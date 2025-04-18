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

let isMonoMode = false;
let isLegatoMode = false;
let isPortamentoOn = false;
let glideTime = 0.1; // seconds
let heldNotes = []; // Keep track of held notes in mono mode
let currentNote = null; // Currently sounding note in mono mode
let lastPlayedNote = null;
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
// All other knobs default to 0.5
};

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
function unlockAudioForChromeIOS() {
console.log("Attempting to unlock audio for Chrome on iOS");

// 1. First, try to play the HTML5 audio element
const playPromise = audioElement.play();

if (playPromise !== undefined) {
playPromise.then(() => {
console.log("Audio element playback successful");

// 2. After successful audio element play, resume AudioContext
if (audioCtx.state === 'suspended') {
  audioCtx.resume().then(() => {
    console.log("AudioContext resumed");
  }).catch(err => {
    console.error("Failed to resume AudioContext:", err);
  });
}

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

}).catch(err => {
console.error("Audio playback failed:", err);
// Show a more direct error message to the user
alert("Audio couldn't be enabled. Please reload and try again, making sure to tap directly on the button.");
});
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
  Object.values(activeNotes).forEach(note => {
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
// Update all active notes' sample gain
Object.values(activeNotes).forEach(note => {
    if (note && note.sampleNode) {
        note.sampleNode.gain.value = currentSampleGain;
    }
});
console.log('Sample Gain:', value.toFixed(2));
},
// ... existing knobs ...
'sample-pitch-knob': (value) => {
// Convert 0-1 range to -1200 to +1200 cents
currentSampleDetune = (value * 2400) - 1200;

// Show and update tooltip
const tooltip = document.getElementById('pitch-tooltip') || createTooltip();
tooltip.textContent = `${currentSampleDetune.toFixed(0)} cents`;
tooltip.style.opacity = '1';

// Update all active notes' sample pitch
Object.values(activeNotes).forEach(note => {
if (note && note.source) {
    note.source.detune.setValueAtTime(currentSampleDetune, audioCtx.currentTime);
}
});

console.log('Sample Pitch:', currentSampleDetune.toFixed(0) + ' cents');
},

// Add these new knob initializations in the knobInitializations object
'sample-start-knob': (value) => {
// Ensure start position is always less than end position
const maxStart = Math.min(value, sampleEndPosition - 0.01);
sampleStartPosition = maxStart;

// Update processing with new start position
updateSampleProcessing();

const tooltip = createTooltipForKnob('sample-start-knob', value);
tooltip.textContent = `Start: ${(sampleStartPosition * 100).toFixed(0)}%`;
tooltip.style.opacity = '1';

console.log('Sample Start:', (sampleStartPosition * 100).toFixed(0) + '%');

// Instead of direct creation, ensure we wait for updateSampleProcessing to finish
if (startUpdateTimer) { clearTimeout(startUpdateTimer); }
startUpdateTimer = setTimeout(() => {
if (audioBuffer && sampleCrossfadeAmount > 0.01 && isSampleLoopOn) {
    console.log("Creating new crossfaded buffer after start position settled");
    // Use the processed buffer that includes fades
    const result = createCrossfadedBuffer(
      audioCtx, // Use the global audioCtx
        fadedBuffer || audioBuffer, 
        0,   // Use entire processed buffer 
        1,   // Use entire processed buffer
        sampleCrossfadeAmount
    );
    
    if (result && result.buffer) {
        cachedCrossfadedBuffer = result.buffer;
        lastCachedStartPos = sampleStartPosition;
        lastCachedEndPos = sampleEndPosition;
        lastCachedCrossfade = sampleCrossfadeAmount;
    }
}

// Update any active notes
Object.values(activeNotes).forEach(note => {
    if (note && note.source) {
        // Skip update if note is held
        if (heldNotes.includes(note.noteNumber)) {
            console.log(`Note ${note.id} is held; skipping start update.`);
            return;
        }
        
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
startUpdateTimer = null;
}, 150);  // Longer delay to ensure processing completes
},

'sample-end-knob': (value) => {
// Ensure end position is always greater than start position
const minEnd = Math.max(value, sampleStartPosition + 0.01);
sampleEndPosition = minEnd;

// Add this line to process fades when end position changes
updateSampleProcessing();

const tooltip = createTooltipForKnob('sample-end-knob', value);
tooltip.textContent = `End: ${(sampleEndPosition * 100).toFixed(0)}%`;
tooltip.style.opacity = '1';

console.log('Sample End:', (sampleEndPosition * 100).toFixed(0) + '%');

// Instead of direct creation, ensure we wait for updateSampleProcessing to finish
if (endUpdateTimer) { clearTimeout(endUpdateTimer); }
endUpdateTimer = setTimeout(() => {
if (audioBuffer && sampleCrossfadeAmount > 0.01 && isSampleLoopOn) {
    console.log("Creating new crossfaded buffer after end position settled");
    // Use the processed buffer that includes fades
    const result = createCrossfadedBuffer(
      audioCtx, // Use the global audioCtx
        fadedBuffer || audioBuffer, 
        0,   // Use entire processed buffer 
        1,   // Use entire processed buffer
        sampleCrossfadeAmount
    );
    
    if (result && result.buffer) {
        cachedCrossfadedBuffer = result.buffer;
        lastCachedStartPos = sampleStartPosition;
        lastCachedEndPos = sampleEndPosition;
        lastCachedCrossfade = sampleCrossfadeAmount;
    }
}

// Update any active notes
Object.values(activeNotes).forEach(note => {
    if (note && note.source) {
        // Skip update if note is held
        if (heldNotes.includes(note.noteNumber)) {
            console.log(`Note ${note.id} is held; skipping end update.`);
            return;
        }
        
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
endUpdateTimer = null;
}, 150);  // Longer delay to ensure processing completes
},
'sample-crossfade-knob': (value) => {
const tooltip = createTooltipForKnob('sample-crossfade-knob', value);
tooltip.textContent = `Crossfade: ${(value * 100).toFixed(0)}%`;
tooltip.style.opacity = '1';

// Store previous values
const prevCrossfade = sampleCrossfadeAmount;
const prevLoopState = isSampleLoopOn;

// Update values
sampleCrossfadeAmount = value;
isSampleLoopOn = value > 0.01;

// If enabling crossfade, clear any existing fades
if (value > 0.01) {
// Reset fade values when enabling crossfade
sampleFadeInAmount = 0;
sampleFadeOutAmount = 0;

// Update the fade knob position to center (no fade)
const fadeKnob = D('sample-fade-knob');
if (fadeKnob) {
    const control = initializeKnob(fadeKnob, knobInitializations['sample-fade-knob'], knobDefaults);
    control.setValue(0.5);
}
}

// CRITICAL FIX: When crossfade amount changes significantly, recalculate zero-crossing alignment
if (Math.abs(prevCrossfade - value) > 0.02 || prevLoopState !== isSampleLoopOn) {
console.log("Crossfade changed significantly - recalculating zero crossings");

if (audioBuffer) {
    // Similar to what happens in updateSampleProcessing but just for zero crossing
    const totalSamples = audioBuffer.length;
    const rawStartSample = Math.floor(sampleStartPosition * totalSamples);
    const rawEndSample = Math.floor(sampleEndPosition * totalSamples);
    
    // Find zero-crossings near the start and end points
    const alignedPoints = findBestZeroCrossings(
        audioBuffer, 
        rawStartSample, 
        rawEndSample
    );
    
    // Update the start and end positions with aligned zero crossings
    sampleStartPosition = alignedPoints.start / totalSamples;
    sampleEndPosition = alignedPoints.end / totalSamples;
    
    console.log(`Zero-crossings recalculated: start=${sampleStartPosition.toFixed(4)}, end=${sampleEndPosition.toFixed(4)}`);
    
    // // Update knob positions to reflect new values
    // const startKnob = D('sample-start-knob');
    // const endKnob = D('sample-end-knob');
    
    // if (startKnob) {
    //     const control = initializeKnob(startKnob, knobInitializations['sample-start-knob']);
    //     control.setValue(sampleStartPosition);
    // }
    
    // if (endKnob) {
    //     const control = initializeKnob(endKnob, knobInitializations['sample-end-knob']);
    //     control.setValue(sampleEndPosition);
    // }
}
}

// Process with any updated settings
updateSampleProcessing();

// Regular debounced update
if (crossfadeUpdateTimer) { clearTimeout(crossfadeUpdateTimer); }
crossfadeUpdateTimer = setTimeout(() => {
console.log("CROSSFADE UPDATE TIMER FIRED with", Object.keys(activeNotes).length, "active notes");
Object.values(activeNotes).forEach(note => {
    if (note && note.source) {
        console.log(`Processing note ${note.id}, held: ${heldNotes.includes(note.noteNumber)}`);
        // Skip held notes
        if (heldNotes.includes(note.noteNumber)) {
            console.log(`Note ${note.id} is held; skipping crossfade update.`);
            return;
        }
        
        console.log(`Forcing re-processing for note ${note.id}`);
        // Force re-processing - important!
        note.usesProcessedBuffer = false;
        note.crossfadeActive = false;
        
        // This is crucial: first create the crossfaded buffer, then update the note
        if (isSampleLoopOn) {
            note.looping = true; // Force looping flag to true!
            setupLoopCrossfade(note);
        }
        updateSamplePlaybackParameters(note);
    }
});
crossfadeUpdateTimer = null;
}, 100);
},
'sample-fade-knob': (value) => {
// Convert 0-1 range to -0.5 to 0.5 range
const fadeValue = value * 2 - 1;

// Create tooltip
const tooltip = createTooltipForKnob('sample-fade-knob', value);

// If crossfade/loop is on, disable fade functionality completely
if (isSampleLoopOn && sampleCrossfadeAmount > 0.01) {
tooltip.textContent = `Fade (disabled)`;
tooltip.style.opacity = '1';
console.log("Fade knob ignored - crossfade is active");
return; // Exit early - don't process fades when crossfade is active
}

// Different text based on direction
if (fadeValue < 0) {
// Fade out (left side)
const fadeOutPercent = Math.abs(fadeValue * 100).toFixed(0);
tooltip.textContent = `Fade Out: ${fadeOutPercent}%`;
console.log(`Setting fade OUT to ${fadeOutPercent}%`);
} else if (fadeValue > 0) {
// Fade in (right side)
const fadeInPercent = (fadeValue * 100).toFixed(0);
tooltip.textContent = `Fade In: ${fadeInPercent}%`;
console.log(`Setting fade IN to ${fadeInPercent}%`);
} else {
// Center position
tooltip.textContent = `No Fade`;
console.log("Resetting fades to 0");
}
tooltip.style.opacity = '1';

// Store values for processing
sampleFadeInAmount = Math.max(0, fadeValue);
sampleFadeOutAmount = Math.abs(Math.min(0, fadeValue));

console.log(`Fade control values: fadeIn=${sampleFadeInAmount.toFixed(2)}, fadeOut=${sampleFadeOutAmount.toFixed(2)}`);

// Process the fade changes
updateSampleProcessing();
},
'glide-time-knob': (value) => {
const tooltip = createTooltipForKnob('glide-time-knob', value);
tooltip.textContent = `${(value * 2000).toFixed(0)}ms`;
tooltip.style.opacity = '1';
glideTime = value * 2; // 0-2 seconds range
console.log('Glide Time:', (value * 2000).toFixed(0) + 'ms');
},
};
/**
 * Updates existing note playback parameters, aggressively replacing the source node.
 * For crossfaded loops, if not already using the processed buffer,
 * this will create a new note and fade out the old one.
 */
function updateSamplePlaybackParameters(note) {
    if (!note || !audioBuffer || !note.source || !note.gainNode) {
        console.warn(`updateSamplePlaybackParameters: Skipping update for note ${note?.id} due to missing note, buffer, source, or gainNode.`);
        return note;
    }
    // Prevent recursive updates or updates on notes already ending
    if (note.isBeingUpdated || note.state === "releasing" || note.state === "fadingOut" || note.state === "killed") {
         console.log(`updateSamplePlaybackParameters: Skipping update for note ${note.id}, state: ${note.state}, isBeingUpdated: ${note.isBeingUpdated}`);
        return note;
    }

    console.log(`updateSamplePlaybackParameters: Starting update for note ${note.id} (state: ${note.state})`);
    note.isBeingUpdated = true; // Mark as being updated

    // --- Aggressive Cleanup ---
    const oldSource = note.source;
    const oldGainNode = note.gainNode; // Keep reference if needed for fade-out, but we'll create a new one
    const oldSampleNode = note.sampleNode;
    const currentGainValue = oldGainNode.gain.value; // Get current gain before stopping

    console.log(`updateSamplePlaybackParameters [${note.id}]: Stopping and disconnecting old source.`);
    try {
        oldGainNode.gain.cancelScheduledValues(audioCtx.currentTime); // Cancel ramps
        oldGainNode.gain.setValueAtTime(0, audioCtx.currentTime); // Set gain to 0 immediately
        oldSource.stop(0); // Stop playback immediately
        oldSource.disconnect();
        oldSampleNode?.disconnect(); // Disconnect old sample node if exists
        oldGainNode.disconnect();    // Disconnect old gain node
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
        console.log(`updateSamplePlaybackParameters [${note.id}]: Calling createNote to get new source/nodes.`);
        // Use createNote logic, but only extract the new nodes/buffer info
        // We need to determine which buffer createNote *would* use

        let useOriginalBuffer = true;
        let sourceBuffer = audioBuffer; // Default to original buffer
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
             console.error(`updateSamplePlaybackParameters [${note.id}]: Invalid sourceBuffer selected (type: ${bufferType}). Cannot create replacement.`);
             // Attempt to kill the note entirely if we can't replace it
             killNote(note.id);
             return null;
        }
         console.log(`updateSamplePlaybackParameters [${note.id}]: Selected buffer for replacement: ${bufferType}`);

        // Create new nodes
        const newSource = audioCtx.createBufferSource();
        const newGainNode = audioCtx.createGain();
        const newSampleNode = audioCtx.createGain();

        newSource.buffer = sourceBuffer;
        newSampleNode.gain.value = currentSampleGain; // Use global sample gain

        // Apply playback rate / detune (same logic as in createNote)
        let calculatedRate = 1.0;
        if (isSampleKeyTrackingOn) {
            calculatedRate = TR2 ** (note.noteNumber - 12);
            newSource.playbackRate.value = calculatedRate;
            newSource.detune.setValueAtTime(currentSampleDetune, audioCtx.currentTime);
        } else {
            newSource.playbackRate.value = 1.0;
            newSource.detune.value = currentSampleDetune;
        }

        // Connect new nodes
        newSource.connect(newSampleNode);
        newSampleNode.connect(newGainNode);
        newGainNode.connect(masterGain); // Connect to master gain

        // Apply loop settings (same logic as in createNote)
        if (useOriginalBuffer) {
            if (isSampleLoopOn) {
                newSource.loop = true;
                newSource.loopStart = sampleStartPosition * audioBuffer.duration;
                newSource.loopEnd = sampleEndPosition * audioBuffer.duration;
            } else {
                 newSource.loop = false;
            }
        } else {
            newSource.loop = isSampleLoopOn;
        }

        // Update the note object with new nodes and state
        note.source = newSource;
        note.gainNode = newGainNode;
        note.sampleNode = newSampleNode;
        note.usesProcessedBuffer = !useOriginalBuffer;
        note.crossfadeActive = !useOriginalBuffer && isSampleLoopOn && sampleCrossfadeAmount > 0.01;
        note.looping = isSampleLoopOn; // Update looping state
        note.sampleStartPosition = useOriginalBuffer ? sampleStartPosition * audioBuffer.duration : 0;
        note.sampleEndPosition = useOriginalBuffer ? sampleEndPosition * audioBuffer.duration : sourceBuffer.duration;

        // Start the new source
        console.log(`updateSamplePlaybackParameters [${note.id}]: Starting new source.`);
        newSource.start(0);

        // Restore gain smoothly (or apply ADSR if needed, but for held notes, restoring gain is better)
        const now = audioCtx.currentTime;
        note.gainNode.gain.cancelScheduledValues(now);
        // Ramp from 0 back to the previous gain value quickly to avoid clicks but maintain level
        note.gainNode.gain.setValueAtTime(0, now);
        note.gainNode.gain.linearRampToValueAtTime(currentGainValue, now + 0.01); // Quick ramp (10ms)

        // Schedule stop if not looping (same logic as createNote)
        if (!isSampleLoopOn) {
            let originalDuration;
             if (fadedBuffer && sourceBuffer === fadedBuffer && fadedBufferOriginalDuration) {
                originalDuration = fadedBufferOriginalDuration;
            } else if (!useOriginalBuffer && sourceBuffer === cachedCrossfadedBuffer) {
                originalDuration = sourceBuffer.duration;
            } else {
                originalDuration = (sampleEndPosition - sampleStartPosition) * audioBuffer.duration;
            }
            const playbackRate = calculatedRate;
            const adjustedDuration = originalDuration / playbackRate;
            const safetyMargin = 0.05;
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
        // Attempt to kill the note if replacement fails badly
        killNote(note.id);
        return null;
    } finally {
        note.isBeingUpdated = false; // Release the update lock
        console.log(`updateSamplePlaybackParameters: Finished update for note ${note.id}`);
    }
    return note;
}
// Replace the entire createNote function with this fixed version
function createNote(noteNumber, buffer, audioCtx, destination) {
const noteId = `${noteNumber}_${Date.now()}`;

// Create gain nodes
const gainNode = audioCtx.createGain();
const sampleNode = audioCtx.createGain();
gainNode.gain.value = 0.5;
sampleNode.gain.value = currentSampleGain;

const source = audioCtx.createBufferSource();

// IMPORTANT: Select the correct buffer to use
let useOriginalBuffer = true;
let sourceBuffer = buffer; // Default to original buffer

// If we have a crossfaded buffer and looping is on, use that
if (isSampleLoopOn && sampleCrossfadeAmount > 0.01 && cachedCrossfadedBuffer) {
sourceBuffer = cachedCrossfadedBuffer;
useOriginalBuffer = false;
console.log("Creating note using crossfaded buffer");
} 
// If we have a faded buffer and crossfade is not active, use the faded buffer
else if (fadedBuffer && (!isSampleLoopOn || sampleCrossfadeAmount <= 0.01)) {
sourceBuffer = fadedBuffer;
useOriginalBuffer = false;
console.log("Creating note using faded buffer");
}

// Set the buffer
source.buffer = sourceBuffer;

// Set playback speed for note pitch

// Apply key tracking only if enabled
if (isSampleKeyTrackingOn) {
// Calculate semitone difference from middle C (note 60)
source.playbackRate.value = TR2 ** (noteNumber - 12);
source.detune.setValueAtTime(currentSampleDetune, audioCtx.currentTime);
} else {
// Just use the knob value without key tracking
source.detune.value = currentSampleDetune;
}
// Connect nodes
source.connect(sampleNode);
sampleNode.connect(gainNode);
gainNode.connect(destination);

// Set exact loop points if using original buffer
if (useOriginalBuffer) {
if (isSampleLoopOn) {
    source.loop = true;
    source.loopStart = sampleStartPosition * buffer.duration;
    source.loopEnd = sampleEndPosition * buffer.duration;
    console.log(`Setting loop points: ${source.loopStart.toFixed(3)}s to ${source.loopEnd.toFixed(3)}s`);
}
} else {
// For processed buffer, loop the entire thing if looping is on
source.loop = isSampleLoopOn;
}

// Create note object
const note = {
id: noteId,
noteNumber,
source,
gainNode,
sampleNode,
startTime: audioCtx.currentTime,
state: "starting",
scheduledEvents: [],
sampleStartPosition: useOriginalBuffer ? sampleStartPosition * buffer.duration : 0,
sampleEndPosition: useOriginalBuffer ? sampleEndPosition * buffer.duration : sourceBuffer.duration,
looping: isSampleLoopOn,
usesProcessedBuffer: !useOriginalBuffer,
crossfadeActive: !useOriginalBuffer && isSampleLoopOn && sampleCrossfadeAmount > 0.01
};

// Start playback
source.start(0);

if (!isSampleLoopOn) {
let originalDuration;

// Duration calculation logic (unchanged)
if (fadedBuffer && sourceBuffer === fadedBuffer && fadedBufferOriginalDuration) {
originalDuration = fadedBufferOriginalDuration;
console.log(`Using stored fadedBufferOriginalDuration: ${originalDuration.toFixed(3)}s`);
}
else if (!useOriginalBuffer && sourceBuffer === cachedCrossfadedBuffer) {
originalDuration = sourceBuffer.duration;
console.log(`Using crossfaded buffer duration: ${originalDuration.toFixed(3)}s`);
}
else {
originalDuration = (sampleEndPosition - sampleStartPosition) * buffer.duration;
console.log(`Calculating original duration: ${originalDuration.toFixed(3)}s`);
}

const now = audioCtx.currentTime;
sampleNode.gain.setValueAtTime(currentSampleGain, now);

// CRITICAL FIX: Adjust duration based on playback rate
// Lower pitches = longer duration
const playbackRate = source.playbackRate.value;
const adjustedDuration = originalDuration / playbackRate;

// Apply safety margin
const safetyMargin = 0.05;
source.stop(now + adjustedDuration + safetyMargin);

console.log(`Note scheduled to play for adjusted duration: ${adjustedDuration.toFixed(3)}s (original: ${originalDuration.toFixed(3)}s) at rate ${playbackRate.toFixed(2)} + ${safetyMargin}s margin`);
}

// Store the note
activeNotes[noteId] = note;

return note;
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
const activeNotes = {}; // Stores active notes
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
displayEl.innerHTML = '';

// Only count and display notes that are in "playing" state
const playingNotes = Object.values(activeNotes).filter(
note => note && note.state === "playing"
);

// Update count first
const activeNoteCount = Math.min(playingNotes.length, MAX_POLYPHONY);
D('voice-count').textContent = activeNoteCount;

// Create display items for keyboard keys
keys.forEach((key, index) => {
const voiceItem = document.createElement('div');
voiceItem.className = 'voice-item';
voiceItem.textContent = key;

// Only show as active if the note is actually playing
const isPlaying = playingNotes.some(
    note => note.noteNumber === index
);

if (isPlaying) {
    voiceItem.classList.add('active-voice');
}

displayEl.appendChild(voiceItem);
});

// Update keyboard visual state
updateKeyboardDisplay();
}

// you're the best <3 and you should put french fries in my car so that my car smells like fries forever :) - from Asher to Faith
// Add event listeners for sliders
D('attack').addEventListener('input', updateSliderValues);
D('decay').addEventListener('input', updateSliderValues);
D('sustain').addEventListener('input', updateSliderValues);
D('release').addEventListener('input', updateSliderValues);

// Update createNote to use unique IDs instead of note numbers as keys


// Update releaseNote to properly handle keyboard display

function startNote(noteNumber, audioCtx, destination, buffer) {
// Create new note
const note = createNote(noteNumber, buffer, audioCtx, destination);

// Apply ADSR envelope
const attack = parseFloat(D('attack').value);
const decay = parseFloat(D('decay').value);
const sustain = parseFloat(D('sustain').value);
const now = audioCtx.currentTime;

note.gainNode.gain.setValueAtTime(0, now);
note.gainNode.gain.linearRampToValueAtTime(1, now + attack);
note.gainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);

note.state = "playing";
updateVoiceDisplay();
return note;
}
// Update releaseNote function to use noteId instead of noteNumber
function releaseNote(noteId, audioCtx) {
const note = activeNotes[noteId];
if (!note || note.state !== "playing") {
console.log("releaseNote: Note", noteId, "is not playing. Skipping release.");
return;
}

// If the note is using the processed (crossfaded) buffer, disable looping
if (note.usesProcessedBuffer) {
note.looping = false;
console.log("releaseNote: Disabling looping for processed note", noteId);
}

note.state = "releasing";
const release = parseFloat(D('release').value);
const now = audioCtx.currentTime;

note.gainNode.gain.cancelScheduledValues(now);
const currentGain = note.gainNode.gain.value;
note.gainNode.gain.setValueAtTime(currentGain, now);
note.gainNode.gain.linearRampToValueAtTime(0, now + release);

try {
note.source.stop(now + release + 0.05);
console.log("releaseNote: Scheduling stop for note", noteId, "at", now + release + 0.05);
} catch (e) {
console.log("releaseNote: Error stopping source for note", noteId, e);
}

const releaseTimer = setTimeout(() => {
if (note.state === "releasing") {
killNote(note.id);
updateVoiceDisplay();
console.log("releaseNote: Note", noteId, "has been cleaned up.");
}
}, (release * 1000) + 100);

note.releaseTimer = releaseTimer;
note.scheduledEvents.push({ type: "timeout", id: releaseTimer });

updateVoiceDisplay();
}
// Rename existing noteOn/noteOff to these:
// Update handlePolyNoteOn function
// Update handlePolyNoteOn function
function handlePolyNoteOn(noteNumber) {
if (!heldNotes.includes(noteNumber)) {
heldNotes.push(noteNumber);
}

// Gather all notes that are still alive (playing or releasing)
let active = Object.values(activeNotes).filter(
n => n.state === "playing" || n.state === "releasing"
);

// While we are at or above the poly limit,
// kill the oldest note to free a slot
while (active.length >= MAX_POLYPHONY) {
// Sort oldest first
active.sort((a, b) => a.startTime - b.startTime);
const oldest = active[0];

// Mark it as "fadingOut" so it won't be counted in active[] next loop
oldest.state = "fadingOut";
quickFadeOut(oldest, 0.15); // short forced fade

// Re-check the active list
active = Object.values(activeNotes).filter(
n => n.state === "playing" || n.state === "releasing"
);
}

// Now that we freed up a slot, start the new note
startNewPolyNote(noteNumber);
updateVoiceDisplay();
}
// Helper to start a note with portamento if needed
function startNewPolyNote(noteNumber) {
if (isPortamentoOn && lastPlayedNote !== null) {
const note = startNote(noteNumber, audioCtx, masterGain, audioBuffer);
const startRate = TR2 ** (lastPlayedNote - 12);
const targetRate = TR2 ** (noteNumber - 12);

note.source.playbackRate.setValueAtTime(startRate, audioCtx.currentTime);
note.source.playbackRate.linearRampToValueAtTime(
    targetRate,
    audioCtx.currentTime + glideTime
);
} else {
startNote(noteNumber, audioCtx, masterGain, audioBuffer);
}
lastPlayedNote = noteNumber;
}
// Fix handlePolyNoteOff function
function handlePolyNoteOff(noteNumber) {
// Remove from held notes
heldNotes = heldNotes.filter(n => n !== noteNumber);

// Release all instances of this note
Object.values(activeNotes).forEach(note => {
if (note.noteNumber === noteNumber && note.state === "playing") {
    releaseNote(note.id, audioCtx);
}
});
updateVoiceDisplay();
}updateVoiceDisplay();


// Initialize switches on DOM load
document.addEventListener('DOMContentLoaded', () => {
//nitializeSwitches();
});
/**
* Quickly fades out a note and cleans it up.
* @param {Object} note - The note object to fade out
* @param {number} fadeTime - Fade time in seconds (default: 0.05)
* @returns {Object} - The same note for chaining
*/
function quickFadeOut(note, fadeTime = 0.05) {
if (!note || !note.gainNode) return note;

// Update state
note.state = "fadingOut";

try {
// Get current time and gain value
const now = audioCtx.currentTime;
const currentGain = note.gainNode.gain.value;

// Cancel any scheduled values and set current value
note.gainNode.gain.cancelScheduledValues(now);
note.gainNode.gain.setValueAtTime(currentGain, now);

// Ramp down to zero
note.gainNode.gain.linearRampToValueAtTime(0, now + fadeTime);

// Schedule the note to be killed after the fade
const killTimer = setTimeout(() => {
killNote(note.id);
}, fadeTime * 1000 + 10); // Add 10ms buffer

// Register this timeout in the note's scheduled events
note.scheduledEvents.push({ type: 'timeout', id: killTimer });
} 
catch (e) {
console.error("Error in quickFadeOut:", e);
killNote(note.id); // Clean up immediately on error
}

return note;
}
// Fix the killNote function
function killNote(noteId) {
    const note = activeNotes[noteId];
    if (!note) return false;

    // Only set currentNote to null if it's the actual current note AND there are no held notes
    if (note === currentNote) {
        if (heldNotes.length === 0) {
            console.log(`killNote: Killing the currentNote (ID: ${noteId}, Note: ${note.noteNumber}). Setting currentNote to null.`);
            currentNote = null;
        } else {
            console.log(`killNote: Not nullifying currentNote because there are still ${heldNotes.length} held notes.`);
        }
    }
    // ---

    // Clean up scheduled events
    note.scheduledEvents.forEach(event => {
        if (event.type === "timeout") {
            clearTimeout(event.id);
        }
    });

// Stop the source and disconnect nodes
try {
    note.gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
    note.gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    if (note.source) {
        note.source.stop(audioCtx.currentTime);
        note.source.disconnect();
    }
    if (note.sampleNode) note.sampleNode.disconnect();
    note.gainNode.disconnect();
} catch (e) {
    if (!e.message.includes("already stopped") && !e.message.includes("invalid state")) {
        console.warn(`Error during killNote cleanup for ${noteId}:`, e);
    }
}

// Remove note from active notes
delete activeNotes[noteId];
return true;
}

function updateKeyboardDisplay() {
// Update all keyboard keys based on active notes
document.querySelectorAll('.key').forEach(keyElement => {
const noteIndex = parseInt(keyElement.dataset.noteIndex);
const isNotePlaying = Object.values(activeNotes).some(
    note => note.noteNumber === noteIndex && note.state === "playing"
);

keyElement.classList.toggle('pressed', isNotePlaying);
});
}

// Update noteOn to handle polyphony with unique note instances
// Update noteOn to ensure proper mode handling

function noteOff(noteNumber) {
if (isMonoMode) {
handleMonoNoteOff(noteNumber);
} else {
handlePolyNoteOff(noteNumber);
}
updateKeyboardDisplay();
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
        Object.values(activeNotes).forEach(note => {
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
function cleanupAllNotes() {
  for (const noteId in activeNotes) { // Iterate over unique IDs
    killNote(noteId); // Use killNote with the ID
}
    
 // Reset all key states using the keyboard module function
 resetKeyStates(); // <-- Call the imported function

    updateVoiceDisplay();
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

// Update noteOn function to handle mono mode
function noteOn(noteNumber) {
if (isMonoMode) {
handleMonoNoteOn(noteNumber);
} else {
handlePolyNoteOn(noteNumber);
}
}
// Fix for voice limiting in mono mode
// Fix for voice limiting in mono mode
function handleMonoNoteOn(noteNumber) {
    if (!checkAudioAvailable()) return;

    // Add note to held notes
    if (!heldNotes.includes(noteNumber)) {
        heldNotes.push(noteNumber);
    }

    // IMPORTANT: Check the state of switches directly before making decisions
    console.log(`SWITCH STATE CHECK: mono=${isMonoMode}, legato=${isLegatoMode}, portamento=${isPortamentoOn}, glideTime=${glideTime.toFixed(3)}`);

    // THE KEY FIX: Legato mode ONLY controls if we trigger or not
    // It should NOT be mixed with portamento decision
    const shouldTrigger = !isLegatoMode || !currentNote;

    // Log initial state
    console.log(
        `handleMonoNoteOn: note=${noteNumber}, isPortamentoOn=${isPortamentoOn}, ` +
        `isLegatoMode=${isLegatoMode}, currentNoteExists=${!!currentNote}, ` +
        `lastPlayedNote=${lastPlayedNote}, shouldTrigger=${shouldTrigger}`
    );

    if (shouldTrigger) {
        // We're going to trigger a new note
        const prevNote = currentNote;
        currentNote = startNote(noteNumber, audioCtx, masterGain, audioBuffer);
        
        // Apply portamento if enabled AND we have a last played note
        if (isPortamentoOn && lastPlayedNote !== null) {
            console.log(`Applying portamento glide (new note): ${glideTime.toFixed(3)}s from ${lastPlayedNote} to ${noteNumber}`);
            const startRate = TR2 ** (lastPlayedNote - 12);
            const targetRate = TR2 ** (noteNumber - 12);
            
            currentNote.source.playbackRate.setValueAtTime(startRate, audioCtx.currentTime);
            currentNote.source.playbackRate.linearRampToValueAtTime(
                targetRate, 
                audioCtx.currentTime + glideTime
            );
        }
        
        // Fade out previous note if there was one
        if (prevNote) {
            quickFadeOut(prevNote, 0.015);
        }
    } else {
        // Legato mode - remove the "if (isPortamentoOn)" check
        currentNote.source.playbackRate.cancelScheduledValues(audioCtx.currentTime);
        const currentRate = currentNote.source.playbackRate.value;
        const targetRate = TR2 ** (noteNumber - 12);
    
        // Always ramp to the user-set glideTime from the knob
        currentNote.source.playbackRate.setValueAtTime(currentRate, audioCtx.currentTime);
        currentNote.source.playbackRate.linearRampToValueAtTime(
            targetRate,
            audioCtx.currentTime + glideTime
        );
    
        currentNote.noteNumber = noteNumber;
    }

    lastPlayedNote = noteNumber;
    updateVoiceDisplay();
}

// Update handleMonoNoteOff function
function handleMonoNoteOff(noteNumber) {
    // Remove note from held notes array
    const initialLength = heldNotes.length;
    heldNotes = heldNotes.filter(n => n !== noteNumber);
    const noteWasHeld = heldNotes.length < initialLength;

    if (!noteWasHeld) return;

    if (heldNotes.length > 0) {
        const lastNote = heldNotes[heldNotes.length - 1]; // The note to return to

        if (currentNote && currentNote.noteNumber === noteNumber) { // If the note being released is the one currently sounding
            if (!isLegatoMode) {
                // Multi-trigger: Fade out current, start last held note (potentially with glide)
                const prevNote = currentNote; // The note we are releasing (e.g., B)
                const prevNoteNumber = prevNote.noteNumber; // Get the note number of the note being released
                // --- Get the actual playback rate just before stopping ---
                const actualStartRateValue = prevNote.source.playbackRate.value;
                // ---

                // Start the new note (the one we are returning to, e.g., A)
                currentNote = startNote(lastNote, audioCtx, masterGain, audioBuffer);
                lastPlayedNote = lastNote; // Update last played note

                // --- Modify Glide Logic for Multi-Trigger Note Off ---
                if (isPortamentoOn && prevNoteNumber !== null) {
                    console.log(`Applying glide (multi-trigger note off): ${glideTime.toFixed(3)}s`);
                    // const startRate = TR2 ** (prevNoteNumber - 12); // OLD: Start glide FROM the released note's target pitch
                    const startRate = actualStartRateValue; // NEW: Start glide FROM the actual current pitch
                    const targetRate = TR2 ** (lastNote - 12);     // Glide TO the held note's pitch

                    // Set starting pitch immediately based on where the previous note left off
                    currentNote.source.playbackRate.setValueAtTime(startRate, audioCtx.currentTime);
                    // Schedule ramp to target pitch
                    currentNote.source.playbackRate.linearRampToValueAtTime(
                        targetRate,
                        audioCtx.currentTime + glideTime
                    );
                }
                // --- End Glide Logic Modification ---

                // Fade out the note that was just released
                quickFadeOut(prevNote, 0.015);

            } else {
                // Legato mode: ALWAYS glide pitch back to the last held note
                currentNote.source.playbackRate.cancelScheduledValues(audioCtx.currentTime);
                const currentRate = currentNote.source.playbackRate.value; // Get pitch where it was released
                const targetRate = TR2 ** (lastNote - 12); // Target pitch of the held note

                 // Log state before glide logic
                console.log(`handleMonoNoteOff (Legato): note=${noteNumber} released, gliding back to ${lastNote}. GlideTime=${glideTime.toFixed(3)}, currentRate=${currentRate.toFixed(4)}, targetRate=${targetRate.toFixed(4)}`);

                // --- REMOVED: if (isPortamentoOn) { ... } else { ... } ---
                // ALWAYS apply the glide back using the global glideTime
                console.log(`Applying glide back (legato note off): ${glideTime.toFixed(3)}s`);
                currentNote.source.playbackRate.setValueAtTime(currentRate, audioCtx.currentTime);
                currentNote.source.playbackRate.linearRampToValueAtTime(
                    targetRate,
                    audioCtx.currentTime + glideTime // Use the global glideTime
                );
                // --- End of modification ---

                 currentNote.noteNumber = lastNote; // Update the current note's number
                 lastPlayedNote = lastNote; // Update last played note as well
            }
        }
    } else { // No notes left held
        if (currentNote && currentNote.noteNumber === noteNumber) {
            releaseNote(currentNote.id, audioCtx);
            console.log(`handleMonoNoteOff: Setting currentNote to null (released last held note ${noteNumber})`);
            // Comment out or remove this line so the next NoteOn can glide:
            // lastPlayedNote = null;
            currentNote = null;
        }
    }
    updateVoiceDisplay();
}
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
Object.values(activeNotes).forEach(note => {
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
    Object.values(activeNotes).forEach(note => {
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
Object.values(activeNotes).forEach(note => {
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
    
    // Store the processed buffer (pre-lofi)
    let finalBuffer = processedBuffer;
    
    // STEP 3: Handle crossfade for looping (before applying Lo-Fi)
    if (isSampleLoopOn && sampleCrossfadeAmount > 0.01) {
        setTimeout(() => {
            const result = createCrossfadedBuffer(
                audioCtx,
                processedBuffer,
                0,  // Start from beginning of the processed buffer
                1,  // Use entire processed buffer
                sampleCrossfadeAmount
            );
            
            if (result && result.buffer) {
                let crossfadedBuffer = result.buffer;
                
                // STEP 4: Apply E-mu processing AFTER crossfade if enabled
                if (isEmuModeOn) {
                    crossfadedBuffer = applyEmuProcessing(crossfadedBuffer);
                }
                
                cachedCrossfadedBuffer = crossfadedBuffer;
                lastCachedStartPos = sampleStartPosition;
                lastCachedEndPos = sampleEndPosition;
                lastCachedCrossfade = sampleCrossfadeAmount;
            }
        }, 10);
    }
    
    // STEP 4: Apply E-mu processing at the very end for non-crossfaded cases
    if (isEmuModeOn) {
        finalBuffer = applyEmuProcessing(processedBuffer);
    }
    
    // Store the final processed buffer
    fadedBuffer = finalBuffer;
}
}, 10);
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
    activeNotes, // Pass object reference
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
Object.values(activeNotes).forEach(note => {
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