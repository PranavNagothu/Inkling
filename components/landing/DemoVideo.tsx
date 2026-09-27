"use client";

// The demo video with a "Play demo" pill in the poster's bottom-left corner (native controls take over once it
// starts). Click-to-play only — never autoplays — and only metadata is fetched until then.
import { useRef, useState, useSyncExternalStore } from "react";
import { PlayIcon } from "./icons";

const noop = () => () => {};

export function DemoVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  // The overlay only exists once hydrated, so without JS the plain native controls are all there is.
  const hydrated = useSyncExternalStore(noop, () => true, () => false);

  const play = () => {
    setStarted(true);
    const v = ref.current;
    if (!v) return;
    v.play().catch(() => setStarted(false));
    v.focus();
  };

  return (
    <div className="relative">
      <video
        ref={ref}
        className="block aspect-[8/5] w-full bg-black"
        // Native controls from the first play on (and always without JS); before that the overlay
        // is the one control, so the browser's own loading UI doesn't sit on the poster.
        controls={started || !hydrated}
        playsInline
        preload="metadata"
        poster="/inkling-demo-poster.jpg"
        width={1280}
        height={800}
        onPlay={() => setStarted(true)}
        // Clicking the poster plays too (the pill is the keyboard path).
        onClick={() => !started && hydrated && play()}
      >
        <source src="/inkling-demo.mp4" type="video/mp4" />
        {/* Captions are burned into the video; this track is optional (off by default). */}
        <track kind="captions" src="/inkling-demo.vtt" srcLang="en" label="English" />
        Your browser can&apos;t play this video. <a href="/inkling-demo.mp4">Download the demo (MP4)</a>.
      </video>

      {hydrated && !started && (
        <>
          {/* A soft scrim along the bottom edge only, so the poster itself stays clear. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-slate-950/45 via-slate-950/15 to-transparent"
          />
          <button
            type="button"
            onClick={play}
            className="group absolute bottom-3 left-3 inline-flex min-h-11 items-center gap-2.5 rounded-full bg-white/95 py-2 pr-4 pl-2 text-[14px] font-semibold text-ink shadow-[0_10px_30px_-10px_rgb(15_23_42/0.5)] ring-1 ring-black/5 backdrop-blur transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 active:scale-[0.97] sm:bottom-5 sm:left-5"
            aria-label="Play the demo video (2 minutes 59 seconds)"
          >
            <span className="inline-flex size-8 items-center justify-center rounded-full bg-teal-700 text-white">
              <PlayIcon size={13} />
            </span>
            Play demo
            <span className="font-mono text-[13px] font-normal text-ink-subtle">· 2:59</span>
          </button>
        </>
      )}
    </div>
  );
}
