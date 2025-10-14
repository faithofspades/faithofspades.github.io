export class MoogFilterNode extends AudioWorkletNode {
  constructor(audioContext, options = {}) {
    // Add adsrValue parameter to the default options
    const defaultOptions = {
      outputChannelCount: [2],
      parameterData: {
        cutoff: 1000,
        resonance: 0.0,
        drive: 1.0,
        saturation: 1.0,
        envelopeAmount: 0.0,
        keytrackAmount: 0.0,
        bassCompensation: 0.5,
        currentMidiNote: 69,
        adsrValue: 0.0 // Add this parameter for direct ADSR resonance following
      }
    };
    
    const nodeOptions = {
      ...defaultOptions,
      ...options
    };
    
    super(audioContext, 'moog-filter-processor', nodeOptions);
    
    this._currentMidiNote = 69;
    this._keytrackAmount = 0;
    this._envelopeAmount = 0;
    this._notePlaying = false;
    this._amplitudeGainNode = null;
    
    // Add ADSR polling interval
    this._adsrPollingInterval = null;
  }
  
  // Set the amplitude gain node to follow
  setAmplitudeGainNode(gainNode) {
    this._amplitudeGainNode = gainNode;
    console.log(`Filter ${this._currentMidiNote} now tracking amplitude gain node`);
    
    // Start ADSR polling when gain node is set
    this._startAdsrPolling();
  }
  _setupEnvelope() {
    // ADSR parameters for filter envelope
    this.attackTime = 0.01; // seconds
    this.decayTime = 0.1; // seconds
    this.sustainLevel = 0.5; // 0.0 to 1.0
    this.releaseTime = 0.5; // seconds
    
    // Envelope state
    this.envelopeStage = 'idle';
    this.envelopeValue = 0;
    this.envelopeStartTime = 0;
    this.envelopeReleaseTime = 0;
    
    // Setup envelope update interval
    this._startEnvelopeUpdate();
  }
  
  _startEnvelopeUpdate() {
    // Update envelope at regular intervals
    this._envelopeInterval = setInterval(() => {
      this._updateEnvelope();
    }, 5); // Update every 5ms for smooth envelope
  }
  
  _updateEnvelope() {
    if (this.envelopeStage === 'idle' && !this._notePlaying) return;
    
    const now = this.context.currentTime;
    let value = 0;
    
    switch (this.envelopeStage) {
      case 'attack':
        const attackProgress = (now - this.envelopeStartTime) / this.attackTime;
        if (attackProgress >= 1.0) {
          this.envelopeStage = 'decay';
          value = 1.0;
        } else {
          // CRITICAL FIX: Start from 0, not from previous value
          // Linear attack for now (can be changed to exponential if desired)
          value = attackProgress;
        }
        break;
        
      case 'decay':
        const decayProgress = (now - this.envelopeStartTime - this.attackTime) / this.decayTime;
        if (decayProgress >= 1.0) {
          this.envelopeStage = 'sustain';
          value = this.sustainLevel;
        } else {
          // Exponential decay curve
          value = this.sustainLevel + (1.0 - this.sustainLevel) * Math.exp(-decayProgress * 5);
        }
        break;
        
      case 'sustain':
        value = this.sustainLevel;
        break;
        
      case 'release':
        const releaseProgress = (now - this.envelopeReleaseTime) / this.releaseTime;
        if (releaseProgress >= 1.0) {
          this.envelopeStage = 'idle';
          value = 0;
        } else {
          // CRITICAL FIX: Release from the sustain level that was active
          value = this.sustainLevel * Math.exp(-releaseProgress * 5);
        }
        break;
        
      case 'idle':
      default:
        value = 0;
        break;
    }
    
    // Update the envelope value and apply to filter
    this.envelopeValue = value;
    this.parameters.get('envelopeAmount').value = this._envelopeAmount * value;
  }
  
  // Start polling the amplitude gain node to update the ADSR value
  _startAdsrPolling() {
    // Clear any existing interval
    if (this._adsrPollingInterval) {
      clearInterval(this._adsrPollingInterval);
    }
    
    // Poll every 5ms for smooth ADSR following
    this._adsrPollingInterval = setInterval(() => {
      this.updateFromAmplitude();
    }, 5);
  }
  
  // Update filter parameters from amplitude envelope
  updateFromAmplitude() {
    if (!this._amplitudeGainNode) return;
    
    try {
      // Get current gain value (the ADSR envelope value)
      const amplitudeValue = this._amplitudeGainNode.gain.value;
      
      // MODIFIED: Update adsrValue parameter instead of envelopeAmount
      // This directly controls resonance following in the processor
      this.parameters.get('adsrValue').value = amplitudeValue;
    } catch (e) {
      console.error('Error updating filter from amplitude:', e);
    }
  }
  
  // Simple note on - just updates note number for keytracking
  noteOn(midiNote, velocity = 1.0, retrigger = true, envelopeState = 'idle', currentEnvelopeValue = 0, isLegatoTransition = false) {
  this._currentMidiNote = midiNote;
  this._notePlaying = true;
  
  // Update the MIDI note parameter for keytracking
  this.parameters.get('currentMidiNote').value = midiNote;
  
  // CRITICAL FIX: Handle legato transitions differently
  if (isLegatoTransition || !retrigger) {
    console.log(`Filter legato transition to note ${midiNote} - maintaining current envelope`);
    
    // Don't clear the polling interval - just continue tracking the envelope
    // This ensures smooth legato transitions in mono mode
    if (!this._adsrPollingInterval) {
      this._startAdsrPolling(); // Make sure polling is active
    }
  } else {
    // Normal note on - start envelope tracking from beginning
    // Clear any existing interval first to restart clean
    if (this._adsrPollingInterval) {
      clearInterval(this._adsrPollingInterval);
      this._adsrPollingInterval = null;
    }
    
    // Start fresh polling
    this._startAdsrPolling();
    console.log(`Filter noteOn for note ${midiNote} - will follow amplitude envelope from beginning`);
  }
}
  
  // Simple note off - just marks as not playing
  noteOff() {
    this._notePlaying = false;
    console.log(`Filter noteOff - will continue following amplitude until it reaches 0`);
  }
  reset(targetValue = null, isVoiceSteal = false) {
  // For normal resets (not voice stealing), reset the filter processor state
  if (!isVoiceSteal) {
    this.port.postMessage({ type: 'reset' });
  }
  
  // Handle ADSR value differently based on whether this is a voice steal
  if (isVoiceSteal && targetValue !== null) {
    // Voice steal - transition smoothly from current value to the target
    const currentValue = this.parameters.get('adsrValue').value;
    const now = this.context.currentTime;
    
    // Rapid but smooth transition (5ms) to the new value
    this.parameters.get('adsrValue').cancelScheduledValues(now);
    this.parameters.get('adsrValue').setValueAtTime(currentValue, now);
    this.parameters.get('adsrValue').linearRampToValueAtTime(targetValue, now + 0.005);
    
    console.log(`Filter smoothly transitioning to new ADSR value ${targetValue.toFixed(2)} (voice steal)`);
  } else {
    // Normal reset (note end) - don't abruptly set to 0, let ADSR naturally complete
    // The voice's gain node tracking will gradually bring this to zero
  }
  
  // Reconnect to the amplitude gain node if there's a new one
  if (this._amplitudeGainNode) {
    const currentGainNode = this._amplitudeGainNode;
    
    // Brief tracking pause during transition to avoid glitches
    this._amplitudeGainNode = null;
    
    // Reconnect after a brief moment to continue tracking
    setTimeout(() => {
      this._amplitudeGainNode = currentGainNode;
    }, 5);
  }
}
  // Parameter setters
  setCutoff(value) {
  // FIXED: Accept 8Hz to 16000Hz range
  this.parameters.get('cutoff').value = Math.max(8, Math.min(16000, value));
}
setInputGain(value) {
  const param = this.parameters.get('inputGain');
  if (param) {
    param.setValueAtTime(value, this.context.currentTime);
  }
}
setResonance(value) {
  // FIXED: Accept 0.0 to 1.0 range (processor will map to Q)
  this.parameters.get('resonance').value = Math.max(0.0, Math.min(1.0, value));
}
  
  setDrive(value) {
    this.parameters.get('drive').value = Math.max(0.1, Math.min(5.0, value));
  }
  
  setSaturation(value) {
    this.parameters.get('saturation').value = Math.max(0.1, Math.min(10.0, value));
  }
  
  setBassCompensation(value) {
  // Already correct - accepts 0.0 to 1.0
  this.parameters.get('bassCompensation').value = Math.max(0.0, Math.min(1.0, value));
}
  
  setKeytrackAmount(value) {
    // Bipolar keytracking (-1.0 to 1.0)
    this._keytrackAmount = Math.max(-1.0, Math.min(1.0, value));
    this.parameters.get('keytrackAmount').value = this._keytrackAmount;
  }
  
  setEnvelopeAmount(value) {
  // Bipolar envelope amount (-1.0 to 1.0)
  this._envelopeAmount = Math.max(-1.0, Math.min(1.0, value));
  
  // CRITICAL FIX: Update the actual parameter in the processor
  // This was missing before - we were storing the value but not sending it
  this.parameters.get('envelopeAmount').setValueAtTime(
    this._envelopeAmount,
    this.context.currentTime
  );
  
  console.log(`MoogFilterNode: envelope amount set to ${this._envelopeAmount.toFixed(2)}`);
}
  
  // ADSR parameter setters
  setAttackTime(value) {
    this.attackTime = Math.max(0.001, value); // Minimum 1ms
  }
  
  setDecayTime(value) {
    this.decayTime = Math.max(0.001, value); // Minimum 1ms
  }
  
  setSustainLevel(value) {
    this.sustainLevel = Math.max(0.0, Math.min(1.0, value));
  }
  
  setReleaseTime(value) {
    this.releaseTime = Math.max(0.001, value); // Minimum 1ms
  }
  
  // Cleanup
  // Clean up resources when disconnected
  disconnect() {
    // Stop ADSR polling
    if (this._adsrPollingInterval) {
      clearInterval(this._adsrPollingInterval);
      this._adsrPollingInterval = null;
    }
    
    // Clear any other intervals
    if (this._envelopeInterval) {
      clearInterval(this._envelopeInterval);
    }
    
    super.disconnect();
  }
}

// Polyphonic wrapper for multiple filter instances
export class PolyphonicMoogFilter {
  constructor(audioContext, options = {}) {
    this.audioContext = audioContext;
    this.options = options;
    this.filters = new Map();
    
    // Default parameters
    this.cutoff = options.cutoff || 1000;
    this.resonance = options.resonance || 0.0;
    this.drive = options.drive || 1.0;
    this.saturation = options.saturation || 1.0;
    this.bassCompensation = options.bassCompensation || 0.5;
    this.keytrackAmount = options.keytrackAmount || 0.0;
    this.envelopeAmount = options.envelopeAmount || 0.0;
    
    // ADSR defaults
    this.attackTime = options.attackTime || 0.01;
    this.decayTime = options.decayTime || 0.1;
    this.sustainLevel = options.sustainLevel || 0.5;
    this.releaseTime = options.releaseTime || 0.5;
    
    // Load the AudioWorklet processor
    this._loadWorkletProcessor();
  }
  
  async _loadWorkletProcessor() {
  try {
    // Check if the worklet is already added
    if (!this._processorLoaded) {
      // Fix 1: Add proper path with 'js/' prefix if needed
      // Fix 2: Add error handling with a meaningful message
      try {
        await this.audioContext.audioWorklet.addModule('./js/moog-filter-processor.js');
        console.log("Successfully loaded moog-filter-processor.js");
        this._processorLoaded = true;
      } catch (loadError) {
        console.error('Failed to load with ./js/ path, trying relative path...');
        try {
          await this.audioContext.audioWorklet.addModule('moog-filter-processor.js');
          console.log("Successfully loaded using direct path");
          this._processorLoaded = true;
        } catch (secondError) {
          throw new Error(`Worklet load failed with both paths: ${secondError.message}`);
        }
      }
    }
  } catch (error) {
    console.error('Failed to load Moog filter AudioWorklet processor:', error);
    this._processorLoaded = false;
    throw error;
  }
}
  
  async noteOn(noteId, midiNote, velocity = 1.0) {
    // Make sure the processor is loaded
    if (!this._processorLoaded) {
      await this._loadWorkletProcessor();
    }
    
    // Create input/output gain nodes for this voice
    const inputGain = new GainNode(this.audioContext);
    const outputGain = new GainNode(this.audioContext);
    
    // Create filter node
    const filterNode = new MoogFilterNode(this.audioContext, {
      parameterData: {
        cutoff: this.cutoff,
        resonance: this.resonance,
        drive: this.drive,
        saturation: this.saturation,
        bassCompensation: this.bassCompensation,
        keytrackAmount: this.keytrackAmount,
        envelopeAmount: this.envelopeAmount,
        currentMidiNote: midiNote
      }
    });
    
    // Set ADSR parameters
    filterNode.setAttackTime(this.attackTime);
    filterNode.setDecayTime(this.decayTime);
    filterNode.setSustainLevel(this.sustainLevel);
    filterNode.setReleaseTime(this.releaseTime);
    
    // Connect the nodes
    inputGain.connect(filterNode);
    filterNode.connect(outputGain);
    
    // Trigger the filter envelope
    filterNode.noteOn(midiNote, velocity);
    
    // Store the filter instance and associated nodes
    this.filters.set(noteId, {
      filter: filterNode,
      input: inputGain,
      output: outputGain
    });
    
    return {
      input: inputGain,
      output: outputGain
    };
  }
  
  noteOff(noteId) {
    const filterData = this.filters.get(noteId);
    if (filterData) {
      filterData.filter.noteOff();
      
      // Remove the filter after release is complete
      setTimeout(() => {
        // Clean up connections
        filterData.filter.disconnect();
        filterData.input.disconnect();
        filterData.output.disconnect();
        
        // Remove from the map
        this.filters.delete(noteId);
      }, this.releaseTime * 1000 + 100); // Add small buffer
    }
  }
  
  // Global parameter setters
  setCutoff(value) {
    this.cutoff = value;
    this.filters.forEach(data => data.filter.setCutoff(value));
  }
  
  setResonance(value) {
    this.resonance = value;
    this.filters.forEach(data => data.filter.setResonance(value));
  }
  
  setDrive(value) {
    this.drive = value;
    this.filters.forEach(data => data.filter.setDrive(value));
  }
  
  setSaturation(value) {
    this.saturation = value;
    this.filters.forEach(data => data.filter.setSaturation(value));
  }
  
  setBassCompensation(value) {
    this.bassCompensation = value;
    this.filters.forEach(data => data.filter.setBassCompensation(value));
  }
  
  setKeytrackAmount(value) {
    this.keytrackAmount = value;
    this.filters.forEach(data => data.filter.setKeytrackAmount(value));
  }
  
  setEnvelopeAmount(value) {
    this.envelopeAmount = value;
    this.filters.forEach(data => data.filter.setEnvelopeAmount(value));
  }
  
  // ADSR parameter setters
  setAttackTime(value) {
    this.attackTime = value;
    this.filters.forEach(data => data.filter.setAttackTime(value));
  }
  
  setDecayTime(value) {
    this.decayTime = value;
    this.filters.forEach(data => data.filter.setDecayTime(value));
  }
  
  setSustainLevel(value) {
    this.sustainLevel = value;
    this.filters.forEach(data => data.filter.setSustainLevel(value));
  }
  
  setReleaseTime(value) {
    this.releaseTime = value;
    this.filters.forEach(data => data.filter.setReleaseTime(value));
  }
}