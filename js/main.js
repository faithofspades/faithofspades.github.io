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
// <<< CHANGE FILENAME AND PROCESSOR NAME >>>
audioCtx.audioWorklet.addModule('js/shape-hold-processor.js').then(() => {
    console.log('ShapeHoldProcessor AudioWorklet loaded successfully.'); // <<< Updated log
    isWorkletReady = true;
}).catch(error => {
    console.error('Failed to load ShapeHoldProcessor AudioWorklet:', error); // <<< Updated log
    // Handle error appropriately
});
// --- End Load AudioWorklet ---

// --- Handle AudioContext Suspension/Resumption ---
function handleVisibilityChange() {
    if (!audioCtx) return; // Exit if context not initialized

    if (document.hidden) {
        console.log("Page hidden, AudioContext might suspend. Clearing release timers.");
        // --- Cancel Pending Release Timers ---
        Object.values(activeVoices).forEach(voice => {
            if (voice) {
                [voice.samplerNote, voice.osc1Note].forEach(note => {
                    if (note && note.state === 'releasing' && note.killTimerId) {
                        console.log(`Clearing release timer ${note.killTimerId} for hidden note ${note.id}`);
                        clearTimeout(note.killTimerId);
                        note.killTimerId = null; // Clear the stored ID
                    }
                });
            }
        });
        // --- End Cancel Timers ---
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

    Object.keys(activeVoices).forEach(noteNumber => { // Iterate using keys for safe deletion
         const voice = activeVoices[noteNumber];
         if (voice) {
            // Check Sampler Note
            const samplerNote = voice.samplerNote;
            // <<< MODIFICATION: Force gain to 0 and kill if state was 'releasing' and timer was cleared >>>
            if (samplerNote && samplerNote.state === 'releasing' && !samplerNote.killTimerId) {
                console.log(`Forcing gain to 0 and killing sampler note ${samplerNote.id} immediately on resume (was releasing when focus lost).`);
                try {
                    // Force gain to 0 immediately
                    samplerNote.gainNode.gain.cancelScheduledValues(now);
                    samplerNote.gainNode.gain.setValueAtTime(0, now);
                } catch (e) {
                    console.warn(`Error forcing gain to 0 for sampler note ${samplerNote.id}:`, e);
                }
                killSamplerNote(samplerNote); // Kill directly
                notesKilledOnResume++;
            }

            // Check Osc1 Note
            const osc1Note = voice.osc1Note;
             // <<< MODIFICATION: Force gain to 0 and kill if state was 'releasing' and timer was cleared >>>
             if (osc1Note && osc1Note.state === 'releasing' && !osc1Note.killTimerId) {
                 console.log(`Forcing gain to 0 and killing osc1 note ${osc1Note.id} immediately on resume (was releasing when focus lost).`);
                 try {
                    // Force gain to 0 immediately
                    osc1Note.gainNode.gain.cancelScheduledValues(now);
                    osc1Note.gainNode.gain.setValueAtTime(0, now);
                 } catch (e) {
                    console.warn(`Error forcing gain to 0 for osc1 note ${osc1Note.id}:`, e);
                 }
                 killOsc1Note(osc1Note); // Kill directly
                 notesKilledOnResume++;
            }
         }
    });

    if (notesKilledOnResume > 0) {
        console.log(`Force-killed ${notesKilledOnResume} note components that were releasing when focus was lost.`);
        updateVoiceDisplay(); // Update UI if notes were killed
        updateKeyboardDisplay();
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


let isMonoMode = false;
let isLegatoMode = false;
let isPortamentoOn = false;
let glideTime = 0.1; // seconds
let heldNotes = []; // Keep track of held notes in mono mode


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
 * Updates or creates the FM modulator source and gain for an existing Osc1 note.
 * Handles both 'sampler' and 'osc2' as FM sources.
 * @param {object} osc1Note - The oscillator note object containing fmModulatorSource and fmDepthGain.
 * @param {number} now - The current audio context time.
 * @param {object} [voice] - Optional: The parent voice object containing both osc1Note and osc2Note. Needed for 'osc2' source.
 */
function updateOsc1FmModulatorParameters(osc1Note, now, voice = null) { // <<< Add optional voice parameter
    // <<< Add Log >>>
    console.log(`updateOsc1FmModulatorParameters ENTER: noteId=${osc1Note?.id}, global osc1FMSource=${osc1FMSource}, voice provided: ${!!voice}, voice.osc2Note exists: ${!!voice?.osc2Note}`);
    // --- Prerequisites Check ---
    const freqParam = osc1Note?.workletNode?.parameters.get('frequency');
    const prerequisitesMet = osc1Note &&
                              osc1Note.workletNode &&
                              freqParam &&
                              osc1FMAmount > 0.001;

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
                osc1Note.fmModulatorSource.disconnect();
            } catch(e) {}
            osc1Note.fmModulatorSource = null;
        }
        // Disconnect from frequency parameter if disconnecting gain
        if (osc1Note?.fmDepthGain) {
            try {
                if (freqParam) osc1Note.fmDepthGain.disconnect(freqParam); // Use checked freqParam
                osc1Note.fmDepthGain.disconnect();
            } catch(e) {}
            console.log(`updateOsc1FmModulatorParameters [${osc1Note?.id}]: Nullifying fmDepthGain due to unmet prerequisites (${reason}).`);
            osc1Note.fmDepthGain = null; // <<< Ensure nullified
        }
        return; // Exit if prerequisites aren't met
    }
    // --- End Prerequisites Check ---


    const noteId = osc1Note.id;
    const noteNumber = osc1Note.noteNumber;
    console.log(`updateOsc1FmModulatorParameters [${noteId}]: Updating FM modulator (Source: ${osc1FMSource}, Amount: ${osc1FMAmount.toFixed(3)}).`);

    // --- Stop and disconnect old source ---
    if (osc1Note.fmModulatorSource) {
        try {
            osc1Note.fmModulatorSource.stop(0);
            osc1Note.fmModulatorSource.disconnect();
            console.log(`updateOsc1FmModulatorParameters [${noteId}]: Stopped and disconnected old FM source.`);
        } catch(e) { /* Ignore errors */ }
        osc1Note.fmModulatorSource = null;
    }

    // --- Disconnect old depth gain (but don't nullify yet) ---
    if (osc1Note.fmDepthGain) {
        try {
            // freqParam is guaranteed to exist here due to prerequisite check
            osc1Note.fmDepthGain.disconnect(freqParam);
            osc1Note.fmDepthGain.disconnect(); // Disconnect from others
            console.log(`updateOsc1FmModulatorParameters [${noteId}]: Disconnected old FM depth gain connections.`);
        } catch(e) {}
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
                 if (osc1Note.fmDepthGain) { try { osc1Note.fmDepthGain.disconnect(); } catch(e) {} osc1Note.fmDepthGain = null; } // Clean up gain node
                 return; // Don't proceed
            }

            newFmSource = audioCtx.createBufferSource();

            // --- Mirror Buffer Selection --- (Existing Logic is Good)
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
                 if (osc1Note.fmDepthGain) { try { osc1Note.fmDepthGain.disconnect(); } catch(e) {} osc1Note.fmDepthGain = null; }
                 return;
            }
            newFmSource.buffer = sourceBuffer;
            console.log(`updateOsc1FmModulatorParameters [${noteId}]: Using ${bufferType} buffer for FM.`);

            // --- Mirror Pitch/Rate --- (Existing Logic is Good)
            let calculatedRate = 1.0;
            if (isSampleKeyTrackingOn) {
                calculatedRate = TR2 ** (noteNumber - 12);
                newFmSource.playbackRate.value = calculatedRate;
                newFmSource.detune.setValueAtTime(currentSampleDetune, now);
            } else {
                newFmSource.playbackRate.value = 1.0;
                newFmSource.detune.value = currentSampleDetune;
            }

            // --- Mirror Loop Settings --- (Existing Logic is Good)
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
            // Find the corresponding osc2Note (requires 'voice' parameter or lookup)
            const osc2Note = voice?.osc2Note; // Assumes 'voice' is passed in

            // <<< Check if osc2Note and its workletNode exist >>>
            if (osc2Note && osc2Note.workletNode) {
                newFmSource = audioCtx.createOscillator();
                // Mirror basic Osc2 settings initially
                newFmSource.type = osc2Waveform === 'pulse' ? 'square' : osc2Waveform; // Map pulse to square for basic oscillator
                const baseOsc2Freq = noteToFrequency(noteNumber, osc2OctaveOffset); // Use Osc2's octave offset for base freq
                newFmSource.frequency.setValueAtTime(baseOsc2Freq, now);
                newFmSource.detune.setValueAtTime(osc2Detune, now); // Use Osc2's global detune initially

                // <<< ADD: Try to get current values from the active osc2Note worklet >>>
                try {
                    const currentFreqParam = osc2Note.workletNode.parameters.get('frequency');
                    const currentDetuneParam = osc2Note.workletNode.parameters.get('detune');
                    // Override with current values if available
                    if (currentFreqParam) {
                        newFmSource.frequency.setValueAtTime(currentFreqParam.value, now);
                        console.log(`updateOsc1FmModulatorParameters [${noteId}]: Set FM Osc freq from active osc2Note: ${currentFreqParam.value.toFixed(2)}`);
                    }
                    if (currentDetuneParam) {
                        newFmSource.detune.setValueAtTime(currentDetuneParam.value, now);
                         console.log(`updateOsc1FmModulatorParameters [${noteId}]: Set FM Osc detune from active osc2Note: ${currentDetuneParam.value.toFixed(2)}`);
                    }
                    console.log(`updateOsc1FmModulatorParameters [${noteId}]: Using basic OscillatorNode (${newFmSource.type}) mirroring active Osc2 note parameters.`);
                } catch(e) {
                    console.warn(`updateOsc1FmModulatorParameters [${noteId}]: Error getting current Osc2 params, using globals. Error: ${e}`);
                    // Fallback to globals already set above
                    console.log(`updateOsc1FmModulatorParameters [${noteId}]: Using basic OscillatorNode (${newFmSource.type}) mirroring global Osc2 settings (error reading active note).`);
                }
                // <<< END ADD >>>

            } else {
                // <<< Fallback if no active osc2Note or workletNode found >>>
                console.log(`updateOsc1FmModulatorParameters [${noteId}]: No active Osc2 note/worklet found. Creating basic OscillatorNode mirroring global Osc2 settings.`);
                newFmSource = audioCtx.createOscillator();
                newFmSource.type = osc2Waveform === 'pulse' ? 'square' : osc2Waveform;
                const osc2Freq = noteToFrequency(noteNumber, osc2OctaveOffset);
                newFmSource.frequency.setValueAtTime(osc2Freq, now);
                newFmSource.detune.setValueAtTime(osc2Detune, now);
                // <<< REMOVED Redundant Warning/Return Block >>>
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
            if (osc1Note.fmDepthGain) { try { osc1Note.fmDepthGain.disconnect(); } catch(e) {} osc1Note.fmDepthGain = null; }
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
        // console.log(`Clearing ${note.scheduledEvents.length} scheduled events for note ${note.id}`);
        note.scheduledEvents.forEach(event => {
            if (event.type === "timeout" && event.id) {
                clearTimeout(event.id);
                // console.log(`Cleared timeout ID: ${event.id}`);
            }
            // Add handling for other event types if needed (e.g., Tone.Transport events)
            // else if (event.type === "toneDispose" && event.id) {
            //    Tone.Transport.clear(event.id);
            // }
        });
        note.scheduledEvents = []; // Clear the array
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
// <<< ADD: Update active Osc1 FM modulators AFTER buffer processing >>>
const nowRec = audioCtx.currentTime;
Object.values(activeVoices).forEach(voice => {
    if (voice && voice.osc1Note) {
        updateOsc1FmModulatorParameters(voice.osc1Note, nowRec, voice);
    }
});
// <<< END ADD >>>
  // 8) Update any active notes to use the new buffer
  Object.values(activeVoices).forEach(note => {
    if (note && note.source) {
        // Skip held notes
        if (heldNotes.includes(note.noteNumber)) {
              console.log(`Note ${note.id} is held; will update on release.`);
              return;
          }
          console.log(`Updating note ${note.id} to use recorded sample`);
          note.usesProcessedBuffer = false;
          note.crossfadeActive = false;
          if (isSampleLoopOn) {
              note.looping = true;
              setupLoopCrossfade(note); // Assumes this uses global audioBuffer/cachedCrossfadedBuffer
          }
          updateSamplePlaybackParameters(note); // Assumes this uses global audioBuffer/cachedCrossfadedBuffer
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
        // Update all active sampler notes' sample gain
        Object.values(activeVoices).forEach(voice => {
            if (voice && voice.samplerNote && voice.samplerNote.sampleNode) {
                voice.samplerNote.sampleNode.gain.value = currentSampleGain;
            }
        });
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

        // Update all active sampler notes' pitch AND their corresponding FM modulators
        Object.values(activeVoices).forEach(voice => {
            // Update main sampler note
            if (voice && voice.samplerNote && voice.samplerNote.source) {
                voice.samplerNote.source.detune.setTargetAtTime(currentSampleDetune, now, 0.01);
            }
            // <<< ADD: Update corresponding FM modulator detune >>>
            if (voice && voice.osc1Note && voice.osc1Note.fmModulatorSource) {
                voice.osc1Note.fmModulatorSource.detune.setTargetAtTime(currentSampleDetune, now, 0.01);
            }
            // <<< END ADD >>>
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
        Object.values(activeVoices).forEach(voice => {
            // Check if the voice and the specific osc1 levelNode exist
            if (voice && voice.osc1Note && voice.osc1Note.levelNode) {
                const levelNode = voice.osc1Note.levelNode;
                // Smoothly transition the levelNode's gain to the new global value
                levelNode.gain.setTargetAtTime(osc1GainValue, now, 0.015); // Use setTargetAtTime for smoothness
            }
        });
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
        Object.values(activeVoices).forEach(voice => {
            // <<< Simplify: Only target workletNode >>>
            if (voice && voice.osc1Note && voice.osc1Note.workletNode) {
                const oscDetuneParam = voice.osc1Note.workletNode.parameters.get('detune');
                if (oscDetuneParam) {
                    oscDetuneParam.setTargetAtTime(osc1Detune, now, 0.01);
                }
            }
        });
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
        Object.values(activeVoices).forEach(voice => {
            if (voice && voice.osc1Note) {
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
        // --- CORRECTED BLOCK ---
        if (newStartPosition !== sampleStartPosition) { // <<< FIX: Check newStartPosition against sampleStartPosition
            sampleStartPosition = newStartPosition; // <<< FIX: Assign newStartPosition to sampleStartPosition

            // Update processing immediately (this handles trimming/fading AND schedules crossfade creation if needed)
            updateSampleProcessing();

            const tooltip = createTooltipForKnob('sample-start-knob', value); // Use original value for tooltip positioning
            tooltip.textContent = `Start: ${(sampleStartPosition * 100).toFixed(0)}%`;
            tooltip.style.opacity = '1';
            console.log('Sample Start:', (sampleStartPosition * 100).toFixed(0) + '%');

            // Debounce note updates (NO buffer creation here)
            if (startUpdateTimer) { clearTimeout(startUpdateTimer); } // <<< FIX: Use startUpdateTimer
            startUpdateTimer = setTimeout(() => { // <<< FIX: Use startUpdateTimer
                // updateSampleProcessing should have finished or scheduled buffer creation by now.
                // updateSamplePlaybackParameters will pick the correct buffer.
                console.log("Start knob settled - updating active notes.");
                Object.values(activeVoices).forEach(voice => {
                    if (voice && voice.samplerNote && !heldNotes.includes(voice.noteNumber)) {
                        console.log(`Updating sampler note ${voice.samplerNote.id} after start change.`);
                        updateSamplePlaybackParameters(voice.samplerNote);
                    } else if (voice && voice.samplerNote && heldNotes.includes(voice.noteNumber)) {
                        console.log(`Skipping update for held sampler note ${voice.samplerNote.id} after start change.`);
                    }
                });
                startUpdateTimer = null; // <<< FIX: Use startUpdateTimer
            }, 150); // Delay to allow updateSampleProcessing's timeouts to potentially finish
        // --- END CORRECTED BLOCK ---
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
            if (endUpdateTimer) { clearTimeout(endUpdateTimer); }
            endUpdateTimer = setTimeout(() => {
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
                    Object.values(activeVoices).forEach(voice => {
                         if (voice && voice.samplerNote && !heldNotes.includes(voice.noteNumber)) {
                            console.log(`Updating sampler note ${voice.samplerNote.id} after end change.`);
                            updateSamplePlaybackParameters(voice.samplerNote);
                        } else if (voice && voice.samplerNote && heldNotes.includes(voice.noteNumber)) {
                            console.log(`Skipping update for held sampler note ${voice.samplerNote.id} after end change.`);
                        }
                    });
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

        // --- REMOVE THIS ENTIRE INCORRECT BLOCK ---
        /*
        // Only update if the value actually changed to prevent unnecessary processing
        if (newStartPosition !== sampleStartPosition) { // <<< ERROR: newStartPosition not defined here
            sampleStartPosition = newStartPosition;

            // Update processing immediately (this handles trimming/fading AND schedules crossfade creation if needed)
            updateSampleProcessing();

            // ... (tooltip update logic) ..
            tooltip.textContent = 'Sample Start:', (sampleStartPosition * 100).toFixed(0) + '%'; // <<< Incorrect tooltip
            tooltip.style.opacity = '1';

            // Debounce note updates (NO buffer creation here)
            if (startUpdateTimer) { clearTimeout(startUpdateTimer); } // <<< Incorrect timer
            startUpdateTimer = setTimeout(() => { // <<< Incorrect timer
                // updateSampleProcessing should have finished or scheduled buffer creation by now.
                // updateSamplePlaybackParameters will pick the correct buffer.
                console.log("Start knob settled - updating active notes.");
                Object.values(activeVoices).forEach(voice => {
                    if (voice && voice.samplerNote && !heldNotes.includes(voice.noteNumber)) {
                        console.log(`Updating sampler note ${voice.samplerNote.id} after start change.`);
                        updateSamplePlaybackParameters(voice.samplerNote);
                    } else if (voice && voice.samplerNote && heldNotes.includes(voice.noteNumber)) {
                        console.log(`Skipping update for held sampler note ${voice.samplerNote.id} after start change.`);
                    }
                });
                startUpdateTimer = null; // <<< Incorrect timer
            }, 150); // Delay to allow updateSampleProcessing's timeouts to potentially finish
        } else {
            tooltip.textContent = 'Sample Start:', (sampleStartPosition * 100).toFixed(0) + '%'; // <<< Incorrect tooltip
            tooltip.style.opacity = '1';
        }
        */
        // --- END REMOVED BLOCK ---

        // --- ADD CORRECT DEBOUNCED NOTE UPDATE ---
        // Update sample processing immediately
        updateSampleProcessing();

        // Debounce note updates using the correct timer
        if (crossfadeUpdateTimer) { clearTimeout(crossfadeUpdateTimer); }
        crossfadeUpdateTimer = setTimeout(() => {
            // updateSampleProcessing should have finished or scheduled buffer creation by now.
            // updateSamplePlaybackParameters will pick the correct buffer.
            console.log("Crossfade knob settled - updating active notes.");
            Object.values(activeVoices).forEach(voice => {
                if (voice && voice.samplerNote && !heldNotes.includes(voice.noteNumber)) {
                    console.log(`Updating sampler note ${voice.samplerNote.id} after crossfade change.`);
                    updateSamplePlaybackParameters(voice.samplerNote);
                } else if (voice && voice.samplerNote && heldNotes.includes(voice.noteNumber)) {
                    console.log(`Skipping update for held sampler note ${voice.samplerNote.id} after crossfade change.`);
                }
            });
            crossfadeUpdateTimer = null;
        }, 150); // Delay to allow updateSampleProcessing's timeouts to potentially finish
        // --- END CORRECT DEBOUNCED NOTE UPDATE ---

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
        // Use a separate timer if needed, or reuse one if logic is identical
        if (fadeProcessTimer) { clearTimeout(fadeProcessTimer); }
        fadeProcessTimer = setTimeout(() => {
             if (audioBuffer) {
                 // Update any active (non-held) sampler notes
                 Object.values(activeVoices).forEach(voice => {
                     if (voice && voice.samplerNote && !heldNotes.includes(voice.noteNumber)) {
                         console.log(`Updating sampler note ${voice.samplerNote.id} after fade change.`);
                         // updateSamplePlaybackParameters will pick up the new fadedBuffer
                         updateSamplePlaybackParameters(voice.samplerNote);
                     } else if (voice && voice.samplerNote && heldNotes.includes(voice.noteNumber)) {
                         console.log(`Skipping update for held sampler note ${voice.samplerNote.id} after fade change.`);
                     }
                 });
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
        // <<< Simplified tooltip >>>
        tooltip.textContent = `Shape: ${(holdAmount * 100).toFixed(0)}%`;
        tooltip.style.opacity = '1';

        // Update active notes
        const now = audioCtx.currentTime;
        Object.values(activeVoices).forEach(voice => {
            // <<< Simplify: Only target workletNode >>>
            if (voice && voice.osc1Note && voice.osc1Note.workletNode) {
                const holdParam = voice.osc1Note.workletNode.parameters.get('holdAmount');
                if (holdParam) {
                    holdParam.setTargetAtTime(holdAmount, now, 0.015);
                }
            }
        });
        // <<< Simplified log >>>
        console.log(`Osc1 PWM/Shape Knob: ${holdAmount.toFixed(2)}`);
    },

    // <<< ADD Quantize Knob Callback >>>
    'osc1-quantize-knob': (value) => {
        osc1QuantizeValue = value; // Update global quantize amount

        const quantizeAmount = osc1QuantizeValue; // Value is 0-1

        const tooltip = createTooltipForKnob('osc1-quantize-knob', value);
        tooltip.textContent = `Quant: ${(quantizeAmount * 100).toFixed(0)}%`;
        tooltip.style.opacity = '1';

        // Update active notes
        const now = audioCtx.currentTime;
        Object.values(activeVoices).forEach(voice => {
            if (voice && voice.osc1Note && voice.osc1Note.workletNode) {
                const quantizeParam = voice.osc1Note.workletNode.parameters.get('quantizeAmount');
                if (quantizeParam) {
                    quantizeParam.setTargetAtTime(quantizeAmount, now, 0.015);
                }
            }
        });
        console.log(`Osc1 Quantize Knob: ${quantizeAmount.toFixed(2)}`);
    },
    // <<< ADD OSC 2 KNOBS >>>
    'osc2-gain-knob': (value) => {
        osc2GainValue = value;
        const tooltip = createTooltipForKnob('osc2-gain-knob', value);
        tooltip.textContent = `Gain: ${Math.round(value * 100)}%`;
        tooltip.style.opacity = '1';
        // Update active Osc2 notes
        Object.values(activeVoices).forEach(voice => {
            if (voice && voice.osc2Note && voice.osc2Note.levelNode) {
                voice.osc2Note.levelNode.gain.setTargetAtTime(osc2GainValue, audioCtx.currentTime, 0.01);
            }
        });
        console.log(`Osc2 Gain set to: ${value.toFixed(2)}`);
    },
    'osc2-pitch-knob': (value) => {
        // Map 0-1 to -1200 to +1200 cents
        osc2Detune = (value - 0.5) * 200;
        const tooltip = createTooltipForKnob('osc2-pitch-knob', value);
        tooltip.textContent = `Pitch: ${osc2Detune.toFixed(0)}c`;
        tooltip.style.opacity = '1';
        // Update active Osc2 notes
        Object.values(activeVoices).forEach(voice => {
            if (voice && voice.osc2Note && voice.osc2Note.workletNode) {
                const detuneParam = voice.osc2Note.workletNode.parameters.get('detune');
                if (detuneParam) {
                    detuneParam.setTargetAtTime(osc2Detune, audioCtx.currentTime, 0.01);
                }
            }
        });
        console.log(`Osc2 Detune set to: ${osc2Detune.toFixed(1)} cents`);
    },
    'osc2-pwm-knob': (value) => {
    osc2PWMValue = value;
    const tooltip = createTooltipForKnob('osc2-pwm-knob', value);
    tooltip.textContent = `Shape: ${Math.round(value * 100)}%`; // Use Shape for consistency
    tooltip.style.opacity = '1';
    const now = audioCtx.currentTime;
    // <<< REMOVE THE IF CHECK WRAPPING THE LOOP >>>
    // Update active Osc2 notes regardless of waveform
    Object.values(activeVoices).forEach(voice => {
        if (voice && voice.osc2Note && voice.osc2Note.workletNode) {
            const holdParam = voice.osc2Note.workletNode.parameters.get('holdAmount');
            if (holdParam) {
                holdParam.setTargetAtTime(osc2PWMValue, now, 0.015); // Use the updated global value
            }
        }
    });
    console.log(`Osc2 PWM/Shape set to: ${value.toFixed(2)}`);
},
    'osc2-quantize-knob': (value) => {
        osc2QuantizeValue = value;
        const tooltip = createTooltipForKnob('osc2-quantize-knob', value);
        tooltip.textContent = `Quant: ${Math.round(value * 100)}%`;
        tooltip.style.opacity = '1';
        // Update active Osc2 notes
        Object.values(activeVoices).forEach(voice => {
            if (voice && voice.osc2Note && voice.osc2Note.workletNode) {
                const quantParam = voice.osc2Note.workletNode.parameters.get('quantizeAmount');
                if (quantParam) {
                    quantParam.setTargetAtTime(osc2QuantizeValue, audioCtx.currentTime, 0.015);
                }
            }
        });
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
        Object.values(activeVoices).forEach(voice => {
            if (voice && voice.osc2Note) {
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
        // --- END UPDATE ---

        console.log(`Osc2 FM Knob Raw: ${value.toFixed(3)}, Curved: ${osc2FMAmount.toFixed(3)}, Depth: ${scaledDepth.toFixed(1)} Hz`);
    },
    // <<< END ADD OSC 2 KNOBS >>>

    // ... other knobs like glide-time ...
};
/**
 * Updates an existing sampler note's playback parameters (buffer, loop, rate, etc.)
 * by aggressively replacing its source and gain nodes.
 * @param {object} note - The sampler note object (e.g., activeVoices[noteNumber].samplerNote).
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
// <<< ADD: Update corresponding FM modulator AFTER main note is updated >>>
const voice = Object.values(activeVoices).find(v => v && v.samplerNote === note);
if (voice && voice.osc1Note) {
    updateOsc1FmModulatorParameters(voice.osc1Note, audioCtx.currentTime, voice);
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

const MAX_MONO = 1;
let audioBuffer = null;
const MAX_POLYPHONY = 6;
const activeVoices = []; // FIFO queue of active notes with their key info

const playingNotes = [];
let playingNoteCount = 0;




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

// Update the voice monitoring display
// Update the voice display function to handle releasing state
// Update the updateVoiceDisplay function
// Update the updateVoiceDisplay function to also update keyboard
function updateVoiceDisplay() {
    const displayEl = D('voice-display');
    if (!displayEl) return;
    displayEl.innerHTML = ''; // Clear previous display

    // Count unique active note numbers where at least one component is playing
    let playingNoteCount = 0;
    const playingNoteNumbers = new Set();

    for (const noteNumber in activeVoices) {
        const voice = activeVoices[noteNumber];
        if (voice) {
            const isSamplerPlaying = voice.samplerNote && voice.samplerNote.state === 'playing';
            const isOsc1Playing = voice.osc1Note && voice.osc1Note.state === 'playing';
            // Add || voice.osc2Note... later

            if (isSamplerPlaying || isOsc1Playing) {
                playingNoteNumbers.add(parseInt(noteNumber));
            }
        }
    }
    playingNoteCount = playingNoteNumbers.size;

    // Update count display
    const voiceCountEl = D('voice-count');
    if (voiceCountEl) {
        voiceCountEl.textContent = Math.min(playingNoteCount, MAX_POLYPHONY);
    }

    // Update visual key indicators
    keys.forEach((key, index) => {
        const voiceItem = document.createElement('div');
        voiceItem.className = 'voice-item';
        voiceItem.textContent = key;
        if (playingNoteNumbers.has(index)) {
            voiceItem.classList.add('active-voice');
        }
        displayEl.appendChild(voiceItem);
    });
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


function updateKeyboardDisplay() {
    document.querySelectorAll('.key').forEach(keyElement => {
        const noteIndex = parseInt(keyElement.dataset.noteIndex);
        let isNotePlaying = false;
        const voice = activeVoices[noteIndex];
        if (voice) {
             const isSamplerPlaying = voice.samplerNote && voice.samplerNote.state === 'playing';
             const isOsc1Playing = voice.osc1Note && voice.osc1Note.state === 'playing';
             isNotePlaying = isSamplerPlaying || isOsc1Playing;
        }
        // Also consider physically held keys for visual feedback
        const isHeld = heldNotes.includes(noteIndex);
        keyElement.classList.toggle('pressed', isNotePlaying || isHeld);
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
        // <<< ADD: Update active Osc1 FM modulators AFTER buffer processing >>>
const nowFile = audioCtx.currentTime;
Object.values(activeVoices).forEach(voice => {
    if (voice && voice.osc1Note) {
        updateOsc1FmModulatorParameters(voice.osc1Note, nowFile, voice);
    }
});
// <<< END ADD >>>
        // Update any active notes to use the new buffer
        Object.values(activeVoices).forEach(note => {
            if (note && note.source) {
              // Skip held notes to avoid interruption
              if (heldNotes.includes(note.noteNumber)) {
                    console.log(`Note ${note.id} is held; will update on release.`);
                    return;
                }
                
                console.log(`Updating note ${note.id} to use new sample`);
                note.usesProcessedBuffer = false;
                note.crossfadeActive = false;
                
                if (isSampleLoopOn) {
                    note.looping = true; 
                    setupLoopCrossfade(note);
                }
                updateSamplePlaybackParameters(note);
            }
        }).catch(e => console.error("Error decoding audio data:", e));
    });
};
reader.readAsArrayBuffer(file);
}



D('audio-file').addEventListener('change', handleFileSelect);

// Clean up everything
// Clean up everything
function cleanupAllNotes() {
    console.log("Cleaning up all notes...");
    const notesToKill = Object.keys(activeVoices);
    notesToKill.forEach(noteNumber => {
        const voice = activeVoices[noteNumber];
        if (voice) {
            // Use quick fade out for immediate silence
            if (voice.samplerNote) quickFadeOutSampler(voice.samplerNote, 0.01);
            if (voice.osc1Note) quickFadeOutOsc1(voice.osc1Note, 0.01);
            if (voice.osc2Note) quickFadeOutOsc2(voice.osc2Note, 0.01); // <<< Kill Osc2
        }
        // kill functions will handle removing from activeVoices after fade
    });

    resetKeyStates();
    currentMonoVoice = null;
    heldNotes = [];
    // lastPlayedNoteNumber = null; // Keep for portamento

    updateVoiceDisplay();
    updateKeyboardDisplay();
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
updateVoiceDisplay();
updateADSRVisualization();
// Initialize Keyboard Module
initializeKeyboard('keyboard', noteOn, noteOff, updateKeyboardDisplay)


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
// Update any playing samples
Object.values(activeVoices).forEach(note => {
    if (note.source) updateSamplePlaybackParameters(note);
    });
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
const nowPreset = audioCtx.currentTime;
Object.values(activeVoices).forEach(voice => {
    if (voice && voice.osc1Note) {
        updateOsc1FmModulatorParameters(voice.osc1Note, nowPreset, voice);
    }
});
// Update any active notes to use the new buffer
Object.values(activeVoices).forEach(note => {
    if (note && note.source) {
      // Skip held notes to avoid interruption
      if (heldNotes.includes(note.noteNumber)) {
    console.log(`Note ${note.id} is held; will update on release.`);
    return;
  }
  
  console.log(`Updating note ${note.id} to use new preset sample`);
  note.usesProcessedBuffer = false;
  note.crossfadeActive = false;
  
  if (isSampleLoopOn) {
    note.looping = true; 
    setupLoopCrossfade(note);
  }
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
// --- Sampler Note Creation/Management (Based on old startNote/createNote) ---
function startSamplerNote(noteNumber, audioCtx, destination, buffer) {
    if (!buffer) return null; // Need a buffer
    const noteId = `sampler_${noteNumber}_${Date.now()}`;
    const gainNode = audioCtx.createGain(); // ADSR Gain
    const sampleNode = audioCtx.createGain(); // Sampler-specific gain
    gainNode.gain.value = 0; // Start silent for ADSR
    sampleNode.gain.value = currentSampleGain;

    const source = audioCtx.createBufferSource();

    // Select the correct buffer (original, faded, or crossfaded)
    let useOriginalBuffer = true;
    let sourceBuffer = buffer;
    let bufferType = "original";

    if (isSampleLoopOn && sampleCrossfadeAmount > 0.01 && cachedCrossfadedBuffer) {
        sourceBuffer = cachedCrossfadedBuffer;
        useOriginalBuffer = false;
        bufferType = "crossfaded";
    } else if (fadedBuffer && (!isSampleLoopOn || sampleCrossfadeAmount <= 0.01)) {
        sourceBuffer = fadedBuffer;
        useOriginalBuffer = false;
        bufferType = "faded";
    }

    if (!sourceBuffer || !(sourceBuffer instanceof AudioBuffer)) {
         console.error(`startSamplerNote [${noteNumber}]: Invalid sourceBuffer selected (type: ${bufferType}).`);
         return null;
    }
    source.buffer = sourceBuffer;
    console.log(`Starting sampler note ${noteNumber} using ${bufferType} buffer.`);

    // Apply playback rate / detune
    let calculatedRate = 1.0;
    if (isSampleKeyTrackingOn) {
        calculatedRate = TR2 ** (noteNumber - 12);
        source.playbackRate.value = calculatedRate;
        source.detune.setValueAtTime(currentSampleDetune, audioCtx.currentTime);
    } else {
        source.playbackRate.value = 1.0;
        source.detune.value = currentSampleDetune;
    }

    // Connect nodes: source -> sampleNode (sample gain) -> gainNode (ADSR) -> destination
    source.connect(sampleNode);
    sampleNode.connect(gainNode);
    gainNode.connect(destination);

    // Set loop points
    let loopStartTime = 0;
    let loopEndTime = sourceBuffer.duration;
    if (useOriginalBuffer) {
        if (isSampleLoopOn) {
            source.loop = true;
            loopStartTime = sampleStartPosition * buffer.duration;
            loopEndTime = sampleEndPosition * buffer.duration;
            source.loopStart = loopStartTime;
            source.loopEnd = loopEndTime;
        } else {
             source.loop = false;
        }
    } else {
        source.loop = isSampleLoopOn; // Loop the entire processed buffer if needed
    }

    // Apply ADSR envelope
    const attack = parseFloat(D('attack').value);
    const decay = parseFloat(D('decay').value);
    const sustain = parseFloat(D('sustain').value);
    const now = audioCtx.currentTime;
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(1, now + attack); // ADSR controls overall level
    gainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);

    // Start playback
    source.start(0);

    // Schedule stop if not looping
    if (!source.loop) {
        let originalDuration;
        // Determine the duration based on which buffer is playing
        if (bufferType === "faded" && fadedBufferOriginalDuration) {
             originalDuration = fadedBufferOriginalDuration; // Use stored duration before fades
        } else if (bufferType === "crossfaded") {
             // This case shouldn't happen if !source.loop, but handle defensively
             originalDuration = sourceBuffer.duration;
        } else { // Original buffer (or original_emu)
             // Use the duration of the selected segment from the *original* buffer
             originalDuration = (sampleEndPosition - sampleStartPosition) * buffer.duration; // Use the initially passed buffer reference
        }

        const playbackRate = source.playbackRate.value; // Use the actual rate
        const adjustedDuration = originalDuration / playbackRate;
        const safetyMargin = 0.05; // Small margin
        const stopTime = now + adjustedDuration + safetyMargin;
        try {
             source.stop(stopTime);
             console.log(`startSamplerNote [${noteId}]: Source scheduled to stop at ${stopTime.toFixed(3)}`);
        } catch (e) { console.error(`Error scheduling stop for sampler note ${noteId}:`, e); }
    }

    const note = {
        id: noteId,
        type: 'sampler',
        noteNumber,
        source,
        gainNode, // ADSR gain
        sampleNode, // Sampler-specific gain
        startTime: now,
        state: "playing", // "playing", "releasing", "fadingOut", "killed"
        scheduledEvents: [],
        looping: source.loop,
        usesProcessedBuffer: !useOriginalBuffer,
        crossfadeActive: bufferType === "crossfaded", // Correctly set based on buffer used
        calculatedLoopStart: loopStartTime,
        calculatedLoopEnd: loopEndTime,
        isBeingUpdated: false // Add this flag
    };
    return note;
}

function releaseSamplerNote(note) {
    if (!note || note.state !== "playing") return;
    note.state = "releasing";
    // Clear any previous kill timer just in case
    if (note.killTimerId) {
        clearTimeout(note.killTimerId);
        note.killTimerId = null;
    }
    clearScheduledEventsForNote(note); // Clear other events

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
    const killDelay = Math.max(100, (release * 1000) + 100); // Ensure minimum delay
    const releaseTimer = setTimeout(() => {
        note.killTimerId = null; // Clear ID before killing
        killSamplerNote(note);
    }, killDelay);

    note.killTimerId = releaseTimer; // <<< STORE THE TIMER ID
    note.scheduledEvents.push({ type: "timeout", id: releaseTimer }); // Keep for general cleanup if needed
}

function killSamplerNote(note) {
    // Check if note is valid and not already killed
    if (!note || note.state === "killed") return false;
    const noteId = note.id;
    const originalNoteNumber = note.noteNumber; // Store for logging, but don't rely on it for lookup
    console.log(`killSamplerNote: Starting kill process for ${noteId} (Original Note ${originalNoteNumber})`);
    note.state = "killed";

    clearScheduledEventsForNote(note);

    try {
        // Stop and disconnect audio nodes
        if (note.gainNode) {
            note.gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
            note.gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
            setTimeout(() => { try { note.gainNode.disconnect(); } catch(e){} }, 20);
        }
        if (note.sampleNode) {
            setTimeout(() => { try { note.sampleNode.disconnect(); } catch(e){} }, 20);
        }
        if (note.source) {
            try { note.source.stop(audioCtx.currentTime); } catch(e) {}
            setTimeout(() => { try { note.source.disconnect(); } catch(e){} }, 20);
        }
    } catch (e) {
         console.warn(`killSamplerNote [${noteId}]: Error during node cleanup:`, e);
    }

    // --- Robust activeVoices update ---
    let voiceEntryKey = null;
    let voiceEntry = null;

    // Find the voice entry containing this specific note object
    for (const key in activeVoices) {
        if (activeVoices[key].samplerNote === note) {
            voiceEntryKey = key;
            voiceEntry = activeVoices[key];
            break;
        }
    }

    if (voiceEntry) {
        console.log(`killSamplerNote [${noteId}]: Found matching samplerNote in activeVoices[${voiceEntryKey}]. Nullifying.`);
        voiceEntry.samplerNote = null; // Nullify the reference in the found entry

        // Check if the voice entry is now empty
        if (!voiceEntry.samplerNote && !voiceEntry.osc1Note) {
            console.log(`killSamplerNote [${noteId}]: Both components for note ${voiceEntryKey} in activeVoices are now null. Deleting voice entry activeVoices[${voiceEntryKey}].`);
            delete activeVoices[voiceEntryKey]; // Delete the entry using the key we found
        }
    } else {
        // If the note wasn't found in any active voice entry (already removed, stolen, etc.)
        console.log(`killSamplerNote [${noteId}]: Note object not found in any activeVoices entry during cleanup (expected if stolen/retriggered/legato state changed).`);
    }
    // --- End Robust update ---

    // Update UI regardless
    updateVoiceDisplay();
    updateKeyboardDisplay();

    console.log(`killSamplerNote: Finished killing ${noteId}`);
    return true;
}

function quickFadeOutSampler(note, fadeTime = 0.05) {
    if (!note || !note.gainNode || note.state === "fadingOut" || note.state === "killed") return note;
    note.state = "fadingOut";
    try {
        const now = audioCtx.currentTime;
        const currentGain = note.gainNode.gain.value;
        note.gainNode.gain.cancelScheduledValues(now);
        note.gainNode.gain.setValueAtTime(currentGain, now);
        note.gainNode.gain.linearRampToValueAtTime(0, now + fadeTime);
        const killTimer = setTimeout(() => killSamplerNote(note), fadeTime * 1000 + 10);
        note.scheduledEvents.push({ type: 'timeout', id: killTimer });
    } catch (e) {
        killSamplerNote(note); // Kill immediately on error
    }
    return note;
}

// --- Oscillator 1 Note Creation/Management ---
function startOsc1Note(noteNumber, audioCtx, destination) {
    // if (osc1GainValue <= 0.001) return null;
    // <<< Always check worklet readiness >>>
    if (!isWorkletReady) {
        console.error(`startOsc1Note: ShapeHoldProcessor AudioWorklet not ready. Aborting.`);
        return null;
    }

    const noteId = `osc1_${noteNumber}_${Date.now()}`;
    const osc1LevelNode = audioCtx.createGain();
    const oscGainNode = audioCtx.createGain(); // ADSR Gain
    osc1LevelNode.gain.value = osc1GainValue;
    oscGainNode.gain.value = 0;

    let workletNode = null;
    let fmModulatorSource = null; // <<< ADD: For per-voice FM source
    let fmDepthGain = null;     // <<< ADD: For per-voice FM depth

    const now = audioCtx.currentTime;
    // Base frequency for the note (before FM is applied via parameter)
    const baseFreq = noteToFrequency(noteNumber, osc1OctaveOffset);
    const targetFreq = noteToFrequency(noteNumber, osc1OctaveOffset);
    const waveMapNameToWorkletType = { sine: 0, sawtooth: 1, triangle: 2, square: 3, pulse: 4 };

    try {
        // --- Create Worklet Node (as before) ---
        const waveformTypeValue = waveMapNameToWorkletType[osc1Waveform] !== undefined ? waveMapNameToWorkletType[osc1Waveform] : 0;
        const holdAmountValue = osc1PWMValue;
        const quantizeValue = osc1QuantizeValue;

        workletNode = new AudioWorkletNode(audioCtx, 'shape-hold-processor', {
            parameterData: {
                frequency: baseFreq, // <<< Set BASE frequency here
                detune: osc1Detune,
                holdAmount: holdAmountValue,
                quantizeAmount: quantizeValue,
                waveformType: waveformTypeValue
            }
        });

        // --- ADD: Per-Voice FM Setup ---
        const freqParam = workletNode.parameters.get('frequency'); // Get frequency param for connection

        if (osc1FMAmount > 0.001 && freqParam) { // Only setup if FM is on and param exists
            console.log(`startOsc1Note [${noteId}]: Setting up FM (Source: ${osc1FMSource}).`);
            fmDepthGain = audioCtx.createGain();
            const scaledDepth = osc1FMAmount * osc1FMDepthScale;
            fmDepthGain.gain.value = scaledDepth;

            if (osc1FMSource === 'sampler' && audioBuffer) {
                // --- Sampler FM Source ---
                fmModulatorSource = audioCtx.createBufferSource();
                // Mirror Buffer Selection
                let useOriginalBuffer = true;
                let sourceBuffer = audioBuffer;
                let bufferType = "original_fm";
                if (isSampleLoopOn && sampleCrossfadeAmount > 0.01 && cachedCrossfadedBuffer) {
                    sourceBuffer = cachedCrossfadedBuffer; useOriginalBuffer = false; bufferType = "crossfaded_fm";
                } else if (fadedBuffer && (!isSampleLoopOn || sampleCrossfadeAmount <= 0.01)) {
                    sourceBuffer = fadedBuffer; useOriginalBuffer = false; bufferType = "faded_fm";
                }
                if (!sourceBuffer || !(sourceBuffer instanceof AudioBuffer)) {
                    console.error(`startOsc1Note FM [${noteId}]: Invalid sourceBuffer selected for FM (type: ${bufferType}). Skipping FM setup.`);
                    fmModulatorSource = null; fmDepthGain = null;
                } else {
                    fmModulatorSource.buffer = sourceBuffer;
                    console.log(`startOsc1Note FM [${noteId}]: Using ${bufferType} buffer.`);
                    // Mirror Pitch/Rate
                    let calculatedRate = 1.0;
                    if (isSampleKeyTrackingOn) { calculatedRate = TR2 ** (noteNumber - 12); }
                    fmModulatorSource.playbackRate.value = calculatedRate;
                    fmModulatorSource.detune.setValueAtTime(currentSampleDetune, now);
                    // Mirror Loop Settings
                    let loopStartTime = 0; let loopEndTime = sourceBuffer.duration;
                    if (useOriginalBuffer) {
                        if (isSampleLoopOn) {
                            fmModulatorSource.loop = true; loopStartTime = sampleStartPosition * audioBuffer.duration; loopEndTime = sampleEndPosition * audioBuffer.duration;
                            fmModulatorSource.loopStart = Math.max(0, loopStartTime); fmModulatorSource.loopEnd = Math.min(audioBuffer.duration, loopEndTime);
                            if (fmModulatorSource.loopEnd <= fmModulatorSource.loopStart) { fmModulatorSource.loopEnd = audioBuffer.duration; fmModulatorSource.loopStart = 0; }
                        } else { fmModulatorSource.loop = false; }
                    } else { fmModulatorSource.loop = isSampleLoopOn; }
                    console.log(`startOsc1Note FM [${noteId}]: Loop=${fmModulatorSource.loop}, Start=${fmModulatorSource.loopStart.toFixed(3)}, End=${fmModulatorSource.loopEnd.toFixed(3)}`);
                    // Connect FM Chain
                    fmModulatorSource.connect(fmDepthGain);
                    fmDepthGain.connect(freqParam);
                    fmModulatorSource.start(now);
                }
            } else if (osc1FMSource === 'osc2') {
                // --- Osc2 FM Source ---
                // NOTE: This requires looking up the *currently playing* Osc2 note for the *same voice*.
                // This is complex during initial note start. Using a basic oscillator mirroring global settings is a fallback.
                // A better approach might involve passing the 'voice' object to startOsc1Note if possible,
                // or looking it up via activeVoices[noteNumber].osc2Note.
                // For now, using the basic oscillator approach:
                fmModulatorSource = audioCtx.createOscillator();
                fmModulatorSource.type = osc2Waveform === 'pulse' ? 'square' : osc2Waveform;
                const osc2Freq = noteToFrequency(noteNumber, osc2OctaveOffset); // Use Osc2 settings
                fmModulatorSource.frequency.setValueAtTime(osc2Freq, now);
                fmModulatorSource.detune.setValueAtTime(osc2Detune, now); // Use Osc2 detune
                console.log(`startOsc1Note FM [${noteId}]: Using basic OscillatorNode (${fmModulatorSource.type}) mirroring Osc2 settings.`);
                // Connect FM Chain
                fmModulatorSource.connect(fmDepthGain);
                fmDepthGain.connect(freqParam);
                fmModulatorSource.start(now);
            } else {
                // Unknown source or prerequisites not met
                console.warn(`startOsc1Note FM [${noteId}]: FM source '${osc1FMSource}' not handled or buffer missing. FM disconnected.`);
                fmModulatorSource = null; fmDepthGain = null;
            }
        } else {
             console.log(`startOsc1Note [${noteId}]: FM is off or frequency parameter missing. Skipping FM setup.`);
             fmModulatorSource = null; fmDepthGain = null;
        }
        // --- END Per-Voice FM Setup ---

        // Connect main audio path
        workletNode.connect(osc1LevelNode);
        osc1LevelNode.connect(oscGainNode);
        oscGainNode.connect(destination);
        console.log(`startOsc1Note [${noteId}]: Using AudioWorklet ${osc1Waveform}.`);
    } catch (e) {
        // ... (error handling) ...
        return null;
    }
    // Apply ADSR envelope
    const attack = parseFloat(D('attack').value);
    const decay = parseFloat(D('decay').value);
    const sustainLevel = parseFloat(D('sustain').value);
    oscGainNode.gain.setValueAtTime(0, now);
    oscGainNode.gain.linearRampToValueAtTime(1.0, now + attack);
    oscGainNode.gain.linearRampToValueAtTime(sustainLevel, now + attack + decay);

    const note = {
        id: noteId,
        type: 'osc1',
        noteNumber,
        oscillator: null, // Keep null, not used
        workletNode: workletNode,
        levelNode: osc1LevelNode,
        gainNode: oscGainNode, // ADSR gain
        fmModulatorSource: fmModulatorSource, // <<< STORE FM source
        fmDepthGain: fmDepthGain,         // <<< STORE FM gain
        startTime: now,
        state: "playing",
        scheduledEvents: []
    };

    if (note.workletNode) {
        return note;
    } else {
        console.error(`startOsc1Note [${noteId}]: Failed to create worklet node. Returning null.`);
        try { osc1LevelNode.disconnect(); } catch(e){}
        try { oscGainNode.disconnect(); } catch(e){}
        return null;
    }
}

function releaseOsc1Note(note) {
    if (!note || note.state !== "playing") return;
    note.state = "releasing";
    // Clear any previous kill timer
    if (note.killTimerId) {
        clearTimeout(note.killTimerId);
        note.killTimerId = null;
    }
    clearScheduledEventsForNote(note); // Clear other events

    const release = parseFloat(D('release').value);
    const now = audioCtx.currentTime;

    // Apply release ramp to the ADSR gain node (native)
    note.gainNode.gain.cancelScheduledValues(now);
    const currentGain = note.gainNode.gain.value;
    note.gainNode.gain.setValueAtTime(currentGain, now);
    note.gainNode.gain.linearRampToValueAtTime(0, now + release);

    // Schedule the oscillator stop
    const stopTime = now + release + 0.05; // Use native context time

    if (note.toneOscillator) {
        // Stop Tone.js oscillator
        try {
            note.toneOscillator.stop(stopTime);
            // Schedule disposal slightly after stop time
            note.scheduledEvents.push({ type: "toneDispose", time: stopTime + 0.1 });
        } catch(e) { console.warn(`Error stopping Tone oscillator ${note.id}:`, e); }
    } else if (note.oscillator) {
        // Stop native oscillator
        try {
            note.oscillator.stop(stopTime);
        } catch(e) { console.warn(`Error stopping native oscillator ${note.id}:`, e); }
    }

    // Schedule final cleanup (killOsc1Note) and store timer ID
    const killDelay = Math.max(100, (release * 1000) + 100); // Ensure minimum delay
    const releaseTimer = setTimeout(() => {
        note.killTimerId = null; // Clear ID before killing
        killOsc1Note(note);
    }, killDelay);

    note.killTimerId = releaseTimer; // <<< STORE THE TIMER ID
    note.scheduledEvents.push({ type: "timeout", id: releaseTimer }); // Keep for general cleanup
}

function killOsc1Note(note) {
    if (!note || note.state === "killed") return false;

    const noteId = note.id;
    const originalNoteNumber = note.noteNumber;
    console.log(`killOsc1Note: Starting kill process for ${noteId} (Original Note ${originalNoteNumber})`);
    note.state = "killed";

    clearScheduledEventsForNote(note);

    try {
        // --- ADD: Cleanup FM Nodes ---
        if (note.fmModulatorSource) {
            try { note.fmModulatorSource.stop(0); } catch(e) {}
            setTimeout(() => {
                try { note.fmModulatorSource.disconnect(); } catch(e){}
                console.log(`killOsc1Note [${noteId}]: Disconnected fmModulatorSource.`);
            }, 20);
        }
        if (note.fmDepthGain) {
            // Disconnect from parameter first if possible
            if (note.workletNode) {
                 try {
                     // <<< DISCONNECT FROM frequency PARAMETER >>>
                     const freqParam = note.workletNode.parameters.get('frequency');
                     if (freqParam) note.fmDepthGain.disconnect(freqParam);
                 } catch(e) {}
            }
            setTimeout(() => {
                try { note.fmDepthGain.disconnect(); } catch(e){}
                console.log(`killOsc1Note [${noteId}]: Disconnected fmDepthGain.`);
            }, 20);
        }
        // --- END: Cleanup FM Nodes ---

        // --- Existing Node Cleanup (gainNode, levelNode, workletNode) ---
        const now = audioCtx.currentTime;
        if (note.gainNode) {
            note.gainNode.gain.cancelScheduledValues(now);
            note.gainNode.gain.setValueAtTime(note.gainNode.gain.value, now);
            note.gainNode.gain.linearRampToValueAtTime(0, now + 0.01);
            setTimeout(() => { try { note.gainNode.disconnect(); } catch(e){} }, 20);
        }
        if (note.levelNode) {
            setTimeout(() => { try { note.levelNode.disconnect(); } catch(e){} }, 20);
        }
        if (note.workletNode) {
            // No need to disconnect fmDepthGain from parameter here again
            setTimeout(() => { try { note.workletNode.disconnect(); } catch(e){} }, 20);
        }
        // --- End Existing Node Cleanup ---

    } catch (e) {
        console.error(`Error during killOsc1Note cleanup for ${noteId}:`, e);
    }

    // --- Robust activeVoices update ---
    let voiceEntryKey = null;
    let voiceEntry = null;

    // Find the voice entry containing this specific note object
    for (const key in activeVoices) {
        if (activeVoices[key].osc1Note === note) {
            voiceEntryKey = key;
            voiceEntry = activeVoices[key];
            break;
        }
    }

    if (voiceEntry) {
        console.log(`killOsc1Note [${noteId}]: Found matching osc1Note in activeVoices[${voiceEntryKey}]. Nullifying.`);
        voiceEntry.osc1Note = null; // Nullify the reference in the found entry

        // Check if the voice entry is now empty
        if (!voiceEntry.samplerNote && !voiceEntry.osc1Note) {
            console.log(`killOsc1Note [${noteId}]: Both components for note ${voiceEntryKey} in activeVoices are now null. Deleting voice entry activeVoices[${voiceEntryKey}].`);
            delete activeVoices[voiceEntryKey]; // Delete the entry using the key we found
        }
    } else {
        // If the note wasn't found in any active voice entry
        console.log(`killOsc1Note [${noteId}]: Note object not found in any activeVoices entry during cleanup (expected if stolen/retriggered/legato state changed).`);
    }
    // --- End Robust update ---

    updateVoiceDisplay();
    updateKeyboardDisplay();

    console.log(`killOsc1Note: Finished killing ${noteId}`);
    return true;
}

function quickFadeOutOsc1(note, fadeTime = 0.05) {
    if (!note || !note.gainNode || note.state === "fadingOut" || note.state === "killed") return note;
    note.state = "fadingOut";
    try {
        const now = audioCtx.currentTime;
        const currentGain = note.gainNode.gain.value;
        note.gainNode.gain.cancelScheduledValues(now);
        note.gainNode.gain.setValueAtTime(currentGain, now);
        note.gainNode.gain.linearRampToValueAtTime(0, now + fadeTime);
        const killTimer = setTimeout(() => killOsc1Note(note), fadeTime * 1000 + 10);
        note.scheduledEvents.push({ type: 'timeout', id: killTimer });
    } catch (e) {
        killOsc1Note(note); // Kill immediately on error
    }
    return note;
}
// --- Oscillator 2 Note Creation/Management --- // <<< ADD OSC 2 FUNCTIONS >>>

/**
 * Creates and starts an Oscillator 2 component using the AudioWorklet.
 * Includes setup for FM modulation *of* Osc2.
 * @param {number} noteNumber - MIDI note number.
 * @param {AudioContext} audioCtx - The audio context.
 * @param {AudioNode} destination - The node to connect the output to (masterGain).
 * @returns {object|null} The Osc2 note object or null on failure.
 */
function startOsc2Note(noteNumber, audioCtx, destination) {
    // if (osc2GainValue <= 0.001) return null; // Skip if gain is zero
    if (!isWorkletReady) {
        console.error(`startOsc2Note: ShapeHoldProcessor AudioWorklet not ready. Aborting.`);
        return null;
    }

    const noteId = `osc2_${noteNumber}_${Date.now()}`;
    const osc2LevelNode = audioCtx.createGain(); // Osc2 specific gain control
    const oscGainNode = audioCtx.createGain();   // ADSR Gain envelope
    osc2LevelNode.gain.value = osc2GainValue;
    oscGainNode.gain.value = 0; // Start silent for ADSR

    let workletNode = null;
    let fmModulatorSource = null; // For FM *of* Osc2
    let fmDepthGain = null;     // For FM *of* Osc2

    const now = audioCtx.currentTime;
    const baseFreq = noteToFrequency(noteNumber, osc2OctaveOffset); // Use Osc2 octave offset
    const waveMapNameToWorkletType = { sine: 0, sawtooth: 1, triangle: 2, square: 3, pulse: 4 };

    try {
        // --- Create Worklet Node ---
        const waveformTypeValue = waveMapNameToWorkletType[osc2Waveform] !== undefined ? waveMapNameToWorkletType[osc2Waveform] : 0; // Use Osc2 waveform
        const holdAmountValue = osc2PWMValue; // Use Osc2 PWM
        const quantizeValue = osc2QuantizeValue; // Use Osc2 Quantize

        workletNode = new AudioWorkletNode(audioCtx, 'shape-hold-processor', {
            parameterData: {
                frequency: baseFreq, // Base frequency before FM
                detune: osc2Detune, // Use Osc2 detune
                holdAmount: holdAmountValue,
                quantizeAmount: quantizeValue,
                waveformType: waveformTypeValue
            }
        });

        // --- Per-Voice FM Setup (Modulating Osc2) ---
        const freqParam = workletNode.parameters.get('frequency'); // Get frequency param for connection

        if (osc2FMAmount > 0.001 && freqParam) { // Only setup if FM is on and param exists
            console.log(`startOsc2Note [${noteId}]: Setting up FM (Source: ${osc2FMSource}).`);
            fmDepthGain = audioCtx.createGain();
            const scaledDepth = osc2FMAmount * osc2FMDepthScale; // Use Osc2 amount/scale
            fmDepthGain.gain.value = scaledDepth;

            if (osc2FMSource === 'sampler' && audioBuffer) {
                // --- Sampler FM Source ---
                fmModulatorSource = audioCtx.createBufferSource();
                // Mirror Buffer Selection
                let useOriginalBuffer = true;
                let sourceBuffer = audioBuffer;
                let bufferType = "original_fm_osc2";
                if (isSampleLoopOn && sampleCrossfadeAmount > 0.01 && cachedCrossfadedBuffer) {
                    sourceBuffer = cachedCrossfadedBuffer; useOriginalBuffer = false; bufferType = "crossfaded_fm_osc2";
                } else if (fadedBuffer && (!isSampleLoopOn || sampleCrossfadeAmount <= 0.01)) {
                    sourceBuffer = fadedBuffer; useOriginalBuffer = false; bufferType = "faded_fm_osc2";
                }
                if (!sourceBuffer || !(sourceBuffer instanceof AudioBuffer)) {
                    console.error(`startOsc2Note FM [${noteId}]: Invalid sourceBuffer selected for FM (type: ${bufferType}). Skipping FM setup.`);
                    fmModulatorSource = null; fmDepthGain = null;
                } else {
                    fmModulatorSource.buffer = sourceBuffer;
                    console.log(`startOsc2Note FM [${noteId}]: Using ${bufferType} buffer.`);
                    // Mirror Pitch/Rate (Based on Sampler settings)
                    let fmRate = 1.0; if (isSampleKeyTrackingOn) { fmRate = TR2 ** (noteNumber - 12); }
                    fmModulatorSource.playbackRate.value = fmRate;
                    fmModulatorSource.detune.value = currentSampleDetune;
                    // Mirror Loop Settings
                    let loopStartTime = 0; let loopEndTime = sourceBuffer.duration;
                    if (useOriginalBuffer) {
                        if (isSampleLoopOn) {
                            fmModulatorSource.loop = true; loopStartTime = sampleStartPosition * audioBuffer.duration; loopEndTime = sampleEndPosition * audioBuffer.duration;
                            fmModulatorSource.loopStart = Math.max(0, loopStartTime); fmModulatorSource.loopEnd = Math.min(audioBuffer.duration, loopEndTime);
                            if (fmModulatorSource.loopEnd <= fmModulatorSource.loopStart) { fmModulatorSource.loopEnd = audioBuffer.duration; fmModulatorSource.loopStart = 0; }
                        } else { fmModulatorSource.loop = false; }
                    } else { fmModulatorSource.loop = isSampleLoopOn; }
                    console.log(`startOsc2Note FM [${noteId}]: Loop=${fmModulatorSource.loop}, Start=${fmModulatorSource.loopStart.toFixed(3)}, End=${fmModulatorSource.loopEnd.toFixed(3)}`);
                    // Connect FM Chain
                    fmModulatorSource.connect(fmDepthGain);
                    fmDepthGain.connect(freqParam);
                    fmModulatorSource.start(now);
                }
            } else if (osc2FMSource === 'osc1') {
                // --- Osc1 FM Source ---
                fmModulatorSource = audioCtx.createOscillator();
                fmModulatorSource.type = osc1Waveform === 'pulse' ? 'square' : osc1Waveform; // Map pulse to square
                const osc1Freq = noteToFrequency(noteNumber, osc1OctaveOffset); // Use Osc1 settings
                fmModulatorSource.frequency.value = osc1Freq;
                fmModulatorSource.detune.value = osc1Detune; // Use Osc1 detune
                console.log(`startOsc2Note FM [${noteId}]: Using basic OscillatorNode (${fmModulatorSource.type}) mirroring Osc1 settings.`);
                // Connect FM Chain
                fmModulatorSource.connect(fmDepthGain);
                fmDepthGain.connect(freqParam);
                fmModulatorSource.start(now);
            } else {
                // Unknown source or prerequisites not met
                console.warn(`startOsc2Note FM [${noteId}]: FM source '${osc2FMSource}' not handled or buffer missing. FM disconnected.`);
                fmModulatorSource = null; fmDepthGain = null;
            }
        } else {
             console.log(`startOsc2Note [${noteId}]: FM is off or frequency parameter missing. Skipping FM setup.`);
             fmModulatorSource = null; fmDepthGain = null;
        }
        // --- END Per-Voice FM Setup ---

        // Connect main audio path
        workletNode.connect(osc2LevelNode);
        osc2LevelNode.connect(oscGainNode);
        oscGainNode.connect(destination); // Connect to master gain
        console.log(`startOsc2Note [${noteId}]: Using AudioWorklet ${osc2Waveform}.`);

    } catch (e) {
        console.error(`Error creating Osc2 worklet node ${noteId}:`, e);
        try { osc2LevelNode.disconnect(); } catch(err){}
        try { oscGainNode.disconnect(); } catch(err){}
        return null;
    }

    // Apply ADSR envelope
    const attack = parseFloat(D('attack').value);
    const decay = parseFloat(D('decay').value);
    const sustainLevel = parseFloat(D('sustain').value);
    oscGainNode.gain.setValueAtTime(0, now);
    oscGainNode.gain.linearRampToValueAtTime(1.0, now + attack);
    oscGainNode.gain.linearRampToValueAtTime(sustainLevel, now + attack + decay);

    const note = {
        id: noteId,
        type: 'osc2',
        noteNumber,
        workletNode: workletNode,
        levelNode: osc2LevelNode, // Osc2 gain
        gainNode: oscGainNode,    // ADSR gain
        fmModulatorSource: fmModulatorSource, // Modulator *for* Osc2
        fmDepthGain: fmDepthGain,         // Depth *for* Osc2
        startTime: now,
        state: "playing",
        scheduledEvents: []
    };

    return note; // Return the created note object
}

/**
 * Initiates the release phase for an Oscillator 2 note.
 * @param {object} note - The Osc2 note object.
 */
function releaseOsc2Note(note) {
    if (!note || note.state !== "playing") return;
    note.state = "releasing";
    if (note.killTimerId) { clearTimeout(note.killTimerId); note.killTimerId = null; }
    clearScheduledEventsForNote(note);

    const release = parseFloat(D('release').value);
    const now = audioCtx.currentTime;

    // Apply release ramp to the ADSR gain node
    note.gainNode.gain.cancelScheduledValues(now);
    const currentGain = note.gainNode.gain.value;
    note.gainNode.gain.setValueAtTime(currentGain, now);
    note.gainNode.gain.linearRampToValueAtTime(0, now + release);

    // Schedule final cleanup (killOsc2Note)
    const killDelay = Math.max(100, (release * 1000) + 100);
    const releaseTimer = setTimeout(() => {
        note.killTimerId = null;
        killOsc2Note(note);
    }, killDelay);

    note.killTimerId = releaseTimer;
    note.scheduledEvents.push({ type: "timeout", id: releaseTimer });
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
    note.state = "killed";

    clearScheduledEventsForNote(note);

    try {
        // Cleanup FM Nodes (modulating Osc2)
        if (note.fmModulatorSource) {
            try { note.fmModulatorSource.stop(0); } catch(e) {}
            setTimeout(() => { try { note.fmModulatorSource.disconnect(); } catch(e){} }, 20);
        }
        if (note.fmDepthGain) {
            if (note.workletNode) { try { note.fmDepthGain.disconnect(note.workletNode.parameters.get('frequency')); } catch(e){} }
            setTimeout(() => { try { note.fmDepthGain.disconnect(); } catch(e){} }, 20);
        }

        // Existing Node Cleanup (gainNode, levelNode, workletNode)
        const now = audioCtx.currentTime;
        if (note.gainNode) { // ADSR gain
            note.gainNode.gain.cancelScheduledValues(now);
            note.gainNode.gain.setValueAtTime(0, now); // Ensure it's silent
            setTimeout(() => { try { note.gainNode.disconnect(); } catch(e){} }, 20);
        }
        if (note.levelNode) { // Osc2 gain
            setTimeout(() => { try { note.levelNode.disconnect(); } catch(e){} }, 20);
        }
        if (note.workletNode) {
            // Disconnect from levelNode
            setTimeout(() => { try { note.workletNode.disconnect(); } catch(e){} }, 20);
        }
    } catch (e) {
        console.error(`Error during killOsc2Note cleanup for ${noteId}:`, e);
    }

    // Robust activeVoices update
    let voiceEntryKey = null;
    let voiceEntry = null;
    for (const key in activeVoices) {
        if (activeVoices[key].osc2Note === note) { // <<< Check osc2Note
            voiceEntryKey = key;
            voiceEntry = activeVoices[key];
            break;
        }
    }

    if (voiceEntry) {
        console.log(`killOsc2Note [${noteId}]: Found matching osc2Note in activeVoices[${voiceEntryKey}]. Nullifying.`);
        voiceEntry.osc2Note = null; // <<< Nullify osc2Note

        if (!voiceEntry.samplerNote && !voiceEntry.osc1Note && !voiceEntry.osc2Note) { // <<< Check all three
            console.log(`killOsc2Note [${noteId}]: All components for note ${voiceEntryKey} are now null. Deleting voice entry.`);
            delete activeVoices[voiceEntryKey];
        }
    } else {
        console.log(`killOsc2Note [${noteId}]: Note object not found in any activeVoices entry during cleanup.`);
    }

    updateVoiceDisplay();
    updateKeyboardDisplay();

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
    note.state = "fadingOut";
    try {
        const now = audioCtx.currentTime;
        const currentGain = note.gainNode.gain.value;
        note.gainNode.gain.cancelScheduledValues(now);
        note.gainNode.gain.setValueAtTime(currentGain, now);
        note.gainNode.gain.linearRampToValueAtTime(0, now + fadeTime);
        const killTimer = setTimeout(() => killOsc2Note(note), fadeTime * 1000 + 10);
        note.scheduledEvents.push({ type: 'timeout', id: killTimer });
    } catch (e) {
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
    if (!osc2Note || !osc2Note.workletNode) {
        console.warn(`updateOsc2FmModulatorParameters: Invalid osc2Note or workletNode for ID ${osc2Note?.id}.`);
        return;
    }
    const noteId = osc2Note.id;

    // --- Disconnect and Stop Existing FM (if any) ---
    if (osc2Note.fmModulatorSource) {
        try { osc2Note.fmModulatorSource.stop(0); } catch (e) {}
        try { osc2Note.fmModulatorSource.disconnect(); } catch (e) {}
        osc2Note.fmModulatorSource = null;
    }
    if (osc2Note.fmDepthGain) {
        try { osc2Note.fmDepthGain.disconnect(); } catch (e) {}
        // Don't nullify fmDepthGain yet, reuse if possible
    }

    // --- Check if FM should be active ---
    if (osc2FMAmount <= 0.001) {
        console.log(`updateOsc2FmModulatorParameters [${noteId}]: FM amount is zero, ensuring FM is off.`);
        if (osc2Note.fmDepthGain) { // Ensure gain is zero if node exists
            osc2Note.fmDepthGain.gain.cancelScheduledValues(now);
            osc2Note.fmDepthGain.gain.setTargetAtTime(0, now, 0.01); // Ramp down quickly
        }
        // No need to create new nodes if FM is off
        return;
    }

    // --- Create/Configure Nodes ---
    try {
        // Reuse or create fmDepthGain
        if (!osc2Note.fmDepthGain) {
            osc2Note.fmDepthGain = audioCtx.createGain();
            console.log(`updateOsc2FmModulatorParameters [${noteId}]: Created fmDepthGain node.`);
        } else {
            console.log(`updateOsc2FmModulatorParameters [${noteId}]: Reusing existing fmDepthGain node.`);
        }
        // Set gain value based on current knob state
        const scaledDepth = osc2FMAmount * osc2FMDepthScale;
        osc2Note.fmDepthGain.gain.cancelScheduledValues(now);
        osc2Note.fmDepthGain.gain.setValueAtTime(scaledDepth, now); // Set initial value directly

        let newFmSource = null;
        const freqParam = osc2Note.workletNode.parameters.get('frequency'); // <<< Get frequency param early

        // <<< Check if frequency parameter exists BEFORE creating source >>>
        if (!freqParam) {
             console.error(`updateOsc2FmModulatorParameters [${noteId}]: Frequency parameter missing on workletNode. Cannot setup FM.`);
             if (osc2Note.fmDepthGain) { try { osc2Note.fmDepthGain.disconnect(); } catch(e) {} osc2Note.fmDepthGain = null; }
             return; // Exit early
        }

        // Create new modulator source based on osc2FMSource
        if (osc2FMSource === 'sampler') { // <<< Check source type >>>
            // <<< Check sampler-specific prerequisites >>>
            if (!audioBuffer) {
                 console.error(`updateOsc2FmModulatorParameters [${noteId}]: Sampler FM selected, but no audioBuffer loaded. Skipping FM connection.`);
                 if (osc2Note.fmDepthGain) { try { osc2Note.fmDepthGain.disconnect(); } catch(e) {} osc2Note.fmDepthGain = null; } // Clean up gain node
                 return; // Don't proceed
            }

            // --- Sampler FM Source ---
            newFmSource = audioCtx.createBufferSource();

            // --- Mirror Buffer Selection ---
            let useOriginalBuffer = true;
            let sourceBuffer = audioBuffer;
            let bufferType = "original_fm_osc2";
            if (isSampleLoopOn && sampleCrossfadeAmount > 0.01 && cachedCrossfadedBuffer) {
                sourceBuffer = cachedCrossfadedBuffer; useOriginalBuffer = false; bufferType = "crossfaded_fm_osc2";
            } else if (fadedBuffer && (!isSampleLoopOn || sampleCrossfadeAmount <= 0.01)) {
                sourceBuffer = fadedBuffer; useOriginalBuffer = false; bufferType = "faded_fm_osc2";
            }
            // <<< Validate selected buffer >>>
            if (!sourceBuffer || !(sourceBuffer instanceof AudioBuffer)) {
                 console.error(`updateOsc2FmModulatorParameters [${noteId}]: Invalid sourceBuffer selected for FM (type: ${bufferType}). Skipping FM connection.`);
                 newFmSource = null; // Nullify the source
                 if (osc2Note.fmDepthGain) { try { osc2Note.fmDepthGain.disconnect(); } catch(e) {} osc2Note.fmDepthGain = null; }
                 return; // <<< ADD RETURN HERE >>>
            }
            // --- Assign buffer and log ---
            newFmSource.buffer = sourceBuffer;
            console.log(`updateOsc2FmModulatorParameters [${noteId}]: Using ${bufferType} buffer for FM.`);

            // --- Mirror Pitch/Rate ---
            let fmRate = 1.0;
            if (isSampleKeyTrackingOn) { fmRate = TR2 ** (osc2Note.noteNumber - 12); } // Use the note's number
            newFmSource.playbackRate.value = fmRate;
            newFmSource.detune.value = currentSampleDetune; // Use global sample detune

            // --- Mirror Loop Settings ---
            let loopStartTime = 0; let loopEndTime = sourceBuffer.duration;
            if (useOriginalBuffer) {
                if (isSampleLoopOn) {
                    newFmSource.loop = true; loopStartTime = sampleStartPosition * audioBuffer.duration; loopEndTime = sampleEndPosition * audioBuffer.duration;
                    newFmSource.loopStart = Math.max(0, loopStartTime); newFmSource.loopEnd = Math.min(audioBuffer.duration, loopEndTime);
                    if (newFmSource.loopEnd <= newFmSource.loopStart) { newFmSource.loopEnd = audioBuffer.duration; newFmSource.loopStart = 0; }
                } else { newFmSource.loop = false; }
            } else { newFmSource.loop = isSampleLoopOn; }
            console.log(`updateOsc2FmModulatorParameters [${noteId}]: Loop=${newFmSource.loop}, Start=${newFmSource.loopStart.toFixed(3)}, End=${newFmSource.loopEnd.toFixed(3)}`);
            // --- End Sampler Specific Logic ---

        } else if (osc2FMSource === 'osc1') {
            // --- Osc1 FM Source ---
            const osc1Note = voice?.osc1Note;
            newFmSource = audioCtx.createOscillator();
            newFmSource.type = osc1Waveform === 'pulse' ? 'square' : osc1Waveform;
            const osc1Freq = noteToFrequency(osc2Note.noteNumber, osc1OctaveOffset);
            newFmSource.frequency.value = osc1Freq;
            newFmSource.detune.value = osc1Detune;

            if (osc1Note && osc1Note.workletNode) {
                 try {
                     const currentFreqParam = osc1Note.workletNode.parameters.get('frequency');
                     const currentDetuneParam = osc1Note.workletNode.parameters.get('detune');
                     if (currentFreqParam) newFmSource.frequency.value = currentFreqParam.value;
                     if (currentDetuneParam) newFmSource.detune.value = currentDetuneParam.value;
                     console.log(`updateOsc2FmModulatorParameters [${noteId}]: Using basic OscillatorNode mirroring Osc1 (found active note).`);
                 } catch(e) { console.warn(`updateOsc2FmModulatorParameters [${noteId}]: Error getting current Osc1 params, using globals.`); }
            } else { console.log(`updateOsc2FmModulatorParameters [${noteId}]: Using basic OscillatorNode mirroring global Osc1 settings.`); }
            // --- End Osc1 Specific Logic ---
        }

        // --- Connect and Start ---
        // <<< Check newFmSource, fmDepthGain, and freqParam (already checked) >>>
        if (newFmSource && osc2Note.fmDepthGain) {
            osc2Note.fmModulatorSource = newFmSource; // Store reference
            newFmSource.connect(osc2Note.fmDepthGain);
            // <<< Connect gain node to the frequency parameter >>>
            osc2Note.fmDepthGain.connect(freqParam);
            newFmSource.start(now); // <<< Start AFTER connecting >>>
            console.log(`updateOsc2FmModulatorParameters [${noteId}]: Started and connected new FM source (${osc2FMSource}) to frequency.`);
        } else {
            // This block will now only be reached if source creation failed for 'osc1' or if prerequisites failed earlier
            console.warn(`updateOsc2FmModulatorParameters [${noteId}]: Failed to create or connect new FM source (${osc2FMSource}). FM will be inactive.`);
            // Ensure gain node is cleaned up if source creation/connection failed
            if (osc2Note.fmDepthGain) { try { osc2Note.fmDepthGain.disconnect(); } catch(e) {} osc2Note.fmDepthGain = null; }
        }

    } catch (error) {
        console.error(`Error in updateOsc2FmModulatorParameters for ${noteId}:`, error);
        // Attempt cleanup on error
        if (osc2Note.fmModulatorSource) { try { osc2Note.fmModulatorSource.disconnect(); } catch(e){} osc2Note.fmModulatorSource = null; }
        if (osc2Note.fmDepthGain) { try { osc2Note.fmDepthGain.disconnect(); } catch(e){} osc2Note.fmDepthGain = null; }
    }
}

// --- End Oscillator 2 Note Functions ---
// --- Unified Note On/Off Handlers ---

function noteOn(noteNumber) {
    console.log(`noteOn: ${noteNumber}, Mono: ${isMonoMode}, Legato: ${isLegatoMode}, Porta: ${isPortamentoOn}`);
    const now = audioCtx.currentTime;

    if (!heldNotes.includes(noteNumber)) { heldNotes.push(noteNumber); }

    if (isMonoMode) {
        if (currentMonoVoice) {
            // --- Mono Update (Existing Voice) ---
            const oldNoteNumber = currentMonoVoice.noteNumber;
            console.log(`Mono NoteOn: Updating existing voice from ${oldNoteNumber} to ${noteNumber}. Legato: ${isLegatoMode}`);

            if (isLegatoMode) {
                // --- Mono Legato Update ---
                const voiceToUpdate = currentMonoVoice;
                const oldNoteNumberForLog = voiceToUpdate.noteNumber; // Log before changing

                // Update voice state FIRST
                voiceToUpdate.noteNumber = noteNumber;
                // Update activeVoices mapping
                if (oldNoteNumberForLog !== noteNumber) {
                    activeVoices[noteNumber] = voiceToUpdate; // Point new key to existing voice
                    delete activeVoices[oldNoteNumberForLog]; // Remove old key mapping
                    console.log(`Mono Legato: Updated activeVoices map. Key ${oldNoteNumberForLog} deleted, Key ${noteNumber} points to voice.`);
                } else {
                    console.log(`Mono Legato: Note number ${noteNumber} retriggered, activeVoices map unchanged.`);
                }

                // Glide or Jump existing components
                const targetFreqOsc1 = noteToFrequency(noteNumber, osc1OctaveOffset);
                const targetFreqOsc2 = noteToFrequency(noteNumber, osc2OctaveOffset); // <<< Get Osc2 target
                const targetRate = isSampleKeyTrackingOn ? TR2 ** (noteNumber - 12) : 1.0;

                // Get current parameters (check existence)
                let osc1FreqParam = voiceToUpdate.osc1Note?.workletNode?.parameters.get('frequency');
                let osc1DetuneParam = voiceToUpdate.osc1Note?.workletNode?.parameters.get('detune');
                let osc2FreqParam = voiceToUpdate.osc2Note?.workletNode?.parameters.get('frequency'); // <<< Get Osc2 param
                let osc2DetuneParam = voiceToUpdate.osc2Note?.workletNode?.parameters.get('detune'); // <<< Get Osc2 param
                let samplerRateParam = voiceToUpdate.samplerNote?.source?.playbackRate;
                let samplerDetuneParam = voiceToUpdate.samplerNote?.source?.detune;
                let fm1ModRateParam = voiceToUpdate.osc1Note?.fmModulatorSource?.playbackRate; // FM for Osc1
                let fm2ModRateParam = voiceToUpdate.osc2Note?.fmModulatorSource?.playbackRate; // FM for Osc2

                // <<< CHANGE: Glide if Legato is ON and glideTime > 0 >>>
                if (glideTime > 0.001) {
                    // --- Legato Glide ---
                    console.log(`Applying MONO Legato glide (noteOn): ${glideTime.toFixed(3)}s`);

                    // <<< Ensure ramps start from CURRENT value >>>
                    if (samplerRateParam) {
                        samplerRateParam.cancelScheduledValues(now); // Cancel previous ramps
                        samplerRateParam.setValueAtTime(samplerRateParam.value, now); // Set current value
                        samplerRateParam.linearRampToValueAtTime(targetRate, now + glideTime); // Ramp to target
                    }
                    if (samplerDetuneParam) {
                        samplerDetuneParam.cancelScheduledValues(now);
                        samplerDetuneParam.setValueAtTime(samplerDetuneParam.value, now);
                        samplerDetuneParam.linearRampToValueAtTime(currentSampleDetune, now + glideTime); // Ramp to target detune
                    }

                    if (osc1FreqParam) {
                        osc1FreqParam.cancelScheduledValues(now);
                        osc1FreqParam.setValueAtTime(osc1FreqParam.value, now);
                        osc1FreqParam.linearRampToValueAtTime(targetFreqOsc1, now + glideTime);
                    }
                    if (osc1DetuneParam) {
                        osc1DetuneParam.cancelScheduledValues(now);
                        osc1DetuneParam.setValueAtTime(osc1DetuneParam.value, now);
                        osc1DetuneParam.linearRampToValueAtTime(osc1Detune, now + glideTime); // Ramp to target detune
                    }

                    if (osc2FreqParam) { // <<< Apply to Osc2 >>>
                        osc2FreqParam.cancelScheduledValues(now);
                        osc2FreqParam.setValueAtTime(osc2FreqParam.value, now);
                        osc2FreqParam.linearRampToValueAtTime(targetFreqOsc2, now + glideTime);
                    }
                    if (osc2DetuneParam) { // <<< Apply to Osc2 Detune >>>
                        osc2DetuneParam.cancelScheduledValues(now);
                        osc2DetuneParam.setValueAtTime(osc2DetuneParam.value, now);
                        osc2DetuneParam.linearRampToValueAtTime(osc2Detune, now + glideTime); // Ramp to target detune
                    }

                    // <<< Apply to FM sources (Rate and Detune if sampler-based) >>>
                    if (fm1ModRateParam && osc1FMSource === 'sampler') { // Check source type
                        fm1ModRateParam.cancelScheduledValues(now);
                        fm1ModRateParam.setValueAtTime(fm1ModRateParam.value, now);
                        fm1ModRateParam.linearRampToValueAtTime(targetRate, now + glideTime); // Glide rate
                        // Glide detune for FM source if it exists
                        const fm1ModDetuneParam = voiceToUpdate.osc1Note?.fmModulatorSource?.detune;
                        if (fm1ModDetuneParam) {
                            fm1ModDetuneParam.cancelScheduledValues(now);
                            fm1ModDetuneParam.setValueAtTime(fm1ModDetuneParam.value, now);
                            fm1ModDetuneParam.linearRampToValueAtTime(currentSampleDetune, now + glideTime);
                        }
                    }
                    if (fm2ModRateParam && osc2FMSource === 'sampler') { // Check source type
                        fm2ModRateParam.cancelScheduledValues(now);
                        fm2ModRateParam.setValueAtTime(fm2ModRateParam.value, now);
                        fm2ModRateParam.linearRampToValueAtTime(targetRate, now + glideTime); // Glide rate
                        // Glide detune for FM source if it exists
                        const fm2ModDetuneParam = voiceToUpdate.osc2Note?.fmModulatorSource?.detune;
                        if (fm2ModDetuneParam) {
                            fm2ModDetuneParam.cancelScheduledValues(now);
                            fm2ModDetuneParam.setValueAtTime(fm2ModDetuneParam.value, now);
                            fm2ModDetuneParam.linearRampToValueAtTime(currentSampleDetune, now + glideTime);
                        }
                    }
                    // Note: If FM source is Osc1/Osc2, their frequency/detune glide is handled above.

                } else {
                    // --- Legato Jump (Only if glideTime is 0) ---
                    console.log(`Applying MONO Legato jump (glideTime is zero)`);
                    if (samplerRateParam) { samplerRateParam.setValueAtTime(targetRate, now); }
                    if (samplerDetuneParam) { samplerDetuneParam.setValueAtTime(currentSampleDetune, now); }
                    if (osc1FreqParam) { osc1FreqParam.setValueAtTime(targetFreqOsc1, now); }
                    if (osc1DetuneParam) { osc1DetuneParam.setValueAtTime(osc1Detune, now); }
                    if (osc2FreqParam) { osc2FreqParam.setValueAtTime(targetFreqOsc2, now); }
                    if (osc2DetuneParam) { osc2DetuneParam.setValueAtTime(osc2Detune, now); }
                    // Jump FM sources if sampler-based
                    if (fm1ModRateParam && osc1FMSource === 'sampler') { fm1ModRateParam.setValueAtTime(targetRate, now); }
                    const fm1ModDetuneParam = voiceToUpdate.osc1Note?.fmModulatorSource?.detune;
                    if (fm1ModDetuneParam && osc1FMSource === 'sampler') { fm1ModDetuneParam.setValueAtTime(currentSampleDetune, now); }
                    if (fm2ModRateParam && osc2FMSource === 'sampler') { fm2ModRateParam.setValueAtTime(targetRate, now); }
                    const fm2ModDetuneParam = voiceToUpdate.osc2Note?.fmModulatorSource?.detune;
                    if (fm2ModDetuneParam && osc2FMSource === 'sampler') { fm2ModDetuneParam.setValueAtTime(currentSampleDetune, now); }
                }
                // Update component note numbers (check existence first)
                if (voiceToUpdate.samplerNote) { voiceToUpdate.samplerNote.noteNumber = noteNumber; }
                if (voiceToUpdate.osc1Note) { voiceToUpdate.osc1Note.noteNumber = noteNumber; }
                if (voiceToUpdate.osc2Note) { voiceToUpdate.osc2Note.noteNumber = noteNumber; } // <<< Update Osc2 noteNumber

            } else {
                // --- Multi-Trigger Retrigger ---
                console.log("Mono NoteOn: Applying Multi-Trigger Retrigger.");
                const prevVoice = currentMonoVoice;
                const prevSamplerNote = prevVoice?.samplerNote;
                const prevOsc1Note = prevVoice?.osc1Note;
                const prevOsc2Note = prevVoice?.osc2Note; // <<< Get prev Osc2
                const prevNoteNumber = prevVoice?.noteNumber;

                let startRate = null; let startFreqOsc1 = null; let startFreqOsc2 = null; // <<< Add Osc2 start freq
                if (isPortamentoOn && glideTime > 0.001) {
                    // Get current pitch BEFORE starting new notes/fading old
                    if (prevSamplerNote?.source?.playbackRate) { try { startRate = prevSamplerNote.source.playbackRate.value; } catch(e){} }
                    if (prevOsc1Note?.workletNode) { try { const p = prevOsc1Note.workletNode.parameters.get('frequency'); if(p) startFreqOsc1 = p.value; } catch(e){} }
                    if (prevOsc2Note?.workletNode) { try { const p = prevOsc2Note.workletNode.parameters.get('frequency'); if(p) startFreqOsc2 = p.value; } catch(e){} } // <<< Get Osc2 start freq
                    // Fallback to target pitch if actual value couldn't be read
                    if (startRate === null && prevNoteNumber !== null) startRate = isSampleKeyTrackingOn ? TR2 ** (prevNoteNumber - 12) : 1.0;
                    if (startFreqOsc1 === null && prevNoteNumber !== null) startFreqOsc1 = noteToFrequency(prevNoteNumber, osc1OctaveOffset);
                    if (startFreqOsc2 === null && prevNoteNumber !== null) startFreqOsc2 = noteToFrequency(prevNoteNumber, osc2OctaveOffset); // <<< Fallback Osc2
                }

                // Update voice state for the NEW note
                currentMonoVoice.noteNumber = noteNumber;
                currentMonoVoice.startTime = now;
                if (prevNoteNumber !== noteNumber && prevNoteNumber !== undefined) {
                    activeVoices[noteNumber] = currentMonoVoice; delete activeVoices[prevNoteNumber];
                }

                // Start NEW components and assign them
                console.log("Mono Multi-Trigger: Starting new components.");
                currentMonoVoice.samplerNote = startSamplerNote(noteNumber, audioCtx, masterGain, audioBuffer);
                currentMonoVoice.osc1Note = startOsc1Note(noteNumber, audioCtx, masterGain);
                currentMonoVoice.osc2Note = startOsc2Note(noteNumber, audioCtx, masterGain); // <<< Start Osc2
                console.log(`Mono Multi-Trigger: New samplerNote: ${currentMonoVoice.samplerNote?.id}, New osc1Note: ${currentMonoVoice.osc1Note?.id}, New osc2Note: ${currentMonoVoice.osc2Note?.id}`); // <<< Log Osc2

                // Apply portamento glide to NEW components if applicable
                if (isPortamentoOn && glideTime > 0.001 && (startRate !== null || startFreqOsc1 !== null || startFreqOsc2 !== null)) {
                    const targetRate = isSampleKeyTrackingOn ? TR2 ** (noteNumber - 12) : 1.0;
                    const targetFreqOsc1 = noteToFrequency(noteNumber, osc1OctaveOffset);
                    const targetFreqOsc2 = noteToFrequency(noteNumber, osc2OctaveOffset); // <<< Target Osc2

                    if (currentMonoVoice.samplerNote?.source?.playbackRate && startRate !== null) {
                        currentMonoVoice.samplerNote.source.playbackRate.setValueAtTime(startRate, now);
                        currentMonoVoice.samplerNote.source.playbackRate.linearRampToValueAtTime(targetRate, now + glideTime);
                    }
                    // FM Glides (similar logic as noteOn) ...
                    if (currentMonoVoice.osc1Note?.fmModulatorSource?.playbackRate && startRate !== null) {
                        const fmSource = currentMonoVoice.osc1Note.fmModulatorSource;
                        fmSource.playbackRate.setValueAtTime(startRate, now);
                        fmSource.playbackRate.linearRampToValueAtTime(targetRate, now + glideTime);
                    }
                    if (currentMonoVoice.osc2Note?.fmModulatorSource?.playbackRate && startRate !== null) { // <<< Glide FM for Osc2
                        const fmSource = currentMonoVoice.osc2Note.fmModulatorSource;
                        fmSource.playbackRate.setValueAtTime(startRate, now);
                        fmSource.playbackRate.linearRampToValueAtTime(targetRate, now + glideTime);
                    }


                    if (currentMonoVoice.osc1Note?.workletNode && startFreqOsc1 !== null) {
                        const p = currentMonoVoice.osc1Note.workletNode.parameters.get('frequency');
                        if(p) { p.setValueAtTime(startFreqOsc1, now); p.linearRampToValueAtTime(targetFreqOsc1, now + glideTime); }
                    }
                    if (currentMonoVoice.osc2Note?.workletNode && startFreqOsc2 !== null) { // <<< Glide Osc2
                        const p = currentMonoVoice.osc2Note.workletNode.parameters.get('frequency');
                        if(p) { p.setValueAtTime(startFreqOsc2, now); p.linearRampToValueAtTime(targetFreqOsc2, now + glideTime); }
                    }
                }

                // Fade out the PREVIOUS voice components
                console.log("Mono Multi-Trigger: Fading out previous components.");
                setTimeout(() => {
                    if (prevSamplerNote) quickFadeOutSampler(prevSamplerNote, 0.015);
                    if (prevOsc1Note) quickFadeOutOsc1(prevOsc1Note, 0.015);
                    if (prevOsc2Note) quickFadeOutOsc2(prevOsc2Note, 0.015); // <<< Fade out Osc2
                }, 5);
            }
        } else {
            // --- Mono First Note ---
            console.log(`Mono NoteOn: Starting new voice for Note ${noteNumber}.`);
            currentMonoVoice = { samplerNote: null, osc1Note: null, osc2Note: null, startTime: now, noteNumber: noteNumber }; // <<< Add osc2Note
            activeVoices[noteNumber] = currentMonoVoice;

            // Start new components
            currentMonoVoice.samplerNote = startSamplerNote(noteNumber, audioCtx, masterGain, audioBuffer);
            currentMonoVoice.osc1Note = startOsc1Note(noteNumber, audioCtx, masterGain);
            currentMonoVoice.osc2Note = startOsc2Note(noteNumber, audioCtx, masterGain); // <<< Start Osc2

            // Apply initial portamento glide if needed
            if (isPortamentoOn && glideTime > 0.001) {
                let glideStartRate = lastActualSamplerRate;
                let glideStartFreqOsc1 = lastActualOsc1Freq;
                let glideStartFreqOsc2 = lastActualOsc2Freq; // <<< Get Osc2 start

                if (glideStartRate === null && lastPlayedNoteNumber !== null) glideStartRate = isSampleKeyTrackingOn ? TR2 ** (lastPlayedNoteNumber - 12) : 1.0;
                if (glideStartFreqOsc1 === null && lastPlayedNoteNumber !== null) glideStartFreqOsc1 = noteToFrequency(lastPlayedNoteNumber, osc1OctaveOffset);
                if (glideStartFreqOsc2 === null && lastPlayedNoteNumber !== null) glideStartFreqOsc2 = noteToFrequency(lastPlayedNoteNumber, osc2OctaveOffset); // <<< Fallback Osc2

                if (glideStartRate !== null || glideStartFreqOsc1 !== null || glideStartFreqOsc2 !== null) {
                    const targetRate = isSampleKeyTrackingOn ? TR2 ** (noteNumber - 12) : 1.0;
                    const targetFreqOsc1 = noteToFrequency(noteNumber, osc1OctaveOffset);
                    const targetFreqOsc2 = noteToFrequency(noteNumber, osc2OctaveOffset); // <<< Target Osc2

                    if (currentMonoVoice.samplerNote?.source?.playbackRate && glideStartRate !== null) {
                        currentMonoVoice.samplerNote.source.playbackRate.setValueAtTime(glideStartRate, now);
                        currentMonoVoice.samplerNote.source.playbackRate.linearRampToValueAtTime(targetRate, now + glideTime);
                    }
                    if (currentMonoVoice.osc1Note?.workletNode && glideStartFreqOsc1 !== null) {
                        const p = currentMonoVoice.osc1Note.workletNode.parameters.get('frequency');
                        if(p) { p.setValueAtTime(glideStartFreqOsc1, now); p.linearRampToValueAtTime(targetFreqOsc1, now + glideTime); }
                    }
                    if (currentMonoVoice.osc2Note?.workletNode && glideStartFreqOsc2 !== null) { // <<< Glide Osc2
                        const p = currentMonoVoice.osc2Note.workletNode.parameters.get('frequency');
                        if(p) { p.setValueAtTime(glideStartFreqOsc2, now); p.linearRampToValueAtTime(targetFreqOsc2, now + glideTime); }
                    }
                }
           }
           // Reset last actual pitch
           lastActualSamplerRate = null; lastActualOsc1Freq = null; lastActualOsc2Freq = null; // <<< Reset Osc2
       }
    } else {
        // --- POLY ---
        // Voice Stealing (check all components)
        const playingVoiceNumbers = Object.keys(activeVoices).filter(num =>
            activeVoices[num] && (
                (activeVoices[num].samplerNote && activeVoices[num].samplerNote.state === 'playing') ||
                (activeVoices[num].osc1Note && activeVoices[num].osc1Note.state === 'playing') ||
                (activeVoices[num].osc2Note && activeVoices[num].osc2Note.state === 'playing') // <<< Check Osc2
            )
        );
        while (playingVoiceNumbers.length >= MAX_POLYPHONY) {
             let oldestNoteNumber = -1; let oldestStartTime = Infinity;
             playingVoiceNumbers.forEach(num => {
                 if (activeVoices[num] && activeVoices[num].startTime < oldestStartTime) {
                     oldestStartTime = activeVoices[num].startTime; oldestNoteNumber = num;
                 }
             });
             if (oldestNoteNumber !== -1) {
                 console.log(`Voice stealing: Removing oldest voice (Note ${oldestNoteNumber})`);
                 const voiceToSteal = activeVoices[oldestNoteNumber];
                 if (voiceToSteal.samplerNote) quickFadeOutSampler(voiceToSteal.samplerNote, 0.015);
                 if (voiceToSteal.osc1Note) quickFadeOutOsc1(voiceToSteal.osc1Note, 0.015);
                 if (voiceToSteal.osc2Note) quickFadeOutOsc2(voiceToSteal.osc2Note, 0.015); // <<< Fade out Osc2
                 playingVoiceNumbers.splice(playingVoiceNumbers.indexOf(oldestNoteNumber.toString()), 1);
             } else { break; }
        }

        let targetVoice = activeVoices[noteNumber];
        let isNewVoice = !targetVoice;

        if (isNewVoice) {
            // --- Poly New Note ---
            console.log(`Poly NoteOn: Creating new voice for Note ${noteNumber}.`);
            targetVoice = { samplerNote: null, osc1Note: null, osc2Note: null, startTime: now, noteNumber: noteNumber }; // <<< Add osc2Note
            activeVoices[noteNumber] = targetVoice;
            // Start Components
            targetVoice.samplerNote = startSamplerNote(noteNumber, audioCtx, masterGain, audioBuffer);
            targetVoice.osc1Note = startOsc1Note(noteNumber, audioCtx, masterGain);
            targetVoice.osc2Note = startOsc2Note(noteNumber, audioCtx, masterGain); // <<< Start Osc2
        } else {
            // --- Poly Retrigger ---
            console.log(`Poly NoteOn: Retriggering voice for Note ${noteNumber}.`);
            const oldSamplerNote = targetVoice.samplerNote;
            const oldOsc1Note = targetVoice.osc1Note;
            const oldOsc2Note = targetVoice.osc2Note; // <<< Get old Osc2

            // Start NEW components immediately
            targetVoice.samplerNote = startSamplerNote(noteNumber, audioCtx, masterGain, audioBuffer);
            targetVoice.osc1Note = startOsc1Note(noteNumber, audioCtx, masterGain);
            targetVoice.osc2Note = startOsc2Note(noteNumber, audioCtx, masterGain); // <<< Start Osc2
            targetVoice.startTime = now; // Update start time

            // Delayed Fade Out of OLD components
            setTimeout(() => {
                if (oldSamplerNote) quickFadeOutSampler(oldSamplerNote, 0.015);
                if (oldOsc1Note) quickFadeOutOsc1(oldOsc1Note, 0.015);
                if (oldOsc2Note) quickFadeOutOsc2(oldOsc2Note, 0.015); // <<< Fade out Osc2
            }, 0);
        }

        // Apply Poly Portamento Glide
        if (isPortamentoOn && lastPlayedNoteNumber !== null && glideTime > 0.001) {
            console.log(`Applying POLY portamento glide: ${glideTime.toFixed(3)}s from ${lastPlayedNoteNumber} to ${noteNumber}`);
            const startFreqOsc1 = noteToFrequency(lastPlayedNoteNumber, osc1OctaveOffset);
            const startFreqOsc2 = noteToFrequency(lastPlayedNoteNumber, osc2OctaveOffset); // <<< Start Osc2
            const startRate = isSampleKeyTrackingOn ? TR2 ** (lastPlayedNoteNumber - 12) : 1.0; // Always use last note for start rate if keytracking

            const targetRate = isSampleKeyTrackingOn ? TR2 ** (noteNumber - 12) : 1.0;
            const targetFreqOsc1 = noteToFrequency(noteNumber, osc1OctaveOffset);
            const targetFreqOsc2 = noteToFrequency(noteNumber, osc2OctaveOffset); // <<< Target Osc2

            // Sampler Glide
            if (targetVoice.samplerNote?.source?.playbackRate) {
                targetVoice.samplerNote.source.playbackRate.setValueAtTime(startRate, now);
                targetVoice.samplerNote.source.playbackRate.linearRampToValueAtTime(targetRate, now + glideTime);
            }
            // FM Modulator Glide (for Osc1)
            if (targetVoice.osc1Note?.fmModulatorSource?.playbackRate) {
                 const fmSource = targetVoice.osc1Note.fmModulatorSource;
                 // Determine FM start rate based on source type (sampler or osc2)
                 const fmStartRate = (osc1FMSource === 'sampler') ? startRate : 1.0; // Assume Osc2 FM source doesn't track pitch for now
                 const fmTargetRate = (osc1FMSource === 'sampler') ? targetRate : 1.0;
                 fmSource.playbackRate.setValueAtTime(fmStartRate, now);
                 fmSource.playbackRate.linearRampToValueAtTime(fmTargetRate, now + glideTime);
            }
             // FM Modulator Glide (for Osc2) // <<< ADD FM Glide for Osc2 >>>
            if (targetVoice.osc2Note?.fmModulatorSource?.playbackRate) {
                 const fmSource = targetVoice.osc2Note.fmModulatorSource;
                 // Determine FM start rate based on source type (sampler or osc1)
                 const fmStartRate = (osc2FMSource === 'sampler') ? startRate : 1.0; // Assume Osc1 FM source doesn't track pitch for now
                 const fmTargetRate = (osc2FMSource === 'sampler') ? targetRate : 1.0;
                 fmSource.playbackRate.setValueAtTime(fmStartRate, now);
                 fmSource.playbackRate.linearRampToValueAtTime(fmTargetRate, now + glideTime);
            }

           // Osc1 Glide
           if (targetVoice.osc1Note?.workletNode) {
                const p = targetVoice.osc1Note.workletNode.parameters.get('frequency');
                if(p) { p.setValueAtTime(startFreqOsc1, now); p.linearRampToValueAtTime(targetFreqOsc1, now + glideTime); }
           }
           // Osc2 Glide // <<< ADD Osc2 Glide >>>
           if (targetVoice.osc2Note?.workletNode) {
                const p = targetVoice.osc2Note.workletNode.parameters.get('frequency');
                if(p) { p.setValueAtTime(startFreqOsc2, now); p.linearRampToValueAtTime(targetFreqOsc2, now + glideTime); }
           }
       }
   }

   lastPlayedNoteNumber = noteNumber;
   updateVoiceDisplay();
   updateKeyboardDisplay();
}

function noteOff(noteNumber) {
    console.log(`noteOff: ${noteNumber}, Mono: ${isMonoMode}, Held: [${heldNotes.join(',')}]`);
    console.log(`noteOff DEBUG ENTRY: currentMonoVoice note = ${currentMonoVoice ? currentMonoVoice.noteNumber : 'null'}`); // <<< ADD THIS LOG
    const now = audioCtx.currentTime;

    // Remove from held notes list
    const initialLength = heldNotes.length;
    heldNotes = heldNotes.filter(n => n !== noteNumber);
    const noteWasHeld = heldNotes.length < initialLength;

    if (!noteWasHeld) {
        console.log(`noteOff: Note ${noteNumber} was not in heldNotes array (potentially stolen or already released).`);
    }

    if (isMonoMode) {
        // --- Mono Mode Logic ---
        // Only act if the released note *was* the currently sounding mono note
        if (!currentMonoVoice || currentMonoVoice.noteNumber !== noteNumber) {
            console.log(`Mono NoteOff: Skipping release for ${noteNumber}. Current mono voice is ${currentMonoVoice ? `Note ${currentMonoVoice.noteNumber}` : 'null'}.`);
            if (noteWasHeld) {
                 updateVoiceDisplay();
                 updateKeyboardDisplay();
            }
            return;
        }

        // The released note IS the current mono voice. Check if other keys are still held.
        if (heldNotes.length > 0) {
            // --- Other notes still held ---
            const lastHeldNoteNumber = heldNotes[heldNotes.length - 1];
            console.log(`Mono NoteOff: Other notes held. Returning to ${lastHeldNoteNumber}. Legato: ${isLegatoMode}`);

            if (!isLegatoMode) {
                // --- Multi-trigger: Retrigger last held note ---
                console.log("Mono NoteOff (Multi): Retriggering and gliding down.");
                const voiceBeingReleased = currentMonoVoice; // The voice playing the noteNumber being released
                const releasedNoteNumber = voiceBeingReleased?.noteNumber; // The note number being released

                // <<< Ensure voiceBeingReleased is valid before proceeding >>>
                if (!voiceBeingReleased || releasedNoteNumber === undefined || releasedNoteNumber === null) {
                    console.error(`Mono NoteOff (Multi): Error! voiceBeingReleased is invalid or has no noteNumber.`);
                    // Attempt cleanup if possible
                    if (voiceBeingReleased) {
                         if (voiceBeingReleased.samplerNote) quickFadeOutSampler(voiceBeingReleased.samplerNote, 0.015);
                         if (voiceBeingReleased.osc1Note) quickFadeOutOsc1(voiceBeingReleased.osc1Note, 0.015);
                         if (voiceBeingReleased.osc2Note) quickFadeOutOsc2(voiceBeingReleased.osc2Note, 0.015);
                    }
                    currentMonoVoice = null; // Reset mono voice state
                    delete activeVoices[noteNumber]; // Clean up active voices map for the released note
                    updateVoiceDisplay(); updateKeyboardDisplay();
                    return; // Exit early
                }

                let startRate = null; let startFreqOsc1 = null; let startFreqOsc2 = null;
                if (isPortamentoOn && glideTime > 0.001) {
                    // Get current pitch of the NOTE BEING RELEASED
                    console.log(`Mono NoteOff (Multi): Reading pitch from released note ${releasedNoteNumber}`);
                    if (voiceBeingReleased.samplerNote?.source?.playbackRate) { try { startRate = voiceBeingReleased.samplerNote.source.playbackRate.value; } catch(e){} }
                    if (voiceBeingReleased.osc1Note?.workletNode) { try { const p = voiceBeingReleased.osc1Note.workletNode.parameters.get('frequency'); if(p) startFreqOsc1 = p.value; } catch(e){} }
                    if (voiceBeingReleased.osc2Note?.workletNode) { try { const p = voiceBeingReleased.osc2Note.workletNode.parameters.get('frequency'); if(p) startFreqOsc2 = p.value; } catch(e){} }
                    // Fallback to target pitch if actual value couldn't be read
                    if (startRate === null) startRate = isSampleKeyTrackingOn ? TR2 ** (releasedNoteNumber - 12) : 1.0;
                    if (startFreqOsc1 === null) startFreqOsc1 = noteToFrequency(releasedNoteNumber, osc1OctaveOffset);
                    if (startFreqOsc2 === null) startFreqOsc2 = noteToFrequency(releasedNoteNumber, osc2OctaveOffset);
                    console.log(`Mono NoteOff (Multi): Start Glide - Rate: ${startRate?.toFixed(4)}, Freq1: ${startFreqOsc1?.toFixed(2)}, Freq2: ${startFreqOsc2?.toFixed(2)}`);
                }
                // --- End Get current pitch ---

                // Start NEW voice components for the note being returned to (lastHeldNoteNumber)
                console.log(`Mono NoteOff (Multi): Starting new components for Note ${lastHeldNoteNumber}.`);
                // <<< Create a NEW voice object for the held note >>>
                const newVoice = { samplerNote: null, osc1Note: null, osc2Note: null, startTime: now, noteNumber: lastHeldNoteNumber };
                activeVoices[lastHeldNoteNumber] = newVoice; // Assign to activeVoices
                currentMonoVoice = newVoice; // Update the current mono voice reference

                newVoice.samplerNote = startSamplerNote(lastHeldNoteNumber, audioCtx, masterGain, audioBuffer);
                newVoice.osc1Note = startOsc1Note(lastHeldNoteNumber, audioCtx, masterGain);
                newVoice.osc2Note = startOsc2Note(lastHeldNoteNumber, audioCtx, masterGain);

                // Apply glide FROM the released note's pitch TO the held note's pitch on the NEW components
                if (isPortamentoOn && glideTime > 0.001 && (startRate !== null || startFreqOsc1 !== null || startFreqOsc2 !== null)) {
                    console.log(`Mono NoteOff (Multi): Applying glide to new components for note ${lastHeldNoteNumber}`);
                    const targetRate = isSampleKeyTrackingOn ? TR2 ** (lastHeldNoteNumber - 12) : 1.0;
                    const targetFreqOsc1 = noteToFrequency(lastHeldNoteNumber, osc1OctaveOffset);
                    const targetFreqOsc2 = noteToFrequency(lastHeldNoteNumber, osc2OctaveOffset);

                    // Glide Sampler Rate (on newVoice.samplerNote)
                    if (newVoice.samplerNote?.source?.playbackRate && startRate !== null) {
                        const p = newVoice.samplerNote.source.playbackRate;
                        p.setValueAtTime(startRate, now);
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
                    // Glide FM sources if needed (apply to newVoice components)
                    // FM for Osc1
                    if (newVoice.osc1Note?.fmModulatorSource?.playbackRate && startRate !== null && osc1FMSource === 'sampler') {
                        const fmSource = newVoice.osc1Note.fmModulatorSource;
                        fmSource.playbackRate.setValueAtTime(startRate, now);
                        fmSource.playbackRate.linearRampToValueAtTime(targetRate, now + glideTime);
                    }
                    // FM for Osc2
                    if (newVoice.osc2Note?.fmModulatorSource?.playbackRate && startRate !== null && osc2FMSource === 'sampler') {
                        const fmSource = newVoice.osc2Note.fmModulatorSource;
                        fmSource.playbackRate.setValueAtTime(startRate, now);
                        fmSource.playbackRate.linearRampToValueAtTime(targetRate, now + glideTime);
                    }

                } else {
                     console.log(`Mono NoteOff (Multi): Portamento off or zero glide. New components started at target pitch ${lastHeldNoteNumber}.`);
                }

                // Fade out the components of the note that was just released (voiceBeingReleased)
                console.log(`Mono NoteOff (Multi): Fading out previous components for Note ${releasedNoteNumber}.`);
                // <<< Use a slightly longer delay to ensure new notes have started >>>
                setTimeout(() => {
                    if (voiceBeingReleased.samplerNote) quickFadeOutSampler(voiceBeingReleased.samplerNote, 0.025); // Increased fade time slightly
                    if (voiceBeingReleased.osc1Note) quickFadeOutOsc1(voiceBeingReleased.osc1Note, 0.025);
                    if (voiceBeingReleased.osc2Note) quickFadeOutOsc2(voiceBeingReleased.osc2Note, 0.025);
                }, 10); // Increased delay slightly

                // Remove old activeVoices entry for the released note (if different from held note)
                if (releasedNoteNumber !== lastHeldNoteNumber && activeVoices[releasedNoteNumber] === voiceBeingReleased) {
                    // Let the kill functions handle the final deletion from activeVoices after fade out
                    console.log(`Mono NoteOff (Multi): Old voice entry activeVoices[${releasedNoteNumber}] will be removed by kill functions.`);
                } else if (releasedNoteNumber === lastHeldNoteNumber) {
                     console.warn("Mono NoteOff (Multi): Released note is the same as the held note - potential state issue.");
                     // Ensure the old entry is removed if it wasn't the one we just created
                     if (activeVoices[releasedNoteNumber] === voiceBeingReleased) {
                         // This shouldn't happen if we correctly assigned newVoice, but handle defensively
                         delete activeVoices[releasedNoteNumber];
                     }
                }
            } else {
                // --- Legato mode: Glide pitch back to the last held note ---
                // ... (existing legato noteOff logic - seems mostly correct based on description) ...
                // <<< Double check glide application within this block >>>
                console.log(`Mono NoteOff (Legato): Gliding pitch back to ${lastHeldNoteNumber}.`);
                const voiceToUpdate = currentMonoVoice;
                const releasedNoteNumber = voiceToUpdate?.noteNumber; // Check if voiceToUpdate exists

                // --- CRITICAL VALIDATION ---
                if (!voiceToUpdate || voiceToUpdate.state === 'killed' || releasedNoteNumber === undefined || releasedNoteNumber === null) {
                    console.error(`Mono NoteOff (Legato): Critical error! voiceToUpdate is invalid or has no noteNumber before glide back.`);
                    return; // Exit early
                }
                // Check components individually
                const samplerValid = !voiceToUpdate.samplerNote || (voiceToUpdate.samplerNote.state !== 'killed' && voiceToUpdate.samplerNote.source);
                const osc1Valid = !voiceToUpdate.osc1Note || (voiceToUpdate.osc1Note.state !== 'killed' && voiceToUpdate.osc1Note.workletNode);
                const osc2Valid = !voiceToUpdate.osc2Note || (voiceToUpdate.osc2Note.state !== 'killed' && voiceToUpdate.osc2Note.workletNode);

                if (!samplerValid || !osc1Valid || !osc2Valid) {
                     console.error(`Mono NoteOff (Legato): Critical error! Required components are invalid/killed before glide back.`);
                     // Attempt cleanup
                     if (voiceToUpdate.samplerNote && !samplerValid) quickFadeOutSampler(voiceToUpdate.samplerNote, 0.01);
                     if (voiceToUpdate.osc1Note && !osc1Valid) quickFadeOutOsc1(voiceToUpdate.osc1Note, 0.01);
                     if (voiceToUpdate.osc2Note && !osc2Valid) quickFadeOutOsc2(voiceToUpdate.osc2Note, 0.01);
                     currentMonoVoice = null;
                     delete activeVoices[releasedNoteNumber];
                     delete activeVoices[lastHeldNoteNumber]; // Clean up both potential keys
                     updateVoiceDisplay(); updateKeyboardDisplay();
                     return;
                }
                // --- End validation ---

                // Update voice state FIRST
                voiceToUpdate.noteNumber = lastHeldNoteNumber;
                activeVoices[lastHeldNoteNumber] = voiceToUpdate;
                if (releasedNoteNumber !== lastHeldNoteNumber) { delete activeVoices[releasedNoteNumber]; }

                // Glide pitch FROM current pitch DOWN TO the held note's pitch
                const glideDuration = Math.max(glideTime, 0.001);
                const targetRate = isSampleKeyTrackingOn ? TR2 ** (lastHeldNoteNumber - 12) : 1.0;
                const targetFreqOsc1 = noteToFrequency(lastHeldNoteNumber, osc1OctaveOffset);
                const targetFreqOsc2 = noteToFrequency(lastHeldNoteNumber, osc2OctaveOffset);

                // Sampler Glide
                if (voiceToUpdate.samplerNote?.source?.playbackRate) {
                    const p = voiceToUpdate.samplerNote.source.playbackRate;
                    p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); p.linearRampToValueAtTime(targetRate, now + glideDuration);
                    voiceToUpdate.samplerNote.noteNumber = lastHeldNoteNumber;
                }
                // FM Glide for Osc1 (if sampler-based)
                if (osc1FMSource === 'sampler' && voiceToUpdate.osc1Note?.fmModulatorSource?.playbackRate) {
                    const fmSource = voiceToUpdate.osc1Note.fmModulatorSource;
                    const currentFmRate = fmSource.playbackRate.value;
                    fmSource.playbackRate.cancelScheduledValues(now);
                    fmSource.playbackRate.setValueAtTime(currentFmRate, now);
                    fmSource.playbackRate.linearRampToValueAtTime(targetRate, now + glideDuration);
                }
                // FM Glide for Osc2 (if sampler-based)
                if (osc2FMSource === 'sampler' && voiceToUpdate.osc2Note?.fmModulatorSource?.playbackRate) {
                    const fmSource = voiceToUpdate.osc2Note.fmModulatorSource;
                    const currentFmRate = fmSource.playbackRate.value;
                    fmSource.playbackRate.cancelScheduledValues(now);
                    fmSource.playbackRate.setValueAtTime(currentFmRate, now);
                    fmSource.playbackRate.linearRampToValueAtTime(targetRate, now + glideDuration);
                }
                 // Osc1 Glide
                 if (voiceToUpdate.osc1Note?.workletNode) {
                    const p = voiceToUpdate.osc1Note.workletNode.parameters.get('frequency');
                    if(p) { p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); p.linearRampToValueAtTime(targetFreqOsc1, now + glideDuration); }
                    voiceToUpdate.osc1Note.noteNumber = lastHeldNoteNumber;
                }
                 // Osc2 Glide
                if (voiceToUpdate.osc2Note?.workletNode) {
                    const p = voiceToUpdate.osc2Note.workletNode.parameters.get('frequency');
                    if(p) { p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); p.linearRampToValueAtTime(targetFreqOsc2, now + glideDuration); }
                    voiceToUpdate.osc2Note.noteNumber = lastHeldNoteNumber;
                }
            }
            lastPlayedNoteNumber = lastHeldNoteNumber; // Update last played note
        } else {
            // --- No notes left held ---
            console.log(`Mono NoteOff: No other notes held. Releasing current mono voice (Note ${noteNumber}).`);
             const voiceToRelease = currentMonoVoice;

             // Store last actual pitch BEFORE nullifying/releasing
             if (voiceToRelease?.samplerNote?.source?.playbackRate) { try { lastActualSamplerRate = voiceToRelease.samplerNote.source.playbackRate.value; } catch(e){} } else { lastActualSamplerRate = null; }
             if (voiceToRelease?.osc1Note?.workletNode) { try { const p = voiceToRelease.osc1Note.workletNode.parameters.get('frequency'); if(p) lastActualOsc1Freq = p.value; } catch(e){} } else { lastActualOsc1Freq = null; }
             if (voiceToRelease?.osc2Note?.workletNode) { try { const p = voiceToRelease.osc2Note.workletNode.parameters.get('frequency'); if(p) lastActualOsc2Freq = p.value; } catch(e){} } else { lastActualOsc2Freq = null; } // <<< Store Osc2
             console.log(`Mono NoteOff: Stored last actual pitch - Rate: ${lastActualSamplerRate?.toFixed(4)}, Freq1: ${lastActualOsc1Freq?.toFixed(2)}, Freq2: ${lastActualOsc2Freq?.toFixed(2)}`);

             currentMonoVoice = null; // Nullify the global reference

             if (voiceToRelease) {
                  if (voiceToRelease.samplerNote) releaseSamplerNote(voiceToRelease.samplerNote);
                  if (voiceToRelease.osc1Note) releaseOsc1Note(voiceToRelease.osc1Note);
                  if (voiceToRelease.osc2Note) releaseOsc2Note(voiceToRelease.osc2Note);
                  // The release functions will schedule kill functions, which handle removing from activeVoices
             } else {
                  console.warn(`Mono NoteOff: voiceToRelease was unexpectedly null when releasing last key for note ${noteNumber}.`);
                  lastActualSamplerRate = null; lastActualOsc1Freq = null; lastActualOsc2Freq = null;
                  delete activeVoices[noteNumber]; // Clean up map directly if voice was null
             }
        }
    } else {
        // --- Poly Mode Logic ---
        const voice = activeVoices[noteNumber];
        if (voice) {
             console.log(`Poly NoteOff: Found voice for note ${noteNumber}. Releasing components.`);
            if (voice.samplerNote && (voice.samplerNote.state === 'playing' || voice.samplerNote.state === 'fadingOut')) { releaseSamplerNote(voice.samplerNote); }
            if (voice.osc1Note && (voice.osc1Note.state === 'playing' || voice.osc1Note.state === 'fadingOut')) { releaseOsc1Note(voice.osc1Note); }
            if (voice.osc2Note && (voice.osc2Note.state === 'playing' || voice.osc2Note.state === 'fadingOut')) { releaseOsc2Note(voice.osc2Note); } // <<< Release Osc2
        } else {
             console.log(`Poly NoteOff: No active voice found for noteNumber ${noteNumber}.`);
        }
    }

    updateVoiceDisplay();
    updateKeyboardDisplay();
}
function updateSampleProcessing() {
console.log("Updating sample processing...");

// Reset cached buffers
fadedBuffer = null;
cachedCrossfadedBuffer = null;
lastCachedStartPos = null;
lastCachedEndPos = null;
lastCachedCrossfade = null;

setTimeout(() => {
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
        setTimeout(() => {
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
updateVoiceDisplay();
updateADSRVisualization();
// Initialize Keyboard Module
initializeKeyboard('keyboard', noteOn, noteOff, updateKeyboardDisplay);

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

                Object.entries(activeVoices).forEach(([key, voice]) => {
                    // ... (rest of update logic) ...
                    if (voice && voice.osc1Note) {
                        updateOsc1FmModulatorParameters(voice.osc1Note, nowSwitch, voice);
                    }
                });
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
    activeVoices, // Pass object reference
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
        Object.values(activeVoices).forEach(voice => {
            if (voice && voice.osc1Note && voice.osc1Note.workletNode) {
                const targetFreq = noteToFrequency(voice.osc1Note.noteNumber, osc1OctaveOffset);
                const freqParam = voice.osc1Note.workletNode.parameters.get('frequency');
                if (freqParam) {
                    console.log(`Updating Worklet note ${voice.osc1Note.id} frequency to ${targetFreq.toFixed(2)} Hz`);
                    freqParam.setTargetAtTime(targetFreq, now, 0.01);
                } else {
                    console.warn(`Could not find frequency parameter for Osc1 note ${voice.osc1Note.id}`);
                }
            }
        });
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

        Object.values(activeVoices).forEach(voice => {
            // <<< Simplify: Only need to handle workletNode >>>
            if (voice && voice.osc1Note && voice.osc1Note.workletNode && voice.osc1Note.state === 'playing') {
                const oscNote = voice.osc1Note;
                try {
                    // Update the waveformType parameter directly
                    const waveformParam = oscNote.workletNode.parameters.get('waveformType');
                    if (waveformParam) {
                        // waveformType is k-rate, so setValueAtTime is appropriate
                        waveformParam.setValueAtTime(targetWaveformType, now);
                        console.log(`Updated active note ${oscNote.id} waveform type to ${targetWaveformType} (${osc1Waveform})`);
                    } else {
                        console.warn(`Could not find waveformType parameter for note ${oscNote.id}`);
                    }

                    // --- NO NEED TO RECREATE NODE ---
                    // The worklet handles different waveforms internally based on the parameter.
                    // Glide logic is handled by frequency/detune parameter updates elsewhere.

                } catch (e) {
                    console.error(`Error updating active Osc1 note ${oscNote?.id} waveform type:`, e);
                    // Consider killing note if update fails badly
                    // killOsc1Note(oscNote);
                }
            }
            // <<< Remove handling for toneOscillator >>>
        });
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
updateSampleProcessing();

// Update any active notes
Object.values(activeVoices).forEach(note => {
  if (note && note.source) {
    // Force re-processing
    note.usesProcessedBuffer = false;
    note.crossfadeActive = false;
    
    if (isSampleLoopOn) {
      note.looping = true;
      setupLoopCrossfade(note);
    }
    updateSamplePlaybackParameters(note);
  }
});
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
            Object.values(activeVoices).forEach(voice => {
                if (voice && voice.osc2Note && voice.osc2Note.workletNode) {
                    const targetFreq = noteToFrequency(voice.osc2Note.noteNumber, osc2OctaveOffset);
                    const freqParam = voice.osc2Note.workletNode.parameters.get('frequency');
                    if (freqParam) {
                        freqParam.setTargetAtTime(targetFreq, now, 0.01); // Smooth transition
                    }
                }
            });
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
            Object.values(activeVoices).forEach(voice => {
                if (voice && voice.osc2Note && voice.osc2Note.workletNode && voice.osc2Note.state === 'playing') {
                    const waveParam = voice.osc2Note.workletNode.parameters.get('waveformType');
                    if (waveParam) {
                        waveParam.setValueAtTime(targetWaveformType, now);
                    }
                }
            });
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
                Object.values(activeVoices).forEach(voice => {
                    if (voice && voice.osc2Note) {
                        // Pass the voice object to updateOsc2FmModulatorParameters
                        updateOsc2FmModulatorParameters(voice.osc2Note, nowSwitch, voice);
                    }
                });
            }
        }
    });
    // <<< FIX: Update initial setValue logic >>>
    fmSwitchControl.setValue(osc2FMSource === 'osc1'); // Set initial state (true if 'osc1')
    // Initial update for any pre-existing notes
    const nowInitOsc2FM = audioCtx.currentTime;
    Object.values(activeVoices).forEach(voice => {
        if (voice && voice.osc2Note) {
            // Pass the voice object here too
            updateOsc2FmModulatorParameters(voice.osc2Note, nowInitOsc2FM, voice);
        }
    });


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

            // <<< ADD: Update active notes' playbackRate/detune for sampler AND FM modulator >>>
            Object.values(activeVoices).forEach(voice => {
                if (!voice) return;
                const noteNumber = voice.noteNumber; // Get the note number for this voice

                // Update Sampler Note
                if (voice.samplerNote && voice.samplerNote.source) {
                    const samplerSource = voice.samplerNote.source;
                    if (isSampleKeyTrackingOn) {
                        const targetRate = TR2 ** (noteNumber - 12);
                        samplerSource.playbackRate.setTargetAtTime(targetRate, now, 0.01);
                        samplerSource.detune.setTargetAtTime(currentSampleDetune, now, 0.01);
                    } else {
                        samplerSource.playbackRate.setTargetAtTime(1.0, now, 0.01);
                        // Detune still applies even if key tracking is off
                        samplerSource.detune.setTargetAtTime(currentSampleDetune, now, 0.01);
                    }
                }

                // Update FM Modulator Source (if it exists)
                if (voice.osc1Note && voice.osc1Note.fmModulatorSource) {
                    const fmSource = voice.osc1Note.fmModulatorSource;
                    if (isSampleKeyTrackingOn) {
                        const targetRate = TR2 ** (noteNumber - 12);
                        fmSource.playbackRate.setTargetAtTime(targetRate, now, 0.01);
                        fmSource.detune.setTargetAtTime(currentSampleDetune, now, 0.01);
                    } else {
                        fmSource.playbackRate.setTargetAtTime(1.0, now, 0.01);
                        fmSource.detune.setTargetAtTime(currentSampleDetune, now, 0.01);
                    }
                }
            });
            // <<< END ADD >>>
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