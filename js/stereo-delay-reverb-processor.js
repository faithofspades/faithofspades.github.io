class StereoDelayReverbProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [];
    }

    constructor() {
        super();
        this.maxDelaySeconds = 4.0;
        this.bufferLength = Math.ceil((this.maxDelaySeconds + 1) * sampleRate);
        this.bufferL = new Float32Array(this.bufferLength);
        this.bufferR = new Float32Array(this.bufferLength);
        this.writeIndex = 0;

        this.params = {
            delayTime: 0.4,
            feedbackGain: 0.55,
            mix: 0.5,
            inputTrim: 0.9,
            lowCutHz: 80,
            highCutHz: 14000,
            tailSeconds: 2.8,
            density: 0.45
        };

        this.delaySamples = Math.max(1, this.params.delayTime * sampleRate);
        this.currentDelaySamples = this.delaySamples;
        this.delayChaseTimeSeconds = 3.006;
        this.delayChaseCoef = this.computeDelayChaseCoef(this.delayChaseTimeSeconds);
        this.inputTrim = this.params.inputTrim;
        this.maxTailSeconds = 12;

        this.mixTarget = this.mixCurrent = Math.max(0, Math.min(1, this.params.mix));
        this.mixSlew = this.computeSlewCoef(0.01, 0.0002, 0.5);
        this.feedbackTarget = this.feedbackCurrent = Math.max(0, Math.min(0.95, this.params.feedbackGain));
        this.feedbackSlew = this.computeSlewCoef(0.03, 0.0005, 1);
        this.densityTarget = this.densityCurrent = Math.max(0, Math.min(1, this.params.density));
        this.densitySlew = this.computeSlewCoef(0.12, 0.001, 1);
        this.tailSecondsTarget = this.tailSecondsCurrent = Math.max(0.4, Math.min(this.maxTailSeconds, this.params.tailSeconds));
        this.tailSlew = this.computeSlewCoef(0.2, 0.002, 2);
        this.lowCutAlphaTarget = this.lowCutAlphaCurrent = this.computeFilterAlpha(this.params.lowCutHz);
        this.highCutAlphaTarget = this.highCutAlphaCurrent = this.computeFilterAlpha(this.params.highCutHz);
        this.filterSlew = this.computeSlewCoef(0.05, 0.0005, 2);
        this.reverbLengthMixTarget = 1;
        this.reverbLengthMixCurrent = 1;
        this.reverbLengthMixSlew = this.computeSlewCoef(0.02, 0.0005, 0.5);
        this.lowCutStateL = 0;
        this.lowCutStateR = 0;
        this.highCutStateL = 0;
        this.highCutStateR = 0;
        this.delayTapeGlideCoef = 0.0025;
        this.readIndex = 0;
        this.reverbEnergy = 0;
        this.reverbEnergyAttack = 1 - Math.exp(-1 / (sampleRate * 0.012));
        this.reverbEnergyRelease = 1 - Math.exp(-1 / (sampleRate * 0.28));
        this.reverbEnergyComp = 1.3;
        this.reverbGainFloor = 0.35;
        this.reverbLevelScale = 1;
        this.reverseEnabled = false;
        this.reverseWindowSeconds = 0.35;
        this.reverseReady = false;
        this.reverseBlendCurrent = 0;
        this.reverseBlendTarget = 0;
        this.reverseBlendSlew = this.computeSlewCoef(0.02, 0.0005, 0.5);
        this.reverseActiveGrains = [];
        this.reverseGrainPool = [];
        this.reverseRampPower = 2.25;
        this.reverseOverlapGain = 1;
        this.externalConvolutionEnabled = false;
        this.reverseStereoWidth = 1.35;
        this.reverseLevelBoost = 1.32;
        this.reverseToneMix = 0.65;
        this.reverseToneAlpha = this.computeFilterAlpha(7200);
        this.reverseToneStateL = 0;
        this.reverseToneStateR = 0;
        this.convolutionSendComp = 1;
            this.freezeEnabled = false;
            this.combFeedbackBase = 0.85;
            this.combDampBase = 0.25;
        this.convolutionReturnTrim = 0.58;
        this.initializeReverseDiffusion();
        this.initializeReverseBuffers();
        this.updateReverseDynamicsForLength(this.tailSecondsTarget);
        this.baseAllpassTimes = [0.0051, 0.0137, 0.0199];
        this.baseCombTimes = [0.0297, 0.0371, 0.0411, 0.0437];
        this.initializeReverbBuffers();
        this.updateReverbTone();
        this.resetDelayReadIndex();

        this.port.onmessage = (event) => this.handleMessage(event.data);
    }

    handleMessage(data) {
        if (!data || typeof data !== 'object') return;
        if (data.type === 'params' && data.values) {
            const values = data.values;
            if (typeof values.delayTime === 'number') {
                this.setDelayTime(values.delayTime);
            }
            if (typeof values.delayChaseTime === 'number') {
                this.setDelayChaseTime(values.delayChaseTime);
            } else if (typeof values.delayChaseMs === 'number') {
                this.setDelayChaseTime(values.delayChaseMs * 0.001);
            }
            if (typeof values.feedbackGain === 'number') {
                this.feedbackTarget = Math.max(0, Math.min(0.95, values.feedbackGain));
            }
            if (typeof values.mix === 'number') {
                this.mixTarget = Math.max(0, Math.min(1, values.mix));
            }
            if (typeof values.inputTrim === 'number') {
                this.inputTrim = Math.max(0, Math.min(1.5, values.inputTrim));
            }
            if (typeof values.tailSeconds === 'number') {
                this.setTailSeconds(values.tailSeconds);
            }
            if (typeof values.density === 'number') {
                this.setDensity(values.density);
            }
            if (typeof values.reverbLengthMix === 'number') {
                const trimmed = Math.max(0, Math.min(1, values.reverbLengthMix));
                this.reverbLengthMixTarget = trimmed;
            }
            if (typeof values.lowCutHz === 'number') {
                this.lowCutAlphaTarget = this.computeFilterAlpha(values.lowCutHz);
            }
            if (typeof values.highCutHz === 'number') {
                this.highCutAlphaTarget = this.computeFilterAlpha(values.highCutHz);
            }
            if (typeof values.reverse === 'boolean') {
                this.setReverseEnabled(values.reverse);
            } else if (typeof values.reverseEnabled === 'boolean') {
                this.setReverseEnabled(values.reverseEnabled);
            }
            if (typeof values.freeze === 'boolean') {
                this.setFreezeEnabled(values.freeze);
            }
        } else if (data.type === 'flush') {
            this.clearBuffers();
        } else if (data.type === 'convolution-mode' && typeof data.enabled === 'boolean') {
            this.externalConvolutionEnabled = data.enabled;
        }
    }

    setFreezeEnabled(enabled) {
        const next = !!enabled;
        if (this.freezeEnabled === next) {
            return;
        }
        this.freezeEnabled = next;
        this.applyFreezeToneModifiers();
    }

    clearBuffers() {
        this.bufferL.fill(0);
        this.bufferR.fill(0);
        this.lowCutStateL = 0;
        this.lowCutStateR = 0;
        this.highCutStateL = 0;
        this.highCutStateR = 0;
        this.writeIndex = 0;
        this.currentDelaySamples = this.delaySamples;
        this.resetReverbEnergy();
        const reset = (buffers, indices) => {
            for (let i = 0; i < buffers.length; i++) {
                buffers[i].fill(0);
                indices[i] = 0;
            }
        };
        reset(this.allpassBuffersL, this.allpassIndicesL);
        reset(this.allpassBuffersR, this.allpassIndicesR);
        reset(this.combBuffersL, this.combIndicesL);
        reset(this.combBuffersR, this.combIndicesR);
        this.combFilterStateL.fill(0);
        this.combFilterStateR.fill(0);
        this.resetDelayReadIndex();
        this.resetReverseState();
    }

    setTailSeconds(seconds) {
        const clamped = Math.max(0.4, Math.min(this.maxTailSeconds, seconds));
        this.tailSecondsTarget = clamped;
    }

    setDensity(value) {
        this.densityTarget = Math.max(0, Math.min(1, value));
    }

    setDelayTime(seconds) {
        const clamped = Math.max(0.02, Math.min(this.maxDelaySeconds, seconds));
        this.delaySamples = Math.max(1, clamped * sampleRate);
    }

    setDelayChaseTime(seconds) {
        const clamped = Math.max(0.0005, Math.min(0.08, seconds));
        this.delayChaseTimeSeconds = clamped;
        this.delayChaseCoef = this.computeDelayChaseCoef(clamped);
    }

    computeDelayChaseCoef(timeSeconds) {
        const clamped = Math.max(0.0005, Math.min(0.05, timeSeconds || 0.005));
        return 1 - Math.exp(-1 / (sampleRate * clamped));
    }

    computeSlewCoef(timeSeconds, minSeconds = 0.0005, maxSeconds = 2) {
        const safe = Math.max(minSeconds, Math.min(maxSeconds, timeSeconds || minSeconds));
        return 1 - Math.exp(-1 / (sampleRate * safe));
    }

    initializeReverseBuffers() {
        const minWindow = 0.05;
        const maxWindow = 1.5;
        const seconds = Math.max(minWindow, Math.min(maxWindow, this.reverseWindowSeconds || 0.35));
        this.reverseWindowSeconds = seconds;
        this.reverseSegmentSamples = Math.max(64, Math.floor(sampleRate * seconds));
        this.reverseGrainHopSamples = Math.max(8, Math.floor(this.reverseSegmentSamples * 0.1));
        this.reverseExpectedOverlap = Math.max(1, Math.ceil(this.reverseSegmentSamples / this.reverseGrainHopSamples));
        this.reverseOverlapGain = 1 / this.reverseExpectedOverlap;
        this.reverseHistoryLength = Math.max(this.reverseSegmentSamples * 4, 4096);
        this.reverseHistoryL = new Float32Array(this.reverseHistoryLength);
        this.reverseHistoryR = new Float32Array(this.reverseHistoryLength);
        this.reverseWindowShape = this.buildReverseWindow(this.reverseSegmentSamples);
        this.reverseWindowLength = this.reverseSegmentSamples;
        this.reverseBaseSegmentSamples = this.reverseSegmentSamples;
        this.reverseBaseHopSamples = this.reverseGrainHopSamples;
        this.reverseEffectiveSegmentSamples = this.reverseSegmentSamples;
        this.reverseEffectiveHopSamples = this.reverseGrainHopSamples;
        this.reverseDynamicRampPower = this.reverseRampPower;
        this.resetReverseState();
    }

    initializeReverseDiffusion() {
        this.reverseDiffusionStages = [
            { gain: 0.72, stateL: { lastInput: 0, lastOutput: 0 }, stateR: { lastInput: 0, lastOutput: 0 } },
            { gain: 0.53, stateL: { lastInput: 0, lastOutput: 0 }, stateR: { lastInput: 0, lastOutput: 0 } }
        ];
    }

    resetReverseDiffusionStates() {
        if (!this.reverseDiffusionStages) return;
        for (let i = 0; i < this.reverseDiffusionStages.length; i++) {
            const stage = this.reverseDiffusionStages[i];
            stage.stateL.lastInput = 0;
            stage.stateL.lastOutput = 0;
            stage.stateR.lastInput = 0;
            stage.stateR.lastOutput = 0;
        }
    }

    applyReverseDiffusion(channel, sample) {
        if (!this.reverseDiffusionStages || this.reverseDiffusionStages.length === 0) {
            return sample;
        }
        let x = sample;
        for (let i = 0; i < this.reverseDiffusionStages.length; i++) {
            const stage = this.reverseDiffusionStages[i];
            const state = channel === 0 ? stage.stateL : stage.stateR;
            const gain = stage.gain;
            const y = -gain * x + state.lastInput + gain * state.lastOutput;
            state.lastInput = x;
            state.lastOutput = y;
            x = y;
        }
        return x;
    }

    applyReverseTone(channel, sample) {
        const alpha = this.reverseToneAlpha;
        const mix = this.reverseToneMix;
        if (!(alpha > 0 && mix > 0)) {
            return sample;
        }
        if (channel === 0) {
            this.reverseToneStateL += alpha * (sample - this.reverseToneStateL);
            return sample * (1 - mix) + this.reverseToneStateL * mix;
        }
        this.reverseToneStateR += alpha * (sample - this.reverseToneStateR);
        return sample * (1 - mix) + this.reverseToneStateR * mix;
    }

    buildReverseWindow(length, rampOverride) {
        const window = new Float32Array(length);
        if (length <= 1) {
            window[0] = 1;
            return window;
        }
        const rampPower = typeof rampOverride === 'number' ? rampOverride : (this.reverseRampPower || 2);
        const denom = length - 1;
        const fadeSamples = Math.max(4, Math.floor(length * 0.02));
        for (let i = 0; i < length; i++) {
            const frac = i / denom;
            let value = Math.pow(frac, rampPower);
            if (i < fadeSamples) {
                value *= i / fadeSamples;
            }
            if (i >= length - fadeSamples) {
                const tail = length - i;
                value *= tail / fadeSamples;
            }
            window[i] = value;
        }
        return window;
    }


    resetReverseState() {
        this.reverseBlendCurrent = 0;
        this.reverseBlendTarget = 0;
        this.reverseReady = false;
        this.reverseHistoryWriteIndex = 0;
        this.reverseHistoryFilled = 0;
        this.reverseSamplesSinceGrain = 0;
        this.reverseToneStateL = 0;
        this.reverseToneStateR = 0;
        this.resetReverseDiffusionStates();
        if (this.reverseHistoryL) this.reverseHistoryL.fill(0);
        if (this.reverseHistoryR) this.reverseHistoryR.fill(0);
        if (!this.reverseActiveGrains) {
            this.reverseActiveGrains = [];
        } else {
            this.releaseAllReverseGrains();
        }
    }

    releaseAllReverseGrains() {
        if (!this.reverseActiveGrains) return;
        if (!this.reverseGrainPool) this.reverseGrainPool = [];
        for (let i = 0; i < this.reverseActiveGrains.length; i++) {
            const grain = this.reverseActiveGrains[i];
            grain.position = 0;
            this.reverseGrainPool.push(grain);
        }
        this.reverseActiveGrains.length = 0;
    }

    acquireReverseGrain() {
        if (!this.reverseGrainPool) this.reverseGrainPool = [];
        if (this.reverseGrainPool.length > 0) {
            const grain = this.reverseGrainPool.pop();
            const length = this.reverseSegmentSamples;
            if (!grain.bufferL || grain.bufferL.length !== length) {
                grain.bufferL = new Float32Array(length);
                grain.bufferR = new Float32Array(length);
            }
            grain.length = length;
            grain.position = 0;
            grain.window = null;
            grain.windowLength = 0;
            return grain;
        }
        return {
            bufferL: new Float32Array(this.reverseSegmentSamples),
            bufferR: new Float32Array(this.reverseSegmentSamples),
            length: this.reverseSegmentSamples,
            position: 0,
            window: null,
            windowLength: 0
        };
    }

    releaseReverseGrain(grain) {
        if (!grain) return;
        grain.position = 0;
        grain.length = this.reverseSegmentSamples;
        grain.window = null;
        grain.windowLength = 0;
        if (!this.reverseGrainPool) this.reverseGrainPool = [];
        this.reverseGrainPool.push(grain);
    }

    scheduleReverseGrain(historyWriteIndex) {
        if (!this.reverseHistoryL || !this.reverseHistoryR) return;
        const grain = this.acquireReverseGrain();
        const length = this.reverseEffectiveSegmentSamples || this.reverseSegmentSamples;
        const window = this.reverseWindowShape;
        const historyLength = this.reverseHistoryLength;
        let historyIndex = historyWriteIndex;
        for (let i = 0; i < length; i++) {
            historyIndex--;
            if (historyIndex < 0) historyIndex += historyLength;
                grain.bufferL[i] = this.reverseHistoryL[historyIndex];
                grain.bufferR[i] = this.reverseHistoryR[historyIndex];
        }
        grain.length = length;
        grain.position = 0;
        grain.window = this.reverseWindowShape;
        grain.windowLength = this.reverseWindowLength || length;
        this.reverseActiveGrains.push(grain);
    }

    updateReverseDynamicsForLength(lengthSeconds) {
        if (!this.reverseBaseSegmentSamples || !this.reverseBaseHopSamples) return;
        const minTail = 0.4;
        const maxTail = Math.max(minTail + 0.1, this.maxTailSeconds || 12);
        const safeTail = Math.max(minTail, Math.min(maxTail, lengthSeconds || minTail));
        const normalized = (safeTail - minTail) / (maxTail - minTail);

        const segmentScale = 0.25 + 0.75 * normalized;
        const targetSegment = Math.max(32, Math.floor(this.reverseBaseSegmentSamples * segmentScale));
        const targetHop = Math.max(4, Math.floor(this.reverseBaseHopSamples * segmentScale));
        const targetRamp = 0.7 + 1.5 * normalized;

        let changed = false;
        if (this.reverseEffectiveSegmentSamples !== targetSegment) {
            this.reverseEffectiveSegmentSamples = targetSegment;
            changed = true;
        }
        if (this.reverseEffectiveHopSamples !== targetHop) {
            this.reverseEffectiveHopSamples = targetHop;
            changed = true;
        }
        if (!this.reverseDynamicRampPower || Math.abs(this.reverseDynamicRampPower - targetRamp) > 0.05) {
            this.reverseDynamicRampPower = targetRamp;
            changed = true;
        }

        if (changed) {
            this.reverseWindowShape = this.buildReverseWindow(targetSegment, targetRamp);
            this.reverseWindowLength = targetSegment;
            const expectedOverlap = Math.max(1, Math.ceil(targetSegment / targetHop));
            const energyBoost = 1.6 + 0.6 * (1 - normalized);
            this.reverseOverlapGain = energyBoost / expectedOverlap;
        }
    }

    setReverseEnabled(enabled) {
        const next = !!enabled;
        if (this.reverseEnabled !== next) {
            this.reverseEnabled = next;
            this.reverseBlendTarget = next ? this.reverseBlendCurrent : 0;
            this.resetReverseState();
        }
        if (!next) {
            this.reverseBlendTarget = 0;
        }
    }

    updateReverseBlendTarget(active) {
        this.reverseBlendTarget = active ? 1 : 0;
    }

    resetDelayReadIndex() {
        this.readIndex = this.normalizeBufferIndex(this.writeIndex - this.currentDelaySamples);
    }

    wrapBufferDistance(current, target) {
        const length = this.bufferLength;
        let diff = target - current;
        if (diff > length * 0.5) diff -= length;
        else if (diff < -length * 0.5) diff += length;
        return diff;
    }

    normalizeBufferIndex(value) {
        const length = this.bufferLength;
        let v = value % length;
        if (v < 0) v += length;
        return v;
    }

    resetReverbEnergy() {
        this.reverbEnergy = 0;
    }

    updateReverbEnergy(level) {
        const target = Math.max(0, level);
        const coef = target > this.reverbEnergy ? this.reverbEnergyAttack : this.reverbEnergyRelease;
        this.reverbEnergy += (target - this.reverbEnergy) * coef;
        return this.reverbEnergy;
    }

    initializeReverbBuffers() {
        const safeTail = this.maxTailSeconds;
        const sizeFactor = 0.9 + Math.min(1.75, safeTail * 0.1);
        const scaledAllpassLengths = this.baseAllpassTimes.map((t) => Math.max(32, Math.floor(t * sizeFactor * sampleRate)));
        const scaledCombLengths = this.baseCombTimes.map((t) => Math.max(64, Math.floor(t * sizeFactor * sampleRate)));

        this.allpassBuffersL = scaledAllpassLengths.map((len) => new Float32Array(len));
        this.allpassBuffersR = scaledAllpassLengths.map((len) => new Float32Array(len));
        this.allpassIndicesL = scaledAllpassLengths.map(() => 0);
        this.allpassIndicesR = scaledAllpassLengths.map(() => 0);

        this.combBuffersL = scaledCombLengths.map((len) => new Float32Array(len));
        this.combBuffersR = scaledCombLengths.map((len) => new Float32Array(len));
        this.combIndicesL = scaledCombLengths.map(() => 0);
        this.combIndicesR = scaledCombLengths.map(() => 0);
        this.combFilterStateL = new Float32Array(scaledCombLengths.length);
        this.combFilterStateR = new Float32Array(scaledCombLengths.length);

        this.resetReverbEnergy();
    }

    updateReverbTone() {
        const d = Math.max(0, Math.min(1, this.densityCurrent));
        const safeTail = Math.max(0.4, Math.min(this.maxTailSeconds, this.tailSecondsCurrent));
        const tailNorm = Math.min(1, safeTail / 6);
        const minTail = 0.4;
        const normalizedTail = Math.max(0, Math.min(1, (safeTail - minTail) / (this.maxTailSeconds - minTail)));
        const reverbLevel = 1;
        this.allpassFeedback = 0.62 + 0.04 * tailNorm;
        this.combFeedbackBase = Math.min(0.92, 0.72 + 0.2 * tailNorm);
        this.combDampBase = 0.22 + 0.12 * (1 - Math.min(1, d || 0.5));
        this.reverbNormalize = 0.4 + 0.2 * tailNorm;
        this.reverbPreGain = 0.45 + 0.85 * d;
        this.reverbLevelScale = reverbLevel;
        const sendComp = this.reverbPreGain > 0 ? 1 / this.reverbPreGain : 1;
        this.convolutionSendComp = Math.max(0.5, Math.min(1.7, sendComp));
        this.applyFreezeToneModifiers();
    }

    applyFreezeToneModifiers() {
        if (this.freezeEnabled) {
            this.combFeedback = Math.min(0.9995, (this.combFeedbackBase || 0.9) + 0.2);
            this.combDamp = Math.min(0.05, (this.combDampBase || 0.2) * 0.25);
        } else {
            this.combFeedback = this.combFeedbackBase || this.combFeedback;
            this.combDamp = this.combDampBase || this.combDamp;
        }
    }

    computeFilterAlpha(freq) {
        const clamped = Math.max(5, Math.min(sampleRate * 0.45, freq));
        const tau = Math.exp(-2 * Math.PI * clamped / sampleRate);
        return 1 - tau;
    }

    processReverbChannel(channel, inputSample) {
        const allpassBuffers = channel === 0 ? this.allpassBuffersL : this.allpassBuffersR;
        const allpassIndices = channel === 0 ? this.allpassIndicesL : this.allpassIndicesR;
        let x = inputSample;
        for (let i = 0; i < allpassBuffers.length; i++) {
            const buffer = allpassBuffers[i];
            let idx = allpassIndices[i];
            const delayed = buffer[idx];
            const y = delayed - x * this.allpassFeedback;
            buffer[idx] = x + delayed * this.allpassFeedback;
            idx++;
            if (idx >= buffer.length) idx = 0;
            allpassIndices[i] = idx;
            x = y;
        }

        const combBuffers = channel === 0 ? this.combBuffersL : this.combBuffersR;
        const combIndices = channel === 0 ? this.combIndicesL : this.combIndicesR;
        const combStates = channel === 0 ? this.combFilterStateL : this.combFilterStateR;
        let sum = 0;
        for (let i = 0; i < combBuffers.length; i++) {
            const buffer = combBuffers[i];
            let idx = combIndices[i];
            const delayed = buffer[idx];
            combStates[i] += (delayed - combStates[i]) * (1 - this.combDamp);
            const filtered = combStates[i];
            buffer[idx] = x + filtered * this.combFeedback;
            idx++;
            if (idx >= buffer.length) idx = 0;
            combIndices[i] = idx;
            sum += filtered;
        }
        const averaged = (sum / combBuffers.length) * this.reverbNormalize;
        return Math.tanh(averaged * 1.35);
    }

    readFromBuffer(buffer, readPosition) {
        const bufferLength = this.bufferLength;
        let pos = readPosition;
        if (pos < 0) {
            pos += bufferLength;
            if (pos < 0) {
                pos = pos % bufferLength;
                if (pos < 0) pos += bufferLength;
            }
        } else if (pos >= bufferLength) {
            pos -= bufferLength;
            if (pos >= bufferLength) {
                pos = pos % bufferLength;
            }
        }
        const indexA = Math.floor(pos);
        const indexB = (indexA + 1) % bufferLength;
        const frac = pos - indexA;
        return buffer[indexA] + (buffer[indexB] - buffer[indexA]) * frac;
    }

    applyFilters(sample, channel) {
        if (channel === 0) {
            this.lowCutStateL += this.lowCutAlphaCurrent * (sample - this.lowCutStateL);
            const highPassed = sample - this.lowCutStateL;
            this.highCutStateL += this.highCutAlphaCurrent * (highPassed - this.highCutStateL);
            return this.highCutStateL;
        }
        this.lowCutStateR += this.lowCutAlphaCurrent * (sample - this.lowCutStateR);
        const highPassed = sample - this.lowCutStateR;
        this.highCutStateR += this.highCutAlphaCurrent * (highPassed - this.highCutStateR);
        return this.highCutStateR;
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const externalReturn = inputs[1];
        const primaryOutput = outputs[0];
        const reverbSendOutput = outputs[1];
        if (!primaryOutput) return true;

        const inL = input && input[0] ? input[0] : null;
        const inR = input && input[1] ? input[1] : null;
        const returnInL = externalReturn && externalReturn[0] ? externalReturn[0] : null;
        const returnInR = externalReturn && externalReturn[1] ? externalReturn[1] : (externalReturn && externalReturn[0] ? externalReturn[0] : null);
        const outL = primaryOutput[0];
        const outR = primaryOutput[1] || primaryOutput[0];
        const sendOutL = reverbSendOutput && reverbSendOutput[0];
        const sendOutR = reverbSendOutput && (reverbSendOutput[1] || reverbSendOutput[0]);
        const frames = outL.length;
        const freezeActive = this.freezeEnabled;

        const bufferL = this.bufferL;
        const bufferR = this.bufferR;
        const bufferLength = this.bufferLength;
        let writeIndex = this.writeIndex;
        let currentDelaySamples = this.currentDelaySamples;
        const delayChaseCoef = this.delayChaseCoef;
        const maxDelaySamples = this.maxDelaySeconds * sampleRate;
        let readIndex = this.readIndex;
        const tapeGlideCoef = this.delayTapeGlideCoef;
        this.updateReverseDynamicsForLength(this.tailSecondsTarget);
            const convolutionActive = this.externalConvolutionEnabled;
            const reverseEnabled = this.reverseEnabled && this.reverseSegmentSamples > 0;
            const reverseSynthesisActive = reverseEnabled && !convolutionActive && !freezeActive;
        const reverseSegmentSamples = this.reverseEffectiveSegmentSamples || this.reverseSegmentSamples;
        const reverseGrainHopSamples = this.reverseEffectiveHopSamples || this.reverseGrainHopSamples || Math.max(16, Math.floor(reverseSegmentSamples * 0.5));
        const reverseActiveGrains = this.reverseActiveGrains;
        const reverseHistoryL = this.reverseHistoryL;
        const reverseHistoryR = this.reverseHistoryR;
        const reverseOverlapGain = this.reverseOverlapGain || 1;
        const reverseHistoryLength = this.reverseHistoryLength || 0;
        let reverseHistoryWriteIndex = this.reverseHistoryWriteIndex || 0;
        let reverseHistoryFilled = this.reverseHistoryFilled || 0;
        let reverseSamplesSinceGrain = this.reverseSamplesSinceGrain || 0;
        let reverseReady = this.reverseReady;
        let reverseBlend = this.reverseBlendCurrent;
        let reverseBlendTarget = this.reverseBlendTarget;
        const reverseBlendSlew = this.reverseBlendSlew;
        let mix = this.mixCurrent;
        const mixTarget = this.mixTarget;
        const mixSlew = this.mixSlew;
        let feedback = this.feedbackCurrent;
        const feedbackTarget = this.feedbackTarget;
        const feedbackSlew = this.feedbackSlew;
        let tailSeconds = this.tailSecondsCurrent;
        const tailTarget = this.tailSecondsTarget;
        const tailSlew = this.tailSlew;
        let density = this.densityCurrent;
        const densityTarget = this.densityTarget;
        const densitySlew = this.densitySlew;
        let lowCutAlpha = this.lowCutAlphaCurrent;
        const lowCutTarget = this.lowCutAlphaTarget;
        let highCutAlpha = this.highCutAlphaCurrent;
        const highCutTarget = this.highCutAlphaTarget;
        const filterSlew = this.filterSlew;
        const inputTrim = this.inputTrim;
        let reverbPreGain = this.reverbPreGain;
        let reverbLevelScale = this.reverbLevelScale;
        // Reverse mode should always feed 100% wet reverb internally; mix knob handles dry balance.
        let reverseAwareReverbLevel = reverseEnabled ? 1 : reverbLevelScale;
        const reverbDirectBypass = 1;
        const baseConvolutionSendComp = convolutionActive ? this.convolutionSendComp : 1;
        const allowNewWet = freezeActive ? 0 : 1;
        let reverbLengthMix = this.reverbLengthMixCurrent;
        const reverbLengthMixTarget = this.reverbLengthMixTarget;
        const reverbLengthMixSlew = this.reverbLengthMixSlew;

        for (let i = 0; i < frames; i++) {
            const dryL = inL ? inL[i] : 0;
            const dryR = inR ? inR[i] : (inL ? inL[i] : 0);

            mix += (mixTarget - mix) * mixSlew;
            if (mix < 0) mix = 0;
            else if (mix > 1) mix = 1;
            const dryMix = 1 - mix;
            const wetMix = mix;

            feedback += (feedbackTarget - feedback) * feedbackSlew;
            if (feedback < 0) feedback = 0;
            else if (feedback > 0.97) feedback = 0.97;
            const delayFeedback = freezeActive ? 0.995 : feedback;

            let toneDirty = false;
            const prevTail = this.tailSecondsCurrent;
            tailSeconds += (tailTarget - tailSeconds) * tailSlew;
            if (Math.abs(tailSeconds - prevTail) > 1e-6) {
                toneDirty = true;
            }
            this.tailSecondsCurrent = tailSeconds;

            const prevDensity = this.densityCurrent;
            density += (densityTarget - density) * densitySlew;
            if (Math.abs(density - prevDensity) > 1e-6) {
                toneDirty = true;
            }
            this.densityCurrent = density;
            if (toneDirty) {
                this.updateReverbTone();
                reverbPreGain = this.reverbPreGain;
                reverbLevelScale = this.reverbLevelScale;
                reverseAwareReverbLevel = reverseEnabled ? 1 : reverbLevelScale;
            }
            const densityMix = Math.max(0, Math.min(1, this.densityTarget));
            reverbLengthMix += (reverbLengthMixTarget - reverbLengthMix) * reverbLengthMixSlew;
            if (reverbLengthMix < 0) reverbLengthMix = 0;
            else if (reverbLengthMix > 1) reverbLengthMix = 1;

            lowCutAlpha += (lowCutTarget - lowCutAlpha) * filterSlew;
            highCutAlpha += (highCutTarget - highCutAlpha) * filterSlew;
            this.lowCutAlphaCurrent = lowCutAlpha;
            this.highCutAlphaCurrent = highCutAlpha;

            const targetDelaySamples = this.delaySamples;
            currentDelaySamples += (targetDelaySamples - currentDelaySamples) * delayChaseCoef;
            if (currentDelaySamples < 1) {
                currentDelaySamples = 1;
            } else if (currentDelaySamples > maxDelaySamples) {
                currentDelaySamples = maxDelaySamples;
            }

            const idealReadIndex = this.normalizeBufferIndex(writeIndex - currentDelaySamples);

            const readError = this.wrapBufferDistance(readIndex, idealReadIndex);
            let glideStep = 1 + readError * tapeGlideCoef;
            if (glideStep < 0.1) glideStep = 0.1;
            else if (glideStep > 4) glideStep = 4;
            readIndex = this.normalizeBufferIndex(readIndex + glideStep);

            const reverbInputL = dryL * inputTrim * reverbPreGain * allowNewWet;
            const reverbInputR = dryR * inputTrim * reverbPreGain * allowNewWet;
            let processedReverbWetL = 0;
            let processedReverbWetR = 0;
            let directReverbWetL = 0;
            let directReverbWetR = 0;
            let reverbDirectScale = 1;
            let reverseWetFactor = 1;

            if (!convolutionActive) {
                const rawReverbWetL = this.processReverbChannel(0, reverbInputL);
                const rawReverbWetR = this.processReverbChannel(1, reverbInputR);
                const reverbWetL = rawReverbWetL * reverseAwareReverbLevel;
                const reverbWetR = rawReverbWetR * reverseAwareReverbLevel;
                // Duck reverb recursion when overlapping tails pile up, but keep some direct verb for feel.
                const reverbEnergy = this.updateReverbEnergy(Math.abs(reverbWetL) + Math.abs(reverbWetR));
                const dynamicReverbGain = Math.max(this.reverbGainFloor, 1 / (1 + reverbEnergy * this.reverbEnergyComp));
                const managedReverbWetL = reverbWetL * dynamicReverbGain;
                const managedReverbWetR = reverbWetR * dynamicReverbGain;
                reverbDirectScale = 0.5 + 0.5 * dynamicReverbGain;
                let reversedWetL = 0;
                let reversedWetR = 0;

                if (reverseHistoryL && reverseHistoryR && reverseHistoryLength > 0) {
                    reverseHistoryL[reverseHistoryWriteIndex] = managedReverbWetL;
                    reverseHistoryR[reverseHistoryWriteIndex] = managedReverbWetR;
                    reverseHistoryWriteIndex++;
                    if (reverseHistoryWriteIndex >= reverseHistoryLength) {
                        reverseHistoryWriteIndex = 0;
                    }
                    if (reverseHistoryFilled < reverseHistoryLength) {
                        reverseHistoryFilled++;
                    }
                    if (reverseSynthesisActive) {
                        reverseSamplesSinceGrain++;
                        while (
                            reverseSamplesSinceGrain >= reverseGrainHopSamples &&
                            reverseHistoryFilled >= reverseSegmentSamples
                        ) {
                            this.scheduleReverseGrain(reverseHistoryWriteIndex);
                            reverseSamplesSinceGrain -= reverseGrainHopSamples;
                        }
                    } else {
                        reverseSamplesSinceGrain = 0;
                    }
                }

                let activeWeight = 0;
                if (reverseSynthesisActive && reverseActiveGrains && reverseActiveGrains.length > 0) {
                    for (let g = 0; g < reverseActiveGrains.length; g++) {
                        const grain = reverseActiveGrains[g];
                        if (grain.position < grain.length) {
                            const windowArray = grain.window;
                            const windowLength = grain.windowLength || (windowArray ? windowArray.length : grain.length);
                            const windowIndex = windowArray ? Math.min(grain.position, windowLength - 1) : grain.position;
                            const windowValue = windowArray ? windowArray[windowIndex] : 1;
                            reversedWetL += grain.bufferL[grain.position] * windowValue;
                            reversedWetR += grain.bufferR[grain.position] * windowValue;
                            activeWeight += windowValue;
                            grain.position++;
                        }
                        if (grain.position >= grain.length) {
                            this.releaseReverseGrain(grain);
                            reverseActiveGrains.splice(g, 1);
                            g--;
                        }
                    }
                    if (activeWeight > 0) {
                        const gain = reverseOverlapGain;
                        reversedWetL *= gain;
                        reversedWetR *= gain;
                    }
                    reverseReady = activeWeight > 0;
                } else {
                    reverseReady = false;
                }

                if (!reverseSynthesisActive || !reverseReady) {
                    reversedWetL = managedReverbWetL;
                    reversedWetR = managedReverbWetR;
                } else {
                    reversedWetL = this.applyReverseDiffusion(0, reversedWetL);
                    reversedWetR = this.applyReverseDiffusion(1, reversedWetR);
                    reversedWetL = this.applyReverseTone(0, reversedWetL);
                    reversedWetR = this.applyReverseTone(1, reversedWetR);
                    const width = this.reverseStereoWidth;
                    if (width && Math.abs(width - 1) > 1e-3) {
                        const mid = 0.5 * (reversedWetL + reversedWetR);
                        const side = 0.5 * (reversedWetL - reversedWetR) * width;
                        reversedWetL = mid + side;
                        reversedWetR = mid - side;
                    }
                    if (this.reverseLevelBoost && this.reverseLevelBoost !== 1) {
                        reversedWetL *= this.reverseLevelBoost;
                        reversedWetR *= this.reverseLevelBoost;
                    }
                }

                const shouldBlendReverse = reverseSynthesisActive && reverseReady;
                reverseBlendTarget = shouldBlendReverse ? 1 : 0;
                reverseBlend += (reverseBlendTarget - reverseBlend) * reverseBlendSlew;
                processedReverbWetL = managedReverbWetL * (1 - reverseBlend) + reversedWetL * reverseBlend;
                processedReverbWetR = managedReverbWetR * (1 - reverseBlend) + reversedWetR * reverseBlend;
                directReverbWetL = processedReverbWetL * densityMix;
                directReverbWetR = processedReverbWetR * densityMix;
                reverseWetFactor = reverseEnabled ? Math.max(1, 1 + (0.6 - Math.min(0.6, tailSeconds - 0.4))) : 1;
            } else {
                const returnWetL = returnInL ? returnInL[i] : 0;
                const returnWetR = returnInR ? returnInR[i] : (returnInL ? returnInL[i] : 0);
                const trimmedReturnL = Math.tanh(returnWetL * this.convolutionReturnTrim);
                const trimmedReturnR = Math.tanh(returnWetR * this.convolutionReturnTrim);
                processedReverbWetL = trimmedReturnL;
                processedReverbWetR = trimmedReturnR;
                directReverbWetL = processedReverbWetL * densityMix;
                directReverbWetR = processedReverbWetR * densityMix;
                reverseWetFactor = 1;
                reverseSamplesSinceGrain = 0;
                reverseReady = false;
                reverseBlendTarget = 0;
                reverseBlend += (reverseBlendTarget - reverseBlend) * reverseBlendSlew;
            }

            const convolutionSendGain = convolutionActive ? baseConvolutionSendComp : densityMix;
            let sendWetL;
            let sendWetR;
            if (convolutionActive) {
                sendWetL = reverbInputL * wetMix * convolutionSendGain;
                sendWetR = reverbInputR * wetMix * convolutionSendGain;
            } else {
                sendWetL = processedReverbWetL * wetMix * convolutionSendGain;
                sendWetR = processedReverbWetR * wetMix * convolutionSendGain;
            }
            if (sendOutL) sendOutL[i] = sendWetL;
            if (sendOutR) sendOutR[i] = sendWetR;
            const reverbDirectL = directReverbWetL * reverbDirectScale * reverseWetFactor * reverbDirectBypass;
            const reverbDirectR = directReverbWetR * reverbDirectScale * reverseWetFactor * reverbDirectBypass;

            const delayedL = this.readFromBuffer(bufferL, readIndex);
            const delayedR = this.readFromBuffer(bufferR, readIndex);
            const filteredDelayL = this.applyFilters(delayedL, 0);
            const filteredDelayR = this.applyFilters(delayedR, 1);

            const wetL = filteredDelayL + reverbDirectL;
            const wetR = filteredDelayR + reverbDirectR;

            outL[i] = dryL * dryMix + wetL * wetMix;
            outR[i] = dryR * dryMix + wetR * wetMix;

            const reverbRemovalFactor = Math.max(0, Math.min(1, reverseAwareReverbLevel * reverbLengthMix));
            const dryDelayInjectionL = allowNewWet ? dryL * inputTrim * (1 - reverbRemovalFactor) : 0;
            const dryDelayInjectionR = allowNewWet ? dryR * inputTrim * (1 - reverbRemovalFactor) : 0;
            const reverbFeedbackWetL = processedReverbWetL * reverbLengthMix;
            const reverbFeedbackWetR = processedReverbWetR * reverbLengthMix;
            const writeValueL = Math.max(-1, Math.min(1, dryDelayInjectionL + reverbFeedbackWetL + delayedL * delayFeedback));
            const writeValueR = Math.max(-1, Math.min(1, dryDelayInjectionR + reverbFeedbackWetR + delayedR * delayFeedback));
            bufferL[writeIndex] = writeValueL;
            bufferR[writeIndex] = writeValueR;

            writeIndex++;
            if (writeIndex >= bufferLength) {
                writeIndex = 0;
            }
        }

        this.writeIndex = writeIndex;
        this.currentDelaySamples = currentDelaySamples;
        this.readIndex = readIndex;
        this.reverseHistoryWriteIndex = reverseHistoryWriteIndex;
        this.reverseHistoryFilled = reverseHistoryFilled;
        this.reverseSamplesSinceGrain = reverseSamplesSinceGrain;
        this.reverseReady = reverseReady;
        this.reverseBlendCurrent = reverseBlend;
        this.reverseBlendTarget = reverseBlendTarget;
        this.mixCurrent = mix;
        this.feedbackCurrent = feedback;
        this.lowCutAlphaCurrent = lowCutAlpha;
        this.highCutAlphaCurrent = highCutAlpha;
        this.tailSecondsCurrent = tailSeconds;
        this.densityCurrent = density;
        this.reverbLengthMixCurrent = reverbLengthMix;
        return true;
    }
}

registerProcessor('stereo-delay-reverb-processor', StereoDelayReverbProcessor);
