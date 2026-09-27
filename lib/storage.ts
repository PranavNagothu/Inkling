import "server-only";

// Where lecture media lives on disk. Uploads go to INKLING_UPLOAD_DIR (default
// <INKLING_DATA_DIR>/uploads, i.e. data/uploads, which is gitignored; see lib/paths); the demo lecture lives in public/demo. Paths stored in the DB are relative to the
// project root and are always server-generated.
import { mkdirSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { isStoredPdfName } from "./notability";
import { isStoredFileName } from "./upload";
import { DEMO_MEDIA_PATH } from "./demo";
import { uploadDirSetting } from "./paths";

const root = () => resolve(/*turbopackIgnore: true*/ process.cwd());

export function uploadDir(): string {
  return resolve(root(), uploadDirSetting());
}

/** Absolute destination for a new upload plus the relative path to store. Creates the directory. */
export function uploadTarget(storedName: string): { abs: string; rel: string } {
  if (!isStoredFileName(storedName)) throw new Error("invalid storage name");
  const dir = uploadDir();
  mkdirSync(dir, { recursive: true });
  const abs = resolve(dir, storedName);
  return { abs, rel: relative(root(), abs).split(sep).join("/") };
}

const within = (dir: string, abs: string) => abs.startsWith(dir + sep);

/**
 * Resolves a stored media path to an absolute file, refusing anything outside the upload directory
 * (or the bundled demo file). Defence in depth: paths are server-generated, but a tampered DB row
 * must still not let the media route read arbitrary files.
 */
export function resolveMediaPath(mediaPath: string): string | null {
  if (!mediaPath || mediaPath.includes("\0")) return null;
  const abs = resolve(root(), mediaPath);
  if (abs === resolve(root(), DEMO_MEDIA_PATH)) return abs;
  const dir = uploadDir();
  if (within(dir, abs) && dirname(abs) === dir && isStoredFileName(basename(abs))) return abs;
  return null;
}

/** Notability PDF exports live in their own sub-folder of the upload directory. */
export function notabilityDir(): string {
  return resolve(uploadDir(), "notability");
}

/** Absolute destination for a new Notability PDF (server-generated name only). Creates the folder. */
export function pdfUploadTarget(storedName: string): string {
  if (!isStoredPdfName(storedName)) throw new Error("invalid storage name");
  const dir = notabilityDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return resolve(dir, storedName);
}

/** Resolves a stored Notability PDF name to its file, refusing anything that isn't one of ours. */
export function resolvePdfPath(storedName: string): string | null {
  if (!storedName || storedName.includes("\0") || !isStoredPdfName(storedName)) return null;
  const dir = notabilityDir();
  const abs = resolve(dir, storedName);
  return within(dir, abs) && dirname(abs) === dir && basename(abs) === storedName ? abs : null;
}
