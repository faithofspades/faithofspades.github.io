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

        // Minimal, click-auditable core: packetize + drop + crossfade.
        // 10ms @ 48kHz = 480 samples.
        this.packetSize = 480;
        this.fadeSamples = 96;
        this.maxBufferPackets = 32;
        this.prebufferPackets = 2;

        // Packet builder
        this.buildBuffers = [];
        this.buildIndex = 0;

        // FIFO of complete packets (each packet is Float32Array[] per channel)
        this.packetBuffer = [];

        // Playback state
        this.currPacket = null;
        this.currIndex = 0;
        this.outputtingSilence = true;
        this.fadeInActive = true;
        this.needsFadeInNextPacket = false;

        // If we start fading out (underflow), keep it latched for the rest of the packet.
        this.fadeOutToCngActive = false;

        // Lookahead for loss-aware fades (time-preserving loss)
        this.nextPacket = null;

        // Repeat-based concealment (only used on lost frames)
        this.lastGoodPacket = null;
        this.lostStreakFrames = 0;
        this.repeatLP = [];
        this.repeatLPCoef = 0.35;
        this.repeatFrameDecay = 0.65;
        this.repeatStrengthSmooth = 0;
        this.repeatStrengthCoef = 0.0015;
        this.repeatStrengthForConceal = 0;

        // Nearby-packet borrow (only used on lost frames)
        this.historyPackets = [];
        this.maxHistoryPackets = 12;
        this.borrowedPacket = null;

        // Smoothed controls
        // NOTE: lossAmount is treated as wet/dry mix in the main thread.
        // The worklet keeps this for telemetry/smoothing only.
        this.lossSmooth = 0;
        this.artifactSmooth = 0;
        this.lossSmoothCoef = 0.005;
        this.artifactSmoothCoef = 0.005;

        // Dropout scheduling (tempo division-driven)
        this.intervalSamples = Number.POSITIVE_INFINITY;
        this.triggerDrop = false;

        // PRNG (deterministic)
        this.prngState = 377913;

        // Click detector (throttled)
        this.lastOut = [];
        this.clickCooldown = 0;

        // De-click ramp when we transition into silence due to underflow
        this.silenceRampFrom = [];
        this.silenceRampPos = 0;

        // Comfort noise (VoIP-style CNG) to avoid hard transitions to/from silence
        this.env = [];
        this.cngLP = [];
        this.envCoef = 0.01;
        this.cngLPCoef = 0.08;
        this.cngMix = 0.12;

        // Input envelope (mono) to gate loss-driven artifacts.
        this.inEnv = 0;
        this.inEnvCoef = 0.01;

        // Spectral smear / warble (cheap diffusion): cascaded 1st-order allpass filters.
        // Coefficients are chosen per packet and smoothly ramped across the packet.
        this.smearStages = 2;
        this.smearAStart = new Float32Array(this.smearStages);
        this.smearAEnd = new Float32Array(this.smearStages);
        this.smearX1 = [];
        this.smearY1 = [];

        // Pitch tracking: lightweight decimated autocorrelation on a small fixed window.
        this.pitchRingLen = 2048;
        this.pitchRing = new Float32Array(this.pitchRingLen);
        this.pitchRingWrite = 0;
        this.pitchDecim = 12;
        this.pitchAnalysisLen = 256;
        this.pitchTemp = new Float32Array(this.pitchAnalysisLen);
        this.pitchUpdateEveryPackets = 12;
        this.packetCounter = 0;
        this.pitchHz = 180;
        this.pitchHzSmooth = 180;
        this.pitchSmoothCoef = 0.12;
        this.pitchConfidence = 0;

        // Spectral pitch-tracking glide: lightweight multi-band "focus" (low/mid/high)
        // that follows a pitch-derived mid target and adds those bands alongside dry.
        this.focusMidFc = 700;
        this.focusLowFc = 350;
        this.focusHighFc = 1400;
        this.focusReady = false;
        this.focusBandCount = 3;
        this.focusB0 = new Float32Array(this.focusBandCount);
        this.focusB1 = new Float32Array(this.focusBandCount);
        this.focusB2 = new Float32Array(this.focusBandCount);
        this.focusA1 = new Float32Array(this.focusBandCount);
        this.focusA2 = new Float32Array(this.focusBandCount);
        this.focusX1 = [];
        this.focusX2 = [];
        this.focusY1 = [];
        this.focusY2 = [];

        // "Alien console" blips: pitch-corrected resonant pings that arpeggiate
        // harmonics of the detected fundamental and overlap. Driven by input audio.
        this.bloopVoices = 7;
        this.bloopActive = new Array(this.bloopVoices).fill(false);
        this.bloopSamplesLeft = new Int32Array(this.bloopVoices);
        this.bloopSamplesTotal = new Int32Array(this.bloopVoices);
        this.bloopPhase01 = new Float32Array(this.bloopVoices);
        this.bloopPhaseInc = new Float32Array(this.bloopVoices);
        this.bloopOscPhase01 = new Float32Array(this.bloopVoices);
        this.bloopOscInc = new Float32Array(this.bloopVoices);
        this.bloopAmp = new Float32Array(this.bloopVoices);
        this.bloopActiveCount = 0;
        this.bloopMixSmooth = 0;
        this.bloopMixCoef = 0.002;
        this.bloopNormSmooth = 1;
        this.bloopNormCoef = 0.004;

        // Artifact-driven phaser sweeps (random timing): allpass cascade with center frequency
        // that sweeps between 500Hz and 6kHz, then HOLDS at the end until the next sweep.
        // Applied to the actual signal (not an additive noise-like layer).
        this.sweepActive = false; // true only while the center freq is transitioning
        this.sweepSamplesLeft = 0;
        this.sweepSamplesTotal = 1;
        this.sweepStartHz = 500;
        this.sweepEndHz = 6000;
        this.sweepFcHz = 500;
        this.sweepUpdateCtr = 0;
        this.sweepApStages = 6;
        this.sweepA = new Float32Array(this.sweepApStages);
        this.sweepAT = new Float32Array(this.sweepApStages);
        this.sweepApX1 = [];
        this.sweepApY1 = [];
        this.sweepLast = [];
        this.sweepFb = 0;
        this.sweepWetSmooth = 0;
        this.sweepWetCoef = 0.0025;
        this.sweepCooldownPackets = 14;

        // Loss-driven "connection noise" + moving filter (tracks bloops).
        this.pinkB0 = 0;
        this.pinkB1 = 0;
        this.pinkB2 = 0;
        this.noiseHpLP = 0;
        this.noiseLP = 0;
        // 4-pole ladder-ish lowpass on the main signal (Moog-like tilt + small resonance)
        this.dryMoog1 = [];
        this.dryMoog2 = [];
        this.dryMoog3 = [];
        this.dryMoog4 = [];

        // Separate ladder filter state for concealment "gap fill" (so it doesn't fight the dry filter).
        this.fillMoog1 = [];
        this.fillMoog2 = [];
        this.fillMoog3 = [];
        this.fillMoog4 = [];
        this.bloopToneLP = 0;
        this.bloopFollowHz = 1200;
        this.bloopFollowTargetHz = 1200;
        this.bloopFollowCoef = 0.01;

        this.port.onmessage = (event) => {
            const data = event?.data;
            if (!data || typeof data !== 'object') return;

            if (data.type === 'interval') {
                const raw = Number(data.intervalSamples);
                if (Number.isFinite(raw) && raw > 0) {
                    // Clamp to at least one packet to avoid pathological behavior.
                    this.intervalSamples = Math.max(this.packetSize, raw);
                }
            } else if (data.type === 'trigger') {
                // Force a single packet drop ASAP.
                this.triggerDrop = true;
            } else if (data.type === 'refresh') {
                // Report config so the main thread can latency-compensate the dry path.
                try {
                    this.port.postMessage({
                        type: 'config',
                        packetSize: this.packetSize,
                        prebufferPackets: this.prebufferPackets,
                        latencySamples: this.packetSize * this.prebufferPackets,
                        smearStages: this.smearStages
                    });
                } catch {
                    // ignore
                }
            }
        };
    }

    _ensureFocusState(channelCount) {
        if (this.focusX1.length === this.focusBandCount && this.focusX1[0]?.length === channelCount) return;
        this.focusX1 = [];
        this.focusX2 = [];
        this.focusY1 = [];
        this.focusY2 = [];
        for (let b = 0; b < this.focusBandCount; b++) {
            this.focusX1[b] = new Float32Array(channelCount);
            this.focusX2[b] = new Float32Array(channelCount);
            this.focusY1[b] = new Float32Array(channelCount);
            this.focusY2[b] = new Float32Array(channelCount);
        }
        this.focusReady = false;
    }

    _ensureSweepState(channelCount) {
        if (this.sweepApX1.length === channelCount && this.sweepApX1[0]?.length === this.sweepApStages) return;
        this.sweepApX1 = [];
        this.sweepApY1 = [];
        this.sweepLast = [];
        for (let ch = 0; ch < channelCount; ch++) {
            this.sweepApX1[ch] = new Float32Array(this.sweepApStages);
            this.sweepApY1[ch] = new Float32Array(this.sweepApStages);
            this.sweepLast[ch] = 0;
        }
    }

    _pickBloopFreqHarmonic(loss01) {
        // Use the detected pitch (fundamental) directly so tones sit within its harmonics.
        const pitch = Math.max(90, Math.min(360, this.pitchHzSmooth));

        // Prefer lower harmonics at low loss, higher harmonics at high loss.
        const harmonics = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16];
        const bias = Math.max(0, Math.min(1, loss01));
        const r = Math.pow(this._rand(), 1.8 - 1.3 * bias); // biases toward higher indices as loss rises
        const idx = Math.max(0, Math.min(harmonics.length - 1, (r * harmonics.length) | 0));
        const h = harmonics[idx] || 2;

        // Also allow 1–2 octaves up sometimes (while still often staying in the base range).
        let octaveMul = 1;
        const u = this._rand();
        if (u < (0.10 + 0.30 * loss01)) octaveMul = 2;
        if (u < (0.02 + 0.14 * loss01)) octaveMul = 4;

        let f = pitch * h * octaveMul;
        // Keep in the requested band.
        f = Math.max(500, Math.min(2800, f));
        return f;
    }

    _startBloop(loss01) {
        // Find a free voice. If none, skip (avoid stealing discontinuities).
        let v = -1;
        for (let i = 0; i < this.bloopVoices; i++) {
            if (!this.bloopActive[i]) { v = i; break; }
        }
        if (v < 0) return;

        const freq = this._pickBloopFreqHarmonic(loss01);

        // Track bloops so other loss-driven filtering can "move" with them.
        this.bloopFollowTargetHz = freq;

        // Pure sine oscillator per voice (strictly stable; cannot "run away").
        const f = Math.max(90, Math.min(0.45 * sampleRate, freq));
        this.bloopOscPhase01[v] = 0;
        this.bloopOscInc[v] = f / sampleRate;

        // Duration: short, defined bloops.
        const durMs = 10 + 33 * (0.25 + 0.75 * this._rand());
        const total = Math.max(32, Math.min((sampleRate * 0.12) | 0, (sampleRate * (durMs / 1000)) | 0));
        this.bloopSamplesTotal[v] = total;
        this.bloopSamplesLeft[v] = total;
        this.bloopPhase01[v] = 0;
        this.bloopPhaseInc[v] = 1 / total;

        // Amplitude scales with loss.
        const gate = Math.max(0, Math.min(1, (this.inEnv - 0.001) / 0.02));
        this.bloopAmp[v] = (0.10 + 0.34 * loss01) * (0.70 + 0.30 * gate);

        this.bloopActive[v] = true;
        this.bloopActiveCount++;
    }

    _maybeSpawnBloopsAtPacketBoundary() {
        const l = Math.max(0, Math.min(1, this.lossSmooth));
        if (l <= 0.0005) return;

        // Only spawn when real audio is present.
        const gate = Math.max(0, Math.min(1, (this.inEnv - 0.001) / 0.02));
        if (gate <= 0.02) return;

        // Use confidence as a *scaler* (not a hard gate), so the effect doesn't disappear.
        const conf = Math.max(0, Math.min(1, this.pitchConfidence));

        // Random density is controlled by the LOSS division interval (intervalSamples).
        // Interpret intervalSamples as mean time between "opportunities" and convert to
        // a per-packet expected count (Poisson-ish). This stays random (not rhythmic).
        const interval = (Number.isFinite(this.intervalSamples) && this.intervalSamples !== Number.POSITIVE_INFINITY)
            ? Math.max(this.packetSize, this.intervalSamples)
            : (sampleRate * 0.45); // fallback ~450ms

        const baseLambda = Math.max(0, Math.min(4, this.packetSize / interval));
        // Loss knob scales how prominent it is (more loss => more bloops), but keep overall density lower.
        const lossScale = 0.10 + 1.10 * l;
        const expected = baseLambda * lossScale * gate * (0.35 + 0.65 * conf);

        // Sample a small-count Poisson approximation.
        const n = expected | 0;
        const frac = expected - n;
        const extra = (this._rand() < frac) ? 1 : 0;
        const count = Math.min(2, n + extra);
        for (let i = 0; i < count; i++) {
            this._startBloop(l);
        }
    }

    _renderBloopsSample(excitation, gate01) {
        if (this.bloopActiveCount <= 0) return 0;

        // If audio isn't present, stop quickly.
        if (gate01 <= 0.0001) {
            for (let v = 0; v < this.bloopVoices; v++) this.bloopActive[v] = false;
            this.bloopActiveCount = 0;
            return 0;
        }

        let sum = 0;
        for (let v = 0; v < this.bloopVoices; v++) {
            if (!this.bloopActive[v]) continue;

            // Smooth window to avoid clicks.
            const p = this.bloopPhase01[v];
            const w = Math.sin(Math.PI * Math.max(0, Math.min(1, p)));
            // Percussive envelope (quick attack, faster decay) to sound like "bloops",
            // but keep it loud enough to hear.
            const ww = w * w;
            const tail = 1 - Math.max(0, Math.min(1, p));
            const env = ww * (0.45 + 0.55 * tail) * gate01;

            // Pure tone; add only a *tiny* amplitude response to the input so it's not dead static.
            const ampMod = 0.90 + 0.10 * Math.min(1, Math.abs(excitation) * 6);
            let ph = this.bloopOscPhase01[v];
            const y0 = Math.sin(2 * Math.PI * ph);
            ph += this.bloopOscInc[v];
            if (ph >= 1) ph -= 1;
            this.bloopOscPhase01[v] = ph;

            sum += y0 * env * this.bloopAmp[v] * ampMod;

            // Advance voice.
            this.bloopPhase01[v] = p + this.bloopPhaseInc[v];
            const left = (this.bloopSamplesLeft[v] | 0) - 1;
            this.bloopSamplesLeft[v] = left;
            if (left <= 0) {
                this.bloopActive[v] = false;
                this.bloopActiveCount--;
            }
        }
        // Smooth normalization so voice start/stop doesn't create crackly gain steps.
        const n = Math.max(1, this.bloopActiveCount | 0);
        const targetNorm = 1 / Math.sqrt(n);
        this.bloopNormSmooth += (targetNorm - this.bloopNormSmooth) * this.bloopNormCoef;
        const y = sum * this.bloopNormSmooth;
        // Very gentle soft clip as a final guardrail.
        const a = Math.abs(y);
        return y / (1 + 0.25 * a);
    }

    _maybeSpawnArtifactSweepAtPacketBoundary() {
        if (this.sweepActive) return;
        if ((this.sweepCooldownPackets | 0) > 0) {
            this.sweepCooldownPackets--;
            return;
        }

        const a = Math.max(0, Math.min(1, this.artifactSmooth));
        if (a <= 0.10) return;

        // Only when real audio is present.
        const gate = Math.max(0, Math.min(1, (this.inEnv - 0.001) / 0.02));
        if (gate <= 0.02) return;

        // Random (unquantized) density is controlled by the LOSS division interval (intervalSamples).
        // Interpret intervalSamples as the mean time between sweep opportunities.
        const interval = (Number.isFinite(this.intervalSamples) && this.intervalSamples !== Number.POSITIVE_INFINITY)
            ? Math.max(this.packetSize, this.intervalSamples)
            : (sampleRate * 0.45);
        const baseLambda = Math.max(0, Math.min(4, this.packetSize / interval));

        // More artifacts => more sweeps; gate keeps it silent when input is absent.
        // Keep overall density low so 1/64 isn't spammy.
        const expected = Math.min(0.13, baseLambda * (0.03 + 0.35 * a) * gate);
        if (this._rand() >= expected) return;

        // Start a center-frequency transition. Hold at the end until the next trigger.
        this.sweepActive = true;
        // Faster transition (was too slow); still smooth.
        const dur = 0.06 + 0.16 * (0.25 + 0.75 * this._rand());
        const total = Math.max(64, Math.min((sampleRate * 0.26) | 0, (sampleRate * dur) | 0));
        this.sweepSamplesTotal = total;
        this.sweepSamplesLeft = total;

        // Toggle between low and high; this makes it HOLD at 6k and then the next sweep brings it down.
        this.sweepStartHz = this.sweepFcHz;
        this.sweepEndHz = (this.sweepFcHz > 2500) ? 1000 : 6000;

        // Refractory period so sweeps don't cluster.
        this.sweepCooldownPackets = 44;

        // Make the woosh clearly audible at higher artifacts.
        // Keep feedback moderate so the phaser blends instead of taking over.
        this.sweepFb = Math.max(0, Math.min(0.55, 0.10 + 0.38 * a));
        this.sweepUpdateCtr = 0;
        // Leave filter state intact for continuity (more cohesive, less "pops").
    }

    _applyArtifactPhaser(sample, ch, gate01) {
        const a01 = Math.max(0, Math.min(1, this.artifactSmooth));
        if (a01 <= 0.10 || gate01 <= 0.0001) return sample;

        // Wetness is continuous (no fade-out). Sweeps only move the center frequency.
        const wetTarget = (0.06 + 0.45 * a01) * gate01;
        this.sweepWetSmooth += (wetTarget - this.sweepWetSmooth) * (this.sweepWetCoef * 0.55);
        const wet = Math.max(0, Math.min(0.62, this.sweepWetSmooth));
        if (wet <= 0.0001) return sample;

        // If a sweep is in progress, update held center frequency smoothly.
        if (this.sweepActive) {
            const left = this.sweepSamplesLeft | 0;
            const total = Math.max(1, this.sweepSamplesTotal | 0);
            const t = 1 - (left / total);
            // Exponential interpolation between start/end (more natural).
            const start = Math.max(500, Math.min(6000, this.sweepStartHz));
            const end = Math.max(500, Math.min(6000, this.sweepEndHz));
            const ratio = end / Math.max(1e-6, start);
            this.sweepFcHz = start * Math.pow(ratio, Math.max(0, Math.min(1, t)));

            this.sweepSamplesLeft = left - 1;
            if ((this.sweepSamplesLeft | 0) <= 0) {
                this.sweepActive = false;
                this.sweepFcHz = end; // HOLD here until next sweep.
            }
        }

        const fcClamped = Math.max(500, Math.min(6000, this.sweepFcHz));

        // Update target allpass coefficients at a reduced rate to save CPU.
        if ((this.sweepUpdateCtr++ & 7) === 0) {
            const fs = sampleRate;
            const center = fcClamped;
            const mid = (this.sweepApStages - 1) * 0.5;
            for (let sIdx = 0; sIdx < this.sweepApStages; sIdx++) {
                const spread = 0.20;
                const ratio = 1 + spread * ((sIdx - mid) / Math.max(1, mid));
                const fStage = Math.max(250, Math.min(8000, center * ratio));
                const tan = Math.tan(Math.PI * (fStage / fs));
                const a = (1 - tan) / (1 + tan);
                this.sweepAT[sIdx] = Math.max(-0.999, Math.min(0.999, a));
            }
        }

        // Smooth coefficients to avoid zipper noise.
        const k = 0.09;
        for (let sIdx = 0; sIdx < this.sweepApStages; sIdx++) {
            this.sweepA[sIdx] += (this.sweepAT[sIdx] - this.sweepA[sIdx]) * k;
        }

        // Classic phaser topology: allpass cascade + feedback.
        const last = (this.sweepLast[ch] || 0);
        let x = sample + last * this.sweepFb;
        const x1Arr = this.sweepApX1[ch];
        const y1Arr = this.sweepApY1[ch];
        for (let sIdx = 0; sIdx < this.sweepApStages; sIdx++) {
            const a = this.sweepA[sIdx];
            const x1 = x1Arr[sIdx];
            const y1 = y1Arr[sIdx];
            const y = (-a * x) + x1 + (a * y1);
            x1Arr[sIdx] = x;
            y1Arr[sIdx] = y;
            x = y;
        }
        this.sweepLast[ch] = x;

        // Mix as a real processed signal (more cohesive than (allpass-dry) alone).
        const phased = sample * (1 - wet) + x * wet;
        return phased;
    }

    _computeBandpassCoeffs(fcHz, q, bandIndex) {
        const fs = sampleRate;
        const fc = Math.max(90, Math.min(0.45 * fs, fcHz));
        const Q = Math.max(0.35, Math.min(18, q));

        // RBJ biquad bandpass (constant 0 dB peak gain)
        const w0 = 2 * Math.PI * (fc / fs);
        const cosw0 = Math.cos(w0);
        const sinw0 = Math.sin(w0);
        const alpha = sinw0 / (2 * Q);

        let b0 = sinw0 * 0.5;
        let b1 = 0;
        let b2 = -sinw0 * 0.5;
        let a0 = 1 + alpha;
        let a1 = -2 * cosw0;
        let a2 = 1 - alpha;

        // normalize so a0 = 1
        b0 /= a0;
        b1 /= a0;
        b2 /= a0;
        a1 /= a0;
        a2 /= a0;

        this.focusB0[bandIndex] = b0;
        this.focusB1[bandIndex] = b1;
        this.focusB2[bandIndex] = b2;
        this.focusA1[bandIndex] = a1;
        this.focusA2[bandIndex] = a2;
    }

    _updateFocusTargets() {
        const t = Math.max(0, Math.min(1, this.artifactSmooth));

        // "Middleground" pitch target: geometric mean between the detected pitch and a mid anchor.
        // This avoids living down at 80–200 Hz (the "woosh" range) while still following the voice.
        const pitch = Math.max(80, Math.min(360, this.pitchHzSmooth));
        const anchor = 950;
        let targetFc = Math.sqrt(pitch * anchor);
        targetFc = Math.max(300, Math.min(2600, targetFc));

        // If pitch confidence is low, hold the current target.
        if (this.pitchConfidence < 0.10) {
            targetFc = this.focusMidFc;
        }

        // Glide speed: higher artifacts = faster lock.
        const glide = 0.03 + 0.16 * t;
        if (!Number.isFinite(this.focusMidFc) || this.focusMidFc <= 0) this.focusMidFc = Number.isFinite(targetFc) ? targetFc : 700;
        this.focusMidFc += (targetFc - this.focusMidFc) * glide;

        if (!Number.isFinite(this.focusMidFc) || this.focusMidFc <= 0) {
            this.focusMidFc = 700;
        }

        // Three related bands around the mid target.
        const midFc = this.focusMidFc;
        const lowFc = Math.max(160, Math.min(1400, midFc * 0.55));
        const highFc = Math.max(700, Math.min(5200, midFc * 2.0));
        this.focusLowFc = lowFc;
        this.focusHighFc = highFc;

        // Q choices: keep mid most "focused", low/high a bit broader.
        const midQ = 0.9 + 5.0 * t;
        const sideQ = 0.7 + 2.4 * t;

        this._computeBandpassCoeffs(lowFc, sideQ, 0);
        this._computeBandpassCoeffs(midFc, midQ, 1);
        this._computeBandpassCoeffs(highFc, sideQ, 2);

        // Guard against NaN coeffs taking the whole graph down.
        for (let b = 0; b < this.focusBandCount; b++) {
            if (!Number.isFinite(this.focusB0[b]) || !Number.isFinite(this.focusA2[b])) {
                this.focusReady = false;
                return;
            }
        }
        this.focusReady = true;
    }



    _applyFocusBands(sample, ch) {
        if (!this.focusReady) return 0;

        // 3 biquads in parallel (low/mid/high). Coeffs are fixed for the packet.
        let sum = 0;
        for (let b = 0; b < this.focusBandCount; b++) {
            const b0 = this.focusB0[b];
            const b1 = this.focusB1[b];
            const b2 = this.focusB2[b];
            const a1 = this.focusA1[b];
            const a2 = this.focusA2[b];

            const x0 = sample;
            const y0 = (b0 * x0) + (b1 * this.focusX1[b][ch]) + (b2 * this.focusX2[b][ch]) - (a1 * this.focusY1[b][ch]) - (a2 * this.focusY2[b][ch]);

            this.focusX2[b][ch] = this.focusX1[b][ch];
            this.focusX1[b][ch] = x0;
            this.focusY2[b][ch] = this.focusY1[b][ch];
            this.focusY1[b][ch] = y0;

            // Weight mid band a bit more than side bands.
            sum += (b === 1) ? (y0 * 0.9) : (y0 * 0.55);
        }
        return sum;
    }

    _estimatePitchHzFast() {
        const ds = this.pitchDecim;
        const n = this.pitchAnalysisLen;
        const ring = this.pitchRing;
        const mask = this.pitchRingLen - 1;
        let read = this.pitchRingWrite;

        // Copy latest decimated samples into temp buffer (no allocations).
        // Newest sample ends at temp[n-1].
        let mean = 0;
        for (let i = 0; i < n; i++) {
            read = (read - ds) & mask;
            const v = ring[read];
            this.pitchTemp[n - 1 - i] = v;
            mean += v;
        }
        mean /= n;

        // Remove DC + energy
        let energy = 0;
        for (let i = 0; i < n; i++) {
            const v = this.pitchTemp[i] - mean;
            this.pitchTemp[i] = v;
            energy += v * v;
        }
        if (energy < 1e-5) return null;

        const fs = sampleRate / ds;
        const minHz = 90;
        const maxHz = 320;
        const minLag = Math.floor(fs / maxHz);
        const maxLag = Math.floor(fs / minHz);
        if (maxLag >= n - 4) return null;

        let bestLag = -1;
        let bestCorr = -1;
        // Speed-ups: step lags by 2 and stride inner loop.
        for (let lag = minLag; lag <= maxLag; lag += 2) {
            let corr = 0;
            for (let i = 0; i < n - lag; i += 3) {
                corr += this.pitchTemp[i] * this.pitchTemp[i + lag];
            }
            if (corr > bestCorr) {
                bestCorr = corr;
                bestLag = lag;
            }
        }
        if (bestLag <= 0) return null;

        const conf = bestCorr / energy;
        this.pitchConfidence = Math.max(0, Math.min(1, conf));
        if (conf < 0.10) return null;

        const hz = fs / bestLag;
        return Math.max(minHz, Math.min(maxHz, hz));
    }

    _ensureSmearState(channelCount) {
        if (this.smearX1.length === channelCount && this.smearY1.length === channelCount) return;
        this.smearX1 = [];
        this.smearY1 = [];
        for (let ch = 0; ch < channelCount; ch++) {
            this.smearX1[ch] = new Float32Array(this.smearStages);
            this.smearY1[ch] = new Float32Array(this.smearStages);
        }
    }

    _updateSmearTargets() {
        // Move start->end, then pick new end coeffs.
        for (let s = 0; s < this.smearStages; s++) {
            this.smearAStart[s] = this.smearAEnd[s];
        }

        // Artifact controls smear depth.
        const t = Math.max(0, Math.min(1, this.artifactSmooth));
        for (let s = 0; s < this.smearStages; s++) {
            // Allpass coefficient magnitude < 1 for stability.
            // Higher => more phase smear / warble.
            const r = 0.5 + 0.5 * this._rand();
            const a = 0.12 + (0.75 * t * r);
            this.smearAEnd[s] = Math.max(0.05, Math.min(0.85, a));
        }
    }

    _applySmear(sample, ch, packetPos01) {
        let y = sample;
        for (let s = 0; s < this.smearStages; s++) {
            const a = this.smearAStart[s] + (this.smearAEnd[s] - this.smearAStart[s]) * packetPos01;
            const x1 = this.smearX1[ch][s];
            const y1 = this.smearY1[ch][s];

            // 1st-order allpass: y[n] = -a x[n] + x[n-1] + a y[n-1]
            const out = (-a * y) + x1 + (a * y1);
            this.smearX1[ch][s] = y;
            this.smearY1[ch][s] = out;
            y = out;
        }
        return y;
    }

    _rand() {
        this.prngState = (this.prngState * 1664525 + 1013904223) >>> 0;
        return this.prngState / 0xffffffff;
    }

    _ensureBuildBuffers(channelCount) {
        if (this.buildBuffers.length === channelCount && this.buildBuffers[0]?.length === this.packetSize) {
            return;
        }
        this.buildBuffers = [];
        for (let ch = 0; ch < channelCount; ch++) {
            this.buildBuffers[ch] = new Float32Array(this.packetSize);
        }
        this.buildIndex = 0;
    }

    _enqueuePacket(packet) {
        this.packetBuffer.push(packet);
        if (this.packetBuffer.length > this.maxBufferPackets) {
            this.packetBuffer.shift();
        }
    }

    _finalizePacket(channelCount) {
        const packet = [];
        for (let ch = 0; ch < channelCount; ch++) {
            const copy = new Float32Array(this.packetSize);
            copy.set(this.buildBuffers[ch]);
            packet.push(copy);
        }
        this.buildIndex = 0;
        return packet;
    }

    _pushHistoryPacket(packet) {
        if (!packet) return;
        this.historyPackets.push(packet);
        if (this.historyPackets.length > this.maxHistoryPackets) {
            this.historyPackets.shift();
        }
    }

    _pickBorrowPacket(strength01) {
        const n = this.historyPackets.length;
        if (n === 0) return null;
        if (n === 1) return this.historyPackets[0];

        // Choose from a "nearby" window of recent packets.
        // strength01=0 -> mostly the most recent; strength01=1 -> random from last ~n.
        const maxBack = Math.max(1, Math.min(n, 2 + Math.floor(strength01 * (n - 1))));
        const back = Math.floor(this._rand() * maxBack); // 0..maxBack-1
        const idx = n - 1 - back;
        return this.historyPackets[idx] || this.historyPackets[n - 1];
    }

    _nextPacket(channelCount) {
        if (this.packetBuffer.length) {
            return this.packetBuffer.shift();
        }
        const silent = [];
        for (let ch = 0; ch < channelCount; ch++) {
            silent.push(new Float32Array(this.packetSize));
        }
        return silent;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];
        if (!input || !output) return true;

        const channelCount = Math.min(input.length || 0, output.length || 0);
        if (channelCount === 0) return true;

        const frames = input[0]?.length || 0;
        if (!frames) return true;

        const lossValues = parameters.lossAmount || [0];
        const artifactValues = parameters.artifactAmount || [0];
        const lossAutomated = lossValues.length > 1;
        const artifactAutomated = artifactValues.length > 1;

        if (this.lastOut.length < channelCount) {
            const expanded = new Array(channelCount).fill(0);
            for (let i = 0; i < this.lastOut.length; i++) expanded[i] = this.lastOut[i];
            this.lastOut = expanded;
        }

        if (this.silenceRampFrom.length < channelCount) {
            const expanded = new Array(channelCount).fill(0);
            for (let i = 0; i < this.silenceRampFrom.length; i++) expanded[i] = this.silenceRampFrom[i];
            this.silenceRampFrom = expanded;
        }

        if (this.env.length < channelCount) {
            const expanded = new Array(channelCount).fill(0);
            for (let i = 0; i < this.env.length; i++) expanded[i] = this.env[i];
            this.env = expanded;
        }

        if (this.cngLP.length < channelCount) {
            const expanded = new Array(channelCount).fill(0);
            for (let i = 0; i < this.cngLP.length; i++) expanded[i] = this.cngLP[i];
            this.cngLP = expanded;
        }

        if (this.repeatLP.length < channelCount) {
            const expanded = new Array(channelCount).fill(0);
            for (let i = 0; i < this.repeatLP.length; i++) expanded[i] = this.repeatLP[i];
            this.repeatLP = expanded;
        }

        if (this.dryMoog1.length < channelCount) {
            const expand = (arr) => {
                const expanded = new Array(channelCount).fill(0);
                for (let i = 0; i < arr.length; i++) expanded[i] = arr[i];
                return expanded;
            };
            this.dryMoog1 = expand(this.dryMoog1);
            this.dryMoog2 = expand(this.dryMoog2);
            this.dryMoog3 = expand(this.dryMoog3);
            this.dryMoog4 = expand(this.dryMoog4);
        }

        if (this.fillMoog1.length < channelCount) {
            const expand = (arr) => {
                const expanded = new Array(channelCount).fill(0);
                for (let i = 0; i < arr.length; i++) expanded[i] = arr[i];
                return expanded;
            };
            this.fillMoog1 = expand(this.fillMoog1);
            this.fillMoog2 = expand(this.fillMoog2);
            this.fillMoog3 = expand(this.fillMoog3);
            this.fillMoog4 = expand(this.fillMoog4);
        }

        this._ensureBuildBuffers(channelCount);
        this._ensureSmearState(channelCount);
        this._ensureFocusState(channelCount);
        this._ensureSweepState(channelCount);

        const fadeLen = Math.max(1, Math.min(this.fadeSamples, this.packetSize));
        for (let i = 0; i < frames; i++) {
            const lossTarget = lossAutomated ? (lossValues[i] ?? lossValues[0] ?? 0) : (lossValues[0] ?? 0);
            const artifactTarget = artifactAutomated ? (artifactValues[i] ?? artifactValues[0] ?? 0) : (artifactValues[0] ?? 0);
            this.lossSmooth += (lossTarget - this.lossSmooth) * this.lossSmoothCoef;
            this.artifactSmooth += (artifactTarget - this.artifactSmooth) * this.artifactSmoothCoef;

            // Build packets from incoming audio
            // Also feed pitch ring buffer with mono mix of the input.
            let monoIn = 0;
            for (let ch = 0; ch < channelCount; ch++) {
                this.buildBuffers[ch][this.buildIndex] = input[ch][i] || 0;
                monoIn += input[ch][i] || 0;
            }
            monoIn /= channelCount;
            this.pitchRing[this.pitchRingWrite] = monoIn;
            this.pitchRingWrite = (this.pitchRingWrite + 1) & (this.pitchRingLen - 1);

            // Input envelope for gating loss-driven artifacts.
            const absIn = Math.abs(monoIn);
            this.inEnv += (absIn - this.inEnv) * this.inEnvCoef;
            this.buildIndex++;

            if (this.buildIndex >= this.packetSize) {
                const packet = this._finalizePacket(channelCount);

                this.packetCounter++;
                // Pitch tracking is gated by effect usage (loss/artifacts) to save CPU.
                const pitchNeeded = (this.artifactSmooth > 0.10) || (this.lossSmooth > 0.08);
                if (pitchNeeded && (this.packetCounter % this.pitchUpdateEveryPackets) === 0) {
                    const hz = this._estimatePitchHzFast();
                    if (hz) this.pitchHz = hz;
                }
                this.pitchHzSmooth += (this.pitchHz - this.pitchHzSmooth) * this.pitchSmoothCoef;

                // Time-preserving loss: random drops with an average interval set by LOSS division.
                let dropped = false;
                if (this.triggerDrop) {
                    dropped = true;
                    this.triggerDrop = false;
                } else if (Number.isFinite(this.intervalSamples) && this.intervalSamples !== Number.POSITIVE_INFINITY) {
                    // Interpret intervalSamples as the mean time between losses.
                    // Use a Poisson-process approximation: P(drop per packet) = 1 - exp(-packetSize/intervalSamples)
                    const ratio = Math.max(0, Math.min(50, this.packetSize / Math.max(this.packetSize, this.intervalSamples)));
                    const p = 1 - Math.exp(-ratio);
                    dropped = (this._rand() < p);
                }

                // IMPORTANT: preserve time. If a packet is lost, enqueue a placeholder (null)
                // rather than skipping, otherwise playback will time-compress and click.
                this._enqueuePacket(dropped ? null : packet);
            }

            // If we're silent (startup or after loss), only start once we have a small buffer.
            if (this.outputtingSilence) {
                if (!this.currPacket && this.packetBuffer.length >= this.prebufferPackets) {
                    this.currPacket = this.packetBuffer.shift();
                    this.nextPacket = this.packetBuffer.shift() ?? null;
                    this.currIndex = 0;
                    this.fadeInActive = (this.currPacket !== null);
                    this.needsFadeInNextPacket = false;
                    this.outputtingSilence = false;
                    this.silenceRampPos = fadeLen;

                    this._updateSmearTargets();
                    this._updateFocusTargets();
                    this._maybeSpawnBloopsAtPacketBoundary();

                    if (this.currPacket === null) {
                        this.lostStreakFrames = 1;
                    } else {
                        this.lostStreakFrames = 0;
                        this.lastGoodPacket = this.currPacket;
                    }
                }
            }

            // Advance packet boundary (or enter silence if we ran out)
            if (!this.outputtingSilence && this.currPacket && this.currIndex >= this.packetSize) {
                // (This branch no longer used: currPacket may be null for "lost" frames.)
            }

            // End of packet: advance to the next scheduled frame (which may be lost/null).
            if (!this.outputtingSilence && this.currIndex >= this.packetSize) {
                const prevWasLost = (this.currPacket === null);
                this.currPacket = this.nextPacket;
                this.nextPacket = this.packetBuffer.shift() ?? null;
                this.currIndex = 0;
                this.fadeOutToCngActive = false;
                // If we are recovering from a lost frame into a good frame, fade in from CNG.
                this.fadeInActive = (prevWasLost && this.currPacket !== null);
                this.needsFadeInNextPacket = false;

                // Latch conceal mix strength at frame boundaries if we're in/around concealment.
                if (prevWasLost || this.currPacket === null || this.fadeInActive) {
                    this.repeatStrengthForConceal = this.repeatStrengthSmooth;
                }

                if (this.currPacket === null) {
                    this.lostStreakFrames++;
                    // Pick a nearby packet once per lost frame (stable across the frame).
                    this.borrowedPacket = this._pickBorrowPacket(this.repeatStrengthSmooth);
                } else {
                    this.lostStreakFrames = 0;
                    this.lastGoodPacket = this.currPacket;
                    this._pushHistoryPacket(this.currPacket);
                    this.borrowedPacket = null;
                }

                // New packet => new smear target coefficients.
                this._updateSmearTargets();
                this._updateFocusTargets();

                // Loss-driven alien console blips.
                this._maybeSpawnBloopsAtPacketBoundary();

                // Artifact-driven phasey sweeps.
                this._maybeSpawnArtifactSweepAtPacketBoundary();
            }

            // Decide once, at the start of the tail, whether the *next frame* is lost.
            // This preserves time and avoids discontinuities.
            if (!this.outputtingSilence && this.currIndex === (this.packetSize - fadeLen)) {
                this.fadeOutToCngActive = (this.currPacket !== null && this.nextPacket === null);
                if (this.fadeOutToCngActive) {
                    // Latch conceal strength for the upcoming transition.
                    this.repeatStrengthForConceal = this.repeatStrengthSmooth;
                }
            }

            const tailStart = this.packetSize - fadeLen;

            const currIsLost = (this.currPacket === null);

            const fadeOutActive = (!this.outputtingSilence && !currIsLost && this.fadeOutToCngActive && this.currIndex >= tailStart);
            const fadeInActiveNow = (!this.outputtingSilence && !currIsLost && this.fadeInActive && this.currIndex < fadeLen);

            const repeatTarget = Math.max(0, Math.min(1, this.artifactSmooth));
            this.repeatStrengthSmooth += (repeatTarget - this.repeatStrengthSmooth) * this.repeatStrengthCoef;
            const inConcealment = currIsLost || fadeOutActive || fadeInActiveNow;
            const repeatStrength = inConcealment ? this.repeatStrengthForConceal : this.repeatStrengthSmooth;

            // Allow gap-fill on all lost frames. We pick a nearby packet per lost frame,
            // and we filter + window + decay it, which avoids the old 100 Hz buzz issue.
            const allowRepeatThisFrame = true;
            const repeatGain = (currIsLost && allowRepeatThisFrame)
                ? Math.pow(this.repeatFrameDecay, Math.max(0, this.lostStreakFrames - 1))
                : 0;
            const fadeOutW = fadeOutActive
                ? (0.5 - 0.5 * Math.cos(Math.PI * ((this.currIndex - tailStart) / (fadeLen - 1))))
                : 0;
            const fadeInW = fadeInActiveNow
                ? (0.5 - 0.5 * Math.cos(Math.PI * (this.currIndex / (fadeLen - 1))))
                : 0;

            // Prepare bloop render once per sample (mono), then add to all channels.
            // Gate based on input envelope so alien sounds only happen when audio is present.
            const loss01 = Math.max(0, Math.min(1, this.lossSmooth));
            // Curve + cap so >~70% loss doesn't get overly loud or crackly.
            const lCurve = Math.pow(loss01, 0.65);
            const bloopMixTarget = Math.max(0, Math.min(0.88, 0.06 + 0.82 * lCurve));
            this.bloopMixSmooth += (bloopMixTarget - this.bloopMixSmooth) * this.bloopMixCoef;
            const gate01 = Math.max(0, Math.min(1, (this.inEnv - 0.001) / 0.02));
            const bloopsMonoRaw = this._renderBloopsSample(monoIn, gate01);

            // Follow current bloop pitch so the loss-driven filtering "moves" with it.
            this.bloopFollowHz += (this.bloopFollowTargetHz - this.bloopFollowHz) * this.bloopFollowCoef;
            const followHz = Math.max(500, Math.min(4000, this.bloopFollowHz));
            const moveHz = Math.max(700, Math.min(5200, followHz * 1.15));
            const l2 = Math.pow(loss01, 1.35);

            // Gentle lowpass on bloops: makes higher notes quieter than lower.
            const bloopLPHz = Math.max(900, Math.min(2200, 1200 + 700 * (1 - l2)));
            const bloopLPCoef = bloopLPHz / (bloopLPHz + sampleRate);
            this.bloopToneLP += (bloopsMonoRaw - this.bloopToneLP) * bloopLPCoef;
            const bloopsMono = this.bloopToneLP;

            // Loss-driven pink noise, filtered so it "moves" with the bloops.
            // Keep it gated to input so we don't add noise on silence.
            let noiseMono = 0;
            if (gate01 > 0.001) {
                const w = (this._rand() * 2 - 1);
                // Lightweight pink-ish noise (Kellet-style IIR).
                this.pinkB0 = 0.99765 * this.pinkB0 + 0.0990460 * w;
                this.pinkB1 = 0.96300 * this.pinkB1 + 0.2965164 * w;
                this.pinkB2 = 0.57000 * this.pinkB2 + 1.0526913 * w;
                let pink = (this.pinkB0 + this.pinkB1 + this.pinkB2 + 0.1848 * w) * 0.05;

                // Highpass (remove rumble) then moving lowpass (track bloops).
                const hpHz = 140;
                const hpCoef = hpHz / (hpHz + sampleRate);
                this.noiseHpLP += (pink - this.noiseHpLP) * hpCoef;
                const hp = pink - this.noiseHpLP;

                const noiseLPHz = Math.max(450, Math.min(7000, moveHz * 0.85));
                const noiseLPCoef = noiseLPHz / (noiseLPHz + sampleRate);
                this.noiseLP += (hp - this.noiseLP) * noiseLPCoef;

                const noiseMix = (0.002 + 0.030 * l2) * gate01;
                noiseMono = this.noiseLP * noiseMix;
            }

            for (let ch = 0; ch < channelCount; ch++) {
                // Generate comfort noise for this channel (band-limited-ish via one-pole LP)
                // Noise amplitude follows a simple envelope of recent output.
                const white = (this._rand() * 2 - 1);
                const lp = this.cngLP[ch] + (white - this.cngLP[ch]) * this.cngLPCoef;
                this.cngLP[ch] = lp;
                const noiseAmp = (this.env[ch] || 0) * this.cngMix;
                const cng = lp * noiseAmp;

                // Gap-fill sample: nearby dry audio, smoothed + windowed + filtered.
                let fillSample = 0;
                if (currIsLost && allowRepeatThisFrame && (this.borrowedPacket || this.lastGoodPacket)) {
                    const packet = this.borrowedPacket || this.lastGoodPacket;
                    const src = packet[ch];
                    const raw = (src?.[this.currIndex]) || 0;
                    const smooth = this.repeatLP[ch] + (raw - this.repeatLP[ch]) * this.repeatLPCoef;
                    this.repeatLP[ch] = smooth;

                    // Hann over the whole lost frame (duck in/out within the gap).
                    const denom = Math.max(1, this.packetSize - 1);
                    const phase = (2 * Math.PI * (this.currIndex / denom));
                    const fillEnv = 0.5 - 0.5 * Math.cos(phase);

                    // Filter cutoff follows bloops in the 500–2800 band.
                    // Keep it smooth and non-clicky with a stable ladder state.
                    const targetHz = Math.max(500, Math.min(2800, moveHz));
                    const cutoffHz = Math.max(250, Math.min(8000, targetHz));
                    const g = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
                    const res = Math.max(0, Math.min(0.35, 0.08 + 0.22 * repeatStrength));

                    let y1 = this.fillMoog1[ch] || 0;
                    let y2 = this.fillMoog2[ch] || 0;
                    let y3 = this.fillMoog3[ch] || 0;
                    let y4 = this.fillMoog4[ch] || 0;

                    let x = smooth - res * y4;
                    const ax = Math.abs(x);
                    x = x / (1 + 0.8 * ax);

                    y1 += (x - y1) * g;
                    y2 += (y1 - y2) * g;
                    y3 += (y2 - y3) * g;
                    y4 += (y3 - y4) * g;

                    this.fillMoog1[ch] = y1;
                    this.fillMoog2[ch] = y2;
                    this.fillMoog3[ch] = y3;
                    this.fillMoog4[ch] = y4;

                    fillSample = y4 * repeatGain * fillEnv;
                }

                // Concealment during loss: CNG bed + artifact-controlled filtered fill.
                const conceal = cng * (1 - repeatStrength) + fillSample * repeatStrength;

                let outSample = 0;

                if (!this.outputtingSilence) {
                    if (currIsLost) {
                        // Lost frame: output concealment for the whole frame (time preserved).
                        outSample = conceal;
                    } else {
                        const currBuf = this.currPacket[ch];
                        const curr = currBuf[this.currIndex] || 0;
                        outSample = curr;

                        // If the next frame is lost, fade current audio into CNG at the tail.
                        if (fadeOutActive) {
                            outSample = curr * (1 - fadeOutW) + conceal * fadeOutW;
                        }

                        // If we recovered from a lost frame, fade from CNG into audio at the head.
                        if (fadeInActiveNow) {
                            outSample = outSample * fadeInW + conceal * (1 - fadeInW);
                        }
                    }
                } else {
                    // Startup fallback: ramp to CNG.
                    if (this.silenceRampPos < fadeLen) {
                        const t = this.silenceRampPos;
                        const alpha = fadeLen <= 1 ? 1 : (t / (fadeLen - 1));
                        const w = 0.5 - 0.5 * Math.cos(Math.PI * alpha); // 0..1
                        outSample = (this.silenceRampFrom[ch] || 0) * (1 - w) + cng * w;
                    } else {
                        outSample = cng;
                    }
                }

                // Spectral smear (warble): wet/dry mix controlled by artifact.
                // Apply to the final signal so concealment is also smeared.
                if (!this.outputtingSilence) {
                    const pos01 = this.packetSize <= 1 ? 0 : (this.currIndex / (this.packetSize - 1));

                    // Keep smear subtle; the main "spectral glide" character comes from the focus bands.
                    const smearMix = Math.max(0, Math.min(0.30, this.artifactSmooth * 0.18));
                    if (smearMix > 0.0001) {
                        const smeared = this._applySmear(outSample, ch, pos01);
                        outSample = outSample * (1 - smearMix) + smeared * smearMix;
                    }

                    // Pitch-tracking spectral glide: add low/mid/high bandpassed components alongside dry.
                    const focusMix = Math.max(0, Math.min(1, this.artifactSmooth));
                    if (focusMix > 0.0001) {
                        const focus = this._applyFocusBands(outSample, ch);
                        // Add focus in parallel (less "all-band removal" than a hard bandpass).
                        const add = 0.55 * focusMix;
                        outSample = (outSample + focus * add) / (1 + add);
                    }

                    // Loss-driven moving 24 dB lowpass on the main signal (ladder-ish, Moog-like).
                    // IMPORTANT: apply in-series (not a dry/wet blend) to avoid phase-cancel "signal loss".
                    const lEff = l2 * gate01;
                    const targetHz = Math.max(500, Math.min(2800, moveHz));
                    const cutoffHz = Math.max(140, Math.min(18000, (1 - lEff) * 18000 + lEff * targetHz));
                    const g = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);

                    // Slight resonance that becomes more noticeable with loss.
                    const res = Math.max(0, Math.min(0.55, 0.10 + 0.35 * lEff));
                    const drive = 1 + 1.2 * lEff;

                    let y1 = this.dryMoog1[ch] || 0;
                    let y2 = this.dryMoog2[ch] || 0;
                    let y3 = this.dryMoog3[ch] || 0;
                    let y4 = this.dryMoog4[ch] || 0;

                    let x = (outSample * drive) - res * y4;
                    const ax = Math.abs(x);
                    x = x / (1 + 0.9 * ax);

                    y1 += (x - y1) * g;
                    y2 += (y1 - y2) * g;
                    y3 += (y2 - y3) * g;
                    y4 += (y3 - y4) * g;

                    this.dryMoog1[ch] = y1;
                    this.dryMoog2[ch] = y2;
                    this.dryMoog3[ch] = y3;
                    this.dryMoog4[ch] = y4;

                    // Makeup gain so higher loss feels like "filtered" not "quieter".
                    const makeup = 1 + 0.35 * lEff;
                    outSample = (y4 * makeup) / (1 + 0.25 * Math.abs(y4 * makeup));

                    // Artifact-driven phaser: apply after the loss lowpass so the held 6k setting stays audible.
                    outSample = this._applyArtifactPhaser(outSample, ch, gate01);

                    // Add filtered pink noise with loss (gated to input).
                    if (noiseMono !== 0) outSample += noiseMono;

                    // Alien console pings (loss-knob effect): add mono bloops alongside dry.
                    if (this.bloopMixSmooth > 0.0001) {
                        const add = Math.min(0.95, this.bloopMixSmooth * gate01);
                        // More normalization at high add to prevent overload/distortion.
                        outSample = (outSample + bloopsMono * add) / (1 + 0.75 * add);
                    }
                }

                // Final makeup gain (~+6 dB) with gentle soft-clip guardrail.
                outSample *= 1.9952623149688795; // 10^(6/20)
                const ao = Math.abs(outSample);
                outSample = outSample / (1 + 0.12 * ao);

                output[ch][i] = outSample;

                // Update envelope follower on actual output to match perceived level.
                const absOut = Math.abs(outSample);
                this.env[ch] += (absOut - this.env[ch]) * this.envCoef;
                if (this.outputtingSilence) {
                    // Gentle decay while silent so noise dies away.
                    this.env[ch] *= 0.9995;
                }

                // Click detector: reports big discontinuities, throttled.
                const last = this.lastOut[ch] || 0;
                const diff = Math.abs(outSample - last);
                this.lastOut[ch] = outSample;
                if (this.clickCooldown === 0 && diff > 0.35) {
                    this.port.postMessage({
                        type: 'click',
                        ch,
                        diff,
                        loss: this.lossSmooth,
                        artifact: this.artifactSmooth
                    });
                    this.clickCooldown = 2400;
                }
            }

            if (!this.outputtingSilence && this.fadeInActive && this.currPacket !== null && this.currIndex === fadeLen - 1) {
                this.fadeInActive = false;
            }

            if (this.clickCooldown > 0) this.clickCooldown--;

            if (this.outputtingSilence) {
                if (this.silenceRampPos < fadeLen) this.silenceRampPos++;
            } else {
                this.currIndex++;
            }
        }

        return true;
    }
}

registerProcessor('loss-artifacts-processor', LossArtifactsProcessor);
