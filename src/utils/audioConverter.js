const { spawn } = require('child_process');
const logger = require('./logger');
const { Readable } = require('stream');

/**
 * Converte um fluxo de entrada (Stream ou Buffer) de áudio (ex: OGG) para WAV usando FFmpeg.
 * Retorna uma Promise que resolve com o Buffer do áudio convertido (WAV 16-bit PCM, 24kHz mono recomendado para GPT-4o, ou padrão).
 * @param {Readable|Buffer} input - O stream ou buffer de entrada (OGG/Opus do WhatsApp).
 * @returns {Promise<Buffer>} O buffer do arquivo WAV convertido.
 */
function convertOggToWav(input) {
    return new Promise((resolve, reject) => {
        // Se for buffer, transformar em stream para uniformizar
        let inputStream = input;
        if (Buffer.isBuffer(input)) {
            inputStream = new Readable();
            inputStream.push(input);
            inputStream.push(null);
        }

        // FFmpeg args:
        // -i pipe:0  -> Lê do stdin
        // -f wav     -> Formato de saída WAV
        // -ac 1      -> Mono (opcional, mas bom pra STT/LLM)
        // -ar 24000  -> Taxa de amostragem 24kHz (bom equilíbrio para GPT-4o input)
        // pipe:1     -> Escreve no stdout
        const ffmpegArgs = [
            '-i', 'pipe:0',
            '-f', 'wav',
            '-ac', '1',
            '-ar', '24000',
            'pipe:1'
        ];

        const ffmpegPath = 'C:\\ffmpeg\\bin\\ffmpeg.exe'; // Caminho absoluto para evitar ENOENT no Windows
        const ffmpeg = spawn(ffmpegPath, ffmpegArgs);
        const chunks = [];

        // Pipe input stream to ffmpeg stdin
        inputStream.pipe(ffmpeg.stdin);

        // Capture stdout (converted audio)
        ffmpeg.stdout.on('data', (chunk) => {
            chunks.push(chunk);
        });

        // Handle errors
        ffmpeg.on('error', (err) => {
            logger.error(`[AudioConverter] Erro ao iniciar processo ffmpeg: ${err.message}`);
            reject(err);
        });

        ffmpeg.stderr.on('data', (data) => {
            // FFmpeg escreve logs no stderr. Descomente para debug se necessário.
            // const msg = data.toString();
            // if (!msg.includes('frame=') && !msg.includes('size=')) { // Ignora logs de progresso
            //    logger.debug(`[AudioConverter FFmpeg Log] ${msg}`);
            // }
        });

        // Handle process exit
        ffmpeg.on('close', (code) => {
            if (code !== 0) {
                logger.error(`[AudioConverter] FFmpeg encerrou com código de erro: ${code}`);
                reject(new Error(`FFmpeg exited with code ${code}`));
            } else {
                const outputBuffer = Buffer.concat(chunks);
                logger.info(`[AudioConverter] Conversão para WAV concluída com sucesso. Tamanho: ${outputBuffer.length} bytes.`);
                resolve(outputBuffer);
            }
        });
    });
}

module.exports = {
    convertOggToWav
};
