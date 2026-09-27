"use client";

// The "Ask Inkling" chat panel: a modal dialog (focus trapped, Esc closes, scroll locked, focus
// returned to the launcher by the caller). Answers stream in from POST /api/ask as plain text;
// the finished answer is announced once through a polite live region (not token by token).
import { useCallback, useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { motion } from "motion/react";
import { STARTER_QUESTIONS } from "@/lib/landing/knowledge";
import { tidyAnswer } from "@/lib/landing/ask/tidy";
import { motionTokens, springs } from "@/lib/motion";
import { CloseIcon, SendIcon, StopIcon } from "../icons";
import { LiquidMetal } from "../ui/liquid-metal";
import { usePrefersReducedMotion } from "../../motion/usePrefersReducedMotion";
import { CLIENT_HISTORY, buildRequestBody, type ChatMsg } from "./types";

const GENERIC_ERROR = "Sorry, I couldn't answer that right now. Please try again in a moment.";
const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

let nextId = 1;

export function AskPanel({
  messages,
  setMessages,
  initialQuestion,
  onConsumeInitial,
  onClose,
}: {
  messages: ChatMsg[];
  setMessages: Dispatch<SetStateAction<ChatMsg[]>>;
  initialQuestion?: string;
  onConsumeInitial: () => void;
  onClose: () => void;
}) {
  const reduce = usePrefersReducedMotion();
  const titleId = useId();
  const descId = useId();
  const inputId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState("");

  /* ───────── dialog behaviour ───────── */

  useEffect(() => {
    inputRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
      abortRef.current?.abort();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Keep the newest message in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [messages, reduce]);

  /* ───────── asking ───────── */

  const ask = useCallback(
    async (raw: string) => {
      const question = raw.trim().slice(0, CLIENT_HISTORY.maxMessageChars);
      if (!question || busy) return;
      const history = messages;
      const user: ChatMsg = { id: nextId++, role: "user", text: question, status: "done" };
      const reply: ChatMsg = { id: nextId++, role: "assistant", text: "", status: "streaming" };
      setMessages((m) => [...m, user, reply]);
      setDraft("");
      setBusy(true);
      setAnnounce("");

      const update = (patch: Partial<ChatMsg>) =>
        setMessages((m) => m.map((x) => (x.id === reply.id ? { ...x, ...patch } : x)));

      const controller = new AbortController();
      abortRef.current = controller;
      let text = "";
      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: buildRequestBody(question, history),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          let msg = GENERIC_ERROR;
          if ([400, 413, 429].includes(res.status)) {
            const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
            if (typeof data?.error === "string") msg = data.error;
          }
          update({ text: msg, status: "error" });
          setAnnounce(msg);
          return;
        }
        const source = res.headers.get("x-answer-source") === "ai" ? "ai" : "offline";
        update({ source });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          update({ text });
        }
        text += decoder.decode();
        const final = tidyAnswer(text) || GENERIC_ERROR;
        update({ text: final, status: "done" });
        setAnnounce(`Inkling: ${final}`);
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          update({ text: text ? `${tidyAnswer(text)} …` : "Stopped.", status: "done" });
        } else {
          update({ text: GENERIC_ERROR, status: "error" });
          setAnnounce(GENERIC_ERROR);
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    },
    [busy, messages, setMessages],
  );

  // A question handed over by openAssistant(question).
  useEffect(() => {
    if (!initialQuestion) return;
    const t = window.setTimeout(() => {
      onConsumeInitial();
      void ask(initialQuestion);
    }, 0);
    return () => clearTimeout(t);
  }, [initialQuestion, onConsumeInitial, ask]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    void ask(draft);
  };

  const remaining = CLIENT_HISTORY.maxMessageChars - draft.length;

  return (
    <>
      <motion.div
        aria-hidden="true"
        className="fixed inset-0 z-[60] bg-slate-900/20 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: motionTokens.duration.fast } }}
        onClick={onClose}
      />
      <motion.div
        ref={panelRef}
        id="ask-inkling"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onKeyDown={onKeyDown}
        className="fixed inset-x-0 top-3 bottom-0 z-[61] flex flex-col overflow-hidden rounded-t-[1.5rem] border border-line bg-desk shadow-[0_30px_80px_-20px_rgb(15_23_42/0.45)] sm:inset-x-auto sm:top-auto sm:right-6 sm:bottom-6 sm:h-[min(660px,calc(100dvh-3rem))] sm:w-[420px] sm:rounded-[1.5rem]"
        style={{ transformOrigin: "bottom right" }}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: motionTokens.distance.lg, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: motionTokens.distance.md, scale: 0.98, transition: { duration: motionTokens.duration.fast } }}
        transition={reduce ? { duration: 0 } : springs.gentle}
      >
        {/* Header strip */}
        <LiquidMetal css variant="pearl" speed={0.5} className="shrink-0 border-b border-line">
          <div className="flex items-center justify-between gap-3 px-5 py-4">
            <div className="min-w-0">
              <h2 id={titleId} className="flex items-center gap-2 text-[17px] font-semibold tracking-tight text-ink">
                <span aria-hidden="true" className="size-2 rounded-full bg-teal-500 shadow-[0_0_0_3px_rgb(20_184_166/0.2)]" />
                Ask Inkling
              </h2>
              <p id={descId} className="mt-0.5 text-[13px] text-ink-muted">
                Answers about Inkling, from Inkling&apos;s own facts.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close assistant"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-line bg-white/80 text-ink-muted transition-colors hover:bg-white hover:text-ink"
            >
              <CloseIcon size={18} />
            </button>
          </div>
        </LiquidMetal>

        {/* Conversation */}
        <div ref={listRef} className="flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-5">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col justify-end gap-4">
              <div className="rounded-2xl rounded-bl-md border border-line bg-white px-4 py-3 text-[15px] leading-relaxed text-ink shadow-[0_1px_2px_rgb(15_23_42/0.04)]">
                Hi! Ask me anything about Inkling: how it notices you&apos;re stuck, privacy, languages, Notability, or
                how to try it.
              </div>
              <div>
                <p className="mb-2 text-[12px] font-medium tracking-wide text-ink-subtle uppercase">Try asking</p>
                <ul className="flex flex-wrap gap-2">
                  {STARTER_QUESTIONS.map((q) => (
                    <li key={q}>
                      <button
                        type="button"
                        onClick={() => void ask(q)}
                        className="min-h-11 rounded-full border border-teal-600/25 bg-white px-4 text-left text-[14px] text-accent-press transition-colors hover:border-teal-600/50 hover:bg-accent-soft"
                      >
                        {q}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <ol className="flex flex-col gap-3" aria-label="Conversation">
              {messages.map((m) => (
                <motion.li
                  key={m.id}
                  className={m.role === "user" ? "flex justify-end" : "flex flex-col items-start"}
                  initial={reduce ? false : { opacity: 0, y: motionTokens.distance.sm }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: motionTokens.duration.normal, ease: motionTokens.easing.smooth }}
                >
                  {m.role === "user" ? (
                    <p className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-white">
                      <span className="sr-only">You: </span>
                      {m.text}
                    </p>
                  ) : (
                    <>
                      <div
                        data-role="assistant"
                        data-status={m.status}
                        className={`max-w-[92%] rounded-2xl rounded-bl-md border px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap shadow-[0_1px_2px_rgb(15_23_42/0.04)] ${
                          m.status === "error" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-line bg-white text-ink"
                        }`}
                      >
                        <span className="sr-only">Inkling: </span>
                        {m.text ? (
                          m.status === "streaming" ? tidyAnswer(m.text) : m.text
                        ) : (
                          <span aria-label="Inkling is typing" className="inline-flex items-center gap-1 py-1.5">
                            <span className="typing-dot size-1.5 rounded-full bg-ink-subtle" />
                            <span className="typing-dot size-1.5 rounded-full bg-ink-subtle" />
                            <span className="typing-dot size-1.5 rounded-full bg-ink-subtle" />
                          </span>
                        )}
                      </div>
                      {m.source === "offline" && m.status === "done" && (
                        <span className="mt-1.5 ml-1 text-[12px] text-ink-subtle" data-testid="offline-label">
                          Offline answer · from the FAQ
                        </span>
                      )}
                    </>
                  )}
                </motion.li>
              ))}
            </ol>
          )}
        </div>

        {/* Composer */}
        <form onSubmit={submit} className="shrink-0 border-t border-line bg-white px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4">
          <label htmlFor={inputId} className="sr-only">
            Ask a question about Inkling
          </label>
          <div className="flex items-end gap-2 rounded-2xl border border-line-strong bg-white p-1.5 pl-3.5 transition-[border-color,box-shadow] focus-within:border-teal-600 focus-within:shadow-[0_0_0_3px_rgb(20_184_166/0.15)]">
            <textarea
              ref={inputRef}
              id={inputId}
              rows={1}
              value={draft}
              maxLength={CLIENT_HISTORY.maxMessageChars}
              placeholder="Ask about Inkling…"
              aria-describedby={remaining < 80 ? `${inputId}-count` : undefined}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              className="max-h-32 min-h-11 flex-1 resize-none bg-transparent py-2.5 text-[16px] leading-snug text-ink outline-none placeholder:text-ink-subtle focus-visible:shadow-none [field-sizing:content]"
            />
            {busy ? (
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                aria-label="Stop answering"
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-ink text-white transition-colors hover:bg-slate-700"
              >
                <StopIcon size={16} />
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Send question"
                disabled={!draft.trim()}
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-teal-700 text-white transition-[background-color,opacity] hover:bg-teal-800 disabled:bg-slate-200 disabled:text-slate-500"
              >
                <SendIcon size={18} strokeWidth={2} />
              </button>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 px-1 pt-2 text-[12px] text-ink-subtle">
            <span>Answers can be imperfect. Enter to send, Shift+Enter for a new line.</span>
            {remaining < 80 && (
              <span id={`${inputId}-count`} className="shrink-0 tabular-nums">
                {remaining} left
              </span>
            )}
          </div>
        </form>

        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announce}
        </p>
      </motion.div>
    </>
  );
}
