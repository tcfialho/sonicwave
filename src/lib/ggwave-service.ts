import ggwaveFactory from 'ggwave';

export class GGWaveService {
    private ggwave: any;
    private instance: any;
    private parameters: any;
    private audioContext: AudioContext | null = null;
    private isInitialized: boolean = false;

    constructor() {
        this.ggwave = null;
        this.instance = null;
        this.parameters = null;
    }

    // Helper function from the official example
    private convertTypedArray(src: any, type: any): any {
        const buffer = new ArrayBuffer(src.byteLength);
        const baseView = new src.constructor(buffer).set(src);
        return new type(buffer);
    }

    private initAudioContext(): void {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
                sampleRate: 48000
            });
        }
    }

    async initialize(): Promise<void> {
        if (this.isInitialized) return;

        try {
            // Initialize ggwave with factory pattern (using ggwave_factory like in the example)
            this.ggwave = await ggwaveFactory();
            
            // Initialize audio context
            this.initAudioContext();
            
            // Get default parameters and configure sample rates
            this.parameters = this.ggwave.getDefaultParameters();
            this.parameters.sampleRateInp = this.audioContext!.sampleRate;
            this.parameters.sampleRateOut = this.audioContext!.sampleRate;
            
            // Initialize the ggwave instance
            this.instance = this.ggwave.init(this.parameters);
            
            this.isInitialized = true;
            console.log('GGWave initialized successfully', {
                sampleRate: this.audioContext!.sampleRate,
                parameters: this.parameters
            });
        } catch (error) {
            console.error('Failed to initialize GGWave:', error);
            throw error;
        }
    }

    async textToSound(text: string, volume: number = 50, protocolName: string = 'GGWAVE_PROTOCOL_AUDIBLE_NORMAL'): Promise<ArrayBuffer> {
        if (!this.isInitialized) {
            await this.initialize();
        }

        try {
            // Get the protocol ID from the protocol name
            let protocolId = this.ggwave.ProtocolId[protocolName];
            
            if (protocolId === undefined) {
                console.warn(`Protocol ${protocolName} not found. Available protocols:`, Object.keys(this.ggwave.ProtocolId || {}));
                
                // Try fallback to default protocol
                const fallbackProtocols = [
                    'GGWAVE_PROTOCOL_AUDIBLE_NORMAL',
                    'GGWAVE_PROTOCOL_AUDIBLE_FAST',
                    'GGWAVE_TX_PROTOCOL_AUDIBLE_NORMAL',
                    'GGWAVE_TX_PROTOCOL_AUDIBLE_FAST'
                ];
                
                for (const fallback of fallbackProtocols) {
                    if (this.ggwave.ProtocolId[fallback] !== undefined) {
                        protocolId = this.ggwave.ProtocolId[fallback];
                        console.log(`Using fallback protocol: ${fallback}`);
                        break;
                    }
                }
                
                if (protocolId === undefined) {
                    throw new Error(`No compatible protocol found. Available: ${Object.keys(this.ggwave.ProtocolId || {}).join(', ')}`);
                }
            }
            
            // Use the volume as in the official example (10 seems to be a good default there)
            const adjustedVolume = Math.max(5, Math.min(50, volume / 2)); // Scale down volume
            
            // Generate audio waveform like in the official example
            const waveform = this.ggwave.encode(this.instance, text, protocolId, adjustedVolume);
            console.log(`Encoded "${text}" using protocol ${protocolName} with volume ${adjustedVolume}`);
            return waveform;
        } catch (error) {
            console.error('Failed to encode text to sound:', error);
            throw error;
        }
    }

    async playSound(waveform: ArrayBuffer): Promise<void> {
        try {
            this.initAudioContext();
            
            // Resume audio context if it's suspended (required by some browsers)
            if (this.audioContext!.state === 'suspended') {
                await this.audioContext!.resume();
            }
            
            // Convert waveform to Float32Array like in the official example
            const buf = this.convertTypedArray(waveform, Float32Array);
            const buffer = this.audioContext!.createBuffer(1, buf.length, this.audioContext!.sampleRate);
            buffer.getChannelData(0).set(buf);
            
            const source = this.audioContext!.createBufferSource();
            source.buffer = buffer;
            source.connect(this.audioContext!.destination);
            source.start(0);
            
            console.log(`Playing sound transmission (${buf.length} samples, ${buffer.duration.toFixed(2)}s)`);
            
            // Return a promise that resolves when the sound finishes playing
            return new Promise((resolve) => {
                source.onended = () => resolve();
            });
        } catch (error) {
            console.error('Failed to play sound:', error);
            throw error;
        }
    }

    async startListening(callback: (text: string) => void): Promise<void> {
        if (!this.isInitialized) {
            await this.initialize();
        }

        try {
            this.initAudioContext();
            
            // Resume audio context if suspended
            if (this.audioContext!.state === 'suspended') {
                await this.audioContext!.resume();
            }

            const constraints = {
                audio: {
                    echoCancellation: false,
                    autoGainControl: false,
                    noiseSuppression: false
                }
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            const mediaStreamSource = this.audioContext!.createMediaStreamSource(stream);

            let recorder: ScriptProcessorNode;
            const bufferSize = 1024;
            const numberOfInputChannels = 1;
            const numberOfOutputChannels = 1;

            if (this.audioContext!.createScriptProcessor) {
                recorder = this.audioContext!.createScriptProcessor(
                    bufferSize,
                    numberOfInputChannels,
                    numberOfOutputChannels
                );
            } else {
                // Fallback for older browsers
                recorder = (this.audioContext! as any).createJavaScriptNode(
                    bufferSize,
                    numberOfInputChannels,
                    numberOfOutputChannels
                );
            }

            recorder.onaudioprocess = (e) => {
                const source = e.inputBuffer;
                
                try {
                    // Convert Float32Array to Int8Array like in the official example
                    const result = this.ggwave.decode(
                        this.instance, 
                        this.convertTypedArray(new Float32Array(source.getChannelData(0)), Int8Array)
                    );

                    if (result && result.length > 0) {
                        // Decode the result as UTF-8 text like in the official example
                        const decodedText = new TextDecoder("utf-8").decode(result);
                        console.log('Decoded message:', decodedText);
                        callback(decodedText);
                    }
                } catch (error) {
                    // Silently ignore decode errors (expected for non-ggwave audio)
                }
            };

            mediaStreamSource.connect(recorder);
            recorder.connect(this.audioContext!.destination);

            console.log('Started listening for ggwave transmissions...');
            console.log('Audio context sample rate:', this.audioContext!.sampleRate);
            console.log('GGWave parameters:', this.parameters);
            
        } catch (error) {
            console.error('Failed to start listening:', error);
            throw error;
        }
    }

    getAvailableProtocols(): { id: string; name: string; description: string }[] {
        if (!this.ggwave) return [];
        
        // Define all 12 official ggwave protocols based on documentation
        // Try multiple naming conventions since different versions may use different names
        const allKnownProtocols = [
            // Standard Audible Protocols (0-2)
            { 
                id: 'GGWAVE_PROTOCOL_AUDIBLE_NORMAL', 
                name: '🔊 Audible Normal (0)', 
                description: 'Standard transmission, most robust (8 bytes/sec, F0=1875Hz)' 
            },
            { 
                id: 'GGWAVE_PROTOCOL_AUDIBLE_FAST', 
                name: '🔊 Audible Fast (1)', 
                description: 'Standard transmission, faster (12 bytes/sec, F0=1875Hz)' 
            },
            { 
                id: 'GGWAVE_PROTOCOL_AUDIBLE_FASTEST', 
                name: '🔊 Audible Fastest (2)', 
                description: 'Standard transmission, fastest (16 bytes/sec, F0=1875Hz)' 
            },
            
            // Ultrasonic Protocols (3-5) - multiple naming conventions
            { 
                id: 'GGWAVE_PROTOCOL_ULTRASONIC_NORMAL', 
                name: '🔇 [U] Ultrasonic Normal (3)', 
                description: 'Silent transmission, inaudible to humans (F0=15000Hz)' 
            },
            { 
                id: 'GGWAVE_PROTOCOL_ULTRASONIC_FAST', 
                name: '🔇 [U] Ultrasonic Fast (4)', 
                description: 'Silent transmission, faster ultrasonic' 
            },
            { 
                id: 'GGWAVE_PROTOCOL_ULTRASONIC_FASTEST', 
                name: '🔇 [U] Ultrasonic Fastest (5)', 
                description: 'Silent transmission, fastest ultrasonic' 
            },
            
            // Dual-Tone Protocols for microcontrollers (6-8)
            { 
                id: 'GGWAVE_PROTOCOL_DT_NORMAL', 
                name: '⚡ [DT] Dual-Tone Normal (6)', 
                description: 'Dual-tone for microcontrollers, most robust' 
            },
            { 
                id: 'GGWAVE_PROTOCOL_DT_FAST', 
                name: '⚡ [DT] Dual-Tone Fast (7)', 
                description: 'Dual-tone for microcontrollers, faster' 
            },
            { 
                id: 'GGWAVE_PROTOCOL_DT_FASTEST', 
                name: '⚡ [DT] Dual-Tone Fastest (8)', 
                description: 'Dual-tone for microcontrollers, fastest' 
            },
            
            // Mono-Tone Protocols for microcontrollers (9-11)
            { 
                id: 'GGWAVE_PROTOCOL_MT_NORMAL', 
                name: '📡 [MT] Mono-Tone Normal (9)', 
                description: 'Mono-tone for microcontrollers, most robust' 
            },
            { 
                id: 'GGWAVE_PROTOCOL_MT_FAST', 
                name: '📡 [MT] Mono-Tone Fast (10)', 
                description: 'Mono-tone for microcontrollers, faster' 
            },
            { 
                id: 'GGWAVE_PROTOCOL_MT_FASTEST', 
                name: '📡 [MT] Mono-Tone Fastest (11)', 
                description: 'Mono-tone for microcontrollers, fastest' 
            },
        ];
        
        // Alternative naming conventions for different ggwave versions
        const alternativeNames = [
            // TX protocol variants
            { 
                id: 'GGWAVE_TX_PROTOCOL_AUDIBLE_NORMAL', 
                name: '🔊 Audible Normal (0)', 
                description: 'Standard transmission, most robust (8 bytes/sec, F0=1875Hz)' 
            },
            { 
                id: 'GGWAVE_TX_PROTOCOL_AUDIBLE_FAST', 
                name: '🔊 Audible Fast (1)', 
                description: 'Standard transmission, faster (12 bytes/sec, F0=1875Hz)' 
            },
            { 
                id: 'GGWAVE_TX_PROTOCOL_AUDIBLE_FASTEST', 
                name: '🔊 Audible Fastest (2)', 
                description: 'Standard transmission, fastest (16 bytes/sec, F0=1875Hz)' 
            },
            { 
                id: 'GGWAVE_TX_PROTOCOL_ULTRASONIC_NORMAL', 
                name: '🔇 [U] Ultrasonic Normal (3)', 
                description: 'Silent transmission, inaudible to humans (F0=15000Hz)' 
            },
            { 
                id: 'GGWAVE_TX_PROTOCOL_ULTRASONIC_FAST', 
                name: '🔇 [U] Ultrasonic Fast (4)', 
                description: 'Silent transmission, faster ultrasonic' 
            },
            { 
                id: 'GGWAVE_TX_PROTOCOL_ULTRASONIC_FASTEST', 
                name: '🔇 [U] Ultrasonic Fastest (5)', 
                description: 'Silent transmission, fastest ultrasonic' 
            },
        ];
        
        const availableProtocols = [];
        const addedIds = new Set(); // Track which protocols we've already added
        
        // Check primary protocol naming convention
        for (const protocol of allKnownProtocols) {
            if (this.ggwave.ProtocolId && this.ggwave.ProtocolId[protocol.id] !== undefined) {
                availableProtocols.push(protocol);
                addedIds.add(protocol.id);
            }
        }
        
        // Check alternative naming conventions
        for (const protocol of alternativeNames) {
            if (this.ggwave.ProtocolId && this.ggwave.ProtocolId[protocol.id] !== undefined && !addedIds.has(protocol.id)) {
                availableProtocols.push(protocol);
                addedIds.add(protocol.id);
            }
        }
        
        // Add specific known ultrasonic protocols that might use different naming
        const ultrasonicVariants = [
            { 
                id: 'GGWAVE_PROTOCOL_ULTRASOUND_NORMAL', 
                name: '🔇 [U] Ultrasonic Normal (3)', 
                description: 'Silent transmission, inaudible to humans (F0=15000Hz)' 
            },
            { 
                id: 'GGWAVE_PROTOCOL_ULTRASOUND_FAST', 
                name: '🔇 [U] Ultrasonic Fast (4)', 
                description: 'Silent transmission, faster ultrasonic' 
            },
            { 
                id: 'GGWAVE_PROTOCOL_ULTRASOUND_FASTEST', 
                name: '🔇 [U] Ultrasonic Fastest (5)', 
                description: 'Silent transmission, fastest ultrasonic' 
            },
        ];
        
        // Check for ultrasonic variants with different naming
        for (const protocol of ultrasonicVariants) {
            if (this.ggwave.ProtocolId && this.ggwave.ProtocolId[protocol.id] !== undefined && !addedIds.has(protocol.id)) {
                availableProtocols.push(protocol);
                addedIds.add(protocol.id);
            }
        }
        
        // Only add useful auto-detected protocols (exclude CUSTOM and values)
        if (this.ggwave.ProtocolId) {
            const availableKeys = Object.keys(this.ggwave.ProtocolId);
            console.log('Available ProtocolId keys:', availableKeys);
            
            // Look for any useful protocols we might have missed (exclude CUSTOM and values)
            for (const key of availableKeys) {
                if (!addedIds.has(key) && 
                    !key.includes('CUSTOM') && 
                    !key.includes('values') && 
                    key !== 'values' &&
                    key !== 'valueOf' &&
                    key.includes('PROTOCOL')) {
                    
                    let name = key.replace(/^GGWAVE_.*?PROTOCOL_/, '').replace(/_/g, ' ');
                    name = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
                    
                    let description = 'Auto-detected protocol';
                    let icon = '🔧';
                    
                    if (key.includes('ULTRASONIC') || key.includes('ULTRASOUND') || key.includes('ULTRA')) {
                        description = 'Silent ultrasonic transmission';
                        icon = '🔇';
                        // Fix naming for ultrasound -> ultrasonic
                        name = name.replace('Ultrasound', 'Ultrasonic');
                    } else if (key.includes('AUDIBLE')) {
                        description = 'Audible transmission';
                        icon = '🔊';
                    } else if (key.includes('DT')) {
                        description = 'Dual-tone for microcontrollers';
                        icon = '⚡';
                    } else if (key.includes('MT')) {
                        description = 'Mono-tone for microcontrollers';
                        icon = '📡';
                    }
                    
                    if (key.includes('NORMAL')) {
                        description += ' (most robust)';
                    } else if (key.includes('FAST') && !key.includes('FASTEST')) {
                        description += ' (balanced speed/robustness)';
                    } else if (key.includes('FASTEST')) {
                        description += ' (fastest, least robust)';
                    }
                    
                    availableProtocols.push({
                        id: key,
                        name: `${icon} ${name}`,
                        description: description
                    });
                }
            }
        }
        
        return availableProtocols;
    }
}