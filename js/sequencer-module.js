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
        accentInterval = 1; // Every button is accented (all orange)
    } else if (numerator === 2) {
        totalSteps = 8; // 2 beats, 4 steps each = 8 total
        accentInterval = 2; // Orange every 2 steps (every half beat in terms of display)
    } else if (numerator === 3) {
        totalSteps = 12;
        accentInterval = 3;
    } else if (numerator === 4) {
        totalSteps = 16;
        accentInterval = 4;
    } else if (numerator === 5) {
        totalSteps = 20;
        accentInterval = 5;
    } else if (numerator === 6) {
        totalSteps = 12; // Same as 3, different accent
        accentInterval = 6;
    } else if (numerator === 7) {
        totalSteps = 14;
        accentInterval = 7;
    } else if (numerator === 8) {
        totalSteps = 16;
        accentInterval = 8;
    } else if (numerator === 9) {
        totalSteps = 18;
        accentInterval = 9;
    } else if (numerator === 10) {
        totalSteps = 20;
        accentInterval = 10;
    } else if (numerator === 11) {
        totalSteps = 11;
        accentInterval = 11;
    } else if (numerator === 12) {
        totalSteps = 12;
        accentInterval = 12;
    } else if (numerator === 13) {
        totalSteps = 13;
        accentInterval = 13;
    } else if (numerator === 14) {
        totalSteps = 14;
        accentInterval = 14;
    } else if (numerator === 15) {
        totalSteps = 15;
        accentInterval = 15;
    } else if (numerator === 16) {
        totalSteps = 16;
        accentInterval = 16;
    } else {
        totalSteps = 16;
        accentInterval = 4;
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
    
    // Clear existing buttons
    container.innerHTML = '';
    
    // Create new buttons
    for (let i = 1; i <= config.totalSteps; i++) {
        const button = document.createElement('div');
        button.className = 'seq-step-button';
        button.id = `seq-step-${i}`;
        button.textContent = i;
        
        // Set custom width
        button.style.width = `${config.buttonWidth}px`;
        button.style.minWidth = `${config.buttonWidth}px`;
        
        // Add accent styling for orange buttons with underline
        if ((i - 1) % config.accentInterval === 0) {
            button.style.backgroundColor = '#CF814D';
            button.style.textDecoration = 'underline';
        }
        
        container.appendChild(button);
    }
    
    console.log(`Rebuilt ${config.totalSteps} step buttons for ${globalMeterNumerator}/${globalMeterDenominator}`);
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
    
    // Initialize mod rate knob state
    updateModRateKnobState();
    
    console.log('Division system initialized');
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
    const secondsPerBeat = 60.0 / globalTempo;
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

function scheduleNote(beatNumber, time) {
    // Schedule the metronome click only on the beat
    if (currentTick === 0) {
        const isAccent = (beatNumber === 0);
        playMetronomeClick(isAccent, time);
        
        // Schedule visual update
        scheduleDraw(beatNumber, time);
    }
    
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
            scheduleNote(currentBeat, nextNoteTime);
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
    
    if (isPaused) {
        // Resume from current position
        isPaused = false;
        nextNoteTime = audioContext.currentTime; // Reset to now
    } else {
        // Start fresh
        resetTempoState();
    }
    
    isTempoPlaying = true;
    scheduler(); // Start the scheduler
    
    console.log(`Tempo started at ${globalTempo} BPM, ${globalMeterNumerator}/${globalMeterDenominator}`);
}

// --- Stop Tempo ---
function stopTempo(options = {}) {
    const { keepButtonState = false } = options;
    isTempoPlaying = false;
    isPaused = false;
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
    
    // Reset step visuals
    updateStepVisuals(-1);
    
    console.log('Tempo stopped');
}

// --- Pause Tempo ---
function pauseTempo() {
    if (!isTempoPlaying) return;
    
    isPaused = true;
    isTempoPlaying = false;
    
    if (timerID) {
        clearTimeout(timerID);
        timerID = null;
    }
    
    console.log('Tempo paused');
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

// --- Visual Scheduler ---
function scheduleDraw(beatNumber, time) {
    const audioContext = window.audioCtx;
    if (!audioContext) return;
    
    const now = audioContext.currentTime;
    const delay = Math.max(0, (time - now) * 1000);
    
    setTimeout(() => {
        updateStepVisuals(beatNumber + 1); // 1-based index
    }, delay);
}

function updateStepVisuals(currentStep) {
    // Clear all active steps
    const buttons = document.querySelectorAll('.seq-step-button');
    buttons.forEach(btn => btn.classList.remove('active'));
    
    // Highlight current step
    if (currentStep > 0) {
        const activeBtn = document.getElementById(`seq-step-${currentStep}`);
        if (activeBtn) activeBtn.classList.add('active');
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
    getIntervalTime: calculateIntervalTime,
    getMeter: () => ({ numerator: globalMeterNumerator, denominator: globalMeterDenominator }),
    initializeColors: () => {
        updateDestinationHighlight('GLOBAL');
        updateSelectButtonState();
        console.log('Sequencer destination colors initialized');
    }
};

// --- Initialize UI Event Listeners ---
function initializeSequencerUI() {
    // Play button
    const playButton = document.getElementById('seq-play-button');
    const playButtonImg = playButton ? playButton.querySelector('img') : null;
    if (playButton) {
        playButton.addEventListener('click', () => {
            if (isTempoPlaying) {
                // Second press stops playback and resets transport
                stopTempo();
                playButton.classList.remove('active');
                if (playButtonImg) playButtonImg.src = 'control%20icons/PLAY.svg';
                const pauseBtn = document.getElementById('seq-pause-button');
                if (pauseBtn) pauseBtn.classList.remove('active');
                return;
            } else if (isPaused) {
                // Resume from pause
                startTempo();
                playButton.classList.add('active');
                if (playButtonImg) playButtonImg.src = 'control%20icons/STOP.svg';
            } else {
                // Start fresh
                startTempo();
                playButton.classList.add('active');
                if (playButtonImg) playButtonImg.src = 'control%20icons/STOP.svg';
            }
            const pauseBtn = document.getElementById('seq-pause-button');
            if (pauseBtn) pauseBtn.classList.remove('active');
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
    
    // Metronome volume knob
    const metronomeKnob = document.getElementById('seq-metronome-vol-knob');
    if (metronomeKnob) {
        initializeKnob(metronomeKnob, (value) => {
            metronomeVolume = value;
            console.log(`Metronome volume: ${Math.round(value * 100)}%`);
        });
    }
    
    // Tempo knob
    const tempoKnob = document.getElementById('seq-tempo-knob');
    if (tempoKnob) {
        initializeKnob(tempoKnob, 
            // onChange: update tempo in real-time
            (value) => {
                const bpm = 20 + (value * 280);
                setTempo(bpm);
                updateTempoKnobDisplay();
                
                // Show tooltip
                const tooltip = createTooltipForKnob('seq-tempo-knob');
                tooltip.textContent = `${Math.round(bpm)} BPM`;
                tooltip.style.opacity = '1';
            },
            // onEnd: hide tooltip
            () => {
                const tooltip = document.getElementById('seq-tempo-knob-tooltip');
                if (tooltip) tooltip.style.opacity = '0';
            }
        );
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
        destSlider.addEventListener('dblclick', () => {
            toggleDivisionRouting(currentDivisionDestination);
        });
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
        const octDots = document.querySelectorAll('.seq-octave-buttons + .seq-dots-container .seq-dot');
        
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
        const dirDots = document.querySelectorAll('.seq-direction-buttons + .seq-dots-container .seq-dot');
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
