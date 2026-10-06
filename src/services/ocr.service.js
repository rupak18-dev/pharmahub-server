import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScheduler, createWorker } from "tesseract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Local cache for the Tesseract language data so OCR keeps working offline
// after the first run. Falls back to a .tessdata dir next to the server.
const OCR_CACHE_DIR = process.env.OCR_CACHE_DIR || path.resolve(__dirname, "..", "..", ".tessdata");
const OCR_LANG = process.env.OCR_LANG || "eng";
// One or more engine workers; jobs are queued through a scheduler so parallel
// uploads do not each spin up their own engine.
const OCR_WORKERS = Math.min(4, Math.max(1, Number(process.env.OCR_WORKERS) || 2));
const OCR_LANG_PATH = process.env.OCR_LANG_PATH || "https://tessdata.projectnaptha.com/4.0.0";

let scheduler = null;
let initPromise = null;

// Worker threads keep the Node event loop alive, which would stall the test
// runner (and any script that only awaits OCR). Refs are managed per job: the
// workers hold the loop open WHILE a recognition job is running and are
// unref'd when idle, so the process can exit cleanly when nothing is pending.
const allWorkers = [];
const refWorkers = () => allWorkers.forEach((w) => w.worker?.ref?.());
const unrefWorkers = () => allWorkers.forEach((w) => w.worker?.unref?.());

async function ensureScheduler() {
  if (scheduler) return scheduler;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    fs.mkdirSync(OCR_CACHE_DIR, { recursive: true });
    const sched = createScheduler();
    const workers = await Promise.all(
      Array.from({ length: OCR_WORKERS }, async () => {
        // tesseract re-throws unhandled worker rejections in the main thread
        // unless an errorHandler is provided; job failures still reach the
        // caller through the scheduler promise, so a no-op keeps a bad image
        // from crashing the process.
        const w = await createWorker(OCR_LANG, 1, {
          cachePath: OCR_CACHE_DIR,
          langPath: OCR_LANG_PATH,
          errorHandler: () => {},
        });
        // Unref so worker threads never keep the Node event loop (or the test
        // runner) alive — the pool is still reused across requests and the OS
        // reclaims the threads when the process exits.
        w.worker?.unref?.();
        // Job failures reach us through the scheduler's message protocol; a
        // raw Worker 'error' event must not become an uncaughtException.
        w.worker?.on?.("error", () => {});
        return w;
      }),
    );
    for (const w of workers) {
      sched.addWorker(w);
      allWorkers.push(w);
    }
    unrefWorkers();
    scheduler = sched;
    return scheduler;
  })();

  return initPromise;
}

/**
 * Runs OCR on an image file (path or Buffer) and returns the recognised text,
 * the engine's overall confidence, and a flat list of OCR lines with their own
 * confidence scores (used by phone extraction to avoid inventing values).
 * Throws if the document cannot be read.
 */
export async function runOcr(input) {
  const sched = await ensureScheduler();
  refWorkers();
  try {
    const result = await sched.addJob("recognize", input, {}, { text: true, blocks: true });
    const lines = [];
    for (const block of result?.data?.blocks ?? []) {
      for (const paragraph of block?.paragraphs ?? []) {
        for (const line of paragraph?.lines ?? []) {
          const text = String(line?.text ?? "");
          if (!text.trim()) continue;
          lines.push({ text, confidence: Number(line?.confidence) || 0 });
        }
      }
    }
    return {
      text: result?.data?.text ?? "",
      confidence: Number(result?.data?.confidence) || 0,
      lines,
    };
  } finally {
    unrefWorkers();
  }
}

/** Shuts down the worker pool (used by the test suite). */
export async function terminateOcr() {
  if (scheduler) {
    refWorkers();
    await scheduler.terminate();
    scheduler = null;
    initPromise = null;
    allWorkers.length = 0;
  }
}
