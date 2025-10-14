class MoogFilterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'cutoff', defaultValue: 1000, minValue: 8, maxValue: 16000, automationRate: 'a-rate' },
      { name: 'resonance', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0, automationRate: 'a-rate' },
      { name: 'drive', defaultValue: 1.0, minValue: 0.1, maxValue: 5.0, automationRate: 'k-rate' },
      { name: 'saturation', defaultValue: 1.0, minValue: 0.1, maxValue: 10.0, automationRate: 'k-rate' },
      { name: 'envelopeAmount', defaultValue: 0.0, minValue: -1.0, maxValue: 1.0, automationRate: 'a-rate' },
      { name: 'keytrackAmount', defaultValue: 0.0, minValue: -1.0, maxValue: 1.0, automationRate: 'k-rate' },
      { name: 'bassCompensation', defaultValue: 0.5, minValue: 0.0, maxValue: 1.0, automationRate: 'k-rate' },
      { name: 'currentMidiNote', defaultValue: 69, minValue: 0, maxValue: 127, automationRate: 'k-rate' },
      { name: 'adsrValue', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0, automationRate: 'a-rate' },
      // CORRECTED: Default to 1.0 (instead of 0.5) to match original filter behavior
      { name: 'inputGain', defaultValue: 1.0, minValue: 0.0, maxValue: 2.0, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    
    // Math constants
    this.MOOG_PI = Math.PI;
    
    // Sample rate - critical for accurate filter behavior
    this.sampleRate = sampleRate;
    
    // Filter parameters
    this.cutoff = 1000;           // Cutoff frequency (Hz)
    this.resonance = 0.0;         // Resonance (0 to 1)
    this.saturation = 1.0;        // Saturation factor
    
    // Oberheim filter-specific variables
    this.K = 0.0;                 // Feedback amount
    this.alpha0 = 1.0;            // Input gain
    this.gamma = 1.0;             // Feedback path gain
    
    // Oberheim output coefficients - controls filter type (LP4 by default)
    this.oberheimCoefs = [0.0, 0.0, 0.0, 0.0, 1.0];
    
    // Internal filter stage objects (one per channel)
    this.channelFilters = [];
    
    // Set up message port for custom messages
    this.port.onmessage = this.handleMessage.bind(this);
    
    // Report the actual sample rate
    console.log(`Oberheim Moog filter initialized with sample rate: ${this.sampleRate}Hz`);
    this.port.postMessage({ type: 'initialized', sampleRate: this.sampleRate });
  // Add envelope follower
    this.envelopeFollower = 0.0;
    
    // Calculate ADSR follower coefficients
    const attackTime = 0.001; // 1ms - very fast attack
    const releaseTime = 0.001; // 1ms - very fast release for tight ADSR following
    this.attackCoef = Math.exp(-1.0 / (attackTime * sampleRate));
    this.releaseCoef = Math.exp(-1.0 / (releaseTime * sampleRate));
  }
  
  // One-pole filter stage implementation
  createOnePole() {
    return {
      alpha: 1.0,    // Coefficient for state update
      beta: 0.0,     // Feedback output coefficient
      gamma: 1.0,    // Input scaling
      delta: 0.0,    // Feedback delta
      epsilon: 0.0,  // Extra feedback coefficient
      a0: 1.0,       // Input coefficient
      feedback: 0.0, // Feedback value
      z1: 0.0,       // State variable
      
      // Reset the filter state
      reset() {
        this.alpha = 1.0;
        this.beta = 0.0;
        this.gamma = 1.0;
        this.delta = 0.0;
        this.epsilon = 0.0;
        this.a0 = 1.0;
        this.feedback = 0.0;
        this.z1 = 0.0;
      },
      
      // Process one sample through the filter
      tick(input) {
        // Apply input scaling, feedback, and epsilon * feedback output
        const scaledInput = input * this.gamma + this.feedback + 
                           this.epsilon * this.getFeedbackOutput();
        
        // Update state
        const vn = (this.a0 * scaledInput - this.z1) * this.alpha;
        const output = vn + this.z1;
        this.z1 = vn + output;
        
        return output;
      },
      
      // Set feedback value
      setFeedback(fb) {
        this.feedback = fb;
      },
      
      // Get feedback output
      getFeedbackOutput() {
        return this.beta * (this.z1 + this.feedback * this.delta);
      },
      
      // Set alpha coefficient
      setAlpha(a) {
        this.alpha = a;
      },
      
      // Set beta coefficient
      setBeta(b) {
        this.beta = b;
      }
    };
  }
  
  // Create a complete 4-stage filter for one channel
  createChannelFilter() {
    return {
      // The four one-pole filter stages
      stage1: this.createOnePole(),
      stage2: this.createOnePole(),
      stage3: this.createOnePole(),
      stage4: this.createOnePole(),
      
      // Reset all stages
      reset() {
        this.stage1.reset();
        this.stage2.reset();
        this.stage3.reset();
        this.stage4.reset();
      }
    };
  }
  
  // Ensure we have enough filters for all channels
  ensureChannelFilters(numChannels) {
    while (this.channelFilters.length < numChannels) {
      this.channelFilters.push(this.createChannelFilter());
    }
  }
  
  reset() {
    // Reset all channel filters
    for (const filter of this.channelFilters) {
      filter.reset();
    }
  }
  
  handleMessage(event) {
  if (event.data.type === 'reset') {
    // Reset filter stages but don't zero out resonance
    for (const filter of this.channelFilters) {
      filter.reset();
    }
    
    // Don't reset this.K to zero - let ADSR parameters handle this naturally
    // Previously it might have been zeroing out resonance here
  }
}
  
  // Improved drive/saturation implementation
softSaturate(input, driveAmount) {
  // No saturation at drive = 1
  if (driveAmount <= 1.0) {
    return input;
  }
  
  // Drive parameter determines amount of saturation - REDUCED RANGE
  const normalizedDrive = Math.min(0.7, (driveAmount - 1.0) / 5.0); // Reduced from 0.9
  
  // Stronger gain compensation
  const gainCompensation = 1.0 / (1.0 + normalizedDrive * 0.8); // Increased from 0.6
  
  // Higher threshold for minimal shaping
  if (Math.abs(input) < 0.3) { // Increased from 0.2
    // For small signals (including resonant peaks), apply minimal shaping
    return input * gainCompensation;
  } else {
    // Gentler soft-clipping function
    const absInput = Math.abs(input);
    const sign = Math.sign(input);
    
    // Softer curve
    const shaped = sign * (1.0 - Math.exp(-absInput * 0.8)) / (1.0 - Math.exp(-0.8));
    
    // Blend between input and shaped based on drive - MORE ORIGINAL
    const blended = input * (1.0 - normalizedDrive * 0.8) + shaped * normalizedDrive * 0.8;
    
    // Apply gain compensation
    return blended * gainCompensation;
  }
}
  
  setCutoff(cutoffHz) {
    // Clamp cutoff to valid range [8Hz, 16kHz]
    this.cutoff = Math.max(8, Math.min(16000, cutoffHz));
    
    // Prewarp for Bilinear Transform (BZT)
    const wd = 2.0 * this.MOOG_PI * this.cutoff;
    const T = 1.0 / this.sampleRate;
    const wa = (2.0 / T) * Math.tan(wd * T / 2.0);
    const g = wa * T / 2.0;
    
    // Feedforward coefficient
    const G = g / (1.0 + g);
    
    // Update coefficients for all channel filters
    for (const filter of this.channelFilters) {
      // Set alpha for all stages (controls cutoff)
      filter.stage1.setAlpha(G);
      filter.stage2.setAlpha(G);
      filter.stage3.setAlpha(G);
      filter.stage4.setAlpha(G);
      
      // Set beta for feedback path
      filter.stage1.setBeta(G * G * G / (1.0 + g));
      filter.stage2.setBeta(G * G / (1.0 + g));
      filter.stage3.setBeta(G / (1.0 + g));
      filter.stage4.setBeta(1.0 / (1.0 + g));
    }
    
    // Calculate global coefficients
    this.gamma = G * G * G * G;
    this.alpha0 = 1.0 / (1.0 + this.K * this.gamma);
    
    // Set Oberheim coefficients for LP4 mode by default
    this.oberheimCoefs = [0.0, 0.0, 0.0, 0.0, 1.0];
  }
  
  setResonance(res) {
  // Clamp resonance to [0, 1]
  const normalizedRes = Math.max(0, Math.min(1, res));
  
  // No more ADSR scaling - use raw resonance value
  const safeRes = Math.min(0.99, normalizedRes);
  
  // Same curve calculation
  if (safeRes < 0.2) {
    this.K = safeRes * 2.0;
  } else if (safeRes < 0.6) {
    const t = (safeRes - 0.2) / 0.4;
    this.K = 0.4 + t * t * 1.6;
  } else {
    const t = (safeRes - 0.6) / 0.4;
    this.K = 2.0 + t * t * 1.95;
  }
  
  // Update alpha0 since it depends on K
  this.alpha0 = 1.0 / (1.0 + this.K * this.gamma);
}
  
  setDrive(driveAmount) {
  // No change to the parameter value - just store it
  this.drive = Math.max(0.1, Math.min(5.0, driveAmount));
}
  processWithDrive(input, driveAmount) {
  // Only apply if drive > 1
  if (driveAmount <= 1.0) return input;
  
  // GENTLER post-filter drive curve
  const normalizedDrive = (driveAmount - 1.0) / 6.0; // Reduced from /4.0
  
  // Stronger gain compensation
  const gainCompensation = 1.0 / (1.0 + normalizedDrive * 0.7); // Increased from 0.5
  
  // Higher threshold for preservation
  const absInput = Math.abs(input);
  const sign = Math.sign(input);
  
  if (absInput < 0.5) { // Increased from 0.4
    // Preserve more details
    return input * gainCompensation;
  } else {
    // Gentler soft clipping with higher threshold
    const softClipped = sign * (1.0 - Math.exp(-(absInput - 0.5) * (0.8 + normalizedDrive))) / (1.0 - Math.exp(-0.8)) + sign * 0.5;
    return softClipped * gainCompensation;
  }
}
  // In process method, replace the existing input gain handling:
process(inputs, outputs, parameters) {
  const input = inputs[0];
  const output = outputs[0];
  
  if (!input || input.length === 0) return true;
  
  this.ensureChannelFilters(input.length);
  
  // Extract parameters
  const cutoff = parameters.cutoff;
  const resonance = parameters.resonance;
  const drive = parameters.drive[0];
  const saturation = parameters.saturation[0]; 
  const envelopeAmount = parameters.envelopeAmount;
  const keytrackAmount = parameters.keytrackAmount[0];
  const bassCompensation = parameters.bassCompensation[0];
  const currentMidiNote = parameters.currentMidiNote[0];
  const adsrValue = parameters.adsrValue;
  const inputGain = parameters.inputGain[0];
  
  // Update drive parameter as before
  this.setDrive(drive * (1.0 + saturation * 0.5));
  
  // Process each channel
  for (let channel = 0; channel < input.length; channel++) {
    const inputChannel = input[channel];
    const outputChannel = output[channel];
    const filter = this.channelFilters[channel];
    
    // Process each sample
    for (let i = 0; i < inputChannel.length; i++) {
      // Get current ADSR value
      const currentAdsrValue = adsrValue.length > 1 ? adsrValue[i] : adsrValue[0];
      
      // Get envelope modulation amount
      const envValue = envelopeAmount.length > 1 ? envelopeAmount[i] : envelopeAmount[0];
      
      // NEW: Calculate ADSR-modulated input gain (FIXED: This was missing)
      let effectiveInputGain = inputGain;
      if (envValue !== 0) {
        // Convert envelope amount from bipolar [-1,1] to unipolar [0,1] for input gain modulation
        const normalizedEnvAmount = (envValue + 1) * 0.5; // 0 = no effect, 1 = max effect
        
        if (normalizedEnvAmount > 0.5) { // Positive envelope effect
          // Scale input gain up with ADSR, more effect as normalizedEnvAmount approaches 1
          const envEffect = (normalizedEnvAmount - 0.5) * 2; // 0 to 1
          effectiveInputGain = inputGain * (1 + envEffect * currentAdsrValue * 3);
        } else if (normalizedEnvAmount < 0.5) { // Negative envelope effect
          // Scale input gain down with ADSR, more effect as normalizedEnvAmount approaches 0
          const envEffect = (0.5 - normalizedEnvAmount) * 2; // 0 to 1
          effectiveInputGain = inputGain * (1 - envEffect * currentAdsrValue);
        }
      }
      
      // Apply modulated input gain
      let inputSample = inputChannel[i] * effectiveInputGain;
      
      // Calculate the actual cutoff frequency
      let actualCutoff = cutoff.length > 1 ? cutoff[i] : cutoff[0];
      
      // Apply keytracking as before...
      if (keytrackAmount !== 0) {
        const noteFreqRatio = Math.pow(2, (currentMidiNote - 69) / 12);
        actualCutoff *= Math.pow(noteFreqRatio, keytrackAmount);
      }
      
      // Apply envelope modulation to cutoff with direct mapping at max
      if (envValue !== 0) {
  if (envValue > 0) {
    // Check if envelope amount is at maximum (bipolar scale: 1.0 = maximum)
    if (envValue >= 0.95) {
      // Direct logarithmic mapping from min to max frequency based on ADSR
      const minFreq = 8;
      const maxFreq = 16000;
      const logMinFreq = Math.log(minFreq);
      const logMaxFreq = Math.log(maxFreq);
      
      // Map ADSR value (0-1) directly to logarithmic frequency range
      const logFreq = logMinFreq + (currentAdsrValue * (logMaxFreq - logMinFreq));
      actualCutoff = Math.exp(logFreq);
      
      // Add debug logging for direct mapping
      if (i === 0) {
        console.log(`Direct ADSR mapping: ADSR=${currentAdsrValue.toFixed(2)}, Cutoff=${actualCutoff.toFixed(1)}Hz`);
      }
    } else {
      // Original behavior for non-maximum envelope amount
      const scaledEnv = Math.min(0.95, envValue);
      actualCutoff *= 1 + (scaledEnv * 8);
    }
  } else {
    // Keep existing negative envelope behavior
    actualCutoff *= Math.pow(10, envValue * 0.8);
  }
}
      
      // Rest of the processing remains the same...
      this.setCutoff(actualCutoff);
      const res = resonance.length > 1 ? resonance[i] : resonance[0];
      this.setResonance(res);
      
      // Continue with the rest of the filter processing as before
      const bassFactor = bassCompensation * 0.7 + 0.3;
      const effectiveK = this.K * bassFactor;
      
      const sigma = 
        filter.stage1.getFeedbackOutput() +
        filter.stage2.getFeedbackOutput() +
        filter.stage3.getFeedbackOutput() +
        filter.stage4.getFeedbackOutput();
      
      // Scale input by resonance factor
      inputSample *= 1.0 + effectiveK * 0.7;
      
      let u = (inputSample - effectiveK * sigma) * this.alpha0;
      
      if (this.saturation > 1.0) {
        u = this.softSaturate(u, this.saturation);
      }
      
      const stage1Out = filter.stage1.tick(u);
      const stage2Out = filter.stage2.tick(stage1Out);
      const stage3Out = filter.stage3.tick(stage2Out);
      const stage4Out = filter.stage4.tick(stage3Out);
      
      let filterOutput = 
        this.oberheimCoefs[0] * u +
        this.oberheimCoefs[1] * stage1Out +
        this.oberheimCoefs[2] * stage2Out +
        this.oberheimCoefs[3] * stage3Out +
        this.oberheimCoefs[4] * stage4Out;
      
      if (this.saturation > 1.0) {
        const postDrive = this.saturation;
        filterOutput = this.processWithDrive(filterOutput, postDrive);
      }
      
      outputChannel[i] = filterOutput;
    }
  }
  
  return true;
}
}

registerProcessor('moog-filter-processor', MoogFilterProcessor);