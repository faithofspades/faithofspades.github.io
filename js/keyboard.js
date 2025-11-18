// filepath: d:\Dropbox\Github Computer Programming Class\faithofspades.github.io\js\keyboard.js
// --- Module State ---
let noteOnCallback = () => {};
let noteOffCallback = () => {};
let updateKeyboardDisplayCallback = () => {};
const keyStates = {}; // Track physical key states internally
const activeNotes = new Map(); // Track which note number each key is playing (key index -> actual note number)

// Key mappings (copied from main.js)
export const keys = [
    'Z','S','X','D','C','V','G','B','H','N','J','M',  // First octave
    'Q','2','W','3','E','R','5','T','6','Y','7','U'   // Second octave
];
const specialKeyMap = {
    ',': 12, '.': 14, '/': 16, 'L': 13, 'l': 13, ';': 15,
    'I': 24, 'i': 24, '9': 25, 'O': 26, 'o': 26, '0': 27, 'P': 28, 'p': 28, '[': 29, '=': 30, ']': 31
};

// Initialize keyStates based on mappings
keys.forEach(key => keyStates[key] = false);
Object.keys(specialKeyMap).forEach(key => keyStates[key] = false);


// --- Helper Functions ---

function getWhiteKeyIndex(position) {
    const whiteKeyMap = [0, 2, 4, 5, 7, 9, 11];
    const octave = Math.floor(position / 7);
    const noteInOctave = position % 7;
    return whiteKeyMap[noteInOctave] + (octave * 12);
}

function getBlackKeyIndex(position) {
    const blackKeyIndices = [1, 3, 6, 8, 10, 13, 15, 18, 20, 22];
    return blackKeyIndices[position];
}

// --- Keyboard Generation ---

function generateKeyboard(keyboardElement) {
    if (!keyboardElement) return;
    keyboardElement.innerHTML = ''; // Clear existing

    // White keys
    const whiteKeysLayout = ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'A', 'B'];
    for (let i = 0; i < whiteKeysLayout.length; i++) {
        const key = document.createElement('div');
        key.className = 'key';
        const keyIndex = getWhiteKeyIndex(i);
        key.dataset.noteIndex = keyIndex;
        keyboardElement.appendChild(key);
        addKeyListeners(key, keyIndex);
    }

    // Black keys
    for (let i = 0; i < 10; i++) {
        const key = document.createElement('div');
        key.className = 'key black';
        const keyIndex = getBlackKeyIndex(i);
        key.dataset.noteIndex = keyIndex;
        keyboardElement.appendChild(key);
        addKeyListeners(key, keyIndex);
    }
}

// --- Event Listeners ---

function addKeyListeners(keyElement, noteIndex) {
    // Mouse events
    keyElement.addEventListener('mousedown', () => {
        // Apply octave shift before calling noteOn
        const octaveShift = window.getKeyboardOctaveShift ? window.getKeyboardOctaveShift() : 0;
        const actualNote = Math.max(0, Math.min(127, noteIndex + (octaveShift * 12)));
        
        // Store which note this key is playing
        activeNotes.set(noteIndex, actualNote);
        
        noteOnCallback(actualNote);
        keyElement.classList.add('pressed');
    });
    keyElement.addEventListener('mouseup', () => {
        // Use the stored note number for release
        const actualNote = activeNotes.get(noteIndex);
        if (actualNote !== undefined) {
            noteOffCallback(actualNote);
            activeNotes.delete(noteIndex);
        }
        keyElement.classList.remove('pressed');
    });
    keyElement.addEventListener('mouseleave', () => {
        if (keyElement.classList.contains('pressed')) {
            // Use the stored note number for release
            const actualNote = activeNotes.get(noteIndex);
            if (actualNote !== undefined) {
                noteOffCallback(actualNote);
                activeNotes.delete(noteIndex);
            }
            keyElement.classList.remove('pressed');
        }
    });

    // Touch events
    keyElement.addEventListener('touchstart', (e) => {
        // Apply octave shift before calling noteOn
        const octaveShift = window.getKeyboardOctaveShift ? window.getKeyboardOctaveShift() : 0;
        const actualNote = Math.max(0, Math.min(127, noteIndex + (octaveShift * 12)));
        
        // Store which note this key is playing
        activeNotes.set(noteIndex, actualNote);
        
        noteOnCallback(actualNote);
        keyElement.classList.add('pressed');
        e.preventDefault();
    }, { passive: false });
    keyElement.addEventListener('touchend', (e) => {
        // Use the stored note number for release
        const actualNote = activeNotes.get(noteIndex);
        if (actualNote !== undefined) {
            noteOffCallback(actualNote);
            activeNotes.delete(noteIndex);
        }
        keyElement.classList.remove('pressed');
        e.preventDefault();
    }, { passive: false });
    keyElement.addEventListener('touchcancel', (e) => {
        // Use the stored note number for release
        const actualNote = activeNotes.get(noteIndex);
        if (actualNote !== undefined) {
            noteOffCallback(actualNote);
            activeNotes.delete(noteIndex);
        }
        keyElement.classList.remove('pressed');
        e.preventDefault();
    }, { passive: false });
}

function handleKeyDown(e) {
    if (e.repeat) return;
    const upperKey = e.key.toUpperCase();

    if (keys.includes(upperKey) && !keyStates[upperKey]) {
        keyStates[upperKey] = true;
        const noteIndex = keys.indexOf(upperKey);
        
        // Apply octave shift before calling noteOn
        const octaveShift = window.getKeyboardOctaveShift ? window.getKeyboardOctaveShift() : 0;
        const actualNote = Math.max(0, Math.min(127, noteIndex + (octaveShift * 12)));
        
        // Store which note this key is playing (use string key for computer keyboard)
        activeNotes.set(upperKey, actualNote);
        
        noteOnCallback(actualNote);
        updateKeyboardDisplayCallback(); // Trigger visual update
        return;
    }

    if (Object.prototype.hasOwnProperty.call(specialKeyMap, e.key) && !keyStates[e.key]) {
        keyStates[e.key] = true;
        const noteIndex = specialKeyMap[e.key];
        
        // Apply octave shift before calling noteOn
        const octaveShift = window.getKeyboardOctaveShift ? window.getKeyboardOctaveShift() : 0;
        const actualNote = Math.max(0, Math.min(127, noteIndex + (octaveShift * 12)));
        
        // Store which note this key is playing
        activeNotes.set(e.key, actualNote);
        
        noteOnCallback(actualNote);
        updateKeyboardDisplayCallback(); // Trigger visual update
    }
}

function handleKeyUp(e) {
    const upperKey = e.key.toUpperCase();

    if (keys.includes(upperKey) && keyStates[upperKey]) {
        keyStates[upperKey] = false;
        
        // Use the stored note number for release
        const actualNote = activeNotes.get(upperKey);
        if (actualNote !== undefined) {
            noteOffCallback(actualNote);
            activeNotes.delete(upperKey);
        }
        
        updateKeyboardDisplayCallback(); // Trigger visual update
        return;
    }

    if (Object.prototype.hasOwnProperty.call(specialKeyMap, e.key) && keyStates[e.key]) {
        keyStates[e.key] = false;
        
        // Use the stored note number for release
        const actualNote = activeNotes.get(e.key);
        if (actualNote !== undefined) {
            noteOffCallback(actualNote);
            activeNotes.delete(e.key);
        }
        
        updateKeyboardDisplayCallback(); // Trigger visual update
    }
}

// --- Initialization ---

export function initializeKeyboard(elementId, onNoteOn, onNoteOff, onUpdateDisplay) {
    const keyboardElement = document.getElementById(elementId);
    if (!keyboardElement) {
        console.error(`Keyboard element with ID "${elementId}" not found.`);
        return;
    }

    // Store callbacks
    noteOnCallback = onNoteOn || noteOnCallback;
    noteOffCallback = onNoteOff || noteOffCallback;
    updateKeyboardDisplayCallback = onUpdateDisplay || updateKeyboardDisplayCallback;

    // Generate visual keyboard
    generateKeyboard(keyboardElement);

    // Attach physical keyboard listeners
    document.removeEventListener('keydown', handleKeyDown); // Remove old listener if any
    document.removeEventListener('keyup', handleKeyUp);     // Remove old listener if any
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);

    console.log("Keyboard Module Initialized");
}
// --- State Reset ---
export function resetKeyStates() {
    // Reset visual key states
    document.querySelectorAll('.key').forEach(key => {
        key.classList.remove('pressed');
    });
    
    // Reset internal key tracking
    keys.forEach((_, index) => {
        keyStates[index] = false;
    });
    
    // Force browser to clear any stuck key states (important for transitions)
    window.addEventListener('keyup', function clearKeys() {
        window.removeEventListener('keyup', clearKeys);
    });
    
    console.log("All keyboard states reset");
}