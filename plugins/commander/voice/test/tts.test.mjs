import test from 'node:test';
import assert from 'node:assert/strict';
import { speechRequest } from '../src/tts.mjs';
import { normalizeTtsSpeed, updateConfig } from '../src/config.mjs';

test('standard and unfamiliar models use only OpenAI speech fields regardless of provider', () => {
  for (const model of ['gpt-4o-mini-tts', 'tts-1', 'custom-speaker']) {
    const body = speechRequest({ model, providerId: 'routergo', baseURL: 'https://api.stepfun.com/v1' }, '你好');
    assert.deepEqual(body, { model, voice: 'alloy', input: '你好', response_format: 'pcm', speed: 1.2 });
    for (const field of ['sample_rate', 'stream', 'stream_format']) assert.equal(Object.hasOwn(body, field), false);
  }
});

test('known Step models and the 2.5 alias preserve legacy streaming extensions', () => {
  for (const model of ['stepaudio-2.5-tts', 'stepfun-2.5-tts', 'stepaudio-3-tts', 'step-tts-2', 'step-tts-mini']) {
    const body = speechRequest({ model }, '测试');
    assert.deepEqual(body, { model, voice: 'cixingnansheng', input: '测试', response_format: 'pcm', speed: 1.2, sample_rate: 24000, stream: true });
  }
});

test('explicit standard protocol overrides Step model inference and prevents vendor fields', () => {
  assert.deepEqual(speechRequest({ model: 'stepaudio-2.5-tts', protocol: 'speech' }, 'text'), { model: 'stepaudio-2.5-tts', voice: 'alloy', input: 'text', response_format: 'pcm', speed: 1.2 });
});

test('explicit Step protocol supports a custom model without provider heuristics', () => {
  assert.deepEqual(speechRequest({ model: 'custom-speaker', protocol: 'step-speech', providerId: 'custom' }, 'text'), { model: 'custom-speaker', voice: 'cixingnansheng', input: 'text', response_format: 'pcm', speed: 1.2, sample_rate: 24000, stream: true });
});

test('configured voice wins for both speech protocols and inputs are not mutated', () => {
  for (const protocol of ['speech', 'step-speech']) {
    const config = Object.freeze({ model: 'stepaudio-2.5-tts', voice: 'qingchunshaonv', protocol });
    assert.equal(speechRequest(config, '保留音色').voice, 'qingchunshaonv');
  }
});

test('unknown explicit TTS protocol is rejected rather than silently selecting a vendor', () => {
  assert.throws(() => speechRequest({ model: 'stepaudio-2.5-tts', protocol: 'unknown' }, 'text'), /Unknown TTS protocol/u);
});

test('speed is explicit, bounded, and precise for both protocols', () => {
  assert.equal(normalizeTtsSpeed(undefined), 1.2);
  assert.equal(speechRequest({ model: 'tts-1', speed: 0.25 }, 'x').speed, 0.25);
  assert.equal(speechRequest({ model: 'stepaudio-2.5-tts', speed: 2.75 }, 'x').speed, 2.75);
  for (const value of [0.24, 4.01, 1.234, NaN, Infinity, '1.2', null]) assert.throws(() => normalizeTtsSpeed(value), /Invalid TTS speed/u);
});

test('config defaults and persists the TTS speed', () => {
  const current = { tts: { model: 'tts-1', voice: '' } };
  assert.equal(updateConfig(current, {}).tts.speed, 1.2);
  assert.equal(updateConfig(current, { tts: { speed: 1.35 } }).tts.speed, 1.35);
});
