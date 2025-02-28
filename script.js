//create an audio context (an audio graph)
const myAudioCtx = new AudioContext();

//get audio element
const audioElement = document.getElementById('audioElement');
let source = myAudioCtx.createMediaElementSource(audioElement);


// Declare myMic outside the block
let myMic;

//add mic input 
navigator.mediaDevices.getUserMedia({audio: {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: true,
  latency: 0,
  channelCount: 1,
}})
  .then(function(stream) {
    myMic = myAudioCtx.createMediaStreamSource(stream);
    //connect mic to gain node
    myMic.connect(master);
    myMic.connect(filter);
  });
//create a master gain node
const master = myAudioCtx.createGain();
master.gain.value = 0.4;
master.connect(myAudioCtx.destination);

source.connect(master);

//create delay node
const delay = myAudioCtx.createDelay();
delay.delayTime.value = 0.00001;

//create a filter node
const filter = myAudioCtx.createBiquadFilter();
filter.type = 'lowpass';
filter.frequency.value = 2000;
filter.Q.value = 1;
filter.connect(delay);

source.connect(filter);


//create create Constant Source Node
const constantSource = myAudioCtx.createConstantSource();
constantSource.offset.value = 0.00001;

constantSource.connect(delay.delayTime);
//create feedback 
const feedback = myAudioCtx.createGain();
feedback.gain.value = 0.3;
delay.connect(feedback);
feedback.connect(filter);
delay.connect(master);

//modulate delay time
const lfo = myAudioCtx.createOscillator();
lfo.frequency.value = 0.5;


//create a gain node for the lfo
const lfoGain = myAudioCtx.createGain();
lfoGain.gain.value = 0.002;
lfo.connect(lfoGain);
lfoGain.connect(delay.delayTime);
startAudio = function() {
  audioElement.play();
  myAudioCtx.resume();
  constantSource.start();
  lfo.start();
}

//Add event listener to button
let myButton = document.getElementById('startAudio');
myButton.addEventListener('click', startAudio);

//add event listener to feedback slider
let feedbackSlider = document.getElementById('feedback');
feedbackSlider.addEventListener('input', function() {
  feedback.gain.value = feedbackSlider.value;
});

//add event listener to lfo frequency slider
let lfoSlider = document.getElementById('modFreq');
lfoSlider.addEventListener('input', function() {
  lfo.frequency.value = lfoSlider.value;
});

//add event listener to lfo depth slider
let lfoDepth = document.getElementById('modDepth');
lfoDepth.addEventListener('input', function() {
  lfoGain.gain.value = lfoDepth.value;
});

//add event listener to constant source manual slider
let delayTime = document.getElementById('manual');
delayTime.addEventListener('input', function() {
  constantSource.offset.value = delayTime.value;
});

//add event listener to filter 
let filterSlider = document.getElementById('filter');
filterSlider.addEventListener('input', function() {
  filter.frequency.value = filterSlider.value;
});

//add event listener to volume
let volumeSlider = document.getElementById('volume');
volumeSlider.addEventListener('input', function() {
  master.gain.value = volumeSlider.value;
});