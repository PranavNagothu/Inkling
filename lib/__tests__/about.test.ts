import { describe, expect, it } from 'vitest';
import { MIT_OCW_ATTRIBUTION, aiLabel, lectureAttribution, storageLabel, voiceLabel } from '../about';

describe('aiLabel', () => {
  it('names the provider and model, or says why there is none — never a key', () => {
    expect(aiLabel({ enabled: true, mode: 'live', provider: 'openai', model: 'gpt-5-mini' })).toBe('OpenAI · gpt-5-mini');
    expect(aiLabel({ enabled: true, mode: 'live', provider: 'gemini', model: 'gemini-3.1-flash-lite' })).toBe('Google Gemini · gemini-3.1-flash-lite');
    expect(aiLabel({ enabled: true, mode: 'live', provider: 'grok', model: 'grok-4-fast-non-reasoning' })).toBe('xAI Grok · grok-4-fast-non-reasoning');
    expect(aiLabel({ enabled: true, mode: 'demo', provider: 'fake', model: 'fake-1' })).toMatch(/^Demo fixtures/);
    expect(aiLabel({ enabled: true, mode: 'fake', provider: 'fake', model: 'fake-1' })).toMatch(/^Fake/);
    expect(aiLabel({ enabled: false, mode: 'off', provider: null, model: null })).toMatch(/^Off/);
  });
});

describe('voiceLabel', () => {
  it('ElevenLabs / OpenAI / the browser voice', () => {
    expect(voiceLabel({ kind: 'elevenlabs', model: 'eleven_flash_v2_5' })).toBe('ElevenLabs · eleven_flash_v2_5');
    expect(voiceLabel({ kind: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy' })).toBe('OpenAI TTS · gpt-4o-mini-tts (alloy)');
    expect(voiceLabel(null)).toMatch(/browser.*no ElevenLabs/i);
    expect(voiceLabel(null, { demoMode: true })).toMatch(/browser.*DEMO_MODE.*offline/i);
  });
});

describe('storageLabel', () => {
  it('backend plus Timescale', () => {
    expect(storageLabel({ backend: 'postgres', timescale: true })).toBe('Postgres + TimescaleDB (Tiger Data)');
    expect(storageLabel({ backend: 'postgres', timescale: false })).toBe('Postgres');
    expect(storageLabel({ backend: 'sqlite', timescale: false })).toBe('SQLite (local file)');
  });
});

describe('lectureAttribution', () => {
  it('credits MIT OpenCourseWare lectures (CC BY-NC-SA)', () => {
    for (const title of ['MIT 18.01 Lecture 4: Chain rule', '18.01 Single Variable Calculus — Lecture 4', 'OpenCourseWare calculus']) {
      expect(lectureAttribution({ id: 'l_x', title })).toEqual({ kind: 'mit', text: MIT_OCW_ATTRIBUTION });
    }
    expect(MIT_OCW_ATTRIBUTION).toMatch(/MIT OpenCourseWare 18\.01.*CC BY-NC-SA/);
  });

  it('explains the bundled demo lecture, and leaves other uploads alone', () => {
    expect(lectureAttribution({ id: 'demo-chain-rule', title: 'Calculus I — The Chain Rule (demo)' }).kind).toBe('demo');
    expect(lectureAttribution({ id: 'l_1', title: 'Week 3 recording' })).toEqual({ kind: 'user', text: null });
  });
});
