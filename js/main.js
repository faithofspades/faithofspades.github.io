import { createiOSStartupOverlay } from './ios.js';
import { initializeKnob } from './controls.js'; 
import { fixMicRecording, createCrossfadedBuffer } from './sampler.js'; 
import { initializeModCanvas, getModulationPoints } from './modCanvas.js';
import { initializeKeyboard, keys, resetKeyStates } from './keyboard.js';
import { fixAllKnobs, initializeSpecialButtons, fixSwitchesTouchMode } from './controlFixes.js'; 
import { initializeUiPlaceholders } from './uiPlaceholders.js'; 

const D = x => document.getElementById(x);
const TR2 = 2 ** (1.0 / 12.0);
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
Tone.setContext(audioCtx); // <<< ADD THIS LINE
const masterGain = audioCtx.createGain();
masterGain.gain.setValueAtTime(0.5, audioCtx.currentTime);
masterGain.connect(audioCtx.destination);
// --- Load AudioWorklet ---
let isWorkletReady = false;
audioCtx.audioWorklet.addModule('js/shape-hold-processor.js').then(() => {
    console.log('ShapeHoldProcessor AudioWorklet loaded successfully.');
    isWorkletReady = true;
    initializeVoicePool(); // <<< CALL INITIALIZATION HERE
}).catch(error => {
    console.error('Failed to load ShapeHoldProcessor AudioWorklet:', error);
    isWorkletReady = false; // Ensure flag is false on error
    // Handle error appropriately - maybe show a message to the user
});
// --- End Load AudioWorklet ---

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
            if (samplerNote && !samplerNote.killTimerId && !noteHasActiveTimeout(samplerNote)) { // Check for active tracked timer
                console.log(`Forcing gain to 0 and killing sampler note ${samplerNote.id} immediately on resume (was releasing when focus lost).`);
                try {
                    samplerNote.gainNode.gain.cancelScheduledValues(now);
                    samplerNote.gainNode.gain.setValueAtTime(0, now);
                } catch (e) { console.warn("Error setting gain to 0 on resume:", e); }
                killSamplerNote(samplerNote); // Use existing kill function
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
let isEmuModeOn = false;
let currentModSource = 'lfo';
let isSampleKeyTrackingOn = true;
let mediaRecorder = null;
let isSampleReversed = false;

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
        state: 'inactive', // 'inactive', 'playing', 'releasing'
        samplerNote: null,
        osc1Note: null,
        osc2Note: null,
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
 * Checks if all components of a voice are inactive or null.
 * @param {object} voice - The voice object.
 * @returns {boolean} True if the voice is effectively inactive.
 */
function isVoiceFullyInactive(voice) {
    if (!voice) return true; // A null voice is inactive

    const samplerInactive = !voice.samplerNote || voice.samplerNote.state === 'inactive' || voice.samplerNote.state === 'killed';
    const osc1Inactive = !voice.osc1Note || voice.osc1Note.state === 'inactive' || voice.osc1Note.state === 'killed';
    const osc2Inactive = !voice.osc2Note || voice.osc2Note.state === 'inactive' || voice.osc2Note.state === 'killed';

    return samplerInactive && osc1Inactive && osc2Inactive;
}
/**
 * Finds an available voice in the pool.
 * Prefers inactive voices, otherwise steals the oldest playing/releasing voice.
 * @returns {object|null} The found voice object or null if pool is empty.
 */
function findAvailableVoice() {
    if (voicePool.length === 0) {
        console.error("findAvailableVoice: Voice pool is empty!");
        return null;
    }

    // 1. Try to find an inactive voice (round-robin starting from nextVoiceIndex)
    for (let i = 0; i < voicePool.length; i++) {
        const index = (nextVoiceIndex + i) % voicePool.length;
        if (voicePool[index].state === 'inactive') {
            console.log(`findAvailableVoice: Found inactive voice ${index}`);
            nextVoiceIndex = (index + 1) % voicePool.length; // Update for next search
            return voicePool[index];
        }
    }

    // 2. No inactive voice found, steal the oldest voice (FIFO based on startTime)
    let oldestVoice = voicePool[0];
    for (let i = 1; i < voicePool.length; i++) {
        // Prioritize stealing releasing voices over playing ones if start times are close
        const isCurrentOldestReleasing = oldestVoice.state === 'releasing';
        const isCandidateReleasing = voicePool[i].state === 'releasing';

        if (isCandidateReleasing && !isCurrentOldestReleasing) {
            oldestVoice = voicePool[i]; // Prefer stealing releasing voice
        } else if (isCandidateReleasing === isCurrentOldestReleasing && voicePool[i].startTime < oldestVoice.startTime) {
            oldestVoice = voicePool[i]; // Steal older voice if states are same
        } else if (!isCandidateReleasing && !isCurrentOldestReleasing && voicePool[i].startTime < oldestVoice.startTime) {
             oldestVoice = voicePool[i]; // Steal older playing voice
        }
    }

    console.warn(`findAvailableVoice: No inactive voices. Stealing voice ${oldestVoice.index} (Note: ${oldestVoice.noteNumber}, State: ${oldestVoice.state})`);

    // --- Force immediate cleanup of the stolen voice ---
    clearScheduledEventsForVoice(oldestVoice); // Clear pending kill timers

    const now = audioCtx.currentTime;
    const veryShortFade = 0.005; // 5ms fade to prevent clicks

    // --- Immediate Cleanup for Sampler ---
    if (oldestVoice.samplerNote) {
        const note = oldestVoice.samplerNote;
        note.state = 'killed'; // Mark component state
        try {
            if (note.source) {
                note.source.stop(now + veryShortFade); // Stop slightly after fade
                // Disconnect source later or let noteOn handle it
            }
            if (note.gainNode) { // ADSR Gain
                note.gainNode.gain.cancelScheduledValues(now);
                // <<< USE SHORT RAMP DOWN instead of setValueAtTime(0) >>>
                note.gainNode.gain.setValueAtTime(note.gainNode.gain.value, now); // Start ramp from current value
                note.gainNode.gain.linearRampToValueAtTime(0, now + veryShortFade);
                // Disconnect from master later or let noteOn handle it
            }
            // Disconnect internal nodes later or let noteOn handle it
            // if (note.sampleNode) { ... }

            // Nullify the source reference on the note object as noteOn creates a new one anyway
            // note.source = null; // Let noteOn handle this overwrite
        } catch (e) { console.warn(`Error during immediate sampler cleanup for stolen voice ${oldestVoice.id}:`, e); }
    }

    // --- Immediate Cleanup for Osc1 ---
    if (oldestVoice.osc1Note) {
        const note = oldestVoice.osc1Note;
        note.state = 'killed'; // Mark component state
        try {
            if (note.gainNode) { // ADSR Gain
                note.gainNode.gain.cancelScheduledValues(now);
                // <<< USE SHORT RAMP DOWN instead of setValueAtTime(0) >>>
                note.gainNode.gain.setValueAtTime(note.gainNode.gain.value, now); // Start ramp from current value
                note.gainNode.gain.linearRampToValueAtTime(0, now + veryShortFade);
                // Disconnect from master later or let noteOn handle it
            }
            // Disconnect FM chain if it exists
            if (note.fmModulatorSource && note.fmDepthGain) {
                note.fmModulatorSource.stop(now + veryShortFade); // Stop slightly after fade
                // Disconnect later or let noteOn handle it
            }
            // Worklet node and level node remain connected internally for reuse
        } catch (e) { console.warn(`Error during immediate osc1 cleanup for stolen voice ${oldestVoice.id}:`, e); }
    }

    // --- Immediate Cleanup for Osc2 ---
    if (oldestVoice.osc2Note) {
        const note = oldestVoice.osc2Note;
        note.state = 'killed'; // Mark component state
        try {
            if (note.gainNode) { // ADSR Gain
                note.gainNode.gain.cancelScheduledValues(now);
                // <<< USE SHORT RAMP DOWN instead of setValueAtTime(0) >>>
                note.gainNode.gain.setValueAtTime(note.gainNode.gain.value, now); // Start ramp from current value
                note.gainNode.gain.linearRampToValueAtTime(0, now + veryShortFade);
                // Disconnect from master later or let noteOn handle it
            }
            // Disconnect FM chain if it exists
            if (note.fmModulatorSource && note.fmDepthGain) {
                note.fmModulatorSource.stop(now + veryShortFade); // Stop slightly after fade
                // Disconnect later or let noteOn handle it
            }
            // Worklet node and level node remain connected internally for reuse
        } catch (e) { console.warn(`Error during immediate osc2 cleanup for stolen voice ${oldestVoice.id}:`, e); }
    }
    // --- End Force Cleanup ---

    // Mark voice as inactive *immediately* so it can be reused now
    oldestVoice.state = 'inactive';
    oldestVoice.noteNumber = null; // Clear note number

    // Do NOT nullify component references (osc1Note, osc2Note, samplerNote) - noteOn needs them

    // Schedule a slightly delayed disconnect of the main gain nodes from masterGain
    // This ensures the short ramp completes before noteOn potentially reconnects.
    const disconnectDelay = veryShortFade + 0.002; // 7ms total
    trackSetTimeout(() => {
        try { oldestVoice.samplerNote?.gainNode?.disconnect(masterGain); } catch(e){}
        try { oldestVoice.osc1Note?.gainNode?.disconnect(masterGain); } catch(e){}
        try { oldestVoice.osc2Note?.gainNode?.disconnect(masterGain); } catch(e){}
        // Also disconnect internal sampler node
        try { oldestVoice.samplerNote?.sampleNode?.disconnect(oldestVoice.samplerNote?.gainNode); } catch(e){}
        // Disconnect FM sources/gains fully
        try { oldestVoice.osc1Note?.fmModulatorSource?.disconnect(); } catch(e){}
        try { oldestVoice.osc1Note?.fmDepthGain?.disconnect(); } catch(e){}
        try { oldestVoice.osc2Note?.fmModulatorSource?.disconnect(); } catch(e){}
        try { oldestVoice.osc2Note?.fmDepthGain?.disconnect(); } catch(e){}
        console.log(`findAvailableVoice: Delayed disconnect for stolen voice ${oldestVoice.id}`);
    }, disconnectDelay * 1000);


    nextVoiceIndex = (oldestVoice.index + 1) % voicePool.length; // Update for next search
    return oldestVoice;
}
/**
 * Clears scheduled timeouts and potentially other events for all components of a voice.
 * @param {object} voice - The voice object from the pool.
 */
function clearScheduledEventsForVoice(voice) {
    if (!voice) return;
    // console.log(`Clearing scheduled events for voice ${voice.id}`); // Optional log
    if (voice.samplerNote) clearScheduledEventsForNote(voice.samplerNote);
    if (voice.osc1Note) clearScheduledEventsForNote(voice.osc1Note);
    if (voice.osc2Note) clearScheduledEventsForNote(voice.osc2Note);
    // Clear any voice-level timers if added later
}

/**
 * Quickly fades out a note component's ADSR gain and schedules node stop/disconnect.
 * Used primarily for voice stealing.
 * @param {object} noteComponent - The note object (e.g., voice.samplerNote).
 * @param {number} fadeTime - The fade-out duration in seconds.
 */
function quickFadeOutAndStop(noteComponent, fadeTime) {
    if (!noteComponent || !noteComponent.gainNode || noteComponent.state === 'killed') return;

    const noteId = noteComponent.id || 'unknown_component';
    // console.log(`quickFadeOutAndStop: Fading ${noteId}`); // Optional log
    noteComponent.state = 'killed'; // Mark as killed immediately for stealing purposes

    try {
        const now = audioCtx.currentTime;
        const gainParam = noteComponent.gainNode.gain;

        // Ramp gain down quickly
        gainParam.cancelScheduledValues(now);
        gainParam.setValueAtTime(gainParam.value, now); // Start from current value
        gainParam.linearRampToValueAtTime(0, now + fadeTime);

        // Schedule stop/disconnect slightly after fade
        const cleanupDelayMs = (fadeTime * 1000) + 20; // 20ms buffer

        // Stop source node
        if (noteComponent.source && typeof noteComponent.source.stop === 'function') {
            try { noteComponent.source.stop(now + fadeTime + 0.01); } catch(e) {}
        } else if (noteComponent.fmModulatorSource && typeof noteComponent.fmModulatorSource.stop === 'function') {
             try { noteComponent.fmModulatorSource.stop(now + fadeTime + 0.01); } catch(e) {}
        }
        // Note: Worklet nodes don't have stop()

        // Disconnect nodes after delay (using trackSetTimeout without note association)
        trackSetTimeout(() => {
            try { noteComponent.gainNode?.disconnect(); } catch(e) {}
            try { noteComponent.levelNode?.disconnect(); } catch(e) {} // For Oscs
            try { noteComponent.sampleNode?.disconnect(); } catch(e) {} // For Sampler
            try { noteComponent.source?.disconnect(); } catch(e) {} // Sampler source
            try { noteComponent.workletNode?.disconnect(); } catch(e) {} // Osc worklet
            try { noteComponent.fmModulatorSource?.disconnect(); } catch(e) {} // FM source
            try { noteComponent.fmDepthGain?.disconnect(); } catch(e) {} // FM gain
            // console.log(`quickFadeOutAndStop: Disconnected nodes for ${noteId}`); // Optional log
        }, cleanupDelayMs);

    } catch (e) {
        console.error(`Error during quickFadeOutAndStop for ${noteId}:`, e);
        // Attempt immediate disconnect on error (less safe, but fallback)
        try { noteComponent.gainNode?.disconnect(); } catch(e) {}
        try { noteComponent.levelNode?.disconnect(); } catch(e) {}
        try { noteComponent.sampleNode?.disconnect(); } catch(e) {}
        try { noteComponent.source?.disconnect(); } catch(e) {}
        try { noteComponent.workletNode?.disconnect(); } catch(e) {}
        try { noteComponent.fmModulatorSource?.disconnect(); } catch(e) {}
        try { noteComponent.fmDepthGain?.disconnect(); } catch(e) {}
    }
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
        osc1Note.fmDepthGain.gain.setValueAtTime(scaledDepth, now);

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
       if (newFmSource && osc1Note.fmDepthGain && freqParam) { // <<< Check newFmSource exists >>>
            newFmSource.connect(osc1Note.fmDepthGain);
            osc1Note.fmDepthGain.connect(freqParam); // Connect gain to frequency parameter
            newFmSource.start(now);
            osc1Note.fmModulatorSource = newFmSource; // <<< Store the new source >>>
            console.log(`updateOsc1FmModulatorParameters [${noteId}]: Started and connected new FM modulator source (${osc1FMSource}) to frequency.`);
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
updateSampleProcessing();


  // 4) Reset crossfade data
  cachedCrossfadedBuffer = null;
  lastCachedStartPos = null;
  lastCachedEndPos = null;
  lastCachedCrossfade = null;

  // 5) Create and connect a new source node
  if (sampleSource) {
      try { sampleSource.stop(); } catch(e){}
  }
  sampleSource = audioCtx.createBufferSource();
  sampleSource.buffer = audioBuffer; // Use the new buffer
  sampleSource.connect(sampleGainNode);
  sampleSource.start();

  // 6) Set UI label
  const fileLabel = document.querySelector('label[for="audio-file"]');
  if (fileLabel) {
      fileLabel.textContent = 'Recording (mic)';
  }

  // 7) Create crossfaded buffer if needed
  if (isSampleLoopOn && sampleCrossfadeAmount > 0.01) {
      console.log("Creating crossfaded buffer for recorded sample");
      const result = createCrossfadedBuffer(
        audioCtx, // Use the global audioCtx
          audioBuffer, // Use the new buffer
          sampleStartPosition,
          sampleEndPosition,
          sampleCrossfadeAmount
      );
      if (result && result.buffer) {
          console.log("Successfully created crossfaded buffer for recorded sample");
          cachedCrossfadedBuffer = result.buffer;
          lastCachedStartPos = sampleStartPosition;
          lastCachedEndPos = sampleEndPosition;
          lastCachedCrossfade = sampleCrossfadeAmount;
      }
  }
// <<< ADD: Update active Osc1/Osc2 FM modulators AFTER buffer processing >>>
const nowRec = audioCtx.currentTime;
// <<< CHANGE: Iterate over voicePool >>>
voicePool.forEach(voice => {
    if (voice.state !== 'inactive') {
        if (voice.osc1Note) {
            updateOsc1FmModulatorParameters(voice.osc1Note, nowRec, voice);
        }
        if (voice.osc2Note) { // <<< Also update Osc2 FM >>>
            updateOsc2FmModulatorParameters(voice.osc2Note, nowRec, voice);
        }
    }
});
// <<< END CHANGE >>>
// <<< END ADD >>>
  // 8) Update any active notes to use the new buffer
  voicePool.forEach(voice => {
    if (voice.state !== 'inactive' && voice.samplerNote) {
        const note = voice.samplerNote; // Get the samplerNote component
        // Skip held notes
        if (heldNotes.includes(voice.noteNumber)) { // Check voice.noteNumber
            console.log(`Sampler note ${note.id} (Voice ${voice.id}) is held; will update on release.`);
            return;
        }
        console.log(`Updating sampler note ${note.id} (Voice ${voice.id}) to use recorded sample`);
        // Call updateSamplePlaybackParameters which handles buffer switching etc.
        updateSamplePlaybackParameters(note);
    }
});
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
        currentSampleGain = value;
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.samplerNote && voice.samplerNote.sampleNode) {
                voice.samplerNote.sampleNode.gain.setTargetAtTime(currentSampleGain, audioCtx.currentTime, 0.01); // Smooth update
            }
        });
        // <<< END CHANGE >>>
        console.log('Sample Gain:', value.toFixed(2));
    },
    'sample-pitch-knob': (value) => {
        // Convert 0-1 range to -1200 to +1200 cents
        currentSampleDetune = (value * 2400) - 1200;
        const now = audioCtx.currentTime;

        // Show and update tooltip
        const tooltip = createTooltipForKnob('sample-pitch-knob', value); // Use specific tooltip helper
        tooltip.textContent = `${currentSampleDetune.toFixed(0)} cents`;
        tooltip.style.opacity = '1';

        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive') {
                // Update main sampler note
                if (voice.samplerNote && voice.samplerNote.source) {
                    voice.samplerNote.source.detune.setTargetAtTime(currentSampleDetune, now, 0.01);
                }
                // Update corresponding FM modulator detune (if source is sampler)
                // Osc1 FM
                if (osc1FMSource === 'sampler' && voice.osc1Note && voice.osc1Note.fmModulatorSource instanceof AudioBufferSourceNode) {
                    voice.osc1Note.fmModulatorSource.detune.setTargetAtTime(currentSampleDetune, now, 0.01);
                }
                // Osc2 FM
                if (osc2FMSource === 'sampler' && voice.osc2Note && voice.osc2Note.fmModulatorSource instanceof AudioBufferSourceNode) {
                    voice.osc2Note.fmModulatorSource.detune.setTargetAtTime(currentSampleDetune, now, 0.01);
                }
            }
        });
        // <<< END CHANGE >>>

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
        note.gainNode.gain.linearRampToValueAtTime(currentGainValue, now + 0.01); // Quick ramp (10ms)

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
// Update the voice monitoring display based on the voicePool
function updateVoiceDisplay_Pool() {
    const displayEl = D('voice-display');
    const voiceCountEl = D('voice-count');
    if (!displayEl || !voiceCountEl) return;

    displayEl.innerHTML = ''; // Clear previous display
    let activeNoteCount = 0;
    const activeNoteNumbers = new Set();

    // Iterate through the voice pool
    voicePool.forEach(voice => {
        if (voice.state !== 'inactive' && voice.noteNumber !== null) {
            activeNoteNumbers.add(voice.noteNumber);
        }
    });

    activeNoteCount = activeNoteNumbers.size;

    // Update count display (limited by MAX_POLYPHONY visually)
    voiceCountEl.textContent = Math.min(activeNoteCount, MAX_POLYPHONY);

    // Update visual key indicators (assuming 'keys' array is still available globally)
    if (typeof keys !== 'undefined' && Array.isArray(keys)) {
        keys.forEach((key, index) => {
            const voiceItem = document.createElement('div');
            voiceItem.className = 'voice-item';
            voiceItem.textContent = key;
            if (activeNoteNumbers.has(index)) {
                voiceItem.classList.add('active-voice');
            }
            displayEl.appendChild(voiceItem);
        });
    } else {
        console.warn("updateVoiceDisplay_Pool: Global 'keys' array not found for visual indicators.");
        // Fallback: Display active note numbers
        activeNoteNumbers.forEach(noteNum => {
             const voiceItem = document.createElement('div');
             voiceItem.className = 'voice-item active-voice';
             voiceItem.textContent = `N${noteNum}`; // Display note number
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

    // Find active notes from the voice pool
    voicePool.forEach(voice => {
        if (voice.state !== 'inactive' && voice.noteNumber !== null) {
            activeNoteNumbers.add(voice.noteNumber);
        }
    });

    document.querySelectorAll('.key').forEach(keyElement => {
        const noteIndex = parseInt(keyElement.dataset.noteIndex);
        if (isNaN(noteIndex)) return;

        const isNoteActiveInPool = activeNoteNumbers.has(noteIndex);
        const isPhysicallyHeld = heldNotes.includes(noteIndex);

        // Key is pressed if it's active in the pool OR physically held down
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
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive') {
                // Update Osc1 FM if sampler is the source
                if (voice.osc1Note && osc1FMSource === 'sampler') {
                    console.log(`handleFileSelect: Triggering Osc1 FM update for voice ${voice.id} because sampler changed.`);
                    updateOsc1FmModulatorParameters(voice.osc1Note, nowFile, voice);
                }
                // Update Osc2 FM if sampler is the source
                if (voice.osc2Note && osc2FMSource === 'sampler') {
                    console.log(`handleFileSelect: Triggering Osc2 FM update for voice ${voice.id} because sampler changed.`);
                    updateOsc2FmModulatorParameters(voice.osc2Note, nowFile, voice);
                }
            }
        });
        // <<< END CHANGE >>>
        // <<< END ADD >>>

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
// Clean up everything
function cleanupAllNotes() {
    console.log("Cleaning up all notes...");
    voicePool.forEach(voice => {
        if (voice.state !== 'inactive') {
            // Use quick fade out for immediate silence
            if (voice.samplerNote) quickFadeOutAndStop(voice.samplerNote, 0.01); // Use new helper
            if (voice.osc1Note) quickFadeOutAndStop(voice.osc1Note, 0.01);     // Use new helper
            if (voice.osc2Note) quickFadeOutAndStop(voice.osc2Note, 0.01);     // Use new helper
            // Mark voice inactive immediately after starting fade
            voice.state = 'inactive';
            voice.noteNumber = null;
        }
    });
    currentMonoVoice = null;
    heldNotes = [];
    // lastPlayedNoteNumber = null; // Keep for portamento

    updateVoiceDisplay_Pool(); // Use the new display function
    updateKeyboardDisplay_Pool(); 
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
reverseBufferIfNeeded();
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
// <<< ADD: Update active FM modulators AFTER buffer processing >>>
const nowPreset = audioCtx.currentTime;
// <<< CHANGE: Iterate over voicePool >>>
voicePool.forEach(voice => {
    if (voice.state !== 'inactive') {
        // Update Osc1 FM if sampler is the source
        if (voice.osc1Note && osc1FMSource === 'sampler') {
            console.log(`loadPresetSample: Triggering Osc1 FM update for voice ${voice.id} because sampler changed.`);
            updateOsc1FmModulatorParameters(voice.osc1Note, nowPreset, voice);
        }
        // Update Osc2 FM if sampler is the source
        if (voice.osc2Note && osc2FMSource === 'sampler') {
            console.log(`loadPresetSample: Triggering Osc2 FM update for voice ${voice.id} because sampler changed.`);
            updateOsc2FmModulatorParameters(voice.osc2Note, nowPreset, voice);
        }
    }
});
// <<< END CHANGE >>>
// <<< END ADD >>>

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

        console.log(`Updating sampler note ${note.id} (Voice ${voice.id}) to use new preset sample`);
        // Call updateSamplePlaybackParameters which handles buffer switching etc.
        updateSamplePlaybackParameters(note);
    }
});
// <<< END CHANGE >>>
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
    if (!note || note.state !== "playing") return;

    // <<< ADD: Set parent voice state to releasing >>>
    const voice = note.parentVoice || voicePool.find(v => v.samplerNote === note);
    if (voice && voice.state === 'playing') {
        voice.state = 'releasing';
        console.log(`releaseSamplerNote: Set voice ${voice.id} state to 'releasing'.`);
    }
    // <<< END ADD >>>

    note.state = "releasing"; // Set component state
    // <<< Clear ALL scheduled events for this note FIRST >>>
    clearScheduledEventsForNote(note);

    // ... (rest of release logic: loop stop, gain ramp) ...
    if (note.usesProcessedBuffer && note.crossfadeActive) {
        note.source.loop = false;
        note.looping = false;
    }

    const release = parseFloat(D('release').value);
    const now = audioCtx.currentTime;
    note.gainNode.gain.cancelScheduledValues(now);
    const currentGain = note.gainNode.gain.value;
    note.gainNode.gain.setValueAtTime(currentGain, now);
    note.gainNode.gain.linearRampToValueAtTime(0, now + release);

    // Schedule stop slightly after release ends
    const stopTime = now + release + 0.05;
    try {
        note.source.stop(stopTime);
    } catch (e) { /* Ignore errors */ }


    // Schedule final cleanup and store timer ID
    const killDelay = Math.max(100, (release * 1000) + 100);
    // <<< USE trackSetTimeout, passing the note object >>>
    const releaseTimer = trackSetTimeout(() => {
        // note.killTimerId = null; // No longer needed here, trackSetTimeout handles removal
        killSamplerNote(note);
    }, killDelay, note); // Pass note object

    // note.killTimerId = releaseTimer; // Legacy storage, clearScheduledEventsForNote handles it
}

function killSamplerNote(note) {
    // Check if note is valid and not already killed
    if (!note || note.state === "killed") return false;
    const noteId = note.id;
    const originalNoteNumber = note.noteNumber; // Store for logging, but don't rely on it for lookup
    console.log(`killSamplerNote: Starting kill process for ${noteId} (Original Note ${originalNoteNumber})`);
    note.state = "killed"; // <<< Mark component killed

    // <<< Clear ALL scheduled events FIRST >>>
    clearScheduledEventsForNote(note);

    try {
        // Stop and disconnect audio nodes (using delayed disconnect)
        if (note.gainNode) {
            note.gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
            note.gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
            // <<< USE trackSetTimeout for delayed disconnect (no note association needed) >>>
            trackSetTimeout(() => { try { note.gainNode.disconnect(); } catch(e){} }, 20);
        }
        if (note.sampleNode) {
            // <<< USE trackSetTimeout for delayed disconnect (no note association needed) >>>
            trackSetTimeout(() => { try { note.sampleNode.disconnect(); } catch(e){} }, 20);
        }
        if (note.source) {
            try { note.source.stop(audioCtx.currentTime); } catch(e) {}
            // <<< USE trackSetTimeout for delayed disconnect (no note association needed) >>>
            trackSetTimeout(() => { try { note.source.disconnect(); } catch(e){} }, 20);
        }
    } catch (e) {
         console.warn(`killSamplerNote [${noteId}]: Error during node cleanup:`, e);
    }

    // --- Update Voice Pool State ---
    // const voice = note.parentVoice || voicePool.find(v => v.samplerNote === note); // Use parentVoice primarily
    const voice = note.parentVoice; // <<< Use direct reference

    if (voice) {
        // <<< Add check: Ensure the samplerNote on the voice still matches the note being killed >>>
        if (voice.samplerNote !== note) {
            console.warn(`killSamplerNote [${noteId}]: Mismatch! Voice ${voice.id}'s samplerNote is not the note being killed. Aborting state change.`);
            // Don't nullify or change state if it's already been replaced (e.g., by retrigger/steal)
            return false; // Indicate that the voice state wasn't changed by this kill call
        }

        console.log(`killSamplerNote [${noteId}]: Nullifying samplerNote on voice ${voice.id}.`);
        voice.samplerNote = null; // Nullify the reference on the voice

        // Check if voice is fully inactive AFTER nullifying
        if (isVoiceFullyInactive(voice)) {
            console.log(`killSamplerNote [${noteId}]: All components for voice ${voice.id} are now inactive/null. Marking voice inactive.`);
            voice.state = 'inactive';
            voice.noteNumber = null; // Clear note number when fully inactive
            // If this was the current mono voice, clear the reference
            if (isMonoMode && currentMonoVoice === voice) {
                console.log(`killSamplerNote [${noteId}]: Cleared currentMonoVoice reference as it became inactive.`);
                currentMonoVoice = null;
            }
            // Update UI only when voice becomes fully inactive
            updateVoiceDisplay_Pool();
            updateKeyboardDisplay_Pool();
        } else {
             console.log(`killSamplerNote [${noteId}]: Voice ${voice.id} still has active/releasing components. State remains '${voice.state}'.`);
        }
    } else {
        console.warn(`killSamplerNote [${noteId}]: Could not find parent voice during cleanup.`);
        // Update UI anyway as a fallback
        updateVoiceDisplay_Pool();
        updateKeyboardDisplay_Pool();
    }
    // --- End Update Voice Pool State ---

    // <<< REMOVE UI Update from here >>>
    // updateVoiceDisplay_Pool();
    // updateKeyboardDisplay_Pool();

    console.log(`killSamplerNote: Finished killing ${noteId}`);
    return true;
}



// --- Oscillator 1 Note Creation/Management ---


function releaseOsc1Note(note) {
    if (!note || note.state !== "playing") return;

    // <<< ADD: Set parent voice state to releasing >>>
    const voice = note.parentVoice || voicePool.find(v => v.osc1Note === note);
    if (voice && voice.state === 'playing') {
        voice.state = 'releasing';
        console.log(`releaseOsc1Note: Set voice ${voice.id} state to 'releasing'.`);
    }
    // <<< END ADD >>>

    note.state = "releasing"; // Set component state
    // <<< Clear ALL scheduled events for this note FIRST >>>
    clearScheduledEventsForNote(note);

    const release = parseFloat(D('release').value);
    const now = audioCtx.currentTime;

    // Apply release ramp to the ADSR gain node (native)
    note.gainNode.gain.cancelScheduledValues(now);
    const currentGain = note.gainNode.gain.value;
    note.gainNode.gain.setValueAtTime(currentGain, now);
    note.gainNode.gain.linearRampToValueAtTime(0, now + release);

    // Schedule the oscillator stop (if applicable, worklet doesn't need stop)
    const stopTime = now + release + 0.05; // Use native context time

    // <<< Stop FM Modulator Source if it exists >>>
    if (note.fmModulatorSource) {
        try {
            note.fmModulatorSource.stop(stopTime);
        } catch(e) { console.warn(`Error stopping FM source for Osc1 note ${note.id}:`, e); }
    }
    // <<< END Stop FM Modulator Source >>>

    // Schedule final cleanup (killOsc1Note) and store timer ID
    const killDelay = Math.max(100, (release * 1000) + 100); // Ensure minimum delay
    // <<< USE trackSetTimeout, passing the note object >>>
    const releaseTimer = trackSetTimeout(() => {
        // note.killTimerId = null; // No longer needed here
        killOsc1Note(note);
    }, killDelay, note); // Pass note object

    // note.killTimerId = releaseTimer; // Legacy storage
}

function killOsc1Note(note) {
    if (!note || note.state === "killed") return false;

    const noteId = note.id;
    const originalNoteNumber = note.noteNumber;
    console.log(`killOsc1Note: Starting kill process for ${noteId} (Original Note ${originalNoteNumber})`);
    note.state = "killed"; // <<< Mark component killed

    // <<< Clear ALL scheduled events FIRST >>>
    clearScheduledEventsForNote(note);

    try {
        // ... (node cleanup) ...
    } catch (e) {
        console.error(`Error during killOsc1Note cleanup for ${noteId}:`, e);
    }

    // --- Update Voice Pool State ---
    // const voice = note.parentVoice || voicePool.find(v => v.osc1Note === note); // Use parentVoice primarily
    const voice = note.parentVoice; // <<< Use direct reference

    if (voice) {
        if (voice.osc1Note !== note) {
            console.warn(`killOsc1Note [${noteId}]: Mismatch! Voice ${voice.id}'s osc1Note is not the note being killed. Aborting state change.`);
            return false;
        }

        // <<< REMOVE/COMMENT OUT THIS LINE >>>
        // console.log(`killOsc1Note [${noteId}]: Nullifying osc1Note on voice ${voice.id}.`);
        // voice.osc1Note = null; // Nullify the reference on the voice
        // <<< END REMOVE >>>


        // Check if voice is fully inactive AFTER nullifying (or conceptually, after this component is killed)
        // We need to check based on the component's state now, not just null reference
        const samplerInactive = !voice.samplerNote || voice.samplerNote.state === 'inactive' || voice.samplerNote.state === 'killed';
        const osc1Inactive = true; // This component is being killed now
        const osc2Inactive = !voice.osc2Note || voice.osc2Note.state === 'inactive' || voice.osc2Note.state === 'killed';

        if (samplerInactive && osc1Inactive && osc2Inactive) {
            console.log(`killOsc1Note [${noteId}]: All components for voice ${voice.id} are now inactive/killed. Marking voice inactive.`);
            voice.state = 'inactive';
            voice.noteNumber = null;
            if (isMonoMode && currentMonoVoice === voice) {
                currentMonoVoice = null;
            }
            updateVoiceDisplay_Pool();
            updateKeyboardDisplay_Pool();
        } else {
             console.log(`killOsc1Note [${noteId}]: Voice ${voice.id} still has active/releasing components. State remains '${voice.state}'.`);
        }
    } else {
        console.warn(`killOsc1Note [${noteId}]: Could not find parent voice in pool during cleanup.`);
        // Update UI anyway as a fallback
        updateVoiceDisplay_Pool();
        updateKeyboardDisplay_Pool();
    }
    // --- End Update Voice Pool State ---

    // <<< REMOVE UI Update from here >>>
    // updateVoiceDisplay_Pool();
    // updateKeyboardDisplay_Pool();

    console.log(`killOsc1Note: Finished killing ${noteId}`);
    return true;
}



/**
 * Initiates the release phase for an Oscillator 2 note.
 * @param {object} note - The Osc2 note object.
 */
function releaseOsc2Note(note) {
    if (!note || note.state !== "playing") return;

    // <<< ADD: Set parent voice state to releasing >>>
    const voice = note.parentVoice || voicePool.find(v => v.osc2Note === note);
    if (voice && voice.state === 'playing') {
        voice.state = 'releasing';
        console.log(`releaseOsc2Note: Set voice ${voice.id} state to 'releasing'.`);
    }
    // <<< END ADD >>>

    note.state = "releasing"; // Set component state
    // <<< Clear ALL scheduled events for this note FIRST >>>
    clearScheduledEventsForNote(note);

    const release = parseFloat(D('release').value);
    const now = audioCtx.currentTime;

    // Apply release ramp to the ADSR gain node
    note.gainNode.gain.cancelScheduledValues(now);
    const currentGain = note.gainNode.gain.value;
    note.gainNode.gain.setValueAtTime(currentGain, now);
    note.gainNode.gain.linearRampToValueAtTime(0, now + release);

    // <<< Stop FM Modulator Source if it exists >>>
    const stopTime = now + release + 0.05;
    if (note.fmModulatorSource) {
        try {
            note.fmModulatorSource.stop(stopTime);
        } catch(e) { console.warn(`Error stopping FM source for Osc2 note ${note.id}:`, e); }
    }
    // <<< END Stop FM Modulator Source >>>

    // Schedule final cleanup (killOsc2Note)
    const killDelay = Math.max(100, (release * 1000) + 100);
    // <<< USE trackSetTimeout, passing the note object >>>
    const releaseTimer = trackSetTimeout(() => {
        // note.killTimerId = null; // No longer needed
        killOsc2Note(note);
    }, killDelay, note); // Pass note object

    // note.killTimerId = releaseTimer; // Legacy storage
}

/**
 * Stops and disconnects all nodes associated with an Oscillator 2 note.
 * @param {object} note - The Osc2 note object.
 * @returns {boolean} True if cleanup was attempted, false if note was invalid/already killed.
 */
function killOsc2Note(note) {
    if (!note || note.state === "killed") return false;

    const noteId = note.id;
    const originalNoteNumber = note.noteNumber;
    console.log(`killOsc2Note: Starting kill process for ${noteId} (Original Note ${originalNoteNumber})`);
    note.state = "killed"; // <<< Mark component killed

    // <<< Clear ALL scheduled events FIRST >>>
    clearScheduledEventsForNote(note);

    try {
        // ... (node cleanup) ...
    } catch (e) {
        console.error(`Error during killOsc2Note cleanup for ${noteId}:`, e);
    }

    // --- Update Voice Pool State ---
    // const voice = note.parentVoice || voicePool.find(v => v.osc2Note === note); // Use parentVoice primarily
    const voice = note.parentVoice; // <<< Use direct reference

    if (voice) {
        if (voice.osc2Note !== note) {
            console.warn(`killOsc2Note [${noteId}]: Mismatch! Voice ${voice.id}'s osc2Note is not the note being killed. Aborting state change.`);
            return false;
        }

        // <<< REMOVE/COMMENT OUT THIS LINE >>>
        // console.log(`killOsc2Note [${noteId}]: Nullifying osc2Note on voice ${voice.id}.`);
        // voice.osc2Note = null; // Nullify the reference on the voice
        // <<< END REMOVE >>>

        // Check if voice is fully inactive AFTER nullifying (or conceptually, after this component is killed)
        const samplerInactive = !voice.samplerNote || voice.samplerNote.state === 'inactive' || voice.samplerNote.state === 'killed';
        const osc1Inactive = !voice.osc1Note || voice.osc1Note.state === 'inactive' || voice.osc1Note.state === 'killed';
        const osc2Inactive = true; // This component is being killed now

        if (samplerInactive && osc1Inactive && osc2Inactive) {
            console.log(`killOsc2Note [${noteId}]: All components for voice ${voice.id} are now inactive/killed. Marking voice inactive.`);
            voice.state = 'inactive';
            voice.noteNumber = null;
            if (isMonoMode && currentMonoVoice === voice) {
                currentMonoVoice = null;
            }
            updateVoiceDisplay_Pool();
            updateKeyboardDisplay_Pool();
        } else {
             console.log(`killOsc2Note [${noteId}]: Voice ${voice.id} still has active/releasing components. State remains '${voice.state}'.`);
        }
    } else {
        console.warn(`killOsc2Note [${noteId}]: Could not find parent voice in pool during cleanup.`);
        // Update UI anyway as a fallback
        updateVoiceDisplay_Pool();
        updateKeyboardDisplay_Pool();
    }
    // --- End Update Voice Pool State ---

    // <<< REMOVE UI Update from here >>>
    // updateVoiceDisplay_Pool();
    // updateKeyboardDisplay_Pool();

    console.log(`killOsc2Note: Finished killing ${noteId}`);
    return true;
}

/**
 * Quickly fades out and kills an Oscillator 2 note.
 * @param {object} note - The Osc2 note object.
 * @param {number} [fadeTime=0.05] - Fade duration in seconds.
 * @returns {object} The note object.
 */
function quickFadeOutOsc2(note, fadeTime = 0.05) {
    if (!note || !note.gainNode || note.state === "fadingOut" || note.state === "killed") return note;

    // <<< Clear existing scheduled events FIRST >>>
    clearScheduledEventsForNote(note);

    note.state = "fadingOut";
    try {
        const now = audioCtx.currentTime;
        const currentGain = note.gainNode.gain.value;
        note.gainNode.gain.cancelScheduledValues(now);
        note.gainNode.gain.setValueAtTime(currentGain, now);
        note.gainNode.gain.linearRampToValueAtTime(0, now + fadeTime);
        // <<< USE trackSetTimeout, passing the note object >>>
        const killTimer = trackSetTimeout(() => killOsc2Note(note), fadeTime * 1000 + 10, note);
        // note.scheduledEvents.push({ type: 'timeout', id: killTimer }); // Handled by trackSetTimeout
    } catch (e) {
        console.error(`Error during quickFadeOutOsc2 for ${note?.id}:`, e);
        killOsc2Note(note); // Kill immediately on error
    }
    return note;
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
        osc2Note.fmDepthGain.gain.setTargetAtTime(scaledDepth, now, 0.015);

        // --- 2. Manage Source Node ---
        const currentSource = osc2Note.fmModulatorSource;
        let sourceTypeMatches = false;
        let newFmSource = null;

        if (currentSource) {
            if (osc2FMSource === 'sampler' && currentSource instanceof AudioBufferSourceNode) {
                sourceTypeMatches = true;
            } else if (osc2FMSource === 'osc1' && currentSource instanceof OscillatorNode) { // Check for Osc1 source
                sourceTypeMatches = true;
            }
        }

        if (sourceTypeMatches) {
            // --- Reuse Existing Source ---
            console.log(`updateOsc2FmModulatorParameters [${noteId}]: Reusing existing FM source node (${currentSource.constructor.name}).`);
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
            // --- Create/Replace Source ---
            console.log(`updateOsc2FmModulatorParameters [${noteId}]: Replacing FM source node.`);
            if (currentSource) {
                try { currentSource.stop(0); } catch(e) { /* Ignore */ }
                try { currentSource.disconnect(); } catch(e) { /* Ignore */ }
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
                console.log(`updateOsc2FmModulatorParameters [${noteId}]: NEW Sampler FM Loop=${newFmSource.loop}, Start=${newFmSource.loopStart.toFixed(3)}, End=${newFmSource.loopEnd.toFixed(3)}`);

            } else if (osc2FMSource === 'osc1') {
                // Create Oscillator Source (mirroring Osc1)
                newFmSource = audioCtx.createOscillator();
                newFmSource.type = osc1Waveform === 'pulse' ? 'square' : osc1Waveform; // Use Osc1 waveform
                const osc1Freq = noteToFrequency(noteNumber, osc1OctaveOffset); // Use Osc1 octave
                newFmSource.frequency.value = osc1Freq;
                newFmSource.detune.value = osc1Detune; // Use Osc1 detune
                console.log(`updateOsc2FmModulatorParameters [${noteId}]: Created NEW basic OscillatorNode (${newFmSource.type}) mirroring Osc1 settings.`);
            }

            if (newFmSource) {
                newFmSource.start(now);
                osc2Note.fmModulatorSource = newFmSource;
            } else {
                console.warn(`updateOsc2FmModulatorParameters [${noteId}]: Failed to create new FM source. FM inactive.`);
                if (osc2Note.fmDepthGain) { try { osc2Note.fmDepthGain.disconnect(); } catch(e) {} osc2Note.fmDepthGain = null; }
                return;
            }
        }

        // --- 3. Connect Nodes ---
        if (osc2Note.fmDepthGain && newFmSource) {
            newFmSource.connect(osc2Note.fmDepthGain);
            osc2Note.fmDepthGain.connect(freqParam);
            console.log(`updateOsc2FmModulatorParameters [${noteId}]: Connected FM chain.`);
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
    console.log(`noteOn POOL: ${noteNumber}, Mono: ${isMonoMode}, Legato: ${isLegatoMode}, Porta: ${isPortamentoOn}`);
    const now = audioCtx.currentTime;

    // --- Add to held notes list ---
    if (!heldNotes.includes(noteNumber)) {
        heldNotes.push(noteNumber);
        heldNotes.sort((a, b) => a - b); // Keep sorted for predictability
    }

    let voice = null;
    let previousNoteNumber = null; // Store the note this voice *was* playing, if any
    let isNewMonoNote = false; // Flag for first note in mono mode
    let wasStolen = false; // Flag if the voice was stolen

    if (isMonoMode) {
        // --- Mono Mode Voice Handling ---
        if (currentMonoVoice && currentMonoVoice.state !== 'inactive') {
            voice = currentMonoVoice;
            previousNoteNumber = voice.noteNumber;
            wasStolen = false; // Not stolen, just reused
            console.log(`Mono NoteOn: Reusing active mono voice ${voice.id} (was playing ${previousNoteNumber}) for new note ${noteNumber}. Legato: ${isLegatoMode}`);
        } else {
            voice = findAvailableVoice();
            if (!voice) {
                console.error("Mono NoteOn: No available voices in the pool!");
                heldNotes = heldNotes.filter(n => n !== noteNumber);
                updateKeyboardDisplay_Pool();
                return;
            }
            wasStolen = voice.state !== 'inactive'; // Check if the found voice was actually inactive or stolen
            console.log(`Mono NoteOn: Acquired ${wasStolen ? 'stolen' : 'new'} voice ${voice.id} for first mono note ${noteNumber}.`);
            currentMonoVoice = voice;
            isNewMonoNote = true;
            previousNoteNumber = wasStolen ? voice.noteNumber : null; // Store previous note only if stolen
        }
    } else {
        // --- Poly Mode Voice Handling ---
        const existingVoice = voicePool.find(v => v.noteNumber === noteNumber && v.state !== 'inactive');
        if (existingVoice) {
            console.log(`Poly Retrigger: Note ${noteNumber} already playing on voice ${existingVoice.id}. Reusing.`);
            voice = existingVoice;
            previousNoteNumber = voice.noteNumber;
            wasStolen = false; // Not stolen, just retriggered
            console.log(`Poly Retrigger: Clearing any pending kill timers for voice ${voice.id}`);
            clearScheduledEventsForVoice(voice);
        } else {
            voice = findAvailableVoice();
            if (!voice) {
                console.error("Poly NoteOn: No available voices in the pool!");
                heldNotes = heldNotes.filter(n => n !== noteNumber);
                updateKeyboardDisplay_Pool();
                return;
            }
            wasStolen = voice.state !== 'inactive'; // Check if the found voice was actually inactive or stolen
            console.log(`Poly NoteOn: Acquired ${wasStolen ? 'stolen' : 'new'} voice ${voice.id} for note ${noteNumber}.`);
            previousNoteNumber = wasStolen ? voice.noteNumber : null; // Store previous note only if stolen
        }
    }

    // --- Voice Configuration ---
    // Store previous pitch values *before* updating voice state, needed for glide calculations
    let glideStartRate = null;
    let glideStartFreqOsc1 = null;
    let glideStartFreqOsc2 = null;
    let glideStartFreqFmOsc1 = null;
    let glideStartDetuneFmOsc1 = null;
    let glideStartFreqFmOsc2 = null;
    let glideStartDetuneFmOsc2 = null;

    const shouldReadPitchNow = isPortamentoOn && glideTime > 0.001 && previousNoteNumber !== null && !(isMonoMode && isLegatoMode);

    if (shouldReadPitchNow) {
        // Attempt to read the *actual current* values from the nodes if they exist
        try { glideStartRate = voice.samplerNote?.source?.playbackRate?.value; } catch(e){}
        try { glideStartFreqOsc1 = voice.osc1Note?.workletNode?.parameters?.get('frequency')?.value; } catch(e){}
        try { glideStartFreqOsc2 = voice.osc2Note?.workletNode?.parameters?.get('frequency')?.value; } catch(e){}
        // Read FM source pitch if applicable
        if (osc1FMSource === 'osc2' && voice.osc1Note?.fmModulatorSource instanceof OscillatorNode) {
            try { glideStartFreqFmOsc1 = voice.osc1Note.fmModulatorSource.frequency.value; } catch(e){}
            try { glideStartDetuneFmOsc1 = voice.osc1Note.fmModulatorSource.detune.value; } catch(e){}
        }
        if (osc2FMSource === 'osc1' && voice.osc2Note?.fmModulatorSource instanceof OscillatorNode) {
            try { glideStartFreqFmOsc2 = voice.osc2Note.fmModulatorSource.frequency.value; } catch(e){}
            try { glideStartDetuneFmOsc2 = voice.osc2Note.fmModulatorSource.detune.value; } catch(e){}
        }

        // Fallback to calculated frequency if reading failed
        if (glideStartRate === undefined || glideStartRate === null) glideStartRate = isSampleKeyTrackingOn ? TR2 ** (previousNoteNumber - 12) : 1.0;
        if (glideStartFreqOsc1 === undefined || glideStartFreqOsc1 === null) glideStartFreqOsc1 = noteToFrequency(previousNoteNumber, osc1OctaveOffset);
        if (glideStartFreqOsc2 === undefined || glideStartFreqOsc2 === null) glideStartFreqOsc2 = noteToFrequency(previousNoteNumber, osc2OctaveOffset);
        if (glideStartFreqFmOsc1 === undefined || glideStartFreqFmOsc1 === null) glideStartFreqFmOsc1 = noteToFrequency(previousNoteNumber, osc2OctaveOffset);
        if (glideStartDetuneFmOsc1 === undefined || glideStartDetuneFmOsc1 === null) glideStartDetuneFmOsc1 = osc2Detune;
        if (glideStartFreqFmOsc2 === undefined || glideStartFreqFmOsc2 === null) glideStartFreqFmOsc2 = noteToFrequency(previousNoteNumber, osc1OctaveOffset);
        if (glideStartDetuneFmOsc2 === undefined || glideStartDetuneFmOsc2 === null) glideStartDetuneFmOsc2 = osc1Detune;

        console.log(`NoteOn: Storing glide start pitch from previous note ${previousNoteNumber} - Rate: ${glideStartRate?.toFixed(4)}, Freq1: ${glideStartFreqOsc1?.toFixed(2)}, Freq2: ${glideStartFreqOsc2?.toFixed(2)}`);
    } else if (isMonoMode && isNewMonoNote && isPortamentoOn && glideTime > 0.001 && lastPlayedNoteNumber !== null) {
        // Special case: First note in a mono sequence, glide from the *last note released*
        glideStartRate = lastActualSamplerRate;
        glideStartFreqOsc1 = lastActualOsc1Freq;
        glideStartFreqOsc2 = lastActualOsc2Freq;
        // Fallback if actual values weren't stored
        if (glideStartRate === null) glideStartRate = isSampleKeyTrackingOn ? TR2 ** (lastPlayedNoteNumber - 12) : 1.0;
        if (glideStartFreqOsc1 === null) glideStartFreqOsc1 = noteToFrequency(lastPlayedNoteNumber, osc1OctaveOffset);
        if (glideStartFreqOsc2 === null) glideStartFreqOsc2 = noteToFrequency(lastPlayedNoteNumber, osc2OctaveOffset);
        // Calculate FM start pitch based on last released note
        if (osc1FMSource === 'osc2') { glideStartFreqFmOsc1 = noteToFrequency(lastPlayedNoteNumber, osc2OctaveOffset); glideStartDetuneFmOsc1 = osc2Detune; }
        if (osc2FMSource === 'osc1') { glideStartFreqFmOsc2 = noteToFrequency(lastPlayedNoteNumber, osc1OctaveOffset); glideStartDetuneFmOsc2 = osc1Detune; }

        console.log(`NoteOn: Storing glide start pitch from LAST RELEASED note ${lastPlayedNoteNumber} - Rate: ${glideStartRate?.toFixed(4)}, Freq1: ${glideStartFreqOsc1?.toFixed(2)}, Freq2: ${glideStartFreqOsc2?.toFixed(2)}`);
    }

    // Update voice state
    voice.noteNumber = noteNumber;
    voice.startTime = now;
    voice.state = 'playing';

    // --- Configure Sampler Component ---
    const samplerNote = voice.samplerNote;
    if (samplerNote && audioBuffer) {
        // Reset component state
        samplerNote.noteNumber = noteNumber;
        samplerNote.state = 'playing';
        samplerNote.startTime = now;
        samplerNote.scheduledEvents = [];

        const oldGainNode = samplerNote.gainNode; // Keep reference to old ADSR gain
        const sampleNode = samplerNote.sampleNode; // Keep reference to sample-specific gain

        // --- Stop existing source playback ---
        if (samplerNote.source) {
            try {
                samplerNote.source.stop(0);
                samplerNote.source.disconnect();
            } catch (e) { /* Ignore if already stopped/disconnected */ }
        }

        // --- Create and configure NEW source ---
        const newSource = audioCtx.createBufferSource();
        samplerNote.source = newSource; // Assign NEW source

        // Select buffer
        let useOriginalBuffer = true;
        let sourceBuffer = audioBuffer;
        let bufferType = "original";
        if (isSampleLoopOn && sampleCrossfadeAmount > 0.01 && cachedCrossfadedBuffer) {
            sourceBuffer = cachedCrossfadedBuffer; useOriginalBuffer = false; bufferType = "crossfaded";
        } else if (fadedBuffer && (!isSampleLoopOn || sampleCrossfadeAmount <= 0.01)) {
            sourceBuffer = fadedBuffer; useOriginalBuffer = false; bufferType = "faded";
        } else if (isEmuModeOn && useOriginalBuffer) {
             sourceBuffer = applyEmuProcessing(audioBuffer); useOriginalBuffer = false; bufferType = "original_emu";
        }

        if (!sourceBuffer || !(sourceBuffer instanceof AudioBuffer) || sourceBuffer.length === 0) {
            console.error(`NoteOn [Voice ${voice.id} Sampler]: Invalid sourceBuffer (type: ${bufferType}). Skipping sampler.`);
            samplerNote.state = 'inactive';
        } else {
            newSource.buffer = sourceBuffer;
            samplerNote.usesProcessedBuffer = !useOriginalBuffer;
            samplerNote.crossfadeActive = bufferType === "crossfaded";

            // --- *** Replace ADSR Gain Node *** ---
            console.log(`NoteOn [Voice ${voice.id} Sampler]: Replacing ADSR gain node.`);
            const newGainNode = audioCtx.createGain();
            newGainNode.gain.value = 0; // Start silent
            samplerNote.gainNode = newGainNode; // Assign NEW gain node

            // Connect nodes: source -> sampleNode -> NEW gainNode -> masterGain
            try {
                if (oldGainNode) oldGainNode.disconnect(); // Disconnect old ADSR gain fully
                sampleNode.disconnect(); // Disconnect sampleNode from wherever it was
            } catch(e) {}
            newSource.connect(sampleNode);
            sampleNode.connect(newGainNode); // Connect sampleNode to NEW gain node
            newGainNode.connect(masterGain); // Connect NEW gain node to master

            // Set sample gain on sampleNode
            sampleNode.gain.value = currentSampleGain;

            // Set pitch/rate/detune on newSource
            const targetRate = isSampleKeyTrackingOn ? TR2 ** (noteNumber - 12) : 1.0;
            newSource.playbackRate.value = targetRate; // Set target rate directly for now
            newSource.detune.value = currentSampleDetune; // Set target detune directly

            // Set loop on newSource
            let loopStartTime = 0; let loopEndTime = sourceBuffer.duration;
            if (useOriginalBuffer) {
                if (isSampleLoopOn) {
                    newSource.loop = true; loopStartTime = sampleStartPosition * audioBuffer.duration; loopEndTime = sampleEndPosition * audioBuffer.duration;
                    newSource.loopStart = Math.max(0, loopStartTime); newSource.loopEnd = Math.min(audioBuffer.duration, loopEndTime);
                    if (newSource.loopEnd <= newSource.loopStart) { newSource.loopEnd = audioBuffer.duration; newSource.loopStart = 0; }
                } else { newSource.loop = false; }
            } else { newSource.loop = isSampleLoopOn; }
            samplerNote.looping = newSource.loop;
            samplerNote.calculatedLoopStart = loopStartTime; samplerNote.calculatedLoopEnd = loopEndTime;

            // ADSR Trigger (Always trigger on the NEW node)
            const attack = parseFloat(D('attack').value);
            const decay = parseFloat(D('decay').value);
            const sustain = parseFloat(D('sustain').value);
            newGainNode.gain.cancelScheduledValues(now); // Should be redundant for new node, but safe
            newGainNode.gain.setValueAtTime(0, now);
            newGainNode.gain.linearRampToValueAtTime(1.0, now + attack);
            newGainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);

            // Start new source
            newSource.start(now);

            // Schedule stop if not looping
            if (!newSource.loop) {
                let originalDuration = (useOriginalBuffer ? (sampleEndPosition - sampleStartPosition) * audioBuffer.duration : (fadedBufferOriginalDuration || sourceBuffer.duration));
                const playbackRate = newSource.playbackRate.value;
                const adjustedDuration = originalDuration / playbackRate;
                const safetyMargin = 0.05;
                const stopTime = now + adjustedDuration + safetyMargin;
                try {
                    newSource.stop(stopTime);
                } catch (e) { console.error(`Error scheduling stop for sampler note ${samplerNote.id}:`, e); }
            }
        }
    } else if (samplerNote) {
        samplerNote.state = 'inactive'; // Mark inactive if no buffer
        console.log(`NoteOn [Voice ${voice.id}]: No audioBuffer loaded, skipping sampler component.`);
    }

    // --- Configure Osc1 Component ---
    const osc1Note = voice.osc1Note;
    if (osc1Note && isWorkletReady) {
        // Reset component state
        osc1Note.noteNumber = noteNumber;
        osc1Note.state = 'playing';
        osc1Note.startTime = now;
        osc1Note.scheduledEvents = [];

        const oldGainNode = osc1Note.gainNode; // Keep reference
        const workletNode = osc1Note.workletNode;
        const levelNode = osc1Note.levelNode;

        // Set worklet parameters
        const targetFreqOsc1 = noteToFrequency(noteNumber, osc1OctaveOffset);
        const freqParam = workletNode.parameters.get('frequency');
        const detuneParam = workletNode.parameters.get('detune');
        const holdParam = workletNode.parameters.get('holdAmount');
        const quantizeParam = workletNode.parameters.get('quantizeAmount');
        const waveTypeParam = workletNode.parameters.get('waveformType');
        const waveMapNameToWorkletType = { sine: 0, sawtooth: 1, triangle: 2, square: 3, pulse: 4 };

        if (freqParam) freqParam.value = targetFreqOsc1; // Set target directly for now
        if (detuneParam) detuneParam.value = osc1Detune;
        if (holdParam) holdParam.value = osc1PWMValue;
        if (quantizeParam) quantizeParam.value = osc1QuantizeValue;
        if (waveTypeParam) waveTypeParam.value = waveMapNameToWorkletType[osc1Waveform] ?? 0;

        // Set level gain on levelNode
        levelNode.gain.value = osc1GainValue;

        // --- *** Replace ADSR Gain Node *** ---
        console.log(`NoteOn [Voice ${voice.id} Osc1]: Replacing ADSR gain node.`);
        const newGainNode = audioCtx.createGain();
        newGainNode.gain.value = 0;
        osc1Note.gainNode = newGainNode; // Assign NEW gain node

        // Connect nodes: worklet -> levelNode -> NEW gainNode -> masterGain
        try {
            if (oldGainNode) oldGainNode.disconnect(); // Disconnect old ADSR gain fully
            levelNode.disconnect(); // Disconnect levelNode from wherever it was
        } catch(e) {}
        // Worklet should already be connected to levelNode from createVoice
        levelNode.connect(newGainNode); // Connect levelNode to NEW gain node
        newGainNode.connect(masterGain); // Connect NEW gain node to master

        // ADSR Trigger (Always trigger on the NEW node)
        const attack = parseFloat(D('attack').value);
        const decay = parseFloat(D('decay').value);
        const sustain = parseFloat(D('sustain').value);
        newGainNode.gain.cancelScheduledValues(now);
        newGainNode.gain.setValueAtTime(0, now);
        newGainNode.gain.linearRampToValueAtTime(1.0, now + attack);
        newGainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);

        // Update/Create FM Modulator for Osc1 (handles its own node replacement if needed)
        updateOsc1FmModulatorParameters(osc1Note, now, voice);

    } else if (osc1Note) {
        osc1Note.state = 'inactive'; // Mark inactive if worklet not ready
        console.warn(`NoteOn [Voice ${voice.id}]: Worklet not ready, skipping Osc1 component.`);
    }

    // --- Configure Osc2 Component ---
    const osc2Note = voice.osc2Note;
    if (osc2Note && isWorkletReady) {
        // Reset component state
        osc2Note.noteNumber = noteNumber;
        osc2Note.state = 'playing';
        osc2Note.startTime = now;
        osc2Note.scheduledEvents = [];

        const oldGainNode = osc2Note.gainNode; // Keep reference
        const workletNode = osc2Note.workletNode;
        const levelNode = osc2Note.levelNode;

        // Set worklet parameters
        const targetFreqOsc2 = noteToFrequency(noteNumber, osc2OctaveOffset); // Use Osc2 offset
        const freqParam = workletNode.parameters.get('frequency');
        const detuneParam = workletNode.parameters.get('detune');
        const holdParam = workletNode.parameters.get('holdAmount');
        const quantizeParam = workletNode.parameters.get('quantizeAmount');
        const waveTypeParam = workletNode.parameters.get('waveformType');
        const waveMapNameToWorkletType = { sine: 0, sawtooth: 1, triangle: 2, square: 3, pulse: 4 };

        if (freqParam) freqParam.value = targetFreqOsc2; // Set target directly
        if (detuneParam) detuneParam.value = osc2Detune; // Use Osc2 detune
        if (holdParam) holdParam.value = osc2PWMValue; // Use Osc2 PWM
        if (quantizeParam) quantizeParam.value = osc2QuantizeValue; // Use Osc2 Quantize
        if (waveTypeParam) waveTypeParam.value = waveMapNameToWorkletType[osc2Waveform] ?? 0; // Use Osc2 waveform

        // Set level gain on levelNode
        levelNode.gain.value = osc2GainValue; // Use Osc2 gain

        // --- *** Replace ADSR Gain Node *** ---
        console.log(`NoteOn [Voice ${voice.id} Osc2]: Replacing ADSR gain node.`);
        const newGainNode = audioCtx.createGain();
        newGainNode.gain.value = 0;
        osc2Note.gainNode = newGainNode; // Assign NEW gain node

        // Connect nodes: worklet -> levelNode -> NEW gainNode -> masterGain
        try {
            if (oldGainNode) oldGainNode.disconnect(); // Disconnect old ADSR gain fully
            levelNode.disconnect(); // Disconnect levelNode from wherever it was
        } catch(e) {}
        // Worklet should already be connected to levelNode from createVoice
        levelNode.connect(newGainNode); // Connect levelNode to NEW gain node
        newGainNode.connect(masterGain); // Connect NEW gain node to master

        // ADSR Trigger (Always trigger on the NEW node)
        const attack = parseFloat(D('attack').value);
        const decay = parseFloat(D('decay').value);
        const sustain = parseFloat(D('sustain').value);
        newGainNode.gain.cancelScheduledValues(now);
        newGainNode.gain.setValueAtTime(0, now);
        newGainNode.gain.linearRampToValueAtTime(1.0, now + attack);
        newGainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);

        // Update/Create FM Modulator for Osc2 (handles its own node replacement if needed)
        updateOsc2FmModulatorParameters(osc2Note, now, voice);

    } else if (osc2Note) {
        osc2Note.state = 'inactive'; // Mark inactive if worklet not ready
        console.warn(`NoteOn [Voice ${voice.id}]: Worklet not ready, skipping Osc2 component.`);
    }

    // --- Apply Glide / Portamento ---
    const applyGlide = isPortamentoOn && glideTime > 0.001;
    const isMonoLegatoGlide = isMonoMode && isLegatoMode && !isNewMonoNote && applyGlide;
    const isMonoRetriggerGlide = isMonoMode && !isLegatoMode && applyGlide && previousNoteNumber !== null;
    const isPolyGlide = !isMonoMode && applyGlide && previousNoteNumber !== null;
    const isFirstMonoGlide = isMonoMode && isNewMonoNote && applyGlide && lastPlayedNoteNumber !== null;

    if (isMonoLegatoGlide || isMonoRetriggerGlide || isPolyGlide || isFirstMonoGlide) {
        console.log(`NoteOn [Voice ${voice.id}]: Applying Glide (${glideTime.toFixed(3)}s). Type: ${isMonoLegatoGlide?'MonoLegato':isMonoRetriggerGlide?'MonoRetrigger':isPolyGlide?'Poly':isFirstMonoGlide?'FirstMono':'None'}`);

        // Get target pitches (already calculated for Oscs)
        const targetRate = isSampleKeyTrackingOn ? TR2 ** (noteNumber - 12) : 1.0;
        const targetFreqOsc1 = noteToFrequency(noteNumber, osc1OctaveOffset);
        const targetFreqOsc2 = noteToFrequency(noteNumber, osc2OctaveOffset);

        // Get start pitches (use stored values, or read current for legato)
        if (isMonoLegatoGlide) {
            // Read current values just before starting the ramp
            try { glideStartRate = voice.samplerNote?.source?.playbackRate?.value; } catch(e){}
            try { glideStartFreqOsc1 = voice.osc1Note?.workletNode?.parameters?.get('frequency')?.value; } catch(e){}
            try { glideStartFreqOsc2 = voice.osc2Note?.workletNode?.parameters?.get('frequency')?.value; } catch(e){}
            // Read FM source pitch if applicable
            if (osc1FMSource === 'osc2' && voice.osc1Note?.fmModulatorSource instanceof OscillatorNode) {
                try { glideStartFreqFmOsc1 = voice.osc1Note.fmModulatorSource.frequency.value; } catch(e){}
                try { glideStartDetuneFmOsc1 = voice.osc1Note.fmModulatorSource.detune.value; } catch(e){}
            }
            if (osc2FMSource === 'osc1' && voice.osc2Note?.fmModulatorSource instanceof OscillatorNode) {
                try { glideStartFreqFmOsc2 = voice.osc2Note.fmModulatorSource.frequency.value; } catch(e){}
                try { glideStartDetuneFmOsc2 = voice.osc2Note.fmModulatorSource.detune.value; } catch(e){}
            }

            // Fallback if read fails (shouldn't happen in legato)
            if (glideStartRate === undefined || glideStartRate === null) glideStartRate = isSampleKeyTrackingOn ? TR2 ** (previousNoteNumber - 12) : 1.0;
            if (glideStartFreqOsc1 === undefined || glideStartFreqOsc1 === null) glideStartFreqOsc1 = noteToFrequency(previousNoteNumber, osc1OctaveOffset);
            if (glideStartFreqOsc2 === undefined || glideStartFreqOsc2 === null) glideStartFreqOsc2 = noteToFrequency(previousNoteNumber, osc2OctaveOffset);
            if (glideStartFreqFmOsc1 === undefined || glideStartFreqFmOsc1 === null) glideStartFreqFmOsc1 = noteToFrequency(previousNoteNumber, osc2OctaveOffset);
            if (glideStartDetuneFmOsc1 === undefined || glideStartDetuneFmOsc1 === null) glideStartDetuneFmOsc1 = osc2Detune;
            if (glideStartFreqFmOsc2 === undefined || glideStartFreqFmOsc2 === null) glideStartFreqFmOsc2 = noteToFrequency(previousNoteNumber, osc1OctaveOffset);
            if (glideStartDetuneFmOsc2 === undefined || glideStartDetuneFmOsc2 === null) glideStartDetuneFmOsc2 = osc1Detune;
             console.log(`NoteOn: Reading current pitch for MONO LEGATO glide - Rate: ${glideStartRate?.toFixed(4)}, Freq1: ${glideStartFreqOsc1?.toFixed(2)}, Freq2: ${glideStartFreqOsc2?.toFixed(2)}`);
        }
        // Start values for non-legato glide were read earlier

        // Apply ramps to the NEWLY ASSIGNED nodes if start pitch is valid
        const glideDuration = Math.max(glideTime, 0.001); // Ensure non-zero duration

        // Sampler Rate Glide (targets samplerNote.source.playbackRate)
        if (glideStartRate !== null && samplerNote?.source?.playbackRate) {
            const param = samplerNote.source.playbackRate;
            param.cancelScheduledValues(now);
            param.setValueAtTime(isMonoLegatoGlide ? param.value : glideStartRate, now); // Start from current for legato, stored for others
            param.linearRampToValueAtTime(targetRate, now + glideDuration);
        }
        // Osc1 Frequency Glide (targets osc1Note.workletNode frequency param)
        if (glideStartFreqOsc1 !== null && osc1Note?.workletNode) {
            const param = osc1Note.workletNode.parameters.get('frequency');
            if (param) {
                param.cancelScheduledValues(now);
                param.setValueAtTime(isMonoLegatoGlide ? param.value : glideStartFreqOsc1, now);
                param.linearRampToValueAtTime(targetFreqOsc1, now + glideDuration);
            }
        }
        // Osc2 Frequency Glide (targets osc2Note.workletNode frequency param)
        if (glideStartFreqOsc2 !== null && osc2Note?.workletNode) {
            const param = osc2Note.workletNode.parameters.get('frequency');
            if (param) {
                param.cancelScheduledValues(now);
                param.setValueAtTime(isMonoLegatoGlide ? param.value : glideStartFreqOsc2, now);
                param.linearRampToValueAtTime(targetFreqOsc2, now + glideDuration);
            }
        }

        // Glide FM Sources (if oscillator-based)
        // FM for Osc1 (Source: Osc2) - targets osc1Note.fmModulatorSource
        if (osc1FMSource === 'osc2' && osc1Note?.fmModulatorSource instanceof OscillatorNode) {
            const fmSource = osc1Note.fmModulatorSource;
            const fmFreqParam = fmSource.frequency;
            const fmDetuneParam = fmSource.detune;
            const targetFreqFm = noteToFrequency(noteNumber, osc2OctaveOffset); // Target uses Osc2 settings
            const targetDetuneFm = osc2Detune;

            // Start values were read earlier (glideStartFreqFmOsc1, glideStartDetuneFmOsc1)
            const startFreq = isMonoLegatoGlide ? fmFreqParam.value : glideStartFreqFmOsc1;
            const startDetune = isMonoLegatoGlide ? fmDetuneParam.value : glideStartDetuneFmOsc1;

            if (startFreq !== null && fmFreqParam) {
                fmFreqParam.cancelScheduledValues(now);
                fmFreqParam.setValueAtTime(startFreq, now);
                fmFreqParam.linearRampToValueAtTime(targetFreqFm, now + glideDuration);
            }
            if (startDetune !== null && fmDetuneParam) {
                fmDetuneParam.cancelScheduledValues(now);
                fmDetuneParam.setValueAtTime(startDetune, now);
                fmDetuneParam.linearRampToValueAtTime(targetDetuneFm, now + glideDuration);
            }
        }

        // FM for Osc2 (Source: Osc1) - targets osc2Note.fmModulatorSource
        if (osc2FMSource === 'osc1' && osc2Note?.fmModulatorSource instanceof OscillatorNode) {
            const fmSource = osc2Note.fmModulatorSource;
            const fmFreqParam = fmSource.frequency;
            const fmDetuneParam = fmSource.detune;
            const targetFreqFm = noteToFrequency(noteNumber, osc1OctaveOffset); // Target uses Osc1 settings
            const targetDetuneFm = osc1Detune;

            // Start values were read earlier (glideStartFreqFmOsc2, glideStartDetuneFmOsc2)
            const startFreq = isMonoLegatoGlide ? fmFreqParam.value : glideStartFreqFmOsc2;
            const startDetune = isMonoLegatoGlide ? fmDetuneParam.value : glideStartDetuneFmOsc2;

            if (startFreq !== null && fmFreqParam) {
                fmFreqParam.cancelScheduledValues(now);
                fmFreqParam.setValueAtTime(startFreq, now);
                fmFreqParam.linearRampToValueAtTime(targetFreqFm, now + glideDuration);
            }
            if (startDetune !== null && fmDetuneParam) {
                fmDetuneParam.cancelScheduledValues(now);
                fmDetuneParam.setValueAtTime(startDetune, now);
                fmDetuneParam.linearRampToValueAtTime(targetDetuneFm, now + glideDuration);
            }
        }
    }

    // --- Final Updates ---
    lastPlayedNoteNumber = noteNumber; // Update last played note for poly portamento / mono glide start
    // Reset last actual pitch tracking if this was the first mono note glide
    if (isFirstMonoGlide) {
        lastActualSamplerRate = null;
        lastActualOsc1Freq = null;
        lastActualOsc2Freq = null;
    }

    updateVoiceDisplay_Pool();
    updateKeyboardDisplay_Pool();
}

function noteOff(noteNumber) {
    console.log(`noteOff POOL: ${noteNumber}, Mono: ${isMonoMode}, Held: [${heldNotes.join(',')}]`);
    const now = audioCtx.currentTime;

    // Remove from held notes list
    const initialLength = heldNotes.length;
    heldNotes = heldNotes.filter(n => n !== noteNumber);
    const noteWasHeld = heldNotes.length < initialLength;

    if (!noteWasHeld) {
        console.log(`noteOff: Note ${noteNumber} was not in heldNotes array (potentially stolen or already released).`);
        // Update UI even if note wasn't technically held (might have been stolen)
        updateVoiceDisplay_Pool();
        updateKeyboardDisplay_Pool();
        return; // Exit if the note wasn't considered held
    }

    if (isMonoMode) {
        // --- Mono Mode Logic ---
        // Only act if the released note *was* the currently sounding mono note
        if (!currentMonoVoice || currentMonoVoice.noteNumber !== noteNumber) {
            console.log(`Mono NoteOff: Skipping release for ${noteNumber}. Current mono voice is ${currentMonoVoice ? `Note ${currentMonoVoice.noteNumber}` : 'null'}.`);
            // Update UI as a held key was released visually
            updateVoiceDisplay_Pool();
            updateKeyboardDisplay_Pool();
            return;
        }

        // The released note IS the current mono voice. Check if other keys are still held.
        if (heldNotes.length > 0) {
            // --- Other notes still held ---
            const lastHeldNoteNumber = heldNotes[heldNotes.length - 1]; // Get the highest remaining note
            console.log(`Mono NoteOff: Other notes held. Transitioning to ${lastHeldNoteNumber}. Legato: ${isLegatoMode}`);

            if (!isLegatoMode) {
                // --- Multi-trigger: Retrigger last held note ---
                console.log("Mono NoteOff (Multi): Retriggering and gliding down.");
                const voiceBeingReleased = currentMonoVoice;
                const releasedNoteNumber = voiceBeingReleased?.noteNumber;

                if (!voiceBeingReleased || releasedNoteNumber === undefined || releasedNoteNumber === null) {
                    console.error(`Mono NoteOff (Multi): Error! voiceBeingReleased is invalid or has no noteNumber.`);
                    if (voiceBeingReleased) { // Attempt cleanup if voice exists
                        clearScheduledEventsForVoice(voiceBeingReleased);
                        if (voiceBeingReleased.samplerNote) quickFadeOutAndStop(voiceBeingReleased.samplerNote, 0.015);
                        if (voiceBeingReleased.osc1Note) quickFadeOutAndStop(voiceBeingReleased.osc1Note, 0.015);
                        if (voiceBeingReleased.osc2Note) quickFadeOutAndStop(voiceBeingReleased.osc2Note, 0.015);
                        voiceBeingReleased.state = 'inactive'; // Mark inactive immediately
                    }
                    currentMonoVoice = null; // Reset mono voice state
                    updateVoiceDisplay_Pool(); updateKeyboardDisplay_Pool();
                    return; // Exit early
                }

                // --- Get current pitch of the NOTE BEING RELEASED ---
                let startRate = null; let startFreqOsc1 = null; let startFreqOsc2 = null;
                let startFreqFmOsc1 = null; let startDetuneFmOsc1 = null; // For FM sources
                let startFreqFmOsc2 = null; let startDetuneFmOsc2 = null;

                if (isPortamentoOn && glideTime > 0.001) {
                    console.log(`Mono NoteOff (Multi): Reading pitch from released note ${releasedNoteNumber}`);
                    // Read main oscillators
                    if (voiceBeingReleased.samplerNote?.source?.playbackRate) { try { startRate = voiceBeingReleased.samplerNote.source.playbackRate.value; } catch(e){} }
                    if (voiceBeingReleased.osc1Note?.workletNode) { try { const p = voiceBeingReleased.osc1Note.workletNode.parameters.get('frequency'); if(p) startFreqOsc1 = p.value; } catch(e){} }
                    if (voiceBeingReleased.osc2Note?.workletNode) { try { const p = voiceBeingReleased.osc2Note.workletNode.parameters.get('frequency'); if(p) startFreqOsc2 = p.value; } catch(e){} }

                    // Read FM oscillators (if they are OscillatorNodes)
                    if (osc1FMSource === 'osc2' && voiceBeingReleased.osc1Note?.fmModulatorSource instanceof OscillatorNode) {
                        try { startFreqFmOsc1 = voiceBeingReleased.osc1Note.fmModulatorSource.frequency.value; } catch(e){}
                        try { startDetuneFmOsc1 = voiceBeingReleased.osc1Note.fmModulatorSource.detune.value; } catch(e){}
                    }
                    if (osc2FMSource === 'osc1' && voiceBeingReleased.osc2Note?.fmModulatorSource instanceof OscillatorNode) {
                        try { startFreqFmOsc2 = voiceBeingReleased.osc2Note.fmModulatorSource.frequency.value; } catch(e){}
                        try { startDetuneFmOsc2 = voiceBeingReleased.osc2Note.fmModulatorSource.detune.value; } catch(e){}
                    }

                    // Fallback to calculated pitch if actual value couldn't be read
                    if (startRate === null) startRate = isSampleKeyTrackingOn ? TR2 ** (releasedNoteNumber - 12) : 1.0;
                    if (startFreqOsc1 === null) startFreqOsc1 = noteToFrequency(releasedNoteNumber, osc1OctaveOffset);
                    if (startFreqOsc2 === null) startFreqOsc2 = noteToFrequency(releasedNoteNumber, osc2OctaveOffset);
                    if (startFreqFmOsc1 === null && osc1FMSource === 'osc2') startFreqFmOsc1 = noteToFrequency(releasedNoteNumber, osc2OctaveOffset);
                    if (startDetuneFmOsc1 === null && osc1FMSource === 'osc2') startDetuneFmOsc1 = osc2Detune;
                    if (startFreqFmOsc2 === null && osc2FMSource === 'osc1') startFreqFmOsc2 = noteToFrequency(releasedNoteNumber, osc1OctaveOffset);
                    if (startDetuneFmOsc2 === null && osc2FMSource === 'osc1') startDetuneFmOsc2 = osc1Detune;

                    console.log(`Mono NoteOff (Multi): Start Glide - Rate: ${startRate?.toFixed(4)}, Freq1: ${startFreqOsc1?.toFixed(2)}, Freq2: ${startFreqOsc2?.toFixed(2)}`);
                    console.log(`Mono NoteOff (Multi): Start Glide FM - FreqFM1: ${startFreqFmOsc1?.toFixed(2)}, DetuneFM1: ${startDetuneFmOsc1?.toFixed(2)}, FreqFM2: ${startFreqFmOsc2?.toFixed(2)}, DetuneFM2: ${startDetuneFmOsc2?.toFixed(2)}`);
                }
                // --- End Get current pitch ---

                // --- Fade out the components of the note that was just released ---
                console.log(`Mono NoteOff (Multi): Fading out previous components for Note ${releasedNoteNumber}.`);
                clearScheduledEventsForVoice(voiceBeingReleased); // Clear events before fade
                if (voiceBeingReleased.samplerNote) quickFadeOutAndStop(voiceBeingReleased.samplerNote, 0.025);
                if (voiceBeingReleased.osc1Note) quickFadeOutAndStop(voiceBeingReleased.osc1Note, 0.025);
                if (voiceBeingReleased.osc2Note) quickFadeOutAndStop(voiceBeingReleased.osc2Note, 0.025);
                voiceBeingReleased.state = 'inactive'; // Mark as inactive immediately for pool management
                voiceBeingReleased.noteNumber = null;
                // --- End Fade out ---

                // --- Start NEW voice components for the note being returned to (lastHeldNoteNumber) ---
                console.log(`Mono NoteOff (Multi): Starting new components for Note ${lastHeldNoteNumber}.`);
                // Find a voice (might steal the one we just faded, or another)
                const newVoice = findAvailableVoice();
                if (!newVoice) {
                    console.error("Mono NoteOff (Multi): Failed to find available voice for retrigger!");
                    currentMonoVoice = null; // Reset mono voice state
                    updateVoiceDisplay_Pool(); updateKeyboardDisplay_Pool();
                    return;
                }
                currentMonoVoice = newVoice; // Update the current mono voice reference
                newVoice.noteNumber = lastHeldNoteNumber;
                newVoice.startTime = now;
                newVoice.state = 'playing';

                // Configure Sampler
                if (newVoice.samplerNote && audioBuffer) {
                    newVoice.samplerNote.noteNumber = lastHeldNoteNumber;
                    newVoice.samplerNote.state = 'playing';
                    newVoice.samplerNote.startTime = now;
                    newVoice.samplerNote.scheduledEvents = [];
                    // Create NEW source
                    const newSamplerSource = audioCtx.createBufferSource();
                    newVoice.samplerNote.source = newSamplerSource;
                    // Select buffer, set params, connect, trigger ADSR, start (similar to noteOn)
                    let useOriginalBuffer = true; let sourceBuffer = audioBuffer; let bufferType = "original";
                    if (isSampleLoopOn && sampleCrossfadeAmount > 0.01 && cachedCrossfadedBuffer) { sourceBuffer = cachedCrossfadedBuffer; useOriginalBuffer = false; bufferType = "crossfaded"; }
                    else if (fadedBuffer && (!isSampleLoopOn || sampleCrossfadeAmount <= 0.01)) { sourceBuffer = fadedBuffer; useOriginalBuffer = false; bufferType = "faded"; }
                    else if (isEmuModeOn && useOriginalBuffer) { sourceBuffer = applyEmuProcessing(audioBuffer); useOriginalBuffer = false; bufferType = "original_emu"; }

                    if (!sourceBuffer || !(sourceBuffer instanceof AudioBuffer) || sourceBuffer.length === 0) { newVoice.samplerNote.state = 'inactive'; }
                    else {
                        newSamplerSource.buffer = sourceBuffer; newVoice.samplerNote.usesProcessedBuffer = !useOriginalBuffer; newVoice.samplerNote.crossfadeActive = bufferType === "crossfaded";
                        newVoice.samplerNote.sampleNode.gain.value = currentSampleGain;
                        const targetRate = isSampleKeyTrackingOn ? TR2 ** (lastHeldNoteNumber - 12) : 1.0;
                        newSamplerSource.playbackRate.value = targetRate; newSamplerSource.detune.value = currentSampleDetune;
                        let loopStartTime = 0; let loopEndTime = sourceBuffer.duration;
                        if (useOriginalBuffer) { if (isSampleLoopOn) { newSamplerSource.loop = true; loopStartTime = sampleStartPosition * audioBuffer.duration; loopEndTime = sampleEndPosition * audioBuffer.duration; newSamplerSource.loopStart = Math.max(0, loopStartTime); newSamplerSource.loopEnd = Math.min(audioBuffer.duration, loopEndTime); if (newSamplerSource.loopEnd <= newSamplerSource.loopStart) { newSamplerSource.loopEnd = audioBuffer.duration; newSamplerSource.loopStart = 0; } } else { newSamplerSource.loop = false; } }
                        else { newSamplerSource.loop = isSampleLoopOn; }
                        newVoice.samplerNote.looping = newSamplerSource.loop; newVoice.samplerNote.calculatedLoopStart = loopStartTime; newVoice.samplerNote.calculatedLoopEnd = loopEndTime;
                        try { newVoice.samplerNote.sampleNode.disconnect(); newVoice.samplerNote.gainNode.disconnect(); } catch(e) {}
                        newSamplerSource.connect(newVoice.samplerNote.sampleNode); newVoice.samplerNote.sampleNode.connect(newVoice.samplerNote.gainNode); newVoice.samplerNote.gainNode.connect(masterGain);
                        const attack = parseFloat(D('attack').value); const decay = parseFloat(D('decay').value); const sustain = parseFloat(D('sustain').value);
                        newVoice.samplerNote.gainNode.gain.cancelScheduledValues(now); newVoice.samplerNote.gainNode.gain.setValueAtTime(0, now); newVoice.samplerNote.gainNode.gain.linearRampToValueAtTime(1.0, now + attack); newVoice.samplerNote.gainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);
                        newSamplerSource.start(now);
                        if (!newSamplerSource.loop) { /* Schedule stop */ let originalDuration = (useOriginalBuffer ? (sampleEndPosition - sampleStartPosition) * audioBuffer.duration : (fadedBufferOriginalDuration || sourceBuffer.duration)); const playbackRate = newSamplerSource.playbackRate.value; const adjustedDuration = originalDuration / playbackRate; const safetyMargin = 0.05; const stopTime = now + adjustedDuration + safetyMargin; try { newSamplerSource.stop(stopTime); } catch (e) {} }
                    }
                } else if (newVoice.samplerNote) { newVoice.samplerNote.state = 'inactive'; }

                // Configure Osc1
                if (newVoice.osc1Note && isWorkletReady) {
                    newVoice.osc1Note.noteNumber = lastHeldNoteNumber; newVoice.osc1Note.state = 'playing'; newVoice.osc1Note.startTime = now; newVoice.osc1Note.scheduledEvents = [];
                    const workletNode = newVoice.osc1Note.workletNode; const gainNode = newVoice.osc1Note.gainNode; const levelNode = newVoice.osc1Note.levelNode;
                    const targetFreqOsc1 = noteToFrequency(lastHeldNoteNumber, osc1OctaveOffset);
                    const freqParam = workletNode.parameters.get('frequency'); const detuneParam = workletNode.parameters.get('detune'); const holdParam = workletNode.parameters.get('holdAmount'); const quantizeParam = workletNode.parameters.get('quantizeAmount'); const waveTypeParam = workletNode.parameters.get('waveformType'); const waveMapNameToWorkletType = { sine: 0, sawtooth: 1, triangle: 2, square: 3, pulse: 4 };
                    if (freqParam) freqParam.value = targetFreqOsc1; if (detuneParam) detuneParam.value = osc1Detune; if (holdParam) holdParam.value = osc1PWMValue; if (quantizeParam) quantizeParam.value = osc1QuantizeValue; if (waveTypeParam) waveTypeParam.value = waveMapNameToWorkletType[osc1Waveform] ?? 0;
                    levelNode.gain.value = osc1GainValue;
                    try { levelNode.disconnect(); gainNode.disconnect(); } catch(e) {}
                    levelNode.connect(gainNode); gainNode.connect(masterGain);
                    const attack = parseFloat(D('attack').value); const decay = parseFloat(D('decay').value); const sustain = parseFloat(D('sustain').value);
                    gainNode.gain.cancelScheduledValues(now); gainNode.gain.setValueAtTime(0, now); gainNode.gain.linearRampToValueAtTime(1.0, now + attack); gainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);
                    updateOsc1FmModulatorParameters(newVoice.osc1Note, now, newVoice); // Create/Update FM for new note
                } else if (newVoice.osc1Note) { newVoice.osc1Note.state = 'inactive'; }

                // Configure Osc2
                if (newVoice.osc2Note && isWorkletReady) {
                    newVoice.osc2Note.noteNumber = lastHeldNoteNumber; newVoice.osc2Note.state = 'playing'; newVoice.osc2Note.startTime = now; newVoice.osc2Note.scheduledEvents = [];
                    const workletNode = newVoice.osc2Note.workletNode; const gainNode = newVoice.osc2Note.gainNode; const levelNode = newVoice.osc2Note.levelNode;
                    const targetFreqOsc2 = noteToFrequency(lastHeldNoteNumber, osc2OctaveOffset);
                    const freqParam = workletNode.parameters.get('frequency'); const detuneParam = workletNode.parameters.get('detune'); const holdParam = workletNode.parameters.get('holdAmount'); const quantizeParam = workletNode.parameters.get('quantizeAmount'); const waveTypeParam = workletNode.parameters.get('waveformType'); const waveMapNameToWorkletType = { sine: 0, sawtooth: 1, triangle: 2, square: 3, pulse: 4 };
                    if (freqParam) freqParam.value = targetFreqOsc2; if (detuneParam) detuneParam.value = osc2Detune; if (holdParam) holdParam.value = osc2PWMValue; if (quantizeParam) quantizeParam.value = osc2QuantizeValue; if (waveTypeParam) waveTypeParam.value = waveMapNameToWorkletType[osc2Waveform] ?? 0;
                    levelNode.gain.value = osc2GainValue;
                    try { levelNode.disconnect(); gainNode.disconnect(); } catch(e) {}
                    levelNode.connect(gainNode); gainNode.connect(masterGain);
                    const attack = parseFloat(D('attack').value); const decay = parseFloat(D('decay').value); const sustain = parseFloat(D('sustain').value);
                    gainNode.gain.cancelScheduledValues(now); gainNode.gain.setValueAtTime(0, now); gainNode.gain.linearRampToValueAtTime(1.0, now + attack); gainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);
                    updateOsc2FmModulatorParameters(newVoice.osc2Note, now, newVoice); // Create/Update FM for new note
                } else if (newVoice.osc2Note) { newVoice.osc2Note.state = 'inactive'; }
                // --- End Start NEW voice components ---


                // --- Apply glide FROM the released note's pitch TO the held note's pitch on the NEW components ---
                if (isPortamentoOn && glideTime > 0.001 && (startRate !== null || startFreqOsc1 !== null || startFreqOsc2 !== null)) {
                    console.log(`Mono NoteOff (Multi): Applying glide to new components for note ${lastHeldNoteNumber}`);
                    const targetRate = isSampleKeyTrackingOn ? TR2 ** (lastHeldNoteNumber - 12) : 1.0;
                    const targetFreqOsc1 = noteToFrequency(lastHeldNoteNumber, osc1OctaveOffset);
                    const targetFreqOsc2 = noteToFrequency(lastHeldNoteNumber, osc2OctaveOffset);

                    // Glide Sampler Rate (on newVoice.samplerNote)
                    if (newVoice.samplerNote?.source?.playbackRate && startRate !== null) {
                        const p = newVoice.samplerNote.source.playbackRate;
                        p.setValueAtTime(startRate, now); // Start from released pitch
                        p.linearRampToValueAtTime(targetRate, now + glideTime);
                    }
                    // Glide Osc1 Freq (on newVoice.osc1Note)
                    if (newVoice.osc1Note?.workletNode && startFreqOsc1 !== null) {
                        const p = newVoice.osc1Note.workletNode.parameters.get('frequency');
                        if(p) { p.setValueAtTime(startFreqOsc1, now); p.linearRampToValueAtTime(targetFreqOsc1, now + glideTime); }
                    }
                    // Glide Osc2 Freq (on newVoice.osc2Note)
                    if (newVoice.osc2Note?.workletNode && startFreqOsc2 !== null) {
                        const p = newVoice.osc2Note.workletNode.parameters.get('frequency');
                        if(p) { p.setValueAtTime(startFreqOsc2, now); p.linearRampToValueAtTime(targetFreqOsc2, now + glideTime); }
                    }

                    // <<< ADD: Glide FM Sources (Multi-Trigger NoteOff) >>>
                    // FM for Osc1 (Source: Osc2) - Apply to newVoice.osc1Note.fmModulatorSource
                    if (osc1FMSource === 'osc2' && newVoice.osc1Note?.fmModulatorSource instanceof OscillatorNode) {
                        const fmSource = newVoice.osc1Note.fmModulatorSource;
                        const fmFreqParam = fmSource.frequency;
                        const fmDetuneParam = fmSource.detune;
                        // Start pitch comes from the *released* note's FM source (approximated using Osc2 settings)
                        const startFreqFm = startFreqFmOsc1 ?? noteToFrequency(releasedNoteNumber, osc2OctaveOffset); // Use read value or calculate
                        const startDetuneFm = startDetuneFmOsc1 ?? osc2Detune;
                        // Target pitch uses the *held* note's FM source settings
                        const targetFreqFm = noteToFrequency(lastHeldNoteNumber, osc2OctaveOffset);
                        const targetDetuneFm = osc2Detune;

                        if (fmFreqParam && startFreqFm !== null) {
                            fmFreqParam.setValueAtTime(startFreqFm, now); // Start from calculated/read pitch
                            fmFreqParam.linearRampToValueAtTime(targetFreqFm, now + glideTime);
                        }
                        if (fmDetuneParam && startDetuneFm !== null) {
                            fmDetuneParam.setValueAtTime(startDetuneFm, now); // Start from calculated/read detune
                            fmDetuneParam.linearRampToValueAtTime(targetDetuneFm, now + glideTime);
                        }
                    }
                    // FM for Osc2 (Source: Osc1) - Apply to newVoice.osc2Note.fmModulatorSource
                    else if (osc2FMSource === 'osc1' && newVoice.osc2Note?.fmModulatorSource instanceof OscillatorNode) {
                        const fmSource = newVoice.osc2Note.fmModulatorSource;
                        const fmFreqParam = fmSource.frequency;
                        const fmDetuneParam = fmSource.detune;
                        // Start pitch comes from the *released* note's FM source (approximated using Osc1 settings)
                        const startFreqFm = startFreqFmOsc2 ?? noteToFrequency(releasedNoteNumber, osc1OctaveOffset); // Use read value or calculate
                        const startDetuneFm = startDetuneFmOsc2 ?? osc1Detune;
                        // Target pitch uses the *held* note's FM source settings
                        const targetFreqFm = noteToFrequency(lastHeldNoteNumber, osc1OctaveOffset);
                        const targetDetuneFm = osc1Detune;

                        if (fmFreqParam && startFreqFm !== null) {
                            fmFreqParam.setValueAtTime(startFreqFm, now); // Start from calculated/read pitch
                            fmFreqParam.linearRampToValueAtTime(targetFreqFm, now + glideTime);
                        }
                        if (fmDetuneParam && startDetuneFm !== null) {
                            fmDetuneParam.setValueAtTime(startDetuneFm, now); // Start from calculated/read detune
                            fmDetuneParam.linearRampToValueAtTime(targetDetuneFm, now + glideTime);
                        }
                    }
                    // <<< END ADD: Glide FM Sources (Multi-Trigger NoteOff) >>>

                } else {
                     console.log(`Mono NoteOff (Multi): Portamento off or zero glide. New components started at target pitch ${lastHeldNoteNumber}.`);
                }
                // --- End Apply Glide ---

            } else {
                // --- Legato mode: Glide pitch back to the last held note ---
                console.log(`Mono NoteOff (Legato): Gliding pitch back to ${lastHeldNoteNumber}.`);
                const voiceToUpdate = currentMonoVoice;
                const releasedNoteNumber = voiceToUpdate?.noteNumber; // Check if voiceToUpdate exists

                // --- CRITICAL VALIDATION ---
                if (!voiceToUpdate || voiceToUpdate.state === 'killed' || voiceToUpdate.state === 'inactive' || releasedNoteNumber === undefined || releasedNoteNumber === null) {
                    console.error(`Mono NoteOff (Legato): Critical error! voiceToUpdate is invalid or has no noteNumber before glide back.`);
                    updateVoiceDisplay_Pool(); updateKeyboardDisplay_Pool();
                    return; // Exit early
                }
                // Check components individually
                const samplerValid = !voiceToUpdate.samplerNote || (voiceToUpdate.samplerNote.state !== 'killed' && voiceToUpdate.samplerNote.source);
                const osc1Valid = !voiceToUpdate.osc1Note || (voiceToUpdate.osc1Note.state !== 'killed' && voiceToUpdate.osc1Note.workletNode);
                const osc2Valid = !voiceToUpdate.osc2Note || (voiceToUpdate.osc2Note.state !== 'killed' && voiceToUpdate.osc2Note.workletNode);

                if (!samplerValid || !osc1Valid || !osc2Valid) {
                     console.error(`Mono NoteOff (Legato): Critical error! Required components are invalid/killed before glide back.`);
                     // Attempt cleanup
                     clearScheduledEventsForVoice(voiceToUpdate);
                     if (voiceToUpdate.samplerNote && !samplerValid) quickFadeOutAndStop(voiceToUpdate.samplerNote, 0.01);
                     if (voiceToUpdate.osc1Note && !osc1Valid) quickFadeOutAndStop(voiceToUpdate.osc1Note, 0.01);
                     if (voiceToUpdate.osc2Note && !osc2Valid) quickFadeOutAndStop(voiceToUpdate.osc2Note, 0.01);
                     voiceToUpdate.state = 'inactive'; voiceToUpdate.noteNumber = null;
                     currentMonoVoice = null;
                     updateVoiceDisplay_Pool(); updateKeyboardDisplay_Pool();
                     return;
                }
                // --- End validation ---

                // Update voice state FIRST
                voiceToUpdate.noteNumber = lastHeldNoteNumber;
                // Update component note numbers
                if (voiceToUpdate.samplerNote) voiceToUpdate.samplerNote.noteNumber = lastHeldNoteNumber;
                if (voiceToUpdate.osc1Note) voiceToUpdate.osc1Note.noteNumber = lastHeldNoteNumber;
                if (voiceToUpdate.osc2Note) voiceToUpdate.osc2Note.noteNumber = lastHeldNoteNumber;

                // Glide pitch FROM current pitch DOWN TO the held note's pitch
                const glideDuration = Math.max(glideTime, 0.001);
                const targetRate = isSampleKeyTrackingOn ? TR2 ** (lastHeldNoteNumber - 12) : 1.0;
                const targetFreqOsc1 = noteToFrequency(lastHeldNoteNumber, osc1OctaveOffset);
                const targetFreqOsc2 = noteToFrequency(lastHeldNoteNumber, osc2OctaveOffset);

                // Sampler Glide
                if (voiceToUpdate.samplerNote?.source?.playbackRate) {
                    const p = voiceToUpdate.samplerNote.source.playbackRate;
                    p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); p.linearRampToValueAtTime(targetRate, now + glideDuration);
                }
                 // Osc1 Glide
                 if (voiceToUpdate.osc1Note?.workletNode) {
                    const p = voiceToUpdate.osc1Note.workletNode.parameters.get('frequency');
                    if(p) { p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); p.linearRampToValueAtTime(targetFreqOsc1, now + glideDuration); }
                }
                 // Osc2 Glide
                if (voiceToUpdate.osc2Note?.workletNode) {
                    const p = voiceToUpdate.osc2Note.workletNode.parameters.get('frequency');
                    if(p) { p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); p.linearRampToValueAtTime(targetFreqOsc2, now + glideDuration); }
                }

                // <<< ADD: Glide FM Sources (Legato NoteOff) >>>
                // FM for Osc1 (Source: Osc2)
                if (osc1FMSource === 'osc2' && voiceToUpdate.osc1Note?.fmModulatorSource instanceof OscillatorNode) {
                    const fmSource = voiceToUpdate.osc1Note.fmModulatorSource;
                    const fmFreqParam = fmSource.frequency;
                    const fmDetuneParam = fmSource.detune;
                    const targetFreqFm = noteToFrequency(lastHeldNoteNumber, osc2OctaveOffset); // Target uses Osc2 settings
                    const targetDetuneFm = osc2Detune;

                    if (fmFreqParam) {
                        fmFreqParam.cancelScheduledValues(now);
                        fmFreqParam.setValueAtTime(fmFreqParam.value, now); // Start from current
                        fmFreqParam.linearRampToValueAtTime(targetFreqFm, now + glideDuration);
                    }
                    if (fmDetuneParam) {
                        fmDetuneParam.cancelScheduledValues(now);
                        fmDetuneParam.setValueAtTime(fmDetuneParam.value, now); // Start from current
                        fmDetuneParam.linearRampToValueAtTime(targetDetuneFm, now + glideDuration);
                    }
                }
                // FM for Osc2 (Source: Osc1)
                else if (osc2FMSource === 'osc1' && voiceToUpdate.osc2Note?.fmModulatorSource instanceof OscillatorNode) {
                    const fmSource = voiceToUpdate.osc2Note.fmModulatorSource;
                    const fmFreqParam = fmSource.frequency;
                    const fmDetuneParam = fmSource.detune;
                    const targetFreqFm = noteToFrequency(lastHeldNoteNumber, osc1OctaveOffset); // Target uses Osc1 settings
                    const targetDetuneFm = osc1Detune;

                    if (fmFreqParam) {
                        fmFreqParam.cancelScheduledValues(now);
                        fmFreqParam.setValueAtTime(fmFreqParam.value, now); // Start from current
                        fmFreqParam.linearRampToValueAtTime(targetFreqFm, now + glideDuration);
                    }
                    if (fmDetuneParam) {
                        fmDetuneParam.cancelScheduledValues(now);
                        fmDetuneParam.setValueAtTime(fmDetuneParam.value, now); // Start from current
                        fmDetuneParam.linearRampToValueAtTime(targetDetuneFm, now + glideDuration);
                    }
                }
                // <<< END ADD: Glide FM Sources (Legato NoteOff) >>>
            }
            lastPlayedNoteNumber = lastHeldNoteNumber; // Update last played note
        } else {
            // --- No notes left held ---
            console.log(`Mono NoteOff: No other notes held. Releasing current mono voice (Note ${noteNumber}).`);
             const voiceToRelease = currentMonoVoice;

             // Store last actual pitch BEFORE nullifying/releasing
             if (voiceToRelease?.samplerNote?.source?.playbackRate) { try { lastActualSamplerRate = voiceToRelease.samplerNote.source.playbackRate.value; } catch(e){} } else { lastActualSamplerRate = null; }
             if (voiceToRelease?.osc1Note?.workletNode) { try { const p = voiceToRelease.osc1Note.workletNode.parameters.get('frequency'); if(p) lastActualOsc1Freq = p.value; } catch(e){} } else { lastActualOsc1Freq = null; }
             if (voiceToRelease?.osc2Note?.workletNode) { try { const p = voiceToRelease.osc2Note.workletNode.parameters.get('frequency'); if(p) lastActualOsc2Freq = p.value; } catch(e){} } else { lastActualOsc2Freq = null; }
             console.log(`Mono NoteOff: Stored last actual pitch - Rate: ${lastActualSamplerRate?.toFixed(4)}, Freq1: ${lastActualOsc1Freq?.toFixed(2)}, Freq2: ${lastActualOsc2Freq?.toFixed(2)}`);

             currentMonoVoice = null; // Nullify the global reference

             if (voiceToRelease) {
                // Initiate release phase for each component
                if (voiceToRelease.samplerNote) releaseSamplerNote(voiceToRelease.samplerNote);
                if (voiceToRelease.osc1Note) releaseOsc1Note(voiceToRelease.osc1Note);
                if (voiceToRelease.osc2Note) releaseOsc2Note(voiceToRelease.osc2Note);
                // The release functions will eventually call kill functions, which mark the voice inactive
           } else {
                  console.warn(`Mono NoteOff: voiceToRelease was unexpectedly null when releasing last key for note ${noteNumber}.`);
                  lastActualSamplerRate = null; lastActualOsc1Freq = null; lastActualOsc2Freq = null;
             }
        }
    } else {
        // --- Poly Mode Logic ---
        // Find the voice playing this note
        const voiceToRelease = voicePool.find(v => v.noteNumber === noteNumber && v.state !== 'inactive');

        if (voiceToRelease) {
             console.log(`Poly NoteOff: Found voice ${voiceToRelease.id} for note ${noteNumber}. Releasing components.`);
             // Initiate release phase for each component
            if (voiceToRelease.samplerNote && (voiceToRelease.samplerNote.state === 'playing' || voiceToRelease.samplerNote.state === 'fadingOut')) { releaseSamplerNote(voiceToRelease.samplerNote); }
            if (voiceToRelease.osc1Note && (voiceToRelease.osc1Note.state === 'playing' || voiceToRelease.osc1Note.state === 'fadingOut')) { releaseOsc1Note(voiceToRelease.osc1Note); }
            if (voiceToRelease.osc2Note && (voiceToRelease.osc2Note.state === 'playing' || voiceToRelease.osc2Note.state === 'fadingOut')) { releaseOsc2Note(voiceToRelease.osc2Note); }
            // The release functions will eventually call kill functions, which mark the voice inactive
        } else {
             console.log(`Poly NoteOff: No active voice found for noteNumber ${noteNumber}.`);
        }
    }

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
        isMonoMode = newState; // Direct assignment
        console.log('>>> Mono Mode SET:', isMonoMode);
        cleanupAllNotes(); 
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