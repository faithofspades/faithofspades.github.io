class ShapeHoldProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'frequency', defaultValue: 440, minValue: -20000, maxValue: 20000, automationRate: 'a-rate' },
            { name: 'detune', defaultValue: 0, minValue: -1200, maxValue: 1200, automationRate: 'k-rate' },
            { name: 'holdAmount', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0, automationRate: 'a-rate' },
            { name: 'quantizeAmount', defaultValue: 0.0, minValue: 0.0, maxValue: 1.0, automationRate: 'a-rate' },
            { name: 'waveformType', defaultValue: 0, minValue: 0, maxValue: 4 },
            { name: 'gate', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
            // Use time-based reset detection
            { name: 'phaseReset', defaultValue: 0, minValue: 0, maxValue: Number.MAX_SAFE_INTEGER, automationRate: 'k-rate' }
        ];
    }

    constructor(options) {
        super(options);
        this.phase = 0.5; // Start at 180 degrees
        this.sampleRate = sampleRate;
        this._holdValues = [ 0.0, -1.0, 0.0, 1.0, 1.0 ];
        this._gateState = 'OPEN';
        this._lastSample = 0.0;
        this._prevGateValue = 1;
        this._currentGateTarget = 1;
        this._outputGain = 1.0;
        this._smoothingSteps = 32;
        this._smoothingCounter = 0;
        // CRITICAL FIX: Use time-based reset detection
        this._lastPhaseResetTime = 0;
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0];
        const channel = output[0];
        
        const frequencyValues = parameters.frequency;
        const detuneValues = parameters.detune;
        const holdAmountValues = parameters.holdAmount;
        const quantizeAmountValues = parameters.quantizeAmount;
        const waveformTypeValues = parameters.waveformType;
        const gateValues = parameters.gate;
        const phaseResetValues = parameters.phaseReset;

        // CRITICAL FIX: Only reset phase when we get a NEW reset signal
        const phaseResetTime = phaseResetValues[0];
        if (phaseResetTime > 0 && phaseResetTime !== this._lastPhaseResetTime) {
            // Reset to 180 degrees for zero-crossing
            this.phase = 0.5;
            this._lastPhaseResetTime = phaseResetTime;
        }

        const waveformType = waveformTypeValues[0];
        const holdValue = this._holdValues[waveformType] !== undefined ? this._holdValues[waveformType] : 0.0;

        for (let i = 0; i < channel.length; ++i) {
            // --- 1. ALWAYS GENERATE THE OSCILLATOR SAMPLE (FREE-RUNNING) ---
            const baseFreq = frequencyValues.length > 1 ? frequencyValues[i] : frequencyValues[0];
            const detune = detuneValues.length > 1 ? detuneValues[i] : detuneValues[0];
            const holdAmount = holdAmountValues.length > 1 ? holdAmountValues[i] : holdAmountValues[0];
            const quantizeAmount = quantizeAmountValues.length > 1 ? quantizeAmountValues[i] : quantizeAmountValues[0];
            
            const instantaneousFreq = baseFreq * Math.pow(2, detune / 1200);
            const phaseIncrementMagnitude = Math.abs(instantaneousFreq) / this.sampleRate;
            const phaseDirection = Math.sign(instantaneousFreq);
            
            this.phase += phaseIncrementMagnitude * phaseDirection;
            this.phase = this.phase - Math.floor(this.phase);
            
            const currentPhase = this.phase;
            const clampedHoldAmount = Math.max(0.0, Math.min(1.0, holdAmount));
            const activeRatio = 1.0 - clampedHoldAmount;
            let currentSample = 0;

            if (activeRatio <= 1e-6) {
                currentSample = holdValue;
            } else if (currentPhase < activeRatio) {
                const squeezedPhase = currentPhase / activeRatio;
                switch (waveformType) {
                    case 0: currentSample = Math.sin(squeezedPhase * 2 * Math.PI); break;
                    case 1: currentSample = (squeezedPhase * 2) - 1; break;
                    case 2: currentSample = 1 - 4 * Math.abs(Math.round(squeezedPhase - 0.25) - (squeezedPhase - 0.25)); break;
                    case 3: currentSample = squeezedPhase < 0.5 ? 1 : -1; break;
                    case 4: {
                        const dutyCycle = 0.25 + (clampedHoldAmount * 0.75);
                        currentSample = squeezedPhase < dutyCycle ? 1 : -1;
                        break;
                    }
                    default: currentSample = Math.sin(squeezedPhase * 2 * Math.PI);
                }
            } else {
                currentSample = holdValue;
            }

            // Quantization (Bitcrushing)
            const clampedQuantize = Math.max(0.0, Math.min(1.0, quantizeAmount));
            if (clampedQuantize > 0.005) {
                const factor = Math.pow(1 - clampedQuantize, 2);
                const calculatedSteps = 4 + (256 - 4) * factor;
                const steps = Math.max(4, Math.floor(calculatedSteps));
                if (steps < 256) {
                    const normalizedSample = (currentSample + 1) / 2;
                    const quantizedScaled = Math.floor(normalizedSample * (steps - 1));
                    const quantizedNormalized = (steps > 1) ? quantizedScaled / (steps - 1) : quantizedScaled;
                    currentSample = quantizedNormalized * 2 - 1;
                }
            }

            // --- 2. IMPROVED GATE HANDLING ---
            const gateCommand = gateValues.length > 1 ? gateValues[i] : gateValues[0];
            // REPLACEMENT LOGIC STARTS HERE
            const gateChanged = gateCommand !== this._prevGateValue;
            this._prevGateValue = gateCommand;

            if (gateChanged) {
                const isOpening = this._gateState === 'CLOSED' || this._gateState === 'CLOSING';
                const isClosing = this._gateState === 'OPEN' || this._gateState === 'OPENING';
                
                if (gateCommand > 0.5 && isOpening) {
                    this._gateState = 'OPENING';
                    this._currentGateTarget = 1;
                } else if (gateCommand < 0.5 && isClosing) {
                    this._gateState = 'CLOSING';
                    this._currentGateTarget = 0;
                }
            }
            
            // Zero-crossing detection for clean transitions
            const zeroCrossingOccurred = (this._lastSample > 0 && currentSample <= 0) || 
                                         (this._lastSample < 0 && currentSample >= 0);

            // Update state based on zero-crossings
            if (zeroCrossingOccurred) {
                if (this._gateState === 'CLOSING') {
                    this._gateState = 'CLOSED';
                } else if (this._gateState === 'OPENING') {
                    this._gateState = 'OPEN';
                }
            }

            // --- 3. DETERMINE OUTPUT BASED ON GATE STATE ---
            let outputSample = 0;
            
            switch (this._gateState) {
                case 'OPEN':
                    outputSample = currentSample;
                    break;
                case 'CLOSING':
                    outputSample = currentSample;
                    break;
                case 'CLOSED':
                    outputSample = 0;
                    break;
                case 'OPENING':
                    outputSample = zeroCrossingOccurred ? currentSample : 0;
                    break;
            }
            
            // Apply smooth gain transitions when forcing gate changes
            if (this._smoothingCounter > 0) {
                const targetGain = (this._currentGateTarget > 0.5) ? 1.0 : 0.0;
                this._outputGain += (targetGain - this._outputGain) / this._smoothingCounter;
                this._smoothingCounter--;
                outputSample *= this._outputGain;
            }
            
            channel[i] = outputSample;
            
            // Update the last sample value for the next iteration's zero-crossing check
            this._lastSample = currentSample;
        }
        return true;
    }
}
registerProcessor('shape-hold-processor', ShapeHoldProcessor);