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
            
            // Generate all waveforms
            
            // Sawtooth: Linear ramp from -1 to 1
            const sawtoothCore = (this.localPhase * 2) - 1;
            
            // Sine: Use Math.sin for proper sine wave
            const sineWave = Math.sin(this.localPhase * 2 * Math.PI);
            
            // Triangle: Create from phase with proper shape
            let triangleWave;
            if (this.localPhase < 0.25) {
                // Rising from 0 to 1 (first quarter)
                triangleWave = this.localPhase * 4;
            } else if (this.localPhase < 0.75) {
                // Falling from 1 to -1 (middle half)
                triangleWave = 2 - (this.localPhase * 4);
            } else {
                // Rising from -1 to 0 (last quarter)
                triangleWave = (this.localPhase * 4) - 4;
            }
            
            // Pulse wave via comparison (Juno-style)
            const pw = pulseWidth.length > 1 ? pulseWidth[i] : pulseWidth[0];
            const pulseWave = this.localPhase < pw ? 1 : -1;
            
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
            
            // Output with reduced volume to avoid clipping
            channel[i] = mixedSample * 0.3;
        }
        
        return true;
    }
}

registerProcessor('juno-voice-processor', JunoVoiceProcessor);