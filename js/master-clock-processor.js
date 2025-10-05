class MasterClockProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            // Master clock rates in Hz (base frequency before voice-specific scaling)
            { name: 'clock1Rate', defaultValue: 440, minValue: 0.1, maxValue: 20000, automationRate: 'a-rate' },
            { name: 'clock2Rate', defaultValue: 440, minValue: 0.1, maxValue: 20000, automationRate: 'a-rate' },
            // Global detune for each clock
            { name: 'clock1Detune', defaultValue: 0, minValue: -1200, maxValue: 1200, automationRate: 'k-rate' },
            { name: 'clock2Detune', defaultValue: 0, minValue: -1200, maxValue: 1200, automationRate: 'k-rate' },
        ];
    }

    constructor(options) {
        super(options);
        this.sampleRate = sampleRate;
        
        // Try to use SharedArrayBuffer if available (requires CORS headers)
        this.useSharedMemory = false;
        if (options && options.processorOptions && options.processorOptions.sharedBuffer) {
            try {
                this.sharedBuffer = options.processorOptions.sharedBuffer;
                this.sharedPhases = new Float32Array(this.sharedBuffer);
                this.useSharedMemory = true;
                console.log('MasterClockProcessor: Using SharedArrayBuffer for clock state');
            } catch (e) {
                console.log('MasterClockProcessor: SharedArrayBuffer not available, using message passing');
            }
        }
        
        // Local phase accumulators (always maintained)
        this.phase1 = 0;
        this.phase2 = 0;
        
        // For message passing fallback
        this.frameCounter = 0;
        this.updateInterval = 128; // Update main thread every N samples
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0];
        const channel0 = output[0];
        const channel1 = output[1] || output[0]; // Use mono if only one channel
        
        const clock1Rate = parameters.clock1Rate;
        const clock2Rate = parameters.clock2Rate;
        const clock1Detune = parameters.clock1Detune[0];
        const clock2Detune = parameters.clock2Detune[0];
        
        for (let i = 0; i < channel0.length; i++) {
            // Calculate actual frequencies with detune
            const freq1 = (clock1Rate.length > 1 ? clock1Rate[i] : clock1Rate[0]) * 
                          Math.pow(2, clock1Detune / 1200);
            const freq2 = (clock2Rate.length > 1 ? clock2Rate[i] : clock2Rate[0]) * 
                          Math.pow(2, clock2Detune / 1200);
            
            // Update phase accumulators
            this.phase1 += freq1 / this.sampleRate;
            this.phase2 += freq2 / this.sampleRate;
            
            // Wrap phases to 0-1 range
            this.phase1 = this.phase1 - Math.floor(this.phase1);
            this.phase2 = this.phase2 - Math.floor(this.phase2);
            
            // Generate basic sawtooth outputs for monitoring (optional)
            // These outputs are just for debugging - voices will read phases directly
            if (channel0) channel0[i] = this.phase1 * 2 - 1; // Sawtooth -1 to 1
            if (channel1 && channel1 !== channel0) channel1[i] = this.phase2 * 2 - 1;
        }
        
        // Update shared memory if available
        if (this.useSharedMemory && this.sharedPhases) {
            // Atomically update the shared phase values
            Atomics.store(this.sharedPhases, 0, this.phase1);
            Atomics.store(this.sharedPhases, 1, this.phase2);
        }
        
        // Send phase updates to main thread periodically (fallback or monitoring)
        this.frameCounter += channel0.length;
        if (this.frameCounter >= this.updateInterval) {
            this.frameCounter = 0;
            this.port.postMessage({
                type: 'phaseUpdate',
                phase1: this.phase1,
                phase2: this.phase2,
                timestamp: currentTime
            });
        }
        
        return true;
    }
}

registerProcessor('master-clock-processor', MasterClockProcessor);