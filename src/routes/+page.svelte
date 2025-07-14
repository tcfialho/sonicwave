<script lang="ts">
    import { onMount } from 'svelte';
    import { GGWaveService } from '$lib/ggwave-service';
    
    let ggwaveService: GGWaveService;
    let textToSend = '';
    let receivedText = '';
    let isInitialized = false;
    let isListening = false;
    let volume = 80;
    let selectedProtocol = 'GGWAVE_PROTOCOL_ULTRASONIC_NORMAL';
    let status = 'Ready';
    let receivedMessages: Array<{text: string, timestamp: Date}> = [];
    let availableProtocols: Array<{id: string, name: string, description: string}> = [];
    let hasAudible = false;
    let hasUltrasonic = false;
    let hasDualTone = false;
    let hasMonoTone = false;

    onMount(async () => {
        ggwaveService = new GGWaveService();
        try {
            await ggwaveService.initialize();
            isInitialized = true;
            availableProtocols = ggwaveService.getAvailableProtocols();
            
            // Detect which protocol categories are available
            hasAudible = availableProtocols.some(p => p.id.includes('AUDIBLE') || p.name.includes('🔊'));
            hasUltrasonic = availableProtocols.some(p => p.id.includes('ULTRASONIC') || p.id.includes('ULTRASOUND') || p.name.includes('🔇'));
            hasDualTone = availableProtocols.some(p => p.id.includes('DT') || p.name.includes('⚡'));
            hasMonoTone = availableProtocols.some(p => p.id.includes('MT') || p.name.includes('📡'));
            
            // Set ultrasonic normal as default if available, otherwise use first available
            const ultrasonicNormal = availableProtocols.find(p => 
                p.id === 'GGWAVE_PROTOCOL_ULTRASONIC_NORMAL' || 
                p.id === 'GGWAVE_PROTOCOL_ULTRASOUND_NORMAL'
            );
            
            if (ultrasonicNormal) {
                selectedProtocol = ultrasonicNormal.id;
            } else if (availableProtocols.length > 0) {
                selectedProtocol = availableProtocols[0].id;
            }
            
            if (availableProtocols.length > 0) {
                status = `GGWave initialized - Ready to transmit/receive (${availableProtocols.length} protocols available)`;
            } else {
                status = 'GGWave initialized but no protocols found - check console';
            }
        } catch (error) {
            status = `Failed to initialize: ${error}`;
        }
    });

    async function sendText() {
        if (!isInitialized || !textToSend.trim()) return;
        
        try {
            status = 'Encoding text to sound...';
            const soundData = await ggwaveService.textToSound(textToSend, volume, selectedProtocol);
            
            status = 'Playing sound transmission...';
            await ggwaveService.playSound(soundData);
            
            const protocolName = availableProtocols.find(p => p.id === selectedProtocol)?.name || selectedProtocol;
            status = `Transmitted: "${textToSend}" using ${protocolName}`;
            textToSend = ''; // Clear text automatically after transmission
        } catch (error) {
            status = `Transmission failed: ${error}`;
        }
    }

    async function startListening() {
        if (!isInitialized || isListening) return;
        
        try {
            isListening = true;
            status = 'Listening for transmissions...';
            
            await ggwaveService.startListening((text: string) => {
                const message = {
                    text: text,
                    timestamp: new Date()
                };
                receivedMessages = [message, ...receivedMessages];
                receivedText = text;
                status = `Received: "${text}"`;
            });
        } catch (error) {
            status = `Failed to start listening: ${error}`;
            isListening = false;
        }
    }

    function clearReceived() {
        receivedMessages = [];
        receivedText = '';
    }

    function clearTextInput() {
        textToSend = '';
        status = 'Text input cleared';
    }


</script>

<svelte:head>
    <title>SonicWave - Text over Sound</title>
</svelte:head>

<main>
    <h1>🔊 SonicWave</h1>
    <p>Transmit and receive text using sound waves with maximum noise tolerance</p>
    
    <div class="status-bar">
        <strong>Status:</strong> {status}
    </div>

    <div class="container">
        <div class="panel">
            <h2>📤 Send Text</h2>
            <div class="form-group">
                <label for="textInput">Text to transmit:</label>
                <textarea 
                    id="textInput"
                    bind:value={textToSend} 
                    placeholder="Enter text to transmit via sound..."
                    rows="3"
                    maxlength="100">
                </textarea>
                <small>Maximum 100 characters for reliable transmission</small>
            </div>
            
            <div class="form-group">
                <label for="volume">Volume: {volume}%</label>
                <input 
                    id="volume"
                    type="range" 
                    bind:value={volume} 
                    min="30" 
                    max="100" 
                    step="5">
                <small>Recommended range: 40-80% (ggwave auto-scales internally)</small>
            </div>
            
            <div class="form-group">
                <label for="protocol">Transmission Mode:</label>
                <select id="protocol" bind:value={selectedProtocol} class="protocol-select">
                    {#each availableProtocols as protocol}
                        <option value={protocol.id}>
                            {protocol.name}
                        </option>
                    {/each}
                </select>
                <small class="protocol-description">
                    {availableProtocols.find(p => p.id === selectedProtocol)?.description || 'Select a protocol'}
                </small>
            </div>
            
            <div class="button-group">
                <button 
                    on:click={sendText} 
                    disabled={!isInitialized || !textToSend.trim()}
                    class="btn btn-primary">
                    🎵 Transmit Text
                </button>
                
                <button 
                    on:click={clearTextInput} 
                    disabled={!textToSend.trim()}
                    class="btn btn-secondary">
                    🗑️ Clear
                </button>
            </div>
        </div>

        <div class="panel">
            <h2>📥 Receive Text</h2>
            
            <button 
                on:click={startListening} 
                disabled={!isInitialized || isListening}
                class="btn btn-secondary">
                {isListening ? '🎧 Listening...' : '🎧 Start Listening'}
            </button>
            
            {#if receivedText}
                <div class="received-text">
                    <h3>Latest Received:</h3>
                    <div class="message">{receivedText}</div>
                </div>
            {/if}
            
            {#if receivedMessages.length > 0}
                <div class="message-history">
                    <div class="history-header">
                        <h3>Message History</h3>
                        <button on:click={clearReceived} class="btn btn-small">Clear</button>
                    </div>
                    {#each receivedMessages as message}
                        <div class="message-item">
                            <div class="message-text">{message.text}</div>
                            <div class="message-time">{message.timestamp.toLocaleTimeString()}</div>
                        </div>
                    {/each}
                </div>
            {/if}
        </div>
    </div>

    <div class="info-panel">
        <h3>ℹ️ GGWave Protocol Guide</h3>
        <p>GGWave offers 12 different transmission protocols (0-11) for various use cases:</p>
        
        <div class="protocol-info">
            {#if hasAudible}
            <h4>🔊 Standard Audible Protocols (0-2)</h4>
            <ul>
                <li><strong>Normal (0):</strong> 8 bytes/sec, F0=1875Hz, most robust (recommended)</li>
                <li><strong>Fast (1):</strong> 12 bytes/sec, balanced speed/robustness</li>
                <li><strong>Fastest (2):</strong> 16 bytes/sec, fastest but least robust</li>
            </ul>
            {/if}
            
            {#if hasUltrasonic}
            <h4>🔇 Ultrasonic Protocols [U] (3-5)</h4>
            <ul>
                <li><strong>Ultrasonic Normal (3):</strong> F0=15000Hz, inaudible to humans</li>
                <li><strong>Ultrasonic Fast/Fastest (4-5):</strong> Silent, varying speeds</li>
            </ul>
            <p><em>Note: Requires devices/speakers capable of ultrasonic frequencies (15kHz+)</em></p>
            {/if}
            
            {#if hasDualTone}
            <h4>⚡ Dual-Tone [DT] Protocols (6-8)</h4>
            <ul>
                <li><strong>Purpose:</strong> Optimized for microcontrollers and IoT devices</li>
                <li><strong>Characteristic:</strong> Uses dual-tone modulation technique</li>
                <li><strong>Use case:</strong> Arduino, ESP32, embedded systems</li>
            </ul>
            {/if}
            
            {#if hasMonoTone}
            <h4>📡 Mono-Tone [MT] Protocols (9-11)</h4>
            <ul>
                <li><strong>Purpose:</strong> Alternative for microcontrollers with limited processing</li>
                <li><strong>Characteristic:</strong> Uses single-tone modulation</li>
                <li><strong>Use case:</strong> Simple embedded systems, lower-power devices</li>
            </ul>
            {/if}
        </div>
        
        <p><strong>Technical Details:</strong></p>
        <ul>
            <li><strong>Modulation:</strong> Multi-frequency FSK (Frequency-Shift Keying)</li>
            <li><strong>Error Correction:</strong> Reed-Solomon coding</li>
            <li><strong>Data Encoding:</strong> 4-bit chunks, 3 bytes using 6 tones</li>
            <li><strong>Frequency Spacing:</strong> dF = 46.875 Hz</li>
        </ul>
        <p><strong>Tips for best results:</strong></p>
        <ul>
            <li>Keep messages short (under 50 characters recommended)</li>
            <li>Use high volumes (70-100%) for better audibility</li>
            <li>Minimize background noise when possible</li>
            <li>Keep devices relatively close (1-3 meters)</li>
            <li>Test audio first to ensure speakers are working</li>
            <li>Try with headphones if having issues</li>
        </ul>
        
        <p><strong>Troubleshooting:</strong></p>
        <ul>
            <li>If you don't hear anything, click "Test Audio" first</li>
            <li>Check browser audio permissions</li>
            <li>Try increasing volume to 100%</li>
            <li>Make sure your computer speakers/headphones are on</li>
            <li>Try a short test message like "hi" first</li>
        </ul>
    </div>
</main>

<style>
    main {
        max-width: 1200px;
        margin: 0 auto;
        padding: 20px;
        font-family: 'Segoe UI', system-ui, sans-serif;
    }

    h1 {
        text-align: center;
        color: #333;
        margin-bottom: 10px;
    }

    .status-bar {
        background: #f0f8ff;
        border: 1px solid #4a90e2;
        border-radius: 8px;
        padding: 12px;
        margin: 20px 0;
        text-align: center;
        font-family: monospace;
    }

    .container {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 30px;
        margin: 30px 0;
    }

    .panel {
        background: #ffffff;
        border: 2px solid #e1e5e9;
        border-radius: 12px;
        padding: 25px;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }

    .panel h2 {
        margin-top: 0;
        color: #2c3e50;
        border-bottom: 2px solid #ecf0f1;
        padding-bottom: 10px;
    }

    .form-group {
        margin-bottom: 20px;
    }

    label {
        display: block;
        margin-bottom: 8px;
        font-weight: 600;
        color: #34495e;
    }

    textarea, input[type="range"], .protocol-select {
        width: 100%;
        padding: 12px;
        border: 2px solid #bdc3c7;
        border-radius: 6px;
        font-size: 14px;
        transition: border-color 0.3s;
    }

    textarea:focus, .protocol-select:focus {
        outline: none;
        border-color: #4a90e2;
    }
    
    .protocol-select {
        background: white;
        cursor: pointer;
    }
    
    .protocol-description {
        font-style: italic;
        color: #5a6c7d !important;
    }

    input[type="range"] {
        padding: 0;
        height: 8px;
        background: #ecf0f1;
    }

    small {
        display: block;
        margin-top: 5px;
        color: #7f8c8d;
        font-size: 12px;
    }

    .btn {
        padding: 12px 24px;
        border: none;
        border-radius: 6px;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s;
        margin-right: 10px;
    }

    .btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }

    .btn-primary {
        background: #4a90e2;
        color: white;
    }

    .btn-primary:hover:not(:disabled) {
        background: #357abd;
        transform: translateY(-2px);
    }

    .btn-secondary {
        background: #27ae60;
        color: white;
    }

    .btn-secondary:hover:not(:disabled) {
        background: #229954;
        transform: translateY(-2px);
    }

    .btn-small {
        padding: 6px 12px;
        font-size: 12px;
    }

    .button-group {
        display: flex;
        gap: 10px;
        margin-bottom: 15px;
    }

    .button-group .btn {
        margin-right: 0;
    }

    .received-text {
        margin-top: 20px;
        padding: 15px;
        background: #e8f5e8;
        border-radius: 8px;
        border-left: 4px solid #27ae60;
    }

    .message {
        font-family: monospace;
        font-size: 16px;
        font-weight: bold;
        color: #2c3e50;
        word-break: break-all;
    }

    .message-history {
        margin-top: 20px;
        max-height: 300px;
        overflow-y: auto;
    }

    .history-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 15px;
    }

    .history-header h3 {
        margin: 0;
    }

    .message-item {
        background: #f8f9fa;
        border: 1px solid #e9ecef;
        border-radius: 6px;
        padding: 10px;
        margin-bottom: 10px;
    }

    .message-text {
        font-family: monospace;
        font-weight: bold;
        margin-bottom: 5px;
    }

    .message-time {
        font-size: 12px;
        color: #6c757d;
    }

    .info-panel {
        background: #f8f9fa;
        border: 1px solid #dee2e6;
        border-radius: 8px;
        padding: 20px;
        margin-top: 30px;
    }

    .info-panel h3 {
        margin-top: 0;
        color: #495057;
    }

    .info-panel ul {
        padding-left: 20px;
    }

    .info-panel li {
        margin-bottom: 5px;
    }
    
    .protocol-info {
        background: #f8f9fa;
        border: 1px solid #e9ecef;
        border-radius: 6px;
        padding: 15px;
        margin: 15px 0;
    }
    
    .protocol-info h4 {
        margin-top: 0;
        margin-bottom: 10px;
        color: #495057;
    }
    
    .protocol-info p {
        margin-bottom: 5px;
    }

    @media (max-width: 768px) {
        .container {
            grid-template-columns: 1fr;
            gap: 20px;
        }
        
        main {
            padding: 15px;
        }
    }
</style>
