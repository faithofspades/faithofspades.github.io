class ShapeHoldProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'frequency', defaultValue: 440, minValue: 20, maxValue: 20000, automationRate: 'k-rate' },
            { name: 'detune', defaultValue: 0, minValue: -1200, maxValue: 1200, automationRate: 'k-rate' },
            { name: 'holdAmount', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0, automationRate: 'a-rate' }, // Controls shape/PWM
            // <<< ADD quantizeAmount parameter >>>
            { name: 'quantizeAmount', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0, automationRate: 'a-rate' },
            // <<< Extend waveformType range >>>
            { name: 'waveformType', defaultValue: 0, minValue: 0, maxValue: 4 } // 0:sine, 1:saw, 2:tri, 3:square, 4:pulse
        ];
    }

    constructor(options) {
        super(options);
        this.phase = 0;
        this.sampleRate = sampleRate;
        // <<< Add start value for pulse >>>
        this._holdValues = [ 0.0, -1.0, 0.0, 1.0, 1.0 ]; // sine, saw, tri, square, pulse start values
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0];
        const outputChannel = output[0];

        const frequencyValues = parameters.frequency;
        const detuneValues = parameters.detune;
        const holdAmountValues = parameters.holdAmount;
        const quantizeAmountValues = parameters.quantizeAmount; // <<< Get quantize values
        const waveformTypeValues = parameters.waveformType;

        const waveformType = waveformTypeValues[0];
        const holdValue = this._holdValues[waveformType] !== undefined ? this._holdValues[waveformType] : 0.0;

        for (let i = 0; i < outputChannel.length; ++i) {
            const freq = frequencyValues.length > 1 ? frequencyValues[i] : frequencyValues[0];
            const detune = detuneValues.length > 1 ? detuneValues[i] : detuneValues[0];
            const holdAmount = holdAmountValues.length > 1 ? holdAmountValues[i] : holdAmountValues[0];
            const quantizeAmount = quantizeAmountValues.length > 1 ? quantizeAmountValues[i] : quantizeAmountValues[0]; // <<< Read quantize amount

            const effectiveFreq = freq * Math.pow(2, detune / 1200);
            const phaseIncrement = effectiveFreq / this.sampleRate;

            const clampedHoldAmount = Math.max(0.0, Math.min(1.0, holdAmount));
            const activeRatio = 1.0 - clampedHoldAmount;

            let sample = 0; // Initialize sample value

            if (activeRatio <= 1e-6) {
                sample = holdValue; // Output only the hold value if fully held
            } else if (this.phase < activeRatio) {
                const squeezedPhase = this.phase / activeRatio;

                switch (waveformType) {
                    case 0: sample = Math.sin(squeezedPhase * 2 * Math.PI); break; // Sine
                    case 1: sample = (squeezedPhase * 2) - 1; break; // Saw
                    case 2: sample = 1 - 4 * Math.abs(Math.round(squeezedPhase - 0.25) - (squeezedPhase - 0.25)); break; // Tri
                    case 3: sample = squeezedPhase < 0.5 ? 1 : -1; break; // Square (50% duty)
                    // <<< ADD case 4 for Pulse >>>
                    case 4: {
                        // Map holdAmount (0-1) to duty cycle (0.25-1.0) for pulse wave
                        const dutyCycle = 0.25 + (clampedHoldAmount * 0.75);
                        sample = squeezedPhase < dutyCycle ? 1 : -1;
                        break;
                    }
                    default: sample = Math.sin(squeezedPhase * 2 * Math.PI); // Sine fallback
                }
            } else {
                // Hold phase
                sample = holdValue;
            }

            // <<< APPLY QUANTIZATION >>>
            const clampedQuantize = Math.max(0.0, Math.min(1.0, quantizeAmount));
            if (clampedQuantize > 0.005) { // Only apply if amount is significant
                // Map 0-1 quantize amount to steps (e.g., 256 down to 2)
                // Use exponential mapping for smoother control at low quantization levels
                const steps = Math.max(2, Math.floor(Math.pow(2, 8 * (1 - clampedQuantize))));
                if (steps < 256) { // Avoid quantizing if steps are too high
                   sample = Math.round(sample * steps) / steps;
                }
            }

            outputChannel[i] = sample; // Output the potentially modified sample

            // Increment and wrap phase
            this.phase += phaseIncrement;
            if (this.phase >= 1.0) {
                this.phase -= 1.0;
            }
        }
        return true;
    }
}
registerProcessor('shape-hold-processor', ShapeHoldProcessor);