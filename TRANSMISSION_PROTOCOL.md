# Documentação do Protocolo de Transmissão sobre GGWave

Este documento detalha o protocolo de comunicação unidirecional sobre a biblioteca `ggwave` para transmitir dados de tamanho ilimitado, superando a restrição de 140 caracteres por pacote. O protocolo é robusto, eficiente e opera sem feedback do receptor, usando MD5 (codificado em Base64 tradicional) para verificação de integridade.

## 1. O Problema: Limite de Caracteres

A biblioteca `ggwave` transmite até 140 caracteres por pacote via áudio. Enviar grandes quantidades de dados em uma única transmissão falha ou é ineficiente. O protocolo fragmenta os dados, envia-os em partes, e os remonta no receptor, com verificação de integridade e correção de erros.

## 2. Camadas de Comunicação

### 2.1. Camada Física: `ggwave` e o Preâmbulo Físico
- **O que é?** A biblioteca `ggwave` converte um bloco de até 140 caracteres em som e vice-versa.
- **Preâmbulo Físico**: Tons de sincronização no início do áudio.
  - **Função**: Permite ao receptor ignorar ruídos e sincronizar o decodificador.
  - **Consequência**: Sincronização de pacotes gerenciada pelo `ggwave`.

### 2.2. Camada de Protocolo Lógico: Nossa Implementação
- **O que é?** Lógica no `GGWaveService` para gerenciar múltiplos pacotes.
- **Preâmbulo Lógico**: Pacote `START` inicia uma sessão.
  - **Função**: Anuncia mensagem, especificando ID, total de pacotes, hash MD5 e compressão.

## 3. Estrutura do Protocolo

### 3.1. Fragmentação
A função `sendLargeData` divide uma mensagem (opcionalmente comprimida com gzip) em chunks de até 75 bytes (~100 caracteres em Base64, incluindo padding `=` ou `==` quando necessário), garantindo que pacotes respeitem o limite de 140 caracteres.

### 3.2. Formato do Pacote
Cada pacote é uma string com formatos específicos por tipo:
- **`S` (Start)**: `S:ID_SESSAO::HASH_MD5:TOTAL:FLAGS`
  - Ex.: `S:1234567890-123456::k8l5Kf9CrfydY0C7h+7MCw==:4:C` (comprimido) ou `S:1234567890-123456::k8l5Kf9CrfydY0C7h+7MCw==:4` (não comprimido).
- **`D` (Data)**: `D:ID_SESSAO:ATUAL:DADOS`
  - Ex.: `D:1234567890-123456:1:H4sIAAAAAAAAA0vOzwMABf4B3Q==`
- **`P` (Parity)**: `P:ID_SESSAO:inicio-fim-tipo:DADOS`
  - Ex.: `P:1234567890-123456:1-3-0:H4sIAAAAAAAAA0vOzwMABf4B3Q==` (paridade primária)
  - Ex.: `P:1234567890-123456:1-3-1:K5jIAAAAAAAAB1vPzwNABf4C4R==` (paridade secundária)
  - Ex.: `P:1234567890-123456:2-4-O0:M6kIAAAAAAAAC2vQzwOABf4D5S==` (overlapping)
- **`E` (End)**: `E:ID_SESSAO::`
  - Ex.: `E:1234567890-123456::`

**Campos**:
- **`ID_SESSAO`**: `timestamp-nonce_6_digitos` (ex.: `1234567890-123456`, ≤ 15 caracteres).
- **`SEQUENCIA`**:
  - `D`: Número do pacote (≤ 7 dígitos, máx. 9.999.999).
  - `P`: `inicio-fim-tipo` onde:
    - `inicio-fim`: Range de pacotes (ex.: `1-3` para `D1-D3`)
    - `tipo`: `0` (primária), `1` (secundária), `O0` (overlapping primária)
  - `S`/`E`: Vazio (`""`).
- **`DADOS`**: Chunk ou paridade, codificado em Base64 tradicional, ≤ 100 caracteres (incluindo padding).
- **`HASH_MD5`**: Hash MD5 (16 bytes, 24 caracteres em Base64 com padding).
- **`TOTAL`**: Total de pacotes `DATA`.
- **`FLAGS`**: Múltiplos flags separados por `,`:
  - `C`: Comprimido com gzip
  - `F[SCHEME]`: Esquema FEC (ex.: `FBASIC_3`, `FENHANCED_2`, `FOVERLAPPING_3`)
  - Exemplo: `C,FBASIC_3` (comprimido com FEC básico 3+1)

**Restrições**:
- Cabeçalho `D`/`P`/`E` ≤ 40 caracteres; `S` até ~52 caracteres (recalcular `chunkSize = 140 − len(cabeçalho)`).
- Pacotes ≤ 140 caracteres.
- **Notas**:
  - Campos ausentes são strings vazias; delimitadores `:` permanecem (ex.: `S:ID::HASH:TOTAL:`).
  - Se `FLAGS` vazio, o campo é omitido e o cabeçalho termina sem o último `:`. Ex.: `S:ID::HASH:TOTAL`. Evitar `S:ID::HASH:TOTAL::`.
  - Base64 tradicional (alfabeto `A-Z`, `a-z`, `0-9`, `+`, `/`, padding `=` ou `==`) usado para MD5 e `DADOS`. Compatível com ASCII 32-126; evitar modos `ggwave` que filtrem `+` ou `/` (ex.: alguns DTMF/MFSK).

### 3.3. Validação de Integridade
- **Hash MD5**: Incluído no `START`, em Base64 (24 caracteres com padding).
- **Verificação**: Receptor calcula hash MD5 dos dados remontados (comprimidos se `FLAGS=C`, brutos se não) antes da descompressão e compara com o do `START`.
- **Corrupção**: Descarta mensagens inválidas.
- **Nota**: MD5 é suficiente para erros acidentais, mas não protege contra colisões maliciosas.

## 4. Fluxo de Execução

- **Transmissão (`sendLargeData`)**:
  1. Gera `ID_SESSAO` (ex.: `1234567890-123456`).
  2. Comprime mensagem com gzip (se aplicável, indicado por `FLAGS=C`).
  3. Calcula hash MD5 (nos dados comprimidos se `FLAGS=C`, brutos se não).
  4. Divide em `N` chunks de até 75 bytes, codificados em Base64.
  5. Envia `START` (`S:ID_SESSAO::HASH_MD5:TOTAL:FLAGS`).
  6. Envia `DATA` (`D:ID_SESSAO:i:chunk_i`) para cada chunk.
  7. Para grupos de 4 pacotes `DATA` (ex.: D1-D4, D5-D8), calcula paridade via XOR (dados brutos, com padding `\0` até 75 bytes), codifica em Base64, envia `P:ID_SESSAO:inicio-fim:DADOS`.
  8. Envia `END` (`E:ID_SESSAO::`).
  9. Usa `await playSound(waveform)` para intervalos naturais.

- **Recepção (`handleReceivedPacket`)**:
  1. Ouve e decodifica pacotes via `ggwave`.
  2. Ignora duplicados (`ID_SESSAO` + `SEQUENCIA`).
  3. **Pacote `S`**: Cria sessão em `receiveSessions`, armazena hash MD5, `TOTAL`, `FLAGS`, inicia timeout (`TOTAL × duração_média_pacote × 1.5`, com `duração_média_pacote` de `ggwave.mode.txDurationPerChar()` ou medição real).
  4. **Pacote `D`**: Armazena chunk (decodificado de Base64).
  5. **Pacote `P`**: Armazena paridade (decodificada de Base64) para grupo `inicio-fim`.
  6. **FEC proativo**: Para grupo (ex.: `D1-D4, P1`), se 4/5 pacotes recebidos, decodifica Base64, aplica XOR nos dados brutos, reconstrói pacote faltante. Remove `\0` antes de concatenar chunks.
  7. **Conclusão**: Verifica se `TOTAL` pacotes `DATA` recebidos/recuperados. Concatena chunks, calcula MD5 (antes da descompressão se `FLAGS=C`), valida contra hash do `START`, descomprime se necessário, entrega ou descarta.
  8. **Pacote `E`**: Sinaliza fim, mas não limpa sessão. Finaliza com:
     - **Sucesso**: Todos os pacotes recebidos/recuperados, hash válido.
     - **Falha**: Timeout expirado.
  9. **Exemplo**: Para `D1, D2, D3, D5-D10, P1-4, E`, aguarda `D4` via `P1-4` ou timeout.
  10. Remove sessão após entrega ou timeout.

## 5. Intervalo entre Pacotes

### 5.1. Intervalo Automático
- `sendLargeData` usa `await playSound(waveform)`, pausando até o som terminar.
- **Delay adicional baseado no protocolo**:
  - NORMAL: +1000ms entre pacotes
  - FAST: +500ms entre pacotes
  - FASTEST: sem delay adicional

### 5.2. Reatividade
- Pacotes autônomos permitem processamento independente de temporização.
- **Buffer de áudio aumentado**: 4096 samples para maior estabilidade
- **Configurações explícitas**: Sample rate e canais definidos para compatibilidade

## 6. Funcionalidades de Robustez

### 6.1. Gerenciamento de Sessões
- **Timeout adaptativo**: Baseado no protocolo e número de pacotes:
  - Base: 30 segundos + (5 segundos × total_pacotes)
  - Multiplicador por protocolo: NORMAL (3x), FAST (2x), FASTEST (1x)
  - Mínimo: 60 segundos
  - Exemplo: 10 pacotes NORMAL = 30s + (10×5s×3) = 180s
- **Limpeza**: Sessões incompletas removidas após timeout com logging detalhado
- **Duplicados**: Ignorados com `ID_SESSAO` + `SEQUENCIA` + tipo de pacote
- **Debug**: Logs mostram pacotes recebidos, perdidos e recuperados

### 6.2. Validação de Integridade
- **Hash MD5**: Em Base64 (24 caracteres), no `START`.
- **Verificação**: Compara hash dos dados remontados (antes da descompressão se `FLAGS=C`).
- **Corrupção**: Descarta mensagens inválidas.

### 6.3. Correção de Erros (FEC)

#### 6.3.1. Esquemas FEC Disponíveis
- **NONE**: Sem correção de erros (máxima velocidade)
- **BASIC_2**: 2 pacotes dados + 1 paridade (recupera 1 perda)
- **BASIC_3**: 3 pacotes dados + 1 paridade (padrão, recupera 1 perda)
- **BASIC_4**: 4 pacotes dados + 1 paridade (recupera 1 perda)
- **ENHANCED_2**: 2 pacotes dados + 2 paridades (recupera até 2 perdas)
- **ENHANCED_3**: 3 pacotes dados + 2 paridades (recupera até 2 perdas)
- **OVERLAPPING_3**: 3 pacotes dados + paridade + grupos sobrepostos (máxima robustez)

#### 6.3.2. Algoritmos de Paridade
- **Paridade Primária (tipo=0)**: XOR simples de todos os chunks do grupo
- **Paridade Secundária (tipo=1)**: XOR ponderado (Reed-Solomon simplificado)
- **Grupos Overlapping**: Paridade adicional para grupos sobrepostos

#### 6.3.3. Algoritmo OVERLAPPING_3 - Especificação Determinística

**⚠️ CRÍTICO**: Transmissor e receptor DEVEM usar exatamente o mesmo algoritmo para gerar grupos overlapping.

**Algoritmo Oficial**:
```
Para N pacotes usando OVERLAPPING_3:

1. GRUPOS PRINCIPAIS (tipo=0):
   - Gerar grupos de 3: [1-3], [4-6], [7-9], ...
   - Para i = 1, 4, 7, 10, ... (i += 3):
     - Criar grupo [i, min(i+2, N), "0"]
   - Parar quando i > N

2. GRUPOS OVERLAPPING (tipos O0, O1, O2, ...):
   - Para i = 2, 3, 4, 5, 6, ... (todos os valores possíveis):
     - Se i+2 ≤ N: criar grupo [i, i+2, "O{i-2}"]
   - Parar quando i+2 > N

3. ORDEM DE TRANSMISSÃO:
   - Todos os grupos principais primeiro (tipos 0)
   - Todos os grupos overlapping depois (tipos O0, O1, ...)
```

**Exemplos Determinísticos**:

**6 pacotes**:
```
Grupos principais: [1-3-0], [4-6-0]
Grupos overlapping: [2-4-O0], [3-5-O1], [4-6-O2] (⚠️ 4-6 duplica principal)
Aplicando filtro: [2-4-O0], [3-5-O1] (remove duplicatas)
Resultado: P:...:1-3-0, P:...:4-6-0, P:...:2-4-O0, P:...:3-5-O1
```

**7 pacotes**:
```
Grupos principais: [1-3-0], [4-6-0], [7-7-0]
Grupos overlapping: [2-4-O0], [3-5-O1], [4-6-O2], [5-7-O3]
Aplicando filtro: [2-4-O0], [3-5-O1], [5-7-O3] (remove 4-6 duplicata)
Resultado: P:...:1-3-0, P:...:4-6-0, P:...:7-7-0, P:...:2-4-O0, P:...:3-5-O1, P:...:5-7-O3
```

**8 pacotes**:
```
Grupos principais: [1-3-0], [4-6-0], [7-8-0]
Grupos overlapping: [2-4-O0], [3-5-O1], [4-6-O2], [5-7-O3], [6-8-O4]
Aplicando filtro: [2-4-O0], [3-5-O1], [5-7-O3], [6-8-O4]
```

#### 6.3.4. Recuperação
- **1 Erro**: Usa paridade primária via XOR
- **2 Erros**: Resolve sistema de equações com paridades primária e secundária
- **Recuperação Agressiva**: Tenta todas as combinações de paridade disponíveis
- **Padding**: Preenche chunks menores com `\0` até 75 bytes, remove após recuperação

### 6.4. Fragmentação
- **Tamanho**: Chunks de até 75 bytes (~100 caracteres em Base64, incluindo padding).
- **Compatibilidade**: Todos os protocolos `ggwave`. Evitar modos que filtrem `+` ou `/`.
- **Compressão**: Gzip opcional, indicado por `FLAGS=C`.

## 7. Limites Práticos e Exemplos

**Tamanho máximo:** 9.999.999 pacotes (~740 MB sem gzip, mais com gzip). Para romper o limite, ampliar o campo SEQUENCIA e recalcular limites.
**Robustez:** 1 perda por grupo de 4; usar DTMF em ambientes ruidosos.
**Modelo:** Half-duplex ponto-a-ponto, com ID_SESSAO para múltiplos transmissores.

### Exemplo 1: Sem Compressão (mensagem simples)

**Mensagem:** "Hello World! This is a test message." (36 bytes, 1 chunk)

```
S:1734567890-123456::ruhdWI58FPq+PotTvjrnNA==:1
D:1734567890-123456:1:SGVsbG8gV29ybGQhIFRoaXMgaXMgYSB0ZXN0IG1lc3NhZ2Uu
E:1734567890-123456::
```

### Exemplo 2: Sem Compressão (múltiplos chunks com FEC)

**Mensagem:** JSON de 300 bytes (4 chunks, 1 grupo FEC)

```
S:1734567890-654321::muOLP0InZ8tjPiZQ5BOBfA==:4
D:1734567890-654321:1:TG9yZW0gaXBzdW0gZG9sb3Igc2l0IGFtZXQsIGNvbnNlY3RldHVyIGFkaXBpc2NpbmcgZWxpdCwgc2VkIGRvIGVpdXNtb2QgdGVt
D:1734567890-654321:2:cG9yIGluY2lkaWR1bnQgdXQgbGFib3JlIGV0IGRvbG9yZSBtYWduYSBhbGlxdWEuIExvcmVtIGlwc3VtIGRvbG9yIHNpdCBhbWV0
D:1734567890-654321:3:LCBjb25zZWN0ZXR1ciBhZGlwaXNjaW5nIGVsaXQsIHNlZCBkbyBlaXVzbW9kIHRlbXBvciBpbmNpZGlkdW50IHV0IGxhYm9yZSBl
D:1734567890-654321:4:dCBkb2xvcmUgbWFnbmEgYWxpcXVhLiBMb3JlbSBpcHN1bSBkb2xvciBzaXQgYW1ldCwgY29uc2VjdGV0dXIgYWRpcGlzY2luZyBl
P:1734567890-654321:1-4-0:ZAAHRQZSHR9DFBxHFloNHwMZBw4UCF0jCgZRBFNFUhwHD1QIFV4WWhQFAQJcRxtHV3cABkYDSUNaEBwZABxUDRsGBQUWGkJdGwAZ
E:1734567890-654321::

```

**Nota:** Grupo D1-D4 com pacote de paridade P1-4-0 (formato padronizado). Se D2 for perdido, pode ser recuperado via: `D2 = D1 XOR D3 XOR D4 XOR P1-4-0`.

### Exemplo 3: Com Compressão e FEC Avançado

**Mensagem:** Dados comprimidos com gzip + FEC Enhanced 3+2 (5 chunks)

```
S:1734567890-789012::m9F2k7P8vQ3nR6eE8tA5Cw==:5:C,FENHANCED_3
D:1734567890-789012:1:SGVsbG8gV29ybGQhIFRoaXMgaXMgYSB0ZXN0IG1lc3NhZ2Uu
D:1734567890-789012:2:TG9yZW0gaXBzdW0gZG9sb3Igc2l0IGFtZXQsIGNvbnNlY3RldHVyIGFkaXBpc2NpbmcgZWxpdCwgc2VkIGRvIGVpdXNtb2QgdGVt
D:1734567890-789012:3:cG9yIGluY2lkaWR1bnQgdXQgbGFib3JlIGV0IGRvbG9yZSBtYWduYSBhbGlxdWEuIExvcmVtIGlwc3VtIGRvbG9yIHNpdCBhbWV0
D:1734567890-789012:4:LCBjb25zZWN0ZXR1ciBhZGlwaXNjaW5nIGVsaXQsIHNlZCBkbyBlaXVzbW9kIHRlbXBvciBpbmNpZGlkdW50IHV0IGxhYm9yZSBl
D:1734567890-789012:5:dCBkb2xvcmUgbWFnbmEgYWxpcXVhLiBMb3JlbSBpcHN1bSBkb2xvciBzaXQgYW1ldCwgY29uc2VjdGV0dXIgYWRpcGlzY2luZyBl
P:1734567890-789012:1-3-0:ZAAHRQZSHR9DFBxHFloNHwMZBw4UCF0jCgZRBFNFUhwHD1QIFV4WWhQFAQJcRxtHV3cABkYDSUNaEBwZABxUDRsGBQUWGkJdGwAZ
P:1734567890-789012:1-3-1:YBBISRTISFNEGByIGGpOIQNaBx5VDG1kDhaSCGOGViwIE2RJGWRXYiRGBRKdSytIW4dBClZETVO7ExyaCCyVESJJBRVXHlOFgAY
P:1734567890-789012:4-5-0:WAAQDxTDGAdADwNFEwYGBg5TCG0jCgZRBFNFUhwHD1QIFV4WWhQFAQJcRxtHV3cABkYDSUNaEBwZABxUDRsGBQUWGkJdGwAZ
E:1734567890-789012::
```

**Nota:** FLAGS=C,FENHANCED_3 indica compressão gzip + FEC Enhanced 3+2. Grupos 1-3 e 4-5 com paridades primária (tipo=0) e secundária (tipo=1). Hash MD5 calculado nos dados comprimidos.

### Exemplo 4: FEC Overlapping para Máxima Robustez

**Mensagem:** Dados com FEC Overlapping 3+1 (6 chunks)

```
S:1734567890-456789::n2B3k8Q9wR5oS7fF9tB6Dw==:6:FOVERLAPPING_3
D:1734567890-456789:1:SGVsbG8gV29ybGQhIFRoaXMgaXMgYSB0ZXN0IG1lc3NhZ2Uu
D:1734567890-456789:2:TG9yZW0gaXBzdW0gZG9sb3Igc2l0IGFtZXQsIGNvbnNlY3RldHVyIGFkaXBpc2NpbmcgZWxpdCwgc2VkIGRvIGVpdXNtb2QgdGVt
D:1734567890-456789:3:cG9yIGluY2lkaWR1bnQgdXQgbGFib3JlIGV0IGRvbG9yZSBtYWduYSBhbGlxdWEuIExvcmVtIGlwc3VtIGRvbG9yIHNpdCBhbWV0
D:1734567890-456789:4:LCBjb25zZWN0ZXR1ciBhZGlwaXNjaW5nIGVsaXQsIHNlZCBkbyBlaXVzbW9kIHRlbXBvciBpbmNpZGlkdW50IHV0IGxhYm9yZSBl
D:1734567890-456789:5:dCBkb2xvcmUgbWFnbmEgYWxpcXVhLiBMb3JlbSBpcHN1bSBkb2xvciBzaXQgYW1ldCwgY29uc2VjdGV0dXIgYWRpcGlzY2luZyBl
D:1734567890-456789:6:bGl0LCBzZWQgZG8gZWl1c21vZCB0ZW1wb3IgaW5jaWRpZHVudCB1dCBsYWJvcmUgZXQgZG9sb3JlIG1hZ25hIGFsaXF1YS4=
P:1734567890-456789:1-3-0:ZAAHRQZSHR9DFBxHFloNHwMZBw4UCF0jCgZRBFNFUhwHD1QIFV4WWhQFAQJcRxtHV3cABkYDSUNaEBwZABxUDRsGBQUWGkJdGwAZ
P:1734567890-456789:4-6-0:WAAQDxTDGAdADwNFEwYGBg5TCG0jCgZRBFNFUhwHD1QIFV4WWhQFAQJcRxtHV3cABkYDSUNaEBwZABxUDRsGBQUWGkJdGwAZ
P:1734567890-456789:2-4-O0:YBBISRTISFNEGByIGGpOIQNaBx5VDG1kDhaSCGOGViwIE2RJGWRXYiRGBRKdSytIW4dBClZETVO7ExyaCCyVESJJBRVXHlOFgAY
P:1734567890-456789:3-5-O1:XCCJTUSJTGOEGDYJHHRPJRMCCX6WEDH2lEiaTDHPHWixJF3SKGXYijSGCRLE2yuJX5eCDmZFUVO8FyzaDDyWFTKKCRWYIlPGhBZ
E:1734567890-456789::
```

**Nota:** FLAGS=FOVERLAPPING_3 segue o algoritmo determinístico corrigido:
- **Grupos principais**: [1-3-0], [4-6-0] (transmitidos primeiro)
- **Grupos overlapping**: [2-4-O0], [3-5-O1] (transmitidos depois, filtrados duplicatas)
- **Ordem de transmissão correta**: P:1-3-0, P:4-6-0, P:2-4-O0, P:3-5-O1
- **Recuperação**: Múltiplos grupos permitem robustez máxima contra perdas adjacentes

## 8. Notas de Implementação

### 8.1. Processamento de Dados
1. **MD5 Byte-Stream**: MD5 calculado nos dados transmitidos: após compressão (se `FLAGS=C`) ou brutos. Verificar antes da descompressão.
2. **MD5 em Base64**: Usar Base64 tradicional (16 bytes → 24 caracteres com padding `=`).
3. **Regra do `:` Final**: Se `FLAGS` vazio, omitir o campo e terminar o cabeçalho sem o último `:`. Ex.: `S:ID::HASH:TOTAL`. Evitar `S:ID::HASH:TOTAL::`.
4. **Tamanho do Chunk com Múltiplos Flags**: Recalcular tamanho do chunk como `140 − len(cabeçalho)` para `S` (até ~52 caracteres) e `D`/`P`/`E` (≤ 40).
5. **Compatibilidade Base64**: Base64 tradicional usa `A-Z`, `a-z`, `0-9`, `+`, `/`, `=`. Compatível com ASCII 32-126; evitar modos `ggwave` que filtrem `+` ou `/`.

### 8.2. Timeouts e Robustez
6. **Timeout Adaptativo**: Calculado como `30s + (5s × total_pacotes × multiplicador_protocolo)` onde multiplicador é 3x para NORMAL, 2x para FAST, 1x para FASTEST. Mínimo de 60s.
7. **Delays de Transmissão**: Adicionar delay entre pacotes baseado no protocolo: 1000ms para NORMAL, 500ms para FAST, 0ms para FASTEST.
8. **Captura de Áudio**: Buffer de 4096 samples, taxa de 48kHz, mono explícito, sem processamento de áudio (echoCancellation/autoGainControl/noiseSuppression = false).

### 8.3. Correção de Erros (FEC)
9. **Esquemas FEC**: 7 opções desde NONE até OVERLAPPING_3, indicados no FLAGS como `F[SCHEME]` (ex.: `FBASIC_3`).
10. **Algoritmos de Paridade**: Tipo 0 (XOR simples), Tipo 1 (XOR ponderado), Overlapping (grupos sobrepostos).
11. **Recuperação**: Tentativa automática com 1 erro (XOR), 2 erros (sistema linear), e recuperação agressiva usando todas as paridades disponíveis.
12. **Padding FEC**: Chunks menores preenchidos com `\0` até 75 bytes antes do cálculo da paridade, removidos após recuperação.
13. **Parser SEQUENCIA Padronizado**: Implementação de parser único que normaliza formatos de entrada:
    - `"1-4"` → normalizado para `"1-4-0"` (tipo padrão)
    - `"1-3-0"` → mantido como está (formato completo)
    - `"2-4-O0"` → mantido como está (overlapping)
    - Validação automática de ranges válidos e tipos suportados
    - Criação de chaves padronizadas para consistência no Map de paridades
14. **Algoritmo OVERLAPPING_3 Determinístico**: OBRIGATÓRIO usar o algoritmo especificado:
    - Grupos principais: `[1-3], [4-6], [7-9], ...` (tipo=0)
    - Grupos overlapping: `[2-4], [3-5], [5-7], [6-8], ...` (tipos O0, O1, O2, ...)
    - Ordem fixa: todos principais primeiro, depois todos overlapping
    - Qualquer desvio causa incompatibilidade total entre transmissor/receptor

### 8.3.4. Implementação do Parser SEQUENCIA

O protocolo implementa um parser padronizado para campos SEQUENCIA em pacotes de paridade, garantindo consistência e robustez:

**Formato Canônico**: `inicio-fim-tipo`
- `inicio`: Número do primeiro pacote do grupo (≥ 1)
- `fim`: Número do último pacote do grupo (≥ inicio)
- `tipo`: Identificador da paridade (`0`, `1`, `O0`, `O1`, etc.)

**Normalização Automática**:
```
Entrada: "1-4"     → Saída: "1-4-0"    (tipo padrão)
Entrada: "1-3-0"   → Saída: "1-3-0"    (inalterado)
Entrada: "2-4-O0"  → Saída: "2-4-O0"   (overlapping)
```

**Funções Implementadas**:
- `parseSequencia(seq)`: Analisa e valida formato de entrada
- `createParityKey(inicio, fim, tipo)`: Cria chaves padronizadas
- `normalizeSequencia(seq)`: Normaliza formato para consistência

**Validação**:
- Verifica se `inicio ≤ fim` e ambos são números válidos
- Retorna `isValid: false` para formatos inválidos
- Logs de warning para entradas malformadas

**Compatibilidade Retroativa**:
- Aceita formatos legados (`"1-4"`) e os normaliza automaticamente
- Mantém compatibilidade com receptores que usam formato incompleto
- Transmissores sempre enviam formato completo (`"1-4-0"`)
- Chaves internas sempre no formato padronizado para consistência

### 8.3.5. Sincronização Crítica do OVERLAPPING_3

**🚨 EXTREMAMENTE IMPORTANTE**: O algoritmo OVERLAPPING_3 é determinístico e DEVE ser implementado exatamente conforme especificado.

**Problema Concreto**:
Se transmissor e receptor implementarem algoritmos diferentes para gerar grupos overlapping, o receptor não conseguirá usar nenhuma paridade overlapping, resultando em falha total de recuperação.

**Exemplo do Problema**:
```javascript
// ❌ IMPLEMENTAÇÃO ERRADA - Transmissor
function gerarGruposOverlapping_TX(N) {
    return [[1,3], [2,4], [4,6], [5,7]]; // Algoritmo A
}

// ❌ IMPLEMENTAÇÃO ERRADA - Receptor  
function gerarGruposOverlapping_RX(N) {
    return [[1,3], [3,5], [5,7], [2,4]]; // Algoritmo B
}
// RESULTADO: Receptor espera P:...:3-5-O0 mas recebe P:...:2-4-O0 = FALHA
```

**✅ Implementação Correta**:
```javascript
// Ambos transmissor e receptor DEVEM usar o mesmo algoritmo:
function gerarGruposOverlapping(N) {
    const grupos = [];
    const principais = new Set();
    
    // 1. Grupos principais primeiro
    for (let i = 1; i <= N; i += 3) {
        const grupo = [i, Math.min(i+2, N), "0"];
        grupos.push(grupo);
        principais.add(`${grupo[0]}-${grupo[1]}`); // Para evitar duplicatas
    }
    
    // 2. Grupos overlapping depois (remove duplicatas de principais)
    let oIndex = 0;
    for (let i = 2; i <= N-2; i++) {
        if (i+2 <= N) {
            const key = `${i}-${i+2}`;
            if (!principais.has(key)) {
                grupos.push([i, i+2, `O${oIndex}`]);
            }
            oIndex++;
        }
    }
    
    return grupos;
}
```

**Verificação de Conformidade**:
- Para 6 pacotes: `[[1,3,"0"], [4,6,"0"], [2,4,"O0"], [3,5,"O1"]]`
- Para 7 pacotes: `[[1,3,"0"], [4,6,"0"], [7,7,"0"], [2,4,"O0"], [3,5,"O1"], [5,7,"O3"]]`
- Para 8 pacotes: `[[1,3,"0"], [4,6,"0"], [7,8,"0"], [2,4,"O0"], [3,5,"O1"], [5,7,"O3"], [6,8,"O4"]]`

### 8.4. Limites e Extensões
15. **Extensão do Limite de Sequência**: Para suportar >9.999.999 pacotes, ampliar o campo `SEQUENCIA` e recalcular limites de cabeçalho e chunk.
16. **Detecção de Duplicatas**: Usando `ID_SESSAO + SEQUENCIA + tipo_pacote` para ignorar retransmissões.
17. **Limpeza de Sessões**: Remoção automática após timeout com logging detalhado do estado final da sessão.