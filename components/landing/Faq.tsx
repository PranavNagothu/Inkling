"use client";

// FAQ accordion (WAI-ARIA APG pattern): buttons with aria-expanded/aria-controls, regions
// labelled by their buttons; ArrowUp/ArrowDown/Home/End move between headers. Answers stay in the
// DOM (hidden when closed) so they're server-rendered and findable. Same knowledge base as the
// assistant.
import { useId, useRef, useState } from "react";
import { motion } from "motion/react";
import { FAQ_ENTRIES } from "@/lib/landing/knowledge";
import { motionTokens } from "@/lib/motion";
import { openAssistant } from "./site";
import { ChatIcon, PlusIcon } from "./icons";
import { usePrefersReducedMotion } from "../motion/usePrefersReducedMotion";

export function Faq() {
  const [open, setOpen] = useState<string | null>(FAQ_ENTRIES[0]?.id ?? null);
  const base = useId();
  const reduce = usePrefersReducedMotion();
  // Server HTML shows the first answer as-is; only answers opened later fade in.
  const [touched, setTouched] = useState(false);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const n = FAQ_ENTRIES.length;
    const to =
      e.key === "ArrowDown" ? (i + 1) % n : e.key === "ArrowUp" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to === -1) return;
    e.preventDefault();
    buttons.current[to]?.focus();
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] lg:gap-14">
      <div className="lg:sticky lg:top-[calc(var(--nav-h)+2rem)] lg:self-start">
        <p className="text-[16px] leading-relaxed text-pretty text-ink-muted">
          Short answers to what people ask most. Something else on your mind? The assistant answers from the same facts.
        </p>
        <button
          type="button"
          onClick={() => openAssistant()}
          className="btn btn-secondary mt-6"
        >
          <ChatIcon size={17} />
          Ask Inkling
        </button>
      </div>

      <div className="card divide-y divide-line overflow-hidden p-0">
        {FAQ_ENTRIES.map((e, i) => {
          const isOpen = open === e.id;
          const btnId = `${base}-q-${e.id}`;
          const panelId = `${base}-a-${e.id}`;
          return (
            <div key={e.id}>
              <h3>
                <button
                  ref={(el) => {
                    buttons.current[i] = el;
                  }}
                  id={btnId}
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => {
                    setTouched(true);
                    setOpen(isOpen ? null : e.id);
                  }}
                  onKeyDown={(ev) => onKeyDown(ev, i)}
                  className="flex min-h-16 w-full items-center justify-between gap-6 px-5 py-4 text-left text-[16.5px] font-semibold tracking-tight text-ink transition-colors hover:bg-chrome-hover sm:px-7"
                >
                  {e.question}
                  <span
                    aria-hidden="true"
                    className={`inline-flex size-8 shrink-0 items-center justify-center rounded-full border transition-[transform,background-color,border-color,color] duration-300 ${
                      isOpen ? "rotate-45 border-teal-600/30 bg-accent-soft text-accent-strong" : "border-line text-ink-subtle"
                    }`}
                  >
                    <PlusIcon size={16} />
                  </span>
                </button>
              </h3>
              <div id={panelId} role="region" aria-labelledby={btnId} hidden={!isOpen}>
                <motion.p
                  key={isOpen ? "open" : "closed"}
                  className="max-w-[65ch] px-5 pb-6 text-[15.5px] leading-relaxed text-pretty text-ink-muted sm:px-7"
                  initial={touched && !reduce ? { opacity: 0, y: -motionTokens.distance.xs } : false}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: motionTokens.duration.normal, ease: motionTokens.easing.smooth }}
                >
                  {e.answer}
                </motion.p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
