import { VoiceConfig } from './config.mjs';
import { mountWeb } from './web.mjs';

export const name = 'voice';
export async function apply(ctx, config = {}) {
  const store = await new VoiceConfig(config).open();
  ctx.provide('voice', store);
  ctx.effect(() => () => store.writes);
  ctx.inject(['connection'], child => { mountWeb(child, store, { providers: config.providers }); });
}
