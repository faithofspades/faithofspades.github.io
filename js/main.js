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
// All other knobs default to 0.5
};
// --- Helper Functions ---

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




function reverseBufferIfNeeded() {
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
      reverseBufferIfNeeded(); // Assumes reverseBufferIfNeeded uses the global audioBuffer/originalBuffer
  }
  // 3) Process fades and crossfades using the same function
  updateSampleProcessing(); // Assumes updateSampleProcessing uses the global audioBuffer

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

        // Show and update tooltip
        const tooltip = createTooltipForKnob('sample-pitch-knob', value); // Use specific tooltip helper
        tooltip.textContent = `${currentSampleDetune.toFixed(0)} cents`;
        tooltip.style.opacity = '1';

        // Update all active sampler notes' pitch
        Object.values(activeVoices).forEach(voice => {
            if (voice && voice.samplerNote && voice.samplerNote.source) {
                voice.samplerNote.source.detune.setTargetAtTime(currentSampleDetune, audioCtx.currentTime, 0.01);
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
        // Convert 0-1 range to -1200 to +1200 cents (like sample pitch)
        const newDetune = (value * 2400) - 1200;
        osc1Detune = newDetune; // Update global detune value

        const tooltip = createTooltipForKnob('osc1-pitch-knob', value);
        tooltip.textContent = `${osc1Detune.toFixed(0)} cents`;
        tooltip.style.opacity = '1';

        // Update detune of all active Osc1 notes smoothly
        const now = audioCtx.currentTime;
        Object.values(activeVoices).forEach(voice => {
            if (voice && voice.osc1Note) {
                let oscDetuneParam = null;
                if (voice.osc1Note.toneOscillator) {
                    oscDetuneParam = voice.osc1Note.toneOscillator.detune;
                } else if (voice.osc1Note.oscillator) {
                    oscDetuneParam = voice.osc1Note.oscillator.detune;
                }

                if (oscDetuneParam) {
                    // Use setTargetAtTime for smooth updates
                    oscDetuneParam.setTargetAtTime(osc1Detune, now, 0.01);
                }
            }
        });
        console.log('Osc1 Pitch (Detune):', osc1Detune.toFixed(0) + ' cents');
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
originalBuffer = buffer.slice(); // Store the original buffer

// Apply reverse if needed
if (isSampleReversed) {
reverseBufferIfNeeded();
}
        
        // Process fades and crossfades whenever a new sample is loaded
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
        });
    });
};
reader.readAsArrayBuffer(file);
}


function checkAudioAvailable() {
if (!audioBuffer) {
console.warn("No audio buffer available - load a sample first!");
return false;
}
return true;
}

D('audio-file').addEventListener('change', handleFileSelect);

// Clean up everything
// Clean up everything
function cleanupAllNotes() {
    console.log("Cleaning up all notes...");
    // Iterate through the unified activeVoices
    const notesToKill = Object.keys(activeVoices); // Get keys before iterating/deleting
    notesToKill.forEach(noteNumber => {
        const voice = activeVoices[noteNumber];
        if (voice) {
            // Use kill functions which handle removal from activeVoices
            if (voice.samplerNote) killSamplerNote(voice.samplerNote);
            if (voice.osc1Note) killOsc1Note(voice.osc1Note);
            // Add killOsc2Note etc. here later
        }
        // Ensure entry is deleted even if components were already null/killed
        delete activeVoices[noteNumber];
    });

    resetKeyStates(); // Update keyboard UI

    // Reset mono tracking
    currentMonoVoice = null;
    heldNotes = [];
    // lastPlayedNoteNumber = null; // Keep last played note for portamento

    updateVoiceDisplay();
    updateKeyboardDisplay();
}

// Add additional safety with blur/focus event handling
window.addEventListener('blur', cleanupAllNotes);
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        cleanupAllNotes();
    }
});

// Initialize interface

updateSliderValues();
updateVoiceDisplay();
updateADSRVisualization();
// Initialize Keyboard Module
initializeKeyboard('keyboard', noteOn, noteOff, updateKeyboardDisplay)

// document.addEventListener('DOMContentLoaded', () => {
// // Initialize all knobs with placeholder functionality
// const knobInitializations = {
// 'sample-volume-knob': (value) => {
//     if (sampleGainNode) {
//         sampleGainNode.gain.setValueAtTime(value, audioCtx.currentTime);
//         console.log('Sample Gain:', value.toFixed(2));
//     }
// }
// };
// });



// Add tooltip creation function
function createTooltip() {
const tooltip = document.createElement('div');
tooltip.id = 'pitch-tooltip';
tooltip.className = 'tooltip';
document.body.appendChild(tooltip);

// Position tooltip near the pitch knob
const knob = D('sample-pitch-knob');
const knobRect = knob.getBoundingClientRect();
tooltip.style.left = `${knobRect.left + knobRect.width + 5}px`;
tooltip.style.top = `${knobRect.top + (knobRect.height / 2) - 10}px`;

return tooltip;
}
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
function initializeOctaveSlider(slider, onChange) {
const handle = slider.querySelector('.octave-slider-handle');
const sliderHeight = slider.offsetHeight - handle.offsetHeight;
const positions = 5; // -2 to +2
const stepSize = sliderHeight / (positions - 1);
let currentPosition = 2; // Start at middle (0)

// Set initial position
handle.style.top = (currentPosition * stepSize) + 'px';

function snapToPosition(y) {
const relativeY = y - slider.getBoundingClientRect().top;
let position = Math.round(relativeY / stepSize);
position = Math.max(0, Math.min(positions - 1, position));
return position;
}

function updatePosition(position) {
handle.style.top = (position * stepSize) + 'px';
const value = 2 - position; // Convert position to octave value
if (onChange) onChange(value);
}

let isDragging = false;

handle.addEventListener('mousedown', (e) => {
isDragging = true;
handle.style.cursor = 'grabbing';
e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
if (!isDragging) return;
const position = snapToPosition(e.clientY);
updatePosition(position);
currentPosition = position;
});

document.addEventListener('mouseup', () => {
if (isDragging) {
    isDragging = false;
    handle.style.cursor = 'grab';
}
});

// Initialize at center position (0 octave)
updatePosition(2);

return {
setValue: (octave) => {
    const position = 2 - octave; // Convert octave value to position
    updatePosition(Math.max(0, Math.min(positions - 1, position)));
}
};
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
let isActive = false;

// Create tooltip for this switch
const tooltip = document.createElement('div');
tooltip.className = 'tooltip';
document.body.appendChild(tooltip);

function updateTooltip() {
const switchRect = switchEl.getBoundingClientRect();
tooltip.style.left = `${switchRect.left + switchRect.width + 5}px`;
tooltip.style.top = `${switchRect.top + (switchRect.height / 2) - 10}px`;
tooltip.textContent = isActive ? options.onText : options.offText;
tooltip.style.opacity = '1';
}

function handleMouseDown(e) {
isDragging = true;
switchEl.style.cursor = 'grabbing';
updateTooltip();
e.preventDefault();
}

function handleMouseUp() {
isDragging = false;
switchEl.style.cursor = 'grab';
tooltip.style.opacity = '0';
}

function handleClick() {
isActive = !isActive;
switchEl.classList.toggle('active');
updateTooltip();
return isActive;
}

switchEl.addEventListener('mousedown', handleMouseDown);
document.addEventListener('mouseup', handleMouseUp);
switchEl.addEventListener('click', handleClick);

return {
getValue: () => isActive,
setValue: (value) => {
    isActive = value;
    switchEl.classList.toggle('active', isActive);
    updateTooltip();
}
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
// Add this function for switch tooltips
function createTooltipForSwitch(switchId, options = { onText: 'ON', offText: 'OFF' }) {
const tooltip = document.getElementById(`${switchId}-tooltip`) || (() => {
const newTooltip = document.createElement('div');
newTooltip.id = `${switchId}-tooltip`;
newTooltip.className = 'tooltip';
document.body.appendChild(newTooltip);
return newTooltip;
})();

// Position tooltip near its switch
const switchEl = D(switchId);
if (switchEl) {
const rect = switchEl.getBoundingClientRect();
tooltip.style.left = `${rect.left + rect.width + 5}px`;
tooltip.style.top = `${rect.top + (rect.height / 2) - 10}px`;
}

return tooltip;
}


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
function initializeSwitches() {
const switches = {
'voice-mode-switch': {
    onText: 'MONO',
    offText: 'POLY',
    onChange: (active) => {
        isMonoMode = active;
        cleanupAllNotes();
        console.log('Voice Mode:', active ? 'MONO' : 'POLY');
    }
},
'trigger-mode-switch': {
    offText: 'MULTI',
    onText: 'LEGATO',
    onChange: (active) => {
        isLegatoMode = active;
        console.log('Trigger Mode:', active ? 'LEGATO' : 'MULTI');
    }
},
'portamento-switch': {
    onText: 'PORTA ON',
    offText: 'PORTA OFF',
    onChange: (active) => {
        isPortamentoOn = active;
        console.log('Portamento:', active ? 'ON' : 'OFF');
    }
}
};

Object.entries(switches).forEach(([id, config]) => {
const switchEl = D(id);
if (!switchEl) return;

let isActive = false;

function updateSwitch() {
    switchEl.classList.toggle('active', isActive);
    
    // Skip tooltip creation completely for emu-mode-switch
    if (id !== 'emu-mode-switch') {
        const tooltip = createTooltipForSwitch(id);
        tooltip.textContent = isActive ? config.onText : config.offText;
        tooltip.style.opacity = '1';
    }
    
    config.onChange(isActive);
}

switchEl.addEventListener('click', () => {
    isActive = !isActive;
    updateSwitch();
});

// Don't add tooltip events to emu-mode-switch
if (id !== 'emu-mode-switch') {
    switchEl.addEventListener('mousedown', (e) => {
        const tooltip = createTooltipForSwitch(id);
        tooltip.textContent = isActive ? config.onText : config.offText;
        tooltip.style.opacity = '1';
        e.preventDefault();
    });
}
});

// Add special handling for emu-mode-switch
const emuModeSwitch = D('emu-mode-switch');
if (emuModeSwitch) {
emuModeSwitch.addEventListener('click', () => {
    const isActive = emuModeSwitch.classList.contains('active');
    isEmuModeOn = !isActive; // Toggle the state
    
    // Update LED indicator
    const led = document.getElementById('emu-led');
    if (led) {
        led.classList.toggle('on', !isActive);
    }
    
    // Toggle active class
    emuModeSwitch.classList.toggle('active', !isActive);
    
    // Process with E-mu mode
    updateSampleProcessing();
    
    // Update any playing notes
    Object.values(activeVoices).forEach(note => {
        if (note && note.source && !heldNotes.includes(note.noteNumber)) {
            updateSamplePlaybackParameters(note);
        }
    });
    
    console.log('Lo-Fi Mode:', !isActive ? 'ON' : 'OFF');
});
}
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

// Rest of the function...

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

    // If using a crossfaded buffer, stop looping immediately on release
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

    const releaseTimer = setTimeout(() => {
        killSamplerNote(note); // Kill the specific sampler component
    }, (release * 1000) + 100);
    note.scheduledEvents.push({ type: "timeout", id: releaseTimer });
}

function killSamplerNote(note) {
    // Check if note is valid and not already killed
    if (!note || note.state === "killed") return false;
    const noteNumber = note.noteNumber;
    const noteId = note.id;
    console.log(`killSamplerNote: Attempting to kill ${noteId} (Note ${noteNumber})`);
    note.state = "killed";

    // ... (clear scheduledEvents) ...
    note.scheduledEvents.forEach(event => {
        if (event.type === "timeout") clearTimeout(event.id);
    });
    note.scheduledEvents = [];

    try {
        // Stop and disconnect audio nodes
        if (note.gainNode) {
            note.gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
            note.gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
            note.gainNode.disconnect();
        }
        if (note.sampleNode) {
            note.sampleNode.disconnect();
        }
        if (note.source) {
            try { note.source.stop(audioCtx.currentTime); } catch(e) {}
            note.source.disconnect();
        }
    } catch (e) {
         console.warn(`killSamplerNote [${noteId}]: Error during node cleanup:`, e);
    }

    // --- Safely update unified voice tracking (activeVoices ONLY) ---
    const voice = activeVoices[noteNumber];
    if (voice) {
        // Nullify the reference in activeVoices if it points to the note we just killed
        if (voice.samplerNote === note) {
            console.log(`killSamplerNote [${noteId}]: Nullifying samplerNote reference in activeVoices[${noteNumber}].`);
            voice.samplerNote = null;
        } else {
             console.log(`killSamplerNote [${noteId}]: samplerNote reference in activeVoices[${noteNumber}] did not match. Skipping nullification.`);
        }

        // Check if the voice entry in activeVoices is now empty and can be deleted
        if (!voice.samplerNote && !voice.osc1Note) {
            console.log(`killSamplerNote [${noteId}]: Both components for note ${noteNumber} in activeVoices are null. Deleting voice entry activeVoices[${noteNumber}].`);
            delete activeVoices[noteNumber]; // Delete if BOTH are null
        }
    } else {
         console.log(`killSamplerNote [${noteId}]: No active voice found for note ${noteNumber} in activeVoices during cleanup.`);
    }
    // --- End safe update ---

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
    // Only start if gain is audible
    if (osc1GainValue <= 0.001) return null;

    const noteId = `osc1_${noteNumber}_${Date.now()}`;
    const osc1LevelNode = audioCtx.createGain(); // <<< NEW: Node for knob control
    const oscGainNode = audioCtx.createGain();   // Node for ADSR control
    osc1LevelNode.gain.value = osc1GainValue;    // Set initial level from global
    oscGainNode.gain.value = 0;                  // Start silent for ADSR


    let nativeOscillator = null;
    let toneOscillator = null;
    const now = audioCtx.currentTime;
    const targetFreq = noteToFrequency(noteNumber, osc1OctaveOffset); // Base frequency

    if (osc1Waveform === 'pulse') {
        try {
            // --- Create Tone.js Pulse Oscillator with BASE frequency ---
            console.log(`startOsc1Note [${noteId}]: Creating Tone.PulseOscillator with BASE Freq=${targetFreq.toFixed(2)}`);
            toneOscillator = new Tone.PulseOscillator(targetFreq, 0.25); // <<< Use BASE targetFreq

            // --- Apply detune using setValueAtTime for precise timing ---
            toneOscillator.detune.setValueAtTime(osc1Detune, now); // <<< USE setValueAtTime
            console.log(`startOsc1Note [${noteId}]: Scheduled initial detune to ${osc1Detune.toFixed(0)} cents at time ${now.toFixed(4)}.`);

            toneOscillator.connect(osc1LevelNode); // Connect Osc to Level Node
            toneOscillator.start(now); // Start at the same time
        } catch (e) {
            console.error(`startOsc1Note [${noteId}]: Failed to create Tone.PulseOscillator:`, e);
            // Clean up gain node if creation failed
            try { oscGainNode.disconnect(); } catch(err) {}
            return null;
        }
    } else {
        // --- Create Standard Native Oscillator ---
        nativeOscillator = audioCtx.createOscillator();
        nativeOscillator.type = osc1Waveform;
        // Set base frequency and detune separately for native oscillator
        nativeOscillator.frequency.setValueAtTime(targetFreq, now); // <<< Base frequency
        nativeOscillator.detune.setValueAtTime(osc1Detune, now);    // <<< Detune offset (already correct)
        nativeOscillator.connect(osc1LevelNode); // Connect Osc to Level Node
        nativeOscillator.start(now);
        console.log(`startOsc1Note [${noteId}]: Using native ${osc1Waveform} oscillator with detune ${osc1Detune}.`); // Log detune
    }

    // Connect Level Node -> ADSR Node -> Destination
    osc1LevelNode.connect(oscGainNode);
    oscGainNode.connect(destination);

    // Apply ADSR envelope to oscGainNode (ADSR node ramps 0 -> 1 -> sustain)
    const attack = parseFloat(D('attack').value);
    const decay = parseFloat(D('decay').value);
    const sustainLevel = parseFloat(D('sustain').value); // <<< Use sustainLevel here
    oscGainNode.gain.setValueAtTime(0, now);
    oscGainNode.gain.linearRampToValueAtTime(1.0, now + attack); // <<< Ramp to 1
    oscGainNode.gain.linearRampToValueAtTime(sustainLevel, now + attack + decay); // <<< Ramp to sustainLevel

    const note = {
        id: noteId,
        type: 'osc1',
        noteNumber,
        oscillator: nativeOscillator,
        toneOscillator: toneOscillator,
        levelNode: osc1LevelNode, // <<< Store reference to level node
        gainNode: oscGainNode,    // ADSR gain node
        startTime: now,
        state: "playing",
        scheduledEvents: []
    };
    return note;
}

function releaseOsc1Note(note) {
    if (!note || note.state !== "playing") return;
    note.state = "releasing";

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

    // Schedule final cleanup (killOsc1Note)
    const releaseTimer = setTimeout(() => {
        killOsc1Note(note);
    }, (release * 1000) + 100); // Keep existing timeout
    note.scheduledEvents.push({ type: "timeout", id: releaseTimer });
}

function killOsc1Note(note) {
    // Check if note is valid and not already killed
    if (!note || note.state === "killed") return false;
    const noteNumber = note.noteNumber;
    const noteId = note.id;
    console.log(`killOsc1Note: Attempting to kill ${noteId} (Note ${noteNumber})`);
    note.state = "killed";

    // Clear scheduled events (including potential Tone disposal)
    note.scheduledEvents.forEach(event => {
        if (event.type === "timeout") clearTimeout(event.id);
        // No explicit cancel needed for scheduled Tone disposal, dispose() handles it
    });
    note.scheduledEvents = [];

    try {
        // Stop and disconnect ADSR gain node (native)
        if (note.gainNode) {
            note.gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
            note.gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
            note.gainNode.disconnect();
        }
        // Disconnect Level node <<< ADDED
        if (note.levelNode) {
            note.levelNode.disconnect();
        }

        // Stop/Dispose/Disconnect Oscillators
        if (note.toneOscillator) {
            try {
                note.toneOscillator.disconnect(); // Disconnect from levelNode
                note.toneOscillator.dispose();
            } catch(e) { /* ... */ }
        } else if (note.oscillator) {
             try { note.oscillator.stop(audioCtx.currentTime); } catch(e) {}
            note.oscillator.disconnect(); // Disconnect from levelNode
        }

    } catch (e) {
        console.warn(`killOsc1Note [${noteId}]: Error during node cleanup:`, e);
    }

    // --- Safely update unified voice tracking (activeVoices ONLY) ---
    // ... (This part remains the same) ...
    const voice = activeVoices[noteNumber];
    if (voice) {
        if (voice.osc1Note === note) {
            voice.osc1Note = null;
        }
        if (!voice.samplerNote && !voice.osc1Note) {
            delete activeVoices[noteNumber];
        }
    }
    // --- End safe update ---

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
// --- Unified Note On/Off Handlers ---

function noteOn(noteNumber) {
    console.log(`noteOn: ${noteNumber}, Mono: ${isMonoMode}, Legato: ${isLegatoMode}, Porta: ${isPortamentoOn}`);
    const now = audioCtx.currentTime;

    // Add to held notes list
    if (!heldNotes.includes(noteNumber)) {
        heldNotes.push(noteNumber);
    }

    if (isMonoMode) {
        // --- MONO ---
        if (currentMonoVoice) {
            // --- Mono Update (Existing Voice) ---
            const oldNoteNumber = currentMonoVoice.noteNumber;
            console.log(`Mono NoteOn: Updating existing voice from ${oldNoteNumber} to ${noteNumber}. Legato: ${isLegatoMode}`);

            if (isLegatoMode) {
                // --- Legato: Update Pitch, NO Retrigger ---
                console.log("Mono NoteOn: Applying Legato pitch change.");
                const oldNoteNumberForLog = currentMonoVoice.noteNumber; // Capture before update

                // Update voice state
                currentMonoVoice.noteNumber = noteNumber; // Attempt to update to the new note number
                currentMonoVoice.startTime = now;
                console.log(`Mono Legato DEBUG: Updated currentMonoVoice.noteNumber from ${oldNoteNumberForLog} to ${currentMonoVoice.noteNumber}. Should be ${noteNumber}.`); // Verify update

                // Update activeVoices mapping if note number changed
                if (oldNoteNumberForLog !== noteNumber) {
                    // ... (Safety check for stale entries) ...
                    activeVoices[noteNumber] = currentMonoVoice;
                    delete activeVoices[oldNoteNumberForLog];
                    console.log(`Mono Legato: Updated activeVoices mapping from ${oldNoteNumberForLog} to ${noteNumber}.`);
                    console.log(`Mono Legato DEBUG: activeVoices[${noteNumber}] exists? ${!!activeVoices[noteNumber]}, activeVoices[${oldNoteNumberForLog}] exists? ${!!activeVoices[oldNoteNumberForLog]}`); // Verify map update
                }

                // Glide or Jump existing components based on Portamento
                const targetFreq = noteToFrequency(noteNumber, osc1OctaveOffset); // Target for the NEW note
                const targetRate = TR2 ** (noteNumber - 12);

                // --- Get the correct frequency/detune parameters ---
                let oscFreqParam = null;
                let oscDetuneParam = null;
                let currentFreq = NaN; // Capture current frequency before glide

                if (currentMonoVoice.osc1Note) {
                    if (currentMonoVoice.osc1Note.toneOscillator) {
                        oscFreqParam = currentMonoVoice.osc1Note.toneOscillator.frequency;
                        oscDetuneParam = currentMonoVoice.osc1Note.toneOscillator.detune;
                        currentFreq = oscFreqParam.value;
                    } else if (currentMonoVoice.osc1Note.oscillator) {
                        oscFreqParam = currentMonoVoice.osc1Note.oscillator.frequency;
                        oscDetuneParam = currentMonoVoice.osc1Note.oscillator.detune;
                        currentFreq = oscFreqParam.value;
                    }
                }
                // --- End Get parameters ---

                if (isPortamentoOn && glideTime > 0.001) { // <<< Legato + Porta ON
                    console.log(`Applying MONO Legato glide: ${glideTime.toFixed(3)}s`);
                    // Sampler Glide (remains the same)
                    if (currentMonoVoice.samplerNote?.source) {
                        const samplerNote = currentMonoVoice.samplerNote;
                        const currentRate = samplerNote.source.playbackRate.value;
                        samplerNote.source.playbackRate.cancelScheduledValues(now);
                        console.log(`Mono Legato Sampler Glide: Rate from ${currentRate.toFixed(4)} to ${targetRate.toFixed(4)}`);
                        samplerNote.source.playbackRate.setValueAtTime(currentRate, now);
                        samplerNote.source.playbackRate.linearRampToValueAtTime(targetRate, now + glideTime);
                        // samplerNote.source.detune.setTargetAtTime(currentSampleDetune, now, 0.01); // Update detune if needed
                    } else { console.error("Mono Legato Glide Error: Sampler source missing!"); }

                    // Osc1 Glide (Use the obtained oscFreqParam)
                    if (oscFreqParam && !isNaN(currentFreq)) {
                        oscFreqParam.cancelScheduledValues(now);
                        console.log(`Mono Legato Osc Glide: Freq from ${currentFreq.toFixed(2)} to ${targetFreq.toFixed(2)}`);
                        oscFreqParam.setValueAtTime(currentFreq, now);
                        oscFreqParam.linearRampToValueAtTime(targetFreq, now + glideTime);
                        // Update detune smoothly <<< ADDED
                        if (oscDetuneParam) {
                            oscDetuneParam.setTargetAtTime(osc1Detune, now, 0.01); // Target global detune
                        }
                    } else {
                         console.error("Mono Legato Glide Error: Oscillator frequency parameter missing or invalid current frequency!");
                    }
                } else { // <<< Legato + Porta OFF (or zero glide) - Apply glide based on glideTime setting
                    const glideDuration = Math.max(glideTime, 0.001); // Use glideTime knob value, ensure minimum
                    console.log(`Mono Legato (Porta OFF): Gliding pitch over ${glideDuration.toFixed(3)}s`);

                    // Sampler Pitch Glide (using glideDuration)
                    if (currentMonoVoice.samplerNote?.source) {
                        const samplerNote = currentMonoVoice.samplerNote;
                        const currentRate = samplerNote.source.playbackRate.value;
                        samplerNote.source.playbackRate.cancelScheduledValues(now);
                        console.log(`Mono Legato (Porta OFF) Sampler Glide: Rate from ${currentRate.toFixed(4)} to ${targetRate.toFixed(4)}`);
                        samplerNote.source.playbackRate.setValueAtTime(currentRate, now);
                        samplerNote.source.playbackRate.linearRampToValueAtTime(targetRate, now + glideDuration);
                        // samplerNote.source.detune.setTargetAtTime(currentSampleDetune, now, 0.01); // Update detune if needed
                    } else { console.error("Mono Legato (Porta OFF) Glide Error: Sampler source missing!"); }

                    // Osc1 Pitch Glide (using glideDuration and obtained oscFreqParam)
                    if (oscFreqParam && !isNaN(currentFreq)) { // <<< FIX: Use oscFreqParam here
                        oscFreqParam.cancelScheduledValues(now);
                        console.log(`Mono Legato (Porta OFF) Osc1 Glide: Freq from ${currentFreq.toFixed(2)} to ${targetFreq.toFixed(2)}`);
                        oscFreqParam.setValueAtTime(currentFreq, now);
                        oscFreqParam.linearRampToValueAtTime(targetFreq, now + glideDuration);
                        // Update detune smoothly <<< ADDED
                        if (oscDetuneParam) {
                            oscDetuneParam.setTargetAtTime(osc1Detune, now, 0.01); // Target global detune
                        }
                    } else {
                         console.error("Mono Legato (Porta OFF) Glide Error: Oscillator frequency parameter missing or invalid current frequency!"); // <<< FIX: Updated error message
                    }
                }
                // Update component note numbers
                if (currentMonoVoice.samplerNote) {
                    currentMonoVoice.samplerNote.noteNumber = noteNumber;
                    console.log(`Mono Legato DEBUG: Updated samplerNote.noteNumber to ${currentMonoVoice.samplerNote.noteNumber}`); // Verify component update
                }
                if (currentMonoVoice.osc1Note) {
                    currentMonoVoice.osc1Note.noteNumber = noteNumber;
                     console.log(`Mono Legato DEBUG: Updated osc1Note.noteNumber to ${currentMonoVoice.osc1Note.noteNumber}`); // Verify component update
                }
                // --- End normal Legato Glide/Jump ---

            } else {
                // --- Multi-Trigger Retrigger ---
                console.log("Mono NoteOn: Applying Multi-Trigger Retrigger.");
                const prevSamplerNote = currentMonoVoice.samplerNote;
                const prevOsc1Note = currentMonoVoice.osc1Note;

                // --- Get current pitch BEFORE starting new notes/fading old ---
                let startRate = null;
                let startFreq = null;
                if (isPortamentoOn && glideTime > 0.001) {
                    // Check previous sampler note
                    if (prevSamplerNote?.source) {
                        try { startRate = prevSamplerNote.source.playbackRate.value; } catch(e) { console.warn("Couldn't get prev sampler rate"); }
                    }
                    // Check previous osc1 note (Tone or Native)
                    if (prevOsc1Note) {
                        if (prevOsc1Note.toneOscillator) {
                             try { startFreq = prevOsc1Note.toneOscillator.frequency.value; } catch(e) { console.warn("Couldn't get prev Tone osc freq"); }
                        } else if (prevOsc1Note.oscillator) {
                             try { startFreq = prevOsc1Note.oscillator.frequency.value; } catch(e) { console.warn("Couldn't get prev native osc freq"); }
                        }
                    }
                    // Fallback to lastPlayedNoteNumber target if actual value couldn't be read
                    if (startRate === null && lastPlayedNoteNumber !== null) startRate = TR2 ** (lastPlayedNoteNumber - 12);
                    if (startFreq === null && lastPlayedNoteNumber !== null) startFreq = noteToFrequency(lastPlayedNoteNumber, osc1OctaveOffset);
                }
                // --- End Get current pitch ---

                // Update voice state for the NEW note
                currentMonoVoice.noteNumber = noteNumber;
                currentMonoVoice.startTime = now;
                // Update activeVoices mapping if note number changed
                if (oldNoteNumber !== noteNumber) {
                    activeVoices[noteNumber] = currentMonoVoice;
                    delete activeVoices[oldNoteNumber];
                    console.log(`Mono Multi-Trigger: Updated activeVoices mapping from ${oldNoteNumber} to ${noteNumber}.`);
                }

                // Start NEW components and assign them to currentMonoVoice
                console.log("Mono Multi-Trigger: Starting new components.");
                currentMonoVoice.samplerNote = startSamplerNote(noteNumber, audioCtx, masterGain, audioBuffer);
                currentMonoVoice.osc1Note = startOsc1Note(noteNumber, audioCtx, masterGain);
                console.log(`Mono Multi-Trigger: New samplerNote: ${currentMonoVoice.samplerNote?.id}, New osc1Note: ${currentMonoVoice.osc1Note?.id}`);
                // Apply portamento glide to NEW components if applicable
                if (isPortamentoOn && glideTime > 0.001 && (startRate !== null || startFreq !== null)) {
                    console.log(`Applying MONO multi-trigger glide: ${glideTime.toFixed(3)}s from actual pitch to ${noteNumber}`);
                    const targetRate = TR2 ** (noteNumber - 12);
                    const targetFreq = noteToFrequency(noteNumber, osc1OctaveOffset);

                    // Sampler Glide (to NEW samplerNote)
                    if (currentMonoVoice.samplerNote?.source && startRate !== null) {
                        console.log(`Mono Multi Sampler Glide: Rate from ${startRate.toFixed(4)} to ${targetRate.toFixed(4)}`);
                        currentMonoVoice.samplerNote.source.playbackRate.setValueAtTime(startRate, now);
                        currentMonoVoice.samplerNote.source.playbackRate.linearRampToValueAtTime(targetRate, now + glideTime);
                    }

                    // Osc1 Glide (to NEW osc1Note - check Tone or Native)
                    if (currentMonoVoice.osc1Note && startFreq !== null) {
                        let newOscFreqParam = null;
                        let newOscDetuneParam = null; // <<< ADDED
                        if (currentMonoVoice.osc1Note.toneOscillator) {
                            newOscFreqParam = currentMonoVoice.osc1Note.toneOscillator.frequency;
                            newOscDetuneParam = currentMonoVoice.osc1Note.toneOscillator.detune; // <<< ADDED
                        } else if (currentMonoVoice.osc1Note.oscillator) {
                            newOscFreqParam = currentMonoVoice.osc1Note.oscillator.frequency;
                            newOscDetuneParam = currentMonoVoice.osc1Note.oscillator.detune; // <<< ADDED
                        }

                        if (newOscFreqParam) {
                            console.log(`Mono Multi Osc1 Glide: Freq from ${startFreq.toFixed(2)} to ${targetFreq.toFixed(2)}`);
                            newOscFreqParam.setValueAtTime(startFreq, now);
                            newOscFreqParam.linearRampToValueAtTime(targetFreq, now + glideTime);
                            // Update detune on new oscillator smoothly <<< ADDED
                            if (newOscDetuneParam) {
                                newOscDetuneParam.setTargetAtTime(osc1Detune, now, 0.01); // Target global detune
                            }
                        } else { console.error("Mono Multi Glide Error: New oscillator frequency parameter missing!"); }
                    }
                }

                // Fade out the PREVIOUS voice components (use stored references)
                console.log("Mono Multi-Trigger: Fading out previous components.");
                if (prevSamplerNote) quickFadeOutSampler(prevSamplerNote, 0.015);
                if (prevOsc1Note) quickFadeOutOsc1(prevOsc1Note, 0.015);
            }

        } else {
            // --- Mono First Note (No Existing Voice) ---
            // This path is now correctly entered after releasing all keys in legato mode
            console.log(`Mono NoteOn: Starting new voice for Note ${noteNumber}.`);
            // Create NEW voice entry
            currentMonoVoice = { samplerNote: null, osc1Note: null, startTime: now, noteNumber: noteNumber };
            activeVoices[noteNumber] = currentMonoVoice;

            // Start new components (triggers envelope)
            currentMonoVoice.samplerNote = startSamplerNote(noteNumber, audioCtx, masterGain, audioBuffer);
            currentMonoVoice.osc1Note = startOsc1Note(noteNumber, audioCtx, masterGain);
            // ...

            // Apply initial portamento glide if needed
            if (isPortamentoOn && glideTime > 0.001) {
                // Use last *actual* pitch if available, otherwise fall back to last note number target
                let glideStartRate = lastActualSamplerRate;
                let glideStartFreq = lastActualOsc1Freq;

                if (glideStartRate === null && lastPlayedNoteNumber !== null) {
                    glideStartRate = TR2 ** (lastPlayedNoteNumber - 12);
                }
                if (glideStartFreq === null && lastPlayedNoteNumber !== null) {
                    glideStartFreq = noteToFrequency(lastPlayedNoteNumber, osc1OctaveOffset);
                }

                if (glideStartRate !== null || glideStartFreq !== null) {
                    console.log(`Applying MONO initial portamento glide (First Note): ${glideTime.toFixed(3)}s from last actual pitch to ${noteNumber}`);
                    const targetRate = TR2 ** (noteNumber - 12);
                    const targetFreq = noteToFrequency(noteNumber, osc1OctaveOffset);

                    // Sampler Glide (to NEW samplerNote)
                    if (currentMonoVoice.samplerNote?.source && glideStartRate !== null) {
                        console.log(`Mono First Sampler Glide: Rate from ${glideStartRate.toFixed(4)} to ${targetRate.toFixed(4)}`);
                        currentMonoVoice.samplerNote.source.playbackRate.setValueAtTime(glideStartRate, now);
                        currentMonoVoice.samplerNote.source.playbackRate.linearRampToValueAtTime(targetRate, now + glideTime);
                    }

                    // Osc1 Glide (to NEW osc1Note - check Tone or Native)
                    if (currentMonoVoice.osc1Note && glideStartFreq !== null) {
                        let newOscFreqParam = null;
                        let newOscDetuneParam = null; // <<< ADDED
                        if (currentMonoVoice.osc1Note.toneOscillator) {
                            newOscFreqParam = currentMonoVoice.osc1Note.toneOscillator.frequency;
                            newOscDetuneParam = currentMonoVoice.osc1Note.toneOscillator.detune; // <<< ADDED
                        } else if (currentMonoVoice.osc1Note.oscillator) {
                            newOscFreqParam = currentMonoVoice.osc1Note.oscillator.frequency;
                            newOscDetuneParam = currentMonoVoice.osc1Note.oscillator.detune; // <<< ADDED
                        }

                        if (newOscFreqParam) {
                            console.log(`Mono First Osc1 Glide: Freq from ${glideStartFreq.toFixed(2)} to ${targetFreq.toFixed(2)}`);
                            newOscFreqParam.setValueAtTime(glideStartFreq, now);
                            newOscFreqParam.linearRampToValueAtTime(targetFreq, now + glideTime);
                            // Update detune on new oscillator smoothly <<< ADDED
                            if (newOscDetuneParam) {
                                newOscDetuneParam.setTargetAtTime(osc1Detune, now, 0.01); // Target global detune
                            }
                        } else { console.error("Mono First Glide Error: New oscillator frequency parameter missing!"); }
                    }
                }
           }
           // Reset last actual pitch now that a new note has started
           lastActualSamplerRate = null;
           lastActualOsc1Freq = null;
       }
    } else {
        // --- POLY ---
        // Voice Stealing (remains the same)
        const playingVoiceNumbers = Object.keys(activeVoices).filter(num =>
            activeVoices[num] && (
                (activeVoices[num].samplerNote && activeVoices[num].samplerNote.state === 'playing') ||
                (activeVoices[num].osc1Note && activeVoices[num].osc1Note.state === 'playing')
            )
        );
        while (playingVoiceNumbers.length >= MAX_POLYPHONY) {
            // ... (voice stealing logic remains the same) ...
             let oldestNoteNumber = -1;
             let oldestStartTime = Infinity;
             playingVoiceNumbers.forEach(num => {
                 if (activeVoices[num] && activeVoices[num].startTime < oldestStartTime) {
                     oldestStartTime = activeVoices[num].startTime;
                     oldestNoteNumber = num;
                 }
             });
             if (oldestNoteNumber !== -1) {
                 console.log(`Voice stealing: Removing oldest voice (Note ${oldestNoteNumber})`);
                 const voiceToSteal = activeVoices[oldestNoteNumber];
                 if (voiceToSteal.samplerNote) quickFadeOutSampler(voiceToSteal.samplerNote, 0.015);
                 if (voiceToSteal.osc1Note) quickFadeOutOsc1(voiceToSteal.osc1Note, 0.015);
                 // kill functions will handle removal from activeVoices
                 playingVoiceNumbers.splice(playingVoiceNumbers.indexOf(oldestNoteNumber.toString()), 1);
             } else { break; }
        }

        let targetVoice = activeVoices[noteNumber];
        let isNewVoice = !targetVoice;

        if (isNewVoice) {
            // --- Poly New Note ---
            console.log(`Poly NoteOn: Creating new voice for Note ${noteNumber}.`);
            targetVoice = { samplerNote: null, osc1Note: null, startTime: now, noteNumber: noteNumber };
            activeVoices[noteNumber] = targetVoice;
            // Start Components
            targetVoice.samplerNote = startSamplerNote(noteNumber, audioCtx, masterGain, audioBuffer);
            targetVoice.osc1Note = startOsc1Note(noteNumber, audioCtx, masterGain);
        } else {
            // --- Poly Retrigger ---
            console.log(`Poly NoteOn: Retriggering voice for Note ${noteNumber}.`);
            const oldSamplerNote = targetVoice.samplerNote;
            const oldOsc1Note = targetVoice.osc1Note;

            // Start NEW components immediately
            targetVoice.samplerNote = startSamplerNote(noteNumber, audioCtx, masterGain, audioBuffer);
            targetVoice.osc1Note = startOsc1Note(noteNumber, audioCtx, masterGain);
            targetVoice.startTime = now; // Update start time

            // Delayed Fade Out of OLD components
            setTimeout(() => {
                if (oldSamplerNote) quickFadeOutSampler(oldSamplerNote, 0.015);
                if (oldOsc1Note) quickFadeOutOsc1(oldOsc1Note, 0.015);
            }, 0);
        }

        // --- Apply Poly Portamento Glide (to the new/retriggered components in targetVoice) ---
        if (isPortamentoOn && lastPlayedNoteNumber !== null && glideTime > 0.001) {
            console.log(`Applying POLY portamento glide: ${glideTime.toFixed(3)}s from ${lastPlayedNoteNumber} to ${noteNumber}`);
            const startFreq = noteToFrequency(lastPlayedNoteNumber, osc1OctaveOffset);
            const targetFreq = noteToFrequency(noteNumber, osc1OctaveOffset);

           // Sampler Glide (remains the same)
           if (targetVoice.samplerNote?.source) {
               const startRate = TR2 ** (lastPlayedNoteNumber - 12);
               const targetRate = TR2 ** (noteNumber - 12);
               console.log(`Poly Sampler Glide: Rate from ${startRate.toFixed(4)} to ${targetRate.toFixed(4)}`);
               targetVoice.samplerNote.source.playbackRate.setValueAtTime(startRate, now);
               targetVoice.samplerNote.source.playbackRate.linearRampToValueAtTime(targetRate, now + glideTime);
           } else { console.log("Poly Glide: No sampler source to glide."); }

           // --- CORRECTED Osc1 Glide ---
           if (targetVoice.osc1Note) {
               let oscFreqParam = null;
               let oscDetuneParam = null;
               if (targetVoice.osc1Note.toneOscillator) { // <<< Check Tone first
                   oscFreqParam = targetVoice.osc1Note.toneOscillator.frequency;
                   oscDetuneParam = targetVoice.osc1Note.toneOscillator.detune;
               } else if (targetVoice.osc1Note.oscillator) { // <<< Fallback to native
                   oscFreqParam = targetVoice.osc1Note.oscillator.frequency;
                   oscDetuneParam = targetVoice.osc1Note.oscillator.detune;
               }

               if (oscFreqParam) {
                   console.log(`Poly Osc1 Glide: Freq from ${startFreq.toFixed(2)} to ${targetFreq.toFixed(2)}`);
                   oscFreqParam.cancelScheduledValues(now); // Cancel previous ramps
                   oscFreqParam.setValueAtTime(startFreq, now);
                   oscFreqParam.linearRampToValueAtTime(targetFreq, now + glideTime);
                   if (oscDetuneParam) { // Update detune smoothly
                       oscDetuneParam.setTargetAtTime(osc1Detune, now, 0.01);
                   }
               } else { console.log("Poly Glide: No valid oscillator frequency parameter found."); }
           } else { console.log("Poly Glide: No oscillator note found to glide."); }
           // --- END CORRECTED Osc1 Glide ---

       } else if (isPortamentoOn) {
            console.log(`Poly Portamento: Skipping glide for note ${noteNumber} (no previous note or zero glide time).`);
       }
       // If portamento is off or no last note, the components start at the correct pitch already.
   }

   lastPlayedNoteNumber = noteNumber; // Update last played note for portamento/mono
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
            console.log(`Mono NoteOff: Other notes held [${heldNotes.join(',')}]. Returning to ${lastHeldNoteNumber}. Legato: ${isLegatoMode}`);

            if (!isLegatoMode) { // --- Multi-trigger: Retrigger last held note, glide pitch down ---
                console.log("Mono NoteOff (Multi): Retriggering and gliding down.");
                const prevVoice = currentMonoVoice; // Voice being released
                const prevNoteNumber = prevVoice.noteNumber; // Note being released (noteNumber)

                // --- Get current pitch of the NOTE BEING RELEASED ---
                let startRate = null;
                let startFreq = null;
                if (isPortamentoOn && glideTime > 0.001) {
                    if (prevVoice?.samplerNote?.source) { /* ... */ }
                    // Check previous osc1 note (Tone or Native)
                    if (prevVoice?.osc1Note) { // <<< Check if osc1Note exists on prevVoice
                        if (prevVoice.osc1Note.toneOscillator) {
                             try { startFreq = prevVoice.osc1Note.toneOscillator.frequency.value; } catch(e) { console.warn("Couldn't get prev Tone osc freq (noteOff)"); }
                        } else if (prevVoice.osc1Note.oscillator) {
                             try { startFreq = prevVoice.osc1Note.oscillator.frequency.value; } catch(e) { console.warn("Couldn't get prev native osc freq (noteOff)"); }
                        }
                    }
                    // Fallback to target pitch if actual value couldn't be read
                    if (startRate === null && prevNoteNumber !== null) startRate = TR2 ** (prevNoteNumber - 12);
                    if (startFreq === null && prevNoteNumber !== null) startFreq = noteToFrequency(prevNoteNumber, osc1OctaveOffset);
                    console.log(`Mono NoteOff (Multi): Captured glide start pitch - Rate: ${startRate?.toFixed(4)}, Freq: ${startFreq?.toFixed(2)}`);
                }
                // --- End Get current pitch ---

                // --- Start NEW voice components for the note being returned to (lastHeldNoteNumber) ---
                // This ensures the envelope re-triggers correctly.
                console.log(`Mono NoteOff (Multi): Starting new components for Note ${lastHeldNoteNumber}.`);
                currentMonoVoice = { samplerNote: null, osc1Note: null, startTime: now, noteNumber: lastHeldNoteNumber };
                activeVoices[lastHeldNoteNumber] = currentMonoVoice; // Add/update entry for the held note

                currentMonoVoice.samplerNote = startSamplerNote(lastHeldNoteNumber, audioCtx, masterGain, audioBuffer);
                currentMonoVoice.osc1Note = startOsc1Note(lastHeldNoteNumber, audioCtx, masterGain);

                // --- Apply glide FROM the released note's pitch TO the held note's pitch (on NEW components) ---
                if (isPortamentoOn && glideTime > 0.001 && (startRate !== null || startFreq !== null)) {
                    console.log(`Applying MONO multi-trigger glide (noteOff): ${glideTime.toFixed(3)}s from actual pitch of ${prevNoteNumber} down to ${lastHeldNoteNumber}`);
                    const targetRate = TR2 ** (lastHeldNoteNumber - 12);
                    const targetFreq = noteToFrequency(lastHeldNoteNumber, osc1OctaveOffset);
                   // Sampler Glide (to NEW samplerNote)
                   if (currentMonoVoice.samplerNote?.source && startRate !== null) { /* ... */ }
                   // Osc1 Glide (to NEW osc1Note - check Tone or Native)
                   if (currentMonoVoice.osc1Note && startFreq !== null) {
                    let newOscFreqParam = null;
                    let newOscDetuneParam = null; // <<< ADDED
                    if (currentMonoVoice.osc1Note.toneOscillator) {
                        newOscFreqParam = currentMonoVoice.osc1Note.toneOscillator.frequency;
                        newOscDetuneParam = currentMonoVoice.osc1Note.toneOscillator.detune; // <<< ADDED
                    } else if (currentMonoVoice.osc1Note.oscillator) {
                        newOscFreqParam = currentMonoVoice.osc1Note.oscillator.frequency;
                        newOscDetuneParam = currentMonoVoice.osc1Note.oscillator.detune; // <<< ADDED
                    }
                    if (newOscFreqParam) {
                        console.log(`Mono Multi Osc1 Glide (noteOff): Freq from ${startFreq.toFixed(2)} to ${targetFreq.toFixed(2)}`);
                        newOscFreqParam.setValueAtTime(startFreq, now);
                        newOscFreqParam.linearRampToValueAtTime(targetFreq, now + glideTime);
                        // Update detune if needed <<< ADDED
                        if (newOscDetuneParam) {
                            newOscDetuneParam.setTargetAtTime(osc1Detune, now, 0.01); // Target global detune
                        }
                    } else { console.error("Mono Multi Glide Error (noteOff): New oscillator frequency parameter missing!"); }
                }
               } else {
                     // If portamento is off, the new components started at the correct pitch already.
                     console.log(`Mono NoteOff (Multi): Portamento off or zero glide. New components started at target pitch ${lastHeldNoteNumber}.`);
                }

                // --- Fade out the components of the note that was just released ---
                console.log(`Mono NoteOff (Multi): Fading out previous components for Note ${prevNoteNumber}.`);
                if (prevVoice) {
                    // Make sure we don't fade out the components we just created if prevNoteNumber === lastHeldNoteNumber (unlikely but possible)
                    if (prevVoice.samplerNote && prevVoice.samplerNote !== currentMonoVoice.samplerNote) {
                         quickFadeOutSampler(prevVoice.samplerNote, 0.015);
                    }
                    if (prevVoice.osc1Note && prevVoice.osc1Note !== currentMonoVoice.osc1Note) {
                         quickFadeOutOsc1(prevVoice.osc1Note, 0.015);
                    }
                }
                // Remove the old activeVoices entry if it wasn't overwritten
                if (activeVoices[prevNoteNumber] === prevVoice) {
                     // Let kill functions handle deletion after fade out
                }

            } else { // --- Legato mode: Glide pitch back to the last held note (NO retrigger) ---
                console.log(`Mono NoteOff (Legato): Gliding pitch back to ${lastHeldNoteNumber}.`);
                const voiceToUpdate = currentMonoVoice; // Use existing voice
                const releasedNoteNumber = voiceToUpdate.noteNumber; // The note being released (noteNumber)

                // Update voice state
                voiceToUpdate.noteNumber = lastHeldNoteNumber;
                // Update activeVoices mapping
                activeVoices[lastHeldNoteNumber] = voiceToUpdate;
                if (releasedNoteNumber !== lastHeldNoteNumber) { // Avoid deleting if returning to the same note (shouldn't happen with heldNotes logic)
                    delete activeVoices[releasedNoteNumber];
                }
                console.log(`Mono NoteOff (Legato): Updated activeVoices map. Key ${releasedNoteNumber} deleted, Key ${lastHeldNoteNumber} points to voice.`);

                // --- Glide pitch FROM current pitch DOWN TO the held note's pitch ---
                const glideDuration = Math.max(glideTime, 0.001);
                console.log(`Applying MONO Legato glide (noteOff): ${glideDuration.toFixed(3)}s`);
                const targetRate = TR2 ** (lastHeldNoteNumber - 12);
                const targetFreq = noteToFrequency(lastHeldNoteNumber, osc1OctaveOffset);

                // Sampler Glide (from current rate) - remains the same
                if (voiceToUpdate.samplerNote?.source) {
                    // ... (existing sampler glide logic) ...
                } else { console.log("Mono NoteOff (Legato): No sampler source to glide."); }

                // --- CORRECTED Osc1 Glide (from current freq) ---
                if (voiceToUpdate.osc1Note) {
                    let oscFreqParam = null;
                    let oscDetuneParam = null;
                    let currentFreq = NaN;

                    if (voiceToUpdate.osc1Note.toneOscillator) { // <<< Check Tone first
                        oscFreqParam = voiceToUpdate.osc1Note.toneOscillator.frequency;
                        oscDetuneParam = voiceToUpdate.osc1Note.toneOscillator.detune;
                        try { currentFreq = oscFreqParam.value; } catch(e) { console.warn("Couldn't get current Tone freq (noteOff Legato)"); }
                    } else if (voiceToUpdate.osc1Note.oscillator) { // <<< Fallback to native
                        oscFreqParam = voiceToUpdate.osc1Note.oscillator.frequency;
                        oscDetuneParam = voiceToUpdate.osc1Note.oscillator.detune;
                        try { currentFreq = oscFreqParam.value; } catch(e) { console.warn("Couldn't get current native freq (noteOff Legato)"); }
                    }

                    if (oscFreqParam && !isNaN(currentFreq)) {
                        try {
                            oscFreqParam.cancelScheduledValues(now);
                            console.log(`Mono NoteOff (Legato) Osc1 Glide PRE-RAMP: Now=${now.toFixed(3)}, CurrentFreq=${currentFreq.toFixed(2)}, TargetFreq=${targetFreq.toFixed(2)}, Duration=${glideDuration.toFixed(3)}`);
                            oscFreqParam.setValueAtTime(currentFreq, now);
                            oscFreqParam.linearRampToValueAtTime(targetFreq, now + glideDuration);
                            console.log(`Mono NoteOff (Legato) Osc1 Glide RAMP SCHEDULED: ${currentFreq.toFixed(2)} -> ${targetFreq.toFixed(2)}`);
                            if (oscDetuneParam) { // Update detune smoothly
                                oscDetuneParam.setTargetAtTime(osc1Detune, now, 0.01);
                            }
                            voiceToUpdate.osc1Note.noteNumber = lastHeldNoteNumber; // Update internal note number
                        } catch (e) {
                            console.error(`Mono NoteOff (Legato) Osc1 Glide ERROR: ${e}. CurrentFreq was ${currentFreq}`);
                        }
                    } else {
                         console.error("Mono NoteOff (Legato) Glide Error: Oscillator frequency parameter missing or invalid current frequency!");
                    }
                } else { console.log("Mono NoteOff (Legato): No oscillator note to glide."); }
                // --- END CORRECTED Osc1 Glide ---
            }

            // Update last played note for subsequent portamento calculations
            lastPlayedNoteNumber = lastHeldNoteNumber;

        } else { // --- No notes left held ---
            console.log(`Mono NoteOff: No other notes held. Releasing current mono voice (Note ${noteNumber}).`);
            const voiceToRelease = currentMonoVoice;

            // --- Store last actual pitch BEFORE nullifying/releasing ---
            if (voiceToRelease?.samplerNote?.source) {
                 try { lastActualSamplerRate = voiceToRelease.samplerNote.source.playbackRate.value; } catch(e) {}
            } else { lastActualSamplerRate = null; }
            if (voiceToRelease?.osc1Note?.oscillator) {
                 try { lastActualOsc1Freq = voiceToRelease.osc1Note.oscillator.frequency.value; } catch(e) {}
            } else { lastActualOsc1Freq = null; }
            console.log(`Mono NoteOff: Stored last actual pitch - Rate: ${lastActualSamplerRate?.toFixed(4)}, Freq: ${lastActualOsc1Freq?.toFixed(2)}`);
            // --- End store last actual pitch ---

            currentMonoVoice = null; // Nullify immediately
            console.log(`Mono NoteOff: currentMonoVoice set to null.`);

            if (voiceToRelease) {
                 if (voiceToRelease.samplerNote) releaseSamplerNote(voiceToRelease.samplerNote);
                 if (voiceToRelease.osc1Note) releaseOsc1Note(voiceToRelease.osc1Note);
            } else {
                 console.warn(`Mono NoteOff: voiceToRelease was unexpectedly null when releasing last key for note ${noteNumber}.`);
                 // Clear stored pitch if we couldn't get it
                 lastActualSamplerRate = null;
                 lastActualOsc1Freq = null;
            }
            // lastPlayedNoteNumber remains from the note that was just released
        }

    } else {
        // --- Poly Mode Logic ---
        const voice = activeVoices[noteNumber];
        if (voice) {
             console.log(`Poly NoteOff: Found voice for note ${noteNumber}. Releasing components.`);
            // Release components if they are currently playing
            if (voice.samplerNote && (voice.samplerNote.state === 'playing' || voice.samplerNote.state === 'fadingOut')) {
                 console.log(`Poly NoteOff: Calling releaseSamplerNote for ${voice.samplerNote.id}`);
                releaseSamplerNote(voice.samplerNote);
            }
            if (voice.osc1Note && (voice.osc1Note.state === 'playing' || voice.osc1Note.state === 'fadingOut')) {
                 console.log(`Poly NoteOff: Calling releaseOsc1Note for ${voice.osc1Note.id}`);
                releaseOsc1Note(voice.osc1Note);
            }
            // The kill functions scheduled by release will handle nullifying references
            // and deleting the activeVoices entry when appropriate.
        } else {
             // This happens in the retrigger case because the kill function deleted the entry too early.
             // The refined kill functions should prevent this.
             console.log(`Poly NoteOff: No active voice found for noteNumber ${noteNumber}. (This might be okay if note was stolen or rapidly retriggered and cleaned up).`);
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
}, 10); // Timeout for the whole processing chain
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
            if (voice && voice.osc1Note) { // Check if osc1Note exists
                const targetFreq = noteToFrequency(voice.osc1Note.noteNumber, osc1OctaveOffset); // Calculate target freq with new offset
                let freqParam = null;

                // --- Find the correct frequency parameter ---
                if (voice.osc1Note.toneOscillator) {
                    freqParam = voice.osc1Note.toneOscillator.frequency;
                    console.log(`Updating Tone Osc note ${voice.osc1Note.id} frequency to ${targetFreq.toFixed(2)} Hz`);
                } else if (voice.osc1Note.oscillator) {
                    freqParam = voice.osc1Note.oscillator.frequency;
                    console.log(`Updating Native Osc note ${voice.osc1Note.id} frequency to ${targetFreq.toFixed(2)} Hz`);
                }
                // --- End Find parameter ---

                // --- Apply smooth update ---
                if (freqParam) {
                    // Use setTargetAtTime for a slightly smoother transition than immediate jump
                    freqParam.setTargetAtTime(targetFreq, now, 0.01); // Short time constant (10ms)
                } else {
                    console.warn(`Could not find frequency parameter for Osc1 note ${voice.osc1Note.id}`);
                }
                // --- End Apply update ---
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
// Initialize Oscillator 1 Wave Shape Selector
const osc1WaveSelector = D('osc1-wave-selector');
if (osc1WaveSelector) {
    osc1WaveSelector.addEventListener('input', (event) => {
        const sliderValue = parseInt(event.target.value, 10); // Value is 0-4
        const prevWaveform = osc1Waveform;

        const waveMap = ['sine', 'sawtooth', 'triangle', 'square', 'pulse'];
        const selectedWave = waveMap[sliderValue] || 'triangle';

        if (selectedWave === prevWaveform) return; // No change

        osc1Waveform = selectedWave; // Update global state
        console.log(`Osc1 Wave Selector value: ${sliderValue}, Waveform changed from ${prevWaveform} to: ${osc1Waveform}`);

        // --- Update Active Notes (Complex: Replace Oscillator Structure) ---
        const now = audioCtx.currentTime;
        Object.values(activeVoices).forEach(voice => {
            // Only update notes that are currently playing
            if (voice && voice.osc1Note && voice.osc1Note.state === 'playing') {
                const oscNote = voice.osc1Note;
                console.log(`Updating active Osc1 note ${oscNote.id} from ${prevWaveform} to ${osc1Waveform}`);

                try {
                    // --- Get current state ---
                    const currentGain = oscNote.gainNode.gain.value; // ADSR gain
                    const currentLevel = oscNote.levelNode.gain.value; // Level gain
                    let currentFreq = NaN;
                    let currentDetune = NaN;

                    if (oscNote.toneOscillator) {
                        currentFreq = oscNote.toneOscillator.frequency.value;
                        currentDetune = oscNote.toneOscillator.detune.value;
                    } else if (oscNote.oscillator) {
                        currentFreq = oscNote.oscillator.frequency.value;
                        currentDetune = oscNote.oscillator.detune.value;
                    } else {
                         throw new Error("Active note has no oscillator reference.");
                    }

                    // --- Stop and disconnect old structure ---
                    oscNote.gainNode.gain.cancelScheduledValues(now);
                    oscNote.gainNode.gain.setValueAtTime(0, now); // Silence briefly

                    if (oscNote.toneOscillator) {
                        oscNote.toneOscillator.disconnect(oscNote.levelNode); // <<< Disconnect from levelNode
                        oscNote.toneOscillator.dispose();
                        oscNote.toneOscillator = null;
                    } else if (oscNote.oscillator) {
                        oscNote.oscillator.disconnect(oscNote.levelNode); // <<< Disconnect from levelNode
                        try { oscNote.oscillator.stop(now); } catch(e){}
                        oscNote.oscillator = null;
                    }

                    // --- Create and connect new structure ---
                    let newNativeOscillator = null;
                    let newToneOscillator = null;
                    const targetFreq = noteToFrequency(oscNote.noteNumber, osc1OctaveOffset);

                    if (osc1Waveform === 'pulse') {
                        newToneOscillator = new Tone.PulseOscillator(targetFreq, 0.25);
                        newToneOscillator.detune.value = currentDetune;
                        newToneOscillator.connect(oscNote.levelNode); // <<< Connect to existing levelNode
                        newToneOscillator.start(now);
                        // Glide from previous frequency if needed (Portamento logic)
                        if (isPortamentoOn && glideTime > 0.001 && !isNaN(currentFreq)) {
                             newToneOscillator.frequency.setValueAtTime(currentFreq, now);
                             newToneOscillator.frequency.linearRampToValueAtTime(targetFreq, now + glideTime);
                        }
                    } else {
                        newNativeOscillator = audioCtx.createOscillator();
                        newNativeOscillator.type = osc1Waveform;
                        newNativeOscillator.frequency.setValueAtTime(targetFreq, now);
                        newNativeOscillator.detune.setValueAtTime(currentDetune, now);
                        newNativeOscillator.connect(oscNote.levelNode); // <<< Connect to existing levelNode
                        newNativeOscillator.start(now);
                         // Glide from previous frequency if needed (Portamento logic)
                        if (isPortamentoOn && glideTime > 0.001 && !isNaN(currentFreq)) {
                             newNativeOscillator.frequency.setValueAtTime(currentFreq, now);
                             newNativeOscillator.frequency.linearRampToValueAtTime(targetFreq, now + glideTime);
                        }
                    }

                    // Update note object
                    oscNote.oscillator = newNativeOscillator;
                    oscNote.toneOscillator = newToneOscillator;

                    // No need to restore gain, levelNode and gainNode were untouched

                    console.log(`Successfully updated active Osc1 note ${oscNote.id} to ${osc1Waveform}`);

                } catch (e) {
                    console.error(`Error updating active Osc1 note ${oscNote.id} waveform:`, e);
                    killOsc1Note(oscNote); // Attempt to kill the note if update fails badly
                }
            }
        });
    });

    // Set initial waveform based on default slider value
    const initialWaveValue = parseInt(osc1WaveSelector.value, 10);
    const initialWaveMap = ['sine', 'sawtooth', 'triangle', 'square', 'pulse'];
    osc1Waveform = initialWaveMap[initialWaveValue] || 'triangle';
    console.log(`Osc1 Wave initial waveform: ${osc1Waveform}`);

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

// Initialize the Key-Track button (default: active)
const keyTrackButton = document.getElementById('keytrack-button');

if (keyTrackButton) {
// Set initial state
keyTrackButton.classList.add('active'); // Key tracking is on by default

// Add click handler
keyTrackButton.addEventListener('click', function() {
this.classList.toggle('active');
isSampleKeyTrackingOn = this.classList.contains('active');
console.log('Sample Key Tracking:', isSampleKeyTrackingOn ? 'ON' : 'OFF');
});
}
});