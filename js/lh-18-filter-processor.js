class LH18FilterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'cutoff', defaultValue: 1000, minValue: 8, maxValue: 16000, automationRate: 'a-rate' },
      { name: 'resonance', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0, automationRate: 'a-rate' },
      { name: 'drive', defaultValue: 2.55, minValue: 0.1, maxValue: 5.0, automationRate: 'k-rate' }, // Default to 2.55 = 50% = unity gain
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
    console.log(`LH-18 Huovilainen Moog filter initialized at ${this.sampleRate}Hz - BUILD v2`);
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
      // LP Huovilainen arrays
      stage: new Float64Array(4),      // Current stage values
      stageTanh: new Float64Array(3),  // Cached tanh values for stages 0-2
      delay: new Float64Array(6),      // Delay line (includes phase compensation)
      
      // LP Filter parameters
      tune: 0.0,
      acr: 0.0,
      resQuad: 0.0,
      
      activeResonance: 0.0,
      
      // LP Cache for resonance calculation (performance optimization)
      lastResonanceValue: -1,
      lastCutoffHz: -1,
      
      // HP Huovilainen arrays (same structure as LP)
      hpStage: new Float64Array(4),      // HP Current stage values
      hpStageTanh: new Float64Array(3),  // HP Cached tanh values for stages 0-2
      hpDelay: new Float64Array(6),      // HP Delay line
      
      // HP Filter parameters
      hpTune: 0.0,
      hpAcr: 0.0,
      hpResQuad: 0.0,
      
      hpActiveResonance: 0.0,
      
      // HP Cache for resonance calculation
      hpLastResonanceValue: -1,
      hpLastCutoffHz: -1,
      
      reset() {
        this.stage.fill(0);
        this.stageTanh.fill(0);
        this.delay.fill(0);
        this.activeResonance = 0.0;
        this.lastResonanceValue = -1;
        this.lastCutoffHz = -1;
        
        this.hpStage.fill(0);
        this.hpStageTanh.fill(0);
        this.hpDelay.fill(0);
        this.hpActiveResonance = 0.0;
        this.hpLastResonanceValue = -1;
        this.hpLastCutoffHz = -1;
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
    
    // Only recalculate resonance if it or cutoff changed significantly (optimization)
    // This prevents expensive Math.pow calls on every audio sample
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
    // This makes the entire slider range feel responsive
    const mappedRes = res * 0.74;
    
    // Apply scaling curve to the mapped value
    const scaledRes = mappedRes * 0.95; // Scale to strong but safe range
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
    
    // Store the MAPPED resonance value for input compensation calculations
    // Use the mapped value (0-0.74 range) so compensation scales properly
    filter.cappedActiveResonance = mappedRes;
  }
  
  // Set HP filter cutoff using Huovilainen's method (same math as LP)
  setHPFilterCutoff(filter, cutoffHz, resonance) {
    // Clamp cutoff to valid range
    const cutoff = Math.max(10, Math.min(this.sampleRate * 0.45, cutoffHz));
    
    // Calculate fc using 2x sample rate since we run 2x oversampling loop
    const effectiveSampleRate = this.sampleRate * 2;
    const fc = cutoff / effectiveSampleRate;
    const fc2 = fc * fc;
    const fc3 = fc2 * fc;
    
    // Huovilainen's frequency and resonance compensation
    const fcr = 1.8730 * fc3 + 0.4955 * fc2 - 0.6490 * fc + 0.9988;
    filter.hpAcr = -3.9364 * fc2 + 1.8409 * fc + 0.9968;
    
    // Standard Huovilainen tune with fcr pre-warping
    filter.hpTune = 1.0 - Math.exp(-2 * Math.PI * fc * fcr);
    
    // Only recalculate resonance if it or cutoff changed significantly (optimization)
    const resonanceChanged = Math.abs(filter.hpLastResonanceValue - resonance) > 0.001;
    const cutoffChanged = Math.abs(filter.hpLastCutoffHz - cutoffHz) > 10;
    
    if (resonanceChanged || cutoffChanged) {
      this.setHPFilterResonance(filter, resonance, cutoffHz);
      filter.hpLastResonanceValue = resonance;
      filter.hpLastCutoffHz = cutoffHz;
    }
  }
  
  // Set HP resonance using Huovilainen's method (same as LP)
  setHPFilterResonance(filter, res, cutoffHz) {
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
    
    // Additional reduction above 13kHz
    if (cutoffHz > 13000) {
      const highFreqRatio = cutoffHz / 13000.0;
      const highFreqReduction = 1.0 / Math.pow(highFreqRatio, 0.15);
      resonance *= highFreqReduction;
    }
    
    // Standard feedback strength
    filter.hpResQuad = 8.0 * resonance * filter.hpAcr;
    
    // Store the MAPPED resonance value
    filter.hpCappedActiveResonance = mappedRes;
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
      
      // MS-20 STYLE: Apply diode clipping to resonance feedback path
      // This creates amplitude-dependent resonance behavior
      // At low levels: clean resonance. At high levels: resonance "breaks up"
      if (resAmount > 0.05) {
        // Scale feedback amount based on resonance for drive intensity
        let feedbackDrive = resAmount * 35.0; // 0-35% drive based on resonance
        
        // ANTI-ALIASING: Reduce diode drive at high frequencies (above 7.4kHz)
        // This prevents aliasing from nonlinear harmonics in the upper range
        if (estimatedCutoff > 7400.0) {
          // Linear reduction from 7.4kHz to 16kHz
          // At 7.4kHz: 100% drive, at 16kHz: 5% drive
          const reductionFactor = Math.max(0.05, 1.0 - ((estimatedCutoff - 7400.0) / 8600.0) * 0.95);
          feedbackDrive *= reductionFactor;
        }
        
        feedbackSignal = this.diode2Clipping(feedbackSignal, feedbackDrive);
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
  
  // Process one sample through Huovilainen HIGHPASS filter with 2x oversampling
  // Same 4-pole structure as LP, but outputs (input - stage[1]) for HP response
  processHuovilainenHighpass(filter, input) {
    const { hpStage, hpStageTanh, hpDelay, hpTune, hpResQuad } = filter;
    
    // Calculate harmonic content based on resonance level
    const resAmount = filter.hpActiveResonance;
    
    // Calculate current cutoff frequency for Nyquist limiting
    const estimatedCutoff = (hpTune / (2.0 * Math.PI)) * this.sampleRate * 4.0;
    
    // 2x oversampling to prevent aliasing from tanh and harmonics
    for (let j = 0; j < 2; j++) {
      // 4-pole feedback signal for strong resonance
      let feedbackSignal = hpDelay[5];
      
      // Add subtle harmonics following overtone series (only when resonance is present)
      if (resAmount > 0.1) {
        const harmonicSource = hpDelay[5];
        
        // ODD HARMONICS ONLY (3, 5, 7, 9, 11, 13, 15, 17) - using pre-calculated coefficients
        let harmonics = 0;
        let harmonicIdx = 0;
        for (let h = 3; h <= 17; h += 2) {
          harmonics += harmonicSource * resAmount * this.harmonicCoeffs[harmonicIdx++];
        }
        
        feedbackSignal += harmonics;
      }
      
      // MS-20 STYLE: Apply diode clipping to resonance feedback path
      if (resAmount > 0.05) {
        let feedbackDrive = resAmount * 35.0;
        
        // ANTI-ALIASING: Reduce diode drive at high frequencies (above 7.4kHz)
        if (estimatedCutoff > 7400.0) {
          const reductionFactor = Math.max(0.05, 1.0 - ((estimatedCutoff - 7400.0) / 8600.0) * 0.95);
          feedbackDrive *= reductionFactor;
        }
        
        feedbackSignal = this.diode2Clipping(feedbackSignal, feedbackDrive);
      }
      
      // Standard 4-pole feedback
      const inputSample = input - hpResQuad * feedbackSignal;
      
      // First stage with tanh
      hpDelay[0] = hpStage[0] = hpDelay[0] + hpTune * (Math.tanh(inputSample) - hpStageTanh[0]);
      
      // Process stages 1-3
      for (let k = 1; k < 4; k++) {
        const stageInput = hpStage[k - 1];
        
        // Calculate and cache tanh for this input
        hpStageTanh[k - 1] = Math.tanh(stageInput);
        
        if (k !== 3) {
          // For stages 1-2, use cached tanh from stageTanh array
          hpStage[k] = hpDelay[k] + hpTune * (hpStageTanh[k - 1] - hpStageTanh[k]);
        } else {
          // For stage 3 (last stage), calculate tanh of delay[k] directly
          hpStage[k] = hpDelay[k] + hpTune * (hpStageTanh[k - 1] - Math.tanh(hpDelay[k]));
        }
        
        hpDelay[k] = hpStage[k];
      }
      
      // Half-sample delay for phase compensation
      hpDelay[5] = (hpStage[3] + hpDelay[4]) * 0.5;
      hpDelay[4] = hpStage[3];
    }
    
    // HIGHPASS OUTPUT: input - stage[1] gives 12dB/octave highpass slope
    // This is the complementary response to the lowpass (stage[1])
    return input - hpStage[1];
  }
  
  // Serum-style Diode 2: Static sinusoidal distortion - SMOOTHED for LP-12
  // Pure sine-based shaping - smooth, rounded, slightly fizzy but never harsh
  // drivePercent: 0-100, the percentage of drive intensity (e.g., 24 for 24%)
  // MS-20 inspired diode clipping: Soft, fuzzy, rounded saturation
  // Uses sinusoidal waveshaping similar to LED forward voltage characteristic
  // TWO-STAGE cascaded for more complex harmonic content
  diode2Clipping(input, drivePercent) {
    if (drivePercent <= 0.0) {
      return input; // Bypass if no drive
    }
    
    // Convert percentage to 0-1 range
    const driveAmount = drivePercent / 100.0;
    
    // MS-20 style: amplitude-dependent behavior
    // Light drive for "sweet spot" where signal and saturation compete
    const driveScalar = 1.0 + (driveAmount * 1.5); // Max 2.5x drive at 100%
    
    // FIRST STAGE
    const driven1 = input * driveScalar;
    const saturationPoint = 0.8; // Start saturation earlier for more fuzz
    const normalizedInput1 = driven1 / saturationPoint;
    
    // Use sine function for smooth, rounded clipping
    const clampedInput1 = Math.max(-Math.PI/2, Math.min(Math.PI/2, normalizedInput1));
    let output1 = Math.sin(clampedInput1) * saturationPoint;
    
    // Add subtle harmonics for "fuzzy" character
    const harmonicAmount = driveAmount * 0.15;
    output1 += Math.sin(clampedInput1 * 2) * harmonicAmount * saturationPoint;
    
    // SECOND STAGE - same processing, cascaded
    const driven2 = output1 * driveScalar;
    const normalizedInput2 = driven2 / saturationPoint;
    
    const clampedInput2 = Math.max(-Math.PI/2, Math.min(Math.PI/2, normalizedInput2));
    let output2 = Math.sin(clampedInput2) * saturationPoint;
    
    // Add harmonics to second stage as well
    output2 += Math.sin(clampedInput2 * 2) * harmonicAmount * saturationPoint;
    
    // Light makeup gain - less than before for more natural response
    output2 *= 1.05;
    
    return output2;
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
    const driveAmount = parameters.drive[0]; // Drive slider controls pre-gain + diode
    const bassCompensation = parameters.bassCompensation[0]; // Variant slider (preserved for future)
    const currentMidiNote = parameters.currentMidiNote[0];
    const adsrValue = parameters.adsrValue;
    const inputGain = parameters.inputGain[0];
    const classicMode = parameters.classicMode[0];
    const sustainLevel = parameters.sustainLevel[0];
    
    // DEBUG: Log parameter values (only once per second)
    if (!this.paramDebugCounter) this.paramDebugCounter = 0;
    this.paramDebugCounter++;
    if (this.paramDebugCounter % 48000 === 0) {
      const adsrVal = adsrValue.length > 1 ? adsrValue[0] : adsrValue[0];
      const envVal = envelopeAmount.length > 1 ? envelopeAmount[0] : envelopeAmount[0];
      console.log(`LH18 PROCESSOR: adsrValue=${adsrVal.toFixed(3)}, sustainLevel=${sustainLevel.toFixed(3)}, envAmount=${envVal.toFixed(3)}`);
    }
    
    // DEBUG: Initialize counter for drive logging
    if (!this._driveDebugCounter) this._driveDebugCounter = 0;
    this._driveDebugCounter++;
    
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
        // NOTE: Drive is NOT applied here - it's handled later in the split pre-gain/diode section
        let inputSample = inputChannel[i] * effectiveInputGain;
        
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
        
        // STEP 1: Apply keytracking first (sets the base frequency for this note)
        if (keytrackAmount !== 0) {
          const noteFreqRatio = Math.pow(2, (currentMidiNote - 69) / 12);
          actualCutoff *= Math.pow(noteFreqRatio, keytrackAmount);
        }
        
        // STEP 2: Apply envelope modulation ON TOP of keytracked frequency
        // Use actualCutoff (with keytracking) as the base, not raw slider value
        if (envValue !== 0) {
          if (envValue > 0) {
            if (envValue >= 0.95) {
              // Store keytracked cutoff as the base frequency
              const baseFreq = actualCutoff;
              let maxFreq = 16000;
              
              // CLASSIC MODE: Sustain level controls attack target, decay returns to base
              // In classic mode: baseFreq → attackTarget (based on sustain) → decay to baseFreq → hold at baseFreq
              // In normal mode: baseFreq → 16kHz → holds at (sustain * range)
              if (classicMode > 0.5) {
                // In classic mode, attack target is controlled by sustain level
                // sustain=1.0: attack goes to baseFreq (no ramp up, stays at base)
                // sustain=0.5: attack goes to halfway between baseFreq and 16kHz, then decays to base
                // sustain=0.0: attack goes to 16kHz (full ramp), then decays to base
                const logMinFreq = Math.log(baseFreq);
                const logMaxFreq = Math.log(16000);
                const logTargetFreq = logMinFreq + ((1.0 - sustainLevel) * (logMaxFreq - logMinFreq));
                const attackTarget = Math.exp(logTargetFreq);
                
                // Classic mode: ADSR envelope creates a "spike" that returns to base
                // ADSR goes from 0 → 1 (attack) → sustain level → 0 (release)
                // But we want: baseFreq → attackTarget → baseFreq (held during sustain)
                // So we map: ADSR closer to 1.0 = higher frequency, ADSR at sustain = baseFreq
                
                // If ADSR is above sustain level (in attack/decay), sweep between base and target
                // If ADSR is at sustain level or below, stay at base
                if (currentAdsrValue > sustainLevel) {
                  // We're in attack or decay phase - sweep from base to target
                  // Normalize to 0-1 range where sustainLevel=0 and 1.0=1
                  const normalizedEnv = (currentAdsrValue - sustainLevel) / (1.0 - sustainLevel);
                  const logBase = Math.log(baseFreq);
                  const logTarget = Math.log(attackTarget);
                  const logFreq = logBase + (normalizedEnv * (logTarget - logBase));
                  actualCutoff = Math.exp(logFreq);
                } else {
                  // We're in sustain or release - stay at base frequency
                  actualCutoff = baseFreq;
                }
              } else {
                // NORMAL MODE: Full sweep to 16kHz during attack, sustain level controls held frequency
                const logMinFreq = Math.log(baseFreq);
                const logMaxFreq = Math.log(maxFreq);
                
                // Map ADSR value (0-1) directly to logarithmic frequency range
                const logFreq = logMinFreq + (currentAdsrValue * (logMaxFreq - logMinFreq));
                actualCutoff = Math.exp(logFreq);
              }
            } else {
              const scaledEnv = Math.min(0.95, envValue);
              actualCutoff *= 1 + (scaledEnv * 8);
            }
          } else {
            if (envValue <= -0.95) {
              // For negative envelope, sweep DOWN from keytracked frequency
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
        
        // Update LP filter coefficients
        this.setFilterCutoff(filter, actualCutoff, filter.activeResonance);
        
        // ===== HP FILTER CUTOFF CALCULATION (mirrors LP logic) =====
        
        // VARIANT SLIDER: Base HP cutoff (INVERTED logarithmic)
        // bassCompensation: 0.0 to 1.0 (0% to 100%)
        // 0% = 16kHz (HP off), 50% ≈ 500Hz, 100% = 8Hz (extreme HP)
        const minHpCutoff = 8;
        const maxHpCutoff = 16000;
        
        // Inverted logarithmic mapping: 0→max, 1→min (100% is most extreme HP)
        const logMinHp = Math.log(minHpCutoff);
        const logMaxHp = Math.log(maxHpCutoff);
        let hpCutoff = Math.exp(logMaxHp - (bassCompensation * (logMaxHp - logMinHp)));

        
        // KEYTRACKING for HP (same as LP)
        if (Math.abs(keytrackAmount) > 0.01) {
          const midiOffset = currentMidiNote - 60;
          const semitoneFactor = Math.pow(2, midiOffset / 12);
          
          if (keytrackAmount > 0) {
            hpCutoff *= Math.pow(semitoneFactor, keytrackAmount);
          } else {
            hpCutoff *= Math.pow(semitoneFactor, keytrackAmount);
          }
          
          hpCutoff = Math.max(8, Math.min(16000, hpCutoff));
        }
        
        // ADSR ENVELOPE for HP (same logic as LP)
        if (Math.abs(envValue) > 0.01) {
          if (envValue > 0) {
            if (envValue >= 0.95) {
              // Full positive envelope - follow ADSR for sweeping
              const baseFreq = hpCutoff;
              let maxFreq = 16000;
              
              if (classicMode > 0.5) {
                // CLASSIC MODE for HP
                const logMinFreq = Math.log(baseFreq);
                const logMaxFreq = Math.log(16000);
                const logTargetFreq = logMinFreq + ((1.0 - sustainLevel) * (logMaxFreq - logMinFreq));
                const attackTarget = Math.exp(logTargetFreq);
                
                if (currentAdsrValue > sustainLevel) {
                  const normalizedEnv = (currentAdsrValue - sustainLevel) / (1.0 - sustainLevel);
                  const logBase = Math.log(baseFreq);
                  const logTarget = Math.log(attackTarget);
                  const logFreq = logBase + (normalizedEnv * (logTarget - logBase));
                  hpCutoff = Math.exp(logFreq);
                } else {
                  hpCutoff = baseFreq;
                }
              } else {
                // NORMAL MODE for HP
                const logMinFreq = Math.log(baseFreq);
                const logMaxFreq = Math.log(maxFreq);
                const logFreq = logMinFreq + (currentAdsrValue * (logMaxFreq - logMinFreq));
                hpCutoff = Math.exp(logFreq);
              }
            } else {
              const scaledEnv = Math.min(0.95, envValue);
              hpCutoff *= 1 + (scaledEnv * 8);
            }
          } else {
            if (envValue <= -0.95) {
              // Negative envelope - sweep DOWN for HP
              const maxFreq = hpCutoff;
              const minFreq = 8;
              
              const logMinFreq = Math.log(minFreq);
              const logMaxFreq = Math.log(maxFreq);
              
              const logFreq = logMaxFreq - (currentAdsrValue * (logMaxFreq - logMinFreq));
              hpCutoff = Math.exp(logFreq);
            } else {
              hpCutoff *= Math.pow(10, envValue * 0.8);
            }
          }
        }
        
        // Update HP filter coefficients
        // DUAL RESONANCE: HP filter gets same resonance as LP filter
        const hpResonance = filter.activeResonance;
        this.setHPFilterCutoff(filter, hpCutoff, hpResonance);
        filter.hpActiveResonance = hpResonance;
        
        // Input gain compensation for passband loss due to negative feedback
        // As resonance increases, negative feedback reduces passband gain significantly
        // Compensate by boosting input proportionally: ~16dB = 6x linear gain
        // CRITICAL: Use cappedActiveResonance (not activeResonance) to prevent excessive compensation above cap
        const safeResonance = filter.cappedActiveResonance || filter.activeResonance;
        const inputCompensation = 1.0 + (safeResonance * 5);
        const compensatedInput = inputSample * inputCompensation;
        
        // Process through Huovilainen LP filter
        let lpOutput = this.processHuovilainenFilter(filter, compensatedInput);
        
        // Process through Huovilainen HP filter (in series after LP)
        let hpOutput = this.processHuovilainenHighpass(filter, lpOutput);
        
        // SMOOTH HP MIX: Crossfade HP based on Variant slider position
        // When Variant is at 100% (bassCompensation = 1.0, HP cutoff = 8Hz),
        // we don't want subsonic resonance, so fade HP to 0%
        // Use a curve that keeps HP at 100% mix until ~80%, then fades out
        let hpMix;
        if (bassCompensation < 0.8) {
          // 0-80%: HP fully active (100% mix)
          hpMix = 1.0;
        } else {
          // 80-100%: Smooth fade to 0% using cubic curve for gentle rolloff
          // At 80%: mix = 1.0, at 100%: mix = 0.0
          const fadeRange = (bassCompensation - 0.8) / 0.2; // Normalize 0.8-1.0 to 0-1
          const cubicFade = fadeRange * fadeRange * fadeRange; // x³ for smooth curve
          hpMix = 1.0 - cubicFade;
        }
        
        // Blend between LP-only and HP+LP based on mix amount
        let filterOutput = lpOutput + ((hpOutput - lpOutput) * hpMix);
        
        // Apply makeup gain to compensate for filter topology loss
        filterOutput *= 5.0;
        
        // STEP 1: Split drive knob into two ranges
        // Lower 50% (0.0-0.5): Clean pre-gain from 0x to 0.2x (accounting for 5x makeup = 0x to 1x final)
        // Upper 50% (0.5-1.0): Pre-gain stays at 0.2x, add gentle diode from 0% to 40%
        
        // Normalize drive from AudioParam range (0.1-5.0) to 0-1
        const normalizedDrive = Math.max(0, Math.min(1, (driveAmount - 0.1) / 4.9));
        
        let preGain = 1.0;
        let diodeDrive = 0.0;
        
        if (normalizedDrive <= 0.5) {
          // Lower 50%: Scale volume from 0x to 0.2x
          // With 5x makeup gain, this gives 0x to 1.0x final output
          preGain = normalizedDrive * 0.4; // 0.0→0x, 0.5→0.2x (which becomes 1.0x after 5x makeup)
          diodeDrive = 0.0; // Completely clean
        } else {
          // Upper 50%: Keep pre-gain at 0.2x (1x after makeup), gradually add saturation
          preGain = 0.2; // 0.2x * 5x makeup = 1.0x unity gain
          const diodeAmount = (normalizedDrive - 0.5) * 2.0; // Normalize 0.5-1.0 to 0-1
          
          // Apply smoothing curve to diode engagement to prevent click
          // Use quadratic curve for very gentle start
          const smoothedDiode = diodeAmount * diodeAmount; // x² curve for slow start
          diodeDrive = smoothedDiode * 35.0; // Scale to 0-35% (reduced max for less harshness)
        }
        
        // Debug logging every 1000 samples (about 20 times per second at 48kHz)
        if (channel === 0 && i === 0 && this._driveDebugCounter % 1000 === 0) {
          console.log(`LH18 Drive Debug: raw=${driveAmount.toFixed(3)}, normalized=${normalizedDrive.toFixed(3)}, preGain=${preGain.toFixed(3)}x, diode=${diodeDrive.toFixed(1)}%`);
        }
        
        // Apply pre-gain first
        filterOutput *= preGain;
        
        // Then apply diode clipping (only active in upper 50%)
        filterOutput = this.diode2Clipping(filterOutput, diodeDrive);
        
        outputChannel[i] = filterOutput;
      }
    }
    
    return true;
  }
}

registerProcessor('lh-18-filter-processor', LH18FilterProcessor);