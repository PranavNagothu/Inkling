import { describe, expect, it } from 'vitest';
import { dataDirSetting, dbPathSetting, ttsDirSetting, uploadDirSetting } from '../paths';
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
