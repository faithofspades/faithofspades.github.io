const EPSILON = 1e-20;

function linearToDb(value) {
    return 20 * Math.log10(Math.max(value, EPSILON));
}

function dbToLinear(db) {
    return Math.pow(10, db / 20);
}

class SafetyLimiterProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.thresholdDb = -1;
        this.kneeDb = 6;
        this.attackMs = 1;
        this.holdMs = 10;
        this.releaseMs = 100;
        this.lookaheadMs = 1;
        this.detectorAttackMs = 0.4;
        this.detectorReleaseMs = 40;

        this._configureTimeConstants();
        this._configureLookaheadBuffer();
        this._configureDetectorEnvelope();

        this.currentGain = 1;
        this.targetGain = 1;
        this.holdCounter = 0;
        this.meterAccumulator = 0;
        this.meterSamples = 0;
        this.meterInterval = Math.round(sampleRate * 0.05); // ~50ms
        this.detectorEnv = 0;

        this.port.onmessage = (event) => {
            if (!event || !event.data) {
                return;
            }
            const data = event.data;
            if (data.type === 'config') {
                if (typeof data.thresholdDb === 'number') this.thresholdDb = data.thresholdDb;
                if (typeof data.kneeDb === 'number') this.kneeDb = Math.max(0, data.kneeDb);
                if (typeof data.attackMs === 'number') this.attackMs = Math.max(0.05, data.attackMs);
                if (typeof data.holdMs === 'number') this.holdMs = Math.max(0, data.holdMs);
                if (typeof data.releaseMs === 'number') this.releaseMs = Math.max(10, data.releaseMs);
                if (typeof data.lookaheadMs === 'number') this.lookaheadMs = Math.min(1, Math.max(0.1, data.lookaheadMs));
                if (typeof data.detectorAttackMs === 'number') this.detectorAttackMs = Math.max(0.05, data.detectorAttackMs);
                if (typeof data.detectorReleaseMs === 'number') this.detectorReleaseMs = Math.max(5, data.detectorReleaseMs);
                this._configureTimeConstants();
                this._configureLookaheadBuffer();
                this._configureDetectorEnvelope();
            }
        };
    }

    _configureTimeConstants() {
        const attackTime = this.attackMs / 1000;
        const releaseTime = this.releaseMs / 1000;
        this.attackCoef = Math.exp(-1 / Math.max(1, attackTime * sampleRate));
        this.releaseCoef = Math.exp(-1 / Math.max(1, releaseTime * sampleRate));
        this.holdSamples = Math.round((this.holdMs / 1000) * sampleRate);
    }

    _configureLookaheadBuffer() {
        const lookaheadSamples = Math.max(1, Math.round((this.lookaheadMs / 1000) * sampleRate));
        this.lookaheadSamples = lookaheadSamples;
        const bufferLength = lookaheadSamples + 128;
        this.delayBuffers = [new Float32Array(bufferLength), new Float32Array(bufferLength)];
        this.delayWriteIndex = 0;
        this.delayBufferLength = bufferLength;
    }

    _configureDetectorEnvelope() {
        const attackTime = Math.max(0.0001, this.detectorAttackMs / 1000);
        const releaseTime = Math.max(0.001, this.detectorReleaseMs / 1000);
        this.detectorAttackStep = 1 - Math.exp(-1 / (attackTime * sampleRate));
        this.detectorReleaseStep = 1 - Math.exp(-1 / (releaseTime * sampleRate));
    }

    _computeGain(samplePeak) {
        const thresholdDb = this.thresholdDb;
        const kneeDb = this.kneeDb;
        const levelDb = linearToDb(samplePeak);
        const lowerKnee = thresholdDb - kneeDb / 2;
        const upperKnee = thresholdDb + kneeDb / 2;

        let gainDb = 0;
        if (levelDb <= lowerKnee) {
            gainDb = 0;
        } else if (levelDb >= upperKnee) {
            gainDb = thresholdDb - levelDb;
        } else {
            const x = (levelDb - lowerKnee) / Math.max(kneeDb, EPSILON);
            gainDb = - (x * x) * (kneeDb / 2);
        }
        return dbToLinear(gainDb);
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        if (!input || !input.length || !output || !output.length) {
            return true;
        }

        const channelCount = Math.min(input.length, output.length, this.delayBuffers.length);
        for (let ch = 0; ch < channelCount; ch++) {
            if (!input[ch] || !output[ch]) {
                return true;
            }
        }

        const frameSamples = input[0].length;
        const outputCeiling = dbToLinear(this.thresholdDb - 0.3);
        for (let i = 0; i < frameSamples; i++) {
            let peak = 0;
            for (let ch = 0; ch < channelCount; ch++) {
                const sample = input[ch][i] || 0;
                this.delayBuffers[ch][this.delayWriteIndex] = sample;
                peak = Math.max(peak, Math.abs(sample));
            }

            if (peak >= this.detectorEnv) {
                this.detectorEnv += (peak - this.detectorEnv) * this.detectorAttackStep;
            } else {
                this.detectorEnv += (peak - this.detectorEnv) * this.detectorReleaseStep;
            }
            const detectorLevel = Math.max(peak, this.detectorEnv);

            const requiredGain = detectorLevel > 0 ? this._computeGain(detectorLevel) : 1;
            if (requiredGain < this.targetGain) {
                this.targetGain = requiredGain;
                this.holdCounter = this.holdSamples;
            } else if (this.holdCounter > 0) {
                this.holdCounter--;
            } else {
                this.targetGain += (1 - this.targetGain) * (1 - this.releaseCoef);
                if (this.targetGain > 1) {
                    this.targetGain = 1;
                }
            }

            if (this.currentGain > this.targetGain) {
                this.currentGain = this.targetGain + (this.currentGain - this.targetGain) * this.attackCoef;
            } else {
                this.currentGain = this.currentGain + (this.targetGain - this.currentGain) * (1 - this.releaseCoef);
            }

            const readIndex = (this.delayWriteIndex + this.delayBufferLength - this.lookaheadSamples) % this.delayBufferLength;
            for (let ch = 0; ch < channelCount; ch++) {
                const delayedSample = this.delayBuffers[ch][readIndex];
                let processed = delayedSample * this.currentGain;
                if (processed > outputCeiling) {
                    processed = outputCeiling;
                } else if (processed < -outputCeiling) {
                    processed = -outputCeiling;
                }
                output[ch][i] = processed;
            }

            this.delayWriteIndex++;
            if (this.delayWriteIndex >= this.delayBufferLength) {
                this.delayWriteIndex = 0;
            }

            this.meterAccumulator += 1 - this.currentGain;
            this.meterSamples++;
            if (this.meterSamples >= this.meterInterval) {
                const reduction = this.meterAccumulator / this.meterSamples;
                if (reduction > 0.001) {
                    this.port.postMessage({ type: 'gainReduction', reduction });
                }
                this.meterAccumulator = 0;
                this.meterSamples = 0;
            }
        }

        return true;
    }
}

registerProcessor('safety-limiter-processor', SafetyLimiterProcessor);
