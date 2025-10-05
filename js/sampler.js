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
 * Creates a loopable buffer with advanced crossfading.
 * @param {AudioContext} audioCtx - The audio context.
 * @param {AudioBuffer} originalBuffer - The buffer to process.
 * @param {number} startFraction - Loop start position (0-1).
 * @param {number} endFraction - Loop end position (0-1).
 * @param {number} crossfadeAmount - Controls crossfade amount (0-1).
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
        const trimmedLength = endSample - startSample;
        
        // Ensure minimum trim length
        if (trimmedLength < 100) {
            console.log("Loop too short, returning minimal buffer");
            return createTrimmedBuffer(audioCtx, originalBuffer, startFraction, endFraction);
        }
        
        // CHANGED: If crossfade is below 5%, use simple loop with no crossfading
        if (crossfadeAmount < 0.05) {
            console.log("Crossfade below 5%, using simple loop with no crossfade");
            const result = createTrimmedBuffer(audioCtx, originalBuffer, startFraction, endFraction);
            
            // Add properties needed for looping but don't actually crossfade
            result.loopStartSample = 0;
            result.crossfadeLengthSamples = 0;
            result.crossfadeFraction = 0;
            
            return result;
        }
        
        // Calculate how much of the start to move to the end and crossfade
        // Scale from 0% at minimum to 50% at maximum crossfadeAmount
        const maxCrossfadePercent = 0.5; // 50% maximum
        const scaledCrossfadeFraction = Math.min(maxCrossfadePercent, crossfadeAmount * maxCrossfadePercent);
        
        // Calculate samples for crossfade
        const crossfadeSamples = Math.floor(trimmedLength * scaledCrossfadeFraction);
        
        // Calculate loop point - where it will jump back to after playing
        const loopPoint = crossfadeSamples;
        
        console.log(`Creating crossfaded loop: ${(crossfadeSamples / sampleRate).toFixed(3)}s crossfade (${(scaledCrossfadeFraction * 100).toFixed(1)}% of loop)`);
        console.log(`Loop jumps back to ${(loopPoint / sampleRate).toFixed(3)}s position after playing`);
        
        // Create the buffer with the same length as the trimmed section
        const newBuffer = audioCtx.createBuffer(
            channels,
            trimmedLength,
            sampleRate
        );
        
        // Process each channel
        for (let channel = 0; channel < channels; channel++) {
            const origData = originalBuffer.getChannelData(channel);
            const newData = newBuffer.getChannelData(channel);
            
            // STEP 1: Copy the entire trimmed section
            for (let i = 0; i < trimmedLength; i++) {
                newData[i] = origData[startSample + i];
            }
            
            // STEP 2: Apply crossfade between the start and end
            for (let i = 0; i < crossfadeSamples; i++) {
                // Position in the output buffer (near the end)
                const destPos = trimmedLength - crossfadeSamples + i;
                
                // Calculate fade ratio (0 to 1)
                const ratio = i / crossfadeSamples;
                
                // Constant power crossfade (equal power curve)
                // sin²(x) + cos²(x) = 1 ensures constant power
                const fadeOutGain = Math.cos(ratio * Math.PI / 2);
                const fadeInGain = Math.sin(ratio * Math.PI / 2);
                
                // Mix the end of the loop with the beginning
                const endSample = newData[destPos];
                const beginSample = origData[startSample + i];
                
                // Apply the crossfade
                newData[destPos] = (endSample * fadeOutGain) + (beginSample * fadeInGain);
            }
        }
        
        console.log(`Created advanced crossfaded buffer: ${(trimmedLength / sampleRate).toFixed(3)}s with ${(crossfadeSamples / sampleRate).toFixed(3)}s crossfade`);
        
        // Return the crossfaded buffer with loop information
        return {
            buffer: newBuffer,
            adjustedStartFraction: startFraction,
            loopStartSample: loopPoint,
            crossfadeLengthSamples: crossfadeSamples,
            crossfadeFraction: scaledCrossfadeFraction
        };
    } catch (e) {
        console.error("Error creating crossfaded buffer:", e);
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
 * Finds the best complementary zero crossings for start and end points.
 * @param {AudioBuffer} buffer - The audio buffer to analyze
 * @param {number} startSample - Approximate start sample index 
 * @param {number} endSample - Approximate end sample index
 * @returns {object} Object with {start, end} sample positions
 */
export function findBestZeroCrossings(buffer, startSample, endSample) {
    if (!buffer || buffer.length === 0 || !buffer.getChannelData) {
        return { start: startSample, end: endSample };
    }
    
    const totalSamples = buffer.length;
    const searchDistance = Math.floor(totalSamples * 0.02); // 2% search radius
    
    // Get the first channel data
    const audioData = buffer.getChannelData(0);
    
    // Ensure samples are within bounds
    startSample = Math.max(0, Math.min(startSample, totalSamples - 1));
    endSample = Math.max(0, Math.min(endSample, totalSamples - 1));
    
    console.log(`Finding complementary zero crossings: start≈${startSample}, end≈${endSample}`);
    
    // Find all candidate zero crossings near start position
    const startCandidates = findCandidateCrossings(audioData, startSample, searchDistance, 1);
    
    // Find all candidate zero crossings near end position
    const endCandidates = findCandidateCrossings(audioData, endSample, searchDistance, -1);
    
    console.log(`Found ${startCandidates.length} start candidates and ${endCandidates.length} end candidates`);
    
    // If no candidates found for either, return original positions
    if (startCandidates.length === 0 || endCandidates.length === 0) {
        console.log("Insufficient candidates found, using original positions");
        return { start: startSample, end: endSample };
    }
    
    // Find the best complementary pair
    let bestPair = { start: startSample, end: endSample, score: -Infinity };
    
    for (const start of startCandidates) {
        for (const end of endCandidates) {
            // Skip invalid pairs (end must be after start)
            if (end.index <= start.index + 100) continue; // Minimum 100 samples between
            
            let score = 0;
            
            // CRITICAL: Prefer complementary pairs (peak→trough or trough→peak)
            if ((start.hasPeak && end.hasTrough) || (start.hasTrough && end.hasPeak)) {
                score += 200; // Strongly prefer complementary pairs
            }
            
            // Add individual scores
            score += start.score + end.score;
            
            // Prefer pairs closer to requested positions
            score -= Math.abs(start.index - startSample) * 0.3;
            score -= Math.abs(end.index - endSample) * 0.3;
            
            if (score > bestPair.score) {
                bestPair = { 
                    start: start.index, 
                    end: end.index, 
                    score: score,
                    startType: start.hasPeak ? 'peak' : (start.hasTrough ? 'trough' : 'none'),
                    endType: end.hasPeak ? 'peak' : (end.hasTrough ? 'trough' : 'none')
                };
            }
        }
    }
    
    if (bestPair.score > -Infinity) {
        console.log(`Found complementary pair: ${bestPair.startType}→${bestPair.endType}, score: ${bestPair.score.toFixed(1)}`);
        console.log(`Adjusted start: ${bestPair.start} (${Math.abs(bestPair.start - startSample)} samples offset)`);
        console.log(`Adjusted end: ${bestPair.end} (${Math.abs(bestPair.end - endSample)} samples offset)`);
        return { start: bestPair.start, end: bestPair.end };
    }
    
    return { start: startSample, end: endSample };
}

// Helper function to find candidate zero crossings
function findCandidateCrossings(audioData, targetSample, searchDistance, direction) {
    const totalSamples = audioData.length;
    const searchStart = Math.max(0, targetSample - (direction > 0 ? searchDistance : 0));
    const searchEnd = Math.min(totalSamples - 2, targetSample + (direction > 0 ? 0 : searchDistance));
    const peakWindow = 5;
    const candidates = [];
    
    for (let i = searchStart; i <= searchEnd; i++) {
        // Check for zero crossing
        const isZeroCrossing = (audioData[i] >= 0 && audioData[i + 1] < 0) || 
                               (audioData[i] <= 0 && audioData[i + 1] > 0);
        
        if (isZeroCrossing) {
            // Look for peak/trough before this
            let hasPeak = false;
            let hasTrough = false;
            let peakDistance = 0;
            
            for (let j = 1; j <= peakWindow; j++) {
                const idx = i - j;
                if (idx < 0) break;
                
                if (idx > 0 && idx < totalSamples - 1) {
                    if (audioData[idx] > audioData[idx - 1] && audioData[idx] > audioData[idx + 1]) {
                        hasPeak = true;
                        peakDistance = j;
                        break;
                    }
                    if (audioData[idx] < audioData[idx - 1] && audioData[idx] < audioData[idx + 1]) {
                        hasTrough = true;
                        peakDistance = j;
                        break;
                    }
                }
            }
            
            let score = 0;
            
            // Basic scoring for individual candidates
            if (hasPeak || hasTrough) {
                score += 100 - peakDistance * 5;
            }
            
            const slope = Math.abs(audioData[i + 1] - audioData[i]);
            score += slope * 50;
            
            const distance = Math.abs(i - targetSample);
            score -= distance * 0.5;
            
            candidates.push({
                index: i,
                hasPeak: hasPeak,
                hasTrough: hasTrough,
                peakDistance: peakDistance,
                score: score
            });
        }
    }
    
    return candidates;
}

// For backward compatibility - wrap the new function
export function findBestZeroCrossing(buffer, targetSample, direction = 1, maxSearchDistance = null) {
    if (!buffer || buffer.length === 0) return targetSample;
    
    const totalSamples = buffer.length;
    maxSearchDistance = maxSearchDistance || Math.floor(totalSamples * 0.02);
    
    // Calculate the other sample position based on direction
    let startSample, endSample;
    if (direction > 0) {
        // We're looking for start position
        startSample = targetSample;
        endSample = Math.min(totalSamples - 1, startSample + Math.floor(totalSamples * 0.05));
    } else {
        // We're looking for end position
        endSample = targetSample;
        startSample = Math.max(0, endSample - Math.floor(totalSamples * 0.05));
    }
    
    // Use the full function but only return what we need
    const result = findBestZeroCrossings(buffer, startSample, endSample);
    return direction > 0 ? result.start : result.end;
}