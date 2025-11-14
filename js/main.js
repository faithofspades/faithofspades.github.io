window.loadPresetSample = function(filename) {
    console.log(`Loading preset sample: ${filename}`);

    // Determine if we're running on GitHub Pages
    const isGitHubPages = window.location.hostname.includes('github.io');
    
    // FIX: Don't duplicate the repository name in the path
    const basePath = isGitHubPages ? '/samples/' : '/samples/';
    const sampleUrl = new URL(basePath + filename, window.location.origin).href;
    
    console.log(`Loading sample from: ${sampleUrl}`);

    // Rest of your function remains the same...
    fetch(sampleUrl)
    .then(response => {
        if (!response.ok) {
            throw new Error(`Failed to load sample: ${response.status} ${response.statusText}`);
        }
        return response.arrayBuffer();
    })
    .then(arrayBuffer => {
        return audioCtx.decodeAudioData(arrayBuffer);
    })
    .then(buffer => {
        audioBuffer = buffer;
        originalBuffer = buffer.slice();
        
        // Apply reverse if needed
        if (isSampleReversed) {
            reverseBufferIfNeeded(false);
        }
        
        // Process fades and crossfades
        updateSampleProcessing();
        
        // Create new source node
        if (sampleSource) {
            sampleSource.stop();
        }
        sampleSource = audioCtx.createBufferSource();
        sampleSource.buffer = buffer;
        sampleSource.connect(sampleGainNode);
        sampleSource.start();
        
        // UPDATE LABEL
        const fileLabel = document.querySelector('label[for="audio-file"]');
        if (fileLabel) {
            fileLabel.textContent = filename.substring(0, 10) + (filename.length > 10 ? '...' : '');
        }
        
        // Force FM connection update
        setTimeout(() => {
            // Update any active sampler notes
            voicePool.forEach(voice => {
                if (voice.state !== 'inactive' && voice.samplerNote) {
                    if (!heldNotes.includes(voice.noteNumber)) {
                        updateSamplePlaybackParameters(voice.samplerNote);
                    }
                }
            });
        }, 100);

        console.log(`Sample ${filename} loaded successfully, length: ${buffer.length} samples, duration: ${buffer.duration.toFixed(2)}s`);
    })
    .catch(error => {
        console.error('Error loading preset sample:', error);
        alert(`Failed to load sample: ${filename}`);
    });
};
import { createiOSStartupOverlay } from './ios.js';
import { initializeKnob } from './controls.js'; 
import { fixMicRecording, createCrossfadedBuffer, findBestZeroCrossing } from './sampler.js'; 
import { initializeModCanvas, getModulationPoints } from './modCanvas.js';
import { initializeKeyboard, keys, resetKeyStates } from './keyboard.js';
import { fixAllKnobs, initializeSpecialButtons, fixSwitchesTouchMode } from './controlFixes.js'; 
import { initializeUiPlaceholders } from './uiPlaceholders.js'; 
import FilterManager from './filter-manager.js';
const D = x => document.getElementById(x);
const TR2 = 2 ** (1.0 / 12.0);
const STANDARD_FADE_TIME = 0.000; // 0ms standard fade time
const VOICE_STEAL_SAFETY_BUFFER = 0.000; // 2ms safety buffer for voice stealing
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
Tone.setContext(audioCtx);

// Dual ADSR system state variables
let adsrMode = 'adsr'; // 'adsr' or 'filter'
let classicModeEnabled = false; // Only active when adsrMode === 'filter'
let currentFilterType = 'lp24'; // Track current filter type for dynamic tooltips
function initializeFilterSystem() {
  // Create filter manager instance
  filterManager = new FilterManager(audioCtx);
  
  // Configure filter with proper defaults
  if (filterManager) {
    // Drive is initialized to 0.5 in FilterManager constructor (50% = unity gain for LH18)
    // It will be set again when the UI initializes the slider
    filterManager.setCutoff(16000); // 100% = 20kHz (no filtering)
    filterManager.setResonance(0.0); // No resonance
  }
  
  console.log("Filter system initialized - LP24 Moog filter active by default");
  
  return filterManager;
}
// Create separate output gains for sampler and oscillators
let samplerMasterGain = audioCtx.createGain();
let oscillatorMasterGain = audioCtx.createGain();
let masterOutputVolume = 0.005;
samplerMasterGain.gain.setValueAtTime(masterOutputVolume, audioCtx.currentTime);
oscillatorMasterGain.gain.setValueAtTime(1.0, audioCtx.currentTime);

// Create masterGain node
const masterGain = audioCtx.createGain();
masterGain.gain.setValueAtTime(0.5, audioCtx.currentTime);

// CORRECT ROUTING: Connect both through masterGain to destination
samplerMasterGain.connect(masterGain);
oscillatorMasterGain.connect(masterGain);
masterGain.connect(audioCtx.destination);
// Don't connect masterGain yet - we'll do it selectively below
let isWorkletReady = false;
let pendingInitialization = true;
// Helper function to create natural decay/release curves
function applyCurvedEnvelope(gainNode, startValue, endValue, duration, startTime, curveType) {
  // Only cancel scheduled values if we're starting immediately (not scheduling for future)
  const now = audioCtx.currentTime;
  if (startTime <= now + 0.001) {
    gainNode.cancelScheduledValues(startTime);
  }
  
  // Set the starting point
  gainNode.setValueAtTime(Math.max(0.0001, startValue), startTime);
  
  if (curveType === 'decay' || curveType === 'release') {
    // Use setTargetAtTime with a faster time constant for smoother fade to zero
    // Time constant = duration / 5 (instead of / 3) makes it decay faster initially
    // This gives more time for the tail to smoothly approach zero
    const timeConstant = duration / 5;
    gainNode.setTargetAtTime(endValue, startTime, timeConstant);
  } else {
    // For attack and other types, keep using linear ramps
    gainNode.linearRampToValueAtTime(endValue, startTime + duration);
  }
}
// Function to play a test tone
function playTestTone(filterType) {
  // Only play if we have an audio context
  if (!audioCtx) return;
  
  // Create a test oscillator
  const testOsc = audioCtx.createOscillator();
  const testGain = audioCtx.createGain();
  
  // Configure oscillator
  testOsc.type = 'sawtooth'; // Rich harmonic content to highlight filter
  testOsc.frequency.value = 220; // Low A
  
  // Very short test
  testGain.gain.setValueAtTime(0, audioCtx.currentTime);
  testGain.gain.linearRampToValueAtTime(0.2, audioCtx.currentTime + 0.01);
  testGain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
  
  // Connect and play
  testOsc.connect(testGain);
  testGain.connect(audioCtx.destination);
  
  testOsc.start();
  testOsc.stop(audioCtx.currentTime + 0.6);
  
  console.log(`Playing test tone with ${filterType} filter`);
}
// Update worklet initialization to include master clock
const workletReadyPromise = initializeMasterClock()
    .then(() => audioCtx.audioWorklet.addModule('js/shape-hold-processor.js'))
    .then(() => {
        console.log('All AudioWorklets loaded successfully.');
        isWorkletReady = true;
        
        console.log("Initializing oscillator and sampler voice pools...");
        initializeVoicePool();
        initializeSamplerVoicePool();
        
        pendingInitialization = false;
        console.log("All voice pools initialized - synth is ready");
        return true;
    })
    .catch(error => {
        console.error('Failed to load AudioWorklets:', error);
        pendingInitialization = false;
        return false;
    });
workletReadyPromise.then(() => {
  console.log("AudioWorklets loaded, initializing filter system...");
  filterManager = initializeFilterSystem();
  
  // Initialize filter ADSR with default values from filter envelope sliders
  if (filterManager && filterManager.isActive) {
    const filterAttack = parseFloat(D('filter-attack')?.dataset.mappedTime || 0);
    const filterDecay = parseFloat(D('filter-decay')?.dataset.mappedTime || 0);
    const filterSustain = parseFloat(D('filter-sustain')?.value || 1.0);
    const filterRelease = parseFloat(D('filter-release')?.dataset.mappedTime || 0);
    
    filterManager.setADSR(filterAttack, filterDecay, filterSustain, filterRelease, false);
    console.log(`Filter ADSR initialized: A:${filterAttack}s D:${filterDecay}s S:${filterSustain} R:${filterRelease}s`);
  }
  
  console.log("Initializing oscillator and sampler voice pools...");
  initializeVoicePool();
  initializeSamplerVoicePool();
  
  pendingInitialization = false;
  console.log("All systems initialized - synth is ready");
});
// Function to set master clock rate based on a MIDI note number
function setMasterClockRate(clockNumber, noteNumber, detune = 0) {
    if (!masterClockNode) return;
    
    const frequency = noteToFrequency(noteNumber, 0, detune);
    const paramName = clockNumber === 1 ? 'clock1Rate' : 'clock2Rate';
    const clockParam = masterClockNode.parameters.get(paramName);
    
    if (clockParam) {
        const now = audioCtx.currentTime;
        clockParam.setValueAtTime(frequency, now);
        console.log(`Set master clock ${clockNumber} to ${frequency.toFixed(2)} Hz (note ${noteNumber})`);
    }
}
// Global helper function to convert visual position (0-1) to frequency
function filterPositionToFrequency(position) {
  // logarithmic mapping with 500Hz at midpoint
  let frequency;
  if (position <= 0.5) {
    frequency = 8 * Math.pow(500/8, position*2); // 0-0.5 maps to 8-500Hz
  } else {
    frequency = 500 * Math.pow(16000/500, (position-0.5)*2); // 0.5-1 maps to 500-16000Hz
  }
  // Round to nearest whole Hz to avoid fractional frequencies
  return Math.round(frequency);
}

function setupNonLinearFilterSlider() {
  const slider = document.querySelector('.freq-slider-range');
  if (!slider) return;
  
  // Keep the original min/max attributes
  slider.min = 8;
  slider.max = 16000;
  
  // Store the original input handler from filterInitialization
  const originalHandler = slider.oninput;
  
  // Remove any existing event listeners
  const newSlider = slider.cloneNode(true);
  slider.parentNode.replaceChild(newSlider, slider);
  
  // Function to convert frequency to visual position
  function frequencyToPosition(freq) {
    if (freq <= 500) {
      return Math.log(freq/8) / Math.log(500/8) * 0.5;
    } else {
      return 0.5 + (Math.log(freq/500) / Math.log(16000/500) * 0.5);
    }
  }
  
  // Update filter cutoff when slider is moved
  newSlider.oninput = function(e) {
    // Calculate visual position based on slider physical position
    let visualPosition = parseInt(this.value) / (parseInt(this.max) - parseInt(this.min));
    
    // Check if this slider has active macro modulation
    const destination = knobToDestinationMap['filter-cutoff'];
    if (destination && destinationConnections[destination] && destinationModulations[destination] !== undefined) {
      const multiplier = destinationModulations[destination];
      
      // Apply multiplier to position (0-1 range)
      visualPosition = visualPosition * multiplier;
      
      // Clamp to 0-1 range
      visualPosition = Math.max(0, Math.min(1, visualPosition));
      
      console.log(`Filter cutoff modulated: base=${(parseInt(this.value) / (parseInt(this.max) - parseInt(this.min))).toFixed(2)}, multiplier=${multiplier.toFixed(2)}, final=${visualPosition.toFixed(2)}`);
    }
    
    // Convert to frequency using our mapping (already rounded to whole Hz)
    const frequency = filterPositionToFrequency(visualPosition);
    
    // Show tooltip with final modulated frequency
    createTooltipForSlider(this, `${Math.round(frequency)} Hz`, 'top-right');
    
    // Update filter
    if (filterManager) {
      filterManager.setCutoff(frequency);
    }
  };
  
  // Hide tooltip on release
  newSlider.addEventListener('mouseup', () => hideTooltipForSlider(newSlider));
  newSlider.addEventListener('touchend', () => hideTooltipForSlider(newSlider));
  
  // Initialize with correct frequency (500Hz at midpoint)
  const initialFreq = 500; // Hz
  const position = frequencyToPosition(initialFreq);
  const rawValue = Math.round(position * (slider.max - slider.min) + parseInt(slider.min));
  
  // Set the slider value
  newSlider.value = rawValue;
  
  // Trigger the event to set initial cutoff
  const event = new Event('input');
  newSlider.dispatchEvent(event);
  
  console.log("Fixed non-linear filter cutoff slider setup complete");
}

// Function to properly map ADSR sliders
function setupNonLinearADSRSliders() {
  // Function to convert visual position (0-1) to time
  function positionToTime(position) {
    if (position <= 0.5) {
      return position * 10; // First half: 0-0.5 maps to 0-5s
    } else {
      return 5 + (position - 0.5) * 50; // Second half: 0.5-1 maps to 5-30s
    }
  }
  
  // Function to convert time to visual position
  function timeToPosition(time) {
    if (time <= 5) {
      return time / 10; // 0-5s maps to 0-0.5
    } else {
      return 0.5 + (time - 5) / 50; // 5-30s maps to 0.5-1
    }
  }
  
  // === AMPLITUDE ADSR SLIDERS ===
  ['attack', 'decay', 'release'].forEach(id => {
    const slider = document.getElementById(id);
    if (!slider) return;
    
    slider.oninput = function(e) {
      const rawValue = parseFloat(this.value);
      const maxValue = parseFloat(this.max);
      const visualPosition = rawValue / maxValue;
      const timeValue = positionToTime(visualPosition);
      
      this.dataset.mappedTime = timeValue.toFixed(3);
      
      const valueDisplay = document.getElementById(`${id}-value`);
      if (valueDisplay) {
        valueDisplay.textContent = timeValue.toFixed(3);
      }
      
      updateADSRVisualization();
      
      console.log(`Amplitude ${id.toUpperCase()}: ${timeValue.toFixed(3)}s`);
    };
    
    // Set initial values
    let initialTime = 0.00;
    const initialPosition = timeToPosition(initialTime);
    slider.value = initialPosition * parseFloat(slider.max);
    slider.dataset.mappedTime = initialTime.toFixed(3);
    slider.dispatchEvent(new Event('input'));
  });
  
  // Amplitude sustain slider (0-1, no mapping)
  const sustainSlider = document.getElementById('sustain');
  if (sustainSlider) {
    sustainSlider.oninput = function(e) {
      const sustainValue = parseFloat(this.value);
      
      const valueDisplay = document.getElementById('sustain-value');
      if (valueDisplay) {
        valueDisplay.textContent = sustainValue.toFixed(2);
      }
      
      updateADSRVisualization();
      
      console.log(`Amplitude SUSTAIN: ${sustainValue.toFixed(2)}`);
    };
    
    sustainSlider.value = 1.0;
    sustainSlider.dispatchEvent(new Event('input'));
  }
  
  // === FILTER ENVELOPE SLIDERS ===
  ['filter-attack', 'filter-decay', 'filter-release'].forEach(id => {
    const slider = document.getElementById(id);
    if (!slider) return;
    
    slider.oninput = function(e) {
      const rawValue = parseFloat(this.value);
      const maxValue = parseFloat(this.max);
      const visualPosition = rawValue / maxValue;
      const timeValue = positionToTime(visualPosition);
      
      this.dataset.mappedTime = timeValue.toFixed(3);
      
      const valueDisplay = document.getElementById(`${id}-value`);
      if (valueDisplay) {
        valueDisplay.textContent = timeValue.toFixed(3);
      }
      
      // Update filter with all current filter envelope values
      if (filterManager && filterManager.isActive) {
        const filterAttack = parseFloat(D('filter-attack').dataset.mappedTime || D('filter-attack').value);
        const filterDecay = parseFloat(D('filter-decay').dataset.mappedTime || D('filter-decay').value);
        const filterSustain = parseFloat(D('filter-sustain').value);
        const filterRelease = parseFloat(D('filter-release').dataset.mappedTime || D('filter-release').value);
        
        filterManager.setADSR(filterAttack, filterDecay, filterSustain, filterRelease, classicModeEnabled);
      }
      
      // Update visualization if in filter mode
      if (adsrMode === 'filter') {
        updateADSRVisualization();
      }
      
      console.log(`Filter ${id.toUpperCase()}: ${timeValue.toFixed(3)}s`);
    };
    
    // Set initial values
    let initialTime = 0.00;
    const initialPosition = timeToPosition(initialTime);
    slider.value = initialPosition * parseFloat(slider.max);
    slider.dataset.mappedTime = initialTime.toFixed(3);
    slider.dispatchEvent(new Event('input'));
  });
  
  // Filter sustain slider (0-1, no mapping)
  const filterSustainSlider = document.getElementById('filter-sustain');
  if (filterSustainSlider) {
    filterSustainSlider.oninput = function(e) {
      const sustainValue = parseFloat(this.value);
      
      const valueDisplay = document.getElementById('filter-sustain-value');
      if (valueDisplay) {
        valueDisplay.textContent = sustainValue.toFixed(2);
      }
      
      // Update filter with all current filter envelope values
      if (filterManager && filterManager.isActive) {
        const filterAttack = parseFloat(D('filter-attack').dataset.mappedTime || D('filter-attack').value);
        const filterDecay = parseFloat(D('filter-decay').dataset.mappedTime || D('filter-decay').value);
        const filterSustain = parseFloat(D('filter-sustain').value);
        const filterRelease = parseFloat(D('filter-release').dataset.mappedTime || D('filter-release').value);
        
        filterManager.setADSR(filterAttack, filterDecay, filterSustain, filterRelease, classicModeEnabled);
      }
      
      // Update visualization if in filter mode
      if (adsrMode === 'filter') {
        updateADSRVisualization();
      }
      
      console.log(`Filter SUSTAIN: ${sustainValue.toFixed(2)}`);
    };
    
    filterSustainSlider.value = 1.0;
    filterSustainSlider.dispatchEvent(new Event('input'));
  }
  
  console.log("Dual ADSR slider sets initialized independently");
}

// Initialize ADSR mode buttons
function initializeADSRModeButtons() {
  const adsrButton = document.getElementById('adsr-mode-button');
  const filterButton = document.getElementById('filter-mode-button');
  const classicButton = document.getElementById('classic-mode-button');
  
  const amplitudeSliders = document.getElementById('amplitude-adsr-sliders');
  const filterSliders = document.getElementById('filter-envelope-sliders');
  
  if (!adsrButton || !filterButton || !classicButton) {
    console.error("ADSR mode buttons not found in DOM");
    return;
  }
  
  if (!amplitudeSliders || !filterSliders) {
    console.error("ADSR slider sets not found in DOM");
    return;
  }
  
  // Function to update button visual states
  function updateButtonStates() {
    // Update ADSR/FILTER mutual exclusivity
    if (adsrMode === 'adsr') {
      adsrButton.classList.add('active');
      filterButton.classList.remove('active');
      amplitudeSliders.classList.remove('hidden');
      amplitudeSliders.classList.add('visible');
      filterSliders.classList.remove('visible');
      filterSliders.classList.add('hidden');
    } else {
      adsrButton.classList.remove('active');
      filterButton.classList.add('active');
      amplitudeSliders.classList.remove('visible');
      amplitudeSliders.classList.add('hidden');
      filterSliders.classList.remove('hidden');
      filterSliders.classList.add('visible');
    }
    
    // Update CLASSIC button state
    if (classicModeEnabled) {
      classicButton.classList.add('active');
    } else {
      classicButton.classList.remove('active');
    }
    
    // Grey out CLASSIC when in ADSR mode (visual indicator only)
    if (adsrMode === 'filter') {
      classicButton.classList.remove('disabled');
    } else {
      classicButton.classList.add('disabled');
    }
  }
  
  // ADSR button click handler - show amplitude sliders
  adsrButton.addEventListener('click', () => {
    if (adsrMode === 'adsr') return; // Already in ADSR mode
    
    // Switch to ADSR mode
    adsrMode = 'adsr';
    
    // Update visibility
    updateButtonStates();
    
    // Update visualization to show amplitude envelope
    updateADSRVisualization();
    
    console.log("Switched to ADSR mode (amplitude envelope sliders visible)");
  });
  
  // FILTER button click handler - show filter sliders
  filterButton.addEventListener('click', () => {
    if (adsrMode === 'filter') return; // Already in FILTER mode
    
    // Switch to FILTER mode
    adsrMode = 'filter';
    
    // Update visibility
    updateButtonStates();
    
    // Update visualization to show filter envelope
    updateADSRVisualization();
    
    console.log("Switched to FILTER mode (filter envelope sliders visible)");
  });
  
  // CLASSIC button click handler
  classicButton.addEventListener('click', () => {
    // Toggle classic mode
    classicModeEnabled = !classicModeEnabled;
    
    // Update button visual states
    updateButtonStates();
    
    // Update filter with classic mode flag using currently visible filter sliders
    if (filterManager && filterManager.isActive) {
      const filterAttack = parseFloat(D('filter-attack').dataset.mappedTime || D('filter-attack').value);
      const filterDecay = parseFloat(D('filter-decay').dataset.mappedTime || D('filter-decay').value);
      const filterSustain = parseFloat(D('filter-sustain').value);
      const filterRelease = parseFloat(D('filter-release').dataset.mappedTime || D('filter-release').value);
      
      filterManager.setADSR(filterAttack, filterDecay, filterSustain, filterRelease, classicModeEnabled);
    }
    
    console.log(`Classic mode ${classicModeEnabled ? 'enabled' : 'disabled'} (affects filter envelope only)`);
  });
  
  // Initialize button states
  updateButtonStates();
  
  console.log("ADSR mode buttons initialized with dual slider sets");
}
function initializeFilterControls() {
  // Filter Type Selector
  const filterTypeSelector = document.querySelector('.filter-type-range');
  if (filterTypeSelector) {
    filterTypeSelector.value = 3; // Set to LP24 (index 1)
    filterTypeSelector.addEventListener('input', (e) => {
      const value = parseInt(e.target.value);
      let filterType = 'none';
      let filterLabel = '';
      
      // Map slider position to filter type
      switch (value) {
        case 4: 
          filterType = 'lp12'; 
          filterLabel = 'Low Pass 12dB';
          break;
        case 3: 
          filterType = 'lp24'; 
          filterLabel = 'Low Pass 24dB';
          break;
        case 2: 
          filterType = 'lh12'; 
          filterLabel = 'Low 12 + High 6';
          break;
        case 1: 
          filterType = 'lh18'; 
          filterLabel = 'Low/High 12dB';
          break;
        case 0: 
          filterType = 'lh24'; 
          filterLabel = 'Low/High 24dB';
          break;
      }
      
      // Show tooltip on the right
      createTooltipForSlider(e.target, filterLabel, 'right');
      
      // Update global filter type for dynamic tooltips
      currentFilterType = filterType;
      
      if (filterManager) {
        filterManager.setFilterType(filterType);
      }
      
      console.log(`Filter type set to: ${filterType}`);
    });
    
    filterTypeSelector.addEventListener('mouseup', () => hideTooltipForSlider(filterTypeSelector));
    filterTypeSelector.addEventListener('touchend', () => hideTooltipForSlider(filterTypeSelector));
  }
  
  // Frequency Slider - Handled by setupNonLinearFilterSlider()
  // DO NOT add event listener here - it conflicts with the non-linear mapping setup
  
  // Resonance Slider - DEFAULT TO 0%%
  const resSlider = document.querySelector('.res-slider-range');
  if (resSlider) {
    resSlider.value = 0.0; // Set to 0%
    resSlider.addEventListener('input', (e) => {
      let value = parseFloat(e.target.value);
      
      // Check if this slider has active macro modulation
      const destination = knobToDestinationMap['filter-resonance'];
      if (destination && destinationConnections[destination] && destinationModulations[destination] !== undefined) {
        const multiplier = destinationModulations[destination];
        
        // Apply multiplier
        value = value * multiplier;
        
        // Clamp to 0-1 range
        value = Math.max(0, Math.min(1, value));
        
        console.log(`Filter resonance modulated: multiplier=${multiplier.toFixed(2)}, final=${value.toFixed(2)}`);
      }
      
      // Show tooltip on the right with final modulated value
      createTooltipForSlider(e.target, `${Math.round(value * 100)}%`, 'top-right');
      
      if (filterManager) {
        filterManager.setResonance(value);
      }
    });
    
    resSlider.addEventListener('mouseup', () => hideTooltipForSlider(resSlider));
    resSlider.addEventListener('touchend', () => hideTooltipForSlider(resSlider));
  }
  
  // Drive Slider - DEFAULT TO 0%
  const driveSlider = document.querySelector('.drive-slider-range');
if (driveSlider) {
  driveSlider.value = 0.5; // Set to 50% (unity gain)
  driveSlider.addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    
    // Show tooltip on top
    createTooltipForSlider(e.target, `Drive: ${Math.round(value * 100)}%`, 'top');
    
    if (filterManager) {
      // Drive slider controls inputGain for LP24/LP12/LH12, but LH18 needs setDrive
      filterManager.setInputGain(value);
    }
  });
  
  // Hide tooltip on release
  driveSlider.addEventListener('mouseup', () => hideTooltipForSlider(driveSlider));
  driveSlider.addEventListener('touchend', () => hideTooltipForSlider(driveSlider));
  
  // Initialize the filter with the default value
  if (filterManager) {
    filterManager.setInputGain(0.5);
  }
}
  
  // Variant Slider - DEFAULT TO 50% (unity)
  const variantSlider = document.querySelector('.variant-slider-range');
  if (variantSlider) {
    variantSlider.value = 1.0; // Set to 100% (maximum)
    variantSlider.addEventListener('input', (e) => {
      let value = parseFloat(e.target.value);
      
      // Check if this slider has active macro modulation FIRST
      const destination = knobToDestinationMap['filter-variant'];
      if (destination && destinationConnections[destination] && destinationModulations[destination] !== undefined) {
        const multiplier = destinationModulations[destination];
        
        // Apply multiplier
        value = value * multiplier;
        
        // Clamp to 0-1 range
        value = Math.max(0, Math.min(1, value));
        
        console.log(`Filter variant modulated: multiplier=${multiplier.toFixed(2)}, final=${value.toFixed(2)}`);
      }
      
      // Create dynamic tooltip based on current filter type and MODULATED value
      let tooltipText;
      if (currentFilterType === 'lp12') {
        tooltipText = `Diode: ${Math.round(value * 100)}%`;
      } else if (currentFilterType === 'lp24') {
        tooltipText = `Bass Compensation: ${Math.round(value * 100)}%`;
      } else if (currentFilterType.startsWith('lh')) {
        // For LH filters, show high-pass frequency (16kHz at 0 to 8Hz at 1, logarithmic)
        const frequency = 16000 * Math.pow(8/16000, value);
        tooltipText = `High Pass: ${Math.round(frequency)} Hz`;
      } else {
        tooltipText = `Variant: ${Math.round(value * 100)}%`;
      }
      
      createTooltipForSlider(e.target, tooltipText, 'bottom');
      
      if (filterManager) {
        filterManager.setVariant(value);
      }
    });
    
    // Hide tooltip on release
    variantSlider.addEventListener('mouseup', () => hideTooltipForSlider(variantSlider));
    variantSlider.addEventListener('touchend', () => hideTooltipForSlider(variantSlider));
  }
  
  // Check if ADSR knob exists, create it if not
  let adsrKnob = document.getElementById('adsr-knob');
  if (!adsrKnob) {
    console.log("Creating missing ADSR knob element");
    const filterControls = document.querySelector('.filter-bottom-controls');
    if (filterControls) {
      const knobContainer = document.createElement('div');
      knobContainer.className = 'filter-knob-container';
      
      adsrKnob = document.createElement('div');
      adsrKnob.id = 'adsr-knob';
      adsrKnob.className = 'knob';
      
      const label = document.createElement('label');
      label.htmlFor = 'adsr-knob';
      label.textContent = 'ADSR';
      
      knobContainer.appendChild(adsrKnob);
      knobContainer.appendChild(label);
      filterControls.appendChild(knobContainer);
    }
  }
  
 
  
  // Do the same for keytrack knob
  let keytrackKnob = document.getElementById('keytrack-knob');
  if (!keytrackKnob) {
    console.log("Creating missing keytrack knob element");
    const filterControls = document.querySelector('.filter-bottom-controls');
    if (filterControls) {
      const knobContainer = document.createElement('div');
      knobContainer.className = 'filter-knob-container';
      
      keytrackKnob = document.createElement('div');
      keytrackKnob.id = 'keytrack-knob';
      keytrackKnob.className = 'knob';
      
      const label = document.createElement('label');
      label.htmlFor = 'keytrack-knob';
      label.textContent = 'Key-Track';
      
      knobContainer.appendChild(keytrackKnob);
      knobContainer.appendChild(label);
      filterControls.appendChild(knobContainer);
    }
  }
  
  
  
  console.log("Filter controls initialized with correct defaults");
}
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
function noteHasActiveTimeout(note) {
    if (!note || !note.scheduledEvents) return false;
    return note.scheduledEvents.some(event => 
        event.type === "timeout" && activeSynthTimers.has(event.id)
    );
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
const VOICE_PAN_LIMIT = 0.08; // 8% pan variation
const VOICE_DETUNE_LIMIT = 20; // 20 cents max detune
const WARBLE_SETTLE_TIME = 0.15; // 150ms to settle

let masterClockNode = null;
let masterClockSharedBuffer = null;
let masterClockPhases = null;
// Add this after the masterGain initialization
let currentVolume = 0.5; // Initial volume
masterGain.gain.setValueAtTime(currentVolume, audioCtx.currentTime, 0.01);
// Add these global variables at the top with other audio-related variables
// Add to your global variables
let currentSampleDetune = 0; // Range will be -1200 to +1200 cents
let currentMonoSamplerVoice = null;
let isEmuModeOn = false;
let isSampleKeyTrackingOn = true;
let mediaRecorder = null;
let isSampleReversed = false;
let isModeTransitioning = false;
let originalBuffer = null;
let audioBuffer = null; // <<< ADD THIS LINE: Initialize audioBuffer to null
let recordedChunks = [];
let isRecording = false;
let recordingMode = 'external'; // 'internal' or 'external'
let internalRecordingNode = null;
let internalRecordingDestination = null;
let externalRecorder = null; // <<< ADD THIS LINE
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
let glideTime = 0.0; // seconds
let heldNotes = []; // Keep track of held notes in mono mode
let nodeMonitorInterval = null; // To store the interval ID
const activeSynthTimers = new Set(); // <<< ADD: Track active setTimeout IDs

// --- Modulation Routing System ---
// Combined list of all 26 destinations (13 from each slider)
const modulationDestinations = [
  // First slider (LFO destinations)
  'Sampler Pitch',
  'Osc 1 Pitch',
  'Osc 2 Pitch',
  'Sampler Gain',
  'Osc 1 Gain',
  'Osc 2 Gain',
  'Osc 1 PWM',
  'Osc 2 PWM',
  'Osc 1 Quant',
  'Osc 2 Quant',
  'Osc 1 FM',
  'Osc 2 FM',
  'Overload',
  // Second slider (additional destinations) - MUST MATCH HTML EXACTLY
  'Lo-Fi',
  'Speed',
  'Jump',
  'Filter',
  'Stutter',
  'Pitch',
  'Delay Time',
  'Warp',
  'Feedback',
  'Cutoff',
  'Variant',
  'Resonance',
  'Lo-Fi Amt'
];

let currentModSource = null; // 'MOD', 'LFO', '1', '2', '3', '4' - initially none selected
let currentDestinationIndex = 0; // 0-25 matching combined slider positions
let currentDestinationName = 'Sampler Pitch'; // Track the actual destination name
let destinationConnections = {}; // Format: { 'Sampler Pitch': 'MOD', 'Osc 1 Pitch': 'LFO', ... }
let destinationDepths = {}; // Format: { 'Sampler Pitch': 0.5, 'Osc 1 Pitch': 0.8, ... } - stores depth for each destination

// Store reference to the depth knob control for programmatic updates
let matrixDepthKnobControl = null;

// Macro knob values (0-1 range)
let macroValues = {
  '1': 0.5,
  '2': 0.5,
  '3': 0.5,
  '4': 0.5
};

// LFO System
let lfoOscillator = null;
let lfoGain = null;
let lfoRate = 1.0; // Hz
let lfoFade = 0.0; // 0-1 fade-in time (0=instant, 1=5 seconds) - applied per-voice
let lfoDepth = 1.0; // 0-1 polarity control: 0=negative, 0.5=off, 1=positive
window.lfoShape = 0; // 0=triangle, 1=square, 2=random, 3=sine, 4=saw (global for uiPlaceholders.js)
let lfoValue = 0.5; // Current LFO output value (0-1)
let lfoUpdateInterval = null;
// Note: lfoFadeStartTime is now tracked per-voice in the voice pool

// Store the current modulation amount for each destination (bipolar -1 to +1)
let destinationModulations = {};

// Initialize - each destination can be connected to one source at a time
function initializeModulationConnections() {
  modulationDestinations.forEach(dest => {
    destinationConnections[dest] = null; // null means no connection
    destinationDepths[dest] = 0.5; // Default depth to 50% (middle position)
    destinationModulations[dest] = 0; // Default modulation is 0 (no modulation)
  });
}

/**
 * Initialize the global LFO oscillator
 */
function initializeLFO() {
  // Create LFO oscillator and gain
  lfoGain = audioCtx.createGain();
  lfoGain.gain.value = lfoDepth;
  
  // Start the LFO
  restartLFO();
  
  // Start update loop using requestAnimationFrame (more efficient than setInterval)
  function lfoUpdate() {
    applyLFOModulation();
    lfoUpdateInterval = requestAnimationFrame(lfoUpdate);
  }
  lfoUpdate();
  
  console.log('LFO initialized');
}

/**
 * Restart the LFO with current shape and rate
 */
function restartLFO() {
  // Note: We don't actually use Web Audio oscillators here
  // The LFO is calculated mathematically in applyLFOModulation()
  // This function exists for future implementation with AudioWorklet
  console.log(`LFO restarted: shape=${lfoShape}, rate=${lfoRate.toFixed(2)} Hz`);
}

/**
 * Apply LFO modulation to all connected destinations (per-voice fade-in)
 */
function applyLFOModulation() {
  // Check if LFO source has ANY connections
  const hasAnyConnections = Object.values(destinationConnections).some(source => source === 'LFO');
  if (!hasAnyConnections) {
    return; // No connections, skip processing
  }
  
  // Calculate LFO value (0-1 range) - shared across all voices
  const now = audioCtx.currentTime;
  const phase = (now * lfoRate) % 1.0;
  
  // Debug: Log shape periodically
  if (!applyLFOModulation.lastLog || now - applyLFOModulation.lastLog > 1.0) {
    const shapeNames = ['Triangle', 'Square', 'Random', 'Sine', 'Sawtooth'];
    console.log(`LFO: shape=${shapeNames[window.lfoShape]}, rate=${lfoRate.toFixed(2)}Hz, phase=${phase.toFixed(2)}`);
    applyLFOModulation.lastLog = now;
  }
  
  // Calculate waveform value based on shape
  let rawValue;
  switch (window.lfoShape) {
    case 0: // Triangle
      rawValue = phase < 0.5 ? phase * 2 : 2 - (phase * 2);
      break;
    case 1: // Square
      rawValue = phase < 0.5 ? 0 : 1;
      break;
    case 2: // Random (sample & hold)
      // Random changes once per cycle
      if (Math.floor(now * lfoRate) !== Math.floor((now - 0.02) * lfoRate)) {
        lfoValue = Math.random();
      }
      rawValue = lfoValue;
      break;
    case 3: // Sine
      rawValue = (Math.sin(phase * Math.PI * 2) + 1) / 2;
      break;
    case 4: // Sawtooth
      rawValue = phase;
      break;
    default:
      rawValue = 0.5;
  }
  
  lfoValue = rawValue;
  
  // Calculate per-voice fade multipliers and use their average
  // This allows each voice to have independent fade-in while sharing one LFO
  let totalFadeMultiplier = 0;
  let activeVoiceCount = 0;
  
  if (lfoFade > 0) {
    const maxFadeTime = 5.0; // 5 seconds at fade = 1.0
    const fadeTime = lfoFade * maxFadeTime;
    
    // Check all oscillator voices
    voicePool.forEach(voice => {
      if (voice.state === 'active' && voice.lfoFadeStartTime !== null) {
        activeVoiceCount++;
        const elapsedTime = now - voice.lfoFadeStartTime;
        
        if (elapsedTime < fadeTime) {
          // Exponential fade-in: starts slow, speeds up towards the end
          // Using x^3 curve for increasingly exponential behavior
          const linearProgress = elapsedTime / fadeTime; // 0 to 1
          const voiceFadeMultiplier = linearProgress * linearProgress * linearProgress; // cubic curve
          totalFadeMultiplier += voiceFadeMultiplier;
        } else {
          // This voice has completed its fade
          totalFadeMultiplier += 1.0;
        }
      }
    });
    
    // Also check sampler voices
    samplerVoicePool.forEach(voice => {
      if (voice.state === 'playing' && voice.lfoFadeStartTime !== null) {
        activeVoiceCount++;
        const elapsedTime = now - voice.lfoFadeStartTime;
        
        if (elapsedTime < fadeTime) {
          const linearProgress = elapsedTime / fadeTime;
          const voiceFadeMultiplier = linearProgress * linearProgress * linearProgress;
          totalFadeMultiplier += voiceFadeMultiplier;
        } else {
          totalFadeMultiplier += 1.0;
        }
      }
    });
  }
  
  // Calculate average fade multiplier across all active voices
  const fadeMultiplier = activeVoiceCount > 0 ? totalFadeMultiplier / activeVoiceCount : 1.0;
  
  // Apply LFO Depth as polarity control:
  // lfoDepth = 0.0 -> negative polarity (inverted)
  // lfoDepth = 0.5 -> no modulation (centered)
  // lfoDepth = 1.0 -> positive polarity (normal)
  
  // Convert lfoDepth (0-1) to polarity (-1 to +1, with 0 at 0.5)
  const polarity = (lfoDepth - 0.5) * 2; // -1 to +1
  
  // Apply fade multiplier to polarity (fade affects the strength of modulation)
  const fadedPolarity = polarity * fadeMultiplier;
  
  // Apply polarity to LFO value
  // When fadedPolarity = 0, output stays at 1.0 (no modulation)
  // When fadedPolarity = +1, output ranges 0-2
  // When fadedPolarity = -1, output ranges 2-0 (inverted)
  let polarizedValue;
  if (fadedPolarity >= 0) {
    // Positive polarity: fade from 1.0 (no mod) to full modulation
    polarizedValue = 1.0 + (lfoValue - 0.5) * 2 * fadedPolarity;
  } else {
    // Negative polarity: invert the LFO
    polarizedValue = 1.0 - (lfoValue - 0.5) * 2 * Math.abs(fadedPolarity);
  }
  
  // Apply modulation to all connected destinations
  modulationDestinations.forEach(destination => {
    const connectedSource = destinationConnections[destination];
    
    if (connectedSource === 'LFO') {
      const matrixDepth = destinationDepths[destination];
      
      // Matrix depth scales the polarized modulation amount
      const scaledMultiplier = 1.0 + ((polarizedValue - 1.0) * matrixDepth);
      
      // Use the same applyModulationToDestination function that macros use
      // This handles both knobs and sliders uniformly
      applyModulationToDestination(destination, scaledMultiplier);
    }
  });
}

// --- MOD Canvas Modulation System ---
let modCanvasMode = 'lfo'; // 'env', 'lfo', or 'trig'
let modCanvasRate = 1.0; // Hz for LFO mode
let modCanvasValue = 0.5; // Current canvas output value (0-1)
let modCanvasPhase = 0.0; // Current phase (0-1) for LFO mode
let modCanvasUpdateInterval = null;

/**
 * Initialize the MOD canvas modulation system
 */
function initializeModCanvasModulation() {
  // Start update loop for MOD canvas
  function modCanvasUpdate() {
    if (modCanvasMode === 'lfo') {
      applyMODCanvasModulation();
    } else if (modCanvasMode === 'env') {
      applyMODCanvasEnvelopeModulation();
    } else if (modCanvasMode === 'trig') {
      applyMODCanvasTrigModulation();
    }
    modCanvasUpdateInterval = requestAnimationFrame(modCanvasUpdate);
  }
  modCanvasUpdate();
  
  console.log('MOD Canvas modulation system initialized');
}

/**
 * Sample the canvas waveform at a specific X position (0-1)
 * Returns Y value normalized to 0-1 range (0 = top, 1 = bottom)
 */
function sampleCanvasWaveform(xPosition) {
  const points = getModulationPoints();
  if (!points || points.length < 2) {
    return 0.5; // Default to middle if no points
  }
  
  // Get canvas dimensions from the first point's context
  const modCanvasElement = document.getElementById('mod-canvas');
  if (!modCanvasElement) return 0.5;
  
  const canvasWidth = modCanvasElement.width;
  const canvasHeight = modCanvasElement.height;
  
  // Convert xPosition (0-1) to canvas X coordinate
  const targetX = xPosition * canvasWidth;
  
  // Find the two points that bracket targetX
  let startPoint = null;
  let endPoint = null;
  
  for (let i = 0; i < points.length - 1; i++) {
    if (targetX >= points[i].x && targetX <= points[i + 1].x) {
      startPoint = points[i];
      endPoint = points[i + 1];
      break;
    }
  }
  
  // If targetX is beyond the last point, use the last segment
  if (!startPoint && points.length >= 2) {
    startPoint = points[points.length - 2];
    endPoint = points[points.length - 1];
  }
  
  if (!startPoint || !endPoint) {
    return 0.5;
  }
  
  // Calculate Y value based on curve type
  let yValue;
  
  if (startPoint.noCurve) {
    // Linear interpolation
    const t = (targetX - startPoint.x) / (endPoint.x - startPoint.x);
    yValue = startPoint.y + t * (endPoint.y - startPoint.y);
  } else {
    // Quadratic bezier curve interpolation
    const cpX = startPoint.curveX || (startPoint.x + endPoint.x) / 2;
    const cpY = startPoint.curveY || (startPoint.y + endPoint.y) / 2;
    
    // Solve for t using quadratic formula (approximate)
    const t = (targetX - startPoint.x) / (endPoint.x - startPoint.x);
    
    // Calculate Y using bezier formula
    yValue = Math.pow(1 - t, 2) * startPoint.y + 
             2 * (1 - t) * t * cpY + 
             Math.pow(t, 2) * endPoint.y;
  }
  
  // Normalize Y to 0-1 range (invert because canvas Y is top-down)
  // Account for 1px padding: Y ranges from 1 to (height - 1)
  const padding = 1;
  const effectiveHeight = canvasHeight - (2 * padding);
  const adjustedY = yValue - padding;
  const normalizedValue = 1.0 - (adjustedY / effectiveHeight);
  
  // Clamp to 0-1 range
  return Math.max(0, Math.min(1, normalizedValue));
}

/**
 * Apply MOD canvas modulation to all connected destinations (LFO mode)
 */
function applyMODCanvasModulation() {
  // Check if MOD source has ANY connections
  const hasAnyConnections = Object.values(destinationConnections).some(source => source === 'MOD');
  if (!hasAnyConnections) {
    return; // No connections, skip processing
  }
  
  // Only process in LFO mode
  if (modCanvasMode !== 'lfo') {
    return;
  }
  
  // Update phase based on rate
  const now = audioCtx.currentTime;
  const deltaTime = 1 / 60; // Assuming 60 FPS
  modCanvasPhase = (modCanvasPhase + (modCanvasRate * deltaTime)) % 1.0;
  
  // Sample the canvas waveform at current phase
  modCanvasValue = sampleCanvasWaveform(modCanvasPhase);
  
  // Convert 0-1 value to bipolar modulation (-1 to +1 becomes 0 to 2 as multiplier)
  // modCanvasValue 0 = minimum (multiplier 0)
  // modCanvasValue 0.5 = no modulation (multiplier 1.0)
  // modCanvasValue 1 = maximum (multiplier 2.0)
  const polarizedValue = modCanvasValue * 2.0;
  
  // Apply modulation to all connected destinations
  modulationDestinations.forEach(destination => {
    const connectedSource = destinationConnections[destination];
    
    if (connectedSource === 'MOD') {
      const matrixDepth = destinationDepths[destination];
      
      // Matrix depth scales the polarized modulation amount
      const scaledMultiplier = 1.0 + ((polarizedValue - 1.0) * matrixDepth);
      
      // Apply modulation to destination
      applyModulationToDestination(destination, scaledMultiplier);
    }
  });
}

/**
 * Apply MOD canvas modulation to all connected destinations (ENV mode - per-voice envelope)
 */
function applyMODCanvasEnvelopeModulation() {
  // Check if MOD source has ANY connections
  const hasAnyConnections = Object.values(destinationConnections).some(source => source === 'MOD');
  if (!hasAnyConnections) {
    return; // No connections, skip processing
  }
  
  const now = audioCtx.currentTime;
  
  // Find the MOST RECENTLY STARTED voice, prioritizing 'active' over 'releasing'
  // This ensures new notes control the modulation, but releasing notes continue if no active notes
  let newestActiveVoicePhase = null;
  let newestActiveVoiceStartTime = -Infinity;
  let newestReleasingVoicePhase = null;
  let newestReleasingVoiceStartTime = -Infinity;
  let hasActiveVoice = false;
  let hasReleasingVoice = false;
  
  // Process oscillator voices
  voicePool.forEach(voice => {
    if (voice.modCanvasEnvStartTime !== null) {
      // Calculate phase for this voice
      let phase;
      if (voice.modCanvasEnvComplete) {
        phase = voice.modCanvasEnvPhase;
      } else {
        const elapsedTime = now - voice.modCanvasEnvStartTime;
        const envelopeDuration = 1.0 / modCanvasRate;
        phase = elapsedTime / envelopeDuration;
        
        if (phase >= 1.0) {
          voice.modCanvasEnvPhase = 1.0;
          voice.modCanvasEnvComplete = true;
          phase = 1.0;
        } else {
          voice.modCanvasEnvPhase = phase;
        }
      }
      
      // Track newest voice by state priority
      if (voice.state === 'active') {
        hasActiveVoice = true;
        if (voice.modCanvasEnvStartTime > newestActiveVoiceStartTime) {
          newestActiveVoiceStartTime = voice.modCanvasEnvStartTime;
          newestActiveVoicePhase = phase;
        }
      } else if (voice.state === 'releasing') {
        hasReleasingVoice = true;
        if (voice.modCanvasEnvStartTime > newestReleasingVoiceStartTime) {
          newestReleasingVoiceStartTime = voice.modCanvasEnvStartTime;
          newestReleasingVoicePhase = phase;
        }
      }
    }
  });
  
  // Process sampler voices
  samplerVoicePool.forEach(voice => {
    if (voice.modCanvasEnvStartTime !== null) {
      // Calculate phase for this voice
      let phase;
      if (voice.modCanvasEnvComplete) {
        phase = voice.modCanvasEnvPhase;
      } else {
        const elapsedTime = now - voice.modCanvasEnvStartTime;
        const envelopeDuration = 1.0 / modCanvasRate;
        phase = elapsedTime / envelopeDuration;
        
        if (phase >= 1.0) {
          voice.modCanvasEnvPhase = 1.0;
          voice.modCanvasEnvComplete = true;
          phase = 1.0;
        } else {
          voice.modCanvasEnvPhase = phase;
        }
      }
      
      // Track newest voice by state priority
      if (voice.state === 'active' || voice.state === 'playing') {
        hasActiveVoice = true;
        if (voice.modCanvasEnvStartTime > newestActiveVoiceStartTime) {
          newestActiveVoiceStartTime = voice.modCanvasEnvStartTime;
          newestActiveVoicePhase = phase;
        }
      } else if (voice.state === 'releasing') {
        hasReleasingVoice = true;
        if (voice.modCanvasEnvStartTime > newestReleasingVoiceStartTime) {
          newestReleasingVoiceStartTime = voice.modCanvasEnvStartTime;
          newestReleasingVoicePhase = phase;
        }
      }
    }
  });
  
  // Determine which phase to use: prioritize active voices, fall back to releasing
  let envelopePhase;
  if (hasActiveVoice && newestActiveVoicePhase !== null) {
    envelopePhase = newestActiveVoicePhase;
  } else if (hasReleasingVoice && newestReleasingVoicePhase !== null) {
    envelopePhase = newestReleasingVoicePhase;
  } else {
    // No voices at all - hold at last envelope phase to prevent ramping on retrigger
    return;
  }
  
  // Sample the canvas waveform at this phase
  modCanvasValue = sampleCanvasWaveform(envelopePhase);
  
  // Convert 0-1 value to bipolar modulation (0 to 2 as multiplier)
  const polarizedValue = modCanvasValue * 2.0;
  
  // Apply modulation to all connected destinations
  modulationDestinations.forEach(destination => {
    const connectedSource = destinationConnections[destination];
    
    if (connectedSource === 'MOD') {
      const matrixDepth = destinationDepths[destination];
      
      // Matrix depth scales the polarized modulation amount
      const scaledMultiplier = 1.0 + ((polarizedValue - 1.0) * matrixDepth);
      
      // Apply modulation to destination
      applyModulationToDestination(destination, scaledMultiplier);
    }
  });
}

/**
 * Apply MOD canvas modulation to all connected destinations (TRIG mode - retriggerable looping envelope)
 * TRIG mode combines features of ENV and LFO:
 * - Resets phase to 0 on each keypress (like ENV)
 * - Loops continuously at the set rate (like LFO)
 * - Newest voice controls modulation (like ENV)
 */
function applyMODCanvasTrigModulation() {
  // Check if MOD source has ANY connections
  const hasAnyConnections = Object.values(destinationConnections).some(source => source === 'MOD');
  if (!hasAnyConnections) {
    return; // No connections, skip processing
  }
  
  const now = audioCtx.currentTime;
  
  // Find the MOST RECENTLY STARTED voice, prioritizing 'active' over 'releasing'
  let newestActiveVoicePhase = null;
  let newestActiveVoiceStartTime = -Infinity;
  let newestReleasingVoicePhase = null;
  let newestReleasingVoiceStartTime = -Infinity;
  let hasActiveVoice = false;
  let hasReleasingVoice = false;
  
  // Process oscillator voices
  voicePool.forEach(voice => {
    if (voice.modCanvasTrigStartTime !== null) {
      // Calculate phase for this voice - loops continuously
      const elapsedTime = now - voice.modCanvasTrigStartTime;
      const trigDuration = 1.0 / modCanvasRate;
      
      // Calculate looping phase (0-1, wraps around)
      let phase = (elapsedTime / trigDuration) % 1.0;
      voice.modCanvasTrigPhase = phase;
      
      // Track newest voice by state priority
      if (voice.state === 'active') {
        hasActiveVoice = true;
        if (voice.modCanvasTrigStartTime > newestActiveVoiceStartTime) {
          newestActiveVoiceStartTime = voice.modCanvasTrigStartTime;
          newestActiveVoicePhase = phase;
        }
      } else if (voice.state === 'releasing') {
        hasReleasingVoice = true;
        if (voice.modCanvasTrigStartTime > newestReleasingVoiceStartTime) {
          newestReleasingVoiceStartTime = voice.modCanvasTrigStartTime;
          newestReleasingVoicePhase = phase;
        }
      }
    }
  });
  
  // Process sampler voices
  samplerVoicePool.forEach(voice => {
    if (voice.modCanvasTrigStartTime !== null) {
      // Calculate phase for this voice - loops continuously
      const elapsedTime = now - voice.modCanvasTrigStartTime;
      const trigDuration = 1.0 / modCanvasRate;
      
      // Calculate looping phase (0-1, wraps around)
      let phase = (elapsedTime / trigDuration) % 1.0;
      voice.modCanvasTrigPhase = phase;
      
      // Track newest voice by state priority
      if (voice.state === 'active' || voice.state === 'playing') {
        hasActiveVoice = true;
        if (voice.modCanvasTrigStartTime > newestActiveVoiceStartTime) {
          newestActiveVoiceStartTime = voice.modCanvasTrigStartTime;
          newestActiveVoicePhase = phase;
        }
      } else if (voice.state === 'releasing') {
        hasReleasingVoice = true;
        if (voice.modCanvasTrigStartTime > newestReleasingVoiceStartTime) {
          newestReleasingVoiceStartTime = voice.modCanvasTrigStartTime;
          newestReleasingVoicePhase = phase;
        }
      }
    }
  });
  
  // Determine which phase to use: prioritize active voices, fall back to releasing
  let trigPhase;
  if (hasActiveVoice && newestActiveVoicePhase !== null) {
    trigPhase = newestActiveVoicePhase;
  } else if (hasReleasingVoice && newestReleasingVoicePhase !== null) {
    trigPhase = newestReleasingVoicePhase;
  } else {
    // No voices at all - hold at last phase
    return;
  }
  
  // Sample the canvas waveform at this phase
  modCanvasValue = sampleCanvasWaveform(trigPhase);
  
  // Convert 0-1 value to bipolar modulation (0 to 2 as multiplier)
  const polarizedValue = modCanvasValue * 2.0;
  
  // Apply modulation to all connected destinations
  modulationDestinations.forEach(destination => {
    const connectedSource = destinationConnections[destination];
    
    if (connectedSource === 'MOD') {
      const matrixDepth = destinationDepths[destination];
      
      // Matrix depth scales the polarized modulation amount
      const scaledMultiplier = 1.0 + ((polarizedValue - 1.0) * matrixDepth);
      
      // Apply modulation to destination
      applyModulationToDestination(destination, scaledMultiplier);
    }
  });
}

let sampleSource = null;
let isPlaying = false;
let filterManager = null;
let sampleStartPosition = 0; // 0-1 range representing portion of audio file
let sampleEndPosition = 1;   // 0-1 range (default to full sample)
let sampleCrossfadeAmount = 0.02; // 0-1 range for crossfade percentage
let isSampleLoopOn = true; // Will now be controlled by crossfade knob
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
let currentSampleGain = 1.0; // Add this with other global variables
let currentSamplePosition = 0; // Add this with other global variables
const knobDefaults = {
'sample-start-knob': 0.0,     // Start at beginning of sample
'sample-end-knob': 1.0,       // End at end of sample
'sample-crossfade-knob': 0.02, // No crossfade initially
'sample-volume-knob': 0.005,   // 100% default volume for samples
'glide-time-knob': 0.00,      // 100ms (5% of 2000ms)
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
'mod-depth-knob': 1.0, // LFO Depth: 1.0 = positive polarity (default)
'mod-rate-knob': 0.5, // MOD Canvas Rate: 1 Hz (middle position)
// ADD FILTER KNOBS
    'adsr-knob': 0.5, // 50% = unity
    'keytrack-knob': 0.5, // 50% = unity
    'drive-slider-range': 0.5,
};
// Try to create SharedArrayBuffer for clock synchronization
function initializeMasterClock() {
    // Check if SharedArrayBuffer is available (requires CORS headers)
    let sharedBuffer = null;
    try {
        sharedBuffer = new SharedArrayBuffer(8); // 2 floats (phase1, phase2)
        masterClockPhases = new Float32Array(sharedBuffer);
        console.log('SharedArrayBuffer available for master clock');
    } catch (e) {
        console.log('SharedArrayBuffer not available, using message passing for clock sync');
    }
    
    // Load the master clock processor
    const clockProcessorPromise = audioCtx.audioWorklet.addModule('js/master-clock-processor.js')
        .then(() => {
            console.log('Master clock processor loaded');
            
            // Create the master clock node
            masterClockNode = new AudioWorkletNode(audioCtx, 'master-clock-processor', {
                processorOptions: {
                    sharedBuffer: sharedBuffer
                }
            });
            
            // Don't connect to output by default (silent operation)
            // Uncomment next line to hear the master clocks for debugging
            // masterClockNode.connect(masterGain);
            
            // Listen for phase updates (for UI or fallback)
            masterClockNode.port.onmessage = (event) => {
                if (event.data.type === 'phaseUpdate') {
                    // Update local phase tracking for UI or debugging
                    if (!sharedBuffer) {
                        // Broadcast phases to voice processors if no shared memory
                        voicePool.forEach(voice => {
                            if (voice.osc1Note?.workletNode) {
                                voice.osc1Note.workletNode.port.postMessage({
                                    type: 'phaseUpdate',
                                    phase1: event.data.phase1,
                                    phase2: event.data.phase2
                                });
                            }
                            if (voice.osc2Note?.workletNode) {
                                voice.osc2Note.workletNode.port.postMessage({
                                    type: 'phaseUpdate',
                                    phase1: event.data.phase1,
                                    phase2: event.data.phase2
                                });
                            }
                        });
                    }
                }
            };
            
            masterClockSharedBuffer = sharedBuffer;
            return true;
        })
        .catch(error => {
            console.error('Failed to load master clock processor:', error);
            return false;
        });
    
    // Load the Juno voice processor
    const voiceProcessorPromise = audioCtx.audioWorklet.addModule('js/juno-voice-processor.js')
        .then(() => {
            console.log('Juno voice processor loaded');
            return true;
        })
        .catch(error => {
            console.error('Failed to load Juno voice processor:', error);
            return false;
        });
    
    return Promise.all([clockProcessorPromise, voiceProcessorPromise]);
}
// --- Helper Functions ---
// Update helper function to map waveform names to Juno parameters
function getJunoWaveformParams(waveformName) {
    switch(waveformName) {
        case 'sine':
            return { sawLevel: 0, pulseLevel: 0, sineLevel: 1, triangleLevel: 0, pulseWidth: 0.5 };
        case 'sawtooth':
            return { sawLevel: 1, pulseLevel: 0, sineLevel: 0, triangleLevel: 0, pulseWidth: 0.5 };
        case 'triangle':
            return { sawLevel: 0, pulseLevel: 0, sineLevel: 0, triangleLevel: 1, pulseWidth: 0.5 };
        case 'square':
            return { sawLevel: 0, pulseLevel: 1, sineLevel: 0, triangleLevel: 0, pulseWidth: 0.5 };
        case 'pulse':
            return { sawLevel: 0, pulseLevel: 1, sineLevel: 0, triangleLevel: 0, pulseWidth: 0.25 }; // 25% duty cycle
        default:
            return { sawLevel: 1, pulseLevel: 0, sineLevel: 0, triangleLevel: 0, pulseWidth: 0.5 };
    }
}
function restartSamplerFMSources() {
    const now = audioCtx.currentTime;
    
    voicePool.forEach(voice => {
        if (voice.state !== 'inactive') {
            // Check OSC1 FM
            if (osc1FMSource === 'sampler' && 
                voice.osc1Note && 
                voice.osc1Note.fmModulatorSource instanceof AudioBufferSourceNode) {
                
                // Check if the source has ended (playback state would be 'finished')
                // We need to restart it
                console.log(`Restarting OSC1 FM sampler source for voice ${voice.id}`);
                updateOsc1FmModulatorParameters(voice.osc1Note, now, voice);
            }
            
            // Check OSC2 FM
            if (osc2FMSource === 'sampler' && 
                voice.osc2Note && 
                voice.osc2Note.fmModulatorSource instanceof AudioBufferSourceNode) {
                
                console.log(`Restarting OSC2 FM sampler source for voice ${voice.id}`);
                updateOsc2FmModulatorParameters(voice.osc2Note, now, voice);
            }
        }
    });
}
function ensureSamplerFmTapsExist() {
    voicePool.forEach(voice => {
        if (voice.samplerNote) {
            // Create FM tap if missing
            if (!voice.samplerNote.fmTap) {
                console.log(`Creating missing FM tap for voice ${voice.id}`);
                voice.samplerNote.fmTap = audioCtx.createGain();
                voice.samplerNote.fmTap.gain.value = 1.0;
            }
            
            // If there's a source and sampleNode but no connection to fmTap
            if (voice.samplerNote.source && voice.samplerNote.sampleNode) {
                try {
                    // Reconnect the chain properly
                    voice.samplerNote.sampleNode.disconnect();
                    voice.samplerNote.sampleNode.connect(voice.samplerNote.fmTap);
                    voice.samplerNote.fmTap.connect(voice.samplerNote.gainNode);
                    console.log(`Rebuilt FM tap connections for voice ${voice.id}`);
                } catch (e) {
                    console.error(`Error connecting FM tap: ${e.message}`);
                }
            }
        }
    });
}
// Add this function to explicitly ensure FM connections are made
function forceFMConnectionUpdate() {
    console.log("Force-updating all FM connections...");
    const now = audioCtx.currentTime;
    
    // First make sure all FM taps exist
    voicePool.forEach(voice => {
        if (voice.samplerNote) {
            // Create FM tap if missing
            if (!voice.samplerNote.fmTap) {
                voice.samplerNote.fmTap = audioCtx.createGain();
                voice.samplerNote.fmTap.gain.value = 1.0;
            }
            
            // Ensure proper connections
            if (voice.samplerNote.source && voice.samplerNote.sampleNode) {
                try {
                    // Disconnect and reconnect to ensure correct signal path
                    voice.samplerNote.sampleNode.disconnect();
                    voice.samplerNote.sampleNode.connect(voice.samplerNote.fmTap);
                    voice.samplerNote.fmTap.connect(voice.samplerNote.gainNode);
                    console.log(`Rebuilt FM connections for voice ${voice.id}`);
                } catch (e) {
                    console.error(`Error connecting FM tap: ${e.message}`);
                }
            }
        }
    });
    
    // Then force FM update on all voices, even with zero depth
    voicePool.forEach(voice => {
        if (voice.osc1Note) {
            // Force non-zero FM amount temporarily to ensure connections are made
            const savedAmount = osc1FMAmount;
            if (osc1FMAmount <= 0.001) osc1FMAmount = 0.002;
            updateOsc1FmModulatorParameters(voice.osc1Note, now, voice);
            osc1FMAmount = savedAmount; // Restore
        }
        
        if (voice.osc2Note) {
            // Force non-zero FM amount temporarily to ensure connections are made
            const savedAmount = osc2FMAmount;
            if (osc2FMAmount <= 0.001) osc2FMAmount = 0.002;
            updateOsc2FmModulatorParameters(voice.osc2Note, now, voice);
            osc2FMAmount = savedAmount; // Restore
        }
    });
}
// Add this function to your code to check if a new FM source needs to be created
function refreshFMSources() {
    const now = audioCtx.currentTime;
    
    // Check all voices and refresh their FM sources if needed
    voicePool.forEach(voice => {
        if (voice.state !== 'inactive') {
            // Check OSC1 FM
            if (osc1FMSource === 'sampler' && voice.osc1Note) {
                const osc1Note = voice.osc1Note;
                
                // Create a new FM source if needed
                if (!osc1Note.fmModulatorSource || 
                    !(osc1Note.fmModulatorSource instanceof AudioBufferSourceNode) ||
                    !audioBuffer) {
                    updateOsc1FmModulatorParameters(osc1Note, now, voice);
                }
            }
            
            // Check OSC2 FM
            if (osc2FMSource === 'sampler' && voice.osc2Note) {
                const osc2Note = voice.osc2Note;
                
                // Create a new FM source if needed
                if (!osc2Note.fmModulatorSource || 
                    !(osc2Note.fmModulatorSource instanceof AudioBufferSourceNode) ||
                    !audioBuffer) {
                    updateOsc2FmModulatorParameters(osc2Note, now, voice);
                }
            }
        }
    });
}
function verifyFilterType() {
  if (!filterManager) return;
  
  const currentType = filterManager.currentFilterType;
  console.log(`VERIFICATION: Current filter type is ${currentType}`);
  
  // Force a parameter change to trigger logging in the processor
  if (currentType === 'lp12') {
    // Apply a small resonance change to trigger LP-12 processor logs
    const currentRes = filterManager.resonance;
    filterManager.setResonance(Math.min(1, currentRes + 0.01));
    filterManager.setResonance(currentRes);
    
    // Apply a small cutoff change to trigger LP-12 processor logs
    const currentCutoff = filterManager.cutoff;
    filterManager.setCutoff(Math.min(16000, currentCutoff + 10));
    
    console.log(`VERIFICATION: LP-12 filter should be logging now`);
  } else {
    // Same for LP-24
    const currentRes = filterManager.resonance;
    filterManager.setResonance(Math.min(1, currentRes + 0.01));
    filterManager.setResonance(currentRes);
    
    console.log(`VERIFICATION: LP-24 filter should be logging now`);
  }
}
/**
 * Creates and initializes all audio nodes for a single permanent voice.
 * Uses Juno voice processors that read from master clock.
 * @param {AudioContext} ctx - The Audio Context.
 * @param {number} index - The index of this voice in the pool (0-5).
 * @returns {object} The initialized voice object.
 */
function createVoice(ctx, index) {
  const voice = {
    id: `voice_${index}`,
    index: index,
    noteNumber: null,
    startTime: 0,
    state: 'idle',
    samplerNote: null,
    osc1Note: null,
    osc2Note: null,
    scheduledTimers: [],
    currentReleaseId: null,
    wasStolen: false,
    panOffset: (Math.random() * 2 - 1) * VOICE_PAN_LIMIT,
    warbleOffset: (Math.random() * 2 - 1) * VOICE_DETUNE_LIMIT,
    // ADD: Envelope state tracking
    envelopeState: 'idle', // 'idle', 'attack', 'decay', 'sustain', 'release'
    envelopeStartTime: 0,
    attackEndTime: 0,
    decayEndTime: 0,
    // ADD: Per-voice LFO fade tracking
    lfoFadeStartTime: null, // Time when this voice was triggered (for per-voice LFO fade-in)
    // ADD: Per-voice MOD canvas envelope tracking
    modCanvasEnvStartTime: null, // Time when envelope was triggered
    modCanvasEnvPhase: 0.0, // Current phase in envelope (0-1)
    modCanvasEnvComplete: false // Whether envelope has finished playing
  };

  // --- Create Sampler Nodes ---
  const samplerGainNode = ctx.createGain();
  const samplerSampleNode = ctx.createGain();
  const samplerSource = ctx.createBufferSource();
  const samplerFMTap = ctx.createGain();
  samplerFMTap.gain.value = 1.0;
  
  const samplerPanner = ctx.createStereoPanner();
  samplerPanner.pan.value = voice.panOffset;
  
  samplerSource.connect(samplerSampleNode);
  samplerSampleNode.connect(samplerFMTap);
  samplerFMTap.connect(samplerGainNode);
  samplerGainNode.connect(samplerPanner);
  
  // Store sampler note object immediately after creation
  voice.samplerNote = {
    id: `sampler_${index}`,
    type: 'sampler',
    noteNumber: null,
    startTime: 0,
    isPlaying: false,
    isPaused: false,
    state: 'idle',
    source: samplerSource,
    gainNode: samplerGainNode,
    sampleNode: samplerSampleNode,
    fmTap: samplerFMTap,
    panner: samplerPanner,
    sampleStart: 0,
    sampleEnd: 1,
    loopStart: 0,
    loopEnd: 1,
    loopEnabled: false,
    crossfadeDuration: 0.02,
    scheduledTimers: [],
    currentReleaseId: null
  };
  
  // --- Create OSC1 and OSC2 Nodes ---
  if (isWorkletReady) {
    // --- OSC1 Setup ---
    const osc1LevelNode = ctx.createGain();
    const osc1GainNode = ctx.createGain();
    const osc1FMDepthGain = ctx.createGain();
    osc1FMDepthGain.gain.value = 0;
    osc1LevelNode.gain.value = 0.5;
    osc1GainNode.gain.value = 0;
    
    const osc1Panner = ctx.createStereoPanner();
    osc1Panner.pan.value = voice.panOffset;
    
    try {
      const osc1WorkletNode = new AudioWorkletNode(ctx, 'juno-voice-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          sharedBuffer: masterClockSharedBuffer,
          voiceIndex: index
        }
      });
      
      // Connect OSC1 chain immediately
      osc1WorkletNode.connect(osc1LevelNode);
      osc1LevelNode.connect(osc1GainNode);
      osc1GainNode.connect(osc1Panner);
      
      // Store OSC1 note object immediately after creation
      voice.osc1Note = {
        id: `osc1_${index}`,
        type: 'osc1',
        noteNumber: null,
        startTime: 0,
        isPlaying: false,
        state: 'idle',
        workletNode: osc1WorkletNode,
        levelNode: osc1LevelNode,
        gainNode: osc1GainNode,
        panner: osc1Panner,
        fmDepthGain: osc1FMDepthGain,
        frequency: 440,
        waveform: 1,
        pulseWidth: 0.5,
        quantizeEnabled: false,
        quantizeMode: 'major',
        fmAmount: 0,
        scheduledTimers: [],
        currentReleaseId: null
      };
      
      // Try to set parameters, but don't fail if they're not available yet
      setTimeout(() => {
        try {
          const params = osc1WorkletNode.parameters;
          if (params && params.get('frequency')) {
            params.get('frequency').value = 440;
            params.get('frequencyRatio').value = 1.0;
            params.get('waveform').value = 1;
            params.get('pulseWidth').value = 0.5;
            params.get('phaseOffset').value = 0;
            params.get('gate').value = 0;
            params.get('warbleAmount').value = 0;
            params.get('warbleRate').value = 5.0;
            params.get('chorusAmount').value = 0;
            params.get('chorusRate').value = 1.0;
            params.get('fmInput').value = 0;
          }
        } catch (e) {
          // Silently fail - parameters will be set when first used
          console.log(`OSC1 parameters will be initialized on first note for voice ${index}`);
        }
      }, 50);
      
    } catch (error) {
      console.error(`Failed to create OSC1 worklet for voice ${index}:`, error);
      voice.osc1Note = null;
    }
    
    // --- OSC2 Setup ---
    const osc2LevelNode = ctx.createGain();
    const osc2GainNode = ctx.createGain();
    const osc2FMDepthGain = ctx.createGain();
    osc2FMDepthGain.gain.value = 0;
    osc2LevelNode.gain.value = 0.5;
    osc2GainNode.gain.value = 0;
    
    const osc2Panner = ctx.createStereoPanner();
    osc2Panner.pan.value = voice.panOffset;
    
    try {
      const osc2WorkletNode = new AudioWorkletNode(ctx, 'juno-voice-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          sharedBuffer: masterClockSharedBuffer,
          voiceIndex: index + 100
        }
      });
      
      // Connect OSC2 chain immediately
      osc2WorkletNode.connect(osc2LevelNode);
      osc2LevelNode.connect(osc2GainNode);
      osc2GainNode.connect(osc2Panner);
      
      // Store OSC2 note object immediately after creation
      voice.osc2Note = {
        id: `osc2_${index}`,
        type: 'osc2',
        noteNumber: null,
        startTime: 0,
        isPlaying: false,
        state: 'idle',
        workletNode: osc2WorkletNode,
        levelNode: osc2LevelNode,
        gainNode: osc2GainNode,
        panner: osc2Panner,
        fmDepthGain: osc2FMDepthGain,
        frequency: 440,
        waveform: 1,
        pulseWidth: 0.5,
        quantizeEnabled: false,
        quantizeMode: 'major',
        fmAmount: 0,
        scheduledTimers: [],
        currentReleaseId: null
      };
      
      // Try to set parameters, but don't fail if they're not available yet
      setTimeout(() => {
        try {
          const params = osc2WorkletNode.parameters;
          if (params && params.get('frequency')) {
            params.get('frequency').value = 440;
            params.get('frequencyRatio').value = 1.0;
            params.get('waveform').value = 1;
            params.get('pulseWidth').value = 0.5;
            params.get('phaseOffset').value = 0;
            params.get('gate').value = 0;
            params.get('warbleAmount').value = 0;
            params.get('warbleRate').value = 5.0;
            params.get('chorusAmount').value = 0;
            params.get('chorusRate').value = 1.0;
            params.get('fmInput').value = 0;
          }
        } catch (e) {
          // Silently fail - parameters will be set when first used
          console.log(`OSC2 parameters will be initialized on first note for voice ${index}`);
        }
      }, 50);
      
    } catch (error) {
      console.error(`Failed to create OSC2 worklet for voice ${index}:`, error);
      voice.osc2Note = null;
    }
  }

  // --- Create Persistent Filter for This Voice ---
if (filterManager && voice.osc1Note && voice.osc2Note) {
  filterManager.createPersistentFilter(`osc-${voice.id}`).then(filterInput => {
    // Get filter input/output nodes
    const filterOutput = filterManager.getFilterOutput(`osc-${voice.id}`);
    
    if (filterInput && filterOutput) {
      // CRITICAL: Connect amplitude gain node to filter for real-time tracking
      filterManager.setAmplitudeGainNode(`osc-${voice.id}`, voice.osc1Note.gainNode);

      // Connect both oscillator panners to the filter INPUT node
      if (voice.osc1Note && voice.osc1Note.panner) {
        voice.osc1Note.panner.connect(filterInput);
        console.log(`Connected OSC1 panner for voice ${voice.id} to filter input`);
      }
      if (voice.osc2Note && voice.osc2Note.panner) {
        voice.osc2Note.panner.connect(filterInput);
        console.log(`Connected OSC2 panner for voice ${voice.id} to filter input`);
      }
      
      // Connect filter OUTPUT node to master gain
      filterOutput.connect(oscillatorMasterGain);
      
      // Store references (not needed but helps with debugging)
      voice.filterInput = filterInput;
      voice.filterOutput = filterOutput;
      voice.hasFilter = true;
      
      console.log(`Created and connected dual filter for voice ${voice.id}`);
    } else {
      // Fallback: Direct connection if filter failed
      console.warn(`Filter creation failed for voice ${voice.id}, connecting directly`);
      if (voice.osc1Note && voice.osc1Note.panner) voice.osc1Note.panner.connect(oscillatorMasterGain);
      if (voice.osc2Note && voice.osc2Note.panner) voice.osc2Note.panner.connect(oscillatorMasterGain);
      voice.hasFilter = false;
    }
  }).catch(err => {
    console.error(`Failed to create filter for voice ${voice.id}:`, err);
    if (voice.osc1Note && voice.osc1Note.panner) voice.osc1Note.panner.connect(oscillatorMasterGain);
    if (voice.osc2Note && voice.osc2Note.panner) voice.osc2Note.panner.connect(oscillatorMasterGain);
    voice.hasFilter = false;
  });
} else {
  if (voice.osc1Note && voice.osc1Note.panner) voice.osc1Note.panner.connect(oscillatorMasterGain);
  if (voice.osc2Note && voice.osc2Note.panner) voice.osc2Note.panner.connect(oscillatorMasterGain);
  voice.hasFilter = false;
}
  
  // Connect sampler panner directly to sampler master gain
  samplerPanner.connect(samplerMasterGain);

  return voice;
}

// Track timers per voice for proper cleanup
function trackVoiceTimer(voice, callback, delay) {
    const timerId = setTimeout(() => {
        // Remove from tracking when executed
        voice.scheduledTimers = voice.scheduledTimers.filter(t => t !== timerId);
        callback();
    }, delay);
    
    // Store the timer ID in the voice
    voice.scheduledTimers.push(timerId);
    return timerId;
}

// Clear all timers for a specific voice
function clearVoiceTimers(voice) {
    if (!voice || !voice.scheduledTimers) return;
    
    // Clear all scheduled timers
    voice.scheduledTimers.forEach(timerId => {
        clearTimeout(timerId);
    });
    voice.scheduledTimers = [];
    
    console.log(`Cleared all timers for voice ${voice.index}`);
}
// --- Helper function to set waveform mix for Juno voices ---
function setJunoWaveform(workletNode, waveformType, customPulseWidth = null) {
    if (!workletNode) return;
    
    const now = audioCtx.currentTime;
    const params = getJunoWaveformParams(waveformType);
    
    // Set all waveform levels
    workletNode.parameters.get('sawLevel').setValueAtTime(params.sawLevel, now);
    workletNode.parameters.get('pulseLevel').setValueAtTime(params.pulseLevel, now);
    workletNode.parameters.get('sineLevel').setValueAtTime(params.sineLevel, now);
    workletNode.parameters.get('triangleLevel').setValueAtTime(params.triangleLevel, now);
    
    // IMPORTANT: Always use custom pulse width if provided, regardless of waveform type
    // This ensures PWM works for all waveforms
    const pwValue = customPulseWidth !== null ? customPulseWidth : params.pulseWidth;

    // Ensure pulse width is within valid range (0-0.95)
    const clampedPW = Math.max(0, Math.min(0.95, pwValue));
    workletNode.parameters.get('pulseWidth').setValueAtTime(clampedPW, now);
}

/**
 * Initializes the voice pool with 6 permanent voices.
 * Called once at startup after AudioWorklet is ready.
 */
function initializeVoicePool() {
    if (!isWorkletReady) {
        console.error("Cannot initialize voice pool: AudioWorklet not ready.");
        return;
    }
    
    console.log("Initializing permanent voice pool with 6 voices...");
    voicePool.length = 0;
    voiceQueue.length = 0;
    
    for (let i = 0; i < 6; i++) {
        const voice = createVoice(audioCtx, i);
        
        if (voice.osc1Note && voice.osc1Note.workletNode) {
            voice.osc1Note.workletNode.parameters.get('resetPhase').setValueAtTime(1, 0);
            voice.osc1Note.workletNode.parameters.get('resetPhase').setValueAtTime(0, 0.001);
        }
        if (voice.osc2Note && voice.osc2Note.workletNode) {
            voice.osc2Note.workletNode.parameters.get('resetPhase').setValueAtTime(1, 0);
            voice.osc2Note.workletNode.parameters.get('resetPhase').setValueAtTime(0, 0.001);
        }
        
        voicePool.push(voice);
    }
    
    nextVoiceIndex = 0;
    voiceAssignments = new Map();
    
    // REMOVED THE FM INITIALIZATION FROM HERE - it was forcing FM to 0
    // The FM will be properly initialized after knobs are set up in DOMContentLoaded
    
    console.log(`Permanent voice pool initialized with ${voicePool.length} voices.`);
}

// Add helper function to check if voice is fully inactive
function isVoiceFullyInactive(voice) {
    if (!voice) return true;
    
    const samplerInactive = !voice.samplerNote || 
                           voice.samplerNote.state === 'inactive' || 
                           voice.samplerNote.state === 'idle';
    const osc1Inactive = !voice.osc1Note || 
                         voice.osc1Note.state === 'inactive' || 
                         voice.osc1Note.state === 'idle';
    const osc2Inactive = !voice.osc2Note || 
                         voice.osc2Note.state === 'inactive' || 
                         voice.osc2Note.state === 'idle';
    
    return samplerInactive && osc1Inactive && osc2Inactive;
}
function initializeSamplerFmSources() {
    // Wait for audioBuffer to be available
    if (!audioBuffer) return;
    
    // Set up FM taps for all voices
    voicePool.forEach(voice => {
        if (voice.samplerNote && !voice.samplerNote.fmTap) {
            voice.samplerNote.fmTap = audioCtx.createGain();
            voice.samplerNote.fmTap.gain.value = 1.0;
            
            // Connect properly if source exists
            if (voice.samplerNote.source && voice.samplerNote.sampleNode) {
                voice.samplerNote.sampleNode.connect(voice.samplerNote.fmTap);
                console.debug(`Created and connected FM tap for voice ${voice.id}`);
            }
        }
    });
}
/**
 * Modified voice allocation system:
 * - Always use a new voice for each note press
 * - When all voices are used, steal the oldest instance of the same note
 * - If no instances of that note exist, steal the oldest voice overall
 * 
 * @param {number} noteNumber - The MIDI note number to play
 * @returns {object|null} The assigned voice object
 */
function findAvailableVoice(noteNumber) {
    if (voicePool.length === 0) {
        console.error("Voice pool is empty!");
        return null;
    }

    // In mono mode, always use voice 0
    if (isMonoMode) {
        const monoVoice = voicePool[0];
        currentMonoVoice = monoVoice; // Track the mono voice
        
        // CRITICAL FIX: Track mono voice in voiceAssignments
        if (!voiceAssignments.has(noteNumber)) {
            voiceAssignments.set(noteNumber, []);
        }
        
        const assignments = voiceAssignments.get(noteNumber);
        if (!assignments.includes(monoVoice)) {
            assignments.push(monoVoice);
        }
        
        return monoVoice;
    }
    
    let selectedVoice = null;
    
    // First, try to find an idle voice using round-robin
    let startIndex = nextVoiceIndex;
    for (let i = 0; i < voicePool.length; i++) {
        const idx = (startIndex + i) % voicePool.length;
        const voice = voicePool[idx];
        if (voice.state === 'idle') {
            selectedVoice = voice;
            nextVoiceIndex = (idx + 1) % voicePool.length;
            console.log(`Found idle voice ${voice.index} for note ${noteNumber}`);
            break;
        }
    }
    
    // If no idle voice, look for the oldest voice playing the same note
    if (!selectedVoice) {
        // Find all voices playing this note and sort by start time
        const sameNoteVoices = voicePool
            .filter(v => v.noteNumber === noteNumber && v.state === 'active')
            .sort((a, b) => a.startTime - b.startTime);
            
        if (sameNoteVoices.length > 0) {
            // Take the oldest voice playing this note
            selectedVoice = sameNoteVoices[0];
            console.log(`Stealing oldest voice ${selectedVoice.index} playing same note ${noteNumber}`);
        }
    }
    
    // If still no voice, steal the oldest voice overall
    if (!selectedVoice) {
        // Sort all voices by start time
        const oldestVoices = [...voicePool].sort((a, b) => a.startTime - b.startTime);
        selectedVoice = oldestVoices[0];
        console.log(`Stealing oldest voice ${selectedVoice.index} (was playing note ${selectedVoice.noteNumber})`);
    }
    
    // Update voice queue (for tracking order)
    if (voiceQueue.includes(selectedVoice)) {
        // Move to end of queue if already in queue
        voiceQueue = voiceQueue.filter(v => v !== selectedVoice);
    }
    voiceQueue.push(selectedVoice);
    
    // If this voice is already playing a note, remove it from that note's assignments
    if (selectedVoice.noteNumber !== null && selectedVoice.noteNumber !== noteNumber) {
        const oldAssignments = voiceAssignments.get(selectedVoice.noteNumber) || [];
        const updatedOldAssignments = oldAssignments.filter(v => v !== selectedVoice);
        
        if (updatedOldAssignments.length === 0) {
            voiceAssignments.delete(selectedVoice.noteNumber);
        } else {
            voiceAssignments.set(selectedVoice.noteNumber, updatedOldAssignments);
        }
    }
    
    // Multiple assignments are now possible (same note in different voices)
    // We'll keep track of all assignments in an array
    if (!voiceAssignments.has(noteNumber)) {
        voiceAssignments.set(noteNumber, []);
    }
    
    // Add this voice to the assignments for this note
    const assignments = voiceAssignments.get(noteNumber);
    if (!assignments.includes(selectedVoice)) {
        assignments.push(selectedVoice);
    }
    
    return selectedVoice;
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
 * Updates or creates the FM modulator source and gain for an existing Osc1 note.
 * Handles both 'sampler' and 'osc2' as FM sources.
 * @param {object} osc1Note - The oscillator note object containing fmModulatorSource and fmDepthGain.
 * @param {number} now - The current audio context time.
 * @param {object} [voice] - Optional: The parent voice object containing both osc1Note and osc2Note. Needed for 'osc2' source.
 */
function updateOsc1FmModulatorParameters(osc1Note, now, voice = null) {
    if (!osc1Note || !osc1Note.workletNode || !voice) {
        return;
    }
    
    const fmDepthParam = osc1Note.workletNode.parameters.get('fmDepth');
    if (!fmDepthParam) return;
    
    const noteId = osc1Note.id || 'unknown';
    const scaledDepth = osc1FMAmount * osc1FMDepthScale;
    
    if (!osc1Note.fmDepthGain) {
        osc1Note.fmDepthGain = audioCtx.createGain();
    }
    osc1Note.fmDepthGain.gain.setValueAtTime(scaledDepth, now);
    
    // CRITICAL FIX: Disconnect ALL possible FM sources first
    try {
        osc1Note.fmDepthGain.disconnect();
    } catch(e) {}
    
    // CRITICAL FIX: Also try to disconnect any sources that might still be connected
    // This handles the case where we're switching FROM osc2 TO sampler
    if (voice.osc2Note && voice.osc2Note.workletNode) {
        try {
            voice.osc2Note.workletNode.disconnect(osc1Note.fmDepthGain);
        } catch(e) {}
    }
    
    // CRITICAL FIX: Disconnect any sampler FM taps that might be connected
    samplerVoicePool.forEach(sv => {
        if (sv.samplerNote && sv.samplerNote.fmTap) {
            try {
                sv.samplerNote.fmTap.disconnect(osc1Note.fmDepthGain);
            } catch(e) {}
        }
    });
    
    let fmSource = null;
    
    if (osc1FMSource === 'sampler') {
        // Find the ACTUAL sampler voice in samplerVoicePool
        const actualSamplerVoice = samplerVoicePool.find(
            sv => sv.noteNumber === voice.noteNumber && 
                  sv.state !== 'inactive' && 
                  sv.samplerNote && 
                  sv.samplerNote.fmTap
        );
        
        if (actualSamplerVoice && actualSamplerVoice.samplerNote.fmTap) {
            fmSource = actualSamplerVoice.samplerNote.fmTap;
            console.log(`OSC1 [${noteId}]: Switching to sampler FM tap from samplerVoice ${actualSamplerVoice.id}`);
        } else {
            console.warn(`OSC1 [${noteId}]: No active sampler found for FM`);
        }
    } else if (osc1FMSource === 'osc2') {
        if (voice.osc2Note && voice.osc2Note.workletNode) {
            fmSource = voice.osc2Note.workletNode;
            console.log(`OSC1 [${noteId}]: Switching to OSC2 worklet from voice ${voice.id}`);
        }
    }
    
    if (fmSource) {
        try {
            // CRITICAL: Connect the NEW source
            fmSource.connect(osc1Note.fmDepthGain);
            osc1Note.fmDepthGain.connect(osc1Note.workletNode, 0, 0);
            fmDepthParam.setValueAtTime(scaledDepth, now);
            console.log(`OSC1 [${noteId}]: FM reconnected to ${osc1FMSource} with depth ${scaledDepth.toFixed(1)} Hz`);
        } catch(e) {
            console.error(`OSC1 [${noteId}]: FM connection error: ${e.message}`);
            fmDepthParam.setValueAtTime(0, now);
        }
    } else {
        fmDepthParam.setValueAtTime(0, now);
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

// --- Modulation Routing System Functions ---

/**
 * Updates the visual state of the select button based on the current connection
 */
function updateSelectButtonState() {
  const selectButton = document.getElementById('lfo-select-button');
  if (!selectButton) {
    console.error('Select button not found!');
    return;
  }
  
  // Check if current destination is connected to current source
  const connectedSource = destinationConnections[currentDestinationName];
  // CRITICAL FIX: Only light up if both are non-null AND match
  const isConnected = (connectedSource !== null && connectedSource === currentModSource);
  
  console.log(`UPDATE SELECT BUTTON: destination="${currentDestinationName}", connectedSource="${connectedSource}", currentModSource="${currentModSource}", isConnected=${isConnected}`);
  
  // Force remove then re-add to trigger visual update
  selectButton.classList.remove('active');
  
  if (isConnected) {
    // Force a reflow to ensure the browser processes the removal before adding
    void selectButton.offsetHeight; // Trigger reflow
    selectButton.classList.add('active');
    console.log('Added "active" class to select button');
  } else {
    console.log('Removed "active" class from select button');
  }
}

/**
 * Updates visual states of source buttons based on current destination's connection
 */
function updateSourceButtonStates() {
  const allButtons = document.querySelectorAll('.matrix-button');
  const connectedSource = destinationConnections[currentDestinationName];
  
  console.log(`updateSourceButtonStates: destination="${currentDestinationName}", connectedSource="${connectedSource}", currentModSource="${currentModSource}"`);
  
  allButtons.forEach(btn => {
    const btnText = btn.textContent.trim();
    if (btnText === connectedSource) {
      btn.classList.add('active');
      console.log(`  Lit up source button: ${btnText}`);
    } else {
      btn.classList.remove('active');
    }
  });
  
  // CRITICAL FIX: Always update currentModSource to match the destination's connection
  // If the destination has a connection, set currentModSource to it
  // If no connection, set to null to show no source is selected
  currentModSource = connectedSource;
  console.log(`  Updated currentModSource to: ${currentModSource}`);
  
  // Update routed class for all destination buttons
  updateDestinationRoutedStates();
}

/**
 * Updates the 'routed' class on destination buttons based on active connections
 */
function updateDestinationRoutedStates() {
  const allTickLabels = document.querySelectorAll('.tick-label');
  
  console.log(`updateDestinationRoutedStates: Found ${allTickLabels.length} tick labels`);
  console.log(`destinationConnections:`, destinationConnections);
  
  allTickLabels.forEach(label => {
    const labelText = label.textContent.trim();
    // Check if this destination has an active connection
    const hasRouting = destinationConnections[labelText] !== null && destinationConnections[labelText] !== undefined;
    
    console.log(`  Label "${labelText}": hasRouting=${hasRouting}, connection="${destinationConnections[labelText]}"`);
    
    if (hasRouting) {
      label.classList.add('routed');
      console.log(`    Added 'routed' class to "${labelText}"`);
    } else {
      label.classList.remove('routed');
      console.log(`    Removed 'routed' class from "${labelText}"`);
    }
  });
}

/**
 * Handles source button clicks (MOD/LFO/1/2/3/4)
 */
window.handleSourceButtonClick = function handleSourceButtonClick(source) {
  // Trim whitespace from source
  const trimmedSource = source.trim();
  
  console.log(`=== SOURCE BUTTON CLICKED: "${trimmedSource}" ===`);
  console.log(`BEFORE: currentModSource="${currentModSource}"`);
  
  // Update current source
  currentModSource = trimmedSource;
  
  console.log(`AFTER: currentModSource="${currentModSource}"`);
  
  // Update visual states of source buttons
  const allButtons = document.querySelectorAll('.matrix-button');
  allButtons.forEach(btn => {
    const btnText = btn.textContent.trim();
    if (btnText === trimmedSource) {
      btn.classList.add('active');
      console.log(`  Highlighted source button: ${btnText}`);
    } else {
      btn.classList.remove('active');
    }
  });
  
  // Update select button state for new source
  updateSelectButtonState();
  
  console.log(`=== SOURCE CHANGE COMPLETE ===`);
}

/**
 * Handles destination slider changes
 */
function handleDestinationChange(sliderIndex, sliderNumber) {
  // sliderNumber: 1 for first slider (0-12), 2 for second slider (0-12)
  // CRITICAL FIX: Invert the slider index because slider is rotated 270deg
  // Slider value 0 = bottom = last item in list (12)
  // Slider value 12 = top = first item in list (0)
  const invertedIndex = 12 - parseInt(sliderIndex);
  
  // Convert to combined index (0-25)
  const combinedIndex = sliderNumber === 1 ? invertedIndex : 13 + invertedIndex;
  
  currentDestinationIndex = combinedIndex;
  currentDestinationName = modulationDestinations[combinedIndex];
  
  // Update routed states first
  updateDestinationRoutedStates();
  
  // Then highlight the current destination tick label (orange overrides routed blue)
  const allTickLabels = document.querySelectorAll('.tick-label');
  allTickLabels.forEach((label) => {
    if (label.textContent.trim() === currentDestinationName) {
      // This is the active destination - highlight it in orange
      label.style.color = '#CF814D';
    } else {
      // Clear inline style to let CSS classes take over (routed or default)
      label.style.color = '';
    }
  });
  
  // Recall the saved depth for this destination
  recallDepthForDestination();
  
  // Update source button states to show which source this destination is connected to
  updateSourceButtonStates();
  
  // Update select button state
  updateSelectButtonState();
  
  console.log(`Destination changed to: ${currentDestinationName} (index ${currentDestinationIndex})`);
}

/**
 * Recalls and sets the depth knob to the saved value for the current destination
 */
function recallDepthForDestination() {
  const savedDepth = destinationDepths[currentDestinationName];
  
  console.log(`Recalling depth for "${currentDestinationName}": ${savedDepth.toFixed(2)}`);
  
  // Always get the fresh DOM element (don't trust stored references as knob may have been re-cloned)
  const depthKnob = document.getElementById('matrix-depth-knob');
  console.log(`[recallDepth] Got element via getElementById:`, depthKnob);
  console.log(`[recallDepth] Comparing to current DOM element?`, depthKnob === document.getElementById('matrix-depth-knob'));
  
  if (depthKnob) {
    const rotation = -150 + (savedDepth * 300);
    depthKnob.style.transform = `rotate(${rotation}deg)`;
    console.log(`Set knob rotation to ${rotation}deg for depth ${savedDepth.toFixed(2)}`);
  } else {
    console.error('Matrix depth knob element not found');
  }
}

/**
 * Saves the depth value for the current destination
 */
function saveDepthForDestination(depthValue) {
  destinationDepths[currentDestinationName] = depthValue;
  console.log(`Saved depth for "${currentDestinationName}": ${depthValue.toFixed(2)}`);
  
  // If the current destination is connected to a macro source (1-4), re-apply that macro's modulation
  const connectedSource = destinationConnections[currentDestinationName];
  if (connectedSource && ['1', '2', '3', '4'].includes(connectedSource)) {
    applyMacroModulation(connectedSource, macroValues[connectedSource]);
  }
}

/**
 * Applies macro modulation from a specific source to all its connected destinations
 * @param {string} macroSource - The macro source ('1', '2', '3', or '4')
 * @param {number} macroValue - The macro knob value (0-1)
 */
function applyMacroModulation(macroSource, macroValue) {
  // Early exit: Check if this macro source has ANY connections at all
  const hasAnyConnections = Object.values(destinationConnections).some(source => source === macroSource);
  if (!hasAnyConnections) {
    return; // No connections, skip all processing
  }
  
  console.log(`=== Applying Macro ${macroSource} modulation: ${(macroValue * 100).toFixed(0)}% ===`);
  
  // Convert macro value to bipolar multiplier (-1 to +1, with 0.5 being center/unity)
  // At 0.5 (center): multiplier = 1 (no change)
  // At 1.0 (max): multiplier = 2 (double)
  // At 0.0 (min): multiplier = 0 (silence/zero)
  const multiplier = macroValue * 2; // 0 to 2
  
  // Find all destinations connected to this macro source
  modulationDestinations.forEach(destination => {
    const connectedSource = destinationConnections[destination];
    
    if (connectedSource === macroSource) {
      const depth = destinationDepths[destination];
      
      // Depth scales the modulation: 100% depth = full multiplier effect, 0% depth = no multiplier (stays at 1.0)
      // scaledMultiplier ranges from 1.0 (no effect) to the full multiplier
      const scaledMultiplier = 1.0 + ((multiplier - 1.0) * depth);
      
      console.log(`  ${destination}: macro=${(macroValue * 100).toFixed(0)}%, depth=${(depth * 100).toFixed(0)}%, multiplier=${scaledMultiplier.toFixed(2)}`);
      
      // Apply the modulation based on the destination type
      applyModulationToDestination(destination, scaledMultiplier);
    }
  });
}

/**
 * Mapping of destination names to their corresponding knob IDs
 */
const destinationToKnobMap = {
  'Sampler Pitch': 'sample-pitch-knob',
  'Osc 1 Pitch': 'osc1-pitch-knob',
  'Osc 2 Pitch': 'osc2-pitch-knob',
  'Sampler Gain': 'sample-volume-knob',
  'Osc 1 Gain': 'osc1-gain-knob',
  'Osc 2 Gain': 'osc2-gain-knob',
  'Osc 1 PWM': 'osc1-pwm-knob',
  'Osc 2 PWM': 'osc2-pwm-knob',
  'Osc 1 Quant': 'osc1-quantize-knob',
  'Osc 2 Quant': 'osc2-quantize-knob',
  'Osc 1 FM': 'osc1-fm-knob',
  'Osc 2 FM': 'osc2-fm-knob',
  'Cutoff': 'filter-cutoff',
  'Resonance': 'filter-resonance',
  'Variant': 'filter-variant',
  // Add more mappings as needed
};

/**
 * Reverse mapping: knob IDs to destination names
 * Used by knob callbacks to find their corresponding modulation destination
 */
const knobToDestinationMap = {};
Object.keys(destinationToKnobMap).forEach(dest => {
  knobToDestinationMap[destinationToKnobMap[dest]] = dest;
});

/**
 * Applies a modulation value to a specific destination parameter
 * Stores the modulation amount and triggers the knob callback to update in real-time
 * @param {string} destination - The destination name
 * @param {number} modulation - The modulation amount (-1 to +1, bipolar, scaled by depth)
 */
function applyModulationToDestination(destination, modulation) {
  // Store the modulation amount - don't move knobs visually
  destinationModulations[destination] = modulation;
  
  console.log(`    -> ${destination}: Stored modulation ${(modulation * 100).toFixed(0)}%`);
  
  // Find the corresponding element and trigger its callback to apply the modulation in real-time
  const elementId = destinationToKnobMap[destination];
  if (elementId) {
    // Try as a knob first
    let knobElement = document.getElementById(elementId);
    if (knobElement && knobElement.classList.contains('knob')) {
      // It's a knob - extract rotation
      const transform = knobElement.style.transform;
      const match = transform.match(/rotate\((-?\d+\.?\d*)deg\)/);
      if (match) {
        const rotation = parseFloat(match[1]);
        const baseValue = (rotation + 150) / 300; // Convert rotation to 0-1 value
        
        // Trigger the knob's callback with the base value
        const callback = knobInitializations[elementId];
        if (callback) {
          callback(baseValue);
        }
      }
    } else {
      // It's a slider - handle filter sliders directly
      if (elementId === 'filter-cutoff') {
        const sliderElement = document.querySelector('.freq-slider-range');
        if (sliderElement && filterManager) {
          // Get current slider position (0-1)
          const sliderValue = parseInt(sliderElement.value);
          const sliderMin = parseInt(sliderElement.min);
          const sliderMax = parseInt(sliderElement.max);
          let position = sliderValue / (sliderMax - sliderMin);
          
          // Apply modulation
          position = position * modulation;
          position = Math.max(0, Math.min(1, position));
          
          // Convert to frequency and apply
          const frequency = filterPositionToFrequency(position);
          filterManager.setCutoff(frequency);
          
          // Show tooltip with modulated frequency
          createTooltipForSlider(sliderElement, `${Math.round(frequency)} Hz`, 'top-right');
          
          console.log(`    -> Filter cutoff: position=${position.toFixed(2)}, frequency=${frequency}Hz`);
        }
      } else if (elementId === 'filter-resonance') {
        const sliderElement = document.querySelector('.res-slider-range');
        if (sliderElement && filterManager) {
          let value = parseFloat(sliderElement.value);
          value = value * modulation;
          value = Math.max(0, Math.min(1, value));
          filterManager.setResonance(value);
          
          // Show tooltip with modulated value
          createTooltipForSlider(sliderElement, `${Math.round(value * 100)}%`, 'top-right');
          
          console.log(`    -> Filter resonance: ${value.toFixed(2)}`);
        }
      } else if (elementId === 'filter-variant') {
        const sliderElement = document.querySelector('.variant-slider-range');
        if (sliderElement && filterManager) {
          let value = parseFloat(sliderElement.value);
          value = value * modulation;
          value = Math.max(0, Math.min(1, value));
          filterManager.setVariant(value);
          
          // Show tooltip with modulated value based on filter type
          let tooltipText;
          if (currentFilterType === 'lp12') {
            tooltipText = `Diode: ${Math.round(value * 100)}%`;
          } else if (currentFilterType === 'lp24') {
            tooltipText = `Bass Compensation: ${Math.round(value * 100)}%`;
          } else if (currentFilterType.startsWith('lh')) {
            const frequency = 16000 * Math.pow(8/16000, value);
            tooltipText = `High Pass: ${Math.round(frequency)} Hz`;
          } else {
            tooltipText = `Variant: ${Math.round(value * 100)}%`;
          }
          createTooltipForSlider(sliderElement, tooltipText, 'bottom');
          
          console.log(`    -> Filter variant: ${value.toFixed(2)}`);
        }
      }
    }
  }
}

/**
 * Handles select button toggle
 */
function handleSelectButtonToggle() {
  console.log(`=== SELECT BUTTON CLICKED ===`);
  console.log(`BEFORE: currentDestinationName="${currentDestinationName}", currentModSource="${currentModSource}"`);
  console.log(`BEFORE: destinationConnections[${currentDestinationName}]="${destinationConnections[currentDestinationName]}"`);
  
  const currentConnection = destinationConnections[currentDestinationName];
  
  if (currentConnection === currentModSource) {
    // Disconnect - destination is already connected to this source
    destinationConnections[currentDestinationName] = null;
    console.log(`AFTER DISCONNECT: destinationConnections[${currentDestinationName}]="${destinationConnections[currentDestinationName]}"`);
  } else {
    // Connect - destination either not connected or connected to different source
    if (currentConnection) {
      console.log(`OVERWRITING previous connection: ${currentDestinationName} was connected to "${currentConnection}", now connecting to "${currentModSource}"`);
    }
    destinationConnections[currentDestinationName] = currentModSource;
    console.log(`AFTER CONNECT: destinationConnections[${currentDestinationName}]="${destinationConnections[currentDestinationName]}"`);
  }
  
  console.log(`About to call updateSelectButtonState()...`);
  
  // Force visual update using requestAnimationFrame to ensure it happens in next render cycle
  requestAnimationFrame(() => {
    console.log(`=== INSIDE requestAnimationFrame ===`);
    console.log(`  currentModSource="${currentModSource}"`);
    console.log(`  destinationConnections[${currentDestinationName}]="${destinationConnections[currentDestinationName]}"`);
    updateSelectButtonState();
    updateSourceButtonStates();
    updateDestinationRoutedStates(); // Update routed states after connection change
    console.log(`  AFTER updates: currentModSource="${currentModSource}"`);
  });
  
  console.log(`=== SELECT BUTTON TOGGLE COMPLETE ===`);
}

/**
 * Initializes the modulation routing system
 */
function initializeModulationRouting() {
  // Initialize all connections to null
  initializeModulationConnections();
  
  // Set up source button click handlers
  const matrixButtons = document.querySelectorAll('.matrix-button');
  console.log(`Found ${matrixButtons.length} matrix buttons`);
  matrixButtons.forEach((button, index) => {
    console.log(`  Button ${index}: "${button.textContent.trim()}"`);
    button.addEventListener('click', () => {
      const source = button.textContent.trim(); // Trim whitespace
      console.log(`Matrix button clicked: "${source}"`);
      handleSourceButtonClick(source);
    });
  });
  
  // Set up destination slider listeners for BOTH sliders
  const destSliders = document.querySelectorAll('.lfo-destination-range');
  destSliders.forEach((slider, index) => {
    const sliderNumber = index + 1; // 1 or 2
    slider.addEventListener('input', (e) => {
      handleDestinationChange(e.target.value, sliderNumber);
    });
  });
  
  // Set up select button click handler
  const selectButton = document.getElementById('lfo-select-button');
  if (selectButton) {
    selectButton.addEventListener('click', handleSelectButtonToggle);
  }
  
  // Initialize to default: slider starts at value 0, which inverts to index 12 = "Overload"
  // The slider value 0 (bottom position) = inverted index 12 = 13th item in first slider
  currentDestinationIndex = 12;
  currentDestinationName = modulationDestinations[12];
  
  // Highlight the initial destination
  const allTickLabels = document.querySelectorAll('.tick-label');
  allTickLabels.forEach((label) => {
    if (label.textContent.trim() === currentDestinationName) {
      label.style.color = '#CF814D';
    } else {
      label.style.color = '#35100B';
    }
  });
  
  // Initialize routed states
  updateDestinationRoutedStates();
  
  console.log(`Modulation routing system initialized - starting at: ${currentDestinationName}`);
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
<h2 style="color: #8b4513;">POLYHYMN</h2>
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
    'macro1-knob': (value) => {
        const tooltip = createTooltipForKnob('macro1-knob', value);
        tooltip.textContent = `Macro 1: ${(value * 100).toFixed(0)}%`;
        tooltip.style.opacity = '1';
        
        // Update macro value and apply modulation to all connected destinations
        macroValues['1'] = value;
        applyMacroModulation('1', value);
        
        console.log('Macro 1:', value.toFixed(2));
    },
    'macro2-knob': (value) => {
        const tooltip = createTooltipForKnob('macro2-knob', value);
        tooltip.textContent = `Macro 2: ${(value * 100).toFixed(0)}%`;
        tooltip.style.opacity = '1';
        
        // Update macro value and apply modulation to all connected destinations
        macroValues['2'] = value;
        applyMacroModulation('2', value);
        
        console.log('Macro 2:', value.toFixed(2));
    },
    'macro3-knob': (value) => {
        const tooltip = createTooltipForKnob('macro3-knob', value);
        tooltip.textContent = `Macro 3: ${(value * 100).toFixed(0)}%`;
        tooltip.style.opacity = '1';
        
        // Update macro value and apply modulation to all connected destinations
        macroValues['3'] = value;
        applyMacroModulation('3', value);
        
        console.log('Macro 3:', value.toFixed(2));
    },
    'macro4-knob': (value) => {
        const tooltip = createTooltipForKnob('macro4-knob', value);
        tooltip.textContent = `Macro 4: ${(value * 100).toFixed(0)}%`;
        tooltip.style.opacity = '1';
        
        // Update macro value and apply modulation to all connected destinations
        macroValues['4'] = value;
        applyMacroModulation('4', value);
        
        console.log('Macro 4:', value.toFixed(2));
    },
    'matrix-depth-knob': (value) => {
        const tooltip = createTooltipForKnob('matrix-depth-knob', value);
        tooltip.textContent = `Depth: ${(value * 100).toFixed(0)}%`;
        tooltip.style.opacity = '1';
        
        // Save the depth for the current destination
        saveDepthForDestination(value);
        
        console.log('Matrix Depth:', value.toFixed(2));
    },
    'mod-depth-knob': (value) => {
        const tooltip = createTooltipForKnob('mod-depth-knob', value);
        
        // Display polarity: 0=negative, 0.5=off, 1=positive
        let polarityText;
        if (value < 0.48) {
            polarityText = `Negative ${((0.5 - value) * 200).toFixed(0)}%`;
        } else if (value > 0.52) {
            polarityText = `Positive ${((value - 0.5) * 200).toFixed(0)}%`;
        } else {
            polarityText = 'Off';
        }
        
        tooltip.textContent = `LFO: ${polarityText}`;
        tooltip.style.opacity = '1';
        
        // Update global LFO depth (polarity control)
        lfoDepth = value;
        
        console.log('LFO Depth (Polarity):', value.toFixed(2), polarityText);
    },
    'mod-rate-knob': (value) => {
        const tooltip = createTooltipForKnob('mod-rate-knob', value);
        
        // Map 0-1 to 0.1-20 Hz (logarithmic) - same as LFO rate slider
        modCanvasRate = 0.1 * Math.pow(200, value);
        
        tooltip.textContent = `${modCanvasRate.toFixed(2)} Hz`;
        tooltip.style.opacity = '1';
        
        console.log('MOD Canvas Rate:', modCanvasRate.toFixed(2), 'Hz');
    },
    // NOTE: mod-shape-knob is handled separately in uiPlaceholders.js with discrete positions
    'master-volume-knob': (value) => {
        const tooltip = createTooltipForKnob('master-volume-knob', value);
        tooltip.textContent = `Volume: ${(value * 100).toFixed(0)}%`;
        tooltip.style.opacity = '1';
        masterGain.gain.setTargetAtTime(value, audioCtx.currentTime, 0.01);
        console.log('Master Volume:', value.toFixed(2));
    },
    'adsr-knob': (value) => {
  // Convert to stepped values: 0, 0.5, or 1 only
  // Determine which step is closest
  let steppedValue;
  if (value < 0.25) {
    steppedValue = 0;
  } else if (value < 0.75) {
    steppedValue = 0.5;
  } else {
    steppedValue = 1;
  }
  
  // Map to -100%, 0%, or +100%
  const bipolarValue = (steppedValue - 0.5) * 2; // Convert to -1, 0, or 1
  
  // Update tooltip with precise stepped value description
  const tooltip = createTooltipForKnob('adsr-knob', steppedValue);
  if (steppedValue === 0.5) {
    tooltip.textContent = `Env: Center (0%)`;
  } else if (steppedValue === 0) {
    tooltip.textContent = `Env: -100%`;
  } else {
    tooltip.textContent = `Env: +100%`;
  }
  tooltip.style.opacity = '1';
  
  if (filterManager) {
    // Pass the stepped value to filter manager
    filterManager.setEnvelopeAmount(steppedValue);
  }
  
  console.log(`Filter Envelope Amount: ${bipolarValue.toFixed(2)} (stepped to ${steppedValue})`);
  
  // Return the stepped value to update the knob's visual position
  return steppedValue;
},

'keytrack-knob': (value) => {
    // Map 0-1 to -1 to +1 (bipolar control)
    const bipolarValue = (value - 0.5) * 2; // 0.5 = unity (no effect)
    
    const tooltip = createTooltipForKnob('keytrack-knob', value);
    if (Math.abs(bipolarValue) < 0.02) {
        tooltip.textContent = `Key: Unity`;
    } else if (bipolarValue > 0) {
        tooltip.textContent = `Key: +${Math.round(bipolarValue * 100)}%`;
    } else {
        tooltip.textContent = `Key: ${Math.round(bipolarValue * 100)}%`;
    }
    tooltip.style.opacity = '1';
    
    if (filterManager) {
        filterManager.setKeytrackAmount(value);
    }
    console.log('Filter Keytrack Amount:', bipolarValue.toFixed(2));
},
    'sample-volume-knob': (value) => {
        // Check if this knob has active macro modulation
        const destination = knobToDestinationMap['sample-volume-knob'];
        let finalValue = value;
        
        // Only apply modulation if destination has a connected source AND a valid multiplier
        if (destination && destinationConnections[destination] && destinationModulations[destination] !== undefined) {
            const multiplier = destinationModulations[destination];
            
            // Apply multiplier directly to the knob value
            finalValue = value * multiplier;
            
            // Clamp to 0-1 range (ceiling)
            finalValue = Math.max(0, Math.min(1, finalValue));
            
            console.log(`Sampler Gain modulated: base=${(value*100).toFixed(0)}%, multiplier=${multiplier.toFixed(2)}, final=${(finalValue*100).toFixed(0)}%`);
        }
        
        const tooltip = createTooltipForKnob('sample-volume-knob', value, 'right');
        
        if (finalValue === 0) {
            tooltip.textContent = 'MUTED';
        } else {
            tooltip.textContent = `${(finalValue * 100).toFixed(0)}%`;
        }
        tooltip.style.opacity = '1';
        
        // Update the samplerMasterGain with modulated value
        samplerMasterGain.gain.setTargetAtTime(finalValue, audioCtx.currentTime, 0.01);
        
        console.log('Sampler Master Volume:', finalValue === 0 ? 'MUTED' : `${(finalValue * 100).toFixed(0)}%`);
    },

'sample-pitch-knob': (value) => {
    // Check if this knob has active macro modulation
    const destination = knobToDestinationMap['sample-pitch-knob'];
    let finalValue = value;
    
    if (destination && destinationConnections[destination] && destinationModulations[destination] !== undefined) {
        const multiplier = destinationModulations[destination];
        
        // Apply multiplier directly to the knob value
        finalValue = value * multiplier;
        
        // Clamp to 0-1 range (ceiling)
        finalValue = Math.max(0, Math.min(1, finalValue));
        
        console.log(`Sampler Pitch modulated: base=${(value*100).toFixed(0)}%, multiplier=${multiplier.toFixed(2)}, final=${(finalValue*100).toFixed(0)}%`);
    }
    
    // Convert 0-1 range to -1200 to +1200 cents using modulated value
    currentSampleDetune = (finalValue * 2400) - 1200;
    const now = audioCtx.currentTime;

    // Show and update tooltip
    const tooltip = createTooltipForKnob('sample-pitch-knob', value, 'right');
    tooltip.textContent = `${currentSampleDetune.toFixed(0)}c`;
    tooltip.style.opacity = '1';

    // CRITICAL FIX: Update samplerVoicePool, not voicePool
    samplerVoicePool.forEach(voice => {
      // FIX: Check if filterNode exists AND has a gain parameter or property
      if (voice.filterNode) {
        // First try to access as AudioWorkletNode parameter
        if (voice.filterNode.parameters && voice.filterNode.parameters.get('gain')) {
          voice.filterNode.parameters.get('gain').value = 1.0;
          console.log(`Set sampler filter gain parameter for voice ${voice.id}`);
        }
        // Otherwise check if it has a direct gain property (for native nodes)
        else if (voice.filterNode.gain) {
          voice.filterNode.gain.value = 1.0;
          console.log(`Set sampler filter gain property for voice ${voice.id}`);
        }
      }
    });

    // Update playback rate for active sampler notes
    samplerVoicePool.forEach(voice => {
      if ((voice.state === 'playing' || voice.state === 'releasing') && voice.samplerNote && voice.samplerNote.source) {
        voice.samplerNote.source.detune.cancelScheduledValues(now);
        voice.samplerNote.source.detune.setValueAtTime(currentSampleDetune, now);
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
        // Check if this knob has active macro modulation
        const destination = knobToDestinationMap['osc1-gain-knob'];
        let finalValue = value;
        
        if (destination && destinationConnections[destination] && destinationModulations[destination] !== undefined) {
            const multiplier = destinationModulations[destination];
            
            // Apply multiplier directly to the knob value
            finalValue = value * multiplier;
            
            // Clamp to 0-1 range (ceiling)
            finalValue = Math.max(0, Math.min(1, finalValue));
            
            console.log(`Osc1 Gain modulated: base=${(value*100).toFixed(0)}%, multiplier=${multiplier.toFixed(2)}, final=${(finalValue*100).toFixed(0)}%`);
        }
        
        const tooltip = createTooltipForKnob('osc1-gain-knob', value, 'bottom');
        tooltip.textContent = `GAIN: ${(finalValue * 100).toFixed(0)}%`;
        tooltip.style.opacity = '1';
        osc1GainValue = finalValue; // Update the global gain value with modulated value

        // --- REAL-TIME UPDATE FOR ACTIVE NOTES (Control levelNode) ---
        const now = audioCtx.currentTime;
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            // Check if the voice is active and the specific osc1 levelNode exist
            if (voice.state !== 'inactive' && voice.osc1Note && voice.osc1Note.levelNode) {
                const levelNode = voice.osc1Note.levelNode;
                levelNode.gain.cancelScheduledValues(now);
                levelNode.gain.setValueAtTime(osc1GainValue, now);
            }
        });
        // <<< END CHANGE >>>
        // --- END REAL-TIME UPDATE ---

        console.log('Osc1 Gain:', finalValue.toFixed(2));
    },
    'osc1-pitch-knob': (value) => {
        // Check if this knob has active macro modulation
        const destination = knobToDestinationMap['osc1-pitch-knob'];
        let finalValue = value;
        
        if (destination && destinationConnections[destination] && destinationModulations[destination] !== undefined) {
            const multiplier = destinationModulations[destination];
            
            // Apply multiplier directly to the knob value
            finalValue = value * multiplier;
            
            // Clamp to 0-1 range (ceiling)
            finalValue = Math.max(0, Math.min(1, finalValue));
            
            console.log(`Osc1 Pitch modulated: base=${(value*100).toFixed(0)}%, multiplier=${multiplier.toFixed(2)}, final=${(finalValue*100).toFixed(0)}%`);
        }
        
        // Calculate detune value (e.g., -100 to +100 cents) using modulated value
        osc1Detune = (finalValue - 0.5) * 200; // Example mapping

        const tooltip = createTooltipForKnob('osc1-pitch-knob', value, 'right');
        tooltip.textContent = `${osc1Detune.toFixed(0)}c`;
        tooltip.style.opacity = '1';

        const now = audioCtx.currentTime;
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.osc1Note && voice.osc1Note.workletNode) {
                const oscDetuneParam = voice.osc1Note.workletNode.parameters.get('detune');
                if (oscDetuneParam) {
                    // Cancel any scheduled changes and set value instantly
                    oscDetuneParam.cancelScheduledValues(now);
                    oscDetuneParam.setValueAtTime(osc1Detune, now);
                }
                // <<< ADD: Update Osc1 FM source if it's Osc2 >>>
                if (osc2FMSource === 'osc1' && voice.osc2Note && voice.osc2Note.fmModulatorSource instanceof OscillatorNode) {
                    voice.osc2Note.fmModulatorSource.detune.cancelScheduledValues(now);
                    voice.osc2Note.fmModulatorSource.detune.setValueAtTime(osc1Detune, now);
                }
            }
        });
        // <<< END CHANGE >>>
        console.log('Osc1 Detune:', osc1Detune.toFixed(2));
    },
    'osc1-fm-knob': (value) => {
        // Check if this knob has active macro modulation
        const destination = knobToDestinationMap['osc1-fm-knob'];
        let finalValue = value;
        
        if (destination && destinationConnections[destination] && destinationModulations[destination] !== undefined) {
            const multiplier = destinationModulations[destination];
            
            // Apply multiplier directly to the knob value
            finalValue = value * multiplier;
            
            // Clamp to 0-1 range (ceiling)
            finalValue = Math.max(0, Math.min(1, finalValue));
            
            console.log(`Osc1 FM modulated: base=${(value*100).toFixed(0)}%, multiplier=${multiplier.toFixed(2)}, final=${(finalValue*100).toFixed(0)}%`);
        }
        
        // Apply exponential curve to modulated value
        const curvedValue = finalValue * finalValue;
        const prevFMAmount = osc1FMAmount; // Store previous amount
        osc1FMAmount = curvedValue; // Update global curved value

        // Calculate scaled depth (Hz)
        const scaledDepth = osc1FMAmount * osc1FMDepthScale;
        const now = audioCtx.currentTime;
        const isNowOn = osc1FMAmount > 0.001;
        const wasPreviouslyOff = prevFMAmount <= 0.001;

        // Update tooltip
        const tooltip = createTooltipForKnob('osc1-fm-knob', value);
        tooltip.textContent = `${(scaledDepth).toFixed(0)} Hz`;
        tooltip.style.opacity = '1';

        // --- UPDATE Per-Voice ---
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.osc1Note) {
                // Check if the fmDepthGain node exists for this voice.
                if (voice.osc1Note.fmDepthGain) {
                    // <<< Node exists: Just update gain instantly >>>
                    voice.osc1Note.fmDepthGain.gain.cancelScheduledValues(now);
                    voice.osc1Note.fmDepthGain.gain.setValueAtTime(scaledDepth, now);
                } else if (isNowOn) {
                    // <<< Node MISSING, but FM should be ON now >>>
                    // This happens if the note started while FM knob was at 0.
                    // Call updateOsc1FmModulatorParameters to create/connect nodes.
                    console.log(`osc1-fm-knob: FM turned on for note ${voice.osc1Note.id}. Initializing FM nodes.`);
                    updateOsc1FmModulatorParameters(voice.osc1Note, now, voice);
                    // updateOsc1FmModulatorParameters sets the initial gain,
                    // so no need to set it again immediately after.
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
    const minLoopFractionRequired = 0.001;
    const minLoopFractionForCrossfade = 0.01;
    const effectiveMinGap = isSampleLoopOn
        ? Math.max(minLoopFractionRequired, minLoopFractionForCrossfade)
        : minLoopFractionRequired;

    const maxAllowedStart = sampleEndPosition - effectiveMinGap;
    let newStartPosition = Math.min(value, maxAllowedStart);
    newStartPosition = Math.max(0, newStartPosition);

    if (newStartPosition !== sampleStartPosition) {
        // SNAP TO ZERO CROSSING - If we have a buffer to analyze
        if (audioBuffer) {
            // Convert fraction to sample position
            const totalSamples = audioBuffer.length;
            const rawStartSample = Math.floor(newStartPosition * totalSamples);
            
            // Find best zero crossing (search backward for start position)
            const snappedSample = findBestZeroCrossing(
                audioBuffer, 
                rawStartSample, 
                1, // Direction: forward to find zero crossing after peak/trough
                Math.floor(totalSamples * 0.02) // Search within 2% of total length
            );
            
            // Convert back to fraction
            newStartPosition = snappedSample / totalSamples;
            console.log(`Start position snapped to zero crossing: ${(newStartPosition * 100).toFixed(2)}%`);
        }
        
        sampleStartPosition = newStartPosition;
        updateSampleProcessing();

        const tooltip = createTooltipForKnob('sample-start-knob', value);
        tooltip.textContent = `Start: ${(sampleStartPosition * 100).toFixed(0)}%`;
        tooltip.style.opacity = '1';
        console.log('Sample Start:', (sampleStartPosition * 100).toFixed(0) + '%');

        if (startUpdateTimer) { trackClearTimeout(startUpdateTimer); }
        startUpdateTimer = null;
    } else {
        const tooltip = createTooltipForKnob('sample-start-knob', value);
        tooltip.textContent = `Start: ${(sampleStartPosition * 100).toFixed(0)}%`;
        tooltip.style.opacity = '1';
    }
},

// Around line 1480 - Update sample-end-knob
'sample-end-knob': (value) => {
    const minLoopFractionRequired = 0.001;
    const minLoopFractionForCrossfade = 0.01;
    const effectiveMinGap = isSampleLoopOn
        ? Math.max(minLoopFractionRequired, minLoopFractionForCrossfade)
        : minLoopFractionRequired;

    const minAllowedEnd = sampleStartPosition + effectiveMinGap;
    let newEndPosition = Math.max(value, minAllowedEnd);
    newEndPosition = Math.min(1, newEndPosition);

    if (newEndPosition !== sampleEndPosition) {
        // SNAP TO ZERO CROSSING - If we have a buffer to analyze
        if (audioBuffer) {
            // Convert fraction to sample position
            const totalSamples = audioBuffer.length;
            const rawEndSample = Math.floor(newEndPosition * totalSamples);
            
            // Find best zero crossing (search forward for end position)
            const snappedSample = findBestZeroCrossing(
                audioBuffer, 
                rawEndSample, 
                -1, // Direction: backward to find zero crossing after peak/trough
                Math.floor(totalSamples * 0.02) // Search within 2% of total length
            );
            
            // Convert back to fraction
            newEndPosition = snappedSample / totalSamples;
            console.log(`End position snapped to zero crossing: ${(newEndPosition * 100).toFixed(2)}%`);
        }
        
        sampleEndPosition = newEndPosition;
        updateSampleProcessing();

        const tooltip = createTooltipForKnob('sample-end-knob', value);
        tooltip.textContent = `End: ${(sampleEndPosition * 100).toFixed(0)}%`;
        tooltip.style.opacity = '1';
        console.log('Sample End:', (sampleEndPosition * 100).toFixed(0) + '%');

        if (endUpdateTimer) { trackClearTimeout(endUpdateTimer); }
        endUpdateTimer = null;
    } else {
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
    isSampleLoopOn = value > 0.01;

    if (isSampleLoopOn && !prevLoopState) {
        console.log("Crossfade enabled, resetting manual fades.");
        sampleFadeInAmount = 0;
        sampleFadeOutAmount = 0;
        const fadeKnob = D('sample-fade-knob');
        if (fadeKnob && fadeKnob.control) {
            fadeKnob.control.setValue(0.5);
        }
    }

    updateSampleProcessing();

    // CRITICAL FIX: Don't update playing notes
    if (crossfadeUpdateTimer) { trackClearTimeout(crossfadeUpdateTimer); }
    crossfadeUpdateTimer = null;
    
    console.log("Crossfade changed - will affect next noteOn only");
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
    // Update the PWM knob callbacks to work with the new system
// In knobInitializations object:
'osc1-pwm-knob': (value) => {
    // Check if this knob has active macro modulation
    const destination = knobToDestinationMap['osc1-pwm-knob'];
    let finalValue = value;
    
    if (destination && destinationConnections[destination] && destinationModulations[destination] !== undefined) {
        const multiplier = destinationModulations[destination];
        
        // Apply multiplier directly to the knob value
        finalValue = value * multiplier;
        
        // Clamp to 0-1 range (ceiling)
        finalValue = Math.max(0, Math.min(1, finalValue));
        
        console.log(`Osc1 PWM modulated: base=${(value*100).toFixed(0)}%, multiplier=${multiplier.toFixed(2)}, final=${(finalValue*100).toFixed(0)}%`);
    }
    
    // Always update the global value with modulated value
    osc1PWMValue = finalValue;
    
    const tooltip = createTooltipForKnob('osc1-pwm-knob', value, 'right');
    
    // Update display text - show "OFF" when at zero
    if (finalValue === 0) {
        tooltip.textContent = "OFF";
    } else {
        // FIXED: Show actual 0-95% range
        tooltip.textContent = `${Math.round(finalValue * 95)}%`;
    }
    tooltip.style.opacity = '1';
    
    // Update active notes with pulse width
    const now = audioCtx.currentTime;
    voicePool.forEach(voice => {
        if (voice.state !== 'inactive' && voice.osc1Note && voice.osc1Note.workletNode) {
            // FIXED: When value is 0, PWM is OFF (use waveform default)
            // Otherwise map to 0.05-0.95 range (valid pulse width range)
            let pulseWidth;
            if (finalValue === 0) {
                pulseWidth = getJunoWaveformParams(osc1Waveform).pulseWidth;
            } else {
                // Map 0.01-1.0 to 0.05-0.95 range to stay within valid bounds
                pulseWidth = 0.05 + (finalValue * 0.90); // 0.05 to 0.95
                pulseWidth = Math.max(0.05, Math.min(0.95, pulseWidth)); // Extra safety clamp
            }
            
            // Apply to the current waveform
            setJunoWaveform(voice.osc1Note.workletNode, osc1Waveform, pulseWidth);
        }
    });
    
    // Log with special case for OFF state
    if (finalValue === 0) {
        console.log(`Osc1 PWM: OFF (using default for ${osc1Waveform})`);
    } else {
        console.log(`Osc1 PWM: ${finalValue.toFixed(2)}, Actual PW: ${(finalValue * 0.95).toFixed(2)}`);
    }
},
    'osc1-quantize-knob': (value) => {
    // Check if this knob has active macro modulation
    const destination = knobToDestinationMap['osc1-quantize-knob'];
    let finalValue = value;
    
    if (destination && destinationConnections[destination] && destinationModulations[destination] !== undefined) {
        const multiplier = destinationModulations[destination];
        
        // Apply multiplier directly to the knob value
        finalValue = value * multiplier;
        
        // Clamp to 0-1 range (ceiling)
        finalValue = Math.max(0, Math.min(1, finalValue));
        
        console.log(`Osc1 Quantize modulated: base=${(value*100).toFixed(0)}%, multiplier=${multiplier.toFixed(2)}, final=${(finalValue*100).toFixed(0)}%`);
    }
    
    osc1QuantizeValue = finalValue;
    
    const tooltip = createTooltipForKnob('osc1-quantize-knob', value, 'bottom');
    tooltip.textContent = `QUANT: ${Math.round(finalValue * 100)}%`;
    tooltip.style.opacity = '1';
    
    // Update active notes
    const now = audioCtx.currentTime;
    voicePool.forEach(voice => {
        if (voice.state !== 'inactive' && voice.osc1Note && voice.osc1Note.workletNode) {
            // Get worklet parameter
            const quantizeParam = voice.osc1Note.workletNode.parameters.get('quantizeAmount');
            if (quantizeParam) {
                // Cancel scheduled values and set instantly using FINAL modulated value
                quantizeParam.cancelScheduledValues(now);
                quantizeParam.setValueAtTime(finalValue, now);
            }
        }
    });
    
    console.log(`Osc1 Quantize: ${finalValue.toFixed(2)}`);
},
    'osc2-gain-knob': (value) => {
        // Check if this knob has active macro modulation
        const destination = knobToDestinationMap['osc2-gain-knob'];
        let finalValue = value;
        
        if (destination && destinationConnections[destination] && destinationModulations[destination] !== undefined) {
            const multiplier = destinationModulations[destination];
            
            // Apply multiplier directly to the knob value
            finalValue = value * multiplier;
            
            // Clamp to 0-1 range (ceiling)
            finalValue = Math.max(0, Math.min(1, finalValue));
            
            console.log(`Osc2 Gain modulated: base=${(value*100).toFixed(0)}%, multiplier=${multiplier.toFixed(2)}, final=${(finalValue*100).toFixed(0)}%`);
        }
        
        osc2GainValue = finalValue;
        const tooltip = createTooltipForKnob('osc2-gain-knob', value, 'bottom');
        tooltip.textContent = `GAIN: ${Math.round(finalValue * 100)}%`;
        tooltip.style.opacity = '1';
        // Update active Osc2 notes
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.osc2Note && voice.osc2Note.levelNode) {
                voice.osc2Note.levelNode.gain.cancelScheduledValues(audioCtx.currentTime);
                voice.osc2Note.levelNode.gain.setValueAtTime(osc2GainValue, audioCtx.currentTime);
            }
        });
        // <<< END CHANGE >>>
        console.log(`Osc2 Gain set to: ${finalValue.toFixed(2)}`);
    },
    'osc2-pitch-knob': (value) => {
        // Check if this knob has active macro modulation
        const destination = knobToDestinationMap['osc2-pitch-knob'];
        let finalValue = value;
        
        if (destination && destinationConnections[destination] && destinationModulations[destination] !== undefined) {
            const multiplier = destinationModulations[destination];
            
            // Apply multiplier directly to the knob value
            finalValue = value * multiplier;
            
            // Clamp to 0-1 range (ceiling)
            finalValue = Math.max(0, Math.min(1, finalValue));
            
            console.log(`Osc2 Pitch modulated: base=${(value*100).toFixed(0)}%, multiplier=${multiplier.toFixed(2)}, final=${(finalValue*100).toFixed(0)}%`);
        }
        
        // Map 0-1 to -100 to +100 cents using modulated value
        osc2Detune = (finalValue - 0.5) * 200;
        const tooltip = createTooltipForKnob('osc2-pitch-knob', value, 'right');
        tooltip.textContent = `${osc2Detune.toFixed(0)}c`;
        tooltip.style.opacity = '1';
        const now = audioCtx.currentTime;
        // Update active Osc2 notes
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.osc2Note && voice.osc2Note.workletNode) {
                const detuneParam = voice.osc2Note.workletNode.parameters.get('detune');
                if (detuneParam) {
                    detuneParam.cancelScheduledValues(now);
                    detuneParam.setValueAtTime(osc2Detune, now);
                }
                // <<< ADD: Update Osc2 FM source if it's Osc1 >>>
                if (osc1FMSource === 'osc2' && voice.osc1Note && voice.osc1Note.fmModulatorSource instanceof OscillatorNode) {
                    voice.osc1Note.fmModulatorSource.detune.cancelScheduledValues(now);
                    voice.osc1Note.fmModulatorSource.detune.setValueAtTime(osc2Detune, now);
                }
            }
        });
        // <<< END CHANGE >>>
        console.log(`Osc2 Detune set to: ${osc2Detune.toFixed(1)} cents`);
    },
    'osc2-pwm-knob': (value) => {
    // Check if this knob has active macro modulation
    const destination = knobToDestinationMap['osc2-pwm-knob'];
    let finalValue = value;
    
    if (destination && destinationConnections[destination] && destinationModulations[destination] !== undefined) {
        const multiplier = destinationModulations[destination];
        
        // Apply multiplier directly to the knob value
        finalValue = value * multiplier;
        
        // Clamp to 0-1 range (ceiling)
        finalValue = Math.max(0, Math.min(1, finalValue));
        
        console.log(`Osc2 PWM modulated: base=${(value*100).toFixed(0)}%, multiplier=${multiplier.toFixed(2)}, final=${(finalValue*100).toFixed(0)}%`);
    }
    
    // Always update the global value with modulated value
    osc2PWMValue = finalValue;
    
    const tooltip = createTooltipForKnob('osc2-pwm-knob', value, 'right');
    
    // Update display text - show "OFF" when at zero
    if (finalValue === 0) {
        tooltip.textContent = "OFF";
    } else {
        // FIXED: Show actual 0-95% range
        tooltip.textContent = `${Math.round(finalValue * 95)}%`;
    }
    tooltip.style.opacity = '1';
    
    // Update active notes with pulse width
    const now = audioCtx.currentTime;
    voicePool.forEach(voice => {
        if (voice.state !== 'inactive' && voice.osc2Note && voice.osc2Note.workletNode) {
            // FIXED: When value is 0, PWM is OFF (use waveform default)
            // Otherwise map to 0.05-0.95 range (valid pulse width range)
            let pulseWidth;
            if (finalValue === 0) {
                pulseWidth = getJunoWaveformParams(osc2Waveform).pulseWidth;
            } else {
                // Map 0.01-1.0 to 0.05-0.95 range to stay within valid bounds
                pulseWidth = 0.05 + (finalValue * 0.90); // 0.05 to 0.95
                pulseWidth = Math.max(0.05, Math.min(0.95, pulseWidth)); // Extra safety clamp
            }
            
            // Apply to the current waveform
            setJunoWaveform(voice.osc2Note.workletNode, osc2Waveform, pulseWidth);
        }
    });
    
    // Log with special case for OFF state
    if (finalValue === 0) {
        console.log(`Osc2 PWM: OFF (using default for ${osc2Waveform})`);
    } else {
        console.log(`Osc2 PWM: ${finalValue.toFixed(2)}, Actual PW: ${(finalValue * 0.95).toFixed(2)}`);
    }
},
    'osc2-quantize-knob': (value) => {
    // Check if this knob has active macro modulation
    const destination = knobToDestinationMap['osc2-quantize-knob'];
    let finalValue = value;
    
    if (destination && destinationConnections[destination] && destinationModulations[destination] !== undefined) {
        const multiplier = destinationModulations[destination];
        
        // Apply multiplier directly to the knob value
        finalValue = value * multiplier;
        
        // Clamp to 0-1 range (ceiling)
        finalValue = Math.max(0, Math.min(1, finalValue));
        
        console.log(`Osc2 Quantize modulated: base=${(value*100).toFixed(0)}%, multiplier=${multiplier.toFixed(2)}, final=${(finalValue*100).toFixed(0)}%`);
    }
    
    osc2QuantizeValue = finalValue;
    
    const tooltip = createTooltipForKnob('osc2-quantize-knob', value, 'bottom');
    tooltip.textContent = `QUANT: ${Math.round(finalValue * 100)}%`;
    tooltip.style.opacity = '1';
    
    // Update active notes
    const now = audioCtx.currentTime;
    voicePool.forEach(voice => {
        if (voice.state !== 'inactive' && voice.osc2Note && voice.osc2Note.workletNode) {
            // Get worklet parameter
            const quantizeParam = voice.osc2Note.workletNode.parameters.get('quantizeAmount');
            if (quantizeParam) {
                // Cancel scheduled values and set instantly using FINAL modulated value
                quantizeParam.cancelScheduledValues(now);
                quantizeParam.setValueAtTime(finalValue, now);
            }
        }
    });
    
    console.log(`Osc2 Quantize: ${finalValue.toFixed(2)}`);
},
    'osc2-fm-knob': (value) => {
        // Check if this knob has active macro modulation
        const destination = knobToDestinationMap['osc2-fm-knob'];
        let finalValue = value;
        
        if (destination && destinationConnections[destination] && destinationModulations[destination] !== undefined) {
            const multiplier = destinationModulations[destination];
            
            // Apply multiplier directly to the knob value
            finalValue = value * multiplier;
            
            // Clamp to 0-1 range (ceiling)
            finalValue = Math.max(0, Math.min(1, finalValue));
            
            console.log(`Osc2 FM modulated: base=${(value*100).toFixed(0)}%, multiplier=${multiplier.toFixed(2)}, final=${(finalValue*100).toFixed(0)}%`);
        }
        
        // Apply exponential curve to modulated value
        const curvedValue = finalValue * finalValue;
        const prevFMAmount = osc2FMAmount; // <<< Store previous amount
        osc2FMAmount = curvedValue; // Store curved value

        // Calculate scaled depth (Hz)
        const scaledDepth = osc2FMAmount * osc2FMDepthScale;
        const now = audioCtx.currentTime;
        const isNowOn = osc2FMAmount > 0.001;
        const wasPreviouslyOff = prevFMAmount <= 0.001; // <<< Check if it was off

        // Update tooltip
        const tooltip = createTooltipForKnob('osc2-fm-knob', value);
        tooltip.textContent = `${(scaledDepth).toFixed(0)} Hz`;
        tooltip.style.opacity = '1';

        // --- UPDATE Per-Voice ---
        // <<< CHANGE: Iterate over voicePool >>>
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.osc2Note) {
                // Check if the fmDepthGain node exists for this voice.
                if (voice.osc2Note.fmDepthGain) {
                    // <<< Node exists: Just update gain instantly >>>
                    voice.osc2Note.fmDepthGain.gain.cancelScheduledValues(now);
                    voice.osc2Note.fmDepthGain.gain.setValueAtTime(scaledDepth, now);
                } else if (isNowOn) { // <<< Check if FM is ON now >>>
                    // <<< Node MISSING, but FM should be ON now >>>
                    // This happens if the note started while FM knob was at 0.
                    // Call updateOsc2FmModulatorParameters to create/connect nodes.
                    console.log(`osc2-fm-knob: FM turned on for note ${voice.osc2Note.id}. Initializing FM nodes.`);
                    // <<< Pass the 'voice' object >>>
                    updateOsc2FmModulatorParameters(voice.osc2Note, now, voice);
                    // updateOsc2FmModulatorParameters sets the initial gain,
                    // so no need to set it again immediately after.
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
    if (!note || !(note.source instanceof AudioBufferSourceNode) || 
        !(note.gainNode instanceof GainNode) || !(note.sampleNode instanceof GainNode)) {
        console.warn(`updateSamplePlaybackParameters: Invalid note object`);
        return note;
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
    }
    
    // Clear references on the note object temporarily
    note.source = null;
    note.gainNode = null;
    note.sampleNode = null;

    try {
        // CRITICAL FIX: Don't rebuild FM connections during sample parameter updates
        // Only rebuild if the sample buffer itself has changed
        
        // Save references to FM connections before replacing
        const affectedOsc1Notes = [];
        const affectedOsc2Notes = [];
        
        // Only track voices that are ACTUALLY using this specific sampler note as FM source
        voicePool.forEach(voice => {
            // Check if OSC1 is using sampler FM AND the modulator source exists
            if (voice.osc1Note && 
                voice.osc1Note.state !== 'inactive' && 
                osc1FMSource === 'sampler' &&
                voice.osc1Note.fmModulatorSource instanceof AudioBufferSourceNode) {
                affectedOsc1Notes.push({note: voice.osc1Note, voice: voice});
            }
            
            // Check if OSC2 is using sampler FM AND the modulator source exists
            if (voice.osc2Note && 
                voice.osc2Note.state !== 'inactive' && 
                osc2FMSource === 'sampler' &&
                voice.osc2Note.fmModulatorSource instanceof AudioBufferSourceNode) {
                affectedOsc2Notes.push({note: voice.osc2Note, voice: voice});
            }
        });
        // --- Create Replacement Note Structure ---
        console.log(`updateSamplePlaybackParameters [${note.id}]: Creating new source/nodes.`);

        // Determine which buffer to use
        let useOriginalBuffer = true;
        let sourceBuffer = audioBuffer; // Default to original (potentially reversed) buffer
        let bufferType = "original";

        if (isSampleLoopOn && sampleCrossfadeAmount > 0.01 && cachedCrossfadedBuffer) {
            sourceBuffer = cachedCrossfadedBuffer;
            useOriginalBuffer = false;
            bufferType = "crossfaded";
        }
        else if (fadedBuffer && (!isSampleLoopOn || sampleCrossfadeAmount <= 0.01)) {
            sourceBuffer = fadedBuffer;
            useOriginalBuffer = false;
            bufferType = "faded";
        }
        else if (isEmuModeOn && useOriginalBuffer) {
             sourceBuffer = applyEmuProcessing(audioBuffer);
             useOriginalBuffer = false;
             bufferType = "original_emu";
        }

        if (!sourceBuffer || !(sourceBuffer instanceof AudioBuffer) || sourceBuffer.length === 0) {
            console.error(`updateSamplePlaybackParameters [${note.id}]: Invalid sourceBuffer. Cannot create replacement.`);
            killSamplerNote(note);
            return null;
        }
        
        console.log(`updateSamplePlaybackParameters [${note.id}]: Selected buffer for replacement: ${bufferType}`);

        // Create new nodes
        const newSource = audioCtx.createBufferSource();
        const newGainNode = audioCtx.createGain(); // For ADSR
        const newSampleNode = audioCtx.createGain(); // For sample-specific gain
        
        // CRITICAL: Reuse existing FM tap or create new one
        let fmTap = note.fmTap;
        if (!fmTap) {
            fmTap = audioCtx.createGain();
            fmTap.gain.value = 1.0;
        }
        
        newSource.buffer = sourceBuffer;
        newSampleNode.gain.value = (note.state === 'playing') ? currentSampleGain : 0;

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

        // Connect with FM tap in the chain
        newSource.connect(newSampleNode);
        newSampleNode.connect(fmTap);  // FM tap gets processed signal
        fmTap.connect(newGainNode);    // Pass through to ADSR
        newGainNode.connect(samplerMasterGain); // FIX: Connect to samplerMasterGain instead

        // Apply loop settings
        let loopStartTime = 0;
        let loopEndTime = sourceBuffer.duration;
        if (useOriginalBuffer) {
            // Looping the original buffer requires start/end points based on global settings
            if (isSampleLoopOn) {
                newSource.loop = true;
                loopStartTime = sampleStartPosition * audioBuffer.duration;
                loopEndTime = sampleEndPosition * audioBuffer.duration;
                newSource.loopStart = loopStartTime;
                newSource.loopEnd = loopEndTime;
            } else {
                newSource.loop = false;
            }
        } else {
            // Looping a processed buffer loops the whole buffer
            newSource.loop = isSampleLoopOn;
        }

        // Update the note object
        note.source = newSource;
        note.gainNode = newGainNode;
        note.sampleNode = newSampleNode;
        note.fmTap = fmTap; // Maintain FM tap reference
        note.usesProcessedBuffer = !useOriginalBuffer;
        note.crossfadeActive = bufferType === "crossfaded";
        note.looping = newSource.loop;
        note.calculatedLoopStart = loopStartTime;
        note.calculatedLoopEnd = loopEndTime;

        // Start the new source
        console.log(`updateSamplePlaybackParameters [${note.id}]: Starting new source.`);
        const now = audioCtx.currentTime;
        newSource.start(now);

        // CRITICAL FIX: Only restore gain for notes that were actually playing
        if (note.state === 'playing') {
            // Restore gain smoothly to the level it was at before replacement
            note.gainNode.gain.cancelScheduledValues(now);
            note.gainNode.gain.setValueAtTime(0, now); // Start at 0
            note.gainNode.gain.exponentialRampToValueAtTime(Math.max(0.001, currentGainValue), now + 0.005); // Smooth fade in
        } else {
            // For non-playing notes, keep gain at 0
            note.gainNode.gain.setValueAtTime(0, now);
        }

        // Schedule stop if not looping
        if (!note.looping) {
            let originalDuration;
            if (bufferType === "faded" && fadedBufferOriginalDuration) {
                 originalDuration = fadedBufferOriginalDuration;
            } else if (bufferType === "crossfaded") {
                 originalDuration = sourceBuffer.duration;
            } else if (bufferType === "original_emu") {
                 originalDuration = (sampleEndPosition - sampleStartPosition) * audioBuffer.duration;
            } else { // Original buffer
                 originalDuration = (sampleEndPosition - sampleStartPosition) * audioBuffer.duration;
            }

            const playbackRate = newSource.playbackRate.value;
            const adjustedDuration = originalDuration / playbackRate;
            const safetyMargin = 0.05;
            const stopTime = now + adjustedDuration + safetyMargin;

            try {
                newSource.stop(stopTime);
                console.log(`updateSamplePlaybackParameters [${note.id}]: New source scheduled to stop at ${stopTime.toFixed(3)}`);
            } catch (e) {
                console.error(`updateSamplePlaybackParameters [${note.id}]: Error scheduling stop:`, e);
            }
        }
        console.log(`updateSamplePlaybackParameters [${note.id}]: Successfully updated note with new source/nodes.`);
        
        // CRITICAL FIX: Only rebuild FM if we actually have buffer sources to replace
        // Don't rebuild every time - only when necessary
        // After updating the sampler, update FM for oscillators in the same voice
        const parentVoice = note.parentVoice || voicePool.find(v => v.samplerNote === note);
        if (parentVoice) {
            const updateTime = audioCtx.currentTime;
            if (parentVoice.osc1Note) {
                updateOsc1FmModulatorParameters(parentVoice.osc1Note, updateTime, parentVoice);
            }
            if (parentVoice.osc2Note) {
                updateOsc2FmModulatorParameters(parentVoice.osc2Note, updateTime, parentVoice);
            }
        }
        
    } catch (error) {
        console.error(`updateSamplePlaybackParameters: Error during replacement:`, error);
        killSamplerNote(note);
        return null;
    }
    
    return note;
}

/**
* Sets up loop crossfade without recursion.
* (Do not call updateSamplePlaybackParameters or createNote here.)
*/

delete knobInitializations['adsr-knob']; 
// Update the DOMContentLoaded event listener
document.addEventListener('DOMContentLoaded', () => {
// Initialize all regular knobs
Object.entries(knobInitializations).forEach(([id, callback]) => {
const knob = D(id);
if (knob) {
const defaultValue = knobDefaults[id] !== undefined ? knobDefaults[id] : 0.5;
console.log(`[DOMContentLoaded] Initializing knob: ${id}, element:`, knob);
const control = initializeKnob(knob, callback, knobDefaults);

// Store reference to matrix-depth-knob control for programmatic updates
if (id === 'matrix-depth-knob') {
    matrixDepthKnobControl = control;
    console.log(`[DOMContentLoaded] Stored matrix-depth-knob control:`, control);
    // Verify the knob element after initialization
    const verifyKnob = document.getElementById('matrix-depth-knob');
    console.log(`[DOMContentLoaded] Verified matrix-depth-knob element after init:`, verifyKnob);
}
}
});

// Initialize ADSR mode buttons
initializeADSRModeButtons();

// Initialize ADSR slider sets with independent handlers
setupNonLinearADSRSliders();

// Initialize any remaining parameters
updateSampleProcessing();
});


// Add to global variables

// --- Voice Pool Management ---
const MAX_POLYPHONY = 6;
const voicePool = []; // Array to hold all voice objects
let nextVoiceIndex = 0; // Round-robin counter
let voiceAssignments = new Map(); // Track which notes are assigned to which voices
let voiceQueue = []; // FIFO queue to track voice usage order// New sampler voice pool
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
    panOffset: (Math.random() * 2 - 1) * VOICE_PAN_LIMIT,
    warbleOffset: (Math.random() * 2 - 1) * VOICE_DETUNE_LIMIT,
    // ADD: Envelope state tracking for sampler voices too
    envelopeState: 'idle', // 'idle', 'attack', 'decay', 'sustain', 'release'
    envelopeStartTime: 0,
    attackEndTime: 0,
    decayEndTime: 0,
    // ADD: Per-voice LFO and MOD canvas tracking
    lfoFadeStartTime: null,
    modCanvasEnvStartTime: null,
    modCanvasEnvPhase: 0.0,
    modCanvasEnvComplete: false
  };

  const samplerGainNode = ctx.createGain();
  const samplerSampleNode = ctx.createGain();
  const samplerSource = ctx.createBufferSource();
  
  // FM tap - gets signal BEFORE filter (unfiltered for FM)
  const samplerFMTap = ctx.createGain();
  samplerFMTap.gain.value = 1.0;
  
  // Create panner
  const samplerPanner = ctx.createStereoPanner();
  samplerPanner.pan.value = voice.panOffset;
  
  // CRITICAL: Build chain but DON'T connect panner to anything yet
  // Chain: source → sampleNode → fmTap (splits here for FM) → gainNode → panner → [FILTER or MASTER]
  samplerSource.connect(samplerSampleNode);
  samplerSampleNode.connect(samplerFMTap);
  samplerFMTap.connect(samplerGainNode);
  samplerGainNode.connect(samplerPanner);
  
  // CRITICAL: Don't connect panner anywhere yet - filter creation will do it
  
  voice.samplerNote = {
    id: `sampler_${index}`,
    type: 'sampler',
    noteNumber: null,
    source: samplerSource,
    gainNode: samplerGainNode,
    sampleNode: samplerSampleNode,
    fmTap: samplerFMTap,
    panner: samplerPanner,
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
  
  // CRITICAL FIX: Create filter and ensure ONLY ONE connection path
if (filterManager) {
  filterManager.createPersistentFilter(`sampler-${voice.id}`).then(filterInput => {
    const filterOutput = filterManager.getFilterOutput(`sampler-${voice.id}`);
    
    // CRITICAL: Connect amplitude gain node to filter for real-time tracking
    filterManager.setAmplitudeGainNode(`sampler-${voice.id}`, samplerGainNode);

    if (filterInput && filterOutput) {
      // ONLY connection: panner → filter input → filter output → samplerMasterGain
      samplerPanner.connect(filterInput);
      filterOutput.connect(samplerMasterGain);
      
      voice.filterInput = filterInput;
      voice.filterOutput = filterOutput;
      voice.hasFilter = true;
      voice.samplerNote.hasFilter = true; // Mark the note too
      
      console.log(`✓ Sampler voice ${voice.id} ONLY path: panner → filter → samplerMasterGain`);
    } else {
      // Fallback: Direct connection ONLY if filter failed
      samplerPanner.connect(samplerMasterGain);
      voice.hasFilter = false;
      voice.samplerNote.hasFilter = false;
      
      console.log(`✗ Sampler voice ${voice.id} direct: panner → samplerMasterGain (filter failed)`);
    }
  }).catch(err => {
    console.error(`Failed to create filter for sampler voice ${voice.id}:`, err);
    // Fallback on error
    samplerPanner.connect(samplerMasterGain);
    voice.hasFilter = false;
    voice.samplerNote.hasFilter = false;
  });
} else {
  // No filter manager - direct connection
  samplerPanner.connect(samplerMasterGain);
  voice.hasFilter = false;
  voice.samplerNote.hasFilter = false;
  console.log(`No filter manager for sampler voice ${voice.id}`);
}

  console.log(`Created sampler voice ${index} with pan: ${(voice.panOffset * 100).toFixed(1)}%, warble: ${voice.warbleOffset.toFixed(1)} cents`);
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

    // In mono mode, always use the same voice
    if (isMonoMode && currentMonoSamplerVoice) {
        const voiceToSteal = currentMonoSamplerVoice;
        voiceToSteal.wasStolen = voiceToSteal.state !== 'inactive';
        return voiceToSteal;
    }
    
    // For poly mode, use round-robin and ignore safety periods completely
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
// ADSR visualization with curved decay and release
function updateADSRVisualization() {
  // Read from the correct slider set based on mode
  let attack, decay, sustain, release;
  
  if (adsrMode === 'filter') {
    // Read from filter envelope sliders
    attack = parseFloat(D('filter-attack').dataset.mappedTime || D('filter-attack').value);
    decay = parseFloat(D('filter-decay').dataset.mappedTime || D('filter-decay').value);
    sustain = parseFloat(D('filter-sustain').value);
    release = parseFloat(D('filter-release').dataset.mappedTime || D('filter-release').value);
  } else {
    // Read from amplitude ADSR sliders
    attack = parseFloat(D('attack').dataset.mappedTime || D('attack').value);
    decay = parseFloat(D('decay').dataset.mappedTime || D('decay').value);
    sustain = parseFloat(D('sustain').value);
    release = parseFloat(D('release').dataset.mappedTime || D('release').value);
  }

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
  
  // Calculate sustain level Y position
  const sustainY = height - (sustain * height);
  
  // Create canvas at exact display size
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Make sure lines are drawn with proper alignment
  ctx.imageSmoothingEnabled = false;
  ctx.translate(0.5, 0.5);
  ctx.strokeStyle = '#f2eed3';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  
  // Clear canvas
  ctx.clearRect(-1, -1, width + 1, height + 1);

  // Draw ADSR path
  ctx.beginPath();
  ctx.moveTo(0, height - 1); // Start at bottom left
  
  // Attack (linear ramp - straight line)
  ctx.lineTo(attackX, 1);
  
  // Decay curve (starts steep, then flattens out)
  // Control points for the decay curve
  const decayControlX1 = attackX + (decayX - attackX) * 0.3;
  const decayControlY1 = 1 + (sustainY - 1) * 0.7; // Drop quickly at first
  
  const decayControlX2 = attackX + (decayX - attackX) * 0.7;
  const decayControlY2 = sustainY - (sustainY - 1) * 0.1; // Flatten out near end
  
  // Draw the curved decay segment
  ctx.bezierCurveTo(
    decayControlX1, decayControlY1,
    decayControlX2, decayControlY2,
    decayX, sustainY
  );
  
  // Sustain (straight line)
  ctx.lineTo(releaseStartX, sustainY);
  
  // Release curve (starts steep, then flattens out like decay)
  // Control points for the release curve
  const releaseControlX1 = releaseStartX + (releaseEndX - releaseStartX) * 0.3;
  const releaseControlY1 = sustainY + (height - 1 - sustainY) * 0.7; // Drop quickly at first
  
  const releaseControlX2 = releaseStartX + (releaseEndX - releaseStartX) * 0.7;
  const releaseControlY2 = height - 1 - (height - 1 - sustainY) * 0.1; // Flatten out near end
  
  // Draw the curved release segment
  ctx.bezierCurveTo(
    releaseControlX1, releaseControlY1,
    releaseControlX2, releaseControlY2,
    releaseEndX, height - 1
  );
  
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
// Event listeners for sliders are now set in setupNonLinearADSRSliders()





// Initialize switches on DOM load
document.addEventListener('DOMContentLoaded', () => {
//nitializeSwitches();
// Add this:


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

// Update cleanupAllNotes to clear voice timers
function cleanupAllNotes() {
    console.log("Performing complete synth reset...");
    
    const now = audioCtx.currentTime;
    const quickRelease = 0.01; // Very quick release for cleanup

    // Close all gates and reset all voices
    voicePool.forEach(voice => {
        // Clear any scheduled timers first
        clearVoiceTimers(voice);
        
        // Release Osc1 with quick fade
        if (voice.osc1Note?.workletNode) {
            voice.osc1Note.gainNode.gain.cancelScheduledValues(now);
            voice.osc1Note.gainNode.gain.setValueAtTime(voice.osc1Note.gainNode.gain.value, now);
            voice.osc1Note.gainNode.gain.linearRampToValueAtTime(0, now + quickRelease);
            
            // Close gate after quick release
            trackVoiceTimer(voice, () => {
                voice.osc1Note.workletNode.parameters.get('gate').setValueAtTime(0, audioCtx.currentTime);
            }, quickRelease * 1000);
            
            voice.osc1Note.state = 'idle';
            voice.osc1Note.noteNumber = null;
        }
        
        // Release Osc2 with quick fade
        if (voice.osc2Note?.workletNode) {
            voice.osc2Note.gainNode.gain.cancelScheduledValues(now);
            voice.osc2Note.gainNode.gain.setValueAtTime(voice.osc2Note.gainNode.gain.value, now);
            voice.osc2Note.gainNode.gain.linearRampToValueAtTime(0, now + quickRelease);
            
            // Close gate after quick release
            trackSetTimeout(() => {
                voice.osc2Note.workletNode.parameters.get('gate').setValueAtTime(0, audioCtx.currentTime);
            }, quickRelease * 1000);
            
            voice.osc2Note.state = 'idle';
            voice.osc2Note.noteNumber = null;
        }
        
        // Reset voice state
        voice.state = 'idle';
        voice.noteNumber = null;
        voice.startTime = 0;
    });
    
    // Clear all assignments and queue
    voiceAssignments.clear();
    voiceQueue.length = 0;
    nextVoiceIndex = 0;
    
    // Reset mono tracking
    currentMonoVoice = null;
    currentMonoSamplerVoice = null;
    
    // Clear held notes
    heldNotes = [];
    lastPlayedNoteNumber = null;
    // Clean up all filters
if (filterManager) {
    voicePool.forEach(voice => {
        if (filterManager && voice.hasFilter) {
        filterManager.noteOff(`osc-${voice.id}`);
        console.log(`Released filter envelope for voice ${voice.id} during cleanup`);
      }
    });

    
    samplerVoicePool.forEach(samplerVoice => {
    if (filterManager && samplerVoice.hasFilter) {  // FIXED: Changed 'voice' to 'samplerVoice'
        filterManager.noteOff(`sampler-${samplerVoice.id}`);  // FIXED: Changed 'voice' to 'samplerVoice'
        console.log(`Released filter envelope for sampler voice ${samplerVoice.id} during cleanup`);  // FIXED: Changed 'voice' to 'samplerVoice'
    }
});
    
    console.log("All filters cleaned up");
}
    // Reset UI
    resetKeyStates();
    updateVoiceDisplay_Pool();
    updateKeyboardDisplay_Pool();
    
    console.log("Complete synth reset finished - all voices idle");
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

// updateSliderValues() removed - sliders now initialize themselves in setupNonLinearADSRSliders()
updateVoiceDisplay_Pool();
updateADSRVisualization();
// Initialize Keyboard Module
initializeKeyboard('keyboard', noteOn, noteOff, updateKeyboardDisplay_Pool)


function createTooltipForKnob(knobId, value, position = 'top') {
const tooltip = document.getElementById(`${knobId}-tooltip`) || (() => {
const newTooltip = document.createElement('div');
newTooltip.id = `${knobId}-tooltip`;
newTooltip.className = 'tooltip';

// Add position class
if (position === 'right') {
    newTooltip.classList.add('tooltip-right');
} else if (position === 'bottom') {
    newTooltip.classList.add('tooltip-bottom');
}

// Find the knob and append tooltip to its parent container
const knob = D(knobId);
const parent = knob.parentElement;

// Ensure parent has position relative
if (parent && window.getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
}

// Append to parent instead of body
if (parent) {
    parent.appendChild(newTooltip);
} else {
    document.body.appendChild(newTooltip);
}

return newTooltip;
})();

return tooltip;
}

// Create tooltip for sliders
function createTooltipForSlider(slider, text, position = 'top') {
    const sliderId = slider.id || slider.className;
    let tooltip = document.getElementById(`${sliderId}-tooltip`);
    
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = `${sliderId}-tooltip`;
        tooltip.className = 'tooltip';
        
        // Find slider's parent container
        const parent = slider.parentElement;
        
        // Ensure parent has position relative
        if (parent && window.getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }
        
        // Append to parent instead of body
        if (parent) {
            parent.appendChild(tooltip);
        } else {
            document.body.appendChild(tooltip);
        }
    }
    
    // Remove any previous position classes
    tooltip.classList.remove('tooltip-right', 'tooltip-bottom', 'tooltip-top-right');
    
    // Add the appropriate position class
    if (position === 'right') {
        tooltip.classList.add('tooltip-right');
    } else if (position === 'bottom') {
        tooltip.classList.add('tooltip-bottom');
    } else if (position === 'top-right') {
        tooltip.classList.add('tooltip-top-right');
    }
    // 'top' is the default, no extra class needed
    
    // Use CSS positioning instead of calculated pixels
    // The CSS already handles centering with left: 50%, top: -30px, transform: translateX(-50%)
    
    tooltip.textContent = text;
    tooltip.style.display = 'block';
    tooltip.style.opacity = '1';
    
    return tooltip;
}

function hideTooltipForSlider(slider) {
    const sliderId = slider.id || slider.className;
    const tooltip = document.getElementById(`${sliderId}-tooltip`);
    if (tooltip) {
        tooltip.style.opacity = '0';
        setTimeout(() => { tooltip.style.display = 'none'; }, 200);
    }
}

// Update the document mouseup handler to hide all tooltips
document.addEventListener('mouseup', () => {
document.querySelectorAll('.tooltip').forEach(tooltip => {
tooltip.style.opacity = '0';
});
});

// DEBUG: Global click listener to see what's being clicked
document.addEventListener('click', (e) => {
    if (e.target.id === 'matrix-depth-knob' || e.target.closest('#matrix-depth-knob')) {
        console.log('[GLOBAL CLICK] matrix-depth-knob clicked!', e.target);
    }
}, true); // Use capture phase to catch it early

// DEBUG: Check what element is at the knob's position
window.checkDepthKnobClickability = function() {
    const knob = document.getElementById('matrix-depth-knob');
    const rect = knob.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const elementAtCenter = document.elementFromPoint(centerX, centerY);
    console.log('[CLICKABILITY CHECK] Element at knob center:', elementAtCenter);
    console.log('[CLICKABILITY CHECK] Is it the knob?', elementAtCenter === knob);
    console.log('[CLICKABILITY CHECK] Knob z-index:', window.getComputedStyle(knob).zIndex);
    console.log('[CLICKABILITY CHECK] Knob pointer-events:', window.getComputedStyle(knob).pointerEvents);
};

/**
 * Filter cutoff slider with non-linear mapping and precision control
 * 500Hz is exactly at the 50% mark
 * Values are stepped 1 by 1 from 8 to 16000 Hz
 */
function initializeFilterPrecisionSlider(slider) {
  // Use a wider range for better precision
  const sliderMinValue = 0;
  const sliderMaxValue = 7996; // 7996 with 0.5 steps = 15,993 discrete positions
  const sliderStep = 0.0001;
  
  // Frequency range remains the same
  const minFreq = 8;  // Hz
  const maxFreq = 16000; // Hz
  const midpointFreq = 500; // Hz - value at slider's visual midpoint
  
  // Remove any existing event listeners by cloning
  const newSlider = slider.cloneNode(true);
  slider.parentNode.replaceChild(newSlider, slider);
  
  // CRITICAL FIX: Ensure orient attribute is set for Safari
  if (!newSlider.hasAttribute('orient')) {
    newSlider.setAttribute('orient', 'vertical');
  }
  
  // Set slider attributes for high precision
  newSlider.min = sliderMinValue;
  newSlider.max = sliderMaxValue;
  newSlider.step = sliderStep;
  
  // Non-linear mapping functions (unchanged behavior)
  function sliderValueToPosition(value) {
    // Convert raw slider value to normalized position (0-1)
    return (value - sliderMinValue) / (sliderMaxValue - sliderMinValue);
  }
  
  function positionToFrequency(position) {
    position = Math.max(0, Math.min(1, position));
    if (position <= 0.5) {
      // First half maps to 8-500Hz (exponential)
      return Math.round(minFreq * Math.pow(midpointFreq/minFreq, position*2));
    } else {
      // Second half maps to 500-16000Hz (exponential)
      return Math.round(midpointFreq * Math.pow(maxFreq/midpointFreq, (position-0.5)*2));
    }
  }
  
  function frequencyToPosition(freq) {
    freq = Math.max(minFreq, Math.min(maxFreq, freq));
    if (freq <= midpointFreq) {
      return Math.log(freq/minFreq) / Math.log(midpointFreq/minFreq) * 0.5;
    } else {
      return 0.5 + Math.log(freq/midpointFreq) / Math.log(maxFreq/midpointFreq) * 0.5;
    }
  }
  
  function frequencyToSliderValue(freq) {
    // Convert frequency to normalized position (0-1)
    const position = frequencyToPosition(freq);
    // Convert position to slider value
    return position * (sliderMaxValue - sliderMinValue) + sliderMinValue;
  }
  
  // Standard input handler for direct slider interaction - SIMPLIFIED
  newSlider.addEventListener('input', function() {
    // Convert slider value to normalized position (0-1)
    const position = sliderValueToPosition(parseFloat(this.value));
    
    // Map position to frequency using non-linear mapping
    const frequency = positionToFrequency(position);
    
    // Show tooltip on the right
    createTooltipForSlider(this, `${Math.round(frequency)} Hz`, 'top-right');
    
    // Update filter cutoff
    if (filterManager) {
      filterManager.setCutoff(frequency);
    }
    
    console.log(`Filter: sliderValue=${this.value}, position=${position.toFixed(4)}, frequency=${frequency}Hz`);
  });
  
  // Hide tooltip on mouseup/touchend
  newSlider.addEventListener('mouseup', function() {
    hideTooltipForSlider(this);
  });
  
  newSlider.addEventListener('touchend', function() {
    hideTooltipForSlider(this);
  });
  
  // Initialize with maximum frequency (16000Hz)
  const initialSliderValue = frequencyToSliderValue(maxFreq);
  newSlider.value = initialSliderValue;
  
  // Trigger input event to set initial cutoff
  const event = new Event('input');
  newSlider.dispatchEvent(event);
  
  return newSlider;
}
function initializeADSRPrecisionSlider(slider) {
  // Keep original min/max
  const minTime = parseFloat(slider.min); // 0s
  const maxTime = parseFloat(slider.max); // 30s
  
  // Remove any existing event handlers by cloning
  const newSlider = slider.cloneNode(true);
  slider.parentNode.replaceChild(newSlider, slider);
  
  // Ensure the orient attribute is set (critical for Safari)
  if (!newSlider.hasAttribute('orient')) {
    newSlider.setAttribute('orient', 'vertical');
  }
  
  // Non-linear mapping functions
  function positionToTime(position) {
    position = Math.max(0, Math.min(1, position));
    if (position <= 0.5) {
      // First half maps to 0-5s (linear)
      return position * 10; // 0-0.5 → 0-5s
    } else {
      // Second half maps to 5-30s (linear)
      return 5 + (position - 0.5) * 50; // 0.5-1.0 → 5-30s
    }
  }
  
  function timeToPosition(time) {
    time = Math.max(0, Math.min(maxTime, time));
    if (time <= 5) {
      return time / 10; // 0-5s → 0-0.5
    } else {
      return 0.5 + (time - 5) / 50; // 5-30s → 0.5-1.0
    }
  }
  
  // Standard input handler - use native slider behavior
  newSlider.addEventListener('input', function(e) {
    // Get position from slider value
    const position = (parseFloat(this.value) - minTime) / (maxTime - minTime);
    
    // Map to time using non-linear mapping
    const timeValue = positionToTime(position);
    
    // Store the mapped time value in dataset
    this.dataset.mappedTime = timeValue.toFixed(3);
    
    // Update displayed value
    const valueDisplay = document.getElementById(`${slider.id}-value`);
    if (valueDisplay) {
      valueDisplay.textContent = timeValue.toFixed(3);
    }
    
    // Update ADSR visualization
    updateADSRVisualization();
    
    // Update filter ADSR ONLY if this is a filter envelope slider
    if (filterManager && filterManager.isActive && slider.id.startsWith('filter-')) {
      filterManager.setADSR(
        parseFloat(D('filter-attack').dataset.mappedTime || D('filter-attack').value),
        parseFloat(D('filter-decay').dataset.mappedTime || D('filter-decay').value),
        parseFloat(D('filter-sustain').value),
        parseFloat(D('filter-release').dataset.mappedTime || D('filter-release').value),
        classicModeEnabled
      );
    }
    
    console.log(`${slider.id}: pos=${position.toFixed(2)}, time=${timeValue.toFixed(3)}s`);
  });
  
  // Set initial values
  let initialTime = 0;
  if (slider.id === 'attack') initialTime = 0.00;
  else if (slider.id === 'decay') initialTime = 0.0;
  else if (slider.id === 'release') initialTime = 0.0;
  
  const initialPosition = timeToPosition(initialTime);
  newSlider.value = initialPosition * (maxTime - minTime) + minTime;
  
  // Store the initial mapped time
  newSlider.dataset.mappedTime = initialTime.toFixed(3);
  
  // Trigger input event to update everything
  const event = new Event('input');
  newSlider.dispatchEvent(event);
  
  return newSlider;
}
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

    // Determine if we're running on GitHub Pages
    const isGitHubPages = window.location.hostname.includes('github.io');
    
    // FIX: Don't duplicate the repository name in the path
    const basePath = isGitHubPages ? '/samples/' : '/samples/';
    const sampleUrl = new URL(basePath + filename, window.location.origin).href;
    
    console.log(`Loading sample from: ${sampleUrl}`);

    // Rest of your function remains the same...
    fetch(sampleUrl)
    .then(response => {
        if (!response.ok) {
            throw new Error(`Failed to load sample: ${response.status} ${response.statusText}`);
        }
        return response.arrayBuffer();
    })
    .then(arrayBuffer => {
        return audioCtx.decodeAudioData(arrayBuffer);
    })
    .then(buffer => {
        audioBuffer = buffer;
        originalBuffer = buffer.slice();
        
        // Apply reverse if needed
        if (isSampleReversed) {
            reverseBufferIfNeeded(false);
        }
        
        // Process fades and crossfades
        updateSampleProcessing();
        
        // Create new source node
        if (sampleSource) {
            sampleSource.stop();
        }
        sampleSource = audioCtx.createBufferSource();
        sampleSource.buffer = buffer;
        sampleSource.connect(sampleGainNode);
        sampleSource.start();
        
        // UPDATE LABEL
        const fileLabel = document.querySelector('label[for="audio-file"]');
        if (fileLabel) {
            fileLabel.textContent = filename.substring(0, 10) + (filename.length > 10 ? '...' : '');
        }
        
        // CRITICAL FIX: Force FM connection update after sample is loaded
        setTimeout(() => {
    // REMOVED: forceFMConnectionUpdate(); // Don't force update here - it resets depths
    
    // Update any active sampler notes
    voicePool.forEach(voice => {
        if (voice.state !== 'inactive' && voice.samplerNote) {
            if (!heldNotes.includes(voice.noteNumber)) {
                updateSamplePlaybackParameters(voice.samplerNote);
            }
        }
    });
}, 100);



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
        // Initialize FM sources after loading
        initializeSamplerFmSources();
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

  // Set parent voice state to releasing
  const voice = note.parentVoice || samplerVoicePool.find(v => v.samplerNote === note);
  if (voice && voice.state === 'playing') {
    voice.state = 'releasing';
  }

  // Set component state and clear existing timers
  note.state = "releasing";
  clearScheduledEventsForNote(note);

  // Keep crossfade handling as is
  if (!note.crossfadeActive && !isSampleLoopOn) {
    note.source.loop = false;
    note.looping = false;
  } else if (note.crossfadeActive && note.source.loop) {
    console.log(`Keeping crossfade loop active during release for ${note.id}`);
  }

  // Apply release envelope
  const release = Math.max(0.01, parseFloat(D('release').dataset.mappedTime || D('release').value));
  const now = audioCtx.currentTime;
  
  // Apply curved release envelope with natural decay
  const currentGain = note.gainNode.gain.value;
  applyCurvedEnvelope(note.gainNode.gain, currentGain, 0, release, now, 'release');

  // Apply curved release to sample gain as well
  const currentSampleGain = note.sampleNode.gain.value;
  applyCurvedEnvelope(note.sampleNode.gain, currentSampleGain, 0, release, now, 'release');

  // Rest of the function remains the same
  const stopTime = now + release + 0.05;
  
  if (!note.looping && !note.crossfadeActive) {
    try {
      note.source.stop(stopTime);
    } catch (e) { /* Ignore errors */ }
  } else {
    console.log(`Not scheduling stop for looping/crossfaded sample ${note.id} - will loop during release`);
  }

  // Schedule kill after release with proper timing
  const killDelay = Math.max(5, (release * 1000) + 0);
  trackSetTimeout(() => {
    killSamplerNote(note);
  }, killDelay, note);
  
  console.log(`releaseSamplerNote: Scheduled kill for ${note.id} in ${killDelay}ms with curved release envelope`);
}

function killSamplerNote(note) {
    // Remove safety period check entirely
    
    // Check if note is valid and not already killed
    if (!note) {
        console.warn(`killSamplerNote: Called with null note`);
        return false;
    }
    
    if (note.state === "killed") {
        console.log(`killSamplerNote: Note ${note.id} already killed, ignoring`);
        return false;
    }
    
    // Only proceed with kill if note is still in releasing state
    if (note.state !== 'releasing') {
        console.log(`killSamplerNote: Note ${note.id} is in state '${note.state}', not 'releasing'. Ignoring kill timer.`);
        return false;
    }
    
    const noteId = note.id;
    console.log(`killSamplerNote: Starting kill process for ${noteId}`);

    // Mark as killed immediately to prevent further processing
    note.state = "killed";

    // Clear ALL scheduled events first
    clearScheduledEventsForNote(note);

    try {
        // Immediately kill all audio to make voice available ASAP
        if (note.gainNode) {
            note.gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
            note.gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
        }
        
        if (note.sampleNode) {
            note.sampleNode.gain.cancelScheduledValues(audioCtx.currentTime);
            note.sampleNode.gain.setValueAtTime(0, audioCtx.currentTime);
        }
        
        if (note.source) {
            try { note.source.stop(audioCtx.currentTime); } catch(e) { /* Ignore */ }
            try { note.source.disconnect(); } catch(e){ /* Ignore */ }
        }
    } catch (e) {
        console.warn(`killSamplerNote [${noteId}]: Error during node cleanup:`, e);
    }

    // Update Voice Pool State
    const voice = note.parentVoice;

    if (voice && samplerVoicePool.includes(voice)) {
        // Reset the component note state immediately
        note.state = 'inactive';
        note.noteNumber = null;
        note.source = null;

        // Reset the parent voice state immediately
        voice.state = 'inactive';
        voice.noteNumber = null;
        voice.startTime = 0;
        
        // Reset MOD canvas envelope state
        voice.modCanvasEnvStartTime = null;
        voice.modCanvasEnvPhase = 0.0;
        voice.modCanvasEnvComplete = false;
        
        // Reset MOD canvas TRIG state
        voice.modCanvasTrigStartTime = null;
        voice.modCanvasTrigPhase = 0.0;
        
        // Remove safety period completely - allow immediate reuse
        // voice.safeUntil = undefined;

        if (isMonoMode && currentMonoSamplerVoice === voice) {
            currentMonoSamplerVoice = null;
        }

        // Update UI
        updateVoiceDisplay_Pool();
        updateKeyboardDisplay_Pool();
    }

    console.log(`killSamplerNote: Finished killing ${noteId}`);
    return true;
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
            
            // Reset MOD canvas envelope state
            voice.modCanvasEnvStartTime = null;
            voice.modCanvasEnvPhase = 0.0;
            voice.modCanvasEnvComplete = false;
            
            // Reset MOD canvas TRIG state
            voice.modCanvasTrigStartTime = null;
            voice.modCanvasTrigPhase = 0.0;
            
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
            
            // Reset MOD canvas envelope state
            voice.modCanvasEnvStartTime = null;
            voice.modCanvasEnvPhase = 0.0;
            voice.modCanvasEnvComplete = false;
            
            // Reset MOD canvas TRIG state
            voice.modCanvasTrigStartTime = null;
            voice.modCanvasTrigPhase = 0.0;
            
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
    if (!osc2Note || !osc2Note.workletNode || !voice) {
        return;
    }
    
    const fmDepthParam = osc2Note.workletNode.parameters.get('fmDepth');
    if (!fmDepthParam) return;
    
    const noteId = osc2Note.id || 'unknown';
    const scaledDepth = osc2FMAmount * osc2FMDepthScale;
    
    if (!osc2Note.fmDepthGain) {
        osc2Note.fmDepthGain = audioCtx.createGain();
    }
    osc2Note.fmDepthGain.gain.setValueAtTime(scaledDepth, now);
    
    // CRITICAL FIX: Disconnect ALL possible FM sources first
    try {
        osc2Note.fmDepthGain.disconnect();
    } catch(e) {}
    
    // CRITICAL FIX: Also try to disconnect any sources that might still be connected
    // This handles the case where we're switching FROM osc1 TO sampler
    if (voice.osc1Note && voice.osc1Note.workletNode) {
        try {
            voice.osc1Note.workletNode.disconnect(osc2Note.fmDepthGain);
        } catch(e) {}
    }
    
    // CRITICAL FIX: Disconnect any sampler FM taps that might be connected
    samplerVoicePool.forEach(sv => {
        if (sv.samplerNote && sv.samplerNote.fmTap) {
            try {
                sv.samplerNote.fmTap.disconnect(osc2Note.fmDepthGain);
            } catch(e) {}
        }
    });
    
    let fmSource = null;
    
    if (osc2FMSource === 'sampler') {
        // Find the ACTUAL sampler voice in samplerVoicePool
        const actualSamplerVoice = samplerVoicePool.find(
            sv => sv.noteNumber === voice.noteNumber && 
                  sv.state !== 'inactive' && 
                  sv.samplerNote && 
                  sv.samplerNote.fmTap
        );
        
        if (actualSamplerVoice && actualSamplerVoice.samplerNote.fmTap) {
            fmSource = actualSamplerVoice.samplerNote.fmTap;
            console.log(`OSC2 [${noteId}]: Switching to sampler FM tap from samplerVoice ${actualSamplerVoice.id}`);
        } else {
            console.warn(`OSC2 [${noteId}]: No active sampler found for FM`);
        }
    } else if (osc2FMSource === 'osc1') {
        if (voice.osc1Note && voice.osc1Note.workletNode) {
            fmSource = voice.osc1Note.workletNode;
            console.log(`OSC2 [${noteId}]: Switching to OSC1 worklet from voice ${voice.id}`);
        }
    }
    
    if (fmSource) {
        try {
            // CRITICAL: Connect the NEW source
            fmSource.connect(osc2Note.fmDepthGain);
            osc2Note.fmDepthGain.connect(osc2Note.workletNode, 0, 0);
            fmDepthParam.setValueAtTime(scaledDepth, now);
            console.log(`OSC2 [${noteId}]: FM reconnected to ${osc2FMSource} with depth ${scaledDepth.toFixed(1)} Hz`);
        } catch(e) {
            console.error(`OSC2 [${noteId}]: FM connection error: ${e.message}`);
            fmDepthParam.setValueAtTime(0, now);
        }
    } else {
        fmDepthParam.setValueAtTime(0, now);
    }
}
// Add warble animation function around line 4000
function applyPitchWarble(voice, now) {
    if (!voice) return;
    
    const settleTime = WARBLE_SETTLE_TIME;
    
    // Apply warble to OSC1
    if (voice.osc1Note && voice.osc1Note.workletNode) {
        const detuneParam = voice.osc1Note.workletNode.parameters.get('detune');
        if (detuneParam) {
            // Start with the random warble offset
            detuneParam.setValueAtTime(osc1Detune + voice.warbleOffset, now);
            // Settle back to base detune over 150ms
            detuneParam.linearRampToValueAtTime(osc1Detune, now + settleTime);
        }
    }
    
    // Apply warble to OSC2
    if (voice.osc2Note && voice.osc2Note.workletNode) {
        const detuneParam = voice.osc2Note.workletNode.parameters.get('detune');
        if (detuneParam) {
            detuneParam.setValueAtTime(osc2Detune + voice.warbleOffset, now);
            detuneParam.linearRampToValueAtTime(osc2Detune, now + settleTime);
        }
    }
}

// Apply warble to sampler voices around line 4200
function applySamplerWarble(samplerVoice, now) {
    if (!samplerVoice || !samplerVoice.samplerNote || !samplerVoice.samplerNote.source) return;
    
    const source = samplerVoice.samplerNote.source;
    const settleTime = WARBLE_SETTLE_TIME;
    
    // Apply warble to sampler detune
    const baseDetune = currentSampleDetune;
    source.detune.setValueAtTime(baseDetune + samplerVoice.warbleOffset, now);
    source.detune.linearRampToValueAtTime(baseDetune, now + settleTime);
}
// Also ensure noteOn properly sets up the envelope from zero
function noteOn(noteNumber, isLegatoMonoTransition = false) {
    if (isModeTransitioning) return;
    
    const now = audioCtx.currentTime;

    // Add to held notes
    if (!heldNotes.includes(noteNumber)) {
        heldNotes.push(noteNumber);
        heldNotes.sort((a, b) => a - b);
    }
    
    // CRITICAL FIX: Use the mapped time values from dataset for attack and decay too
    const attack = Math.max(0.003, parseFloat(D('attack').dataset.mappedTime || D('attack').value));
    const decay = parseFloat(D('decay').dataset.mappedTime || D('decay').value);
    const sustain = parseFloat(D('sustain').value);

    // Store the previous played note before getting a new voice
    const previousNoteNumber = lastPlayedNoteNumber;

    // --- DETERMINE LEGATO STATE ---
    // Check if we're in mono mode with legato enabled and if we're triggering a new note while another is held
    // Now use BOTH the legato mode setting AND the passed parameter
    const isLegatoActive = isMonoMode && (isLegatoMode || isLegatoMonoTransition) && previousNoteNumber !== null;
    
    // For true legato, we need at least one previously held note that's not in release stage
    let legatoTransition = false;
    
    if (isLegatoActive) {
        // We have a mono voice that we're using
        const monoVoice = voicePool[0];
        
        // Check if any component is in playing state (not releasing)
        const hasPreviousActiveSampler = monoVoice.samplerNote && monoVoice.samplerNote.state === 'playing';
        const hasPreviousActiveOsc1 = monoVoice.osc1Note && monoVoice.osc1Note.state === 'playing';
        const hasPreviousActiveOsc2 = monoVoice.osc2Note && monoVoice.osc2Note.state === 'playing';
        
        // Only use legato if at least one component is in playing state
        legatoTransition = hasPreviousActiveSampler || hasPreviousActiveOsc1 || hasPreviousActiveOsc2;
        
        console.log(`Legato check: Active=${isLegatoActive}, Transition=${legatoTransition}, Components: Sampler=${hasPreviousActiveSampler}, Osc1=${hasPreviousActiveOsc1}, Osc2=${hasPreviousActiveOsc2}`);
    }
    // --- SAMPLER VOICE ALLOCATION ---
    // Find or allocate a sampler voice
    let samplerVoice = null;
    let wasSamplerStolen = false;
    
    if (audioBuffer) { // Only allocate if we have a sample
        if (isMonoMode) {
            // In mono mode, always use the same voice
            samplerVoice = currentMonoSamplerVoice || findAvailableSamplerVoice(noteNumber);
            currentMonoSamplerVoice = samplerVoice;
            wasSamplerStolen = samplerVoice.state !== 'inactive';
        } else {
            // In poly mode, find an available voice
            samplerVoice = findAvailableSamplerVoice(noteNumber);
            wasSamplerStolen = samplerVoice.state !== 'inactive';
        }
    }
    
    // --- OSCILLATOR VOICE ALLOCATION (EXISTING) ---
    // Get a voice for oscillators (may be stolen)
    const voice = findAvailableVoice(noteNumber);
    if (!voice) {
        console.error("noteOn: Could not assign a voice!");
        return;
    }
    
    // CRITICAL: Clear all previous timers for this voice when stealing it
    clearVoiceTimers(voice);

    // Set master clock rates based on the note
    setMasterClockRate(1, noteNumber, osc1Detune);
    setMasterClockRate(2, noteNumber + 12, osc2Detune); // Add 12 semitones (1 octave) to OSC2

    // Check voice states
    const isRetrigger = voice.noteNumber === noteNumber && voice.state === 'active';
    const isVoiceSteal = voice.state === 'active' && voice.noteNumber !== noteNumber;
    const isReleasingSteal = voice.state === 'releasing';
    const wasActive = voice.state === 'active' || voice.state === 'releasing';
    
    // Store old note for glide
    const oldNoteNumber = voice.noteNumber;
// When setting up the filter, ensure legatoTransition is respected:
    if (filterManager && filterManager.isActive) {
        if (voice.osc1Note) {
            // Pass legatoTransition=true when in legato mono mode
            const isFilterLegato = legatoTransition || isLegatoMonoTransition;
            filterManager.noteOn(`osc-${voice.id}`, noteNumber, 1.0, !isFilterLegato, voice.envelopeState, undefined, isFilterLegato);
            filterManager.connectVoiceEnvelope(`osc-${voice.id}`, voice.osc1Note.gainNode);
            console.log(`Filter ${isFilterLegato ? 'continues' : 'starts'} tracking amplitude for voice ${voice.id} (${isMonoMode ? 'mono' : 'poly'})`);
        }
        
        // Do the same for sampler
        if (samplerVoice && samplerVoice.samplerNote) {
            const isFilterLegato = legatoTransition || isLegatoMonoTransition;
            filterManager.noteOn(`sampler-${samplerVoice.id}`, noteNumber, 1.0, !isFilterLegato, samplerVoice.envelopeState, undefined, isFilterLegato);
            filterManager.connectVoiceEnvelope(`sampler-${samplerVoice.id}`, samplerVoice.samplerNote.gainNode);
            console.log(`Filter ${isFilterLegato ? 'continues' : 'starts'} tracking amplitude for sampler ${samplerVoice.id} (${isMonoMode ? 'mono' : 'poly'})`);
        }
    }
// Store previous envelope state for sophisticated retriggering
const previousEnvelopeState = voice.envelopeState;
const wasInAttack = previousEnvelopeState === 'attack';
const wasInDecay = previousEnvelopeState === 'decay';
const wasInSustain = previousEnvelopeState === 'sustain';
const wasInRelease = previousEnvelopeState === 'release';
const wasReleasing = voice.state === 'releasing' || previousEnvelopeState === 'release';
setMasterClockRate(1, noteNumber, osc1Detune);
    // Update voice state
    voice.noteNumber = noteNumber;
    voice.startTime = now;
    voice.state = 'active';
    voice.currentReleaseId = null;
    voice.wasStolen = false;
    
    // Set per-voice LFO fade start time
    if (lfoFade > 0) {
        voice.lfoFadeStartTime = now;
    }
    
    // Set per-voice MOD canvas envelope start time (ENV mode)
    if (modCanvasMode === 'env') {
        voice.modCanvasEnvStartTime = now;
        voice.modCanvasEnvPhase = 0.0;
        voice.modCanvasEnvComplete = false;
    }
    
    // Set per-voice MOD canvas TRIG start time (TRIG mode)
    if (modCanvasMode === 'trig') {
        voice.modCanvasTrigStartTime = now;
        voice.modCanvasTrigPhase = 0.0;
    }
    
    if (voice) {
    const fmUpdateTime = now + 0.01; // Small delay to ensure everything is connected
    
    // Set up FM for OSC1
    if (voice.osc1Note && osc1FMAmount > 0.001) {
        updateOsc1FmModulatorParameters(voice.osc1Note, fmUpdateTime, voice);
    }
    
    // Set up FM for OSC2
    if (voice.osc2Note && osc2FMAmount > 0.001) {
        updateOsc2FmModulatorParameters(voice.osc2Note, fmUpdateTime, voice);
    }
}
    // --- GLIDE TIME CALCULATION --- MOVED EARLIER
    let glideSourceNote = null;
    
    if (isPortamentoOn) {
        glideSourceNote = previousNoteNumber;
        console.log(`Portamento ON: Gliding from previous note ${previousNoteNumber} to ${noteNumber}`);
    } else if (isVoiceSteal || isReleasingSteal) {
        glideSourceNote = oldNoteNumber;
        console.log(`Voice stealing: Gliding from stolen note ${oldNoteNumber} to ${noteNumber}`);
    }
    
    let effectiveGlideTime = 0.001;
    
    if (isPortamentoOn) {
        effectiveGlideTime = Math.max(0.001, glideTime);
    } else if ((isVoiceSteal || isReleasingSteal) && glideTime > 0) {
        effectiveGlideTime = Math.max(0.001, glideTime * 0.5);
    }
    
    // --- SAMPLER VOICE CONFIGURATION ---
if (audioBuffer && samplerVoice) {
    // Configure the sampler note
    const samplerNote = samplerVoice.samplerNote;
    
    // Determine if we need to create a new source or reuse existing
    let needNewSource = true;
    let oldPlaybackRate = 1.0;
    
    // CRITICAL FIX: Force new source (restart from beginning) when:
    // 1. Loop/crossfade is OFF, AND
    // 2. This is a stolen voice (not a fresh voice allocation)
    if (samplerNote.source && (samplerNote.state === 'playing' || samplerNote.state === 'releasing')) {
        // Check if we should restart the sampler
        if (!isSampleLoopOn && wasSamplerStolen) {
            // Force restart with new source when not looping and voice was stolen
            needNewSource = true;
            console.log(`Restarting sampler from beginning for stolen voice ${samplerVoice.id} (crossfade OFF)`);
        } else {
            // Otherwise reuse existing source (continue playback)
            needNewSource = false;
            oldPlaybackRate = samplerNote.source.playbackRate.value || 1.0;
            console.log(`Reusing existing sampler source for voice ${samplerVoice.id} (state: ${samplerNote.state})`);
        }
    }
        
        // Create new source only if needed
        if (needNewSource) {
        if (samplerNote.source) {
            try { 
                samplerNote.source.stop(now); 
                samplerNote.source.disconnect();
            } catch(e) { /* Ignore errors */ }
        }
        
        // Create new source with appropriate buffer
samplerNote.source = audioCtx.createBufferSource();

// Select the appropriate buffer
let sourceBuffer = audioBuffer;
let bufferInfo = null;
if (isSampleLoopOn && cachedCrossfadedBuffer) {
    sourceBuffer = cachedCrossfadedBuffer;
    
    // Get crossfade information
    if (sampleCrossfadeAmount < 0.05) {
        // For small crossfade amounts (<5%), use simple loop
        bufferInfo = {
            loopStartSample: 0, 
            crossfadeLengthSamples: 0,
            crossfadeFraction: 0
        };
        samplerNote.usesProcessedBuffer = true;
        samplerNote.crossfadeActive = false;
        console.log(`Using simple loop for note ${noteNumber} (no crossfade, clean edges)`);
    } else {
        // For larger crossfade amounts, use proper crossfade with loopStartSample
        bufferInfo = {
            loopStartSample: lastCachedCrossfade ? Math.floor(cachedCrossfadedBuffer.length * lastCachedCrossfade * 0.5) : 0,
            crossfadeLengthSamples: lastCachedCrossfade ? Math.floor(cachedCrossfadedBuffer.length * lastCachedCrossfade * 0.5) : 0,
            crossfadeFraction: lastCachedCrossfade ? lastCachedCrossfade : 0
        };
        samplerNote.usesProcessedBuffer = true;
        samplerNote.crossfadeActive = true;
        console.log(`Using cached crossfaded buffer for note ${noteNumber}`);
    }
} else if (fadedBuffer && (!isSampleLoopOn || sampleCrossfadeAmount <= 0.01)) {
    sourceBuffer = fadedBuffer;
    samplerNote.usesProcessedBuffer = true;
    samplerNote.crossfadeActive = false;
    console.log(`Using cached faded buffer for note ${noteNumber}`);
} else {
    samplerNote.usesProcessedBuffer = false;
    samplerNote.crossfadeActive = false;
    console.log(`Using original buffer for note ${noteNumber}`);
}

// Configure the new source
samplerNote.source.buffer = sourceBuffer;

// After creating the source and setting the buffer:
if (isSampleLoopOn) {
    samplerNote.source.loop = true;
    
    if (bufferInfo && bufferInfo.loopStartSample !== undefined && sampleCrossfadeAmount >= 0.05) {
        // Advanced crossfade mode - use calculated loop start point
        const loopStartSample = bufferInfo.loopStartSample;
        const loopStartTime = loopStartSample / samplerNote.source.buffer.sampleRate;
        
        samplerNote.source.loopStart = loopStartTime;
        samplerNote.source.loopEnd = samplerNote.source.buffer.duration;
        
        // Store crossfade information on the note
        samplerNote.crossfadeLength = bufferInfo.crossfadeLengthSamples;
        samplerNote.crossfadeFraction = bufferInfo.crossfadeFraction;
        
        console.log(`Advanced crossfade loop: loopStart=${loopStartTime.toFixed(3)}s, loopEnd=${samplerNote.source.buffer.duration.toFixed(3)}s`);
    } else {
        // Simple loop - loop the entire buffer with no offset
        samplerNote.source.loopStart = 0;
        samplerNote.source.loopEnd = samplerNote.source.buffer.duration;
        samplerNote.crossfadeLength = 0;
        samplerNote.crossfadeFraction = 0;
        
        console.log(`Simple loop for note ${noteNumber}: looping entire buffer with clean edges`);
    }
}
        // NEW: Apply pitch warble to sampler
    applySamplerWarble(samplerVoice, now);
        // Connect the audio path
        samplerNote.source.connect(samplerNote.sampleNode);
        
        // Start playback for new sources only
        samplerNote.source.start(now);
        console.log(`Started new sampler source for note ${noteNumber}`);
    }
    
    // --- APPLY PORTAMENTO/GLIDE ---
    // Calculate target playback rate based on key tracking
    const newPlaybackRate = isSampleKeyTrackingOn ? TR2 ** (noteNumber - 12) : 1.0;
    let applyGlide = false;
    let glideSourceRate = oldPlaybackRate;
    
    // Determine if we should apply portamento/glide
    if (isPortamentoOn && previousNoteNumber !== null) {
        applyGlide = true;
        // Calculate previous note rate (if portamento is on)
        glideSourceRate = isSampleKeyTrackingOn ? TR2 ** (previousNoteNumber - 12) : 1.0;
        console.log(`Sampler Portamento: Gliding from rate ${glideSourceRate.toFixed(3)} to ${newPlaybackRate.toFixed(3)}`);
    } else if (wasSamplerStolen && !needNewSource) {
        // For voice stealing without creating a new source, apply glide
        applyGlide = glideTime > 0;
        console.log(`Sampler Voice Steal: ${applyGlide ? "Gliding" : "Jumping"} to new rate ${newPlaybackRate.toFixed(3)}`);
    }
    
    // Apply rate changes with or without glide
    if (applyGlide && effectiveGlideTime > 0.001) {
        // Apply glide for playback rate
        samplerNote.source.playbackRate.cancelScheduledValues(now);
        samplerNote.source.playbackRate.setValueAtTime(glideSourceRate, now);
        samplerNote.source.playbackRate.linearRampToValueAtTime(newPlaybackRate, now + effectiveGlideTime);
    } else {
        // Immediate rate change (no glide)
        samplerNote.source.playbackRate.setValueAtTime(newPlaybackRate, now);
    }
    
    // Always apply detune directly
    samplerNote.source.detune.setValueAtTime(currentSampleDetune, now);
    
    // Reset gain nodes and apply ADSR envelope
        samplerNote.sampleNode.gain.cancelScheduledValues(now);
        samplerNote.sampleNode.gain.setValueAtTime(currentSampleGain, now);
        
        // SOPHISTICATED SAMPLER ENVELOPE
samplerNote.gainNode.gain.cancelScheduledValues(now);

// FIX: Define currentGain outside any conditional blocks to ensure it exists
const currentGain = wasActive ? samplerNote.gainNode.gain.value : 0;

if (legatoTransition && samplerNote.state === 'playing') {
  // LEGATO MODE logic remains
  if (wasInAttack || wasInDecay) {
    samplerNote.gainNode.gain.setValueAtTime(currentGain, now);
    
    if (wasInAttack) {
      // Continue attack
      const remainingAttackTime = attack * (1.0 - currentGain);
      samplerNote.gainNode.gain.linearRampToValueAtTime(1.0, now + remainingAttackTime);
      
      // Apply curved decay
      applyCurvedEnvelope(samplerNote.gainNode.gain, 1.0, sustain, decay, now + remainingAttackTime, 'decay');
      
      voice.envelopeState = 'attack';
      voice.attackEndTime = now + remainingAttackTime;
      voice.decayEndTime = now + remainingAttackTime + decay;
      
      console.log(`Legato sampler: Continuing attack from ${currentGain.toFixed(3)}, ${remainingAttackTime.toFixed(3)}s remaining, with curved decay`);
    } else {
      // Continue from decay with a curved envelope
      const decayProgress = (1.0 - currentGain) / (1.0 - sustain);
      const remainingDecayTime = decay * (1.0 - decayProgress);
      
      // Apply curved decay from the current point
      applyCurvedEnvelope(samplerNote.gainNode.gain, currentGain, sustain, remainingDecayTime, now, 'decay');
      
      voice.envelopeState = 'decay';
      voice.decayEndTime = now + remainingDecayTime;
      
      console.log(`Legato sampler: Continuing curved decay from ${currentGain.toFixed(3)}, ${remainingDecayTime.toFixed(3)}s remaining`);
    }
  } else {
        // Reset to sustain if in sustain or release
        samplerNote.gainNode.gain.setValueAtTime(sustain, now);
        voice.envelopeState = 'sustain';
        console.log(`Legato sampler: Reset to sustain ${sustain.toFixed(3)}`);
    }

} else if (!isMonoMode && wasSamplerStolen) {
    // MULTI MODE: Sophisticated envelope behavior
    samplerNote.gainNode.gain.cancelScheduledValues(now);
    const currentGain = samplerNote.gainNode.gain.value;
    
    // CRITICAL FIX: Check if we're stealing from a RELEASING voice
    const stealingFromRelease = voice.state === 'releasing' || previousEnvelopeState === 'release';
    
    if (stealingFromRelease) {
        // Always start fresh from 0 when stealing from release
        samplerNote.gainNode.gain.setValueAtTime(0, now);
        samplerNote.gainNode.gain.linearRampToValueAtTime(1.0, now + attack);
        samplerNote.gainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);
        
        voice.envelopeState = 'attack';
        voice.envelopeStartTime = now;
        voice.attackEndTime = now + attack;
        voice.decayEndTime = now + attack + decay;
        
        samplerVoice.envelopeState = 'attack';
        samplerVoice.envelopeStartTime = now;
        samplerVoice.attackEndTime = now + attack;
        samplerVoice.decayEndTime = now + attack + decay;
        
        console.log(`Multi sampler: Fresh attack from 0 (stolen from release)`);
    } else if (wasInAttack) {
        const remainingAttackTime = attack * (1.0 - currentGain);
        samplerNote.gainNode.gain.setValueAtTime(currentGain, now);
        samplerNote.gainNode.gain.linearRampToValueAtTime(1.0, now + remainingAttackTime);
        samplerNote.gainNode.gain.linearRampToValueAtTime(sustain, now + remainingAttackTime + decay);
        
        // CRITICAL FIX: Update BOTH voice objects
        voice.envelopeState = 'attack';
        voice.envelopeStartTime = now;
        voice.attackEndTime = now + remainingAttackTime;
        voice.decayEndTime = now + remainingAttackTime + decay;
        
        // ADD: Also update the sampler voice
        samplerVoice.envelopeState = 'attack';
        samplerVoice.envelopeStartTime = now;
        samplerVoice.attackEndTime = now + remainingAttackTime;
        samplerVoice.decayEndTime = now + remainingAttackTime + decay;
        
        console.log(`Multi sampler: Continuing attack from ${currentGain.toFixed(3)}, ${remainingAttackTime.toFixed(3)}s remaining`);
    } else if (wasInDecay) {
        const currentGain = samplerNote.gainNode.gain.value;
        samplerNote.gainNode.gain.setValueAtTime(currentGain, now);
        samplerNote.gainNode.gain.linearRampToValueAtTime(1.0, now + attack);
        samplerNote.gainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);
        
        voice.envelopeState = 'attack';
        voice.envelopeStartTime = now;
        voice.attackEndTime = now + attack;
        voice.decayEndTime = now + attack + decay;
        
        // ADD: Also update the sampler voice
        samplerVoice.envelopeState = 'attack';
        samplerVoice.envelopeStartTime = now;
        samplerVoice.attackEndTime = now + attack;
        samplerVoice.decayEndTime = now + attack + decay;
        
        console.log(`Multi sampler: Reset from decay (gain ${currentGain.toFixed(3)}) to attack`);
    } else if (wasInSustain) {
        samplerNote.gainNode.gain.setValueAtTime(sustain, now);
        samplerNote.gainNode.gain.linearRampToValueAtTime(1.0, now + attack);
        samplerNote.gainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);
        
        voice.envelopeState = 'attack';
        voice.envelopeStartTime = now;
        voice.attackEndTime = now + attack;
        voice.decayEndTime = now + attack + decay;
        
        // ADD: Also update the sampler voice
        samplerVoice.envelopeState = 'attack';
        samplerVoice.envelopeStartTime = now;
        samplerVoice.attackEndTime = now + attack;
        samplerVoice.decayEndTime = now + attack + decay;
        
        console.log(`Multi sampler: From sustain ${sustain.toFixed(3)}, new envelope`);
    } else {
        const currentGain = samplerNote.gainNode.gain.value || 0;
        samplerNote.gainNode.gain.setValueAtTime(currentGain, now);
        samplerNote.gainNode.gain.linearRampToValueAtTime(1.0, now + attack);
        samplerNote.gainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);
        
        voice.envelopeState = 'attack';
        voice.envelopeStartTime = now;
        voice.attackEndTime = now + attack;
        voice.decayEndTime = now + attack + decay;
        
        // ADD: Also update the sampler voice
        samplerVoice.envelopeState = 'attack';
        samplerVoice.envelopeStartTime = now;
        samplerVoice.attackEndTime = now + attack;
        samplerVoice.decayEndTime = now + attack + decay;
    }
} else {
  // For fresh notes, apply linear attack and curved decay
  samplerNote.gainNode.gain.setValueAtTime(0, now);
  samplerNote.gainNode.gain.linearRampToValueAtTime(1.0, now + attack);
  
  // Apply curved decay
  applyCurvedEnvelope(samplerNote.gainNode.gain, 1.0, sustain, decay, now + attack, 'decay');
  
  voice.envelopeState = 'attack';
  voice.attackEndTime = now + attack;
  voice.decayEndTime = now + attack + decay;
}

// Schedule envelope state updates for BOTH voices
trackVoiceTimer(voice, () => {
    if (voice.envelopeState === 'attack') {
        voice.envelopeState = 'decay';
        samplerVoice.envelopeState = 'decay'; // ADD: Keep sampler voice in sync
        console.log(`Voice ${voice.id} entered decay state`);
    }
}, attack * 1000);

trackVoiceTimer(voice, () => {
    if (voice.envelopeState === 'decay') {
        voice.envelopeState = 'sustain';
        samplerVoice.envelopeState = 'sustain'; // ADD: Keep sampler voice in sync
        console.log(`Voice ${voice.id} entered sustain state`);
    }
}, (attack + decay) * 1000);

samplerNote.state = 'playing';
// --- FILTER TRIGGER (simplified) ---
if (filterManager) {
  const voiceId = `osc-${voice.id}`;
  
  // Simplified logic - NEVER reset filter to 0
  if (legatoTransition) {
    filterManager.noteOn(voiceId, noteNumber, 1.0);
    console.log(`Filter continues tracking amplitude for voice ${voice.id} (legato)`);
  } else if (!isMonoMode && wasActive) {
    // MULTI MODE with voice stealing - NO RESET
    filterManager.noteOn(voiceId, noteNumber, 1.0);
    console.log(`Filter continues tracking amplitude for voice ${voice.id} (voice steal)`);
  } else if (isMonoMode) {
    // MONO MODE: Continue tracking amplitude (no reset)
    filterManager.noteOn(voiceId, noteNumber, 1.0);
    console.log(`Filter continues tracking amplitude for voice ${voice.id} (mono)`);
  } else {
    // Fresh note in either mode
    filterManager.noteOn(voiceId, noteNumber, 1.0);
    console.log(`Filter tracking new attack for voice ${voice.id} (fresh note)`);
  }
}

// Around line 4660 - Fix Sampler filter trigger
if (samplerVoice && filterManager) {
  const samplerVoiceId = `sampler-${samplerVoice.id}`;
  
  // Simplified logic - NEVER reset filter to 0
  if (legatoTransition) {
    filterManager.noteOn(samplerVoiceId, noteNumber, 1.0);
    console.log(`Filter continues tracking amplitude for sampler ${samplerVoice.id} (legato)`);
  } else if (!isMonoMode && wasSamplerStolen) {
    // MULTI MODE with voice stealing - NO RESET
    filterManager.noteOn(samplerVoiceId, noteNumber, 1.0);
    console.log(`Filter continues tracking amplitude for sampler ${samplerVoice.id} (voice steal)`);
  } else if (isMonoMode) {
    // MONO MODE: Continue tracking amplitude (no reset)
    filterManager.noteOn(samplerVoiceId, noteNumber, 1.0);
    console.log(`Filter continues tracking amplitude for sampler ${samplerVoice.id} (mono)`);
  } else {
    // Fresh note in either mode
    filterManager.noteOn(samplerVoiceId, noteNumber, 1.0);
    console.log(`Filter tracking new attack for sampler ${samplerVoice.id} (fresh note)`);
  }
}
    console.log(`Sampler note ${samplerNote.id} using existing audio path (filter=${samplerVoice.hasFilter})`);
    // Update note status
    samplerNote.state = 'playing';
    samplerNote.noteNumber = noteNumber;
    samplerNote.startTime = now;
    
    // Update voice status
    samplerVoice.noteNumber = noteNumber;
    samplerVoice.startTime = now;
    samplerVoice.state = 'playing';
    
    // Set per-voice LFO fade start time for sampler voice
    if (lfoFade > 0) {
        samplerVoice.lfoFadeStartTime = now;
    }
    
    // Set per-voice MOD canvas envelope start time (ENV mode)
    if (modCanvasMode === 'env') {
        samplerVoice.modCanvasEnvStartTime = now;
        samplerVoice.modCanvasEnvPhase = 0.0;
        samplerVoice.modCanvasEnvComplete = false;
    }
    
    // Set per-voice MOD canvas TRIG start time (TRIG mode)
    if (modCanvasMode === 'trig') {
        samplerVoice.modCanvasTrigStartTime = now;
        samplerVoice.modCanvasTrigPhase = 0.0;
    }
    
    console.log(`Sampler note ${samplerNote.id} configured for note ${noteNumber}, rate=${newPlaybackRate.toFixed(3)}`);
}

    // --- GLIDE TIME CALCULATION (EXISTING CODE) ---

    
    if (isPortamentoOn) {
        glideSourceNote = previousNoteNumber;
        console.log(`Portamento ON: Gliding from previous note ${previousNoteNumber} to ${noteNumber}`);
    } else if (isVoiceSteal || isReleasingSteal) {
        glideSourceNote = oldNoteNumber;
        console.log(`Voice stealing: Gliding from stolen note ${oldNoteNumber} to ${noteNumber}`);
    }
    

    
    if (isPortamentoOn) {
        effectiveGlideTime = Math.max(0.001, glideTime);
    } else if ((isVoiceSteal || isReleasingSteal) && glideTime > 0) {
        effectiveGlideTime = Math.max(0.001, glideTime * 0.5);
    }
    
    // CONTINUOUS OSCILLATOR ENVELOPE - OSC1
    if (voice.osc1Note && voice.osc1Note.workletNode) {
    const osc1 = voice.osc1Note;
    
    // Calculate frequencies
    const oldFrequency = glideSourceNote ? noteToFrequency(glideSourceNote, osc1OctaveOffset, osc1Detune) : 0;
    const newFrequency = noteToFrequency(noteNumber, osc1OctaveOffset, osc1Detune);

    // Handle frequency changes
    if (glideSourceNote !== null && effectiveGlideTime > 0.001) {
        console.log(`Osc1: Gliding from ${glideSourceNote} to ${noteNumber} over ${effectiveGlideTime}s`);
        
        osc1.workletNode.parameters.get('frequency').cancelScheduledValues(now);
        osc1.workletNode.parameters.get('frequency').setValueAtTime(oldFrequency, now);
        
        if (oldFrequency > 0.01 && newFrequency > 0.01 && Math.abs(oldFrequency - newFrequency) > 0.01) {
            osc1.workletNode.parameters.get('frequency').exponentialRampToValueAtTime(newFrequency, now + effectiveGlideTime);
        } else {
            osc1.workletNode.parameters.get('frequency').linearRampToValueAtTime(newFrequency, now + effectiveGlideTime);
        }
    } else {
        osc1.workletNode.parameters.get('frequency').setValueAtTime(newFrequency, now);
    }
    
    // CRITICAL FIX: Don't apply frequencyRatio - octave offset is already in the frequency
    osc1.workletNode.parameters.get('frequencyRatio').setValueAtTime(1.0, now);
    applyPitchWarble(voice, now);
    // Get waveform from selector
    const waveformMap = ['sine', 'sawtooth', 'triangle', 'square', 'pulse'];
    const osc1WaveSelector = D('osc1-wave-selector');
    const selectedWaveform = waveformMap[osc1WaveSelector ? parseInt(osc1WaveSelector.value) : 1];
    
    // FIXED: Apply waveform with proper PWM - if PWM knob is 0, use waveform default
    const pulseWidth = (osc1PWMValue === 0) ? 
        getJunoWaveformParams(selectedWaveform).pulseWidth : 
        (osc1PWMValue * 0.95);
    setJunoWaveform(osc1.workletNode, selectedWaveform, pulseWidth);
    
    // Ensure gate is open
        osc1.workletNode.parameters.get('gate').setValueAtTime(1, now);
        
// SOPHISTICATED OSC1 ENVELOPE
// CRITICAL FIX: Read the gain BEFORE canceling to get accurate current value
const currentGain = wasActive ? osc1.gainNode.gain.value : 0;

// Cancel scheduled values first
osc1.gainNode.gain.cancelScheduledValues(now);

if (legatoTransition && osc1.state === 'playing') {
    // LEGATO MODE - lock in current gain
    osc1.gainNode.gain.setValueAtTime(currentGain, now);
    
    if (wasInAttack || wasInDecay) {
        // Already set currentGain above
        
        if (wasInAttack) {
            // Continue attack
            const remainingAttackTime = attack * (1.0 - currentGain);
            osc1.gainNode.gain.linearRampToValueAtTime(1.0, now + remainingAttackTime);
            osc1.gainNode.gain.linearRampToValueAtTime(sustain, now + remainingAttackTime + decay);
            console.log(`Legato osc1: Continuing attack from ${currentGain.toFixed(3)}`);
        } else {
            // Continue decay
            const decayProgress = (1.0 - currentGain) / (1.0 - sustain);
            const remainingDecayTime = decay * (1.0 - decayProgress);
            osc1.gainNode.gain.linearRampToValueAtTime(sustain, now + remainingDecayTime);
            console.log(`Legato osc1: Continuing decay from ${currentGain.toFixed(3)}`);
        }
    } else {
        // Already set currentGain above
        console.log(`Legato osc1: Reset to sustain ${sustain.toFixed(3)}`);
    }
} else if (!isMonoMode && wasActive) {
    // MULTI MODE - already set currentGain above
    // Use wasReleasing instead of checking voice.state (which was already updated to 'active')
    const stealingFromRelease = wasReleasing;
    
    if (stealingFromRelease) {
        // Smoothly ramp from current gain to 0, then attack back up (always 5ms)
        const fadeOutTime = 0.005; // Fixed 5ms fade
        osc1.gainNode.gain.setValueAtTime(currentGain, now);
        osc1.gainNode.gain.linearRampToValueAtTime(0, now + fadeOutTime);
        osc1.gainNode.gain.linearRampToValueAtTime(1.0, now + fadeOutTime + attack);
        osc1.gainNode.gain.linearRampToValueAtTime(sustain, now + fadeOutTime + attack + decay);
        
        console.log(`Multi osc1: Smooth restart from ${currentGain.toFixed(3)} → 0 → attack (stolen from release)`);
    } else if (wasInAttack) {
        // CRITICAL FIX: Calculate remaining attack time - lock in current gain first
        osc1.gainNode.gain.setValueAtTime(currentGain, now);
        const remainingAttackTime = attack * (1.0 - currentGain);
        
        osc1.gainNode.gain.linearRampToValueAtTime(1.0, now + remainingAttackTime);
        osc1.gainNode.gain.linearRampToValueAtTime(sustain, now + remainingAttackTime + decay);
        
        console.log(`Multi osc1: Continuing attack from ${currentGain.toFixed(3)}, ${remainingAttackTime.toFixed(3)}s remaining`);
    } else if (wasInDecay) {
        // Start from current gain - lock it in first
        osc1.gainNode.gain.setValueAtTime(currentGain, now);
        osc1.gainNode.gain.linearRampToValueAtTime(1.0, now + attack);
        osc1.gainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);
        console.log(`Multi osc1: Reset from decay (gain ${currentGain.toFixed(3)}) to attack`);
    } else if (wasInSustain) {
        // Jump to sustain then new envelope
        osc1.gainNode.gain.setValueAtTime(sustain, now);
        osc1.gainNode.gain.linearRampToValueAtTime(1.0, now + attack);
        osc1.gainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);
        console.log(`Multi osc1: From sustain, new envelope`);
    } else {
        // Lock in current gain first
        osc1.gainNode.gain.setValueAtTime(currentGain, now);
        osc1.gainNode.gain.linearRampToValueAtTime(1.0, now + attack);
        osc1.gainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);
    }
} else {
    // Mono mode (non-legato) OR fresh note
    if (isMonoMode && wasReleasing) {
        // Mono mode stealing from release - smooth 5ms fade like poly
        const fadeOutTime = 0.005;
        osc1.gainNode.gain.setValueAtTime(currentGain, now);
        osc1.gainNode.gain.linearRampToValueAtTime(0, now + fadeOutTime);
        osc1.gainNode.gain.linearRampToValueAtTime(1.0, now + fadeOutTime + attack);
        osc1.gainNode.gain.linearRampToValueAtTime(sustain, now + fadeOutTime + attack + decay);
        console.log(`Mono osc1: Smooth restart from ${currentGain.toFixed(3)} → 0 → attack`);
    } else {
        // Fresh note - start from 0
        osc1.gainNode.gain.setValueAtTime(0, now);
        osc1.gainNode.gain.linearRampToValueAtTime(1.0, now + attack);
        osc1.gainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);
    }
}

osc1.levelNode.gain.setValueAtTime(osc1GainValue, now);
        osc1.state = 'playing';
        osc1.noteNumber = noteNumber;
    }

    // CONTINUOUS OSCILLATOR ENVELOPE - OSC2
if (voice.osc2Note && voice.osc2Note.workletNode) {
    const osc2 = voice.osc2Note;
    
    console.log(`Setting up OSC2 for voice ${voice.id}, note ${noteNumber}`);
    
    // CRITICAL FIX: Add +1 octave offset to OSC2 to make it permanently one octave higher
    const adjustedOsc2Offset = osc2OctaveOffset + 1;
    
    // Calculate frequencies with the adjusted offset
    const oldFrequency = glideSourceNote ? noteToFrequency(glideSourceNote, adjustedOsc2Offset, osc2Detune) : 0;
    const newFrequency = noteToFrequency(noteNumber, adjustedOsc2Offset, osc2Detune);

    console.log(`OSC2 target frequency: ${newFrequency.toFixed(2)} Hz`);

    // Handle frequency changes
    if (glideSourceNote !== null && effectiveGlideTime > 0.001) {
        console.log(`Osc2: Gliding from ${glideSourceNote} to ${noteNumber} over ${effectiveGlideTime}s (with +1 octave offset)`);
        
        osc2.workletNode.parameters.get('frequency').cancelScheduledValues(now);
        osc2.workletNode.parameters.get('frequency').setValueAtTime(oldFrequency, now);
        
        if (oldFrequency > 0.01 && newFrequency > 0.01 && Math.abs(oldFrequency - newFrequency) > 0.01) {
            osc2.workletNode.parameters.get('frequency').exponentialRampToValueAtTime(newFrequency, now + effectiveGlideTime);
        } else {
            osc2.workletNode.parameters.get('frequency').linearRampToValueAtTime(newFrequency, now + effectiveGlideTime);
        }
    } else {
        osc2.workletNode.parameters.get('frequency').setValueAtTime(newFrequency, now);
    }
    
    // Don't apply frequencyRatio - octave offset is already in the frequency
    osc2.workletNode.parameters.get('frequencyRatio').setValueAtTime(1.0, now);
    applyPitchWarble(voice, now);
    
    // Get waveform from selector
    const waveformMap = ['sine', 'sawtooth', 'triangle', 'square', 'pulse'];
    const osc2WaveSelector = D('osc2-wave-selector');
    const selectedWaveform = waveformMap[osc2WaveSelector ? parseInt(osc2WaveSelector.value) : 1];
    
    console.log(`OSC2 waveform: ${selectedWaveform}`);
    
    // Apply waveform with proper PWM
    const pulseWidth = (osc2PWMValue === 0) ? 
        getJunoWaveformParams(selectedWaveform).pulseWidth : 
        (osc2PWMValue * 0.95);
    setJunoWaveform(osc2.workletNode, selectedWaveform, pulseWidth);
    
    // Ensure gate is open
    osc2.workletNode.parameters.get('gate').setValueAtTime(1, now);
    console.log(`OSC2 gate opened for voice ${voice.id}`);
    
// SOPHISTICATED OSC2 ENVELOPE
// CRITICAL FIX: Read the gain BEFORE canceling to get accurate current value
const currentGain = wasActive ? osc2.gainNode.gain.value : 0;

// Cancel scheduled values first
osc2.gainNode.gain.cancelScheduledValues(now);

if (legatoTransition && osc2.state === 'playing') {
    // LEGATO MODE - lock in current gain
    osc2.gainNode.gain.setValueAtTime(currentGain, now);
    
    if (wasInAttack || wasInDecay) {
        // Already set currentGain above
        
        if (wasInAttack) {
            const remainingAttackTime = attack * (1.0 - currentGain);
            osc2.gainNode.gain.linearRampToValueAtTime(1.0, now + remainingAttackTime);
            osc2.gainNode.gain.linearRampToValueAtTime(sustain, now + remainingAttackTime + decay);
        } else {
            const decayProgress = (1.0 - currentGain) / (1.0 - sustain);
            const remainingDecayTime = decay * (1.0 - decayProgress);
            osc2.gainNode.gain.linearRampToValueAtTime(sustain, now + remainingDecayTime);
        }
    } else {
        // Jump to sustain
        osc2.gainNode.gain.setValueAtTime(sustain, now);
    }
} else if (!isMonoMode && wasActive) {
    // MULTI MODE - currentGain already set above
    // Use wasReleasing instead of checking voice.state (which was already updated to 'active')
    const stealingFromRelease = wasReleasing;
    
    if (stealingFromRelease) {
        // Smoothly ramp from current gain to 0, then attack back up (always 5ms)
        const fadeOutTime = 0.005; // Fixed 5ms fade
        osc2.gainNode.gain.setValueAtTime(currentGain, now);
        osc2.gainNode.gain.linearRampToValueAtTime(0, now + fadeOutTime);
        osc2.gainNode.gain.linearRampToValueAtTime(1.0, now + fadeOutTime + attack);
        osc2.gainNode.gain.linearRampToValueAtTime(sustain, now + fadeOutTime + attack + decay);
        
        console.log(`Multi osc2: Smooth restart from ${currentGain.toFixed(3)} → 0 → attack (stolen from release)`);
    } else if (wasInAttack) {
        // Lock in current gain first
        osc2.gainNode.gain.setValueAtTime(currentGain, now);
        const remainingAttackTime = attack * (1.0 - currentGain);
        
        osc2.gainNode.gain.linearRampToValueAtTime(1.0, now + remainingAttackTime);
        osc2.gainNode.gain.linearRampToValueAtTime(sustain, now + remainingAttackTime + decay);
    } else if (wasInDecay) {
        // Start from current gain - lock it in first
        osc2.gainNode.gain.setValueAtTime(currentGain, now);
        osc2.gainNode.gain.linearRampToValueAtTime(1.0, now + attack);
        osc2.gainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);
    } else if (wasInSustain) {
        // Jump to sustain then new envelope
        osc2.gainNode.gain.setValueAtTime(sustain, now);
        osc2.gainNode.gain.linearRampToValueAtTime(1.0, now + attack);
        osc2.gainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);
    } else {
        // Lock in current gain first
        osc2.gainNode.gain.setValueAtTime(currentGain, now);
        osc2.gainNode.gain.linearRampToValueAtTime(1.0, now + attack);
        osc2.gainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);
    }
} else {
    // Mono mode (non-legato) OR fresh note
    if (isMonoMode && wasReleasing) {
        // Mono mode stealing from release - smooth 5ms fade like poly
        const fadeOutTime = 0.005;
        osc2.gainNode.gain.setValueAtTime(currentGain, now);
        osc2.gainNode.gain.linearRampToValueAtTime(0, now + fadeOutTime);
        osc2.gainNode.gain.linearRampToValueAtTime(1.0, now + fadeOutTime + attack);
        osc2.gainNode.gain.linearRampToValueAtTime(sustain, now + fadeOutTime + attack + decay);
        console.log(`Mono osc2: Smooth restart from ${currentGain.toFixed(3)} → 0 → attack`);
    } else {
        // Fresh note - start from 0
        osc2.gainNode.gain.setValueAtTime(0, now);
        osc2.gainNode.gain.linearRampToValueAtTime(1.0, now + attack);
        osc2.gainNode.gain.linearRampToValueAtTime(sustain, now + attack + decay);
    }
}

osc2.levelNode.gain.setValueAtTime(osc2GainValue, now);
    console.log(`OSC2 level set to ${osc2GainValue} for voice ${voice.id}`);
    
    osc2.state = 'playing';
    osc2.noteNumber = noteNumber;
}
    if (filterManager && filterManager.isActive) {
    filterManager.noteOn(noteNumber, 1.0); // Pass note number and default velocity
  }
  
// Update FM for ALL oscillators regardless of FM amount
const nowFM = audioCtx.currentTime + 0.01;

// ALWAYS set up FM connections, even if depth is 0
if (voice.osc1Note) {
    console.log(`noteOn: Setting up Osc1 FM (source: ${osc1FMSource}, depth: ${osc1FMAmount})`);
    updateOsc1FmModulatorParameters(voice.osc1Note, nowFM, voice);
}

if (voice.osc2Note) {
    console.log(`noteOn: Setting up Osc2 FM (source: ${osc2FMSource}, depth: ${osc2FMAmount})`);
    updateOsc2FmModulatorParameters(voice.osc2Note, nowFM, voice);
}
// At the end of the function, add:
    
    // Always refresh FM sources when playing a new note
    // This ensures that even if samples have ended, new FM sources are created
    if (osc1FMSource === 'sampler' || osc2FMSource === 'sampler') {
        refreshFMSources();
    }
    
    // Update UI and tracking
    lastPlayedNoteNumber = noteNumber;
    updateVoiceDisplay_Pool();
    updateKeyboardDisplay_Pool();
}

// Update noteOff to handle multiple voices per note
function noteOff(noteNumber, isForced = false, specificVoice = null) {
    if (isModeTransitioning && !isForced) {
        console.log(`noteOff: Ignoring note ${noteNumber} during mode transition`);
        return;
    }
    
    console.log(`noteOff: ${noteNumber}, Mono: ${isMonoMode}`);
    const now = audioCtx.currentTime;

    // Remove from held notes
    heldNotes = heldNotes.filter(n => n !== noteNumber);

    // --- MONO MODE HANDLING ---
    if (isMonoMode && heldNotes.length > 0) {
  // Get the next held note
  const nextNote = heldNotes[heldNotes.length - 1];
  
  // Check if the released note is actually the currently playing note
  const isReleasingCurrentNote = currentMonoVoice && 
                               currentMonoVoice.noteNumber === noteNumber;
  
  console.log(`Mono noteOff: ${noteNumber} → ${nextNote} (${isReleasingCurrentNote ? 'releasing active' : 'releasing held'})`);
  
  if (isReleasingCurrentNote) {
    // Only retrigger when releasing the currently playing note
    noteOn(nextNote, isLegatoMode);
  } else {
    // Don't do anything when releasing non-active held notes
    console.log(`Mono noteOff: Ignoring release of non-active note ${noteNumber}`);
  }
  
  return;
}

    // --- SAMPLER NOTE-OFF LOGIC ---
    // Find all sampler voices playing this note
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

    // --- OSCILLATOR VOICE HANDLING (EXISTING CODE) ---
    // Get all voices assigned to this note, or use the specific voice if provided
    let voicesToRelease = [];
    if (specificVoice) {
        // Release only the specific voice
        voicesToRelease = [specificVoice];
        console.log(`Releasing specific voice ${specificVoice.id} for note ${noteNumber}`);
    } else {
        
        // Release all voices for this note
        voicesToRelease = voiceAssignments.get(noteNumber) || [];
    }
    
    if (voicesToRelease.length === 0) {
        console.log(`noteOff: No oscillator voices to release for note ${noteNumber}`);
        return;
    }
// CRITICAL FIX: Use the mapped time value from dataset instead of raw slider value
    const release = Math.max(0.01, parseFloat(D('release').dataset.mappedTime || D('release').value));

    // Release the specified voices
    for (const voice of voicesToRelease) {
        // Give each voice a unique release ID to avoid conflicts
        const releaseId = `rel_${noteNumber}_${voice.id}_${Date.now()}`;
        voice.currentReleaseId = releaseId;
        
        console.log(`Starting release ${releaseId} for voice ${voice.id}, note ${noteNumber}`);
        
        // Release Osc1
        if (voice.osc1Note && voice.osc1Note.workletNode) {
  const osc1 = voice.osc1Note;
  osc1.currentReleaseId = releaseId;
  
  // Mark as releasing
  voice.state = 'releasing';
  osc1.state = 'releasing';
  
  // Apply curved release envelope at 80% speed to leave buffer for exponential tail
  const currentGain = osc1.gainNode.gain.value;
  const envelopeRelease = release * 0.6;
  applyCurvedEnvelope(osc1.gainNode.gain, currentGain, 0, envelopeRelease, now, 'release');
  
  // Schedule gate closure after full release time (envelope completes at 80%, tail decays during remaining 20%)
  trackVoiceTimer(voice, () => {
    // Only close if this is still the active release for this voice
    if (osc1.currentReleaseId === releaseId && osc1.state === 'releasing') {
      osc1.workletNode.parameters.get('gate').setValueAtTime(0, audioCtx.currentTime);
      osc1.state = 'idle';
      osc1.noteNumber = null;
      console.log(`Osc1 gate closed for release ${releaseId}`);
    }
  }, release * 1000 + 40);
}

        // Release Osc2 with similar pattern
        if (voice.osc2Note && voice.osc2Note.workletNode) {
  const osc2 = voice.osc2Note;
  osc2.currentReleaseId = releaseId;
  
  osc2.state = 'releasing';
  
  // Apply curved release envelope at 80% speed to leave buffer for exponential tail
  const currentGain = osc2.gainNode.gain.value;
  const envelopeRelease = release * 0.6;
  applyCurvedEnvelope(osc2.gainNode.gain, currentGain, 0, envelopeRelease, now, 'release');
  
  trackVoiceTimer(voice, () => {
    if (osc2.currentReleaseId === releaseId && osc2.state === 'releasing') {
      osc2.workletNode.parameters.get('gate').setValueAtTime(0, audioCtx.currentTime);
      osc2.state = 'idle';
      osc2.noteNumber = null;
      console.log(`Osc2 gate closed for release ${releaseId}`);
    }
  }, release * 1000 + 40);
}

// Update filter call to include mono mode parameters
            if (filterManager && voice.osc1Note) {
  // Pass mono mode flag and remaining held notes count to filter
  // CRITICAL: Use osc-${voice.id} to match the voiceId used in createPersistentFilter
  filterManager.noteOff(`osc-${voice.id}`, false, isMonoMode, heldNotes.length);
}
        // Clean up voice assignment after release
        trackVoiceTimer(voice, () => {
            // Only cleanup if this is still the active release for this voice
            if (voice.currentReleaseId === releaseId && voice.state === 'releasing') {
                voice.state = 'idle';
                
                // Remove only this specific voice from assignments
                const assignments = voiceAssignments.get(noteNumber) || [];
                const updatedAssignments = assignments.filter(v => v !== voice);
                if (updatedAssignments.length === 0) {
                    voiceAssignments.delete(noteNumber);
                } else {
                    voiceAssignments.set(noteNumber, updatedAssignments);
                }
                
                // Clear the release ID
                voice.currentReleaseId = null;
                voice.noteNumber = null;
                
                console.log(`Voice ${voice.id} fully released for note ${noteNumber} (${releaseId})`);
                updateVoiceDisplay_Pool();
                updateKeyboardDisplay_Pool();
            }
        }, release * 1000 + 60);
    }
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

// updateSliderValues() removed - sliders now initialize themselves in setupNonLinearADSRSliders()
updateVoiceDisplay_Pool();
updateADSRVisualization();

// Initialize Keyboard Module
initializeKeyboard('keyboard', noteOn, noteOff, updateKeyboardDisplay_Pool);
setupNonLinearFilterSlider(); // Set up non-linear cutoff mapping BEFORE filter controls
initializeFilterControls();
initializeModulationRouting();

// Initialize LFO system
initializeLFO();

// Initialize MOD Canvas modulation system
initializeModCanvasModulation();

// Add LFO rate slider handler
const rateSlider = document.querySelector('.rate-slider-range');
if (rateSlider) {
  rateSlider.addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    // Map 0-1 to 0.1-20 Hz (logarithmic)
    lfoRate = 0.1 * Math.pow(200, value); // 0.1 Hz to 20 Hz
    
    // Show tooltip on the right
    createTooltipForSlider(e.target, `${lfoRate.toFixed(2)} Hz`, 'right');
    
    restartLFO();
    console.log(`LFO Rate: ${lfoRate.toFixed(2)} Hz`);
  });
  
  rateSlider.addEventListener('mouseup', () => hideTooltipForSlider(rateSlider));
  rateSlider.addEventListener('touchend', () => hideTooltipForSlider(rateSlider));
}

// Add LFO fade slider handler  
const fadeSlider = document.querySelector('.delay-slider-range');
if (fadeSlider) {
  fadeSlider.addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    lfoFade = value;
    
    // Show tooltip on the right
    const fadeTime = value * 5; // Max 5 seconds
    createTooltipForSlider(e.target, `${fadeTime.toFixed(2)}s`, 'right');
    
    console.log(`LFO Fade: ${(lfoFade * 100).toFixed(0)}%`);
  });
  
  fadeSlider.addEventListener('mouseup', () => hideTooltipForSlider(fadeSlider));
  fadeSlider.addEventListener('touchend', () => hideTooltipForSlider(fadeSlider));
}

// Set filter defaults
  if (filterManager) {
    // Set default filter values
    filterManager.setCutoff(16000); // 100% = 20kHz
    filterManager.setResonance(0.0); // 0% resonance
    filterManager.setVariant(1); // 100% oscillation
    filterManager.setDrive(0.0); // No drive
    filterManager.setEnvelopeAmount(0.5); // Center position (no envelope)
    filterManager.setKeytrackAmount(0.5); // Center position (no keytracking)
    
    // Set filter ADSR from filter envelope sliders (not VCA sliders)
    filterManager.setADSR(
      parseFloat(D('filter-attack').dataset.mappedTime || D('filter-attack').value || 0),
      parseFloat(D('filter-decay').dataset.mappedTime || D('filter-decay').value || 0),
      parseFloat(D('filter-sustain').value || 1.0),
      parseFloat(D('filter-release').dataset.mappedTime || D('filter-release').value || 0),
      classicModeEnabled
    );
  }
// Initialize controls - REMOVED fixAllKnobs as initializeKnob already handles all knobs properly
// fixAllKnobs(knobInitializations, knobDefaults); // <-- COMMENTED OUT - was re-cloning knobs and destroying event listeners
// CRITICAL FIX: Initialize FM sources AFTER knobs are set up
    // This ensures osc1FMAmount and osc2FMAmount have their correct values from the knobs
    setTimeout(() => {
        console.log("Initializing FM with actual knob values...");
        const now = audioCtx.currentTime;
        
        voicePool.forEach(voice => {
            // Set up OSC1 FM with actual knob value
            if (voice.osc1Note && osc1FMAmount > 0.001) {
                console.log(`Initial FM setup for osc1 in voice ${voice.id} with depth ${osc1FMAmount}`);
                updateOsc1FmModulatorParameters(voice.osc1Note, now, voice);
            } else if (voice.osc1Note) {
                // Even with zero depth, establish the routing
                updateOsc1FmModulatorParameters(voice.osc1Note, now, voice);
            }
            
            // Set up OSC2 FM with actual knob value
            if (voice.osc2Note && osc2FMAmount > 0.001) {
                console.log(`Initial FM setup for osc2 in voice ${voice.id} with depth ${osc2FMAmount}`);
                updateOsc2FmModulatorParameters(voice.osc2Note, now, voice);
            } else if (voice.osc2Note) {
                // Even with zero depth, establish the routing
                updateOsc2FmModulatorParameters(voice.osc2Note, now, voice);
            }
        });
    }, 500); // 500ms delay to ensure knobs are fully initialized
// Replace your existing sample auto-loading code with this:

    // // Add a listener for user interaction before loading sample
    // const userInteractionHandler = function() {
    //     console.log("User interaction detected - loading initial sample");
    //     loadPresetSample('Noise.wav');
        
    //     // Remove these event listeners after first use
    //     document.removeEventListener('click', userInteractionHandler);
    //     document.removeEventListener('keydown', userInteractionHandler);
    //     document.removeEventListener('touchstart', userInteractionHandler);
    // };
    
    // // Add the event listeners for common interaction events
    // document.addEventListener('click', userInteractionHandler, { once: true });
    // document.addEventListener('keydown', userInteractionHandler, { once: true });
    // document.addEventListener('touchstart', userInteractionHandler, { once: true });


    
    // Initialize FM with a slight delay to ensure sample is loaded
    setTimeout(() => {
        console.log("Initializing FM connections on startup...");
        forceFMConnectionUpdate();
    }, 1200); // Wait 1.2 seconds after DOM load

// initializeSpecialButtons(); // <-- Remove this line
initializeSpecialButtons( // <-- Add this line, passing dependencies/callbacks
    (newState) => { isEmuModeOn = newState; }, // Callback for Emu mode toggle
    updateSampleProcessing, // Pass function reference
    updateSamplePlaybackParameters, // Pass function reference
    voicePool, // <<< CHANGE: Pass voicePool>>>
    heldNotes // Pass array reference
);
// Initialize recording with button setup SKIPPED
externalRecorder = fixMicRecording(audioCtx, handleRecordingComplete, true);

// Set up recording mode dropdown
const dropdown = createRecordingModeDropdown();
const recButton = document.getElementById('mic-record-button');

if (recButton && dropdown && externalRecorder) {
    console.log("Setting up recording dropdown...");
    
    // Add our click handler
    recButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        // CRITICAL FIX: Check BOTH recording states
        const isExternalRecording = externalRecorder.isRecording();
        const isInternalRecording = isRecording; // Global state for internal recording
        
        if (isExternalRecording || isInternalRecording) {
            // Stop recording - determine which type
            console.log("Stopping recording...");
            
            if (isInternalRecording && mediaRecorder && mediaRecorder.state !== 'inactive') {
                // Stop internal recording
                mediaRecorder.stop();
                console.log("Stopped internal recording");
            }
            
            if (isExternalRecording) {
                // Stop external recording
                externalRecorder.stopRecording();
                console.log("Stopped external recording");
            }
        } else {
            // Not recording - show dropdown to choose mode
            const isVisible = dropdown.style.display !== 'none';
            dropdown.style.display = isVisible ? 'none' : 'block';
            console.log("Dropdown toggled:", dropdown.style.display);
        }
    });
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!recButton.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.style.display = 'none';
        }
    });
} else {
    console.error("Failed to setup recording:", { recButton: !!recButton, dropdown: !!dropdown, externalRecorder: !!externalRecorder });
}
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
const fmSourceSwitchElement = D('osc1-fm-source-switch');
if (fmSourceSwitchElement) {
    const fmSwitchControl = initializeSwitch(fmSourceSwitchElement, {
        onText: 'Osc 2',
        offText: 'Sampler',
        onChange: (isActive) => {
            osc1FMSource = isActive ? 'osc2' : 'sampler';
            console.log(`Osc1 FM Source set to: ${osc1FMSource}`);
            
            // Update all voices immediately
            const now = audioCtx.currentTime;
            voicePool.forEach(voice => {
                if (voice.osc1Note) {
                    updateOsc1FmModulatorParameters(voice.osc1Note, now, voice);
                }
            });
        }
    });
    fmSwitchControl.setValue(osc1FMSource === 'osc2');
}


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
        const octaveLabels = ['-2 Octaves', '-1 Octave', '0 Octave', '+1 Octave', '+2 Octaves'];
        osc1OctaveOffset = octaveOffsetMap[sliderValue] || 0; // Default to 0 if mapping fails

        // Show tooltip on top
        createTooltipForSlider(event.target, octaveLabels[sliderValue], 'top');

        console.log(`Osc1 Octave Selector value: ${sliderValue}, Offset set to: ${osc1OctaveOffset}`);

        // Update frequency of all active Osc1 notes immediately
        const now = audioCtx.currentTime;
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.osc1Note && voice.osc1Note.workletNode && voice.osc1Note.noteNumber !== null) {
                // CRITICAL FIX: Calculate frequency with octave offset already included
                const targetFreq = noteToFrequency(voice.osc1Note.noteNumber, osc1OctaveOffset, osc1Detune);
                const freqParam = voice.osc1Note.workletNode.parameters.get('frequency');
                
                // CRITICAL FIX: Set frequencyRatio to 1.0 since octave offset is already in the frequency
                const freqRatioParam = voice.osc1Note.workletNode.parameters.get('frequencyRatio');
                
                if (freqParam && freqRatioParam) {
                    console.log(`Updating Worklet note ${voice.osc1Note.id} (Voice ${voice.id}) frequency to ${targetFreq.toFixed(2)} Hz`);
                    freqParam.setTargetAtTime(targetFreq, now, 0.01);
                    freqRatioParam.setValueAtTime(1.0, now); // Always 1.0 - octave is in frequency
                } else {
                    console.warn(`Could not find frequency parameter for Osc1 note ${voice.osc1Note.id} (Voice ${voice.id})`);
                }
            }
        });
    });
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
    // Set initial waveform
    const waveformMap = ['sine', 'sawtooth', 'triangle', 'square', 'pulse'];
    const waveformLabels = ['Sine', 'Saw', 'Triangle', 'Square', 'Pulse'];
    osc1Waveform = waveformMap[parseInt(osc1WaveSelector.value)];
    
    // Change from 'change' to 'input' event for immediate updates
    osc1WaveSelector.addEventListener('input', (e) => {
        const waveIndex = parseInt(e.target.value);
        osc1Waveform = waveformMap[waveIndex];
        
        // Show tooltip on top
        createTooltipForSlider(e.target, waveformLabels[waveIndex], 'top');
        
        console.log(`Osc1 waveform changed to: ${osc1Waveform}`);
        
        // Update all active Osc1 notes with new waveform
        const now = audioCtx.currentTime;
        voicePool.forEach(voice => {
            if (voice.osc1Note && voice.osc1Note.workletNode) {
                const pulseWidth = (osc1PWMValue === 0) ? 
                    getJunoWaveformParams(osc1Waveform).pulseWidth : 
                    (osc1PWMValue * 0.95);
                setJunoWaveform(voice.osc1Note.workletNode, osc1Waveform, pulseWidth);
            }
        });
        
        updatePWMKnobState(); // Update PWM knob visibility/state
    });
    
    // Hide tooltips on release
    osc1WaveSelector.addEventListener('mouseup', () => hideTooltipForSlider(osc1WaveSelector));
    osc1WaveSelector.addEventListener('touchend', () => hideTooltipForSlider(osc1WaveSelector));
}

// Hide tooltips for OSC1 octave selector
if (osc1OctaveSelector) {
    osc1OctaveSelector.addEventListener('mouseup', () => hideTooltipForSlider(osc1OctaveSelector));
    osc1OctaveSelector.addEventListener('touchend', () => hideTooltipForSlider(osc1OctaveSelector));
}

// Replace your existing sample auto-loading code with this:
// document.addEventListener('DOMContentLoaded', function() {
//     // Add a listener for user interaction before loading sample
//     const userInteractionHandler = function() {
//         console.log("User interaction detected - loading initial sample");
//         loadPresetSample('Noise.wav');
        
//         // Remove these event listeners after first use
//         document.removeEventListener('click', userInteractionHandler);
//         document.removeEventListener('keydown', userInteractionHandler);
//         document.removeEventListener('touchstart', userInteractionHandler);
//     };
    
//     // Add the event listeners for common interaction events
//     document.addEventListener('click', userInteractionHandler, { once: true });
//     document.addEventListener('keydown', userInteractionHandler, { once: true });
//     document.addEventListener('touchstart', userInteractionHandler, { once: true });
    

// });

// --- Modulation Source Button Logic ---
const modModeSelector = document.querySelector('.mod-mode-selector'); // Get the container
if (modModeSelector) {
    const modOptions = modModeSelector.querySelectorAll('.mode-option');

    // Function to update button states and mode
    function setActiveModMode(modeName) {
        modCanvasMode = modeName; // Update global canvas mode
        
        // Deactivate all options within this selector
        modOptions.forEach(option => {
            option.classList.remove('active');
        });

        // Activate the selected option
        const activeOption = modModeSelector.querySelector(`.mode-option[data-mode="${modeName}"]`);
        if (activeOption) {
            activeOption.classList.add('active');
        }

        console.log(`MOD Canvas mode set to: ${modCanvasMode}`);
        
        // Reset phase when switching modes
        modCanvasPhase = 0.0;
        
        // Reset all voice envelope states when switching to/from ENV mode
        if (modeName === 'env') {
            // Entering ENV mode - reset all envelope states
            voicePool.forEach(voice => {
                voice.modCanvasEnvStartTime = null;
                voice.modCanvasEnvPhase = 0.0;
                voice.modCanvasEnvComplete = false;
            });
            samplerVoicePool.forEach(voice => {
                voice.modCanvasEnvStartTime = null;
                voice.modCanvasEnvPhase = 0.0;
                voice.modCanvasEnvComplete = false;
            });
        } else if (modeName === 'trig') {
            // Entering TRIG mode - reset all TRIG states
            voicePool.forEach(voice => {
                voice.modCanvasTrigStartTime = null;
                voice.modCanvasTrigPhase = 0.0;
            });
            samplerVoicePool.forEach(voice => {
                voice.modCanvasTrigStartTime = null;
                voice.modCanvasTrigPhase = 0.0;
            });
        }
    }

    // Add click listeners to each option
    modOptions.forEach(option => {
        option.addEventListener('click', () => {
            const modeName = option.getAttribute('data-mode');
            if (modeName) {
                setActiveModMode(modeName);
            }
        });
    });

    // Set initial mode to 'lfo' (default)
    setActiveModMode('lfo');

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
    // FIRST: Disconnect any previous initialization of the ADSR knob
    const adsrKnob = document.getElementById('adsr-knob');
    if (adsrKnob) {
        // Clone the element to remove all event listeners
        const newAdsrKnob = adsrKnob.cloneNode(true);
        adsrKnob.parentNode.replaceChild(newAdsrKnob, adsrKnob);
        
        // Now set up the stepped knob with 3 fixed positions
        let currentPosition = 1; // 0=left(-100%), 1=middle(0%), 2=right(+100%)
        let isDragging = false;
        let startY;
        let totalMovement = 0;
        const positions = [-150, 0, 150]; // Rotation degrees for each position
        const moveThreshold = 30; // Pixels of movement needed to change position
        let lastTap = 0;

        function updateKnobPosition() {
            newAdsrKnob.style.transform = `rotate(${positions[currentPosition]}deg)`;
            
            // Convert position to filter envelope amount value (0, 0.5, or 1)
            const values = [0, 0.5, 1];
            const value = values[currentPosition];
            
            // Update filter envelope with the stepped value
            if (filterManager) {
                filterManager.setEnvelopeAmount(value);
            }
            
            // Update tooltip
            const tooltip = createTooltipForKnob('adsr-knob', value);
            if (currentPosition === 0) {
                tooltip.textContent = `Env: -100%`;
            } else if (currentPosition === 1) {
                tooltip.textContent = `Env: Center (0%)`;
            } else {
                tooltip.textContent = `Env: +100%`;
            }
            tooltip.style.opacity = '1';
            
            // Log the value change
            const bipolarValue = (value - 0.5) * 2;
            console.log(`Filter Envelope Amount: ${bipolarValue.toFixed(2)} (stepped to ${value})`);
        }
        
        // Set initial position from knob defaults
        const defaultValue = knobDefaults['adsr-knob'] || 0.5;
        currentPosition = defaultValue < 0.25 ? 0 : defaultValue > 0.75 ? 2 : 1;
        updateKnobPosition(); // Apply initial position

        // Mouse event handlers
        newAdsrKnob.addEventListener('mousedown', function(e) {
            isDragging = true;
            startY = e.clientY;
            totalMovement = 0;
            e.preventDefault();
        });
        
        document.addEventListener('mousemove', function(e) {
            if (!isDragging) return;
            const deltaY = startY - e.clientY;
            totalMovement += deltaY;
            startY = e.clientY;
            
            if (totalMovement >= moveThreshold) {
                if (currentPosition < 2) {
                    currentPosition++;
                    updateKnobPosition();
                }
                totalMovement = 0;
            } else if (totalMovement <= -moveThreshold) {
                if (currentPosition > 0) {
                    currentPosition--;
                    updateKnobPosition();
                }
                totalMovement = 0;
            }
        });
        
        document.addEventListener('mouseup', function() {
            isDragging = false;
            totalMovement = 0;
        });
        
        // Touch event handlers
        newAdsrKnob.addEventListener('touchstart', function(e) {
            if (e.touches.length !== 1) return;
            isDragging = true;
            startY = e.touches[0].clientY;
            totalMovement = 0;
            e.preventDefault();
        }, { passive: false });
        
        document.addEventListener('touchmove', function(e) {
            if (!isDragging || e.touches.length !== 1) return;
            const deltaY = startY - e.touches[0].clientY;
            totalMovement += deltaY;
            startY = e.touches[0].clientY;
            
            if (totalMovement >= moveThreshold) {
                if (currentPosition < 2) {
                    currentPosition++;
                    updateKnobPosition();
                }
                totalMovement = 0;
            } else if (totalMovement <= -moveThreshold) {
                if (currentPosition > 0) {
                    currentPosition--;
                    updateKnobPosition();
                }
                totalMovement = 0;
            }
            e.preventDefault();
        }, { passive: false });
        
        document.addEventListener('touchend', function() {
            isDragging = false;
            totalMovement = 0;
        });
        
        // Double-click and double-tap to reset to center position
        newAdsrKnob.addEventListener('dblclick', function() {
            currentPosition = 1; // Center position (0%)
            updateKnobPosition();
            console.log("ADSR reset to center position (0%)");
        });
        
        newAdsrKnob.addEventListener('touchend', function(e) {
            const now = Date.now();
            if (now - lastTap < 300) {
                currentPosition = 1; // Center position (0%)
                updateKnobPosition();
                console.log("ADSR reset to center position (0%)");
            }
            lastTap = now;
        });
    }
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
reverseBufferIfNeeded(false); // Don't trigger FM update yet
updateSampleProcessing(); // This updates fadedBuffer/cachedCrossfadedBuffer
// CRITICAL FIX: Use a timeout to ensure processing completes before updating notes
setTimeout(() => {
    console.log("Reverse button: Updating all active sampler notes");
    
    // Update ALL sampler voices, not just the oscillator voicePool
    samplerVoicePool.forEach(voice => {
        if (voice.state !== 'inactive' && voice.samplerNote) {
            const note = voice.samplerNote;
            // Skip held notes to avoid interruption
            if (heldNotes.includes(voice.noteNumber)) {
                console.log(`Reverse Button: Skipping update for held sampler note ${note.id}`);
                return;
            }
            console.log(`Reverse Button: Updating sampler note ${note.id}`);
            updateSamplePlaybackParameters(note);
        }
    });
    
    // CRITICAL FIX: Also update FM sources that use sampler
    const fmUpdateTime = audioCtx.currentTime;
    voicePool.forEach(voice => {
        if (voice.state !== 'inactive') {
            // Update Osc1 FM if using sampler
            if (osc1FMSource === 'sampler' && voice.osc1Note && voice.osc1Note.fmModulatorSource instanceof AudioBufferSourceNode) {
                console.log(`Reverse Button: Updating Osc1 FM for voice ${voice.id}`);
                updateOsc1FmModulatorParameters(voice.osc1Note, fmUpdateTime, voice);
            }
            // Update Osc2 FM if using sampler
            if (osc2FMSource === 'sampler' && voice.osc2Note && voice.osc2Note.fmModulatorSource instanceof AudioBufferSourceNode) {
                console.log(`Reverse Button: Updating Osc2 FM for voice ${voice.id}`);
                updateOsc2FmModulatorParameters(voice.osc2Note, fmUpdateTime, voice);
            }
        }
    });
}, 100); // Wait 100ms for updateSampleProcessing to complete
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
        const octaveLabels = ['-2 Octaves', '-1 Octave', '0 Octave', '+1 Octave', '+2 Octaves'];
        osc2OctaveOffset = octaveOffsetMap[sliderValue] || 0;
        
        // Show tooltip on top
        createTooltipForSlider(event.target, octaveLabels[sliderValue], 'top');
        
        // CRITICAL FIX: Add +1 to the offset for the permanent octave shift
        const adjustedOsc2Offset = osc2OctaveOffset + 1;
        
        console.log(`Osc2 Octave Selector value: ${sliderValue}, Base Offset: ${osc2OctaveOffset}, Adjusted Offset: ${adjustedOsc2Offset}`);
        
        // Update active Osc2 notes
        const now = audioCtx.currentTime;
        voicePool.forEach(voice => {
            if (voice.state !== 'inactive' && voice.osc2Note && voice.osc2Note.workletNode && voice.osc2Note.noteNumber !== null) {
                // Use the adjusted offset (+1 octave)
                const targetFreq = noteToFrequency(voice.osc2Note.noteNumber, adjustedOsc2Offset, osc2Detune);
                const freqParam = voice.osc2Note.workletNode.parameters.get('frequency');
                const freqRatioParam = voice.osc2Note.workletNode.parameters.get('frequencyRatio');
                
                if (freqParam && freqRatioParam) {
                    console.log(`Updating Osc2 Worklet note ${voice.osc2Note.id} (Voice ${voice.id}) frequency to ${targetFreq.toFixed(2)} Hz`);
                    freqParam.setTargetAtTime(targetFreq, now, 0.01);
                    freqRatioParam.setValueAtTime(1.0, now);
                } else {
                    console.warn(`Could not find frequency parameter for Osc2 note ${voice.osc2Note.id} (Voice ${voice.id})`);
                }
            }
        });
    });
} else { 
    console.warn("Oscillator 2 Octave Selector element not found!"); 
}
    // Initialize Oscillator 2 Wave Shape Selector
const osc2WaveSelector = D('osc2-wave-selector');
if (osc2WaveSelector) {
    // Set initial waveform
    const waveformMap = ['sine', 'sawtooth', 'triangle', 'square', 'pulse'];
    const waveformLabels = ['Sine', 'Saw', 'Triangle', 'Square', 'Pulse'];
    osc2Waveform = waveformMap[parseInt(osc2WaveSelector.value)];
    
    // Change from 'change' to 'input' event for immediate updates
    osc2WaveSelector.addEventListener('input', (e) => {
        const waveIndex = parseInt(e.target.value);
        osc2Waveform = waveformMap[waveIndex];
        
        // Show tooltip on top
        createTooltipForSlider(e.target, waveformLabels[waveIndex], 'top');
        
        console.log(`Osc2 waveform changed to: ${osc2Waveform}`);
        
        // Update all active Osc2 notes with new waveform
        const now = audioCtx.currentTime;
        voicePool.forEach(voice => {
            if (voice.osc2Note && voice.osc2Note.workletNode) {
                const pulseWidth = (osc2PWMValue === 0) ? 
                    getJunoWaveformParams(osc2Waveform).pulseWidth : 
                    (osc2PWMValue * 0.95);
                setJunoWaveform(voice.osc2Note.workletNode, osc2Waveform, pulseWidth);
            }
        });
        
        updateOsc2PWMKnobState();
    });
    
    // Hide tooltips on release
    osc2WaveSelector.addEventListener('mouseup', () => hideTooltipForSlider(osc2WaveSelector));
    osc2WaveSelector.addEventListener('touchend', () => hideTooltipForSlider(osc2WaveSelector));
}

// Hide tooltips for OSC2 octave selector
if (osc2OctaveSelector) {
    osc2OctaveSelector.addEventListener('mouseup', () => hideTooltipForSlider(osc2OctaveSelector));
    osc2OctaveSelector.addEventListener('touchend', () => hideTooltipForSlider(osc2OctaveSelector));
}

// Fix the OSC2 FM Source Switch (already exists around line 5350 but needs correction)
const osc2FmSourceSwitchElement = D('osc2-fm-source-switch');
if (osc2FmSourceSwitchElement) {
    const fmSwitchControl = initializeSwitch(osc2FmSourceSwitchElement, {
        onText: 'Osc 1',
        offText: 'Sampler',
        onChange: (isActive) => {
            osc2FMSource = isActive ? 'osc1' : 'sampler';
            console.log(`Osc2 FM Source set to: ${osc2FMSource}`);
            
            // Update all voices immediately
            const now = audioCtx.currentTime;
            voicePool.forEach(voice => {
                if (voice.osc2Note) {
                    updateOsc2FmModulatorParameters(voice.osc2Note, now, voice);
                }
            });
        }
    });
    fmSwitchControl.setValue(osc2FMSource === 'osc1');
}
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
// Add this function around line 5850 to start internal recording
function startInternalRecording() {
    console.log("Starting internal recording (master output)...");
    
    try {
        // Create MediaStreamDestination to capture audio
        internalRecordingDestination = audioCtx.createMediaStreamDestination();
        
        // Connect both master outputs to recording destination
        // This captures the complete synth output (oscillators + sampler)
        oscillatorMasterGain.connect(internalRecordingDestination);
        samplerMasterGain.connect(internalRecordingDestination);
        
        // Create MediaRecorder with the internal audio stream
        const options = { 
            mimeType: 'audio/webm;codecs=opus',
            audioBitsPerSecond: 128000
        };
        
        mediaRecorder = new MediaRecorder(internalRecordingDestination.stream, options);
        recordedChunks = [];
        
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                recordedChunks.push(event.data);
            }
        };
        
        mediaRecorder.onstop = () => {
            console.log("Internal recording stopped, processing audio...");
            const blob = new Blob(recordedChunks, { type: 'audio/webm' });
            
            // Convert blob to AudioBuffer
            const reader = new FileReader();
            reader.onload = () => {
                audioCtx.decodeAudioData(reader.result)
                    .then(buffer => {
                        console.log("Internal recording decoded successfully");
                        handleRecordingComplete(buffer);
                    })
                    .catch(err => {
                        console.error("Error decoding internal recording:", err);
                        alert("Failed to process internal recording");
                    });
            };
            reader.readAsArrayBuffer(blob);
            
            // Clean up connections
            if (internalRecordingDestination) {
                try {
                    oscillatorMasterGain.disconnect(internalRecordingDestination);
                    samplerMasterGain.disconnect(internalRecordingDestination);
                } catch(e) { /* Ignore */ }
                internalRecordingDestination = null;
            }
            
            isRecording = false;
            recordingStartTime = null;
            
            // Update UI
            const recButton = document.getElementById('mic-record-button');
            if (recButton) {
                recButton.classList.remove('recording');
                const led = recButton.querySelector('.led-indicator');
                if (led) led.classList.remove('on');
            }
        };
        
        mediaRecorder.start();
        isRecording = true;
        recordingStartTime = Date.now();
        
        // Update UI
        const recButton = document.getElementById('mic-record-button');
        if (recButton) {
            recButton.classList.add('recording');
            const led = recButton.querySelector('.led-indicator');
            if (led) led.classList.add('on');
        }
        
        console.log("Internal recording started successfully");
        
    } catch (error) {
        console.error("Error starting internal recording:", error);
        alert("Failed to start internal recording: " + error.message);
    }
}
// Add this function to create the recording mode dropdown
function createRecordingModeDropdown() {
    const recButton = document.getElementById('mic-record-button');
    if (!recButton) return null;

    // Create dropdown container
    const dropdown = document.createElement('div');
    dropdown.id = 'rec-mode-dropdown';
    dropdown.className = 'rec-mode-dropdown';
    dropdown.style.display = 'none';
    dropdown.innerHTML = `
        <div class="rec-mode-option" data-mode="external">
            <span class="mode-label">External</span>
        </div>
        <div class="rec-mode-option" data-mode="internal">
            <span class="mode-label">Internal</span>
        </div>
    `;

    // Insert dropdown after rec button's container
    const recContainer = recButton.closest('.rec-button-container');
    if (recContainer) {
        recContainer.appendChild(dropdown);
    } else {
        recButton.parentNode.insertBefore(dropdown, recButton.nextSibling);
    }

    // Add click handlers for mode selection
    const modeOptions = dropdown.querySelectorAll('.rec-mode-option');
    modeOptions.forEach(option => {
        option.addEventListener('click', (e) => {
            e.stopPropagation();
            const mode = option.getAttribute('data-mode');
            recordingMode = mode;
            console.log(`Recording mode set to: ${mode}`);
            
            // Update active state
            modeOptions.forEach(opt => opt.classList.remove('active'));
            option.classList.add('active');
            
            // Hide dropdown
            dropdown.style.display = 'none';
            
            // Start recording with selected mode
            startRecording(mode);
        });
    });

    // Set initial active mode (default to external)
    const defaultOption = dropdown.querySelector(`[data-mode="external"]`);
    if (defaultOption) defaultOption.classList.add('active');

    return dropdown;
}

// Add this function to start recording based on mode
function startRecording(mode) {
    if (mode === 'internal') {
        startInternalRecording();
    } else {
        // External (mic) recording - use the recorder from sampler.js
        console.log("Starting external microphone recording...");
        if (externalRecorder && externalRecorder.isWorkletReady()) {
            externalRecorder.startRecording();
        } else {
            console.error("External recorder not ready");
            alert("Microphone recording is not ready yet. Please try again in a moment.");
        }
    }
}
document.addEventListener('DOMContentLoaded', () => {
  // Other initialization code...
  // Initialize Filter slider
  const freqSlider = document.querySelector('.freq-slider-range');
  if (freqSlider) {
    initializeFilterPrecisionSlider(freqSlider);
  }
  // Initialize ADSR sliders with the fixed function
  ['attack', 'decay', 'release'].forEach(id => {
    const slider = document.getElementById(id);
    if (slider) {
      initializeADSRPrecisionSlider(slider);
    }
  });
});
