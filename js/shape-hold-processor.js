class ShapeHoldProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            // Frequency is modulated for Linear TZFM
            { name: 'frequency', defaultValue: 440, minValue: -20000, maxValue: 20000, automationRate: 'a-rate' }, // Allow negative target
            { name: 'detune', defaultValue: 0, minValue: -1200, maxValue: 1200, automationRate: 'k-rate' },
            { name: 'holdAmount', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0, automationRate: 'a-rate' },
            { name: 'quantizeAmount', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0, automationRate: 'a-rate' },
            { name: 'waveformType', defaultValue: 0, minValue: 0, maxValue: 4 },
            { name: 'phaseReset', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' } // Phase reset parameter
            // No separate phaseModulation parameter needed for this approach
        ];
    }

    constructor(options) {
        super(options);
        this.phase = 0;
        this.sampleRate = sampleRate;
        this._holdValues = [ 0.0, -1.0, 0.0, 1.0, 1.0 ];
    }

    process(inputs, outputs, parameters) {
    const output = outputs[0];
    const channel = output[0]; // You correctly define 'channel' here
    
    // Handle phase reset FIRST
    const phaseReset = parameters.phaseReset;
    const phaseResetValue = phaseReset ? phaseReset[0] : 0;
    
    if (phaseResetValue > 0.5) {
        this.phase = 0; // Reset to exact zero phase (also fix: use 'this.phase' not 'this._phase')
    }
    
    const frequencyValues = parameters.frequency;
    const detuneValues = parameters.detune;
    const holdAmountValues = parameters.holdAmount;
    const quantizeAmountValues = parameters.quantizeAmount;
    const waveformTypeValues = parameters.waveformType;

    const waveformType = waveformTypeValues[0];
    const holdValue = this._holdValues[waveformType] !== undefined ? this._holdValues[waveformType] : 0.0;

    // FIX: Use 'channel.length' instead of 'outputChannel.length'
    for (let i = 0; i < channel.length; ++i) {
        // --- Calculate Instantaneous Frequency ---
        const baseFreq = frequencyValues.length > 1 ? frequencyValues[i] : frequencyValues[0];
        const detune = detuneValues.length > 1 ? detuneValues[i] : detuneValues[0];
        const holdAmount = holdAmountValues.length > 1 ? holdAmountValues[i] : holdAmountValues[0];
        const quantizeAmount = quantizeAmountValues.length > 1 ? quantizeAmountValues[i] : quantizeAmountValues[0];

        // Apply detune AFTER getting the modulated frequency
        const instantaneousFreq = baseFreq * Math.pow(2, detune / 1200);

        // Calculate Phase Increment based on ABSOLUTE frequency
        const phaseIncrementMagnitude = Math.abs(instantaneousFreq) / this.sampleRate;
        const phaseDirection = Math.sign(instantaneousFreq);

        // Apply phase increment
        this.phase += phaseIncrementMagnitude * phaseDirection;
        this.phase = this.phase - Math.floor(this.phase);

        // --- Waveform Generation ---
        const currentPhase = this.phase;
        const clampedHoldAmount = Math.max(0.0, Math.min(1.0, holdAmount));
        const activeRatio = 1.0 - clampedHoldAmount;
        let sample = 0;

        if (activeRatio <= 1e-6) {
            sample = holdValue;
        } else if (currentPhase < activeRatio) {
            const squeezedPhase = currentPhase / activeRatio;
            switch (waveformType) {
                case 0: sample = Math.sin(squeezedPhase * 2 * Math.PI); break; // Sine
                case 1: sample = (squeezedPhase * 2) - 1; break; // Saw
                case 2: sample = 1 - 4 * Math.abs(Math.round(squeezedPhase - 0.25) - (squeezedPhase - 0.25)); break; // Tri
                case 3: sample = squeezedPhase < 0.5 ? 1 : -1; break; // Square
                case 4: {
                    const dutyCycle = 0.25 + (clampedHoldAmount * 0.75);
                    sample = squeezedPhase < dutyCycle ? 1 : -1;
                    break;
                }
                default: sample = Math.sin(squeezedPhase * 2 * Math.PI);
            }
        } else {
            sample = holdValue;
        }

        // Quantization
        const clampedQuantize = Math.max(0.0, Math.min(1.0, quantizeAmount));
        if (clampedQuantize > 0.005) {
            const factor = Math.pow(1 - clampedQuantize, 2);
            const calculatedSteps = 4 + (256 - 4) * factor;
            const steps = Math.max(4, Math.floor(calculatedSteps));
            if (steps < 256) {
                const normalizedSample = (sample + 1) / 2;
                const quantizedScaled = Math.floor(normalizedSample * (steps - 1));
                const quantizedNormalized = (steps > 1) ? quantizedScaled / (steps - 1) : quantizedScaled;
                sample = quantizedNormalized * 2 - 1;
            }
        }

        // FIX: Use 'channel[i]' instead of 'outputChannel[i]'
        channel[i] = sample;
    }
    
    return true;
}
}
registerProcessor('shape-hold-processor', ShapeHoldProcessor);