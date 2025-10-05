// filepath: d:\Dropbox\Github Computer Programming Class\faithofspades.github.io\js\sampler.js
/**
 * Initializes microphone recording functionality using AudioWorklet.
 * @param {AudioContext} audioCtx - The main AudioContext.
 * @param {Function} onRecordingComplete - Callback function executed when recording stops, receives the recorded AudioBuffer.
 */
export function fixMicRecording(audioCtx, onRecordingComplete, skipButtonSetup = false) {
    // Get button reference FIRST
    const recButton = document.getElementById('mic-record-button');
    if (!recButton) return;

    // ONLY clone and setup the button if skipButtonSetup is false
    let newRecButton = recButton;
    if (!skipButtonSetup) {
        // Then clone it to remove potential old listeners
        newRecButton = recButton.cloneNode(true);
        recButton.parentNode.replaceChild(newRecButton, recButton);
    }

    // NOW you can safely access elements inside it
    const recLed = newRecButton.querySelector('.led-indicator');

    // Internal state for this instance
    let localIsRecording = false;
    let processingLock = false;
    let audioInputStream = null;
    let audioInputNode = null;
    let recordingChunks = [];
    let recorderWorklet = null;
    let workletReady = false;

    // --- AudioWorklet Setup ---
    const workletCode = `
    class RecorderWorkletProcessor extends AudioWorkletProcessor {
        constructor() {
            super();
            this.isRecording = false;
            this.port.onmessage = (event) => {
                if (event.data.command === 'setRecording') {
                    this.isRecording = event.data.value;
                }
            };
        }

        process(inputs, outputs, parameters) {
            if (!this.isRecording || !inputs[0] || !inputs[0][0]) return true;
            const inputData = inputs[0][0];
            const buffer = new Float32Array(inputData.length);
            buffer.set(inputData);
            this.port.postMessage({ type: 'chunk', data: buffer });
            return true;
        }
    }
    registerProcessor('recorder-processor', RecorderWorkletProcessor);
    `;
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(blob);

    audioCtx.audioWorklet.addModule(workletUrl).then(() => {
        workletReady = true;
        console.log("Audio worklet ready for recording");
    }).catch(err => {
        console.error("Error loading audio worklet:", err);
        newRecButton.disabled = true;
        newRecButton.title = "Recording unavailable: Worklet failed to load.";
    });

    // --- Event Listener (only if not skipping button setup) ---
    if (!skipButtonSetup) {
        newRecButton.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();

            if (processingLock || !workletReady) return;
            processingLock = true;
            setTimeout(() => { processingLock = false; }, 300);

            if (localIsRecording) {
                stopRecording();
            } else {
                startRecording();
            }
        });
    }

    // --- Recording Functions ---
    async function startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

            // Update UI
            newRecButton.classList.add('recording');
            if (recLed) recLed.classList.add('on');
            localIsRecording = true;

            recordingChunks = [];
            audioInputStream = stream;
            audioInputNode = audioCtx.createMediaStreamSource(stream);
            recorderWorklet = new AudioWorkletNode(audioCtx, 'recorder-processor');

            recorderWorklet.port.onmessage = (event) => {
                if (event.data.type === 'chunk') {
                    recordingChunks.push(event.data.data);
                }
            };

            recorderWorklet.port.postMessage({ command: 'setRecording', value: true });
            audioInputNode.connect(recorderWorklet);

            console.log("Recording started with AudioWorkletNode");
        } catch (err) {
            console.error("Error starting recording:", err);
            newRecButton.classList.remove('recording');
            if (recLed) recLed.classList.remove('on');
            localIsRecording = false;
        }
    }

    function stopRecording() {
        if (recorderWorklet) {
            try {
                recorderWorklet.port.postMessage({ command: 'setRecording', value: false });
                recorderWorklet.disconnect();
            } catch(e) { console.error("Error disconnecting recorder worklet:", e); }
            recorderWorklet = null;
        }
        if (audioInputNode) {
            try { audioInputNode.disconnect(); } catch(e) { console.error("Error disconnecting input node:", e); }
            audioInputNode = null;
        }
        if (audioInputStream) {
            try { audioInputStream.getTracks().forEach(track => track.stop()); } catch(e) { console.error("Error stopping tracks:", e); }
            audioInputStream = null;
        }

        newRecButton.classList.remove('recording');
        if (recLed) recLed.classList.remove('on');
        localIsRecording = false;

        if (recordingChunks && recordingChunks.length > 0) {
            const recordedBuffer = processRecording(recordingChunks);
            if (recordedBuffer && typeof onRecordingComplete === 'function') {
                onRecordingComplete(recordedBuffer);
            }
            recordingChunks = [];
        } else {
            console.log("No audio chunks recorded.");
        }
    }

    function processRecording(chunks) {
        console.log("Processing recorded audio...");
        try {
            let totalLength = 0;
            chunks.forEach(chunk => { totalLength += chunk.length; });

            if (totalLength === 0) return null;

            const newBuffer = audioCtx.createBuffer(1, totalLength, audioCtx.sampleRate);
            const channelData = newBuffer.getChannelData(0);
            let offset = 0;
            chunks.forEach(chunk => {
                channelData.set(chunk, offset);
                offset += chunk.length;
            });

            console.log("Recording processed into AudioBuffer, duration:", newBuffer.duration);
            return newBuffer;
        } catch (err) {
            console.error("Error processing recording:", err);
            return null;
        }
    }

    // EXPORT these functions so main.js can use them
    return {
        startRecording,
        stopRecording,
        isRecording: () => localIsRecording,
        isWorkletReady: () => workletReady
    };
}
/**
 * Creates a loopable buffer (with no actual crossfading).
 * @param {AudioContext} audioCtx - The audio context.
 * @param {AudioBuffer} originalBuffer - The buffer to process.
 * @param {number} startFraction - Loop start position (0-1).
 * @param {number} endFraction - Loop end position (0-1).
 * @param {number} crossfadeAmount - Not used for fading, just determines if looping is on.
 * @returns {object|null} An object { buffer, adjustedStartFraction } or null on error.
 */
export function createCrossfadedBuffer(audioCtx, originalBuffer, startFraction, endFraction, crossfadeAmount) {
    try {
        // Basic parameter checks
        if (!audioCtx || !originalBuffer || originalBuffer.length === 0) {
            console.log("createCrossfadedBuffer: Invalid arguments");
            return null;
        }

        // Get basic buffer properties
        const sampleRate = originalBuffer.sampleRate;
        const channels = originalBuffer.numberOfChannels;
        const totalSamples = originalBuffer.length;
        
        // Calculate exact trim positions
        const startSample = Math.floor(startFraction * totalSamples);
        const endSample = Math.floor(endFraction * totalSamples);
        const loopLength = endSample - startSample;
        
        // Ensure minimum loop length
        if (loopLength < 100) {
            console.log("Loop too short, returning minimal buffer");
            return createTrimmedBuffer(audioCtx, originalBuffer, startFraction, endFraction);
        }
        
        console.log(`Creating loop buffer: ${startSample} to ${endSample} (${loopLength} samples)`);
        
        // Simply create a trimmed buffer with the loop portion
        const newBuffer = audioCtx.createBuffer(
            channels,
            loopLength,
            sampleRate
        );
        
        // Process each channel
        for (let channel = 0; channel < channels; channel++) {
            const origData = originalBuffer.getChannelData(channel);
            const newData = newBuffer.getChannelData(channel);
            
            // Copy the entire trimmed section
            for (let i = 0; i < loopLength; i++) {
                newData[i] = origData[startSample + i];
            }
        }
        
        console.log(`Created simple loop buffer: ${(loopLength / sampleRate).toFixed(3)}s loop`);
        
        // Return the buffer with the exact trim points preserved
        return {
            buffer: newBuffer,
            adjustedStartFraction: startFraction
        };
    } catch (e) {
        console.error("Error creating loop buffer:", e);
        return null;
    }
}

// Helper function to create a simple trimmed buffer (same as before)
function createTrimmedBuffer(audioCtx, originalBuffer, startFraction, endFraction) {
    const totalSamples = originalBuffer.length;
    const startSample = Math.floor(startFraction * totalSamples);
    const endSample = Math.floor(endFraction * totalSamples);
    const length = endSample - startSample;
    
    const newBuffer = audioCtx.createBuffer(
        originalBuffer.numberOfChannels,
        length,
        originalBuffer.sampleRate
    );
    
    for (let channel = 0; channel < originalBuffer.numberOfChannels; channel++) {
        const origData = originalBuffer.getChannelData(channel);
        const newData = newBuffer.getChannelData(channel);
        
        for (let i = 0; i < length; i++) {
            newData[i] = origData[startSample + i];
        }
    }
    
    return {
        buffer: newBuffer,
        adjustedStartFraction: startFraction
    };
}
/**
 * Finds the best zero crossing near a target sample position.
 * Looks for zero crossings that come after peaks/troughs for clean cuts.
 * @param {AudioBuffer} buffer - The audio buffer to analyze
 * @param {number} targetSample - The approximate sample index to find a zero crossing near
 * @param {number} direction - Direction to search: 1 for forward (end trim), -1 for backward (start trim)
 * @param {number} maxSearchDistance - Maximum distance to search in samples (default: 2% of buffer length)
 * @returns {number} The best zero crossing sample index, or targetSample if none found
 */
export function findBestZeroCrossing(buffer, targetSample, direction = 1, maxSearchDistance = null) {
    if (!buffer || buffer.length === 0 || !buffer.getChannelData) return targetSample;
    
    const totalSamples = buffer.length;
    // Default search distance is 2% of total sample length
    const searchDistance = maxSearchDistance || Math.floor(totalSamples * 0.02);
    
    // Get the first channel data (usually we just analyze channel 0 for simplicity)
    const audioData = buffer.getChannelData(0);
    
    // Ensure target is within bounds
    targetSample = Math.max(0, Math.min(targetSample, totalSamples - 1));
    
    // Define search boundaries
    const searchStart = Math.max(0, targetSample - (direction < 0 ? searchDistance : 0));
    const searchEnd = Math.min(totalSamples - 2, targetSample + (direction > 0 ? searchDistance : 0));
    
    console.log(`Finding best zero crossing near sample ${targetSample}, searching ${searchStart}-${searchEnd}`);
    
    // Variables to track best zero crossing
    let bestZeroCrossing = targetSample;
    let bestScore = -Infinity;
    
    // Local minima/maxima detection window size
    const peakWindow = 5;
    
    // Scan the search range
    for (let i = searchStart; i <= searchEnd; i++) {
        // Check for zero crossing (positive-to-negative or negative-to-positive)
        const isZeroCrossing = (audioData[i] >= 0 && audioData[i + 1] < 0) || 
                               (audioData[i] <= 0 && audioData[i + 1] > 0);
        
        if (isZeroCrossing) {
            // Look back to see if there was a peak or trough before this
            let hasPeak = false;
            let hasTrough = false;
            let peakDistance = 0;
            
            // Check previous samples within peak window
            for (let j = 1; j <= peakWindow; j++) {
                const idx = i - j;
                if (idx < 0) break;
                
                // Check for peak (sample is higher than neighbors)
                if (idx > 0 && idx < totalSamples - 1) {
                    if (audioData[idx] > audioData[idx - 1] && audioData[idx] > audioData[idx + 1]) {
                        hasPeak = true;
                        peakDistance = j;
                        break;
                    }
                    // Check for trough (sample is lower than neighbors)
                    if (audioData[idx] < audioData[idx - 1] && audioData[idx] < audioData[idx + 1]) {
                        hasTrough = true;
                        peakDistance = j;
                        break;
                    }
                }
            }
            
            // Calculate score - higher is better
            let score = 0;
            
            // Preferred: Zero crossing after peak/trough
            if (hasPeak || hasTrough) {
                score += 100 - peakDistance * 5; // Closer peaks/troughs are better
            }
            
            // Steeper zero crossings are cleaner
            const slope = Math.abs(audioData[i + 1] - audioData[i]);
            score += slope * 50; // Steeper slope = higher score
            
            // Prefer zero crossings closer to target
            const distance = Math.abs(i - targetSample);
            score -= distance * 0.5; // Penalize distance from target
            
            // Check if this is the best so far
            if (score > bestScore) {
                bestScore = score;
                bestZeroCrossing = i;
            }
        }
    }
    
    // If we found a good zero crossing, return it
    if (bestScore > -Infinity) {
        console.log(`Found zero crossing at ${bestZeroCrossing}, score: ${bestScore.toFixed(1)}, ${Math.abs(bestZeroCrossing - targetSample)} samples from target`);
        return bestZeroCrossing;
    }
    
    // If no suitable zero crossing found, return original position
    console.log(`No suitable zero crossing found, using original position ${targetSample}`);
    return targetSample;
}
