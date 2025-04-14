// This file serves as the main JavaScript entry point for the web synthesizer application.
// It initializes the application, sets up event listeners, and manages the overall state.

// Importing necessary modules
import { initializeKeyboard } from './modules/keyboard.js';
import { initializeSampler } from './modules/sampler.js';
import { initializeLFO } from './modules/lfo.js';
import { initializeADSR } from './modules/adsr.js';
import { initializeOscillator } from './modules/oscillator.js';
import { initializeFilter } from './modules/filter.js';
import { initializeModulation } from './modules/modulation.js';
import { initializeLooper } from './modules/looper.js';
import { initializeFX } from './modules/fx.js';
import { initializeDelay } from './modules/delay.js';
import { initializeMaster } from './modules/master.js';

// Global variables
let audioCtx;

// Function to initialize the application
function init() {
    // Create audio context
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // Initialize modules
    initializeKeyboard(audioCtx);
    initializeSampler(audioCtx);
    initializeLFO(audioCtx);
    initializeADSR(audioCtx);
    initializeOscillator(audioCtx);
    initializeFilter(audioCtx);
    initializeModulation(audioCtx);
    initializeLooper(audioCtx);
    initializeFX(audioCtx);
    initializeDelay(audioCtx);
    initializeMaster(audioCtx);

    // Set up event listeners
    setupEventListeners();
}

// Function to set up event listeners
function setupEventListeners() {
    // Add global event listeners here
    // Example: document.getElementById('someButton').addEventListener('click', someFunction);
}

// Start the application
window.addEventListener('load', init);