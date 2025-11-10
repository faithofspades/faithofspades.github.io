/**
 * Creates a startup overlay for iOS devices to unlock the Web Audio API.
 * @param {AudioContext} audioCtx - The main AudioContext to resume.
 */
export function createiOSStartupOverlay(audioCtx) {
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.backgroundColor = 'rgba(245, 245, 220, 0.95)';
    overlay.style.zIndex = '9999';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.justifyContent = 'center';
    overlay.style.alignItems = 'center';
    overlay.style.textAlign = 'center';
    overlay.style.padding = '20px';

    // Logo image
    const logo = document.createElement('img');
    logo.src = 'my-favicon/favicon.svg';
    logo.alt = 'PolyHymn Logo';
    logo.style.height = 'min(190px, 25vw)';
    logo.style.width = 'auto';
    logo.style.marginBottom = '0';
    logo.style.maxWidth = '90vw';

    const heading = document.createElement('h2');
    heading.textContent = 'POLYHYMN';
    heading.style.fontFamily = "'ofelia-text', sans-serif";
    heading.style.fontWeight = '600';
    heading.style.fontSize = 'min(120px, 20vw)';
    heading.style.lineHeight = '1';
    heading.style.color = '#35100B';
    heading.style.margin = '0';
    heading.style.marginBottom = 'min(40px, 5vw)';

    const message = document.createElement('p');
    message.textContent = 'Tap anywhere to enable audio';
    message.style.marginBottom = '30px';
    message.style.color = '#35100B';

    const button = document.createElement('button');
    button.textContent = 'Start Synth';
    button.style.padding = '15px 30px';
    button.style.fontSize = '18px';
    button.style.backgroundColor = '#e6e6e6';
    button.style.border = '1px solid #35100B';
    button.style.borderRadius = '8px';
    button.style.color = '#35100B';
    button.style.cursor = 'pointer';

    overlay.appendChild(logo);
    overlay.appendChild(heading);
    overlay.appendChild(message);
    overlay.appendChild(button);

    // Make sure overlay is in the DOM before adding audio context
    document.body.appendChild(overlay);

    // Prepare the audio context but don't resume yet
    if (window.AudioContext || window.webkitAudioContext) {
        // Use your own silent audio file
        const silentAudio = document.createElement('audio');
        silentAudio.src = 'silence.mp3'; // Path to your silent audio file
        silentAudio.setAttribute('loop', 'loop');
        silentAudio.setAttribute('preload', 'auto');
        silentAudio.style.display = 'none';
        document.body.appendChild(silentAudio);

        function unlockAudio(event) {
            // This is the key change: multiple unlock methods in a synchronous user event handler

            // 1. Play the silent audio element first (this works for iOS Chrome)
            const playPromise = silentAudio.play();

            // 2. Resume the AudioContext
            if (audioCtx && audioCtx.state === 'suspended') { // Check if audioCtx exists
                audioCtx.resume();
            }

            // 3. Create and play an immediate oscillator (works in Safari)
            try {
                if (audioCtx) { // Check if audioCtx exists
                    const oscillator = audioCtx.createOscillator();
                    const gain = audioCtx.createGain();
                    gain.gain.value = 0.001; // Nearly silent
                    oscillator.connect(gain);
                    gain.connect(audioCtx.destination);
                    oscillator.start(0);
                    oscillator.stop(audioCtx.currentTime + 0.5); // Use audioCtx.currentTime
                }
            } catch(e) {
                console.log("Error creating oscillator:", e);
            }

            // 4. Create and play a buffer source (alternative method)
            try {
                if (audioCtx) { // Check if audioCtx exists
                    const buffer = audioCtx.createBuffer(1, 1, 22050);
                    const source = audioCtx.createBufferSource();
                    source.buffer = buffer;
                    source.connect(audioCtx.destination);
                    source.start(0);
                }
            } catch(e) {
                console.log("Error playing buffer:", e);
            }

            console.log("Audio unlock attempts complete, removing overlay");

            // Remove the overlay with slight delay
            setTimeout(() => {
                if (overlay.parentNode === document.body) { // Check if overlay is still in DOM
                    document.body.removeChild(overlay);
                    
                    // ADDED: Load the sample after overlay is removed
                    console.log("Overlay removed, loading initial sample");
                    
                    // Make sure audio context is running
                    if (audioCtx && audioCtx.state === "running") {
                        // Check if window.loadPresetSample function exists
                        if (typeof window.loadPresetSample === 'function') {
                            window.loadPresetSample('Noise.wav');
                        } else {
                            console.error("loadPresetSample function not available");
                        }
                    } else {
                        console.error("AudioContext not running after unlock");
                    }
                }
                // Keep the silent audio element playing in the background
            }, 200); // Increased from 50ms to 200ms for more reliable context state

            // Clean up event listeners
            overlay.removeEventListener('touchstart', unlockAudio);
            button.removeEventListener('touchstart', unlockAudio);
            overlay.removeEventListener('click', unlockAudio);

            // Prevent default
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
        }

        // Add event listeners for both touch and click
        overlay.addEventListener('touchstart', unlockAudio, { passive: false });
        button.addEventListener('touchstart', unlockAudio, { passive: false });
        overlay.addEventListener('click', unlockAudio);
    }
}