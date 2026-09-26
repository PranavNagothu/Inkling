// pdf.js, loaded only by the compare page (it's dynamically imported there, so no other route pays
// for it). The worker is bundled from node_modules — never fetched from a CDN. The legacy build is
// used because it carries polyfills the modern build assumes (e.g. Map.getOrInsertComputed), which
// iPad Safari doesn't have yet.
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";

export type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask };

function ensureWorker() {
  if (GlobalWorkerOptions.workerPort) return;
  GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url), {
    type: "module",
  });
}

/** Opens a PDF from bytes. Rejects with pdf.js' PasswordException / InvalidPDFException as usual. */
export function openPdf(data: ArrayBuffer): PDFDocumentLoadingTask {
  ensureWorker();
  return getDocument({
    data: new Uint8Array(data),
    // (pdf.js 6 no longer compiles fonts with eval, so there's no isEvalSupported switch to turn off.)
    // No XFA forms, no scripting: this is a picture of a notebook page.
    enableXfa: false,
    // No wasm decoders: they would need a wasmUrl, and nothing here is fetched from anywhere else.
    useWasm: false,
  });
}
