// filepath: d:\Dropbox\Github Computer Programming Class\faithofspades.github.io\js\modCanvas.js
// --- Module State ---
let canvas = null;
let ctx = null;
let points = [];
let selectedPointIndex = -1;
let isDraggingPoint = false;
let isDraggingCurve = false;
let activeCurveIndex = -1;
let lastTapTime = 0;

// Global drag state
let isDraggingOutside = false;
let dragType = null; // 'point' or 'curve'
let dragPointIndex = -1;

// --- Helper Functions ---

function drawWaveform() {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (points.length < 2) return;

    drawGrid();

    ctx.strokeStyle = '#f2eed3';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    for (let i = 0; i < points.length - 1; i++) {
        const startPoint = points[i];
        const endPoint = points[i + 1];

        if (startPoint.noCurve) {
            ctx.lineTo(endPoint.x, endPoint.y);
        } else {
            if (!startPoint.curveX || !startPoint.curveY) {
                const midX = (startPoint.x + endPoint.x) / 2;
                const midY = (startPoint.y + endPoint.y) / 2;
                startPoint.curveX = midX;
                startPoint.curveY = midY;
            }

            const clampedSegment = ensureCurveInsideBounds(
                startPoint.x, startPoint.y,
                startPoint.curveX, startPoint.curveY,
                endPoint.x, endPoint.y
            );

            ctx.quadraticCurveTo(
                clampedSegment.cpX, clampedSegment.cpY,
                endPoint.x, endPoint.y
            );
        }
    }
    ctx.stroke();

    points.forEach((point, index) => {
        ctx.fillStyle = index === selectedPointIndex ? '#ffcc00' : '#f2eed3';
        ctx.beginPath();
        ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
        ctx.fill();
    });

    for (let i = 0; i < points.length - 1; i++) {
        const startPoint = points[i];
        if (startPoint.noCurve) continue;
        const endPoint = points[i + 1];
        const isActive = i === activeCurveIndex;

        ctx.fillStyle = isActive ? '#ffcc00' : '#f2eed3';
        ctx.beginPath();
        ctx.arc(startPoint.curveX, startPoint.curveY, 3, 0, Math.PI * 2);
        ctx.fill();

        if (isActive) {
            ctx.strokeStyle = 'rgba(242, 238, 211, 0.4)';
            ctx.setLineDash([2, 2]);
            ctx.beginPath();
            ctx.moveTo(startPoint.x, startPoint.y);
            ctx.lineTo(startPoint.curveX, startPoint.curveY);
            ctx.lineTo(endPoint.x, endPoint.y);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }
    drawInfoText();
}

function drawGrid() {
    if (!ctx || !canvas) return;
    const gridSize = 10;
    ctx.strokeStyle = 'rgba(242, 238, 211, 0.1)';
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= canvas.width; x += gridSize) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = 0; y <= canvas.height; y += gridSize) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
}

function ensureCurveInsideBounds(x1, y1, cpX, cpY, x2, y2) {
    if (!canvas) return { cpX, cpY };
    const padding = 1;
    const minY = padding;
    const maxY = canvas.height - padding;
    const steps = 10;
    let maxOutOfBounds = 0;
    let direction = 0;

    for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const y = Math.pow(1 - t, 2) * y1 + 2 * (1 - t) * t * cpY + Math.pow(t, 2) * y2;
        if (y < minY && (minY - y) > maxOutOfBounds) { maxOutOfBounds = minY - y; direction = 1; }
        else if (y > maxY && (y - maxY) > maxOutOfBounds) { maxOutOfBounds = y - maxY; direction = -1; }
    }

    if (maxOutOfBounds > 0) {
        const correctionFactor = 2;
        cpY += direction * maxOutOfBounds * correctionFactor;
        let maxViolation = 0;
        for (let i = 1; i < steps; i++) {
            const t = i / steps;
            const y = Math.pow(1 - t, 2) * y1 + 2 * (1 - t) * t * cpY + Math.pow(t, 2) * y2;
            if (y < minY) maxViolation = Math.max(maxViolation, minY - y);
            else if (y > maxY) maxViolation = Math.max(maxViolation, y - maxY);
        }
        if (maxViolation > 0.5) { cpY += direction * maxViolation * correctionFactor; }
    }
    return { cpX, cpY };
}

function constrainControlPoint(startPoint, endPoint, curveX, curveY) {
    const minX = Math.min(startPoint.x, endPoint.x);
    const maxX = Math.max(startPoint.x, endPoint.x);
    const criticalX = startPoint.x - (endPoint.x - startPoint.x) / 2;
    const effectiveMinX = Math.max(minX, criticalX);

    if (startPoint.x === 0) {
        const constrainedX = Math.max(effectiveMinX, Math.min(maxX, curveX));
        return { x: constrainedX <= 0 ? 0.001 : constrainedX, y: curveY };
    }
    const constrainedX = Math.max(effectiveMinX, Math.min(maxX, curveX));
    return { x: constrainedX, y: curveY };
}

function constrainPointY(y) {
    if (!canvas) return y;
    const padding = 1;
    return Math.max(padding, Math.min(canvas.height - padding, y));
}

function updateControlPointsForSegment(segmentIndex) {
    if (segmentIndex < 0 || segmentIndex >= points.length - 1) return;
    const startPoint = points[segmentIndex];
    const endPoint = points[segmentIndex + 1];
    if (startPoint.noCurve) return;

    if (startPoint.curveX === undefined || startPoint.curveY === undefined) {
        startPoint.curveX = (startPoint.x + endPoint.x) / 2;
        startPoint.curveY = (startPoint.y + endPoint.y) / 2;
        return;
    }

    const originalY = startPoint.curveY;
    const minX = Math.min(startPoint.x, endPoint.x);
    const maxX = Math.max(startPoint.x, endPoint.x);

    if (startPoint.curveX < minX || startPoint.curveX > maxX) {
        const segmentWidth = endPoint.x - startPoint.x;
        if (segmentWidth !== 0) {
            const xRatio = segmentWidth > 0 ? (startPoint.curveX - startPoint.x) / segmentWidth : 0.5;
            const clampedRatio = Math.max(0, Math.min(1, xRatio));
            startPoint.curveX = startPoint.x + (segmentWidth * clampedRatio);
        } else {
            startPoint.curveX = startPoint.x;
        }
    }
    startPoint.curveX = Math.max(minX, Math.min(maxX, startPoint.curveX));
    startPoint.curveY = originalY;

    const clampedCurve = ensureCurveInsideBounds(
        startPoint.x, startPoint.y, startPoint.curveX, startPoint.curveY, endPoint.x, endPoint.y
    );
    startPoint.curveY = clampedCurve.cpY;
}

function initializeDefaultWave() {
    if (!canvas) return;
    points.length = 0;
    const width = canvas.width;
    const height = canvas.height;
    const center = height / 2;
    const amplitude = height / 3;

    for (let i = 0; i < 5; i++) {
        const x = (i / 4) * width;
        const y = center - Math.sin((i / 4) * Math.PI * 2) * amplitude;
        if (i > 0) {
            const prevX = ((i - 1) / 4) * width;
            const midX = (prevX + x) / 2;
            const curveY = center - Math.sin((((i - 0.5) / 4)) * Math.PI * 2) * amplitude;
            points[i - 1].curveX = midX;
            points[i - 1].curveY = curveY;
            points[i - 1].noCurve = false;
        }
        points.push({ x, y, noCurve: false });
    }
}

function findClosestPoint(x, y) {
    let closestIndex = -1;
    let minDistance = 10;
    points.forEach((point, index) => {
        const distance = Math.sqrt(Math.pow(point.x - x, 2) + Math.pow(point.y - y, 2));
        if (distance < minDistance) { minDistance = distance; closestIndex = index; }
    });
    return closestIndex;
}

function findClosestCurvePoint(x, y) {
    let closestIndex = -1;
    let minDistance = 10;
    for (let i = 0; i < points.length - 1; i++) {
        const startPoint = points[i];
        if (startPoint.noCurve || startPoint.curveX === undefined || startPoint.curveY === undefined) continue;
        const distance = Math.sqrt(Math.pow(startPoint.curveX - x, 2) + Math.pow(startPoint.curveY - y, 2));
        if (distance < minDistance) { minDistance = distance; closestIndex = i; }
    }
    return closestIndex;
}

function findClosestLineSegment(x, y) {
    let closestIndex = -1;
    let minDistance = 10;
    for (let i = 0; i < points.length - 1; i++) {
        const startPoint = points[i];
        const endPoint = points[i + 1];
        const A = x - startPoint.x, B = y - startPoint.y, C = endPoint.x - startPoint.x, D = endPoint.y - startPoint.y;
        const dot = A * C + B * D, lenSq = C * C + D * D;
        let param = lenSq !== 0 ? dot / lenSq : -1;
        let xx, yy;
        if (param < 0) { xx = startPoint.x; yy = startPoint.y; }
        else if (param > 1) { xx = endPoint.x; yy = endPoint.y; }
        else { xx = startPoint.x + param * C; yy = startPoint.y + param * D; }
        const distance = Math.sqrt(Math.pow(x - xx, 2) + Math.pow(y - yy, 2));
        if (distance < minDistance) { minDistance = distance; closestIndex = i; }
    }
    return closestIndex;
}

function findInsertPosition(x) {
    for (let i = 0; i < points.length; i++) { if (x < points[i].x) return i; }
    return points.length;
}

function addPoint(x, y) {
    const insertIndex = findInsertPosition(x);
    const minDistance = 0.1;
    if ((insertIndex > 0 && x - points[insertIndex - 1].x < minDistance) ||
        (insertIndex < points.length && points[insertIndex].x - x < minDistance)) {
        return -1;
    }
    y = constrainPointY(y);
    points.splice(insertIndex, 0, { x, y, noCurve: false });
    if (insertIndex > 0) {
        const prevPoint = points[insertIndex - 1];
        prevPoint.curveX = (prevPoint.x + x) / 2;
        prevPoint.curveY = (prevPoint.y + y) / 2;
    }
    if (insertIndex < points.length - 1) {
        const nextPoint = points[insertIndex + 1];
        points[insertIndex].curveX = (x + nextPoint.x) / 2;
        points[insertIndex].curveY = (y + nextPoint.y) / 2;
    }
    return insertIndex;
}

function toggleCurveOnSegment(segmentIndex) {
    if (segmentIndex < 0 || segmentIndex >= points.length - 1) return;
    const startPoint = points[segmentIndex];
    startPoint.noCurve = !startPoint.noCurve;
    if (!startPoint.noCurve) {
        const endPoint = points[segmentIndex + 1];
        startPoint.curveX = (startPoint.x + endPoint.x) / 2;
        startPoint.curveY = (startPoint.y + endPoint.y) / 2;
    }
}

function deletePoint(index) {
    if (index <= 0 || index >= points.length - 1 || points.length <= 2) return false;
    points.splice(index, 1);
    selectedPointIndex = -1;
    return true;
}

function handlePointDrag(x, y) {
    if (selectedPointIndex < 0 || !canvas) return;
    const oldX = points[selectedPointIndex].x;
    const oldY = points[selectedPointIndex].y;
    points[selectedPointIndex].y = constrainPointY(y);
    if (selectedPointIndex > 0 && selectedPointIndex < points.length - 1) {
        const minX = points[selectedPointIndex - 1].x + 0.1;
        const maxX = points[selectedPointIndex + 1].x - 0.1;
        points[selectedPointIndex].x = Math.max(minX, Math.min(maxX, x));
    } else if (selectedPointIndex === 0) {
        points[selectedPointIndex].x = 0;
    } else if (selectedPointIndex === points.length - 1) {
        points[selectedPointIndex].x = canvas.width;
    }
    if (oldX !== points[selectedPointIndex].x || oldY !== points[selectedPointIndex].y) {
        if (selectedPointIndex > 0) updateControlPointsForSegment(selectedPointIndex - 1);
        if (selectedPointIndex < points.length - 1) updateControlPointsForSegment(selectedPointIndex);
    }
}

function handleCurveDrag(x, y) {
    if (activeCurveIndex < 0) return;
    const startPoint = points[activeCurveIndex];
    const endPoint = points[activeCurveIndex + 1];
    const constrained = constrainControlPoint(startPoint, endPoint, x, y);
    startPoint.curveX = constrained.x;
    startPoint.curveY = constrained.y;
    const clampedCurve = ensureCurveInsideBounds(
        startPoint.x, startPoint.y, startPoint.curveX, startPoint.curveY, endPoint.x, endPoint.y
    );
    startPoint.curveY = clampedCurve.cpY;
}

function drawInfoText() {
    if (!ctx || !canvas) return;
    ctx.fillStyle = "rgba(242, 238, 211, 0.6)";
    ctx.font = "8px Arial";
    ctx.textAlign = "center";
    ctx.fillText("", canvas.width / 2, canvas.height - 5);
}

function handleDoubleInteraction(x, y) {
    if (deletePoint(findClosestPoint(x, y))) { drawWaveform(); return true; }
    const curveIndex = findClosestCurvePoint(x, y);
    if (curveIndex >= 0) { points[curveIndex].noCurve = true; drawWaveform(); return true; }
    const lineIndex = findClosestLineSegment(x, y);
    if (lineIndex >= 0) { toggleCurveOnSegment(lineIndex); drawWaveform(); return true; }
    const newIndex = addPoint(x, y);
    if (newIndex >= 0) { selectedPointIndex = newIndex; isDraggingPoint = true; drawWaveform(); return true; }
    return false;
}

function resetDragState() {
    isDraggingPoint = false;
    isDraggingCurve = false;
    selectedPointIndex = -1;
    activeCurveIndex = -1;
}

// --- Event Handlers ---

// Local canvas handlers
function handleLocalMouseDown(e) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (e.detail === 2) { handleDoubleInteraction(x, y); return; }
    const curveIndex = findClosestCurvePoint(x, y);
    if (curveIndex >= 0) { isDraggingCurve = true; activeCurveIndex = curveIndex; drawWaveform(); return; }
    const pointIndex = findClosestPoint(x, y);
    if (pointIndex >= 0) { selectedPointIndex = pointIndex; isDraggingPoint = true; drawWaveform(); return; }
    resetDragState(); // Reset if clicked on empty space
}

function handleLocalMouseMove(e) {
    if (!isDraggingPoint && !isDraggingCurve || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (isDraggingPoint) handlePointDrag(x, y);
    else if (isDraggingCurve) handleCurveDrag(x, y);
    drawWaveform();
}

function handleLocalMouseUp() {
    isDraggingPoint = false;
    isDraggingCurve = false;
    // Don't reset selectedPointIndex or activeCurveIndex here
}

function handleLocalTouchStart(e) {
    if (!canvas) return;
    e.preventDefault();
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const rect = canvas.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    const now = Date.now();
    const timeSinceLastTap = now - lastTapTime;
    lastTapTime = now;
    if (timeSinceLastTap < 300) { handleDoubleInteraction(x, y); return; }
    const curveIndex = findClosestCurvePoint(x, y);
    if (curveIndex >= 0) { isDraggingCurve = true; activeCurveIndex = curveIndex; drawWaveform(); return; }
    const pointIndex = findClosestPoint(x, y);
    if (pointIndex >= 0) { selectedPointIndex = pointIndex; isDraggingPoint = true; drawWaveform(); return; }
    resetDragState();
}

function handleLocalTouchMove(e) {
    if ((!isDraggingPoint && !isDraggingCurve) || e.touches.length !== 1 || !canvas) return;
    e.preventDefault();
    const touch = e.touches[0];
    const rect = canvas.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    if (isDraggingPoint) handlePointDrag(x, y);
    else if (isDraggingCurve) handleCurveDrag(x, y);
    drawWaveform();
}

function handleLocalTouchEnd() {
    isDraggingPoint = false;
    isDraggingCurve = false;
}

function handleLocalKeyDown(e) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPointIndex > 0 && selectedPointIndex < points.length - 1) {
        deletePoint(selectedPointIndex);
        drawWaveform();
    }
}

// Global document handlers (for dragging outside canvas)
function handleGlobalMouseMove(e) {
    if (!isDraggingOutside || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (dragType === 'curve' && dragPointIndex >= 0) {
        if (points && points.length > dragPointIndex + 1) {
            const startPoint = points[dragPointIndex];
            const endPoint = points[dragPointIndex + 1];
            if (startPoint && endPoint) {
                const minX = Math.min(startPoint.x, endPoint.x);
                const maxX = Math.max(startPoint.x, endPoint.x);
                let constrainedX;
                if (x < 0 && startPoint.x === 0) {
                    const segmentWidth = maxX - minX;
                    const extraLeftAllowance = segmentWidth * 0.5;
                    constrainedX = Math.max(minX - extraLeftAllowance, x);
                } else if (x < 0) {
                    constrainedX = minX;
                } else {
                    constrainedX = Math.max(minX, Math.min(maxX, x));
                }
                handleCurveDrag(constrainedX, y); // Use internal handler
            } else { handleCurveDrag(x, y); }
        } else { handleCurveDrag(x, y); }
    } else if (dragType === 'point') {
        handlePointDrag(x, y); // Use internal handler
    }
    drawWaveform();
}

function handleGlobalMouseUp() {
    if (!isDraggingOutside) return;
    isDraggingOutside = false;
    dragType = null;
    dragPointIndex = -1;
    resetDragState(); // Reset internal canvas state too
}

// Canvas leave handler
function handleCanvasMouseLeave() {
    if (isDraggingPoint && selectedPointIndex >= 0) {
        isDraggingOutside = true;
        dragType = 'point';
        dragPointIndex = selectedPointIndex;
    } else if (isDraggingCurve && activeCurveIndex >= 0) {
        isDraggingOutside = true;
        dragType = 'curve';
        dragPointIndex = activeCurveIndex;
    }
}

// --- Initialization ---
export function initializeModCanvas(canvasElement) {
    if (!canvasElement) {
        console.error("ModCanvas: Canvas element not provided.");
        return;
    }
    canvas = canvasElement;
    ctx = canvas.getContext('2d');
    if (!ctx) {
        console.error("ModCanvas: Failed to get 2D context.");
        return;
    }

    // Reset state variables
    points = [];
    selectedPointIndex = -1;
    isDraggingPoint = false;
    isDraggingCurve = false;
    activeCurveIndex = -1;
    lastTapTime = 0;
    isDraggingOutside = false;
    dragType = null;
    dragPointIndex = -1;

    initializeDefaultWave();

    // Attach local canvas event listeners
    canvas.addEventListener('mousedown', handleLocalMouseDown);
    canvas.addEventListener('mousemove', handleLocalMouseMove);
    canvas.addEventListener('mouseup', handleLocalMouseUp);
    canvas.addEventListener('mouseleave', handleCanvasMouseLeave); // Activate global tracking
    canvas.addEventListener('touchstart', handleLocalTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleLocalTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleLocalTouchEnd);
    canvas.addEventListener('touchcancel', handleLocalTouchEnd);

    // Attach global document listeners (only once is fine, but doing it here keeps it contained)
    // Note: If multiple modules attach global listeners, consider a central manager.
    document.removeEventListener('mousemove', handleGlobalMouseMove); // Remove previous if any
    document.removeEventListener('mouseup', handleGlobalMouseUp);     // Remove previous if any
    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleGlobalMouseUp);

    // Key listener for delete
    document.removeEventListener('keydown', handleLocalKeyDown); // Remove previous if any
    document.addEventListener('keydown', handleLocalKeyDown);

    // Initial draw
    drawWaveform();

    console.log("Modulation Canvas Initialized");
}

// --- Data Access ---
export function getModulationPoints() {
    // Return a deep copy to prevent external modification?
    // For now, return direct reference for simplicity.
    return points;
}