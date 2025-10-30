class LH12FilterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'cutoff', defaultValue: 1000, minValue: 8, maxValue: 16000, automationRate: 'a-rate' },
      { name: 'resonance', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0, automationRate: 'a-rate' },
      { name: 'drive', defaultValue: 1.0, minValue: 0.1, maxValue: 5.0, automationRate: 'k-rate' },
      { name: 'saturation', defaultValue: 1.0, minValue: 0.1, maxValue: 10.0, automationRate: 'k-rate' },
      { name: 'envelopeAmount', defaultValue: 0.0, minValue: -1.0, maxValue: 1.0, automationRate: 'a-rate' },
      { name: 'keytrackAmount', defaultValue: 0.0, minValue: -1.0, maxValue: 1.0, automationRate: 'k-rate' },
      { name: 'bassCompensation', defaultValue: 0.5, minValue: 0.0, maxValue: 1.0, automationRate: 'k-rate' }, // Repurposed as "HP Amount"
      { name: 'currentMidiNote', defaultValue: 69, minValue: 0, maxValue: 127, automationRate: 'k-rate' },
      { name: 'adsrValue', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0, automationRate: 'a-rate' },
      { name: 'inputGain', defaultValue: 1.0, minValue: 0.0, maxValue: 2.0, automationRate: 'k-rate' },
      { name: 'classicMode', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0, automationRate: 'k-rate' },
      { name: 'sustainLevel', defaultValue: 1.0, minValue: 0.0, maxValue: 1.0, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    this.MOOG_PI = Math.PI;
    this.sampleRate = sampleRate;
    
    // Huovilainen specific constants
    this.thermal = 1.0;
    
    this.channelFilters = [];
    this.resonanceSmoothed = 0;
    
    this.port.onmessage = this.handleMessage.bind(this);
    console.log(`LH-12 Hybrid Moog filter initialized at ${this.sampleRate}Hz`);
    this.port.postMessage({ type: 'initialized', sampleRate: this.sampleRate });
    
    // Calculate decay coefficient for 5ms decay time
    const decayTime = 0.005;
    this.resonanceDecayCoef = Math.exp(-1.0 / (decayTime * sampleRate));
    
    // PRE-CALCULATE harmonic coefficients (performance optimization)
    this.harmonicCoeffs = [];
    for (let h = 3; h <= 17; h += 2) {
      const amplitude = 0.008 / Math.pow(h, 0.03);
      this.harmonicCoeffs.push(amplitude);
    }
  }
  
  createChannelFilter() {
    return {
      // Huovilainen lowpass arrays
      stage: new Float64Array(4),
      stageTanh: new Float64Array(3),
      delay: new Float64Array(6),
      
      // Filter parameters
      tune: 0.0,
      acr: 0.0,
      resQuad: 0.0,
      
      activeResonance: 0.0,
      
      // 4-pole (24dB/oct) highpass state variables (cascaded 1-pole filters)
      hpStage1X: 0.0,  // Stage 1 previous input
      hpStage1Y: 0.0,  // Stage 1 previous output
      hpStage2X: 0.0,  // Stage 2 previous input
      hpStage2Y: 0.0,  // Stage 2 previous output
      hpStage3X: 0.0,  // Stage 3 previous input
      hpStage3Y: 0.0,  // Stage 3 previous output
      hpStage4X: 0.0,  // Stage 4 previous input
      hpStage4Y: 0.0,  // Stage 4 previous output
      
      // Smooth HPF amount to prevent clicks
      hpAmountSmooth: 0.0,
      
      // Cache for resonance calculation
      lastResonanceValue: -1,
      lastCutoffHz: -1,
      
      reset() {
        this.stage.fill(0);
        this.stageTanh.fill(0);
        this.delay.fill(0);
        this.activeResonance = 0.0;
        this.hpStage1X = 0.0;
        this.hpStage1Y = 0.0;
        this.hpStage2X = 0.0;
        this.hpStage2Y = 0.0;
        this.hpStage3X = 0.0;
        this.hpStage3Y = 0.0;
        this.hpStage4X = 0.0;
        this.hpStage4Y = 0.0;
        this.hpAmountSmooth = 0.0;
        this.lastResonanceValue = -1;
        this.lastCutoffHz = -1;
      }
    };
  }
  
  ensureChannelFilters(numChannels) {
    while (this.channelFilters.length < numChannels) {
      const filter = this.createChannelFilter();
      this.channelFilters.push(filter);
    }
  }
  
  reset() {
    for (const filter of this.channelFilters) {
      filter.reset();
    }
  }
  
  handleMessage(event) {
    if (event.data.type === 'reset') {
      for (const filter of this.channelFilters) {
        filter.reset();
      }
    }
  }
  
  // Set cutoff using Huovilainen's method
  setFilterCutoff(filter, cutoffHz, resonance) {
    const cutoff = Math.max(10, Math.min(this.sampleRate * 0.45, cutoffHz));
    
    // Calculate fc using 2x sample rate since we run 2x oversampling loop
    const effectiveSampleRate = this.sampleRate * 2;
    const fc = cutoff / effectiveSampleRate;
    const fc2 = fc * fc;
    const fc3 = fc2 * fc;
    
    // Huovilainen's frequency and resonance compensation
    const fcr = 1.8730 * fc3 + 0.4955 * fc2 - 0.6490 * fc + 0.9988;
    filter.acr = -3.9364 * fc2 + 1.8409 * fc + 0.9968;
    
    // Standard Huovilainen tune with fcr pre-warping
    filter.tune = 1.0 - Math.exp(-2 * Math.PI * fc * fcr);
    
    // Only recalculate resonance if it or cutoff changed significantly (optimization)
    const resonanceChanged = Math.abs(filter.lastResonanceValue - resonance) > 0.001;
    const cutoffChanged = Math.abs(filter.lastCutoffHz - cutoffHz) > 10;
    
    if (resonanceChanged || cutoffChanged) {
      this.setFilterResonance(filter, resonance, cutoffHz);
      filter.lastResonanceValue = resonance;
      filter.lastCutoffHz = cutoffHz;
    }
  }
  
  // Set resonance using Huovilainen's method with proper scaling
  setFilterResonance(filter, res, cutoffHz) {
    // Map the full 0-1 input range to 0-0.74 safe range
    const mappedRes = res * 0.74;
    
    // Apply scaling curve to the mapped value
    const scaledRes = mappedRes * 0.95;
    const quadraticRes = scaledRes * scaledRes;
    let resonance = Math.max(0, Math.min(0.96, quadraticRes * 0.96));
    
    // FREQUENCY-DEPENDENT RESONANCE SCALING
    if (cutoffHz > 1000) {
      const frequencyRatio = cutoffHz / 1000.0;
      const reductionFactor = 1.0 / Math.pow(frequencyRatio, 0.001);
      resonance *= reductionFactor;
    }
    
    if (cutoffHz > 13000) {
      const highFreqRatio = cutoffHz / 13000.0;
      const highFreqReduction = 1.0 / Math.pow(highFreqRatio, 0.15);
      resonance *= highFreqReduction;
    }
    
    // Standard feedback strength
    filter.resQuad = 8.0 * resonance * filter.acr;
    
    // Store the MAPPED resonance value for input compensation calculations
    filter.cappedActiveResonance = mappedRes;
  }
  
  // Process one sample through Huovilainen filter with 2x oversampling
  processHuovilainenFilter(filter, input) {
    const { stage, stageTanh, delay, tune, resQuad } = filter;
    
    // Calculate harmonic content based on resonance level
    const resAmount = filter.activeResonance;
    
    // 2x oversampling to prevent aliasing from tanh and harmonics
    for (let j = 0; j < 2; j++) {
      // 4-pole feedback signal for strong resonance
      let feedbackSignal = delay[5];
      
      // Add subtle harmonics following overtone series (only when resonance is present)
      if (resAmount > 0.1) {
        const harmonicSource = delay[5];
        
        // ODD HARMONICS ONLY (3, 5, 7, 9, 11, 13, 15, 17) - using pre-calculated coefficients
        let harmonics = 0;
        let harmonicIdx = 0;
        for (let h = 3; h <= 17; h += 2) {
          harmonics += harmonicSource * resAmount * this.harmonicCoeffs[harmonicIdx++];
        }
        
        feedbackSignal += harmonics;
      }
      
      // Standard 4-pole feedback
      const inputSample = input - resQuad * feedbackSignal;
      
      // First stage with tanh
      delay[0] = stage[0] = delay[0] + tune * (Math.tanh(inputSample) - stageTanh[0]);
      
      // Process stages 1-3
      for (let k = 1; k < 4; k++) {
        const stageInput = stage[k - 1];
        stageTanh[k - 1] = Math.tanh(stageInput);
        
        if (k !== 3) {
          stage[k] = delay[k] + tune * (stageTanh[k - 1] - stageTanh[k]);
        } else {
          stage[k] = delay[k] + tune * (stageTanh[k - 1] - Math.tanh(delay[k]));
        }
        
        delay[k] = stage[k];
      }
      
      // Half-sample delay for phase compensation
      delay[5] = (stage[3] + delay[4]) * 0.5;
      delay[4] = stage[3];
    }
    
    // OUTPUT FROM STAGE 1 (2 poles = 12dB/octave)
    return stage[1];
  }
  
  // 4-pole (24dB/oct) non-resonant highpass filter - Juno-106 style
  // Four cascaded 1-pole stages for 24dB/octave slope
  // amount: 0.0 = full highpass (bass removed up to 2kHz), 1.0 = no highpass (full bass) - REVERSED
  applyHighpass(filter, input, amount) {
    // REVERSE the slider direction: 0 = max HPF, 1 = no HPF
    const reversedAmount = 1.0 - amount;
    
    // Smooth the amount parameter with slow smoothing (10ms)
    const smoothCoeff = 0.9995; // ~5ms at 48kHz
    filter.hpAmountSmooth = filter.hpAmountSmooth * smoothCoeff + reversedAmount * (1.0 - smoothCoeff);
    
    const smoothAmount = filter.hpAmountSmooth;
    
    // Always process the filter, but crossfade between filtered and unfiltered
    // This prevents clicks by maintaining filter state even when bypassed
    
    // Calculate cutoff frequency for highpass based on amount
    // Map amount 0-1 to frequency range 20Hz-2000Hz logarithmically (Juno-106 range)
    const minFreq = 20;
    const maxFreq = 2000;
    const logMin = Math.log(minFreq);
    const logMax = Math.log(maxFreq);
    const hpCutoff = Math.exp(logMin + Math.max(0.01, smoothAmount) * (logMax - logMin));
    
    // Calculate one-pole coefficient (same for all 4 stages)
    const omega = 2.0 * Math.PI * hpCutoff / this.sampleRate;
    const alpha = 1.0 / (1.0 + omega);
    
    // STAGE 1: First 6dB/oct pole
    // One-pole highpass: y[n] = alpha * (y[n-1] + x[n] - x[n-1])
    let output = alpha * (filter.hpStage1Y + input - filter.hpStage1X);
    filter.hpStage1X = input;
    filter.hpStage1Y = output;
    
    // STAGE 2: Second 6dB/oct pole (cumulative 12dB/oct)
    const stage2Input = output;
    output = alpha * (filter.hpStage2Y + stage2Input - filter.hpStage2X);
    filter.hpStage2X = stage2Input;
    filter.hpStage2Y = output;
    
    // STAGE 3: Third 6dB/oct pole (cumulative 18dB/oct)
    const stage3Input = output;
    output = alpha * (filter.hpStage3Y + stage3Input - filter.hpStage3X);
    filter.hpStage3X = stage3Input;
    filter.hpStage3Y = output;
    
    // STAGE 4: Fourth 6dB/oct pole (cumulative 24dB/oct)
    const stage4Input = output;
    output = alpha * (filter.hpStage4Y + stage4Input - filter.hpStage4X);
    filter.hpStage4X = stage4Input;
    filter.hpStage4Y = output;
    
    // Crossfade between unfiltered (input) and filtered (output) based on smoothAmount
    // When smoothAmount = 0: return input (no HPF)
    // When smoothAmount = 1: return output (full HPF)
    // Smooth crossfade curve for musical response
    const wetAmount = smoothAmount * smoothAmount; // Quadratic curve for smooth transition
    const dryAmount = 1.0 - wetAmount;
    
    return input * dryAmount + output * wetAmount;
  }
  
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    if (!input || input.length === 0) return true;
    
    this.ensureChannelFilters(input.length);
    
    const cutoff = parameters.cutoff;
    const resonance = parameters.resonance;
    const drive = parameters.drive[0];
    const saturation = parameters.saturation[0];
    const envelopeAmount = parameters.envelopeAmount;
    const keytrackAmount = parameters.keytrackAmount[0];
    const hpAmount = parameters.bassCompensation[0]; // Repurposed: HP amount
    const currentMidiNote = parameters.currentMidiNote[0];
    const adsrValue = parameters.adsrValue;
    const inputGain = parameters.inputGain[0];
    const classicMode = parameters.classicMode[0];
    const sustainLevel = parameters.sustainLevel[0];
    
    for (let channel = 0; channel < input.length; channel++) {
      const inputChannel = input[channel];
      const outputChannel = output[channel];
      const filter = this.channelFilters[channel];
      
      for (let i = 0; i < inputChannel.length; i++) {
        const currentAdsrValue = adsrValue.length > 1 ? adsrValue[i] : adsrValue[0];
        const envValue = envelopeAmount.length > 1 ? envelopeAmount[i] : envelopeAmount[0];
        
        const effectiveInputGain = inputGain;
        
        // Scale input with proper gain for filter
        let inputSample = inputChannel[i] * effectiveInputGain * drive * 2.0;
        
        // Apply saturation as additional pre-gain
        inputSample *= (1.0 + (saturation - 1.0) * 0.3);
        
        // Detect if input is present
        const inputPresent = Math.abs(inputSample) > 0.0001;
        
        // Get target resonance value
        const res = resonance.length > 1 ? resonance[i] : resonance[0];
        
        // Resonance decay when no input
        if (inputPresent) {
          filter.activeResonance = res;
        } else {
          filter.activeResonance *= this.resonanceDecayCoef;
        }
        
        let actualCutoff = cutoff.length > 1 ? cutoff[i] : cutoff[0];
        
        // STEP 1: Apply keytracking first
        if (keytrackAmount !== 0) {
          const noteFreqRatio = Math.pow(2, (currentMidiNote - 69) / 12);
          actualCutoff *= Math.pow(noteFreqRatio, keytrackAmount);
        }
        
        // STEP 2: Apply envelope modulation ON TOP of keytracked frequency
        if (envValue !== 0) {
          if (envValue > 0) {
            if (envValue >= 0.95) {
              const baseFreq = actualCutoff;
              let maxFreq = 16000;
              
              if (classicMode > 0.5) {
                const logMinFreq = Math.log(baseFreq);
                const logMaxFreq = Math.log(16000);
                const logTargetFreq = logMinFreq + ((1.0 - sustainLevel) * (logMaxFreq - logMinFreq));
                const attackTarget = Math.exp(logTargetFreq);
                
                if (currentAdsrValue > sustainLevel) {
                  const normalizedEnv = (currentAdsrValue - sustainLevel) / (1.0 - sustainLevel);
                  const logBase = Math.log(baseFreq);
                  const logTarget = Math.log(attackTarget);
                  const logFreq = logBase + (normalizedEnv * (logTarget - logBase));
                  actualCutoff = Math.exp(logFreq);
                } else {
                  actualCutoff = baseFreq;
                }
              } else {
                const logMinFreq = Math.log(baseFreq);
                const logMaxFreq = Math.log(maxFreq);
                const logFreq = logMinFreq + (currentAdsrValue * (logMaxFreq - logMinFreq));
                actualCutoff = Math.exp(logFreq);
              }
            } else {
              const scaledEnv = Math.min(0.95, envValue);
              actualCutoff *= 1 + (scaledEnv * 8);
            }
          } else {
            if (envValue <= -0.95) {
              const maxFreq = actualCutoff;
              const minFreq = 8;
              
              const logMinFreq = Math.log(minFreq);
              const logMaxFreq = Math.log(maxFreq);
              
              const logFreq = logMaxFreq - (currentAdsrValue * (logMaxFreq - logMinFreq));
              actualCutoff = Math.exp(logFreq);
            } else {
              actualCutoff *= Math.pow(10, envValue * 0.8);
            }
          }
        }
        
        // Update filter coefficients
        this.setFilterCutoff(filter, actualCutoff, filter.activeResonance);
        
        // Input gain compensation for passband loss
        const safeResonance = filter.cappedActiveResonance || filter.activeResonance;
        const inputCompensation = 1.0 + (safeResonance * 5);
        const compensatedInput = inputSample * inputCompensation;
        
        // Process through Huovilainen lowpass filter
        let filterOutput = this.processHuovilainenFilter(filter, compensatedInput);
        
        // Apply makeup gain
        filterOutput *= 5.0;
        
        // Apply 6dB/oct highpass filter (controlled by variant/HP amount slider)
        filterOutput = this.applyHighpass(filter, filterOutput, hpAmount);
        
        outputChannel[i] = filterOutput;
      }
    }
    
    return true;
  }
}

registerProcessor('lh-12-filter-processor', LH12FilterProcessor);
