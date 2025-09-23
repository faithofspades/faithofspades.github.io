import { createiOSStartupOverlay } from './ios.js';
import { initializeKnob } from './controls.js'; 
import { fixMicRecording, createCrossfadedBuffer } from './sampler.js'; 
import { initializeModCanvas, getModulationPoints } from './modCanvas.js';
import { initializeKeyboard, keys, resetKeyStates } from './keyboard.js';
import { fixAllKnobs, initializeSpecialButtons, fixSwitchesTouchMode } from './controlFixes.js'; 
import { initializeUiPlaceholders } from './uiPlaceholders.js'; 

const D = x => document.getElementById(x);
const TR2 = 2 ** (1.0 / 12.0);
const STANDARD_FADE_TIME = 0.000; // 0ms standard fade time
const VOICE_STEAL_SAFETY_BUFFER = 0.000; // 2ms safety buffer for voice stealing
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
Tone.setContext(audioCtx); // <<< ADD THIS LINE
const masterGain = audioCtx.createGain();
masterGain.gain.setValueAtTime(0.5, audioCtx.currentTime);
masterGain.connect(audioCtx.destination);
// --- Load AudioWorklet with better initialization sequence ---
let isWorkletReady = false;
let pendingInitialization = true;

// Create a promise to track when everything is ready
const workletReadyPromise = audioCtx.audioWorklet.addModule('js/shape-hold-processor.js')
    .then(() => {
        console.log('ShapeHoldProcessor AudioWorklet loaded successfully.');
        isWorkletReady = true;
        
        // Only initialize voice pools when worklet is fully ready
        console.log("Initializing oscillator and sampler voice pools...");
        initializeVoicePool();
        initializeSamplerVoicePool();
        
        pendingInitialization = false;
        console.log("All voice pools initialized - synth is ready");
        return true;
    })
    .catch(error => {
        console.error('Failed to load ShapeHoldProcessor AudioWorklet:', error);
        pendingInitialization = false;
        return false;
    });

// Add a safety timeout in case initialization hangs
setTimeout(() => {
    if (pendingInitialization) {
        console.warn("AudioWorklet initialization taking too long - continuing anyway");
        pendingInitialization = false;
    }
}, 3000);

// --- Handle AudioContext Suspension/Resumption ---
function handleVisibilityChange() {
    if (!audioCtx) return;

    if (document.hidden) {
        console.log("Page hidden, AudioContext might suspend. Clearing release timers.");
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state === 'releasing') { // Check the voice state first
                // Check each component within the releasing voice
                [voice.samplerNote, voice.osc1Note, voice.osc2Note].forEach(note => {
                    if (note && note.state === 'releasing') { // Double-check component state
                        // Find the timeout event associated with this note's release
                        const releaseTimeoutEvent = note.scheduledEvents?.find(event => event.type === "timeout");
                        if (releaseTimeoutEvent && releaseTimeoutEvent.id) {
                            console.log(`Clearing release timer ${releaseTimeoutEvent.id} for hidden note ${note.id}`);
                            // Use trackClearTimeout, passing the note object to ensure removal from scheduledEvents
                            trackClearTimeout(releaseTimeoutEvent.id, note);
                            // No need to nullify killTimerId as trackClearTimeout handles scheduledEvents
                        } else if (note.killTimerId) { // Fallback for legacy timer ID
                            console.log(`Clearing legacy release timer ${note.killTimerId} for hidden note ${note.id}`);
                            trackClearTimeout(note.killTimerId, note); // Pass note here too
                            note.killTimerId = null; // Clear legacy ID
                        }
                    }
                });
            }
        });
    } else {
        console.log("Page visible, ensuring AudioContext is running.");
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().then(() => {
                console.log("AudioContext resumed successfully.");
                // --- Check Releasing Notes on Resume ---
                checkReleasingNotesOnResume();
                // --- End Check ---
            }).catch(e => {
                console.error("Error resuming AudioContext:", e);
            });
        } else if (audioCtx.state === 'interrupted') {
             audioCtx.resume().then(() => {
                console.log("AudioContext resumed from interrupted state.");
                checkReleasingNotesOnResume();
             }).catch(e => {
                console.error("Error resuming AudioContext from interrupted state:", e);
             });
        } else {
            console.log(`AudioContext state is already: ${audioCtx.state}`);
            // Still check releasing notes even if context wasn't suspended,
            // as timers might have been throttled.
            checkReleasingNotesOnResume();
        }
    }
}

document.addEventListener('visibilitychange', handleVisibilityChange, false);

// Also check state when window gains focus
window.addEventListener('focus', () => {
    console.log("Window focused, checking AudioContext state.");
    // Call the same handler
    handleVisibilityChange();
});
function diagnoseSamplerState() {
    console.log("=== SAMPLER DIAGNOSTIC ===");
    console.log(`audioBuffer exists: ${!!audioBuffer}, length: ${audioBuffer ? audioBuffer.length : 'N/A'}`);
    console.log(`originalBuffer exists: ${!!originalBuffer}`);
    console.log(`fadedBuffer exists: ${!!fadedBuffer}`);
    console.log(`cachedCrossfadedBuffer exists: ${!!cachedCrossfadedBuffer}`);
    console.log(`currentSampleGain: ${currentSampleGain}`);
    console.log(`sampleStartPosition: ${sampleStartPosition}`);
    console.log(`sampleEndPosition: ${sampleEndPosition}`);
    console.log(`isSampleLoopOn: ${isSampleLoopOn}`);
    console.log(`isEmuModeOn: ${isEmuModeOn}`);
    
    let activeVoices = 0;
    samplerVoicePool.forEach(voice => {
        if (voice.state !== 'inactive') {
            activeVoices++;
            console.log(`Active sampler voice ${voice.id}, note: ${voice.noteNumber}`);
            if (voice.samplerNote) {
                console.log(`- samplerNote exists, state: ${voice.samplerNote.state}`);
                console.log(`- source exists: ${!!voice.samplerNote.source}`);
                if (voice.samplerNote.source) {
                    console.log(`- source buffer exists: ${!!voice.samplerNote.source.buffer}`);
                }
            }
        }
    });
    console.log(`Total active sampler voices: ${activeVoices}`);
    console.log("=== END DIAGNOSTIC ===");
}
// Function to check releasing notes after resume
function checkReleasingNotesOnResume() {
    console.log("Checking state of releasing notes on resume/focus...");
    const now = audioCtx.currentTime; // Get current time after resume/focus
    let notesKilledOnResume = 0;

    voicePool.forEach(voice => {
        if (voice.state === 'releasing') { // Check voice state directly
            // Check Sampler Note
            const samplerNote = voice.samplerNote;
            // Force gain to 0 and kill if state was 'releasing' and timer was cleared
            if (samplerNote && !samplerNote.killTimerId && !noteHasActiveTimeout(samplerNote)) {
    console.log(`Forcing gain to 0 and killing sampler note ${samplerNote.id} immediately on resume (was releasing when focus lost).`);
    try {
        samplerNote.gainNode.gain.cancelScheduledValues(now);
        // Add tiny ramp instead of immediate value
        samplerNote.gainNode.gain.setValueAtTime(samplerNote.gainNode.gain.value, now);
        samplerNote.gainNode.gain.linearRampToValueAtTime(0, now + STANDARD_FADE_TIME);
        setTimeout(() => killSamplerNote(samplerNote), STANDARD_FADE_TIME * 1000 + 5);
    } catch (e) { console.warn("Error setting gain to 0 on resume:", e); }
    notesKilledOnResume++;
}

            // Check Osc1 Note
            const osc1Note = voice.osc1Note;
            if (osc1Note && !osc1Note.killTimerId && !noteHasActiveTimeout(osc1Note)) { // Check for active tracked timer
                console.log(`Forcing gain to 0 and killing osc1 note ${osc1Note.id} immediately on resume (was releasing when focus lost).`);
                try {
                    osc1Note.gainNode.gain.cancelScheduledValues(now);
                    osc1Note.gainNode.gain.setValueAtTime(0, now);
                } catch (e) { console.warn("Error setting gain to 0 on resume:", e); }
                killOsc1Note(osc1Note); // Use existing kill function
                notesKilledOnResume++;
            }

            // Check Osc2 Note
            const osc2Note = voice.osc2Note;
            if (osc2Note && !osc2Note.killTimerId && !noteHasActiveTimeout(osc2Note)) { // Check for active tracked timer
                console.log(`Forcing gain to 0 and killing osc2 note ${osc2Note.id} immediately on resume (was releasing when focus lost).`);
                try {
                    osc2Note.gainNode.gain.cancelScheduledValues(now);
                    osc2Note.gainNode.gain.setValueAtTime(0, now);
                } catch (e) { console.warn("Error setting gain to 0 on resume:", e); }
                killOsc2Note(osc2Note); // Use existing kill function
                notesKilledOnResume++;
            }
        }
    });

    if (notesKilledOnResume > 0) {
        console.log(`Force-killed ${notesKilledOnResume} note components that were releasing when focus was lost.`);
        updateVoiceDisplay_Pool(); // Use the new display function
    updateKeyboardDisplay_Pool(); // Use the new display function
} else {
        console.log("No releasing notes needed immediate cleanup on resume/focus.");
    }
}
// --- End AudioContext Handling ---


// Add this after the masterGain initialization
let currentVolume = 0.5; // Initial volume
masterGain.gain.setValueAtTime(currentVolume, audioCtx.currentTime, 0.01);
// Add these global variables at the top with other audio-related variables
// Add to your global variables
let currentSampleDetune = 0; // Range will be -1200 to +1200 cents
let currentMonoSamplerVoice = null;
let isEmuModeOn = false;
let currentModSource = 'lfo';
let isSampleKeyTrackingOn = true;
let mediaRecorder = null;
let isSampleReversed = false;
let isModeTransitioning = false;
let originalBuffer = null;
let audioBuffer = null; // <<< ADD THIS LINE: Initialize audioBuffer to null
let recordedChunks = [];
let isRecording = false;
let recordingStartTime = null;
let fadedBufferOriginalDuration = null;
let emuFilterNode = null;
let lastActualSamplerRate = null;
let lastActualOsc1Freq = null;
// PWM, FM, Quantize state would go here later
const activeOsc1Notes = {}; // Separate tracking for oscillator notes
let osc1HeldNotes = [];
let osc1CurrentNote = null;
let osc1LastPlayedNote = null; // Separate tracking for Osc1 glide
// --- Oscillator 1 State (Keep parameters) ---
let osc1Waveform = 'triangle';
let osc1OctaveOffset = 0;
let osc1Detune = 0;
let osc1GainValue = 0.5;
let osc1PWMValue = 0.0; // 0.0 to 1.0. Interpreted as Duty Cycle (Pulse/Square) or Shape Amount (Others)
let osc1QuantizeValue = 0.0; // <<< ADD: Quantization amount 0.0 to 1.0
let osc1FMAmount = 0.0; // 0.0 to 1.0
let osc1FMSource = 'sampler'; // 'sampler' or 'osc2'
const osc1FMDepthScale = 22000; // Max frequency deviation in Hz
// --- Oscillator 2 State --- // <<< ADD OSC 2 STATE >>>
let osc2Waveform = 'triangle';
let osc2OctaveOffset = 0;
let osc2Detune = 0; // Fine tune in cents
let osc2GainValue = 0.5;
let osc2PWMValue = 0.0; // 0.0 to 1.0
let osc2QuantizeValue = 0.0; // 0.0 to 1.0
let osc2FMAmount = 0.0; // 0.0 to 1.0 (Control knob value)
let osc2FMSource = 'sampler'; // 'sampler' or 'osc1'
const osc2FMDepthScale = 22000; // Max frequency deviation in Hz
let lastActualOsc2Freq = null; // For portamento glide start
// Store previous pitch values *before* updating voice state, needed for glide calculations
let glideStartRate = null;
let glideStartFreqOsc1 = null;
let glideStartFreqOsc2 = null;
let glideStartFreqFmOsc1 = null; // <<< ADD: Start freq for Osc1's FM source if it's Osc2
let glideStartDetuneFmOsc1 = null; // <<< ADD: Start detune for Osc1's FM source if it's Osc2
let glideStartFreqFmOsc2 = null; // <<< ADD: Start freq for Osc2's FM source if it's Osc1
let glideStartDetuneFmOsc2 = null; // <<< ADD: Start detune for Osc2's FM source if it's Osc1

let isMonoMode = false;
let isLegatoMode = false;
let isPortamentoOn = false;
let glideTime = 0.1; // seconds
let heldNotes = []; // Keep track of held notes in mono mode
let nodeMonitorInterval = null; // To store the interval ID
const activeSynthTimers = new Set(); // <<< ADD: Track active setTimeout IDs
let sampleSource = null;
let isPlaying = false;
let sampleStartPosition = 0; // 0-1 range representing portion of audio file
let sampleEndPosition = 1;   // 0-1 range (default to full sample)
let sampleCrossfadeAmount = 0; // 0-1 range for crossfade percentage
let isSampleLoopOn = false; // Will now be controlled by crossfade knob
let cachedCrossfadedBuffer = null;
let crossfadeUpdateTimer = null;
let sampleFadeInAmount = 0;
let sampleFadeOutAmount = 0;
let fadeProcessTimer = null;
let fadedBuffer = null;
let startUpdateTimer = null;
let endUpdateTimer = null;
let lastCachedStartPos = null;
let lastCachedEndPos = null;
let lastCachedCrossfade = null;
// --- Mono Mode Specific Tracking ---
let currentMonoVoice = null; // Reference to the active *voice object* in mono mode { samplerNote: ..., osc1Note: ... }
let lastPlayedNoteNumber = null; // Tracks the last note triggered for portamento (used by both sampler & osc)

// Add at top with other global variables
let sampleGainNode = audioCtx.createGain();
sampleGainNode.gain.value = 0.5;
// Update the createNote function to use a reference to the current gain value
let currentSampleGain = 0.5; // Add this with other global variables
let currentSamplePosition = 0; // Add this with other global variables
const knobDefaults = {
'sample-start-knob': 0.0,     // Start at beginning of sample
'sample-end-knob': 1.0,       // End at end of sample
'sample-crossfade-knob': 0.0, // No crossfade initially
'glide-time-knob': 0.05,      // 100ms (5% of 2000ms)
'osc1-gain-knob': 0.5, // <<< ADD: Default gain 50%
'osc1-pitch-knob': 0.5, // <<< ADD: Default pitch 0 cents (center)
'osc1-pwm-knob': 0.0, // Default: 50% duty cycle / minimal shape distortion
'osc1-quantize-knob': 0.0, // <<< ADD: Default quantize amount
'osc1-fm-knob': 0.0, // <<< ADD: Default FM amount
'osc2-gain-knob': 0.5, // <<< ADD: Default gain 50%
'osc2-pitch-knob': 0.5, // <<< ADD: Default pitch 0 cents (center)
'osc2-pwm-knob': 0.0, // Default: 50% duty cycle / minimal shape distortion
'osc2-quantize-knob': 0.0, // <<< ADD: Default quantize amount
'osc2-fm-knob': 0.0, // <<< ADD: Default FM amount
// All other knobs default to 0.5
};
// --- Helper Functions ---
/**
 * Creates and initializes all audio nodes for a single voice in the pool.
 * Nodes are initially disconnected or connected to a dummy gain.
 * @param {AudioContext} ctx - The Audio Context.
 * @param {number} index - The index of this voice in the pool.
 * @returns {object} The initialized voice object.
 */
function createVoice(ctx, index) {
    const voice = {
        id: `voice_${index}`,
        index: index,
        noteNumber: null, // MIDI note number currently playing
        startTime: 0,     // Context time when the note started
        state: 'inactive', // 'inactive', 'playing', 'releasing', 'resetting'
        samplerNote: null,
        osc1Note: null,
        osc2Note: null,
        stolenFrom: null,  // NEW: Track which note this voice was stolen from
    };

    // --- Create Sampler Nodes ---
    const samplerGainNode = ctx.createGain(); // ADSR
    const samplerSampleNode = ctx.createGain(); // Sample-specific gain
    const samplerSource = ctx.createBufferSource(); // Placeholder, buffer set later
    samplerGainNode.gain.value = 0;
    samplerSampleNode.gain.value = 0.5; // Default sample gain
    samplerSource.connect(samplerSampleNode);
    samplerSampleNode.connect(samplerGainNode);
    // samplerGainNode.connect(masterGain); // Connect in noteOn

    voice.samplerNote = {
        id: `sampler_${index}`,
        type: 'sampler',
        noteNumber: null,
        source: samplerSource,
        gainNode: samplerGainNode,
        sampleNode: samplerSampleNode,
        startTime: 0,
        state: 'inactive', // Separate state for component? Maybe sync with voice state.
        scheduledEvents: [],
        looping: false,
        usesProcessedBuffer: false,
        crossfadeActive: false,
        calculatedLoopStart: 0,
        calculatedLoopEnd: 0,
        isBeingUpdated: false,
        parentVoice: voice // <<< ADD parentVoice reference
    };
    // if (voice.samplerNote) voice.samplerNote.parentVoice = voice; // Alternative placement

    // --- Create Osc1 Nodes (Worklet + Gains + FM) ---
    if (isWorkletReady) { // Check if worklet is loaded
        const osc1LevelNode = ctx.createGain(); // Osc-specific gain
        const osc1GainNode = ctx.createGain();   // ADSR
        const osc1WorkletNode = new AudioWorkletNode(ctx, 'shape-hold-processor');
        const osc1FmDepthGain = ctx.createGain(); // FM Depth
        // FM Source node (Oscillator or BufferSource) created dynamically in noteOn/update

        osc1LevelNode.gain.value = 0.5; // Default osc gain
        osc1GainNode.gain.value = 0;
        osc1FmDepthGain.gain.value = 0;

        osc1WorkletNode.connect(osc1LevelNode);
        osc1LevelNode.connect(osc1GainNode);
        // osc1GainNode.connect(masterGain); // Connect in noteOn

        voice.osc1Note = {
            id: `osc1_${index}`,
            type: 'osc1',
            noteNumber: null,
            workletNode: osc1WorkletNode,
            levelNode: osc1LevelNode,
            gainNode: osc1GainNode,
            fmModulatorSource: null, // Created on demand
            fmDepthGain: osc1FmDepthGain,
            startTime: 0,
            state: 'inactive',
            scheduledEvents: [],
            parentVoice: voice // <<< ADD parentVoice reference
        };
        // if (voice.osc1Note) voice.osc1Note.parentVoice = voice; // Alternative placement
    } else {
        console.warn(`Voice ${index}: Worklet not ready during Osc1 node creation.`);
    }


    // --- Create Osc2 Nodes (Worklet + Gains + FM) ---
    if (isWorkletReady) { // Check if worklet is loaded
        const osc2LevelNode = ctx.createGain(); // Osc-specific gain
        const osc2GainNode = ctx.createGain();   // ADSR
        const osc2WorkletNode = new AudioWorkletNode(ctx, 'shape-hold-processor');
        const osc2FmDepthGain = ctx.createGain(); // FM Depth
        // FM Source node (Oscillator or BufferSource) created dynamically in noteOn/update

        osc2LevelNode.gain.value = 0.5; // Default osc gain
        osc2GainNode.gain.value = 0;
        osc2FmDepthGain.gain.value = 0;

        osc2WorkletNode.connect(osc2LevelNode);
        osc2LevelNode.connect(osc2GainNode);
        // osc2GainNode.connect(masterGain); // Connect in noteOn

        voice.osc2Note = {
            id: `osc2_${index}`,
            type: 'osc2',
            noteNumber: null,
            workletNode: osc2WorkletNode,
            levelNode: osc2LevelNode,
            gainNode: osc2GainNode,
            fmModulatorSource: null, // Created on demand
            fmDepthGain: osc2FmDepthGain,
            startTime: 0,
            state: 'inactive',
            scheduledEvents: [],
            parentVoice: voice // <<< ADD parentVoice reference
        };
        // if (voice.osc2Note) voice.osc2Note.parentVoice = voice; // Alternative placement
    } else {
         console.warn(`Voice ${index}: Worklet not ready during Osc2 node creation.`);
    }

    console.log(`Created voice ${index}`);
    return voice;
}

/**
 * Initializes the voice pool array. Must be called after AudioWorklet is ready.
 */
function initializeVoicePool() {
    if (!isWorkletReady) {
        console.error("Cannot initialize voice pool: AudioWorklet not ready.");
        // Optionally, retry after a delay or wait for the worklet promise
        // For now, we'll rely on calling this later.
        return;
    }
    console.log("Initializing voice pool...");
    voicePool.length = 0; // Clear any previous pool
    for (let i = 0; i < MAX_POLYPHONY; i++) {
        voicePool.push(createVoice(audioCtx, i));
    }
    console.log(`Voice pool initialized with ${voicePool.length} voices.`);
}
/**
 * Checks if all components of a voice are inactive or in a killable state.
 * @param {object} voice - The voice object.
 * @returns {boolean} True if the voice is effectively inactive.
 */
function isVoiceFullyInactive(voice) {
    if (!voice) return true;

    // CRITICAL FIX: A voice is fully inactive for allocation/cleanup purposes if all its
    // components are either 'inactive' or have already been 'killed'.
    // The 'releasing' state is NOT considered inactive here, which was the source of the bug.
    const samplerInactive = !voice.samplerNote || ['inactive', 'killed'].includes(voice.samplerNote.state);
    const osc1Inactive = !voice.osc1Note || ['inactive', 'killed'].includes(voice.osc1Note.state);
    const osc2Inactive = !voice.osc2Note || ['inactive', 'killed'].includes(voice.osc2Note.state);

    return samplerInactive && osc1Inactive && osc2Inactive;
}

/**
 * Finds an available voice in the pool.
 * Prefers inactive voices, otherwise steals the oldest playing/releasing voice.
 * @param {number} noteNumber - The MIDI note number that will be played
 * @returns {object|null} The found voice object or null if pool is empty.
 */
function findAvailableVoice(noteNumber, peek = false) {
    if (voicePool.length === 0) {
        return null;
    }

    // --- NEW, SMARTER ALLOCATION LOGIC ---

    // 1. Highest Priority: Find a truly inactive voice.
    const inactiveVoice = voicePool.find(v => v.state === 'inactive');
    if (inactiveVoice) {
        if (peek) return { wasStolen: false };
        inactiveVoice.wasStolen = false;
        inactiveVoice.isSelfStealing = false;
        return inactiveVoice;
    }

    // 2. No inactive voices. Find the oldest voice that is currently releasing.
    let oldestReleasingVoice = null;
    voicePool.forEach(v => {
        if (v.state === 'releasing') {
            if (!oldestReleasingVoice || v.startTime < oldestReleasingVoice.startTime) {
                oldestReleasingVoice = v;
            }
        }
    });

    if (oldestReleasingVoice) {
        if (peek) return { wasStolen: true };
        console.log(`findAvailableVoice: Stealing oldest RELEASING voice ${oldestReleasingVoice.id} for new note ${noteNumber}`);
        oldestReleasingVoice.wasStolen = true;
        oldestReleasingVoice.isSelfStealing = oldestReleasingVoice.noteNumber === noteNumber;
        return oldestReleasingVoice;
    }

    // 3. No inactive or releasing voices. Steal the oldest playing voice (FIFO).
    let oldestVoice = voicePool.reduce((oldest, current) => {
        return (!oldest || current.startTime < oldest.startTime) ? current : oldest;
    }, null);
    
    if (oldestVoice) {
        if (peek) return { wasStolen: true };
        console.log(`findAvailableVoice: Stealing oldest PLAYING voice ${oldestVoice.id} for new note ${noteNumber}`);
        oldestVoice.wasStolen = true;
        oldestVoice.isSelfStealing = oldestVoice.noteNumber === noteNumber;
        return oldestVoice;
    }
    // --- END NEW LOGIC ---

    return null; // Should not be reached if pool is not empty
}


/**
 * Performs an immediate, synchronous, and clean reset of a single voice component (sampler, osc1, or osc2).
 * This is the new, correct implementation that avoids destroying worklet nodes.
 * @param {object} component - The voice component to reset (e.g., voice.samplerNote).
 */
function hardResetVoiceComponent(component) {
    if (!component || component.state === 'inactive' || !component.workletNode) return;

    const now = audioCtx.currentTime;
    
    // CRITICAL FIX: Close the gate for zero-crossing silence
    const gateParam = component.workletNode.parameters.get('gate');
    if (gateParam) {
        gateParam.setValueAtTime(0, now);
        console.log(`hardResetVoiceComponent: Sent 'close gate' command to ${component.id}`);
    }

    // CRITICAL FIX: Also immediately reset the gain envelope 
    // This ensures the envelope doesn't continue into the new note
    if (component.gainNode) {
        component.gainNode.gain.cancelScheduledValues(now);
        component.gainNode.gain.setValueAtTime(0, now);
    }

    // Mark as inactive immediately for allocation purposes
    component.state = 'inactive';
    
    clearScheduledEventsForNote(component);
}

/**
 * Wrapper for setTimeout that tracks the timer ID.
 * @param {Function} callback The function to execute.
 * @param {number} delay The delay in milliseconds.
 * @param {object} [note] Optional: The note object to associate the timer with.
 * @returns {number} The timeout ID.
 */
function trackSetTimeout(callback, delay, note = null) {
    const timerId = setTimeout(() => {
        activeSynthTimers.delete(timerId); // Remove ID when callback executes
        // Remove from note's scheduledEvents if associated
        if (note && Array.isArray(note.scheduledEvents)) {
            const index = note.scheduledEvents.findIndex(event => event.type === "timeout" && event.id === timerId);
            if (index > -1) {
                note.scheduledEvents.splice(index, 1);
            }
        }
        callback();
    }, delay);
    activeSynthTimers.add(timerId); // Add ID to the set
    // Optionally associate with note for easier clearing later
    if (note && note.scheduledEvents) {
         // Avoid duplicate entries if somehow called multiple times for the same timer
         if (!note.scheduledEvents.some(event => event.type === "timeout" && event.id === timerId)) {
             note.scheduledEvents.push({ type: "timeout", id: timerId });
         }
    }
    // console.log(`trackSetTimeout: Added timer ${timerId}, Total: ${activeSynthTimers.size}`); // Optional detailed log
    return timerId;
}
/**
 * Wrapper for clearTimeout that removes the ID from tracking.
 * @param {number} timerId The timeout ID to clear.
 */
function trackClearTimeout(timerId, note = null) { // <<< Add optional note parameter
    if (timerId) {
        clearTimeout(timerId);
        const deleted = activeSynthTimers.delete(timerId);
        // Remove from note's scheduledEvents if associated
        if (note && Array.isArray(note.scheduledEvents)) {
            const index = note.scheduledEvents.findIndex(event => event.type === "timeout" && event.id === timerId);
            if (index > -1) {
                note.scheduledEvents.splice(index, 1);
            }
        }
        // if (deleted) console.log(`trackClearTimeout: Removed timer ${timerId}, Total: ${activeSynthTimers.size}`); // Optional detailed log
    }
}
/**
 * Counts and logs the number of specific Web Audio nodes, active timers,
 * and AudioContext properties.
 */
function logNodeCounts() {
    const counts = {
        // Sources
        AudioBufferSourceNode: 0,
        OscillatorNode: 0,
        AudioWorkletNode: 0,
        // Processing/Effects
        GainNode: 0,
        BiquadFilterNode: 0, // <<< ADDED
        DelayNode: 0,        // <<< ADDED
        ConvolverNode: 0,    // <<< ADDED
        DynamicsCompressorNode: 0, // <<< ADDED
        WaveShaperNode: 0,   // <<< ADDED
        // Other potential nodes...
    };

    try {
        // --- Count Nodes in voicePool ---
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (!voice || voice.state === 'inactive') return; // Skip inactive voices

            // Helper to count a node (remains the same)
            const countNode = (node) => {
                if (!node) return;
                const constructorName = node.constructor.name;
                if (counts.hasOwnProperty(constructorName)) {
                    counts[constructorName]++;
                } else {
                    // Log unexpected node types
                    // console.log(`Found unexpected node type: ${constructorName}`);
                }
            };

            // Sampler Nodes
            if (voice.samplerNote) {
                countNode(voice.samplerNote.source);
                countNode(voice.samplerNote.gainNode);
                countNode(voice.samplerNote.sampleNode);
                // Add any filter/effect nodes specific to sampler notes if they exist
            }

            // Osc1 Nodes
            if (voice.osc1Note) {
                countNode(voice.osc1Note.workletNode);
                countNode(voice.osc1Note.levelNode);
                countNode(voice.osc1Note.gainNode);
                // Osc1 FM Nodes
                countNode(voice.osc1Note.fmModulatorSource); // Could be BufferSource or Oscillator
                countNode(voice.osc1Note.fmDepthGain);
            }

            // Osc2 Nodes
            if (voice.osc2Note) {
                countNode(voice.osc2Note.workletNode);
                countNode(voice.osc2Note.levelNode);
                countNode(voice.osc2Note.gainNode);
                // Osc2 FM Nodes
                countNode(voice.osc2Note.fmModulatorSource); // Could be BufferSource or Oscillator
                countNode(voice.osc2Note.fmDepthGain);
            }
        });

        // --- Log Counts and Context Info ---
        console.groupCollapsed(`--- Synth Monitor (${new Date().toLocaleTimeString()}) ---`); // Use group for better readability
        console.log(`AudioContext State: ${audioCtx?.state}, Current Time: ${audioCtx?.currentTime.toFixed(3)}`);
        console.log(`Base Latency: ${(audioCtx?.baseLatency * 1000).toFixed(1)}ms, Output Latency: ${(audioCtx?.outputLatency * 1000).toFixed(1)}ms`);
        const activeVoiceCount = voicePool.filter(v => v.state !== 'inactive').length;
        console.log(`Active Voices (Pool): ${activeVoiceCount}`); // <<< LOG ACTIVE VOICE COUNT
        console.log(`Tracked Timers: ${activeSynthTimers.size}`); // <<< LOG TIMER COUNT
        console.table(counts);
        console.groupEnd();


        // --- Optional Warnings (Adjust thresholds as needed) ---
        const gainThreshold = MAX_POLYPHONY * 8 + 20; // Increased threshold slightly
        const sourceThreshold = MAX_POLYPHONY * 4 + 10; // Increased threshold slightly
        const timerThreshold = MAX_POLYPHONY * 3 + 50; // Threshold for timers

        if (counts.GainNode > gainThreshold) {
            console.warn(`High GainNode count: ${counts.GainNode}`);
        }
        if (counts.AudioBufferSourceNode > sourceThreshold) {
             console.warn(`High AudioBufferSourceNode count: ${counts.AudioBufferSourceNode}`);
        }
         if (counts.AudioWorkletNode > MAX_POLYPHONY * 2 + 5) {
             console.warn(`High AudioWorkletNode count: ${counts.AudioWorkletNode}`);
         }
         if (activeSynthTimers.size > timerThreshold) { // <<< WARNING FOR TIMERS
             console.warn(`High active timer count: ${activeSynthTimers.size}`);
         }
         // Add warnings for other node types if necessary

    } catch (error) {
        console.error("Error during node/timer counting:", error);
        if (console.groupCollapsed) console.groupEnd(); // Ensure group is closed on error
    }
}

/**
 * Starts the periodic node monitoring.
 * @param {number} intervalMs - The interval in milliseconds (e.g., 5000 for 5 seconds).
 */
function startNodeMonitoring(intervalMs = 5000) {
    if (nodeMonitorInterval) {
        clearInterval(nodeMonitorInterval); // Clear existing interval if any
    }
    console.log(`Starting node monitoring every ${intervalMs}ms.`);
    logNodeCounts(); // Log immediately on start
    nodeMonitorInterval = setInterval(logNodeCounts, intervalMs);
}

/**
 * Stops the periodic node monitoring.
 */
function stopNodeMonitoring() {
    if (nodeMonitorInterval) {
        clearInterval(nodeMonitorInterval);
        nodeMonitorInterval = null;
        console.log("Stopped node monitoring.");
    }
}
/**
 * Updates or creates the FM modulator source and gain for an existing Osc1 note.
 * Handles both 'sampler' and 'osc2' as FM sources.
 * @param {object} osc1Note - The oscillator note object containing fmModulatorSource and fmDepthGain.
 * @param {number} now - The current audio context time.
 * @param {object} [voice] - Optional: The parent voice object containing both osc1Note and osc2Note. Needed for 'osc2' source.
 */
function updateOsc1FmModulatorParameters(osc1Note, now, voice = null) {
    // <<< Add Log >>>
    // console.log(`updateOsc1FmModulatorParameters ENTER: noteId=${osc1Note?.id}, global osc1FMSource=${osc1FMSource}, voice provided: ${!!voice}, voice.osc2Note exists: ${!!voice?.osc2Note}`);

    // --- Prerequisites Check ---
    const freqParam = osc1Note?.workletNode?.parameters.get('frequency');
    const prerequisitesMet = osc1Note &&
                              osc1Note.workletNode &&
                              freqParam &&
                              osc1FMAmount > 0.001; // Check global FM amount

    // --- Cleanup Existing FM if Prerequisites NOT Met ---
    if (!prerequisitesMet) {
        const reason = !osc1Note ? "no osc1Note" :
                       !osc1Note.workletNode ? "no workletNode" :
                       !freqParam ? "no frequency parameter" :
                       osc1FMAmount <= 0.001 ? "FM amount is zero" : "unknown";

        // Only log if trying to disable an existing modulator
        if (osc1Note?.fmModulatorSource || osc1Note?.fmDepthGain) {
             console.log(`updateOsc1FmModulatorParameters [${osc1Note?.id}]: Prerequisites not met (${reason}). Stopping/disconnecting any existing FM.`);
        }

        // Stop and disconnect old source if it exists
        if (osc1Note?.fmModulatorSource) {
            try {
                osc1Note.fmModulatorSource.stop(0);
            } catch(e) { /* Ignore if already stopped */ }
            try {
                osc1Note.fmModulatorSource.disconnect();
            } catch(e) { /* Ignore if already disconnected */ }
            osc1Note.fmModulatorSource = null;
        }
        // Disconnect and nullify depth gain if it exists
        if (osc1Note?.fmDepthGain) {
            try {
                // Disconnect from frequency parameter first
                if (freqParam) osc1Note.fmDepthGain.disconnect(freqParam);
                osc1Note.fmDepthGain.disconnect(); // Disconnect from any other connections
            } catch(e) { /* Ignore if already disconnected */ }
            console.log(`updateOsc1FmModulatorParameters [${osc1Note?.id}]: Nullifying fmDepthGain due to unmet prerequisites (${reason}).`);
            osc1Note.fmDepthGain = null; // <<< Ensure nullified
        }
        return; // Exit if prerequisites aren't met
    }
    // --- End Prerequisites Check / Cleanup ---


    const noteId = osc1Note.id;
    const noteNumber = osc1Note.noteNumber;
    console.log(`updateOsc1FmModulatorParameters [${noteId}]: Updating FM modulator (Source: ${osc1FMSource}, Amount: ${osc1FMAmount.toFixed(3)}).`);

    // --- Stop and disconnect old source ---
    if (osc1Note.fmModulatorSource) {
        try {
            osc1Note.fmModulatorSource.stop(0);
            console.log(`updateOsc1FmModulatorParameters [${noteId}]: Stopped old FM source.`);
        } catch(e) { /* Ignore errors */ }
        try {
            osc1Note.fmModulatorSource.disconnect();
            console.log(`updateOsc1FmModulatorParameters [${noteId}]: Disconnected old FM source.`);
        } catch(e) { /* Ignore errors */ }
        osc1Note.fmModulatorSource = null;
    }

    // --- Disconnect old depth gain (but don't nullify yet, reuse if possible) ---
    if (osc1Note.fmDepthGain) {
        try {
            // freqParam is guaranteed to exist here due to prerequisite check
            osc1Note.fmDepthGain.disconnect(freqParam); // Disconnect from frequency param
            osc1Note.fmDepthGain.disconnect(); // Disconnect from others (like the old source)
            console.log(`updateOsc1FmModulatorParameters [${noteId}]: Disconnected old FM depth gain connections.`);
        } catch(e) { /* Ignore errors */ }
    }

    // --- Create/Configure Nodes ---
    try {
        // --- Create fmDepthGain if it doesn't exist ---
        if (!osc1Note.fmDepthGain) {
            osc1Note.fmDepthGain = audioCtx.createGain();
            console.log(`updateOsc1FmModulatorParameters [${noteId}]: Created NEW FM depth gain.`);
        } else {
             console.log(`updateOsc1FmModulatorParameters [${noteId}]: Reusing existing FM depth gain.`);
        }
        // Set initial gain value
        const scaledDepth = osc1FMAmount * osc1FMDepthScale;
        osc1Note.fmDepthGain.gain.cancelScheduledValues(now); // Cancel ramps before setting
        osc1Note.fmDepthGain.gain.setTargetAtTime(scaledDepth, now, STANDARD_FADE_TIME / 3); // Use fraction of standard time
        let newFmSource = null; // <<< Initialize newFmSource >>>
        // --- Create Modulator Based on Source ---
        if (osc1FMSource === 'sampler') {
            // <<< Check sampler-specific prerequisites >>>
            if (!audioBuffer) {
                 console.error(`updateOsc1FmModulatorParameters [${noteId}]: Sampler FM selected, but no audioBuffer loaded. Skipping FM connection.`);
                 // <<< Cleanup gain node if created/reused >>>
                 if (osc1Note.fmDepthGain) {
                     try { osc1Note.fmDepthGain.disconnect(); } catch(e) {}
                     osc1Note.fmDepthGain = null;
                 }
                 return; // Don't proceed
            }

            newFmSource = audioCtx.createBufferSource();

            // --- Mirror Buffer Selection ---
            let useOriginalBuffer = true;
            let sourceBuffer = audioBuffer;
            let bufferType = "original_fm";
            if (isSampleLoopOn && sampleCrossfadeAmount > 0.01 && cachedCrossfadedBuffer) {
                sourceBuffer = cachedCrossfadedBuffer; useOriginalBuffer = false; bufferType = "crossfaded_fm";
            } else if (fadedBuffer && (!isSampleLoopOn || sampleCrossfadeAmount <= 0.01)) {
                sourceBuffer = fadedBuffer; useOriginalBuffer = false; bufferType = "faded_fm";
            }
            if (!sourceBuffer || !(sourceBuffer instanceof AudioBuffer)) {
                 console.error(`updateOsc1FmModulatorParameters [${noteId}]: Invalid sourceBuffer selected (type: ${bufferType}). Skipping FM connection.`);
                 // <<< Cleanup gain node >>>
                 if (osc1Note.fmDepthGain) { try { osc1Note.fmDepthGain.disconnect(); } catch(e) {} osc1Note.fmDepthGain = null; }
                 return;
            }
            newFmSource.buffer = sourceBuffer;
            console.log(`updateOsc1FmModulatorParameters [${noteId}]: Using ${bufferType} buffer for FM.`);

            // --- Mirror Pitch/Rate ---
            let calculatedRate = 1.0;
            if (isSampleKeyTrackingOn) {
                calculatedRate = TR2 ** (noteNumber - 12);
                newFmSource.playbackRate.value = calculatedRate;
                newFmSource.detune.setValueAtTime(currentSampleDetune, now);
            } else {
                newFmSource.playbackRate.value = 1.0;
                newFmSource.detune.value = currentSampleDetune;
            }

            // --- Mirror Loop Settings ---
            let loopStartTime = 0;
            let loopEndTime = sourceBuffer.duration;
            if (useOriginalBuffer) {
                if (isSampleLoopOn) {
                    newFmSource.loop = true;
                    loopStartTime = sampleStartPosition * audioBuffer.duration;
                    loopEndTime = sampleEndPosition * audioBuffer.duration;
                    newFmSource.loopStart = Math.max(0, loopStartTime);
                    newFmSource.loopEnd = Math.min(audioBuffer.duration, loopEndTime);
                     if (newFmSource.loopEnd <= newFmSource.loopStart) {
                         newFmSource.loopEnd = audioBuffer.duration; newFmSource.loopStart = 0;
                     }
                } else { newFmSource.loop = false; }
            } else {
                newFmSource.loop = isSampleLoopOn;
            }
            console.log(`updateOsc1FmModulatorParameters [${noteId}]: Loop=${newFmSource.loop}, Start=${newFmSource.loopStart.toFixed(3)}, End=${newFmSource.loopEnd.toFixed(3)}`);

        } else if (osc1FMSource === 'osc2') {
            // <<< ADD OSC2 SOURCE LOGIC >>>
            console.log(`updateOsc1FmModulatorParameters [${noteId}]: Creating OscillatorNode modulator based on Osc2.`);
            const osc2Note = voice?.osc2Note;

            if (osc2Note && osc2Note.workletNode) {
                newFmSource = audioCtx.createOscillator();
                newFmSource.type = osc2Waveform === 'pulse' ? 'square' : osc2Waveform;
                const baseOsc2Freq = noteToFrequency(noteNumber, osc2OctaveOffset);
                newFmSource.frequency.setValueAtTime(baseOsc2Freq, now);
                newFmSource.detune.setValueAtTime(osc2Detune, now);

                try {
                    const currentFreqParam = osc2Note.workletNode.parameters.get('frequency');
                    const currentDetuneParam = osc2Note.workletNode.parameters.get('detune');
                    if (currentFreqParam) {
                        newFmSource.frequency.setValueAtTime(currentFreqParam.value, now);
                        // console.log(`updateOsc1FmModulatorParameters [${noteId}]: Set FM Osc freq from active osc2Note: ${currentFreqParam.value.toFixed(2)}`);
                    }
                    if (currentDetuneParam) {
                        newFmSource.detune.setValueAtTime(currentDetuneParam.value, now);
                         // console.log(`updateOsc1FmModulatorParameters [${noteId}]: Set FM Osc detune from active osc2Note: ${currentDetuneParam.value.toFixed(2)}`);
                    }
                    console.log(`updateOsc1FmModulatorParameters [${noteId}]: Using basic OscillatorNode (${newFmSource.type}) mirroring active Osc2 note parameters.`);
                } catch(e) {
                    console.warn(`updateOsc1FmModulatorParameters [${noteId}]: Error getting current Osc2 params, using globals. Error: ${e}`);
                    console.log(`updateOsc1FmModulatorParameters [${noteId}]: Using basic OscillatorNode (${newFmSource.type}) mirroring global Osc2 settings (error reading active note).`);
                }

            } else {
                console.log(`updateOsc1FmModulatorParameters [${noteId}]: No active Osc2 note/worklet found. Creating basic OscillatorNode mirroring global Osc2 settings.`);
                newFmSource = audioCtx.createOscillator();
                newFmSource.type = osc2Waveform === 'pulse' ? 'square' : osc2Waveform;
                const osc2Freq = noteToFrequency(noteNumber, osc2OctaveOffset);
                newFmSource.frequency.setValueAtTime(osc2Freq, now);
                newFmSource.detune.setValueAtTime(osc2Detune, now);
            }
            // <<< END OSC2 SOURCE LOGIC >>>
        }

       // --- Connect and Start ---
       // Prerequisites (freqParam, fmDepthGain) are guaranteed here unless buffer/osc2 was invalid
       if (newFmSource && osc1Note.fmDepthGain && freqParam) {
    newFmSource.connect(osc1Note.fmDepthGain);
    osc1Note.fmDepthGain.connect(freqParam);
    // Start at precise time to avoid clicks
    const startTime = now + (STANDARD_FADE_TIME / 10); // Small offset for clean start
    newFmSource.start(startTime);
    osc1Note.fmModulatorSource = newFmSource;
    console.log(`FM modulator source started and connected at ${startTime.toFixed(5)}`);
} else {
            console.warn(`updateOsc1FmModulatorParameters [${noteId}]: Failed to create or connect new FM source (${osc1FMSource}). FM will be inactive.`);
            // Ensure gain node is cleaned up if source creation/connection failed
            if (osc1Note.fmDepthGain) {
                try { osc1Note.fmDepthGain.disconnect(); } catch(e) {}
                osc1Note.fmDepthGain = null; // <<< Nullify gain node >>>
            }
       }

    } catch (error) {
        console.error(`updateOsc1FmModulatorParameters [${noteId}]: Error creating/starting new FM source:`, error);
        // Nullify references on error
        if (osc1Note.fmModulatorSource) { try { osc1Note.fmModulatorSource.disconnect(); } catch(e){} }
        osc1Note.fmModulatorSource = null;
        if (osc1Note.fmDepthGain) {
             try { osc1Note.fmDepthGain.disconnect(); } catch(e){}
             console.log(`updateOsc1FmModulatorParameters [${noteId}]: Nullifying fmDepthGain due to error during creation/start.`);
             osc1Note.fmDepthGain = null; // <<< Ensure nullified on error
        }
    }
}

function noteToFrequency(noteNumber, octaveOffset = 0, detuneCents = 0) {
    const baseNote = 69; // MIDI note number for A4
    const baseFreq = 440;
    // Adjust noteNumber based on your keyboard mapping if needed (e.g., if 0 isn't C1)
    // Assuming noteNumber 0 from keyboard.js corresponds to MIDI note 36 (C1)
    const midiNoteNumber = noteNumber + 36 + (octaveOffset * 12);
    const frequency = baseFreq * Math.pow(2, (midiNoteNumber - baseNote) / 12);
    // Apply detune if necessary (though OscillatorNode has built-in detune)
    // return frequency * Math.pow(2, detuneCents / 1200);
    return frequency;
}


// Initialize for all mobile devices to be safe
if (/iPhone|iPad|iPod|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
// Use DOMContentLoaded for more reliable initialization
document.addEventListener('DOMContentLoaded', () => {
createiOSStartupOverlay(audioCtx);
});
}
// Add this function at the beginning of your script
function createIOSChromeAudioUnlocker() {
// Create a special overlay for Chrome on iOS
const overlay = document.createElement('div');
overlay.innerHTML = `
<div style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; 
 background: rgba(245, 245, 220, 0.95); z-index: 99999; display: flex; 
 flex-direction: column; justify-content: center; align-items: center; text-align: center;">
<h2 style="color: #8b4513;">THULE Sampler</h2>
<p style="margin: 20px 0;">Tap the button below to enable audio</p>
<button id="ios-chrome-audio-unlock" style="padding: 16px 32px; font-size: 18px; 
      background: #e6e6e6; border: 1px solid #35100B; border-radius: 8px; 
      color: #35100B; cursor: pointer;">START SYNTHESIZER</button>
</div>
`;

document.body.appendChild(overlay);

// Create a hidden HTML5 audio element (crucial for Chrome on iOS)
const audioElement = document.createElement('audio');
audioElement.setAttribute('src', 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABIgD///////////////////////////////////////////8AAAA8TEFNRTMuMTAwAQAAAAAAAAAAABUgJAMGQQABmgAAIicg4EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//sQZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=');
audioElement.setAttribute('playsinline', '');
audioElement.setAttribute('preload', 'auto');
audioElement.setAttribute('loop', 'loop');
audioElement.style.display = 'none';
document.body.appendChild(audioElement);

// Function to unlock audio with special handling for Chrome on iOS
async function unlockAudioForChromeIOS() { // <<< Make async
    console.log("Attempting to unlock audio for Chrome on iOS");

    // 1. First, try to play the HTML5 audio element
    const playPromise = audioElement.play();

    if (playPromise !== undefined) {
        try {
            await playPromise; // Wait for playback attempt
            console.log("Audio element playback successful");

            // 2. After successful audio element play, resume AudioContext
            if (audioCtx.state === 'suspended') {
                await audioCtx.resume(); // Wait for resume
                console.log("AudioContext resumed");
            }

            // 3. START TONE.JS <<< ADD THIS
            await Tone.start();
            console.log("Tone.js started successfully.");
            // --- END ADD ---

// 3. Create a silent oscillator (important for iOS Chrome)
try {
  const oscillator = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  gain.gain.value = 0.001;
  oscillator.connect(gain);
  gain.connect(audioCtx.destination);
  oscillator.start(0);
  oscillator.stop(audioCtx.currentTime + 0.5);
  console.log("Created silent oscillator");
} catch(e) {
  console.error("Failed to create oscillator:", e);
}

// Remove the overlay
setTimeout(() => {
  document.body.removeChild(overlay);
}, 100);

} catch (err) {
    console.error("Audio unlock/start failed:", err);
    // Show a more direct error message to the user
    alert("Audio couldn't be enabled. Please reload and try again, making sure to tap directly on the button.");
}
} else {
 console.warn("Audio element playPromise was undefined.");
 // Attempt to resume context and start Tone anyway as a fallback
 try {
     if (audioCtx.state === 'suspended') {
         await audioCtx.resume();
         console.log("AudioContext resumed (fallback)");
     }
     await Tone.start();
     console.log("Tone.js started successfully (fallback).");
     // Remove overlay on fallback success too
     setTimeout(() => {
         if (overlay.parentNode) {
              document.body.removeChild(overlay);
         }
     }, 100);
 } catch (fallbackErr) {
      console.error("Fallback audio unlock/start failed:", fallbackErr);
      alert("Audio couldn't be enabled (fallback failed). Please reload and try again.");
 }
}
}

// Add event listener directly to the button
document.getElementById('ios-chrome-audio-unlock').addEventListener('click', unlockAudioForChromeIOS);
document.getElementById('ios-chrome-audio-unlock').addEventListener('touchend', unlockAudioForChromeIOS);
}
// Function to detect Chrome on iOS specifically
function isChromeOnIOS() {
const userAgent = navigator.userAgent;
return /iPad|iPhone|iPod/.test(userAgent) && /CriOS/.test(userAgent);
}

// Show the special Chrome iOS unlocker only when needed
document.addEventListener('DOMContentLoaded', function() {
if (isChromeOnIOS()) {
console.log("Detected Chrome on iOS - showing special audio unlock UI");
createIOSChromeAudioUnlocker();
} else if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
// Use your original iOS unlocker for Safari
createiOSStartupOverlay(audioCtx);
}
});
// Detect if the device is a touch device
function isTouchDevice() {
return ('ontouchstart' in window) || 
 (navigator.maxTouchPoints > 0) || 
 (navigator.msMaxTouchPoints > 0);
}

/**
 * Clears any scheduled timeouts associated with a note object.
 * @param {object} note - The note object (samplerNote or osc1Note).
 */
function clearScheduledEventsForNote(note) {
    if (note && Array.isArray(note.scheduledEvents)) {
        // Iterate backwards to safely remove elements while iterating
        for (let i = note.scheduledEvents.length - 1; i >= 0; i--) {
            const event = note.scheduledEvents[i];
            if (event.type === "timeout" && event.id) {
                // Use trackClearTimeout WITHOUT passing the note again to avoid infinite recursion
                trackClearTimeout(event.id);
                // No need to splice here, trackClearTimeout handles removal if note was passed initially
            }
            // Add handling for other event types if needed (e.g., Tone.js events)
            // else if (event.type === "toneDispose") { ... }
        }
        note.scheduledEvents = []; // Clear the array after processing
    }
     // Also clear the legacy killTimerId if it exists
     if (note && note.killTimerId) {
         // Use trackClearTimeout WITHOUT passing the note again
         trackClearTimeout(note.killTimerId);
         note.killTimerId = null;
     }
}


function reverseBufferIfNeeded(triggerFMUpdate = true) {
    if (!originalBuffer) return;

if (isSampleReversed) {
// Create reversed version of the buffer
const reversedBuffer = audioCtx.createBuffer(
originalBuffer.numberOfChannels,
originalBuffer.length,
originalBuffer.sampleRate
);

// Copy and reverse each channel
for (let channel = 0; channel < originalBuffer.numberOfChannels; channel++) {
const originalData = originalBuffer.getChannelData(channel);
const reversedData = reversedBuffer.getChannelData(channel);

for (let i = 0; i < originalBuffer.length; i++) {
reversedData[i] = originalData[originalBuffer.length - 1 - i];
}
}

// Use the reversed buffer for processing
audioBuffer = reversedBuffer;
} else {
// Use the original buffer
audioBuffer = originalBuffer.slice();
// <<< UPDATE/RESTART Sampler FM Node (conditionally) >>>
if (triggerFMUpdate) {
    startSamplerFMNode(); // Restart with the potentially reversed buffer
}
// <<< END UPDATE >>>
}
}
if (!AudioBuffer.prototype.slice) {
AudioBuffer.prototype.slice = function() {
const newBuffer = audioCtx.createBuffer(
this.numberOfChannels,
this.length,
this.sampleRate
);

for (let channel = 0; channel < this.numberOfChannels; channel++) {
const originalData = this.getChannelData(channel);
const newData = newBuffer.getChannelData(channel);

for (let i = 0; i < this.length; i++) {
newData[i] = originalData[i];
}
}

return newBuffer;
};
}
/**
 * Handles the recorded buffer after mic recording stops.
 * Updates global state, UI, and active notes.
 * @param {AudioBuffer} recordedBuffer - The buffer containing the recorded audio.
 */
function handleRecordingComplete(recordedBuffer) {
    if (!recordedBuffer) {
        console.error("handleRecordingComplete received null buffer.");
        return;
    }
    console.log("Handling completed recording in main.js");

    // 2) Update global audioBuffer
    audioBuffer = recordedBuffer;
    originalBuffer = recordedBuffer.slice(); // Store the original buffer

    // Apply reverse if needed
    if (isSampleReversed) {
        reverseBufferIfNeeded(false); // Reverse if needed, don't trigger FM update yet
    }
    
    // Process the buffer and wait for processing to complete
    console.log("Processing recorded buffer...");
    updateSampleProcessing();
    
    // Use a timeout to ensure processing has time to complete
    setTimeout(() => {
        console.log("Updating all active sampler notes with new recorded buffer");
        
        // Force update ALL sampler notes, even held ones
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.samplerNote) {
                console.log(`Forced update of sampler note ${voice.samplerNote.id} to use new recording`);
                updateSamplePlaybackParameters(voice.samplerNote);
            }
        });
        
        // Update the source for UI preview
        if (sampleSource) {
            try { sampleSource.stop(); } catch(e) {}
            sampleSource = audioCtx.createBufferSource();
            sampleSource.buffer = audioBuffer;
            sampleSource.connect(sampleGainNode);
            sampleSource.start();
        }
        
        // Update display
        const fileLabel = document.querySelector('label[for="audio-file"]');
        if (fileLabel) {
            fileLabel.textContent = 'Recording (mic)';
        }
    }, 200); // Give enough time for updateSampleProcessing to do its work
}
function preventScrollOnControls() {
// More targeted approach - add touch event handlers to each UI control type individually



// 2. Fix sliders
document.querySelectorAll('input[type="range"]').forEach(slider => {
slider.addEventListener('touchstart', function(e) {
// Don't prevent default on sliders to allow native handling
}, { passive: false });
});





// 5. Fix special buttons (emu mode and rec button)
document.querySelectorAll('.lofi-button, .rec-button').forEach(button => {
button.addEventListener('touchstart', function(e) {
e.preventDefault();
// Simulate a click
button.click();
}, { passive: false });
});


}



// Knob initializations (only one set)
const knobInitializations = {
    'master-volume-knob': (value) => {
        const tooltip = createTooltipForKnob('master-volume-knob', value);
        tooltip.textContent = `Volume: ${(value * 100).toFixed(0)}%`;
        tooltip.style.opacity = '1';
        masterGain.gain.setTargetAtTime(value, audioCtx.currentTime, 0.01);
        console.log('Master Volume:', value.toFixed(2));
    },
    'sample-volume-knob': (value) => {
    const tooltip = createTooltipForKnob('sample-volume-knob', value);
    tooltip.textContent = `Volume: ${(value * 100).toFixed(0)}%`;
    tooltip.style.opacity = '1';
    
    // Update global value
    currentSampleGain = value;
    
    // CRITICAL FIX: Update samplerVoicePool, not voicePool
    const now = audioCtx.currentTime;
    samplerVoicePool.forEach(voice => {
        if (voice.state !== 'inactive' && voice.samplerNote && voice.samplerNote.sampleNode) {
            voice.samplerNote.sampleNode.gain.cancelScheduledValues(now);
            voice.samplerNote.sampleNode.gain.setValueAtTime(currentSampleGain, now);
            console.log(`Real-time volume update for sampler voice ${voice.id}: ${value.toFixed(2)}`);
        }
    });
    
    console.log('Sample Gain:', value.toFixed(2));
},

'sample-pitch-knob': (value) => {
    // Convert 0-1 range to -1200 to +1200 cents
    currentSampleDetune = (value * 2400) - 1200;
    const now = audioCtx.currentTime;

    // Show and update tooltip
    const tooltip = createTooltipForKnob('sample-pitch-knob', value);
    tooltip.textContent = `${currentSampleDetune.toFixed(0)} cents`;
    tooltip.style.opacity = '1';

    // CRITICAL FIX: Update samplerVoicePool, not voicePool
    samplerVoicePool.forEach(voice => {
        if (voice.state !== 'inactive' && voice.samplerNote && voice.samplerNote.source) {
            voice.samplerNote.source.detune.cancelScheduledValues(now);
            voice.samplerNote.source.detune.setValueAtTime(currentSampleDetune, now);
            console.log(`Real-time pitch update for sampler voice ${voice.id}: ${currentSampleDetune.toFixed(0)} cents`);
        }
    });

    // Also update FM modulators that use sampler in the voicePool
    voicePool.forEach(voice => {
        if (voice.state !== 'inactive') {
            // Update Osc1 FM if using sampler
            if (osc1FMSource === 'sampler' && voice.osc1Note && voice.osc1Note.fmModulatorSource instanceof AudioBufferSourceNode) {
                voice.osc1Note.fmModulatorSource.detune.setValueAtTime(currentSampleDetune, now);
            }
            // Update Osc2 FM if using sampler
            if (osc2FMSource === 'sampler' && voice.osc2Note && voice.osc2Note.fmModulatorSource instanceof AudioBufferSourceNode) {
                voice.osc2Note.fmModulatorSource.detune.setValueAtTime(currentSampleDetune, now);
            }
        }
    });

    console.log('Sample Pitch:', currentSampleDetune.toFixed(0) + ' cents');
},
    'osc1-gain-knob': (value) => {
        const tooltip = createTooltipForKnob('osc1-gain-knob', value);
        tooltip.textContent = `Gain: ${(value * 100).toFixed(0)}%`;
        tooltip.style.opacity = '1';
        osc1GainValue = value; // Update the global gain value

        // --- REAL-TIME UPDATE FOR ACTIVE NOTES (Control levelNode) ---
        const now = audioCtx.currentTime;
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            // Check if the voice is active and the specific osc1 levelNode exist
            if (voice.state !== 'inactive' && voice.osc1Note && voice.osc1Note.levelNode) {
                const levelNode = voice.osc1Note.levelNode;
                levelNode.gain.setTargetAtTime(osc1GainValue, now, 0.015);
            }
        });
        // <<< END CHANGE >>>
        // --- END REAL-TIME UPDATE ---

        console.log('Osc1 Gain:', value.toFixed(2));
    },
    'osc1-pitch-knob': (value) => {
        // Calculate detune value (e.g., -100 to +100 cents)
        osc1Detune = (value - 0.5) * 200; // Example mapping

        const tooltip = createTooltipForKnob('osc1-pitch-knob', value);
        tooltip.textContent = `Detune: ${osc1Detune.toFixed(0)}c`;
        tooltip.style.opacity = '1';

        const now = audioCtx.currentTime;
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.osc1Note && voice.osc1Note.workletNode) {
                const oscDetuneParam = voice.osc1Note.workletNode.parameters.get('detune');
                if (oscDetuneParam) {
                    oscDetuneParam.setTargetAtTime(osc1Detune, now, 0.01);
                }
                // <<< ADD: Update Osc1 FM source if it's Osc2 >>>
                if (osc2FMSource === 'osc1' && voice.osc2Note && voice.osc2Note.fmModulatorSource instanceof OscillatorNode) {
                    voice.osc2Note.fmModulatorSource.detune.setTargetAtTime(osc1Detune, now, 0.01);
                }
            }
        });
        // <<< END CHANGE >>>
        console.log('Osc1 Detune:', osc1Detune.toFixed(2));
    },
    'osc1-fm-knob': (value) => {
        // Apply exponential curve
        const curvedValue = value * value;
        const prevFMAmount = osc1FMAmount; // Store previous amount
        osc1FMAmount = curvedValue; // Update global curved value

        // Calculate scaled depth (Hz)
        const scaledDepth = osc1FMAmount * osc1FMDepthScale;
        const now = audioCtx.currentTime;
        const isNowOn = osc1FMAmount > 0.001;
        const wasPreviouslyOff = prevFMAmount <= 0.001;

        // Update tooltip
        const tooltip = createTooltipForKnob('osc1-fm-knob', value);
        tooltip.textContent = `FM: ${(scaledDepth).toFixed(0)}Hz`;
        tooltip.style.opacity = '1';

        // --- UPDATE Per-Voice ---
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.osc1Note) {
                // Check if the fmDepthGain node exists for this voice.
                if (voice.osc1Note.fmDepthGain) {
                    // <<< Node exists: Just update gain smoothly >>>
                    const timeConstant = 0.020; // 20ms time constant
                    voice.osc1Note.fmDepthGain.gain.setTargetAtTime(scaledDepth, now, timeConstant);
                } else if (isNowOn) {
                    // <<< Node MISSING, but FM should be ON now >>>
                    // This happens if the note started while FM knob was at 0.
                    // Call updateOsc1FmModulatorParameters to create/connect nodes.
                    console.log(`osc1-fm-knob: FM turned on for note ${voice.osc1Note.id}. Initializing FM nodes.`);
                    updateOsc1FmModulatorParameters(voice.osc1Note, now, voice);
                    // updateOsc1FmModulatorParameters sets the initial gain,
                    // so no need to setTargetAtTime immediately after.
                }
                // <<< If !isNowOn and node missing, do nothing (FM is off) >>>
                // <<< If !isNowOn and node exists, the gain ramp above will handle turning it down >>>
            }
        });
        // <<< END CHANGE >>>
        // --- END UPDATE ---

        // Log values
        console.log(`Osc1 FM Knob Raw: ${value.toFixed(3)}, Curved: ${osc1FMAmount.toFixed(3)}, Depth: ${scaledDepth.toFixed(1)} Hz`);
    },
    'sample-start-knob': (value) => {
        const minLoopFractionRequired = 0.001; // Minimum gap always required
        const minLoopFractionForCrossfade = 0.01; // Minimum 1% loop length if crossfading

        // Determine the effective minimum gap based on loop state
        const effectiveMinGap = isSampleLoopOn
            ? Math.max(minLoopFractionRequired, minLoopFractionForCrossfade)
            : minLoopFractionRequired;

        // Calculate the maximum allowed start position
        const maxAllowedStart = sampleEndPosition - effectiveMinGap;

        // Clamp the incoming value
        let newStartPosition = Math.min(value, maxAllowedStart);
        newStartPosition = Math.max(0, newStartPosition); // Ensure not less than 0

        // Only update if the value actually changed
        if (newStartPosition !== sampleStartPosition) {
            sampleStartPosition = newStartPosition;

            // Update processing immediately (this handles trimming/fading AND schedules crossfade creation if needed)
            updateSampleProcessing();

            const tooltip = createTooltipForKnob('sample-start-knob', value); // Use original value for tooltip positioning
            tooltip.textContent = `Start: ${(sampleStartPosition * 100).toFixed(0)}%`;
            tooltip.style.opacity = '1';
            console.log('Sample Start:', (sampleStartPosition * 100).toFixed(0) + '%');

            // Debounce note updates
            if (startUpdateTimer) { trackClearTimeout(startUpdateTimer); } // <<< Use trackClearTimeout
            startUpdateTimer = trackSetTimeout(() => {
                // updateSampleProcessing should have finished or scheduled buffer creation by now.
                // updateSamplePlaybackParameters will pick the correct buffer.
                console.log("Start knob settled - updating active notes.");
                // <<< CHANGE: Iterate over voicePool >>>
                voicePool.forEach(voice => {
                    if (voice.state !== 'inactive' && voice.samplerNote && !heldNotes.includes(voice.noteNumber)) {
                        console.log(`Updating sampler note ${voice.samplerNote.id} after start change.`);
                        updateSamplePlaybackParameters(voice.samplerNote);
                    } else if (voice.state !== 'inactive' && voice.samplerNote && heldNotes.includes(voice.noteNumber)) {
                        console.log(`Skipping update for held sampler note ${voice.samplerNote.id} after start change.`);
                    }
                });
                // <<< END CHANGE >>>
                startUpdateTimer = null;
            }, 150); // Delay to allow updateSampleProcessing's timeouts to potentially finish
        } else {
             // If the clamped value is the same as the current, still show tooltip briefly
             const tooltip = createTooltipForKnob('sample-start-knob', value);
             tooltip.textContent = `Start: ${(sampleStartPosition * 100).toFixed(0)}%`;
             tooltip.style.opacity = '1';
        }
    },
    'sample-end-knob': (value) => {
        const minLoopFractionRequired = 0.001; // Minimum gap always required
        const minLoopFractionForCrossfade = 0.01; // Minimum 1% loop length if crossfading

        // Determine the effective minimum gap based on loop state
        const effectiveMinGap = isSampleLoopOn
            ? Math.max(minLoopFractionRequired, minLoopFractionForCrossfade)
            : minLoopFractionRequired;

        // Calculate the minimum allowed end position
        const minAllowedEnd = sampleStartPosition + effectiveMinGap;

        // Clamp the incoming value
        let newEndPosition = Math.max(value, minAllowedEnd);
        newEndPosition = Math.min(1, newEndPosition); // Ensure not more than 1

        // Only update if the value actually changed
        if (newEndPosition !== sampleEndPosition) {
            sampleEndPosition = newEndPosition;

            // Update processing immediately (this handles trimming/fading)
            updateSampleProcessing();

            const tooltip = createTooltipForKnob('sample-end-knob', value); // Use original value for tooltip positioning
            tooltip.textContent = `End: ${(sampleEndPosition * 100).toFixed(0)}%`;
            tooltip.style.opacity = '1';
            console.log('Sample End:', (sampleEndPosition * 100).toFixed(0) + '%');

            // Debounce crossfade buffer creation and note updates (existing logic)
            if (endUpdateTimer) { trackClearTimeout(endUpdateTimer); } // <<< Use trackClearTimeout
            endUpdateTimer = trackSetTimeout(() => {
                if (audioBuffer) {
                    // Create crossfaded buffer if needed (uses processed/faded buffer)
                    if (isSampleLoopOn && sampleCrossfadeAmount > 0.01) {
                        console.log("Creating new crossfaded buffer after end position settled");
                        const bufferToCrossfade = fadedBuffer || audioBuffer; // Use faded if available
                        const result = createCrossfadedBuffer(
                            audioCtx,
                            bufferToCrossfade,
                            0, // Use entire processed buffer
                            1, // Use entire processed buffer
                            sampleCrossfadeAmount
                        );

                        if (result && result.buffer) {
                            // Apply Emu processing AFTER crossfade if enabled
                            cachedCrossfadedBuffer = isEmuModeOn ? applyEmuProcessing(result.buffer) : result.buffer;
                            lastCachedStartPos = sampleStartPosition; // Store original requested start
                            lastCachedEndPos = sampleEndPosition;     // Store original requested end
                            lastCachedCrossfade = sampleCrossfadeAmount;
                            console.log("Crossfaded buffer updated after end change.");
                        } else {
                            console.warn("Crossfaded buffer creation failed after end change.");
                            cachedCrossfadedBuffer = null; // Invalidate cache on failure
                        }
                    } else {
                        cachedCrossfadedBuffer = null; // Invalidate if crossfade turned off
                    }

                    // Update any active (non-held) sampler notes
                    // <<< CHANGE: Iterate over voicePool >>>
                    voicePool.forEach(voice => {
                         if (voice.state !== 'inactive' && voice.samplerNote && !heldNotes.includes(voice.noteNumber)) {
                            console.log(`Updating sampler note ${voice.samplerNote.id} after end change.`);
                            updateSamplePlaybackParameters(voice.samplerNote);
                        } else if (voice.state !== 'inactive' && voice.samplerNote && heldNotes.includes(voice.noteNumber)) {
                            console.log(`Skipping update for held sampler note ${voice.samplerNote.id} after end change.`);
                        }
                    });
                    // <<< END CHANGE >>>
                }
                endUpdateTimer = null;
            }, 150); // Delay
        } else {
             // If the clamped value is the same as the current, still show tooltip briefly
             const tooltip = createTooltipForKnob('sample-end-knob', value);
             tooltip.textContent = `End: ${(sampleEndPosition * 100).toFixed(0)}%`;
             tooltip.style.opacity = '1';
        }
    },
    'sample-crossfade-knob': (value) => {
        const tooltip = createTooltipForKnob('sample-crossfade-knob', value);
        tooltip.textContent = `Crossfade: ${(value * 100).toFixed(0)}%`;
        tooltip.style.opacity = '1';

        const prevCrossfade = sampleCrossfadeAmount;
        const prevLoopState = isSampleLoopOn;

        sampleCrossfadeAmount = value;
        isSampleLoopOn = value > 0.01; // Loop is ON if crossfade > 1%

        // If enabling crossfade, disable and reset manual fades
        if (isSampleLoopOn && !prevLoopState) {
            console.log("Crossfade enabled, resetting manual fades.");
            sampleFadeInAmount = 0;
            sampleFadeOutAmount = 0;
            const fadeKnob = D('sample-fade-knob');
            if (fadeKnob && fadeKnob.control) { // Check if control object exists
                fadeKnob.control.setValue(0.5); // Reset fade knob UI to center
            }
        }

        // Update sample processing immediately
        updateSampleProcessing();

        // Debounce note updates using the correct timer
        if (crossfadeUpdateTimer) { trackClearTimeout(crossfadeUpdateTimer); } // <<< Use trackClearTimeout
        crossfadeUpdateTimer = trackSetTimeout(() => {
            // updateSampleProcessing should have finished or scheduled buffer creation by now.
            // updateSamplePlaybackParameters will pick the correct buffer.
            console.log("Crossfade knob settled - updating active notes.");
            // <<< CHANGE: Iterate over voicePool >>>
            voicePool.forEach(voice => {
                if (voice.state !== 'inactive' && voice.samplerNote && !heldNotes.includes(voice.noteNumber)) {
                    console.log(`Updating sampler note ${voice.samplerNote.id} after crossfade change.`);
                    updateSamplePlaybackParameters(voice.samplerNote);
                } else if (voice.state !== 'inactive' && voice.samplerNote && heldNotes.includes(voice.noteNumber)) {
                    console.log(`Skipping update for held sampler note ${voice.samplerNote.id} after crossfade change.`);
                }
            });
            // <<< END CHANGE >>>
            crossfadeUpdateTimer = null;
        }, 150); // Delay to allow updateSampleProcessing's timeouts to potentially finish

    }, // End of 'sample-crossfade-knob'

    'sample-fade-knob': (value) => {
        const fadeValue = value * 2 - 1; // Convert 0-1 range to -1 to +1 range
        const tooltip = createTooltipForKnob('sample-fade-knob', value);

        // Disable if crossfade/loop is active
        if (isSampleLoopOn && sampleCrossfadeAmount > 0.01) {
            tooltip.textContent = `Fade (Disabled)`;
            tooltip.style.opacity = '1';
            console.log("Fade knob ignored - crossfade is active");
            // Optionally reset the knob value visually if disabled
            // if (D('sample-fade-knob').control) D('sample-fade-knob').control.setValue(0.5, false);
            return;
        }

        // Update tooltip text based on direction
        if (fadeValue < -0.01) { // Fade Out (left side)
            const fadeOutPercent = Math.abs(fadeValue * 50).toFixed(0); // Map -1..0 to 50%..0%
            tooltip.textContent = `Fade Out: ${fadeOutPercent}%`;
            sampleFadeInAmount = 0;
            sampleFadeOutAmount = Math.abs(fadeValue) / 2; // Map -1..0 to 0.5..0
        } else if (fadeValue > 0.01) { // Fade In (right side)
            const fadeInPercent = (fadeValue * 50).toFixed(0); // Map 0..1 to 0%..50%
            tooltip.textContent = `Fade In: ${fadeInPercent}%`;
            sampleFadeInAmount = fadeValue / 2; // Map 0..1 to 0..0.5
            sampleFadeOutAmount = 0;
        } else { // Center position (no fade)
            tooltip.textContent = `No Fade`;
            sampleFadeInAmount = 0;
            sampleFadeOutAmount = 0;
        }
        tooltip.style.opacity = '1';

        console.log(`Fade control values: fadeIn=${sampleFadeInAmount.toFixed(3)}, fadeOut=${sampleFadeOutAmount.toFixed(3)}`);

        // Process the fade changes immediately (updates fadedBuffer)
        updateSampleProcessing();

        // Debounce note updates (similar to start/end knobs)
        if (fadeProcessTimer) { trackClearTimeout(fadeProcessTimer); } // <<< Use trackClearTimeout
        fadeProcessTimer = trackSetTimeout(() => {
             if (audioBuffer) {
                 // Update any active (non-held) sampler notes
                 // <<< CHANGE: Iterate over voicePool >>>
                 voicePool.forEach(voice => {
                     if (voice.state !== 'inactive' && voice.samplerNote && !heldNotes.includes(voice.noteNumber)) {
                         console.log(`Updating sampler note ${voice.samplerNote.id} after fade change.`);
                         // updateSamplePlaybackParameters will pick up the new fadedBuffer
                         updateSamplePlaybackParameters(voice.samplerNote);
                     } else if (voice.state !== 'inactive' && voice.samplerNote && heldNotes.includes(voice.noteNumber)) {
                         console.log(`Skipping update for held sampler note ${voice.samplerNote.id} after fade change.`);
                     }
                 });
                 // <<< END CHANGE >>>
             }
             fadeProcessTimer = null;
        }, 150); // Delay
    },
    'glide-time-knob': (value) => {
        const tooltip = createTooltipForKnob('glide-time-knob', value);
        const timeMs = value * 2000; // 0 to 2000ms
        tooltip.textContent = `${timeMs.toFixed(0)}ms`;
        tooltip.style.opacity = '1';
        glideTime = timeMs / 1000; // Convert ms to seconds for Web Audio API
        console.log('Glide Time:', glideTime.toFixed(3) + 's');
    },
    'osc1-pwm-knob': (value) => {
        osc1PWMValue = value; // Update global hold amount

        const holdAmount = osc1PWMValue; // Value is 0-1

        const tooltip = createTooltipForKnob('osc1-pwm-knob', value);
        tooltip.textContent = `Shape: ${(holdAmount * 100).toFixed(0)}%`;
        tooltip.style.opacity = '1';

        // Update active notes
        const now = audioCtx.currentTime;
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.osc1Note && voice.osc1Note.workletNode) {
                const holdParam = voice.osc1Note.workletNode.parameters.get('holdAmount');
                if (holdParam) {
                    holdParam.setTargetAtTime(holdAmount, now, 0.015);
                }
            }
        });
        // <<< END CHANGE >>>
        console.log(`Osc1 PWM/Shape Knob: ${holdAmount.toFixed(2)}`);
    },

    'osc1-quantize-knob': (value) => {
        osc1QuantizeValue = value; // Update global quantize amount

        const quantizeAmount = osc1QuantizeValue; // Value is 0-1

        const tooltip = createTooltipForKnob('osc1-quantize-knob', value);
        tooltip.textContent = `Quant: ${(quantizeAmount * 100).toFixed(0)}%`;
        tooltip.style.opacity = '1';

        // Update active notes
        const now = audioCtx.currentTime;
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.osc1Note && voice.osc1Note.workletNode) {
                const quantizeParam = voice.osc1Note.workletNode.parameters.get('quantizeAmount');
                if (quantizeParam) {
                    quantizeParam.setTargetAtTime(quantizeAmount, now, 0.015);
                }
            }
        });
        // <<< END CHANGE >>>
        console.log(`Osc1 Quantize Knob: ${quantizeAmount.toFixed(2)}`);
    },
    'osc2-gain-knob': (value) => {
        osc2GainValue = value;
        const tooltip = createTooltipForKnob('osc2-gain-knob', value);
        tooltip.textContent = `Gain: ${Math.round(value * 100)}%`;
        tooltip.style.opacity = '1';
        // Update active Osc2 notes
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.osc2Note && voice.osc2Note.levelNode) {
                voice.osc2Note.levelNode.gain.setTargetAtTime(osc2GainValue, audioCtx.currentTime, 0.01);
            }
        });
        // <<< END CHANGE >>>
        console.log(`Osc2 Gain set to: ${value.toFixed(2)}`);
    },
    'osc2-pitch-knob': (value) => {
        // Map 0-1 to -100 to +100 cents (adjust range as needed)
        osc2Detune = (value - 0.5) * 200;
        const tooltip = createTooltipForKnob('osc2-pitch-knob', value);
        tooltip.textContent = `Pitch: ${osc2Detune.toFixed(0)}c`;
        tooltip.style.opacity = '1';
        const now = audioCtx.currentTime;
        // Update active Osc2 notes
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.osc2Note && voice.osc2Note.workletNode) {
                const detuneParam = voice.osc2Note.workletNode.parameters.get('detune');
                if (detuneParam) {
                    detuneParam.setTargetAtTime(osc2Detune, now, 0.01);
                }
                // <<< ADD: Update Osc2 FM source if it's Osc1 >>>
                if (osc1FMSource === 'osc2' && voice.osc1Note && voice.osc1Note.fmModulatorSource instanceof OscillatorNode) {
                    voice.osc1Note.fmModulatorSource.detune.setTargetAtTime(osc2Detune, now, 0.01);
                }
            }
        });
        // <<< END CHANGE >>>
        console.log(`Osc2 Detune set to: ${osc2Detune.toFixed(1)} cents`);
    },
    'osc2-pwm-knob': (value) => {
        osc2PWMValue = value;
        const tooltip = createTooltipForKnob('osc2-pwm-knob', value);
        tooltip.textContent = `Shape: ${Math.round(value * 100)}%`; // Use Shape for consistency
        tooltip.style.opacity = '1';
        const now = audioCtx.currentTime;
        // Update active Osc2 notes regardless of waveform
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.osc2Note && voice.osc2Note.workletNode) {
                const holdParam = voice.osc2Note.workletNode.parameters.get('holdAmount');
                if (holdParam) {
                    holdParam.setTargetAtTime(osc2PWMValue, now, 0.015); // Use the updated global value
                }
            }
        });
        // <<< END CHANGE >>>
        console.log(`Osc2 PWM/Shape set to: ${value.toFixed(2)}`);
    },
    'osc2-quantize-knob': (value) => {
        osc2QuantizeValue = value;
        const tooltip = createTooltipForKnob('osc2-quantize-knob', value);
        tooltip.textContent = `Quant: ${Math.round(value * 100)}%`;
        tooltip.style.opacity = '1';
        const now = audioCtx.currentTime;
        // Update active Osc2 notes
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.osc2Note && voice.osc2Note.workletNode) {
                const quantParam = voice.osc2Note.workletNode.parameters.get('quantizeAmount');
                if (quantParam) {
                    quantParam.setTargetAtTime(osc2QuantizeValue, now, 0.015);
                }
            }
        });
        // <<< END CHANGE >>>
        console.log(`Osc2 Quantize set to: ${value.toFixed(2)}`);
    },
    'osc2-fm-knob': (value) => {
        // Apply exponential curve
        const curvedValue = value * value;
        const prevFMAmount = osc2FMAmount; // <<< Store previous amount
        osc2FMAmount = curvedValue; // Store curved value

        // Calculate scaled depth (Hz)
        const scaledDepth = osc2FMAmount * osc2FMDepthScale;
        const now = audioCtx.currentTime;
        const isNowOn = osc2FMAmount > 0.001;
        const wasPreviouslyOff = prevFMAmount <= 0.001; // <<< Check if it was off

        // Update tooltip
        const tooltip = createTooltipForKnob('osc2-fm-knob', value);
        tooltip.textContent = `FM: ${(scaledDepth).toFixed(0)}Hz`;
        tooltip.style.opacity = '1';

        // --- UPDATE Per-Voice ---
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.osc2Note) {
                // Check if the fmDepthGain node exists for this voice.
                if (voice.osc2Note.fmDepthGain) {
                    // <<< Node exists: Just update gain smoothly >>>
                    const timeConstant = 0.020; // 20ms time constant
                    voice.osc2Note.fmDepthGain.gain.setTargetAtTime(scaledDepth, now, timeConstant);
                } else if (isNowOn) { // <<< Check if FM is ON now >>>
                    // <<< Node MISSING, but FM should be ON now >>>
                    // This happens if the note started while FM knob was at 0.
                    // Call updateOsc2FmModulatorParameters to create/connect nodes.
                    console.log(`osc2-fm-knob: FM turned on for note ${voice.osc2Note.id}. Initializing FM nodes.`);
                    // <<< Pass the 'voice' object >>>
                    updateOsc2FmModulatorParameters(voice.osc2Note, now, voice);
                    // updateOsc2FmModulatorParameters sets the initial gain,
                    // so no need to setTargetAtTime immediately after.
                }
                // <<< If !isNowOn and node missing, do nothing (FM is off) >>>
                // <<< If !isNowOn and node exists, the gain ramp above will handle turning it down >>>
            }
        });
        // <<< END CHANGE >>>
        // --- END UPDATE ---

        console.log(`Osc2 FM Knob Raw: ${value.toFixed(3)}, Curved: ${osc2FMAmount.toFixed(3)}, Depth: ${scaledDepth.toFixed(1)} Hz`);
    },
};
/**
 * Updates an existing sampler note's playback parameters (buffer, loop, rate, etc.)
 * by aggressively replacing its source and gain nodes.
 * @param {object} note - The sampler note object 
 * @returns {object|null} The updated note object or null if update failed.
 */
function updateSamplePlaybackParameters(note) {
    // --- Safety Checks ---
    if (!note || !(note.source instanceof AudioBufferSourceNode) || !(note.gainNode instanceof GainNode) || !(note.sampleNode instanceof GainNode)) {
        console.warn(`updateSamplePlaybackParameters: Skipping update for note ${note?.id}. Invalid note object, source, gainNode, or sampleNode.`);
        return note; // Return original note if invalid
    }
    if (!audioBuffer) {
        console.warn(`updateSamplePlaybackParameters: Skipping update for note ${note.id}. Global audioBuffer is missing.`);
        return note;
    }
    // Prevent recursive updates or updates on notes already ending/killed
    if (note.isBeingUpdated || note.state === "releasing" || note.state === "fadingOut" || note.state === "killed") {
        console.log(`updateSamplePlaybackParameters: Skipping update for note ${note.id}, state: ${note.state}, isBeingUpdated: ${note.isBeingUpdated}`);
        return note;
    }

    console.log(`updateSamplePlaybackParameters: Starting update for note ${note.id} (state: ${note.state})`);
    note.isBeingUpdated = true; // Mark as being updated

    // --- Aggressive Cleanup ---
    const oldSource = note.source;
    const oldGainNode = note.gainNode;
    const oldSampleNode = note.sampleNode;
    let currentGainValue = 0; // Default to 0

    console.log(`updateSamplePlaybackParameters [${note.id}]: Stopping and disconnecting old nodes.`);
    try {
        // Get current gain BEFORE cancelling ramps
        currentGainValue = oldGainNode.gain.value;

        oldGainNode.gain.cancelScheduledValues(audioCtx.currentTime);
        oldGainNode.gain.setValueAtTime(0, audioCtx.currentTime); // Set gain to 0 immediately to prevent clicks

        oldSource.stop(0); // Stop playback immediately
        oldSource.disconnect();
        oldSampleNode.disconnect();
        oldGainNode.disconnect();
    } catch (e) {
        // Ignore errors if source was already stopped or disconnected
        if (!e.message.includes("already stopped") && !e.message.includes("invalid state")) {
            console.error(`updateSamplePlaybackParameters [${note.id}]: Error stopping/disconnecting old source:`, e);
        }
    }
    // Clear references on the note object temporarily
    note.source = null;
    note.gainNode = null;
    note.sampleNode = null;
    // --- End Aggressive Cleanup ---

    try {
        // --- Create Replacement Note Structure ---
        console.log(`updateSamplePlaybackParameters [${note.id}]: Creating new source/nodes.`);

        // Determine which buffer to use
        let useOriginalBuffer = true;
        let sourceBuffer = audioBuffer; // Default to original (potentially reversed) buffer
        let bufferType = "original";

        // Prioritize crossfaded buffer if loop/crossfade active and buffer exists
        if (isSampleLoopOn && sampleCrossfadeAmount > 0.01 && cachedCrossfadedBuffer) {
            sourceBuffer = cachedCrossfadedBuffer;
            useOriginalBuffer = false;
            bufferType = "crossfaded";
        }
        // Otherwise, use faded buffer if fades are active (and not looping/crossfading)
        else if (fadedBuffer && (!isSampleLoopOn || sampleCrossfadeAmount <= 0.01)) {
            sourceBuffer = fadedBuffer;
            useOriginalBuffer = false;
            bufferType = "faded";
        }
        // If Emu mode is on and we ended up with the original buffer, apply Emu processing now
        else if (isEmuModeOn && useOriginalBuffer) {
             // This case should ideally be covered by updateSampleProcessing storing the emu version in fadedBuffer
             // But as a fallback, process it here if needed.
             console.warn(`updateSamplePlaybackParameters [${note.id}]: Applying Emu processing fallback.`);
             sourceBuffer = applyEmuProcessing(audioBuffer);
             useOriginalBuffer = false; // Technically using a processed version now
             bufferType = "original_emu";
        }


        if (!sourceBuffer || !(sourceBuffer instanceof AudioBuffer) || sourceBuffer.length === 0) {
            console.error(`updateSamplePlaybackParameters [${note.id}]: Invalid sourceBuffer selected (type: ${bufferType}, length: ${sourceBuffer?.length}). Cannot create replacement.`);
            killSamplerNote(note); // Attempt to kill the note entirely
            return null; // Indicate failure
        }
        console.log(`updateSamplePlaybackParameters [${note.id}]: Selected buffer for replacement: ${bufferType}`);

        // Create new nodes
        const newSource = audioCtx.createBufferSource();
        const newGainNode = audioCtx.createGain(); // For ADSR
        const newSampleNode = audioCtx.createGain(); // For sample-specific gain

        newSource.buffer = sourceBuffer;
        newSampleNode.gain.value = currentSampleGain; // Use global sample gain

        // Apply playback rate / detune
        let calculatedRate = 1.0;
        if (isSampleKeyTrackingOn) {
            calculatedRate = TR2 ** (note.noteNumber - 12); // Use note's number
            newSource.playbackRate.value = calculatedRate;
            newSource.detune.setTargetAtTime(currentSampleDetune, audioCtx.currentTime, 0.01);
        } else {
            newSource.playbackRate.value = 1.0;
            newSource.detune.value = currentSampleDetune;
        }

        // Connect new nodes: source -> sampleNode -> gainNode -> destination (masterGain)
        newSource.connect(newSampleNode);
        newSampleNode.connect(newGainNode);
        newGainNode.connect(masterGain);

        // Apply loop settings
        let loopStartTime = 0;
        let loopEndTime = sourceBuffer.duration;
        if (useOriginalBuffer) {
            // Looping the original buffer requires start/end points based on global settings
            if (isSampleLoopOn) {
                newSource.loop = true;
                // Use the original buffer's duration for calculating loop points
                loopStartTime = sampleStartPosition * audioBuffer.duration;
                loopEndTime = sampleEndPosition * audioBuffer.duration;
                newSource.loopStart = loopStartTime;
                newSource.loopEnd = loopEndTime;
            } else {
                newSource.loop = false;
            }
        } else {
            // Looping a processed buffer (faded or crossfaded) loops the whole buffer
            newSource.loop = isSampleLoopOn;
            // loopStart/End default to 0 and buffer duration if loop is true
        }

        // Update the note object with new nodes and state
        note.source = newSource;
        note.gainNode = newGainNode;
        note.sampleNode = newSampleNode;
        note.usesProcessedBuffer = !useOriginalBuffer;
        note.crossfadeActive = bufferType === "crossfaded"; // Only true if using the specific crossfaded buffer
        note.looping = newSource.loop; // Reflect the actual loop state
        note.calculatedLoopStart = loopStartTime; // Store for reference
        note.calculatedLoopEnd = loopEndTime;     // Store for reference

        // Start the new source
        console.log(`updateSamplePlaybackParameters [${note.id}]: Starting new source.`);
        const now = audioCtx.currentTime;
        newSource.start(now); // Start immediately

        // Restore gain smoothly to the level it was at before replacement
note.gainNode.gain.cancelScheduledValues(now);
note.gainNode.gain.setValueAtTime(0, now); // Start at 0
note.gainNode.gain.exponentialRampToValueAtTime(Math.max(0.001, currentGainValue), now + STANDARD_FADE_TIME * 2); // Use 2x standard time for smoother transitions


        // Schedule stop if not looping
        if (!note.looping) {
            let originalDuration;
            // Determine the duration based on which buffer is playing
            if (bufferType === "faded" && fadedBufferOriginalDuration) {
                 originalDuration = fadedBufferOriginalDuration; // Use stored duration before fades
            } else if (bufferType === "crossfaded") {
                 originalDuration = sourceBuffer.duration; // Crossfaded buffer duration is the loop length
            } else if (bufferType === "original_emu") {
                 // Duration of the original segment before Emu processing
                 originalDuration = (sampleEndPosition - sampleStartPosition) * audioBuffer.duration;
            } else { // Original buffer
                 originalDuration = (sampleEndPosition - sampleStartPosition) * audioBuffer.duration;
            }

            const playbackRate = newSource.playbackRate.value; // Use the actual rate
            const adjustedDuration = originalDuration / playbackRate;
            const safetyMargin = 0.05; // Small margin
            const stopTime = now + adjustedDuration + safetyMargin;

            try {
                newSource.stop(stopTime);
                console.log(`updateSamplePlaybackParameters [${note.id}]: New source scheduled to stop at ${stopTime.toFixed(3)}`);
            } catch (e) {
                console.error(`updateSamplePlaybackParameters [${note.id}]: Error scheduling stop for new source:`, e);
            }
        }
        console.log(`updateSamplePlaybackParameters [${note.id}]: Successfully updated note with new source/nodes.`);
// <<< ADD: Update corresponding FM modulators AFTER main sampler note is updated >>>
        // Ensure the note object has a reference to its parent voice (e.g., note.parentVoice)
        // This reference should be added when the note object is created within createVoice.
        const voice = note.parentVoice;
        const nowUpdate = audioCtx.currentTime;
        if (voice) {
            // Update Osc1 FM if sampler is the source
            if (voice.osc1Note && osc1FMSource === 'sampler') {
                console.log(`updateSamplePlaybackParameters: Triggering Osc1 FM update for voice ${voice.id} because sampler changed.`);
                updateOsc1FmModulatorParameters(voice.osc1Note, nowUpdate, voice);
            }
            // Update Osc2 FM if sampler is the source
            if (voice.osc2Note && osc2FMSource === 'sampler') {
                console.log(`updateSamplePlaybackParameters: Triggering Osc2 FM update for voice ${voice.id} because sampler changed.`);
                updateOsc2FmModulatorParameters(voice.osc2Note, nowUpdate, voice);
            }
        } else {
            // Attempt to find the voice in the pool as a fallback (less efficient)
            const fallbackVoice = voicePool.find(v => v.samplerNote === note);
            if (fallbackVoice) {
                 console.warn(`updateSamplePlaybackParameters: Used fallback to find parent voice ${fallbackVoice.id} for sampler note ${note.id}. Consider adding parentVoice reference.`);
                 if (fallbackVoice.osc1Note && osc1FMSource === 'sampler') {
                     updateOsc1FmModulatorParameters(fallbackVoice.osc1Note, nowUpdate, fallbackVoice);
                 }
                 if (fallbackVoice.osc2Note && osc2FMSource === 'sampler') {
                     updateOsc2FmModulatorParameters(fallbackVoice.osc2Note, nowUpdate, fallbackVoice);
                 }
            } else {
                console.warn(`updateSamplePlaybackParameters: Could not find parent voice for sampler note ${note.id} to update FM.`);
            }
        }
        // <<< END ADD >>>

    } catch (error) {
        console.error(`updateSamplePlaybackParameters [${note.id}]: Error during replacement process:`, error);
        killSamplerNote(note); // Attempt to kill the note if replacement fails badly
        return null; // Indicate failure
    } finally {
        note.isBeingUpdated = false; // Release the update lock
        console.log(`updateSamplePlaybackParameters: Finished update for note ${note.id}`);
    }
    return note; // Return the updated note object
}

/**
* Sets up loop crossfade without recursion.
* (Do not call updateSamplePlaybackParameters or createNote here.)
*/


// Update the DOMContentLoaded event listener
document.addEventListener('DOMContentLoaded', () => {
// Initialize all regular knobs
Object.entries(knobInitializations).forEach(([id, callback]) => {
const knob = D(id);
if (knob) {
const defaultValue = knobDefaults[id] !== undefined ? knobDefaults[id] : 0.5;
const control = initializeKnob(knob, callback, knobDefaults);
}
});



// Initialize any remaining parameters
updateSampleProcessing();
});


// Add to global variables

// --- Voice Pool Management ---
const MAX_POLYPHONY = 6;
const voicePool = []; // Array to hold all voice objects
let nextVoiceIndex = 0; // To cycle through voices for allocation/stealing

// New sampler voice pool
const MAX_SAMPLER_POLYPHONY = 6; // New constant for sampler voices
const samplerVoicePool = []; // Array to hold all sampler voice objects
let nextSamplerVoiceIndex = 0; // To cycle through sampler voices for allocation/stealing

// Function to create a sampler voice
function createSamplerVoice(ctx, index) {
    const voice = {
        id: `sampler_voice_${index}`,
        index: index,
        noteNumber: null,
        startTime: 0,
        state: 'inactive',
        samplerNote: null,
    };

    // --- Create Sampler Nodes ---
    const samplerGainNode = ctx.createGain(); // ADSR
    const samplerSampleNode = ctx.createGain(); // Sample-specific gain
    const samplerSource = ctx.createBufferSource(); // Placeholder, buffer set later
    samplerGainNode.gain.value = 0;
    samplerSampleNode.gain.value = 0.5; // Default sample gain
    samplerSource.connect(samplerSampleNode);
    samplerSampleNode.connect(samplerGainNode);
    // samplerGainNode.connect(masterGain); // Connect in noteOn

    voice.samplerNote = {
        id: `sampler_${index}`,
        type: 'sampler',
        noteNumber: null,
        source: samplerSource,
        gainNode: samplerGainNode,
        sampleNode: samplerSampleNode,
        startTime: 0,
        state: 'inactive',
        scheduledEvents: [],
        looping: false,
        usesProcessedBuffer: false,
        crossfadeActive: false,
        calculatedLoopStart: 0,
        calculatedLoopEnd: 0,
        isBeingUpdated: false,
        parentVoice: voice,
    };

    console.log(`Created sampler voice ${index}`);
    return voice;
}

// Function to initialize the sampler voice pool
function initializeSamplerVoicePool() {
    console.log("Initializing sampler voice pool...");
    samplerVoicePool.length = 0; // Clear any previous pool
    for (let i = 0; i < MAX_SAMPLER_POLYPHONY; i++) {
        samplerVoicePool.push(createSamplerVoice(audioCtx, i));
    }
    console.log(`Sampler voice pool initialized with ${samplerVoicePool.length} voices.`);
}
// Call this function after the AudioWorklet is ready

// Function to find an available sampler voice in the pool
function findAvailableSamplerVoice(noteNumber) {
    if (samplerVoicePool.length === 0) return null;

    // In mono mode, we MUST steal the current voice if it exists
    if (isMonoMode && currentMonoSamplerVoice) {
        const voiceToSteal = currentMonoSamplerVoice;
        voiceToSteal.wasStolen = voiceToSteal.state !== 'inactive'; // Mark as stolen if it was active
        return voiceToSteal;
    }
    
    // For poly mode, use round-robin
    const index = nextSamplerVoiceIndex % samplerVoicePool.length;
    const candidate = samplerVoicePool[index];
    nextSamplerVoiceIndex = (index + 1) % samplerVoicePool.length;
    
    // Mark as stolen if it's currently active. noteOn will handle the rest.
    candidate.wasStolen = candidate.state !== 'inactive';
    if (candidate.wasStolen) {
        console.log(`findAvailableSamplerVoice: Stealing sampler voice ${candidate.id} for note ${noteNumber}.`);
    }
    
    return candidate;
}
// Add interface updating functions
function updateSliderValues() {
// Always format to 2 decimal places for consistent width
D('attack-value').textContent = parseFloat(D('attack').value).toFixed(3);
D('decay-value').textContent = parseFloat(D('decay').value).toFixed(2);
D('sustain-value').textContent = parseFloat(D('sustain').value).toFixed(2);
D('release-value').textContent = parseFloat(D('release').value).toFixed(3);

updateADSRVisualization();
}

// ADSR visualization
function updateADSRVisualization() {
  const attack = parseFloat(D('attack').value);
const decay = parseFloat(D('decay').value);
const sustain = parseFloat(D('sustain').value);
const release = parseFloat(D('release').value);

const graph = D('adsr-visualization');
const totalTime = attack + decay + 2 + release; // 2 seconds for sustain

// Get actual display dimensions
const width = graph.offsetWidth;
const height = graph.offsetHeight;
    
    // Calculate points for ADSR envelope
    const attackX = (attack / totalTime) * width;
    const decayX = attackX + ((decay / totalTime) * width);
    const releaseStartX = decayX + ((2 / totalTime) * width); // 2 seconds sustain
    const releaseEndX = width;
    
// Create canvas at exact display size
const canvas = document.createElement('canvas');
canvas.width = width;
canvas.height = height;
const ctx = canvas.getContext('2d');

// Make sure lines are drawn with proper alignment
ctx.imageSmoothingEnabled = false;
ctx.translate(0.5, 0.5);
ctx.strokeStyle = '#f2eed3';
ctx.lineWidth = 2.5; // Make the line thickness 3px

// Set line join style for smoother corners
ctx.lineJoin = 'round';
ctx.lineCap = 'round';
// Clear canvas
ctx.clearRect(-1, -1, width + 1, height + 1);

    
// Draw ADSR path
ctx.beginPath();
ctx.moveTo(0, height - 1); // Start at bottom left
ctx.lineTo(attackX, 1); // Attack to peak
ctx.lineTo(decayX, height - (sustain * height)); // Decay to sustain level
ctx.lineTo(releaseStartX, height - (sustain * height)); // Sustain
ctx.lineTo(releaseEndX, height - 1); // Release
ctx.stroke();

// Update visualization
graph.innerHTML = '';
graph.appendChild(canvas);
}

// Update the voice monitoring display based on the voicePool
function updateVoiceDisplay_Pool() {
    const displayEl = D('voice-display');
    const voiceCountEl = D('voice-count');
    if (!displayEl || !voiceCountEl) return;

    displayEl.innerHTML = ''; // Clear previous display
    
    // --- CORRECTED LOGIC ---
    // 1. Get all truly active notes from both pools.
    const activeNotes = new Map();
    const countNote = (noteNum) => {
        if (noteNum === null) return;
        activeNotes.set(noteNum, (activeNotes.get(noteNum) || 0) + 1);
    };

    voicePool.forEach(v => { if (v.state !== 'inactive') countNote(v.noteNumber); });
    samplerVoicePool.forEach(v => { if (v.state !== 'inactive') countNote(v.noteNumber); });

    // 2. Update the voice count based on the number of active voices.
    const activeVoiceCount = voicePool.filter(v => v.state !== 'inactive').length;
    const totalActiveVoices = (isMonoMode && activeVoiceCount > 0) ? 1 : activeVoiceCount;
    voiceCountEl.textContent = totalActiveVoices;

    // 3. Display visual key indicators based on the active notes found in the pools.
    if (typeof keys !== 'undefined' && Array.isArray(keys)) {
        keys.forEach((key, index) => {
            const voiceItem = document.createElement('div');
            voiceItem.className = 'voice-item';
            
            const count = activeNotes.get(index) || 0;
            if (count > 0) {
                voiceItem.classList.add('active-voice');
                if (count > 1 && !isMonoMode) {
                    voiceItem.textContent = `${key}×${count}`;
                    voiceItem.style.fontWeight = 'bold';
                } else {
                    voiceItem.textContent = key;
                }
            } else {
                voiceItem.textContent = key;
            }
            displayEl.appendChild(voiceItem);
        });
    }
}

// you're the best <3 and you should put french fries in my car so that my car smells like fries forever :) - from Asher to Faith
// Add event listeners for sliders
D('attack').addEventListener('input', updateSliderValues);
D('decay').addEventListener('input', updateSliderValues);
D('sustain').addEventListener('input', updateSliderValues);
D('release').addEventListener('input', updateSliderValues);





// Initialize switches on DOM load
document.addEventListener('DOMContentLoaded', () => {
//nitializeSwitches();
});


function updateKeyboardDisplay_Pool() {
    const activeNoteNumbers = new Set();

    // --- CORRECTED LOGIC: Check both pools for active notes ---
    voicePool.forEach(voice => {
        if (voice.state !== 'inactive' && voice.noteNumber !== null) {
            activeNoteNumbers.add(voice.noteNumber);
        }
    });
    samplerVoicePool.forEach(voice => {
        if (voice.state !== 'inactive' && voice.noteNumber !== null) {
            activeNoteNumbers.add(voice.noteNumber);
        }
    });
    // --- END CORRECTION ---

    document.querySelectorAll('.key').forEach(keyElement => {
        const noteIndex = parseInt(keyElement.dataset.noteIndex);
        if (isNaN(noteIndex)) return;

        // A key is "pressed" if it's active in any voice pool OR still physically held.
        const isNoteActiveInPool = activeNoteNumbers.has(noteIndex);
        const isPhysicallyHeld = heldNotes.includes(noteIndex);

        keyElement.classList.toggle('pressed', isNoteActiveInPool || isPhysicallyHeld);
    });
}




function handleFileSelect(event) {
const file = event.target.files[0];
if (!file) return;

const reader = new FileReader();
reader.onload = function(e) {
const arrayBuffer = e.target.result;
audioCtx.decodeAudioData(arrayBuffer).then(buffer => {
    audioBuffer = buffer;
    originalBuffer = buffer.slice(); // Create a copy for reversal
    if (isSampleReversed) {
        reverseBufferIfNeeded(false); // Reverse if needed, but don't trigger another FM update yet
    }
    updateSampleProcessing(); // Process fades/crossfades


        // <<< END UPDATE >>>
        // Reset cached crossfade buffer when loading a new sample
        cachedCrossfadedBuffer = null;
        lastCachedStartPos = null;
        lastCachedEndPos = null;
        lastCachedCrossfade = null;
        
        // Create new source node
        if (sampleSource) {
            sampleSource.stop();
        }
        sampleSource = audioCtx.createBufferSource();
        sampleSource.buffer = buffer;
        
        // Connect the audio chain
        sampleSource.connect(sampleGainNode);
        sampleSource.start();
        
        // Update the label text to show the file name
        const fileLabel = document.querySelector('label[for="audio-file"]');
        if (fileLabel) {
            // Truncate filename if too long
            const maxLength = 12;
            const displayName = file.name.length > maxLength ? 
                file.name.substring(0, maxLength-3) + '...' : 
                file.name;
            fileLabel.textContent = displayName;
        }
        
        // Create crossfaded buffer if needed
        if (isSampleLoopOn && sampleCrossfadeAmount > 0.01) {
            console.log("Creating crossfaded buffer for newly loaded sample");
            const result = createCrossfadedBuffer(
              audioCtx,
                buffer, 
                sampleStartPosition, 
                sampleEndPosition, 
                sampleCrossfadeAmount
            );
            
            if (result && result.buffer) {
                console.log("Successfully created crossfaded buffer for new sample");
                cachedCrossfadedBuffer = result.buffer;
                lastCachedStartPos = sampleStartPosition;
                lastCachedEndPos = sampleEndPosition;
                lastCachedCrossfade = sampleCrossfadeAmount;
            }
        }
        // <<< ADD: Update active FM modulators AFTER buffer processing >>>
        const nowFile = audioCtx.currentTime;
trackSetTimeout(() => {
    voicePool.forEach(voice => {
        if (voice.state !== 'inactive') {
            if (voice.osc1Note && osc1FMSource === 'sampler') {
                updateOsc1FmModulatorParameters(voice.osc1Note, nowFile, voice);
            }
            if (voice.osc2Note && osc2FMSource === 'sampler') {
                updateOsc2FmModulatorParameters(voice.osc2Note, nowFile, voice);
            }
        }
    });
}, STANDARD_FADE_TIME * 1000); // Use standard time instead of arbitrary 20ms
        // Update any active sampler notes to use the new buffer
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.samplerNote) {
                const note = voice.samplerNote; // Get the samplerNote component
                // Skip held notes to avoid interruption
                if (heldNotes.includes(voice.noteNumber)) { // Check voice.noteNumber
                    console.log(`Sampler note ${note.id} (Voice ${voice.id}) is held; will update on release.`);
                    return;
                }

                console.log(`Updating sampler note ${note.id} (Voice ${voice.id}) to use new sample`);
                // Call updateSamplePlaybackParameters which handles buffer switching etc.
                updateSamplePlaybackParameters(note);
            }
        });
        // <<< END CHANGE >>>
    }).catch(e => console.error("Error decoding audio data:", e));
};
reader.readAsArrayBuffer(file);
}



D('audio-file').addEventListener('change', handleFileSelect);

// Clean up everything
function cleanupAllNotes() {
    console.log("Performing complete synth reset...");
    
    // 1. IMMEDIATELY stop all audio to prevent clicks and stuck notes
    const now = audioCtx.currentTime;

    // Hard stop all oscillator voices
    voicePool.forEach(voice => {
        // CRITICAL FIX: First set all gain nodes to zero immediately
        if (voice.osc1Note?.gainNode) {
            voice.osc1Note.gainNode.gain.cancelScheduledValues(now);
            voice.osc1Note.gainNode.gain.setValueAtTime(0, now);
        }
        if (voice.osc2Note?.gainNode) {
            voice.osc2Note.gainNode.gain.cancelScheduledValues(now);
            voice.osc2Note.gainNode.gain.setValueAtTime(0, now);
        }
        if (voice.samplerNote?.gainNode) {
            voice.samplerNote.gainNode.gain.cancelScheduledValues(now);
            voice.samplerNote.gainNode.gain.setValueAtTime(0, now);
        }
        
        // Stop all source nodes WITHOUT disconnecting
        if (voice.osc1Note?.fmModulatorSource) {
            try { voice.osc1Note.fmModulatorSource.stop(now); } catch(e) {}
        }
        if (voice.osc2Note?.fmModulatorSource) {
            try { voice.osc2Note.fmModulatorSource.stop(now); } catch(e) {}
        }
        if (voice.samplerNote?.source) {
            try { voice.samplerNote.source.stop(now); } catch(e) {}
        }
        
        // CRITICAL FIX: Only null out sources, don't disconnect audio nodes
        if (voice.osc1Note) {
            if (voice.osc1Note.fmModulatorSource) voice.osc1Note.fmModulatorSource = null;
            voice.osc1Note.state = 'inactive';
            voice.osc1Note.noteNumber = null;
        }
        if (voice.osc2Note) {
            if (voice.osc2Note.fmModulatorSource) voice.osc2Note.fmModulatorSource = null;
            voice.osc2Note.state = 'inactive';
            voice.osc2Note.noteNumber = null;
        }
        if (voice.samplerNote) {
            if (voice.samplerNote.source) voice.samplerNote.source = null;
            voice.samplerNote.state = 'inactive';
            voice.samplerNote.noteNumber = null;
        }
        
        // Reset state flags
        voice.state = 'inactive';
        voice.noteNumber = null;
        voice.startTime = 0;
        voice.wasStolen = false;
        voice.preservePhase = false;
        voice.isSelfStealing = false;
    });
    
    // Hard stop all sampler voices (similar changes as above)
    samplerVoicePool.forEach(voice => { 
        if (voice.samplerNote?.gainNode) {
            voice.samplerNote.gainNode.gain.cancelScheduledValues(now);
            voice.samplerNote.gainNode.gain.setValueAtTime(0, now);
        }
        
        if (voice.samplerNote?.source) {
            try { voice.samplerNote.source.stop(now); } catch(e) {}
        }
        
        // CRITICAL FIX: Only null out source, don't disconnect nodes
        if (voice.samplerNote) {
            if (voice.samplerNote.source) voice.samplerNote.source = null;
            voice.samplerNote.state = 'inactive';
            voice.samplerNote.noteNumber = null;
        }
        
        voice.state = 'inactive';
        voice.noteNumber = null;
        voice.startTime = 0;
        voice.wasStolen = false;
    });
    
    // 2. Reset mono tracking variables
    currentMonoVoice = null;
    currentMonoSamplerVoice = null;
    
    // Rest of the function remains the same...
    nextVoiceIndex = 0;
    nextSamplerVoiceIndex = 0;
    
    console.log(`Clearing held notes array: [${heldNotes.join(',')}]`);
    heldNotes = [];
    
    lastPlayedNoteNumber = null;
    glideStartRate = null;
    glideStartFreqOsc1 = null;
    glideStartFreqOsc2 = null;
    glideStartFreqFmOsc1 = null;
    glideStartDetuneFmOsc1 = null;
    glideStartFreqFmOsc2 = null;
    glideStartDetuneFmOsc2 = null;

    resetKeyStates();
    updateVoiceDisplay_Pool();
    updateKeyboardDisplay_Pool();
    
    // CRITICAL FIX: Make sure AudioContext is running after cleanup
    if (audioCtx.state === 'suspended') {
        audioCtx.resume().then(() => {
            console.log("AudioContext resumed after cleanup");
        }).catch(e => {
            console.error("Failed to resume AudioContext after cleanup:", e);
        });
    }
    
    console.log("Complete synth reset finished - all voices inactive, all notes cleared");
}

// Add additional safety with blur/focus event handling
// window.addEventListener('blur', cleanupAllNotes);
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // cleanupAllNotes();
        handleVisibilityChange();
    }
});

// Initialize interface

updateSliderValues();
updateVoiceDisplay_Pool();
updateADSRVisualization();
// Initialize Keyboard Module
initializeKeyboard('keyboard', noteOn, noteOff, updateKeyboardDisplay_Pool)


function createTooltipForKnob(knobId, value) {
const tooltip = document.getElementById(`${knobId}-tooltip`) || (() => {
const newTooltip = document.createElement('div');
newTooltip.id = `${knobId}-tooltip`;
newTooltip.className = 'tooltip';
document.body.appendChild(newTooltip);

// Position tooltip near its knob
const knob = D(knobId);
const knobRect = knob.getBoundingClientRect();
newTooltip.style.left = `${knobRect.left + knobRect.width + 5}px`;
newTooltip.style.top = `${knobRect.top + (knobRect.height / 2) - 10}px`;

return newTooltip;
})();

return tooltip;
}

// Update the document mouseup handler to hide all tooltips
document.addEventListener('mouseup', () => {
document.querySelectorAll('.tooltip').forEach(tooltip => {
tooltip.style.opacity = '0';
});
});

function initializePrecisionSlider(slider) {
let lastY;
let isDragging = false;
const range = parseFloat(slider.max) - parseFloat(slider.min);
const totalHeight = 230; // Height of slider in pixels

function handleMouseMove(e) {
if (!isDragging) return;

// Calculate sensitivity based on shift key
const sensitivity = e.shiftKey ? 0.2 : 1.0;
const deltaY = (lastY - e.clientY) * sensitivity;
lastY = e.clientY;

// Calculate value change
const valueChange = (deltaY / totalHeight) * range;
const currentValue = parseFloat(slider.value);
let newValue = currentValue + valueChange;

// Clamp to min/max
newValue = Math.min(Math.max(newValue, slider.min), slider.max);

// Update slider value
slider.value = newValue;

// Trigger input event for ADSR visualization
slider.dispatchEvent(new Event('input'));

e.preventDefault();
}

function handleMouseUp() {
isDragging = false;
document.removeEventListener('mousemove', handleMouseMove);
document.removeEventListener('mouseup', handleMouseUp);
}

slider.addEventListener('mousedown', (e) => {
isDragging = true;
lastY = e.clientY;
document.addEventListener('mousemove', handleMouseMove);
document.addEventListener('mouseup', handleMouseUp);
e.preventDefault();
});
}

// Initialize precision control for ADSR sliders
document.addEventListener('DOMContentLoaded', () => {
['attack', 'decay', 'sustain', 'release'].forEach(id => {
const slider = D(id);
if (slider) {
    initializePrecisionSlider(slider);
}
});
});




// Add to initializeSwitch function
function initializeSwitch(switchEl, options = { onText: 'ON', offText: 'OFF' }) {
    let isDragging = false;
    let isActive = false; // Internal state

    

    function handleInteractionStart(e) {
        isDragging = true; // Use this flag for both touch and mouse
        switchEl.style.cursor = 'grabbing';
        e.preventDefault(); // Prevent default actions like scrolling on touch
    }

    function handleInteractionEnd() {
        if (!isDragging) return; // Prevent multiple triggers if already ended
        isDragging = false;
        switchEl.style.cursor = 'grab';
        
    }

    function handleClick() {
        // Toggle internal state
        isActive = !isActive;
        switchEl.classList.toggle('active', isActive); // Update visual class
        // Call the onChange callback if provided
        if (options.onChange) {
            options.onChange(isActive);
        }
    }

    // --- Event Listeners ---
    // Mouse
    switchEl.addEventListener('mousedown', handleInteractionStart);
    // Use document mouseup to catch release outside the element
    document.addEventListener('mouseup', handleInteractionEnd);

    // Touch
    switchEl.addEventListener('touchstart', handleInteractionStart, { passive: false });
    // Use document touchend to catch release outside the element
    document.addEventListener('touchend', handleInteractionEnd);
    document.addEventListener('touchcancel', handleInteractionEnd); // Handle cancelled touches

    // Click (handles both mouse clicks and simulated clicks from touch handlers if needed)
    switchEl.addEventListener('click', handleClick);

    // Set initial cursor style
    switchEl.style.cursor = 'grab';

    return {
        getValue: () => isActive,
        setValue: (value, triggerChange = false) => {
            const changed = isActive !== value;
            isActive = value;
            switchEl.classList.toggle('active', isActive);
            // Don't update tooltip here, let external call do it after initialization
            if (changed && triggerChange && options.onChange) {
                 options.onChange(isActive);
            }
        },
    };
}



// Initialize the switches


// Initialize switches on DOM load
document.addEventListener('DOMContentLoaded', () => {
//initializeSwitches();
});



// Initialize switches on DOM load
document.addEventListener('DOMContentLoaded', () => {
//initializeSwitches();
});
function initializeSampleLoopSwitch() {
const loopSwitch = document.getElementById('sample-loop-switch');
if (!loopSwitch) return;

// Toggle “active” class on click
loopSwitch.addEventListener('click', () => {
    loopSwitch.classList.toggle('active');
    isSampleLoopOn = loopSwitch.classList.contains('active');
    // <<< CHANGE: Iterate over voicePool >>>
    voicePool.forEach(voice => {
        if (voice.state !== 'inactive' && voice.samplerNote) {
            updateSamplePlaybackParameters(voice.samplerNote);
        }
    });
    // <<< END CHANGE >>>
        console.log('Sample Loop:', isSampleLoopOn ? 'ON' : 'OFF');
    });
    }
document.addEventListener('DOMContentLoaded', () => {
// Call this after other setup
initializeSampleLoopSwitch();
});



// Call this function during initialization instead of setupMicRecording

// Update document mouseup to hide all tooltips
document.addEventListener('mouseup', () => {
document.querySelectorAll('.tooltip').forEach(tooltip => {
tooltip.style.opacity = '0';
});
});
// Auto-hide tooltips after inactivity
function setupAutoHideTooltips() {
let tooltipHideTimers = {}; // Track timers per tooltip
const tooltipHideDelay = 250; // 2 seconds

// Function to hide all tooltips
function hideAllTooltips() {
document.querySelectorAll('.tooltip').forEach(tooltip => {
tooltip.style.opacity = '0';
});
}

// Function to schedule hiding a specific tooltip
function scheduleTooltipHide(tooltipId) {
// Clear any existing timer for this tooltip
if (tooltipHideTimers[tooltipId]) {
clearTimeout(tooltipHideTimers[tooltipId]);
}

// Set new timer
tooltipHideTimers[tooltipId] = setTimeout(() => {
const tooltip = document.getElementById(tooltipId);
if (tooltip) tooltip.style.opacity = '0';
delete tooltipHideTimers[tooltipId];
}, tooltipHideDelay);
}

// When any touch interaction ends, schedule hiding all tooltips
document.addEventListener('touchend', () => {
setTimeout(hideAllTooltips, tooltipHideDelay);
});

// Force hide tooltips when leaving the page or switching tabs
document.addEventListener('visibilitychange', () => {
if (document.hidden) {
hideAllTooltips();
}
});

// Ensure tooltips hide after inactivity
let globalInactivityTimer = null;

function resetInactivityTimer() {
if (globalInactivityTimer) clearTimeout(globalInactivityTimer);
globalInactivityTimer = setTimeout(hideAllTooltips, tooltipHideDelay);
}

// Reset the timer on any touch event
['touchstart', 'touchmove', 'touchend'].forEach(eventName => {
document.addEventListener(eventName, resetInactivityTimer, { passive: true });
});

// Initially reset timer
resetInactivityTimer();
}

// JavaScript for sample selector dropdown
document.addEventListener('DOMContentLoaded', function() {
const selectorBtn = document.getElementById('sample-selector-btn');
const dropdown = document.getElementById('sample-dropdown');
const dropdownItems = document.querySelectorAll('.dropdown-item');

// Toggle dropdown when clicking the button
selectorBtn.addEventListener('click', function() {
dropdown.classList.toggle('show');
event.stopPropagation();
});

// Close dropdown when clicking outside
window.addEventListener('click', function() {
if (dropdown.classList.contains('show')) {
dropdown.classList.remove('show');
}
});

// Handle preset sample selection
dropdownItems.forEach(item => {
item.addEventListener('click', function() {
const sampleName = this.getAttribute('data-sample');
loadPresetSample(sampleName);
dropdown.classList.remove('show');
});
});
});

// Function to load preset samples
function loadPresetSample(filename) {
    console.log(`Loading preset sample: ${filename}`);

    // Build the URL to the sample file
    const sampleUrl = `samples/${filename}`;

    // Fetch the sample file
    fetch(sampleUrl)
    .then(response => {
        if (!response.ok) {
            throw new Error(`Failed to load sample: ${response.status} ${response.statusText}`);
        }
        return response.arrayBuffer();
    })
    .then(arrayBuffer => {
        // Decode the audio data
        return audioCtx.decodeAudioData(arrayBuffer);
    })
    .then(buffer => {
        // Use the buffer as the sample
        audioBuffer = buffer;
        originalBuffer = buffer.slice(); // Store the original buffer

        // Apply reverse if needed
        if (isSampleReversed) {
            reverseBufferIfNeeded(false); // Don't trigger FM update yet
        }
        // Process fades and crossfades whenever a new preset is loaded
        updateSampleProcessing();

        // Reset cached crossfade buffer when loading a new sample
        cachedCrossfadedBuffer = null;
        lastCachedStartPos = null;
        lastCachedEndPos = null;
        lastCachedCrossfade = null;

        // Create new source node
        if (sampleSource) {
            sampleSource.stop();
        }
        sampleSource = audioCtx.createBufferSource();
        sampleSource.buffer = buffer;

        // Connect the audio chain
        sampleSource.connect(sampleGainNode);
        sampleSource.start();

        // Update the label to show the loaded sample name
        const fileLabel = document.querySelector('label[for="audio-file"]');
        if (fileLabel) {
            fileLabel.textContent = filename.substring(0, 10) + (filename.length > 10 ? '...' : '');
        }

        // Create crossfaded buffer if needed
        if (isSampleLoopOn && sampleCrossfadeAmount > 0.01) {
            console.log("Creating crossfaded buffer for preset sample");
            const result = createCrossfadedBuffer(
              audioCtx,
              buffer, 
              sampleStartPosition, 
              sampleEndPosition, 
              sampleCrossfadeAmount
            );

            if (result && result.buffer) {
                console.log("Successfully created crossfaded buffer for preset sample");
                cachedCrossfadedBuffer = result.buffer;
                lastCachedStartPos = sampleStartPosition;
                lastCachedEndPos = sampleEndPosition;
                lastCachedCrossfade = sampleCrossfadeAmount;
            }
        }
        
        // Update FM modulators with proper delay to avoid clicks
        const nowPreset = audioCtx.currentTime;
        // Use trackSetTimeout with standard fade time for consistency
        trackSetTimeout(() => {
            voicePool.forEach(voice => {
                if (voice.state !== 'inactive') {
                    if (voice.osc1Note && osc1FMSource === 'sampler') {
                        console.log(`loadPresetSample: Triggering Osc1 FM update for voice ${voice.id}`);
                        updateOsc1FmModulatorParameters(voice.osc1Note, nowPreset, voice);
                    }
                    if (voice.osc2Note && osc2FMSource === 'sampler') {
                        console.log(`loadPresetSample: Triggering Osc2 FM update for voice ${voice.id}`);
                        updateOsc2FmModulatorParameters(voice.osc2Note, nowPreset, voice);
                    }
                }
            });
        }, STANDARD_FADE_TIME * 1000); // Use standard fade time for consistent timing

        // Update active notes with proper timing
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.samplerNote) {
                const note = voice.samplerNote;
                if (heldNotes.includes(voice.noteNumber)) {
                    console.log(`Sampler note ${note.id} (Voice ${voice.id}) is held; will update on release.`);
                    return;
                }
                console.log(`Updating sampler note ${note.id} (Voice ${voice.id}) to use new preset sample`);
                updateSamplePlaybackParameters(note);
            }
        });
    })
    .catch(error => {
        console.error('Error loading preset sample:', error);
        alert(`Failed to load sample: ${filename}`);
    });
}

// In your processBufferWithFades function:
function processBufferWithFades(buffer) {
if (!buffer) return null;

// Skip processing if no fades needed
if (sampleFadeInAmount < 0.01 && sampleFadeOutAmount < 0.01) {
console.log("No fades to apply, returning original buffer");
return buffer;
}

console.log("Applying fade to trimmed buffer...");
const length = buffer.length;
if (length < 2) return buffer;

// Create the faded buffer
const newFadedBuffer = audioCtx.createBuffer(
buffer.numberOfChannels, 
length, 
buffer.sampleRate
);

// Calculate fade samples OUTSIDE the channel loop
const fadeInSamples = Math.floor(length * sampleFadeInAmount);
const fadeOutSamples = Math.floor(length * sampleFadeOutAmount);

for (let c = 0; c < buffer.numberOfChannels; c++) {
const inputData = buffer.getChannelData(c);
const outputData = newFadedBuffer.getChannelData(c);

// First copy all samples
for (let i = 0; i < length; i++) {
    outputData[i] = inputData[i];
}

// Apply fade in (first part of buffer)
for (let i = 0; i < fadeInSamples; i++) {
    outputData[i] *= i / fadeInSamples;
}

// Apply fade out (last part of buffer)
for (let i = 0; i < fadeOutSamples; i++) {
    const idx = length - 1 - i;
    outputData[idx] *= i / fadeOutSamples;
}
}

// CRITICAL FIX: Store the processed buffer in the global fadedBuffer variable
fadedBuffer = newFadedBuffer;

// Store the original duration for correct playback
fadedBufferOriginalDuration = (sampleEndPosition - sampleStartPosition) * audioBuffer.duration;
console.log(`Created faded buffer with ${fadeInSamples} fade in samples and ${fadeOutSamples} fade out samples`);
console.log(`Original duration: ${fadedBufferOriginalDuration}s`);

return newFadedBuffer;
}
function applyEmuProcessing(buffer) {
if (!buffer) return null;

const ctx = audioCtx;
const sampleRate = buffer.sampleRate;
const channels = buffer.numberOfChannels;
const length = buffer.length;

// Create a new buffer for the processed audio
const processedBuffer = ctx.createBuffer(channels, length, sampleRate);

// Process each channel
for (let channel = 0; channel < channels; channel++) {
const inputData = buffer.getChannelData(channel);
const outputData = processedBuffer.getChannelData(channel);

// First simply copy all data
for (let i = 0; i < length; i++) {
outputData[i] = inputData[i];
}

// Apply 8-bit mu-law companding simulation 
for (let i = 0; i < length; i++) {
// 1. Compress (simulate mu-law encoding)
const compressed = Math.sign(outputData[i]) * 
              Math.log(1 + 255 * Math.abs(outputData[i])) / Math.log(256);

// 2. Simulate quantization (8-bit)
const quantized = Math.round(compressed * 255) / 255;

// 3. Decompress (simulate mu-law decoding)
outputData[i] = Math.sign(quantized) * 
           (Math.pow(256, Math.abs(quantized)) - 1) / 255;
}

// Apply extremely subtle noise (0.05% amplitude)
for (let i = 0; i < length; i++) {
outputData[i] += (Math.random() * 2 - 1) * 0.0005;
}

// Apply gentle low-pass filter
let prevSample = outputData[0];
const alpha = 0.20; // Filter strength

for (let i = 0; i < length; i++) {
prevSample = outputData[i] = prevSample + alpha * (outputData[i] - prevSample);
}
}

return processedBuffer;
}
// Add this helper function to find zero crossings
function findBestZeroCrossings(buffer, rawStartSample, rawEndSample) {
const searchWindowSamples = Math.ceil(buffer.sampleRate * 0.01); // 10ms search window
let startSample = rawStartSample;
let endSample = rawEndSample;

try {
// Get first channel data for analysis
const data = buffer.getChannelData(0);
const totalSamples = buffer.length;

// Find zero crossings near start position
const startCrossings = [];
const startMin = Math.max(0, rawStartSample - searchWindowSamples);
const startMax = Math.min(totalSamples - 2, rawStartSample + searchWindowSamples);

for (let i = startMin; i < startMax; i++) {
    // Detect rising zero crossing (negative to positive)
    if (data[i] <= 0 && data[i + 1] > 0) {
        startCrossings.push({
            index: i,
            slope: data[i + 1] - data[i],
            type: 'rising'
        });
    }
    // Detect falling zero crossing (positive to negative)
    else if (data[i] >= 0 && data[i + 1] < 0) {
        startCrossings.push({
            index: i,
            slope: data[i + 1] - data[i],
            type: 'falling'
        });
    }
}

// Find zero crossings near end position
const endCrossings = [];
const endMin = Math.max(0, rawEndSample - searchWindowSamples);
const endMax = Math.min(totalSamples - 2, rawEndSample + searchWindowSamples);

for (let i = endMin; i < endMax; i++) {
    if (data[i] <= 0 && data[i + 1] > 0) {
        endCrossings.push({
            index: i,
            slope: data[i + 1] - data[i],
            type: 'rising'
        });
    }
    else if (data[i] >= 0 && data[i + 1] < 0) {
        endCrossings.push({
            index: i,
            slope: data[i + 1] - data[i],
            type: 'falling'
        });
    }
}

console.log(`Found ${startCrossings.length} start and ${endCrossings.length} end zero crossings`);

// If we found zero crossings, match them by type and slope
if (startCrossings.length > 0 && endCrossings.length > 0) {
    let bestMatch = { score: -Infinity, start: rawStartSample, end: rawEndSample };
    
    for (const start of startCrossings) {
        for (const end of endCrossings) {
            // Score based on matching type and similar slope
            const typeScore = (start.type === end.type) ? 5 : -2;
            const slopeScore = 5 - Math.min(5, Math.abs(start.slope - end.slope) * 20);
            const distanceScore = 3 - Math.min(3, 
                (Math.abs(start.index - rawStartSample) + 
                 Math.abs(end.index - rawEndSample)) / (searchWindowSamples * 2) * 3);
            
            const score = typeScore + slopeScore + distanceScore;
            
            if (score > bestMatch.score) {
                bestMatch = {
                    score,
                    start: start.index,
                    end: end.index
                };
            }
        }
    }
    
    if (bestMatch.score > 0) {
        console.log(`Using zero crossings: start=${bestMatch.start}, end=${bestMatch.end}, score=${bestMatch.score.toFixed(2)}`);
        startSample = bestMatch.start;
        endSample = bestMatch.end;
    }
}
} catch (e) {
console.error("Error finding zero crossings:", e);
}

return { start: startSample, end: endSample };
}

function releaseSamplerNote(note) {
    if (!note || note.state !== "playing") {
        console.log(`releaseSamplerNote: Note ${note?.id} not playing, state: ${note?.state}`);
        return;
    }

    // Set parent voice state to releasing - FIX: Use samplerVoicePool not voicePool
    const voice = note.parentVoice || samplerVoicePool.find(v => v.samplerNote === note);
    if (voice && voice.state === 'playing') {
        voice.state = 'releasing';
        console.log(`releaseSamplerNote: Set voice ${voice.id} state to 'releasing'.`);
    }

    // Set component state and clear existing timers
    console.log(`releaseSamplerNote: Starting release for note ${note.id}`);
    note.state = "releasing";
    clearScheduledEventsForNote(note);

    // Handle loop state
    if (note.usesProcessedBuffer && note.crossfadeActive) {
        note.source.loop = false;
        note.looping = false;
    }

    // Apply release envelope
    const release = Math.max(0.01, parseFloat(D('release').value)); // Ensure minimum release time
    const now = audioCtx.currentTime;
    note.gainNode.gain.cancelScheduledValues(now);
    const currentGain = Math.max(0.001, note.gainNode.gain.value); // Ensure non-zero gain
    note.gainNode.gain.setValueAtTime(currentGain, now);
    note.gainNode.gain.linearRampToValueAtTime(0, now + release);

    // Schedule stop slightly after release ends
    const stopTime = now + release + 0.05;
    try {
        note.source.stop(stopTime);
    } catch (e) { /* Ignore errors */ }

    // CRUCIAL FIX: Ensure the kill timer is properly set and tracked
    const killDelay = Math.max(100, (release * 1000) + 100);
    const killTimer = trackSetTimeout(() => {
        console.log(`Release timer fired for ${note.id}, calling killSamplerNote`);
        killSamplerNote(note);
    }, killDelay, note); // <<< CRITICAL FIX: Pass the 'note' object here
    
    console.log(`releaseSamplerNote: Scheduled kill for ${note.id} in ${killDelay}ms`);
}

function killSamplerNote(note) {
    // Safety check: Don't kill notes within their safety period
    if (note && note.safeUntil && audioCtx.currentTime < note.safeUntil) {
        console.log(`killSamplerNote: Note ${note.id} is within safety period until ${note.safeUntil.toFixed(3)}. Ignoring kill request.`);
        return false;
    }
// Check if note is valid and not already killed
    if (!note) {
        console.warn(`killSamplerNote: Called with null note`);
        return false;
    }
    
    if (note.state === "killed") {
        console.log(`killSamplerNote: Note ${note.id} already killed, ignoring`);
        return false;
    }
    
    // CRITICAL FIX: Only proceed with kill if note is still in releasing state
    // This prevents kill timers from affecting notes that have been stolen
    if (note.state !== 'releasing') {
        console.log(`killSamplerNote: Note ${note.id} is in state '${note.state}', not 'releasing'. Ignoring kill timer.`);
        return false;
    }
    
    const noteId = note.id;
    const originalNoteNumber = note.noteNumber;
    console.log(`killSamplerNote: Starting kill process for ${noteId} (Original Note ${originalNoteNumber})`);


    // Mark as killed immediately to prevent further processing
    note.state = "killed";

    // Clear ALL scheduled events first
    clearScheduledEventsForNote(note);

    try {
        // Stop and disconnect audio nodes with immediate gain cut
        if (note.gainNode) {
            note.gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
            note.gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
            try { note.gainNode.disconnect(); } catch(e){ /* Ignore */ }
        }
        
        if (note.sampleNode) {
            try { note.sampleNode.disconnect(); } catch(e){ /* Ignore */ }
        }
        
        if (note.source) {
            try { note.source.stop(audioCtx.currentTime); } catch(e) { /* Ignore */ }
            try { note.source.disconnect(); } catch(e){ /* Ignore */ }
        }
    } catch (e) {
        console.warn(`killSamplerNote [${noteId}]: Error during node cleanup:`, e);
    }

    // --- Update Voice Pool State ---
    const voice = note.parentVoice;

    if (voice) {
        // Mark the component as inactive immediately
        note.state = 'inactive';
        note.noteNumber = null;
        
        // CRITICAL FIX: Only update voice state if this is the LAST component to be killed
        const allComponentsInactive = isVoiceFullyInactive(voice);
        
        if (allComponentsInactive && voice.state !== 'inactive') {
            console.log(`killSamplerNote [${noteId}]: Last component killed, marking voice ${voice.id} inactive.`);
            voice.state = 'inactive';
            voice.noteNumber = null;
            voice.startTime = 0;
            
            if (isMonoMode && currentMonoVoice === voice) {
                currentMonoVoice = null;
            }
            
            // Update UI only once when voice becomes fully inactive
            updateVoiceDisplay_Pool();
            updateKeyboardDisplay_Pool();
        } else {
            console.log(`killSamplerNote [${noteId}]: Voice ${voice.id} still has active/releasing components (${voice.state}).`);
        }
    } else {
        console.warn(`killSamplerNote [${noteId}]: Could not find parent voice during cleanup.`);
    }

    console.log(`killSamplerNote: Finished killing ${noteId}`);
    return true;
}



// --- Oscillator 1 Note Creation/Management ---


function releaseOsc1Note(note) {
    if (!note || note.state !== "playing") {
        return;
    }

    const voice = note.parentVoice;
    if (voice && voice.state === 'playing') {
        voice.state = 'releasing';
    }

    note.state = "releasing";
    clearScheduledEventsForNote(note);

    const release = Math.max(0.01, parseFloat(D('release').value));
    const now = audioCtx.currentTime;

    // CRITICAL FIX: First, cancel all previous ramps to ensure clean state
    note.gainNode.gain.cancelScheduledValues(now);
    
    // Get the current gain value for smooth transition
    const currentGain = Math.max(0.001, note.gainNode.gain.value);
    note.gainNode.gain.setValueAtTime(currentGain, now);
    
    // Apply release ramp
    note.gainNode.gain.linearRampToValueAtTime(0, now + release);

    // Close the gate at the end of the release time
    const gateParam = note.workletNode.parameters.get('gate');
    if (gateParam) {
        // CRITICAL FIX: Schedule gate close exactly at the end of release
        gateParam.setValueAtTime(1, now); // Ensure gate is open during release
        gateParam.setValueAtTime(0, now + release); // Close at end of release
    }

    // Schedule final cleanup
    const killDelay = Math.max(100, (release * 1000) + 100);
    trackSetTimeout(() => {
    killOsc1Note(note); // <<< CRITICAL FIX: Was killOsc2Note
}, killDelay, note);
}

function killOsc1Note(note) {
    // Safety check: Don't kill notes within their safety period
    if (note && note.safeUntil && audioCtx.currentTime < note.safeUntil) {
        console.log(`killOsc1Note: Note ${note.id} is within safety period until ${note.safeUntil.toFixed(3)}. Ignoring kill request.`);
        return false;
    }
    // Check if note is valid and not already killed
    if (!note) {
        console.warn(`killOsc1Note: Called with null note`);
        return false;
    }
    
    if (note.state === "killed") {
        console.log(`killOsc1Note: Note ${note.id} already killed, ignoring`);
        return false;
    }
    
    // CRITICAL FIX: Only proceed with kill if note is still in releasing state
    // This prevents kill timers from affecting notes that have been stolen
    if (note.state !== 'releasing') {
        console.log(`killOsc1Note: Note ${note.id} is in state '${note.state}', not 'releasing'. Ignoring kill timer.`);
        return false;
    }
    
    const noteId = note.id;
    const originalNoteNumber = note.noteNumber;
    console.log(`killOsc1Note: Starting kill process for ${noteId} (Original Note ${originalNoteNumber})`);

    
    // Mark as killed immediately to prevent further processing
    note.state = "killed";

    // Clear ALL scheduled events first
    clearScheduledEventsForNote(note);

    try {
        // Stop and disconnect audio nodes with immediate gain cut
        if (note.gainNode) {
            note.gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
            note.gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
            try { note.gainNode.disconnect(masterGain); } catch(e){ /* Ignore */ }
        }
        
        // Clean up FM modulator source
        if (note.fmModulatorSource) {
            try { note.fmModulatorSource.stop(audioCtx.currentTime); } catch(e) { /* Ignore */ }
            try { note.fmModulatorSource.disconnect(); } catch(e){ /* Ignore */ }
            note.fmModulatorSource = null; // Safe to nullify disposable source
        }
        
        // Disconnect FM depth gain
        if (note.fmDepthGain) {
            try { note.fmDepthGain.disconnect(); } catch(e){ /* Ignore */ }
            // Don't nullify, just disconnect - it will be reused
        }
    } catch (e) {
        console.warn(`killOsc1Note [${noteId}]: Error during node cleanup:`, e);
    }

    // --- Update Voice Pool State ---
    const voice = note.parentVoice;

    if (voice) {
        // Mark the component as inactive immediately
        note.state = 'inactive';
        note.noteNumber = null;
        
        // CRITICAL FIX: Only update voice state if this is the LAST component to be killed
        const allComponentsInactive = isVoiceFullyInactive(voice);
        
        if (allComponentsInactive && voice.state !== 'inactive') {
            console.log(`killOsc1Note [${noteId}]: Last component killed, marking voice ${voice.id} inactive.`);
            voice.state = 'inactive';
            voice.noteNumber = null;
            voice.startTime = 0;
            
            if (isMonoMode && currentMonoVoice === voice) {
                currentMonoVoice = null;
            }
            
            // Update UI only once when voice becomes fully inactive
            updateVoiceDisplay_Pool();
            updateKeyboardDisplay_Pool();
        } else {
            console.log(`killOsc1Note [${noteId}]: Voice ${voice.id} still has active/releasing components (${voice.state}).`);
        }
    } else {
        console.warn(`killOsc1Note [${noteId}]: Could not find parent voice during cleanup.`);
    }

    console.log(`killOsc1Note: Finished killing ${noteId}`);
    return true;
}

/**
 * Initiates the release phase for an Oscillator 2 note.
 * @param {object} note - The Osc2 note object.
 */
function releaseOsc2Note(note) {
    if (!note || note.state !== "playing") {
        return;
    }

    const voice = note.parentVoice;
    if (voice && voice.state === 'playing') {
        voice.state = 'releasing';
    }

    note.state = "releasing";
    clearScheduledEventsForNote(note);

    const release = Math.max(0.01, parseFloat(D('release').value));
    const now = audioCtx.currentTime;

    // CRITICAL FIX: First, cancel all previous ramps to ensure clean state
    note.gainNode.gain.cancelScheduledValues(now);
    
    // Get the current gain value for smooth transition
    const currentGain = Math.max(0.001, note.gainNode.gain.value);
    note.gainNode.gain.setValueAtTime(currentGain, now);
    
    // Apply release ramp
    note.gainNode.gain.linearRampToValueAtTime(0, now + release);

    // Close the gate at the end of the release time
    const gateParam = note.workletNode.parameters.get('gate');
    if (gateParam) {
        // CRITICAL FIX: Schedule gate close exactly at the end of release
        gateParam.setValueAtTime(1, now); // Ensure gate is open during release
        gateParam.setValueAtTime(0, now + release); // Close at end of release
    }

    // Schedule final cleanup
    const killDelay = Math.max(100, (release * 1000) + 100);
    trackSetTimeout(() => {
        killOsc2Note(note);
    }, killDelay, note);
}

/**
 * Stops and disconnects all nodes associated with an Oscillator 2 note.
 * @returns {boolean} True if cleanup was attempted, false if note was invalid/already killed.
 */
function killOsc2Note(note) {
    // Safety check: Don't kill notes within their safety period
    if (note && note.safeUntil && audioCtx.currentTime < note.safeUntil) {
        console.log(`killOsc2Note: Note ${note.id} is within safety period until ${note.safeUntil.toFixed(3)}. Ignoring kill request.`);
        return false;
    }
    // Check if note is valid and not already killed
    if (!note) {
        console.warn(`killOsc2Note: Called with null note`);
        return false;
    }
    
    if (note.state === "killed") {
        console.log(`killOsc2Note: Note ${note.id} already killed, ignoring`);
        return false;
    }
    
    // CRITICAL FIX: Only proceed with kill if note is still in releasing state
    // This prevents kill timers from affecting notes that have been stolen
    if (note.state !== 'releasing') {
        console.log(`killOsc2Note: Note ${note.id} is in state '${note.state}', not 'releasing'. Ignoring kill timer.`);
        return false;
    }
    
    const noteId = note.id;
    const originalNoteNumber = note.noteNumber;
    console.log(`killOsc2Note: Starting kill process for ${noteId} (Original Note ${originalNoteNumber})`);

    
    // Mark as killed immediately to prevent further processing
    note.state = "killed";

    // Clear ALL scheduled events first
    clearScheduledEventsForNote(note);

    try {
        // Stop and disconnect audio nodes with immediate gain cut
        if (note.gainNode) {
            note.gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
            note.gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
            try { note.gainNode.disconnect(masterGain); } catch(e){ /* Ignore */ }
        }
        
        // Clean up FM modulator source
        if (note.fmModulatorSource) {
            try { note.fmModulatorSource.stop(audioCtx.currentTime); } catch(e) { /* Ignore */ }
            try { note.fmModulatorSource.disconnect(); } catch(e){ /* Ignore */ }
            note.fmModulatorSource = null; // Safe to nullify disposable source
        }
        
        // Disconnect FM depth gain
        if (note.fmDepthGain) {
            try { note.fmDepthGain.disconnect(); } catch(e){ /* Ignore */ }
            // Don't nullify, just disconnect - it will be reused
        }
    } catch (e) {
        console.warn(`killOsc2Note [${noteId}]: Error during node cleanup:`, e);
    }

    // --- Update Voice Pool State ---
    const voice = note.parentVoice;

    if (voice) {
        // Mark the component as inactive immediately
        note.state = 'inactive';
        note.noteNumber = null;
        
        // CRITICAL FIX: Only update voice state if this is the LAST component to be killed
        const allComponentsInactive = isVoiceFullyInactive(voice);
        
        if (allComponentsInactive && voice.state !== 'inactive') {
            console.log(`killOsc2Note [${noteId}]: Last component killed, marking voice ${voice.id} inactive.`);
            voice.state = 'inactive';
            voice.noteNumber = null;
            voice.startTime = 0;
            
            if (isMonoMode && currentMonoVoice === voice) {
                currentMonoVoice = null;
            }
            
            // Update UI only once when voice becomes fully inactive
            updateVoiceDisplay_Pool();
            updateKeyboardDisplay_Pool();
        } else {
            console.log(`killOsc2Note [${noteId}]: Voice ${voice.id} still has active/releasing components (${voice.state}).`);
        }
    } else {
        console.warn(`killOsc2Note [${noteId}]: Could not find parent voice during cleanup.`);
    }

    console.log(`killOsc2Note: Finished killing ${noteId}`);
    return true;
}
// --- Update updateOsc2FmModulatorParameters signature ---
/**
 * Updates or creates the FM modulator source and gain for an existing Osc2 note.
 * Called when FM source type changes or FM knob turned up from zero.
 * @param {object} osc2Note - The Osc2 note object.
 * @param {number} now - The current audio context time.
 * @param {object} [voice] - Optional: The parent voice object containing both osc1Note and osc2Note. Needed for 'osc1' source.
 */
function updateOsc2FmModulatorParameters(osc2Note, now, voice = null) {
    // --- Prerequisites Check ---
    const freqParam = osc2Note?.workletNode?.parameters.get('frequency');
    const prerequisitesMet = osc2Note &&
                              osc2Note.workletNode &&
                              freqParam &&
                              osc2FMAmount > 0.001; // Use Osc2 FM amount

    const noteId = osc2Note?.id || 'unknown'; // Get note ID for logging

    // --- Cleanup Existing FM if Prerequisites NOT Met ---
    if (!prerequisitesMet) {
        const reason = !osc2Note ? "no osc2Note" :
                       !osc2Note.workletNode ? "no workletNode" :
                       !freqParam ? "no frequency parameter" :
                       osc2FMAmount <= 0.001 ? "FM amount is zero" : "unknown";

        if (osc2Note?.fmModulatorSource || osc2Note?.fmDepthGain) {
             console.log(`updateOsc2FmModulatorParameters [${noteId}]: Prerequisites not met (${reason}). Stopping/disconnecting any existing FM.`);
        }
        if (osc2Note?.fmModulatorSource) {
            try { osc2Note.fmModulatorSource.stop(0); } catch(e) { /* Ignore */ }
            try { osc2Note.fmModulatorSource.disconnect(); } catch(e) { /* Ignore */ }
            osc2Note.fmModulatorSource = null;
        }
        if (osc2Note?.fmDepthGain) {
            try {
                if (freqParam) osc2Note.fmDepthGain.disconnect(freqParam);
                osc2Note.fmDepthGain.disconnect();
            } catch(e) { /* Ignore */ }
            osc2Note.fmDepthGain = null;
        }
        return;
    }
    // --- End Prerequisites Check / Cleanup ---

    // --- Prerequisites ARE Met ---
    console.log(`updateOsc2FmModulatorParameters [${noteId}]: Updating FM modulator (Source: ${osc2FMSource}, Amount: ${osc2FMAmount.toFixed(3)}).`);
    const noteNumber = osc2Note.noteNumber;

    try {
        // --- 1. Manage Gain Node ---
        if (!osc2Note.fmDepthGain) {
            osc2Note.fmDepthGain = audioCtx.createGain();
            console.log(`updateOsc2FmModulatorParameters [${noteId}]: Created NEW FM depth gain.`);
        } else {
            console.log(`updateOsc2FmModulatorParameters [${noteId}]: Reusing existing FM depth gain.`);
            try { osc2Note.fmDepthGain.disconnect(); } catch(e) { /* Ignore */ }
        }
        const scaledDepth = osc2FMAmount * osc2FMDepthScale; // Use Osc2 scale
        osc2Note.fmDepthGain.gain.cancelScheduledValues(now);
        osc2Note.fmDepthGain.gain.setTargetAtTime(scaledDepth, now, STANDARD_FADE_TIME / 3); // Use fraction of standard time

        // --- 2. Manage Source Node ---
        const currentSource = osc2Note.fmModulatorSource;
        let sourceTypeMatches = false;
    let newFmSource = null;
    let createdNewSource = false; // track whether we created a new node

    if (currentSource) {
        if (osc2FMSource === 'sampler' && currentSource instanceof AudioBufferSourceNode) {
            sourceTypeMatches = true;
        } else if (osc2FMSource === 'osc1' && currentSource instanceof OscillatorNode) {
            sourceTypeMatches = true;
        }
    }

        if (sourceTypeMatches) {
        // Reuse existing source; DO NOT call start() again
        newFmSource = currentSource;

            if (osc2FMSource === 'sampler') {
                // Update Sampler Source Parameters (same logic as in Osc1 update)
                const source = newFmSource;
                let calculatedRate = 1.0; if (isSampleKeyTrackingOn) { calculatedRate = TR2 ** (noteNumber - 12); }
                source.playbackRate.cancelScheduledValues(now);
                source.playbackRate.setTargetAtTime(calculatedRate, now, 0.01);
                source.detune.cancelScheduledValues(now);
                source.detune.setTargetAtTime(currentSampleDetune, now, 0.01);
                // Loop settings (simplified reuse logic)
                let loopStartTime = 0; let loopEndTime = source.buffer ? source.buffer.duration : 0;
                let targetLoop = isSampleLoopOn;
                const seemsOriginal = source.loopStart > 0 || (source.buffer && source.loopEnd < source.buffer.duration - 0.001);
                if (seemsOriginal && audioBuffer) {
                    loopStartTime = sampleStartPosition * audioBuffer.duration; loopEndTime = sampleEndPosition * audioBuffer.duration; targetLoop = isSampleLoopOn;
                } else { targetLoop = isSampleLoopOn; loopStartTime = 0; loopEndTime = source.buffer ? source.buffer.duration : 0; }
                if (source.loop !== targetLoop) source.loop = targetLoop;
                if (targetLoop) {
                    if (Math.abs(source.loopStart - loopStartTime) > 0.001) source.loopStart = loopStartTime;
                    if (Math.abs(source.loopEnd - loopEndTime) > 0.001) source.loopEnd = loopEndTime;
                }
                console.log(`updateOsc2FmModulatorParameters [${noteId}]: Updated reused sampler FM source params.`);

            } else if (osc2FMSource === 'osc1') {
                // Update Oscillator Source Parameters (mirroring Osc1)
                const source = newFmSource;
                const osc1Note = voice?.osc1Note; // Get Osc1 note from voice
                let targetFreq = noteToFrequency(noteNumber, osc1OctaveOffset); // Use Osc1 octave
                let targetDetune = osc1Detune; // Use Osc1 detune

                if (osc1Note && osc1Note.workletNode) { // Check active Osc1 note
                    try {
                        const currentFreqParam = osc1Note.workletNode.parameters.get('frequency');
                        const currentDetuneParam = osc1Note.workletNode.parameters.get('detune');
                        if (currentFreqParam) targetFreq = currentFreqParam.value;
                        if (currentDetuneParam) targetDetune = currentDetuneParam.value;
                    } catch(e) { /* Use globals if error */ }
                }
                source.frequency.cancelScheduledValues(now);
                source.frequency.setTargetAtTime(targetFreq, now, 0.01);
                source.detune.cancelScheduledValues(now);
                source.detune.setTargetAtTime(targetDetune, now, 0.01);
                const targetType = osc1Waveform === 'pulse' ? 'square' : osc1Waveform; // Use Osc1 waveform
                if (source.type !== targetType) source.type = targetType;
                console.log(`updateOsc2FmModulatorParameters [${noteId}]: Updated reused oscillator FM source params (mirroring Osc1).`);
            }
        } else {
        // Replace source
        if (currentSource) {
            try { currentSource.stop(0); } catch(e) {}
            try { currentSource.disconnect(); } catch(e) {}
            osc2Note.fmModulatorSource = null;
        }

            if (osc2FMSource === 'sampler') {
                // Create Sampler Source (same logic as in Osc1 update)
                 if (!audioBuffer) {
                     console.error(`updateOsc2FmModulatorParameters [${noteId}]: Sampler FM selected, but no audioBuffer loaded. Skipping FM connection.`);
                     if (osc2Note.fmDepthGain) { try { osc2Note.fmDepthGain.disconnect(); } catch(e) {} osc2Note.fmDepthGain = null; }
                     return;
                }
                newFmSource = audioCtx.createBufferSource();
                let useOriginalBuffer = true; let sourceBuffer = audioBuffer; let bufferType = "original_fm_osc2";
                if (isSampleLoopOn && sampleCrossfadeAmount > 0.01 && cachedCrossfadedBuffer) { sourceBuffer = cachedCrossfadedBuffer; useOriginalBuffer = false; bufferType = "crossfaded_fm_osc2"; }
                else if (fadedBuffer && (!isSampleLoopOn || sampleCrossfadeAmount <= 0.01)) { sourceBuffer = fadedBuffer; useOriginalBuffer = false; bufferType = "faded_fm_osc2"; }
                if (!sourceBuffer || !(sourceBuffer instanceof AudioBuffer)) {
                     console.error(`updateOsc2FmModulatorParameters [${noteId}]: Invalid sourceBuffer selected for FM (type: ${bufferType}). Skipping FM connection.`);
                     newFmSource = null; if (osc2Note.fmDepthGain) { try { osc2Note.fmDepthGain.disconnect(); } catch(e) {} osc2Note.fmDepthGain = null; } return;
                }
                newFmSource.buffer = sourceBuffer; console.log(`updateOsc2FmModulatorParameters [${noteId}]: Using ${bufferType} buffer for NEW FM source.`);
                let calculatedRate = 1.0; if (isSampleKeyTrackingOn) { calculatedRate = TR2 ** (noteNumber - 12); }
                newFmSource.playbackRate.value = calculatedRate; newFmSource.detune.value = currentSampleDetune;
                let loopStartTime = 0; let loopEndTime = sourceBuffer.duration;
                if (useOriginalBuffer) {
                    if (isSampleLoopOn) { newFmSource.loop = true; loopStartTime = sampleStartPosition * audioBuffer.duration; loopEndTime = sampleEndPosition * audioBuffer.duration; newFmSource.loopStart = Math.max(0, loopStartTime); newFmSource.loopEnd = Math.min(audioBuffer.duration, loopEndTime); if (newFmSource.loopEnd <= newFmSource.loopStart) { newFmSource.loopEnd = audioBuffer.duration; newFmSource.loopStart = 0; } }
                    else { newFmSource.loop = false; }
                } else { newFmSource.loop = isSampleLoopOn; }
                createdNewSource = true;
                console.log(`updateOsc2FmModulatorParameters [${noteId}]: NEW Sampler FM Loop=${newFmSource.loop}, Start=${newFmSource.loopStart.toFixed(3)}, End=${newFmSource.loopEnd.toFixed(3)}`);

            } else if (osc2FMSource === 'osc1') {
                // Create Oscillator Source (mirroring Osc1)
                newFmSource = audioCtx.createOscillator();
                newFmSource.type = osc1Waveform === 'pulse' ? 'square' : osc1Waveform; // Use Osc1 waveform
                const osc1Freq = noteToFrequency(noteNumber, osc1OctaveOffset); // Use Osc1 octave
                newFmSource.frequency.value = osc1Freq;
                newFmSource.detune.value = osc1Detune; // Use Osc1 detune
                createdNewSource = true;
                console.log(`updateOsc2FmModulatorParameters [${noteId}]: Created NEW basic OscillatorNode (${newFmSource.type}) mirroring Osc1 settings.`);
            }

           
        }

        // --- 3. Connect Nodes ---
        if (newFmSource && osc2Note.fmDepthGain && freqParam) {
        newFmSource.connect(osc2Note.fmDepthGain);
        osc2Note.fmDepthGain.connect(freqParam);
        if (createdNewSource) {
            const startTime = now + (STANDARD_FADE_TIME / 10);
            try { newFmSource.start(startTime); } catch(e) { console.warn('Osc2 FM start failed:', e); }
        }
        osc2Note.fmModulatorSource = newFmSource;
    } else {
             console.warn(`updateOsc2FmModulatorParameters [${noteId}]: Could not connect FM chain (gain or source missing).`);
             if (osc2Note.fmDepthGain) { try { osc2Note.fmDepthGain.disconnect(); } catch(e) {} osc2Note.fmDepthGain = null; }
             if (newFmSource) { try { newFmSource.disconnect(); } catch(e) {} }
             osc2Note.fmModulatorSource = null;
        }

    } catch (error) {
        console.error(`updateOsc2FmModulatorParameters [${noteId}]: Error during update:`, error);
        if (osc2Note.fmModulatorSource) { try { osc2Note.fmModulatorSource.stop(0); } catch(e){} try { osc2Note.fmModulatorSource.disconnect(); } catch(e){} }
        osc2Note.fmModulatorSource = null;
        if (osc2Note.fmDepthGain) { try { osc2Note.fmDepthGain.disconnect(); } catch(e){} }
        osc2Note.fmDepthGain = null;
    }
}

// --- End Oscillator 2 Note Functions ---
// --- Unified Note On/Off Handlers ---

function noteOn(noteNumber) {
    if (isModeTransitioning) return;
    
    const now = audioCtx.currentTime;

    // --- 1. PREPARATION & UI ---
    if (!heldNotes.includes(noteNumber)) {
        heldNotes.push(noteNumber);
        heldNotes.sort((a, b) => a - b);
    }
    // DELETE THESE TWO LINES FROM HERE
    // updateVoiceDisplay_Pool();
    // updateKeyboardDisplay_Pool();
    
    const attack = Math.max(0.005, parseFloat(D('attack').value));
    const decay = parseFloat(D('decay').value);
    const sustain = parseFloat(D('sustain').value);
    const release = parseFloat(D('release').value);

    // --- 2. VOICE ALLOCATION ---
    let voice = null;
    let samplerVoice = null;
    let wasStolen = false;
    let wasSamplerStolen = false;

    // --- NEW: More Robust Phase Lock Logic ---
    // Determine if the voice to be used was recently active, which means we should preserve phase.
    let shouldPreservePhase = false;
    if (isMonoMode && currentMonoVoice && currentMonoVoice.state !== 'inactive') {
        shouldPreservePhase = true;
    } else if (!isMonoMode) {
        // In poly mode, we peek at the voice we are about to find.
        const peekVoice = findAvailableVoice(noteNumber, true); // Peek without allocating
        if (peekVoice && peekVoice.wasStolen) {
            shouldPreservePhase = true;
        }
    }
    // --- END NEW ---


    // Allocate oscillator voice
    if (isMonoMode) {
        if (currentMonoVoice && currentMonoVoice.state !== 'inactive') {
            voice = currentMonoVoice;
            wasStolen = true;
        } else {
            voice = findAvailableVoice(noteNumber);
            if (!voice) { console.error("Mono NoteOn: No voices available!"); return; }
            currentMonoVoice = voice;
        }
    } else {
        voice = findAvailableVoice(noteNumber);
        if (!voice) { console.error("Poly NoteOn: No voices available!"); return; }
        wasStolen = voice.wasStolen;
    }

    // --- MODIFIED: Apply the phase lock based on our earlier check ---
    if (shouldPreservePhase || wasStolen) {
        // When a voice is stolen or was very recently active, lock its phase.
        if (voice) {
            voice.preservePhase = true;
            setTimeout(() => {
                if (voice) voice.preservePhase = false;
            }, 50); // Lock phase for 50ms, long enough to cover rapid re-triggers.
        }
    } else {
        // It's a genuinely new note, so no phase preservation is needed.
        if (voice) voice.preservePhase = false;
    }
    // --- END MODIFIED ---

    // Allocate sampler voice
    samplerVoice = findAvailableSamplerVoice(noteNumber);
    if (samplerVoice) {
        wasSamplerStolen = samplerVoice.wasStolen;
        if (isMonoMode) currentMonoSamplerVoice = samplerVoice;
    }

    // --- 3. VOICE CONFIGURATION ---
    const noteStartTime = now;

    // Helper to re-trigger a component, preserving gain and gliding pitch.
    const retriggerComponent = (component, targetPitchProvider, isSampler = false) => {
        if (!component) return;
        
        // For samplers, the source can be stopped and needs to be replaced.
        if (isSampler) {
            if (component.source) { try { component.source.stop(0); } catch(e){} }
            component.source = audioCtx.createBufferSource();
            component.source.connect(component.sampleNode);
            try { component.source.start(now); } catch(e) { console.warn(`retriggerComponent: Failed to start new sampler source for ${component.id}`, e); return; }
        }

        // Set state to 'playing' BEFORE clearing timers to invalidate old kill timers.
        component.state = 'playing';
        component.noteNumber = noteNumber;
        component.startTime = noteStartTime;
        clearScheduledEventsForNote(component);

        // 1. Glide Pitch
        const pitchParam = isSampler ? component.source.playbackRate : component.workletNode.parameters.get('frequency');
        if (isPortamentoOn && pitchParam) {
            const glideDuration = (glideTime > 0.001) ? glideTime : 0.005;
            const targetPitch = targetPitchProvider();
            pitchParam.cancelScheduledValues(now);
            pitchParam.setValueAtTime(pitchParam.value, now); // Start glide from current value.
            pitchParam.setTargetAtTime(targetPitch, now, glideDuration / 4);
        } else if (pitchParam) {
            pitchParam.setValueAtTime(targetPitchProvider(), now);
        }

        // For samplers, update buffer and loop settings on the new source
        if (isSampler) {
            let sourceBuffer = audioBuffer;
            if (isSampleLoopOn && sampleCrossfadeAmount > 0.01 && cachedCrossfadedBuffer) sourceBuffer = cachedCrossfadedBuffer;
            else if (fadedBuffer && (!isSampleLoopOn || sampleCrossfadeAmount <= 0.01)) sourceBuffer = fadedBuffer;
            else if (isEmuModeOn) sourceBuffer = applyEmuProcessing(audioBuffer);
            
            component.source.buffer = sourceBuffer;
            component.source.loop = isSampleLoopOn;
            if (isSampleLoopOn) {
                component.source.loopStart = sampleStartPosition * sourceBuffer.duration;
                component.source.loopEnd = sampleEndPosition * sourceBuffer.duration;
            }
        }

        // For oscillators, reset the gate.
        if (!isSampler && component.workletNode) {
            const gateParam = component.workletNode.parameters.get('gate');
            if (gateParam) {
                gateParam.cancelScheduledValues(now);
                gateParam.setValueAtTime(1, now);
            }
        }

        // 2. Re-trigger ADSR Envelope from its current level.
        if (!(isMonoMode && isLegatoMode)) {
            const gainParam = component.gainNode.gain;
            gainParam.cancelScheduledValues(now);
            gainParam.setValueAtTime(gainParam.value, now); // THIS IS THE KEY: Start from current gain.
            gainParam.linearRampToValueAtTime(1.0, now + attack);
            gainParam.linearRampToValueAtTime(sustain, now + attack + decay);
        }
    };

    // Helper to configure a fresh component from an inactive state.
    const configureNewComponent = (component, targetPitchProvider, isSampler = false) => {
        if (!component) return;
        
        component.noteNumber = noteNumber;
        component.startTime = noteStartTime;
        component.state = 'playing';
        clearScheduledEventsForNote(component);

        if (!isSampler) { // Oscillator setup
            component.workletNode.parameters.get('gate').setValueAtTime(1, noteStartTime);
            
            // --- MODIFIED: Check the phase lock before resetting ---
            const phaseResetParam = component.workletNode.parameters.get('phaseReset');
            // Only reset phase if the voice is NOT in a phase-locked (stolen) state.
            if (phaseResetParam && (!component.parentVoice || !component.parentVoice.preservePhase)) {
                phaseResetParam.setValueAtTime(noteStartTime, noteStartTime);
            }
            // --- END MODIFIED ---

            const isOsc1 = component.type === 'osc1';
            const waveMap = { sine: 0, sawtooth: 1, triangle: 2, square: 3, pulse: 4 };
            component.workletNode.parameters.get('frequency').setValueAtTime(targetPitchProvider(), noteStartTime);
            component.workletNode.parameters.get('detune').setValueAtTime(isOsc1 ? osc1Detune : osc2Detune, noteStartTime);
            component.workletNode.parameters.get('waveformType').setValueAtTime(waveMap[isOsc1 ? osc1Waveform : osc2Waveform] ?? 0, noteStartTime);
            component.workletNode.parameters.get('holdAmount').setValueAtTime(isOsc1 ? osc1PWMValue : osc2PWMValue, noteStartTime);
            component.workletNode.parameters.get('quantizeAmount').setValueAtTime(isOsc1 ? osc1QuantizeValue : osc2QuantizeValue, noteStartTime);
            component.levelNode.gain.setValueAtTime(isOsc1 ? osc1GainValue : osc2GainValue, noteStartTime);
        } else { // Sampler setup
            if (component.source) try { component.source.stop(); } catch(e){}
            component.source = audioCtx.createBufferSource();
            
            let sourceBuffer = audioBuffer;
            if (isSampleLoopOn && sampleCrossfadeAmount > 0.01 && cachedCrossfadedBuffer) sourceBuffer = cachedCrossfadedBuffer;
            else if (fadedBuffer && (!isSampleLoopOn || sampleCrossfadeAmount <= 0.01)) sourceBuffer = fadedBuffer;
            else if (isEmuModeOn) sourceBuffer = applyEmuProcessing(audioBuffer);

            if (!sourceBuffer) { console.error(`configureNewComponent: No valid buffer for sampler`); return; }
            
            component.source.buffer = sourceBuffer;
            component.source.playbackRate.setValueAtTime(targetPitchProvider(), noteStartTime);
            component.source.detune.setValueAtTime(currentSampleDetune, noteStartTime);
            component.source.loop = isSampleLoopOn;
            if (isSampleLoopOn) {
                component.source.loopStart = sampleStartPosition * sourceBuffer.duration;
                component.source.loopEnd = sampleEndPosition * sourceBuffer.duration;
            }
            component.sampleNode.gain.setValueAtTime(currentSampleGain, noteStartTime);
            component.source.connect(component.sampleNode);
            component.source.start(noteStartTime);
        }

        // Start ADSR envelope from zero for a new note.
        const gainParam = component.gainNode.gain;
        gainParam.cancelScheduledValues(noteStartTime);
        gainParam.setValueAtTime(0, noteStartTime);
        gainParam.linearRampToValueAtTime(1.0, noteStartTime + attack);
        gainParam.linearRampToValueAtTime(sustain, noteStartTime + attack + decay);
        component.gainNode.connect(masterGain);
    };

    // --- APPLY LOGIC ---
    // This section is now simplified and works for both MONO and POLY.
    // The 'wasStolen' flag, correctly set by our improved findAvailableVoice,
    // determines whether to retrigger or configure anew.
    
    // Oscillator Voice
    if (wasStolen) {
        console.log(`noteOn: Retriggering stolen voice ${voice.id} for note ${noteNumber}`);
        retriggerComponent(voice.osc1Note, () => noteToFrequency(noteNumber, osc1OctaveOffset));
        retriggerComponent(voice.osc2Note, () => noteToFrequency(noteNumber, osc2OctaveOffset));
    } else {
        console.log(`noteOn: Configuring new voice ${voice.id} for note ${noteNumber}`);
        configureNewComponent(voice.osc1Note, () => noteToFrequency(noteNumber, osc1OctaveOffset));
        configureNewComponent(voice.osc2Note, () => noteToFrequency(noteNumber, osc2OctaveOffset));
    }
    
    // Sampler Voice
    if (audioBuffer && samplerVoice) {
        if (wasSamplerStolen) {
            retriggerComponent(samplerVoice.samplerNote, () => isSampleKeyTrackingOn ? TR2 ** (noteNumber - 12) : 1.0, true);
        } else {
            configureNewComponent(samplerVoice.samplerNote, () => isSampleKeyTrackingOn ? TR2 ** (noteNumber - 12) : 1.0, true);
        }
        samplerVoice.noteNumber = noteNumber;
        samplerVoice.startTime = now;
        samplerVoice.state = 'playing';
    }

    // Update main voice properties and FM.
    voice.noteNumber = noteNumber;
    voice.startTime = now;
    voice.state = 'playing';
    updateOsc1FmModulatorParameters(voice.osc1Note, now, voice);
    updateOsc2FmModulatorParameters(voice.osc2Note, now, voice);

    // --- 4. FINAL UPDATES ---
    lastPlayedNoteNumber = noteNumber;
    if (voice) voice.wasStolen = false;
    if (samplerVoice) samplerVoice.wasStolen = false;

    // ADD THE TWO LINES HERE, AT THE VERY END
    updateVoiceDisplay_Pool();
    updateKeyboardDisplay_Pool();
}

function noteOff(noteNumber, isForced = false) {
    // Block note off during mode transitions unless it's a forced release
    if (isModeTransitioning && !isForced) {
        console.log(`noteOff: Ignoring note ${noteNumber} during mode transition`);
        return;
    }
    
    console.log(`noteOff POOL: ${noteNumber}, Mono: ${isMonoMode}, Held: [${heldNotes.join(',')}]`);
    const now = audioCtx.currentTime;

    // CRITICAL FIX: Handle cleanup grace period
    if (window.cleanupGracePeriod) {
        console.log(`noteOff: Ignoring note-off for ${noteNumber} during cleanup grace period`);
        return;
    }

    // Remove from held notes list
    const initialHeldNotesCount = heldNotes.length;
    heldNotes = heldNotes.filter(n => n !== noteNumber);
    const noteWasActuallyHeld = heldNotes.length < initialHeldNotesCount;

    // CRITICAL FIX: Check if there are any active voices for this note even if not in heldNotes
    const hasActiveOscVoices = voicePool.some(voice => 
        voice.noteNumber === noteNumber && voice.state === 'playing'
    );
    const hasActiveSamplerVoices = samplerVoicePool.some(voice => 
        voice.noteNumber === noteNumber && voice.state === 'playing'
    );

    // If the note wasn't in the held list AND there are no active voices, it's a stray note-off
    if (!noteWasActuallyHeld && !hasActiveOscVoices && !hasActiveSamplerVoices) {
        console.warn(`noteOff: Received noteOff for ${noteNumber}, but it was not in the heldNotes list and has no active voices. Ignoring.`);
        return;
    }

    // If note wasn't held but has active voices, it means cleanup happened while key was held
    if (!noteWasActuallyHeld && (hasActiveOscVoices || hasActiveSamplerVoices)) {
        console.log(`noteOff: Note ${noteNumber} not in heldNotes but has active voices - processing noteOff anyway.`);
    }

    if (isMonoMode) {
        // --- MONO MODE OSCILLATOR LOGIC ---
        if (currentMonoVoice && currentMonoVoice.noteNumber === noteNumber) {
            if (heldNotes.length > 0) {
                const nextNote = heldNotes[heldNotes.length - 1];
                console.log(`Mono noteOff: Switching oscillator from ${noteNumber} to held note ${nextNote}`);
                // This will reuse the currentMonoVoice for the next note.
                // The sampler is handled separately below.
                noteOn(nextNote);
            } else {
                // No more held notes, release the oscillator voice.
                console.log(`Mono noteOff: Releasing mono oscillator voice ${currentMonoVoice.id}`);
                if (currentMonoVoice.osc1Note && currentMonoVoice.osc1Note.state === 'playing') {
                    releaseOsc1Note(currentMonoVoice.osc1Note);
                }
                if (currentMonoVoice.osc2Note && currentMonoVoice.osc2Note.state === 'playing') {
                    releaseOsc2Note(currentMonoVoice.osc2Note);
                }
            }
        }
        // --- END MONO OSCILLATOR LOGIC ---

    } else {
        // --- POLYPHONIC MODE OSCILLATOR LOGIC ---
        let foundOscVoices = [];
        for (const voice of voicePool) {
            if (voice.noteNumber === noteNumber && voice.state === 'playing') {
                foundOscVoices.push(voice);
            }
        }
        if (foundOscVoices.length > 0) {
            console.log(`Poly noteOff: Releasing ${foundOscVoices.length} oscillator voices for note ${noteNumber}`);
            foundOscVoices.forEach(voice => {
                if (voice.osc1Note && voice.osc1Note.state === 'playing') releaseOsc1Note(voice.osc1Note);
                if (voice.osc2Note && voice.osc2Note.state === 'playing') releaseOsc2Note(voice.osc2Note);
            });
        }
    }

    // --- UNIFIED SAMPLER NOTE-OFF LOGIC (FOR BOTH MONO AND POLY) ---
    const samplerVoicesToRelease = samplerVoicePool.filter(
        voice => voice.noteNumber === noteNumber && voice.state === 'playing'
    );

    if (samplerVoicesToRelease.length > 0) {
        console.log(`noteOff: Found and releasing ${samplerVoicesToRelease.length} sampler voice(s) for note ${noteNumber}.`);
        samplerVoicesToRelease.forEach(voice => {
            if (voice.samplerNote && voice.samplerNote.state === 'playing') {
                releaseSamplerNote(voice.samplerNote);
            }
        });
    }
    // --- END UNIFIED SAMPLER LOGIC ---

    updateVoiceDisplay_Pool();
    updateKeyboardDisplay_Pool();
}
function updateSampleProcessing() {
    console.log("Updating sample processing...");

    // Reset cached buffers
    fadedBuffer = null;
    cachedCrossfadedBuffer = null;
    lastCachedStartPos = null;
    lastCachedEndPos = null;
    lastCachedCrossfade = null;

    // <<< USE trackSetTimeout for outer delay >>>
    trackSetTimeout(() => {
        if (audioBuffer) {
    // STEP 1: First trim to the desired region WITH ZERO-CROSSING ALIGNMENT
    const totalSamples = audioBuffer.length;
    const rawStartSample = Math.floor(sampleStartPosition * totalSamples);
    const rawEndSample = Math.floor(sampleEndPosition * totalSamples);
    
    // Find zero-crossings near the start and end points
    const alignedPoints = findBestZeroCrossings(
        audioBuffer, 
        rawStartSample, 
        rawEndSample
    );
    
    const startSample = alignedPoints.start;
    const endSample = alignedPoints.end;
    const trimmedLength = Math.max(2, endSample - startSample);
    
    // Store original duration for accurate playback timing
    fadedBufferOriginalDuration = (endSample - startSample) / audioBuffer.sampleRate;
    
    const trimmedBuffer = audioCtx.createBuffer(
        audioBuffer.numberOfChannels,
        trimmedLength,
        audioBuffer.sampleRate
    );
    
    // Copy the trimmed section
    for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
        const origData = audioBuffer.getChannelData(channel);
        const newData = trimmedBuffer.getChannelData(channel);
        for (let i = 0; i < trimmedLength; i++) {
            newData[i] = origData[startSample + i];
        }
    }
    
    // STEP 2: Apply fades to the trimmed buffer
    let processedBuffer = trimmedBuffer;
    
    // Only apply fades if needed 
    if (sampleFadeInAmount > 0.01 || sampleFadeOutAmount > 0.01) {
        processedBuffer = audioCtx.createBuffer(
            trimmedBuffer.numberOfChannels,
            trimmedBuffer.length,
            trimmedBuffer.sampleRate
        );
        
        // Calculate fade lengths once
        const fadeInSamples = Math.floor(trimmedLength * sampleFadeInAmount);
        const fadeOutSamples = Math.floor(trimmedLength * sampleFadeOutAmount);
        
        for (let c = 0; c < trimmedBuffer.numberOfChannels; c++) {
            const inputData = trimmedBuffer.getChannelData(c);
            const outputData = processedBuffer.getChannelData(c);
            
            // Copy all samples first
            for (let i = 0; i < trimmedLength; i++) {
                outputData[i] = inputData[i];
            }
            
            // Apply fade in
            for (let i = 0; i < fadeInSamples; i++) {
                outputData[i] *= i / fadeInSamples;
            }
            
            // Apply fade out
            for (let i = 0; i < fadeOutSamples; i++) {
                const idx = trimmedLength - 1 - i;
                outputData[idx] *= i / fadeOutSamples;
            }
        }
    }
    
    // Store the trimmed and potentially faded buffer (pre-crossfade, pre-emu)
    let bufferForCrossfade = processedBuffer; // This is trimmed & potentially faded
    let finalFadedBuffer = processedBuffer; // This will hold the final non-crossfaded result

    // STEP 3: Handle crossfade OR Emu processing for non-crossfaded buffer
    if (isSampleLoopOn && sampleCrossfadeAmount > 0.01) {
        // --- Crossfade Path ---
        // Clear the non-crossfaded buffer reference as we'll use the cached one
        fadedBuffer = null;
        // Create crossfaded buffer in a timeout
        trackSetTimeout(() => {
            console.log("updateSampleProcessing: Creating crossfaded buffer...");
            const result = createCrossfadedBuffer(
                audioCtx,
                bufferForCrossfade, // Use the trimmed & faded buffer
                0, 1, // Use the whole processed buffer
                sampleCrossfadeAmount
            );

            if (result && result.buffer) {
                let crossfadedResultBuffer = result.buffer;
                // Apply E-mu processing AFTER crossfade if enabled
                if (isEmuModeOn) {
                    console.log("updateSampleProcessing: Applying Emu processing to crossfaded buffer.");
                    crossfadedResultBuffer = applyEmuProcessing(crossfadedResultBuffer);
                }
                cachedCrossfadedBuffer = crossfadedResultBuffer;
                lastCachedStartPos = sampleStartPosition;
                lastCachedEndPos = sampleEndPosition;
                lastCachedCrossfade = sampleCrossfadeAmount;
                console.log("updateSampleProcessing: Cached crossfaded buffer created/updated.");
            } else {
                console.warn("updateSampleProcessing: Crossfaded buffer creation failed.");
                cachedCrossfadedBuffer = null; // Invalidate cache
            }
        }, 10); // Short delay for async operation

    } else {
        // --- Non-Crossfade Path ---
        // Invalidate crossfade cache
        cachedCrossfadedBuffer = null;
        // Apply E-mu processing now if enabled
        if (isEmuModeOn) {
            console.log("updateSampleProcessing: Applying Emu processing to non-crossfaded buffer.");
            finalFadedBuffer = applyEmuProcessing(bufferForCrossfade); // Apply to trimmed/faded buffer
        }
        // Store the final result (trimmed, maybe faded, maybe Emu'd)
        fadedBuffer = finalFadedBuffer;
        console.log("updateSampleProcessing: Faded (non-crossfade) buffer created/updated.");
    }

} else {
    // No audio buffer loaded
    fadedBuffer = null;
    cachedCrossfadedBuffer = null;

}
}, 10); // Existing timeout
}
// Add MIDI controller support to overcome keyboard limitations
function setupMIDIAccess() {
if (!navigator.requestMIDIAccess) {
console.log("WebMIDI not supported in this browser");
return;
}

navigator.requestMIDIAccess()
.then(onMIDISuccess, onMIDIFailure);

function onMIDISuccess(midiAccess) {
console.log("MIDI access obtained");

// Get lists of available MIDI controllers
const inputs = midiAccess.inputs.values();

// Connect to all available inputs
for (let input = inputs.next(); input && !input.done; input = inputs.next()) {
input.value.onmidimessage = onMIDIMessage;
console.log("Connected to MIDI device: " + input.value.name);
}

// Listen for new devices being connected
midiAccess.onstatechange = function(e) {
if (e.port.type === "input" && e.port.state === "connected") {
e.port.onmidimessage = onMIDIMessage;
console.log("Connected to MIDI device: " + e.port.name);
}
};
}

function onMIDIFailure(msg) {
console.error("Failed to get MIDI access - " + msg);
}

function onMIDIMessage(event) {
// Extract MIDI data
const [command, note, velocity] = event.data;

// Note on (144-159) with velocity > 0
if ((command >= 144 && command <= 159) && velocity > 0) {
// Convert MIDI note numbers (starts at 21 for A0) to our note system (starts at 0)
const ourNoteNumber = Math.max(0, note - 36); // Adjust offset as needed
noteOn(ourNoteNumber);
} 
// Note off (128-143) or note on with velocity 0
else if ((command >= 128 && command <= 143) || 
     (command >= 144 && command <= 159 && velocity === 0)) {
const ourNoteNumber = Math.max(0, note - 36); // Adjust offset as needed
noteOff(ourNoteNumber);
}
}
}

// Detect iOS device
function isIOS() {
return /iPad|iPhone|iPod/.test(navigator.userAgent) || 
 (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// Only show the unlock overlay on iOS devices
setTimeout(() => {
    console.log("Creating startup overlay for audio unlock.");
    createiOSStartupOverlay(audioCtx); // Use the existing overlay function
}, 100);

// Add explicit touch handling for iOS throughout your UI
function addIOSTouchHandlers() {
// Add touch handlers to all interactive elements
const touchElements = document.querySelectorAll('.key, .knob, .button, .switch-container, .vertical-switch');

touchElements.forEach(el => {
el.addEventListener('touchstart', function(e) {
// Ensure audio context is resumed on any touch
if (audioCtx.state === 'suspended') {
audioCtx.resume().then(() => {
  console.log('AudioContext resumed by user interaction');
});
}
// Don't prevent default here to allow the original handlers to work
});
});
}


document.addEventListener('DOMContentLoaded', () => {






// Optional: add touch events for mobile (touchstart/touchmove/touchend)
});

// CLEAN UP - Delete redundant and outdated event listeners
// Keep only this consolidated event listener for initialization
document.addEventListener('DOMContentLoaded', function() {
// Core functionality

updateSliderValues();
updateVoiceDisplay_Pool();
updateADSRVisualization();
// Initialize Keyboard Module
initializeKeyboard('keyboard', noteOn, noteOff, updateKeyboardDisplay_Pool);

// Initialize controls
fixAllKnobs(knobInitializations, knobDefaults); // <-- Add this line, passing dependencies

const fmSourceSwitchElement = D('osc1-fm-source-switch');
if (fmSourceSwitchElement) {
    const fmSwitchControl = initializeSwitch(fmSourceSwitchElement, {
        // <<< SWAP Tooltip Text Here >>>
        onText: 'Osc 2',  // Visually UP state label (but corresponds to isActive=false)
        offText: 'Sampler', // Visually DOWN state label (but corresponds to isActive=true)
        onChange: (isActive) => {
            // Logic remains inverted: isActive=true (DOWN) -> 'osc2', isActive=false (UP) -> 'sampler'
            const newSource = isActive ? 'osc2' : 'sampler';

            console.log(`Osc1 FM Switch onChange: Internal isActive=${isActive}, Determined newSource=${newSource}, current global osc1FMSource=${osc1FMSource}`);

            if (newSource !== osc1FMSource) {
                osc1FMSource = newSource;
                console.log(`Osc1 FM Source variable updated to: ${osc1FMSource}`);
                const nowSwitch = audioCtx.currentTime;

                // <<< CHANGE: Iterate over voicePool >>>
                voicePool.forEach(voice => {
                    // Update FM for active voices that have an Osc1 component
                    if (voice.state !== 'inactive' && voice.osc1Note) {
                        console.log(`Osc1 FM Switch: Updating FM for active voice ${voice.id}`);
                        updateOsc1FmModulatorParameters(voice.osc1Note, nowSwitch, voice);
                    }
                });
                // <<< END CHANGE >>>
            } else {
                 console.log(`Osc1 FM Switch onChange: Source already set to ${newSource}. No update needed.`);
            }
        }
    });

    // Initial state logic remains the same (based on inverted isActive)
    const shouldBeActiveInitially = (osc1FMSource === 'osc2'); // False if default is 'sampler'
    fmSwitchControl.setValue(shouldBeActiveInitially);
    console.log(`Osc1 FM Switch Initial State: Default source='${osc1FMSource}', Setting internal isActive to ${shouldBeActiveInitially} (assuming inverted state)`);



} else {
    console.warn("Osc1 FM Source Switch element not found!");
}
// initializeSpecialButtons(); // <-- Remove this line
initializeSpecialButtons( // <-- Add this line, passing dependencies/callbacks
    (newState) => { isEmuModeOn = newState; }, // Callback for Emu mode toggle
    updateSampleProcessing, // Pass function reference
    updateSamplePlaybackParameters, // Pass function reference
    voicePool, // <<< CHANGE: Pass voicePool>>>
    heldNotes // Pass array reference
);

// fixSwitchesTouchMode(); // <-- Remove this line
fixSwitchesTouchMode(
    (newState) => { 
        // First clean up ALL notes and reset state
        cleanupAllNotes(); 
        
        // Then set the mode
        isMonoMode = newState;
        console.log('>>> Mono Mode SET:', isMonoMode);
        
        // No delays or grace periods - just ready for new notes immediately
    },
    (newState) => { 
        isLegatoMode = newState; // Direct assignment
        console.log('>>> Legato Mode SET:', isLegatoMode); 
    },
    (newState) => {
        isPortamentoOn = newState; // Direct assignment
        console.log('>>> Portamento SET TO:', newState, 'Global value now:', isPortamentoOn);
    },
    cleanupAllNotes
);


fixMicRecording(audioCtx, handleRecordingComplete);
preventScrollOnControls();

// Initialize Modulation Canvas
const modCanvasElement = document.getElementById('mod-canvas'); // Get the canvas element
if (modCanvasElement) {
    initializeModCanvas(modCanvasElement); // Call the initialization function
} else {
    console.error("Modulation canvas element not found!");
}
// Initialize Placeholder UI Elements
initializeUiPlaceholders();
// Initialize Oscillator 1 Octave Slider
const osc1OctaveSelector = D('osc1-octave-selector');
if (osc1OctaveSelector) {
    osc1OctaveSelector.addEventListener('input', (event) => {
        const sliderValue = parseInt(event.target.value, 10); // Value is 0-4

        // Map slider value (0, 1, 2, 3, 4) to octave offset (-2, -1, 0, 1, 2)
        const octaveOffsetMap = [-2, -1, 0, 1, 2];
        osc1OctaveOffset = octaveOffsetMap[sliderValue] || 0; // Default to 0 if mapping fails

        console.log(`Osc1 Octave Selector value: ${sliderValue}, Offset set to: ${osc1OctaveOffset}`);

        // Update frequency of all active Osc1 notes immediately
        const now = audioCtx.currentTime;
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            // Check if the voice is active and has the necessary Osc1 components
            if (voice.state !== 'inactive' && voice.osc1Note && voice.osc1Note.workletNode && voice.osc1Note.noteNumber !== null) {
                const targetFreq = noteToFrequency(voice.osc1Note.noteNumber, osc1OctaveOffset);
                const freqParam = voice.osc1Note.workletNode.parameters.get('frequency');
                if (freqParam) {
                    console.log(`Updating Worklet note ${voice.osc1Note.id} (Voice ${voice.id}) frequency to ${targetFreq.toFixed(2)} Hz`);
                    // Use setTargetAtTime for a slightly smoother transition
                    freqParam.setTargetAtTime(targetFreq, now, 0.01);
                } else {
                    console.warn(`Could not find frequency parameter for Osc1 note ${voice.osc1Note.id} (Voice ${voice.id})`);
                }
            }
        });
        // <<< END CHANGE >>>
    });

    // Set initial value on load (optional, if default value="2" isn't sufficient)
    // const initialSliderValue = parseInt(osc1OctaveSelector.value, 10);
    // const initialOctaveOffsetMap = [-2, -1, 0, 1, 2];
    // osc1OctaveOffset = initialOctaveOffsetMap[initialSliderValue] || 0;
    // console.log(`Osc1 Octave initial offset: ${osc1OctaveOffset}`);

} else {
    console.warn("Oscillator 1 Octave Selector element not found!");
}
function updatePWMKnobState() {
    const pwmKnobElement = D('osc1-pwm-knob');
    const pwmKnobContainer = pwmKnobElement ? pwmKnobElement.closest('.knob-container') : null;
    const isPulseOrSquare = (osc1Waveform === 'pulse' || osc1Waveform === 'square');

    if (pwmKnobContainer) {
        if (isPulseOrSquare) {
            pwmKnobContainer.classList.remove('disabled');
            pwmKnobElement.classList.remove('disabled');
        } else {
            pwmKnobContainer.classList.add('disabled');
            pwmKnobElement.classList.add('disabled');
            // Optionally hide tooltip if disabled
            const tooltip = pwmKnobContainer.querySelector('.knob-tooltip');
            if (tooltip) tooltip.style.opacity = '0';
        }
    }
}
// Initialize Oscillator 1 Wave Shape Selector
const osc1WaveSelector = D('osc1-wave-selector');
if (osc1WaveSelector) {

    // <<< Updated map including pulse >>>
    const waveMapSliderToName = ['sine', 'sawtooth', 'triangle', 'square', 'pulse'];
    const waveMapNameToWorkletType = { sine: 0, sawtooth: 1, triangle: 2, square: 3, pulse: 4 };

    osc1WaveSelector.addEventListener('input', (event) => {
        const sliderValue = parseInt(event.target.value, 10);
        const prevWaveform = osc1Waveform;
        const selectedWave = waveMapSliderToName[sliderValue] || 'triangle';

        if (selectedWave === prevWaveform) return;

        console.log(`Osc1 Wave changed from ${prevWaveform} to ${selectedWave}`);
        osc1Waveform = selectedWave; // Update global state

        // --- Update Active Notes ---
        const now = audioCtx.currentTime;
        const targetWaveformType = waveMapNameToWorkletType[osc1Waveform] !== undefined ? waveMapNameToWorkletType[osc1Waveform] : 0;

        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            // Check if the voice is active and has the necessary Osc1 components
            if (voice.state !== 'inactive' && voice.osc1Note && voice.osc1Note.workletNode && voice.osc1Note.state === 'playing') {
                const oscNote = voice.osc1Note;
                try {
                    // Update the waveformType parameter directly
                    const waveformParam = oscNote.workletNode.parameters.get('waveformType');
                    if (waveformParam) {
                        // waveformType is k-rate, so setValueAtTime is appropriate
                        waveformParam.setValueAtTime(targetWaveformType, now);
                        console.log(`Updated active note ${oscNote.id} (Voice ${voice.id}) waveform type to ${targetWaveformType} (${osc1Waveform})`);
                    } else {
                        console.warn(`Could not find waveformType parameter for note ${oscNote.id} (Voice ${voice.id})`);
                    }

                    // --- NO NEED TO RECREATE NODE ---
                    // The worklet handles different waveforms internally based on the parameter.
                    // Glide logic is handled by frequency/detune parameter updates elsewhere.

                } catch (e) {
                    console.error(`Error updating active Osc1 note ${oscNote?.id} (Voice ${voice.id}) waveform type:`, e);
                    // Consider killing note if update fails badly
                    // killOsc1Note(oscNote);
                }
            }
        });
        // <<< END CHANGE >>>
    });

} else {
    console.warn("Oscillator 1 Wave Selector element not found!");
}
// --- Modulation Source Button Logic ---
const modModeSelector = document.querySelector('.mod-mode-selector'); // Get the container
if (modModeSelector) {
    const modOptions = modModeSelector.querySelectorAll('.mode-option');

    // Function to update button states and global variable
    function setActiveModSource(sourceName) {
        currentModSource = sourceName; // Update global state

        // Deactivate all options within this selector
        modOptions.forEach(option => {
            option.classList.remove('active');
        });

        // Activate the selected option
        const activeOption = modModeSelector.querySelector(`.mode-option[data-mode="${sourceName}"]`);
        if (activeOption) {
            activeOption.classList.add('active');
        }

        console.log(`Modulation source set to: ${currentModSource}`);
        // TODO: Add logic here to show/hide relevant controls based on currentModSource
        // e.g., updateModCanvasDisplay(currentModSource);
        // e.g., showModControls(currentModSource);
    }

    // Add click listeners to each option
    modOptions.forEach(option => {
        option.addEventListener('click', () => {
            const sourceName = option.getAttribute('data-mode');
            if (sourceName) {
                setActiveModSource(sourceName);
            }
        });
    });

    // Set initial active button based on the default global variable
    setActiveModSource(currentModSource); // Initialize with the default

} else {
    console.warn("Modulation mode selector container (.mod-mode-selector) not found.");
}
// Set up special handling for touch devices
if (isTouchDevice()) {
setupAutoHideTooltips();
}
// iOS-specific handling
if (isIOS()) {
addIOSTouchHandlers();
document.body.style.touchAction = 'none';
document.body.style.overscrollBehavior = 'none';
}
// MIDI functionality
setupMIDIAccess();
// Start Node Monitoring (e.g., every 5 seconds)
startNodeMonitoring(5000); // <<< ADD THIS LINE
// Re-register any important listeners
if (D('audio-file')) {
D('audio-file').addEventListener('change', handleFileSelect);
}
// Add audio context resume handlers
const resumeAudioContext = function() {
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().then(() => {
            console.log('AudioContext resumed');
            
            // Also start Tone.js after resuming AudioContext
            if (Tone && Tone.start) {
                Tone.start().then(() => {
                    console.log('Tone.js started');
                }).catch(err => {
                    console.error('Error starting Tone.js:', err);
                });
            }
        });
    }
};
document.body.addEventListener('touchstart', resumeAudioContext, { passive: true });
document.body.addEventListener('mousedown', resumeAudioContext, { passive: true });
});
document.addEventListener('DOMContentLoaded', function() {
const selectButton = document.getElementById('lfo-select-button');
if (selectButton) {
selectButton.addEventListener('click', function() {
this.classList.toggle('active');
});
}

// Initialize the depth knob
const depthKnob = document.getElementById('lfo-depth-knob');
if (depthKnob) {
initializeKnob(depthKnob, (value) => {
const tooltip = createTooltipForKnob('lfo-depth-knob', value);
tooltip.textContent = `Depth: ${Math.round(value * 100)}%`;
tooltip.style.opacity = '1';
console.log('LFO Depth:', value.toFixed(2));
});
}
});
// Add this to your existing JavaScript
document.addEventListener('DOMContentLoaded', function() {
const reverseButton = document.getElementById('reverse-button');
if (reverseButton) {
reverseButton.addEventListener('click', function() {
this.classList.toggle('active');
isSampleReversed = this.classList.contains('active');

// If we have a sample loaded, process it
if (audioBuffer) {
// Store original buffer on first use if it doesn't exist
if (!originalBuffer) {
  originalBuffer = audioBuffer.slice();
}

// Apply reverse if needed
reverseBufferIfNeeded();
updateSampleProcessing(); // This updates fadedBuffer/cachedCrossfadedBuffer

// <<< CHANGE: Iterate over voicePool >>>
voicePool.forEach(voice => {
    if (voice.state !== 'inactive' && voice.samplerNote) {
        const note = voice.samplerNote; // Get the samplerNote component
        // Skip held notes
        if (heldNotes.includes(voice.noteNumber)) {
            console.log(`Reverse Button: Skipping update for held sampler note ${note.id}`);
            return;
        }
        console.log(`Reverse Button: Updating sampler note ${note.id}`);
        // updateSamplePlaybackParameters will pick up the correct buffer (original or reversed, processed)
        updateSamplePlaybackParameters(note);
    }
});
// <<< END CHANGE >>>
}

console.log('Sample Reverse:', isSampleReversed ? 'ON' : 'OFF');
});
}
// <<< INITIALIZE OSC 2 CONTROLS >>>

    // Initialize Oscillator 2 Octave Slider
    const osc2OctaveSelector = D('osc2-octave-selector');
    if (osc2OctaveSelector) {
        osc2OctaveSelector.addEventListener('input', (event) => {
            const sliderValue = parseInt(event.target.value, 10);
            const octaveOffsetMap = [-2, -1, 0, 1, 2];
            osc2OctaveOffset = octaveOffsetMap[sliderValue] || 0;
            console.log(`Osc2 Octave Selector value: ${sliderValue}, Offset set to: ${osc2OctaveOffset}`);
            // Update active Osc2 notes
            const now = audioCtx.currentTime;
            // <<< CHANGE: Iterate over voicePool >>>
            voicePool.forEach(voice => {
                // Check if the voice is active and has the necessary Osc2 components
                if (voice.state !== 'inactive' && voice.osc2Note && voice.osc2Note.workletNode && voice.osc2Note.noteNumber !== null) {
                    const targetFreq = noteToFrequency(voice.osc2Note.noteNumber, osc2OctaveOffset);
                    const freqParam = voice.osc2Note.workletNode.parameters.get('frequency');
                    if (freqParam) {
                        console.log(`Updating Osc2 Worklet note ${voice.osc2Note.id} (Voice ${voice.id}) frequency to ${targetFreq.toFixed(2)} Hz`);
                        freqParam.setTargetAtTime(targetFreq, now, 0.01); // Smooth transition
                    } else {
                         console.warn(`Could not find frequency parameter for Osc2 note ${voice.osc2Note.id} (Voice ${voice.id})`);
                    }
                }
            });
            // <<< END CHANGE >>>
        });
        // Set initial value based on default
        const initialSliderValueOsc2 = 2; // Assuming default value="2" (0 offset)
        const initialOctaveOffsetMapOsc2 = [-2, -1, 0, 1, 2];
        osc2OctaveOffset = initialOctaveOffsetMapOsc2[initialSliderValueOsc2] || 0;
    } else { console.warn("Oscillator 2 Octave Selector element not found!"); }

    // Initialize Oscillator 2 Wave Shape Selector
    const osc2WaveSelector = D('osc2-wave-selector');
    if (osc2WaveSelector) {
        const waveMapSliderToName = ['sine', 'sawtooth', 'triangle', 'square', 'pulse'];
        const waveMapNameToWorkletType = { sine: 0, sawtooth: 1, triangle: 2, square: 3, pulse: 4 };

        osc2WaveSelector.addEventListener('input', (event) => {
            const sliderValue = parseInt(event.target.value, 10);
            const selectedWave = waveMapSliderToName[sliderValue] || 'triangle';
            if (selectedWave === osc2Waveform) return;

            console.log(`Osc2 Wave changed to ${selectedWave}`);
            osc2Waveform = selectedWave; // Update global state

            // Update Active Notes
            const now = audioCtx.currentTime;
            const targetWaveformType = waveMapNameToWorkletType[osc2Waveform] !== undefined ? waveMapNameToWorkletType[osc2Waveform] : 0;
            // <<< CHANGE: Iterate over voicePool >>>
            voicePool.forEach(voice => {
                // Check if the voice is active and has the necessary Osc2 components
                if (voice.state !== 'inactive' && voice.osc2Note && voice.osc2Note.workletNode && voice.osc2Note.state === 'playing') {
                    const waveParam = voice.osc2Note.workletNode.parameters.get('waveformType');
                    if (waveParam) {
                        console.log(`Updating Osc2 note ${voice.osc2Note.id} (Voice ${voice.id}) waveform to ${targetWaveformType}`);
                        waveParam.setValueAtTime(targetWaveformType, now);
                    } else {
                         console.warn(`Could not find waveformType parameter for Osc2 note ${voice.osc2Note.id} (Voice ${voice.id})`);
                    }
                }
            });
            // <<< END CHANGE >>>
            updateOsc2PWMKnobState(); // Enable/disable PWM knob
        });
        // Set initial value based on default
        const initialSliderValueWaveOsc2 = 2; // Assuming default value="2" (triangle)
        osc2Waveform = waveMapSliderToName[initialSliderValueWaveOsc2] || 'triangle';
        updateOsc2PWMKnobState(); // Initial PWM knob state
    } else { console.warn("Oscillator 2 Wave Selector element not found!"); }

// Initialize Osc2 FM Source Switch
const osc2FmSourceSwitchElement = D('osc2-fm-source-switch');
if (osc2FmSourceSwitchElement) {
    const fmSwitchControl = initializeSwitch(osc2FmSourceSwitchElement, {
        // <<< FIX: Swap onText and offText >>>
        onText: 'Osc 1',  // UP = active = true (Now Osc 1)
        offText: 'Sampler', // DOWN = inactive = false (Now Sampler)
        onChange: (isActive) => {
            // <<< FIX: Update logic to match swapped text >>>
            const newSource = isActive ? 'osc1' : 'sampler';
            if (newSource !== osc2FMSource) {
                osc2FMSource = newSource;
                console.log(`Osc2 FM Source changed to: ${osc2FMSource}`);
                const nowSwitch = audioCtx.currentTime;
                // <<< CHANGE: Iterate over voicePool >>>
                voicePool.forEach(voice => {
                    if (voice.state !== 'inactive' && voice.osc2Note) {
                        console.log(`Osc2 FM Switch: Updating FM for active voice ${voice.id}`);
                        // Pass the voice object to updateOsc2FmModulatorParameters
                        updateOsc2FmModulatorParameters(voice.osc2Note, nowSwitch, voice);
                    }
                });
                // <<< END CHANGE >>>
            }
        }
    });
    // <<< FIX: Update initial setValue logic >>>
    fmSwitchControl.setValue(osc2FMSource === 'osc1'); // Set initial state (true if 'osc1')
    // Initial update for any pre-existing notes
    const nowInitOsc2FM = audioCtx.currentTime;
    // <<< CHANGE: Iterate over voicePool >>>
    voicePool.forEach(voice => {
        if (voice.state !== 'inactive' && voice.osc2Note) {
            console.log(`Osc2 FM Switch Initial: Updating FM for active voice ${voice.id}`);
            // Pass the voice object here too
            updateOsc2FmModulatorParameters(voice.osc2Note, nowInitOsc2FM, voice);
        }
    });
    // <<< END CHANGE >>>

} else { console.warn("Osc2 FM Source Switch element not found!"); }

// Initialize the Key-Track button (default: active)
const keyTrackButton = document.getElementById('keytrack-button');
    if (keyTrackButton) {
        // Set initial state (assuming default is ON)
        keyTrackButton.classList.add('active');
        isSampleKeyTrackingOn = true;

        keyTrackButton.addEventListener('click', function() {
            this.classList.toggle('active');
            isSampleKeyTrackingOn = this.classList.contains('active');
            console.log('Sample Key Tracking:', isSampleKeyTrackingOn ? 'ON' : 'OFF');
            const now = audioCtx.currentTime;

            // <<< CHANGE: Iterate over voicePool >>>
            voicePool.forEach(voice => {
                if (voice.state === 'inactive' || voice.noteNumber === null) return; // Skip inactive voices or those without a note number

                const noteNumber = voice.noteNumber; // Get the note number for this voice

                // Update Sampler Note
                if (voice.samplerNote && voice.samplerNote.source) {
                    const samplerSource = voice.samplerNote.source;
                    const targetRate = isSampleKeyTrackingOn ? TR2 ** (noteNumber - 12) : 1.0;
                    // Use setTargetAtTime for smoother transitions
                    samplerSource.playbackRate.setTargetAtTime(targetRate, now, 0.01);
                    // Detune always applies
                    samplerSource.detune.setTargetAtTime(currentSampleDetune, now, 0.01);
                    console.log(`KeyTrack [Voice ${voice.id} Sampler]: Set Rate=${targetRate.toFixed(3)}, Detune=${currentSampleDetune.toFixed(1)}`);
                }

                // Update Osc1 FM Modulator Source (if it's a sampler)
                if (osc1FMSource === 'sampler' && voice.osc1Note && voice.osc1Note.fmModulatorSource instanceof AudioBufferSourceNode) {
                    const fmSource = voice.osc1Note.fmModulatorSource;
                    const targetRate = isSampleKeyTrackingOn ? TR2 ** (noteNumber - 12) : 1.0;
                    fmSource.playbackRate.setTargetAtTime(targetRate, now, 0.01);
                    fmSource.detune.setTargetAtTime(currentSampleDetune, now, 0.01); // Apply sample detune
                    console.log(`KeyTrack [Voice ${voice.id} Osc1 FM]: Set Rate=${targetRate.toFixed(3)}, Detune=${currentSampleDetune.toFixed(1)}`);
                }

                // Update Osc2 FM Modulator Source (if it's a sampler)
                if (osc2FMSource === 'sampler' && voice.osc2Note && voice.osc2Note.fmModulatorSource instanceof AudioBufferSourceNode) {
                    const fmSource = voice.osc2Note.fmModulatorSource;
                    const targetRate = isSampleKeyTrackingOn ? TR2 ** (noteNumber - 12) : 1.0;
                    fmSource.playbackRate.setTargetAtTime(targetRate, now, 0.01);
                    fmSource.detune.setTargetAtTime(currentSampleDetune, now, 0.01); // Apply sample detune
                    console.log(`KeyTrack [Voice ${voice.id} Osc2 FM]: Set Rate=${targetRate.toFixed(3)}, Detune=${currentSampleDetune.toFixed(1)}`);
                }
            });
            // <<< END CHANGE >>>
        });
    }
});
// <<< ADD HELPER FUNCTION for Osc2 PWM Knob State >>>
function updateOsc2PWMKnobState() {
    const pwmKnobElement = D('osc2-pwm-knob');
    const pwmKnobContainer = pwmKnobElement ? pwmKnobElement.closest('.knob-container') : null;
    const isPulseOrSquare = (osc2Waveform === 'pulse' || osc2Waveform === 'square');

    if (pwmKnobContainer) {
        if (isPulseOrSquare) {
            pwmKnobContainer.classList.remove('disabled');
            pwmKnobElement?.classList.remove('disabled'); // Add null check
        } else {
            pwmKnobContainer.classList.add('disabled');
            pwmKnobElement?.classList.add('disabled'); // Add null check
            // Optionally hide tooltip
            const tooltip = pwmKnobContainer.querySelector('.tooltip'); // Correct selector
            if (tooltip) tooltip.style.opacity = '0';
        }
    }
}
