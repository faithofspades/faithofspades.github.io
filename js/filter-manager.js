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
    this._processorLoaded = false;
    
    // Load worklet processor
    this._loadWorkletProcessor();
    
    console.log("Triple-filter manager initialized with LP24 filter active");
  }
  
  // Load all processor types
  async _loadWorkletProcessor() {
    try {
      if (!this._processorLoaded) {
        try {
          await this.audioCtx.audioWorklet.addModule('./js/moog-filter-processor.js');
          await this.audioCtx.audioWorklet.addModule('./js/LP-12-filter-processor.js');
          await this.audioCtx.audioWorklet.addModule('./js/lh-12-filter-processor.js');
          await this.audioCtx.audioWorklet.addModule('./js/lh-18-filter-processor.js');
          await this.audioCtx.audioWorklet.addModule('./js/lh-24-filter-processor.js');
          console.log("Successfully loaded all filter processors");
          this._processorLoaded = true;
        } catch (loadError) {
          console.error('Failed to load with ./js/ path, trying relative path...');
          try {
            await this.audioCtx.audioWorklet.addModule('moog-filter-processor.js');
            await this.audioCtx.audioWorklet.addModule('LP-12-filter-processor.js');
            await this.audioCtx.audioWorklet.addModule('lh-12-filter-processor.js');
            await this.audioCtx.audioWorklet.addModule('lh-18-filter-processor.js');
            console.log("Successfully loaded using direct path");
            this._processorLoaded = true;
          } catch (secondError) {
            throw new Error(`Worklet load failed with both paths: ${secondError.message}`);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load filter AudioWorklet processors:', error);
      this._processorLoaded = false;
    }
  }

  // Set filter type - now switches connections between existing filters
  setFilterType(type) {
    if (type === this.currentFilterType) return; // No change

    const validTypes = ['lp24', 'lp12', 'lh12', 'lh18', 'lh24'];
    if (!validTypes.includes(type)) {
      console.error(`Invalid filter type: ${type}. Using LP24 instead.`);
      type = 'lp24';
    }

    const oldType = this.currentFilterType;
    this.currentFilterType = type;
    console.log(`Filter type changed to: ${type} from ${oldType}`);

    // Switch connections for all voices
    this.switchFilterConnections();
  }

  // Switch connections between filter types
  switchFilterConnections() {
  // Create crossfade duration
  const crossfadeDuration = 0.02; // 20ms crossfade
  const disconnectDelay = 0.05; // 50ms delay before disconnecting to avoid clicks
  const now = this.audioCtx.currentTime;
  
  this.voiceFilters.forEach((filterData, voiceId) => {
    // Cancel any pending cleanup timeout for this voice
    if (filterData.cleanupTimeoutId) {
      clearTimeout(filterData.cleanupTimeoutId);
      filterData.cleanupTimeoutId = null;
    }
    
    if (filterData && filterData.lp12Filter && filterData.lp24Filter && filterData.lh12Filter && filterData.lh18Filter && filterData.lh24Filter) {
      try {
        // Get the input and output nodes
        const inputNode = filterData.inputNode;
        const outputNode = filterData.outputNode;
        
        if (!inputNode || !outputNode) return;
        
        // Create crossfade gain nodes if they don't exist
        if (!filterData.lp12Gain) {
          console.error(`CRITICAL: Gain nodes don't exist for ${voiceId}! Recreating...`);
          filterData.lp12Gain = this.audioCtx.createGain();
          filterData.lp24Gain = this.audioCtx.createGain();
          filterData.lh12Gain = this.audioCtx.createGain();
          filterData.lh18Gain = this.audioCtx.createGain();
          filterData.lh24Gain = this.audioCtx.createGain();
          
          // Connect the filter outputs through their gain nodes to the output
          console.warn(`Disconnecting and reconnecting all filters for ${voiceId}...`);
          filterData.lp12Filter.disconnect();
          filterData.lp24Filter.disconnect();
          filterData.lh12Filter.disconnect();
          filterData.lh18Filter.disconnect();
          filterData.lh24Filter.disconnect();
          
          filterData.lp12Filter.connect(filterData.lp12Gain);
          filterData.lp24Filter.connect(filterData.lp24Gain);
          filterData.lh12Filter.connect(filterData.lh12Gain);
          filterData.lh18Filter.connect(filterData.lh18Gain);
          filterData.lh24Filter.connect(filterData.lh24Gain);
          
          filterData.lp12Gain.connect(outputNode);
          filterData.lp24Gain.connect(outputNode);
          filterData.lh12Gain.connect(outputNode);
          filterData.lh18Gain.connect(outputNode);
          filterData.lh24Gain.connect(outputNode);
          console.warn(`Reconnection complete for ${voiceId}`);
        }
        
        // Determine which filter to activate
        let activeFilterNode;
        if (this.currentFilterType === 'lp12') {
          activeFilterNode = filterData.lp12Filter;
        } else if (this.currentFilterType === 'lh12') {
          activeFilterNode = filterData.lh12Filter;
        } else if (this.currentFilterType === 'lh18') {
          activeFilterNode = filterData.lh18Filter;
        } else if (this.currentFilterType === 'lh24') {
          activeFilterNode = filterData.lh24Filter;
        } else {
          activeFilterNode = filterData.lp24Filter;
        }
        
        // FIRST: Connect the NEW active filter (if not already connected)
        // This ensures it's ready before we start the crossfade
        const allFilters = [
          filterData.lp12Filter,
          filterData.lp24Filter,
          filterData.lh12Filter,
          filterData.lh18Filter,
          filterData.lh24Filter
        ];
        
        // Connect the active filter to input if not already connected
        try {
          inputNode.connect(activeFilterNode);
        } catch (e) {
          // Already connected, that's fine
        }
        
        // Set all gains to 0 except active (with smooth crossfade)
        const allGains = [
          { gain: filterData.lp12Gain, filter: filterData.lp12Filter, active: this.currentFilterType === 'lp12' },
          { gain: filterData.lp24Gain, filter: filterData.lp24Filter, active: this.currentFilterType === 'lp24' },
          { gain: filterData.lh12Gain, filter: filterData.lh12Filter, active: this.currentFilterType === 'lh12' },
          { gain: filterData.lh18Gain, filter: filterData.lh18Filter, active: this.currentFilterType === 'lh18' },
          { gain: filterData.lh24Gain, filter: filterData.lh24Filter, active: this.currentFilterType === 'lh24' }
        ];
        
        allGains.forEach(({ gain, active }) => {
          const currentValue = gain.gain.value;
          gain.gain.cancelScheduledValues(now);
          gain.gain.setValueAtTime(currentValue, now);
          gain.gain.linearRampToValueAtTime(active ? 1 : 0, now + crossfadeDuration);
        });
        
        // AFTER crossfade completes + delay, disconnect inactive filters to save CPU
        filterData.cleanupTimeoutId = setTimeout(() => {
          allGains.forEach(({ filter, active }) => {
            if (!active) {
              try {
                inputNode.disconnect(filter);
              } catch (e) {
                // Already disconnected, that's fine
              }
            }
          });
          console.log(`Disconnected inactive filters for ${voiceId} (CPU optimized)`);
          filterData.cleanupTimeoutId = null; // Clear the timeout ID
        }, (crossfadeDuration + disconnectDelay) * 1000);
        
        filterData.activeFilter = activeFilterNode;
        console.log(`Crossfading ${voiceId} to ${this.currentFilterType} filter`);
        
        // Update filter note state if needed
        setTimeout(() => {
          if (filterData.currentNote !== null) {
            filterData.activeFilter.noteOn(filterData.currentNote, 1.0, false);
          }
          
          // Force a parameter update
          activeFilterNode.setCutoff(this.cutoff);
        }, crossfadeDuration * 1000 + 5);
      } catch (err) {
        console.error(`Error switching filters for voice ${voiceId}:`, err);
      }
    }
  });
}

  // Create all three filter types for each voice
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
    // Create all five filter types
    const lp24Filter = new MoogFilterNode(this.audioCtx, {
      parameterData: {
        cutoff: this.cutoff,
        resonance: this.resonance,
        drive: this.drive,
        saturation: this.saturation,
        bassCompensation: this.variant,
        keytrackAmount: (this.keytrackAmount - 0.5) * 2,
        envelopeAmount: (this.envelopeAmount - 0.5) * 2,
        currentMidiNote: 69,
        inputGain: this.inputGain
      }
    });
    
    const lp12Filter = new LP12FilterNode(this.audioCtx, {
      parameterData: {
        cutoff: this.cutoff,
        resonance: this.resonance,
        drive: 0.0, // LP12 drive (diode) is controlled by variant slider, default to 0
        saturation: this.saturation,
        bassCompensation: this.variant,
        keytrackAmount: (this.keytrackAmount - 0.5) * 2,
        envelopeAmount: (this.envelopeAmount - 0.5) * 2,
        currentMidiNote: 69,
        inputGain: this.inputGain
      }
    });
    
    const lh12Filter = new LH12FilterNode(this.audioCtx, {
      parameterData: {
        cutoff: this.cutoff,
        resonance: this.resonance,
        drive: 0.0, // LH12 drive is unused/reserved, default to 0
        saturation: this.saturation,
        bassCompensation: this.variant,
        keytrackAmount: (this.keytrackAmount - 0.5) * 2,
        envelopeAmount: (this.envelopeAmount - 0.5) * 2,
        currentMidiNote: 69,
        inputGain: this.inputGain
      }
    });
    
    console.log(`Creating LH18 filter for ${voiceId}...`);
    const lh18DriveValue = 0.1 + this.drive * 4.9; // Scale 0-1 to 0.1-5.0 for LH18
    console.log(`LH18 initialization: this.drive=${this.drive.toFixed(3)}, scaled drive=${lh18DriveValue.toFixed(3)}`);
    const lh18Filter = new LH18FilterNode(this.audioCtx, {
      parameterData: {
        cutoff: this.cutoff,
        resonance: this.resonance,
        drive: lh18DriveValue,
        saturation: this.saturation,
        bassCompensation: this.variant,
        keytrackAmount: (this.keytrackAmount - 0.5) * 2,
        envelopeAmount: (this.envelopeAmount - 0.5) * 2,
        currentMidiNote: 69,
        inputGain: this.inputGain
      }
    });
    console.log(`LH18 filter created for ${voiceId}`);
    console.log(`LH18 adsrValue at creation: ${lh18Filter.parameters.get('adsrValue').value}`);
    
    // Call setDrive explicitly after creation to ensure the AudioParam is updated
    setTimeout(() => {
      lh18Filter.setDrive(lh18DriveValue);
      console.log(`LH18 drive explicitly set to ${lh18DriveValue.toFixed(3)} after creation`);
      console.log(`LH18 adsrValue after setDrive: ${lh18Filter.parameters.get('adsrValue').value}`);
    }, 10);
    
    console.log(`Creating LH24 filter for ${voiceId}...`);
    const lh24Filter = new LH24FilterNode(this.audioCtx, {
      parameterData: {
        cutoff: this.cutoff,
        resonance: this.resonance,
        drive: this.drive,
        saturation: this.saturation,
        variant: this.variant, // Controls HP cutoff frequency
        keytrackAmount: (this.keytrackAmount - 0.5) * 2,
        envelopeAmount: (this.envelopeAmount - 0.5) * 2,
        currentMidiNote: 69,
        adsrValue: 0.0,
        inputGain: this.inputGain,
        classicMode: this.classicMode || 0.0,
        sustainLevel: this.sustainLevel || 1.0
      }
    });
    console.log(`LH24 filter created for ${voiceId}`);
    
    // Add verification logging
    console.log(`Filter processors created for ${voiceId}:
      LP24: ${lp24Filter._processorName || 'unknown'}
      LP12: ${lp12Filter._processorName || 'unknown'}
      LH12: ${lh12Filter._processorName || 'unknown'}
      LH18: ${lh18Filter._processorName || 'unknown'}
      LH24: ${lh24Filter._processorName || 'unknown'}
    `);
    
    // Set ADSR parameters for all filters
    lp24Filter.setAttackTime(this.attackTime);
    lp24Filter.setDecayTime(this.decayTime);
    lp24Filter.setSustainLevel(this.sustainLevel);
    lp24Filter.setReleaseTime(this.releaseTime);
    
    lp12Filter.setAttackTime(this.attackTime);
    lp12Filter.setDecayTime(this.decayTime);
    lp12Filter.setSustainLevel(this.sustainLevel);
    lp12Filter.setReleaseTime(this.releaseTime);
    
    lh12Filter.setAttackTime(this.attackTime);
    lh12Filter.setDecayTime(this.decayTime);
    lh12Filter.setSustainLevel(this.sustainLevel);
    lh12Filter.setReleaseTime(this.releaseTime);
    
    lh18Filter.setAttackTime(this.attackTime);
    lh18Filter.setDecayTime(this.decayTime);
    lh18Filter.setSustainLevel(this.sustainLevel);
    lh18Filter.setReleaseTime(this.releaseTime);
    
    lh24Filter.setAttackTime(this.attackTime);
    lh24Filter.setDecayTime(this.decayTime);
    lh24Filter.setSustainLevel(this.sustainLevel);
    lh24Filter.setReleaseTime(this.releaseTime);
    
    // Create mixer nodes for input and output
    const inputNode = new GainNode(this.audioCtx);
    const outputNode = new GainNode(this.audioCtx);
    
    // Create crossfade gain nodes
    const lp12Gain = this.audioCtx.createGain();
    const lp24Gain = this.audioCtx.createGain();
    const lh12Gain = this.audioCtx.createGain();
    const lh18Gain = this.audioCtx.createGain();
    const lh24Gain = this.audioCtx.createGain();
    
    // Set initial gain states based on current filter type
    if (this.currentFilterType === 'lp12') {
      lp12Gain.gain.setValueAtTime(1, this.audioCtx.currentTime);
      lp24Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      lh12Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      lh18Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      lh24Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
    } else if (this.currentFilterType === 'lh12') {
      lp12Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      lp24Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      lh12Gain.gain.setValueAtTime(1, this.audioCtx.currentTime);
      lh18Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      lh24Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
    } else if (this.currentFilterType === 'lh18') {
      lp12Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      lp24Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      lh12Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      lh18Gain.gain.setValueAtTime(1, this.audioCtx.currentTime);
      lh24Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
    } else if (this.currentFilterType === 'lh24') {
      lp12Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      lp24Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      lh12Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      lh18Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      lh24Gain.gain.setValueAtTime(1, this.audioCtx.currentTime);
    } else {
      lp12Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      lp24Gain.gain.setValueAtTime(1, this.audioCtx.currentTime);
      lh12Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      lh18Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
      lh24Gain.gain.setValueAtTime(0, this.audioCtx.currentTime);
    }
    
    // Connect through crossfade structure
    lp12Filter.connect(lp12Gain);
    lp24Filter.connect(lp24Gain);
    lh12Filter.connect(lh12Gain);
    lh18Filter.connect(lh18Gain);
    lh24Filter.connect(lh24Gain);
    lp12Gain.connect(outputNode);
    lp24Gain.connect(outputNode);
    lh12Gain.connect(outputNode);
    lh18Gain.connect(outputNode);
    lh24Gain.connect(outputNode);
    
    // Determine which one is active based on current setting
    const activeFilter = this.currentFilterType === 'lp12' ? lp12Filter : 
                         this.currentFilterType === 'lh12' ? lh12Filter :
                         this.currentFilterType === 'lh24' ? lh24Filter :
                         this.currentFilterType === 'lh18' ? lh18Filter : lp24Filter;
    
    // Input node connects to all filters always
    inputNode.connect(lp12Filter);
    inputNode.connect(lp24Filter);
    inputNode.connect(lh12Filter);
    inputNode.connect(lh18Filter);
    inputNode.connect(lh24Filter);
    
    // Store all filter data
    this.voiceFilters.set(voiceId, {
      lp24Filter,
      lp12Filter,
      lh12Filter,
      lh18Filter,
      lh24Filter,
      lp12Gain,
      lp24Gain,
      lh12Gain,
      lh18Gain,
      lh24Gain,
      activeFilter,
      inputNode,
      outputNode,
      active: true,
      currentNote: null,
      type: voiceId.startsWith('sampler-') ? 'sampler' : 'osc'
    });
    
    console.log(`Created 5-filter system for voice ${voiceId} with ${this.currentFilterType} active`);
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