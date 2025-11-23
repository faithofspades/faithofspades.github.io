// ============================================
// SEQUENCER TEMPO & DIVISION SYSTEM
// ============================================

// --- Tempo System State ---
let globalTempo = 120; // BPM (beats per minute)
let isTempoPlaying = false;
let isPaused = false;
let nextNoteTime = 0; // When the next note is due (in AudioContext time)
let currentBeat = 0; // Current beat in the bar
let currentTick = 0; // Current tick within the beat
let noteResolution = 16; // 16 ticks per beat (supports up to 1/64 notes)
let scheduleAheadTime = 0.1; // How far ahead to schedule (in seconds)
let lookahead = 25.0; // How frequently to call scheduling function (in milliseconds)
let timerID = null; // setTimeout ID for the scheduler
let metronomeSamples = {
    click: null,
    accentClick: null
};

// --- Time Signature (Global Meter) ---
let globalMeterNumerator = 4; // Default 4/4
let globalMeterDenominator = 4;

// --- Division Routing System ---
const divisionDestinations = ['LOSS', 'DELAY', 'LFO', 'MOD', 'ARP', 'GLOBAL'];
let currentDivisionDestination = 'GLOBAL'; // Currently highlighted destination
let selectedDivisionDestination = null; // Currently selected destination (when select is on)
let divisionConnections = {}; // { 'LOSS': true, 'DELAY': false, ... }
let divisionSettings = {}; // { 'LOSS': { type: '1/64', modifier: 'regular' }, ... }
let arpeggiatorInstance = null;

export function setArpeggiatorInstance(instance) {
    arpeggiatorInstance = instance;
}

// Division options for LOSS, DELAY, ARP, LFO, MOD
const rhythmDivisions = [
    '1/64', '1/32', '1/16', '1/8', '1/4', '1/2', '1/1', '2/1', '4/1', '8/1'
];
const divisionModifiers = ['regular', 'dotted', 'triplet']; // regular, . (dotted), T (triplet)

// Global meter options
const meterNumerators = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const meterDenominators = [2, 4, 8, 16];

// --- Tap Tempo System ---
let tapTimes = [];
const TAP_TIMEOUT = 2000; // Reset tap tempo after 2 seconds of inactivity

// --- Metronome Volume ---
let metronomeVolume = 0.5; // 0-1 range

// --- Keyboard Octave Shift ---
let keyboardOctaveShift = 0; // -2 to +2 octaves

// --- Pitch Bend ---
let currentPitchBend = 0; // -2 to +2 semitones
let pitchBendReturnTimeout = null;

// --- Step Buttons State ---
let currentStepCount = 16; // Current number of step buttons displayed

// --- Sequencer Pattern State ---
const SEQUENCER_PAGE_COUNT = 4;
let currentPageIndex = 0; // 0-based page pointer, 4 pages total
let currentStepPosition = -1; // Last advanced step index across full pattern
let lastStepTimestamp = null; // AudioContext time for the start of the active step
let sequencerPattern = []; // Array of arrays -> recorded note events per beat
let canonicalSequencerEvents = []; // Canonical timeline (normalized positions) for post-processing
let pendingRecordedNotes = new Map(); // noteNumber -> stack of pending captures
let sequencerEventIdCounter = 0;
let sequencerRecordArmed = false;
let userSelectedStartStep = null;
let preCountRequested = false;
let isPreCountActive = false;
let preCountStepsRemaining = 0;
let preCountTotalSteps = 0;
let preCountTotalBeats = 0;
let preCountDisplayNumber = null;
let modRecordingEnabled = false;
const automationTargets = new Map();
const automationLanes = new Map();
let automationEventIdCounter = 0;
const automationPlaybackTimeouts = new Set();
const automationBaselineValues = new Map();
const automationCurrentValues = new Map();
let automationPlaybackStartValues = null;
let modAutomationSessionActive = false;
const automationLaneBaselines = new Map();
let modRecordingSessionBaseline = null;
let currentLoopStartTime = null;
let currentLoopDurationSeconds = null;
let lastSequencerNoteReleaseTime = null;
const MONO_LEGATO_MAX_GAP = 0.06;
const nudgeOverflowStore = {
    notesLeft: [],
    notesRight: [],
    automationLeft: new Map(),
    automationRight: new Map()
};
const STEP_RECORD_CHORD_WINDOW_MS = 12;
let stepRecordingEnabled = false;
let stepRecordingSimpleMode = false;
let stepRecordingTargetStepIndex = null;
let stepRecordingActiveChordStep = null;
let stepRecordingChordDeadlineTime = null;
let stepRecordingStepCleared = false;
const stepRecordingPendingNotes = new Map();
let stepRecordingAutomationBaselines = null;
const stepRecordingTouchedParams = new Set();
let sequencerSpaceHotkeyBound = false;

const TOUCH_DOUBLE_TAP_MAX_DELAY = 350;
const TOUCH_LONG_PRESS_DELAY = 600;
const TOUCH_MOVE_CANCEL_THRESHOLD = 12;

function addTouchDoubleTapSupport(element, handler, options = {}) {
    if (!element || typeof handler !== 'function') return;
    const delay = options.delay || TOUCH_DOUBLE_TAP_MAX_DELAY;
    const moveThreshold = options.moveThreshold || TOUCH_MOVE_CANCEL_THRESHOLD;
    let lastTapTime = 0;
    let startX = 0;
    let startY = 0;
    let trackingTap = false;

    element.addEventListener('touchstart', (event) => {
        if (event.touches.length !== 1) return;
        trackingTap = true;
        startX = event.touches[0].clientX;
        startY = event.touches[0].clientY;
    }, { passive: false });

    element.addEventListener('touchend', (event) => {
        if (!trackingTap || event.changedTouches.length !== 1) {
            trackingTap = false;
            return;
        }
        trackingTap = false;
        const touch = event.changedTouches[0];
        const now = performance.now();
        const deltaTime = now - lastTapTime;
        const distance = Math.hypot(touch.clientX - startX, touch.clientY - startY);
        if (deltaTime > 0 && deltaTime <= delay && distance <= moveThreshold) {
            event.preventDefault();
            handler(event);
            lastTapTime = 0;
        } else {
            lastTapTime = now;
            startX = touch.clientX;
            startY = touch.clientY;
        }
    }, { passive: false });

    element.addEventListener('touchcancel', () => {
        trackingTap = false;
    });
}

function addTouchLongPressSupport(element, handler, options = {}) {
    if (!element || typeof handler !== 'function') return;
    const delay = options.delay || TOUCH_LONG_PRESS_DELAY;
    const moveThreshold = options.moveThreshold || TOUCH_MOVE_CANCEL_THRESHOLD;
    let timerId = null;
    let startX = 0;
    let startY = 0;
    let active = false;
    let longPressTriggered = false;

    const clearTimer = () => {
        if (timerId !== null) {
            window.clearTimeout(timerId);
            timerId = null;
        }
    };

    const cancelTracking = () => {
        clearTimer();
        active = false;
    };

    element.addEventListener('touchstart', (event) => {
        if (event.touches.length !== 1) return;
        active = true;
        longPressTriggered = false;
        startX = event.touches[0].clientX;
        startY = event.touches[0].clientY;
        clearTimer();
        timerId = window.setTimeout(() => {
            if (!active) return;
            longPressTriggered = true;
            event.preventDefault();
            handler(event);
        }, delay);
    }, { passive: false });

    element.addEventListener('touchmove', (event) => {
        if (!active || event.touches.length !== 1) return;
        const touch = event.touches[0];
        const distance = Math.hypot(touch.clientX - startX, touch.clientY - startY);
        if (distance > moveThreshold) {
            cancelTracking();
        }
    }, { passive: false });

    element.addEventListener('touchend', (event) => {
        if (longPressTriggered) {
            event.preventDefault();
        }
        cancelTracking();
    }, { passive: false });

    element.addEventListener('touchcancel', () => {
        cancelTracking();
    });
}

const TRIPLET_RATIO = 2 / 3;
const DEFAULT_QUANTIZE_LABEL = '1/16 BEAT';
const quantizeBaseModes = [
    { label: 'BAR', beatsFn: () => Math.max(1, globalMeterNumerator), allowTriplet: false },
    { label: '1/2 BAR', beatsFn: () => Math.max(1, globalMeterNumerator) / 2, allowTriplet: true },
    { label: 'BEAT', beatsFn: () => 1, allowTriplet: true },
    { label: '1/2 BEAT', beatsFn: () => 0.5, allowTriplet: true },
    { label: '1/4 BEAT', beatsFn: () => 0.25, allowTriplet: true },
    { label: '1/8 BEAT', beatsFn: () => 0.125, allowTriplet: true },
    { label: '1/16 BEAT', beatsFn: () => 0.0625, allowTriplet: true },
    { label: '1/32 BEAT', beatsFn: () => 0.03125, allowTriplet: true },
    { label: '1/64 BEAT', beatsFn: () => 0.015625, allowTriplet: true }
];
let quantizeOptions = [];
let currentQuantizeIndex = null;
let quantizeKnobElement = null;
const MIN_DURATION_NORMALIZED = 1 / 4096;
const AUTOMATION_POSITION_MERGE_DIVISOR = 8;
const AUTOMATION_VALUE_EPSILON = 0.0005;
const SEQUENCE_SNAPSHOT_VERSION = 1;

function dispatchSequencerEvent(name, detail = {}) {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    try {
        window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (error) {
        console.warn(`Sequencer: failed to dispatch ${name}`, error);
    }
}

function resetNudgeOverflowStore() {
    nudgeOverflowStore.notesLeft.length = 0;
    nudgeOverflowStore.notesRight.length = 0;
    nudgeOverflowStore.automationLeft.clear();
    nudgeOverflowStore.automationRight.clear();
}

function shiftSequenceBySteps(stepDelta) {
    if (!Number.isInteger(stepDelta) || stepDelta === 0) return;
    const totalSteps = getTotalPatternSteps();
    if (!totalSteps) return;
    const normalizedDelta = (stepDelta / totalSteps);
    if (!Number.isFinite(normalizedDelta) || normalizedDelta === 0) return;

    const combinedNotes = [
        ...canonicalSequencerEvents,
        ...nudgeOverflowStore.notesLeft,
        ...nudgeOverflowStore.notesRight
    ];
    canonicalSequencerEvents = [];
    nudgeOverflowStore.notesLeft = [];
    nudgeOverflowStore.notesRight = [];

    combinedNotes.forEach(evt => {
        if (!evt || !Number.isFinite(evt.position)) return;
        evt.position += normalizedDelta;
        if (evt.position < 0) {
            nudgeOverflowStore.notesLeft.push(evt);
        } else if (evt.position >= 1) {
            nudgeOverflowStore.notesRight.push(evt);
        } else {
            canonicalSequencerEvents.push(evt);
        }
    });

    const automationParamIds = new Set([
        ...automationLanes.keys(),
        ...nudgeOverflowStore.automationLeft.keys(),
        ...nudgeOverflowStore.automationRight.keys()
    ]);

    automationParamIds.forEach(paramId => {
        const lane = automationLanes.get(paramId) || [];
        const leftOverflow = nudgeOverflowStore.automationLeft.get(paramId) || [];
        const rightOverflow = nudgeOverflowStore.automationRight.get(paramId) || [];
        const combined = [...lane, ...leftOverflow, ...rightOverflow];
        const kept = [];
        const newLeft = [];
        const newRight = [];
        const hadLane = automationLanes.has(paramId);
        combined.forEach(evt => {
            if (!evt || !Number.isFinite(evt.position)) return;
            evt.position += normalizedDelta;
            if (evt.position < 0) {
                newLeft.push(evt);
            } else if (evt.position >= 1) {
                newRight.push(evt);
            } else {
                kept.push(evt);
            }
        });
        if (kept.length) {
            kept.sort((a, b) => a.position - b.position);
            automationLanes.set(paramId, kept);
        } else if (hadLane) {
            automationLanes.set(paramId, []);
        } else {
            automationLanes.delete(paramId);
        }
        if (newLeft.length) {
            nudgeOverflowStore.automationLeft.set(paramId, newLeft);
        } else {
            nudgeOverflowStore.automationLeft.delete(paramId);
        }
        if (newRight.length) {
            nudgeOverflowStore.automationRight.set(paramId, newRight);
        } else {
            nudgeOverflowStore.automationRight.delete(paramId);
        }
    });

    rebuildSequencerPatternFromCanonical();
    console.log(`Sequencer: nudged timeline by ${stepDelta > 0 ? '+' : ''}${stepDelta} step(s)`);
}

// --- Calculate Step Configuration Based on Meter ---
function calculateStepConfiguration(numerator, denominator) {
    // Calculate total steps based on numerator
    // Rules:
    // - Multiples of 4: steps = numerator * 4
    // - Multiples of 3 (not 6): steps = numerator * 4
    // - Others: steps = numerator * (16 / 4) but capped
    
    let totalSteps;
    let accentInterval; // Which steps get orange underline
    
    // Special handling based on numerator
    if (numerator === 1) {
        totalSteps = 16; // 16 steps, all orange
    } else if (numerator === 2) {
        totalSteps = 8; // 2 beats, 4 steps each = 8 total
    } else if (numerator === 3) {
        totalSteps = 12;
    } else if (numerator === 4) {
        totalSteps = 16;
    } else if (numerator === 5) {
        totalSteps = 20;
    } else if (numerator === 6) {
        totalSteps = 12; // Same as 3, different accent
    } else if (numerator === 7) {
        totalSteps = 14;
    } else if (numerator === 8) {
        totalSteps = 16;
    } else if (numerator === 9) {
        totalSteps = 18;
    } else if (numerator === 10) {
        totalSteps = 20;
    } else if (numerator === 11) {
        totalSteps = 11;
    } else if (numerator === 12) {
        totalSteps = 12;
    } else if (numerator === 13) {
        totalSteps = 13;
    } else if (numerator === 14) {
        totalSteps = 14;
    } else if (numerator === 15) {
        totalSteps = 15;
    } else if (numerator === 16) {
        totalSteps = 16;
    } else {
        totalSteps = 16;
    }
    const safeNumerator = Math.max(1, numerator);
    if (safeNumerator === 1) {
        accentInterval = totalSteps; // one orange then full page of yellow
    } else {
        const stepsPerBeat = totalSteps / safeNumerator;
        accentInterval = Math.max(1, Math.min(totalSteps, Math.round(stepsPerBeat))); // Highlight each beat start
    }
    
    // Calculate button width to fit container
    // Container width is approximately 27.29px * 16 = 436.64px
    const containerWidth = 436.64;
    const buttonWidth = containerWidth / totalSteps;
    
    return { totalSteps, accentInterval, buttonWidth };
}

// --- Rebuild Step Buttons ---
function rebuildStepButtons() {
    const container = document.querySelector('.seq-steps-container');
    if (!container) return;
    
    const config = calculateStepConfiguration(globalMeterNumerator, globalMeterDenominator);
    currentStepCount = config.totalSteps;
    ensurePatternLength();
    clampPageIndex();
    
    // Clear existing buttons
    container.innerHTML = '';
    const stepsPerPage = currentStepCount;
    const pageStartIndex = currentPageIndex * stepsPerPage;
    const totalPatternSteps = getTotalPatternSteps();
    
    // Create new buttons
    for (let i = 0; i < stepsPerPage; i++) {
        const absoluteIndex = pageStartIndex + i;
        if (absoluteIndex >= totalPatternSteps) break;
        const displayNumber = absoluteIndex + 1;
        const button = document.createElement('div');
        button.className = 'seq-step-button';
        button.id = `seq-step-${displayNumber}`;
        button.dataset.stepIndex = displayNumber;
        button.textContent = displayNumber;
        const clearThisStep = () => {
            clearStepNotes(absoluteIndex);
        };
        button.addEventListener('click', () => handleStepButtonClick(absoluteIndex));
        button.addEventListener('dblclick', (event) => {
            event.stopPropagation();
            clearThisStep();
        });
        button.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            clearThisStep();
        });
        addTouchDoubleTapSupport(button, clearThisStep);
        addTouchLongPressSupport(button, clearThisStep);
        
        // Set custom width
        button.style.width = `${config.buttonWidth}px`;
        button.style.minWidth = `${config.buttonWidth}px`;
        
        // Add accent styling for orange buttons with underline
        if ((displayNumber - 1) % config.accentInterval === 0) {
            button.style.backgroundColor = '#CF814D';
            button.style.textDecoration = 'underline';
        }
        container.appendChild(button);
    }
    
    updatePageIndicators();
    const highlightStep = getCurrentHighlightStepNumber();
    if (highlightStep > 0) {
        updateStepVisuals(highlightStep);
    } else {
        updateStepVisuals(-1);
    }
    refreshVisibleStepNoteIndicators();
    console.log(`Rebuilt ${stepsPerPage} step buttons for ${globalMeterNumerator}/${globalMeterDenominator} (page ${currentPageIndex + 1})`);
}

function getStepsPerPage() {
    return currentStepCount || 0;
}

function getTotalPatternSteps() {
    return getStepsPerPage() * SEQUENCER_PAGE_COUNT;
}

function ensurePatternLength() {
    const totalSteps = getTotalPatternSteps();
    if (!Number.isFinite(totalSteps) || totalSteps <= 0) return;
    const previousLength = sequencerPattern.length;
    if (previousLength !== totalSteps) {
        const previousStart = userSelectedStartStep;
        sequencerPattern = Array.from({ length: totalSteps }, () => []);
        currentStepPosition = Math.min(currentStepPosition, totalSteps - 1);
        if (currentStepPosition < 0) currentStepPosition = -1;
        if (previousStart !== null) {
            if (previousLength > 1) {
                const mapped = Math.round((previousStart / Math.max(1, previousLength - 1)) * (totalSteps - 1));
                userSelectedStartStep = Math.max(0, Math.min(totalSteps - 1, mapped));
            } else {
                userSelectedStartStep = Math.max(0, Math.min(totalSteps - 1, previousStart));
            }
        }
        updateStepVisuals(-1);
        return;
    }
    sequencerPattern = sequencerPattern.map(events => Array.isArray(events) ? events : []);
    currentStepPosition = Math.min(currentStepPosition, totalSteps - 1);
    if (currentStepPosition < 0) currentStepPosition = -1;
    if (userSelectedStartStep !== null) {
        userSelectedStartStep = Math.max(0, Math.min(totalSteps - 1, userSelectedStartStep));
    }
}

function clampPageIndex() {
    const maxPage = Math.max(0, SEQUENCER_PAGE_COUNT - 1);
    if (currentPageIndex > maxPage) {
        currentPageIndex = maxPage;
    }
    if (currentPageIndex < 0) {
        currentPageIndex = 0;
    }
}

function setCurrentPage(newPageIndex) {
    const clamped = Math.max(0, Math.min(SEQUENCER_PAGE_COUNT - 1, newPageIndex));
    if (clamped === currentPageIndex) return;
    currentPageIndex = clamped;
    rebuildStepButtons();
}

function updatePageIndicators() {
    const dots = document.querySelectorAll('.seq-page-dots-container .seq-dot');
    dots.forEach((dot, index) => {
        dot.classList.toggle('active', index === currentPageIndex);
    });
}

function updateStepNoteIndicator(stepIndex, hasNotes) {
    const button = document.querySelector(`.seq-step-button[data-step-index="${stepIndex}"]`);
    if (!button) return;
    button.classList.toggle('has-notes', hasNotes);
}

function getAutomationStepPresence() {
    const stepsWithAutomation = new Set();
    const totalSteps = getTotalPatternSteps();
    if (!totalSteps || !automationLanes.size) return stepsWithAutomation;
    automationLanes.forEach(lane => {
        if (!Array.isArray(lane) || !lane.length) return;
        lane.forEach(evt => {
            if (!evt || !Number.isFinite(evt.position)) return;
            const normalized = normalizeLoopPosition(evt.position);
            let stepIndex = Math.floor(normalized * totalSteps);
            if (!Number.isFinite(stepIndex)) return;
            if (stepIndex < 0) stepIndex = 0;
            if (stepIndex >= totalSteps) stepIndex = totalSteps - 1;
            stepsWithAutomation.add(stepIndex);
        });
    });
    return stepsWithAutomation;
}

function refreshVisibleStepNoteIndicators() {
    const automationSteps = getAutomationStepPresence();
    const buttons = document.querySelectorAll('.seq-step-button');
    buttons.forEach(button => {
        const idx = parseInt(button.dataset.stepIndex, 10) - 1;
        const hasNotes = idx >= 0 && sequencerPattern[idx] && sequencerPattern[idx].length > 0;
        const hasAutomation = idx >= 0 && automationSteps.has(idx);
        button.classList.toggle('has-notes', Boolean(hasNotes));
        button.classList.toggle('has-modulation', hasAutomation);
    });
}

function getAutomationValuesForStep(stepIndex) {
    const totalSteps = getTotalPatternSteps();
    if (!Number.isFinite(totalSteps) || totalSteps <= 0 || stepIndex < 0) return null;
    const values = new Map();
    automationLanes.forEach((lane, paramId) => {
        if (!Array.isArray(lane) || !lane.length) return;
        const match = lane.find(evt => {
            if (!evt || !Number.isFinite(evt.position)) return false;
            const evtStep = Math.floor(normalizeLoopPosition(evt.position) * totalSteps);
            return evtStep === stepIndex;
        });
        if (match && Number.isFinite(match.value)) {
            values.set(paramId, match.value);
        }
    });
    return values;
}

function applyStepAutomationPreview(stepIndex) {
    if (!stepRecordingEnabled) return;
    const values = getAutomationValuesForStep(stepIndex);
    if (!values || !values.size) return;
    values.forEach((value, paramId) => {
        rememberStepRecordingBaseline(paramId);
        if (!Number.isFinite(value)) return;
        applyAutomationValue(paramId, value);
        stepRecordingTouchedParams.add(paramId);
    });
}

function clearStepNotes(stepIndex, options = {}) {
    const { clearAutomation = true } = options;
    ensurePatternLength();
    const totalSteps = getTotalPatternSteps();
    if (!Number.isFinite(totalSteps) || totalSteps <= 0) return;
    if (stepIndex < 0 || stepIndex >= totalSteps) return;
    const beforeCount = canonicalSequencerEvents.length;
    canonicalSequencerEvents = canonicalSequencerEvents.filter(evt => {
        if (!Number.isFinite(evt?.position)) return true;
        const evtSteps = evt.position * totalSteps;
        const { stepIndex: evtStepIndex } = quantizeStepPosition(evtSteps);
        return evtStepIndex !== stepIndex;
    });
    const automationRemoved = clearAutomation ? clearStepAutomation(stepIndex) : false;
    if (canonicalSequencerEvents.length !== beforeCount) {
        rebuildSequencerPatternFromCanonical();
    }
    if (automationRemoved || canonicalSequencerEvents.length !== beforeCount) {
        refreshVisibleStepNoteIndicators();
        console.log(`Sequencer: cleared step ${stepIndex + 1}${automationRemoved ? ' (with motion)' : ''}`);
    }
}

function clearStepAutomation(stepIndex) {
    const totalSteps = getTotalPatternSteps();
    if (!Number.isFinite(totalSteps) || totalSteps <= 0) return false;
    let removed = false;
    automationLanes.forEach((lane, paramId) => {
        if (!Array.isArray(lane) || !lane.length) return;
        const filtered = lane.filter(evt => {
            if (!evt || !Number.isFinite(evt.position)) return true;
            const evtStep = Math.floor(normalizeLoopPosition(evt.position) * totalSteps);
            return evtStep !== stepIndex;
        });
        if (filtered.length !== lane.length) {
            removed = true;
            if (filtered.length) {
                automationLanes.set(paramId, filtered);
            } else {
                automationLanes.delete(paramId);
            }
        }
    });
    return removed;
}

function clearAllSequencerNotes() {
    canonicalSequencerEvents = [];
    pendingRecordedNotes.clear();
    stepRecordingPendingNotes.clear();
    stepRecordingActiveChordStep = null;
    stepRecordingChordDeadlineTime = null;
    ensurePatternLength();
    for (let i = 0; i < sequencerPattern.length; i++) {
        sequencerPattern[i] = [];
    }
    refreshVisibleStepNoteIndicators();
    console.log('Sequencer: cleared all recorded notes');
}

function getHighestRecordedStepIndex() {
    ensurePatternLength();
    for (let i = sequencerPattern.length - 1; i >= 0; i--) {
        if (sequencerPattern[i] && sequencerPattern[i].length > 0) {
            return i;
        }
    }
    return -1;
}

function getHighestHeldNoteStepIndex() {
    const totalSteps = getTotalPatternSteps();
    if (!totalSteps || !canonicalSequencerEvents.length) return -1;
    let highest = -1;
    canonicalSequencerEvents.forEach(evt => {
        if (!Number.isFinite(evt?.position)) return;
        const startPosition = evt.position * totalSteps;
        const durationNormalized = Number.isFinite(evt?.durationNormalized)
            ? Math.max(MIN_DURATION_NORMALIZED, evt.durationNormalized)
            : MIN_DURATION_NORMALIZED;
        const spanSteps = durationNormalized * totalSteps;
        const releasePosition = startPosition + Math.max(0, spanSteps);
        const releaseStepIndex = Math.min(
            totalSteps - 1,
            Math.max(0, Math.ceil(releasePosition) - 1)
        );
        if (releaseStepIndex > highest) {
            highest = releaseStepIndex;
        }
    });
    return highest;
}

function getHighestAutomationStepIndex() {
    const totalSteps = getTotalPatternSteps();
    if (!totalSteps || !automationLanes.size) return -1;
    let highest = -1;
    automationLanes.forEach(lane => {
        if (!Array.isArray(lane)) return;
        lane.forEach(evt => {
            if (!Number.isFinite(evt?.position)) return;
            let stepIndex = Math.floor(Math.max(0, evt.position) * totalSteps);
            if (stepIndex >= totalSteps) {
                stepIndex = totalSteps - 1;
            }
            if (stepIndex > highest) {
                highest = stepIndex;
            }
        });
    });
    return highest;
}

function getActivePageCountFromPattern() {
    const stepsPerPage = getStepsPerPage();
    if (!stepsPerPage) return SEQUENCER_PAGE_COUNT;
    const totalSteps = getTotalPatternSteps();
    if (!totalSteps) return SEQUENCER_PAGE_COUNT;
    const highestStep = Math.max(
        getHighestRecordedStepIndex(),
        getHighestHeldNoteStepIndex(),
        getHighestAutomationStepIndex()
    );
    if (highestStep < 0) return SEQUENCER_PAGE_COUNT;
    const activePages = Math.ceil((highestStep + 1) / stepsPerPage);
    return Math.max(1, Math.min(SEQUENCER_PAGE_COUNT, activePages));
}

function getEffectiveLoopLengthSteps() {
    const totalSteps = getTotalPatternSteps();
    if (!totalSteps) return 0;
    if (sequencerRecordArmed) return totalSteps;
    const stepsPerPage = getStepsPerPage();
    if (!stepsPerPage) return totalSteps;
    const activePages = getActivePageCountFromPattern();
    return Math.max(stepsPerPage, Math.min(totalSteps, activePages * stepsPerPage));
}

function getCurrentHighlightStepNumber() {
    if (!isTempoPlaying && !isPaused) {
        if (stepRecordingEnabled && Number.isInteger(stepRecordingTargetStepIndex)) {
            return stepRecordingTargetStepIndex + 1;
        }
        if (userSelectedStartStep !== null) {
            return userSelectedStartStep + 1;
        }
    }
    if (currentStepPosition >= 0) {
        return currentStepPosition + 1;
    }
    return -1;
}

function getStepsPerBeat() {
    if (!globalMeterNumerator) return 0;
    return currentStepCount / globalMeterNumerator;
}

function getBeatDurationSeconds() {
    const baseQuarter = 60 / Math.max(1, globalTempo);
    return baseQuarter * (4 / Math.max(1, globalMeterDenominator));
}

function getStepDurationSeconds() {
    const stepsPerBeat = getStepsPerBeat();
    if (!stepsPerBeat) return 0;
    const beatDuration = getBeatDurationSeconds();
    return beatDuration / stepsPerBeat;
}

function handleSequencerStepTick(tickNumber, time) {
    const stepsPerBeat = getStepsPerBeat();
    if (!stepsPerBeat) return;
    const ticksPerStep = noteResolution / stepsPerBeat;
    if (!Number.isFinite(ticksPerStep) || ticksPerStep <= 0) return;
    if (tickNumber % Math.round(ticksPerStep) !== 0) return;
    advanceSequencerStep(time);
}

function advanceSequencerStep(stepStartTime) {
    const loopSteps = getEffectiveLoopLengthSteps();
    if (!loopSteps) return;
    if (isPreCountActive) {
        handlePrecountStepAdvance();
        return;
    }
    updateModRecordingSessionState();
    currentStepPosition = (currentStepPosition + 1) % loopSteps;
    const audioContext = window.audioCtx;
    const startTime = typeof stepStartTime === 'number'
        ? stepStartTime
        : (audioContext ? audioContext.currentTime : 0);
    updateLoopTimingReference(startTime);
    if (currentStepPosition === 0) {
        restoreAutomationPlaybackStartValues();
    }
    lastStepTimestamp = startTime;
    const highlightStep = currentStepPosition + 1;
    updateStepVisuals(highlightStep);
    triggerSequencerStepPlayback(currentStepPosition, startTime);
    scheduleAutomationForStep(currentStepPosition, startTime);
}

function updateLoopTimingReference(stepStartTime) {
    const totalSteps = getTotalPatternSteps();
    const stepDuration = getStepDurationSeconds();
    if (!totalSteps || !Number.isFinite(stepDuration) || stepDuration <= 0) {
        currentLoopStartTime = null;
        currentLoopDurationSeconds = null;
        return;
    }
    currentLoopDurationSeconds = totalSteps * stepDuration;
    const baseTime = Number.isFinite(stepStartTime)
        ? stepStartTime
        : (window.audioCtx ? window.audioCtx.currentTime : 0);
    if (currentStepPosition === 0) {
        currentLoopStartTime = baseTime;
    } else if (currentLoopStartTime === null || !Number.isFinite(currentLoopStartTime)) {
        currentLoopStartTime = baseTime - (currentStepPosition * stepDuration);
    }
}

const sequencerPlaybackHandlers = {
    noteOn: null,
    noteOff: null
};

const activeSequencerNoteReleases = new Map();
let nextNoteReleaseId = 1;

export function registerSequencerPlaybackHandlers(handlers = {}) {
    sequencerPlaybackHandlers.noteOn = typeof handlers.noteOn === 'function' ? handlers.noteOn : null;
    sequencerPlaybackHandlers.noteOff = typeof handlers.noteOff === 'function' ? handlers.noteOff : null;
}

function scheduleNoteRelease(noteNumber, startTime, releaseTime) {
    if (!sequencerPlaybackHandlers.noteOff) return;
    const audioContext = window.audioCtx;
    const now = audioContext ? audioContext.currentTime : 0;
    const delayMs = Math.max(0, (releaseTime - now) * 1000);
    if (Number.isFinite(releaseTime)) {
        lastSequencerNoteReleaseTime = lastSequencerNoteReleaseTime === null
            ? releaseTime
            : Math.max(lastSequencerNoteReleaseTime, releaseTime);
    }
    const releaseId = nextNoteReleaseId++;
    const entry = {
        timeoutId: null,
        noteNumber,
        startTime,
        releaseTime
    };
    entry.timeoutId = setTimeout(() => {
        activeSequencerNoteReleases.delete(releaseId);
        if (!sequencerPlaybackHandlers.noteOff) return;
        try {
            if (Number.isFinite(releaseTime)) {
                lastSequencerNoteReleaseTime = releaseTime;
            }
            sequencerPlaybackHandlers.noteOff({
                noteNumber,
                startTime,
                releaseTime
            });
        } catch (error) {
            console.error('Sequencer: failed to trigger scheduled noteOff', error);
        }
    }, delayMs);
    activeSequencerNoteReleases.set(releaseId, entry);
}

function flushActiveSequencerNotes() {
    if (!activeSequencerNoteReleases.size) return;
    const audioContext = window.audioCtx;
    const now = audioContext ? audioContext.currentTime : 0;
    activeSequencerNoteReleases.forEach(entry => {
        clearTimeout(entry.timeoutId);
        if (!sequencerPlaybackHandlers.noteOff) return;
        try {
            if (Number.isFinite(now)) {
                lastSequencerNoteReleaseTime = now;
            }
            sequencerPlaybackHandlers.noteOff({
                noteNumber: entry.noteNumber,
                startTime: entry.startTime,
                releaseTime: now
            });
        } catch (error) {
            console.error('Sequencer: failed to flush noteOff', error);
        }
    });
    activeSequencerNoteReleases.clear();
}

function triggerSequencerStepPlayback(stepIndex, stepStartTime) {
    ensurePatternLength();
    const events = sequencerPattern[stepIndex];
    if (!events || events.length === 0) return;
    const stepDuration = getStepDurationSeconds();
    if (!stepDuration) return;
    const audioContext = window.audioCtx;
    events.forEach(event => {
        const now = audioContext ? audioContext.currentTime : 0;
        const startOffset = Math.max(0, Math.min(1, event.offset || 0));
        const eventStart = stepStartTime + (startOffset * stepDuration);
        const scheduledStart = Math.max(eventStart, now);
        if (sequencerPlaybackHandlers.noteOn) {
            sequencerPlaybackHandlers.noteOn({
                noteNumber: event.noteNumber,
                velocity: event.velocity ?? 1,
                startTime: scheduledStart,
                isLegato: shouldUseMonoLegato(scheduledStart)
            });
        }
        if (sequencerPlaybackHandlers.noteOff) {
            const eventDurationSeconds = getEventDurationSeconds(event, stepDuration);
            const releaseTime = scheduledStart + eventDurationSeconds;
            scheduleNoteRelease(event.noteNumber, scheduledStart, releaseTime);
        }
    });
    console.log(`Sequencer: played step ${stepIndex + 1} with ${events.length} note(s)`);
}

function getEventDurationSeconds(event, stepDurationSeconds) {
    if (!stepDurationSeconds) return 0.02;
    const totalSteps = getTotalPatternSteps();
    const defaultDuration = Math.max(stepDurationSeconds * 0.9, 0.02);
    if (!totalSteps) return defaultDuration;
    const normalized = Number.isFinite(event?.durationNormalized)
        ? Math.max(MIN_DURATION_NORMALIZED, event.durationNormalized)
        : null;
    if (normalized === null) return defaultDuration;
    const stepsSpan = normalized * totalSteps;
    return Math.max(0.02, stepsSpan * stepDurationSeconds);
}

function handleStepButtonClick(stepIndex) {
    const totalSteps = getTotalPatternSteps();
    if (!totalSteps) return;
    const normalizedIndex = ((stepIndex % totalSteps) + totalSteps) % totalSteps;
    userSelectedStartStep = normalizedIndex;
    currentStepPosition = (normalizedIndex - 1 + totalSteps) % totalSteps;
    lastStepTimestamp = null;
    updateStepVisuals(normalizedIndex + 1);
    if (stepRecordingEnabled) {
        setStepRecordingTargetStep(normalizedIndex, { userInitiated: true });
    }
}

function updateStepRecordButtonState() {
    const stepButton = document.getElementById('seq-top-record-button');
    if (!stepButton) return;
    stepButton.classList.toggle('active', stepRecordingEnabled);
    stepButton.classList.toggle('simple-mode', stepRecordingSimpleMode);
    if (stepRecordingSimpleMode) {
        stepButton.setAttribute('title', 'STEP REC (simple durations)');
    } else {
        stepButton.removeAttribute('title');
    }
}

function captureStepRecordingAutomationBaselines() {
    stepRecordingAutomationBaselines = new Map();
    automationBaselineValues.forEach((value, paramId) => {
        if (Number.isFinite(value)) {
            stepRecordingAutomationBaselines.set(paramId, value);
        }
    });
    automationCurrentValues.forEach((value, paramId) => {
        if (Number.isFinite(value)) {
            stepRecordingAutomationBaselines.set(paramId, value);
        }
    });
    stepRecordingTouchedParams.clear();
}

function applyStepRecordingAutomationBaselines() {
    if (!stepRecordingAutomationBaselines || !stepRecordingTouchedParams.size) return;
    stepRecordingTouchedParams.forEach(paramId => {
        if (!stepRecordingAutomationBaselines.has(paramId)) return;
        const baseline = stepRecordingAutomationBaselines.get(paramId);
        if (!Number.isFinite(baseline)) return;
        applyAutomationValue(paramId, baseline);
    });
}

function rememberStepRecordingBaseline(paramId) {
    if (!stepRecordingAutomationBaselines) return;
    if (stepRecordingAutomationBaselines.has(paramId)) return;

    let baseline = automationCurrentValues.has(paramId)
        ? automationCurrentValues.get(paramId)
        : undefined;
    if (!Number.isFinite(baseline) && automationBaselineValues.has(paramId)) {
        baseline = automationBaselineValues.get(paramId);
    }
    if (
        !Number.isFinite(baseline) &&
        automationPlaybackStartValues &&
        typeof automationPlaybackStartValues.get === 'function'
    ) {
        baseline = automationPlaybackStartValues.get(paramId);
    }
    if (Number.isFinite(baseline)) {
        stepRecordingAutomationBaselines.set(paramId, baseline);
    }
}

function ensureBaselineAutomationEventForStep(paramId, stepIndex) {
    if (!stepRecordingAutomationBaselines) return false;
    if (!Number.isInteger(stepIndex)) return false;
    const totalSteps = getTotalPatternSteps();
    if (!Number.isFinite(totalSteps) || totalSteps <= 0) return false;
    rememberStepRecordingBaseline(paramId);
    if (!stepRecordingAutomationBaselines.has(paramId)) return false;
    const baseline = stepRecordingAutomationBaselines.get(paramId);
    if (!Number.isFinite(baseline)) return false;
    const lane = automationLanes.get(paramId) || [];
    const hasEvent = lane.some(evt => {
        if (!evt || !Number.isFinite(evt.position)) return false;
        const evtStep = Math.floor(normalizeLoopPosition(evt.position) * totalSteps);
        return evtStep === stepIndex;
    });
    if (hasEvent) return false;
    const normalizedPosition = normalizeLoopPosition(stepIndex / totalSteps);
    lane.push({
        id: ++automationEventIdCounter,
        position: normalizedPosition,
        value: baseline
    });
    lane.sort((a, b) => a.position - b.position);
    automationLanes.set(paramId, lane);
    console.log(`Step REC: captured baseline ${baseline.toFixed(3)} for ${paramId} on step ${stepIndex + 1}`);
    return true;
}

function commitStepRecordingBaselinesForStep(stepIndex) {
    if (!stepRecordingEnabled) return;
    if (!Number.isInteger(stepIndex)) return;
    if (!stepRecordingTouchedParams.size) return;
    let lanesChanged = false;
    stepRecordingTouchedParams.forEach(paramId => {
        if (ensureBaselineAutomationEventForStep(paramId, stepIndex)) {
            lanesChanged = true;
        }
    });
    if (lanesChanged) {
        refreshVisibleStepNoteIndicators();
    }
}

function setStepRecordingEnabled(state) {
    const nextState = Boolean(state);
    if (stepRecordingEnabled === nextState) return;
    if (nextState && isTempoPlaying) {
        console.warn('Step REC can only be enabled while the sequencer is stopped.');
        return;
    }
    if (nextState) {
        captureStepRecordingAutomationBaselines();
    } else {
        commitStepRecordingBaselinesForStep(stepRecordingTargetStepIndex);
        applyStepRecordingAutomationBaselines();
        stepRecordingAutomationBaselines = null;
        stepRecordingTouchedParams.clear();
    }
    stepRecordingEnabled = nextState;
    if (!stepRecordingEnabled) {
        finalizeAllStepRecordingCaptures({ forceTime: window.audioCtx ? window.audioCtx.currentTime : null });
        stepRecordingTargetStepIndex = null;
        stepRecordingActiveChordStep = null;
        stepRecordingChordDeadlineTime = null;
        stepRecordingStepCleared = false;
    } else {
        ensureStepRecordingTargetInitialized();
    }
    updateStepRecordButtonState();
    const highlight = getCurrentHighlightStepNumber();
    updateStepVisuals(highlight);
}

function toggleStepRecording() {
    setStepRecordingEnabled(!stepRecordingEnabled);
}

function setStepRecordingSimpleMode(state) {
    const nextState = Boolean(state);
    if (stepRecordingSimpleMode === nextState) return;
    stepRecordingSimpleMode = nextState;
    updateStepRecordButtonState();
}

function toggleStepRecordingSimpleMode() {
    setStepRecordingSimpleMode(!stepRecordingSimpleMode);
}

function ensureStepRecordingTargetInitialized() {
    if (!stepRecordingEnabled) return null;
    const totalSteps = getTotalPatternSteps();
    if (!totalSteps) {
        stepRecordingTargetStepIndex = null;
        return null;
    }
    if (!Number.isInteger(stepRecordingTargetStepIndex)) {
        const fallback = Number.isInteger(userSelectedStartStep) ? userSelectedStartStep : 0;
        setStepRecordingTargetStep(fallback);
    }
    return stepRecordingTargetStepIndex;
}

function setStepRecordingTargetStep(stepIndex, options = {}) {
    const { resetChordState = true, userInitiated = false } = options;
    const totalSteps = getTotalPatternSteps();
    if (!totalSteps) {
        stepRecordingTargetStepIndex = null;
        return null;
    }
    const previousTarget = stepRecordingTargetStepIndex;
    const normalized = ((stepIndex % totalSteps) + totalSteps) % totalSteps;
    if (stepRecordingEnabled && Number.isInteger(previousTarget) && previousTarget !== normalized) {
        commitStepRecordingBaselinesForStep(previousTarget);
        applyStepRecordingAutomationBaselines();
    }
    stepRecordingTargetStepIndex = normalized;
    if (resetChordState) {
        stepRecordingActiveChordStep = null;
        stepRecordingChordDeadlineTime = null;
        stepRecordingStepCleared = false;
    }
    const stepsPerPage = getStepsPerPage();
    if (stepsPerPage) {
        const pageIndex = Math.floor(normalized / stepsPerPage);
        if (pageIndex !== currentPageIndex) {
            setCurrentPage(pageIndex);
        }
    }
    if (userInitiated) {
        userSelectedStartStep = normalized;
    }
    updateStepVisuals(normalized + 1);
    applyStepAutomationPreview(normalized);
    return normalized;
}

function advanceStepRecordingTarget(direction = 1) {
    const totalSteps = getTotalPatternSteps();
    if (!totalSteps) return null;
    const current = Number.isInteger(stepRecordingTargetStepIndex)
        ? stepRecordingTargetStepIndex
        : (Number.isInteger(userSelectedStartStep) ? userSelectedStartStep : 0);
    const nextIndex = ((current + direction) % totalSteps + totalSteps) % totalSteps;
    return setStepRecordingTargetStep(nextIndex);
}

function prepareStepRecordingStep(stepIndex) {
    if (stepRecordingStepCleared) return;
    clearStepNotes(stepIndex, { clearAutomation: false });
    stepRecordingStepCleared = true;
}

function startStepRecordingChord(now) {
    const target = ensureStepRecordingTargetInitialized();
    if (!Number.isInteger(target)) return null;
    prepareStepRecordingStep(target);
    stepRecordingActiveChordStep = target;
    stepRecordingChordDeadlineTime = now + (STEP_RECORD_CHORD_WINDOW_MS / 1000);
    return target;
}

function createStepRecordingEvent(stepIndex, noteNumber, velocity = 1) {
    const totalSteps = getTotalPatternSteps();
    if (!totalSteps) return null;
    const normalizedPosition = normalizeLoopPosition(stepIndex / totalSteps);
    const event = {
        id: ++sequencerEventIdCounter,
        position: normalizedPosition,
        noteNumber,
        velocity: velocity ?? 1,
        durationNormalized: stepRecordingSimpleMode
            ? Math.max(MIN_DURATION_NORMALIZED, 1 / totalSteps)
            : getDefaultDurationNormalized()
    };
    canonicalSequencerEvents.push(event);
    rebuildSequencerPatternFromCanonical({ skipIndicatorUpdate: true });
    refreshVisibleStepNoteIndicators();
    return event;
}

function handleStepRecordingNoteOn(noteNumber, velocity = 1, options = {}) {
    if (!stepRecordingEnabled) return false;
    if (options?.source === 'arp') return false;
    const audioContext = window.audioCtx;
    if (!audioContext) return false;
    const now = typeof options.startTime === 'number' ? options.startTime : audioContext.currentTime;
    const totalSteps = getTotalPatternSteps();
    if (!totalSteps) return false;

    if (Number.isInteger(stepRecordingActiveChordStep) && stepRecordingChordDeadlineTime !== null && now > stepRecordingChordDeadlineTime) {
        advanceStepRecordingTarget(1);
    }

    if (!Number.isInteger(stepRecordingActiveChordStep)) {
        startStepRecordingChord(now);
    }

    if (!Number.isInteger(stepRecordingActiveChordStep)) return true;
    const event = createStepRecordingEvent(stepRecordingActiveChordStep, noteNumber, velocity);
    if (!event) return true;
    const stack = stepRecordingPendingNotes.get(noteNumber) || [];
    stack.push({
        eventId: event.id,
        stepIndex: stepRecordingActiveChordStep,
        startTime: now,
        totalStepsAtCapture: totalSteps,
        simpleMode: stepRecordingSimpleMode
    });
    stepRecordingPendingNotes.set(noteNumber, stack);
    return true;
}

function finalizeStepRecordingEntry(entry, options = {}) {
    if (!entry) return false;
    const event = canonicalSequencerEvents.find(evt => evt && evt.id === entry.eventId);
    if (!event) return false;
    const audioContext = window.audioCtx;
    const referenceTime = typeof options.forceTime === 'number'
        ? options.forceTime
        : (audioContext ? audioContext.currentTime : null);
    const hasReferenceTime = Number.isFinite(referenceTime);
    const durationSeconds = hasReferenceTime
        ? Math.max(0.005, referenceTime - entry.startTime)
        : null;
    const totalSteps = Math.max(1, entry.totalStepsAtCapture || getTotalPatternSteps() || 1);
    let normalizedDuration;
    const useSimpleMode = entry.simpleMode ?? stepRecordingSimpleMode;
    if (useSimpleMode) {
        normalizedDuration = Math.max(MIN_DURATION_NORMALIZED, 1 / totalSteps);
    } else {
        const stepDuration = getStepDurationSeconds();
        if (stepDuration && durationSeconds !== null) {
            const stepsElapsed = durationSeconds / stepDuration;
            normalizedDuration = Math.max(MIN_DURATION_NORMALIZED, stepsElapsed / totalSteps);
        } else {
            normalizedDuration = getDefaultDurationNormalized();
        }
    }
    event.durationNormalized = normalizedDuration;
    return true;
}

function finalizeAllStepRecordingCaptures(options = {}) {
    if (!stepRecordingPendingNotes.size) return false;
    let didUpdate = false;
    stepRecordingPendingNotes.forEach(stack => {
        stack.forEach(entry => {
            if (finalizeStepRecordingEntry(entry, options)) {
                didUpdate = true;
            }
        });
    });
    stepRecordingPendingNotes.clear();
    if (didUpdate) {
        rebuildSequencerPatternFromCanonical();
    }
    return didUpdate;
}

function hasActiveStepRecordingNotes(stepIndex) {
    for (const stack of stepRecordingPendingNotes.values()) {
        if (Array.isArray(stack) && stack.some(entry => entry.stepIndex === stepIndex)) {
            return true;
        }
    }
    return false;
}

function maybeAdvanceStepRecordingAfterRelease(stepIndex) {
    if (!stepRecordingEnabled) return;
    if (!Number.isInteger(stepRecordingActiveChordStep)) return;
    if (stepRecordingActiveChordStep !== stepIndex) return;
    if (hasActiveStepRecordingNotes(stepIndex)) return;
    advanceStepRecordingTarget(1);
}

function handleStepRecordingNoteRelease(noteNumber, options = {}) {
    if (!stepRecordingEnabled && !stepRecordingPendingNotes.size) return false;
    const stack = stepRecordingPendingNotes.get(noteNumber);
    if (!stack || !stack.length) return false;
    const entry = stack.pop();
    if (!stack.length) {
        stepRecordingPendingNotes.delete(noteNumber);
    }
    const releaseTime = typeof options.releaseTime === 'number'
        ? options.releaseTime
        : (window.audioCtx ? window.audioCtx.currentTime : null);
    const finalizeOptions = typeof releaseTime === 'number' ? { forceTime: releaseTime } : {};
    if (finalizeStepRecordingEntry(entry, finalizeOptions)) {
        rebuildSequencerPatternFromCanonical();
    }
    maybeAdvanceStepRecordingAfterRelease(entry.stepIndex);
    return true;
}

function recordStepAutomationValue(paramId, rawValue) {
    if (!stepRecordingEnabled || !modRecordingEnabled) return false;
    const targetStep = ensureStepRecordingTargetInitialized();
    if (!Number.isInteger(targetStep)) return false;
    const totalSteps = getTotalPatternSteps();
    if (!totalSteps) return false;
    const value = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    if (!Number.isFinite(value)) return false;
    rememberStepRecordingBaseline(paramId);
    const stepBaseline = stepRecordingAutomationBaselines?.get(paramId);
    if (Number.isFinite(stepBaseline)) {
        automationLaneBaselines.set(paramId, stepBaseline);
    } else if (automationBaselineValues.has(paramId) && Number.isFinite(automationBaselineValues.get(paramId))) {
        automationLaneBaselines.set(paramId, automationBaselineValues.get(paramId));
    }
    const normalizedPosition = normalizeLoopPosition(targetStep / totalSteps);
    const lane = automationLanes.get(paramId) || [];
    const preserved = lane.filter(evt => {
        if (!evt || !Number.isFinite(evt.position)) return true;
        const evtStep = Math.floor(normalizeLoopPosition(evt.position) * totalSteps);
        return evtStep !== targetStep;
    });
    preserved.push({
        id: ++automationEventIdCounter,
        position: normalizedPosition,
        value
    });
    preserved.sort((a, b) => a.position - b.position);
    automationLanes.set(paramId, preserved);
    stepRecordingTouchedParams.add(paramId);
    refreshVisibleStepNoteIndicators();
    console.log(`Step REC: set ${paramId} to ${(value).toFixed(3)} on step ${targetStep + 1}`);
    return true;
}

function applyUserSelectedStartStep() {
    if (userSelectedStartStep === null) return;
    const loopSteps = getEffectiveLoopLengthSteps();
    if (!loopSteps) return;
    currentStepPosition = (userSelectedStartStep - 1 + loopSteps) % loopSteps;
}

function rebuildQuantizeOptions() {
    const options = [];
    quantizeBaseModes.forEach(mode => {
        const baseBeats = Math.max(1 / 16384, mode.beatsFn());
        options.push({ label: mode.label, beats: baseBeats });
        if (mode.allowTriplet) {
            options.push({ label: `${mode.label} T`, beats: baseBeats * TRIPLET_RATIO });
        }
    });
    quantizeOptions = options;
    if (currentQuantizeIndex === null) {
        const defaultIndex = quantizeOptions.findIndex(opt => opt.label === DEFAULT_QUANTIZE_LABEL);
        currentQuantizeIndex = defaultIndex >= 0 ? defaultIndex : 0;
    } else {
        currentQuantizeIndex = Math.max(0, Math.min(quantizeOptions.length - 1, currentQuantizeIndex));
    }
    updateQuantizeKnobRotation();
}

function updateQuantizeKnobRotation() {
    if (!quantizeKnobElement || !quantizeOptions.length || currentQuantizeIndex === null) return;
    const normalized = quantizeOptions.length > 1
        ? currentQuantizeIndex / (quantizeOptions.length - 1)
        : 0;
    const rotation = (normalized * 300) - 150;
    quantizeKnobElement.style.transform = `rotate(${rotation}deg)`;
}

function updateModRecButtonState() {
    const modButton = document.getElementById('seq-motion-button');
    if (!modButton) return;
    modButton.classList.toggle('active', modRecordingEnabled);
}

function setModRecordingEnabled(state) {
    modRecordingEnabled = Boolean(state);
    updateModRecButtonState();
    console.log(`Sequencer: MOD REC ${modRecordingEnabled ? 'ENABLED' : 'DISABLED'}`);
    if (!modRecordingEnabled) {
        resetModAutomationSession();
    }
}

function toggleModRecording() {
    setModRecordingEnabled(!modRecordingEnabled);
}

function updateRecordPrecountIndicator() {
    const recordButton = document.getElementById('seq-record-button');
    if (!recordButton) return;
    const hasPrecount = preCountRequested || isPreCountActive;
    recordButton.classList.toggle('precount-armed', hasPrecount);

    let countdownLabel = recordButton.querySelector('.record-precount-label');
    if (!countdownLabel) {
        countdownLabel = document.createElement('div');
        countdownLabel.className = 'record-precount-label';
        recordButton.appendChild(countdownLabel);
    }

    const icon = recordButton.querySelector('.icon');
    const shouldShowCountdown = isPreCountActive && preCountDisplayNumber !== null;
    countdownLabel.style.display = shouldShowCountdown ? 'flex' : 'none';
    countdownLabel.textContent = shouldShowCountdown ? preCountDisplayNumber : '';
    if (icon) {
        icon.style.visibility = shouldShowCountdown ? 'hidden' : '';
    }
}

function clearPrecountState() {
    preCountRequested = false;
    isPreCountActive = false;
    preCountStepsRemaining = 0;
    preCountTotalSteps = 0;
    preCountTotalBeats = 0;
    preCountDisplayNumber = null;
    updateRecordPrecountIndicator();
}

function handleRecordButtonDoubleClick(event) {
    event.preventDefault();
    event.stopPropagation();
    setSequencerRecordArmed(true);
    preCountRequested = true;
    isPreCountActive = false;
    preCountStepsRemaining = 0;
    preCountTotalSteps = 0;
    preCountTotalBeats = 0;
    preCountDisplayNumber = null;
    updateRecordPrecountIndicator();
    console.log('Sequencer: pre-count armed (double-click)');
}

function beginPrecountIfNeeded() {
    if (!sequencerRecordArmed || !preCountRequested || isPreCountActive) return;
    const steps = Math.max(1, getStepsPerPage() || currentStepCount || 0);
    const beats = Math.max(1, globalMeterNumerator);
    preCountTotalSteps = steps;
    preCountStepsRemaining = steps;
    preCountTotalBeats = beats;
    preCountDisplayNumber = beats;
    isPreCountActive = true;
    preCountRequested = false;
    updateRecordPrecountIndicator();
    console.log(`Sequencer: pre-count engaged for ${steps} step(s)`);
}

function handlePrecountStepAdvance() {
    if (!isPreCountActive) return;
    if (preCountStepsRemaining > 0) {
        preCountStepsRemaining -= 1;
    }
    const stepsPerBeat = Math.max(1e-6, getStepsPerBeat() || 1);
    const stepsCompleted = Math.max(0, preCountTotalSteps - preCountStepsRemaining);
    const beatsElapsed = stepsCompleted / stepsPerBeat;
    const beatsRemaining = Math.max(0, preCountTotalBeats - beatsElapsed);
    const countdownValue = beatsRemaining > 0 ? Math.ceil(beatsRemaining) : null;
    if (preCountDisplayNumber !== countdownValue) {
        preCountDisplayNumber = countdownValue;
        updateRecordPrecountIndicator();
    }
    if (preCountStepsRemaining <= 0) {
        isPreCountActive = false;
        preCountDisplayNumber = null;
        updateRecordPrecountIndicator();
        console.log('Sequencer: pre-count finished, recording enabled');
    }
}

function isModAutomationRecordingActive() {
    return sequencerRecordArmed && modRecordingEnabled && isTempoPlaying && !isPreCountActive;
}

function normalizeAutomationPosition() {
    const totalSteps = getTotalPatternSteps();
    if (!totalSteps) return null;
    const audioContext = window.audioCtx;
    if (!audioContext || currentLoopStartTime === null || !Number.isFinite(currentLoopDurationSeconds) || currentLoopDurationSeconds <= 0) {
        return null;
    }
    const now = audioContext.currentTime;
    const elapsed = now - currentLoopStartTime;
    const normalized = normalizeLoopPosition(elapsed / currentLoopDurationSeconds);
    return {
        normalized,
        totalSteps
    };
}

export function registerModAutomationTarget(paramId, setterFn) {
    if (!paramId || typeof setterFn !== 'function') return;
    automationTargets.set(paramId, setterFn);
    console.log(`Sequencer: registered automation target ${paramId}`);
}

function applyAutomationValue(paramId, value) {
    const setter = automationTargets.get(paramId);
    if (!setter) return;
    try {
        setter(value);
        automationCurrentValues.set(paramId, value);
    } catch (error) {
        console.error(`Sequencer automation: failed to apply ${paramId}`, error);
    }
}

function normalizeLoopPosition(position) {
    if (!Number.isFinite(position)) return 0;
    let normalized = position % 1;
    if (normalized < 0) {
        normalized += 1;
    }
    return normalized;
}

function getLoopStepInfoForTime(targetTime) {
    const totalSteps = getTotalPatternSteps();
    if (!totalSteps) return null;
    const audioContext = window.audioCtx;
    if (!audioContext) return null;
    const stepDurationSeconds = getStepDurationSeconds();
    if (!stepDurationSeconds) return null;
    const referenceTime = typeof targetTime === 'number' ? targetTime : audioContext.currentTime;

    if (currentLoopStartTime !== null && Number.isFinite(currentLoopDurationSeconds) && currentLoopDurationSeconds > 0) {
        const elapsed = referenceTime - currentLoopStartTime;
        if (Number.isFinite(elapsed)) {
            const normalized = normalizeLoopPosition(elapsed / currentLoopDurationSeconds);
            return {
                rawSteps: normalized * totalSteps,
                stepDurationSeconds,
                totalSteps
            };
        }
    }

    if (currentStepPosition < 0 || lastStepTimestamp === null) return null;
    let fraction = (referenceTime - lastStepTimestamp) / stepDurationSeconds;
    if (!Number.isFinite(fraction)) {
        fraction = 0;
    }
    fraction = Math.max(0, Math.min(0.999, fraction));
    const rawSteps = (currentStepPosition + fraction) % totalSteps;
    return {
        rawSteps,
        stepDurationSeconds,
        totalSteps
    };
}

function shouldUseMonoLegato(startTime) {
    if (typeof window === 'undefined' || !window || !window.isMonoMode) return false;
    const wantsLegato = window.isLegatoMode || window.isPortamentoOn;
    if (!wantsLegato) return false;
    if (lastSequencerNoteReleaseTime === null) return false;
    return startTime <= lastSequencerNoteReleaseTime + MONO_LEGATO_MAX_GAP;
}

export function updateAutomationBaselineValue(paramId, rawValue) {
    if (!paramId) return;
    const value = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    if (!Number.isFinite(value)) return;
    automationBaselineValues.set(paramId, value);
    automationCurrentValues.set(paramId, value);
}

function buildAutomationBaselineSnapshot() {
    const snapshot = new Map();
    automationBaselineValues.forEach((value, paramId) => {
        if (Number.isFinite(value)) {
            snapshot.set(paramId, value);
        }
    });
    automationLaneBaselines.forEach((value, paramId) => {
        if (Number.isFinite(value)) {
            snapshot.set(paramId, value);
        }
    });
    return snapshot;
}

function hasActiveAutomationForParam(paramId) {
    const lane = automationLanes.get(paramId);
    return Array.isArray(lane) && lane.length > 0;
}

function hasAnyActiveAutomationLanes() {
    for (const lane of automationLanes.values()) {
        if (Array.isArray(lane) && lane.length > 0) {
            return true;
        }
    }
    return false;
}

function captureAutomationPlaybackStartValues() {
    automationPlaybackStartValues = buildAutomationBaselineSnapshot();
}

function restoreAutomationPlaybackStartValues() {
    if (!automationPlaybackStartValues || !automationPlaybackStartValues.size) return;
    if (!hasAnyActiveAutomationLanes()) return;
    automationPlaybackStartValues.forEach((value, paramId) => {
        if (!hasActiveAutomationForParam(paramId)) return;
        if (!Number.isFinite(value)) return;
        applyAutomationValue(paramId, value);
    });
}

function clearAutomationPlaybackSnapshot() {
    automationPlaybackStartValues = null;
}

function applyAutomationBaselineValues(options = {}) {
    if (!automationBaselineValues.size) return;
    const { onlyAutomated = false, limitParamIds = null } = options;
    const hasLimitList = Array.isArray(limitParamIds);
    const normalizedLimitIds = hasLimitList
        ? limitParamIds.filter(id => typeof id === 'string' || typeof id === 'number')
        : null;
    if (hasLimitList && (!normalizedLimitIds || !normalizedLimitIds.length)) {
        return;
    }
    const limitSet = normalizedLimitIds ? new Set(normalizedLimitIds) : null;
    automationBaselineValues.forEach((value, paramId) => {
        if (!Number.isFinite(value)) return;
        if (limitSet && !limitSet.has(paramId)) return;
        if (onlyAutomated && !hasActiveAutomationForParam(paramId)) return;
        applyAutomationValue(paramId, value);
    });
}

function updateLaneBaselineForParam(paramId) {
    if (!paramId || !modAutomationSessionActive) return;
    const sourceMap = modRecordingSessionBaseline || automationBaselineValues;
    if (!sourceMap) return;
    const value = sourceMap.has(paramId)
        ? sourceMap.get(paramId)
        : automationBaselineValues.get(paramId);
    if (!Number.isFinite(value)) return;
    automationLaneBaselines.set(paramId, value);
    captureAutomationPlaybackStartValues();
}

function updateModRecordingSessionState() {
    const active = isModAutomationRecordingActive();
    if (active) {
        if (!modAutomationSessionActive) {
            modRecordingSessionBaseline = new Map(automationBaselineValues);
            captureAutomationPlaybackStartValues();
            modAutomationSessionActive = true;
            console.log('Sequencer: captured automation baseline for motion recording');
        }
    } else if (modAutomationSessionActive) {
        modAutomationSessionActive = false;
    }
}

function resetModAutomationSession() {
    modAutomationSessionActive = false;
    modRecordingSessionBaseline = null;
}

function clearAllAutomationRecordings(options = {}) {
    const { skipBaselineRestore = false, suppressLog = false } = options;
    const paramsWithAutomation = [];
    automationLanes.forEach((lane, paramId) => {
        if (Array.isArray(lane) && lane.length > 0) {
            paramsWithAutomation.push(paramId);
        }
    });
    automationLanes.clear();
    automationLaneBaselines.clear();
    clearScheduledAutomationEvents();
    clearAutomationPlaybackSnapshot();
    if (!skipBaselineRestore && paramsWithAutomation.length) {
        applyAutomationBaselineValues({ limitParamIds: paramsWithAutomation });
    }
    refreshVisibleStepNoteIndicators();
    if (!suppressLog) {
        console.log('Sequencer: cleared all recorded motion');
    }
}

function scheduleAutomationEvent(paramId, value, eventTime) {
    const audioContext = window.audioCtx;
    if (!audioContext) return;
    const now = audioContext.currentTime;
    const delayMs = Math.max(0, (eventTime - now) * 1000);
    const timeoutId = setTimeout(() => {
        automationPlaybackTimeouts.delete(timeoutId);
        applyAutomationValue(paramId, value);
    }, delayMs);
    automationPlaybackTimeouts.add(timeoutId);
}

function clearScheduledAutomationEvents() {
    automationPlaybackTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
    automationPlaybackTimeouts.clear();
}

function scheduleAutomationForStep(stepIndex, stepStartTime) {
    if (!automationTargets.size || !automationLanes.size) return;
    const totalSteps = getTotalPatternSteps();
    const stepDuration = getStepDurationSeconds();
    if (!totalSteps || !stepDuration) return;
    const stepSize = 1 / totalSteps;
    const stepStartNorm = stepIndex / totalSteps;
    const stepEndNorm = stepStartNorm + stepSize;
    const wraps = stepEndNorm > 1;
    const paramsTriggeredThisStep = new Set();
    automationLanes.forEach((lane, paramId) => {
        if (!Array.isArray(lane) || !lane.length) return;
        lane.forEach(evt => {
            const eventPosition = normalizeLoopPosition(evt?.position ?? 0);
            let relativeProgress = null;
            if (!wraps) {
                if (eventPosition >= stepStartNorm && eventPosition < stepEndNorm) {
                    relativeProgress = (eventPosition - stepStartNorm) / stepSize;
                }
            } else {
                const adjustedEnd = stepEndNorm - 1;
                if (eventPosition >= stepStartNorm || eventPosition < adjustedEnd) {
                    const adjustedPosition = eventPosition >= stepStartNorm ? eventPosition : eventPosition + 1;
                    relativeProgress = (adjustedPosition - stepStartNorm) / stepSize;
                }
            }
            if (relativeProgress === null) return;
            const boundedProgress = Math.max(0, Math.min(1, relativeProgress));
            const eventTime = stepStartTime + boundedProgress * stepDuration;
            paramsTriggeredThisStep.add(paramId);
            scheduleAutomationEvent(paramId, evt.value, eventTime);
        });
    });

    if (stepRecordingEnabled) {
        if (!stepRecordingTouchedParams.size || !stepRecordingAutomationBaselines) return;
        let lanesChanged = false;
        stepRecordingTouchedParams.forEach(paramId => {
            if (paramsTriggeredThisStep.has(paramId)) return;
            const inserted = ensureBaselineAutomationEventForStep(paramId, stepIndex);
            if (!inserted) return;
            const baselineValue = stepRecordingAutomationBaselines.get(paramId);
            if (!Number.isFinite(baselineValue)) return;
            paramsTriggeredThisStep.add(paramId);
            lanesChanged = true;
            scheduleAutomationEvent(paramId, baselineValue, stepStartTime);
        });
        if (lanesChanged) {
            refreshVisibleStepNoteIndicators();
        }
        return;
    }

    const isLoopResetStep = stepIndex === 0;
    if (!isLoopResetStep || !automationLaneBaselines.size) return;
    automationLaneBaselines.forEach((baselineValue, paramId) => {
        if (!Number.isFinite(baselineValue)) return;
        if (paramsTriggeredThisStep.has(paramId)) return;
        if (!hasActiveAutomationForParam(paramId)) return;
        scheduleAutomationEvent(paramId, baselineValue, stepStartTime);
    });
}

export function recordModAutomationValue(paramId, rawValue) {
    if (!paramId || !automationTargets.has(paramId)) return;
    const canStepRecordAutomation = stepRecordingEnabled && modRecordingEnabled;
    if (canStepRecordAutomation && recordStepAutomationValue(paramId, rawValue)) {
        return;
    }
    updateModRecordingSessionState();
    if (!isModAutomationRecordingActive()) return;
    const value = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    if (!Number.isFinite(value)) return;
    updateLaneBaselineForParam(paramId);
    const positionInfo = normalizeAutomationPosition();
    if (!positionInfo) return;
    const normalizedPosition = normalizeLoopPosition(positionInfo.normalized);
    const totalSteps = positionInfo.totalSteps;
    const lane = automationLanes.get(paramId) || [];
    const mergeWindow = (1 / Math.max(1, totalSteps)) / Math.max(1, AUTOMATION_POSITION_MERGE_DIVISOR);
    const valueThreshold = Math.max(AUTOMATION_VALUE_EPSILON, Math.abs(value) * AUTOMATION_VALUE_EPSILON);
    for (let i = lane.length - 1; i >= 0; i--) {
        const existing = lane[i];
        if (!existing) continue;
        const diff = Math.abs(existing.position - normalizedPosition);
        const wrappedDiff = Math.min(diff, Math.abs(diff - 1));
        if (wrappedDiff <= mergeWindow) {
            const valueDiff = Math.abs((existing.value ?? 0) - value);
            if (valueDiff <= valueThreshold) {
                lane.splice(i, 1);
            }
        }
    }
    lane.push({
        id: ++automationEventIdCounter,
        position: normalizedPosition,
        value
    });
    lane.sort((a, b) => a.position - b.position);
    automationLanes.set(paramId, lane);
    refreshVisibleStepNoteIndicators();
    console.log(`Sequencer: captured mod automation for ${paramId} at ${(normalizedPosition * 100).toFixed(2)}%`);
}

function setSequencerRecordArmed(state) {
    sequencerRecordArmed = state;
    const recordButton = document.getElementById('seq-record-button');
    if (recordButton) {
        recordButton.classList.toggle('active', sequencerRecordArmed);
    }
    if (!state) {
        finalizeAllPendingCaptures({ forceTime: window.audioCtx ? window.audioCtx.currentTime : null });
        clearPrecountState();
        resetModAutomationSession();
    } else {
        updateRecordPrecountIndicator();
    }
}

function toggleSequencerRecordArm() {
    setSequencerRecordArmed(!sequencerRecordArmed);
}

function getQuantizeUnitBeats() {
    if (!quantizeOptions.length) {
        rebuildQuantizeOptions();
    }
    if (currentQuantizeIndex === null && quantizeOptions.length) {
        currentQuantizeIndex = 0;
    }
    const option = quantizeOptions[currentQuantizeIndex ?? 0];
    return option ? option.beats : 0.25;
}

function getQuantizeUnitSteps() {
    const beats = getQuantizeUnitBeats();
    const stepsPerBeat = getStepsPerBeat();
    return beats * (stepsPerBeat || 1);
}

function quantizeStepPosition(rawSteps) {
    const totalSteps = getTotalPatternSteps();
    if (!totalSteps) return { stepIndex: 0, offset: 0 };
    let position = rawSteps;
    const quantumSteps = getQuantizeUnitSteps();
    if (quantumSteps > 0) {
        position = Math.round(position / quantumSteps) * quantumSteps;
    }
    const wrapped = ((position % totalSteps) + totalSteps) % totalSteps;
    let stepIndex = Math.floor(wrapped);
    let offset = wrapped - stepIndex;
    if (stepIndex >= totalSteps) {
        stepIndex = 0;
        offset = 0;
    }
    return { stepIndex, offset };
}

function requantizePattern(options = {}) {
    rebuildSequencerPatternFromCanonical(options);
}

function rebuildSequencerPatternFromCanonical(options = {}) {
    const { skipIndicatorUpdate = false } = options;
    const totalSteps = getTotalPatternSteps();
    if (!Number.isFinite(totalSteps) || totalSteps <= 0) {
        sequencerPattern = [];
        if (!skipIndicatorUpdate) {
            refreshVisibleStepNoteIndicators();
        }
        return;
    }
    ensurePatternLength();
    for (let i = 0; i < sequencerPattern.length; i++) {
        sequencerPattern[i] = [];
    }
    canonicalSequencerEvents.forEach(evt => {
        const rawSteps = evt.position * totalSteps;
        const { stepIndex, offset } = quantizeStepPosition(rawSteps);
        if (!sequencerPattern[stepIndex]) {
            sequencerPattern[stepIndex] = [];
        }
        sequencerPattern[stepIndex].push({
            noteNumber: evt.noteNumber,
            velocity: evt.velocity ?? 1,
            offset: Math.max(0, Math.min(0.999, offset || 0)),
            durationNormalized: evt.durationNormalized
        });
    });
    if (!skipIndicatorUpdate) {
        refreshVisibleStepNoteIndicators();
    }
}

function getDefaultDurationNormalized() {
    const totalSteps = getTotalPatternSteps();
    if (!Number.isFinite(totalSteps) || totalSteps <= 0) {
        return MIN_DURATION_NORMALIZED;
    }
    const quantum = Math.max(1, Math.round(getQuantizeUnitSteps() || 1));
    return Math.max(MIN_DURATION_NORMALIZED, quantum / totalSteps);
}

function createCanonicalEvent(rawStepPosition, noteNumber, velocity = 1) {
    const totalSteps = getTotalPatternSteps();
    if (!Number.isFinite(totalSteps) || totalSteps <= 0) return null;
    const wrapped = ((rawStepPosition % totalSteps) + totalSteps) % totalSteps;
    const normalized = wrapped / totalSteps;
    const { stepIndex: targetStepIndex } = quantizeStepPosition(wrapped);
    canonicalSequencerEvents = canonicalSequencerEvents.filter(evt => {
        if (evt.noteNumber !== noteNumber) return true;
        const evtSteps = evt.position * totalSteps;
        const { stepIndex: existingStep } = quantizeStepPosition(evtSteps);
        return existingStep !== targetStepIndex;
    });
    const event = {
        id: ++sequencerEventIdCounter,
        position: normalized,
        noteNumber,
        velocity: velocity ?? 1,
        durationNormalized: getDefaultDurationNormalized()
    };
    canonicalSequencerEvents.push(event);
    rebuildSequencerPatternFromCanonical({ skipIndicatorUpdate: true });
    refreshVisibleStepNoteIndicators();
    return event;
}

function finalizePendingCapture(entry, options = {}) {
    if (!entry) return false;
    const audioContext = window.audioCtx;
    if (!audioContext) return false;
    const event = canonicalSequencerEvents.find(evt => evt.id === entry.eventId);
    if (!event) return false;
    const now = options.forceTime ?? audioContext.currentTime;
    const durationSeconds = Math.max(0.01, now - entry.startTime);
    const stepDuration = Math.max(0.0001, entry.stepDurationSeconds);
    const stepsElapsed = durationSeconds / stepDuration;
    const totalSteps = Math.max(1, entry.totalStepsAtCapture);
    const normalized = Math.max(MIN_DURATION_NORMALIZED, stepsElapsed / totalSteps);
    event.durationNormalized = normalized;
    return true;
}

function finalizeAllPendingCaptures(options = {}) {
    let didUpdate = false;
    pendingRecordedNotes.forEach(stack => {
        stack.forEach(entry => {
            if (finalizePendingCapture(entry, options)) {
                didUpdate = true;
            }
        });
    });
    pendingRecordedNotes.clear();
    if (didUpdate) {
        rebuildSequencerPatternFromCanonical();
    }
}

function beginLiveNoteCapture(noteNumber, rawStepPosition, velocity = 1, options = {}) {
    const audioContext = window.audioCtx;
    if (!audioContext) return;
    const stepDuration = Number.isFinite(options.stepDurationSeconds)
        ? options.stepDurationSeconds
        : getStepDurationSeconds();
    if (!stepDuration) return;
    const event = createCanonicalEvent(rawStepPosition, noteNumber, velocity);
    if (!event) return;
    const stack = pendingRecordedNotes.get(noteNumber) || [];
    const captureStartTime = typeof options.startTime === 'number'
        ? options.startTime
        : audioContext.currentTime;
    const totalStepsAtCapture = Number.isFinite(options.totalStepsAtCapture)
        ? Math.max(1, options.totalStepsAtCapture)
        : Math.max(1, getTotalPatternSteps());
    stack.push({
        eventId: event.id,
        noteNumber,
        startTime: captureStartTime,
        stepDurationSeconds: stepDuration,
        totalStepsAtCapture
    });
    pendingRecordedNotes.set(noteNumber, stack);
}

export function handleLiveSequencerNoteRelease(noteNumber, options = {}) {
    if (handleStepRecordingNoteRelease(noteNumber, options)) {
        return;
    }
    if (!sequencerRecordArmed || !isTempoPlaying) return;
    const stack = pendingRecordedNotes.get(noteNumber);
    if (!stack || stack.length === 0) return;
    const entry = stack.pop();
    if (stack.length === 0) {
        pendingRecordedNotes.delete(noteNumber);
    }
    const releaseTime = typeof options.releaseTime === 'number'
        ? options.releaseTime
        : undefined;
    const finalizeOptions = releaseTime !== undefined ? { forceTime: releaseTime } : undefined;
    if (finalizePendingCapture(entry, finalizeOptions || {})) {
        rebuildSequencerPatternFromCanonical();
    }
}

// --- Keyboard Octave Functions ---
function updateOctaveIndicator() {
    const dots = document.querySelectorAll('.seq-pitch-column .seq-dot');
    dots.forEach((dot, index) => {
        // octaveShift: -2, -1, 0, 1, 2 maps to dots 0, 1, 2, 3, 4
        const dotValue = index - 2; // Map index to octave value
        if (dotValue === keyboardOctaveShift) {
            dot.classList.add('active');
        } else {
            dot.classList.remove('active');
        }
    });
}

export function getKeyboardOctaveShift() {
    return keyboardOctaveShift;
}

export function handleLiveSequencerNoteInput(noteNumber, velocity = 1, options = {}) {
    if (handleStepRecordingNoteOn(noteNumber, velocity, options)) {
        return;
    }
    if (!sequencerRecordArmed || !isTempoPlaying) return;
    if (isPreCountActive) return;
    const audioContext = window.audioCtx;
    if (!audioContext) return;
    const targetTime = typeof options.startTime === 'number'
        ? options.startTime
        : audioContext.currentTime;
    const loopInfo = getLoopStepInfoForTime(targetTime);
    if (!loopInfo) return;
    const { rawSteps, stepDurationSeconds, totalSteps } = loopInfo;
    const { stepIndex, offset } = quantizeStepPosition(rawSteps);
    beginLiveNoteCapture(noteNumber, rawSteps, velocity, {
        startTime: targetTime,
        stepDurationSeconds,
        totalStepsAtCapture: totalSteps
    });
    const activeIndex = currentQuantizeIndex ?? 0;
    const quantLabel = quantizeOptions[activeIndex]?.label || DEFAULT_QUANTIZE_LABEL;
    const sourceLabel = options?.source ? ` via ${options.source}` : '';
    console.log(`Sequencer: recorded note ${noteNumber}${sourceLabel} on step ${stepIndex + 1} (offset ${offset.toFixed(3)} step units, quant ${quantLabel})`);
}

// --- Pitch Bend Functions ---
function applyPitchBend(semitones) {
    // Store current pitch bend value globally
    window.sequencerPitchBend = semitones;
    
    // Apply pitch bend to all active voices
    const now = window.audioCtx ? window.audioCtx.currentTime : 0;
    
    // Access voicePool from main.js
    if (window.voicePool) {
        window.voicePool.forEach(voice => {
            if (voice.state !== 'inactive') {
                // Osc1
                if (voice.osc1Note && voice.osc1Note.workletNode) {
                    const detuneParam = voice.osc1Note.workletNode.parameters.get('detune');
                    if (detuneParam) {
                        const basePitch = window.osc1Detune || 0;
                        detuneParam.setValueAtTime(basePitch + (semitones * 100), now);
                    }
                }
                
                // Osc2
                if (voice.osc2Note && voice.osc2Note.workletNode) {
                    const detuneParam = voice.osc2Note.workletNode.parameters.get('detune');
                    if (detuneParam) {
                        const basePitch = window.osc2Detune || 0;
                        detuneParam.setValueAtTime(basePitch + (semitones * 100), now);
                    }
                }
                
                // Sampler
                if (voice.samplerNote && voice.samplerNote.source) {
                    const playbackRate = Math.pow(2, semitones / 12);
                    voice.samplerNote.source.playbackRate.setValueAtTime(playbackRate, now);
                }
            }
        });
    }
    
    console.log(`Pitch bend: ${semitones.toFixed(2)} semitones`);
}

function returnPitchBend(slider) {
    // Animate slider back to center
    const startValue = parseFloat(slider.value);
    const duration = 200; // ms
    const startTime = Date.now();
    
    function animate() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Ease out
        const eased = 1 - Math.pow(1 - progress, 3);
        const newValue = startValue * (1 - eased);
        
        slider.value = newValue;
        currentPitchBend = newValue;
        applyPitchBend(newValue);
        
        if (progress < 1) {
            requestAnimationFrame(animate);
        } else {
            currentPitchBend = 0;
            applyPitchBend(0);
        }
    }
    
    animate();
}

// --- Initialize Division System ---
function initializeDivisionSystem() {
    // Set defaults
    divisionSettings['GLOBAL'] = { numerator: 4, denominator: 4 };
    divisionSettings['ARP'] = { type: '1/16', modifier: 'regular' };
    divisionSettings['LOSS'] = { type: '1/64', modifier: 'regular' };
    divisionSettings['DELAY'] = { type: '1/4', modifier: 'regular' };
    divisionSettings['LFO'] = { type: '1/4', modifier: 'regular' };
    divisionSettings['MOD'] = { type: '1/4', modifier: 'regular' };
    
    // Default connections
    divisionConnections['GLOBAL'] = true; // Always routed (master tempo)
    divisionConnections['ARP'] = true; // Permanently routed to its own scheduler
    divisionConnections['LOSS'] = true; // Loss/sidechain clock always follows tempo
    divisionConnections['DELAY'] = false;
    divisionConnections['LFO'] = false;
    divisionConnections['MOD'] = false;
    
    // Set default selected destination to null initially
    selectedDivisionDestination = null;
    currentDivisionDestination = 'GLOBAL';
    
    // Load metronome samples
    loadMetronomeSamples();
    
    // Initialize step buttons
    rebuildStepButtons();
    rebuildQuantizeOptions();
    
    // Initialize mod rate knob state
    updateModRateKnobState();
    
    console.log('Division system initialized');
}

function applyGlobalMeterSnapshot(numerator, denominator, options = {}) {
    const { forceUpdate = false } = options;
    const parsedNumerator = Number(numerator);
    const parsedDenominator = Number(denominator);
    const resolvedNumerator = meterNumerators.includes(parsedNumerator)
        ? parsedNumerator
        : globalMeterNumerator;
    const resolvedDenominator = meterDenominators.includes(parsedDenominator)
        ? parsedDenominator
        : globalMeterDenominator;
    const meterChanged = (resolvedNumerator !== globalMeterNumerator) || (resolvedDenominator !== globalMeterDenominator);
    if (meterChanged || forceUpdate) {
        globalMeterNumerator = resolvedNumerator;
        globalMeterDenominator = resolvedDenominator;
        divisionSettings['GLOBAL'] = {
            numerator: globalMeterNumerator,
            denominator: globalMeterDenominator
        };
        rebuildStepButtons();
        rebuildQuantizeOptions();
        requantizePattern({ skipIndicatorUpdate: true });
        updateDivisionKnobForDestination('GLOBAL');
    }
    return meterChanged;
}

// --- Load Metronome Click Samples ---
function loadMetronomeSamples() {
    const audioContext = window.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    
    // Load CLICK.wav from root folder
    fetch('CLICK.wav')
        .then(response => response.arrayBuffer())
        .then(arrayBuffer => audioContext.decodeAudioData(arrayBuffer))
        .then(audioBuffer => {
            metronomeSamples.click = audioBuffer;
            console.log('Metronome click loaded');
        })
        .catch(error => console.error('Error loading CLICK.wav:', error));
    
    // Load CLICK ACCENT.wav from root folder
    fetch('CLICK ACCENT.wav')
        .then(response => response.arrayBuffer())
        .then(arrayBuffer => audioContext.decodeAudioData(arrayBuffer))
        .then(audioBuffer => {
            metronomeSamples.accentClick = audioBuffer;
            console.log('Metronome accent click loaded');
        })
        .catch(error => console.error('Error loading CLICK ACCENT.wav:', error));
}

// --- Play Metronome Click ---
function playMetronomeClick(isAccent = false, time) {
    if (metronomeVolume === 0) return; // Don't play if muted
    
    const audioContext = window.audioCtx;
    if (!audioContext) {
        console.error('No audioContext available');
        return;
    }
    
    const sample = isAccent ? metronomeSamples.accentClick : metronomeSamples.click;
    
    if (!sample) {
        console.warn('Metronome sample not loaded yet');
        return;
    }
    
    try {
        // Validate time - must be in the future or very close to now
        const startTime = time || audioContext.currentTime;
        
        // Don't try to start sounds in the past
        if (startTime < audioContext.currentTime - 0.01) {
            console.warn('Skipping click - time is in the past:', startTime, 'vs', audioContext.currentTime);
            return;
        }
        
        const source = audioContext.createBufferSource();
        source.buffer = sample;
        
        const gainNode = audioContext.createGain();
        gainNode.gain.value = metronomeVolume;
        
        source.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        // Add error handler
        source.onended = null; // Clear any previous handlers
        
        source.start(Math.max(startTime, audioContext.currentTime));
    } catch (error) {
        console.error('Error playing metronome click:', error.message, 'time:', time, 'currentTime:', audioContext.currentTime);
    }
}

// --- Calculate Interval Time in MS ---
function calculateIntervalTime(destination) {
    const beatDuration = 60000 / globalTempo; // milliseconds per beat
    
    if (destination === 'GLOBAL') {
        // For global, return the beat duration based on denominator
        // 4/4 means quarter note gets the beat
        // 6/8 means eighth note gets the beat
        return beatDuration * (4 / globalMeterDenominator);
    }
    
    const settings = divisionSettings[destination];
    if (!settings) return beatDuration;
    
    const { type, modifier } = settings;
    
    // Parse division (e.g., "1/4" -> numerator: 1, denominator: 4)
    const [num, denom] = type.split('/').map(Number);
    
    // Calculate base interval (relative to quarter note)
    let interval = beatDuration * (4 / denom) * num;
    
    // Apply modifier
    if (modifier === 'dotted') {
        interval *= 1.5; // Dotted notes are 1.5x longer
    } else if (modifier === 'triplet') {
        interval *= (2 / 3); // Triplets are 2/3 the duration
    }
    
    return interval;
}

// --- Start Tempo/Metronome ---
function nextNote() {
    // Advance time by a tick
    const secondsPerBeat = getBeatDurationSeconds();
    const secondsPerTick = secondsPerBeat / noteResolution;
    nextNoteTime += secondsPerTick;
    
    currentTick++;
    if (currentTick >= noteResolution) {
        currentTick = 0;
        currentBeat++;
        if (currentBeat >= globalMeterNumerator) {
            currentBeat = 0;
        }
    }
}

function scheduleNote(beatNumber, tickNumber, time) {
    // Schedule the metronome click only on the beat
    if (tickNumber === 0) {
        const isAccent = (beatNumber === 0);
        playMetronomeClick(isAccent, time);
        
    }
    handleSequencerStepTick(tickNumber, time);
    
    // Notify divisions
    notifyDivisionTick(time);
}

function scheduler() {
    if (!isTempoPlaying) return; // Stop if tempo stopped
    
    const audioContext = window.audioCtx;
    if (!audioContext) {
        console.warn('AudioContext not ready yet, retrying...');
        timerID = setTimeout(scheduler, lookahead);
        return;
    }
    
    try {
        // Schedule all notes that need to play before next interval
        let loopCount = 0;
        const maxLoops = 100; // Safety limit
        
        while (nextNoteTime < audioContext.currentTime + scheduleAheadTime && loopCount < maxLoops) {
            scheduleNote(currentBeat, currentTick, nextNoteTime);
            nextNote();
            loopCount++;
        }
        
        if (loopCount >= maxLoops) {
            console.error('Scheduler safety limit reached - stopping tempo');
            stopTempo();
            return;
        }
    } catch (error) {
        console.error('Scheduler error:', error.message);
        stopTempo();
        return;
    }
    
    timerID = setTimeout(scheduler, lookahead);
}

function resetTempoState() {
    currentBeat = 0;
    currentTick = 0;
    const audioContext = window.audioCtx;
    nextNoteTime = audioContext ? audioContext.currentTime : 0;
    for (const dest in subdivisionCounters) {
        subdivisionCounters[dest] = 0;
    }
    currentStepPosition = -1;
    lastStepTimestamp = null;
    currentLoopStartTime = null;
    currentLoopDurationSeconds = null;
}

function startTempo() {
    if (isTempoPlaying && !isPaused) {
        // If already playing, just return
        return;
    }
    
    const audioContext = window.audioCtx;
    if (!audioContext) {
        console.error('Cannot start tempo: AudioContext not initialized yet');
        return;
    }

    if (stepRecordingEnabled) {
        console.log('Disabling STEP REC before starting playback');
        setStepRecordingEnabled(false);
    }
    
    if (isPaused) {
        // Resume from current position
        isPaused = false;
        nextNoteTime = audioContext.currentTime; // Reset to now
    } else {
        // Start fresh
        resetTempoState();
        applyUserSelectedStartStep();
        captureAutomationPlaybackStartValues();
    }
    
    isTempoPlaying = true;
    scheduler(); // Start the scheduler
    beginPrecountIfNeeded();
    
    console.log(`Tempo started at ${globalTempo} BPM, ${globalMeterNumerator}/${globalMeterDenominator}`);
}

// --- Stop Tempo ---
function stopTempo(options = {}) {
    const { keepButtonState = false } = options;
    isTempoPlaying = false;
    isPaused = false;
    finalizeAllPendingCaptures({ forceTime: window.audioCtx ? window.audioCtx.currentTime : null });
    clearPrecountState();
    clearScheduledAutomationEvents();
    flushActiveSequencerNotes();
    restoreAutomationPlaybackStartValues();
    applyAutomationBaselineValues({ onlyAutomated: true });
    clearAutomationPlaybackSnapshot();
    resetModAutomationSession();
    resetTempoState();
    
    if (timerID) {
        clearTimeout(timerID);
        timerID = null;
    }
    
    if (!keepButtonState) {
        const playButton = document.getElementById('seq-play-button');
        const playButtonImg = playButton ? playButton.querySelector('img') : null;
        if (playButton) playButton.classList.remove('active');
        if (playButtonImg) playButtonImg.src = 'control%20icons/PLAY.svg';
    }
    
    userSelectedStartStep = null;
    // Reset step visuals
    updateStepVisuals(-1);
    
    console.log('Tempo stopped');
    dispatchSequencerEvent('sequencer:transport-stopped');
}

// --- Pause Tempo ---
function pauseTempo() {
    if (!isTempoPlaying) return;
    
    isPaused = true;
    isTempoPlaying = false;
    clearScheduledAutomationEvents();
    flushActiveSequencerNotes();
    applyAutomationBaselineValues({ onlyAutomated: true });
    resetModAutomationSession();
    
    if (timerID) {
        clearTimeout(timerID);
        timerID = null;
    }
    
    console.log('Tempo paused');
}

function toggleSequencerPlayback() {
    const playButton = document.getElementById('seq-play-button');
    const playButtonImg = playButton ? playButton.querySelector('img') : null;
    const pauseBtn = document.getElementById('seq-pause-button');
    if (isTempoPlaying) {
        stopTempo();
        if (playButton) playButton.classList.remove('active');
        if (playButtonImg) playButtonImg.src = 'control%20icons/PLAY.svg';
        if (pauseBtn) pauseBtn.classList.remove('active');
        return;
    }
    startTempo();
    if (playButton) playButton.classList.add('active');
    if (playButtonImg) playButtonImg.src = 'control%20icons/STOP.svg';
    if (pauseBtn) pauseBtn.classList.remove('active');
}

function canSequencerHandleSpacebar(target) {
    if (!target) return true;
    if (target.isContentEditable) return false;
    const tag = target.tagName ? target.tagName.toLowerCase() : '';
    if (!tag) return true;
    return tag !== 'input' && tag !== 'textarea' && tag !== 'select';
}

function handleSequencerGlobalKeydown(event) {
    const isSpace = event.code === 'Space' || event.key === ' ';
    if (!isSpace) return;
    if (event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.repeat) return;
    if (!canSequencerHandleSpacebar(event.target)) return;
    event.preventDefault();
    toggleSequencerPlayback();
}

// --- Tap Tempo ---
function handleTapTempo() {
    const now = Date.now();
    
    // Play click on tap
    playMetronomeClick(tapTimes.length % globalMeterNumerator === 0);
    
    // Reset if too much time has passed
    if (tapTimes.length > 0 && (now - tapTimes[tapTimes.length - 1]) > TAP_TIMEOUT) {
        tapTimes = [];
    }
    
    tapTimes.push(now);
    
    // Need at least 2 taps to calculate tempo
    if (tapTimes.length < 2) return;
    
    // Calculate average interval between taps
    let totalInterval = 0;
    for (let i = 1; i < tapTimes.length; i++) {
        totalInterval += tapTimes[i] - tapTimes[i - 1];
    }
    const avgInterval = totalInterval / (tapTimes.length - 1);
    
    // Account for meter - if in 3/4, user is tapping quarter notes
    // avgInterval is the time for one beat
    const beatDuration = avgInterval;
    
    // Calculate BPM (beats per minute)
    const newTempo = Math.round(60000 / beatDuration);
    
    // Clamp to reasonable range
    globalTempo = Math.max(20, Math.min(300, newTempo));
    
    // Update tempo knob visual
    updateTempoKnobDisplay();
    
    // If tempo was playing, restart with new tempo
    if (isTempoPlaying) {
        startTempo();
    }
    
    console.log(`Tap tempo: ${globalTempo} BPM (${tapTimes.length} taps)`);
}

// --- Update Tempo ---
function setTempo(bpm) {
    globalTempo = Math.max(20, Math.min(300, Math.round(bpm)));
    // Tempo change takes effect immediately on next scheduled beat
    // No need to restart - the scheduler will use the new tempo automatically
    
    // Update routed LFO/MOD rates
    updateRoutedRates();
    
    console.log(`Tempo set to ${globalTempo} BPM`);
}

// --- Set Division for Destination ---
function setDivision(destination, divisionIndex, modifierIndex = 0) {
    if (destination === 'GLOBAL') {
        // Set meter
        const totalCombos = meterNumerators.length * meterDenominators.length;
        const numIndex = Math.floor(divisionIndex / meterDenominators.length) % meterNumerators.length;
        const denomIndex = divisionIndex % meterDenominators.length;
        
        globalMeterNumerator = meterNumerators[numIndex];
        globalMeterDenominator = meterDenominators[denomIndex];
        
        divisionSettings['GLOBAL'] = {
            numerator: globalMeterNumerator,
            denominator: globalMeterDenominator
        };
        rebuildStepButtons();
        rebuildQuantizeOptions();
        requantizePattern();
        
        console.log(`Global meter set to ${globalMeterNumerator}/${globalMeterDenominator}`);
    } else {
        // Set rhythm division
        const typeIndex = divisionIndex % rhythmDivisions.length;
        const type = rhythmDivisions[typeIndex];
        const modifier = divisionModifiers[modifierIndex % divisionModifiers.length];
        
        divisionSettings[destination] = { type, modifier };
        
        const modifierSymbol = modifier === 'dotted' ? '.' : (modifier === 'triplet' ? 'T' : '');
        console.log(`${destination} division set to ${type}${modifierSymbol}`);
    }
    
    // Update visual display
    updateDivisionDisplay();
    
    // If tempo is playing, restart to apply new division
    if (isTempoPlaying && !isPaused) {
        startTempo();
    }
}

// --- Toggle Division Routing ---
function toggleDivisionRouting(destination) {
    if (!destination) destination = currentDivisionDestination;
    if (destination === 'ARP' || destination === 'GLOBAL' || destination === 'LOSS') {
        console.log(`${destination} routing is locked and cannot be toggled.`);
        updateDivisionRoutingIndicators();
        return;
    }
    
    divisionConnections[destination] = !divisionConnections[destination];
    
    console.log(`${destination} division routing: ${divisionConnections[destination] ? 'ON' : 'OFF'}`);
    
    // Update visual indicators
    updateDivisionRoutingIndicators();
    
    // Update mod rate knob state if MOD or LFO is toggled
    updateModRateKnobState();
}

// --- Update Mod Rate Knob State ---
function updateModRateKnobState() {
    const modRateKnob = document.getElementById('mod-rate-knob');
    const lfoRateSlider = document.querySelector('.rate-slider-range');
    
    // Disable mod rate knob if MOD is routed
    if (modRateKnob) {
        const shouldDisableMod = divisionConnections['MOD'];
        
        if (shouldDisableMod) {
            modRateKnob.style.opacity = '0.3';
            modRateKnob.style.pointerEvents = 'none';
            modRateKnob.style.filter = 'grayscale(1)';
        } else {
            modRateKnob.style.opacity = '1';
            modRateKnob.style.pointerEvents = 'auto';
            modRateKnob.style.filter = 'none';
        }
    }
    
    // Disable LFO rate slider if LFO is routed
    if (lfoRateSlider) {
        const shouldDisableLfo = divisionConnections['LFO'];
        
        if (shouldDisableLfo) {
            lfoRateSlider.style.opacity = '0.3';
            lfoRateSlider.style.pointerEvents = 'none';
            lfoRateSlider.style.filter = 'grayscale(1)';
        } else {
            lfoRateSlider.style.opacity = '1';
            lfoRateSlider.style.pointerEvents = 'auto';
            lfoRateSlider.style.filter = 'none';
        }
    }
    
    // Update rates for routed destinations
    updateRoutedRates();
}

// --- Calculate Rate from Division Setting ---
function calculateRateFromDivision(destination) {
    // Get division setting for this destination
    const settings = divisionSettings[destination];
    if (!settings) return null;
    
    const { type, modifier } = settings;
    
    // Parse division type (e.g., '1/16' -> numerator=1, denominator=16)
    const [num, denom] = type.split('/').map(Number);
    
    // Calculate base rate from tempo
    // BPM = beats per minute, so beats per second = BPM / 60
    const beatsPerSecond = globalTempo / 60;
    
    // Division determines how many divisions per beat
    // For example: 1/16 means 16th notes, so 4 sixteenth notes per quarter note
    // In 4/4 time, there are 4 quarter notes per bar
    const divisionsPerBeat = denom / 4; // Assuming quarter note = 1 beat
    const rateHz = beatsPerSecond * divisionsPerBeat * (num / 1);
    
    // Apply modifier
    let finalRate = rateHz;
    if (modifier === 'dotted') {
        finalRate = rateHz * (2/3); // Dotted notes are 1.5x longer, so rate is 2/3
    } else if (modifier === 'triplet') {
        finalRate = rateHz * (3/2); // Triplets fit 3 in the space of 2, so 1.5x faster
    }
    
    return finalRate;
}

// --- Update Routed Rates ---
function updateRoutedRates() {
    // Update MOD rate if routed
    if (divisionConnections['MOD']) {
        const rate = calculateRateFromDivision('MOD');
        if (rate !== null && window.modCanvasRate !== undefined) {
            window.modCanvasRate = rate;
            console.log(`MOD rate synced to tempo: ${rate.toFixed(2)} Hz`);
        }
    }
    
    // Update LFO rate if routed
    if (divisionConnections['LFO']) {
        const rate = calculateRateFromDivision('LFO');
        if (rate !== null && window.lfoRate !== undefined) {
            window.lfoRate = rate;
            // Restart LFO with new rate
            if (window.restartLFO) {
                window.restartLFO();
            }
            console.log(`LFO rate synced to tempo: ${rate.toFixed(2)} Hz`);
        }
    }
}

// --- Set Selected Division Destination ---
function setSelectedDivisionDestination(destination) {
    selectedDivisionDestination = destination;
    console.log(`Selected division destination: ${destination}`);
    
    // Update division knob to show current setting for this destination
    updateDivisionKnobForDestination(destination);
}

// --- Notify Division Tick (called on each metronome beat) ---
let subdivisionCounters = {
    'LOSS': 0,
    'DELAY': 0,
    'ARP': 0,
    'LFO': 0,
    'MOD': 0
};

function notifyDivisionTick(time) {
    // This is called on each tick (1/64th note resolution)
    // We need to check if each destination should fire based on its division
    
    for (const destination of divisionDestinations) {
        if (!divisionConnections[destination]) continue;
        if (destination === 'GLOBAL') continue; // Global just controls metronome
        if (destination === 'ARP') continue; // Arpeggiator now runs on its own scheduler
        
        const settings = divisionSettings[destination];
        if (!settings) continue;

        const { type, modifier } = settings;
        // type is like '1/16'
        const [num, denom] = type.split('/').map(Number);
        
        // Calculate ticks needed for this division
        // Formula: (64 / denom) * num
        // 1/4 -> 16 ticks
        // 1/16 -> 4 ticks
        let ticksPerEvent = (64 / denom) * num;
        
        // Apply modifier
        if (modifier === 'dotted') {
            ticksPerEvent = ticksPerEvent * 1.5;
        } else if (modifier === 'triplet') {
            ticksPerEvent = ticksPerEvent * (2/3); 
        }
        
        // Increment counter
        subdivisionCounters[destination]++;
        
        // Check if this destination should fire
        if (subdivisionCounters[destination] >= ticksPerEvent) {
            subdivisionCounters[destination] = 0;
            
            // Fire event for this destination
            fireDivisionEvent(destination, time);
        }
    }
}

// Fire division event for specific destination
function fireDivisionEvent(destination, time) {
    // Trigger appropriate module based on destination
    switch(destination) {
        case 'LOSS':
            // Trigger bit crusher/loss effect
            if (window.lossEffect && window.lossEffect.trigger) {
                window.lossEffect.trigger();
            }
            break;
        case 'DELAY':
            // Sync delay time - update the global delay time if it exists
            const delayTime = calculateIntervalTime('DELAY') / 1000; // Convert to seconds
            if (typeof window.delayTime !== 'undefined') {
                window.delayTime = delayTime;
            }
            if (window.delayEffect && window.delayEffect.syncToTempo) {
                window.delayEffect.syncToTempo(delayTime);
            }
            break;
        case 'LFO':
            // Sync LFO rate - update the global lfoRate
            const lfoHz = 1000 / calculateIntervalTime('LFO'); // Convert interval to Hz
            if (typeof window.lfoRate !== 'undefined') {
                window.lfoRate = lfoHz;
                console.log(`LFO synced to tempo: ${lfoHz.toFixed(2)} Hz`);
            }
            break;
        case 'MOD':
            // Sync MOD canvas rate - update the global modCanvasRate
            const modHz = 1000 / calculateIntervalTime('MOD');
            if (typeof window.modCanvasRate !== 'undefined') {
                window.modCanvasRate = modHz;
                console.log(`MOD synced to tempo: ${modHz.toFixed(2)} Hz`);
            }
            break;
    }
}

function updateStepVisuals(stepNumber) {
    const buttons = document.querySelectorAll('.seq-step-button');
    buttons.forEach(btn => btn.classList.remove('active'));
    if (stepNumber <= 0) return;
    const activeBtn = document.querySelector(`.seq-step-button[data-step-index="${stepNumber}"]`);
    if (activeBtn) {
        activeBtn.classList.add('active');
    }
}

// --- UI Update Functions ---
// Helper function to create tooltips for knobs
function createTooltipForKnob(knobId) {
    const tooltip = document.getElementById(`${knobId}-tooltip`) || (() => {
        const newTooltip = document.createElement('div');
        newTooltip.id = `${knobId}-tooltip`;
        newTooltip.className = 'tooltip';
        
        const knob = document.getElementById(knobId);
        const parent = knob ? knob.parentElement : null;
        
        if (parent && window.getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }
        
        if (parent) {
            parent.appendChild(newTooltip);
        }
        
        return newTooltip;
    })();
    
    return tooltip;
}

// Helper function to initialize knob rotation and interaction
function initializeKnob(knobElement, onChangeCallback, onEndCallback) {
    let isDragging = false;
    let startY = 0;
    let startRotation = 0;
    
    // Get current rotation from transform
    function getRotation() {
        const transform = knobElement.style.transform || 'rotate(0deg)';
        const match = transform.match(/rotate\((-?\d+\.?\d*)deg\)/);
        return match ? parseFloat(match[1]) : 0;
    }
    
    // Convert rotation to 0-1 value
    function rotationToValue(rotation) {
        return (rotation + 150) / 300;
    }
    
    // Convert 0-1 value to rotation
    function valueToRotation(value) {
        return (value * 300) - 150;
    }
    
    function startDrag(e) {
        isDragging = true;
        startY = e.clientY || e.touches[0].clientY;
        startRotation = getRotation();
        e.preventDefault();
    }
    
    function drag(e) {
        if (!isDragging) return;
        
        const currentY = e.clientY || e.touches[0].clientY;
        const deltaY = startY - currentY; // Inverted: up = positive
        const rotationChange = deltaY * 0.5; // Sensitivity
        
        let newRotation = startRotation + rotationChange;
        newRotation = Math.max(-150, Math.min(150, newRotation)); // Clamp
        
        knobElement.style.transform = `rotate(${newRotation}deg)`;
        
        const value = rotationToValue(newRotation);
        onChangeCallback(value);
    }
    
    function endDrag() {
        if (isDragging && onEndCallback) {
            const value = rotationToValue(getRotation());
            onEndCallback(value);
        }
        isDragging = false;
    }
    
    // Mouse events
    knobElement.addEventListener('mousedown', startDrag);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', endDrag);
    
    // Touch events
    knobElement.addEventListener('touchstart', startDrag);
    document.addEventListener('touchmove', drag);
    document.addEventListener('touchend', endDrag);
}

function updateTempoKnobDisplay() {
    // Update the tempo knob rotation to match globalTempo
    const tempoKnob = document.getElementById('seq-tempo-knob');
    if (tempoKnob) {
        // Map 20-300 BPM to 0-1 range
        const value = (globalTempo - 20) / (300 - 20);
        const rotation = (value * 300) - 150;
        tempoKnob.style.transform = `rotate(${rotation}deg)`;
    }
}

function updateDivisionDisplay() {
    // Display is now handled by tooltip during knob interaction
}

function updateDivisionRoutingIndicators() {
    // Update tick labels to show routed (blue) vs unrouted
    divisionDestinations.forEach(destination => {
        const label = document.querySelector(`[data-division-destination="${destination}"]`);
        if (label) {
            if (divisionConnections[destination]) {
                label.classList.add('routed');
            } else {
                label.classList.remove('routed');
            }
        }
    });
}

function updateDivisionKnobForDestination(destination) {
    // Update division knob rotation based on current setting
    const divisionKnob = document.getElementById('seq-division-knob');
    if (!divisionKnob) return;
    
    let value = 0;
    
    if (destination === 'GLOBAL') {
        // Calculate index from current meter
        const numIndex = meterNumerators.indexOf(globalMeterNumerator);
        const denomIndex = meterDenominators.indexOf(globalMeterDenominator);
        const totalCombos = meterNumerators.length * meterDenominators.length;
        const index = numIndex * meterDenominators.length + denomIndex;
        value = index / (totalCombos - 1);
    } else {
        const settings = divisionSettings[destination];
        if (settings) {
            const typeIndex = rhythmDivisions.indexOf(settings.type);
            const modifierIndex = divisionModifiers.indexOf(settings.modifier);
            const totalOptions = rhythmDivisions.length * divisionModifiers.length;
            const index = typeIndex * divisionModifiers.length + modifierIndex;
            value = index / (totalOptions - 1);
        }
    }
    
    const rotation = (value * 300) - 150;
    divisionKnob.style.transform = `rotate(${rotation}deg)`;
}

// --- Export for use in main.js ---
export const sequencerTempo = {
    initialize: initializeDivisionSystem,
    start: startTempo,
    stop: stopTempo,
    pause: pauseTempo,
    tap: handleTapTempo,
    setTempo: setTempo,
    setDivision: setDivision,
    toggleRouting: toggleDivisionRouting,
    setSelectedDestination: setSelectedDivisionDestination,
    setCurrentDestination: (dest) => { currentDivisionDestination = dest; },
    getCurrentDestination: () => currentDivisionDestination,
    getSelectedDestination: () => selectedDivisionDestination,
    setMetronomeVolume: (vol) => { metronomeVolume = Math.max(0, Math.min(1, vol)); },
    isPlaying: () => isTempoPlaying,
    isPaused: () => isPaused,
    getTempo: () => globalTempo,
    isDestinationRouted: (destination) => !!divisionConnections[destination],
    getIntervalTime: calculateIntervalTime,
    getMeter: () => ({ numerator: globalMeterNumerator, denominator: globalMeterDenominator }),
    initializeColors: () => {
        updateDestinationHighlight('GLOBAL');
        updateSelectButtonState();
        console.log('Sequencer destination colors initialized');
    }
};

export function getSequencerStateSnapshot() {
    const notePayload = canonicalSequencerEvents
        .filter(evt => evt && Number.isFinite(evt.noteNumber))
        .map(evt => {
            const velocity = Number.isFinite(evt.velocity) ? evt.velocity : 1;
            const duration = Number.isFinite(evt.durationNormalized)
                ? Math.max(MIN_DURATION_NORMALIZED, evt.durationNormalized)
                : Math.max(MIN_DURATION_NORMALIZED, getDefaultDurationNormalized());
            const position = Number.isFinite(evt.position) ? evt.position : 0;
            return {
                position: normalizeLoopPosition(position),
                noteNumber: Math.round(evt.noteNumber),
                velocity: Math.max(0, Math.min(1, velocity)),
                durationNormalized: duration
            };
        })
        .sort((a, b) => (a.position - b.position) || (a.noteNumber - b.noteNumber));

    const automationLanesPayload = {};
    automationLanes.forEach((lane, paramId) => {
        if (!Array.isArray(lane) || !lane.length) return;
        const events = lane
            .map(evt => {
                if (!evt) return null;
                const value = Number(evt.value);
                const position = Number(evt.position);
                if (!Number.isFinite(value) || !Number.isFinite(position)) return null;
                return {
                    position: normalizeLoopPosition(position),
                    value
                };
            })
            .filter(Boolean);
        if (events.length) {
            automationLanesPayload[paramId] = events;
        }
    });

    const automationBaselinesPayload = {};
    automationLaneBaselines.forEach((value, paramId) => {
        if (Number.isFinite(value)) {
            automationBaselinesPayload[paramId] = value;
        }
    });

    return {
        formatVersion: SEQUENCE_SNAPSHOT_VERSION,
        exportedAt: new Date().toISOString(),
        meter: {
            numerator: globalMeterNumerator,
            denominator: globalMeterDenominator
        },
        notes: notePayload,
        automation: {
            lanes: automationLanesPayload,
            baselines: automationBaselinesPayload
        }
    };
}

export function loadSequencerStateSnapshot(rawSnapshot) {
    if (!rawSnapshot || typeof rawSnapshot !== 'object') {
        throw new Error('Sequence snapshot must be an object.');
    }
    const snapshotVersion = Number(rawSnapshot.formatVersion ?? 1);
    if (snapshotVersion > SEQUENCE_SNAPSHOT_VERSION) {
        console.warn(`Sequence snapshot format ${snapshotVersion} is newer than supported version ${SEQUENCE_SNAPSHOT_VERSION}.`);
    }

    flushActiveSequencerNotes();
    clearScheduledAutomationEvents();
    resetModAutomationSession();

    const meterInfo = rawSnapshot.meter && typeof rawSnapshot.meter === 'object'
        ? rawSnapshot.meter
        : null;

    clearAllSequencerNotes();
    let meterChanged = false;
    if (meterInfo) {
        meterChanged = applyGlobalMeterSnapshot(meterInfo.numerator, meterInfo.denominator, { forceUpdate: true });
    } else {
        updateDivisionKnobForDestination('GLOBAL');
    }

    clearAllAutomationRecordings({ skipBaselineRestore: true, suppressLog: true });
    if (typeof resetNudgeOverflowStore === 'function') {
        resetNudgeOverflowStore();
    } else {
        nudgeOverflowStore.notesLeft.length = 0;
        nudgeOverflowStore.notesRight.length = 0;
        nudgeOverflowStore.automationLeft.clear();
        nudgeOverflowStore.automationRight.clear();
    }
    sequencerEventIdCounter = 0;
    automationEventIdCounter = 0;
    currentStepPosition = -1;
    userSelectedStartStep = null;
    lastStepTimestamp = null;
    currentLoopStartTime = null;
    currentLoopDurationSeconds = null;

    const loadedNotes = [];
    if (Array.isArray(rawSnapshot.notes)) {
        rawSnapshot.notes.forEach(note => {
            if (!note || typeof note !== 'object') return;
            const noteNumber = Number(note.noteNumber);
            if (!Number.isFinite(noteNumber)) return;
            const velocityRaw = Number(note.velocity);
            const durationRaw = Number(note.durationNormalized);
            const positionRaw = Number(note.position);
            loadedNotes.push({
                id: ++sequencerEventIdCounter,
                position: normalizeLoopPosition(Number.isFinite(positionRaw) ? positionRaw : 0),
                noteNumber: Math.round(noteNumber),
                velocity: Math.max(0, Math.min(1, Number.isFinite(velocityRaw) ? velocityRaw : 1)),
                durationNormalized: Number.isFinite(durationRaw)
                    ? Math.max(MIN_DURATION_NORMALIZED, durationRaw)
                    : Math.max(MIN_DURATION_NORMALIZED, getDefaultDurationNormalized())
            });
        });
    }
    loadedNotes.sort((a, b) => (a.position - b.position) || (a.noteNumber - b.noteNumber));
    canonicalSequencerEvents = loadedNotes;
    rebuildSequencerPatternFromCanonical({ skipIndicatorUpdate: true });

    automationLanes.clear();
    const automationSection = rawSnapshot.automation && typeof rawSnapshot.automation === 'object'
        ? rawSnapshot.automation
        : null;
    const lanesPayload = automationSection && typeof automationSection.lanes === 'object'
        ? automationSection.lanes
        : null;
    if (lanesPayload) {
        Object.entries(lanesPayload).forEach(([paramId, lane]) => {
            if (!Array.isArray(lane) || !lane.length) return;
            const events = lane
                .map(evt => {
                    if (!evt || typeof evt !== 'object') return null;
                    const value = Number(evt.value);
                    const position = Number(evt.position);
                    if (!Number.isFinite(value) || !Number.isFinite(position)) return null;
                    return {
                        id: ++automationEventIdCounter,
                        position: normalizeLoopPosition(position),
                        value
                    };
                })
                .filter(Boolean)
                .sort((a, b) => a.position - b.position);
            if (events.length) {
                automationLanes.set(`${paramId}`, events);
            }
        });
    }

    automationLaneBaselines.clear();
    const baselinesPayload = automationSection && typeof automationSection.baselines === 'object'
        ? automationSection.baselines
        : null;
    const baselineParamIds = [];
    if (baselinesPayload) {
        Object.entries(baselinesPayload).forEach(([paramId, value]) => {
            const numericValue = Number(value);
            if (!Number.isFinite(numericValue)) return;
            const id = `${paramId}`;
            automationLaneBaselines.set(id, numericValue);
            baselineParamIds.push(id);
            automationBaselineValues.set(id, numericValue);
        });
    }
    if (baselineParamIds.length) {
        applyAutomationBaselineValues({ limitParamIds: baselineParamIds });
    }

    refreshVisibleStepNoteIndicators();
    updateStepVisuals(-1);

    console.log(`Sequencer: loaded sequence snapshot (${loadedNotes.length} notes, ${automationLanes.size} motion lane(s))`);

    return {
        noteCount: loadedNotes.length,
        automationLaneCount: automationLanes.size,
        meterChanged
    };
}

// --- Initialize UI Event Listeners ---
function initializeSequencerUI() {
    if (!quantizeOptions.length) {
        rebuildQuantizeOptions();
    }
    // Play button
    const playButton = document.getElementById('seq-play-button');
    const playButtonImg = playButton ? playButton.querySelector('img') : null;
    if (playButton) {
        playButton.addEventListener('click', () => {
            toggleSequencerPlayback();
        });
    }
    
    // Pause button
    const pauseButton = document.getElementById('seq-pause-button');
    if (pauseButton) {
        pauseButton.addEventListener('click', () => {
            if (isTempoPlaying) {
                pauseTempo();
                pauseButton.classList.add('active');
                if (playButton) playButton.classList.remove('active');
                if (playButtonImg) playButtonImg.src = 'control%20icons/PLAY.svg';
                const playBtn = document.getElementById('seq-play-button');
                if (playBtn) playBtn.classList.remove('active');
            } else if (isPaused) {
                // Second click on pause = stop
                stopTempo();
                pauseButton.classList.remove('active');
            }
        });
    }
    
    // Tap button (metronome button)
    const tapButton = document.getElementById('seq-metronome-button');
    if (tapButton) {
        tapButton.addEventListener('click', handleTapTempo);
    }

    // Record arm button
    const recordButton = document.getElementById('seq-record-button');
    if (recordButton) {
        recordButton.addEventListener('click', (event) => {
            if (event.detail > 1) return;
            toggleSequencerRecordArm();
        });
        const handleRecordContextAction = (event) => {
            if (event) {
                event.preventDefault?.();
                event.stopPropagation?.();
            }
            if (!canonicalSequencerEvents.length) return;
            if (!window.confirm('Delete all recorded notes?')) return;
            clearAllSequencerNotes();
        };
        recordButton.addEventListener('dblclick', handleRecordButtonDoubleClick);
        addTouchDoubleTapSupport(recordButton, handleRecordButtonDoubleClick);
        recordButton.addEventListener('contextmenu', handleRecordContextAction);
        addTouchLongPressSupport(recordButton, handleRecordContextAction);
        recordButton.classList.toggle('active', sequencerRecordArmed);
        updateRecordPrecountIndicator();
    }

    const motionButton = document.getElementById('seq-motion-button');
    if (motionButton) {
        motionButton.addEventListener('click', () => {
            toggleModRecording();
        });
        const handleMotionContextAction = (event) => {
            if (event) {
                event.preventDefault?.();
                event.stopPropagation?.();
            }
            if (!hasAnyActiveAutomationLanes()) return;
            if (!window.confirm('Delete all recorded motion?')) return;
            clearAllAutomationRecordings();
        };
        motionButton.addEventListener('contextmenu', handleMotionContextAction);
        addTouchLongPressSupport(motionButton, handleMotionContextAction);
        updateModRecButtonState();
    }

    const stepRecordButton = document.getElementById('seq-top-record-button');
    if (stepRecordButton) {
        stepRecordButton.addEventListener('click', (event) => {
            if (event.detail > 1) return;
            toggleStepRecording();
        });
        const handleStepRecordContext = (event) => {
            if (event) {
                event.preventDefault?.();
                event.stopPropagation?.();
            }
            toggleStepRecordingSimpleMode();
        };
        stepRecordButton.addEventListener('contextmenu', handleStepRecordContext);
        addTouchLongPressSupport(stepRecordButton, handleStepRecordContext);
        updateStepRecordButtonState();
    }
    
    // Metronome volume knob
    const metronomeKnob = document.getElementById('seq-metronome-vol-knob');
    if (metronomeKnob) {
        initializeKnob(metronomeKnob, (value) => {
            metronomeVolume = value;
            console.log(`Metronome volume: ${Math.round(value * 100)}%`);
        });
    }

    // Quantize knob
    const quantizeKnob = document.getElementById('seq-quantize-knob');
    if (quantizeKnob) {
        quantizeKnobElement = quantizeKnob;
        updateQuantizeKnobRotation();
        initializeKnob(quantizeKnob, (value) => {
            if (!quantizeOptions.length) {
                rebuildQuantizeOptions();
            }
            if (!quantizeOptions.length) return;
            const idx = Math.min(
                quantizeOptions.length - 1,
                Math.max(0, Math.round(value * (quantizeOptions.length - 1)))
            );
            currentQuantizeIndex = idx;
            updateQuantizeKnobRotation();
            const tooltip = createTooltipForKnob('seq-quantize-knob');
            tooltip.textContent = quantizeOptions[idx].label;
            tooltip.style.opacity = '1';
            requantizePattern();
            dispatchSequencerEvent('sequencer:quantize-changed', {
                index: idx,
                label: quantizeOptions[idx].label
            });
        }, () => {
            const tooltip = document.getElementById('seq-quantize-knob-tooltip');
            if (tooltip) tooltip.style.opacity = '0';
        });
    }
    
    // Tempo knob
    const tempoKnob = document.getElementById('seq-tempo-knob');
    if (tempoKnob) {
        const applyTempoFromKnob = (value, options = {}) => {
            const bpm = 20 + (value * 280);
            setTempo(bpm);
            updateTempoKnobDisplay();
            const tooltip = createTooltipForKnob('seq-tempo-knob');
            tooltip.textContent = `${Math.round(bpm)} BPM`;
            tooltip.style.opacity = '1';
            if (!options.suppressAutomationCapture) {
                recordModAutomationValue('seq-tempo-knob', value);
            }
        };
        const tempoControl = initializeKnob(tempoKnob, (value) => {
            applyTempoFromKnob(value);
        });
        registerModAutomationTarget('seq-tempo-knob', (value) => {
            if (!tempoControl) return;
            tempoControl.setValue(value, false);
            applyTempoFromKnob(value, { suppressAutomationCapture: true });
        });
    }
    
    // Division knob
    const divisionKnob = document.getElementById('seq-division-knob');
    if (divisionKnob) {
        // Set initial rotation for 4/4 (numerator index 3, denominator index 1)
        // index = 3 * 4 + 1 = 13, value = 13/63 ≈ 0.206
        const initial44Value = 0.206;
        const initialRotation = (initial44Value * 300) - 150;
        divisionKnob.style.transform = `rotate(${initialRotation}deg)`;
        
        initializeKnob(divisionKnob, (value) => {
            const destination = currentDivisionDestination; // Use currently highlighted destination
            if (!destination) return;
            
            let tooltipText = '';
            
            if (destination === 'GLOBAL') {
                // Map to meter combinations
                const totalCombos = meterNumerators.length * meterDenominators.length;
                const index = Math.floor(value * (totalCombos - 1));
                const numIndex = Math.floor(index / meterDenominators.length);
                const denomIndex = index % meterDenominators.length;
                
                globalMeterNumerator = meterNumerators[numIndex];
                globalMeterDenominator = meterDenominators[denomIndex];
                
                divisionSettings['GLOBAL'] = { 
                    numerator: globalMeterNumerator, 
                    denominator: globalMeterDenominator 
                };
                rebuildStepButtons(); // Rebuild step buttons for new meter
                rebuildQuantizeOptions();
                requantizePattern();
                
                tooltipText = `${globalMeterNumerator}/${globalMeterDenominator}`;
            } else {
                // Map to rhythm divisions with modifiers
                const totalOptions = rhythmDivisions.length * divisionModifiers.length;
                const index = Math.floor(value * (totalOptions - 1));
                const typeIndex = Math.floor(index / divisionModifiers.length);
                const modifierIndex = index % divisionModifiers.length;
                
                const type = rhythmDivisions[typeIndex];
                const modifier = divisionModifiers[modifierIndex];
                
                divisionSettings[destination] = { type, modifier };
                
                // Update routed rates if this destination is MOD or LFO
                if (destination === 'MOD' || destination === 'LFO') {
                    updateRoutedRates();
                }
                
                const modSymbol = modifier === 'dotted' ? '.' : (modifier === 'triplet' ? 'T' : '');
                tooltipText = `${type}${modSymbol}`;
            }
            
            // Show tooltip
            const tooltip = createTooltipForKnob('seq-division-knob');
            tooltip.textContent = tooltipText;
            tooltip.style.opacity = '1';
        }, () => {
            // Hide tooltip on release
            const tooltip = document.getElementById('seq-division-knob-tooltip');
            if (tooltip) tooltip.style.opacity = '0';
        });
    }
    
    // Select button
    const selectButton = document.getElementById('seq-select-button');
    if (selectButton) {
        selectButton.addEventListener('click', () => {
            // Toggle routing for current destination
            toggleDivisionRouting(currentDivisionDestination);
            
            // Update select button state and highlights
            updateSelectButtonState();
            updateDestinationHighlight(currentDivisionDestination);
        });
    }
    
    // Destination slider
    const destSlider = document.querySelector('.seq-destination-range');
    if (destSlider) {
        destSlider.addEventListener('input', (e) => {
            const sliderValue = parseInt(e.target.value);
            // INVERT: slider 0 (top) should give index 5, slider 5 (bottom) should give index 0
            const index = 5 - sliderValue;
            const destination = divisionDestinations[index];
            currentDivisionDestination = destination;
            
            // Update tick labels to show highlighted destination
            updateDestinationHighlight(destination);
            
            // Update select button state for new destination
            updateSelectButtonState();
            
            // Update division knob and display for new destination
            updateDivisionKnobForDestination(destination);
        });
        
        // Double-click to toggle routing
        const toggleRoutingFromGesture = () => {
            toggleDivisionRouting(currentDivisionDestination);
        };
        destSlider.addEventListener('dblclick', toggleRoutingFromGesture);
        addTouchDoubleTapSupport(destSlider, toggleRoutingFromGesture);
    }

    // Page buttons
    const pageDown = document.getElementById('seq-page-down');
    if (pageDown) {
        pageDown.addEventListener('click', () => {
            if (currentPageIndex > 0) {
                setCurrentPage(currentPageIndex - 1);
            }
        });
        const handlePageDownContext = (event) => {
            event?.preventDefault?.();
            shiftSequenceBySteps(-1);
        };
        pageDown.addEventListener('contextmenu', handlePageDownContext);
        addTouchLongPressSupport(pageDown, handlePageDownContext);
    }
    const pageUp = document.getElementById('seq-page-up');
    if (pageUp) {
        pageUp.addEventListener('click', () => {
            if (currentPageIndex < SEQUENCER_PAGE_COUNT - 1) {
                setCurrentPage(currentPageIndex + 1);
            }
        });
        const handlePageUpContext = (event) => {
            event?.preventDefault?.();
            shiftSequenceBySteps(1);
        };
        pageUp.addEventListener('contextmenu', handlePageUpContext);
        addTouchLongPressSupport(pageUp, handlePageUpContext);
    }
    
    // Keyboard octave buttons
    const octaveDown = document.getElementById('seq-keyboard-octave-down');
    const octaveUp = document.getElementById('seq-keyboard-octave-up');
    
    if (octaveDown) {
        octaveDown.addEventListener('click', () => {
            keyboardOctaveShift = Math.max(-2, keyboardOctaveShift - 1);
            updateOctaveIndicator();
            console.log(`Keyboard octave shift: ${keyboardOctaveShift}`);
        });
    }
    
    if (octaveUp) {
        octaveUp.addEventListener('click', () => {
            keyboardOctaveShift = Math.min(2, keyboardOctaveShift + 1);
            updateOctaveIndicator();
            console.log(`Keyboard octave shift: ${keyboardOctaveShift}`);
        });
    }
    
    // Pitch bend slider
    const pitchSlider = document.querySelector('.seq-pitch-slider');
    if (pitchSlider) {
        pitchSlider.addEventListener('input', (e) => {
            const semitones = parseFloat(e.target.value);
            applyPitchBend(semitones);
        });
        
        // Return to center on release
        pitchSlider.addEventListener('mouseup', () => returnPitchBend(pitchSlider));
        pitchSlider.addEventListener('touchend', () => returnPitchBend(pitchSlider));
    }

    // --- Arpeggiator UI ---
    if (arpeggiatorInstance) {
        // Hold Button
        const holdButton = document.getElementById('seq-hold-button');
        if (holdButton) {
            holdButton.addEventListener('click', () => {
                const isHold = !arpeggiatorInstance.isHold();
                arpeggiatorInstance.setHold(isHold);
                holdButton.classList.toggle('active', isHold);
            });
        }

        // Arp On/Off Button
        const arpButton = document.getElementById('seq-arp-button');
        if (arpButton) {
            arpButton.addEventListener('click', () => {
                const isActive = !arpeggiatorInstance.isActive();
                arpeggiatorInstance.setActive(isActive);
                arpButton.classList.toggle('active', isActive);
            });
        }

        // Octave Buttons
        const octDown = document.getElementById('seq-octave-down');
        const octUp = document.getElementById('seq-octave-up');
        const arpOctaveDotContainer = (octDown || octUp)
            ? (octDown || octUp).closest('.seq-button-container')
            : null;
        const octDots = arpOctaveDotContainer
            ? arpOctaveDotContainer.querySelectorAll('.seq-dots-container .seq-dot')
            : [];
        
        function updateArpOctaveUI() {
            const oct = arpeggiatorInstance.getOctaves();
            octDots.forEach((dot, i) => {
                dot.classList.toggle('active', i + 1 === oct);
            });
        }

        if (octDown) {
            octDown.addEventListener('click', () => {
                let oct = arpeggiatorInstance.getOctaves();
                if (oct > 1) {
                    arpeggiatorInstance.setOctaves(oct - 1);
                    updateArpOctaveUI();
                }
            });
        }

        if (octUp) {
            octUp.addEventListener('click', () => {
                let oct = arpeggiatorInstance.getOctaves();
                if (oct < 5) {
                    arpeggiatorInstance.setOctaves(oct + 1);
                    updateArpOctaveUI();
                }
            });
        }

        // Direction Buttons
        const dirDown = document.getElementById('seq-direction-down');
        const dirUp = document.getElementById('seq-direction-up');
        const arpDirectionDotContainer = (dirDown || dirUp)
            ? (dirDown || dirUp).closest('.seq-button-container')
            : null;
        const dirDots = arpDirectionDotContainer
            ? arpDirectionDotContainer.querySelectorAll('.seq-dots-container .seq-dot')
            : [];
        const modes = ['up', 'down', 'forward', 'upDown', 'random']; // 'forward' is 'order'
        // Map internal modes to UI dots
        // UI: Up, Down, Forward(Order), UpDown, Random
        
        function updateArpModeUI() {
            const mode = arpeggiatorInstance.getMode();
            // Map mode string to index
            let index = 0;
            if (mode === 'up') index = 0;
            else if (mode === 'down') index = 1;
            else if (mode === 'order') index = 2;
            else if (mode === 'upDown') index = 3;
            else if (mode === 'random') index = 4;
            
            dirDots.forEach((dot, i) => {
                dot.classList.toggle('active', i === index);
            });
        }

        if (dirDown) {
            dirDown.addEventListener('click', () => {
                const currentMode = arpeggiatorInstance.getMode();
                let index = 0;
                if (currentMode === 'up') index = 0;
                else if (currentMode === 'down') index = 1;
                else if (currentMode === 'order') index = 2;
                else if (currentMode === 'upDown') index = 3;
                else if (currentMode === 'random') index = 4;
                
                if (index > 0) {
                    index--;
                    let newMode = 'up';
                    if (index === 1) newMode = 'down';
                    else if (index === 2) newMode = 'order';
                    else if (index === 3) newMode = 'upDown';
                    else if (index === 4) newMode = 'random';
                    
                    arpeggiatorInstance.setMode(newMode);
                    updateArpModeUI();
                }
            });
        }

        if (dirUp) {
            dirUp.addEventListener('click', () => {
                const currentMode = arpeggiatorInstance.getMode();
                let index = 0;
                if (currentMode === 'up') index = 0;
                else if (currentMode === 'down') index = 1;
                else if (currentMode === 'order') index = 2;
                else if (currentMode === 'upDown') index = 3;
                else if (currentMode === 'random') index = 4;
                
                if (index < 4) {
                    index++;
                    let newMode = 'up';
                    if (index === 1) newMode = 'down';
                    else if (index === 2) newMode = 'order';
                    else if (index === 3) newMode = 'upDown';
                    else if (index === 4) newMode = 'random';
                    
                    arpeggiatorInstance.setMode(newMode);
                    updateArpModeUI();
                }
            });
        }
        
        // Initialize UI
        updateArpOctaveUI();
        updateArpModeUI();
    }
    
    // Initialize octave indicator to center position (0)
    updateOctaveIndicator();
}

// Update destination highlight as slider moves
function updateDestinationHighlight(destination) {
    const tickLabels = document.querySelectorAll('.seq-destination-ticks .tick-label');
    
    console.log(`updateDestinationHighlight: Found ${tickLabels.length} labels, destination=${destination}`);
    console.log('divisionConnections:', divisionConnections);
    
    tickLabels.forEach(label => {
        const labelDest = label.textContent.trim();
        
        // Update routed class based on connection state
        if (divisionConnections[labelDest]) {
            label.classList.add('routed');
        } else {
            label.classList.remove('routed');
        }
        
        // If this is the current destination, apply orange inline style (overrides CSS)
        if (labelDest === destination) {
            label.style.color = '#CF814D'; // Orange for current
        } else {
            // Remove inline style to let CSS class take over
            label.style.color = '';
        }
    });
}

// Update select button state based on current destination routing
function updateSelectButtonState() {
    const selectButton = document.getElementById('seq-select-button');
    if (!selectButton) return;
    
    // Check if current destination is routed
    const isRouted = divisionConnections[currentDivisionDestination];
    
    // Update button state
    selectButton.classList.remove('active');
    if (isRouted) {
        void selectButton.offsetHeight; // Trigger reflow
        selectButton.classList.add('active');
    }

    if (!sequencerSpaceHotkeyBound) {
        document.addEventListener('keydown', handleSequencerGlobalKeydown);
        sequencerSpaceHotkeyBound = true;
    }
}

export function initializeSequencerModule() {
    initializeDivisionSystem();
    initializeSequencerUI();

    updateTempoKnobDisplay();
    updateDivisionRoutingIndicators();

    const destSlider = document.querySelector('.seq-destination-range');
    if (destSlider) {
        destSlider.value = 0;
        currentDivisionDestination = 'GLOBAL';
    }

    requestAnimationFrame(() => {
        updateDestinationHighlight('GLOBAL');
        updateSelectButtonState();
        updateDivisionKnobForDestination('GLOBAL');
    });

    console.log('Sequencer tempo system loaded');
}
