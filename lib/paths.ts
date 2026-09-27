// Where Inkling keeps its files: the SQLite database, uploaded lectures and Notability PDFs, and the
// read-aloud audio cache. Everything lives under one data folder, INKLING_DATA_DIR (default `data`,
// relative to the project root; gitignored), so a host with a persistent volume (Railway: /data)
// only has to point that one variable at it. The older per-item variables still win when set:
//
//   INKLING_DB_PATH     default <data>/inkling.db
//   INKLING_UPLOAD_DIR  default <data>/uploads        (Notability PDFs: <uploads>/notability)
//   INKLING_TTS_DIR     default <data>/tts
//
// Values may be relative (to the project root) or absolute; callers resolve them against cwd.
// No `server-only` marker: scripts (tsx) and tests import this too. Keep scripts/start-prod.mjs in
// step with these defaults.
import { join } from "node:path";

type Env = Record<string, string | undefined>;

const setting = (v: string | undefined) => v?.trim() || null;

export function dataDirSetting(env: Env = process.env): string {
  return setting(env.INKLING_DATA_DIR) ?? "data";
}

export function dbPathSetting(env: Env = process.env): string {
  return setting(env.INKLING_DB_PATH) ?? join(dataDirSetting(env), "inkling.db");
}

export function uploadDirSetting(env: Env = process.env): string {
  return setting(env.INKLING_UPLOAD_DIR) ?? join(dataDirSetting(env), "uploads");
}

export function ttsDirSetting(env: Env = process.env): string {
  return setting(env.INKLING_TTS_DIR) ?? join(dataDirSetting(env), "tts");
}
