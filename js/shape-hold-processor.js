class ShapeHoldProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            // <<< CHANGE frequency automationRate >>>
            { name: 'frequency', defaultValue: 440, minValue: 20, maxValue: 20000, automationRate: 'a-rate' },
            { name: 'detune', defaultValue: 0, minValue: -1200, maxValue: 1200, automationRate: 'k-rate' },
            { name: 'holdAmount', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0, automationRate: 'a-rate' },
            { name: 'quantizeAmount', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0, automationRate: 'a-rate' },
            { name: 'waveformType', defaultValue: 0, minValue: 0, maxValue: 4 }
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

                // <<< ADJUSTED MAPPING: Map quantizeAmount (0-1) to steps (256 down to 4) >>>
                // Use power curve (pow(2)) on the inverse amount for smoother transition
                const factor = Math.pow(1 - clampedQuantize, 2); // Curve factor (1 down to 0)

                // Linearly interpolate steps between 4 (min) and 256 (max) using the factor
                // When factor = 1 (quantize=0), steps = 4 + 252 * 1 = 256
                // When factor = 0 (quantize=1), steps = 4 + 252 * 0 = 4
                const calculatedSteps = 4 + (256 - 4) * factor; // Interpolate between 4 and 256

                // Use floor for integer steps and ensure minimum of 4
                const steps = Math.max(4, Math.floor(calculatedSteps)); // Ensure minimum is 4
                // <<< END ADJUSTED MAPPING >>>

                // Avoid quantizing if steps are effectively 256 (or very close)
                if (steps < 256) { // Check against 256 now
                   // <<< USE STANDARD QUANTIZATION FORMULA with FLOOR for harshness >>>
                   // 1. Normalize sample from [-1, 1] to [0, 1]
                   const normalizedSample = (sample + 1) / 2;
                   // 2. Scale by (steps - 1), apply floor
                   const quantizedScaled = Math.floor(normalizedSample * (steps - 1));
                   // 3. Divide by (steps - 1) to get quantized normalized value
                   const quantizedNormalized = (steps > 1) ? quantizedScaled / (steps - 1) : quantizedScaled;
                   // 4. Denormalize back to [-1, 1]
                   sample = quantizedNormalized * 2 - 1;
                   // <<< END STANDARD QUANTIZATION FORMULA >>>
                }
            }
            // <<< END QUANTIZATION >>>


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