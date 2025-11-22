// Arpeggiator Module
export function createArpeggiator({
    playNote,
    getIntervalMs,
    getTempo,
    getAudioContext
} = {}) {
    let isActive = false;
    let isHold = false;
    let mode = 'up';
    let octaves = 1;

    let heldNotes = [];
    let patternNotes = [];
    let noteCursor = 0;
    let schedulerId = null;
    let nextStepTime = null;
    let pendingSteps = [];
    let nextScheduledStepId = 0;
    let scheduleGeneration = 0;
    let startGraceTimer = null;
    let holdPressedNotes = new Set();
    let holdBatchNotes = new Set();
    let holdCommitTimer = null;
    let holdBatchActive = false;
    let holdBatchShouldExtend = false;
    let chordCaptureTimer = null;
    let chordCapturePrevState = false;
    let skipNextStartGrace = false;

    const schedulerLookahead = 25; // ms between scheduler checks
    const MIN_SCHEDULE_AHEAD = 0.1; // base seconds to keep queued
    const MIN_INTERVAL_SECONDS = 0.002; // allow up to ~500 steps per second
    const STEP_TRIGGER_MIN_LEAD = 0.003;
    const STEP_TRIGGER_MAX_LEAD = 0.05;
    const STEP_TRIGGER_LEAD_RATIO = 0.6;
    const STEP_IMMEDIATE_WINDOW = 0.001;
    const GATE_RATIO = 1;
    const MIN_GATE_SECONDS = 0.02;
    const ARP_START_GRACE_MS = 15;
    const HOLD_COMMIT_WINDOW_MS = 120;
    const CHORD_CAPTURE_WINDOW_MS = 7;

    const getIntervalSeconds = () => Math.max(MIN_INTERVAL_SECONDS, intervalFallback() / 1000);

    const intervalFallback = () => {
        if (typeof getIntervalMs === 'function') {
            const value = getIntervalMs('ARP');
            if (Number.isFinite(value) && value > 0) {
                return value;
            }
        }
        if (typeof getTempo === 'function') {
            const tempo = getTempo();
            if (Number.isFinite(tempo) && tempo > 0) {
                return (60000 / tempo) / 4;
            }
        }
        return 125;
    };

    const resolveAudioCtx = () => (typeof getAudioContext === 'function' ? getAudioContext() : null);

    function sortNotes(notes) {
        return notes.slice().sort((a, b) => a - b);
    }

    function hasPatternToPlay() {
        return isActive && patternNotes.length > 0;
    }

    function cancelStartGrace() {
        if (startGraceTimer) {
            clearTimeout(startGraceTimer);
            startGraceTimer = null;
        }
    }

    function requestStartGrace() {
        cancelStartGrace();
        startGraceTimer = setTimeout(() => {
            startGraceTimer = null;
            if (!hasPatternToPlay()) return;
            scheduleGeneration++;
            triggerImmediateStep();
        }, ARP_START_GRACE_MS);
    }

    function cancelChordCapture() {
        if (chordCaptureTimer) {
            clearTimeout(chordCaptureTimer);
            chordCaptureTimer = null;
        }
        chordCapturePrevState = false;
        skipNextStartGrace = false;
    }

    function scheduleChordCapture(previouslyHadPattern) {
        chordCapturePrevState = chordCapturePrevState || previouslyHadPattern;
        if (chordCaptureTimer) return;
        chordCaptureTimer = setTimeout(() => {
            chordCaptureTimer = null;
            const priorState = chordCapturePrevState;
            chordCapturePrevState = false;
            skipNextStartGrace = true;
            handlePatternRefresh(priorState);
        }, CHORD_CAPTURE_WINDOW_MS);
    }

    function resetHoldTracking() {
        holdPressedNotes.clear();
        holdBatchNotes.clear();
        holdBatchActive = false;
        holdBatchShouldExtend = false;
        if (holdCommitTimer) {
            clearTimeout(holdCommitTimer);
            holdCommitTimer = null;
        }
    }

    function arraysEqual(a = [], b = []) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    function handlePatternRefresh(previouslyHadPattern) {
        const hasPattern = patternNotes.length > 0;
        if (!previouslyHadPattern && hasPattern && isActive) {
            if (skipNextStartGrace) {
                skipNextStartGrace = false;
                restartScheduleFromNow({ immediate: true });
            } else {
                requestStartGrace();
            }
        } else if (hasPattern && isActive) {
            if (startGraceTimer) {
                requestStartGrace();
            } else {
                restartScheduleFromNow({ immediate: true });
            }
        } else if (!hasPattern) {
            skipNextStartGrace = false;
            cancelChordCapture();
            stopScheduler();
        } else {
            skipNextStartGrace = false;
            ensureScheduler();
        }
    }

    function commitHoldBatch() {
        if (!isHold || holdBatchNotes.size === 0) {
            holdBatchActive = false;
            holdBatchShouldExtend = false;
            return false;
        }

        const nextNotes = sortNotes(Array.from(holdBatchNotes));
        holdBatchNotes.clear();
        holdBatchActive = false;

        let combinedNotes;
        if (holdBatchShouldExtend && heldNotes.length > 0) {
            const combinedSet = new Set(heldNotes);
            nextNotes.forEach(n => combinedSet.add(n));
            combinedNotes = sortNotes(Array.from(combinedSet));
        } else {
            combinedNotes = nextNotes;
        }

        holdBatchShouldExtend = false;

        if (arraysEqual(combinedNotes, heldNotes)) {
            return false;
        }

        const previouslyHadPattern = patternNotes.length > 0;
        heldNotes = combinedNotes;
        generatePattern();
        handlePatternRefresh(previouslyHadPattern);
        return true;
    }

    function scheduleHoldCommit({ immediate = false } = {}) {
        if (!isHold) return false;
        if (holdCommitTimer) {
            clearTimeout(holdCommitTimer);
            holdCommitTimer = null;
        }

        if (immediate) {
            return commitHoldBatch();
        }

        holdCommitTimer = setTimeout(() => {
            holdCommitTimer = null;
            commitHoldBatch();
        }, HOLD_COMMIT_WINDOW_MS);
        return false;
    }

    function clearScheduledSteps({ adjustCursor = false } = {}) {
        if (pendingSteps.length === 0) {
            return { removed: 0, earliestTime: null };
        }
        const earliestTime = pendingSteps[0]?.time ?? null;
        const removed = pendingSteps.length;
        pendingSteps.forEach(step => {
            if (step && step.timerId) {
                clearTimeout(step.timerId);
                step.timerId = null;
            }
            if (step) {
                step.cancelled = true;
            }
        });
        pendingSteps = [];
        if (adjustCursor && removed > 0 && mode !== 'random') {
            noteCursor = Math.max(0, noteCursor - removed);
        }
        return { removed, earliestTime };
    }

    function restartScheduleFromNow({ immediate = true } = {}) {
        scheduleGeneration++;
        const { earliestTime } = clearScheduledSteps({ adjustCursor: true });
        if (!hasPatternToPlay()) {
            nextStepTime = null;
            return;
        }

        const audioCtx = resolveAudioCtx();
        const now = audioCtx ? audioCtx.currentTime : null;
        let startTime = now;
        if (earliestTime !== null && now !== null) {
            startTime = Math.max(now, earliestTime);
        } else if (earliestTime !== null) {
            startTime = earliestTime;
        }
        nextStepTime = startTime ?? now;
        ensureScheduler({ immediate });
    }

    function stopScheduler() {
        if (schedulerId) {
            clearInterval(schedulerId);
            schedulerId = null;
        }
        nextStepTime = null;
        clearScheduledSteps();
        cancelStartGrace();
        cancelChordCapture();
    }

    function runScheduler() {
        if (!hasPatternToPlay()) {
            stopScheduler();
            return;
        }

        const audioCtx = resolveAudioCtx();
        if (!audioCtx) return;

        const now = audioCtx.currentTime;
        const intervalSeconds = getIntervalSeconds();
        const lookaheadWindow = Math.max(MIN_SCHEDULE_AHEAD, intervalSeconds * 4);

        if (!nextStepTime || nextStepTime < now) {
            nextStepTime = now;
        }

        while (nextStepTime < now + lookaheadWindow) {
            triggerArpStep(nextStepTime);
            nextStepTime += intervalSeconds;
        }
    }

    function ensureScheduler({ immediate = false } = {}) {
        if (!hasPatternToPlay()) {
            stopScheduler();
            return;
        }

        if (!schedulerId) {
            schedulerId = setInterval(runScheduler, schedulerLookahead);
        }

        if (immediate) {
            runScheduler();
        }
    }

    function triggerImmediateStep() {
        const audioCtx = resolveAudioCtx();
        if (!audioCtx || !hasPatternToPlay()) return;

        const now = audioCtx.currentTime;
        const intervalSeconds = getIntervalSeconds();
        triggerArpStep(now);
        nextStepTime = now + intervalSeconds;
        ensureScheduler();
    }

    function triggerArpStep(time) {
        if (!hasPatternToPlay()) {
            stopScheduler();
            return;
        }

        let note;
        if (mode === 'random') {
            const idx = Math.floor(Math.random() * patternNotes.length);
            note = patternNotes[idx];
        } else {
            const length = patternNotes.length;
            if (length === 0) return;
            const currentIndex = ((noteCursor % length) + length) % length;
            note = patternNotes[currentIndex];
            noteCursor += 1;
        }

        if (note !== undefined) {
            const intervalSeconds = getIntervalSeconds();
            const duration = Math.max(MIN_GATE_SECONDS, intervalSeconds * GATE_RATIO);
            scheduleStep(note, time, duration, intervalSeconds);
        }
    }

    function scheduleStep(note, time, duration, intervalSeconds) {
        const audioCtx = resolveAudioCtx();
        if (!audioCtx || typeof playNote !== 'function') return;

        const step = {
            id: nextScheduledStepId++,
            note,
            time,
            duration,
            leadTime: calculateStepLead(intervalSeconds),
            timerId: null,
            cancelled: false,
            generation: scheduleGeneration
        };
        pendingSteps.push(step);
        pendingSteps.sort((a, b) => a.time - b.time);
        scheduleIndividualStep(step, audioCtx);
    }

    function scheduleIndividualStep(step, audioCtx = resolveAudioCtx()) {
        if (!audioCtx || !step || step.cancelled) return;

        if (step.timerId) {
            clearTimeout(step.timerId);
            step.timerId = null;
        }

        const now = audioCtx.currentTime;
        const earliestTrigger = step.time - step.leadTime;
        if (earliestTrigger <= now + STEP_IMMEDIATE_WINDOW) {
            fireScheduledStep(step, audioCtx);
            return;
        }

        const delayMs = Math.max(0, (earliestTrigger - now) * 1000);
        step.timerId = setTimeout(() => {
            step.timerId = null;
            fireScheduledStep(step, audioCtx);
        }, delayMs);
    }

    function fireScheduledStep(step, audioCtx = resolveAudioCtx()) {
        if (!audioCtx || !step || step.cancelled) return;

        removePendingStep(step.id);

        if (!hasPatternToPlay()) {
            return;
        }

        if (step.generation !== scheduleGeneration) {
            return;
        }

        playNote(step.note, step.time, step.duration, step.id);
    }

    function removePendingStep(stepId) {
        const idx = pendingSteps.findIndex(p => p.id === stepId);
        if (idx !== -1) {
            const [removed] = pendingSteps.splice(idx, 1);
            if (removed && removed.timerId) {
                clearTimeout(removed.timerId);
                removed.timerId = null;
            }
            return removed;
        }
        return null;
    }

    function calculateStepLead(intervalSeconds) {
        const target = intervalSeconds * STEP_TRIGGER_LEAD_RATIO;
        return Math.min(STEP_TRIGGER_MAX_LEAD, Math.max(STEP_TRIGGER_MIN_LEAD, target));
    }

    function generatePattern() {
        if (heldNotes.length === 0) {
            patternNotes = [];
            noteCursor = 0;
            return;
        }

        let baseNotes = sortNotes(heldNotes);
        if (mode === 'down') {
            baseNotes.reverse();
        } else if (mode === 'order') {
            baseNotes = heldNotes.slice();
        } else if (mode === 'random') {
            baseNotes = heldNotes.slice();
        }

        let expandedNotes = [];
        if (mode === 'down') {
            baseNotes = sortNotes(heldNotes);
        }

        for (let oct = 0; oct < octaves; oct++) {
            for (let i = 0; i < baseNotes.length; i++) {
                const noteValue = baseNotes[i] + (oct * 12);
                if (noteValue <= 127) {
                    expandedNotes.push(noteValue);
                }
            }
        }

        if (mode === 'down') {
            expandedNotes.reverse();
            patternNotes = expandedNotes;
        } else if (mode === 'upDown') {
            const upPart = expandedNotes.slice();
            let downPart = expandedNotes.slice().reverse();
            if (downPart.length > 2) {
                downPart = downPart.slice(1, -1);
            } else {
                downPart = [];
            }
            patternNotes = upPart.concat(downPart);
        } else if (mode === 'random') {
            patternNotes = expandedNotes;
        } else {
            patternNotes = expandedNotes;
        }

        console.log(`Arp Pattern: ${patternNotes.join(', ')} (Mode: ${mode}, Oct: ${octaves})`);
    }

    return {
        init() {
            console.log('Arpeggiator initialized');
        },
        setActive(active) {
            isActive = active;
            console.log(`Arpeggiator Active: ${isActive}`);
            if (!active) {
                stopScheduler();
            } else {
                if (patternNotes.length > 0) {
                    const audioCtx = resolveAudioCtx();
                    nextStepTime = audioCtx ? audioCtx.currentTime : null;
                }
                ensureScheduler({ immediate: true });
            }
        },
        setHold(hold) {
            isHold = hold;
            console.log(`Arpeggiator Hold: ${isHold}`);
            resetHoldTracking();
            if (!hold && heldNotes.length > 0) {
                heldNotes = [];
                generatePattern();
            }
            restartScheduleFromNow({ immediate: true });
        },
        setMode(newMode) {
            mode = newMode;
            console.log(`Arpeggiator Mode: ${mode}`);
            generatePattern();
            restartScheduleFromNow({ immediate: true });
        },
        setOctaves(newOctaves) {
            octaves = newOctaves;
            console.log(`Arpeggiator Octaves: ${octaves}`);
            generatePattern();
            restartScheduleFromNow({ immediate: true });
        },
        handleNoteOn(note) {
            const hadPattern = patternNotes.length > 0;
            let patternChanged = false;

            if (isHold) {
                const hadPhysicalBefore = holdPressedNotes.size > 0;
                holdPressedNotes.add(note);

                if (!holdBatchActive) {
                    holdBatchNotes.clear();
                    holdBatchActive = true;
                    holdBatchShouldExtend = hadPhysicalBefore;
                }

                holdBatchNotes.add(note);
                patternChanged = scheduleHoldCommit();
            } else {
                if (!heldNotes.includes(note)) {
                    heldNotes.push(note);
                    generatePattern();
                    patternChanged = true;
                }
            }

            if (!isHold) {
                if (patternChanged) {
                    if (!hadPattern) {
                        if (isActive) {
                            scheduleChordCapture(hadPattern);
                        } else {
                            handlePatternRefresh(hadPattern);
                        }
                    } else {
                        handlePatternRefresh(hadPattern);
                    }
                } else {
                    ensureScheduler();
                }
            }
        },
        handleNoteOff(note) {
            if (isHold) {
                holdPressedNotes.delete(note);
                scheduleHoldCommit();
                return;
            }

            const idx = heldNotes.indexOf(note);
            if (idx > -1) {
                heldNotes.splice(idx, 1);
                if (heldNotes.length === 0) {
                    cancelChordCapture();
                }
                const previouslyHadPattern = patternNotes.length > 0;
                generatePattern();
                handlePatternRefresh(previouslyHadPattern);
                return;
            }

            if (heldNotes.length === 0) {
                cancelChordCapture();
                stopScheduler();
            } else {
                ensureScheduler();
            }
        },
        isActive: () => isActive,
        isHold: () => isHold,
        getMode: () => mode,
        getOctaves: () => octaves
    };
}
