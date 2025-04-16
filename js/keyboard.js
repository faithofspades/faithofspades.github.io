// filepath: d:\Dropbox\Github Computer Programming Class\faithofspades.github.io\js\keyboard.js
// --- Module State ---
let noteOnCallback = () => {};
let noteOffCallback = () => {};
let updateKeyboardDisplayCallback = () => {};
const keyStates = {}; // Track physical key states internally

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
        noteOnCallback(noteIndex);
        keyElement.classList.add('pressed');
    });
    keyElement.addEventListener('mouseup', () => {
        noteOffCallback(noteIndex);
        keyElement.classList.remove('pressed');
    });
    keyElement.addEventListener('mouseleave', () => {
        if (keyElement.classList.contains('pressed')) {
            noteOffCallback(noteIndex);
            keyElement.classList.remove('pressed');
        }
    });

    // Touch events
    keyElement.addEventListener('touchstart', (e) => {
        noteOnCallback(noteIndex);
        keyElement.classList.add('pressed');
        e.preventDefault();
    }, { passive: false });
    keyElement.addEventListener('touchend', (e) => {
        noteOffCallback(noteIndex);
        keyElement.classList.remove('pressed');
        e.preventDefault();
    }, { passive: false });
    keyElement.addEventListener('touchcancel', (e) => {
        noteOffCallback(noteIndex);
        keyElement.classList.remove('pressed');
        e.preventDefault();
    }, { passive: false });
}

function handleKeyDown(e) {
    if (e.repeat) return;
    const upperKey = e.key.toUpperCase();

    if (keys.includes(upperKey) && !keyStates[upperKey]) {
        keyStates[upperKey] = true;
        noteOnCallback(keys.indexOf(upperKey));
        updateKeyboardDisplayCallback(); // Trigger visual update
        return;
    }

    if (Object.prototype.hasOwnProperty.call(specialKeyMap, e.key) && !keyStates[e.key]) {
        keyStates[e.key] = true;
        noteOnCallback(specialKeyMap[e.key]);
        updateKeyboardDisplayCallback(); // Trigger visual update
    }
}

function handleKeyUp(e) {
    const upperKey = e.key.toUpperCase();

    if (keys.includes(upperKey) && keyStates[upperKey]) {
        keyStates[upperKey] = false;
        noteOffCallback(keys.indexOf(upperKey));
        updateKeyboardDisplayCallback(); // Trigger visual update
        return;
    }

    if (Object.prototype.hasOwnProperty.call(specialKeyMap, e.key) && keyStates[e.key]) {
        keyStates[e.key] = false;
        noteOffCallback(specialKeyMap[e.key]);
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
    for (const key in keyStates) {
        keyStates[key] = false;
    }
    console.log("Keyboard key states reset.");
}