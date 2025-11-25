class LossArtifactsProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            {
                name: 'lossAmount',
                defaultValue: 0,
                minValue: 0,
                maxValue: 1,
                automationRate: 'a-rate'
            },
            {
                name: 'artifactAmount',
                defaultValue: 0,
                minValue: 0,
                maxValue: 1,
                automationRate: 'a-rate'
            }
        ];
    }

    constructor() {
        super();
        this.bufferSize = 16384;

        this.grainSize = 512;
        this.grainHop = 128;
        this.grainWindow = this._buildHannWindow(this.grainSize);

        this.artifactAmount = 0;
        this.artifactTarget = 0;
        this.artifactBlend = 0;
        this.artifactLowCoefBase = 0.02;
        this.artifactLowCoefRange = 0.3;
        this.artifactLowCoef = this.artifactLowCoefBase;
        this.artifactLowCoefTarget = this.artifactLowCoefBase;
        this.artifactFrameIntensity = 0;
        this.artifactSlewMin = 0.0015;
        this.artifactSlewMax = 0.02;
        this.prngState = 377913;
        this.tiltOctaveConfig = [
            { depth: 1, baseSpeed: 0.0004, speedRange: 0.0015, targetScale: 1, memory: 0.2 },
            { depth: 0.6, baseSpeed: 0.0012, speedRange: 0.004, targetScale: 0.8, memory: 0.1 },
            { depth: 0.35, baseSpeed: 0.006, speedRange: 0.02, targetScale: 0.6, memory: 0.05 }
        ];

        this.prominentFreq = 0;
        this.bandpassCurrentFreq = 440;
        this.bandpassTargetFreq = 440;
        this.bandpassQ = 20;
        this.bandpassCoeff = this._computeBandpassCoefficients(this.bandpassCurrentFreq, this.bandpassQ);
        this.bandpassSecondaryCurrentFreq = this.bandpassCurrentFreq;
        this.bandpassSecondaryTargetFreq = this.bandpassTargetFreq;
        this.bandpassSecondaryCoeff = this.bandpassCoeff;
        this.bandpassSecondaryActive = false;
        this.bandpassJumpThreshold = 80;
        this.bandpassJumpScale = 1 / 400;
        this.bandpassMinConfidence = 0.02;
        this.bandpassConfidenceReplaceRatio = 0.75;
        this.bandpassCandidates = [
            { freq: this.bandpassCurrentFreq, age: 0, valid: true, confidence: 1 },
            { freq: this.bandpassCurrentFreq, age: Infinity, valid: false, confidence: 0 }
        ];
        this.bandpassActiveIndex = 0;
        this.bandpassSecondaryIndex = 1;
        this.bandpassCandidateThresholdBase = 6;
        this.bandpassCandidateThresholdRatio = 0.0125;
        this.bandpassCandidateStaleSamples = 0;
        this.bandpassAlternateNext = false;
        this.bandpassPreferredMinFreq = 500;
        this.bandpassPreferredMaxFreq = 5000;
        this.bandpassConfidenceStickiness = 0.85;
        this.bandpassAlternateTolerance = 0.15;
        this.bandpassCloudSlots = 8;
        this.bandpassCloudFreqs = new Float32Array(this.bandpassCloudSlots);
        this.bandpassCloudCoeffs = new Array(this.bandpassCloudSlots);
        this.bandpassCloudSpreadQ = 6;

        this.laneCount = 2;
        this.lanes = Array.from({ length: this.laneCount }, () => this._createLaneState());

        this.pitchWindowSize = 2048;
        this.pitchHop = 128;
        this.pitchBuffer = new Float32Array(this.pitchWindowSize);
        this.pitchScratch = new Float32Array(this.pitchWindowSize);
        this.pitchWriteIndex = 0;
        this.pitchFilled = false;
        this.samplesSincePitch = 0;
        this.minFreq = 55;
        this.maxFreq = 1000;
        this.pitchTable = this._buildPitchTable();

        this.detectedFreq = 0;
        this.lockedFreq = 0;
        this.playbackRate = 1;
        this.freqSlew = 0.2;
        this.rateSlew = 0.15;
        this.minSlew = 0.01;
        this.maxSlew = 0.45;
        this.rateScale = 0.75;
        this.retuneSamples = Math.round(sampleRate * 0.5);
        this.samplesSinceRetune = this.retuneSamples;
        this.forceRetune = false;
        this.bandpassCandidateStaleSamples = this.retuneSamples * 12;

        this.samplesSinceBandpass = this.retuneSamples;
        this.forceBandpassUpdate = true;
        this._updateBandpassCloud();

        this.port.onmessage = (event) => {
            if (!event || !event.data || !event.data.type) {
                return;
            }
            if (event.data.type === 'interval') {
                this._setRetuneSamples(event.data.intervalSamples);
            } else if (event.data.type === 'trigger') {
                this.samplesSinceRetune = this.retuneSamples;
                this.samplesSinceBandpass = this.retuneSamples;
                this.forceRetune = true;
                this.forceBandpassUpdate = true;
            } else if (event.data.type === 'refresh') {
                this._resetLockState();
            }
        };
    }

    _resetLockState() {
        this.lockedFreq = 0;
        this.playbackRate = 1;
        this.samplesSinceRetune = this.retuneSamples;
        this.forceRetune = false;
        this.forceBandpassUpdate = true;
        this._resetBandpassState();
    }

    _resetBandpassState() {
        this.bandpassCurrentFreq = Math.max(this.minFreq, Math.min(this.maxFreq, this.bandpassTargetFreq || this.bandpassCurrentFreq || this.minFreq));
        this.bandpassTargetFreq = this.bandpassCurrentFreq;
        this.bandpassSecondaryCurrentFreq = this.bandpassCurrentFreq;
        this.bandpassSecondaryTargetFreq = this.bandpassCurrentFreq;
        this.samplesSinceBandpass = this.retuneSamples;
        this.bandpassCoeff = this._computeBandpassCoefficients(this.bandpassCurrentFreq, this.bandpassQ);
        this.bandpassSecondaryCoeff = this.bandpassCoeff;
        this.bandpassSecondaryActive = false;
        if (this.lanes) {
            for (let i = 0; i < this.lanes.length; i++) {
                const lane = this.lanes[i];
                if (lane && lane.bandpass) {
                    this._ensureBandpassCloudStates(lane);
                    if (lane.bandpass.primary) {
                        lane.bandpass.primary.x1 = 0;
                        lane.bandpass.primary.x2 = 0;
                        lane.bandpass.primary.y1 = 0;
                        lane.bandpass.primary.y2 = 0;
                    }
                    if (lane.bandpass.secondary) {
                        lane.bandpass.secondary.x1 = 0;
                        lane.bandpass.secondary.x2 = 0;
                        lane.bandpass.secondary.y1 = 0;
                        lane.bandpass.secondary.y2 = 0;
                    }
                    if (lane.bandpass.cloud && lane.bandpass.cloud.length) {
                        for (let c = 0; c < lane.bandpass.cloud.length; c++) {
                            const state = lane.bandpass.cloud[c];
                            if (!state) {
                                continue;
                            }
                            state.x1 = 0;
                            state.x2 = 0;
                            state.y1 = 0;
                            state.y2 = 0;
                        }
                    }
                }
            }
        }
        if (this.bandpassCandidates && this.bandpassCandidates.length >= 2) {
            this.bandpassCandidates[0].freq = this.bandpassCurrentFreq;
            this.bandpassCandidates[0].age = 0;
            this.bandpassCandidates[0].valid = true;
            this.bandpassCandidates[0].confidence = 1;
            this.bandpassCandidates[1].age = Infinity;
            this.bandpassCandidates[1].valid = false;
            this.bandpassCandidates[1].confidence = 0;
        }
        this.bandpassActiveIndex = 0;
        this.bandpassSecondaryIndex = 1;
        this.bandpassAlternateNext = false;
        this.forceBandpassUpdate = true;
    }

    _setRetuneSamples(samples) {
        if (!Number.isFinite(samples) || samples <= 0) {
            return;
        }
        const sanitized = Math.max(this.grainHop, Math.round(samples));
        this.retuneSamples = sanitized;
        this.samplesSinceRetune = Math.min(this.samplesSinceRetune, this.retuneSamples);
        this.samplesSinceBandpass = Math.min(this.samplesSinceBandpass, this.retuneSamples);
        this.bandpassCandidateStaleSamples = this.retuneSamples * 12;
    }

    _createGrain() {
        return {
            active: false,
            readIndex: 0,
            position: 0,
            playbackRate: 1
        };
    }

    _createLaneState() {
        return {
            buffer: new Float32Array(this.bufferSize),
            writeIndex: 0,
            fill: 0,
            grainCountdown: 0,
            grains: Array.from({ length: 4 }, () => this._createGrain()),
            tiltLow: 0,
            tiltInitialized: false,
            tiltOctaves: this._createTiltOctaves(),
            bandpass: {
                primary: this._createBandpassState(),
                secondary: this._createBandpassState(),
                cloud: Array.from({ length: this.bandpassCloudSlots }, () => this._createBandpassState())
            }
        };
    }

    _createBandpassState() {
        return {
            x1: 0,
            x2: 0,
            y1: 0,
            y2: 0
        };
    }

    _ensureBandpassCloudStates(lane) {
        if (!lane || !lane.bandpass) {
            return;
        }
        if (!lane.bandpass.cloud) {
            lane.bandpass.cloud = Array.from({ length: this.bandpassCloudSlots }, () => this._createBandpassState());
        } else if (lane.bandpass.cloud.length !== this.bandpassCloudSlots) {
            const resized = new Array(this.bandpassCloudSlots);
            for (let i = 0; i < this.bandpassCloudSlots; i++) {
                resized[i] = lane.bandpass.cloud[i] || this._createBandpassState();
            }
            lane.bandpass.cloud = resized;
        }
    }

    _processBandpassSample(sample, state, coeff) {
        if (!state || !coeff) {
            return sample;
        }
        const filtered = coeff.b0 * sample + coeff.b1 * state.x1 + coeff.b2 * state.x2 - coeff.a1 * state.y1 - coeff.a2 * state.y2;
        state.x2 = state.x1;
        state.x1 = sample;
        state.y2 = state.y1;
        state.y1 = filtered;
        return filtered;
    }

    _dampenBandpassStates(amount, which = 'both') {
        if (!this.lanes || amount <= 0) {
            return;
        }
        const retain = Math.max(0, 1 - Math.min(0.95, amount));
        const dampState = (state) => {
            if (!state) {
                return;
            }
            state.x1 *= retain;
            state.x2 *= retain;
            state.y1 *= retain;
            state.y2 *= retain;
        };
        const dampPrimary = which === 'both' || which === 'primary';
        const dampSecondary = which === 'both' || which === 'secondary';
        const dampCloud = which === 'both' || which === 'cloud';
        for (let i = 0; i < this.lanes.length; i++) {
            const lane = this.lanes[i];
            if (!lane || !lane.bandpass) {
                continue;
            }
            if (dampPrimary) {
                dampState(lane.bandpass.primary);
            }
            if (dampSecondary) {
                dampState(lane.bandpass.secondary);
            }
            if (dampCloud && lane.bandpass.cloud) {
                for (let c = 0; c < lane.bandpass.cloud.length; c++) {
                    dampState(lane.bandpass.cloud[c]);
                }
            }
        }
    }

    _buildHannWindow(size) {
        const window = new Float32Array(size);
        for (let i = 0; i < size; i++) {
            window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
        }
        return window;
    }

    _buildPitchTable() {
        const table = [];
        for (let midi = 36; midi <= 96; midi++) {
            table.push(440 * Math.pow(2, (midi - 69) / 12));
        }
        return table;
    }

    _createTiltOctaves() {
        return this.tiltOctaveConfig.map(() => ({ value: 0, target: 0 }));
    }

    _registerBandpassCandidate(freq, confidence = 0) {
        if (!Number.isFinite(freq) || freq <= 0) {
            return;
        }
        const preferMin = this.bandpassPreferredMinFreq || this.minFreq;
        const preferMax = this.bandpassPreferredMaxFreq || this.maxFreq;
        const clamped = Math.max(this.minFreq, Math.min(this.maxFreq, freq));
        const threshold = this._frequencyDistanceThreshold(clamped);
        const conf = Math.max(0, confidence || 0);
        if (conf < (this.bandpassMinConfidence || 0)) {
            return;
        }
        if (clamped < preferMin && this._hasPreferredCandidate()) {
            return;
        }
        const primary = this.bandpassCandidates[0];
        const secondary = this.bandpassCandidates[1];
        const assign = (candidate) => {
            candidate.freq = clamped;
            candidate.age = 0;
            candidate.valid = true;
            candidate.confidence = conf;
        };
        if (!primary.valid) {
            assign(primary);
            return;
        }
        const replaceRatio = this.bandpassConfidenceReplaceRatio || 0;
        const primaryDistance = Math.abs(primary.freq - clamped);
        if (primaryDistance <= threshold) {
            const minReplace = (primary.confidence || 0) * replaceRatio;
            if (!primary.valid || conf >= minReplace) {
                assign(primary);
            }
            return;
        }
        if (!secondary.valid) {
            assign(secondary);
            return;
        }
        const secondaryDistance = Math.abs(secondary.freq - clamped);
        if (secondaryDistance <= threshold) {
            const minReplace = (secondary.confidence || 0) * replaceRatio;
            if (!secondary.valid || conf >= minReplace) {
                assign(secondary);
            }
            return;
        }
        const primaryConfidence = primary.confidence ?? 0;
        const secondaryConfidence = secondary.confidence ?? 0;
        let replaceTarget = primaryConfidence <= secondaryConfidence ? primary : secondary;
        if (primaryConfidence === secondaryConfidence) {
            replaceTarget = primary.age >= secondary.age ? primary : secondary;
        }
        assign(replaceTarget);
    }

    _frequencyDistanceThreshold(freq) {
        const base = this.bandpassCandidateThresholdBase || 0;
        const ratio = this.bandpassCandidateThresholdRatio || 0;
        return base + freq * ratio;
    }

    _isPreferredBandpassFreq(freq) {
        if (!Number.isFinite(freq)) {
            return false;
        }
        const min = this.bandpassPreferredMinFreq || 0;
        const max = this.bandpassPreferredMaxFreq || Infinity;
        return freq >= min && freq <= max;
    }

    _scoreBandpassCandidate(candidate) {
        if (!candidate || !candidate.valid) {
            return -Infinity;
        }
        const confidence = candidate.confidence ?? 0;
        const freq = candidate.freq || 0;
        const preferredBoost = this._isPreferredBandpassFreq(freq) ? 0.3 : 0;
        const normalizedFreq = Math.max(0, Math.min(1, (freq - (this.bandpassPreferredMinFreq || 0)) / ((this.bandpassPreferredMaxFreq || freq) - (this.bandpassPreferredMinFreq || 0) + 1e-9)));
        const freqBias = normalizedFreq * 0.2;
        return confidence + preferredBoost + freqBias;
    }

    _hasPreferredCandidate() {
        const minConf = this.bandpassMinConfidence || 0;
        for (let i = 0; i < this.bandpassCandidates.length; i++) {
            const candidate = this.bandpassCandidates[i];
            if (!candidate || !candidate.valid) {
                continue;
            }
            if ((candidate.confidence ?? 0) >= minConf && this._isPreferredBandpassFreq(candidate.freq)) {
                return true;
            }
        }
        return false;
    }

    _refreshBandpassTarget() {
        const validIndices = [];
        for (let i = 0; i < this.bandpassCandidates.length; i++) {
            if (this.bandpassCandidates[i].valid) {
                validIndices.push(i);
            }
        }
        const preferMin = this.bandpassPreferredMinFreq || this.minFreq;
        const preferMax = this.bandpassPreferredMaxFreq || this.maxFreq;
        if (validIndices.length === 0) {
            const fallbackBase = this.bandpassCurrentFreq || this.prominentFreq || this.bandpassTargetFreq || preferMin || 440;
            const fallback = Math.max(preferMin, Math.min(preferMax, fallbackBase));
            this.bandpassTargetFreq = fallback;
            this.bandpassSecondaryTargetFreq = fallback;
            this.bandpassSecondaryActive = false;
            this.samplesSinceBandpass = 0;
            this.forceBandpassUpdate = false;
            return;
        }
        const candidateInfos = validIndices.map((idx) => ({
            idx,
            candidate: this.bandpassCandidates[idx],
            score: this._scoreBandpassCandidate(this.bandpassCandidates[idx])
        })).sort((a, b) => b.score - a.score);

        const primaryInfo = candidateInfos[0];
        const secondaryInfo = candidateInfos.length > 1 ? candidateInfos[1] : null;

        this.bandpassActiveIndex = primaryInfo?.idx ?? this.bandpassActiveIndex;
        this.bandpassSecondaryIndex = secondaryInfo?.idx ?? this.bandpassSecondaryIndex;

        const primaryFreq = primaryInfo ? Math.max(preferMin, Math.min(preferMax, primaryInfo.candidate.freq)) : Math.max(preferMin, Math.min(preferMax, this.bandpassTargetFreq || preferMin));
        const secondaryFreq = secondaryInfo ? Math.max(preferMin, Math.min(preferMax, secondaryInfo.candidate.freq)) : primaryFreq;

        this.bandpassTargetFreq = primaryFreq;
        this.bandpassSecondaryTargetFreq = secondaryFreq;
        this.bandpassSecondaryActive = Boolean(secondaryInfo);
        this.samplesSinceBandpass = 0;
        this.forceBandpassUpdate = false;
    }

    _ageBandpassCandidates(frames) {
        const limit = this.bandpassCandidateStaleSamples || (this.retuneSamples * 12);
        for (let i = 0; i < this.bandpassCandidates.length; i++) {
            const candidate = this.bandpassCandidates[i];
            if (!candidate.valid) {
                continue;
            }
            candidate.age += frames;
            if (candidate.age > limit) {
                candidate.valid = false;
                candidate.confidence = 0;
            }
        }
    }

    _computeBandpassCoefficients(freq, q) {
        const nyquist = sampleRate * 0.5;
        const clampedFreq = Math.max(10, Math.min(nyquist - 10, freq || 10));
        const omega = (2 * Math.PI * clampedFreq) / sampleRate;
        const sin = Math.sin(omega);
        const cos = Math.cos(omega);
        const alpha = sin / (2 * Math.max(0.001, q));
        const b0 = alpha;
        const b1 = 0;
        const b2 = -alpha;
        const a0 = 1 + alpha;
        const a1 = -2 * cos;
        const a2 = 1 - alpha;
        const norm = 1 / Math.max(1e-9, a0);
        return {
            b0: b0 * norm,
            b1: b1 * norm,
            b2: b2 * norm,
            a1: a1 * norm,
            a2: a2 * norm
        };
    }

    _writeInputSample(laneIndex, sample) {
        const lane = this.lanes[laneIndex];
        if (!lane) {
            return;
        }
        lane.buffer[lane.writeIndex] = sample;
        lane.writeIndex = (lane.writeIndex + 1) % this.bufferSize;
        if (lane.fill < this.bufferSize) {
            lane.fill++;
        }
    }

    _writePitchSample(sample) {
        this.pitchBuffer[this.pitchWriteIndex] = sample;
        this.pitchWriteIndex = (this.pitchWriteIndex + 1) % this.pitchWindowSize;
        if (!this.pitchFilled && this.pitchWriteIndex === 0) {
            this.pitchFilled = true;
        }
        this.samplesSincePitch++;
        if (this.pitchFilled && this.samplesSincePitch >= this.pitchHop) {
            this.samplesSincePitch = 0;
            this._updatePitchLock();
        }
    }

    _updatePitchLock() {
        const estimate = this._estimatePitch();
        if (!estimate || estimate.frequency <= 0 || !Number.isFinite(estimate.frequency)) {
            return;
        }
        this.detectedFreq = estimate.frequency;
        this.prominentFreq = estimate.frequency;
        this._registerBandpassCandidate(this.prominentFreq, estimate.confidence);
        const targetFreq = this._quantizeFrequency(estimate.frequency);
        if (!targetFreq) {
            return;
        }
        if (!this.lockedFreq) {
            this.lockedFreq = targetFreq;
            this.samplesSinceRetune = 0;
            this.forceRetune = false;
        } else {
            const needsRetune = Math.abs(targetFreq - this.lockedFreq) > Math.max(0.5, this.lockedFreq * 0.003);
            if (needsRetune) {
                if (this.samplesSinceRetune >= this.retuneSamples || this.forceRetune) {
                    this.lockedFreq = targetFreq;
                    this.samplesSinceRetune = 0;
                    this.forceRetune = false;
                }
            } else {
                this.forceRetune = false;
            }
        }
        const activeFreq = this.lockedFreq || targetFreq;
        const baseFreq = Math.max(1, this.detectedFreq);
        let desiredRate = activeFreq / baseFreq;
        desiredRate = Math.min(4, Math.max(0.25, desiredRate));
        this.playbackRate += (desiredRate - this.playbackRate) * this.rateSlew;
    }

    _configureResponse(lossValue) {
        const normalized = Math.min(1, Math.max(0, lossValue || 0));
        const division = 1 + normalized * 96;
        const targetSlew = 1 / division;
        const speedBoost = 4;
        const clamped = Math.min(this.maxSlew, Math.max(this.minSlew, targetSlew * speedBoost));
        this.freqSlew = clamped;
        this.rateSlew = Math.min(this.maxSlew, Math.max(this.minSlew, clamped * this.rateScale));
    }

    _configureArtifact(value) {
        const clamped = Math.min(1, Math.max(0, value || 0));
        this.artifactAmount = clamped;
        this.artifactTarget = clamped;
        this.artifactLowCoefTarget = this.artifactLowCoefBase + clamped * this.artifactLowCoefRange;
    }

    _random() {
        this.prngState = (this.prngState * 1664525 + 1013904223) >>> 0;
        return this.prngState / 0xffffffff;
    }

    _randomSigned() {
        return this._random() * 2 - 1;
    }

    _prepareArtifactFrame() {
        const slew = this.artifactSlewMin + (this.artifactSlewMax - this.artifactSlewMin) * this.artifactTarget;
        this.artifactBlend += (this.artifactTarget - this.artifactBlend) * slew;
        this.artifactLowCoef += (this.artifactLowCoefTarget - this.artifactLowCoef) * 0.05;
        this.artifactLowCoef = Math.max(0.001, Math.min(1, this.artifactLowCoef));
        this.artifactFrameIntensity = this.artifactBlend;
        this._updateBandpassFrequency();
    }

    _updateBandpassFrequency() {
        const preferMin = this.bandpassPreferredMinFreq || this.minFreq;
        const preferMax = this.bandpassPreferredMaxFreq || this.maxFreq;
        const fallback = this.prominentFreq || preferMin;
        const primaryTarget = Math.max(preferMin, Math.min(preferMax, this.bandpassTargetFreq || fallback));
        const primaryState = this._advanceBandpassFilter(primaryTarget, this.bandpassCurrentFreq, 'primary');
        this.bandpassCurrentFreq = primaryState.freq;
        this.bandpassCoeff = primaryState.coeff;

        if (this.bandpassSecondaryActive) {
            const secondaryTarget = Math.max(preferMin, Math.min(preferMax, this.bandpassSecondaryTargetFreq || primaryTarget));
            const secondaryState = this._advanceBandpassFilter(secondaryTarget, this.bandpassSecondaryCurrentFreq, 'secondary');
            this.bandpassSecondaryCurrentFreq = secondaryState.freq;
            this.bandpassSecondaryCoeff = secondaryState.coeff;
        } else {
            this.bandpassSecondaryCurrentFreq = this.bandpassCurrentFreq;
            this.bandpassSecondaryTargetFreq = this.bandpassTargetFreq;
            this.bandpassSecondaryCoeff = this.bandpassCoeff;
        }
        this._updateBandpassCloud();
    }

    _advanceBandpassFilter(targetFreq, currentFreq, which) {
        const preferMin = this.bandpassPreferredMinFreq || this.minFreq;
        const preferMax = this.bandpassPreferredMaxFreq || this.maxFreq;
        const desired = Math.max(preferMin, Math.min(preferMax, targetFreq || this.prominentFreq || preferMin));
        const previous = currentFreq || desired;
        const blend = 0.003 + (0.02 * (0.2 + this.artifactFrameIntensity));
        let next = previous + (desired - previous) * blend;
        next = Math.max(this.minFreq, Math.min(this.maxFreq, next));
        const delta = Math.abs(next - previous);
        if (delta > this.bandpassJumpThreshold) {
            const dampAmount = Math.min(0.95, delta * this.bandpassJumpScale);
            this._dampenBandpassStates(dampAmount, which);
        }
        return {
            freq: next,
            coeff: this._computeBandpassCoefficients(next, this.bandpassQ)
        };
    }

    _updateBandpassCloud() {
        if (!this.bandpassCloudSlots || !this.bandpassCloudCoeffs) {
            return;
        }
        const preferMin = this.bandpassPreferredMinFreq || this.minFreq;
        const preferMax = this.bandpassPreferredMaxFreq || this.maxFreq;
        const span = Math.max(1, preferMax - preferMin);
        const q = Math.max(1.5, this.bandpassCloudSpreadQ || (this.bandpassQ * 0.5));
        for (let i = 0; i < this.bandpassCloudSlots; i++) {
            const t = (i + 0.5) / this.bandpassCloudSlots;
            const freq = preferMin + span * t;
            this.bandpassCloudFreqs[i] = freq;
            this.bandpassCloudCoeffs[i] = this._computeBandpassCoefficients(freq, q);
        }
    }

    _quantizeFrequency(freq) {
        if (!Number.isFinite(freq) || freq <= 0) {
            return 0;
        }
        let best = this.pitchTable[0];
        let minDiff = Math.abs(freq - best);
        for (let i = 1; i < this.pitchTable.length; i++) {
            const candidate = this.pitchTable[i];
            const diff = Math.abs(freq - candidate);
            if (diff < minDiff) {
                minDiff = diff;
                best = candidate;
            }
        }
        return best;
    }

    _estimatePitch() {
        const size = this.pitchWindowSize;
        let srcIndex = this.pitchWriteIndex;
        for (let i = 0; i < size; i++) {
            this.pitchScratch[i] = this.pitchBuffer[srcIndex];
            srcIndex++;
            if (srcIndex >= size) {
                srcIndex = 0;
            }
        }
        const data = this.pitchScratch;
        let energy = 0;
        for (let i = 0; i < size; i++) {
            const sample = data[i];
            energy += sample * sample;
        }
        if (energy < 1e-7) {
            return null;
        }
        const minLag = Math.max(1, Math.floor(sampleRate / this.maxFreq));
        const maxLag = Math.min(size - 1, Math.floor(sampleRate / this.minFreq));
        let bestLag = 0;
        let bestScore = -Infinity;
        for (let lag = minLag; lag <= maxLag; lag++) {
            let corr = 0;
            for (let i = 0; i < size - lag; i += 2) {
                corr += data[i] * data[i + lag];
            }
            if (corr > bestScore) {
                bestScore = corr;
                bestLag = lag;
            }
        }
        if (bestLag === 0) {
            return null;
        }
        const frequency = sampleRate / bestLag;
        if (frequency < this.minFreq || frequency > this.maxFreq) {
            return null;
        }
        const normalized = bestScore / (energy + 1e-9);
        const confidence = Math.max(0, Math.min(1, normalized));
        if (confidence < (this.bandpassMinConfidence || 0)) {
            return { frequency, confidence };
        }
        return { frequency, confidence };
    }

    _spawnGrain(laneIndex) {
        const lane = this.lanes[laneIndex];
        if (!lane) {
            return;
        }
        const grain = lane.grains.find((g) => !g.active);
        if (!grain) {
            return;
        }
        if (lane.fill < this.grainSize * 2) {
            return;
        }
        const maxDelay = lane.fill - this.grainSize;
        const delay = Math.max(this.grainSize, Math.min(maxDelay, this.grainSize * 2));
        const startIndex = this._wrapBufferIndex(lane.writeIndex - delay);
        grain.active = true;
        grain.position = 0;
        grain.readIndex = startIndex;
        grain.playbackRate = this.playbackRate || 1;
        lane.grainCountdown = this.grainHop;
    }

    _wrapBufferIndex(index) {
        let wrapped = index % this.bufferSize;
        if (wrapped < 0) {
            wrapped += this.bufferSize;
        }
        return wrapped;
    }

    _sampleBuffer(buffer, readIndex) {
        const size = this.bufferSize;
        const baseIndex = Math.floor(readIndex) % size;
        const wrappedBase = baseIndex < 0 ? baseIndex + size : baseIndex;
        const nextIndex = (wrappedBase + 1) % size;
        const frac = readIndex - Math.floor(readIndex);
        const s0 = buffer[wrappedBase];
        const s1 = buffer[nextIndex];
        return s0 + (s1 - s0) * frac;
    }

    _renderGrains(laneIndex) {
        const lane = this.lanes[laneIndex];
        if (!lane) {
            return 0;
        }
        if (lane.grainCountdown <= 0) {
            this._spawnGrain(laneIndex);
        }
        lane.grainCountdown--;
        let sum = 0;
        let active = 0;
        for (let i = 0; i < lane.grains.length; i++) {
            const grain = lane.grains[i];
            if (!grain.active) {
                continue;
            }
            const windowValue = this.grainWindow[grain.position] || 0;
            const sample = this._sampleBuffer(lane.buffer, grain.readIndex) * windowValue;
            sum += sample;
            active++;
            grain.readIndex = this._wrapBufferIndex(grain.readIndex + (grain.playbackRate || 1));
            grain.position++;
            if (grain.position >= this.grainSize) {
                grain.active = false;
                grain.position = 0;
            }
        }
        if (active > 0) {
            sum /= active;
        }
        const tilted = this._applySpectralTilt(laneIndex, sum);
        return this._applyBandpass(laneIndex, tilted);
    }

    _applySpectralTilt(laneIndex, sample) {
        const lane = this.lanes[laneIndex];
        if (!lane) {
            return sample;
        }
        if (!lane.tiltInitialized) {
            lane.tiltLow = sample;
            lane.tiltInitialized = true;
        }
        const intensity = this.artifactFrameIntensity;
        const modulation = this._updateTiltOctaves(lane, intensity);
        const dynamicCoef = this.artifactLowCoef * (1 + Math.min(1, Math.abs(modulation) * 1.5));
        lane.tiltLow += (sample - lane.tiltLow) * dynamicCoef;
        const low = lane.tiltLow;
        const high = sample - low;
        const shaping = Math.pow(intensity, 0.85);
        const baseBias = shaping * 0.35;
        const modDepth = shaping * 0.65;
        const combinedTilt = Math.max(-0.95, Math.min(0.95, baseBias + modulation * modDepth));
        const lowWeight = 0.5 + combinedTilt * 0.5;
        const highWeight = 1 - lowWeight;
        const tilted = low * lowWeight + high * highWeight;
        return sample + (tilted - sample) * intensity;
    }

    _applyBandpass(laneIndex, sample) {
        const lane = this.lanes[laneIndex];
        if (!lane) {
            return sample;
        }
        if (!lane.bandpass) {
            lane.bandpass = {
                primary: this._createBandpassState(),
                secondary: this._createBandpassState(),
                cloud: Array.from({ length: this.bandpassCloudSlots }, () => this._createBandpassState())
            };
        }
        this._ensureBandpassCloudStates(lane);
        const primaryCoeff = this.bandpassCoeff;
        if (!primaryCoeff) {
            return sample;
        }
        const primaryState = lane.bandpass.primary;
        const secondaryState = lane.bandpass.secondary;
        const primaryFiltered = this._processBandpassSample(sample, primaryState, primaryCoeff);
        const secondaryCoeff = this.bandpassSecondaryCoeff || primaryCoeff;
        const secondaryFiltered = this._processBandpassSample(sample, secondaryState, secondaryCoeff);
        const intensity = this.artifactFrameIntensity;
        let combined = primaryFiltered;
        if (this.bandpassSecondaryActive) {
            combined = (primaryFiltered + secondaryFiltered) * 0.5;
        }
        const spreadAmount = Math.max(0, 1 - intensity);
        let cloudAverage = sample;
        const cloudSlots = this.bandpassCloudSlots || 0;
        const activeCloud = cloudSlots > 0 ? Math.min(cloudSlots, Math.max(0, Math.round(spreadAmount * cloudSlots))) : 0;
        if (activeCloud > 0 && this.bandpassCloudCoeffs) {
            let cloudSum = 0;
            let engaged = 0;
            for (let i = 0; i < activeCloud; i++) {
                const coeff = this.bandpassCloudCoeffs[i];
                if (!coeff) {
                    continue;
                }
                const cloudState = lane.bandpass.cloud[i] || (lane.bandpass.cloud[i] = this._createBandpassState());
                cloudSum += this._processBandpassSample(sample, cloudState, coeff);
                engaged++;
            }
            if (engaged > 0) {
                cloudAverage = (cloudSum / engaged + sample) * 0.5;
            }
        }
        if (spreadAmount >= 0.999) {
            cloudAverage = sample;
        }
        const focusWeight = Math.pow(Math.max(0, intensity), 0.9);
        const spreadWeight = 1 - focusWeight;
        return combined * focusWeight + cloudAverage * spreadWeight;
    }

    _updateTiltOctaves(lane, intensity) {
        if (!lane.tiltOctaves || lane.tiltOctaves.length !== this.tiltOctaveConfig.length) {
            lane.tiltOctaves = this._createTiltOctaves();
        }
        if (intensity <= 0.0001) {
            for (let i = 0; i < lane.tiltOctaves.length; i++) {
                const state = lane.tiltOctaves[i];
                state.value += (0 - state.value) * 0.02;
                state.target += (0 - state.target) * 0.05;
            }
            return 0;
        }
        let sum = 0;
        let weight = 0;
        for (let i = 0; i < this.tiltOctaveConfig.length; i++) {
            const cfg = this.tiltOctaveConfig[i];
            const state = lane.tiltOctaves[i];
            const speed = cfg.baseSpeed + cfg.speedRange * intensity;
            state.value += (state.target - state.value) * speed;
            if (Math.abs(state.target - state.value) < 0.01) {
                const random = this._randomSigned() * cfg.targetScale * intensity;
                state.target = random + state.value * cfg.memory;
            }
            const depth = cfg.depth * intensity;
            sum += state.value * depth;
            weight += cfg.depth;
        }
        if (weight <= 0) {
            return 0;
        }
        return Math.max(-1, Math.min(1, sum / weight));
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        if (!input || !input.length) {
            return true;
        }
        const inputChannels = input.length;
        const outputChannels = output.length;
        const channelCount = Math.min(inputChannels, outputChannels);
        if (channelCount === 0) {
            return true;
        }
        const frames = input[0]?.length || 0;
        if (!frames) {
            return true;
        }

        const lossValues = parameters.lossAmount || [0];
        const artifactValues = parameters.artifactAmount || [0];
        const hasAutomation = lossValues.length > 1;
        const blockLoss = lossValues[0] ?? 0;
        const hasArtifactAutomation = artifactValues.length > 1;
        const blockArtifact = artifactValues[0] ?? 0;
        const engaged = blockLoss > 0.0001 || hasAutomation;
        if (!engaged) {
            for (let ch = 0; ch < channelCount; ch++) {
                output[ch].set(input[ch]);
            }
            return true;
        }

        if (!hasAutomation) {
            this._configureResponse(blockLoss);
        }
        if (!hasArtifactAutomation) {
            this._configureArtifact(blockArtifact);
        }

        const laneInputCount = Math.min(this.lanes.length, Math.max(channelCount, 1));
        const laneOutputCount = Math.min(outputChannels, this.lanes.length);

        for (let i = 0; i < frames; i++) {
            const currentLoss = hasAutomation ? (lossValues[i] ?? blockLoss) : blockLoss;
            const currentArtifact = hasArtifactAutomation ? (artifactValues[i] ?? blockArtifact) : blockArtifact;
            if (hasAutomation) {
                this._configureResponse(currentLoss);
            }
            if (hasArtifactAutomation) {
                this._configureArtifact(currentArtifact);
            }
            this.samplesSinceRetune++;
            this.samplesSinceBandpass++;
            if (this.forceBandpassUpdate || this.samplesSinceBandpass >= this.retuneSamples) {
                this._refreshBandpassTarget();
            }
            let monoSample = 0;
            for (let ch = 0; ch < channelCount; ch++) {
                const sample = input[ch][i] || 0;
                monoSample += sample;
            }
            const divisor = channelCount || 1;
            monoSample /= divisor;

            for (let laneIndex = 0; laneIndex < laneInputCount; laneIndex++) {
                const sourceIndex = channelCount ? Math.min(laneIndex, channelCount - 1) : 0;
                const laneSample = channelCount ? (input[sourceIndex][i] || 0) : monoSample;
                this._writeInputSample(laneIndex, laneSample);
            }

            this._writePitchSample(monoSample);
            this._prepareArtifactFrame();

            for (let laneIndex = 0; laneIndex < laneOutputCount; laneIndex++) {
                output[laneIndex][i] = this._renderGrains(laneIndex);
            }

            const fallbackValue = laneOutputCount > 0 ? output[Math.min(laneOutputCount - 1, outputChannels - 1)][i] : monoSample;
            for (let ch = laneOutputCount; ch < channelCount; ch++) {
                output[ch][i] = fallbackValue;
            }
            for (let ch = Math.max(channelCount, laneOutputCount); ch < outputChannels; ch++) {
                output[ch][i] = fallbackValue;
            }
        }

        this._ageBandpassCandidates(frames);

        return true;
    }
}

registerProcessor('loss-artifacts-processor', LossArtifactsProcessor);
