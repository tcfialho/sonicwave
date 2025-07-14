<script lang="ts">
    import { onMount } from 'svelte';
    import { GGWaveService } from '$lib/ggwave-service';
    
    let ggwaveService: GGWaveService;
    let textToSend = '';
    let receivedText = '';
    let isInitialized = false;
    let isListening = false;
    let selectedProtocol = 'GGWAVE_PROTOCOL_ULTRASONIC_FASTEST';
    let useCompression = false;
    let selectedFecScheme = 'BASIC_3';
    let status = 'Ready';
    let receivedMessages: Array<{text: string, timestamp: Date}> = [];
    let availableProtocols: Array<{id: string, name: string, description: string}> = [];
    let hasAudible = false;
    let hasUltrasonic = false;
    let hasDualTone = false;
    let hasMonoTone = false;
    let isTransmitting = false;
    let activeTab: 'send' | 'receive' = 'send';
    let showHelpModal = false;
    
    // Progress tracking
    let transmissionProgress = {
        sessionId: '',
        totalChunks: 0,
        currentChunk: 0,
        phase: 'idle' as 'idle' | 'start' | 'data' | 'parity' | 'end',
        lastPacket: ''
    };
    
    let receptionProgress = {
        sessionId: '',
        totalChunks: 0,
        receivedChunks: 0,
        chunks: {} as { [key: number]: boolean },
        parity: {} as { [key: string]: boolean },
        phase: 'idle' as 'idle' | 'start' | 'data' | 'parity' | 'end' | 'complete',
        lastPacket: ''
    };
    
    // Debug information
    let debugInfo = {
        totalReceived: 0,
        totalFailed: 0,
        sessions: [] as string[]
    };

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
            
            // Set ultrasonic fastest as default if available, otherwise fallback
            const ultrasonicFastest = availableProtocols.find(p => 
                p.id === 'GGWAVE_PROTOCOL_ULTRASONIC_FASTEST' || 
                p.id === 'GGWAVE_PROTOCOL_ULTRASOUND_FASTEST'
            );
            
            const ultrasonicNormal = availableProtocols.find(p => 
                p.id === 'GGWAVE_PROTOCOL_ULTRASONIC_NORMAL' || 
                p.id === 'GGWAVE_PROTOCOL_ULTRASOUND_NORMAL'
            );
            
            if (ultrasonicFastest) {
                selectedProtocol = ultrasonicFastest.id;
            } else if (ultrasonicNormal) {
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
        if (!isInitialized || !textToSend.trim() || isTransmitting) return;
        
        isTransmitting = true;
        
        try {
            status = useCompression ? '🔄 Compressing & transmitting...' : '🔄 Encoding & transmitting...';
            
            // Reset progress
            transmissionProgress = {
                sessionId: '',
                totalChunks: 0,
                currentChunk: 0,
                phase: 'idle',
                lastPacket: ''
            };
            
            // Get FEC scheme from service
            const fecScheme = (ggwaveService.constructor as any).FEC_SCHEMES[selectedFecScheme] || (ggwaveService.constructor as any).DEFAULT_FEC_SCHEME;
            
            await ggwaveService.sendLargeData(textToSend, selectedProtocol, useCompression, fecScheme, (progress) => {
                transmissionProgress = {
                    sessionId: progress.sessionId,
                    totalChunks: progress.total,
                    currentChunk: progress.current,
                    phase: progress.type,
                    lastPacket: progress.packet
                };
                
                if (progress.type === 'start') {
                    const fecInfo = progress.fecInfo ? ` (FEC: ${progress.fecInfo.scheme})` : '';
                    status = `🚀 Starting transmission (${progress.total} chunks)${fecInfo}`;
                } else if (progress.type === 'data') {
                    status = `📤 Sending chunk ${progress.current}/${progress.total}`;
                } else if (progress.type === 'parity') {
                    status = `🔧 Sending parity ${progress.current}/${progress.total}`;
                } else if (progress.type === 'end') {
                    status = `🏁 Finalizing transmission`;
                }
            });

            const protocolName = availableProtocols.find(p => p.id === selectedProtocol)?.name || selectedProtocol;
            const compressionNote = useCompression ? ' (compressed)' : '';
            status = `✅ Transmitted using ${protocolName}${compressionNote}`;
            
            // Reset progress after completion
            transmissionProgress.phase = 'idle';
        } catch (error) {
            status = `❌ Transmission failed: ${error}`;
            transmissionProgress.phase = 'idle';
        } finally {
            isTransmitting = false;
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
                
                status = `📥 Message received (${text.length} characters)`;
                
                // Reset reception progress
                receptionProgress.phase = 'idle';
            }, (progress) => {
                receptionProgress = {
                    sessionId: progress.sessionId,
                    totalChunks: progress.total,
                    receivedChunks: progress.received,
                    chunks: progress.chunks,
                    parity: progress.parity,
                    phase: progress.type,
                    lastPacket: progress.packet
                };
                
                // Update debug info
                debugInfo.totalReceived++;
                if (!debugInfo.sessions.includes(progress.sessionId)) {
                    debugInfo.sessions.push(progress.sessionId);
                }
                
                if (progress.type === 'start') {
                    status = `🎯 Receiving transmission (${progress.total} chunks expected)`;
                } else if (progress.type === 'data') {
                    status = `📥 Received chunk ${progress.received}/${progress.total}`;
                } else if (progress.type === 'parity') {
                    status = `🔧 Received parity data`;
                } else if (progress.type === 'end') {
                    status = `🏁 Transmission ending`;
                } else if (progress.type === 'complete') {
                    status = `✅ Message reconstructed successfully`;
                }
            });
        } catch (error) {
            status = `Failed to start listening: ${error}`;
            isListening = false;
        }
    }

    function clearReceived() {
        receivedMessages = [];
        receivedText = '';
        receptionProgress.phase = 'idle';
        debugInfo = {
            totalReceived: 0,
            totalFailed: 0,
            sessions: []
        };
    }

    function clearTextInput() {
        textToSend = '';
        status = 'Text input cleared';
    }


    async function stopListening() {
        // Note: In a real implementation, you'd need to stop the media stream
        // For now, we'll just reset the listening state
        isListening = false;
        status = 'Stopped listening';
    }

    async function handleReceiveTabClick() {
        activeTab = 'receive';
        if (!isListening && isInitialized) {
            await startListening();
        }
    }

    async function copyToClipboard(text: string) {
        try {
            await navigator.clipboard.writeText(text);
            status = `📋 Copied to clipboard: "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`;
        } catch (err) {
            // Fallback para browsers antigos
            const textArea = document.createElement('textarea');
            textArea.value = text;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            status = `📋 Copied to clipboard: "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`;
        }
    }


</script>

<svelte:head>
    <title>SonicWave - Text over Sound</title>
</svelte:head>

<main>
    <h1>🔊 SonicWave</h1>
    
    <!-- Fixed Status Bar -->
    <div class="status-bar-fixed">
        <div class="status-content">
            <strong>Status:</strong> {status}
        </div>
    </div>

    <!-- Modern Tab Interface -->
    <div class="tab-container">
        <div class="tab-header">
            <button 
                class="tab-button {activeTab === 'send' ? 'active' : ''}" 
                on:click={() => activeTab = 'send'}>
                📤 Send Text
            </button>
            <button 
                class="tab-button {activeTab === 'receive' ? 'active' : ''}" 
                on:click={handleReceiveTabClick}>
                📥 Receive Text
            </button>
        </div>
        
        <div class="tab-content">
            {#if activeTab === 'send'}
                <div class="panel send-panel">
                    <div class="form-group">
                        <label for="textInput">Text to transmit:</label>
                        <textarea 
                            id="textInput"
                            bind:value={textToSend} 
                            placeholder="Enter text to transmit via sound..."
                            rows="4">
                        </textarea>
                        <small>{textToSend.length} characters</small>
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
                    
                    <div class="form-group">
                        <label class="checkbox-label">
                            <input type="checkbox" bind:checked={useCompression} />
                            <span class="checkbox-text">Use gzip compression</span>
                        </label>
                        <small>Compress data before transmission (reduces size, increases processing time)</small>
                    </div>
                    
                    <div class="form-group">
                        <label for="fecScheme">Error Correction (FEC):</label>
                        <select id="fecScheme" bind:value={selectedFecScheme} class="protocol-select">
                            <option value="NONE">None - No error correction</option>
                            <option value="BASIC_2">Basic 2+1 - Can recover 1 lost packet per 2</option>
                            <option value="BASIC_3">Basic 3+1 - Can recover 1 lost packet per 3 (default)</option>
                            <option value="BASIC_4">Basic 4+1 - Can recover 1 lost packet per 4</option>
                            <option value="ENHANCED_2">Enhanced 2+2 - Can recover 2 lost packets per 2</option>
                            <option value="ENHANCED_3">Enhanced 3+2 - Can recover 2 lost packets per 3</option>
                            <option value="OVERLAPPING_3">Overlapping 3+1 - Extra redundancy with overlapping groups</option>
                        </select>
                        <small class="fec-description">
                            {#if selectedFecScheme === 'NONE'}
                                No error correction - fastest but no protection against packet loss
                            {:else if selectedFecScheme === 'BASIC_2'}
                                Groups of 2 data packets + 1 parity packet. Can recover if 1 packet is lost.
                            {:else if selectedFecScheme === 'BASIC_3'}
                                Groups of 3 data packets + 1 parity packet. Can recover if 1 packet is lost.
                            {:else if selectedFecScheme === 'BASIC_4'}
                                Groups of 4 data packets + 1 parity packet. Can recover if 1 packet is lost.
                            {:else if selectedFecScheme === 'ENHANCED_2'}
                                Groups of 2 data packets + 2 parity packets. Can recover if up to 2 packets are lost.
                            {:else if selectedFecScheme === 'ENHANCED_3'}
                                Groups of 3 data packets + 2 parity packets. Can recover if up to 2 packets are lost.
                            {:else if selectedFecScheme === 'OVERLAPPING_3'}
                                Overlapping groups provide extra redundancy for better recovery in noisy environments.
                            {/if}
                        </small>
                    </div>
                    
                    <!-- Transmission Progress -->
                    {#if transmissionProgress.phase !== 'idle'}
                        <div class="progress-section">
                            <h4>📤 Transmission Progress</h4>
                            <div class="progress-info">
                                <div class="progress-header">
                                    <span>Session: {transmissionProgress.sessionId}</span>
                                    <span>Phase: {transmissionProgress.phase.toUpperCase()}</span>
                                </div>
                                <div class="progress-subheader">
                                    <span>FEC Scheme: {ggwaveService ? (ggwaveService.constructor as any).FEC_SCHEMES[selectedFecScheme]?.name || selectedFecScheme : selectedFecScheme}</span>
                                    <span>Group Size: {ggwaveService ? (ggwaveService.constructor as any).FEC_SCHEMES[selectedFecScheme]?.groupSize || 'N/A' : 'N/A'}</span>
                                </div>
                                
                                <div class="progress-bar-container">
                                    <div class="progress-bar-bg">
                                        <div 
                                            class="progress-bar-fill" 
                                            style="width: {transmissionProgress.totalChunks > 0 ? (transmissionProgress.currentChunk / transmissionProgress.totalChunks) * 100 : 0}%"
                                        ></div>
                                    </div>
                                    <span class="progress-text">{transmissionProgress.currentChunk}/{transmissionProgress.totalChunks}</span>
                                </div>
                                
                                <div class="chunk-grid">
                                    {#each Array(transmissionProgress.totalChunks) as _, i}
                                        <div class="chunk-indicator {i < transmissionProgress.currentChunk ? 'sent' : 'pending'}">
                                            {i + 1}
                                        </div>
                                    {/each}
                                </div>
                                
                                <div class="last-packet">
                                    <small>Last packet: {transmissionProgress.lastPacket}</small>
                                </div>
                            </div>
                        </div>
                    {/if}
                </div>
            {:else}
                <div class="panel receive-panel">
                    {#if receivedText}
                        <div class="received-text">
                            <div class="received-header">
                                <h3>Latest Received:</h3>
                                <button on:click={() => copyToClipboard(receivedText)} class="btn btn-small copy-btn">
                                    📋 Copy
                                </button>
                            </div>
                            <div class="message-container">
                                <div class="message">{receivedText}</div>
                            </div>
                        </div>
                    {/if}
                    
                    <!-- Reception Progress -->
                    {#if receptionProgress.phase !== 'idle'}
                        <div class="progress-section">
                            <h4>📥 Reception Progress</h4>
                            <div class="progress-info">
                                <div class="progress-header">
                                    <span>Session: {receptionProgress.sessionId}</span>
                                    <span>Phase: {receptionProgress.phase.toUpperCase()}</span>
                                </div>
                                <div class="progress-subheader">
                                    <span>Detecting FEC scheme from transmission...</span>
                                </div>
                                
                                <div class="progress-bar-container">
                                    <div class="progress-bar-bg">
                                        <div 
                                            class="progress-bar-fill receive" 
                                            style="width: {receptionProgress.totalChunks > 0 ? (receptionProgress.receivedChunks / receptionProgress.totalChunks) * 100 : 0}%"
                                        ></div>
                                    </div>
                                    <span class="progress-text">{receptionProgress.receivedChunks}/{receptionProgress.totalChunks}</span>
                                </div>
                                
                                <div class="chunk-grid">
                                    {#each Array(receptionProgress.totalChunks) as _, i}
                                        <div class="chunk-indicator {receptionProgress.chunks[i + 1] ? 'received' : 'missing'}">
                                            {i + 1}
                                        </div>
                                    {/each}
                                </div>
                                
                                {#if Object.keys(receptionProgress.parity).length > 0}
                                    <div class="parity-info">
                                        <h5>🔧 Parity Data</h5>
                                        <div class="parity-grid">
                                            {#each Object.entries(receptionProgress.parity) as [range, received]}
                                                <div class="parity-indicator {received ? 'received' : 'missing'}">
                                                    P{range}
                                                </div>
                                            {/each}
                                        </div>
                                    </div>
                                {/if}
                                
                                <div class="last-packet">
                                    <small>Last packet: {receptionProgress.lastPacket}</small>
                                </div>
                                
                                <div class="debug-info">
                                    <h5>🔍 Debug Information</h5>
                                    <div class="debug-grid">
                                        <span>Total packets received: {debugInfo.totalReceived}</span>
                                        <span>Active sessions: {debugInfo.sessions.length}</span>
                                        <span>Latest session: {debugInfo.sessions[debugInfo.sessions.length - 1] || 'None'}</span>
                                    </div>
                                </div>
                            </div>
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
                                    <div class="message-content">
                                        <div class="message-text">{message.text}</div>
                                        <div class="message-time">{message.timestamp.toLocaleTimeString()}</div>
                                    </div>
                                    <button on:click={() => copyToClipboard(message.text)} class="btn btn-small copy-btn-small">
                                        📋
                                    </button>
                                </div>
                            {/each}
                        </div>
                    {:else if receptionProgress.phase === 'idle'}
                        <div class="no-messages">
                            <p>No messages received yet. Start listening to capture incoming transmissions.</p>
                        </div>
                    {/if}
                </div>
            {/if}
        </div>
    </div>

    <!-- Help Modal -->
    {#if showHelpModal}
        <div
            class="modal-overlay"
            role="button"
            tabindex="0"
            on:click={(e) => {
                if (e.currentTarget === e.target) {
                    showHelpModal = false;
                }
            }}
            on:keydown={(e) => {
                if (e.currentTarget === e.target && (e.key === 'Enter' || e.key === ' ')) {
                    showHelpModal = false;
                }
            }}
        >
            <div class="modal-content" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <h3>ℹ️ GGWave Protocol Guide</h3>
                    <button class="modal-close" on:click={() => showHelpModal = false}>✕</button>
                </div>
                
                <div class="modal-body">
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
            </div>
        </div>
    {/if}

    <!-- Fixed Controls at Bottom -->
    <div class="controls-section">
        <div class="controls-container">
            <div class="button-group">
                {#if activeTab === 'send'}
                    <button 
                        on:click={sendText} 
                        disabled={!isInitialized || !textToSend.trim() || isTransmitting}
                        class="btn btn-primary {isTransmitting ? 'transmitting' : ''}">
                        {#if isTransmitting}
                            <span class="spinner"></span> Transmitting...
                        {:else}
                            🎵 Transmit Text
                        {/if}
                    </button>
                    
                    <button 
                        on:click={clearTextInput} 
                        disabled={!textToSend.trim() || isTransmitting}
                        class="btn btn-secondary">
                        🗑️ Clear
                    </button>
                {:else}
                    <button 
                        on:click={isListening ? stopListening : startListening} 
                        disabled={!isInitialized}
                        class="btn btn-primary">
                        {isListening ? '🛑 Stop Listening' : '🎧 Start Listening'}
                    </button>
                    
                    <button 
                        on:click={clearReceived} 
                        disabled={receivedMessages.length === 0}
                        class="btn btn-secondary">
                        🗑️ Clear History
                    </button>
                {/if}
                
                <button 
                    on:click={() => showHelpModal = true} 
                    class="btn btn-help"
                    title="Protocol Help & Guide">
                    ❓ Help
                </button>
                
            </div>
            
            <!-- Progress bar appears below buttons -->
            {#if isTransmitting}
                <div class="transmission-progress">
                    <div class="progress-bar">
                        <div class="progress-fill"></div>
                    </div>
                    <div class="progress-text">{status}</div>
                </div>
            {/if}
        </div>
    </div>
</main>

<style>
    /* Global box-sizing fix */
    *, *::before, *::after {
        box-sizing: border-box;
    }

    main {
        max-width: 1200px;
        margin: 0 auto;
        padding: 20px 20px 120px 20px; /* Extra bottom padding for fixed controls */
        padding-top: 80px; /* Space for fixed status bar */
        font-family: 'Segoe UI', system-ui, sans-serif;
        overflow-x: hidden; /* Prevent horizontal scroll */
    }

    h1 {
        text-align: center;
        color: #333;
        margin-bottom: 10px;
    }

    /* Fixed Status Bar */
    .status-bar-fixed {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        background: #f0f8ff;
        border-bottom: 2px solid #4a90e2;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        z-index: 1001;
        backdrop-filter: blur(10px);
    }
    
    .status-content {
        max-width: 1200px;
        margin: 0 auto;
        padding: 12px 20px;
        text-align: center;
        font-family: monospace;
        font-size: 14px;
        color: #2c3e50;
    }

    .progress-bar {
        width: 100%;
        height: 4px;
        background: rgba(39, 174, 96, 0.2);
        border-radius: 2px;
        margin-top: 8px;
        overflow: hidden;
    }

    .progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #27ae60, #2ecc71);
        border-radius: 2px;
        animation: progress 2s ease-in-out infinite;
    }

    @keyframes progress {
        0% { width: 0%; transform: translateX(-100%); }
        50% { width: 100%; transform: translateX(0%); }
        100% { width: 100%; transform: translateX(100%); }
    }

    /* Tab Container */
    .tab-container {
        margin: 20px 0;
        background: white;
        border-radius: 12px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        overflow: hidden;
    }
    
    .tab-header {
        display: flex;
        background: #f8f9fa;
        border-bottom: 1px solid #e1e5e9;
    }
    
    .tab-button {
        flex: 1;
        background: none;
        border: none;
        padding: 16px 20px;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s;
        color: #6c757d;
        border-bottom: 3px solid transparent;
    }
    
    .tab-button:hover {
        background: #e9ecef;
        color: #495057;
    }
    
    .tab-button.active {
        background: white;
        color: #4a90e2;
        border-bottom-color: #4a90e2;
        position: relative;
    }
    
    .tab-content {
        min-height: 400px;
    }

    .panel {
        background: #ffffff;
        padding: 30px;
        box-sizing: border-box;
        max-width: 100%;
        overflow: hidden;
    }
    
    .send-panel, .receive-panel {
        min-height: 350px;
    }


    .form-group {
        margin-bottom: 20px;
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
    }

    label {
        display: block;
        margin-bottom: 8px;
        font-weight: 600;
        color: #34495e;
    }

    textarea, .protocol-select {
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
        padding: 12px;
        border: 2px solid #bdc3c7;
        border-radius: 6px;
        font-size: 14px;
        transition: border-color 0.3s;
        resize: vertical; /* Allow only vertical resize */
    }
    
    textarea {
        overflow-wrap: break-word;
        word-wrap: break-word;
        word-break: break-word;
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
    
    .fec-description {
        font-style: italic;
        color: #5a6c7d !important;
        line-height: 1.4;
    }
    
    .checkbox-label {
        display: flex;
        align-items: center;
        cursor: pointer;
        font-weight: normal;
        margin-bottom: 0;
    }
    
    .checkbox-label input[type="checkbox"] {
        width: auto;
        margin-right: 8px;
        cursor: pointer;
    }
    
    .checkbox-text {
        font-weight: 600;
        color: #34495e;
    }
    
    /* Progress Section Styles */
    .progress-section {
        margin-top: 20px;
        padding: 20px;
        background: #f8f9fa;
        border-radius: 8px;
        border: 1px solid #e9ecef;
    }
    
    .progress-section h4 {
        margin: 0 0 15px 0;
        color: #495057;
        font-size: 16px;
    }
    
    .progress-info {
        display: flex;
        flex-direction: column;
        gap: 12px;
    }
    
    .progress-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 12px;
        color: #6c757d;
        font-family: monospace;
    }
    
    .progress-subheader {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 11px;
        color: #868e96;
        font-family: monospace;
        margin-top: 4px;
        font-style: italic;
    }
    
    .progress-bar-container {
        display: flex;
        align-items: center;
        gap: 10px;
    }
    
    .progress-bar-bg {
        flex: 1;
        height: 8px;
        background: #e9ecef;
        border-radius: 4px;
        overflow: hidden;
    }
    
    .progress-bar-fill {
        height: 100%;
        background: linear-gradient(90deg, #007bff, #0056b3);
        border-radius: 4px;
        transition: width 0.3s ease;
    }
    
    .progress-bar-fill.receive {
        background: linear-gradient(90deg, #28a745, #1e7e34);
    }
    
    .progress-text {
        font-size: 12px;
        font-weight: 600;
        color: #495057;
        min-width: 50px;
        text-align: center;
    }
    
    .chunk-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        max-height: 120px;
        overflow-y: auto;
        padding: 8px;
        background: white;
        border-radius: 4px;
        border: 1px solid #dee2e6;
    }
    
    .chunk-indicator {
        min-width: 30px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 600;
        border: 1px solid #dee2e6;
        background: #f8f9fa;
        color: #6c757d;
    }
    
    .chunk-indicator.sent {
        background: #007bff;
        color: white;
        border-color: #0056b3;
    }
    
    .chunk-indicator.received {
        background: #28a745;
        color: white;
        border-color: #1e7e34;
    }
    
    .chunk-indicator.pending {
        background: #ffc107;
        color: #000;
        border-color: #ffc107;
    }
    
    .chunk-indicator.missing {
        background: #dc3545;
        color: white;
        border-color: #c82333;
    }
    
    .parity-info {
        margin-top: 8px;
    }
    
    .parity-info h5 {
        margin: 0 0 8px 0;
        font-size: 14px;
        color: #495057;
    }
    
    .parity-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
    }
    
    .parity-indicator {
        min-width: 50px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 600;
        border: 1px solid #dee2e6;
        background: #f8f9fa;
        color: #6c757d;
    }
    
    .parity-indicator.received {
        background: #17a2b8;
        color: white;
        border-color: #138496;
    }
    
    .last-packet {
        padding: 8px;
        background: white;
        border-radius: 4px;
        border: 1px solid #dee2e6;
        font-family: monospace;
        color: #6c757d;
        word-break: break-all;
        max-height: 60px;
        overflow-y: auto;
    }
    
    .debug-info {
        margin-top: 8px;
        padding: 8px;
        background: #f8f9fa;
        border-radius: 4px;
        border: 1px solid #dee2e6;
    }
    
    .debug-info h5 {
        margin: 0 0 8px 0;
        font-size: 12px;
        color: #495057;
    }
    
    .debug-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 4px;
        font-size: 11px;
        color: #6c757d;
        font-family: monospace;
    }
    
    .debug-grid span {
        padding: 2px 4px;
        background: white;
        border-radius: 2px;
        border: 1px solid #e9ecef;
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

    .btn.transmitting {
        background: #27ae60;
        cursor: not-allowed;
        position: relative;
    }

    .spinner {
        display: inline-block;
        width: 12px;
        height: 12px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-radius: 50%;
        border-top-color: #fff;
        animation: spin 1s ease-in-out infinite;
        margin-right: 8px;
    }

    @keyframes spin {
        to { transform: rotate(360deg); }
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

    /* Fixed Controls Section */
    .controls-section {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        background: white;
        border-top: 2px solid #e1e5e9;
        box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.15);
        z-index: 1000;
    }

    .controls-container {
        max-width: 1200px;
        margin: 0 auto;
        padding: 15px 20px;
    }

    .controls-section .button-group {
        justify-content: center;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 0;
    }

    .controls-section .btn {
        flex: 1;
        min-width: 120px;
        max-width: 200px;
        font-size: 14px;
        padding: 10px 16px;
    }

    .transmission-progress {
        margin-top: 12px;
        text-align: center;
    }

    .transmission-progress .progress-bar {
        margin-bottom: 8px;
    }

    .progress-text {
        font-size: 12px;
        color: #27ae60;
        font-weight: 600;
    }

    .no-messages {
        text-align: center;
        color: #7f8c8d;
        font-style: italic;
        padding: 20px;
    }

    .received-text {
        margin-top: 20px;
        padding: 15px;
        background: #e8f5e8;
        border-radius: 8px;
        border-left: 4px solid #27ae60;
    }

    .received-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 10px;
    }

    .received-header h3 {
        margin: 0;
    }

    .message-container {
        max-height: 200px;
        overflow-y: auto;
        padding: 5px;
        background: rgba(255, 255, 255, 0.7);
        border-radius: 4px;
    }

    .message {
        font-family: monospace;
        font-size: 14px;
        font-weight: bold;
        color: #2c3e50;
        word-break: break-word;
        line-height: 1.4;
        white-space: pre-wrap;
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
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 10px;
    }

    .message-content {
        flex: 1;
        min-width: 0;
    }

    .message-text {
        font-family: monospace;
        font-weight: bold;
        margin-bottom: 5px;
        word-break: break-word;
        white-space: pre-wrap;
        line-height: 1.3;
    }

    .message-time {
        font-size: 12px;
        color: #6c757d;
    }

    .copy-btn {
        background: #17a2b8;
        color: white;
        border: none;
        padding: 6px 12px;
        font-size: 12px;
        border-radius: 4px;
        cursor: pointer;
        transition: background 0.3s;
    }

    .copy-btn:hover {
        background: #138496;
    }

    .copy-btn-small {
        background: #17a2b8;
        color: white;
        border: none;
        padding: 4px 8px;
        font-size: 10px;
        border-radius: 3px;
        cursor: pointer;
        transition: background 0.3s;
        flex-shrink: 0;
        min-width: 30px;
    }

    .copy-btn-small:hover {
        background: #138496;
    }


    .btn-help {
        background: #6c757d;
        color: white;
        border: none;
    }
    
    .btn-help:hover:not(:disabled) {
        background: #5a6268;
        transform: translateY(-2px);
    }
    
    /* Modal Styles */
    .modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1002;
        backdrop-filter: blur(4px);
    }
    
    .modal-content {
        background: white;
        border-radius: 12px;
        max-width: 600px;
        max-height: 80vh;
        width: 90%;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
        overflow: hidden;
        animation: modalSlideIn 0.3s ease-out;
    }
    
    @keyframes modalSlideIn {
        from {
            opacity: 0;
            transform: scale(0.9) translateY(-20px);
        }
        to {
            opacity: 1;
            transform: scale(1) translateY(0);
        }
    }
    
    .modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 20px;
        border-bottom: 1px solid #e9ecef;
        background: #f8f9fa;
    }
    
    .modal-header h3 {
        margin: 0;
        color: #495057;
    }
    
    .modal-close {
        background: none;
        border: none;
        font-size: 18px;
        color: #6c757d;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        transition: all 0.3s;
    }
    
    .modal-close:hover {
        background: #e9ecef;
        color: #495057;
    }
    
    .modal-body {
        padding: 20px;
        overflow-y: auto;
        max-height: calc(80vh - 80px);
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
        main {
            padding: 15px 15px 140px 15px; /* More bottom padding on mobile */
            padding-top: 70px; /* Space for fixed status bar on mobile */
        }

        .controls-section .btn {
            min-width: 100px;
            font-size: 13px;
            padding: 12px 8px;
        }

        .controls-container {
            padding: 12px 15px;
        }

        .panel {
            padding: 20px;
        }
        
        .tab-button {
            font-size: 14px;
            padding: 12px 16px;
        }
        
        .status-content {
            font-size: 12px;
            padding: 10px 15px;
        }
        
        .modal-content {
            width: 95%;
            max-height: 85vh;
        }
        
        .modal-body {
            padding: 15px;
            max-height: calc(85vh - 80px);
        }
        
        .message-container {
            max-height: 150px;
        }
        
        .message-history {
            max-height: 250px;
        }

        textarea, .protocol-select {
            font-size: 16px; /* Prevent zoom on iOS */
            padding: 10px;
        }

        h1 {
            font-size: 24px;
        }
        
        .progress-section {
            padding: 15px;
            margin-top: 15px;
        }
        
        .chunk-grid {
            max-height: 80px;
            gap: 2px;
        }
        
        .chunk-indicator {
            min-width: 25px;
            height: 20px;
            font-size: 9px;
        }
        
        .parity-indicator {
            min-width: 40px;
            height: 20px;
            font-size: 9px;
        }

    }

    @media (max-width: 480px) {
        .controls-section .button-group {
            flex-direction: column;
            gap: 8px;
        }

        .controls-section .btn {
            width: 100%;
            max-width: none;
            min-width: auto;
        }

        main {
            padding: 10px 10px 160px 10px;
            padding-top: 65px;
        }
        
        .tab-button {
            font-size: 13px;
            padding: 10px 12px;
        }
    }
</style>
