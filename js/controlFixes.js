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
 * @param {object} activeVoicesRef - Reference to the activeVoices object. // Renamed parameter
 * @param {array} heldNotesRef - Reference to the heldNotes array.
 */
export function initializeSpecialButtons(
    onEmuModeToggle,
    updateSampleProcessingCallback,
    updatePlaybackParamsCallback,
    activeVoicesRef,
    heldNotesRef
) {
    let controls = null;

    const emuModeSwitch = D('emu-mode-switch');
    if (emuModeSwitch) {
        const newEmuSwitch = emuModeSwitch.cloneNode(true);
        emuModeSwitch.parentNode.replaceChild(newEmuSwitch, emuModeSwitch);

        let touchLock = false;
        let touchTimeout;

        const applyEmuModeState = (nextState, options = {}) => {
            const { suppressCallbacks = false, force = false } = options;
            const targetState = !!nextState;
            const wasActive = newEmuSwitch.classList.contains('active');
            if (!force && wasActive === targetState) {
                return;
            }

            newEmuSwitch.classList.toggle('active', targetState);
            const led = D('emu-led');
            if (led) {
                led.classList.toggle('on', targetState);
            }

            if (suppressCallbacks) {
                return;
            }

            onEmuModeToggle(targetState);
            updateSampleProcessingCallback();

            setTimeout(() => {
                if (!activeVoicesRef) {
                    return;
                }
                Object.values(activeVoicesRef).forEach(voice => {
                    if (voice && voice.samplerNote) {
                        const isHeld = Array.isArray(heldNotesRef) && heldNotesRef.includes(voice.noteNumber);
                        console.log(`Lo-Fi Toggle: Updating sampler note ${voice.samplerNote.id} (held: ${isHeld})`);
                        updatePlaybackParamsCallback(voice.samplerNote);
                    }
                });
            }, 50);

            console.log('Lo-Fi Mode:', targetState ? 'ON' : 'OFF');
        };

        const handleClick = function(e) {
            if (touchLock) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            touchLock = true;

            applyEmuModeState(!newEmuSwitch.classList.contains('active'));

            clearTimeout(touchTimeout);
            touchTimeout = setTimeout(() => { touchLock = false; }, 300);
        };

        newEmuSwitch.addEventListener('click', handleClick);

        newEmuSwitch.addEventListener('touchstart', function(e) {
            e.stopPropagation();
        }, { passive: true });

        newEmuSwitch.addEventListener('touchend', function(e) {
            if (!touchLock) {
                handleClick(e);
            }
            e.preventDefault();
            e.stopPropagation();
        }, { passive: false });

        controls = {
            setEmuModeState: (state, options = {}) => applyEmuModeState(state, options)
        };
    }

    return controls;
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
    // Add global mode transition lock
    window.isModeTransitioning = false;

    const switchConfigs = {
        'voice-mode-switch': { callback: onMonoToggle, logName: 'Voice Mode', states: ['POLY', 'MONO'] },
        'trigger-mode-switch': { callback: onLegatoToggle, logName: 'Trigger Mode', states: ['MULTI', 'LEGATO'] },
        'portamento-switch': { callback: onPortaToggle, logName: 'Portamento', states: ['OFF', 'ON'] }
    };

    // Force reset global state before attaching new handlers
    window.isMonoMode = false;
    window.isLegatoMode = false;
    window.isPortamentoOn = false;
    console.log("RESETTING ALL SWITCH STATES");

    Object.keys(switchConfigs).forEach(id => {
        const switchEl = D(id);
        if (!switchEl) return;

        // IMPORTANT: Remove the old switch and replace with clone
        const newSwitch = switchEl.cloneNode(true);
        switchEl.parentNode.replaceChild(newSwitch, switchEl);

        // Reset visual state to match our forced reset above
        newSwitch.classList.remove('active');
        
        const config = switchConfigs[id];

        // Simplify event handling - use a single function for all events
        const toggleSwitch = function(e) {
            e.preventDefault();
            e.stopPropagation();

            // Prevent toggling during transition
            if (window.isModeTransitioning) {
                console.log(`${config.logName} toggle ignored - mode transition in progress`);
                return;
            }

            // Explicitly toggle, don't rely on classList.toggle
            const currentState = newSwitch.classList.contains('active');
            const newState = !currentState;
            
            // Update visual state
            newSwitch.classList.toggle('active', newState);
            
            // Special handling for mono mode switch
            if (id === 'voice-mode-switch') {
                console.log(`${config.logName} toggled to: ${newState ? 'MONO' : 'POLY'}`);
                
                // Set transition lock
                window.isModeTransitioning = true;
                
                // Force cleanup before changing mode
                if (cleanupNotesCallback) {
                    console.log("Cleaning up all notes before mode change");
                    cleanupNotesCallback();
                }
                
                // Call the callback with explicit log verification after a small delay
                setTimeout(() => {
                    config.callback(newState);
                    
                    // Release transition lock after mode is fully changed
                    setTimeout(() => {
                        window.isModeTransitioning = false;
                        console.log("Mode transition complete - input unlocked");
                    }, 50);
                }, 20);
            } else {
                // For non-mono switches, just call the callback directly
                console.log(`${config.logName} toggled to:`, newState);
                config.callback(newState);
            }
        };

        // Use click for all devices for consistency
        newSwitch.addEventListener('click', toggleSwitch);
        
        // Also catch touchend for touch devices to ensure the event fires
        newSwitch.addEventListener('touchend', function(e) {
            toggleSwitch(e);
        }, { passive: false });
    });

    // Log the initial state of all switches
    console.log("INITIAL SWITCH STATE CHECK after fixSwitchesTouchMode:", 
        `mono=${window.isMonoMode}, legato=${window.isLegatoMode}, portamento=${window.isPortamentoOn}`);
}