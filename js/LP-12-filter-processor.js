class LP12FilterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'cutoff', defaultValue: 1000, minValue: 8, maxValue: 16000, automationRate: 'a-rate' },
      { name: 'resonance', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0, automationRate: 'a-rate' },
      { name: 'drive', defaultValue: 1.0, minValue: 0.1, maxValue: 5.0, automationRate: 'k-rate' },
      { name: 'saturation', defaultValue: 1.0, minValue: 0.1, maxValue: 10.0, automationRate: 'k-rate' },
      { name: 'envelopeAmount', defaultValue: 0.0, minValue: -1.0, maxValue: 1.0, automationRate: 'a-rate' },
      { name: 'keytrackAmount', defaultValue: 0.0, minValue: -1.0, maxValue: 1.0, automationRate: 'k-rate' },
      { name: 'bassCompensation', defaultValue: 0.5, minValue: 0.0, maxValue: 1.0, automationRate: 'k-rate' }, // Repurposed as "Harshness"
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
    this.thermal = 1.0; // Normalized thermal scaling (originally 0.000025V but normalized for digital domain)
    
    this.channelFilters = [];
    this.resonanceSmoothed = 0;
    
    this.port.onmessage = this.handleMessage.bind(this);
    console.log(`LP-12 Huovilainen Moog filter initialized at ${this.sampleRate}Hz`);
    this.port.postMessage({ type: 'initialized', sampleRate: this.sampleRate });
    
    // Calculate decay coefficient for 5ms decay time
    const decayTime = 0.005;
    this.resonanceDecayCoef = Math.exp(-1.0 / (decayTime * sampleRate));
  }
  
  createChannelFilter() {
    return {
      // Huovilainen uses specific arrays
      stage: new Float64Array(4),      // Current stage values
      stageTanh: new Float64Array(3),  // Cached tanh values for stages 0-2
      delay: new Float64Array(6),      // Delay line (includes phase compensation)
      
      // Filter parameters
      tune: 0.0,
      acr: 0.0,
      resQuad: 0.0,
      
      activeResonance: 0.0,
      
      reset() {
        this.stage.fill(0);
        this.stageTanh.fill(0);
        this.delay.fill(0);
        this.activeResonance = 0.0;
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
  
  // NO diode processing - Huovilainen model has its own nonlinearities
  
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
    
    // Update resonance with new acr and cutoff frequency for frequency-dependent scaling
    this.setFilterResonance(filter, resonance, cutoffHz);
  }
  
  // Set resonance using Huovilainen's method with proper scaling
  setFilterResonance(filter, res, cutoffHz) {
    // Simple hard cap at a safe maximum to prevent instability and artifacts
    // Dial back from 76% until we find stable maximum
    const cappedRes = Math.min(res, 0.74); // Start at 74% and test
    const scaledRes = cappedRes * 0.95; // Scale to strong but safe range
    const quadraticRes = scaledRes * scaledRes; // Quadratic for musical curve
    let resonance = Math.max(0, Math.min(0.96, quadraticRes * 0.96));
    
    // FREQUENCY-DEPENDENT RESONANCE SCALING
    // Reduce resonance at higher frequencies to prevent ear-piercing peaks
    // Aim for consistent perceived loudness across the frequency range
    if (cutoffHz > 1000) {
      // Very gentle logarithmic reduction above 1kHz
      // At 1kHz: no reduction (1.0x)
      // At 3kHz: ~0.97x reduction
      // At 10kHz: ~0.92x reduction
      const frequencyRatio = cutoffHz / 1000.0;
      const reductionFactor = 1.0 / Math.pow(frequencyRatio, 0.001); // Much gentler falloff
      resonance *= reductionFactor;
    }
    
    // Additional reduction above 13kHz for very high frequencies
    if (cutoffHz > 13000) {
      const highFreqRatio = cutoffHz / 13000.0;
      const highFreqReduction = 1.0 / Math.pow(highFreqRatio, 0.15); // Steeper reduction
      resonance *= highFreqReduction;
    }
    
    // Standard feedback strength
    filter.resQuad = 8.0 * resonance * filter.acr;
    
    // Store the CAPPED resonance value for input compensation calculations
    // This prevents excessive gain compensation above the resonance cap
    filter.cappedActiveResonance = cappedRes;
  }
  
  // Process one sample through Huovilainen filter with 2x oversampling
  // MODIFIED: Taps output after 2 poles (stage[1]) for 12dB/octave response
  processHuovilainenFilter(filter, input) {
    const { stage, stageTanh, delay, tune, resQuad } = filter;
    
    // Calculate harmonic content based on resonance level
    const resAmount = filter.activeResonance;
    
    // Calculate current cutoff frequency for Nyquist limiting
    // Estimate cutoff from tune parameter (inverse relationship)
    const estimatedCutoff = (tune / (2.0 * Math.PI)) * this.sampleRate * 4.0; // Approximate
    const nyquistFreq = this.sampleRate * 0.5; // Half sample rate
    
    // 2x oversampling to prevent aliasing from tanh and harmonics
    for (let j = 0; j < 2; j++) {
      // 4-pole feedback signal for strong resonance
      let feedbackSignal = delay[5];
      

      
      // Add subtle harmonics following overtone series (only when resonance is present)
      // Use delay[5] as harmonic source - this is the resonating signal before filtering
      if (resAmount > 0.1) {
        let harmonics = 0;
        
        // Generate harmonics from the resonant feedback signal (before it gets filtered)
        // This ensures we have strong signal to generate all harmonics from
        const harmonicSource = delay[5];
        
        // SEPARATE GENERATION: ODD HARMONICS (3, 5, 7, 9, 11, 13, 15, 17)
        // These are MUCH louder and give the classic Moog resonance character
        for (let h = 3; h <= 17; h += 2) {
          // Very slow rolloff - let the natural filter response shape them
          // Increased base amplitude for stronger resonant peaks
          const amplitude = 0.008 / Math.pow(h, 0.03); // Almost flat, stronger base
          const strength = resAmount * 1.0 * amplitude; // Boost strength
          const harmonic = harmonicSource * strength;
          harmonics += harmonic;
        }
        
        // SEPARATE GENERATION: EVEN HARMONICS (2, 4, 6, 8, 10, 12, 14, 16)
        // These are MUCH quieter for contrast
        for (let h = 2; h <= 16; h += 2) {
          const amplitude = 0.00  / Math.sqrt(h);
          const strength = resAmount * 0.0 * amplitude; // Very subtle even harmonics (8x quieter!)
          const harmonic = harmonicSource * strength;
          harmonics += harmonic;
        }
        
        // Mix harmonics into feedback
        feedbackSignal = feedbackSignal + harmonics;
      }
      
      // Standard 4-pole feedback
      const inputSample = input - resQuad * feedbackSignal;
      
      // First stage with tanh - proper scaling for transistor nonlinearity
      delay[0] = stage[0] = delay[0] + tune * (Math.tanh(inputSample) - stageTanh[0]);
      
      // Process stages 1-3 (indices k = 1, 2, 3)
      for (let k = 1; k < 4; k++) {
        const stageInput = stage[k - 1];
        
        // Calculate and cache tanh for this input
        stageTanh[k - 1] = Math.tanh(stageInput);
        
        if (k !== 3) {
          // For stages 1-2, use cached tanh from stageTanh array
          stage[k] = delay[k] + tune * (stageTanh[k - 1] - stageTanh[k]);
        } else {
          // For stage 3 (last stage), calculate tanh of delay[k] directly
          stage[k] = delay[k] + tune * (stageTanh[k - 1] - Math.tanh(delay[k]));
        }
        
        delay[k] = stage[k];
      }
      
      // Half-sample delay for phase compensation (still from stage 3)
      delay[5] = (stage[3] + delay[4]) * 0.5;
      delay[4] = stage[3];
    }
    
    // OUTPUT FROM STAGE 1 (2 poles = 12dB/octave) instead of delay[5] (4 poles = 24dB/octave)
    // This keeps all the resonance feedback math intact while giving 12dB/oct slope
    return stage[1];
  }
  
  // Serum-style Diode 2: Static sinusoidal distortion - SMOOTHED for LP-12
  // Pure sine-based shaping - smooth, rounded, slightly fizzy but never harsh
  // drivePercent: 0-100, the percentage of drive intensity (e.g., 24 for 24%)
  diode2Clipping(input, drivePercent) {
    // Convert percentage to 0-1 range
    const driveAmount = drivePercent / 100.0;
    
    // First diode stage (0-50% range, active throughout 0-100%)
    // Much gentler pre-gain to reduce aliasing
    const preGain1 = 1.0 + (Math.min(driveAmount, 0.5) * 0.8 * 2.0); // Scale 0-50% to full range
    let driven1 = input * preGain1;
    
    // Higher threshold for smoother operation
    const threshold1 = 1.2 - (Math.min(driveAmount, 0.5) * 0.2 * 2.0);
    const normalizedInput1 = driven1 / threshold1;
    
    // Pure sinusoidal shaping - NO hard clipping ever
    const shaped1 = Math.sin(normalizedInput1 * Math.PI * 0.5);
    let output = shaped1 * threshold1;
    
    // Gain compensation for first stage
    const gainComp1 = 1.0 - (Math.min(driveAmount, 0.5) * 0.25 * 2.0);
    output *= gainComp1;
    
    // Second diode stage (kicks in 50-100%)
    if (driveAmount > 0.5) {
      const secondStageDrive = (driveAmount - 0.5) * 2.0; // Normalize 50-100% to 0-1
      
      // Second stage with more aggressive shaping
      const preGain2 = 1.0 + (secondStageDrive * 1.2); // Stronger drive
      let driven2 = output * preGain2;
      
      const threshold2 = 1.1 - (secondStageDrive * 0.15);
      const normalizedInput2 = driven2 / threshold2;
      
      // Sine shaping again for smooth stacking
      const shaped2 = Math.sin(normalizedInput2 * Math.PI * 0.5);
      output = shaped2 * threshold2;
      
      // Gain compensation for second stage
      const gainComp2 = 1.0 - (secondStageDrive * 0.2);
      output *= gainComp2;
    }
    
    return output;
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
    const harshness = parameters.bassCompensation[0]; // Repurposed: 0=gentle, 1=aggressive
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
        
        // FIXED: envelopeAmount should ONLY affect filter cutoff, NOT gain
        // The gain should remain constant regardless of envelope settings
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
        
        if (keytrackAmount !== 0) {
          const noteFreqRatio = Math.pow(2, (currentMidiNote - 69) / 12);
          actualCutoff *= Math.pow(noteFreqRatio, keytrackAmount);
        }
        
        if (envValue !== 0) {
          if (envValue > 0) {
            if (envValue >= 0.95) {
              const baseSliderCutoff = cutoff.length > 1 ? cutoff[i] : cutoff[0];
              const minFreq = baseSliderCutoff;
              let maxFreq = 16000;
              
              // CLASSIC MODE: Sustain level controls attack target frequency
              // sustain=1.0: attack goes to baseSliderCutoff (no ramp)
              // sustain=0.5: attack goes to halfway between baseSliderCutoff and 16kHz
              // sustain=0.0: attack goes to 16kHz (full ramp)
              if (classicMode > 0.5) {
                // In classic mode, calculate max frequency based on sustain level
                // Use logarithmic interpolation for musical response
                const logMinFreq = Math.log(baseSliderCutoff);
                const logMaxFreq = Math.log(16000);
                const logTargetFreq = logMinFreq + ((1.0 - sustainLevel) * (logMaxFreq - logMinFreq));
                maxFreq = Math.exp(logTargetFreq);
              }
              
              const logMinFreq = Math.log(minFreq);
              const logMaxFreq = Math.log(maxFreq);
              
              const logFreq = logMinFreq + (currentAdsrValue * (logMaxFreq - logMinFreq));
              actualCutoff = Math.exp(logFreq);
            } else {
              const scaledEnv = Math.min(0.95, envValue);
              actualCutoff *= 1 + (scaledEnv * 8);
            }
          } else {
            if (envValue <= -0.95) {
              const baseSliderCutoff = cutoff.length > 1 ? cutoff[i] : cutoff[0];
              const maxFreq = baseSliderCutoff;
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
        
        // Input gain compensation for passband loss due to negative feedback
        // As resonance increases, negative feedback reduces passband gain significantly
        // Compensate by boosting input proportionally: ~16dB = 6x linear gain
        // CRITICAL: Use cappedActiveResonance (not activeResonance) to prevent excessive compensation above cap
        const safeResonance = filter.cappedActiveResonance || filter.activeResonance;
        const inputCompensation = 1.0 + (safeResonance * 5);
        const compensatedInput = inputSample * inputCompensation;
        
        // Process through Huovilainen filter with 4x oversampling
        let filterOutput = this.processHuovilainenFilter(filter, compensatedInput);
        
        // Apply makeup gain to compensate for filter topology loss
        filterOutput *= 5.0;
        
        // Apply Moog-style sine diode with variant knob controlling drive
        // harshness 0 = 0% drive (clean), harshness 1.0 = 50% drive max (smoother)
        // Capped at 50% to prevent aliasing and keep it smooth
        const diodeDrive = harshness * 50.0;
        filterOutput = this.diode2Clipping(filterOutput, diodeDrive);
        
        outputChannel[i] = filterOutput;
      }
    }
    
    return true;
  }
}

registerProcessor('lp-12-filter-processor', LP12FilterProcessor);