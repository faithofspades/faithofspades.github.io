// filepath: d:\Dropbox\Github Computer Programming Class\faithofspades.github.io\js\controls.js
/**
 * Initializes a knob element with drag-to-rotate functionality, touch support,
 * and double-click/tap to reset.
 * @param {HTMLElement} knob - The knob element to initialize.
 * @param {Function} onChange - Callback function triggered when the knob value changes. Receives the normalized value (0-1).
 * @param {Object} knobDefaults - An object containing default values for knobs, keyed by knob ID.
 * @returns {Object} An object with `getValue` and `setValue` methods.
 */
export function initializeKnob(knob, onChange, knobDefaults) {
    // Remove any existing event listeners first by cloning
    const newKnob = knob.cloneNode(true);
    knob.parentNode.replaceChild(newKnob, knob);
    knob = newKnob; // Use the new clone
    
    // DEBUG: Log element identity after cloning
    console.log(`[initializeKnob] After cloning ${newKnob.id}:`, newKnob);
    console.log(`[initializeKnob] Is same as getElementById?`, newKnob === document.getElementById(newKnob.id));

    // Use default value from knobDefaults if available, otherwise 0.5
    const defaultValue = knobDefaults[knob.id] !== undefined ? knobDefaults[knob.id] : 0.5;

    // Set initial rotation based on default value
    let rotation = -150 + (defaultValue * 300);
    let isDragging = false;
    let lastY;
    let initialMovement = true; // Flag to track first movement

    // Double-click/tap detection
    let lastInteractionTime = 0;
    const doubleClickThreshold = 350; // ms

    // Set the initial visual rotation
    knob.style.transform = `rotate(${rotation}deg)`;
    knob.style.cursor = 'grab'; // Initial cursor

    function resetToDefault() {
        rotation = -150 + (defaultValue * 300);
        knob.style.transform = `rotate(${rotation}deg)`;
        if (onChange) {
            // Trigger onChange with the default value when resetting
            onChange(defaultValue);
        }
        console.log(`Knob ${knob.id} reset to default: ${defaultValue}`);
    }

    function handleMove(y) {
        const sensitivity = 1.0; // Adjust sensitivity if needed
        const deltaY = (lastY - y) * sensitivity;

        if (initialMovement) {
            // On first movement, just record the position but don't apply the delta
            initialMovement = false;
            lastY = y;
            return;
        }

        lastY = y;

        const newRotation = Math.min(150, Math.max(-150, rotation + deltaY));

        if (newRotation !== rotation) {
            rotation = newRotation;
            knob.style.transform = `rotate(${rotation}deg)`;

            if (onChange) {
                const normalizedValue = (rotation + 150) / 300;
                onChange(normalizedValue);
            }
        }
    }

    function handleInteractionEnd() {
        if (!isDragging) return;
        isDragging = false;
        initialMovement = true; // Reset for next drag
        knob.style.cursor = 'grab';
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('touchmove', handleTouchMove);
        document.removeEventListener('touchend', handleTouchEnd);
        document.removeEventListener('touchcancel', handleTouchEnd);
    }

    // --- Mouse Events ---
    function handleMouseDown(e) {
        const now = Date.now();
        if (now - lastInteractionTime < doubleClickThreshold) {
            // Double-click detected
            resetToDefault();
            e.preventDefault();
            lastInteractionTime = 0; // Reset time after double-click
            return;
        }
        lastInteractionTime = now;

        // Sync rotation from DOM before starting drag
        // This ensures external rotation changes (e.g., from recallDepthForDestination) are respected
        const currentTransform = knob.style.transform;
        console.log(`[mousedown] knob ID: ${knob.id}, transform: ${currentTransform}, internal rotation before: ${rotation}`);
        const match = currentTransform.match(/rotate\((-?\d+\.?\d*)deg\)/);
        if (match) {
            const domRotation = parseFloat(match[1]);
            console.log(`[mousedown] Parsed DOM rotation: ${domRotation}deg, internal rotation: ${rotation}deg, diff: ${Math.abs(domRotation - rotation)}`);
            if (Math.abs(domRotation - rotation) > 1) { // Only sync if significantly different
                console.log(`[mousedown] SYNCING: ${rotation}deg → ${domRotation}deg`);
                rotation = domRotation;
            } else {
                console.log(`[mousedown] No sync needed (diff < 1deg)`);
            }
        } else {
            console.log(`[mousedown] Could not parse transform!`);
        }
        console.log(`[mousedown] Final rotation: ${rotation}deg`);

        // Alt-click check removed, double-click handles reset
        isDragging = true;
        initialMovement = true; // Reset flag on new drag
        lastY = e.clientY;
        knob.style.cursor = 'grabbing';
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        e.preventDefault();
    }

    function handleMouseMove(e) {
        if (!isDragging) return;
        handleMove(e.clientY);
        e.preventDefault(); // Prevent text selection during drag
    }

    function handleMouseUp() {
        handleInteractionEnd();
    }

    // --- Touch Events ---
    function handleTouchStart(e) {
        const now = Date.now();
        if (now - lastInteractionTime < doubleClickThreshold) {
            // Double-tap detected
            resetToDefault();
            e.preventDefault();
            lastInteractionTime = 0; // Reset time after double-tap
            return;
        }
        lastInteractionTime = now;

        // Sync rotation from DOM before starting drag
        // This ensures external rotation changes (e.g., from recallDepthForDestination) are respected
        const currentTransform = knob.style.transform;
        const match = currentTransform.match(/rotate\((-?\d+\.?\d*)deg\)/);
        if (match) {
            const domRotation = parseFloat(match[1]);
            if (Math.abs(domRotation - rotation) > 1) { // Only log if significantly different
                console.log(`[controls.js touchstart] Synced rotation from DOM: ${domRotation}deg (was ${rotation}deg)`);
                rotation = domRotation;
            }
        }

        if (e.touches.length === 1) {
            isDragging = true;
            initialMovement = true;
            lastY = e.touches[0].clientY;

            // Use passive: false to allow preventDefault in touchmove
            document.addEventListener('touchmove', handleTouchMove, { passive: false });
            document.addEventListener('touchend', handleTouchEnd);
            document.addEventListener('touchcancel', handleTouchEnd);
        }
        // Prevent default to avoid scrolling/zooming on the knob itself
        e.preventDefault();
    }

    function handleTouchMove(e) {
        if (!isDragging || !e.touches[0]) return;
        handleMove(e.touches[0].clientY);
        // Critical: prevent default to stop page scrolling while turning knobs
        e.preventDefault();
    }

    function handleTouchEnd() {
        handleInteractionEnd();
    }

    // Attach listeners
    console.log(`[initializeKnob] Attaching mousedown to ${knob.id}:`, knob);
    console.log(`[initializeKnob] Element matches getElementById?`, knob === document.getElementById(knob.id));
    
    // Test if element receives clicks at all
    knob.addEventListener('click', (e) => {
        console.log(`[CLICK TEST] ${knob.id} was clicked!`, e);
    });
    
    knob.addEventListener('mousedown', handleMouseDown);
    // Use passive: false for touchstart to allow preventDefault
    knob.addEventListener('touchstart', handleTouchStart, { passive: false });

    // Return control object
    return {
        getValue: () => (rotation + 150) / 300,
        setValue: (value, triggerOnChange = false) => {
            const newRotation = (value * 300) - 150;
            rotation = Math.min(150, Math.max(-150, newRotation));
            knob.style.transform = `rotate(${rotation}deg)`;

            // Only trigger onChange if explicitly requested
            if (onChange && triggerOnChange) {
                onChange(value);
            }
        }
    };
}
