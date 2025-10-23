class LP12FilterProcessor extends AudioWorkletProcessor {
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
      { name: 'inputGain', defaultValue: 1.0, minValue: 0.0, maxValue: 2.0, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    this.MOOG_PI = Math.PI;
    this.sampleRate = sampleRate;
    this.cutoff = 1000;
    this.resonance = 0.0;
    this.saturation = 1.0;
    this.K = 0.0;
    this.alpha0 = 1.0;
    this.gamma = 1.0;
    this.oberheimCoefs = [0.0, 0.0, 0.0, 0.0, 1.0];
    this.channelFilters = [];
    
    this.lastResonanceValue = 0;
    this.resonanceSmoothed = 0;
    
    this.port.onmessage = this.handleMessage.bind(this);
    console.log(`LP-12 Moog filter initialized at ${this.sampleRate}Hz`);
    this.port.postMessage({ type: 'initialized', sampleRate: this.sampleRate });
    
    this.envelopeFollower = 0.0;
    const attackTime = 0.001;
    const releaseTime = 0.001;
    this.attackCoef = Math.exp(-1.0 / (attackTime * sampleRate));
    this.releaseCoef = Math.exp(-1.0 / (releaseTime * sampleRate));
  }
  
  createOnePole() {
    return {
      alpha: 1.0,
      beta: 0.0,
      gamma: 1.0,
      delta: 0.0,
      epsilon: 0.0,
      a0: 1.0,
      feedback: 0.0,
      z1: 0.0,
      
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
      
      tick(input) {
        const scaledInput = input * this.gamma + this.feedback + 
                           this.epsilon * this.getFeedbackOutput();
        
        const vn = (this.a0 * scaledInput - this.z1) * this.alpha;
        const output = vn + this.z1;
        this.z1 = vn + output;
        
        return output;
      },
      
      setFeedback(fb) {
        this.feedback = fb;
      },
      
      getFeedbackOutput() {
        return this.beta * (this.z1 + this.feedback * this.delta);
      },
      
      setAlpha(a) {
        this.alpha = a;
      },
      
      setBeta(b) {
        this.beta = b;
      }
    };
  }
  
  createChannelFilter() {
    return {
      stage1: this.createOnePole(),
      stage2: this.createOnePole(),
      stage3: this.createOnePole(),
      stage4: this.createOnePole(),
      
      lastOutput: 0,
      resonanceFeedback: 0,
      
      reset() {
        this.stage1.reset();
        this.stage2.reset();
        this.stage3.reset();
        this.stage4.reset();
        this.lastOutput = 0;
        this.resonanceFeedback = 0;
      }
    };
  }
  
  ensureChannelFilters(numChannels) {
    while (this.channelFilters.length < numChannels) {
      this.channelFilters.push(this.createChannelFilter());
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
  
  // Simple post-filter diode processing - only controlled by resonance amount
  applyDiodeProcessing(input, resonanceAmount) {
    // No processing if resonance is zero
    if (resonanceAmount <= 0.0) return input;
    
    // First diode: reduce to 17%, apply sinusoidal transfer, boost by 2x
    let signal = input * 0.17;
    
    // Drive amount increases with resonance
    const drive = 1.0 + resonanceAmount * 4.0;
    
    // Apply sine waveshaping
    signal = Math.sin(signal * drive * Math.PI);
    
    // Hard clip with threshold that decreases as resonance increases
    const clipThreshold1 = 1.0 / (1.0 + resonanceAmount * 2.0);
    signal = Math.max(-clipThreshold1, Math.min(clipThreshold1, signal));
    
    // Normalize and boost by 2x (3dB)

    
    // Second diode: reduce to 36%, apply more extreme processing
    signal = signal * 0.36;
    
    // More extreme drive for second stage
    const drive2 = 1.0 + resonanceAmount * 4.0;
    
    // Apply sine waveshaping again
    signal = Math.sin(signal * drive2 * Math.PI);
    
    // Even harder clipping - approaches brick wall at high resonance
    const clipThreshold2 = 1.0 / (1.0 + resonanceAmount * 4.0);
    signal = Math.max(-clipThreshold2, Math.min(clipThreshold2, signal));
    
    // Normalize
    signal = signal / clipThreshold2;
    
    // Blend between clean and processed based on resonance
    // At 0 resonance: 100% clean
    // At full resonance: 100% processed
    return input * (1.0 - resonanceAmount) + signal * resonanceAmount;
  }
  
  setCutoff(cutoffHz) {
    this.cutoff = Math.max(8, Math.min(16000, cutoffHz));
    
    const wd = 2.0 * this.MOOG_PI * this.cutoff;
    const T = 1.0 / this.sampleRate;
    const wa = (2.0 / T) * Math.tan(wd * T / 2.0);
    const g = wa * T / 2.0;
    
    const G = g / (1.0 + g);
    
    for (const filter of this.channelFilters) {
      filter.stage1.setAlpha(G);
      filter.stage2.setAlpha(G);
      filter.stage3.setAlpha(G);
      filter.stage4.setAlpha(G);
      
      filter.stage1.setBeta(G * G * G / (1.0 + g));
      filter.stage2.setBeta(G * G / (1.0 + g));
      filter.stage3.setBeta(G / (1.0 + g));
      filter.stage4.setBeta(1.0 / (1.0 + g));
    }
    
    this.gamma = G * G * G * G;
    this.alpha0 = 1.0 / (1.0 + this.K * this.gamma);
    
    this.oberheimCoefs = [0.0, 0.0, 0.0, 0.0, 1.0];
  }
  
  setResonance(res) {
    const normalizedRes = Math.max(0, Math.min(1, res));
    const safeRes = Math.min(0.99, normalizedRes);
    
    this.resonanceSmoothed = this.resonanceSmoothed * 0.95 + safeRes * 0.05;
    const effectiveRes = this.resonanceSmoothed;
    
    this.resonance = effectiveRes;
    
    if (effectiveRes < 0.2) {
      this.K = effectiveRes * 2.0;
    } else if (effectiveRes < 0.6) {
      const t = (effectiveRes - 0.2) / 0.4;
      this.K = 0.4 + t * t * 1.6;
    } else {
      const t = (effectiveRes - 0.6) / 0.4;
      this.K = 2.0 + t * t * 1.95;
    }
    
    this.alpha0 = 1.0 / (1.0 + this.K * this.gamma);
  }
  
  setDrive(driveAmount) {
    this.drive = Math.max(0.1, Math.min(5.0, driveAmount));
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
    const bassCompensation = parameters.bassCompensation[0];
    const currentMidiNote = parameters.currentMidiNote[0];
    const adsrValue = parameters.adsrValue;
    const inputGain = parameters.inputGain[0];
    
    const effectiveDrive = drive * (1.0 + saturation * 0.5);
    this.setDrive(effectiveDrive);
    this.saturation = saturation;
    
    for (let channel = 0; channel < input.length; channel++) {
      const inputChannel = input[channel];
      const outputChannel = output[channel];
      const filter = this.channelFilters[channel];
      
      for (let i = 0; i < inputChannel.length; i++) {
        const currentAdsrValue = adsrValue.length > 1 ? adsrValue[i] : adsrValue[0];
        const envValue = envelopeAmount.length > 1 ? envelopeAmount[i] : envelopeAmount[0];
        
        let effectiveInputGain = inputGain;
        if (envValue !== 0) {
          const normalizedEnvAmount = (envValue + 1) * 0.5;
          
          if (normalizedEnvAmount > 0.5) {
            const envEffect = (normalizedEnvAmount - 0.5) * 2;
            effectiveInputGain = inputGain * (1 + envEffect * currentAdsrValue * 3);
          } else if (normalizedEnvAmount < 0.5) {
            const envEffect = (0.5 - normalizedEnvAmount) * 2;
            effectiveInputGain = inputGain * (1 - envEffect * currentAdsrValue);
          }
        }
        
        let inputSample = inputChannel[i] * effectiveInputGain;
        
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
              const maxFreq = 16000;
              
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
        
        this.setCutoff(actualCutoff);
        const res = resonance.length > 1 ? resonance[i] : resonance[0];
        this.setResonance(res);
        
        const bassFactor = bassCompensation * 0.7 + 0.3;
        const effectiveK = this.K * bassFactor;
        
        const sigma = 
          filter.stage1.getFeedbackOutput() +
          filter.stage2.getFeedbackOutput() +
          filter.stage3.getFeedbackOutput() +
          filter.stage4.getFeedbackOutput();
        
        // Standard Moog filter processing - NO diode processing here
        inputSample *= 1.0 + effectiveK * 0.7;
        let u = (inputSample - effectiveK * sigma) * this.alpha0;
        
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
        
        filter.lastOutput = filterOutput;
        
        // ONLY DIODE PROCESSING: Apply after all filter processing is complete
        // Controlled purely by resonance amount (0 to 1)
        filterOutput = this.applyDiodeProcessing(filterOutput, res);
        
        outputChannel[i] = filterOutput;
      }
    }
    
    return true;
  }
}

registerProcessor('lp-12-filter-processor', LP12FilterProcessor);