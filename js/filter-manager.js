// Add imports for all filter types
import { MoogFilterNode } from './moog-filter-node.js';
import { LP12FilterNode } from './LP-12-filter-node.js';
import { LH12FilterNode } from './lh-12-filter-node.js';
import { LH18FilterNode } from './lh-18-filter-node.js';
import { LH24FilterNode } from './lh-24-filter-node.js';
class FilterManager {
  constructor(audioContext) {
    this.audioCtx = audioContext;
    this.currentFilterType = 'lp24'; // DEFAULT to LP24 filter
    
    // Store persistent filter instances - each voice will have THREE filters
    this.voiceFilters = new Map(); // voiceId -> filter data
    
    // Global filter parameters
    this.cutoff = 16000;
    this.resonance = 0.0;
    this.variant = 1.0;
    this.keytrackAmount = 0.5;
    this.envelopeAmount = 0.5;
    this.drive = 0.5; // Initialize to 0.5 to match UI slider default (50% = unity gain for LH18)
    this.inputGain = 1.0;
    this.saturation = 1.0;
    
    // ADSR parameters
    this.attackTime = 0.01;
    this.decayTime = 0.1;
    this.sustainLevel = 0.5;
    this.releaseTime = 0.5;
    
    this.isActive = true;
    this._loadedProcessors = new Set(); // Track which processors have been loaded
    
    // Load only the default filter processor on startup
    this._loadWorkletProcessor('lp24');
    
    console.log("Filter manager initialized with LP24 filter (lazy loading enabled)");
  }
  
  // Load specific processor type on-demand
  async _loadWorkletProcessor(filterType) {
    // Map filter types to their processor files
    const processorMap = {
      'lp24': './js/moog-filter-processor.js',
      'lp12': './js/LP-12-filter-processor.js',
      'lh12': './js/lh-12-filter-processor.js',
      'lh18': './js/lh-18-filter-processor.js',
      'lh24': './js/lh-24-filter-processor.js'
    };
    
    // Check if already loaded
    if (this._loadedProcessors.has(filterType)) {
      return true;
    }
    
    const processorPath = processorMap[filterType];
    if (!processorPath) {
      console.error(`Unknown filter type: ${filterType}`);
      return false;
    }
    
    try {
      // Try with ./js/ path first
      await this.audioCtx.audioWorklet.addModule(processorPath);
      this._loadedProcessors.add(filterType);
      console.log(`Loaded ${filterType} filter processor on-demand`);
      return true;
    } catch (loadError) {
      // Try without ./js/ prefix
      try {
        const fallbackPath = processorPath.replace('./js/', '');
        await this.audioCtx.audioWorklet.addModule(fallbackPath);
        this._loadedProcessors.add(filterType);
        console.log(`Loaded ${filterType} filter processor (fallback path)`);
        return true;
      } catch (secondError) {
        console.error(`Failed to load ${filterType} processor:`, secondError);
        return false;
      }
    }
  }

  // Set filter type - now switches connections between existing filters
  async setFilterType(type) {
    if (type === this.currentFilterType) return; // No change

    const validTypes = ['lp24', 'lp12', 'lh12', 'lh18', 'lh24'];
    if (!validTypes.includes(type)) {
      console.error(`Invalid filter type: ${type}. Using LP24 instead.`);
      type = 'lp24';
    }

    // Load the processor if not already loaded
    await this._loadWorkletProcessor(type);

    const oldType = this.currentFilterType;
    this.currentFilterType = type;
    console.log(`Filter type changed to: ${type} from ${oldType}`);

    // Switch connections for all voices (will create filters on-demand)
    this.switchFilterConnections();
  }

  // Switch connections between filter types (creates new filter on-demand if needed)
  switchFilterConnections() {
  const crossfadeDuration = 0.02; // 20ms crossfade
  const now = this.audioCtx.currentTime;
  
  this.voiceFilters.forEach((filterData, voiceId) => {
    const inputNode = filterData.inputNode;
    const outputNode = filterData.outputNode;
    
    if (!inputNode || !outputNode) return;
    
    try {
      // Check if new filter type already exists
      const filterKey = `${this.currentFilterType}Filter`;
      let newFilter = filterData[filterKey];
      
      if (!newFilter) {
        // Create new filter on-demand
        console.log(`Creating ${this.currentFilterType} filter on-demand for ${voiceId}`);
        newFilter = this._createSingleFilter(this.currentFilterType, voiceId);
        filterData[filterKey] = newFilter;
        
        // Connect new filter
        inputNode.connect(newFilter);
        newFilter.connect(outputNode);
        
        // Update note state if voice is currently playing
        if (filterData.currentNote !== null) {
          newFilter.noteOn(filterData.currentNote, 1.0, false);
        }
      }
      
      // Crossfade from old to new filter
      const oldFilter = filterData.activeFilter;
      
      if (oldFilter && oldFilter !== newFilter) {
        // Create temporary gain nodes for crossfade
        const oldGain = this.audioCtx.createGain();
        const newGain = this.audioCtx.createGain();
        
        oldGain.gain.setValueAtTime(1, now);
        newGain.gain.setValueAtTime(0, now);
        
        // Disconnect and reconnect through gain nodes
        oldFilter.disconnect();
        newFilter.disconnect();
        
        oldFilter.connect(oldGain);
        newFilter.connect(newGain);
        
        oldGain.connect(outputNode);
        newGain.connect(outputNode);
        
        // Crossfade
        oldGain.gain.linearRampToValueAtTime(0, now + crossfadeDuration);
        newGain.gain.linearRampToValueAtTime(1, now + crossfadeDuration);
        
        // After crossfade, clean up old gain node and reconnect new filter directly
        setTimeout(() => {
          try {
            oldGain.disconnect();
            newGain.disconnect();
            newFilter.connect(outputNode);
          } catch (e) {
            console.warn(`Cleanup error for ${voiceId}:`, e);
          }
        }, (crossfadeDuration + 0.01) * 1000);
      }
      
      // Update active filter reference
      filterData.activeFilter = newFilter;
      
      console.log(`Switched ${voiceId} to ${this.currentFilterType} filter`);
      
    } catch (err) {
      console.error(`Error switching filters for voice ${voiceId}:`, err);
    }
  });
}

  // Helper: Create a single filter of specified type
  _createSingleFilter(filterType, voiceId) {
    const baseParams = {
      cutoff: this.cutoff,
      resonance: this.resonance,
      saturation: this.saturation,
      bassCompensation: this.variant,
      keytrackAmount: (this.keytrackAmount - 0.5) * 2,
      envelopeAmount: (this.envelopeAmount - 0.5) * 2,
      currentMidiNote: 69,
      inputGain: this.inputGain
    };
    
    let filter;
    switch (filterType) {
      case 'lp24':
        filter = new MoogFilterNode(this.audioCtx, {
          parameterData: { ...baseParams, drive: this.drive }
        });
        break;
      case 'lp12':
        filter = new LP12FilterNode(this.audioCtx, {
          parameterData: { ...baseParams, drive: 0.0 }
        });
        break;
      case 'lh12':
        filter = new LH12FilterNode(this.audioCtx, {
          parameterData: { ...baseParams, drive: 0.0 }
        });
        break;
      case 'lh18':
        const lh18DriveValue = 0.1 + this.drive * 4.9;
        filter = new LH18FilterNode(this.audioCtx, {
          parameterData: { ...baseParams, drive: lh18DriveValue }
        });
        break;
      case 'lh24':
        filter = new LH24FilterNode(this.audioCtx, {
          parameterData: {
            ...baseParams,
            drive: this.drive,
            variant: this.variant,
            adsrValue: 0.0,
            classicMode: this.classicMode || 0.0,
            sustainLevel: this.sustainLevel || 1.0
          }
        });
        break;
      default:
        throw new Error(`Unknown filter type: ${filterType}`);
    }
    
    // Set ADSR parameters
    filter.setAttackTime(this.attackTime);
    filter.setDecayTime(this.decayTime);
    filter.setSustainLevel(this.sustainLevel);
    filter.setReleaseTime(this.releaseTime);
    
    return filter;
  }

  // Create ONLY the currently active filter for each voice (optimized for mobile)
  async createPersistentFilter(voiceId) {
  // Wait for current filter's processor to load
  if (!this._loadedProcessors.has(this.currentFilterType)) {
    await this._loadWorkletProcessor(this.currentFilterType);
  }
  
  if (!this._loadedProcessors.has(this.currentFilterType)) {
    console.error(`Cannot create filter for ${voiceId}: processor not loaded`);
    return this.createFallbackFilter(voiceId);
  }
  
  try {
    // Create ONLY the active filter type (huge performance win on mobile!)
    const activeFilter = this._createSingleFilter(this.currentFilterType, voiceId);
    
    // Create mixer nodes for input and output
    const inputNode = new GainNode(this.audioCtx);
    const outputNode = new GainNode(this.audioCtx);
    
    // Simple direct connection - no need for crossfade gains on first creation
    inputNode.connect(activeFilter);
    activeFilter.connect(outputNode);
    
    // Store filter data - only stores active filter initially
    const filterData = {
      activeFilter,
      inputNode,
      outputNode,
      active: true,
      currentNote: null,
      type: voiceId.startsWith('sampler-') ? 'sampler' : 'osc'
    };
    
    // Initialize storage for other filter types (created on-demand)
    filterData[`${this.currentFilterType}Filter`] = activeFilter;
    
    this.voiceFilters.set(voiceId, filterData);
    
    console.log(`Created optimized single-filter (${this.currentFilterType}) for voice ${voiceId}`);
    return inputNode;
    
  } catch (error) {
    console.error(`Failed to create AudioWorklet filter for voice ${voiceId}:`, error);
    return this.createFallbackFilter(voiceId);
  }
}
  
  // Get the input node for connecting to filter
  getFilterInput(voiceId) {
    const filterData = this.voiceFilters.get(voiceId);
    return filterData ? filterData.inputNode : null;
  }
  
  // Get the output node for connecting from filter
  getFilterOutput(voiceId) {
    const filterData = this.voiceFilters.get(voiceId);
    return filterData ? filterData.outputNode : null;
  }
  
  // Update parameter methods must update BOTH filters
  
  setCutoff(frequency) {
    this.cutoff = Math.max(8, Math.min(16000, frequency));
    
    this.voiceFilters.forEach((filterData) => {
      if (filterData.lp24Filter) {
        filterData.lp24Filter.setCutoff(this.cutoff);
      }
      if (filterData.lp12Filter) {
        filterData.lp12Filter.setCutoff(this.cutoff);
      }
      if (filterData.lh12Filter) {
        filterData.lh12Filter.setCutoff(this.cutoff);
      }
      if (filterData.lh18Filter) {
        filterData.lh18Filter.setCutoff(this.cutoff);
      }
      if (filterData.lh24Filter) {
        filterData.lh24Filter.setCutoff(this.cutoff);
      }
    });
    
    console.log(`Filter cutoff set to ${this.cutoff.toFixed(1)}Hz`);
  }
  
  setResonance(normalizedValue) {
    this.resonance = normalizedValue;
    
    this.voiceFilters.forEach((filterData) => {
      if (filterData.lp24Filter) {
        filterData.lp24Filter.setResonance(this.resonance);
      }
      if (filterData.lp12Filter) {
        filterData.lp12Filter.setResonance(this.resonance);
      }
      if (filterData.lh12Filter) {
        filterData.lh12Filter.setResonance(this.resonance);
      }
      if (filterData.lh18Filter) {
        filterData.lh18Filter.setResonance(this.resonance);
      }
      if (filterData.lh24Filter) {
        filterData.lh24Filter.setResonance(this.resonance);
      }
    });
    
    console.log(`Filter resonance set to ${this.resonance.toFixed(2)}`);
  }
  
  setDrive(normalizedValue) {
  this.drive = normalizedValue; // Store raw value, don't apply scaling
  
  let lh18Count = 0;
  this.voiceFilters.forEach((filterData, voiceId) => {
    if (filterData.lp24Filter) {
      // Only scale drive for LP24 filter
      filterData.lp24Filter.setDrive(1.0 + normalizedValue * 4.0);
    }
    if (filterData.lp12Filter) {
      // For LP12, pass the raw value - it will be used for diode amount
      filterData.lp12Filter.setDrive(normalizedValue);
    }
    if (filterData.lh12Filter) {
      // For LH12, pass the raw value - unused (reserved for future)
      filterData.lh12Filter.setDrive(normalizedValue);
    }
    if (filterData.lh18Filter) {
      // For LH18, scale 0-1 to 0.1-5.0 range expected by AudioParam
      const scaledValue = 0.1 + normalizedValue * 4.9;
      console.log(`[${voiceId}] Calling lh18Filter.setDrive(${scaledValue.toFixed(3)}) from normalized ${normalizedValue.toFixed(3)}`);
      filterData.lh18Filter.setDrive(scaledValue);
      lh18Count++;
    }
    if (filterData.lh24Filter) {
      // For LH24, scale same as LP24
      filterData.lh24Filter.setDrive(1.0 + normalizedValue * 4.0);
    }
  });
  
  console.log(`Filter drive set to ${normalizedValue.toFixed(2)} - updated ${lh18Count} LH18 filters`);
}
  
  setVariant(normalizedValue) {
    this.variant = normalizedValue;
    
    this.voiceFilters.forEach((filterData) => {
      if (filterData.lp24Filter) {
        filterData.lp24Filter.setBassCompensation(normalizedValue);
      }
      if (filterData.lp12Filter) {
        filterData.lp12Filter.setBassCompensation(normalizedValue);
      }
      if (filterData.lh12Filter) {
        filterData.lh12Filter.setBassCompensation(normalizedValue);
      }
      if (filterData.lh18Filter) {
        filterData.lh18Filter.setBassCompensation(normalizedValue);
      }
      if (filterData.lh24Filter) {
        // LH-24 has bass compensation fixed at 1.0, variant controls HP cutoff
        filterData.lh24Filter.setVariant(normalizedValue);
      }
    });
    
    console.log(`Filter variant set to ${this.variant.toFixed(2)}`);
  }
  
  setEnvelopeAmount(normalizedValue) {
    this.envelopeAmount = normalizedValue;
    const bipolarValue = (normalizedValue - 0.5) * 2;
    
    this.voiceFilters.forEach((filterData) => {
      if (filterData.lp24Filter) {
        filterData.lp24Filter.setEnvelopeAmount(bipolarValue);
      }
      if (filterData.lp12Filter) {
        filterData.lp12Filter.setEnvelopeAmount(bipolarValue);
      }
      if (filterData.lh12Filter) {
        filterData.lh12Filter.setEnvelopeAmount(bipolarValue);
      }
      if (filterData.lh18Filter) {
        filterData.lh18Filter.setEnvelopeAmount(bipolarValue);
      }
      if (filterData.lh24Filter) {
        filterData.lh24Filter.setEnvelopeAmount(bipolarValue);
      }
    });
    
    console.log(`Filter envelope amount set to ${normalizedValue.toFixed(2)}`);
  }
  
  setKeytrackAmount(normalizedValue) {
    this.keytrackAmount = normalizedValue;
    const bipolarValue = (normalizedValue - 0.5) * 2;
    
    this.voiceFilters.forEach((filterData) => {
      if (filterData.lp24Filter) {
        filterData.lp24Filter.setKeytrackAmount(bipolarValue);
      }
      if (filterData.lp12Filter) {
        filterData.lp12Filter.setKeytrackAmount(bipolarValue);
      }
      if (filterData.lh12Filter) {
        filterData.lh12Filter.setKeytrackAmount(bipolarValue);
      }
      if (filterData.lh18Filter) {
        filterData.lh18Filter.setKeytrackAmount(bipolarValue);
      }
      if (filterData.lh24Filter) {
        filterData.lh24Filter.setKeytrackAmount(bipolarValue);
      }
    });
    
    console.log(`Filter keytrack amount set to ${normalizedValue.toFixed(2)}`);
  }
  
  setADSR(attack, decay, sustain, release, classicMode = false) {
    this.attackTime = attack;
    this.decayTime = decay;
    this.sustainLevel = sustain;
    this.releaseTime = release;
    this.classicMode = classicMode; // Store classic mode state
    
    this.voiceFilters.forEach((filterData) => {
      if (filterData.lp24Filter) {
        filterData.lp24Filter.setAttackTime(attack);
        filterData.lp24Filter.setDecayTime(decay);
        filterData.lp24Filter.setSustainLevel(sustain);
        filterData.lp24Filter.setReleaseTime(release);
        filterData.lp24Filter.setClassicMode(classicMode);
      }
      if (filterData.lp12Filter) {
        filterData.lp12Filter.setAttackTime(attack);
        filterData.lp12Filter.setDecayTime(decay);
        filterData.lp12Filter.setSustainLevel(sustain);
        filterData.lp12Filter.setReleaseTime(release);
        filterData.lp12Filter.setClassicMode(classicMode);
      }
      if (filterData.lh12Filter) {
        filterData.lh12Filter.setAttackTime(attack);
        filterData.lh12Filter.setDecayTime(decay);
        filterData.lh12Filter.setSustainLevel(sustain);
        filterData.lh12Filter.setReleaseTime(release);
        filterData.lh12Filter.setClassicMode(classicMode);
      }
      if (filterData.lh18Filter) {
        filterData.lh18Filter.setAttackTime(attack);
        filterData.lh18Filter.setDecayTime(decay);
        filterData.lh18Filter.setSustainLevel(sustain);
        filterData.lh18Filter.setReleaseTime(release);
        filterData.lh18Filter.setClassicMode(classicMode);
      }
      if (filterData.lh24Filter) {
        filterData.lh24Filter.setAttackTime(attack);
        filterData.lh24Filter.setDecayTime(decay);
        filterData.lh24Filter.setSustainLevel(sustain);
        filterData.lh24Filter.setReleaseTime(release);
        filterData.lh24Filter.setClassicMode(classicMode);
      }
    });
    
    console.log(`Filter ADSR set to A:${attack}s D:${decay}s S:${sustain} R:${release}s${classicMode ? ' [CLASSIC MODE]' : ''}`);
  }
  
  setInputGain(normalizedValue) {
    this.inputGain = normalizedValue * 2.0;
    
    this.voiceFilters.forEach((filterData) => {
      if (filterData.lp24Filter) {
        filterData.lp24Filter.setInputGain(this.inputGain);
      }
      if (filterData.lp12Filter) {
        filterData.lp12Filter.setInputGain(this.inputGain);
      }
      if (filterData.lh12Filter) {
        filterData.lh12Filter.setInputGain(this.inputGain);
      }
      if (filterData.lh24Filter) {
        filterData.lh24Filter.setInputGain(this.inputGain);
      }
      // LH18 doesn't use inputGain - it uses drive parameter instead
      if (filterData.lh18Filter) {
        // For LH18, the "input gain" slider actually controls drive
        const scaledValue = 0.1 + normalizedValue * 4.9;
        filterData.lh18Filter.setDrive(scaledValue);
      }
    });
    
    console.log(`Filter input gain set to ${(normalizedValue * 100).toFixed(0)}%`);
  }
  
  setAmplitudeGainNode(voiceId, gainNode) {
    const filterData = this.voiceFilters.get(voiceId);
    if (!filterData) return;
    
    filterData.amplitudeGainNode = gainNode;
    
    // Setup amplitude tracking for all filters
    if (filterData.lp24Filter) {
      filterData.lp24Filter.setAmplitudeGainNode(gainNode);
    }
    
    if (filterData.lp12Filter) {
      filterData.lp12Filter.setAmplitudeGainNode(gainNode);
    }
    
    if (filterData.lh12Filter) {
      filterData.lh12Filter.setAmplitudeGainNode(gainNode);
    }
    
    if (filterData.lh18Filter) {
      filterData.lh18Filter.setAmplitudeGainNode(gainNode);
    }
    
    // Start the update loop if not already started
    if (!filterData.updateInterval) {
      filterData.updateInterval = setInterval(() => {
        if (filterData.lp24Filter) filterData.lp24Filter.updateFromAmplitude();
        if (filterData.lp12Filter) filterData.lp12Filter.updateFromAmplitude();
        if (filterData.lh12Filter) filterData.lh12Filter.updateFromAmplitude();
        if (filterData.lh18Filter) filterData.lh18Filter.updateFromAmplitude();
      }, 5);
    }
    
    console.log(`Filter ${voiceId} now tracking amplitude gain node`);
  }
  
  noteOn(voiceId, noteNumber, velocity = 1, retrigger = true, envelopeState = 'idle', currentEnvelopeValue = 0, isLegatoTransition = false) {
    const filterData = this.voiceFilters.get(voiceId);
    if (!filterData) return;
    
    filterData.currentNote = noteNumber;
    
    // Update all filters
    if (filterData.lp24Filter) {
      filterData.lp24Filter.noteOn(noteNumber, velocity, !isLegatoTransition, envelopeState, currentEnvelopeValue);
    }
    
    if (filterData.lp12Filter) {
      filterData.lp12Filter.noteOn(noteNumber, velocity, !isLegatoTransition, envelopeState, currentEnvelopeValue);
    }
    
    if (filterData.lh12Filter) {
      filterData.lh12Filter.noteOn(noteNumber, velocity, !isLegatoTransition, envelopeState, currentEnvelopeValue);
    }
    
    if (filterData.lh18Filter) {
      filterData.lh18Filter.noteOn(noteNumber, velocity, !isLegatoTransition, envelopeState, currentEnvelopeValue);
    }
    
    if (filterData.lh24Filter) {
      filterData.lh24Filter.noteOn(noteNumber, velocity, !isLegatoTransition, envelopeState, currentEnvelopeValue);
    }
    
    console.log(`Filter noteOn for voice ${voiceId}, note ${noteNumber}, retrigger=${!isLegatoTransition}`);
  }
  
  noteOff(voiceId, reset = false, isMonoMode = false, heldNotesRemaining = 0) {
    console.log(`[FilterManager.noteOff] Called for voiceId: ${voiceId}, isMonoMode: ${isMonoMode}, heldNotesRemaining: ${heldNotesRemaining}`);
    
    const filterData = this.voiceFilters.get(voiceId);
    if (!filterData) {
      console.log(`[FilterManager.noteOff] No filterData found for voice ${voiceId}`);
      return;
    }
    
    // In mono mode, only release if no more notes held
    if (isMonoMode && heldNotesRemaining > 0) {
      console.log(`[FilterManager.noteOff] Skipping release - mono mode with ${heldNotesRemaining} notes still held`);
      return;
    }
    
    console.log(`[FilterManager.noteOff] Releasing filters for voice ${voiceId}...`);
    
    // Release all filters
    if (filterData.lp24Filter) {
      console.log(`[FilterManager.noteOff] Calling lp24Filter.noteOff()`);
      filterData.lp24Filter.noteOff();
    }
    
    if (filterData.lp12Filter) {
      console.log(`[FilterManager.noteOff] Calling lp12Filter.noteOff()`);
      filterData.lp12Filter.noteOff();
    }
    
    if (filterData.lh12Filter) {
      console.log(`[FilterManager.noteOff] Calling lh12Filter.noteOff()`);
      filterData.lh12Filter.noteOff();
    }
    
    if (filterData.lh18Filter) {
      console.log(`[FilterManager.noteOff] Calling lh18Filter.noteOff()`);
      filterData.lh18Filter.noteOff();
    }
    
    if (filterData.lh24Filter) {
      console.log(`[FilterManager.noteOff] Calling lh24Filter.noteOff()`);
      filterData.lh24Filter.noteOff();
    }
    
    console.log(`Filter noteOff for voice ${voiceId}`);
  }
  
  destroy() {
    this.voiceFilters.forEach((filterData, voiceId) => {
      if (filterData.updateInterval) {
        clearInterval(filterData.updateInterval);
      }
      
      try {
        if (filterData.lp24Filter) filterData.lp24Filter.disconnect();
        if (filterData.lp12Filter) filterData.lp12Filter.disconnect();
        if (filterData.lh12Filter) filterData.lh12Filter.disconnect();
        if (filterData.inputNode) filterData.inputNode.disconnect();
        if (filterData.outputNode) filterData.outputNode.disconnect();
      } catch (e) {
        // Ignore disconnection errors
      }
    });
    
    this.voiceFilters.clear();
    console.log('Filter manager destroyed');
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
}
export default FilterManager;