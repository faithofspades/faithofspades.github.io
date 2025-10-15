function initializeFilterPrecisionSlider(slider) {
  // Keep the original min/max attributes
  const minFreq = parseInt(slider.min); // 8 Hz
  const maxFreq = parseInt(slider.max); // 16000 Hz
  
  // Remove any existing event listeners by cloning
  const newSlider = slider.cloneNode(true);
  slider.parentNode.replaceChild(newSlider, slider);
  
  // Non-linear mapping functions
  function positionToFrequency(position) {
    position = Math.max(0, Math.min(1, position));
    if (position <= 0.5) {
      // First half maps to 8-500Hz (exponential)
      return minFreq * Math.pow(500/minFreq, position*2);
    } else {
      // Second half maps to 500-16000Hz (exponential)
      return 500 * Math.pow(maxFreq/500, (position-0.5)*2);
    }
  }
  
  function frequencyToPosition(freq) {
    freq = Math.max(minFreq, Math.min(maxFreq, freq));
    if (freq <= 500) {
      return Math.log(freq/minFreq) / Math.log(500/minFreq) * 0.5;
    } else {
      return 0.5 + Math.log(freq/500) / Math.log(maxFreq/500) * 0.5;
    }
  }
  
  // CRITICAL FIX: Set slider min/max to 0-1 range to match our normalized positions
  newSlider.min = 0;
  newSlider.max = 1;
  newSlider.step = 0.000001; // Fine steps for precision
  
  let lastY;
  let isDragging = false;
  
  // Mouse down event - start drag operation
  newSlider.addEventListener('mousedown', function(e) {
    isDragging = true;
    lastY = e.clientY;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    e.preventDefault();
  });
  
  // Mouse move handler with precision shift key control
  function handleMouseMove(e) {
    if (!isDragging) return;
    
    // Shift key provides finer control (5x slower)
    const sensitivity = e.shiftKey ? 0.2 : 1.0;
    
    // Calculate vertical movement
    const deltaY = lastY - e.clientY;
    lastY = e.clientY;
    
    // Get current normalized position (0-1)
    const currentPosition = parseFloat(newSlider.value);
    
    // Apply movement with sensitivity factor
    const posChange = (deltaY * 0.005) * sensitivity;
    let newPosition = Math.max(0, Math.min(1, currentPosition + posChange));
    
    // Convert position to frequency using non-linear mapping
    let newFreq = positionToFrequency(newPosition);
    
    // Always round to nearest integer for whole Hz values
    newFreq = Math.round(newFreq);
    
    // Update filter without changing slider position directly
    if (filterManager) {
      filterManager.setCutoff(newFreq);
    }
    
    // CRITICAL FIX: Update slider position to match our 0-1 normalized range
    newSlider.value = newPosition;
    
    console.log(`Filter: position=${newPosition.toFixed(2)}, frequency=${newFreq}Hz, shift=${e.shiftKey ? 'ON' : 'OFF'}`);
    
    e.preventDefault();
  }
  
  // Mouse up handler - end drag operation
  function handleMouseUp() {
    isDragging = false;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }
  
  // Standard input handler for direct clicks on the track
  newSlider.oninput = function() {
    // Get normalized position directly from slider value (now in 0-1 range)
    const position = parseFloat(this.value);
    
    // Convert to frequency using our non-linear mapping
    const frequency = positionToFrequency(position);
    const roundedFreq = Math.round(frequency);
    
    // Update filter cutoff
    if (filterManager) {
      filterManager.setCutoff(roundedFreq);
    }
    
    console.log(`Filter input: position=${position.toFixed(2)}, freq=${roundedFreq}Hz`);
  };
  
  // Initialize with maximum frequency (16000Hz)
  const initialPosition = 1.0; // Set to rightmost position
  newSlider.value = initialPosition;
  
  // Manually set cutoff to match
  if (filterManager) {
    filterManager.setCutoff(16000);
  }
  return newSlider;
}