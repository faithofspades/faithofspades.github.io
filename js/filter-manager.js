import { MoogFilterNode } from './moog-filter-node.js';

class FilterManager {
  constructor(audioContext) {
  this.audioCtx = audioContext;
  this.currentFilterType = 'lp24'; // DEFAULT to LP24 filter
  
  // Store persistent filter instances
  this.voiceFilters = new Map(); // voiceId -> filter instance
  
  // Global filter parameters with CORRECTED DEFAULTS
  this.cutoff = 16000; // DEFAULT: 16kHz (100% = no filtering)
  this.resonance = 0.0; // DEFAULT: 0% (no resonance)
  this.variant = 1.0; // DEFAULT: 50% (unity bass)
  this.keytrackAmount = 0.5; // DEFAULT: 50% (unity)
  this.envelopeAmount = 0.5; // DEFAULT: 50% (unity)
  this.drive = 1.0; // DEFAULT: unity gain (50% on slider)
  this.inputGain = 1.0;
  this.saturation = 1.0; // DEFAULT: no saturation
  
    
    // ADSR parameters
    this.attackTime = 0.01;
    this.decayTime = 0.1;
    this.sustainLevel = 0.5;
    this.releaseTime = 0.5;
    
    this.isActive = true; // ALWAYS ACTIVE with LP24 as default
    this._processorLoaded = false;
    
    // Load worklet processor
    this._loadWorkletProcessor();
    
    console.log("Polyphonic Moog filter manager initialized with LP24 filter active");
  }
  
  async _loadWorkletProcessor() {
    try {
      if (!this._processorLoaded) {
        try {
          await this.audioCtx.audioWorklet.addModule('./js/moog-filter-processor.js');
          console.log("Successfully loaded moog-filter-processor.js");
          this._processorLoaded = true;
        } catch (loadError) {
          console.error('Failed to load with ./js/ path, trying relative path...');
          await this.audioCtx.audioWorklet.addModule('moog-filter-processor.js');
          console.log("Successfully loaded using direct path");
          this._processorLoaded = true;
        }
      }
    } catch (error) {
      console.error('Failed to load Moog filter AudioWorklet processor:', error);
      this._processorLoaded = false;
    }
  }
  setInputGain(normalizedValue) {
  // CORRECTED: Map 0-1 to input gain range (0.0-2.0)
  // At 0%, input gain = 0.0 (silence)
  // At 50%, input gain = 1.0 (original unmodified level)
  // At 100%, input gain = 2.0 (2x boost)
  this.inputGain = normalizedValue * 2.0;
  
  this.voiceFilters.forEach((filterData) => {
    if (filterData.filterNode instanceof MoogFilterNode) {
      filterData.filterNode.setInputGain(this.inputGain);
    }
  });
  
  if (normalizedValue < 0.45) {
    console.log(`Filter input gain set to ${(normalizedValue * 100).toFixed(0)}% (attenuated)`);
  } else if (normalizedValue > 0.55) {
    console.log(`Filter input gain set to ${(normalizedValue * 100).toFixed(0)}% (boosted)`);
  } else {
    console.log(`Filter input gain set to original level (50%)`);
  }
}

// Update createPersistentFilter to initialize with the correct input gain
async createPersistentFilter(voiceId) {
  // Wait for processor to load
  if (!this._processorLoaded) {
    await this._loadWorkletProcessor();
  }
  
  if (!this._processorLoaded) {
    console.error(`Cannot create filter for ${voiceId}: processor not loaded`);
    return this.createFallbackFilter(voiceId);
  }
  
  try {
    // Create the AudioWorklet filter node
    const filterNode = new MoogFilterNode(this.audioCtx, {
      parameterData: {
        cutoff: this.cutoff,
        resonance: this.resonance,
        drive: this.drive,
        saturation: this.saturation,
        bassCompensation: this.variant,
        keytrackAmount: (this.keytrackAmount - 0.5) * 2, // Bipolar
        envelopeAmount: (this.envelopeAmount - 0.5) * 2, // Bipolar
        currentMidiNote: 69,
        inputGain: this.inputGain // Add inputGain parameter
      }
    });
    
    // Set ADSR parameters
    filterNode.setAttackTime(this.attackTime);
    filterNode.setDecayTime(this.decayTime);
    filterNode.setSustainLevel(this.sustainLevel);
    filterNode.setReleaseTime(this.releaseTime);
    
    // Store the filter instance
    this.voiceFilters.set(voiceId, {
      filterNode: filterNode,
      active: true,
      currentNote: null,
      type: voiceId.startsWith('sampler-') ? 'sampler' : 'osc' // Add type tracking
    });
    
    console.log(`Created persistent Moog LP24 filter for voice ${voiceId}`);
    return filterNode;
    
  } catch (error) {
    console.error(`Failed to create AudioWorklet filter for voice ${voiceId}:`, error);
    return this.createFallbackFilter(voiceId);
  }
}
  
  createFallbackFilter(voiceId) {
    console.log(`Creating fallback ScriptProcessor filter for voice ${voiceId}`);
    
    const processorNode = this.audioCtx.createScriptProcessor(1024, 1, 1);
    
    const filter = {
      cutoff: this.cutoff,
      resonance: this.resonance / 4,
      stage: [0, 0, 0, 0],
      delay: [0, 0, 0, 0],
      
      calculateCoefficient() {
        return Math.min(0.99, Math.max(0.01, 
          2 * Math.sin(Math.PI * this.cutoff / 44100)));
      },
      
      process(input) {
        const coeff = this.calculateCoefficient();
        let x = input - this.resonance * this.delay[3];
        
        for (let i = 0; i < 4; i++) {
          this.stage[i] = this.delay[i] + coeff * (x - this.delay[i]);
          x = this.stage[i];
          this.delay[i] = this.stage[i];
        }
        
        return x;
      }
    };
    
    processorNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const output = e.outputBuffer.getChannelData(0);
      
      for (let i = 0; i < input.length; i++) {
        output[i] = filter.process(input[i]);
      }
    };
    
    this.voiceFilters.set(voiceId, {
      filterNode: processorNode,
      processorNode: processorNode,
      filterInstance: filter,
      active: true,
      currentNote: null
    });
    
    return processorNode;
  }
  
  // Get the existing filter for a voice
  getFilter(voiceId) {
    const filterData = this.voiceFilters.get(voiceId);
    return filterData ? filterData.filterNode : null;
  }
  setAmplitudeGainNode(voiceId, gainNode) {
  const filterData = this.voiceFilters.get(voiceId);
  if (filterData && filterData.filterNode instanceof MoogFilterNode) {
    filterData.filterNode.setAmplitudeGainNode(gainNode);
    filterData.amplitudeGainNode = gainNode;
    
    // Start the update loop for this filter if not already started
    if (!filterData.updateInterval) {
      filterData.updateInterval = setInterval(() => {
        filterData.filterNode.updateFromAmplitude();
      }, 5); // Update every 5ms
    }
    
    console.log(`Filter ${voiceId} now tracking amplitude gain node`);
  }
}
  // Add this method to the FilterManager class
connectVoiceEnvelope(voiceId, voiceGainNode) {
  const filterData = this.voiceFilters.get(voiceId);
  if (filterData && filterData.filterNode instanceof MoogFilterNode) {
    filterData.filterNode.setAmplitudeGainNode(voiceGainNode);
    
    // Start automatic envelope tracking
    if (!filterData.updateInterval) {
      filterData.updateInterval = setInterval(() => {
        filterData.filterNode.updateFromAmplitude();
      }, 5); // Poll every 5ms for smooth envelope following
    }
    
    console.log(`Filter for ${voiceId} now tracking voice envelope`);
  }
}

// Also update the noteOn method to synchronize filter ADSR with voice ADSR
noteOn(voiceId, noteNumber, velocity = 1, retrigger = true, envelopeState = 'idle', currentEnvelopeValue = 0) {
  const filterData = this.voiceFilters.get(voiceId);
  if (filterData) {
    filterData.currentNote = noteNumber;
    
    // Update MIDI note parameter for keytracking
    if (filterData.filterNode instanceof MoogFilterNode) {
      // Pass envelope state and current value to ensure filter ADSR stays synchronized
      filterData.filterNode.noteOn(noteNumber, velocity, retrigger, envelopeState, currentEnvelopeValue);
    }
    
    console.log(`Filter noteOn for voice ${voiceId}, note ${noteNumber}, retrigger=${retrigger}, state=${envelopeState}`);
  }
}

// Update noteOff to properly handle release phase
noteOff(voiceId, reset = false) {
  const filterData = this.voiceFilters.get(voiceId);
  if (filterData && filterData.filterNode instanceof MoogFilterNode) {
    filterData.filterNode.noteOff();
    console.log(`Filter noteOff for voice ${voiceId} - resonance will fade with release`);
  }
}
  resetFilterEnvelope(voiceId, targetAdsrValue = null, isVoiceSteal = false) {
  const filterData = this.voiceFilters.get(voiceId);
  if (filterData && filterData.filterNode instanceof MoogFilterNode) {
    // Pass the voice steal flag and target ADSR value
    filterData.filterNode.reset(targetAdsrValue, isVoiceSteal);
    
    if (isVoiceSteal) {
      console.log(`Smoothly transitioning filter ${voiceId} for voice steal`);
    } else {
      console.log(`Reset filter envelope for voice ${voiceId}`);
    }
  }
}
handleVoiceSteal(stolenVoiceId, newGainNode, targetAdsrValue) {
  const filterData = this.voiceFilters.get(stolenVoiceId);
  if (filterData && filterData.filterNode instanceof MoogFilterNode) {
    // First smoothly transition the ADSR value
    filterData.filterNode.reset(targetAdsrValue, true);
    
    // Then update the amplitude gain node to track
    // Allow a small delay for the transition to start
    setTimeout(() => {
      filterData.filterNode.setAmplitudeGainNode(newGainNode);
    }, 5);
    
    console.log(`Filter for stolen voice ${stolenVoiceId} now tracking new gain node`);
  }
}
  // Set cutoff frequency (0-1 normalized value)
  setCutoff(frequency) {
  // Directly use the frequency value, just ensure it's within valid range
  this.cutoff = Math.max(8, Math.min(16000, frequency));
  
  this.voiceFilters.forEach((filterData) => {
    if (filterData.filterNode instanceof MoogFilterNode) {
      filterData.filterNode.setCutoff(this.cutoff);
    } else if (filterData.filterInstance) {
      filterData.filterInstance.cutoff = this.cutoff;
    }
  });
  
  console.log(`Filter cutoff set to ${this.cutoff.toFixed(1)}Hz`);
}
  
  // Set resonance (0-1 normalized value)
  setResonance(normalizedValue) {
  // FIXED: Map 0-1 directly to 0-1 range (processor will map to Q internally)
  // The processor maps: 0 = Q of 1, 1 = Q of 40
  this.resonance = normalizedValue;
  
  this.voiceFilters.forEach((filterData) => {
    if (filterData.filterNode instanceof MoogFilterNode) {
      filterData.filterNode.setResonance(this.resonance);
    } else if (filterData.filterInstance) {
      filterData.filterInstance.resonance = this.resonance / 4;
    }
  });
  
  console.log(`Filter resonance set to ${this.resonance.toFixed(2)} (Q: ${(1 + this.resonance * 39).toFixed(1)})`);
}

  
  // Set drive amount (0-1 normalized value)
  setDrive(normalizedValue) {
  // Map 0-1 to drive range (1.0-5.0)
  // At 0%, drive = 1.0 (unity gain/no overdrive)
  // At 100%, drive = 5.0 (maximum overdrive)
  this.drive = 1.0 + normalizedValue * 4.0;
  
  this.voiceFilters.forEach((filterData) => {
    if (filterData.filterNode instanceof MoogFilterNode) {
      filterData.filterNode.setDrive(this.drive);
    }
  });
  
  console.log(`Filter drive set to ${this.drive.toFixed(2)} (${(normalizedValue * 100).toFixed(0)}%)`);
}
  
  // Set variant amount (0-1 normalized value)
  setVariant(normalizedValue) {
  // FIXED: Bass compensation behavior
  // 0.0 = full bandpass (cut lows completely)
  // 0.5 = unity (no compensation)
  // 1.0 = boost bass to compensate for resonance volume loss
  this.variant = normalizedValue;
  
  this.voiceFilters.forEach((filterData) => {
    if (filterData.filterNode instanceof MoogFilterNode) {
      filterData.filterNode.setBassCompensation(normalizedValue);
    }
  });
  
  if (normalizedValue < 0.5) {
    const bandpassAmount = ((0.5 - normalizedValue) / 0.5 * 100).toFixed(0);
    console.log(`Filter bass compensation: ${bandpassAmount}% bandpass (cutting lows)`);
  } else if (normalizedValue > 0.5) {
    const boostAmount = ((normalizedValue - 0.5) / 0.5 * 100).toFixed(0);
    console.log(`Filter bass compensation: ${boostAmount}% bass boost`);
  } else {
    console.log(`Filter bass compensation: Unity (no compensation)`);
  }
}
  
  // Set envelope amount (0-1 normalized value)
  setEnvelopeAmount(normalizedValue) {
    this.envelopeAmount = normalizedValue;
    const bipolarValue = (normalizedValue - 0.5) * 2;
    
    this.voiceFilters.forEach((filterData) => {
      if (filterData.filterNode instanceof MoogFilterNode) {
        filterData.filterNode.setEnvelopeAmount(bipolarValue);
      }
    });
    
    console.log(`Filter envelope amount set to ${normalizedValue.toFixed(2)}`);
  }
  
  // Set key tracking amount (0-1 normalized value)
  setKeytrackAmount(normalizedValue) {
    this.keytrackAmount = normalizedValue;
    const bipolarValue = (normalizedValue - 0.5) * 2;
    
    this.voiceFilters.forEach((filterData) => {
      if (filterData.filterNode instanceof MoogFilterNode) {
        filterData.filterNode.setKeytrackAmount(bipolarValue);
      }
    });
    
    console.log(`Filter keytrack amount set to ${normalizedValue.toFixed(2)}`);
  }
  
  // Set ADSR parameters
  setADSR(attack, decay, sustain, release) {
    this.attackTime = attack;
    this.decayTime = decay;
    this.sustainLevel = sustain;
    this.releaseTime = release;
    
    this.voiceFilters.forEach((filterData) => {
      if (filterData.filterNode instanceof MoogFilterNode) {
        filterData.filterNode.setAttackTime(attack);
        filterData.filterNode.setDecayTime(decay);
        filterData.filterNode.setSustainLevel(sustain);
        filterData.filterNode.setReleaseTime(release);
      }
    });
    
    console.log(`Filter ADSR set to A:${attack}s D:${decay}s S:${sustain} R:${release}s`);
  }
  
  // Clean up all filters (call on shutdown)
  destroy() {
  this.voiceFilters.forEach((filterData, voiceId) => {
    if (filterData.updateInterval) {
      clearInterval(filterData.updateInterval);
    }
    try {
      filterData.filterNode.disconnect();
    } catch (e) {
      // Ignore
    }
  });
  this.voiceFilters.clear();
}
}

export default FilterManager;