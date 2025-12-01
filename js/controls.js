/**
 * Initializes a knob element with drag-to-rotate functionality, touch support,
 * and double-click/tap to reset.
 * @param {HTMLElement} knob - The knob element to initialize.
 * @param {Function} onChange - Callback function triggered when the knob value changes. Receives the normalized value (0-1).
 * @param {Object} knobDefaults - An object containing default values for knobs, keyed by knob ID.
 * @returns {Object} Control helpers for the knob.
 */
export function initializeKnob(knob, onChange, knobDefaults) {
    const newKnob = knob.cloneNode(true);
    knob.parentNode.replaceChild(newKnob, knob);
    knob = newKnob;

    console.log(`[initializeKnob] After cloning ${newKnob.id}:`, newKnob);
    console.log(`[initializeKnob] Is same as getElementById?`, newKnob === document.getElementById(newKnob.id));

    const clamp01 = (val) => Math.max(0, Math.min(1, Number.isFinite(val) ? val : 0));
    let defaultValue = knobDefaults[knob.id] !== undefined ? knobDefaults[knob.id] : 0.5;
    let rotation = -150 + (defaultValue * 300);
    let isDragging = false;
    let lastY;
    let initialMovement = true;
    let lastInteractionTime = 0;
    const doubleClickThreshold = 350;

    knob.style.transform = `rotate(${rotation}deg)`;
    knob.style.cursor = 'grab';

    const applyRotationFromValue = (value) => {
        const clamped = clamp01(value);
        rotation = Math.min(150, Math.max(-150, -150 + clamped * 300));
        knob.style.transform = `rotate(${rotation}deg)`;
        return clamped;
    };

    const dispatchChange = (value) => {
        const clamped = clamp01(value);
        if (!onChange) {
            return clamped;
        }
        const result = onChange(clamped);
        if (typeof result === 'number' && Number.isFinite(result)) {
            return clamp01(result);
        }
        return clamped;
    };

    function resetToDefault() {
        const appliedValue = dispatchChange(defaultValue);
        applyRotationFromValue(appliedValue);
        console.log(`Knob ${knob.id} reset to default: ${appliedValue}`);
    }

    function handleMove(y) {
        const sensitivity = 1.0;
        const deltaY = (lastY - y) * sensitivity;

        if (initialMovement) {
            initialMovement = false;
            lastY = y;
            return;
        }

        lastY = y;
        const newRotation = Math.min(150, Math.max(-150, rotation + deltaY));
        if (newRotation === rotation) {
            return;
        }
        rotation = newRotation;
        knob.style.transform = `rotate(${rotation}deg)`;

        const normalizedValue = (rotation + 150) / 300;
        const appliedValue = dispatchChange(normalizedValue);
        if (Math.abs(appliedValue - normalizedValue) > 0.0005) {
            applyRotationFromValue(appliedValue);
        }
    }

    function handleInteractionEnd() {
        if (!isDragging) return;
        isDragging = false;
        initialMovement = true;
        knob.style.cursor = 'grab';
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('touchmove', handleTouchMove);
        document.removeEventListener('touchend', handleTouchEnd);
        document.removeEventListener('touchcancel', handleTouchEnd);
    }

    function handleMouseDown(e) {
        const now = Date.now();
        if (now - lastInteractionTime < doubleClickThreshold) {
            resetToDefault();
            e.preventDefault();
            lastInteractionTime = 0;
            return;
        }
        lastInteractionTime = now;

        const currentTransform = knob.style.transform;
        console.log(`[mousedown] knob ID: ${knob.id}, transform: ${currentTransform}, internal rotation before: ${rotation}`);
        const match = currentTransform.match(/rotate\((-?\d+\.?\d*)deg\)/);
        if (match) {
            const domRotation = parseFloat(match[1]);
            console.log(`[mousedown] Parsed DOM rotation: ${domRotation}deg, internal rotation: ${rotation}deg, diff: ${Math.abs(domRotation - rotation)}`);
            if (Math.abs(domRotation - rotation) > 1) {
                console.log(`[mousedown] SYNCING: ${rotation}deg → ${domRotation}deg`);
                rotation = domRotation;
            } else {
                console.log(`[mousedown] No sync needed (diff < 1deg)`);
            }
        } else {
            console.log(`[mousedown] Could not parse transform!`);
        }
        console.log(`[mousedown] Final rotation: ${rotation}deg`);

        isDragging = true;
        initialMovement = true;
        lastY = e.clientY;
        knob.style.cursor = 'grabbing';
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        e.preventDefault();
    }

    function handleMouseMove(e) {
        if (!isDragging) return;
        handleMove(e.clientY);
        e.preventDefault();
    }

    function handleMouseUp() {
        handleInteractionEnd();
    }

    function handleTouchStart(e) {
        const now = Date.now();
        if (now - lastInteractionTime < doubleClickThreshold) {
            resetToDefault();
            e.preventDefault();
            lastInteractionTime = 0;
            return;
        }
        lastInteractionTime = now;

        const currentTransform = knob.style.transform;
        const match = currentTransform.match(/rotate\((-?\d+\.?\d*)deg\)/);
        if (match) {
            const domRotation = parseFloat(match[1]);
            if (Math.abs(domRotation - rotation) > 1) {
                console.log(`[controls.js touchstart] Synced rotation from DOM: ${domRotation}deg (was ${rotation}deg)`);
                rotation = domRotation;
            }
        }

        if (e.touches.length === 1) {
            isDragging = true;
            initialMovement = true;
            lastY = e.touches[0].clientY;
            document.addEventListener('touchmove', handleTouchMove, { passive: false });
            document.addEventListener('touchend', handleTouchEnd);
            document.addEventListener('touchcancel', handleTouchEnd);
        }
        e.preventDefault();
    }

    function handleTouchMove(e) {
        if (!isDragging || !e.touches[0]) return;
        handleMove(e.touches[0].clientY);
        e.preventDefault();
    }

    function handleTouchEnd() {
        handleInteractionEnd();
    }

    console.log(`[initializeKnob] Attaching mousedown to ${knob.id}:`, knob);
    console.log(`[initializeKnob] Element matches getElementById?`, knob === document.getElementById(knob.id));

    knob.addEventListener('click', (e) => {
        console.log(`[CLICK TEST] ${knob.id} was clicked!`, e);
    });
    knob.addEventListener('mousedown', handleMouseDown);
    knob.addEventListener('touchstart', handleTouchStart, { passive: false });

    return {
        getValue: () => (rotation + 150) / 300,
        setValue: (value, triggerOnChange = false) => {
            const baseValue = applyRotationFromValue(value);
            if (triggerOnChange) {
                const appliedValue = dispatchChange(baseValue);
                if (Math.abs(appliedValue - baseValue) > 0.0005) {
                    applyRotationFromValue(appliedValue);
                }
            }
        },
        setDefaultValue: (value) => {
            defaultValue = clamp01(value);
        },
        getDefaultValue: () => defaultValue
    };
}
