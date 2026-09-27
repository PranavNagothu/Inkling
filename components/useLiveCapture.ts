"use client";

// Live lecture capture: the session clock, the microphone (level meter + MediaRecorder for
// Replay 20 s) and in-browser speech recognition (Web Speech API) whose final results become
// transcript cues, saved to the server in small idempotent batches (POST /api/lectures/[id]/cues).
// The microphone is requested only from start() (a click), and every track is stopped on finish()
// or when the page goes away.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  DEFAULT_LIVE_LANGUAGE,
  clockNow,
  newLiveClock,
  pauseClock,
  pickRecordingMime,
  resultToCue,
  startClock,
  type LiveClock,
  type LiveCue,
} from "@/lib/liveLecture";

// ── Minimal Web Speech API typings (not in TypeScript's DOM lib) ──────────────────────────────────

interface SpeechAlternative {
  transcript: string;
}
interface SpeechResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechAlternative;
}
interface SpeechResultEvent extends Event {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: SpeechResult };
}
interface SpeechErrorEvent extends Event {
  readonly error: string;
}
interface Recognizer extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognizerCtor = new () => Recognizer;

function recognizerCtor(): RecognizerCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognizerCtor; webkitSpeechRecognition?: RecognizerCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface LiveSupport {
  speech: boolean;
  mic: boolean;
  recorder: boolean;
  /** Microphone access needs a secure context (HTTPS or localhost). */
  secure: boolean;
}

const noSubscribe = () => () => {};
let supportCache: LiveSupport | null = null;
const readSupport = (): LiveSupport => {
  if (!supportCache) {
    supportCache = {
      speech: recognizerCtor() !== null,
      mic: typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function",
      recorder: typeof MediaRecorder !== "undefined",
      secure: typeof window !== "undefined" && window.isSecureContext,
    };
  }
  return supportCache;
};

/** What the browser can do (null during server render and hydration). */
export function useLiveSupport(): LiveSupport | null {
  return useSyncExternalStore(noSubscribe, readSupport, () => null);
}

/**
 * One continuous recognition "session" as the student sees it: Chrome ends recognition after a
 * stretch of silence (or a network hiccup), so it is started again until stop() — with a short
 * back-off when it keeps ending right away.
 */
class SpeechLoop {
  private rec: Recognizer | null = null;
  private want = false;
  private lang = DEFAULT_LIVE_LANGUAGE;
  private delay = 250;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private cb: {
      onFinal: (text: string) => void;
      onInterim: (text: string) => void;
      onError: (message: string | null) => void;
    },
  ) {}

  /** Starts listening in `lang` (restarts when already listening in another language). */
  start(lang: string) {
    const restart = this.want && this.lang !== lang;
    this.lang = lang;
    this.want = true;
    this.delay = 250;
    if (restart && this.rec) this.rec.stop();
    else if (!this.rec) this.open();
  }

  private open() {
    const Ctor = recognizerCtor();
    if (!Ctor || !this.want) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    const startedAt = performance.now();
    rec.onresult = (e) => {
      let pending = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0]?.transcript ?? "";
        if (r.isFinal) this.cb.onFinal(text);
        else pending += text;
      }
      this.cb.onInterim(pending.trim());
      this.cb.onError(null); // hearing again: any "can't be reached" note is stale
      this.delay = 250;
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.want = false;
        this.cb.onError("Speech recognition was blocked, so there’s no live transcript. Your notes still work.");
      } else if (e.error === "language-not-supported") {
        this.want = false;
        this.cb.onError("This browser can’t transcribe that language. Pick another one.");
      } else if (e.error === "network") {
        this.cb.onError("The browser’s speech service can’t be reached — retrying.");
      }
    };
    rec.onend = () => {
      if (this.rec === rec) this.rec = null;
      this.cb.onInterim("");
      if (!this.want) return;
      this.delay = performance.now() - startedAt < 1000 ? Math.min(3000, this.delay * 2) : 250;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.open(), this.delay);
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      // Already starting: the running one carries on.
    }
  }

  /** Stops listening; resolves once the last final result is in (at most 1.5 s). */
  stop(): Promise<void> {
    this.want = false;
    if (this.timer) clearTimeout(this.timer);
    const rec = this.rec;
    if (!rec) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = setTimeout(resolve, 1500);
      rec.addEventListener("end", () => {
        clearTimeout(done);
        resolve();
      });
      try {
        rec.stop();
      } catch {
        clearTimeout(done);
        resolve();
      }
    });
  }

  /** Stops at once, dropping anything unfinished (leaving the page). */
  abort() {
    this.want = false;
    if (this.timer) clearTimeout(this.timer);
    try {
      this.rec?.abort();
    } catch {
      // already stopped
    }
    this.rec = null;
  }
}

// ── The hook ───────────────────────────────────────────────────────────────────────────────────

export type LiveStatus = "idle" | "starting" | "running" | "paused" | "ended";
/** on: recording + listening; blocked: permission denied; unavailable: no mic API; off: not started / stopped. */
export type MicState = "off" | "on" | "blocked" | "unavailable";

export interface FinishResult {
  /** Every cue reached the server. */
  cuesSaved: boolean;
  /** The microphone recording, when one was made. */
  recording: Blob | null;
  /** Session-clock length at the end. */
  durationMs: number;
}

interface Options {
  lectureId: string;
  /** False: nothing here does anything (not a Live lecture, or DEMO_MODE). */
  enabled: boolean;
  /** Clock start (0 for a new lecture; its length so far when a session is resumed). */
  offsetMs: number;
}

/** How often unsaved cues are sent. */
const CUE_FLUSH_MS = 3000;

export function useLiveCapture({ lectureId, enabled, offsetMs }: Options) {
  const support = useLiveSupport();
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [mic, setMic] = useState<MicState>("off");
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [cues, setCues] = useState<LiveCue[]>([]);
  const [interim, setInterim] = useState("");
  const [language, setLanguageState] = useState(DEFAULT_LIVE_LANGUAGE);
  const [saveError, setSaveError] = useState<string | null>(null);

  const clockRef = useRef<LiveClock>(newLiveClock(offsetMs));
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const meterRafRef = useRef(0);
  const levelElRef = useRef<HTMLElement | null>(null);
  /** Clock time the utterance being recognised began (first interim result); null between utterances. */
  const utteranceStartRef = useRef<number | null>(null);
  const lastCueEndRef = useRef(offsetMs);
  /** Cues not yet confirmed saved, oldest first, and whether a save is in flight. */
  const pendingRef = useRef<LiveCue[]>([]);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const blockedRef = useRef(false);

  const getMs = useCallback(() => clockNow(clockRef.current, performance.now()), []);

  // ── Saving cues ──
  const saveOnce = useCallback(async (): Promise<boolean> => {
    const batch = pendingRef.current.slice(0, 200);
    if (batch.length === 0 || blockedRef.current) return batch.length === 0;
    try {
      const res = await fetch(`/api/lectures/${encodeURIComponent(lectureId)}/cues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cues: batch, durationMs: getMs() }),
      });
      if (res.status === 403) blockedRef.current = true;
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSaveError(body.error || `Transcript not saved (HTTP ${res.status}) — retrying`);
        return false;
      }
      // Confirmed: drop exactly what was sent (more may have arrived meanwhile).
      pendingRef.current = pendingRef.current.slice(batch.length);
      setSaveError(null);
      return true;
    } catch {
      setSaveError("Transcript not saved — check your connection. Retrying…");
      return false;
    }
  }, [lectureId, getMs]);

  /** Sends pending cues (one request at a time). Resolves true when nothing is left unsaved. */
  const flushCues = useCallback(async (): Promise<boolean> => {
    while (savingRef.current) await savingRef.current;
    const run = (async () => {
      while (pendingRef.current.length > 0) {
        if (!(await saveOnce())) return false;
      }
      return true;
    })();
    savingRef.current = run;
    try {
      return await run;
    } finally {
      savingRef.current = null;
    }
  }, [saveOnce]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (pendingRef.current.length > 0 && !savingRef.current) void flushCues();
    }, CUE_FLUSH_MS);
    return () => clearInterval(timer);
  }, [enabled, flushCues]);

  // ── Speech recognition ──
  const addFinal = useCallback(
    (text: string) => {
      const end = getMs();
      const start = utteranceStartRef.current ?? lastCueEndRef.current;
      utteranceStartRef.current = null;
      const cue = resultToCue(text, start, end, lastCueEndRef.current);
      if (!cue) return;
      lastCueEndRef.current = cue.endMs;
      pendingRef.current.push(cue);
      setCues((prev) => [...prev, cue]);
    },
    [getMs],
  );

  const speechRef = useRef<SpeechLoop | null>(null);
  const speech = useCallback((): SpeechLoop => {
    speechRef.current ??= new SpeechLoop({
      onFinal: (text) => addFinal(text),
      onInterim: (text) => {
        if (text && utteranceStartRef.current === null) utteranceStartRef.current = getMs();
        setInterim(text);
      },
      onError: (message) => setSpeechError(message),
    });
    return speechRef.current;
  }, [addFinal, getMs]);

  // ── Microphone: level meter + recorder ──
  const stopMeter = useCallback(() => {
    cancelAnimationFrame(meterRafRef.current);
    if (levelElRef.current) levelElRef.current.style.transform = "scaleX(0)";
  }, []);

  const startMeter = useCallback(() => {
    const ctx = audioCtxRef.current;
    const stream = streamRef.current;
    if (!ctx || !stream) return;
    void ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let smooth = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / data.length);
      smooth = Math.max(rms * 4, smooth * 0.85);
      if (levelElRef.current) levelElRef.current.style.transform = `scaleX(${Math.min(1, smooth).toFixed(3)})`;
      meterRafRef.current = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(meterRafRef.current);
    meterRafRef.current = requestAnimationFrame(tick);
  }, []);

  /** Stops every microphone track and the audio graph (idempotent). */
  const releaseMic = useCallback(() => {
    stopMeter();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, [stopMeter]);

  const openMic = useCallback(async (): Promise<MicState> => {
    if (!support?.mic) return "unavailable";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      try {
        audioCtxRef.current = new AudioContext();
      } catch {
        audioCtxRef.current = null;
      }
      // Replay 20 s needs the recording to line up with the clock, so only a lecture's first
      // capture (clock at 0) is recorded; a resumed one keeps transcribing and timestamping.
      if (support.recorder && clockRef.current.bankedMs === 0) {
        const mimeType = pickRecordingMime((m) => MediaRecorder.isTypeSupported(m));
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorderRef.current = recorder;
      }
      return "on";
    } catch (err) {
      console.error("microphone unavailable", err);
      return err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError")
        ? "blocked"
        : "unavailable";
    }
  }, [support]);

  // ── Controls ──
  const start = useCallback(async () => {
    if (!enabled || status === "starting" || status === "running" || status === "ended") return;
    setStatus("starting");
    let micState = mic;
    if (!streamRef.current) {
      micState = await openMic();
      setMic(micState);
    } else {
      streamRef.current.getAudioTracks().forEach((t) => (t.enabled = true));
    }
    // The clock and the recorder start together, so recording time == session time.
    const recorder = recorderRef.current;
    if (recorder?.state === "inactive") recorder.start(1000);
    else if (recorder?.state === "paused") recorder.resume();
    clockRef.current = startClock(clockRef.current, performance.now());
    if (micState === "on") startMeter();
    if (support?.speech) speech().start(language);
    setStatus("running");
  }, [enabled, status, mic, openMic, startMeter, speech, support, language]);

  const pause = useCallback(async () => {
    if (status !== "running") return;
    clockRef.current = pauseClock(clockRef.current, performance.now());
    if (recorderRef.current?.state === "recording") recorderRef.current.pause();
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = false));
    stopMeter();
    setStatus("paused");
    await speechRef.current?.stop();
  }, [status, stopMeter]);

  const setLanguage = useCallback(
    (tag: string) => {
      setLanguageState(tag);
      setSpeechError(null);
      // Restart recognition in the new language when it is running.
      if (status === "running" && support?.speech) speech().start(tag);
    },
    [status, support, speech],
  );

  /** Stops everything, saves the transcript and hands back the recording (End session). */
  const finish = useCallback(async (): Promise<FinishResult> => {
    clockRef.current = pauseClock(clockRef.current, performance.now());
    const durationMs = getMs();
    await speechRef.current?.stop();
    const recorder = recorderRef.current;
    let recording: Blob | null = null;
    if (recorder && recorder.state !== "inactive") {
      recording = await new Promise<Blob | null>((resolve) => {
        const done = setTimeout(() => resolve(null), 4000);
        recorder.onstop = () => {
          clearTimeout(done);
          const type = recorder.mimeType || chunksRef.current[0]?.type || "audio/webm";
          resolve(chunksRef.current.length ? new Blob(chunksRef.current, { type }) : null);
        };
        recorder.stop();
      });
    }
    recorderRef.current = null;
    releaseMic();
    setMic("off");
    setStatus("ended");
    let cuesSaved = await flushCues();
    for (let i = 0; !cuesSaved && !blockedRef.current && i < 2; i++) cuesSaved = await flushCues();
    return { cuesSaved: cuesSaved || pendingRef.current.length === 0, recording, durationMs };
  }, [getMs, releaseMic, flushCues]);

  // Leaving the page (or client-side navigation): never keep the microphone open, and hand any
  // unsaved cues to the browser so they outlive the page.
  useEffect(() => {
    if (!enabled) return;
    const onHide = () => {
      const batch = pendingRef.current.slice(0, 200);
      if (batch.length && !blockedRef.current) {
        void fetch(`/api/lectures/${encodeURIComponent(lectureId)}/cues`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cues: batch, durationMs: clockNow(clockRef.current, performance.now()) }),
          keepalive: true,
        }).catch(() => {});
      }
    };
    const onPageHide = () => {
      onHide();
      // Leaving the page never keeps the microphone open.
      speechRef.current?.abort();
      releaseMic();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      onHide();
      speechRef.current?.abort();
      if (recorderRef.current?.state !== "inactive") {
        try {
          recorderRef.current?.stop();
        } catch {
          // already stopped
        }
      }
      releaseMic();
    };
  }, [enabled, lectureId, releaseMic]);

  /** Attach to the level meter's fill element (scaled on the x axis, 0..1, without re-renders). */
  const attachLevel = useCallback((el: HTMLElement | null) => {
    levelElRef.current = el;
  }, []);

  return {
    support,
    status,
    mic,
    speechError,
    saveError,
    cues,
    interim,
    language,
    setLanguage,
    start,
    pause,
    finish,
    flushCues,
    getMs,
    attachLevel,
  };
}

export type LiveCapture = ReturnType<typeof useLiveCapture>;
