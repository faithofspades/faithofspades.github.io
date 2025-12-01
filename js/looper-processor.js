const GRAIN_SIZE = 512;
const GRAIN_OVERLAP = 0.5;
const GRAIN_SPACING = Math.max(8, Math.floor(GRAIN_SIZE * (1 - GRAIN_OVERLAP)));
const PITCH_SHIFT_EPSILON = 0.0005;
const GRAIN_WINDOW = (() => {
    const win = new Float32Array(GRAIN_SIZE);
    if (GRAIN_SIZE <= 1) {
        win[0] = 1;
        return win;
    }
    for (let i = 0; i < GRAIN_SIZE; i++) {
        win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (GRAIN_SIZE - 1));
    }
    return win;
})();
const SPEED_MIN = 0.25;
const SPEED_MAX = 2.0;
const PITCH_MIN = -24;
const PITCH_MAX = 24;
const LOOP_FADE_SAMPLES = 192;
const LAYER_VOLUME_MAX = 5.0;
const JUMP_FADE_MIN_SECONDS = 0.0005; // ~22 samples @44.1k
const JUMP_FADE_MAX_SECONDS = 0.0025; // ~110 samples @44.1k
const FILTER_LP_MAX_HZ = 20000;
const FILTER_LP_MIN_RATIO = 0.00005; // ~1 Hz at 44.1k
const FILTER_HP_MIN_HZ = 20;
const STUTTER_MIN_SECONDS = 0.1;
const STUTTER_MAX_SECONDS = 1.0;

function mapNormalizedSpeedToActual(value) {
    const clamped = Math.max(0, Math.min(1, value ?? 0.5));
    if (clamped <= 0.5) {
        const t = clamped / 0.5;
        return SPEED_MIN + (1 - SPEED_MIN) * t;
    }
    const t = (clamped - 0.5) / 0.5;
    return 1 + (SPEED_MAX - 1) * t;
}

function mapNormalizedPitchToFactor(value) {
    const clamped = Math.max(0, Math.min(1, value ?? 0.5));
    const semitone = PITCH_MIN + (PITCH_MAX - PITCH_MIN) * clamped;
    return Math.pow(2, semitone / 12);
}

class LayeredLooperProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [];
    }

    constructor() {
        super();
        this.maxLayers = 8;
        this.maxLoopSeconds = 64;
        this.sampleRate = sampleRate;
        this.maxLoopSamples = Math.floor(this.maxLoopSeconds * sampleRate);
        this.layers = Array.from({ length: this.maxLayers }, () => this.createLayerState());
        this.playing = false;
        this.longestLoopSamples = 0;
        this.loopReferenceSamples = 0;
        this.loopReferenceIndex = -1;
        this.globalLoopSamples = 0;
        this.referenceCatchupSamples = 0;
        this.referenceCatchupLayerIndex = -1;
        this.referenceCatchupSuppressedLayer = -1;
        this.transportSamples = 0;
        this.recordState = {
            active: false,
            layerIndex: -1,
            writePosition: 0,
            targetSamples: 0,
            autoStop: false,
            bufferL: null,
            bufferR: null,
            alignMode: null,
            captureOffsetSamples: 0,
            samplesWritten: 0,
            captureSamples: 0,
            manualStopLocked: false,
            pendingManualStop: false,
            captureMuted: true,
            continuous: false,
            captureMode: 'manual',
            hadInputThisCycle: false,
            restartConfig: null,
            monitorLayer: false,
            autoPrintOnce: false
        };
        this.selectedLayer = 0;
        this.addMode = false;
        this.addQueue = [];
        this.transportPosition = 0;
        this.transportSamples = 0;
        this.port.onmessage = (event) => this.handleMessage(event.data);
    }

    createLayerState() {
        return {
            active: false,
            lengthSamples: 0,
            startNorm: 0,
            endNorm: 1,
            startSample: 0,
            endSample: 0,
            loopLengthSamples: 0,
            volume: 1,
            repeats: 1,
            accumulatedGain: 1,
            playhead: 0,
            startOffset: 0,
            bufferL: null,
            bufferR: null,
            mutedWhileRecording: false,
            lofiAmount: 0,
            lofiBuild: 0,
            filterMode: 0.5,
            filterStrength: 0,
            lowFilterStateL: 0,
            lowFilterStateR: 0,
            highFilterStateL: 0,
            highFilterStateR: 0,
            dropouts: 0,
            dropoutTimer: 0,
            dropoutState: 1,
            dropoutTarget: 1,
            dropoutStep: 0,
            jumpAmount: 0,
            jumpTimer: 0,
            jumpFadeStartL: 0,
            jumpFadeStartR: 0,
            jumpFadeRemaining: 0,
            jumpFadeTotal: 0,
            stutterAmount: 0,
            stutterTimer: 0,
            stutterBufferL: new Float32Array(256),
            stutterBufferR: new Float32Array(256),
            stutterPos: 0,
            stutterActive: false,
            stutterFramePending: false,
            stutterFrameL: 0,
            stutterFrameR: 0,
            speed: 1,
            pitchSemitones: 0,
            pitchFactor: 1,
            grains: [],
            grainTimer: 0,
            repeatsDecay: 1,
            dropoutRampSamples: 0,
            dropoutPhase: 0,
            takes: [],
            phaseOffset: 0,
            activePhaseOffset: 0,
            pendingPhaseOffset: null,
            lastFrameSampleL: 0,
            lastFrameSampleR: 0
        };
    }

    resetLayer(layer) {
        Object.assign(layer, this.createLayerState());
    }

    ensureLayerTakes(layer) {
        if (!layer.takes) {
            layer.takes = [];
        }
    }

    normalizeOffset(value, span) {
        if (!Number.isFinite(value) || span <= 0) {
            return 0;
        }
        let normalized = value % span;
        if (normalized < 0) {
            normalized += span;
        }
        return normalized;
    }

    updateLayerWindowMetrics(layer) {
        if (!layer) return 0;
        const total = layer.lengthSamples || 0;
        if (total <= 0) {
            layer.startSample = 0;
            layer.endSample = 0;
            layer.loopLengthSamples = 0;
            layer.phaseOffset = 0;
            layer.playhead = 0;
            return 0;
        }
        const startSample = Math.max(0, Math.min(total - 1, Math.floor(layer.startSample || 0)));
        let endSample = Math.max(startSample + 1, Math.min(total, Math.floor(layer.endSample || total)));
        const span = Math.max(1, endSample - startSample);
        layer.startSample = startSample;
        layer.endSample = endSample;
        const prevPlayhead = layer.playhead || 0;
        layer.loopLengthSamples = span;
        const anchor = Number.isFinite(layer.startOffset) ? layer.startOffset : (layer.phaseOffset || 0);
        layer.phaseOffset = this.normalizeOffset((anchor || 0) - startSample, span);
        layer.playhead = this.normalizeOffset(prevPlayhead, span);
        const layerIndex = this.layers.indexOf(layer);
        const isReferenceLayer = layerIndex !== -1 && layerIndex === this.loopReferenceIndex;
        if (!Number.isFinite(layer.activePhaseOffset)) {
            layer.activePhaseOffset = layer.phaseOffset;
        }
        if (!isReferenceLayer || this.referenceCatchupLayerIndex !== layerIndex || this.referenceCatchupSamples <= 0) {
            layer.activePhaseOffset = layer.phaseOffset;
            layer.pendingPhaseOffset = null;
        } else if (!Number.isFinite(layer.pendingPhaseOffset)) {
            layer.pendingPhaseOffset = layer.phaseOffset;
        }
        if (isReferenceLayer && span > 0) {
            this.globalLoopSamples = Math.max(this.globalLoopSamples, span);
        }
        if (layerIndex !== -1 && layerIndex === this.loopReferenceIndex) {
            console.log('[Looper] window metrics', {
                layerIndex,
                startSample,
                endSample,
                span,
                anchor,
                phaseOffset: layer.phaseOffset,
                transport: this.transportSamples
            });
        }
        return span;
    }

    getLayerLoopLength(layer) {
        if (!layer || !layer.active) {
            return 0;
        }
        if (layer.loopLengthSamples && layer.loopLengthSamples > 0) {
            return layer.loopLengthSamples;
        }
        if (layer.lengthSamples && layer.lengthSamples > 0) {
            return Math.max(1, layer.lengthSamples);
        }
        return 0;
    }

    shiftLayerOffsets(referenceIndex, deltaSamples) {
        if (!deltaSamples) return;
        for (let i = 0; i < this.layers.length; i++) {
            if (i === referenceIndex) continue;
            const layer = this.layers[i];
            if (!layer || !layer.active) continue;
            const span = this.getLayerLoopLength(layer);
            if (span <= 0) continue;
            const absoluteSpan = layer.lengthSamples || span;
            const currentAnchor = Number.isFinite(layer.startOffset) ? layer.startOffset : (layer.phaseOffset || 0);
            const newAnchor = this.normalizeOffset((currentAnchor || 0) - deltaSamples, absoluteSpan);
            layer.startOffset = newAnchor;
            layer.phaseOffset = this.normalizeOffset(newAnchor - (layer.startSample || 0), span);
            layer.activePhaseOffset = layer.phaseOffset;
            layer.pendingPhaseOffset = null;
            this.syncLayerPlayheadToTransport(layer);
        }
    }

    queueReferenceCatchup(layerIndex, deltaSamples, prevStartSample, prevLoopSpan) {
        if (layerIndex == null || layerIndex < 0) return;
        const samplesNeeded = Math.max(0, Math.floor(deltaSamples || 0));
        if (samplesNeeded <= 0) return;
        const layer = this.layers[layerIndex];
        if (!layer || !layer.active) return;
        const anchor = Number.isFinite(layer.startOffset) ? layer.startOffset : 0;
        const previousCatchupActive = this.referenceCatchupSamples > 0 && this.referenceCatchupLayerIndex === layerIndex;
        if (!previousCatchupActive) {
            const priorSpan = Math.max(1, prevLoopSpan || layer.loopLengthSamples || layer.lengthSamples || 1);
            const preservedPhase = this.normalizeOffset((anchor || 0) - prevStartSample, priorSpan);
            const newSpan = Math.max(1, layer.loopLengthSamples || priorSpan);
            layer.activePhaseOffset = this.normalizeOffset(preservedPhase, newSpan);
            this.syncLayerPlayheadToTransport(layer);
        }
        layer.pendingPhaseOffset = layer.phaseOffset;
        this.referenceCatchupSamples += samplesNeeded;
        this.referenceCatchupLayerIndex = layerIndex;
        console.log('[Looper][catchup][queue]', {
            layerIndex,
            samplesNeeded,
            referenceCatchupSamples: this.referenceCatchupSamples
        });
    }

    shrinkReferenceCatchup(layerIndex, deltaSamples) {
        if (layerIndex == null || this.referenceCatchupLayerIndex !== layerIndex) return;
        if (this.referenceCatchupSamples <= 0) return;
        const reduction = Math.max(0, Math.floor(deltaSamples || 0));
        if (reduction <= 0) return;
        this.referenceCatchupSamples = Math.max(0, this.referenceCatchupSamples - reduction);
        const layer = this.layers[layerIndex];
        if (layer) {
            layer.pendingPhaseOffset = layer.phaseOffset;
        }
        console.log('[Looper][catchup][shrink]', {
            layerIndex,
            reduction,
            referenceCatchupSamples: this.referenceCatchupSamples
        });
        if (this.referenceCatchupSamples === 0) {
            this.completeReferenceCatchup();
        }
    }

    applyReferenceCatchupProgress(samplesAdvanced) {
        if (this.referenceCatchupSamples <= 0) return;
        const decrement = Math.max(0, Math.floor(samplesAdvanced || 0));
        if (decrement <= 0) return;
        this.referenceCatchupSamples = Math.max(0, this.referenceCatchupSamples - decrement);
        if (decrement > 0) {
            console.log('[Looper][catchup][progress]', {
                decrement,
                referenceCatchupSamples: this.referenceCatchupSamples
            });
        }
        if (this.referenceCatchupSamples === 0) {
            this.completeReferenceCatchup();
        }
    }

    resetReferenceCatchup(layerIndex = -1) {
        const layer = layerIndex >= 0 ? this.layers[layerIndex] : null;
        this.referenceCatchupSamples = 0;
        this.referenceCatchupLayerIndex = -1;
        if (layerIndex >= 0) {
            this.referenceCatchupSuppressedLayer = layerIndex;
        } else {
            this.referenceCatchupSuppressedLayer = -1;
        }
        if (layer && layer.active) {
            layer.pendingPhaseOffset = null;
            if (Number.isFinite(layer.phaseOffset)) {
                layer.activePhaseOffset = layer.phaseOffset;
            }
            this.syncLayerPlayheadToTransport(layer);
        }
    }

    completeReferenceCatchup() {
        const layerIndex = this.referenceCatchupLayerIndex;
        const layer = layerIndex >= 0 ? this.layers[layerIndex] : null;
        if (layer && layer.active) {
            if (Number.isFinite(layer.pendingPhaseOffset)) {
                layer.activePhaseOffset = layer.pendingPhaseOffset;
            } else {
                layer.activePhaseOffset = layer.phaseOffset;
            }
            layer.pendingPhaseOffset = null;
            this.syncLayerPlayheadToTransport(layer);
        }
        this.referenceCatchupSamples = 0;
        this.referenceCatchupLayerIndex = -1;
        console.log('[Looper][catchup][complete]', {
            layerIndex
        });
    }

    forceReferenceCatchup() {
        if (this.referenceCatchupSamples > 0) {
            this.referenceCatchupSamples = 0;
            this.completeReferenceCatchup();
        }
    }

    syncLayerPlayheadToTransport(layer) {
        if (!layer || !layer.active) return;
        const span = this.getLayerLoopLength(layer);
        if (span <= 0) {
            layer.playhead = 0;
            return;
        }
        const phaseSource = Number.isFinite(layer.activePhaseOffset) ? layer.activePhaseOffset : layer.phaseOffset;
        const offset = this.normalizeOffset(phaseSource || 0, span);
        if (this.playing && this.longestLoopSamples > 0) {
            const transportPhase = this.transportSamples % span;
            layer.playhead = this.normalizeOffset(transportPhase - offset, span);
        } else {
            layer.playhead = this.normalizeOffset(-offset, span);
        }
    }

    remindLayerPhase(index, payload = {}) {
        const layerIndex = typeof index === 'number' ? index : this.selectedLayer;
        if (layerIndex < 0 || layerIndex >= this.maxLayers) return;
        const layer = this.layers[layerIndex];
        if (!layer || !layer.active) return;
        const hasStart = Number.isFinite(payload.startOffsetSamples);
        const hasPhase = Number.isFinite(payload.phaseOffsetSamples);
        const absoluteSpan = layer.lengthSamples || this.getLayerLoopLength(layer);
        if (absoluteSpan > 0 && (hasStart || hasPhase)) {
            let anchorSamples = null;
            if (hasStart) {
                anchorSamples = payload.startOffsetSamples;
            } else {
                anchorSamples = payload.phaseOffsetSamples;
                if (payload.relativeToWindow && layer.startSample != null) {
                    anchorSamples = (layer.startSample || 0) + payload.phaseOffsetSamples;
                }
            }
            const anchor = this.normalizeOffset(anchorSamples || 0, absoluteSpan);
            layer.startOffset = anchor;
            const span = this.getLayerLoopLength(layer);
            if (span > 0) {
                layer.phaseOffset = this.normalizeOffset(anchor - (layer.startSample || 0), span);
            }
        }
        if (Number.isFinite(layer.phaseOffset)) {
            layer.activePhaseOffset = layer.phaseOffset;
        }
        layer.pendingPhaseOffset = null;
        this.syncLayerPlayheadToTransport(layer);
        if ((payload.isMaster && layerIndex === this.loopReferenceIndex) || payload.forceCatchup) {
            const span = this.getLayerLoopLength(layer) || layer.lengthSamples || 0;
            if (this.playing && span > 0) {
                layer.pendingPhaseOffset = layer.phaseOffset;
                this.referenceCatchupLayerIndex = layerIndex;
                this.referenceCatchupSamples = span;
            } else {
                this.forceReferenceCatchup();
            }
        }
    }

    mixTakes(takes) {
        if (!takes || !takes.length) {
            return {
                bufferL: new Float32Array(0),
                bufferR: new Float32Array(0)
            };
        }
        const length = takes[0].bufferL?.length || 0;
        const mixL = new Float32Array(length);
        const mixR = new Float32Array(length);
        takes.forEach((take) => {
            if (!take || !take.bufferL) return;
            const srcL = take.bufferL;
            const srcR = take.bufferR || take.bufferL;
            for (let i = 0; i < length; i++) {
                mixL[i] += srcL[i] || 0;
                mixR[i] += srcR[i] || 0;
            }
        });
        return { bufferL: mixL, bufferR: mixR };
    }

    rebuildLayerFromTakes(layer) {
        this.ensureLayerTakes(layer);
        if (!layer.takes.length) {
            layer.bufferL = null;
            layer.bufferR = null;
            layer.lengthSamples = 0;
            layer.startSample = 0;
            layer.endSample = 0;
            layer.startNorm = 0;
            layer.endNorm = 1;
            return;
        }
        const mixed = this.mixTakes(layer.takes);
        layer.bufferL = mixed.bufferL;
        layer.bufferR = mixed.bufferR.length ? mixed.bufferR : mixed.bufferL;
        layer.lengthSamples = layer.bufferL.length;
        layer.startSample = 0;
        layer.endSample = layer.lengthSamples;
        layer.startNorm = 0;
        layer.endNorm = 1;
            this.updateLayerWindowMetrics(layer);
            layer.activePhaseOffset = layer.phaseOffset;
            layer.pendingPhaseOffset = null;
        this.recomputeLongestLoop();
    }

    commitTake(layer, bufferL, bufferR) {
        this.ensureLayerTakes(layer);
        const take = {
            bufferL,
            bufferR: bufferR ? bufferR : bufferL
        };
        if (layer.takes.length >= 2) {
            const flattened = this.mixTakes(layer.takes);
            layer.takes = [{ bufferL: flattened.bufferL, bufferR: flattened.bufferR }];
        }
        layer.takes.push(take);
        this.rebuildLayerFromTakes(layer);
    }

    updateLoopReference() {
        const previousReference = this.loopReferenceIndex;
        let referenceIndex = -1;
        let referenceSamples = 0;
        for (let i = 0; i < this.layers.length; i++) {
            const layer = this.layers[i];
            if (!layer.active) continue;
            const span = this.getLayerLoopLength(layer);
            if (span > 0) {
                referenceIndex = i;
                referenceSamples = span;
                break;
            }
        }
        this.loopReferenceIndex = referenceIndex;
        this.loopReferenceSamples = referenceSamples;
        if (referenceIndex === -1 || referenceSamples === 0) {
            this.globalLoopSamples = referenceSamples;
            this.completeReferenceCatchup();
        } else if (previousReference !== referenceIndex) {
            this.globalLoopSamples = referenceSamples;
            this.completeReferenceCatchup();
        } else if (referenceSamples > 0) {
            this.globalLoopSamples = referenceSamples;
        }
        this.port.postMessage({ type: 'loop-reference', index: referenceIndex, samples: referenceSamples });
        return referenceSamples;
    }

    handleMessage(data) {
        if (!data || typeof data !== 'object') return;
        switch (data.type) {
            case 'set-play':
                this.playing = !!data.value;
                if (!this.playing) {
                    this.forceReferenceCatchup();
                }
                break;
            case 'configure':
                if (typeof data.maxLoopSeconds === 'number') {
                    const seconds = Math.max(1, Math.min(180, data.maxLoopSeconds));
                    this.maxLoopSeconds = seconds;
                    this.maxLoopSamples = Math.floor(seconds * sampleRate);
                }
                break;
            case 'set-selected-layer':
                if (typeof data.index === 'number') {
                    this.selectedLayer = Math.max(0, Math.min(this.maxLayers - 1, data.index));
                }
                break;
            case 'set-add-mode':
                this.addMode = !!data.value;
                break;
            case 'begin-record':
                this.beginRecording(data);
                break;
            case 'stop-record':
                this.stopRecording(data && data.commit !== false, { auto: false });
                break;
            case 'set-record-feed':
                this.setRecordFeed(data);
                break;
            case 'clear-layer':
                this.clearLayer(data?.index ?? this.selectedLayer);
                break;
            case 'set-layer-params':
                this.setLayerParams(data.index, data.params || {});
                break;
            case 'resync-layer-phase':
                this.remindLayerPhase(data.index, data);
                break;
            case 'export-layer':
                this.exportLayer(data);
                break;
            case 'restore-layer':
                this.restoreLayer(data);
                break;
            case 'undo':
            case 'redo':
                // Reserved for future history support handled externally
                break;
            default:
                break;
        }
    }

    exportLayer(payload = {}) {
        const index = typeof payload.index === 'number' ? payload.index : this.selectedLayer;
        const requestId = payload.requestId;
        const layer = this.layers[index];
        if (!layer || !layer.active || !layer.bufferL || !layer.bufferR) {
            if (requestId !== undefined) {
                this.port.postMessage({ type: 'layer-data', requestId, index, empty: true });
            }
            return;
        }
        const copyL = layer.bufferL.slice();
        const copyR = layer.bufferR.slice();
        const takesPayload = [];
        const transfer = [copyL.buffer, copyR.buffer];
        if (layer.takes && layer.takes.length) {
            layer.takes.forEach((take) => {
                const takeL = take.bufferL.slice();
                const takeR = (take.bufferR || take.bufferL).slice();
                takesPayload.push({ bufferL: takeL, bufferR: takeR });
                transfer.push(takeL.buffer, takeR.buffer);
            });
        }
        const response = {
            type: 'layer-data',
            requestId,
            index,
            empty: false,
            lengthSamples: layer.lengthSamples,
            params: {
                startNorm: layer.startNorm,
                endNorm: layer.endNorm,
                volume: layer.volume,
                repeats: layer.repeats,
                lofi: layer.lofiAmount,
                filter: layer.filterMode,
                dropouts: layer.dropouts,
                jump: layer.jumpAmount,
                stutter: layer.stutterAmount,
                speed: layer.speed,
                speedActual: layer.speed,
                pitch: layer.pitchSemitones,
                pitchFactor: layer.pitchFactor
            },
            bufferL: copyL,
            bufferR: copyR,
            takes: takesPayload,
            startOffsetSamples: layer.startOffset || 0,
            phaseOffsetSamples: layer.phaseOffset || 0
        };
        this.port.postMessage(response, transfer);
    }

    restoreLayer(payload = {}) {
        const index = typeof payload.index === 'number' ? payload.index : this.selectedLayer;
        const layer = this.layers[index];
        if (!layer) return;
        const bufferL = payload.bufferL ? new Float32Array(payload.bufferL) : null;
        const bufferRSource = payload.bufferR ? new Float32Array(payload.bufferR) : null;
        if (bufferL && bufferL.length > 0) {
            const bufferR = bufferRSource && bufferRSource.length === bufferL.length ? bufferRSource : bufferL;
            let takes = [];
            if (Array.isArray(payload.takes) && payload.takes.length) {
                takes = payload.takes.map((take) => {
                    const takeL = take.bufferL ? new Float32Array(take.bufferL) : bufferL;
                    const takeR = take.bufferR ? new Float32Array(take.bufferR) : takeL;
                    return { bufferL: takeL, bufferR: takeR };
                });
            } else {
                takes = [{ bufferL, bufferR }];
            }
            layer.takes = takes;
            this.rebuildLayerFromTakes(layer);
            const startNormParam = typeof payload.params?.startNorm === 'number'
                ? payload.params.startNorm
                : (typeof payload.params?.start === 'number' ? payload.params.start : undefined);
            const endNormParam = typeof payload.params?.endNorm === 'number'
                ? payload.params.endNorm
                : (typeof payload.params?.end === 'number' ? payload.params.end : undefined);
            layer.startNorm = typeof payload.startNorm === 'number' ? payload.startNorm : (startNormParam ?? 0);
            layer.endNorm = typeof payload.endNorm === 'number' ? payload.endNorm : (endNormParam ?? 1);
            const restoredVolume = payload.params?.volume ?? layer.volume;
            layer.volume = Math.max(0, Math.min(LAYER_VOLUME_MAX, restoredVolume));
            layer.repeats = payload.params?.repeats ?? layer.repeats;
            layer.repeatsDecay = layer.repeats;
            layer.lofiAmount = payload.params?.lofi ?? layer.lofiAmount;
            layer.filterMode = payload.params?.filter ?? layer.filterMode;
            layer.dropouts = payload.params?.dropouts ?? layer.dropouts;
            layer.jumpAmount = payload.params?.jump ?? layer.jumpAmount;
            layer.stutterAmount = payload.params?.stutter ?? layer.stutterAmount;
            if (typeof payload.params?.speedActual === 'number') {
                layer.speed = payload.params.speedActual;
            } else if (typeof payload.params?.speed === 'number') {
                layer.speed = mapNormalizedSpeedToActual(payload.params.speed);
            }
            if (typeof payload.params?.pitchFactor === 'number') {
                layer.pitchFactor = payload.params.pitchFactor;
            } else if (typeof payload.params?.pitch === 'number') {
                layer.pitchFactor = mapNormalizedPitchToFactor(payload.params.pitch);
            }
            layer.startSample = Math.floor(layer.startNorm * layer.lengthSamples);
            layer.endSample = Math.floor(layer.endNorm * layer.lengthSamples);
            if (layer.endSample <= layer.startSample) {
                layer.endSample = layer.lengthSamples;
            }
            const restoredAnchor = typeof payload.startOffsetSamples === 'number'
                ? payload.startOffsetSamples
                : (typeof payload.phaseOffsetSamples === 'number' ? payload.phaseOffsetSamples : 0);
            layer.startOffset = Number.isFinite(restoredAnchor) ? restoredAnchor : 0;
            layer.phaseOffset = 0;
            this.updateLayerWindowMetrics(layer);
            layer.activePhaseOffset = layer.phaseOffset;
            layer.pendingPhaseOffset = null;
            layer.active = true;
            this.syncLayerPlayheadToTransport(layer);
            layer.accumulatedGain = 1;
            layer.grains = [];
            layer.grainTimer = 0;
            this.recomputeLongestLoop();
            if (this.loopReferenceIndex === index) {
                this.resetReferenceCatchup(index);
            }
            console.log('[Looper][restoreLayer]', {
                index,
                bufferLength: layer.bufferL?.length || 0,
                loopLength: layer.loopLengthSamples,
                globalLoopSamples: this.globalLoopSamples
            });
            const referenceSpanSamples = (typeof payload.referenceSpanSamples === 'number' && payload.referenceSpanSamples > 0)
                ? Math.floor(payload.referenceSpanSamples)
                : (layer.loopLengthSamples || layer.lengthSamples);
            this.port.postMessage({
                type: 'layer-restored',
                index,
                lengthSamples: layer.lengthSamples,
                startOffsetSamples: layer.startOffset || 0,
                phaseOffsetSamples: layer.phaseOffset || 0,
                referenceSpanSamples
            });
        } else {
            this.resetLayer(layer);
            this.recomputeLongestLoop();
        }
    }

    recomputeLongestLoop() {
        const computedMax = this.layers.reduce((max, layer) => {
            const span = this.getLayerLoopLength(layer);
            return span > max ? span : max;
        }, 0);
        const referenceLength = this.updateLoopReference();
        if (computedMax === 0) {
            this.globalLoopSamples = 0;
        }
        const fallbackLength = referenceLength > 0 ? referenceLength : computedMax;
        const resolvedLength = this.globalLoopSamples > 0 ? this.globalLoopSamples : fallbackLength;
        this.longestLoopSamples = resolvedLength;
        if (!this.playing || this.longestLoopSamples === 0) {
            this.transportSamples = 0;
        } else if (this.transportSamples >= this.longestLoopSamples) {
            this.transportSamples %= this.longestLoopSamples;
        }
    }

    beginRecording(payload = {}) {
        const layerIndex = typeof payload.layerIndex === 'number' ? payload.layerIndex : this.selectedLayer;
        const layer = this.layers[layerIndex];
        if (!layer) return;

        const mode = typeof payload.mode === 'string' ? payload.mode : 'free';
        const providedReference = typeof payload.referenceSamples === 'number'
            ? Math.min(this.maxLoopSamples, Math.max(1, Math.floor(payload.referenceSamples)))
            : 0;
        const requestedTarget = typeof payload.targetSamples === 'number' ? Math.floor(payload.targetSamples) : 0;
        const clampedTarget = requestedTarget > 0
            ? Math.min(this.maxLoopSamples, Math.max(1, requestedTarget))
            : 0;
        const alignMode = (mode === 'aligned' || mode === 'loop') && providedReference > 0;
        const effectiveTarget = alignMode ? providedReference : clampedTarget;
        const bufferSamples = effectiveTarget > 0 ? effectiveTarget : this.maxLoopSamples;
        const captureOffsetSamples = alignMode
            ? (mode === 'loop' ? 0 : (this.playing && providedReference > 0 ? (this.transportSamples % providedReference) : 0))
            : 0;

        const bufferL = new Float32Array(bufferSamples);
        const bufferR = new Float32Array(bufferSamples);
        const captureSamples = bufferSamples;
        const continuous = !!payload.continuous && alignMode;
        const captureMuted = payload.captureMuted !== undefined ? !!payload.captureMuted : false;
        const autoRestart = !!payload.autoRestart;
        const captureMode = payload.captureMode === 'add' ? 'add' : 'manual';
        const monitorLayer = typeof payload.monitor === 'boolean'
            ? payload.monitor
            : (continuous && !!layer.active);
        const autoPrintOnce = !!payload.autoPrintOnce;
        this.recordState = {
            active: true,
            layerIndex,
            writePosition: 0,
            targetSamples: effectiveTarget,
            autoStop: effectiveTarget > 0 && !continuous,
            bufferL,
            bufferR,
            alignMode: alignMode ? mode : null,
            captureOffsetSamples,
            samplesWritten: 0,
            captureSamples,
            manualStopLocked: alignMode,
            pendingManualStop: false,
            captureMuted,
            continuous,
            captureMode,
                        hadInputThisCycle: false,
                        monitorLayer,
                        autoPrintOnce,
            restartConfig: continuous
                ? {
                      layerIndex,
                      referenceSamples: providedReference,
                      targetSamples: effectiveTarget,
                      mode,
                      captureMode,
                                            autoRestart: true,
                                            monitor: monitorLayer,
                                            autoPrintOnce
                  }
                : null
        };
        if (!alignMode) {
            layer.mutedWhileRecording = layer.active;
            layer.active = false;
        }
        this.port.postMessage({
            type: 'record-started',
            layerIndex,
            locked: !!alignMode,
            continuous,
            captureMode,
            autoRestart
        });
    }

    stopRecording(commit = true, options = {}) {
        const state = this.recordState;
        if (!state.active) return;
        if (state.manualStopLocked && commit && !options.auto && state.captureSamples > 0 && state.samplesWritten < state.captureSamples) {
            state.pendingManualStop = true;
            return;
        }
        const restartAllowed = state.continuous && options.restart !== false;
        state.active = false;
        const layer = this.layers[state.layerIndex];
        if (!layer) {
            this.resetRecordStateLocks();
            return;
        }
        const recordedLength = state.alignMode ? state.bufferL.length : state.writePosition;
        if (!commit || recordedLength === 0) {
            // Restore layer if we muted it
            if (layer.mutedWhileRecording) {
                layer.active = true;
                layer.mutedWhileRecording = false;
            }
            this.port.postMessage({ type: 'record-cancelled', layerIndex: state.layerIndex });
            this.resetRecordStateLocks();
            return;
        }
        const lengthSamples = recordedLength;
        if (state.alignMode === 'loop') {
            this.applyLoopCapture(layer, lengthSamples, restartAllowed);
        } else {
            const bufferSliceL = state.alignMode
                ? state.bufferL.slice()
                : state.bufferL.subarray(0, lengthSamples).slice();
            const bufferSliceR = state.alignMode
                ? state.bufferR.slice()
                : state.bufferR.subarray(0, lengthSamples).slice();
            this.commitTake(layer, bufferSliceL, bufferSliceR);
            const startOffset = this.normalizeOffset(state.captureOffsetSamples || 0, lengthSamples);
            layer.startOffset = startOffset;
            layer.grains = [];
            layer.grainTimer = 0;
            layer.accumulatedGain = 1;
            layer.active = true;
            layer.mutedWhileRecording = false;
            this.updateLayerWindowMetrics(layer);
            this.syncLayerPlayheadToTransport(layer);
            this.recomputeLongestLoop();
            this.port.postMessage({
                type: 'record-complete',
                layerIndex: state.layerIndex,
                lengthSamples,
                durationSeconds: lengthSamples / sampleRate,
                mode: state.captureMode,
                continuous: state.continuous,
                autoRestart: restartAllowed,
                startOffsetSamples: layer.startOffset || 0,
                phaseOffsetSamples: layer.phaseOffset || 0
            });
        }
        if (restartAllowed) {
            if (state.restartConfig) {
                state.restartConfig.autoPrintOnce = false;
            }
            state.autoPrintOnce = false;
            this.restartContinuousRecording();
            return;
        }
        this.resetRecordStateLocks();
    }

    resetRecordStateLocks() {
        this.recordState.alignMode = null;
        this.recordState.manualStopLocked = false;
        this.recordState.pendingManualStop = false;
        this.recordState.captureSamples = 0;
        this.recordState.samplesWritten = 0;
        this.recordState.captureOffsetSamples = 0;
        this.recordState.captureMuted = true;
        this.recordState.continuous = false;
        this.recordState.captureMode = 'manual';
        this.recordState.hadInputThisCycle = false;
        this.recordState.restartConfig = null;
        this.recordState.monitorLayer = false;
        this.recordState.autoPrintOnce = false;
    }

    setRecordFeed(payload = {}) {
        if (!this.recordState.active) return;
        if (typeof payload.armed === 'boolean') {
            this.recordState.captureMuted = !payload.armed;
            if (payload.armed) {
                this.recordState.pendingManualStop = false;
            } else if (this.recordState.manualStopLocked) {
                this.recordState.pendingManualStop = true;
            }
        }
        if (typeof payload.captureMode === 'string') {
            this.recordState.captureMode = payload.captureMode;
        }
    }

    applyLoopCapture(layer, lengthSamples, autoRestart) {
        const state = this.recordState;
        if (!state.bufferL || !state.bufferR || lengthSamples <= 0) {
            return;
        }
        if (!state.hadInputThisCycle) {
            state.bufferL.fill(0);
            state.bufferR.fill(0);
            state.samplesWritten = 0;
            state.hadInputThisCycle = false;
            return;
        }
        if (!layer.bufferL || layer.lengthSamples !== lengthSamples) {
            layer.bufferL = new Float32Array(lengthSamples);
            layer.bufferR = new Float32Array(lengthSamples);
            layer.lengthSamples = lengthSamples;
            layer.startSample = 0;
            layer.endSample = lengthSamples;
            layer.startNorm = 0;
            layer.endNorm = 1;
        }
        const replace = state.captureMode === 'add' && !layer.active;
        for (let i = 0; i < lengthSamples; i++) {
            const valueL = state.bufferL[i];
            const valueR = state.bufferR[i];
            if (replace) {
                layer.bufferL[i] = valueL;
                layer.bufferR[i] = valueR;
            } else {
                layer.bufferL[i] += valueL;
                layer.bufferR[i] += valueR;
            }
        }
        layer.active = true;
        const startOffset = this.normalizeOffset(state.captureOffsetSamples || 0, lengthSamples);
        layer.startOffset = startOffset;
        layer.grains = [];
        layer.grainTimer = 0;
        layer.accumulatedGain = 1;
        this.updateLayerWindowMetrics(layer);
        this.syncLayerPlayheadToTransport(layer);
        state.monitorLayer = true;
        if (state.restartConfig) {
            state.restartConfig.monitor = true;
        }
        this.recomputeLongestLoop();
        this.port.postMessage({
            type: 'record-complete',
            layerIndex: state.layerIndex,
            lengthSamples,
            durationSeconds: lengthSamples / sampleRate,
            mode: state.captureMode,
            continuous: state.continuous,
            autoRestart,
            startOffsetSamples: layer.startOffset || 0,
            phaseOffsetSamples: layer.phaseOffset || 0
        });
        state.bufferL.fill(0);
        state.bufferR.fill(0);
        state.samplesWritten = 0;
        state.hadInputThisCycle = false;
    }

    restartContinuousRecording() {
        const state = this.recordState;
        const config = state.restartConfig;
        if (!config) {
            this.resetRecordStateLocks();
            return;
        }
        const payload = {
            layerIndex: config.layerIndex,
            mode: config.mode || 'loop',
            referenceSamples: config.referenceSamples,
            targetSamples: config.targetSamples,
            continuous: true,
            captureMuted: state.captureMuted,
            captureMode: state.captureMode,
            monitor: config.monitor ?? state.monitorLayer,
            autoRestart: true,
            autoPrintOnce: !!config.autoPrintOnce
        };
        this.beginRecording(payload);
    }

    clearLayer(index) {
        const layerIndex = typeof index === 'number' ? index : this.selectedLayer;
        const layer = this.layers[layerIndex];
        if (!layer) return;
        this.resetLayer(layer);
        if (layerIndex === this.selectedLayer) {
            this.port.postMessage({ type: 'layer-cleared', layerIndex });
        }
        this.recomputeLongestLoop();
    }

    setLayerParams(index, params) {
        const layerIndex = typeof index === 'number' ? index : this.selectedLayer;
        const layer = this.layers[layerIndex];
        if (!layer) return;
        const prevStartSample = layer.startSample || 0;
        const prevLoopSpan = Math.max(1, this.getLayerLoopLength(layer) || layer.lengthSamples || 1);
        const wasReferenceLayer = this.loopReferenceIndex === layerIndex;
        let windowChanged = false;
        if (typeof params.volume === 'number') {
            layer.volume = Math.max(0, Math.min(LAYER_VOLUME_MAX, params.volume));
        }
        if (typeof params.start === 'number') {
            layer.startNorm = Math.max(0, Math.min(1, params.start));
            windowChanged = true;
        }
        if (typeof params.end === 'number') {
            layer.endNorm = Math.max(layer.startNorm + 0.001, Math.min(1, params.end));
            windowChanged = true;
        }
        if (layer.lengthSamples > 0) {
            layer.startSample = Math.floor(layer.startNorm * layer.lengthSamples);
            layer.endSample = Math.floor(layer.endNorm * layer.lengthSamples);
            if (layer.endSample <= layer.startSample) {
                layer.endSample = Math.min(layer.lengthSamples, layer.startSample + 128);
            }
        }
        if (typeof params.repeats === 'number') {
            layer.repeats = Math.max(0, Math.min(1, params.repeats));
            layer.repeatsDecay = params.repeats;
        }
        if (typeof params.lofi === 'number') {
            layer.lofiAmount = Math.max(0, Math.min(1, params.lofi));
        }
        if (typeof params.filter === 'number') {
            layer.filterMode = Math.max(0, Math.min(1, params.filter));
        }
        if (typeof params.dropouts === 'number') {
            layer.dropouts = Math.max(0, Math.min(1, params.dropouts));
        }
        if (typeof params.jump === 'number') {
            layer.jumpAmount = Math.max(0, Math.min(1, params.jump));
        }
        if (typeof params.stutter === 'number') {
            layer.stutterAmount = Math.max(0, Math.min(1, params.stutter));
        }
        if (typeof params.speed === 'number') {
            const minRate = 0.25;
            const maxRate = 2.0;
            const clamped = Math.max(0, Math.min(1, params.speed));
            if (clamped <= 0.5) {
                const t = clamped / 0.5;
                layer.speed = minRate + (1 - minRate) * t;
            } else {
                const t = (clamped - 0.5) / 0.5;
                layer.speed = 1 + (maxRate - 1) * t;
            }
        }
        if (typeof params.pitch === 'number') {
            const semitone = -24 + 48 * params.pitch;
            layer.pitchSemitones = semitone;
            layer.pitchFactor = Math.pow(2, semitone / 12);
        }
        if (typeof params.startSeconds === 'number' && layer.lengthSamples > 0) {
            const samplePos = Math.max(0, Math.min(layer.lengthSamples - 1, Math.floor(params.startSeconds * sampleRate)));
            layer.startSample = samplePos;
            layer.startNorm = layer.startSample / layer.lengthSamples;
            windowChanged = true;
        }
        if (typeof params.endSeconds === 'number' && layer.lengthSamples > 0) {
            const samplePos = Math.max(0, Math.min(layer.lengthSamples, Math.floor(params.endSeconds * sampleRate)));
            layer.endSample = Math.max(samplePos, layer.startSample + 128);
            layer.endNorm = layer.endSample / layer.lengthSamples;
            windowChanged = true;
        }
        this.updateLayerWindowMetrics(layer);
        if (windowChanged) {
            const deltaStart = (layer.startSample || 0) - prevStartSample;
            if (wasReferenceLayer && deltaStart !== 0) {
                if (this.referenceCatchupSuppressedLayer === layerIndex) {
                    this.referenceCatchupSuppressedLayer = -1;
                } else {
                    this.shiftLayerOffsets(layerIndex, deltaStart);
                    if (deltaStart < 0) {
                        if (this.playing) {
                            this.queueReferenceCatchup(layerIndex, Math.abs(deltaStart), prevStartSample, prevLoopSpan);
                        } else {
                            this.forceReferenceCatchup();
                        }
                    } else {
                        this.shrinkReferenceCatchup(layerIndex, deltaStart);
                    }
                }
            } else if (wasReferenceLayer && this.referenceCatchupSuppressedLayer === layerIndex) {
                this.referenceCatchupSuppressedLayer = -1;
            }
            this.syncLayerPlayheadToTransport(layer);
            this.recomputeLongestLoop();
        }
    }

    readLayerFrame(layer) {
        if (!layer.active || !layer.bufferL || layer.endSample <= layer.startSample) {
            layer.lastFrameSampleL = 0;
            layer.lastFrameSampleR = 0;
            return [0, 0];
        }
        const range = layer.endSample - layer.startSample;
        if (range <= 1) {
            const valueL = layer.bufferL[layer.startSample] || 0;
            const valueR = layer.bufferR[layer.startSample] || valueL;
            layer.lastFrameSampleL = valueL;
            layer.lastFrameSampleR = valueR;
            return [valueL, valueR];
        }

        const playheadPosition = layer.playhead;
        let sampleL;
        let sampleR;
        if (Math.abs(layer.pitchFactor - 1) < PITCH_SHIFT_EPSILON) {
            const position = layer.startSample + playheadPosition;
            sampleL = this.sampleLayerBuffer(layer, 0, position);
            sampleR = this.sampleLayerBuffer(layer, 1, position);
            if (layer.grains && layer.grains.length) {
                layer.grains.length = 0;
            }
            layer.grainTimer = 0;
        } else {
            [sampleL, sampleR] = this.readPitchShiftedFrame(layer, range);
        }

        const fade = this.computeLoopFadeFactor(playheadPosition, range);
        if (fade < 1) {
            sampleL *= fade;
            sampleR *= fade;
        }

        if (layer.jumpFadeRemaining > 0 && layer.jumpFadeTotal > 0) {
            const progress = 1 - ((layer.jumpFadeRemaining - 1) / layer.jumpFadeTotal);
            const eased = 0.5 - 0.5 * Math.cos(Math.min(1, Math.max(0, progress)) * Math.PI);
            const fromL = Number.isFinite(layer.jumpFadeStartL) ? layer.jumpFadeStartL : 0;
            const fromR = Number.isFinite(layer.jumpFadeStartR) ? layer.jumpFadeStartR : fromL;
            sampleL = fromL * (1 - eased) + sampleL * eased;
            sampleR = fromR * (1 - eased) + sampleR * eased;
            layer.jumpFadeRemaining--;
            if (layer.jumpFadeRemaining <= 0) {
                layer.jumpFadeTotal = 0;
            }
        }

        this.advanceTransport(layer, range);
        layer.lastFrameSampleL = sampleL;
        layer.lastFrameSampleR = sampleR;
        return [sampleL, sampleR];
    }

    computeLoopFadeFactor(playheadPosition, range) {
        const span = Math.max(1, range || 0);
        const fadeWindow = Math.min(LOOP_FADE_SAMPLES, Math.floor(span / 2));
        if (fadeWindow <= 0) {
            return 1;
        }
        const clampedPlayhead = playheadPosition % span;
        const position = clampedPlayhead >= 0 ? clampedPlayhead : clampedPlayhead + span;
        const distanceToStart = position;
        const distanceToEnd = span - position;
        const fadeEase = (distance) => {
            if (distance >= fadeWindow) return 1;
            const t = Math.max(0, Math.min(1, distance / fadeWindow));
            return 0.5 - 0.5 * Math.cos(t * Math.PI);
        };
        const startFactor = fadeEase(distanceToStart);
        const endFactor = fadeEase(distanceToEnd);
        return Math.min(startFactor, endFactor);
    }

    sampleLayerBuffer(layer, channel, position) {
        const buffer = channel === 0 ? layer.bufferL : layer.bufferR;
        const start = layer.startSample;
        const end = layer.endSample;
        const range = end - start;
        if (!buffer || range <= 0) {
            return 0;
        }
        let pos = position;
        while (pos >= end) {
            pos -= range;
        }
        while (pos < start) {
            pos += range;
        }
        const indexA = pos | 0;
        const indexB = indexA + 1 >= end ? start : indexA + 1;
        const frac = pos - indexA;
        return buffer[indexA] + (buffer[indexB] - buffer[indexA]) * frac;
    }

    advanceTransport(layer, range) {
        layer.playhead += layer.speed;
        while (layer.playhead >= range) {
            layer.playhead -= range;
            this.advanceLayerCycle(layer);
        }
        while (layer.playhead < 0) {
            layer.playhead += range;
        }
    }

    readPitchShiftedFrame(layer, range) {
        if (!layer.grains) {
            layer.grains = [];
            layer.grainTimer = 0;
        }
        if (layer.grains.length === 0) {
            this.spawnPitchGrain(layer, range);
            layer.grainTimer = GRAIN_SPACING;
        }

        let sampleL = 0;
        let sampleR = 0;
        for (let i = layer.grains.length - 1; i >= 0; i--) {
            const grain = layer.grains[i];
            const valueL = this.sampleLayerBuffer(layer, 0, grain.position);
            const valueR = this.sampleLayerBuffer(layer, 1, grain.position);
            const windowGain = GRAIN_WINDOW[grain.index];
            sampleL += valueL * windowGain;
            sampleR += valueR * windowGain;

            grain.position += layer.pitchFactor * layer.speed;
            while (grain.position >= layer.endSample) {
                grain.position -= range;
            }
            while (grain.position < layer.startSample) {
                grain.position += range;
            }

            grain.index++;
            if (grain.index >= GRAIN_WINDOW.length) {
                layer.grains.splice(i, 1);
            }
        }

        layer.grainTimer -= layer.speed;
        if (layer.grainTimer <= 0) {
            this.spawnPitchGrain(layer, range);
            layer.grainTimer += GRAIN_SPACING;
        }

        return [sampleL, sampleR];
    }

    spawnPitchGrain(layer, range) {
        if (!layer.grains) {
            layer.grains = [];
        }
        const origin = layer.startSample + layer.playhead;
        let position = origin;
        while (position >= layer.endSample) {
            position -= range;
        }
        while (position < layer.startSample) {
            position += range;
        }
        layer.grains.push({ position, index: 0 });
    }

    advanceLayerCycle(layer) {
        const range = layer.endSample - layer.startSample;
        if (layer.repeatsDecay < 1) {
            layer.accumulatedGain *= layer.repeatsDecay;
            if (layer.accumulatedGain < 0.0001) {
                layer.accumulatedGain = 0;
            }
        }
        if (layer.lofiAmount > 0) {
            layer.lofiBuild += layer.lofiAmount * 0.05;
        } else {
            layer.lofiBuild *= 0.98;
        }
        if (layer.lofiBuild < 0) {
            layer.lofiBuild = 0;
        }
        const offset = Math.abs(layer.filterMode - 0.5);
        const targetStrength = Math.min(1, Math.max(0, offset * 2));
        const response = 0.08 + targetStrength * 0.4;
        layer.filterStrength += (targetStrength - layer.filterStrength) * response;
        if (layer.filterStrength < 0.0001) {
            layer.filterStrength = 0;
        }
        if (layer.jumpAmount > 0) {
            layer.jumpTimer = Math.max(32, Math.floor((1 - layer.jumpAmount) * (layer.endSample - layer.startSample)));
        }
        if (layer.stutterAmount > 0) {
            layer.stutterTimer = Math.max(128, Math.floor((1 - layer.stutterAmount) * sampleRate * 0.5));
        }
        if (layer.dropouts > 0) {
            layer.dropoutTimer = Math.max(64, Math.floor(sampleRate * (0.1 + Math.pow(1 - layer.dropouts, 2))));
        }
    }

    applyDropouts(layer, sample) {
        if (layer.dropouts <= 0) return sample;
        layer.dropoutTimer--;
        if (layer.dropoutTimer <= 0) {
            layer.dropoutTimer = Math.max(64, Math.floor(sampleRate * (0.02 + (1 - layer.dropouts) * 0.5)));
            layer.dropoutTarget = Math.random() * (1 - layer.dropouts * 0.8);
            layer.dropoutRampSamples = Math.floor(sampleRate * 0.02);
            layer.dropoutStep = (layer.dropoutTarget - layer.dropoutState) / Math.max(1, layer.dropoutRampSamples);
        }
        if (layer.dropoutRampSamples > 0) {
            layer.dropoutState += layer.dropoutStep;
            layer.dropoutRampSamples--;
        } else {
            layer.dropoutState += (1 - layer.dropoutState) * 0.002;
        }
        return sample * layer.dropoutState;
    }

    applyJump(layer) {
        if (layer.jumpAmount <= 0) return;
        layer.jumpTimer--;
        if (layer.jumpTimer <= 0) {
            const range = layer.endSample - layer.startSample;
            if (range > 0) {
                const jump = Math.random() * range * layer.jumpAmount;
                const fadeSeconds = JUMP_FADE_MIN_SECONDS
                    + (JUMP_FADE_MAX_SECONDS - JUMP_FADE_MIN_SECONDS) * Math.min(1, Math.max(0, layer.jumpAmount));
                const fadeSamples = Math.max(4, Math.floor(sampleRate * fadeSeconds));
                layer.jumpFadeStartL = Number.isFinite(layer.lastFrameSampleL) ? layer.lastFrameSampleL : 0;
                layer.jumpFadeStartR = Number.isFinite(layer.lastFrameSampleR) ? layer.lastFrameSampleR : layer.jumpFadeStartL;
                layer.jumpFadeTotal = fadeSamples;
                layer.jumpFadeRemaining = fadeSamples;
                layer.playhead = (layer.playhead + jump) % range;
            }
            layer.jumpTimer = Math.max(64, Math.floor(sampleRate * (0.05 + (1 - layer.jumpAmount) * 0.4)));
        }
    }

    applyStutter(layer, sample, channel) {
        if (layer.stutterAmount <= 0 || !layer.bufferL) {
            return sample;
        }
        layer.stutterTimer--;
        if (layer.stutterTimer <= 0 && !layer.stutterActive) {
            const range = Math.max(1, layer.endSample - layer.startSample);
            const windowSeconds = STUTTER_MIN_SECONDS
                + (STUTTER_MAX_SECONDS - STUTTER_MIN_SECONDS) * Math.min(1, Math.max(0, layer.stutterAmount));
            const len = Math.max(32, Math.min(range, Math.floor(windowSeconds * sampleRate)));
            layer.stutterBufferL = new Float32Array(len);
            layer.stutterBufferR = new Float32Array(len);
            for (let i = 0; i < len; i++) {
                const pos = (layer.playhead + i) % range;
                const srcIndex = layer.startSample + (pos | 0);
                const sampleL = layer.bufferL[srcIndex] || 0;
                const sampleR = (layer.bufferR ? layer.bufferR[srcIndex] : sampleL) || 0;
                layer.stutterBufferL[i] = sampleL;
                layer.stutterBufferR[i] = sampleR;
            }
            layer.stutterActive = true;
            layer.stutterPos = 0;
            layer.stutterFramePending = false;
            layer.stutterTimer = Math.max(256, Math.floor(sampleRate * (0.1 + (1 - layer.stutterAmount))));
        }
        if (layer.stutterActive) {
            const bufferL = layer.stutterBufferL;
            const bufferR = (layer.stutterBufferR && layer.stutterBufferR.length === bufferL.length)
                ? layer.stutterBufferR
                : bufferL;
            if (!bufferL || bufferL.length === 0) {
                layer.stutterActive = false;
                layer.stutterFramePending = false;
                return sample;
            }
            if (!layer.stutterFramePending) {
                if (layer.stutterPos >= bufferL.length) {
                    layer.stutterPos = 0;
                    layer.stutterActive = Math.random() < 0.7; // continue stutter sometimes
                    if (!layer.stutterActive) {
                        layer.stutterFramePending = false;
                        return sample;
                    }
                }
                const idx = layer.stutterPos;
                layer.stutterFrameL = bufferL[idx] || 0;
                layer.stutterFrameR = (bufferR[idx] ?? layer.stutterFrameL) || 0;
                layer.stutterFramePending = true;
            }
            const value = channel === 0 ? layer.stutterFrameL : layer.stutterFrameR;
            if (channel === 1) {
                layer.stutterFramePending = false;
                layer.stutterPos++;
            }
            return value;
        }
        return sample;
    }

    applyFilter(layer, sample, channel) {
        if (layer.filterStrength <= 0.001) {
            return sample;
        }
        const mode = layer.filterMode;
        const strength = layer.filterStrength;
        const nyquist = sampleRate * 0.5;
        if (!Number.isFinite(layer.lowFilterStateL)) layer.lowFilterStateL = 0;
        if (!Number.isFinite(layer.lowFilterStateR)) layer.lowFilterStateR = 0;
        if (!Number.isFinite(layer.highFilterStateL)) layer.highFilterStateL = 0;
        if (!Number.isFinite(layer.highFilterStateR)) layer.highFilterStateR = 0;
        const lpMaxCutoff = Math.max(1, Math.min(FILTER_LP_MAX_HZ, nyquist * 0.99));
        const lpMinCutoff = Math.max(0.1, nyquist * FILTER_LP_MIN_RATIO);
        const lpRatio = Math.max(1e-6, lpMinCutoff / lpMaxCutoff);
        const hpMaxCutoff = Math.max(FILTER_HP_MIN_HZ, nyquist * 0.999);
        const cutoffHz = mode < 0.5
            ? lpMaxCutoff * Math.pow(lpRatio, strength)
            : FILTER_HP_MIN_HZ + (hpMaxCutoff - FILTER_HP_MIN_HZ) * Math.pow(strength, 2);
        const omega = 2 * Math.PI * cutoffHz / sampleRate;
        const alpha = omega / (omega + 1);
        if (mode < 0.5) {
            if (channel === 0) {
                layer.lowFilterStateL += alpha * (sample - layer.lowFilterStateL);
                return layer.lowFilterStateL;
            }
            layer.lowFilterStateR += alpha * (sample - layer.lowFilterStateR);
            return layer.lowFilterStateR;
        } else {
            if (channel === 0) {
                layer.highFilterStateL += alpha * (sample - layer.highFilterStateL);
                return sample - layer.highFilterStateL;
            }
            layer.highFilterStateR += alpha * (sample - layer.highFilterStateR);
            return sample - layer.highFilterStateR;
        }
    }

    applyLofi(layer, sample) {
        const build = Math.max(0, layer.lofiBuild || 0);
        if (build <= 0.001) return sample;
        const depth = 16 - 14 * build;
        const levels = Math.max(1e-4, Math.pow(2, depth));
        const quantized = Math.round(sample * levels) / levels;
        const limited = Math.max(-1, Math.min(1, quantized));
        const bitGain = 1 / (1 + build * 0.25);
        const noiseAmount = Math.min(0.01, 0.001 + build * 0.0015);
        const noise = (Math.random() * 2 - 1) * noiseAmount * (1 - bitGain);
        return limited * bitGain + noise;
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        if (!output) return true;
        const inL = input && input[0] ? input[0] : null;
        const inR = input && input[1] ? input[1] : null;
        const outL = output[0];
        const outR = output[1] || output[0];
        const frames = outL.length;
        const state = this.recordState;

        for (let i = 0; i < frames; i++) {
            const dryL = inL ? inL[i] : 0;
            const dryR = inR ? inR[i] : (inL ? inL[i] : 0);

            if (state.active && state.bufferL) {
                if (state.alignMode) {
                    const targetLength = state.bufferL.length;
                    if (targetLength <= 0 || state.captureSamples <= 0) {
                        this.stopRecording(true, { auto: true });
                    } else {
                        const writeIndex = state.samplesWritten;
                        if (writeIndex >= targetLength) {
                            this.stopRecording(true, { auto: true });
                        } else {
                            const sourceL = state.captureMuted ? 0 : dryL;
                            const sourceR = state.captureMuted ? 0 : dryR;
                            state.bufferL[writeIndex] = sourceL;
                            state.bufferR[writeIndex] = sourceR;
                            if (!state.captureMuted) {
                                state.hadInputThisCycle = true;
                            }
                            state.samplesWritten++;
                            if (state.samplesWritten >= state.captureSamples) {
                                if ((state.autoPrintOnce && state.hadInputThisCycle) || !state.continuous || state.pendingManualStop) {
                                    this.stopRecording(true, { auto: true });
                                } else {
                                    if (state.captureOffsetSamples !== 0) {
                                        state.captureOffsetSamples = 0;
                                    }
                                    state.samplesWritten = 0;
                                    state.hadInputThisCycle = false;
                                }
                            }
                        }
                    }
                } else if (state.writePosition < state.bufferL.length) {
                    state.bufferL[state.writePosition] = dryL;
                    state.bufferR[state.writePosition] = dryR;
                    state.writePosition++;
                    if (state.autoStop && state.writePosition >= state.targetSamples) {
                        this.stopRecording(true, { auto: true });
                    }
                } else {
                    this.stopRecording(true, { auto: true });
                }
            }

            let wetL = 0;
            let wetR = 0;

            if (this.playing) {
                for (let layerIndex = 0; layerIndex < this.maxLayers; layerIndex++) {
                    const layer = this.layers[layerIndex];
                    if (!layer.active || !layer.bufferL) continue;
                    if (state.active && state.layerIndex === layerIndex && !state.monitorLayer) {
                        continue; // mute while recording replacement when monitoring disabled
                    }
                    this.applyJump(layer);
                    const [sampleLFrame, sampleRFrame] = this.readLayerFrame(layer);
                    let sampleL = sampleLFrame;
                    let sampleR = sampleRFrame;
                    sampleL = this.applyStutter(layer, sampleL, 0);
                    sampleR = this.applyStutter(layer, sampleR, 1);
                    sampleL = this.applyDropouts(layer, sampleL);
                    sampleR = this.applyDropouts(layer, sampleR);
                    sampleL = this.applyFilter(layer, sampleL, 0);
                    sampleR = this.applyFilter(layer, sampleR, 1);
                    sampleL = this.applyLofi(layer, sampleL);
                    sampleR = this.applyLofi(layer, sampleR);
                    const gain = layer.volume * layer.accumulatedGain;
                    wetL += sampleL * gain;
                    wetR += sampleR * gain;
                }
            }

            outL[i] = dryL + wetL;
            outR[i] = dryR + wetR;
        }

        if (this.playing && this.longestLoopSamples > 0) {
            this.transportSamples += frames;
            while (this.transportSamples >= this.longestLoopSamples) {
                this.transportSamples -= this.longestLoopSamples;
                this.port.postMessage({ type: 'loop-head', loopSamples: this.longestLoopSamples });
            }
            this.applyReferenceCatchupProgress(frames);
        } else if (!this.playing) {
            this.transportSamples = 0;
            this.forceReferenceCatchup();
        }

        return true;
    }
}

registerProcessor('layered-looper-processor', LayeredLooperProcessor);
