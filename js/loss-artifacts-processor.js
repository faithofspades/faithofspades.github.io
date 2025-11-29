const LOG_TO_DB = 4.342944819032518;
const DB_TO_LN = Math.LN10 / 20;

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
        this.bandpassQBase = 20;
        this.bandpassQMin = 6;
        this.bandpassQ = this.bandpassQBase;
        this.resonanceSuppression = 0;
        this.resonanceSuppressionCoef = 1 - Math.exp(-1 / Math.max(1, sampleRate * 0.05));
        this.resonanceSlowInterval = 0.55;
        this.focusSuppression = 1;
        this.spreadSuppression = 1;
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
        this.bandpassPreferredMinFreq = 400;
        this.bandpassPreferredMaxFreq = 5000;
        this.bandpassConfidenceStickiness = 0.15;
        this.bandpassAlternateTolerance = 0.15;
        this.bandpassCloudSlots = 8;
        this.bandpassCloudFreqs = new Float32Array(this.bandpassCloudSlots);
        this.bandpassCloudCoeffs = new Array(this.bandpassCloudSlots);
        this.bandpassCloudSpreadQ = 6;

        this.laneCount = 3;
        this.lanes = Array.from({ length: this.laneCount }, () => this._createLaneState());
        this.bassLaneIndex = this.laneCount - 1;

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

        this.lossSmooth = 0;
        this.lossSmoothInitialized = false;
        this.lossSmoothCoef = 0.0008;
        this.lossEngageThreshold = 0.0015;
        this.artifactSmooth = 0;
        this.artifactSmoothInitialized = false;
        this.artifactSmoothCoef = 0.0004;
        this.artifactEngageThreshold = 0.0015;
        this.artifactDropLevel = 1;
        this.artifactDropMinLevel = 0.25;
        this.artifactDropThreshold = 0.08;
        this.artifactDropHoldSamples = Math.max(1, Math.round(sampleRate * 0.02));
        this.artifactDropHold = 0;
        this.artifactDropRecoverCoef = 1 - Math.exp(-1 / Math.max(1, sampleRate * 0.08));
        this.lastLossBlock = 0;
        this.lastArtifactBlock = 0;
        this.knobFallbackThreshold = 0.02;
        this.knobFallbackSamples = Math.round(sampleRate * 0.18);
        this.knobFallbackRemaining = 0;
        this.knobFallbackMaxBlend = 0.75;
        this.knobFallbackBlendValue = 0;
        this.knobFallbackAttackCoef = 1 - Math.exp(-1 / Math.max(1, sampleRate * 0.004));
        this.knobFallbackReleaseCoef = 1 - Math.exp(-1 / Math.max(1, sampleRate * 0.08));
        this.fallbackLowCoef = 0.01;
        this.fallbackLow = new Float32Array(Math.max(1, this.laneCount));
        this.resonanceFallbackMax = 0.65;
        this.resonanceMakeupDrop = 0.55;
        this.resonanceSpikeHold = 0;
        this.resonanceSpikeHoldSamples = Math.max(1, Math.round(sampleRate * 0.32));
        this.resonanceSpikeThreshold = 0.66;
        this.resonanceSpikeBlendMax = 0.85;
        this.resonanceSpikeGainDrop = 0.45;

        this.dryEnv = 0;
        this.wetEnv = 0;
        this.levelFloor = 1e-7;
        this.levelMatchCoef = 1 - Math.exp(-1 / Math.max(1, sampleRate * 0.02));
        this.makeupGain = 1;
        this.makeupSlewCoef = 1 - Math.exp(-1 / Math.max(1, sampleRate * 0.04));
        this.makeupMinGain = 0.4;
        this.makeupMaxGain = 18;
        this.levelAggression = 1.15;
        this.artifactLiftDb = 8;
        this.artifactBaseDb = 1.2;

        this.limiterEnv = new Float32Array(Math.max(1, this.laneCount));
        this.limiterAttackCoef = 1 - Math.exp(-1 / Math.max(1, sampleRate * 0.005));
        this.limiterReleaseCoef = 1 - Math.exp(-1 / Math.max(1, sampleRate * 0.12));
        this.limiterCeilingBase = 0.94;
        this.limiterCeilingMin = 0.72;
        this.limiterStressBoost = 0.85;
        this.softClipThreshold = 0.88;
        this.softClipShape = 0.55;

        this.bassPitchWindowSize = 4096;
        this.bassPitchHop = 256;
        this.bassPitchBuffer = new Float32Array(this.bassPitchWindowSize);
        this.bassPitchScratch = new Float32Array(this.bassPitchWindowSize);
        this.bassPitchWriteIndex = 0;
        this.bassPitchFilled = false;
        this.samplesSinceBassPitch = 0;
        this.bassMinFreq = 48;
        this.bassMaxFreq = 331;
        this.bassFreq = 110;
        this.bassTargetFreq = 110;
        this.bassHoldSamples = Math.round(sampleRate * 0.35);
        this.samplesSinceBassChange = this.bassHoldSamples;
        this.bassConfidenceThreshold = 0.25;
        this.bassLargeJumpHz = 16;
        this.bassUpdateBlend = 0.015;
        this.bassQ = 45;
        this.bassFilterState = this._createBandpassState();
        this.bassFilterCoeff = this._computeBandpassCoefficients(this.bassFreq, this.bassQ);

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

        this._resetBandpassState();
    }

    _resetLockState() {
        // Clear pitch tracking buffers so the next block re-detects from scratch
        if (this.pitchBuffer) {
            this.pitchBuffer.fill(0);
        }
        if (this.pitchScratch) {
            this.pitchScratch.fill(0);
        }

        this.pitchWriteIndex = 0;
        this.pitchFilled = false;
        this.samplesSincePitch = 0;

        this.detectedFreq = 0;
        this.prominentFreq = 0;
        this.lockedFreq = 0;
        this.playbackRate = 1;
        this.samplesSinceRetune = this.retuneSamples;
        this.forceRetune = false;
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

    _updateBassFilter() {
        if (!Number.isFinite(this.bassTargetFreq)) {
            return;
        }
        const target = Math.max(this.bassMinFreq, Math.min(this.bassMaxFreq, this.bassTargetFreq));
        const previous = this.bassFreq || target;
        const blend = Math.max(0.001, this.bassUpdateBlend || 0.01);
        const next = previous + (target - previous) * blend;
        this.bassFreq = next;
        this.bassFilterCoeff = this._computeBandpassCoefficients(next, this.bassQ || this.bandpassQ || 20);
    }

    _applyBassFilter(sample) {
        if (!this.bassFilterState) {
            this.bassFilterState = this._createBandpassState();
        }
        if (!this.bassFilterCoeff) {
            const freq = this.bassFreq || this.bassMinFreq || 60;
            this.bassFilterCoeff = this._computeBandpassCoefficients(freq, this.bassQ || this.bandpassQ || 20);
        }
        return this._processBandpassSample(sample, this.bassFilterState, this.bassFilterCoeff);
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

    _writeBassPitchSample(sample) {
        if (!this.bassPitchBuffer) {
            return;
        }
        this.bassPitchBuffer[this.bassPitchWriteIndex] = sample;
        this.bassPitchWriteIndex = (this.bassPitchWriteIndex + 1) % this.bassPitchWindowSize;
        if (!this.bassPitchFilled && this.bassPitchWriteIndex === 0) {
            this.bassPitchFilled = true;
        }
        this.samplesSinceBassPitch++;
        if (this.bassPitchFilled && this.samplesSinceBassPitch >= this.bassPitchHop) {
            this.samplesSinceBassPitch = 0;
            this._updateBassTracker();
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

    _updateBassTracker() {
        const estimate = this._estimateBassPitch();
        if (!estimate) {
            return;
        }
        const confidence = estimate.confidence;
        if (confidence < this.bassConfidenceThreshold) {
            return;
        }
        const freq = Math.max(this.bassMinFreq, Math.min(this.bassMaxFreq, estimate.frequency));
        const delta = Math.abs(freq - this.bassTargetFreq);
        const largeMove = delta >= this.bassLargeJumpHz;
        if (!largeMove && delta < 0.6) {
            return;
        }
        if (this.samplesSinceBassChange < this.bassHoldSamples && !largeMove) {
            return;
        }
        this.bassTargetFreq = freq;
        this.samplesSinceBassChange = 0;
    }

    _estimateBassPitch() {
        if (!this.bassPitchFilled) {
            return null;
        }
        const size = this.bassPitchWindowSize;
        let srcIndex = this.bassPitchWriteIndex;
        for (let i = 0; i < size; i++) {
            this.bassPitchScratch[i] = this.bassPitchBuffer[srcIndex];
            srcIndex++;
            if (srcIndex >= size) {
                srcIndex = 0;
            }
        }
        const data = this.bassPitchScratch;
        let energy = 0;
        for (let i = 0; i < size; i++) {
            const sample = data[i];
            energy += sample * sample;
        }
        if (energy < 1e-8) {
            return null;
        }
        const minLag = Math.max(1, Math.floor(sampleRate / this.bassMaxFreq));
        const maxLag = Math.min(size - 1, Math.floor(sampleRate / Math.max(1, this.bassMinFreq)));
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
        if (!Number.isFinite(frequency) || frequency < this.bassMinFreq || frequency > this.bassMaxFreq) {
            return null;
        }
        const normalized = bestScore / (energy + 1e-9);
        const confidence = Math.max(0, Math.min(1, normalized));
        return { frequency, confidence };
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

    _updateResonanceSuppression(lossValue) {
        const normalizedLoss = Math.min(1, Math.max(0, lossValue || 0));
        const lowLossFactor = Math.max(0, (0.55 - normalizedLoss) / 0.55);
        const intervalSeconds = Math.max(0, this.retuneSamples / sampleRate);
        const slowTempoFactor = Math.min(1, intervalSeconds / this.resonanceSlowInterval);
        const holdFactor = Math.min(1, this.samplesSinceRetune / Math.max(1, this.retuneSamples));
        const stress = lowLossFactor * Math.max(holdFactor, slowTempoFactor);
        const targetSuppression = Math.max(0, Math.min(1, stress));
        this.resonanceSuppression += (targetSuppression - this.resonanceSuppression) * this.resonanceSuppressionCoef;
        const baseQ = this.bandpassQBase || 20;
        const minQ = this.bandpassQMin || 6;
        const qRange = Math.max(0, baseQ - minQ);
        const dynamicQ = baseQ - qRange * this.resonanceSuppression;
        this.bandpassQ = Math.max(minQ, Math.min(baseQ, dynamicQ));
        this.focusSuppression = Math.max(0.25, 1 - 0.7 * this.resonanceSuppression);
        this.spreadSuppression = Math.max(0.15, 1 - 0.8 * this.resonanceSuppression);
        if (this.resonanceSpikeHold > 0) {
            this.bandpassQ = Math.max(this.bandpassQMin, this.bandpassQ * 0.5);
            this.focusSuppression = Math.min(this.focusSuppression, 0.45);
            this.spreadSuppression = Math.min(this.spreadSuppression, 0.45);
        }
    }

    _computeResonanceMakeupScale() {
        const dropAmount = Math.max(0, Math.min(1, this.resonanceSuppression * this.resonanceMakeupDrop));
        const scale = 1 - dropAmount;
        return Math.max(0.3, scale);
    }

    _applySoftClip(sample) {
        const threshold = this.softClipThreshold || 1;
        if (Math.abs(sample) <= threshold) {
            return sample;
        }
        const shape = Math.max(0.01, this.softClipShape || 0.5);
        const excess = Math.abs(sample) - threshold;
        const clipped = threshold + Math.tanh(excess * (1 / shape)) * shape;
        return sample < 0 ? -clipped : clipped;
    }

    _currentLimiterCeiling() {
        const base = this.limiterCeilingBase || 0.94;
        const min = this.limiterCeilingMin || 0.72;
        const stress = Math.max(0, Math.min(1, this.resonanceSuppression * (this.limiterStressBoost || 1)));
        const range = Math.max(0, base - min);
        return Math.max(min, base - range * stress);
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

    _renderArtifactsOnly(laneIndex, sample) {
        return this._applyBandpass(laneIndex, this._applySpectralTilt(laneIndex, sample));
    }

    _suspendGrains(laneIndex) {
        const lane = this.lanes[laneIndex];
        if (!lane || !lane.grains) {
            return;
        }
        lane.grainCountdown = 0;
        for (let i = 0; i < lane.grains.length; i++) {
            const grain = lane.grains[i];
            if (!grain) {
                continue;
            }
            grain.active = false;
            grain.position = 0;
        }
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
        if (laneIndex === this.bassLaneIndex) {
            this._updateBassFilter();
            return this._applyBassFilter(sample);
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
        const spreadLimiter = Math.max(0, Math.min(1, this.spreadSuppression || 1));
        const spreadAmount = Math.max(0, Math.min(1, (1 - intensity) * spreadLimiter));
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
        const focusBase = Math.pow(Math.max(0, intensity), 0.9);
        const focusLimiter = Math.max(0.25, Math.min(1, this.focusSuppression || 1));
        const focusWeight = Math.max(0, Math.min(1, focusBase * focusLimiter));
        const spreadWeight = Math.max(0, 1 - focusWeight);
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
        const engaged = blockLoss > 0.0001 || blockArtifact > 0.0001 || hasAutomation || hasArtifactAutomation;
        if (!engaged) {
            for (let ch = 0; ch < channelCount; ch++) {
                output[ch].set(input[ch]);
            }
            return true;
        }

        for (let ch = 0; ch < outputChannels; ch++) {
            output[ch].fill(0);
        }

        this._prepareArtifactFrame();

        if (!this.lossSmoothInitialized) {
            this.lossSmooth = blockLoss;
            this.lossSmoothInitialized = true;
        }
        if (!this.artifactSmoothInitialized) {
            this.artifactSmooth = blockArtifact;
            this.artifactSmoothInitialized = true;
        }

        const lossDelta = Math.abs(blockLoss - this.lastLossBlock);
        const artifactDelta = Math.abs(blockArtifact - this.lastArtifactBlock);
        this.lastLossBlock = blockLoss;
        this.lastArtifactBlock = blockArtifact;
        if (lossDelta > this.knobFallbackThreshold || artifactDelta > this.knobFallbackThreshold) {
            this.knobFallbackRemaining = this.knobFallbackSamples;
        }

        const laneInputCount = this.lanes.length;
        const laneOutputCount = this.lanes.length;
        const fallbackChannels = Math.max(1, laneOutputCount);
        if (!this.fallbackLow || this.fallbackLow.length < fallbackChannels) {
            const replacement = new Float32Array(fallbackChannels);
            replacement.set(this.fallbackLow ?? []);
            this.fallbackLow = replacement;
        }
        if (!this.limiterEnv || this.limiterEnv.length < fallbackChannels) {
            const limiter = new Float32Array(fallbackChannels);
            limiter.set(this.limiterEnv ?? []);
            this.limiterEnv = limiter;
        }

        const fallbackWindow = Math.max(1, this.knobFallbackSamples);
        let previousLossTarget = blockLoss;
        let previousArtifactTarget = blockArtifact;

        for (let i = 0; i < frames; i++) {
            const lossTarget = hasAutomation ? (lossValues[i] ?? blockLoss) : blockLoss;
            const artifactTarget = hasArtifactAutomation ? (artifactValues[i] ?? blockArtifact) : blockArtifact;
            if (Math.abs(lossTarget - previousLossTarget) > this.knobFallbackThreshold ||
                Math.abs(artifactTarget - previousArtifactTarget) > this.knobFallbackThreshold) {
                this.knobFallbackRemaining = this.knobFallbackSamples;
            }
            const artifactDrop = previousArtifactTarget - artifactTarget;
            if (artifactDrop > this.artifactDropThreshold) {
                this.artifactDropLevel = Math.min(this.artifactDropLevel, this.artifactDropMinLevel);
                this.artifactDropHold = this.artifactDropHoldSamples;
            }
            if (this.artifactDropHold > 0) {
                this.artifactDropHold--;
            } else {
                this.artifactDropLevel += (1 - this.artifactDropLevel) * this.artifactDropRecoverCoef;
            }
            this.artifactDropLevel = Math.max(0, Math.min(1, this.artifactDropLevel));
            previousLossTarget = lossTarget;
            previousArtifactTarget = artifactTarget;

            this.lossSmooth += (lossTarget - this.lossSmooth) * this.lossSmoothCoef;
            this.artifactSmooth += (artifactTarget - this.artifactSmooth) * this.artifactSmoothCoef;

            this._configureResponse(this.lossSmooth);
            this._configureArtifact(this.artifactSmooth);
            const lossInstant = Math.max(lossTarget, this.lossSmooth);
            const artifactInstant = Math.max(artifactTarget, this.artifactSmooth);
            const lossEngaged = lossInstant > this.lossEngageThreshold;
            const artifactEngaged = artifactInstant > this.artifactEngageThreshold;

            const fallbackTarget = this.knobFallbackRemaining > 0
                ? this.knobFallbackMaxBlend * (this.knobFallbackRemaining / fallbackWindow)
                : 0;
            const fallbackCoef = fallbackTarget > this.knobFallbackBlendValue
                ? this.knobFallbackAttackCoef
                : this.knobFallbackReleaseCoef;
            this.knobFallbackBlendValue += (fallbackTarget - this.knobFallbackBlendValue) * fallbackCoef;
            const fallbackBlend = this.knobFallbackBlendValue;
            if (this.knobFallbackRemaining > 0) {
                this.knobFallbackRemaining--;
            }
            const spikeSamples = Math.max(1, this.resonanceSpikeHoldSamples || 1);
            const spikePhase = this.resonanceSpikeHold > 0 ? this.resonanceSpikeHold / spikeSamples : 0;
            const spikeBlend = this.resonanceSpikeBlendMax * spikePhase;
            const spikeGainScale = Math.max(0.15, 1 - this.resonanceSpikeGainDrop * spikePhase);
            if (this.resonanceSpikeHold > 0) {
                this.resonanceSpikeHold--;
            }
            let wetEnergy = 0;
            this.samplesSinceBassChange++;
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

            const dryEnergy = monoSample * monoSample;
            this.dryEnv += (dryEnergy - this.dryEnv) * this.levelMatchCoef;
            const dryPower = Math.max(this.dryEnv, this.levelFloor);
            const wetPower = Math.max(this.wetEnv, this.levelFloor);
            const dryDb = LOG_TO_DB * Math.log(dryPower);
            const wetDb = LOG_TO_DB * Math.log(wetPower);
            const deficitDb = Math.max(0, dryDb - wetDb);
            const artifactDrive = this.artifactSmooth * this.artifactDropLevel;
            const artifactDb = artifactDrive * this.artifactLiftDb;
            const baseDb = artifactDrive > 0.02 ? this.artifactBaseDb : 0;
            const desiredDbGain = (deficitDb * this.levelAggression) + artifactDb + baseDb;
            const desiredGainRaw = Math.exp(DB_TO_LN * desiredDbGain);
            const desiredGain = Math.min(this.makeupMaxGain, Math.max(this.makeupMinGain, desiredGainRaw));
            this.makeupGain += (desiredGain - this.makeupGain) * this.makeupSlewCoef;

            for (let laneIndex = 0; laneIndex < laneInputCount; laneIndex++) {
                const sourceIndex = channelCount ? Math.min(laneIndex, channelCount - 1) : 0;
                let laneSample;
                if (laneIndex === this.bassLaneIndex) {
                    laneSample = monoSample;
                } else if (channelCount) {
                    laneSample = input[sourceIndex][i] || 0;
                } else {
                    laneSample = monoSample;
                }
                this._writeInputSample(laneIndex, laneSample);
            }

            this._writeBassPitchSample(monoSample);
            this._writePitchSample(monoSample);
            this._updateResonanceSuppression(this.lossSmooth);
            this._prepareArtifactFrame();

            for (let laneIndex = 0; laneIndex < laneOutputCount; laneIndex++) {
                const dryIndex = channelCount ? Math.min(laneIndex, channelCount - 1) : 0;
                const drySample = channelCount ? (input[dryIndex][i] || 0) : monoSample;
                if (!lossEngaged) {
                    this._suspendGrains(laneIndex);
                }
                let effectedSample;
                if (lossEngaged) {
                    effectedSample = this._renderGrains(laneIndex);
                } else if (artifactEngaged) {
                    const artifactSample = this._renderArtifactsOnly(laneIndex, drySample);
                    if (this.artifactDropLevel < 0.999) {
                        const dropBlend = 1 - this.artifactDropLevel;
                        effectedSample = artifactSample * this.artifactDropLevel + drySample * dropBlend;
                    } else {
                        effectedSample = artifactSample;
                    }
                } else {
                    effectedSample = drySample;
                }
                const previousLow = this.fallbackLow[laneIndex] || 0;
                const lowSample = previousLow + this.fallbackLowCoef * (drySample - previousLow);
                this.fallbackLow[laneIndex] = lowSample;
                const fallbackSample = fallbackBlend > 0
                    ? (effectedSample * (1 - fallbackBlend)) + (lowSample * fallbackBlend)
                    : effectedSample;
                const stressBlendBase = Math.max(0, Math.min(1, this.resonanceSuppression * this.resonanceFallbackMax));
                const combinedBlend = 1 - (1 - stressBlendBase) * (1 - spikeBlend);
                const stressedSample = combinedBlend > 0
                    ? (fallbackSample * (1 - combinedBlend)) + (lowSample * combinedBlend)
                    : fallbackSample;
                const resonanceGain = this._computeResonanceMakeupScale() * spikeGainScale;
                const wetSample = stressedSample * this.makeupGain * resonanceGain;
                const clippedSample = Math.abs(wetSample) > this.softClipThreshold
                    ? this._applySoftClip(wetSample)
                    : wetSample;
                const limitedSample = this._applyLimiter(clippedSample, laneIndex);
                wetEnergy += limitedSample * limitedSample;
                if (laneIndex === this.bassLaneIndex) {
                    for (let ch = 0; ch < outputChannels; ch++) {
                        if (!output[ch]) {
                            continue;
                        }
                        output[ch][i] += limitedSample;
                    }
                } else if (laneIndex < outputChannels) {
                    output[laneIndex][i] += limitedSample;
                } else if (outputChannels > 0) {
                    output[outputChannels - 1][i] += limitedSample;
                }
            }

            const wetSampleCount = laneOutputCount || 1;
            const avgWetEnergy = wetEnergy / wetSampleCount;
            this.wetEnv += (avgWetEnergy - this.wetEnv) * this.levelMatchCoef;

            if (outputChannels > laneOutputCount) {
                const refIndex = Math.min(outputChannels - 1, laneOutputCount - 1);
                const fallbackValue = output[refIndex] ? output[refIndex][i] : monoSample;
                for (let ch = laneOutputCount; ch < outputChannels; ch++) {
                    output[ch][i] = fallbackValue;
                }
            }
        }

        this._ageBandpassCandidates(frames);

        return true;
    }

    _applyLimiter(sample, laneIndex) {
        if (!this.limiterEnv || laneIndex >= this.limiterEnv.length) {
            return sample;
        }
        const env = this.limiterEnv[laneIndex] || 0;
        const absSample = Math.abs(sample);
        const coef = absSample > env ? this.limiterAttackCoef : this.limiterReleaseCoef;
        const nextEnv = env + (absSample - env) * coef;
        this.limiterEnv[laneIndex] = nextEnv;
        const ceiling = this._currentLimiterCeiling();
        const spikeThreshold = this.resonanceSpikeThreshold || 0.66;
        if (nextEnv > spikeThreshold) {
            const holdSamples = this.resonanceSpikeHoldSamples || 0;
            if (holdSamples > 0) {
                this.resonanceSpikeHold = Math.max(this.resonanceSpikeHold, holdSamples);
            }
        }
        if (nextEnv <= ceiling) {
            return sample;
        }
        const gain = ceiling / (nextEnv + this.levelFloor);
        return sample * gain;
    }
}

registerProcessor('loss-artifacts-processor', LossArtifactsProcessor);
