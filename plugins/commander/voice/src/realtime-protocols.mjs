import { VoiceError } from './config.mjs';

// Wire formats depend on the selected protocol, never a provider identity.
const protocols = {
  'step-websocket': {
    path: '/realtime/asr/stream', query: {}, requiresItemId: false,
    ready: type => type === 'session.created' || type === 'session.updated',
    session: model => ({ audio: { input: {
      format: { type: 'pcm', codec: 'pcm_s16le', rate: 24000, bits: 16, channel: 1 },
      transcription: { model, language: 'zh', full_rerun_on_commit: true, enable_itn: true },
      turn_detection: null,
    } } }),
    partial: (event, previous) => typeof event.text === 'string' ? event.text : previous,
  },
  'openai-websocket': {
    path: '/realtime', query: { intent: 'transcription' }, requiresItemId: true,
    // Initial session.created does not acknowledge our transcription settings.
    ready: type => type === 'session.updated',
    session: model => ({ type: 'transcription', audio: { input: {
      format: { type: 'audio/pcm', rate: 24000 }, transcription: { model }, turn_detection: null,
    } } }),
    partial: (event, previous) => typeof event.delta === 'string' ? previous + event.delta : previous,
  },
};

export function realtimeProtocol(protocol = 'openai-websocket') {
  const adapter = Object.hasOwn(protocols, protocol) ? protocols[protocol] : undefined;
  if (!adapter) throw new VoiceError('Select a supported native realtime ASR protocol', 400);
  return adapter;
}
