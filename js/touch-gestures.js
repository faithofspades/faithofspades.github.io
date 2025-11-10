/**
 * Touch gesture handler for mobile devices
 * Enables pinch-to-zoom everywhere except on the keyboard
 */

let initialPinchDistance = null;
let initialScale = 1;
let currentScale = 1;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2;

// Track if touch started on keyboard
let touchStartedOnKeyboard = false;

export function initTouchGestures() {
    const container = document.querySelector('.container');
    const keyboard = document.getElementById('keyboard');
    
    if (!container) return;

    // Prevent default pinch zoom on the whole document
    document.addEventListener('gesturestart', (e) => {
        e.preventDefault();
    });

    document.addEventListener('gesturechange', (e) => {
        e.preventDefault();
    });

    document.addEventListener('gestureend', (e) => {
        e.preventDefault();
    });

    // Handle touch events for custom pinch-to-zoom
    document.addEventListener('touchstart', (e) => {
        // Check if touch started on keyboard
        if (keyboard && e.target.closest('#keyboard')) {
            touchStartedOnKeyboard = true;
            return;
        }
        
        touchStartedOnKeyboard = false;

        if (e.touches.length === 2) {
            e.preventDefault();
            
            const touch1 = e.touches[0];
            const touch2 = e.touches[1];
            
            initialPinchDistance = Math.hypot(
                touch2.clientX - touch1.clientX,
                touch2.clientY - touch1.clientY
            );
            
            initialScale = currentScale;
        }
    }, { passive: false });

    document.addEventListener('touchmove', (e) => {
        // Don't interfere with keyboard touches
        if (touchStartedOnKeyboard) {
            return;
        }

        if (e.touches.length === 2) {
            e.preventDefault();
            
            const touch1 = e.touches[0];
            const touch2 = e.touches[1];
            
            const currentDistance = Math.hypot(
                touch2.clientX - touch1.clientX,
                touch2.clientY - touch1.clientY
            );
            
            if (initialPinchDistance) {
                const scaleChange = currentDistance / initialPinchDistance;
                currentScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, initialScale * scaleChange));
                
                // Apply the scale
                container.style.transform = `scale(${currentScale})`;
            }
        }
    }, { passive: false });

    document.addEventListener('touchend', (e) => {
        if (e.touches.length < 2) {
            initialPinchDistance = null;
            touchStartedOnKeyboard = false;
        }
    });

    // Improve scrolling on mobile
    const synthPanel = document.querySelector('.synth-panel');
    if (synthPanel) {
        synthPanel.style.touchAction = 'pan-x pan-y';
    }

    // Make sure modules row is scrollable
    const modulesRow = document.querySelector('.modules-row');
    if (modulesRow) {
        modulesRow.style.touchAction = 'pan-x pan-y';
        modulesRow.style.overflowX = 'auto';
        modulesRow.style.webkitOverflowScrolling = 'touch'; // Smooth scrolling on iOS
    }
}
