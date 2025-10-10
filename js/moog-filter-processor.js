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
      { name: 'currentMidiNote', defaultValue: 69, minValue: 0, maxValue: 127, automationRate: 'k-rate' }
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
      this.reset();
    }
  }
  
  // Fast approximation of tanh for efficiency
  fastTanh(x) {
    // Simple approximation that's good enough for audio
    return Math.tanh(x);
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
    
    // Scale resonance from [0,1] to a K value
    // The original maps resonance [1,10] to K [0,4]
    // So we map [0,1] to K [0,4] with a non-linear curve
    if (normalizedRes < 0.2) {
      // Gentle slope at the low end
      this.K = normalizedRes * 2.0;
    } else if (normalizedRes < 0.6) {
      // Mid range
      const t = (normalizedRes - 0.2) / 0.4;
      this.K = 0.4 + t * t * 1.6;
    } else {
      // High range - aggressive curve for more musical resonance
      const t = (normalizedRes - 0.6) / 0.4;
      this.K = 2.0 + t * t * 2.0;
    }
    
    // Update alpha0 since it depends on K
    this.alpha0 = 1.0 / (1.0 + this.K * this.gamma);
  }
  
  setDrive(driveAmount) {
    // Adjust saturation based on drive amount
    this.saturation = driveAmount;
  }
  
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    if (!input || input.length === 0) return true;
    
    // Ensure we have filters for all channels
    this.ensureChannelFilters(input.length);
    
    // Extract parameters
    const cutoff = parameters.cutoff;
    const resonance = parameters.resonance;
    const drive = parameters.drive[0]; // k-rate
    const saturation = parameters.saturation[0]; // k-rate
    const envelopeAmount = parameters.envelopeAmount;
    const keytrackAmount = parameters.keytrackAmount[0]; // k-rate
    const bassCompensation = parameters.bassCompensation[0]; // k-rate
    const currentMidiNote = parameters.currentMidiNote[0]; // k-rate
    
    // Update drive parameter
    this.setDrive(drive * (1.0 + saturation * 0.5));
    
    // Process each channel
    for (let channel = 0; channel < input.length; channel++) {
      const inputChannel = input[channel];
      const outputChannel = output[channel];
      const filter = this.channelFilters[channel];
      
      // Process each sample
      for (let i = 0; i < inputChannel.length; i++) {
        // Calculate the actual cutoff frequency based on keytracking and envelope
        let actualCutoff = cutoff.length > 1 ? cutoff[i] : cutoff[0];
        
        // Apply keytracking
        if (keytrackAmount !== 0) {
          const noteFreqRatio = Math.pow(2, (currentMidiNote - 69) / 12);
          actualCutoff *= Math.pow(noteFreqRatio, keytrackAmount);
        }
        
        // Apply envelope modulation
        if (envelopeAmount.length > 1) {
          const envValue = envelopeAmount[i];
          if (envValue !== 0) {
            if (envValue > 0) {
              const scaledEnv = Math.min(0.95, envValue);
              actualCutoff *= 1 + (scaledEnv * 8);
            } else {
              actualCutoff *= Math.pow(10, envValue * 0.8);
            }
          }
        } else if (envelopeAmount[0] !== 0) {
          const envValue = envelopeAmount[0];
          if (envValue > 0) {
            const scaledEnv = Math.min(0.95, envValue);
            actualCutoff *= 1 + (scaledEnv * 8);
          } else {
            actualCutoff *= Math.pow(10, envValue * 0.8);
          }
        }
        
        // Update filter cutoff
        this.setCutoff(actualCutoff);
        
        // Get resonance for this sample
        const res = resonance.length > 1 ? resonance[i] : resonance[0];
        this.setResonance(res);
        
        // Apply bass compensation if needed
        // In the Oberheim model, bass comp affects the feedback path
        const bassFactor = bassCompensation * 0.7 + 0.3;
        const effectiveK = this.K * bassFactor;
        
        // Get input sample
        let inputSample = inputChannel[i];
        
        // Calculate feedback from all stages
        const sigma = 
          filter.stage1.getFeedbackOutput() +
          filter.stage2.getFeedbackOutput() +
          filter.stage3.getFeedbackOutput() +
          filter.stage4.getFeedbackOutput();
        
        // Scale input by resonance factor
        inputSample *= 1.0 + effectiveK;
        
        // Calculate input to first filter
        let u = (inputSample - effectiveK * sigma) * this.alpha0;
        
        // Apply saturation to input
        u = this.fastTanh(this.saturation * u);
        
        // Process through each filter stage
        const stage1Out = filter.stage1.tick(u);
        const stage2Out = filter.stage2.tick(stage1Out);
        const stage3Out = filter.stage3.tick(stage2Out);
        const stage4Out = filter.stage4.tick(stage3Out);
        
        // Mix outputs according to Oberheim coefficients
        outputChannel[i] = 
          this.oberheimCoefs[0] * u +
          this.oberheimCoefs[1] * stage1Out +
          this.oberheimCoefs[2] * stage2Out +
          this.oberheimCoefs[3] * stage3Out +
          this.oberheimCoefs[4] * stage4Out;
      }
    }
    
    return true; // Keep the processor alive
  }
}

registerProcessor('moog-filter-processor', MoogFilterProcessor);