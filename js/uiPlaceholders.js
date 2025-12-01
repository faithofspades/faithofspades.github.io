
// Helper (if not globally available)
const D = x => document.getElementById(x);

export function initializeUiPlaceholders() {
    console.log("Initializing UI Placeholders...");

    // -------------------------------
    //  Button Switches (dummy toggle)
    // -------------------------------
    document.querySelectorAll('.frame-for-button-switches > div').forEach((btn) => {
        // Clone to remove old listeners
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);

        newBtn.addEventListener('click', () => {
            if (newBtn.classList.contains('active')) {
                newBtn.classList.remove('active');
                newBtn.style.boxShadow = '';
            } else {
                newBtn.classList.add('active');
                newBtn.style.boxShadow = 'inset 0 0 5px rgba(0,0,0,0.5)';
            }
            console.log(`Button Switch ${newBtn.id || 'unknown'} toggled: ${newBtn.classList.contains('active')}`);
        });
    });

    // ---------------------------------------------------------
    //  Five-Step Selector Slider (snap to 5 notches)
    // ---------------------------------------------------------
    const fiveStepThumb = document.querySelector('.five-Step-Selector-Slider-Thumb');
    if (fiveStepThumb) {
        let isDragging5Step = false;
        let startX = 0;
        let originalLeft = 0;
        const minLeft = 0;
        const maxLeft = 80;
        const steps = 4;
        const stepSize = (maxLeft - minLeft) / steps;

        fiveStepThumb.addEventListener('mousedown', (e) => {
            isDragging5Step = true;
            startX = e.clientX;
            originalLeft = parseInt(window.getComputedStyle(fiveStepThumb).left, 10) || 0;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging5Step) return;
            const delta = e.clientX - startX;
            let newLeft = originalLeft + delta;
            if (newLeft < minLeft) newLeft = minLeft;
            if (newLeft > maxLeft) newLeft = maxLeft;
            const stepIndex = Math.round(newLeft / stepSize);
            const snappedLeft = stepIndex * stepSize;
            fiveStepThumb.style.left = snappedLeft + 'px';
            const currentValue = stepIndex;
            // console.log('Five-step slider value:', currentValue);
        });

        document.addEventListener('mouseup', () => {
            isDragging5Step = false;
        });
        // Add touch support if needed later
    }

    // ---------------------------------------
    //  Rate Slider (dummy vertical drag)
    // ---------------------------------------
    const rateThumb = document.querySelector('.Rate-Slider-Thumb');
    const rateTrack = document.querySelector('.Rate-Slider-Track');
    if (rateThumb && rateTrack) {
        let isDraggingRate = false;
        let startY = 0;
        let originalTop = 0;
        const minTop = 0;
        const maxTop = 80;

        rateThumb.addEventListener('mousedown', (e) => {
            isDraggingRate = true;
            startY = e.clientY;
            originalTop = parseInt(window.getComputedStyle(rateThumb).top, 10) || 0;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDraggingRate) return;
            const delta = e.clientY - startY;
            let newTop = originalTop + delta;
            if (newTop < minTop) newTop = minTop;
            if (newTop > maxTop) newTop = maxTop;
            rateThumb.style.top = newTop + 'px';
            const normalizedRateValue = (newTop - minTop) / (maxTop - minTop);
            // console.log('LFO Rate value:', normalizedRateValue.toFixed(2));
        });

        document.addEventListener('mouseup', () => {
            isDraggingRate = false;
        });
         // Add touch support if needed later
    }

    // ----------------------------------------
    //  Delay Slider (dummy vertical drag)
    // ----------------------------------------
    const delayThumb = document.querySelector('.Delay-Slider-Thumb');
    const delayTrack = document.querySelector('.Delay-Slider-Track');
    if (delayThumb && delayTrack) {
        let isDraggingDelay = false;
        let startY = 0;
        let originalTop = 0;
        const minTop = 0;
        const maxTop = 80;

        delayThumb.addEventListener('mousedown', (e) => {
            isDraggingDelay = true;
            startY = e.clientY;
            originalTop = parseInt(window.getComputedStyle(delayThumb).top, 10) || 0;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDraggingDelay) return;
            const delta = e.clientY - startY;
            let newTop = originalTop + delta;
            if (newTop < minTop) newTop = minTop;
            if (newTop > maxTop) newTop = maxTop;
            delayThumb.style.top = newTop + 'px';
            const normalizedDelayValue = (newTop - minTop) / (maxTop - minTop);
            // console.log('LFO Delay value:', normalizedDelayValue.toFixed(2));
        });

        document.addEventListener('mouseup', () => {
            isDraggingDelay = false;
        });
         // Add touch support if needed later
    }
document.addEventListener('DOMContentLoaded', () => {
const fiveStep = document.querySelector('.five-step-selector-range');
if (fiveStep) {
fiveStep.addEventListener('input', () => {
console.log('Five-step value:', fiveStep.value);
});
}

const rateSlider = document.querySelector('.rate-slider-range');
if (rateSlider) {
rateSlider.addEventListener('input', () => {
console.log('LFO Rate:', rateSlider.value);
});
}

const delaySlider = document.querySelector('.delay-slider-range');
if (delaySlider) {
delaySlider.addEventListener('input', () => {
console.log('LFO Delay:', delaySlider.value);
});
}
});
    // ----------------------------------------
    //  Dummy Range Slider Listeners
    // ----------------------------------------
    const fiveStepRange = document.querySelector('.five-step-selector-range');
    if (fiveStepRange) {
        fiveStepRange.addEventListener('input', () => {
            console.log('Five-step value:', fiveStepRange.value);
        });
    }
    const rateSliderRange = document.querySelector('.rate-slider-range');
    if (rateSliderRange) {
        rateSliderRange.addEventListener('input', () => {
            console.log('LFO Rate:', rateSliderRange.value);
        });
    }
    const delaySliderRange = document.querySelector('.delay-slider-range');
    if (delaySliderRange) {
        delaySliderRange.addEventListener('input', () => {
            console.log('LFO Delay:', delaySliderRange.value);
        });
    }

    // ----------------------------------------
    //  Matrix Buttons
    // ----------------------------------------
    const matrixButtons = document.querySelectorAll('.matrix-buttons-container .matrix-button');
    matrixButtons.forEach((button, index) => {
        // Clone to remove old listeners
        const newButton = button.cloneNode(true);
        button.parentNode.replaceChild(newButton, button);

        newButton.addEventListener('click', function() {
            // Don't return early - let both handlers run
            matrixButtons.forEach(btn => {
                // Access the potentially replaced node via querySelectorAll again inside handler
                document.querySelectorAll('.matrix-buttons-container .matrix-button')
                        .forEach(b => b.classList.remove('active'));
            });
            newButton.classList.add('active');
            console.log(`Matrix button ${index + 1} activated`);
            
            // Call the modulation routing handler
            const source = newButton.textContent.trim();
            if (typeof handleSourceButtonClick === 'function') {
                handleSourceButtonClick(source);
            }
        });
    });
    // Don't auto-activate the first button - let user choose
    // if (matrixButtons.length > 0) {
    //      // Access the potentially replaced node via querySelectorAll again
    //     document.querySelectorAll('.matrix-buttons-container .matrix-button')[0].classList.add('active');
    // }

    // ----------------------------------------
    //  Looper Buttons & Knob
    // ----------------------------------------
    const looperToggleButtons = document.querySelectorAll('.record-button'); // Assuming these are looper buttons
    looperToggleButtons.forEach(button => {
         // Clone to remove old listeners
        const newButton = button.cloneNode(true);
        button.parentNode.replaceChild(newButton, button);
        newButton.addEventListener('click', function() {
            this.classList.toggle('active');
            console.log(`Looper button ${this.id || 'unknown'} toggled: ${this.classList.contains('active')}`);
        });
    });

    const layersKnob = document.getElementById('looper-layers-knob');
    if (layersKnob) {
        let currentPosition = 0; // 0-7
        let isDragging = false;
        let startY;
        let totalMovement = 0;
        const positions = [-150, -107.14, -64.29, -21.43, 21.43, 64.29, 107.14, 150];
        const moveThreshold = 20;
        let lastTap = 0;

        function updateKnobPosition() {
            layersKnob.style.transform = `rotate(${positions[currentPosition]}deg)`;
        }
        updateKnobPosition(); // Initial position

        layersKnob.addEventListener('mousedown', function(e) {
            isDragging = true; startY = e.clientY; totalMovement = 0; e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!isDragging) return;
            const deltaY = startY - e.clientY; totalMovement += deltaY; startY = e.clientY;
            if (totalMovement >= moveThreshold) {
                if (currentPosition < 7) { currentPosition++; updateKnobPosition(); console.log(`Layers position: ${currentPosition + 1}/8`); }
                totalMovement = 0;
            } else if (totalMovement <= -moveThreshold) {
                if (currentPosition > 0) { currentPosition--; updateKnobPosition(); console.log(`Layers position: ${currentPosition + 1}/8`); }
                totalMovement = 0;
            }
        });
        document.addEventListener('mouseup', function() { isDragging = false; totalMovement = 0; });
        layersKnob.addEventListener('touchstart', function(e) {
            if (e.touches.length !== 1) return; isDragging = true; startY = e.touches[0].clientY; totalMovement = 0; e.preventDefault();
        }, { passive: false });
        document.addEventListener('touchmove', function(e) {
            if (!isDragging || e.touches.length !== 1) return;
            const deltaY = startY - e.touches[0].clientY; totalMovement += deltaY; startY = e.touches[0].clientY;
            if (totalMovement >= moveThreshold) {
                if (currentPosition < 7) { currentPosition++; updateKnobPosition(); console.log(`Layers position: ${currentPosition + 1}/8`); }
                totalMovement = 0;
            } else if (totalMovement <= -moveThreshold) {
                if (currentPosition > 0) { currentPosition--; updateKnobPosition(); console.log(`Layers position: ${currentPosition + 1}/8`); }
                totalMovement = 0;
            }
            e.preventDefault();
        }, { passive: false });
        document.addEventListener('touchend', function() { isDragging = false; totalMovement = 0; });
        layersKnob.addEventListener('dblclick', function() { currentPosition = 0; updateKnobPosition(); console.log("Layers reset to position 1/8"); });
        layersKnob.addEventListener('touchend', function(e) {
            const now = Date.now(); if (now - lastTap < 300) { currentPosition = 0; updateKnobPosition(); console.log("Layers reset to position 1/8"); } lastTap = now;
        });
    }

    // ----------------------------------------
    //  Chorus Button
    // ----------------------------------------
    const chorusButton = document.getElementById('chorus-button');
    if (chorusButton) {
        let chorusState = 0; // 0: off, 1: light, 2: heavy
         // Clone to remove old listeners
        const newButton = chorusButton.cloneNode(true);
        chorusButton.parentNode.replaceChild(newButton, chorusButton);

        newButton.addEventListener('click', function() {
            chorusState = (chorusState + 1) % 3;
            newButton.classList.remove('state-1', 'state-2');
            if (chorusState === 1) { newButton.classList.add('state-1'); console.log('Chorus: Light mode activated'); }
            else if (chorusState === 2) { newButton.classList.add('state-2'); console.log('Chorus: Heavy mode activated'); }
            else { console.log('Chorus: Off'); }
        });
    }

    // ----------------------------------------
    //  Delay Module Switches
    // ----------------------------------------
    const delayModuleSwitches = document.querySelectorAll('.delay-module .vertical-switch');
    delayModuleSwitches.forEach(switchEl => {
         // Clone to remove old listeners
        const newSwitch = switchEl.cloneNode(true);
        switchEl.parentNode.replaceChild(newSwitch, switchEl);
        newSwitch.addEventListener('click', function() {
            this.classList.toggle('active');
            console.log(`${this.id} switched: ${this.classList.contains('active') ? 'ON' : 'OFF'}`);
        });
    });

    // ----------------------------------------
    //  Horizontal Switches
    // ----------------------------------------
    const horizontalSwitches = document.querySelectorAll('.horizontal-switch');
    horizontalSwitches.forEach(switchEl => {
         // Clone to remove old listeners
        const newSwitch = switchEl.cloneNode(true);
        switchEl.parentNode.replaceChild(newSwitch, switchEl);
        newSwitch.addEventListener('click', function() {
            this.classList.toggle('active');
            console.log(`${this.id} toggled: ${this.classList.contains('active') ? 'ON' : 'OFF'}`);
        });
    });

    // ----------------------------------------
    //  Mod Shape Knob (Discrete)
    const shapeKnob = document.getElementById('mod-shape-knob');
    if (shapeKnob) {
        const SHAPE_POSITIONS = [0, 72, 144, 216, 288];
        const SHAPE_NAMES = ['Triangle', 'Square', 'Random', 'Sine', 'Sawtooth'];
        const positionChangeThreshold = 15;
        let currentPosition = 0;
        let isDragging = false;
        let lastY = 0;
        let accumulatedDelta = 0;

        function updateShapeVisual() {
            shapeKnob.style.transform = `rotate(${SHAPE_POSITIONS[currentPosition]}deg)`;
        }

        function showShapeTooltip() {
            let tooltip = document.getElementById('mod-shape-knob-tooltip');
            if (!tooltip) {
                tooltip = document.createElement('div');
                tooltip.id = 'mod-shape-knob-tooltip';
                tooltip.className = 'tooltip';
                document.body.appendChild(tooltip);
            }
            const knobRect = shapeKnob.getBoundingClientRect();
            tooltip.style.left = `${knobRect.left + knobRect.width + 5}px`;
            tooltip.style.top = `${knobRect.top + (knobRect.height / 2) - 10}px`;
            tooltip.textContent = `LFO: ${SHAPE_NAMES[currentPosition]}`;
            tooltip.style.opacity = '1';
            setTimeout(() => { tooltip.style.opacity = '0'; }, 1500);
        }

        function applyShapePosition(options = {}) {
            updateShapeVisual();
            if (!options.suppressShapeUpdate) {
                window.lfoShape = currentPosition;
            }
            if (!options.suppressRestart && typeof restartLFO === 'function') {
                restartLFO();
            }
            if (!options.suppressTooltip) {
                showShapeTooltip();
            }
            if (!options.suppressLog) {
                console.log(`LFO Shape changed to: ${SHAPE_NAMES[currentPosition]}`);
            }
        }

        function setShapePosition(position, options = {}) {
            const maxIndex = SHAPE_POSITIONS.length;
            const wrapped = ((Math.round(position) % maxIndex) + maxIndex) % maxIndex;
            if (!options.force && wrapped === currentPosition) {
                if (options.syncEvenIfSame) {
                    applyShapePosition(options);
                }
                return currentPosition;
            }
            currentPosition = wrapped;
            applyShapePosition(options);
            return currentPosition;
        }

        function stepShape(direction) {
            setShapePosition(currentPosition + direction);
        }

        function beginDrag(clientY) {
            isDragging = true;
            lastY = clientY;
            accumulatedDelta = 0;
            shapeKnob.style.cursor = 'grabbing';
        }

        function updateDrag(clientY) {
            const deltaY = lastY - clientY;
            lastY = clientY;
            if (Math.abs(deltaY) >= 1) {
                accumulatedDelta += deltaY;
                if (Math.abs(accumulatedDelta) >= positionChangeThreshold) {
                    const direction = accumulatedDelta > 0 ? 1 : -1;
                    stepShape(direction);
                    accumulatedDelta = 0;
                }
            }
        }

        function endDrag() {
            isDragging = false;
            accumulatedDelta = 0;
            shapeKnob.style.cursor = 'pointer';
        }

        shapeKnob.addEventListener('mousedown', (e) => {
            beginDrag(e.clientY);
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            updateDrag(e.clientY);
            e.preventDefault();
        });
        document.addEventListener('mouseup', endDrag);

        shapeKnob.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            beginDrag(e.touches[0].clientY);
            e.preventDefault();
        }, { passive: false });
        document.addEventListener('touchmove', (e) => {
            if (!isDragging || e.touches.length !== 1) return;
            updateDrag(e.touches[0].clientY);
            e.preventDefault();
        }, { passive: false });
        document.addEventListener('touchend', endDrag);
        document.addEventListener('touchcancel', endDrag);

        const initialShape = typeof window.pendingLfoShapeIndex === 'number'
            ? window.pendingLfoShapeIndex
            : (typeof window.lfoShape === 'number' ? window.lfoShape : 0);
        setShapePosition(initialShape, {
            suppressRestart: true,
            suppressTooltip: true,
            suppressLog: true,
            force: true
        });
        window.pendingLfoShapeIndex = null;

        window.__setLfoShapeKnobPosition = (position, options = {}) => setShapePosition(position, {
            suppressRestart: options.suppressRestart !== false,
            suppressTooltip: options.suppressTooltip !== false,
            suppressLog: options.suppressLog !== false,
            suppressShapeUpdate: options.suppressShapeUpdate === true,
            force: options.force === true,
            syncEvenIfSame: options.syncEvenIfSame === true
        });
        window.__getLfoShapeKnobPosition = () => currentPosition;
    }

    // ----------------------------------------
    //  Oscillator FM Source Switches
    // ----------------------------------------
    // const oscSwitches = document.querySelectorAll('.osc-vertical-switch');
    // oscSwitches.forEach((switchEl, index) => {
    //     if (!switchEl.id) { switchEl.id = `fm-source-switch-${index + 1}`; }
    //     const newSwitch = switchEl.cloneNode(true); switchEl.parentNode.replaceChild(newSwitch, switchEl); switchEl = newSwitch;
    //     let isActive = false;
    //     switchEl.addEventListener('click', function() {
    //         isActive = !isActive; this.classList.toggle('active', isActive);
    //         const switchNum = this.id.includes('2') ? 2 : 1; console.log(`Oscillator ${switchNum} FM Source changed to:`, isActive ? 'Osc 2' : 'Noise');
    //     });
    //     switchEl.addEventListener('touchstart', function(e) { e.preventDefault(); e.stopPropagation(); }, { passive: false });
    //     switchEl.addEventListener('touchend', function(e) { this.click(); e.preventDefault(); e.stopPropagation(); }, { passive: false });
    //     switchEl.style.cursor = 'pointer';
    // });

     // ----------------------------------------
    //  Mod Select Button
    // ----------------------------------------
    const modSelectButton = document.getElementById('mod-select-button');
    if (modSelectButton) {
        const newButton = modSelectButton.cloneNode(true); modSelectButton.parentNode.replaceChild(newButton, modSelectButton);
        newButton.addEventListener('click', function() {
            this.classList.toggle('active'); const isActive = this.classList.contains('active');
            console.log('Modulation Select button:', isActive ? 'ACTIVE' : 'INACTIVE');
            const destContainer = document.querySelector('.mod-destination-container');
            if (destContainer) { destContainer.classList.toggle('selection-mode', isActive); }
        });
        newButton.addEventListener('touchstart', function(e) { e.preventDefault(); this.click(); }, { passive: false });
    }

    console.log("UI Placeholders Initialized.");
}