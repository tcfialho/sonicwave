import { zip, unzip } from 'fflate';

export interface FileTransferProgress {
    batchId: string;
    filename: string;
    totalSize: number;
    receivedChunks: number;
    totalChunks: number;
    percentage: number;
    eta: number; // seconds
    status: 'receiving' | 'complete' | 'failed' | 'extracting';
    error?: string;
}

export interface ReceivedBatch {
    batchId: string;
    filename: string;
    zipData: Uint8Array;
    receivedAt: Date;
    extracted: boolean;
    files: Array<{
        name: string;
        size: number;
        data: Uint8Array;
    }>;
}

export class FileService {
    private db: IDBDatabase | null = null;
    private readonly dbName = 'SonicWaveFiles';
    private readonly dbVersion = 1;

    async initialize(): Promise<void> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };
            
            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                
                // Store for received ZIP batches
                if (!db.objectStoreNames.contains('batches')) {
                    db.createObjectStore('batches', { keyPath: 'batchId' });
                }
                
                // Store for extracted individual files
                if (!db.objectStoreNames.contains('files')) {
                    const fileStore = db.createObjectStore('files', { keyPath: 'id' });
                    fileStore.createIndex('batchId', 'batchId', { unique: false });
                }
                
                // Store for transfer progress
                if (!db.objectStoreNames.contains('progress')) {
                    db.createObjectStore('progress', { keyPath: 'batchId' });
                }
            };
        });
    }

    /**
     * Creates a ZIP file from selected files with maximum compression
     */
    async createZipFromFiles(files: FileList): Promise<{ zipData: Uint8Array; filename: string }> {
        try {
            const fileMap: Record<string, Uint8Array> = {};
            
            // Read all files
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const arrayBuffer = await file.arrayBuffer();
                fileMap[file.name] = new Uint8Array(arrayBuffer);
            }
            
            // Create ZIP with maximum compression
            const zipData = await new Promise<Uint8Array>((resolve, reject) => {
                zip(fileMap, { 
                    level: 9, // Maximum compression
                    mem: 12   // High memory level for better compression
                }, (err, data) => {
                    if (err) reject(err);
                    else resolve(data);
                });
            });
            
            // Generate filename based on first file or timestamp
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const baseName = files.length === 1 
                ? files[0].name.replace(/\.[^/.]+$/, "") 
                : `files-${timestamp}`;
            const filename = `${baseName}.zip`;
            
            console.log(`📦 Created ZIP: ${filename} (${zipData.length} bytes, compression: ${((1 - zipData.length / this.getTotalSize(files)) * 100).toFixed(1)}%)`);
            
            return { zipData, filename };
            
        } catch (error) {
            console.error('❌ Error creating ZIP:', error);
            throw new Error(`Failed to create ZIP file: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    
    private getTotalSize(files: FileList): number {
        let total = 0;
        for (let i = 0; i < files.length; i++) {
            total += files[i].size;
        }
        return total;
    }

    /**
     * Stores received ZIP batch in IndexedDB
     */
    async storeBatch(batch: ReceivedBatch): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        const transaction = this.db.transaction(['batches'], 'readwrite');
        const store = transaction.objectStore('batches');
        
        await new Promise<void>((resolve, reject) => {
            const request = store.put(batch);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
        
        console.log(`💾 Stored batch ${batch.batchId} in IndexedDB`);
    }

    /**
     * Extracts ZIP file and stores individual files
     */
    async extractBatch(batchId: string): Promise<Array<{ name: string; size: number }>> {
        if (!this.db) throw new Error('Database not initialized');
        
        try {
            // Get batch from IndexedDB
            const batch = await this.getBatch(batchId);
            if (!batch) throw new Error(`Batch ${batchId} not found`);
            
            // Extract ZIP
            const extractedFiles = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
                unzip(batch.zipData, (err, data) => {
                    if (err) reject(err);
                    else resolve(data);
                });
            });
            
            // Store individual files
            const transaction = this.db.transaction(['files', 'batches'], 'readwrite');
            const fileStore = transaction.objectStore('files');
            const batchStore = transaction.objectStore('batches');
            
            const fileInfos: Array<{ name: string; size: number }> = [];
            
            for (const [filename, fileData] of Object.entries(extractedFiles)) {
                const fileRecord = {
                    id: `${batchId}:${filename}`,
                    batchId,
                    name: filename,
                    size: fileData.length,
                    data: fileData,
                    extractedAt: new Date()
                };
                
                fileStore.put(fileRecord);
                fileInfos.push({ name: filename, size: fileData.length });
            }
            
            // Mark batch as extracted
            batch.extracted = true;
            batch.files = fileInfos.map(info => ({
                name: info.name,
                size: info.size,
                data: extractedFiles[info.name]
            }));
            batchStore.put(batch);
            
            await new Promise<void>((resolve, reject) => {
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            });
            
            console.log(`📂 Extracted ${fileInfos.length} files from batch ${batchId}`);
            return fileInfos;
            
        } catch (error) {
            console.error(`❌ Error extracting batch ${batchId}:`, error);
            throw new Error(`Failed to extract ZIP: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Downloads individual file from IndexedDB
     */
    async downloadFile(batchId: string, filename: string): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        try {
            const transaction = this.db.transaction(['files'], 'readonly');
            const store = transaction.objectStore('files');
            const fileId = `${batchId}:${filename}`;
            
            const fileRecord = await new Promise<any>((resolve, reject) => {
                const request = store.get(fileId);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            
            if (!fileRecord) {
                throw new Error(`File ${filename} not found in batch ${batchId}`);
            }
            
            // Create download
            const blob = new Blob([fileRecord.data]);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
            
            console.log(`📥 Downloaded ${filename} (${fileRecord.size} bytes)`);
            
        } catch (error) {
            console.error(`❌ Error downloading ${filename}:`, error);
            throw new Error(`Failed to download file: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Downloads entire batch as ZIP
     */
    async downloadBatch(batchId: string): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        try {
            const batch = await this.getBatch(batchId);
            if (!batch) throw new Error(`Batch ${batchId} not found`);
            
            // Create download
            const blob = new Blob([batch.zipData], { type: 'application/zip' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = batch.filename;
            a.click();
            URL.revokeObjectURL(url);
            
            console.log(`📥 Downloaded batch ${batch.filename} (${batch.zipData.length} bytes)`);
            
        } catch (error) {
            console.error(`❌ Error downloading batch ${batchId}:`, error);
            throw new Error(`Failed to download batch: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private async getBatch(batchId: string): Promise<ReceivedBatch | null> {
        if (!this.db) throw new Error('Database not initialized');
        
        const transaction = this.db.transaction(['batches'], 'readonly');
        const store = transaction.objectStore('batches');
        
        return new Promise((resolve, reject) => {
            const request = store.get(batchId);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Gets all received batches
     */
    async getAllBatches(): Promise<ReceivedBatch[]> {
        if (!this.db) throw new Error('Database not initialized');
        
        const transaction = this.db.transaction(['batches'], 'readonly');
        const store = transaction.objectStore('batches');
        
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Deletes a batch and its files from IndexedDB
     */
    async deleteBatch(batchId: string): Promise<void> {
        if (!this.db) throw new Error('Database not initialized');
        
        const transaction = this.db.transaction(['batches', 'files', 'progress'], 'readwrite');
        const batchStore = transaction.objectStore('batches');
        const fileStore = transaction.objectStore('files');
        const progressStore = transaction.objectStore('progress');
        
        // Delete all files from this batch
        const fileIndex = fileStore.index('batchId');
        const fileRequest = fileIndex.openCursor(IDBKeyRange.only(batchId));
        
        fileRequest.onsuccess = () => {
            const cursor = fileRequest.result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };
        
        // Delete batch and progress
        batchStore.delete(batchId);
        progressStore.delete(batchId);
        
        await new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
        
        console.log(`🗑️ Deleted batch ${batchId} from IndexedDB`);
    }
}