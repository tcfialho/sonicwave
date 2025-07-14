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
- **`P` (Parity)**: `P:ID_SESSAO:inicio-fim:DADOS`
  - Ex.: `P:1234567890-123456:1-4:H4sIAAAAAAAAA0vOzwMABf4B3Q==`
- **`E` (End)**: `E:ID_SESSAO::`
  - Ex.: `E:1234567890-123456::`

**Campos**:
- **`ID_SESSAO`**: `timestamp-nonce_6_digitos` (ex.: `1234567890-123456`, ≤ 15 caracteres).
- **`SEQUENCIA`**:
  - `D`: Número do pacote (≤ 7 dígitos, máx. 9.999.999).
  - `P`: `inicio-fim` (ex.: `1-4` para `D1-D4`).
  - `S`/`E`: Vazio (`""`).
- **`DADOS`**: Chunk ou paridade, codificado em Base64 tradicional, ≤ 100 caracteres (incluindo padding).
- **`HASH_MD5`**: Hash MD5 (16 bytes, 24 caracteres em Base64 com padding).
- **`TOTAL`**: Total de pacotes `DATA`.
- **`FLAGS`**: `C` (comprimido com gzip), vazio (`""`) ou múltiplos flags separados por `,` (ex.: `C,E`).

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

### 5.2. Reatividade
- Pacotes autônomos permitem processamento independente de temporização.

## 6. Funcionalidades de Robustez

### 6.1. Gerenciamento de Sessões
- **Timeout adaptativo**: `TOTAL × duração_média_pacote × 1.5`, com `duração_média_pacote` de `ggwave.mode.txDurationPerChar()` ou medição real.
- **Limpeza**: Sessões incompletas removidas após timeout.
- **Duplicados**: Ignorados com `ID_SESSAO` + `SEQUENCIA`.

### 6.2. Validação de Integridade
- **Hash MD5**: Em Base64 (24 caracteres), no `START`.
- **Verificação**: Compara hash dos dados remontados (antes da descompressão se `FLAGS=C`).
- **Corrupção**: Descarta mensagens inválidas.

### 6.3. Correção de Erros (FEC)
- **Conceito (XOR)**:
  1. Agrupa 4 pacotes `DATA` consecutivamente (ex.: D1-D4, D5-D8).
  2. Calcula paridade via XOR nos dados brutos (com padding `\0` até 75 bytes), codifica em Base64.
  3. Receptor decodifica Base64, aplica XOR, reconstrói 1 pacote perdido por grupo.
- **Mapeamento**: `P:ID:inicio-fim:DADOS` (ex.: `1-4`).
- **Grupos incompletos**: Sem paridade para <4 pacotes, vulneráveis a perdas.
- **Padding**: Preenche chunks menores com `\0` até 75 bytes antes de Base64.
- **Remoção**: Após Base64-decode e FEC, remove `\0` antes de concatenar chunks.
- **Nota**: Paridade usa mesmo tamanho de chunk (75 bytes, ~100 caracteres em Base64).
- **Limite**: 1 perda por grupo; usar DTMF para alto BER.

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
P:1734567890-654321:1-4:ZAAHRQZSHR9DFBxHFloNHwMZBw4UCF0jCgZRBFNFUhwHD1QIFV4WWhQFAQJcRxtHV3cABkYDSUNaEBwZABxUDRsGBQUWGkJdGwAZ
E:1734567890-654321::

```

**Nota:** Grupo D1-D4 com pacote de paridade P1-4. Se D2 for perdido, pode ser recuperado via: `D2 = D1 XOR D3 XOR D4 XOR P1-4`.

### Exemplo 3: Com Compressão

**Mensagem:** Dados comprimidos com gzip (1 chunk)

```
S:1734567890-789012::m9F2k7P8vQ3nR6eE8tA5Cw==:1:C
D:1734567890-789012:1:H4sIAAAAAAAAA+3OMQ7CMAyF4StyBME5IVJGRKsOVi1GZuPEpBK3+q01QIIVJHnvn3MJf2N4Y2B7GI8yj1z
E:1734567890-789012::
```

**Nota:** FLAGS=C indica compressão gzip. Hash MD5 calculado nos dados comprimidos.

## 8. Notas de Implementação
1. **MD5 Byte-Stream**: MD5 calculado nos dados transmitidos: após compressão (se `FLAGS=C`) ou brutos. Verificar antes da descompressão.
2. **MD5 em Base64**: Usar Base64 tradicional (16 bytes → 24 caracteres com padding `=`).
3. **Regra do `:` Final**: Se `FLAGS` vazio, omitir o campo e terminar o cabeçalho sem o último `:`. Ex.: `S:ID::HASH:TOTAL`. Evitar `S:ID::HASH:TOTAL::`.
4. **Tamanho do Chunk com Múltiplos Flags**: Recalcular tamanho do chunk como `140 − len(cabeçalho)` para `S` (até ~52 caracteres) e `D`/`P`/`E` (≤ 40).
5. **Compatibilidade Base64**: Base64 tradicional usa `A-Z`, `a-z`, `0-9`, `+`, `/`, `=`. Compatível com ASCII 32-126; evitar modos `ggwave` que filtrem `+` ou `/`.
6. **Extensão do Limite de Sequência**: Para suportar >9.999.999 pacotes, ampliar o campo `SEQUENCIA` e recalcular limites de cabeçalho e chunk.