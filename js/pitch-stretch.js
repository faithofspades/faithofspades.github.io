const MIN_RATIO = 0.25;
const MAX_RATIO = 4.0;

const DEFAULT_PROFILE = {
    fftSize: 4096,
    oversample: 16,
    window: 'blackman-harris',
    transientBlend: 0.65,
    transientSpanMs: 18,
    formantPreserve: true,
    resampleInterpolation: 'cubic'
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function processLayerBuffer({
    bufferL,
    bufferR,
    sampleRate,
    speedRatio = 1,
    pitchRatio = 1,
    profileOverrides = {}
}) {
    if (!bufferL || bufferL.length === 0) {
        return {
            bufferL: new Float32Array(0),
            bufferR: new Float32Array(0),
            lengthSamples: 0,
            profile: { ...DEFAULT_PROFILE }
        };
    }

    const safeSpeed = clamp(Math.abs(speedRatio) || 1, MIN_RATIO, MAX_RATIO);
    const safePitch = clamp(Math.abs(pitchRatio) || 1, MIN_RATIO, MAX_RATIO);

    const analysis = analyzeSource(bufferL, sampleRate);
    const profile = selectProcessingProfile({ analysis, safeSpeed, safePitch, overrides: profileOverrides });

    const sourceR = bufferR && bufferR.length === bufferL.length ? bufferR : bufferL;

    const resampledL = resampleChannel(bufferL, safeSpeed, profile.resampleInterpolation);
    const resampledR = sourceR === bufferL ? resampledL.slice() : resampleChannel(sourceR, safeSpeed, profile.resampleInterpolation);

    const needsPitchShift = Math.abs(safePitch - 1) > 0.0005;
    let processedL = needsPitchShift
        ? pitchShiftBuffer({
            pitchShift: safePitch,
            input: resampledL,
            fftFrameSize: profile.fftSize,
            oversample: profile.oversample,
            sampleRate,
            windowType: profile.window
        })
        : resampledL;
    let processedR = needsPitchShift
        ? pitchShiftBuffer({
            pitchShift: safePitch,
            input: resampledR,
            fftFrameSize: profile.fftSize,
            oversample: profile.oversample,
            sampleRate,
            windowType: profile.window
        })
        : resampledR;

    if (profile.transientBlend > 0) {
        processedL = preserveTransients(processedL, resampledL, {
            blend: profile.transientBlend,
            sampleRate,
            windowMs: profile.transientSpanMs,
            threshold: analysis.transientThreshold
        });
        processedR = preserveTransients(processedR, resampledR, {
            blend: profile.transientBlend,
            sampleRate,
            windowMs: profile.transientSpanMs,
            threshold: analysis.transientThreshold
        });
    }

    if (profile.formantPreserve && Math.abs(safePitch - 1) > 0.01) {
        processedL = applyFormantCompensation(processedL, safePitch, sampleRate);
        processedR = applyFormantCompensation(processedR, safePitch, sampleRate);
    }

    return {
        bufferL: processedL,
        bufferR: processedR,
        lengthSamples: processedL.length,
        profile
    };
}

function analyzeSource(buffer, sampleRate) {
    const length = buffer.length;
    if (!length) {
        return { rms: 0, transientMetric: 0, isPercussive: false, transientThreshold: 0.2 };
    }
    let sumSquares = 0;
    let transientSum = 0;
    let prev = buffer[0];
    for (let i = 0; i < length; i++) {
        const value = buffer[i];
        sumSquares += value * value;
        transientSum += Math.abs(value - prev);
        prev = value;
    }
    const rms = Math.sqrt(sumSquares / length);
    const transientMetric = transientSum / length;
    const adjustedThreshold = clamp(transientMetric * 1.5, 0.05, 0.7);
    const isPercussive = transientMetric > 0.12 || rms < 0.02;
    return { rms, transientMetric, isPercussive, transientThreshold: adjustedThreshold };
}

function selectProcessingProfile({ analysis, safeSpeed, safePitch, overrides }) {
    const profile = { ...DEFAULT_PROFILE, ...overrides };
    if (analysis.isPercussive) {
        profile.fftSize = overrides?.fftSize || 2048;
        profile.oversample = overrides?.oversample || 8;
        profile.window = overrides?.window || 'hann';
        profile.transientBlend = overrides?.transientBlend ?? 0.8;
        profile.transientSpanMs = overrides?.transientSpanMs ?? 12;
        profile.resampleInterpolation = overrides?.resampleInterpolation || 'linear';
    }
    if (safePitch > 1.8 || safePitch < 0.6) {
        profile.fftSize = overrides?.fftSize || Math.min(8192, profile.fftSize * 2);
        profile.oversample = overrides?.oversample || Math.min(32, profile.oversample * 2);
    }
    if (safeSpeed !== 1 && !analysis.isPercussive) {
        profile.transientBlend = overrides?.transientBlend ?? 0.5;
    }
    return profile;
}

function resampleChannel(input, rate, mode = 'cubic') {
    if (!input || input.length === 0) {
        return new Float32Array(0);
    }
    if (Math.abs(rate - 1) < 0.0001) {
        return input.slice();
    }
    const outputLength = Math.max(1, Math.round(input.length / rate));
    const output = new Float32Array(outputLength);
    let position = 0;
    for (let i = 0; i < outputLength; i++) {
        const baseIndex = Math.floor(position);
        const frac = position - baseIndex;
        if (mode === 'cubic') {
            output[i] = interpolateHermite(input, baseIndex, frac);
        } else {
            const sampleA = input[baseIndex] ?? input[input.length - 1];
            const sampleB = input[baseIndex + 1] ?? input[input.length - 1];
            output[i] = sampleA + (sampleB - sampleA) * frac;
        }
        position += rate;
    }
    return output;
}

function interpolateHermite(buffer, index, frac) {
    const x0 = buffer[index - 1] ?? buffer[index] ?? 0;
    const x1 = buffer[index] ?? 0;
    const x2 = buffer[index + 1] ?? x1;
    const x3 = buffer[index + 2] ?? x2;
    const a = (-x0 + 3 * x1 - 3 * x2 + x3) / 2;
    const b = (x0 - 2 * x1 + x2);
    const c = (-x0 + x2) / 2;
    const d = x1;
    return ((a * frac + b) * frac + c) * frac + d;
}

function pitchShiftBuffer({ pitchShift, input, fftFrameSize, oversample, sampleRate, windowType = 'hann' }) {
    const numSamples = input.length;
    if (numSamples === 0 || Math.abs(pitchShift - 1) < 0.0005) {
        return input.slice();
    }

    const fftSize = Math.max(32, Math.pow(2, Math.round(Math.log2(Math.max(32, fftFrameSize)))));
    const oversampleSafe = Math.max(4, Math.round(oversample));
    const window = buildWindow(windowType, fftSize);
    const gInFIFO = new Float32Array(fftSize);
    const gOutFIFO = new Float32Array(fftSize);
    const gFFTworksp = new Float32Array(2 * fftSize);
    const gLastPhase = new Float32Array(fftSize / 2 + 1);
    const gSumPhase = new Float32Array(fftSize / 2 + 1);
    const gOutputAccum = new Float32Array(2 * fftSize);
    const gAnaMagn = new Float32Array(fftSize);
    const gAnaFreq = new Float32Array(fftSize);
    const gSynMagn = new Float32Array(fftSize);
    const gSynFreq = new Float32Array(fftSize);

    let gRover = 0;
    const out = new Float32Array(numSamples);

    const fftFrameSize2 = fftSize / 2;
    const stepSize = Math.floor(fftSize / oversampleSafe);
    const freqPerBin = sampleRate / fftSize;
    const expct = 2.0 * Math.PI * stepSize / fftSize;
    const inFifoLatency = fftSize - stepSize;
    if (gRover < inFifoLatency) {
        gRover = inFifoLatency;
    }

    for (let i = 0; i < numSamples; i++) {
        gInFIFO[gRover] = input[i];
        out[i] = gOutFIFO[gRover - inFifoLatency];
        gRover++;

        if (gRover >= fftSize) {
            gRover = inFifoLatency;

            for (let k = 0; k < fftSize; k++) {
                gFFTworksp[2 * k] = gInFIFO[k] * window[k];
                gFFTworksp[2 * k + 1] = 0.0;
            }

            shortTimeFourierTransform(gFFTworksp, fftSize, -1);

            for (let k = 0; k <= fftFrameSize2; k++) {
                const real = gFFTworksp[2 * k];
                const imag = gFFTworksp[2 * k + 1];
                let magn = 2.0 * Math.hypot(real, imag);
                let phase = Math.atan2(imag, real);

                let tmp = phase - gLastPhase[k];
                gLastPhase[k] = phase;
                tmp -= k * expct;
                let qpd = Math.floor(tmp / Math.PI);
                if (qpd >= 0) {
                    qpd += qpd & 1;
                } else {
                    qpd -= qpd & 1;
                }
                tmp -= Math.PI * qpd;
                tmp = oversampleSafe * tmp / (2.0 * Math.PI);
                tmp = k * freqPerBin + tmp * freqPerBin;

                gAnaMagn[k] = magn;
                gAnaFreq[k] = tmp;
            }

            gSynMagn.fill(0);
            gSynFreq.fill(0);
            for (let k = 0; k <= fftFrameSize2; k++) {
                const index = Math.floor(k * pitchShift);
                if (index <= fftFrameSize2) {
                    gSynMagn[index] += gAnaMagn[k];
                    gSynFreq[index] = gAnaFreq[k] * pitchShift;
                }
            }

            for (let k = 0; k <= fftFrameSize2; k++) {
                let magn = gSynMagn[k];
                let tmp = gSynFreq[k];
                tmp -= k * freqPerBin;
                tmp /= freqPerBin;
                tmp = 2.0 * Math.PI * tmp / oversampleSafe;
                tmp += k * expct;
                gSumPhase[k] += tmp;
                const phase = gSumPhase[k];
                gFFTworksp[2 * k] = magn * Math.cos(phase);
                gFFTworksp[2 * k + 1] = magn * Math.sin(phase);
            }

            for (let k = fftFrameSize2 + 1; k < fftSize; k++) {
                gFFTworksp[2 * k] = 0;
                gFFTworksp[2 * k + 1] = 0;
            }

            shortTimeFourierTransform(gFFTworksp, fftSize, 1);

            for (let k = 0; k < fftSize; k++) {
                gOutputAccum[k] += 2.0 * window[k] * gFFTworksp[2 * k] / (fftFrameSize2 * oversampleSafe);
            }
            for (let k = 0; k < stepSize; k++) {
                gOutFIFO[k] = gOutputAccum[k];
            }
            gOutputAccum.copyWithin(0, stepSize);
            gOutputAccum.fill(0, gOutputAccum.length - stepSize);
            gInFIFO.copyWithin(0, stepSize);
            gInFIFO.fill(0, fftSize - stepSize);
        }
    }

    return out;
}

function buildWindow(type, size) {
    const window = new Float32Array(size);
    switch ((type || '').toLowerCase()) {
        case 'blackman-harris':
            for (let i = 0; i < size; i++) {
                const phase = (2 * Math.PI * i) / (size - 1);
                window[i] = 0.35875 - 0.48829 * Math.cos(phase) + 0.14128 * Math.cos(2 * phase) - 0.01168 * Math.cos(3 * phase);
            }
            break;
        case 'hann':
        default:
            for (let i = 0; i < size; i++) {
                window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
            }
            break;
    }
    return window;
}

function preserveTransients(processed, reference, { blend, sampleRate, windowMs, threshold }) {
    if (!reference || reference.length === 0 || processed.length !== reference.length) {
        return processed;
    }
    const output = processed.slice();
    const windowSamples = Math.max(8, Math.floor((windowMs / 1000) * sampleRate));
    const transients = detectTransientWindows(reference, threshold || 0.2);
    if (!transients.length) {
        return output;
    }
    for (const { start, end } of transients) {
        for (let i = start; i < end; i++) {
            const rampIn = Math.min(1, (i - start) / windowSamples);
            const rampOut = Math.min(1, (end - i) / windowSamples);
            const weight = Math.min(rampIn, rampOut) * blend;
            output[i] = output[i] * (1 - weight) + reference[i] * weight;
        }
    }
    return output;
}

function detectTransientWindows(buffer, threshold) {
    const result = [];
    let start = -1;
    for (let i = 1; i < buffer.length; i++) {
        const delta = Math.abs(buffer[i] - buffer[i - 1]);
        if (delta >= threshold) {
            if (start === -1) {
                start = Math.max(0, i - 8);
            }
        } else if (start !== -1) {
            result.push({ start, end: Math.min(buffer.length, i + 8) });
            start = -1;
        }
    }
    if (start !== -1) {
        result.push({ start, end: Math.min(buffer.length, start + 16) });
    }
    return result;
}

function applyFormantCompensation(buffer, pitchRatio, sampleRate) {
    if (!buffer.length) return buffer;
    const output = buffer.slice();
    const logRatio = Math.log2(pitchRatio);
    const tiltDb = clamp(Math.abs(logRatio) * 14, 0, 12);
    const boostLow = pitchRatio > 1 ? tiltDb : -tiltDb;
    const boostHigh = -boostLow * 0.85;
    applyShelf(output, sampleRate, 350, boostLow, 'low');
    applyShelf(output, sampleRate, 4500, boostHigh, 'high');
    return output;
}

function applyShelf(buffer, sampleRate, cutoff, gainDb, type) {
    if (Math.abs(gainDb) < 0.1) return;
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * (cutoff / sampleRate);
    const alpha = Math.sin(w0) / Math.sqrt(2);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'low') {
        b0 = A * ((A + 1) - (A - 1) * Math.cos(w0) + 2 * Math.sqrt(A) * alpha);
        b1 = 2 * A * ((A - 1) - (A + 1) * Math.cos(w0));
        b2 = A * ((A + 1) - (A - 1) * Math.cos(w0) - 2 * Math.sqrt(A) * alpha);
        a0 = (A + 1) + (A - 1) * Math.cos(w0) + 2 * Math.sqrt(A) * alpha;
        a1 = -2 * ((A - 1) + (A + 1) * Math.cos(w0));
        a2 = (A + 1) + (A - 1) * Math.cos(w0) - 2 * Math.sqrt(A) * alpha;
    } else {
        b0 = A * ((A + 1) + (A - 1) * Math.cos(w0) + 2 * Math.sqrt(A) * alpha);
        b1 = -2 * A * ((A - 1) + (A + 1) * Math.cos(w0));
        b2 = A * ((A + 1) + (A - 1) * Math.cos(w0) - 2 * Math.sqrt(A) * alpha);
        a0 = (A + 1) - (A - 1) * Math.cos(w0) + 2 * Math.sqrt(A) * alpha;
        a1 = 2 * ((A - 1) - (A + 1) * Math.cos(w0));
        a2 = (A + 1) - (A - 1) * Math.cos(w0) - 2 * Math.sqrt(A) * alpha;
    }
    const y = buffer;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) {
        const x0 = y[i];
        const out = (b0 / a0) * x0 + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
        y[i] = out;
        x2 = x1;
        x1 = x0;
        y2 = y1;
        y1 = out;
    }
}

function shortTimeFourierTransform(buffer, frameSize, sign) {
    const doubleFrame = frameSize * 2;
    let i = 2;
    while (i < doubleFrame - 2) {
        let bitm = 2;
        let j = 0;
        while (bitm < doubleFrame) {
            if (i & bitm) {
                j++;
            }
            j <<= 1;
            bitm <<= 1;
        }
        if (i < j) {
            const tmpReal = buffer[i];
            const tmpImag = buffer[i + 1];
            buffer[i] = buffer[j];
            buffer[i + 1] = buffer[j + 1];
            buffer[j] = tmpReal;
            buffer[j + 1] = tmpImag;
        }
        i += 2;
    }

    let le = 2;
    const layers = Math.round(Math.log2(frameSize));
    for (let k = 0; k < layers; k++) {
        le <<= 1;
        const le2 = le >> 1;
        let ur = 1.0;
        let ui = 0.0;
        const arg = Math.PI / (le2 >> 1);
        const wr = Math.cos(arg);
        const wi = sign * Math.sin(arg);
        for (let j = 0; j < le2; j += 2) {
            for (let idx = j; idx < doubleFrame; idx += le) {
                const real = buffer[idx + le2];
                const imag = buffer[idx + le2 + 1];
                const tr = real * ur - imag * ui;
                const ti = real * ui + imag * ur;
                buffer[idx + le2] = buffer[idx] - tr;
                buffer[idx + le2 + 1] = buffer[idx + 1] - ti;
                buffer[idx] += tr;
                buffer[idx + 1] += ti;
            }
            const tmpUr = ur * wr - ui * wi;
            ui = ur * wi + ui * wr;
            ur = tmpUr;
        }
    }
}
