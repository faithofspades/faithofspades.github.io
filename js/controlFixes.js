// filepath: d:\Dropbox\Github Computer Programming Class\faithofspades.github.io\js\controlFixes.js
import { initializeKnob } from './controls.js'; // Assuming initializeKnob is exported from controls.js

// Helper (if not globally available or imported elsewhere)
const D = x => document.getElementById(x);

/**
 * Fixes knob interactions for desktop and mobile, including double-click/tap reset.
 * @param {object} knobInitCallbacks - Object mapping knob IDs to their update callback functions.
 * @param {object} knobDefaultValues - Object mapping knob IDs to their default values (0-1).
 */
export function fixAllKnobs(knobInitCallbacks, knobDefaultValues) {
    document.querySelectorAll('.knob').forEach(knob => {
        // Create a completely fresh knob without any event listeners
        const newKnob = knob.cloneNode(true);
        knob.parentNode.replaceChild(newKnob, knob);

        // Extract ID and initial state
        const knobId = newKnob.id;
        const callback = knobInitCallbacks[knobId];
        // Use provided defaults, fallback to 0.5 if not specified
        const defaultValue = knobDefaultValues[knobId] !== undefined ? knobDefaultValues[knobId] : 0.5;

        // Set up initial rotation based on default value
        let rotation = -150 + (defaultValue * 300);
        newKnob.style.transform = `rotate(${rotation}deg)`;

        // Track interaction state
        let isDragging = false;
        let startY, lastY;

        // Double-click/tap detection
        let lastClickTime = 0;

        // Desktop mouse handling
        newKnob.addEventListener('mousedown', function(e) {
            const now = new Date().getTime();
            const timeSinceLastClick = now - lastClickTime;

            if (timeSinceLastClick < 350 && timeSinceLastClick > 0) {
                resetToDefault();
                e.preventDefault();
                return;
            }
            lastClickTime = now;

            isDragging = true;
            startY = e.clientY;
            lastY = startY;
            this.style.cursor = 'grabbing';
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
            e.preventDefault();
        });

        function handleMouseMove(e) {
            if (!isDragging) return;
            const deltaY = lastY - e.clientY;
            lastY = e.clientY;
            updateKnob(deltaY);
            e.preventDefault();
        }

        function handleMouseUp() {
            if (isDragging) {
                isDragging = false;
                newKnob.style.cursor = 'grab';
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            }
        }

        // Touch handling
        newKnob.addEventListener('touchstart', function(e) {
            const now = new Date().getTime();
            const timeSinceLastClick = now - lastClickTime;

            if (timeSinceLastClick < 350 && timeSinceLastClick > 0) {
                resetToDefault();
                e.preventDefault();
                return;
            }
            lastClickTime = now;

            if (e.touches.length !== 1) return;
            isDragging = true;
            startY = e.touches[0].clientY;
            lastY = startY;
            document.addEventListener('touchmove', handleTouchMove, { passive: false });
            document.addEventListener('touchend', handleTouchEnd);
            document.addEventListener('touchcancel', handleTouchEnd);
            e.preventDefault();
        }, { passive: false });

        function handleTouchMove(e) {
            if (!isDragging || e.touches.length !== 1) return;
            const deltaY = lastY - e.touches[0].clientY;
            lastY = e.touches[0].clientY;
            updateKnob(deltaY);
            e.preventDefault();
        }

        function handleTouchEnd() {
            if (isDragging) {
                isDragging = false;
                document.removeEventListener('touchmove', handleTouchMove);
                document.removeEventListener('touchend', handleTouchEnd);
                document.removeEventListener('touchcancel', handleTouchEnd);
            }
        }

        // Common function to update knob rotation and value
        function updateKnob(delta) {
            const newRotation = Math.min(150, Math.max(-150, rotation + delta));
            if (newRotation !== rotation) {
                rotation = newRotation;
                newKnob.style.transform = `rotate(${rotation}deg)`;
                if (callback) {
                    const normalizedValue = (rotation + 150) / 300;
                    callback(normalizedValue); // Call the specific callback for this knob
                }
            }
        }

        // Reset function for double-click/tap
        function resetToDefault() {
            rotation = -150 + (defaultValue * 300);
            newKnob.style.transform = `rotate(${rotation}deg)`;
            if (callback) {
                callback(defaultValue); // Call the callback with the default value
            }
            console.log(`Reset ${knobId} to default value:`, defaultValue);
        }
    });
}


/**
 * Initializes special buttons like Lo-Fi mode.
 * @param {function} onEmuModeToggle - Callback function when Emu mode is toggled (receives new boolean state).
 * @param {function} updateSampleProcessingCallback - Callback to trigger sample processing update.
 * @param {function} updatePlaybackParamsCallback - Callback to update playback parameters for active notes.
 * @param {object} activeNotesRef - Reference to the activeNotes object.
 * @param {array} heldNotesRef - Reference to the heldNotes array.
 */
export function initializeSpecialButtons(
    onEmuModeToggle,
    updateSampleProcessingCallback,
    updatePlaybackParamsCallback,
    activeNotesRef,
    heldNotesRef
) {
    // Fix for LoFi button
    const emuModeSwitch = D('emu-mode-switch');
    if (emuModeSwitch) {
        const newEmuSwitch = emuModeSwitch.cloneNode(true);
        emuModeSwitch.parentNode.replaceChild(newEmuSwitch, emuModeSwitch);

        let touchLock = false;
        let touchTimeout;

        const handleClick = function(e) {
            if (touchLock) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            touchLock = true;

            const isActive = newEmuSwitch.classList.contains('active');
            const newState = !isActive; // The state *after* the toggle

            // Update internal state via callback
            onEmuModeToggle(newState);

            // Update UI
            const led = D('emu-led');
            if (led) led.classList.toggle('on', newState);
            newEmuSwitch.classList.toggle('active', newState);

            // Trigger necessary updates
            updateSampleProcessingCallback();
            Object.values(activeNotesRef).forEach(note => {
                if (note && note.source && !heldNotesRef.includes(note.noteNumber)) {
                    updatePlaybackParamsCallback(note);
                }
            });

            console.log('Lo-Fi Mode:', newState ? 'ON' : 'OFF');

            clearTimeout(touchTimeout);
            touchTimeout = setTimeout(() => { touchLock = false; }, 300);
        };

        newEmuSwitch.addEventListener('click', handleClick);

        newEmuSwitch.addEventListener('touchstart', function(e) {
            e.stopPropagation(); // Prevent potential parent handlers
        }, { passive: true });

        newEmuSwitch.addEventListener('touchend', function(e) {
            if (!touchLock) {
                handleClick(e); // Simulate click on touchend if not locked
            }
            e.preventDefault();
            e.stopPropagation();
        }, { passive: false });
    }

    // Add initialization for other special buttons (like Rec) here if needed
}


/**
 * Fixes touch interaction for vertical switches (Mono, Legato, Porta).
 * @param {function} onMonoToggle - Callback when mono mode toggles (receives new boolean state).
 * @param {function} onLegatoToggle - Callback when legato mode toggles (receives new boolean state).
 * @param {function} onPortaToggle - Callback when portamento mode toggles (receives new boolean state).
 * @param {function} cleanupNotesCallback - Callback to clean up all notes.
 */
export function fixSwitchesTouchMode(
    onMonoToggle,
    onLegatoToggle,
    onPortaToggle,
    cleanupNotesCallback
) {
    const switchConfigs = {
        'voice-mode-switch': { callback: onMonoToggle, logName: 'Voice Mode', states: ['POLY', 'MONO'] },
        'trigger-mode-switch': { callback: onLegatoToggle, logName: 'Trigger Mode', states: ['MULTI', 'LEGATO'] },
        'portamento-switch': { callback: onPortaToggle, logName: 'Portamento', states: ['OFF', 'ON'] }
    };

    Object.keys(switchConfigs).forEach(id => {
        const switchEl = D(id);
        if (!switchEl) return;

        const newSwitch = switchEl.cloneNode(true);
        switchEl.parentNode.replaceChild(newSwitch, switchEl);

        const config = switchConfigs[id];

        const handleInteraction = function(e) {
            // Prevent default actions and bubbling
            e.preventDefault();
            e.stopPropagation();

            // Toggle the class
            newSwitch.classList.toggle('active');
            const isActive = newSwitch.classList.contains('active');

            // Call the specific callback
            config.callback(isActive);

            // Log the change
            console.log(`${config.logName}: ${config.states[isActive ? 1 : 0]}`);

            // Special action for voice mode switch
            if (id === 'voice-mode-switch') {
                cleanupNotesCallback();
            }
        };

        // Use touchstart for immediate feedback on touch devices
        newSwitch.addEventListener('touchstart', handleInteraction, { passive: false });

        // Also handle clicks for mouse users, but prevent double-triggering from touch
        newSwitch.addEventListener('click', function(e) {
            // If the event originated from touch, the touchstart handler already ran
            if (e.pointerType === 'touch' || e.sourceCapabilities?.firesTouchEvents) {
                return;
            }
            // Manually toggle state for click events as classList might have been toggled by touchstart
            const currentState = this.classList.contains('active');
            const newState = !currentState;
            this.classList.toggle('active', newState); // Ensure class matches intended state

            config.callback(newState);
            console.log(`${config.logName}: ${config.states[newState ? 1 : 0]}`);
            if (id === 'voice-mode-switch') {
                cleanupNotesCallback();
            }
        });
    });
}