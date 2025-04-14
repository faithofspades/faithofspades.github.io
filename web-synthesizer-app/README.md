# Web Synthesizer App

## Overview
The Web Synthesizer App is a modular web application designed to create and manipulate audio using various synthesis techniques. This project is structured to separate concerns, making it easier to maintain and extend.

## Project Structure
The project is organized into the following directories and files:

```
web-synthesizer-app
├── css
│   ├── main.css          # Global styles for the application
│   ├── keyboard.css      # Styles for the keyboard module
│   ├── sampler.css       # Styles for the sampler module
│   ├── lfo.css           # Styles for the LFO module
│   ├── adsr.css          # Styles for the ADSR module
│   ├── oscillator.css     # Styles for the oscillator module
│   ├── filter.css        # Styles for the filter module
│   ├── modulation.css     # Styles for the modulation module
│   ├── looper.css        # Styles for the looper module
│   ├── fx.css            # Styles for the FX module
│   ├── delay.css         # Styles for the delay module
│   └── master.css        # Styles for the master module
├── js
│   ├── main.js           # Main JavaScript entry point
│   ├── modules
│   │   ├── keyboard.js   # Keyboard functionality
│   │   ├── sampler.js    # Sampler functionality
│   │   ├── lfo.js        # LFO functionality
│   │   ├── adsr.js       # ADSR envelope functionality
│   │   ├── oscillator.js  # Oscillator functionality
│   │   ├── filter.js     # Filter functionality
│   │   ├── modulation.js  # Modulation effects
│   │   ├── looper.js     # Looper functionality
│   │   ├── fx.js         # Effects functionality
│   │   ├── delay.js      # Delay effects functionality
│   │   └── master.js     # Master controls functionality
│   └── utils
│       └── audioUtils.js  # Utility functions for audio processing
├── index.html            # Main HTML file
└── README.md             # Project documentation
```

## Setup Instructions
1. **Clone the Repository**: 
   ```bash
   git clone <repository-url>
   cd web-synthesizer-app
   ```

2. **Open the Project**: Open `index.html` in a web browser to run the application.

3. **Dependencies**: Ensure you have a modern web browser that supports ES6 modules and the Web Audio API.

## Usage Guidelines
- Use the keyboard to play notes and manipulate sound.
- Load samples into the sampler module to create unique sounds.
- Adjust parameters in the LFO, ADSR, oscillator, filter, and modulation modules to shape your audio.
- Utilize the looper and FX modules to create complex audio compositions.
- Control overall volume and settings in the master module.

## Contributing
Contributions are welcome! Please submit a pull request or open an issue for any enhancements or bug fixes.

## License
This project is licensed under the MIT License. See the LICENSE file for more details.