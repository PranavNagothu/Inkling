import { describe, expect, it } from 'vitest';
import { dataDirSetting, dbPathSetting, onVercel, ttsDirSetting, uploadDirSetting } from '../paths';
import { shouldSeedOnVercel } from '../vercelDemo';
import { isDemoMode } from '../demoMode';

describe('lib/paths', () => {
  it('keeps the local defaults under data/', () => {
    expect(dataDirSetting({})).toBe('data');
    expect(dbPathSetting({})).toBe('data/inkling.db');
    expect(uploadDirSetting({})).toBe('data/uploads');
    expect(ttsDirSetting({})).toBe('data/tts');
  });

  it('moves everything under INKLING_DATA_DIR (a Railway volume at /data)', () => {
    const env = { INKLING_DATA_DIR: '/data' };
    expect(dbPathSetting(env)).toBe('/data/inkling.db');
    expect(uploadDirSetting(env)).toBe('/data/uploads');
    expect(ttsDirSetting(env)).toBe('/data/tts');
  });

  it('defaults to /tmp/inkling on Vercel (read-only project folder), unless INKLING_DATA_DIR is set', () => {
    expect(onVercel({ VERCEL: '1' })).toBe(true);
    expect(onVercel({ VERCEL: '' })).toBe(false);
    expect(dataDirSetting({ VERCEL: '1' })).toBe('/tmp/inkling');
    expect(dbPathSetting({ VERCEL: '1' })).toBe('/tmp/inkling/inkling.db');
    expect(uploadDirSetting({ VERCEL: '1' })).toBe('/tmp/inkling/uploads');
    expect(dataDirSetting({ VERCEL: '1', INKLING_DATA_DIR: '/tmp/other' })).toBe('/tmp/other');
  });

  it('seeds at cold start only on Vercel, in DEMO_MODE, on SQLite', () => {
    expect(shouldSeedOnVercel({ VERCEL: '1', DEMO_MODE: '1' })).toBe(true);
    expect(shouldSeedOnVercel({ DEMO_MODE: '1' })).toBe(false);
    expect(shouldSeedOnVercel({ VERCEL: '1' })).toBe(false);
    expect(shouldSeedOnVercel({ VERCEL: '1', DEMO_MODE: '1', DATABASE_URL: 'postgres://x' })).toBe(false);
  });

  it('lets the per-item variables win, and ignores blank values', () => {
    const env = { INKLING_DATA_DIR: '/data', INKLING_DB_PATH: 'data/e2e.db', INKLING_UPLOAD_DIR: ' ', INKLING_TTS_DIR: '/tmp/tts' };
    expect(dbPathSetting(env)).toBe('data/e2e.db');
    expect(uploadDirSetting(env)).toBe('/data/uploads');
    expect(ttsDirSetting(env)).toBe('/tmp/tts');
  });
});

describe('isDemoMode', () => {
  it('accepts the usual truthy spellings only', () => {
    for (const v of ['1', 'true', 'YES', ' on ']) expect(isDemoMode({ DEMO_MODE: v })).toBe(true);
    for (const v of [undefined, '', '0', 'false', 'demo']) expect(isDemoMode({ DEMO_MODE: v })).toBe(false);
  });
});
