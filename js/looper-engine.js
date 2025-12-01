import { initializeKnob } from './controls.js';
import { processLayerBuffer } from './pitch-stretch.js';

const MAX_LAYERS = 8;
const VOLUME_MIN = 0;
const VOLUME_CORE_MAX = 1.5;
const VOLUME_EXTENDED_MAX = 5.0;
const VOLUME_LINEAR_THRESHOLD = 0.75;
const SPEED_MIN = 0.25;
const SPEED_MAX = 2.0;
const PITCH_MIN = -24;
const PITCH_MAX = 24;
const FILTER_LP_MAX_HZ = 20000;
const FILTER_LP_MIN_RATIO = 0.00005;
const FILTER_HP_MIN_HZ = 20;

const defaultKnobValues = () => ({
    volume: 0.75,
    start: 0,
    end: 1,
    repeats: 1,
    lofi: 0,
    filter: 0.5,
    dropouts: 0,
    jump: 0,
    stutter: 0,
    speed: 0.5,
    pitch: 0.5
});

const defaultLayerState = () => ({
    active: false,
    lengthSamples: 0,
    lengthSeconds: 0,
    startOffsetSamples: 0,
    phaseOffsetSamples: 0,
    knobValues: { ...defaultKnobValues() }
});

export class LayeredLooperEngine {
    constructor(audioCtx, node, options = {}) {
        this.audioCtx = audioCtx;
        this.node = node;
        this.integrationCallbacks = options.integrationCallbacks || null;
        this.state = {
            playing: false,
            recording: false,
            addMode: false,
            autoLatch: false,
            waitingForLoopHead: false,
            pendingStopRequest: false,
            lockedRecording: false,
            captureSessionActive: false,
            awaitingCaptureRestart: false,
            currentRecordingLayer: null,
            currentCaptureMode: 'manual',
            feedArmQueued: false,
            queuedFeedOptions: null,
            selectedLayer: 0,
            layers: Array.from({ length: MAX_LAYERS }, () => defaultLayerState()),
            layerProcessing: Array(MAX_LAYERS).fill(false),
            loopReferenceSamples: 0,
            longestLoopSamples: 0,
            primaryLayerIndex: null,
            undoStack: [],
            redoStack: [],
            pendingRequests: new Map(),
            requestId: 0
        };
        this.buttons = {};
        this.knobs = {};
        this.knobTooltipElements = new Map();
        this.paramToKnobId = {
            volume: 'looper-volume-knob',
            start: 'looper-start-knob',
            end: 'looper-end-knob',
            lofi: 'looper-lofi-knob',
            repeats: 'looper-repeats-knob',
            speed: 'looper-speed-knob',
            filter: 'looper-filter-knob',
            dropouts: 'looper-dropouts-knob',
            jump: 'looper-jump-knob',
            stutter: 'looper-stutter-knob',
            pitch: 'looper-pitch-knob'
        };
        this.layersKnob = null;
        this.layerMarkers = [];
        this.statusTextEl = null;
        this.layerInfoEl = null;
        this.nextAutoLayer = null;
        const baseKnobDefaults = defaultKnobValues();
        this.looperKnobDefaults = {
            'looper-volume-knob': baseKnobDefaults.volume,
            'looper-start-knob': baseKnobDefaults.start,
            'looper-end-knob': baseKnobDefaults.end,
            'looper-lofi-knob': baseKnobDefaults.lofi,
            'looper-repeats-knob': baseKnobDefaults.repeats,
            'looper-speed-knob': baseKnobDefaults.speed,
            'looper-filter-knob': baseKnobDefaults.filter,
            'looper-dropouts-knob': baseKnobDefaults.dropouts,
            'looper-jump-knob': baseKnobDefaults.jump,
            'looper-stutter-knob': baseKnobDefaults.stutter,
            'looper-pitch-knob': baseKnobDefaults.pitch
        };
        this.layerOriginalAudio = new Map();
        this.layerProcessingState = new Map();
        this.layerProcessingTimers = new Map();
        this.layerHasProcessedAudio = Array(MAX_LAYERS).fill(false);
        this.layerRealtimeParamOverride = Array(MAX_LAYERS).fill(false);
        this.layerNeedsPostRestoreResync = Array(MAX_LAYERS).fill(false);
        this.layerReferenceSpanSamples = Array(MAX_LAYERS).fill(0);
        const baseSpeedDefault = this.looperKnobDefaults?.['looper-speed-knob'] ?? 0.5;
        this.masterWindowDefaults = { start: 0, end: 1, speed: baseSpeedDefault, spanSamples: 0, layerIndex: null, valid: false };
        this.masterDefaultsNeedCommit = false;
        this.layerPendingPhaseReminder = Array(MAX_LAYERS).fill(false);
        if (this.node?.port) {
            this.node.port.onmessage = (event) => this.handlePortMessage(event.data);
        }
        this.setupUi();
        this.statusTextEl = document.getElementById('looper-status-text');
        this.layerInfoEl = document.getElementById('looper-layer-info');
        this.layerMarkers = Array.from(document.querySelectorAll('.layer-marker'));
        this.syncUiState();
        this.updateLayerInfo();
        this.updateLayerMarkers();
        this.updateStatusText();
    }

    destroy() {
        this.state.pendingRequests.clear();
        this.layerProcessingTimers.forEach((timer) => clearTimeout(timer));
        this.layerProcessingTimers.clear();
        this.layerProcessingState.clear();
        this.layerOriginalAudio.clear();
        if (this.node?.port) {
            this.node.port.onmessage = null;
        }
    }

    resolvePhaseOffsetSamples(payload) {
        if (!payload || typeof payload !== 'object') {
            return 0; 
        }
        const phaseValue = payload.phaseOffsetSamples;
        if (typeof phaseValue === 'number' && Number.isFinite(phaseValue)) {
            return phaseValue;
        }
        const legacyValue = payload.startOffsetSamples;
        if (typeof legacyValue === 'number' && Number.isFinite(legacyValue)) {
            return legacyValue;
        }
        return 0;
    }

    resolveStartOffsetSamples(payload) {
        if (!payload || typeof payload !== 'object') {
            return 0;
        }
        const startValue = payload.startOffsetSamples;
        if (typeof startValue === 'number' && Number.isFinite(startValue)) {
            return startValue;
        }
        const fallbackPhase = payload.phaseOffsetSamples;
        if (typeof fallbackPhase === 'number' && Number.isFinite(fallbackPhase)) {
            return fallbackPhase;
        }
        return 0;
    }

    isApproximatelyEqual(a, b, epsilon = 0.0005) {
        if (!Number.isFinite(a) || !Number.isFinite(b)) {
            return false;
        }
        return Math.abs(a - b) < epsilon;
    }

    forceMasterPhaseReminder(layerIndex) {
        const masterIndex = this.getMasterLayerIndex();
        if (layerIndex == null || layerIndex !== masterIndex) {
            return;
        }
        if (!this.state.layers[layerIndex]?.active) {
            return;
        }
        this.layerPendingPhaseReminder[layerIndex] = false;
        this.layerNeedsPostRestoreResync[layerIndex] = false;
        this.remindLayerPhase(layerIndex, { forceCatchup: true });
        this.remindLinkedLayers(layerIndex);
    }

    maybeRemindMasterAfterWindowReset(layerIndex) {
        const masterIndex = this.getMasterLayerIndex();
        if (layerIndex == null || layerIndex !== masterIndex) {
            return;
        }
        if (!this.masterWindowDefaults.valid) {
            return;
        }
        const layer = this.state.layers[layerIndex];
        if (!layer?.active) {
            return;
        }
        const startDefault = this.masterWindowDefaults.start ?? 0;
        const endDefault = this.masterWindowDefaults.end ?? 1;
        const atStartDefault = this.isApproximatelyEqual(layer.knobValues.start, startDefault);
        const atEndDefault = this.isApproximatelyEqual(layer.knobValues.end, endDefault);
        if (atStartDefault && atEndDefault) {
            this.forceMasterPhaseReminder(layerIndex);
        }
    }

    // ---------- UI Wiring ----------
    setupUi() {
        this.buttons.record = this.wireButton('looper-record-button', () => this.toggleRecord());
        this.buttons.play = this.wireButton('looper-play-button', () => this.togglePlay());
        this.buttons.add = this.wireButton('looper-additive-button', () => this.toggleAddMode());
        this.buttons.delete = this.wireButton('looper-delete-button', () => this.handleDelete());
        this.buttons.undo = this.wireButton('looper-undo-button', () => this.handleUndo());
        this.buttons.redo = this.wireButton('looper-redo-button', () => this.handleRedo());
        this.layersKnob = this.initializeLayersKnob();
        this.initializeKnobs();
        this.syncKnobsToLayer();
    }

    wireButton(id, handler) {
        const original = document.getElementById(id);
        if (!original) return null;
        const clone = original.cloneNode(true);
        original.parentNode.replaceChild(clone, original);
        clone.addEventListener('click', (event) => {
            event.preventDefault();
            if (clone.classList.contains('disabled')) return;
            handler();
        });
        return clone;
    }

    initializeLayersKnob() {
        const knob = document.getElementById('looper-layers-knob');
        if (!knob) return null;
        const positions = [-150, -107.14, -64.29, -21.43, 21.43, 64.29, 107.14, 150];
        let index = this.state.selectedLayer;
        const applyRotation = () => {
            knob.style.transform = `rotate(${positions[index]}deg)`;
        };
        applyRotation();
        let dragging = false;
        let lastY = 0;
        let accumulator = 0;
        const threshold = 20;
        const updateIndex = (direction) => {
            index = Math.max(0, Math.min(MAX_LAYERS - 1, index + direction));
            this.state.selectedLayer = index;
            this.postSelectedLayer(index);
            applyRotation();
            this.syncKnobsToLayer();
            this.updateLayerInfo();
            this.updateLayerMarkers();
            this.updateLayerSelectorTooltip(index, { show: true });
        };
        const handleMove = (clientY) => {
            if (!dragging) return;
            const delta = lastY - clientY;
            lastY = clientY;
            accumulator += delta;
            if (accumulator >= threshold) {
                updateIndex(1);
                accumulator = 0;
            } else if (accumulator <= -threshold) {
                updateIndex(-1);
                accumulator = 0;
            }
        };
        knob.addEventListener('mousedown', (event) => {
            dragging = true;
            lastY = event.clientY;
            accumulator = 0;
            event.preventDefault();
        });
        document.addEventListener('mousemove', (event) => handleMove(event.clientY));
        document.addEventListener('mouseup', () => { dragging = false; });
        knob.addEventListener('touchstart', (event) => {
            if (event.touches.length !== 1) return;
            dragging = true;
            lastY = event.touches[0].clientY;
            accumulator = 0;
            event.preventDefault();
        }, { passive: false });
        document.addEventListener('touchmove', (event) => {
            if (!dragging || event.touches.length !== 1) return;
            handleMove(event.touches[0].clientY);
            event.preventDefault();
        }, { passive: false });
        document.addEventListener('touchend', () => { dragging = false; });
        this.postSelectedLayer(index);
        this.updateLayerSelectorTooltip(index, { show: false });
        return knob;
    }

    initializeKnobs() {
        this.knobs.volume = this.createKnob('looper-volume-knob', 'volume');
        this.knobs.start = this.createKnob('looper-start-knob', 'start');
        this.knobs.end = this.createKnob('looper-end-knob', 'end');
        this.knobs.lofi = this.createKnob('looper-lofi-knob', 'lofi');
        this.knobs.repeats = this.createKnob('looper-repeats-knob', 'repeats');
        this.knobs.speed = this.createKnob('looper-speed-knob', 'speed');
        this.knobs.filter = this.createKnob('looper-filter-knob', 'filter');
        this.knobs.dropouts = this.createKnob('looper-dropouts-knob', 'dropouts');
        this.knobs.jump = this.createKnob('looper-jump-knob', 'jump');
        this.knobs.stutter = this.createKnob('looper-stutter-knob', 'stutter');
        this.knobs.pitch = this.createKnob('looper-pitch-knob', 'pitch');
        this.applyStartEndDefaultTargets();
    }

    createKnob(id, param) {
        const node = document.getElementById(id);
        if (!node) return null;
        const defaults = this.looperKnobDefaults || {};
        return initializeKnob(node, (value) => {
            if (param) {
                this.updateLayerParam(param, value);
            }
            this.reportKnobValue(id, value);
            return value;
        }, defaults);
    }

    reportKnobValue(knobId, value) {
        if (!knobId || !this.integrationCallbacks?.onKnobValueChange) {
            return;
        }
        try {
            this.integrationCallbacks.onKnobValueChange(knobId, value);
        } catch (error) {
            console.warn('Looper integration callback failed for', knobId, error);
        }
    }

    ensureKnobTooltipElement(knobId) {
        if (!knobId) {
            return null;
        }
        const cached = this.knobTooltipElements.get(knobId);
        if (cached && cached.isConnected) {
            return cached;
        }
        const knob = document.getElementById(knobId);
        if (!knob) {
            return null;
        }
        const tooltip = document.createElement('div');
        tooltip.id = `${knobId}-tooltip`;
        tooltip.classList.add('tooltip', 'tooltip-bottom');
        const parent = knob.parentElement;
        if (parent && window.getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }
        (parent || document.body).appendChild(tooltip);
        tooltip.style.opacity = '0';
        tooltip.style.left = '50%';
        tooltip.style.transform = 'translateX(-50%)';
        this.knobTooltipElements.set(knobId, tooltip);
        return tooltip;
    }

    applyTooltipText(knobId, text, options = {}) {
        if (!knobId) return;
        const tooltip = this.ensureKnobTooltipElement(knobId);
        if (!tooltip) return;
        if (!text) {
            tooltip.textContent = '';
            tooltip.style.opacity = '0';
            return;
        }
        tooltip.textContent = text;
        tooltip.style.display = 'block';
        if (options.show !== false) {
            tooltip.style.opacity = '1';
        }
    }

    updateKnobTooltip(param, value, options = {}) {
        const knobId = this.paramToKnobId?.[param];
        if (!knobId) {
            return;
        }
        const text = this.formatKnobTooltipValue(param, value);
        if (!text) {
            this.applyTooltipText(knobId, '', { show: false });
            return;
        }
        this.applyTooltipText(knobId, text, options);
    }

    formatKnobTooltipValue(param, value) {
        switch (param) {
            case 'volume':
            case 'lofi':
            case 'repeats':
            case 'dropouts':
            case 'jump':
            case 'stutter':
                return this.formatPercent(value);
            case 'start':
            case 'end':
                return this.formatPercent(value, 1);
            case 'speed': {
                const speedRatio = this.mapSpeedNormalizedToActual(this.clamp01(value));
                if (!Number.isFinite(speedRatio)) {
                    return '';
                }
                return `${Math.round(speedRatio * 100)}%`;
            }
            case 'pitch': {
                const cents = Math.round(this.normalizedPitchToSemitones(this.clamp01(value)) * 100);
                const sign = cents > 0 ? '+' : '';
                return `${sign}${cents}c`;
            }
            case 'filter':
                return this.formatFilterTooltip(value);
            default:
                if (typeof value === 'number') {
                    return this.formatPercent(value);
                }
                return '';
        }
    }

    updateLayerSelectorTooltip(index, options = {}) {
        const knobId = 'looper-layers-knob';
        const safeIndex = typeof index === 'number' && index >= 0 ? index : (this.state.selectedLayer ?? 0);
        const label = `Layer ${safeIndex + 1}`;
        this.applyTooltipText(knobId, label, options);
    }

    formatFilterTooltip(value) {
        const mode = this.clamp01(value ?? 0.5);
        const nyquist = (this.audioCtx?.sampleRate || 44100) * 0.5;
        const lpMax = Math.min(FILTER_LP_MAX_HZ, nyquist * 0.99);
        const lpMin = Math.max(0.1, nyquist * FILTER_LP_MIN_RATIO);
        const hpMax = Math.max(FILTER_HP_MIN_HZ, nyquist * 0.999);
        const epsilon = 0.0005;
        if (mode < 0.5 - epsilon) {
            const strength = Math.min(1, (0.5 - mode) * 2);
            const cutoff = lpMin + (lpMax - lpMin) * Math.pow(1 - strength, 2);
            return `LP: ${this.formatFrequencyLabel(cutoff)}`;
        }
        if (mode > 0.5 + epsilon) {
            const strength = Math.min(1, (mode - 0.5) * 2);
            const cutoff = FILTER_HP_MIN_HZ + (hpMax - FILTER_HP_MIN_HZ) * Math.pow(strength, 2);
            return `HP: ${this.formatFrequencyLabel(cutoff)}`;
        }
        return `LP: ${this.formatFrequencyLabel(lpMax)}`;
    }

    formatFrequencyLabel(hz) {
        if (!Number.isFinite(hz) || hz <= 0) {
            return '';
        }
        if (hz >= 1000) {
            const value = hz / 1000;
            const digits = value >= 10 ? 1 : 2;
            return `${value.toFixed(digits)} kHz`;
        }
        return `${Math.round(hz)} Hz`;
    }

    formatPercent(value, decimals = 0) {
        const clamped = this.clamp01(Number.isFinite(value) ? value : 0);
        const percent = clamped * 100;
        if (decimals > 0) {
            return `${percent.toFixed(decimals)}%`;
        }
        return `${Math.round(percent)}%`;
    }

    clamp01(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
            return 0;
        }
        return Math.max(0, Math.min(1, numeric));
    }

    getMasterLayerIndex() {
        if (typeof this.state.primaryLayerIndex === 'number' && this.state.primaryLayerIndex >= 0) {
            return this.state.primaryLayerIndex;
        }
        const fallback = this.state.layers.findIndex((layer) => layer.active);
        return fallback === -1 ? null : fallback;
    }

    getActiveLayerCount() {
        return this.state.layers.reduce((count, layer) => (layer.active ? count + 1 : count), 0);
    }

    commitMasterLoopWindowDefaults() {
        const masterIndex = this.getMasterLayerIndex();
        if (masterIndex == null) {
            return false;
        }
        const layer = this.state.layers[masterIndex];
        if (!layer?.active) {
            return false;
        }
        const start = layer.knobValues?.start ?? 0;
        const end = layer.knobValues?.end ?? 1;
        const speed = layer.knobValues?.speed ?? (this.looperKnobDefaults?.['looper-speed-knob'] ?? 0.5);
        const spanSamples = layer.lengthSamples || 0;
        this.masterWindowDefaults = {
            start,
            end,
            speed,
            spanSamples,
            layerIndex: masterIndex,
            valid: true
        };
        this.layerReferenceSpanSamples[masterIndex] = spanSamples;
        this.applyStartEndDefaultTargets();
        return true;
    }

    applyStartEndDefaultTargets() {
        const startKnob = this.knobs.start;
        const endKnob = this.knobs.end;
        const speedKnob = this.knobs.speed;
        if (!startKnob?.setDefaultValue || !endKnob?.setDefaultValue) {
            return;
        }
        const selected = this.state.selectedLayer;
        const useMasterDefaults = this.masterWindowDefaults.valid
            && selected === this.masterWindowDefaults.layerIndex;
        const startDefault = useMasterDefaults ? this.masterWindowDefaults.start : 0;
        const endDefault = useMasterDefaults ? this.masterWindowDefaults.end : 1;
        const baseSpeedDefault = this.looperKnobDefaults?.['looper-speed-knob'] ?? 0.5;
        const speedDefault = useMasterDefaults && Number.isFinite(this.masterWindowDefaults.speed)
            ? this.masterWindowDefaults.speed
            : baseSpeedDefault;
        startKnob.setDefaultValue(startDefault);
        endKnob.setDefaultValue(endDefault);
        speedKnob?.setDefaultValue(speedDefault);
    }

    handlePrimaryLayerIndexChange(newIndex) {
        const baseSpeedDefault = this.looperKnobDefaults?.['looper-speed-knob'] ?? 0.5;
        if (typeof newIndex !== 'number' || newIndex < 0) {
            this.masterWindowDefaults = { start: 0, end: 1, speed: baseSpeedDefault, spanSamples: 0, layerIndex: null, valid: false };
            this.masterDefaultsNeedCommit = false;
            this.applyStartEndDefaultTargets();
            return;
        }
        if (this.masterWindowDefaults.layerIndex !== newIndex) {
            this.masterWindowDefaults = { start: 0, end: 1, speed: baseSpeedDefault, spanSamples: 0, layerIndex: newIndex, valid: false };
            this.masterDefaultsNeedCommit = false;
            this.commitMasterLoopWindowDefaults();
            return;
        }
        if (!this.masterWindowDefaults.valid) {
            this.commitMasterLoopWindowDefaults();
        } else {
            this.applyStartEndDefaultTargets();
        }
    }

    // ---------- Parameter Routing ----------
    updateLayerParam(param, value) {
        const layerIndex = this.state.selectedLayer;
        const layer = this.state.layers[layerIndex];
        const knobs = layer.knobValues;
        knobs[param] = value;
        this.updateKnobTooltip(param, knobs[param]);
        if (param === 'start' && value >= knobs.end - 0.01) {
            knobs.end = Math.min(1, value + 0.01);
            this.knobs.end?.setValue(knobs.end, false);
            this.updateKnobTooltip('end', knobs.end, { show: false });
            this.reportKnobValue(this.paramToKnobId?.end, knobs.end);
        }
        if (param === 'end' && value <= knobs.start + 0.01) {
            knobs.start = Math.max(0, value - 0.01);
            this.knobs.start?.setValue(knobs.start, false);
            this.updateKnobTooltip('start', knobs.start, { show: false });
            this.reportKnobValue(this.paramToKnobId?.start, knobs.start);
        }
        if ((param === 'start' || param === 'end') && layerIndex === this.getMasterLayerIndex()) {
            this.masterDefaultsNeedCommit = true;
        }
        if (param === 'speed' || param === 'pitch') {
            this.layerRealtimeParamOverride[layerIndex] = !!this.layerHasProcessedAudio[layerIndex];
        }
        this.sendLayerParams(layerIndex);
        if ((param === 'start' || param === 'end')) {
            this.maybeRemindMasterAfterWindowReset(layerIndex);
        }
        const knobId = this.paramToKnobId?.[param];
        if (knobId) {
            this.reportKnobValue(knobId, knobs[param]);
        }
        if (param === 'speed' && this.state.layers[layerIndex]?.active) {
            const speedKnobDefault = this.knobs.speed?.getDefaultValue?.();
            const normalizedValue = value ?? layer.knobValues.speed ?? 0.5;
            const isAtDefault = typeof speedKnobDefault === 'number'
                ? Math.abs(normalizedValue - speedKnobDefault) < 0.0005
                : Math.abs(this.mapSpeedNormalizedToActual(normalizedValue) - 1) < 0.0005;
            if (isAtDefault) {
                this.layerPendingPhaseReminder[layerIndex] = true;
                if (!this.layerHasProcessedAudio[layerIndex]) {
                    this.remindLayerPhase(layerIndex);
                }
            } else {
                this.layerPendingPhaseReminder[layerIndex] = false;
            }
            const masterIndex = this.getMasterLayerIndex();
            if (layerIndex === masterIndex && this.getActiveLayerCount() <= 1) {
                const baseSpeedDefault = this.looperKnobDefaults?.['looper-speed-knob'] ?? 0.5;
                const resolvedSpeed = Number.isFinite(value) ? value : baseSpeedDefault;
                if (!this.masterWindowDefaults.valid || this.masterWindowDefaults.layerIndex !== masterIndex) {
                    this.masterWindowDefaults = {
                        start: layer.knobValues?.start ?? 0,
                        end: layer.knobValues?.end ?? 1,
                        speed: resolvedSpeed,
                        spanSamples: this.masterWindowDefaults.spanSamples || (layer.lengthSamples || 0),
                        layerIndex: masterIndex,
                        valid: true
                    };
                } else {
                    this.masterWindowDefaults.speed = resolvedSpeed;
                    const latestSpan = layer.lengthSamples || this.layerReferenceSpanSamples[layerIndex] || this.masterWindowDefaults.spanSamples;
                    if (latestSpan > 0) {
                        this.masterWindowDefaults.spanSamples = latestSpan;
                        this.layerReferenceSpanSamples[layerIndex] = latestSpan;
                    }
                }
                this.applyStartEndDefaultTargets();
            } else if (layerIndex === masterIndex) {
                const targetSpeed = Number.isFinite(this.masterWindowDefaults.speed)
                    ? this.masterWindowDefaults.speed
                    : (this.looperKnobDefaults?.['looper-speed-knob'] ?? 0.5);
                const returningToMasterDefault = Math.abs(normalizedValue - targetSpeed) < 0.0005;
                if (returningToMasterDefault && this.getActiveLayerCount() > 1) {
                    this.reprocessLinkedLayers(masterIndex);
                }
            }
        } else if (param === 'speed') {
            this.layerPendingPhaseReminder[layerIndex] = false;
        }
        if ((param === 'speed' || param === 'pitch') && this.state.layers[layerIndex]?.active) {
            this.queueLayerProcessing(layerIndex, { debounce: true });
        }
    }

    postSelectedLayer(index) {
        if (!this.node?.port || typeof index !== 'number') return;
        this.node.port.postMessage({ type: 'set-selected-layer', index });
    }

    setSelectedLayer(index) {
        if (typeof index !== 'number' || index < 0 || index >= MAX_LAYERS) return;
        if (this.state.selectedLayer === index) return;
        this.state.selectedLayer = index;
        this.postSelectedLayer(index);
        this.updateLayerSelectorTooltip(index, { show: false });
        this.syncKnobsToLayer();
        this.updateLayerInfo();
        this.updateLayerMarkers();
        this.applyStartEndDefaultTargets();
    }

    mapKnobValuesToParams(knobs) {
        const speedActual = this.mapSpeedNormalizedToActual(knobs.speed);
        const pitchSemitones = this.normalizedPitchToSemitones(knobs.pitch);
        const pitchFactor = Math.pow(2, pitchSemitones / 12);
        return {
            volume: this.mapVolume(knobs.volume),
            start: knobs.start,
            end: knobs.end,
            startNorm: knobs.start,
            endNorm: knobs.end,
            repeats: knobs.repeats,
            lofi: knobs.lofi,
            filter: knobs.filter,
            dropouts: knobs.dropouts,
            jump: knobs.jump,
            stutter: knobs.stutter,
            speed: knobs.speed,
            speedActual,
            pitch: knobs.pitch,
            pitchSemitones,
            pitchFactor
        };
    }

    sendLayerParams(layerIndex) {
        if (layerIndex == null || layerIndex < 0 || layerIndex >= MAX_LAYERS) return;
        const layer = this.state.layers[layerIndex];
        if (!layer) return;
        let params = this.mapKnobValuesToParams(layer.knobValues);
        const shouldNeutralize = this.layerHasProcessedAudio[layerIndex] && !this.layerRealtimeParamOverride[layerIndex];
        if (shouldNeutralize) {
            params = {
                ...params,
                speed: 0.5,
                speedActual: 1,
                pitch: 0.5,
                pitchSemitones: 0,
                pitchFactor: 1
            };
        }
        this.node.port.postMessage({ type: 'set-layer-params', index: layerIndex, params });
    }

    remindLayerPhase(layerIndex, options = {}) {
        if (!this.node?.port) return;
        if (typeof layerIndex !== 'number' || layerIndex < 0 || layerIndex >= MAX_LAYERS) {
            return;
        }
        const layer = this.state.layers[layerIndex];
        if (!layer?.active) {
            return;
        }
        const masterIndex = this.getMasterLayerIndex();
        const isMasterLayer = layerIndex === masterIndex;
        const forceCatchup = !!options.forceCatchup;
        const hasPhase = Number.isFinite(layer.phaseOffsetSamples);
        const hasStart = Number.isFinite(layer.startOffsetSamples);
        const phaseOffset = hasPhase ? layer.phaseOffsetSamples : 0;
        const startOffset = hasStart ? layer.startOffsetSamples : (hasPhase ? layer.phaseOffsetSamples : 0);
        this.node.port.postMessage({
            type: 'resync-layer-phase',
            index: layerIndex,
            isMaster: isMasterLayer,
            forceCatchup: forceCatchup && isMasterLayer,
            startOffsetSamples: startOffset,
            phaseOffsetSamples: phaseOffset,
            relativeToWindow: true
        });
    }

    remindLinkedLayers(masterIndex) {
        for (let i = 0; i < MAX_LAYERS; i++) {
            if (i === masterIndex) continue;
            const layer = this.state.layers[i];
            if (!layer?.active) continue;
            this.remindLayerPhase(i, { forceCatchup: false });
        }
    }

    reprocessLinkedLayers(masterIndex) {
        for (let i = 0; i < MAX_LAYERS; i++) {
            if (i === masterIndex) continue;
            const layer = this.state.layers[i];
            if (!layer?.active) continue;
            this.queueLayerProcessing(i);
        }
    }

    mapVolume(normalized) {
        const value = Math.max(0, Math.min(1, normalized ?? 0));
        if (value <= VOLUME_LINEAR_THRESHOLD) {
            const scaled = value / Math.max(0.0001, VOLUME_LINEAR_THRESHOLD);
            return VOLUME_MIN + scaled * (VOLUME_CORE_MAX - VOLUME_MIN);
        }
        const extra = (value - VOLUME_LINEAR_THRESHOLD) / Math.max(0.0001, 1 - VOLUME_LINEAR_THRESHOLD);
        return VOLUME_CORE_MAX + extra * (VOLUME_EXTENDED_MAX - VOLUME_CORE_MAX);
    }

    normalizeVolume(actual) {
        const clamped = Math.max(VOLUME_MIN, Math.min(VOLUME_EXTENDED_MAX, actual ?? VOLUME_MIN));
        if (clamped <= VOLUME_CORE_MAX) {
            const span = VOLUME_CORE_MAX - VOLUME_MIN;
            if (span <= 0) return 0;
            const linear = (clamped - VOLUME_MIN) / span;
            return Math.max(0, Math.min(1, linear * VOLUME_LINEAR_THRESHOLD));
        }
        const extraSpan = VOLUME_EXTENDED_MAX - VOLUME_CORE_MAX;
        if (extraSpan <= 0) return 1;
        const extra = (clamped - VOLUME_CORE_MAX) / extraSpan;
        return Math.max(0, Math.min(1, VOLUME_LINEAR_THRESHOLD + extra * (1 - VOLUME_LINEAR_THRESHOLD)));
    }

    normalizeSpeed(actual) {
        if (!Number.isFinite(actual)) {
            return 0.5;
        }
        if (actual <= 1) {
            const span = 1 - SPEED_MIN;
            if (span <= 0) return 0;
            const t = (actual - SPEED_MIN) / span;
            return Math.max(0, Math.min(0.5, 0.5 * t));
        }
        const upperSpan = SPEED_MAX - 1;
        if (upperSpan <= 0) return 1;
        const t = (actual - 1) / upperSpan;
        return 0.5 + Math.max(0, Math.min(0.5, 0.5 * t));
    }

    mapSpeedNormalizedToActual(value) {
        const clamped = Math.max(0, Math.min(1, value));
        if (clamped <= 0.5) {
            const t = clamped / 0.5;
            return SPEED_MIN + (1 - SPEED_MIN) * t;
        }
        const t = (clamped - 0.5) / 0.5;
        return 1 + (SPEED_MAX - 1) * t;
    }

    normalizePitch(semitones) {
        return Math.max(0, Math.min(1, (semitones - PITCH_MIN) / (PITCH_MAX - PITCH_MIN)));
    }

    normalizedPitchToSemitones(value) {
        const clamped = Math.max(0, Math.min(1, value ?? 0.5));
        return PITCH_MIN + clamped * (PITCH_MAX - PITCH_MIN);
    }

    // ---------- Worklet Messages ----------
    handlePortMessage(data) {
        if (!data || typeof data !== 'object') return;
        switch (data.type) {
            case 'record-started':
                this.state.captureSessionActive = true;
                this.state.awaitingCaptureRestart = false;
                if (typeof data.layerIndex === 'number') {
                    this.state.currentRecordingLayer = data.layerIndex;
                }
                if (typeof data.captureMode === 'string') {
                    this.state.currentCaptureMode = data.captureMode;
                }
                if (typeof data.locked === 'boolean') {
                    this.state.lockedRecording = data.locked;
                }
                this.setPendingStopRequest(false);
                if (this.state.feedArmQueued && this.state.queuedFeedOptions) {
                    this.setRecordFeedState(this.state.queuedFeedOptions);
                }
                this.setRecordActive(this.state.recording || this.state.autoLatch);
                break;
            case 'record-complete':
                this.state.recording = false;
                this.state.captureSessionActive = false;
                this.state.awaitingCaptureRestart = !!data.autoRestart;
                this.setPendingStopRequest(false);
                this.state.feedArmQueued = false;
                this.state.queuedFeedOptions = null;
                this.state.currentRecordingLayer = null;
                this.state.lockedRecording = false;
                
                this.updateLayerMetadata(data.layerIndex, data.lengthSamples);
                const layer = this.state.layers[data.layerIndex];
                if (layer) {
                    const phaseOffset = this.resolvePhaseOffsetSamples(data);
                    const startOffset = this.resolveStartOffsetSamples(data);
                    layer.phaseOffsetSamples = phaseOffset;
                    layer.startOffsetSamples = startOffset;
                }
                this.sendLayerParams(data.layerIndex);
                this.queueLayerProcessing(data.layerIndex);
                
                // Always start playback after recording completes
                this.setPlaying(true);
                
                this.handleAutoRecordingComplete();
                if (!this.masterWindowDefaults.valid || this.masterDefaultsNeedCommit) {
                    if (this.commitMasterLoopWindowDefaults()) {
                        this.masterDefaultsNeedCommit = false;
                    }
                }
                this.layerOriginalAudio.delete(data.layerIndex);
                break;
            case 'record-cancelled':
                this.state.recording = false;
                this.state.currentRecordingLayer = null;
                this.state.lockedRecording = false;
                this.setPendingStopRequest(false);
                this.state.captureSessionActive = false;
                this.state.awaitingCaptureRestart = false;
                this.state.feedArmQueued = false;
                this.state.queuedFeedOptions = null;
                this.setRecordActive(false);
                break;
            case 'layer-cleared':
                this.resetLayerState(data.layerIndex);
                break;
            case 'layer-restored':
                if (typeof data.index === 'number') {
                    this.state.layers[data.index].active = true;
                    if (typeof data.lengthSamples === 'number') {
                        this.updateLayerMetadata(data.index, data.lengthSamples);
                    } else {
                        this.recomputeLongestLoop();
                    }
                    const phaseOffset = this.resolvePhaseOffsetSamples(data);
                    const startOffset = this.resolveStartOffsetSamples(data);
                    this.state.layers[data.index].phaseOffsetSamples = phaseOffset;
                    this.state.layers[data.index].startOffsetSamples = startOffset;
                    if (typeof data.referenceSpanSamples === 'number' && data.referenceSpanSamples > 0) {
                        this.layerReferenceSpanSamples[data.index] = Math.floor(data.referenceSpanSamples);
                        if (data.index === this.masterWindowDefaults.layerIndex
                            && (!this.masterWindowDefaults.valid || this.masterDefaultsNeedCommit)) {
                            this.masterWindowDefaults.spanSamples = Math.floor(data.referenceSpanSamples);
                        }
                    }
                    if (this.layerNeedsPostRestoreResync[data.index]) {
                        const masterIndex = this.getMasterLayerIndex();
                        const isMaster = data.index === masterIndex;
                        this.remindLayerPhase(data.index, { forceCatchup: isMaster });
                        if (isMaster) {
                            this.remindLinkedLayers(data.index);
                        }
                        this.layerNeedsPostRestoreResync[data.index] = false;
                    }
                }
                break;
            case 'layer-data':
                this.resolveLayerDataRequest(data);
                break;
            case 'loop-reference':
                this.handleLoopReferenceUpdate(data);
                break;
            case 'loop-head':
                this.handleLoopHead();
                break;
            default:
                break;
        }
        this.syncUiState();
    }

    updateLayerMetadata(layerIndex, lengthSamples) {
        if (typeof layerIndex !== 'number' || layerIndex < 0 || layerIndex >= MAX_LAYERS) return;
        const layer = this.state.layers[layerIndex];
        layer.active = true;
        layer.lengthSamples = lengthSamples || 0;
        layer.lengthSeconds = layer.lengthSamples / (this.audioCtx?.sampleRate || 44100);
        this.state.longestLoopSamples = Math.max(this.state.longestLoopSamples, layer.lengthSamples);
        this.updateLayerInfo();
        this.updateLayerMarkers();
    }

    handleLoopReferenceUpdate(payload) {
        if (!payload || typeof payload.samples !== 'number') {
            this.state.loopReferenceSamples = 0;
            if (!this.state.layers.some((layer) => layer.active)) {
                this.state.longestLoopSamples = 0;
            }
            return;
        }
        this.state.loopReferenceSamples = Math.max(0, Math.floor(payload.samples));
        this.state.longestLoopSamples = this.state.loopReferenceSamples || this.state.longestLoopSamples;
        if (typeof payload.index === 'number') {
            this.state.primaryLayerIndex = payload.index;
        }
        this.handlePrimaryLayerIndexChange(this.state.primaryLayerIndex);
    }

    resetLayerState(layerIndex) {
        if (typeof layerIndex !== 'number' || layerIndex < 0 || layerIndex >= MAX_LAYERS) return;
        this.state.layers[layerIndex] = defaultLayerState();
        this.layerReferenceSpanSamples[layerIndex] = 0;
        if (layerIndex === this.state.selectedLayer) {
            this.syncKnobsToLayer();
        }
        this.recomputeLongestLoop();
        this.updateLayerInfo();
        this.updateLayerMarkers();
        this.clearLayerProcessingState(layerIndex);
        const baseSpeedDefault = this.looperKnobDefaults?.['looper-speed-knob'] ?? 0.5;
        if (layerIndex === this.masterWindowDefaults.layerIndex) {
            this.masterWindowDefaults = { start: 0, end: 1, speed: baseSpeedDefault, spanSamples: 0, layerIndex: null, valid: false };
            this.masterDefaultsNeedCommit = false;
            this.applyStartEndDefaultTargets();
        }
    }

    recomputeLongestLoop() {
        this.state.longestLoopSamples = this.state.layers.reduce((max, layer) => {
            return layer.active && layer.lengthSamples ? Math.max(max, layer.lengthSamples) : max;
        }, 0);
        if (this.state.longestLoopSamples === 0) {
            this.state.autoLatch = false;
            this.state.waitingForLoopHead = false;
        }
        this.updateStatusText();
        this.updateLayerMarkers();
    }

    getReferenceLoopSamples() {
        if (this.state.loopReferenceSamples > 0) {
            return this.state.loopReferenceSamples;
        }
        const first = this.state.layers.find((layer) => layer.active && layer.lengthSamples > 0);
        return first?.lengthSamples || 0;
    }

    // ---------- Transport + Buttons ----------
    togglePlay() {
        this.setPlaying(!this.state.playing);
    }

    setPlaying(active) {
        this.state.playing = !!active;
        this.node.port.postMessage({ type: 'set-play', value: this.state.playing });
        this.syncUiState();
    }

    toggleAddMode() {
        if (this.isAddDisabled()) return;
        this.state.addMode = !this.state.addMode;
        this.node.port.postMessage({ type: 'set-add-mode', value: this.state.addMode });
        this.syncUiState();
    }

    toggleRecord() {
        // If currently recording, stop it
        if (this.state.recording) {
            this.stopCurrentRecording();
            return;
        }

        // If in add mode, use add-mode flow
        if (this.state.addMode) {
            this.handleAddModeRecord();
            return;
        }

        // Otherwise start recording on selected layer
        this.startManualRecording();
    }

    stopCurrentRecording() {
        this.state.autoLatch = false;
        if (this.state.lockedRecording) {
            // For aligned recordings, flag the pending stop and wait for loop completion
            this.setPendingStopRequest(true);
            this.updateStatusText();
            return;
        }

        // For free recordings, stop immediately
        this.node.port.postMessage({ type: 'stop-record', commit: true });
        this.state.recording = false;
        this.setPendingStopRequest(false);
        this.setRecordActive(false);
        this.updateStatusText();
    }

    handleAddModeRecord() {
        const referenceSamples = this.getReferenceLoopSamples();
        
        // No reference loop yet - record first layer normally
        if (!referenceSamples) {
            this.startManualRecording();
            return;
        }

        // Find next available layer
        const targetLayer = this.findNextAvailableLayer();
        if (targetLayer === -1) {
            // All layers full - should not happen if Add button is disabled properly
            return;
        }

        // Switch to target layer and start recording
        this.setSelectedLayer(targetLayer);
        this.state.autoLatch = true;
        this.setPlaying(true);
        this.beginQuantizedRecording(targetLayer, {
            referenceSamples,
            autoAdvance: true
        });
    }

    prepareLayerUndo(layerIndex) {
        if (layerIndex == null || layerIndex < 0 || layerIndex >= MAX_LAYERS) {
            return;
        }
        this.clearLayerProcessingState(layerIndex, { preserveOriginal: true });
        const snapshotPromise = this.captureLayerSnapshot(layerIndex);
        snapshotPromise
            .then((snapshot) => {
                if (snapshot) {
                    this.pushUndo({ type: 'restore', layerIndex, snapshot });
                } else {
                    this.pushUndo({ type: 'clear', layerIndex });
                }
            })
            .catch((error) => {
                console.error('Failed to capture layer snapshot before record:', error);
            });
    }

    setRecordActive(active) {
        this.buttons.record?.classList.toggle('active', !!active);
        this.updateRecordButtonDisplay();
        this.updateStatusText();
        this.updateLayerMarkers();
    }

    setPendingStopRequest(active) {
        this.state.pendingStopRequest = !!active;
        this.updateRecordButtonDisplay();
    }

    setRecordFeedState(options = {}) {
        if (!this.node?.port) return;
        if (!this.state.captureSessionActive) {
            if (typeof options.armed === 'boolean') {
                this.state.feedArmQueued = true;
                this.state.queuedFeedOptions = {
                    armed: options.armed,
                    captureMode: options.captureMode ?? this.state.currentCaptureMode
                };
            }
            return;
        }
        const payload = { type: 'set-record-feed' };
        if (typeof options.armed === 'boolean') {
            payload.armed = options.armed;
        }
        const mode = options.captureMode ?? this.state.currentCaptureMode;
        if (mode) {
            payload.captureMode = mode;
        }
        this.node.port.postMessage(payload);
        this.state.feedArmQueued = false;
        this.state.queuedFeedOptions = null;
    }

    resolveManualRecordTarget() {
        const selected = this.state.selectedLayer;
        const layer = this.state.layers[selected];
        if (layer == null) {
            return null;
        }
        return {
            layerIndex: selected,
            clearFirst: !!layer.active
        };
    }

    startManualRecording() {
        const targetInfo = this.resolveManualRecordTarget();
        if (!targetInfo) {
            return;
        }
        
        const targetLayer = targetInfo.layerIndex;
        this.prepareLayerUndo(targetLayer);
        
        // Clear layer if it has existing audio (do-over)
        if (targetInfo.clearFirst) {
            this.node.port.postMessage({ type: 'clear-layer', index: targetLayer });
            this.resetLayerState(targetLayer);
        }
        
        const referenceSamples = this.getReferenceLoopSamples();
        const payload = referenceSamples > 0
            ? {
                  type: 'begin-record',
                  layerIndex: targetLayer,
                  mode: 'aligned',
                  referenceSamples,
                  targetSamples: referenceSamples,
                  captureMode: targetInfo.clearFirst ? 'manual' : 'add',
                  captureMuted: false
              }
            : {
                  type: 'begin-record',
                  layerIndex: targetLayer,
                  mode: 'free',
                  captureMode: 'manual',
                  captureMuted: false
              };
        
        this.node.port.postMessage(payload);
        this.state.recording = true;
        this.state.lockedRecording = referenceSamples > 0;
        this.setPendingStopRequest(false);
        this.state.currentRecordingLayer = targetLayer;
        this.state.captureSessionActive = false;
        this.state.awaitingCaptureRestart = false;
        this.setRecordActive(true);
        this.setPlaying(true);
        this.updateStatusText();
        this.updateLayerMarkers();
    }

    beginQuantizedRecording(layerIndex, options = {}) {
        if (layerIndex == null || layerIndex === -1) return;
        
        this.prepareLayerUndo(layerIndex);
        const referenceSamples = options.referenceSamples || this.getReferenceLoopSamples();
        
        const payload = {
            type: 'begin-record',
            layerIndex,
            mode: 'aligned',
            referenceSamples,
            targetSamples: referenceSamples,
            captureMode: 'manual',
            captureMuted: false
        };
        
        this.node.port.postMessage(payload);
        this.state.recording = true;
        this.state.lockedRecording = true;
        this.setPendingStopRequest(false);
        this.state.currentRecordingLayer = layerIndex;
        this.state.captureSessionActive = false;
        this.state.awaitingCaptureRestart = false;
        this.setRecordActive(true);
        this.updateStatusText();
        this.updateLayerMarkers();
    }

    handleLoopHead() {
        if (!this.state.autoLatch || this.state.recording) return;
        if (this.state.waitingForLoopHead) {
            const target = this.nextAutoLayer ?? this.findNextAvailableLayer();
            if (target === -1) {
                this.state.autoLatch = false;
                this.setRecordActive(false);
                this.updateStatusText();
                this.updateLayerMarkers();
                return;
            }
            this.beginQuantizedRecording(target, { startMode: 'loop' });
            this.state.waitingForLoopHead = false;
            this.updateStatusText();
            this.updateLayerMarkers();
        }
    }

    handleAutoRecordingComplete() {
        // Not in add mode - just stop
        if (!this.state.autoLatch) {
            this.setRecordActive(false);
            this.updateStatusText();
            this.updateLayerMarkers();
            return;
        }
        
        // Find next layer
        const next = this.findNextAvailableLayer();
        if (next === -1) {
            // All layers full - stop add mode
            this.state.autoLatch = false;
            this.setRecordActive(false);
            this.updateStatusText();
            this.updateLayerMarkers();
            return;
        }
        
        // Auto-advance to next layer and start recording immediately
        this.setSelectedLayer(next);
        const referenceSamples = this.getReferenceLoopSamples();
        this.beginQuantizedRecording(next, { referenceSamples });
    }

    findNextAvailableLayer(startIndex = 0) {
        if (!Number.isFinite(startIndex)) {
            startIndex = 0;
        }
        const normalized = ((Math.floor(startIndex) % MAX_LAYERS) + MAX_LAYERS) % MAX_LAYERS;
        for (let offset = 0; offset < MAX_LAYERS; offset++) {
            const index = (normalized + offset) % MAX_LAYERS;
            if (!this.state.layers[index].active) {
                return index;
            }
        }
        return -1;
    }

    // ---------- Undo / Redo ----------
    handleDelete() {
        const index = this.state.selectedLayer;
        if (!this.state.layers[index].active) return;
        this.captureLayerSnapshot(index).then((snapshot) => {
            if (!snapshot) return;
            this.pushUndo({ type: 'restore', layerIndex: index, snapshot });
            this.node.port.postMessage({ type: 'clear-layer', index });
            this.clearLayerProcessingState(index);
        });
    }

    handleUndo() {
        const entry = this.state.undoStack.pop();
        if (!entry) return;
        this.captureLayerSnapshot(entry.layerIndex).then((redoSnapshot) => {
            this.applyUndoEntry(entry);
            if (redoSnapshot) {
                this.state.redoStack.push({ type: 'restore', layerIndex: entry.layerIndex, snapshot: redoSnapshot });
            } else {
                this.state.redoStack.push({ type: 'clear', layerIndex: entry.layerIndex });
            }
        });
    }

    handleRedo() {
        const entry = this.state.redoStack.pop();
        if (!entry) return;
        this.captureLayerSnapshot(entry.layerIndex).then((undoSnapshot) => {
            this.applyUndoEntry(entry);
            if (undoSnapshot) {
                this.state.undoStack.push({ type: 'restore', layerIndex: entry.layerIndex, snapshot: undoSnapshot });
            } else {
                this.state.undoStack.push({ type: 'clear', layerIndex: entry.layerIndex });
            }
        });
    }

    applyUndoEntry(entry) {
        if (entry.type === 'restore') {
            const { layerIndex, snapshot } = entry;
            const hasPhase = Number.isFinite(snapshot.phaseOffsetSamples);
            const hasStart = Number.isFinite(snapshot.startOffsetSamples);
            const phaseOffset = hasPhase ? snapshot.phaseOffsetSamples : (hasStart ? snapshot.startOffsetSamples : 0);
            const startOffset = hasStart ? snapshot.startOffsetSamples : phaseOffset;
            this.node.port.postMessage({
                type: 'restore-layer',
                index: layerIndex,
                bufferL: snapshot.bufferL,
                bufferR: snapshot.bufferR,
                params: snapshot.params,
                takes: snapshot.takes,
                startOffsetSamples: startOffset,
                phaseOffsetSamples: phaseOffset
            });
            this.layerOriginalAudio.set(layerIndex, {
                bufferL: snapshot.bufferL.slice(),
                bufferR: (snapshot.bufferR ? snapshot.bufferR : snapshot.bufferL).slice()
            });
            this.layerHasProcessedAudio[layerIndex] = false;
            this.layerRealtimeParamOverride[layerIndex] = false;
            const layer = this.state.layers[layerIndex];
            layer.active = true;
            layer.knobValues = { ...snapshot.knobValues };
            layer.phaseOffsetSamples = phaseOffset;
            layer.startOffsetSamples = startOffset;
            this.sendLayerParams(layerIndex);
            if (layerIndex === this.state.selectedLayer) {
                this.syncKnobsToLayer();
            }
            return;
        }

        if (entry.type === 'clear') {
            const layerIndex = entry.layerIndex;
            this.node.port.postMessage({ type: 'clear-layer', index: layerIndex });
            this.resetLayerState(layerIndex);
        }
    }

    pushUndo(entry) {
        this.state.undoStack.push(entry);
        if (this.state.undoStack.length > 32) {
            this.state.undoStack.shift();
        }
        this.state.redoStack.length = 0;
    }

    captureLayerSnapshot(layerIndex) {
        const layer = this.state.layers[layerIndex];
        if (!layer.active) {
            return Promise.resolve(null);
        }
        return this.requestLayerData(layerIndex).then((payload) => {
            if (!payload || payload.empty) return null;
            const layerState = this.state.layers[layerIndex];
            const snapshotPhaseOffset = this.resolvePhaseOffsetSamples(payload);
            const snapshotStartOffset = this.resolveStartOffsetSamples(payload);
            if (layerState) {
                layerState.phaseOffsetSamples = snapshotPhaseOffset;
                layerState.startOffsetSamples = snapshotStartOffset;
            }
            const knobValues = {
                volume: this.normalizeVolume(payload.params?.volume ?? this.mapVolume(layer.knobValues.volume)),
                start: payload.params?.startNorm ?? layer.knobValues.start,
                end: payload.params?.endNorm ?? layer.knobValues.end,
                repeats: payload.params?.repeats ?? layer.knobValues.repeats,
                lofi: payload.params?.lofi ?? layer.knobValues.lofi,
                filter: payload.params?.filter ?? layer.knobValues.filter,
                dropouts: payload.params?.dropouts ?? layer.knobValues.dropouts,
                jump: payload.params?.jump ?? layer.knobValues.jump,
                stutter: payload.params?.stutter ?? layer.knobValues.stutter,
                speed: this.normalizeSpeed(
                    typeof payload.params?.speedActual === 'number'
                        ? payload.params.speedActual
                        : this.mapSpeedNormalizedToActual(layer.knobValues.speed)
                ),
                pitch: this.normalizePitch(payload.params?.pitchSemitones ?? (PITCH_MIN + layer.knobValues.pitch * (PITCH_MAX - PITCH_MIN)))
            };
            return {
                bufferL: payload.bufferL,
                bufferR: payload.bufferR,
                knobValues,
                params: this.mapKnobValuesToParams(knobValues),
                startOffsetSamples: snapshotStartOffset,
                phaseOffsetSamples: snapshotPhaseOffset,
                takes: Array.isArray(payload.takes)
                    ? payload.takes.map((take) => ({ bufferL: take.bufferL, bufferR: take.bufferR }))
                    : null
            };
        });
    }

    requestLayerData(layerIndex) {
        const requestId = ++this.state.requestId;
        return new Promise((resolve) => {
            this.state.pendingRequests.set(requestId, resolve);
            this.node.port.postMessage({ type: 'export-layer', index: layerIndex, requestId });
        });
    }

    resolveLayerDataRequest(payload) {
        const resolver = this.state.pendingRequests.get(payload.requestId);
        if (resolver) {
            this.state.pendingRequests.delete(payload.requestId);
            resolver(payload);
        }
    }

    queueLayerProcessing(layerIndex, options = {}) {
        if (!this.node?.port) return;
        if (typeof layerIndex !== 'number' || layerIndex < 0 || layerIndex >= MAX_LAYERS) return;
        if (!this.state.layers[layerIndex]?.active) return;
        if (options.debounce) {
            const delay = typeof options.delay === 'number' ? options.delay : 250;
            const existing = this.layerProcessingTimers.get(layerIndex);
            if (existing) {
                clearTimeout(existing);
            }
            const timer = setTimeout(() => {
                this.layerProcessingTimers.delete(layerIndex);
                this.queueLayerProcessing(layerIndex);
            }, delay);
            this.layerProcessingTimers.set(layerIndex, timer);
            return;
        }
        const tracker = this.layerProcessingState.get(layerIndex) || { running: false, pending: false };
        if (tracker.running) {
            tracker.pending = true;
            this.layerProcessingState.set(layerIndex, tracker);
            return;
        }
        tracker.running = true;
        tracker.pending = false;
        this.layerProcessingState.set(layerIndex, tracker);
        this.setLayerProcessingFlag(layerIndex, true);
        this.processLayerAudio(layerIndex)
            .catch((error) => console.error('Looper layer processing failed:', error))
            .finally(() => {
                tracker.running = false;
                this.setLayerProcessingFlag(layerIndex, false);
                if (tracker.pending) {
                    tracker.pending = false;
                    this.queueLayerProcessing(layerIndex);
                } else {
                    this.layerProcessingState.delete(layerIndex);
                }
            });
    }

    async processLayerAudio(layerIndex) {
        const layer = this.state.layers[layerIndex];
        if (!layer?.active) return;
        const source = await this.getOriginalLayerBuffers(layerIndex);
        if (!source || !source.bufferL?.length) return;
        const sampleRate = this.audioCtx?.sampleRate || 44100;
        const speedRatio = this.mapSpeedNormalizedToActual(layer.knobValues.speed);
        const pitchSemitones = this.normalizedPitchToSemitones(layer.knobValues.pitch);
        const targetPitchRatio = Math.pow(2, pitchSemitones / 12);
        const compensatedPitchRatio = targetPitchRatio / (speedRatio || 1);
        const requiresSpeed = Math.abs(speedRatio - 1) > 0.0005;
        const requiresPitch = Math.abs(compensatedPitchRatio - 1) > 0.0005;
        if (!requiresSpeed && !requiresPitch) {
            if (this.layerHasProcessedAudio[layerIndex] && this.state.layers[layerIndex]?.active) {
                const restored = {
                    bufferL: source.bufferL.slice(),
                    bufferR: source.bufferR.slice(),
                    lengthSamples: source.bufferL.length
                };
                if (this.layerPendingPhaseReminder[layerIndex]) {
                    this.layerNeedsPostRestoreResync[layerIndex] = true;
                }
                await this.applyProcessedLayer(layerIndex, restored, { forceReferenceSpan: true });
                this.layerHasProcessedAudio[layerIndex] = false;
                this.layerRealtimeParamOverride[layerIndex] = false;
                if (this.layerPendingPhaseReminder[layerIndex]) {
                    const masterIndex = this.getMasterLayerIndex();
                    const isMasterLayer = layerIndex === masterIndex;
                    this.remindLayerPhase(layerIndex, { forceCatchup: isMasterLayer });
                    if (isMasterLayer) {
                        this.remindLinkedLayers(layerIndex);
                    }
                    this.layerPendingPhaseReminder[layerIndex] = false;
                }
            }
            return;
        }
        const processed = processLayerBuffer({
            bufferL: source.bufferL,
            bufferR: source.bufferR,
            sampleRate,
            speedRatio,
            pitchRatio: compensatedPitchRatio
        });
        if (!this.state.layers[layerIndex]?.active) {
            return;
        }
        const masterIndex = this.getMasterLayerIndex();
        if (layerIndex === masterIndex) {
            this.layerNeedsPostRestoreResync[layerIndex] = true;
        }
        await this.applyProcessedLayer(layerIndex, processed, { forceReferenceSpan: false });
        this.layerHasProcessedAudio[layerIndex] = true;
        this.layerRealtimeParamOverride[layerIndex] = false;
    }

    async getOriginalLayerBuffers(layerIndex) {
        if (this.layerOriginalAudio.has(layerIndex)) {
            return this.layerOriginalAudio.get(layerIndex);
        }
        const payload = await this.requestLayerData(layerIndex);
        if (!payload || payload.empty || !payload.bufferL) {
            return null;
        }
        const stored = {
            bufferL: payload.bufferL.slice(),
            bufferR: (payload.bufferR ? payload.bufferR : payload.bufferL).slice()
        };
        this.layerOriginalAudio.set(layerIndex, stored);
        return stored;
    }

    async applyProcessedLayer(layerIndex, processed, options = {}) {
        if (!processed || !processed.bufferL) return;
        const { forceReferenceSpan = false } = options;
        const masterIndex = this.getMasterLayerIndex();
        const isMasterLayer = layerIndex === masterIndex;
        const baselineSpan = (isMasterLayer && this.masterWindowDefaults.valid)
            ? Math.max(0, Math.floor(this.masterWindowDefaults.spanSamples || 0))
            : 0;
        const shouldForceSpan = forceReferenceSpan && baselineSpan > 0;
        const params = this.mapKnobValuesToParams(this.state.layers[layerIndex].knobValues);
        const neutralizedParams = {
            ...params,
            speed: 0.5,
            speedActual: 1,
            pitch: 0.5,
            pitchSemitones: 0,
            pitchFactor: 1
        };
        const startOffset = this.state.layers[layerIndex]?.startOffsetSamples ?? this.state.layers[layerIndex]?.phaseOffsetSamples ?? 0;
        const phaseOffset = this.state.layers[layerIndex]?.phaseOffsetSamples ?? startOffset;
        let workingBuffer = processed;
        let targetSpan = processed.lengthSamples || processed.bufferL.length;
        if (shouldForceSpan && baselineSpan > 0) {
            targetSpan = baselineSpan;
            const currentSpan = processed.lengthSamples || processed.bufferL.length || 0;
            if (Math.abs(currentSpan - baselineSpan) > 1) {
                workingBuffer = this.retimeProcessedLayer(processed, baselineSpan);
            }
        }
        const finalLength = workingBuffer.lengthSamples || workingBuffer.bufferL.length;
        if (!shouldForceSpan) {
            this.layerReferenceSpanSamples[layerIndex] = finalLength;
        } else if (baselineSpan > 0) {
            this.layerReferenceSpanSamples[layerIndex] = baselineSpan;
        }
        if (isMasterLayer && this.getActiveLayerCount() <= 1) {
            const baseSpeedDefault = this.looperKnobDefaults?.['looper-speed-knob'] ?? 0.5;
            const layerKnobs = this.state.layers[layerIndex]?.knobValues || {};
            const masterDefaults = this.masterWindowDefaults.valid && this.masterWindowDefaults.layerIndex === masterIndex
                ? this.masterWindowDefaults
                : {
                      start: layerKnobs.start ?? 0,
                      end: layerKnobs.end ?? 1,
                      speed: layerKnobs.speed ?? baseSpeedDefault,
                      spanSamples: finalLength,
                      layerIndex: masterIndex,
                      valid: true
                  };
            masterDefaults.spanSamples = finalLength;
            masterDefaults.speed = layerKnobs.speed ?? masterDefaults.speed ?? baseSpeedDefault;
            masterDefaults.start = layerKnobs.start ?? masterDefaults.start ?? 0;
            masterDefaults.end = layerKnobs.end ?? masterDefaults.end ?? 1;
            masterDefaults.layerIndex = masterIndex;
            masterDefaults.valid = true;
            this.masterWindowDefaults = masterDefaults;
            this.masterDefaultsNeedCommit = false;
            this.applyStartEndDefaultTargets();
        }
        console.log('[Looper][applyProcessedLayer]', {
            layerIndex,
            bufferLength: workingBuffer.bufferL?.length || 0,
            startOffset,
            phaseOffset
        });
        const payload = {
            type: 'restore-layer',
            index: layerIndex,
            bufferL: workingBuffer.bufferL,
            bufferR: workingBuffer.bufferR || workingBuffer.bufferL,
            params: neutralizedParams,
            startOffsetSamples: startOffset,
            phaseOffsetSamples: phaseOffset,
            referenceSpanSamples: shouldForceSpan ? baselineSpan : finalLength,
            takes: [
                {
                    bufferL: workingBuffer.bufferL,
                    bufferR: workingBuffer.bufferR || workingBuffer.bufferL
                }
            ]
        };
        const transfer = [workingBuffer.bufferL.buffer];
        if (workingBuffer.bufferR && workingBuffer.bufferR.buffer !== workingBuffer.bufferL.buffer) {
            transfer.push(workingBuffer.bufferR.buffer);
        }
        this.node.port.postMessage(payload, transfer);
    }

    retimeProcessedLayer(processed, targetSpan) {
        const currentLength = processed.lengthSamples || processed.bufferL.length || 0;
        const desiredSpan = Math.max(1, Math.floor(targetSpan || 0));
        if (!desiredSpan || currentLength === desiredSpan) {
            return processed;
        }
        const sampleRate = this.audioCtx?.sampleRate || 44100;
        const spanRatio = currentLength / desiredSpan;
        if (spanRatio >= 0.25 && spanRatio <= 4) {
            const resampled = processLayerBuffer({
                bufferL: processed.bufferL,
                bufferR: processed.bufferR || processed.bufferL,
                sampleRate,
                speedRatio: spanRatio,
                pitchRatio: 1
            });
            const resolvedLength = resampled.lengthSamples || resampled.bufferL.length;
            if (resolvedLength === desiredSpan) {
                return resampled;
            }
            return this.linearResampleProcessedLayer(resampled, desiredSpan);
        }
        return this.linearResampleProcessedLayer(processed, desiredSpan);
    }

    linearResampleProcessedLayer(processed, targetSpan) {
        const bufferL = this.linearResampleChannel(processed.bufferL, targetSpan);
        const sourceR = processed.bufferR || processed.bufferL;
        const bufferR = sourceR === processed.bufferL
            ? bufferL
            : this.linearResampleChannel(sourceR, targetSpan);
        return {
            bufferL,
            bufferR,
            lengthSamples: targetSpan
        };
    }

    linearResampleChannel(source, targetLength) {
        const desiredLength = Math.max(1, Math.floor(targetLength || 0));
        if (!source || source.length === desiredLength) {
            return source ? source.slice() : new Float32Array(desiredLength);
        }
        const srcLength = source.length;
        if (srcLength === 0) {
            return new Float32Array(desiredLength);
        }
        const output = new Float32Array(desiredLength);
        if (desiredLength === 1) {
            output[0] = source[0] || 0;
            return output;
        }
        const ratio = (srcLength - 1) / (desiredLength - 1);
        for (let i = 0; i < desiredLength; i++) {
            const pos = i * ratio;
            const index = Math.floor(pos);
            const frac = pos - index;
            const nextIndex = Math.min(srcLength - 1, index + 1);
            const sampleA = source[index] || 0;
            const sampleB = source[nextIndex] || 0;
            output[i] = sampleA + (sampleB - sampleA) * frac;
        }
        return output;
    }

    setLayerProcessingFlag(layerIndex, active) {
        if (layerIndex < 0 || layerIndex >= MAX_LAYERS) return;
        if (this.state.layerProcessing[layerIndex] === !!active) return;
        this.state.layerProcessing[layerIndex] = !!active;
        this.updateLayerMarkers();
        this.updateStatusText();
    }

    clearLayerProcessingState(layerIndex, options = {}) {
        if (layerIndex == null || layerIndex < 0 || layerIndex >= MAX_LAYERS) return;
        const preserveOriginal = !!options.preserveOriginal;
        if (!preserveOriginal) {
            this.layerOriginalAudio.delete(layerIndex);
        }
        const timer = this.layerProcessingTimers.get(layerIndex);
        if (timer) {
            clearTimeout(timer);
            this.layerProcessingTimers.delete(layerIndex);
        }
        this.layerProcessingState.delete(layerIndex);
        this.setLayerProcessingFlag(layerIndex, false);
        this.layerHasProcessedAudio[layerIndex] = false;
        this.layerRealtimeParamOverride[layerIndex] = false;
    }

    // ---------- UI Sync ----------
    syncKnobsToLayer() {
        const layer = this.state.layers[this.state.selectedLayer];
        Object.entries(this.knobs).forEach(([key, controller]) => {
            if (!controller) return;
            controller.setValue(layer.knobValues[key], false);
            this.updateKnobTooltip(key, layer.knobValues[key], { show: false });
            const knobId = this.paramToKnobId?.[key];
            if (knobId) {
                this.reportKnobValue(knobId, layer.knobValues[key]);
            }
        });
        this.updateLayerInfo();
        this.updateLayerMarkers();
        this.applyStartEndDefaultTargets();
    }

    syncUiState() {
        this.buttons.play?.classList.toggle('active', this.state.playing);
        this.setRecordActive(this.state.recording || this.state.autoLatch);
        this.disableAddButton(this.isAddDisabled());
        this.buttons.add?.classList.toggle('active', this.state.addMode && !this.isAddDisabled());
        this.updateStatusText();
        this.updateLayerMarkers();
        this.updateLayerInfo();
    }

    disableAddButton(disabled) {
        this.buttons.add?.classList.toggle('disabled', !!disabled);
    }

    isAddDisabled() {
        return this.state.layers.every(layer => layer.active);
    }

    updateRecordButtonDisplay() {
        if (!this.buttons.record) return;
        this.buttons.record.classList.toggle('pending-stop', !!this.state.pendingStopRequest);
    }

    updateLayerInfo() {
        if (!this.layerInfoEl) return;
        const index = this.state.selectedLayer;
        const layer = this.state.layers[index];
        const statusText = layer?.active
            ? `${this.formatLayerDuration(layer)}`
            : 'empty';
        this.layerInfoEl.textContent = `Layer ${index + 1} • ${statusText}`;
    }

    updateStatusText() {
        if (!this.statusTextEl) return;
        let text = 'Idle';
        let state = 'idle';
        if (this.state.recording && this.state.currentRecordingLayer != null) {
            if (this.state.pendingStopRequest) {
                text = `Recording L${this.state.currentRecordingLayer + 1} • stopping at loop`;
            } else if (this.state.lockedRecording) {
                text = `Recording L${this.state.currentRecordingLayer + 1} • locked`;
            } else {
                text = `Recording L${this.state.currentRecordingLayer + 1}`;
            }
            state = 'armed';
        } else if (this.state.layerProcessing[this.state.selectedLayer]) {
            text = `Rendering L${this.state.selectedLayer + 1}`;
            state = 'armed';
        } else if (this.state.autoLatch) {
            const queued = this.nextAutoLayer ?? this.findNextAvailableLayer();
            if (this.state.waitingForLoopHead) {
                text = queued === -1 ? 'Add mode full' : `Waiting loop • L${queued + 1}`;
            } else {
                text = queued === -1 ? 'Add mode full' : `Add armed • L${queued + 1}`;
            }
            state = 'armed';
        } else if (this.state.lockedRecording && (this.state.captureSessionActive || this.state.awaitingCaptureRestart)) {
            const layerIndex = this.state.currentRecordingLayer != null
                ? this.state.currentRecordingLayer
                : this.state.selectedLayer;
            text = `Loop armed • L${layerIndex + 1}`;
            state = 'armed';
        } else if (this.state.playing) {
            text = 'Playing';
            state = 'playing';
        }
        this.statusTextEl.textContent = text;
        this.statusTextEl.dataset.state = state;
    }

    updateLayerMarkers() {
        if (!this.layerMarkers?.length) return;
        const queued = this.state.autoLatch ? (this.nextAutoLayer ?? this.findNextAvailableLayer()) : -1;
        this.layerMarkers.forEach((marker, index) => {
            const layer = this.state.layers[index];
            marker.classList.toggle('selected', index === this.state.selectedLayer);
            marker.classList.toggle('active', !!layer?.active);
            marker.classList.toggle('recording', index === this.state.currentRecordingLayer);
            const queuedMatch = queued === index && this.state.autoLatch;
            marker.classList.toggle('queued', queuedMatch);
            marker.classList.toggle('processing', this.state.layerProcessing[index]);
        });
    }

    formatLayerDuration(layer) {
        if (!layer || !layer.lengthSamples) {
            return 'empty';
        }
        const seconds = layer.lengthSeconds || (layer.lengthSamples / (this.audioCtx?.sampleRate || 44100));
        if (!Number.isFinite(seconds) || seconds <= 0) {
            return 'empty';
        }
        return seconds >= 10 ? `${seconds.toFixed(1)}s` : `${seconds.toFixed(2)}s`;
    }
}
