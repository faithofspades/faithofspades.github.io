class JunoVoiceProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            // Which voice this is (0-5 for 6 voices)
            { name: 'voiceIndex', defaultValue: 0, minValue: 0, maxValue: 5 },
            // Which clock to use (0 = clock1, 1 = clock2)
            { name: 'clockSource', defaultValue: 0, minValue: 0, maxValue: 1 },
            // Basic frequency for fallback
            { name: 'frequency', defaultValue: 440, minValue: 0.1, maxValue: 20000, automationRate: 'a-rate' },
            { name: 'detune', defaultValue: 0, minValue: -1200, maxValue: 1200, automationRate: 'k-rate' },
            // Frequency ratio for this voice (relative to master clock)
            { name: 'frequencyRatio', defaultValue: 1, minValue: 0.0625, maxValue: 16, automationRate: 'a-rate' },
            // Waveform parameters - now includes sine and triangle levels
            { name: 'sawLevel', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
            { name: 'pulseLevel', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
            { name: 'sineLevel', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
            { name: 'triangleLevel', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
            { name: 'pulseWidth', defaultValue: 0.5, minValue: 0.05, maxValue: 0.95, automationRate: 'a-rate' },
            // Add quantization parameter
            { name: 'quantizeAmount', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0, automationRate: 'a-rate' },
            // Gate for this voice
            { name: 'gate', defaultValue: 0, minValue: 0, maxValue: 1 },
            // Phase reset trigger (only used on initial page load)
            { name: 'resetPhase', defaultValue: 0, minValue: 0, maxValue: 1 }
        ];
    }

    constructor(options) {
        super(options);
        this.sampleRate = sampleRate;
        
        // Try to access shared memory
        this.useSharedMemory = false;
        if (options && options.processorOptions && options.processorOptions.sharedBuffer) {
            try {
                this.sharedBuffer = options.processorOptions.sharedBuffer;
                this.sharedPhases = new Float32Array(this.sharedBuffer);
                this.useSharedMemory = true;
                console.log('JunoVoiceProcessor: Connected to shared clock buffer');
            } catch (e) {
                console.log('JunoVoiceProcessor: No shared buffer, using fallback oscillator');
            }
        }
        
        // Local state
        this.localPhase = 0;
        this.lastMasterPhase = 0;
        this.masterPhase1 = 0;
        this.masterPhase2 = 0;
        
        // Gate state
        this.lastResetTrigger = 0;
        this.gateOpen = false;
        this.hasBeenInitialized = false; // Track if we've ever reset phase
        
        // Sub-oscillator state for pulse wave generation
        this.subOscillatorPhase = 0;
        
        // Add state for improved pulse generation
        this.lastPulseValue = -1;
        this.pulseTransitionPos = 0;
        this.previousPW = 0.5;
        
        // Message handling for phase updates (fallback)
        this.port.onmessage = (event) => {
            if (event.data.type === 'phaseUpdate') {
                this.masterPhase1 = event.data.phase1;
                this.masterPhase2 = event.data.phase2;
            }
        };
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0];
        const channel = output[0];
        
        if (!channel) return true;
        
        const voiceIndex = parameters.voiceIndex[0];
        const clockSource = parameters.clockSource[0];
        const frequency = parameters.frequency;
        const detune = parameters.detune[0];
        const frequencyRatio = parameters.frequencyRatio;
        const sawLevel = parameters.sawLevel;
        const pulseLevel = parameters.pulseLevel;
        const sineLevel = parameters.sineLevel;
        const triangleLevel = parameters.triangleLevel;
        const pulseWidth = parameters.pulseWidth;
        // Get the quantize amount parameter
        const quantizeAmount = parameters.quantizeAmount;
        const gate = parameters.gate[0];
        const resetPhase = parameters.resetPhase[0];
        
        // Only reset phase on first initialization (page load)
        if (!this.hasBeenInitialized && resetPhase > 0.5) {
            this.localPhase = 0;
            this.subOscillatorPhase = 0;
            this.hasBeenInitialized = true;
            console.log(`Voice ${voiceIndex}: Initial phase reset`);
        }
        this.lastResetTrigger = resetPhase;
        
        // Simple gate check
        this.gateOpen = gate > 0.5;
        
        for (let i = 0; i < channel.length; i++) {
            if (!this.gateOpen) {
                channel[i] = 0;
                continue;
            }
            
            // Try to use master clock if available
            let phaseDelta = 0;
            
            if (this.useSharedMemory) {
                // Read from master clock via shared memory
                const masterPhase = Atomics.load(this.sharedPhases, clockSource);
                phaseDelta = masterPhase - this.lastMasterPhase;
                if (phaseDelta < 0) phaseDelta += 1; // Handle wrap
                this.lastMasterPhase = masterPhase;
            } else {
                // Fallback: generate own oscillator
                const freq = frequency.length > 1 ? frequency[i] : frequency[0];
                const detuneMultiplier = Math.pow(2, detune / 1200);
                const actualFreq = freq * detuneMultiplier;
                phaseDelta = actualFreq / this.sampleRate;
            }
            
            // Apply frequency ratio
            const ratio = frequencyRatio.length > 1 ? frequencyRatio[i] : frequencyRatio[0];
            this.localPhase += phaseDelta * ratio;
            
            // Wrap phase to 0-1 range
            if (this.localPhase >= 1) {
                this.localPhase -= Math.floor(this.localPhase);
            }
            
            // Get pulse width for this sample
            const pw = pulseWidth.length > 1 ? pulseWidth[i] : pulseWidth[0];
            const clampedPW = Math.max(0.05, Math.min(0.95, pw));
            
            // IMPORTANT: Apply PWM to all waveforms by warping the phase
            // This is similar to how shape-hold-processor.js does it
            let modifiedPhase = this.localPhase;
            
            // Apply phase warping based on pulse width only when different from default
if (Math.abs(clampedPW - 0.5) > 0.001) {
    // Map PWM to phase warping - different for each half of the cycle
    if (this.localPhase < 0.5) {
        // First half of the waveform - compress/expand
        modifiedPhase = this.localPhase * (clampedPW * 2);
    } else {
        // Second half - compress/expand inversely
        modifiedPhase = 0.5 + ((this.localPhase - 0.5) * ((1 - clampedPW) * 2));
    }
    
    // Ensure phase stays in 0-1 range
    modifiedPhase = Math.max(0, Math.min(1, modifiedPhase));
}
            
            // Generate all waveforms using the modified phase
            
            // Sawtooth: Linear ramp from -1 to 1
            const sawtoothCore = (modifiedPhase * 2) - 1;
            
            // Sine: Use Math.sin for proper sine wave
            const sineWave = Math.sin(modifiedPhase * 2 * Math.PI);
            
            // Triangle: Create from phase with proper shape
            let triangleWave;
            if (modifiedPhase < 0.25) {
                // Rising from 0 to 1 (first quarter)
                triangleWave = modifiedPhase * 4;
            } else if (modifiedPhase < 0.75) {
                // Falling from 1 to -1 (middle half)
                triangleWave = 2 - (modifiedPhase * 4);
            } else {
                // Rising from -1 to 0 (last quarter)
                triangleWave = (modifiedPhase * 4) - 4;
            }
            
            // Pulse: Standard pulse wave with direct pulse width control
            let pulseWave;
            if (this.localPhase < clampedPW) {
                // Phase is in the "high" part of the pulse wave
                pulseWave = 1;
            } else {
                // Phase is in the "low" part of the pulse wave
                pulseWave = -1;
            }
            
            // When there's a significant PW change, track it for smoother transitions
            if (Math.abs(this.previousPW - clampedPW) > 0.01) {
                this.pulseTransitionPos = this.localPhase;
                this.previousPW = clampedPW;
            }
            
            // Store last value for potential zero-crossing detection later
            this.lastPulseValue = pulseWave;
            
            // Get level parameters for this sample
            const sawLvl = sawLevel.length > 1 ? sawLevel[i] : sawLevel[0];
            const pulseLvl = pulseLevel.length > 1 ? pulseLevel[i] : pulseLevel[0];
            const sineLvl = sineLevel.length > 1 ? sineLevel[i] : sineLevel[0];
            const triangleLvl = triangleLevel.length > 1 ? triangleLevel[i] : triangleLevel[0];
            
            // Mix waveforms based on levels
            let mixedSample = 0;
            mixedSample += sawtoothCore * sawLvl;
            mixedSample += pulseWave * pulseLvl;
            mixedSample += sineWave * sineLvl;
            mixedSample += triangleWave * triangleLvl;
            
            // Normalize if multiple waveforms are mixed
            const totalLevel = Math.max(0.001, sawLvl + pulseLvl + sineLvl + triangleLvl);
            if (totalLevel > 1) {
                mixedSample /= totalLevel;
            }
            
            // Apply quantization (bitcrushing) effect
            const quantizeAmt = quantizeAmount.length > 1 ? quantizeAmount[i] : quantizeAmount[0];
            if (quantizeAmt > 0.005) {
                // Convert the quantization amount to number of steps
                // Smaller values = more quantization (fewer steps)
                const factor = Math.pow(1 - quantizeAmt, 2);
                const calculatedSteps = 4 + (256 - 4) * factor;
                const steps = Math.max(4, Math.floor(calculatedSteps));
                
                if (steps < 256) {
                    // Normalize the sample to 0-1 range
                    const normalizedSample = (mixedSample + 1) / 2;
                    // Quantize to discrete steps
                    const quantizedScaled = Math.floor(normalizedSample * (steps - 1));
                    // Convert back to normalized 0-1
                    const quantizedNormalized = (steps > 1) ? quantizedScaled / (steps - 1) : quantizedScaled;
                    // Convert back to -1 to 1 range
                    mixedSample = quantizedNormalized * 2 - 1;
                }
            }
            
            // Output with reduced volume to avoid clipping
            channel[i] = mixedSample * 0.3;
        }
        
        return true;
    }
}

registerProcessor('juno-voice-processor', JunoVoiceProcessor);