// This file handles the filter functionality, including cutoff frequency and resonance controls.

class Filter {
    constructor(audioContext) {
        this.audioContext = audioContext;
        this.filterNode = this.audioContext.createBiquadFilter();
        this.filterNode.type = 'lowpass'; // Default filter type
        this.cutoffFrequency = 440; // Default cutoff frequency in Hz
        this.resonance = 1; // Default resonance value
        this.updateFilter();
    }

    updateFilter() {
        this.filterNode.frequency.setValueAtTime(this.cutoffFrequency, this.audioContext.currentTime);
        this.filterNode.Q.setValueAtTime(this.resonance, this.audioContext.currentTime);
    }

    setCutoffFrequency(value) {
        this.cutoffFrequency = value;
        this.updateFilter();
    }

    setResonance(value) {
        this.resonance = value;
        this.updateFilter();
    }

    connect(destination) {
        this.filterNode.connect(destination);
    }

    disconnect() {
        this.filterNode.disconnect();
    }
}

// Export the Filter class for use in other modules
export default Filter;