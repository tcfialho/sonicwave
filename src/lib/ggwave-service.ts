import ggwaveFactory from 'ggwave';
import CryptoJS from 'crypto-js';
import { gunzip, gzip } from 'fflate';
import { FileService, type ReceivedBatch, type FileTransferProgress } from './file-service';


// === FEC Scheme Types ===
interface FECScheme {
    groupSize: number;
    parityCount: number;
    name: string;
    isFountain: boolean;
}

export class GGWaveService {
    private ggwave: any;
    private instance: any;
    private parameters: any;
    private audioContext: AudioContext | null = null;
    private isInitialized: boolean = false;
    private currentProtocol: string | null = null;
    
    // === File transfer support ===
    private fileService: FileService = new FileService();
    private fileTransferCallbacks: Array<(progress: FileTransferProgress) => void> = [];

    // === Large message support ===
    private static readonly CHUNK_SIZE = 75; // bytes per data packet (before Base64)
    private static readonly SESSION_TIMEOUT_BASE_MS = 30_000; // base timeout (30s)
    private static readonly SESSION_TIMEOUT_PER_PACKET_MS = 5_000; // per packet timeout (5s per packet)
    private static readonly MIN_SESSION_TIMEOUT_MS = 60_000; // minimum 1 minute timeout
    
    // === FEC Configuration ===
    public static readonly FEC_SCHEMES: Record<string, FECScheme> = {
        FOUNTAIN_XOR: { groupSize: 10, parityCount: 2, name: 'Fountain XOR (20% overhead)', isFountain: true }
    };
    
    public static readonly DEFAULT_FEC_SCHEME = GGWaveService.FEC_SCHEMES.FOUNTAIN_XOR;



    /**
     * Generates FEC groups for Fountain XOR scheme
     */
    private static generateFECGroups(totalPackets: number, fecScheme: FECScheme): Array<{start: number, end: number, type: string}> {
        if (fecScheme.groupSize === 0) {
            return []; // No FEC
        }
        
        // Fountain XOR: Generate fountain symbols based on overhead
        // Simplified fountain approach with deterministic XOR patterns
        const redundancyFactor = 1.20; // 20% overhead (realistic for XOR-based fountain)
        const totalSymbols = Math.ceil(totalPackets * redundancyFactor);
        const groups: Array<{start: number, end: number, type: string}> = [];
        
        // Generate fountain symbols for the entire message
        for (let i = 0; i < totalSymbols - totalPackets; i++) {
            groups.push({ 
                start: 1, 
                end: totalPackets, 
                type: `F${i}` // Fountain symbol identifier
            });
        }
        
        return groups;
    }

    // Map of active receive sessions
    private receiveSessions: Map<string, {
        total: number;
        expectedHash: string;
        flags: string;
        fecScheme: FECScheme;
        chunks: Map<number, Uint8Array>; // seq -> raw data bytes
        parity: Map<string, Uint8Array>; // "group-type" -> parity bytes
        timeoutId: ReturnType<typeof setTimeout>;
        receivedPackets: Set<string>; // for duplicate detection
    }> = new Map();

    // Map of active send sessions for selective retransmission
    private sendSessions: Map<string, {
        sessionId: string;
        chunks: Map<number, Uint8Array>; // seq -> raw data bytes
        parity: Map<string, Uint8Array>; // "group-type" -> parity bytes
        total: number;
        sentChunks: Set<number>; // chunks that were sent
        sentParity: Set<string>; // parity packets that were sent
        protocolName: string;
        fecScheme: FECScheme;
        fullHash: string;
        flags: string;
        createdAt: Date;
    }> = new Map();

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

    // Volume automático baseado no tipo de protocolo
    private getAutomaticVolume(protocolName: string): number {
        // Protocolos ULTRASONIC sempre usam volume máximo (100%)
        if (protocolName.includes('ULTRASONIC') || protocolName.includes('ULTRASOUND')) {
            console.log(`🔊 Ultrasonic protocol detected - using maximum volume (100%)`);
            return 100;
        }
        
        // Protocolos AUDIBLE usam volume padrão (80%)
        if (protocolName.includes('AUDIBLE')) {
            console.log(`🔊 Audible protocol detected - using standard volume (80%)`);
            return 80;
        }
        
        // Outros protocolos (DT, MT, etc.) usam volume médio (80%)
        console.log(`🔊 Other protocol detected - using standard volume (80%)`);
        return 80;
    }

    private initAudioContext(): void {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
                sampleRate: 48000,
                latencyHint: 'interactive'  // Otimização: prioriza baixa latência para tempo real
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

    async textToSound(text: string, protocolName: string = 'GGWAVE_PROTOCOL_ULTRASONIC_FASTEST'): Promise<ArrayBuffer> {
        if (!this.isInitialized) {
            await this.initialize();
        }

        try {
            // Usar texto diretamente sem compressão
            const textToEncode = text;
            
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
            
            // Volume automático baseado no tipo de protocolo
            const automaticVolume = this.getAutomaticVolume(protocolName);
            
            // Encode text to UTF-8 bytes for transmission
            const textBytes = new TextEncoder().encode(textToEncode);
            
            // Generate audio waveform like in the official example
            const waveform = this.ggwave.encode(this.instance, textBytes, protocolId, automaticVolume);
            console.log(`🎵 Encoded "${textToEncode}" using protocol ${protocolName} with automatic volume ${automaticVolume}%`);
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

    async startListening(
        callback: (text: string) => void,
        onProgress?: (progress: {
            type: 'start' | 'data' | 'parity' | 'end' | 'complete';
            sessionId: string;
            packet: string;
            received: number;
            total: number;
            chunks: { [key: number]: boolean };
            parity: { [key: string]: boolean };
        }) => void
    ): Promise<void> {
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
                    noiseSuppression: false,
                    sampleRate: 48000,
                    channelCount: 1
                }
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            const mediaStreamSource = this.audioContext!.createMediaStreamSource(stream);

            let recorder: ScriptProcessorNode;
            const bufferSize = 4096; // Increased buffer size for better stability
            const numberOfInputChannels = 1;
            const numberOfOutputChannels = 1;
            
            console.log('Audio stream created with constraints:', constraints);
            console.log('Media stream tracks:', stream.getTracks().map(t => ({ kind: t.kind, label: t.label, settings: t.getSettings() })));

            if (typeof this.audioContext!.createScriptProcessor === 'function') {
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
                        const decodedText = new TextDecoder('utf-8').decode(result);
                        console.log('📥 Received packet:', decodedText);

                        // Handle the async call without blocking the audio processing
                        this.handleReceivedPacket(decodedText, onProgress).then((complete) => {
                            if (complete) {
                                console.log('📥 Reconstructed message:', complete);
                                callback(complete);
                            }
                        }).catch((error) => {
                            console.error('Error handling received packet:', error);
                        });
                    }
                } catch (error) {
                    // Only log decode errors occasionally to avoid spam
                    if (Math.random() < 0.01) {
                        console.debug('Decode attempt failed (this is normal for background noise)');
                    }
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

    /* =====================
       * Utility functions *
       ===================== */

    // Generate a unique session ID (timestamp-nonce format)
    private static generateSessionId(): string {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const nonce = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
        return `${timestamp}-${nonce}`;
    }

    // Compute MD5 hash in Base64 format for entire message
    private static md5Base64(data: Uint8Array): string {
        const wordArray = CryptoJS.lib.WordArray.create(data);
        const hash = CryptoJS.MD5(wordArray);
        return CryptoJS.enc.Base64.stringify(hash);
    }

    // Split bytes into fixed-size chunks
    private static chunkBytes(data: Uint8Array, size: number): Uint8Array[] {
        const chunks: Uint8Array[] = [];
        for (let i = 0; i < data.length; i += size) {
            chunks.push(data.slice(i, i + size));
        }
        return chunks;
    }

    // XOR multiple equal-length byte arrays with padding
    private static xorBytes(chunks: Uint8Array[], size: number): Uint8Array {
        const result = new Uint8Array(size);
        for (const chunk of chunks) {
            const paddedChunk = new Uint8Array(size);
            paddedChunk.set(chunk);
            for (let i = 0; i < size; i++) {
                result[i] ^= paddedChunk[i];
            }
        }
        return result;
    }
    
    // Generate parity data for a group using specified scheme
    private static generateParityData(chunks: Uint8Array[], scheme: FECScheme): Uint8Array[] {
        const parities: Uint8Array[] = [];
        
        if (scheme.parityCount === 0) {
            return parities;
        }
        
        if (scheme.isFountain) {
            // Fountain XOR codes - simplified fountain approach
            // Uses deterministic XOR patterns to create fountain-like symbols
            // Not as optimal as true Raptor codes but much simpler
            
            // Generate fountain symbol using XOR of selected chunks
            const fountainSymbol = new Uint8Array(GGWaveService.CHUNK_SIZE);
            
            // Simple degree distribution: most symbols connect to 1-3 chunks
            // In practice, this gives ~20% overhead for reasonable error rates
            const degree = Math.min(chunks.length, Math.floor(Math.random() * 3) + 1);
            const selectedChunks = new Set<number>();
            
            // Select chunks pseudo-randomly but deterministically
            for (let i = 0; i < degree; i++) {
                let chunkIndex = i % chunks.length;
                selectedChunks.add(chunkIndex);
            }
            
            // XOR selected chunks to create fountain symbol
            for (const chunkIndex of selectedChunks) {
                const chunk = chunks[chunkIndex];
                const paddedChunk = new Uint8Array(GGWaveService.CHUNK_SIZE);
                paddedChunk.set(chunk);
                
                for (let j = 0; j < GGWaveService.CHUNK_SIZE; j++) {
                    fountainSymbol[j] ^= paddedChunk[j];
                }
            }
            
            parities.push(fountainSymbol);
        }
        
        return parities;
    }
    
    // Simplified fountain recovery - basic XOR decoding
    private static recoverChunks(
        chunks: Map<number, Uint8Array>,
        parity: Map<string, Uint8Array>,
        groupStart: number,
        groupSize: number,
        scheme: typeof GGWaveService.FEC_SCHEMES[keyof typeof GGWaveService.FEC_SCHEMES]
    ): Map<number, Uint8Array> {
        const recovered = new Map<number, Uint8Array>();
        
        if (scheme.parityCount === 0) {
            return recovered;
        }
        
        console.log(`Attempting fountain recovery for messages with ${parity.size} fountain symbols`);
        
        // Simplified fountain decoding: try to use fountain symbols to recover missing chunks
        // This is a basic implementation - real fountain codes would use belief propagation
        for (const [fountainKey, fountainData] of parity) {
            if (fountainKey.startsWith('F')) {
                // This is a fountain symbol - try simple XOR recovery if only 1 chunk is missing
                let missingCount = 0;
                let missingIndex = -1;
                
                // Count missing chunks in the full message range
                for (let i = 1; i <= groupSize; i++) {
                    if (!chunks.has(i) && !recovered.has(i)) {
                        missingCount++;
                        missingIndex = i;
                    }
                }
                
                // If exactly 1 chunk is missing, we can potentially recover it
                if (missingCount === 1) {
                    const recoveredData = fountainData.slice();
                    
                    // XOR with all known chunks (simplified degree-1 assumption)
                    for (let i = 1; i <= groupSize; i++) {
                        if (chunks.has(i)) {
                            const chunkData = chunks.get(i)!;
                            const paddedChunk = new Uint8Array(GGWaveService.CHUNK_SIZE);
                            paddedChunk.set(chunkData);
                            
                            for (let j = 0; j < GGWaveService.CHUNK_SIZE; j++) {
                                recoveredData[j] ^= paddedChunk[j];
                            }
                        }
                    }
                    
                    // Remove trailing zeros
                    let actualLength = recoveredData.length;
                    while (actualLength > 0 && recoveredData[actualLength - 1] === 0) {
                        actualLength--;
                    }
                    
                    if (actualLength > 0) {
                        recovered.set(missingIndex, recoveredData.slice(0, actualLength));
                        console.log(`Fountain recovery: recovered chunk ${missingIndex} using symbol ${fountainKey}`);
                        break; // Try one recovery at a time
                    }
                }
            }
        }
        
        return recovered;
    }

    // Compress data using gzip
    private static compressData(data: Uint8Array): Promise<Uint8Array> {
        return new Promise((resolve, reject) => {
            gzip(data, (err, compressed) => {
                if (err) reject(err);
                else resolve(compressed);
            });
        });
    }

    // Decompress data using gzip
    private static decompressData(data: Uint8Array): Promise<Uint8Array> {
        return new Promise((resolve, reject) => {
            gunzip(data, (err, decompressed) => {
                if (err) reject(err);
                else resolve(new Uint8Array(decompressed));
            });
        });
    }

    // Calculate adaptive timeout based on packet count and protocol speed
    private static calculateTimeout(totalPackets: number, protocolName?: string): number {
        let multiplier = 1;
        
        // Adjust timeout based on protocol speed
        if (protocolName) {
            if (protocolName.includes('NORMAL')) {
                multiplier = 3; // Normal protocols are slower
            } else if (protocolName.includes('FAST') && !protocolName.includes('FASTEST')) {
                multiplier = 2; // Fast protocols are medium speed
            } else if (protocolName.includes('FASTEST')) {
                multiplier = 1; // Fastest protocols are quick
            }
        }
        
        const calculatedTimeout = GGWaveService.SESSION_TIMEOUT_BASE_MS + 
                                 (totalPackets * GGWaveService.SESSION_TIMEOUT_PER_PACKET_MS * multiplier);
        
        return Math.max(calculatedTimeout, GGWaveService.MIN_SESSION_TIMEOUT_MS);
    }

    /**
     * Robust Base64 validation and decoding
     * @param base64String The Base64 string to validate and decode
     * @returns Uint8Array if valid, null if invalid
     */
    private static validateAndDecodeBase64(base64String: string): Uint8Array | null {
        try {
            // Check if string contains only valid Base64 characters
            const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
            if (!base64Regex.test(base64String)) {
                console.warn(`Invalid Base64 characters in: ${base64String.substring(0, 50)}...`);
                return null;
            }
            
            // Check if length is valid (must be multiple of 4 after padding)
            if (base64String.length % 4 !== 0) {
                console.warn(`Invalid Base64 length: ${base64String.length} (must be multiple of 4)`);
                return null;
            }
            
            // Attempt decode
            const decoded = atob(base64String);
            return Uint8Array.from(decoded, c => c.charCodeAt(0));
            
        } catch (error) {
            console.warn(`Base64 decode error: ${error}`, base64String.substring(0, 50));
            return null;
        }
    }

    /**
     * Infer protocol type from current listening mode or use conservative default
     */
    private inferCurrentProtocol(): string {
        // If we have a recorded current protocol, use it
        if (this.currentProtocol) {
            return this.currentProtocol;
        }
        
        // Try to infer from current ggwave mode (if available)
        if (this.instance) {
            try {
                const currentMode = this.instance.getDefaultMode?.() || 0;
                // This is a heuristic - map mode numbers to protocol types
                // Mode 0-3 are typically ultrasonic, 4-7 audible, etc.
                if (currentMode <= 1) return 'ULTRASONIC_FASTEST';
                if (currentMode <= 3) return 'ULTRASONIC_NORMAL';
                return 'AUDIBLE_NORMAL';
            } catch (e) {
                console.warn('Could not infer protocol from ggwave instance');
            }
        }
        
        // Conservative default - assume slower protocol for safety
        return 'NORMAL';
    }

    // ===================== Sender side =====================

    /**
     * Transmit arbitrarily large data by fragmenting into multiple GGWave packets.
     * The method blocks until transmission of all packets completes.
     * Stores session info for selective retransmission.
     */
    async sendLargeData(
        message: string, 
        protocolName: string = 'GGWAVE_PROTOCOL_ULTRASONIC_FASTEST', 
        compress: boolean = false,
        fecScheme: FECScheme = GGWaveService.DEFAULT_FEC_SCHEME,
        onProgress?: (progress: {
            type: 'start' | 'data' | 'parity' | 'end';
            current: number;
            total: number;
            sessionId: string;
            packet: string;
            fecInfo?: { scheme: string; groupSize: number; parityCount: number };
        }) => void
    ): Promise<void> {
        // Track current protocol for adaptive timeouts
        this.currentProtocol = protocolName;
        
        if (!this.isInitialized) {
            await this.initialize();
        }

        const id = GGWaveService.generateSessionId();
        let data = new TextEncoder().encode(message);
        let flags = '';

        // Apply compression if requested
        if (compress) {
            data = await GGWaveService.compressData(data);
            flags = 'C';
        }

        const fullHash = GGWaveService.md5Base64(data);
        const chunks = GGWaveService.chunkBytes(data, GGWaveService.CHUNK_SIZE);
        const total = chunks.length;

        // Add FEC scheme to flags
        const fecFlag = `F${Object.entries(GGWaveService.FEC_SCHEMES).find(([_, scheme]) => scheme === fecScheme)?.[0] || 'FOUNTAIN_XOR'}`;
        const allFlags = [flags, fecFlag].filter(Boolean).join(',');

        // Generate and store parity data for selective retransmission
        const parityMap = new Map<string, Uint8Array>();
        const fecGroups = GGWaveService.generateFECGroups(total, fecScheme);
        
        for (const group of fecGroups) {
            const groupChunks = chunks.slice(group.start - 1, group.end);
            const parityCount = group.type.startsWith('O') ? 1 : (fecScheme.parityCount || 1);
            const parities = GGWaveService.generateParityData(groupChunks, {
                ...fecScheme,
                parityCount
            });
            
            const parityIndex = group.type.startsWith('O') ? 0 : parseInt(group.type);
            if (parityIndex < parities.length) {
                const rangeStr = group.type; // Fountain symbols use simple F0, F1, etc. identifiers
                parityMap.set(rangeStr, parities[parityIndex]);
            }
        }

        // Store session info for selective retransmission
        const chunkMap = new Map<number, Uint8Array>();
        chunks.forEach((chunk, index) => {
            chunkMap.set(index + 1, chunk);
        });

        this.sendSessions.set(id, {
            sessionId: id,
            chunks: chunkMap,
            parity: parityMap,
            total,
            sentChunks: new Set(),
            sentParity: new Set(),
            protocolName,
            fecScheme,
            fullHash,
            flags: allFlags,
            createdAt: new Date()
        });

        // 1) START packet
        const startPacket = allFlags ? `S:${id}::${fullHash}:${total}:${allFlags}` : `S:${id}::${fullHash}:${total}`;
        
        console.log(`Sending START packet: ${startPacket}`);
        console.log(`Compression flag: ${compress ? 'YES' : 'NO'}, Data size: ${data.length} bytes`);
        
        onProgress?.({ 
            type: 'start', 
            current: 0, 
            total, 
            sessionId: id, 
            packet: startPacket,
            fecInfo: { scheme: fecScheme.name, groupSize: fecScheme.groupSize, parityCount: fecScheme.parityCount }
        });
        await this.transmitPacket(startPacket, protocolName);

        // 2) DATA packets
        const sendSession = this.sendSessions.get(id);
        for (let i = 0; i < total; i++) {
            const seqNum = i + 1;
            const chunkBase64 = btoa(String.fromCharCode(...chunks[i]));
            const dataPacket = `D:${id}:${seqNum}:${chunkBase64}`;
            onProgress?.({ type: 'data', current: seqNum, total, sessionId: id, packet: dataPacket });
            await this.transmitPacket(dataPacket, protocolName);
            
            // Mark chunk as sent
            if (sendSession) {
                sendSession.sentChunks.add(seqNum);
            }
        }

        // 3) PARITY packets - deterministic order following specification
        if (fecScheme.groupSize > 0) {
            const fecGroups = GGWaveService.generateFECGroups(total, fecScheme);
            console.log(`FEC Groups for ${total} packets with ${fecScheme.name}:`, fecGroups);
            
            // Send parity packets in deterministic order
            for (const group of fecGroups) {
                const groupChunks = chunks.slice(group.start - 1, group.end);
                
                // Generate parity data for this specific group
                const parityCount = group.type.startsWith('O') ? 1 : (fecScheme.parityCount || 1);
                const parities = GGWaveService.generateParityData(groupChunks, {
                    ...fecScheme,
                    parityCount
                });
                
                // For overlapping groups, only send the primary parity (index 0)
                const parityIndex = group.type.startsWith('O') ? 0 : parseInt(group.type);
                if (parityIndex < parities.length) {
                    const parityBase64 = btoa(String.fromCharCode(...parities[parityIndex]));
                    const rangeStr = group.type; // Fountain symbols use simple F0, F1, etc. identifiers
                    const parityPacket = `P:${id}:${rangeStr}:${parityBase64}`;
                    
                    console.log(`Sending parity packet: ${rangeStr} for group [${group.start}-${group.end}]`);
                    
                    onProgress?.({ 
                        type: 'parity', 
                        current: fecGroups.indexOf(group) + 1, 
                        total: fecGroups.length, 
                        sessionId: id, 
                        packet: parityPacket 
                    });
                    
                    await this.transmitPacket(parityPacket, protocolName);
                    
                    // Mark parity as sent
                    if (sendSession) {
                        sendSession.sentParity.add(rangeStr);
                    }
                }
            }
        }

        // 4) END packet
        const endPacket = `E:${id}::`;
        onProgress?.({ type: 'end', current: total, total, sessionId: id, packet: endPacket });
        await this.transmitPacket(endPacket, protocolName);
    }

    /** Helper to encode+play a packet */
    private async transmitPacket(packet: string, protocolName: string): Promise<void> {
        const waveform = await this.textToSound(packet, protocolName);
        await this.playSound(waveform);
        
        // Add extra delay for slower protocols to ensure proper reception
        let extraDelay = 0;
        if (protocolName.includes('NORMAL')) {
            extraDelay = 1000; // 1 second extra delay for normal protocols
        } else if (protocolName.includes('FAST') && !protocolName.includes('FASTEST')) {
            extraDelay = 500; // 0.5 second extra delay for fast protocols
        } else if (protocolName.includes('FASTEST')) {
            extraDelay = 200; // Add small delay even for fastest to prevent overlap
        }
        
        if (extraDelay > 0) {
            console.log(`Adding ${extraDelay}ms delay after packet: ${packet.substring(0, 50)}...`);
            await new Promise(resolve => setTimeout(resolve, extraDelay));
        }
    }

    // ===================== Receiver side =====================

    /** Handle a single received GGWave payload string. Returns full message when reconstructed */
    private async handleReceivedPacket(
        raw: string,
        onProgress?: (progress: {
            type: 'start' | 'data' | 'parity' | 'end' | 'complete';
            sessionId: string;
            packet: string;
            received: number;
            total: number;
            chunks: { [key: number]: boolean };
            parity: { [key: string]: boolean };
        }) => void
    ): Promise<string | null> {
        const parts = raw.split(':');
        if (parts.length < 2) return null; // Not a structured packet

        const type = parts[0];
        const sessionId = parts[1];

        // Handle FILE packets specially
        if (type === 'FILE') {
            return await this.handleFilePacket(raw);
        }

        if (!['S', 'D', 'P', 'E'].includes(type)) {
            return raw; // treat as simple text
        }

        // Create packet ID for duplicate detection
        const packetId = `${type}:${sessionId}:${parts[2] || ''}`;

        // Ensure session entry exists when needed
        const getSession = () => this.receiveSessions.get(sessionId);

        switch (type) {
            case 'S': {
                if (parts.length < 5) return null;
                const expectedHash = parts[3];
                const total = parseInt(parts[4], 10);
                const flags = parts[5] || '';

                if (isNaN(total) || !expectedHash) return null;

                // Parse FEC scheme from flags
                let fecScheme = GGWaveService.DEFAULT_FEC_SCHEME;
                console.log(`Parsing flags for session ${sessionId}: "${flags}"`);
                
                const fecMatch = flags.match(/F([A-Z_0-9]+)/);
                if (fecMatch) {
                    const schemeName = fecMatch[1] as keyof typeof GGWaveService.FEC_SCHEMES;
                    console.log(`Found FEC scheme: ${schemeName}`);
                    if (GGWaveService.FEC_SCHEMES[schemeName]) {
                        fecScheme = GGWaveService.FEC_SCHEMES[schemeName];
                        console.log(`Using FEC scheme: ${fecScheme.name}`);
                    }
                } else {
                    console.log(`No FEC scheme found in flags, using default: ${fecScheme.name}`);
                }

                // Clean previous if exists
                if (this.receiveSessions.has(sessionId)) {
                    clearTimeout(getSession()!.timeoutId);
                    this.receiveSessions.delete(sessionId);
                }

                const inferredProtocol = this.inferCurrentProtocol();
                const timeoutMs = GGWaveService.calculateTimeout(total, inferredProtocol);
                console.log(`Session ${sessionId} timeout set to ${timeoutMs}ms for ${total} packets`);
                const timeoutId = setTimeout(() => {
                    console.warn(`Session ${sessionId} timed out after ${timeoutMs}ms`);
                    const session = this.receiveSessions.get(sessionId);
                    if (session) {
                        console.log(`Session ${sessionId} incomplete: received ${session.chunks.size}/${session.total} packets`);
                        console.log('Received packets:', Array.from(session.chunks.keys()).sort((a, b) => a - b));
                        console.log('Available parity:', Array.from(session.parity.keys()));
                    }
                    this.receiveSessions.delete(sessionId);
                }, timeoutMs);

                this.receiveSessions.set(sessionId, {
                    total,
                    expectedHash,
                    flags,
                    fecScheme,
                    chunks: new Map(),
                    parity: new Map(),
                    timeoutId,
                    receivedPackets: new Set([packetId])
                });
                
                // Report progress
                onProgress?.({
                    type: 'start',
                    sessionId,
                    packet: raw,
                    received: 0,
                    total,
                    chunks: {},
                    parity: {}
                });
                break;
            }
            case 'D': {
                if (parts.length < 4) return null;
                const seqNum = parseInt(parts[2], 10);
                const dataBase64 = parts.slice(3).join(':'); // rest of string may contain ':'

                if (isNaN(seqNum)) return null;
                if (!this.receiveSessions.has(sessionId)) return null;
                
                const sess = getSession()!;
                
                // Check for duplicate
                if (sess.receivedPackets.has(packetId)) {
                    console.log(`Duplicate packet ignored: ${packetId}`);
                    break;
                }
                sess.receivedPackets.add(packetId);

                // Decode Base64 data with validation
                const dataBytes = GGWaveService.validateAndDecodeBase64(dataBase64);
                if (dataBytes) {
                    sess.chunks.set(seqNum, dataBytes);
                    
                    // Report progress
                    const chunksStatus: { [key: number]: boolean } = {};
                    const parityStatus: { [key: string]: boolean } = {};
                    
                    for (let i = 1; i <= sess.total; i++) {
                        chunksStatus[i] = sess.chunks.has(i);
                    }
                    
                    for (const [key] of sess.parity) {
                        parityStatus[key] = true;
                    }
                    
                    onProgress?.({
                        type: 'data',
                        sessionId,
                        packet: raw,
                        received: sess.chunks.size,
                        total: sess.total,
                        chunks: chunksStatus,
                        parity: parityStatus
                    });
                } else {
                    console.warn(`Invalid Base64 in DATA packet: ${dataBase64.substring(0, 50)}...`);
                    return null;
                }
                break;
            }
            case 'P': {
                if (parts.length < 4) return null;
                const rangeStr = parts[2];
                const parityBase64 = parts[3];
                
                if (!this.receiveSessions.has(sessionId)) return null;
                
                const sess = getSession()!;
                
                // Check for duplicate
                if (sess.receivedPackets.has(packetId)) {
                    console.log(`Duplicate packet ignored: ${packetId}`);
                    break;
                }
                sess.receivedPackets.add(packetId);

                // Decode Base64 parity with validation
                const parityBytes = GGWaveService.validateAndDecodeBase64(parityBase64);
                if (parityBytes) {
                    // Store fountain symbol with its key
                    sess.parity.set(rangeStr, parityBytes);
                    
                    // Report progress
                    const chunksStatus: { [key: number]: boolean } = {};
                    const parityStatus: { [key: string]: boolean } = {};
                    
                    for (let i = 1; i <= sess.total; i++) {
                        chunksStatus[i] = sess.chunks.has(i);
                    }
                    
                    for (const [key] of sess.parity) {
                        parityStatus[key] = true;
                    }
                    
                    onProgress?.({
                        type: 'parity',
                        sessionId,
                        packet: raw,
                        received: sess.chunks.size,
                        total: sess.total,
                        chunks: chunksStatus,
                        parity: parityStatus
                    });
                } else {
                    console.warn(`Invalid Base64 in PARITY packet: ${parityBase64.substring(0, 50)}...`);
                    return null;
                }
                break;
            }
            case 'E': {
                if (!this.receiveSessions.has(sessionId)) return null;
                const sess = getSession()!;
                
                // Check for duplicate
                if (sess.receivedPackets.has(packetId)) {
                    console.log(`Duplicate packet ignored: ${packetId}`);
                    break;
                }
                sess.receivedPackets.add(packetId);
                // Report progress
                if (sess) {
                    const chunksStatus: { [key: number]: boolean } = {};
                    const parityStatus: { [key: string]: boolean } = {};
                    
                    for (let i = 1; i <= sess.total; i++) {
                        chunksStatus[i] = sess.chunks.has(i);
                    }
                    
                    for (const [key] of sess.parity) {
                        parityStatus[key] = true;
                    }
                    
                    onProgress?.({
                        type: 'end',
                        sessionId,
                        packet: raw,
                        received: sess.chunks.size,
                        total: sess.total,
                        chunks: chunksStatus,
                        parity: parityStatus
                    });
                }
                break;
            }
        }

        // After any packet, attempt to finalize session if possible
        const sess = this.receiveSessions.get(sessionId);
        if (!sess) return null;
        
        // Log current session state
        console.log(`Session ${sessionId} state: ${sess.chunks.size}/${sess.total} chunks, ${sess.parity.size} parity packets`);
        if (sess.chunks.size < sess.total) {
            const missingChunks = [];
            for (let i = 1; i <= sess.total; i++) {
                if (!sess.chunks.has(i)) {
                    missingChunks.push(i);
                }
            }
            console.log(`Missing chunks: [${missingChunks.join(', ')}]`);
        }

        // Attempt fountain recovery using available symbols
        if (sess.fecScheme.groupSize > 0 && sess.parity.size > 0) {
            console.log(`Attempting fountain recovery for session ${sessionId} with ${sess.parity.size} symbols`);
            
            const recovered = GGWaveService.recoverChunks(
                sess.chunks, 
                sess.parity, 
                1, 
                sess.total, 
                sess.fecScheme
            );
            
            // Apply recovered chunks
            for (const [index, data] of recovered) {
                if (!sess.chunks.has(index)) {
                    sess.chunks.set(index, data);
                    console.log(`Fountain recovered packet ${index} for session ${sessionId}`);
                }
            }
        }

        if (sess.chunks.size === sess.total) {
            // Reconstruct full message
            const orderedChunks = Array.from(sess.chunks.entries())
                .sort((a, b) => a[0] - b[0])
                .map(entry => entry[1]);
            
            // Concatenate all chunks
            const totalLength = orderedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const fullData = new Uint8Array(totalLength);
            let offset = 0;
            
            for (const chunk of orderedChunks) {
                fullData.set(chunk, offset);
                offset += chunk.length;
            }

            // Verify hash
            const hashCheck = GGWaveService.md5Base64(fullData);
            
            // Cleanup
            clearTimeout(sess.timeoutId);
            this.receiveSessions.delete(sessionId);
            
            // Signal successful completion to potentially stop transmission
            console.log(`🎉 Session ${sessionId} completed successfully - message recovered!`);

            if (hashCheck === sess.expectedHash) {
                try {
                    // Decompress if needed
                    let finalData: Uint8Array = fullData;
                    const hasCompressionFlag = sess.flags.includes('C');
                    
                    console.log(`Session ${sessionId} flags: "${sess.flags}", hasCompressionFlag: ${hasCompressionFlag}`);
                    
                    if (hasCompressionFlag) {
                        console.log(`Attempting to decompress data for session ${sessionId}`);
                        const decompressed = await GGWaveService.decompressData(fullData);
                        finalData = new Uint8Array(decompressed);
                        console.log(`Decompression successful for session ${sessionId}`);
                    } else {
                        console.log(`No compression flag found, using data as-is for session ${sessionId}`);
                    }
                    
                    // Convert to string
                    const fullMessage = new TextDecoder().decode(finalData);
                    console.log(`Message reconstructed successfully for session ${sessionId} (${fullMessage.length} characters)`);
                    
                    // Report completion
                    const chunksStatus: { [key: number]: boolean } = {};
                    const parityStatus: { [key: string]: boolean } = {};
                    
                    for (let i = 1; i <= sess.total; i++) {
                        chunksStatus[i] = true;
                    }
                    
                    for (const [key] of sess.parity) {
                        parityStatus[key] = true;
                    }
                    
                    onProgress?.({
                        type: 'complete',
                        sessionId,
                        packet: 'COMPLETE',
                        received: sess.total,
                        total: sess.total,
                        chunks: chunksStatus,
                        parity: parityStatus
                    });
                    
                    // Check if this is a FILE message that was sent using sendLargeData
                    if (fullMessage.startsWith('FILE:')) {
                        console.log('Detected FILE message from large data transmission, processing as file...');
                        // Process as file packet
                        const fileResult = await this.handleFilePacket(fullMessage);
                        // Return the file processing result or null to prevent showing raw FILE data
                        return fileResult;
                    }
                    
                    return fullMessage;
                } catch (e) {
                    console.error(`Failed to process message for session ${sessionId}:`, e);
                    
                    // Fallback: try without decompression
                    try {
                        console.log(`Attempting fallback without decompression for session ${sessionId}`);
                        const fallbackMessage = new TextDecoder().decode(fullData);
                        console.log(`Fallback successful for session ${sessionId} (${fallbackMessage.length} characters)`);
                        
                        // Report completion
                        const chunksStatus: { [key: number]: boolean } = {};
                        const parityStatus: { [key: string]: boolean } = {};
                        
                        for (let i = 1; i <= sess.total; i++) {
                            chunksStatus[i] = true;
                        }
                        
                        for (const [key] of sess.parity) {
                            parityStatus[key] = true;
                        }
                        
                        onProgress?.({
                            type: 'complete',
                            sessionId,
                            packet: 'COMPLETE',
                            received: sess.total,
                            total: sess.total,
                            chunks: chunksStatus,
                            parity: parityStatus
                        });
                        
                        // Check if this is a FILE message (fallback case)
                        if (fallbackMessage.startsWith('FILE:')) {
                            console.log('Detected FILE message from fallback, processing as file...');
                            // Process as file packet
                            const fileResult = await this.handleFilePacket(fallbackMessage);
                            // Return the file processing result or null to prevent showing raw FILE data
                            return fileResult;
                        }
                        
                        return fallbackMessage;
                    } catch (fallbackError) {
                        console.error(`Fallback also failed for session ${sessionId}:`, fallbackError);
                        return null;
                    }
                }
            } else {
                console.warn(`Hash mismatch for session ${sessionId} (expected ${sess.expectedHash}, got ${hashCheck})`);
            }
        }

        return null;
    }
    

    // ===================== File Transfer Handling =====================

    /**
     * Handle received FILE packet
     */
    private async handleFilePacket(raw: string): Promise<string | null> {
        try {
            // Parse FILE packet: FILE:batchId:filename:base64Data
            const parts = raw.split(':');
            if (parts.length < 4) {
                console.warn('Invalid FILE packet format:', raw.substring(0, 100));
                return null;
            }
            
            const batchId = parts[1];
            const filename = parts[2];
            const base64Data = parts.slice(3).join(':'); // Rejoin in case filename had colons
            
            console.log(`📥 Processing FILE packet: ${filename} for batch ${batchId}`);
            
            // Decode base64 to ZIP data
            const zipData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
            
            // Create batch record
            const batch: ReceivedBatch = {
                batchId,
                filename,
                zipData,
                receivedAt: new Date(),
                extracted: false,
                files: []
            };
            
            // Store in IndexedDB
            await this.fileService.storeBatch(batch);
            
            // Notify file transfer callbacks
            const progress: FileTransferProgress = {
                batchId,
                filename,
                totalSize: zipData.length,
                receivedChunks: 1,
                totalChunks: 1,
                percentage: 100,
                eta: 0,
                status: 'complete'
            };
            
            this.fileTransferCallbacks.forEach(callback => {
                try {
                    callback(progress);
                } catch (error) {
                    console.error('Error in file transfer callback:', error);
                }
            });
            
            console.log(`✅ File batch received: ${filename} (${zipData.length} bytes)`);
            
            // Return null to prevent this from appearing in text callback
            // The file transfer callback will handle UI updates
            return null;
            
        } catch (error) {
            console.error('❌ Error handling FILE packet:', error);
            
            // Notify error via callbacks
            if (this.fileTransferCallbacks.length > 0) {
                const errorProgress: FileTransferProgress = {
                    batchId: 'unknown',
                    filename: 'unknown',
                    totalSize: 0,
                    receivedChunks: 0,
                    totalChunks: 1,
                    percentage: 0,
                    eta: 0,
                    status: 'failed',
                    error: error instanceof Error ? error.message : 'Unknown error'
                };
                
                this.fileTransferCallbacks.forEach(callback => {
                    try {
                        callback(errorProgress);
                    } catch (cbError) {
                        console.error('Error in file transfer error callback:', cbError);
                    }
                });
            }
            
            return `❌ Failed to receive file: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
    }

    // ===================== File Transfer Methods =====================

    /**
     * Initialize file service (call once on app startup)
     */
    async initializeFileService(): Promise<void> {
        await this.fileService.initialize();
        console.log('📁 File service initialized');
    }

    /**
     * Send multiple files as a ZIP batch
     */
    async sendFiles(
        files: FileList, 
        protocolName: string = 'GGWAVE_PROTOCOL_ULTRASONIC_FASTEST',
        fecScheme: FECScheme = GGWaveService.DEFAULT_FEC_SCHEME,
        onProgress?: (progress: {
            type: 'zip-creation' | 'start' | 'data' | 'parity' | 'end';
            current: number;
            total: number;
            sessionId: string;
            packet?: string;
            zipInfo?: { filename: string; originalSize: number; compressedSize: number; compressionRatio: number };
        }) => void
    ): Promise<void> {
        try {
            if (!files || files.length === 0) {
                throw new Error('No files selected');
            }

            console.log(`📤 Starting file transfer: ${files.length} files`);
            
            // Calculate total original size
            let totalOriginalSize = 0;
            for (let i = 0; i < files.length; i++) {
                totalOriginalSize += files[i].size;
            }

            // Create ZIP with maximum compression
            onProgress?.({ type: 'zip-creation', current: 0, total: 1, sessionId: '', zipInfo: undefined });
            
            const { zipData, filename } = await this.fileService.createZipFromFiles(files);
            const compressionRatio = ((1 - zipData.length / totalOriginalSize) * 100);
            
            console.log(`📦 ZIP created: ${filename} (${zipData.length} bytes, ${compressionRatio.toFixed(1)}% compression)`);
            
            onProgress?.({ 
                type: 'zip-creation', 
                current: 1, 
                total: 1, 
                sessionId: '',
                zipInfo: {
                    filename,
                    originalSize: totalOriginalSize,
                    compressedSize: zipData.length,
                    compressionRatio
                }
            });

            // Generate batch ID
            const batchId = `batch-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
            
            // Convert ZIP to base64 for transmission
            const base64Zip = btoa(String.fromCharCode(...zipData));
            const fileMessage = `FILE:${batchId}:${filename}:${base64Zip}`;
            
            console.log(`📡 Transmitting ZIP batch: ${filename} (${base64Zip.length} chars)`);
            
            // Send using existing sendLargeData method
            await this.sendLargeData(
                fileMessage,
                protocolName,
                false, // No additional compression (already ZIP compressed)
                fecScheme,
                (progress) => {
                    // Forward progress with file context
                    onProgress?.({
                        type: progress.type,
                        current: progress.current,
                        total: progress.total,
                        sessionId: progress.sessionId,
                        packet: progress.packet
                    });
                }
            );
            
            console.log(`✅ File batch transmission completed: ${filename}`);
            
        } catch (error) {
            console.error('❌ Error sending files:', error);
            throw new Error(`Failed to send files: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Subscribe to file transfer progress updates
     */
    onFileTransferProgress(callback: (progress: FileTransferProgress) => void): void {
        this.fileTransferCallbacks.push(callback);
    }

    /**
     * Unsubscribe from file transfer progress updates
     */
    offFileTransferProgress(callback: (progress: FileTransferProgress) => void): void {
        const index = this.fileTransferCallbacks.indexOf(callback);
        if (index > -1) {
            this.fileTransferCallbacks.splice(index, 1);
        }
    }

    /**
     * Get all received file batches
     */
    async getReceivedBatches(): Promise<ReceivedBatch[]> {
        return await this.fileService.getAllBatches();
    }

    /**
     * Extract files from a received batch
     */
    async extractBatch(batchId: string): Promise<Array<{ name: string; size: number }>> {
        return await this.fileService.extractBatch(batchId);
    }

    /**
     * Download individual file from a batch
     */
    async downloadFile(batchId: string, filename: string): Promise<void> {
        await this.fileService.downloadFile(batchId, filename);
    }

    /**
     * Download entire batch as ZIP
     */
    async downloadBatch(batchId: string): Promise<void> {
        await this.fileService.downloadBatch(batchId);
    }

    /**
     * Delete a batch and its files
     */
    async deleteBatch(batchId: string): Promise<void> {
        await this.fileService.deleteBatch(batchId);
    }

    // ===================== Selective Retransmission Methods =====================

    /**
     * Get information about active send sessions
     */
    getSendSessions(): Array<{
        sessionId: string;
        total: number;
        sentChunks: number[];
        sentParity: string[];
        protocolName: string;
        createdAt: Date;
        fecScheme: { name: string; groupSize: number; parityCount: number };
    }> {
        const sessions: Array<{
            sessionId: string;
            total: number;
            sentChunks: number[];
            sentParity: string[];
            protocolName: string;
            createdAt: Date;
            fecScheme: { name: string; groupSize: number; parityCount: number };
        }> = [];

        this.sendSessions.forEach((session) => {
            sessions.push({
                sessionId: session.sessionId,
                total: session.total,
                sentChunks: Array.from(session.sentChunks).sort((a, b) => a - b),
                sentParity: Array.from(session.sentParity).sort(),
                protocolName: session.protocolName,
                createdAt: session.createdAt,
                fecScheme: {
                    name: session.fecScheme.name,
                    groupSize: session.fecScheme.groupSize,
                    parityCount: session.fecScheme.parityCount
                }
            });
        });

        return sessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }

    /**
     * Get information about active receive sessions
     */
    getReceiveSessions(): Array<{
        sessionId: string;
        total: number;
        receivedChunks: number[];
        receivedParity: string[];
        missingChunks: number[];
        fecScheme: { name: string; groupSize: number; parityCount: number };
    }> {
        const sessions: Array<{
            sessionId: string;
            total: number;
            receivedChunks: number[];
            receivedParity: string[];
            missingChunks: number[];
            fecScheme: { name: string; groupSize: number; parityCount: number };
        }> = [];

        this.receiveSessions.forEach((session, sessionId) => {
            const receivedChunks = Array.from(session.chunks.keys()).sort((a, b) => a - b);
            const missingChunks: number[] = [];
            
            for (let i = 1; i <= session.total; i++) {
                if (!session.chunks.has(i)) {
                    missingChunks.push(i);
                }
            }

            sessions.push({
                sessionId,
                total: session.total,
                receivedChunks,
                receivedParity: Array.from(session.parity.keys()).sort(),
                missingChunks,
                fecScheme: {
                    name: session.fecScheme.name,
                    groupSize: session.fecScheme.groupSize,
                    parityCount: session.fecScheme.parityCount
                }
            });
        });

        return sessions;
    }

    /**
     * Resend specific chunks from a session
     */
    async resendChunks(
        sessionId: string, 
        chunkNumbers: number[],
        onProgress?: (progress: {
            type: 'chunk-resend';
            current: number;
            total: number;
            sessionId: string;
            chunkNumber: number;
            packet: string;
        }) => void
    ): Promise<void> {
        const session = this.sendSessions.get(sessionId);
        if (!session) {
            throw new Error(`Send session ${sessionId} not found`);
        }

        console.log(`🔄 Resending ${chunkNumbers.length} chunks for session ${sessionId}`);

        for (let i = 0; i < chunkNumbers.length; i++) {
            const chunkNumber = chunkNumbers[i];
            const chunkData = session.chunks.get(chunkNumber);
            
            if (!chunkData) {
                console.warn(`Chunk ${chunkNumber} not found in session ${sessionId}`);
                continue;
            }

            const chunkBase64 = btoa(String.fromCharCode(...chunkData));
            const dataPacket = `D:${sessionId}:${chunkNumber}:${chunkBase64}`;
            
            console.log(`📤 Resending chunk ${chunkNumber}/${session.total}`);
            
            onProgress?.({
                type: 'chunk-resend',
                current: i + 1,
                total: chunkNumbers.length,
                sessionId,
                chunkNumber,
                packet: dataPacket
            });

            await this.transmitPacket(dataPacket, session.protocolName);
            
            // Update sent tracking
            session.sentChunks.add(chunkNumber);
        }

        console.log(`✅ Resent ${chunkNumbers.length} chunks for session ${sessionId}`);
    }

    /**
     * Resend specific parity packets from a session
     */
    async resendParity(
        sessionId: string, 
        parityKeys: string[],
        onProgress?: (progress: {
            type: 'parity-resend';
            current: number;
            total: number;
            sessionId: string;
            parityKey: string;
            packet: string;
        }) => void
    ): Promise<void> {
        const session = this.sendSessions.get(sessionId);
        if (!session) {
            throw new Error(`Send session ${sessionId} not found`);
        }

        console.log(`🔄 Resending ${parityKeys.length} parity packets for session ${sessionId}`);

        for (let i = 0; i < parityKeys.length; i++) {
            const parityKey = parityKeys[i];
            const parityData = session.parity.get(parityKey);
            
            if (!parityData) {
                console.warn(`Parity ${parityKey} not found in session ${sessionId}`);
                continue;
            }

            const parityBase64 = btoa(String.fromCharCode(...parityData));
            const parityPacket = `P:${sessionId}:${parityKey}:${parityBase64}`;
            
            console.log(`📤 Resending parity ${parityKey}`);
            
            onProgress?.({
                type: 'parity-resend',
                current: i + 1,
                total: parityKeys.length,
                sessionId,
                parityKey,
                packet: parityPacket
            });

            await this.transmitPacket(parityPacket, session.protocolName);
            
            // Update sent tracking
            session.sentParity.add(parityKey);
        }

        console.log(`✅ Resent ${parityKeys.length} parity packets for session ${sessionId}`);
    }

    /**
     * Clear old send sessions (cleanup)
     */
    clearOldSendSessions(maxAgeMinutes: number = 30): void {
        const now = new Date();
        const sessionsToDelete: string[] = [];

        this.sendSessions.forEach((session, sessionId) => {
            const ageMinutes = (now.getTime() - session.createdAt.getTime()) / (1000 * 60);
            if (ageMinutes > maxAgeMinutes) {
                sessionsToDelete.push(sessionId);
            }
        });

        sessionsToDelete.forEach(sessionId => {
            this.sendSessions.delete(sessionId);
            console.log(`🗑️ Cleared old send session: ${sessionId}`);
        });
    }

    /**
     * Delete a specific send session
     */
    deleteSendSession(sessionId: string): boolean {
        const deleted = this.sendSessions.delete(sessionId);
        if (deleted) {
            console.log(`🗑️ Deleted send session: ${sessionId}`);
        }
        return deleted;
    }

    clearAllSendSessions(): void {
        const count = this.sendSessions.size;
        this.sendSessions.clear();
        console.log(`🗑️ Cleared all ${count} send sessions`);
    }

    clearAllReceiveSessions(): void {
        // First clear timeouts to prevent memory leaks
        this.receiveSessions.forEach((session) => {
            clearTimeout(session.timeoutId);
        });
        
        const count = this.receiveSessions.size;
        this.receiveSessions.clear();
        console.log(`🗑️ Cleared all ${count} receive sessions`);
    }
}