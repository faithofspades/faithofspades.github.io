// ms20.js  -- digital MS-20 style lowpass (12 dB) + highpass variant (6 dB)
// Uses bilinear one-pole sections (recommended) with a feedback (resonance) path.
// References: Stinchcombe (MS20_study) + Huovilainen thesis. :contentReference[oaicite:10]{index=10} :contentReference[oaicite:11]{index=11} :contentReference[oaicite:12]{index=12}

class OnePoleBL {
  constructor(sampleRate) {
    this.fs = sampleRate;
    this.x1 = 0; // x[n-1]
    this.y1 = 0; // y[n-1]
    // b and a correspond to Huovilainen's b = K/(K+1), a=(K-1)/(K+1)
    this.b = 0;
    this.a = 0;
  }

  // set cutoff freq in Hz
  setCutoff(fc) {
    const K = Math.tan(Math.PI * fc / this.fs);
    this.b = K / (K + 1);
    this.a = (K - 1) / (K + 1);
  }

  // process one sample: y[n] = b*(x[n] + x[n-1]) - a*y[n-1]
  process(x) {
    const y = this.b * (x + this.x1) - this.a * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }

  reset() { this.x1 = this.y1 = 0; }
}

// simple soft clipper approximating diode clipper from thesis
function sat(x, hi, lo) {
  if (x > hi) return hi;
  if (x < lo) return lo;
  return x;
}
function fclip(x, thres = 0.6) {
  // piecewise approx: 0.25x + 0.75*sat(x,thres,-thres)
  return 0.25 * x + 0.75 * sat(x, thres, -thres);
}

// MS-20 style structure: input -> stage1 -> stage2 -> output
// feedback: out_delayed * resonance_k is added into the bandpass/between stages
class MS20 {
  constructor(sampleRate) {
    this.fs = sampleRate;
    this.stage1 = new OnePoleBL(sampleRate);
    this.stage2 = new OnePoleBL(sampleRate);
    this.k = 0.0; // resonance feedback gain (0..~2 for analog; tune for digital)
    this.clipThreshold = 0.6;
    this.prevOut = 0; // unit delay in feedback path (important for realizability)
    this.inputMode = 'lowpass'; // 'lowpass' or 'highpass' (ms20 wiring)
  }

  setCutoff(fc) {
    this.stage1.setCutoff(fc);
    this.stage2.setCutoff(fc);
  }

  // set resonance control r in [0,1]; map to k (feedback gain)
  // Analog threshold ~2.0 -> self-oscillates; digital needs tuning (we choose safe mapping)
  setResonance(r) {
    // conservative mapping: 0..1 -> 0..2.5 (you may adjust maxK)
    const maxK = 2.5;
    this.k = r * maxK;
  }

  processSample(input) {
    // feedback signal is previous output, clipped (diode effect)
    const fb = this.k * fclip(this.prevOut, this.clipThreshold);

    // MS-20 feeds back into the bandpass/first stage path => subtract from input
    // (Some implementations add; sign convention may change polarity)
    const u = input - fb;

    const y1 = this.stage1.process(u);
    const y2 = this.stage2.process(y1);

    // store delayed output for next sample's feedback path
    this.prevOut = y2;

    if (this.inputMode === 'lowpass') {
      // 12 dB lowpass output = cascade of two 1-poles
      return y2;
    } else {
      // highpass variant used in MS20: feed input into C2 end (Korg wiring)
      // The Korg highpass wiring behaves like a 6dB/oct HP; quick MS20-style HP:
      // hp = input - (some gain * lowpass) ; here a simple subtraction gives approximate HP
      // (for exact MS20 highpass algebra see Stinchcombe derivation). :contentReference[oaicite:13]{index=13}
      return input - y2; // crude MS-20 style HP (6 dB)
    }
  }

  reset() {
    this.stage1.reset();
    this.stage2.reset();
    this.prevOut = 0;
  }
}

module.exports = { MS20, OnePoleBL, fclip };
// End of ms20.js
