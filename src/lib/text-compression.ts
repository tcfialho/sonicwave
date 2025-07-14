import LZString from 'lz-string';

/**
 * Classe para prever a eficácia da compressão sem comprimir
 */
export class CompressionPredictor {
    // Calcula entropia do texto (Shannon entropy)
    static calculateEntropy(text: string): number {
        const freq = new Map<string, number>();
        
        // Conta frequência de cada caractere
        for (const char of text) {
            freq.set(char, (freq.get(char) || 0) + 1);
        }
        
        let entropy = 0;
        const length = text.length;
        
        for (const count of freq.values()) {
            const probability = count / length;
            entropy -= probability * Math.log2(probability);
        }
        
        return entropy;
    }
    
    // Detecta padrões repetitivos
    static detectRepetition(text: string): number {
        const ngrams = new Map<string, number>();
        let totalNgrams = 0;
        
        // Analisa n-gramas de tamanho 2-4
        for (let n = 2; n <= Math.min(4, text.length); n++) {
            for (let i = 0; i <= text.length - n; i++) {
                const ngram = text.substr(i, n);
                ngrams.set(ngram, (ngrams.get(ngram) || 0) + 1);
                totalNgrams++;
            }
        }
        
        // Calcula % de n-gramas repetidos
        let repeatedNgrams = 0;
        for (const count of ngrams.values()) {
            if (count > 1) repeatedNgrams += count;
        }
        
        return totalNgrams > 0 ? repeatedNgrams / totalNgrams : 0;
    }
    
    // Prediz eficiência da compressão SEM comprimir
    static predictCompressionRatio(text: string): number {
        const entropy = this.calculateEntropy(text);
        const repetition = this.detectRepetition(text);
        const length = text.length;
        
        // Heurísticas baseadas em análise empírica
        let predictedRatio = 1.0; // 1.0 = sem compressão
        
        // Fator 1: Entropia baixa = melhor compressão
        if (entropy < 3.0) predictedRatio -= (3.0 - entropy) * 0.15;
        
        // Fator 2: Repetições = muito melhor compressão  
        predictedRatio -= repetition * 0.4;
        
        // Fator 3: Tamanho - textos curtos têm overhead (penalidades reduzidas)
        if (length < 25) predictedRatio += 0.2; // Penalty menor para textos curtos
        if (length < 40) predictedRatio += 0.1;
        
        // Fator 4: Espaços repetidos
        const spaceRatio = (text.match(/\s+/g)?.join('').length || 0) / length;
        predictedRatio -= spaceRatio * 0.2;
        
        return Math.max(0.2, Math.min(1.2, predictedRatio));
    }
    
    // Decisão inteligente: comprimir ou não?
    static shouldCompress(text: string): { 
        shouldCompress: boolean, 
        predictedRatio: number, 
        reason: string 
    } {
        const ratio = this.predictCompressionRatio(text);
        const threshold = 0.90; // Só comprimir se ganho > 10% (transmissão por som é lenta)
        
        if (text.length < 20) {
            return { 
                shouldCompress: false, 
                predictedRatio: ratio,
                reason: 'Texto muito curto - overhead > ganho' 
            };
        }
        
        if (ratio > threshold) {
            return { 
                shouldCompress: false, 
                predictedRatio: ratio,
                reason: `Ganho insuficiente (${((1-ratio)*100).toFixed(1)}% < 10%)` 
            };
        }
        
        return { 
            shouldCompress: true, 
            predictedRatio: ratio,
            reason: `Ganho previsto: ${((1-ratio)*100).toFixed(1)}%` 
        };
    }
}

/**
 * Classe para compressão automática com detecção sem metadados
 */
export class AutoDetectCompression {
    private static cache = new Map<string, {
        compressed: string,
        method: string,
        actualRatio: number
    }>();
    
    // Compressão inteligente SEM prefixos
    static compress(text: string): {
        result: string,
        method: string,
        savings: string,
        prediction: string
    } {
        // 1. Verificar cache primeiro
        if (this.cache.has(text)) {
            const cached = this.cache.get(text)!;
            return {
                result: cached.compressed,
                method: `${cached.method} (cached)`,
                savings: `${((1-cached.actualRatio)*100).toFixed(1)}%`,
                prediction: 'cached'
            };
        }
        
        // 2. Análise preditiva
        const prediction = CompressionPredictor.shouldCompress(text);
        
        // 3. Compressão simples sempre aplicada
        const simple = text.replace(/\s+/g, ' ').trim();
        
        // 4. Se predição recomenda compressão avançada, testar
        if (prediction.shouldCompress) {
            try {
                const lzCompressed = LZString.compressToUTF16(simple);
                if (lzCompressed) {
                    const actualRatio = lzCompressed.length / text.length;
                    
                    // Verificar se ganho real é significativo (>10%)
                    if (actualRatio < 0.90) {
                        // Cachear resultado
                        this.cache.set(text, {
                            compressed: lzCompressed,
                            method: 'lz-string',
                            actualRatio
                        });
                        
                        return {
                            result: lzCompressed,
                            method: 'lz-string',
                            savings: `${((1-actualRatio)*100).toFixed(1)}%`,
                            prediction: `✅ Predicted: ${((1-prediction.predictedRatio)*100).toFixed(1)}%`
                        };
                    }
                }
            } catch (e) {
                console.warn('LZ-String compression failed:', e);
            }
        }
        
        // 5. Usar compressão simples
        const simpleRatio = simple.length / text.length;
        this.cache.set(text, {
            compressed: simple,
            method: 'simple',
            actualRatio: simpleRatio
        });
        
        return {
            result: simple,
            method: 'simple',
            savings: `${((1-simpleRatio)*100).toFixed(1)}%`,
            prediction: `❌ ${prediction.reason}`
        };
    }
    
    // Detecção automática SEM prefixos
    static decompress(data: string): string {
        // Estratégia 1: Verificar se contém caracteres Unicode altos
        const hasUnicodeHigh = data.split('').some(char => char.charCodeAt(0) >= 256);
        
        if (hasUnicodeHigh && data.length > 3) {
            try {
                // Tentar decodificar LZ-String
                const decompressed = LZString.decompressFromUTF16(data);
                
                // Validações de sanidade:
                if (decompressed && 
                    decompressed.length > 0 && 
                    decompressed.length > data.length * 0.3 && // Expansão mínima esperada
                    decompressed.length < data.length * 10) {  // Expansão máxima razoável
                    
                    console.log(`🔍 Auto-detected LZ compression: ${data.length} → ${decompressed.length} chars`);
                    return decompressed;
                }
            } catch (e) {
                console.log(`❌ LZ decompression failed, treating as plain text`);
            }
        }
        
        // Fallback: texto simples
        console.log(`📝 Treating as plain text: "${data.substring(0, 50)}${data.length > 50 ? '...' : ''}"`);
        return data;
    }
    
    // Método para testar detecção
    static testAutoDetection(originalText: string): {
        original: string,
        compressed: string, 
        decompressed: string,
        success: boolean,
        savings: string,
        method: string
    } {
        const compressionResult = this.compress(originalText);
        const decompressed = this.decompress(compressionResult.result);
        
        return {
            original: originalText,
            compressed: compressionResult.result,
            decompressed: decompressed,
            success: decompressed === originalText,
            savings: compressionResult.savings,
            method: compressionResult.method
        };
    }
    
    // Limpar cache (útil para testes)
    static clearCache(): void {
        this.cache.clear();
    }
    
    // Estatísticas do cache
    static getCacheStats(): { size: number, entries: Array<{text: string, method: string, ratio: number}> } {
        const entries = Array.from(this.cache.entries()).map(([text, data]) => ({
            text: text.substring(0, 30) + (text.length > 30 ? '...' : ''),
            method: data.method,
            ratio: data.actualRatio
        }));
        
        return {
            size: this.cache.size,
            entries
        };
    }
}