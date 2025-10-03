// filepath: d:\Dropbox\Github Computer Programming Class\faithofspades.github.io\js\sampler.js
/**
 * Initializes microphone recording functionality using AudioWorklet.
 * @param {AudioContext} audioCtx - The main AudioContext.
 * @param {Function} onRecordingComplete - Callback function executed when recording stops, receives the recorded AudioBuffer.
 */
export function fixMicRecording(audioCtx, onRecordingComplete) {
    // Get button reference FIRST
    const recButton = document.getElementById('mic-record-button');
    if (!recButton) return;

    // Then clone it to remove potential old listeners
    const newRecButton = recButton.cloneNode(true);
    recButton.parentNode.replaceChild(newRecButton, recButton);

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
        // Optionally disable the button or show an error
        newRecButton.disabled = true;
        newRecButton.title = "Recording unavailable: Worklet failed to load.";
    });

    // --- Event Listener ---
    newRecButton.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();

        if (processingLock || !workletReady) return;
        processingLock = true;
        setTimeout(() => { processingLock = false; }, 300); // Debounce

        if (localIsRecording) {
            stopRecording();
        } else {
            startRecording();
        }
    });

    // --- Recording Functions ---
    async function startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

            // Update UI
            newRecButton.classList.add('recording');
            if (recLed) recLed.classList.add('on');
            localIsRecording = true;

            // Reset recording chunks
            recordingChunks = [];

            // Create audio input source
            audioInputStream = stream;
            audioInputNode = audioCtx.createMediaStreamSource(stream);

            // Create and connect the AudioWorkletNode
            recorderWorklet = new AudioWorkletNode(audioCtx, 'recorder-processor');

            // Collect audio chunks
            recorderWorklet.port.onmessage = (event) => {
                if (event.data.type === 'chunk') {
                    recordingChunks.push(event.data.data);
                }
            };

            // Tell the worklet to start
            recorderWorklet.port.postMessage({ command: 'setRecording', value: true });

            // Connect nodes
            audioInputNode.connect(recorderWorklet);
            // Do NOT connect recorderWorklet to destination unless monitoring is desired
            // recorderWorklet.connect(audioCtx.destination);

            console.log("Recording started with AudioWorkletNode");
        } catch (err) {
            console.error("Error starting recording:", err);
            // Reset UI on error
            newRecButton.classList.remove('recording');
            if (recLed) recLed.classList.remove('on');
            localIsRecording = false;
        }
    }

    function stopRecording() {
        // Clean up audio nodes and stream first
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

        // Update UI
        newRecButton.classList.remove('recording');
        if (recLed) recLed.classList.remove('on');
        localIsRecording = false;

        // Process the recording chunks if we have any
        if (recordingChunks && recordingChunks.length > 0) {
            const recordedBuffer = processRecording(recordingChunks);
            if (recordedBuffer && typeof onRecordingComplete === 'function') {
                onRecordingComplete(recordedBuffer); // Pass the buffer to the callback
            }
            recordingChunks = []; // Clear chunks after processing
        } else {
            console.log("No audio chunks recorded.");
        }
    }

    /**
     * Processes recorded chunks into a single AudioBuffer.
     * @param {Float32Array[]} chunks - Array of recorded audio chunks.
     * @returns {AudioBuffer|null} The combined AudioBuffer or null if error.
     */
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
}
/**
 * Creates a properly loopable buffer with crossfades baked in.
 * @param {AudioContext} audioCtx - The audio context.
 * @param {AudioBuffer} originalBuffer - The buffer to process.
 * @param {number} startFraction - Loop start position (0-1).
 * @param {number} endFraction - Loop end position (0-1).
 * @param {number} crossfadeAmount - Crossfade amount (0-1).
 * @returns {object|null} An object { buffer, adjustedStartFraction } or null on error.
 */
export function createCrossfadedBuffer(audioCtx, originalBuffer, startFraction, endFraction, crossfadeAmount) {
    try {
        // Basic parameter checks
        if (!audioCtx || !originalBuffer || originalBuffer.length === 0) {
            console.log("createCrossfadedBuffer: Invalid arguments (audioCtx or buffer missing/empty)");
            return null;
        }

        if (crossfadeAmount <= 0.00001) {
            console.log("Crossfade amount too small, returning original segment");
            // Return a slice of the original buffer based on fractions if no crossfade
            const startSample = Math.floor(startFraction * originalBuffer.length);
            const endSample = Math.floor(endFraction * originalBuffer.length);
            const loopLength = Math.max(1, endSample - startSample);
            const newBuffer = audioCtx.createBuffer(originalBuffer.numberOfChannels, loopLength, originalBuffer.sampleRate);
            for (let c = 0; c < originalBuffer.numberOfChannels; c++) {
                const origData = originalBuffer.getChannelData(c);
                const newData = newBuffer.getChannelData(c);
                for (let i = 0; i < loopLength; i++) {
                    newData[i] = origData[startSample + i];
                }
            }
            return { buffer: newBuffer, adjustedStartFraction: startFraction };
        }

        // IMPORTANT: Use the original buffer for consistency
        const sourceBuffer = originalBuffer;
        const sampleRate = sourceBuffer.sampleRate;
        const channels = sourceBuffer.numberOfChannels;
        const totalSamples = sourceBuffer.length;
        const channel0Data = sourceBuffer.getChannelData(0);

        // Calculate sample indices and loop length
        let startSamplePos = Math.floor(startFraction * totalSamples);
        let endSamplePos = Math.floor(endFraction * totalSamples);
        let loopLength = endSamplePos - startSamplePos;

        // Check for minimum viable loop length
        const minimumSamples = Math.max(100, Math.floor(totalSamples * 0.001));
        if (loopLength < minimumSamples) {
            console.log(`Loop length (${loopLength} samples) is too short for crossfading. Minimum: ${minimumSamples}`);
            // Return original buffer segment if too short
            const newBuffer = audioCtx.createBuffer(channels, loopLength, sampleRate);
            for (let c = 0; c < channels; c++) {
                const origData = sourceBuffer.getChannelData(c);
                const newData = newBuffer.getChannelData(c);
                for (let i = 0; i < loopLength; i++) {
                    newData[i] = origData[startSamplePos + i];
                }
            }
            return { buffer: newBuffer, adjustedStartFraction: startFraction };
        }

        // For very small crossfades (<20%), we just use zero-crossing alignment without crossfade
        if (crossfadeAmount < 0.20) {
            console.log("Using pure zero-crossing alignment for small crossfade");

            // Zero crossing detection code (unchanged)
            const searchWindowSamples = Math.ceil(sampleRate * 0.01);
            const startCrossings = [];
            const startMin = Math.max(0, startSamplePos - searchWindowSamples);
            const startMax = Math.min(totalSamples - 2, startSamplePos + searchWindowSamples);

            for (let i = startMin; i < startMax; i++) {
                if (channel0Data[i] <= 0 && channel0Data[i + 1] > 0) {
                    startCrossings.push({
                        index: i,
                        slope: channel0Data[i + 1] - channel0Data[i],
                        type: 'rising'
                    });
                }
                else if (channel0Data[i] >= 0 && channel0Data[i + 1] < 0) {
                    startCrossings.push({
                        index: i,
                        slope: channel0Data[i + 1] - channel0Data[i],
                        type: 'falling'
                    });
                }
            }

            const endCrossings = [];
            const endMin = Math.max(0, endSamplePos - searchWindowSamples);
            const endMax = Math.min(totalSamples - 2, endSamplePos + searchWindowSamples);

            for (let i = endMin; i < endMax; i++) {
                if (channel0Data[i] <= 0 && channel0Data[i + 1] > 0) {
                    endCrossings.push({
                        index: i,
                        slope: channel0Data[i + 1] - channel0Data[i],
                        type: 'rising'
                    });
                }
                else if (channel0Data[i] >= 0 && channel0Data[i + 1] < 0) {
                    endCrossings.push({
                        index: i,
                        slope: channel0Data[i + 1] - channel0Data[i],
                        type: 'falling'
                    });
                }
            }

            console.log(`Found ${startCrossings.length} start and ${endCrossings.length} end zero crossings`);

            if (startCrossings.length > 0 && endCrossings.length > 0) {
                let bestMatch = { score: -Infinity, start: startSamplePos, end: endSamplePos };

                for (const start of startCrossings) {
                    for (const end of endCrossings) {
                        const typeScore = (start.type === end.type) ? 5 : -2;
                        const slopeScore = 5 - Math.min(5, Math.abs(start.slope - end.slope) * 20);
                        const distanceScore = 3 - Math.min(3,
                            (Math.abs(start.index - startSamplePos) +
                                Math.abs(end.index - endSamplePos)) / (searchWindowSamples * 2) * 3);

                        const score = typeScore + slopeScore + distanceScore;

                        if (score > bestMatch.score) {
                            bestMatch = {
                                score,
                                start: start.index,
                                end: end.index
                            };
                        }
                    }
                }

                if (bestMatch.score > 0) {
                    console.log(`Using zero crossings: start=${bestMatch.start}, end=${bestMatch.end}, score=${bestMatch.score.toFixed(2)}`);
                    startSamplePos = bestMatch.start;
                    endSamplePos = bestMatch.end;
                    loopLength = endSamplePos - startSamplePos;
                }
            }

            const newBuffer = audioCtx.createBuffer(channels, loopLength, sampleRate);

            for (let channel = 0; channel < channels; channel++) {
                const origData = sourceBuffer.getChannelData(channel);
                const newData = newBuffer.getChannelData(channel);

                for (let i = 0; i < loopLength; i++) {
                    newData[i] = origData[startSamplePos + i];
                }
            }

            return { buffer: newBuffer, adjustedStartFraction: startSamplePos / totalSamples };
        }

        // For larger crossfades (≥20%), implement a robust crossfade with phase alignment
        console.log("Using enhanced phase-aligned crossfade for larger fade amount");

        // IMPROVED CROSSFADE LENGTH CALCULATION
        const minFadeSamples = Math.max(Math.round(sampleRate * 0.015), 100); // minimum 15ms fade
        const maxFadeSamples = Math.floor(loopLength * 0.4); // maximum 40% of loop length

        let fadeLengthSamples;
        if (crossfadeAmount >= 0.95) {
            fadeLengthSamples = maxFadeSamples;
        } else if (crossfadeAmount < 0.3) {
            fadeLengthSamples = Math.max(minFadeSamples, Math.round(sampleRate * 0.035)); // 35ms minimum
        } else {
            const t = crossfadeAmount;
            const easedT = t * t * (3 - 2 * t); // Smooth step function
            fadeLengthSamples = Math.floor(minFadeSamples + (maxFadeSamples - minFadeSamples) * easedT);
        }

        console.log(`Fade length: ${fadeLengthSamples} samples (${fadeLengthSamples / sampleRate}s), ${(fadeLengthSamples / loopLength * 100).toFixed(1)}% of loop`);

        // Ensure we have enough samples before start for lead-in
        if (startSamplePos < fadeLengthSamples) {
            startSamplePos = fadeLengthSamples;
            loopLength = endSamplePos - startSamplePos;
            // Recheck loop length after adjustment
            if (loopLength < minimumSamples) {
                 console.log(`Adjusted loop length (${loopLength} samples) is too short. Returning original segment.`);
                 const newBuffer = audioCtx.createBuffer(channels, loopLength, sampleRate);
                 for (let c = 0; c < channels; c++) {
                     const origData = sourceBuffer.getChannelData(c);
                     const newData = newBuffer.getChannelData(c);
                     for (let i = 0; i < loopLength; i++) {
                         newData[i] = origData[startSamplePos + i];
                     }
                 }
                 return { buffer: newBuffer, adjustedStartFraction: startSamplePos / totalSamples };
            }
        }

        // ENHANCED CROSSFADE REGION ANALYSIS
        const crossfadeStartPos = endSamplePos - fadeLengthSamples;
        const analysisPoints = 5;
        const crossfadeCharacteristics = [];

        for (let i = 0; i < analysisPoints; i++) {
            const position = crossfadeStartPos + Math.floor(i * fadeLengthSamples / (analysisPoints - 1));
            let crossType = null;
            let isRising = false;
            for (let j = -3; j <= 2; j++) {
                const idx = Math.max(0, Math.min(position + j, totalSamples - 2));
                if (channel0Data[idx] <= 0 && channel0Data[idx + 1] > 0) { crossType = 'rising'; isRising = true; break; }
                else if (channel0Data[idx] >= 0 && channel0Data[idx + 1] < 0) { crossType = 'falling'; isRising = false; break; }
            }
            if (!crossType) {
                const p0 = channel0Data[Math.max(0, position - 3)];
                const p1 = channel0Data[position];
                const p2 = channel0Data[Math.min(totalSamples - 1, position + 3)];
                isRising = (p2 > p0);
                crossType = p1 >= 0 ? 'positive' : 'negative';
            }
            const amplitude = Math.abs(channel0Data[position]);
            let localFreq = 0;
            const freqWindow = 20;
            let crossings = 0;
            for (let j = Math.max(0, position - freqWindow); j < Math.min(totalSamples - 1, position + freqWindow); j++) {
                if ((channel0Data[j] <= 0 && channel0Data[j + 1] > 0) || (channel0Data[j] >= 0 && channel0Data[j + 1] < 0)) { crossings++; }
            }
            localFreq = crossings / (freqWindow * 2);
            crossfadeCharacteristics.push({ position, crossType, isRising, amplitude, localFreq });
        }

        const searchWindow = Math.min(Math.floor(sampleRate * 0.1), Math.floor(loopLength * 0.3));
        const searchStartPoint = startSamplePos - fadeLengthSamples;
        let bestLeadInPos = searchStartPoint;
        let bestScore = -1000;

        for (let offset = -searchWindow; offset <= searchWindow; offset += 5) {
            const testPos = searchStartPoint + offset;
            if (testPos < 0 || testPos + fadeLengthSamples >= crossfadeStartPos) { continue; }
            let totalScore = 0;
            for (let i = 0; i < analysisPoints; i++) {
                const targetChar = crossfadeCharacteristics[i];
                const relativePos = Math.floor(i * fadeLengthSamples / (analysisPoints - 1));
                const testSamplePos = testPos + relativePos;
                let pointScore = 0;
                let testCrossType = null;
                let testIsRising = false;
                for (let j = -3; j <= 2; j++) {
                    const idx = Math.max(0, Math.min(testSamplePos + j, totalSamples - 2));
                    if (channel0Data[idx] <= 0 && channel0Data[idx + 1] > 0) { testCrossType = 'rising'; testIsRising = true; break; }
                    else if (channel0Data[idx] >= 0 && channel0Data[idx + 1] < 0) { testCrossType = 'falling'; testIsRising = false; break; }
                }
                if (!testCrossType) {
                    const p0 = channel0Data[Math.max(0, testSamplePos - 3)];
                    const p1 = channel0Data[testSamplePos];
                    const p2 = channel0Data[Math.min(totalSamples - 1, testSamplePos + 3)];
                    testIsRising = (p2 > p0);
                    testCrossType = p1 >= 0 ? 'positive' : 'negative';
                }
                if (testCrossType === targetChar.crossType) { pointScore += 30; }
                if (testIsRising === targetChar.isRising) { pointScore += 20; }
                const testAmplitude = Math.abs(channel0Data[testSamplePos]);
                const ampDiff = Math.abs(targetChar.amplitude - testAmplitude);
                pointScore += 20 - Math.min(20, ampDiff * 40);
                let testCrossings = 0;
                const freqWindow = 20;
                for (let j = Math.max(0, testSamplePos - freqWindow); j < Math.min(totalSamples - 1, testSamplePos + freqWindow); j++) {
                    if ((channel0Data[j] <= 0 && channel0Data[j + 1] > 0) || (channel0Data[j] >= 0 && channel0Data[j + 1] < 0)) { testCrossings++; }
                }
                const testLocalFreq = testCrossings / (freqWindow * 2);
                const freqDiff = Math.abs(targetChar.localFreq - testLocalFreq);
                pointScore += 20 - Math.min(20, freqDiff * 100);
                totalScore += pointScore * (0.8 + 0.2 * i / analysisPoints);
            }
            totalScore += 50 - Math.min(50, Math.abs(offset) / searchWindow * 50);
            if (totalScore > bestScore) { bestScore = totalScore; bestLeadInPos = testPos; }
        }
        console.log(`Selected lead-in position: ${bestLeadInPos}, score: ${bestScore.toFixed(1)}`);

        let fineTunedLeadIn = bestLeadInPos;
        let fineTuneScore = -1000;
        for (let fineOffset = -10; fineOffset <= 10; fineOffset++) {
            const testPos = bestLeadInPos + fineOffset;
            if (testPos < 0) continue;
            const endPhase = channel0Data[crossfadeStartPos];
            const endSlope = channel0Data[crossfadeStartPos + 1] - channel0Data[crossfadeStartPos];
            const testPhase = channel0Data[testPos];
            const testSlope = channel0Data[testPos + 1] - channel0Data[testPos];
            const phaseScore = 50 - Math.min(50, Math.abs(endPhase - testPhase) * 100);
            const slopeScore = 50 - Math.min(50, Math.abs(endSlope - testSlope) * 200);
            const score = phaseScore + slopeScore;
            if (score > fineTuneScore) { fineTuneScore = score; fineTunedLeadIn = testPos; }
        }
        console.log(`Fine-tuned lead-in position: ${fineTunedLeadIn}, improvement: ${(fineTuneScore / 100).toFixed(1)}`);

        const adjustedStart = startSamplePos;
        const fadeInStart = fineTunedLeadIn;
        const newBuffer = audioCtx.createBuffer(channels, loopLength, sampleRate);

        for (let channel = 0; channel < channels; channel++) {
            const origData = sourceBuffer.getChannelData(channel);
            const newData = newBuffer.getChannelData(channel);
            for (let i = 0; i < loopLength; i++) { newData[i] = origData[adjustedStart + i]; }
            for (let i = 0; i < fadeLengthSamples; i++) {
                const idx = loopLength - fadeLengthSamples + i;
                if (idx >= 0) {
                    const ratio = i / fadeLengthSamples;
                    const fadeOutFactor = Math.cos(ratio * Math.PI / 2) - Math.max(0, 0.02 - ratio * 0.04);
                    const fadeInFactor = Math.sin(ratio * Math.PI / 2);
                    const loopEndSample = newData[idx];
                    const leadInSample = origData[fadeInStart + i];
                    newData[idx] = (loopEndSample * fadeOutFactor) + (leadInSample * fadeInFactor);
                }
            }
            const smoothSamples = Math.min(24, Math.ceil(sampleRate * 0.0005));
            for (let i = 1; i <= smoothSamples; i++) {
                const idx = loopLength - i;
                if (idx >= 0 && idx < loopLength - 1) {
                    const weight = i / smoothSamples;
                    newData[idx] = newData[idx] * (1 - weight * 0.1) + newData[idx + 1] * (weight * 0.1);
                }
            }
        }

        console.log(`Created enhanced crossfaded buffer: ${(loopLength / sampleRate).toFixed(3)}s loop`);
        return { buffer: newBuffer, adjustedStartFraction: adjustedStart / totalSamples };

    } catch (e) {
        console.error("Error creating crossfaded buffer:", e);
        // Return null on error, let the caller handle it
        return null;
    }
}