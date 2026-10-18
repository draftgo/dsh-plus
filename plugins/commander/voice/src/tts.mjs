import { VoiceError, isStepTtsModel, normalizeTtsModel, normalizeTtsSpeed } from './config.mjs';

/** Keep vendor extensions out of the standard OpenAI speech request. */
export function speechRequest(config, text) {
  const protocol = config.protocol || (isStepTtsModel(config.model) ? 'step-speech' : 'speech');
  if (!['speech', 'step-speech'].includes(protocol)) throw new VoiceError('Unknown TTS protocol');
  const step = protocol === 'step-speech';
  return {
    model: normalizeTtsModel(config.model),
    voice: config.voice || (step ? 'cixingnansheng' : 'alloy'),
    input: text,
    response_format: 'pcm',
    speed: normalizeTtsSpeed(config.speed),
    ...(step ? { sample_rate: 24000, stream: true } : {}),
  };
}
