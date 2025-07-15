// Type declarations for external modules

declare module 'ggwave' {
    interface GGWaveInstance {
        init(sampleRate: number, protocolId: number): Promise<void>;
        getProtocols(): Array<{ protocolId: number, name: string, txDataLength: number }>;
        encode(protocolId: number, message: string, volume?: number): Promise<Float32Array>;
        decode(data: Float32Array): Promise<string | null>;
        free(): void;
    }

    interface GGWaveFactory {
        (options?: any): Promise<GGWaveInstance>;
    }

    const ggwaveFactory: GGWaveFactory;
    export default ggwaveFactory;
}

declare module 'crypto-js' {
    export interface WordArray {
        toString(): string;
    }

    export function MD5(message: string | WordArray): WordArray;

    export namespace lib {
        namespace WordArray {
            function create(data: Uint8Array): WordArray;
        }
    }

    export namespace enc {
        namespace Base64 {
            function stringify(wordArray: WordArray): string;
            function parse(base64Str: string): WordArray;
        }
    }
}