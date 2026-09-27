// Small inline icon set (no dependency). All icons are decorative: pair them with visible text or aria-label.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const PenIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16.9 3.6a2 2 0 0 1 2.8 0l.7.7a2 2 0 0 1 0 2.8L8.6 18.9 4 20l1.1-4.6Z" />
    <path d="m14.5 6 3.5 3.5" />
  </Svg>
);

export const MicIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17.5V21" />
  </Svg>
);

export const EraserIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m7.5 20-4.1-4.1a2 2 0 0 1 0-2.8L13.1 3.4a2 2 0 0 1 2.8 0l4.7 4.7a2 2 0 0 1 0 2.8L11.5 20Z" />
    <path d="M20.5 20h-9" />
    <path d="m8.5 8 7.5 7.5" />
  </Svg>
);

export const UndoIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);

export const PlayIcon = (p: IconProps) => (
  <Svg {...p} fill="currentColor" stroke="none">
    {/* Nudged right 1px for optical centering. */}
    <path d="M8.5 5.2v13.6a1 1 0 0 0 1.53.85l10.6-6.8a1 1 0 0 0 0-1.7l-10.6-6.8a1 1 0 0 0-1.53.85Z" />
  </Svg>
);

export const PauseIcon = (p: IconProps) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <rect x="6" y="5" width="4" height="14" rx="1.2" />
    <rect x="14" y="5" width="4" height="14" rx="1.2" />
  </Svg>
);

/** A dashed stroke — Inkling's "ghost ink" glyph. */
export const GhostInkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 16c3-6 5.5-8 8-5s5 1 9-5" strokeDasharray="3.2 3" />
  </Svg>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m15 18-6-6 6-6" />
  </Svg>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9 18 6-6-6-6" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const ArrowRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);

/** Inkling mark: an ink drop resting on a dashed teal "ghost" rule. */
export function InklingMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={className}>
      <path
        d="M16 2.5c-1.2 3.6-8 9.6-8 15a8 8 0 0 0 16 0c0-5.4-6.8-11.4-8-15Z"
        fill="var(--color-ink)"
      />
      <path
        d="M12.4 18.2a3.8 3.8 0 0 0 3 3.9"
        fill="none"
        stroke="var(--color-paper)"
        strokeWidth="1.7"
        strokeLinecap="round"
        opacity=".75"
      />
      <path
        d="M3 29.5h26"
        fill="none"
        stroke="var(--color-ghost)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="3 3"
      />
    </svg>
  );
}

/** Lines of text — the transcript toggle. */
export const TranscriptIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6.5h16M4 11.5h16M4 16.5h10" />
  </Svg>
);

export const UploadIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9" />
    <path d="M4.5 15v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15" />
  </Svg>
);

/** Counter-clockwise arrow — replay. */
export const ReplayIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9" />
    <path d="M4.5 4.5V9H9" />
  </Svg>
);

export const StopIcon = (p: IconProps) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <rect x="6.5" y="6.5" width="11" height="11" rx="1.8" />
  </Svg>
);

export const VideoIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="6" width="13" height="12" rx="2.5" />
    <path d="m16 10.5 5-3v9l-5-3" />
  </Svg>
);

/** Two inward corners — shrink a floating panel. */
export const MinimizeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4v5H4M15 20v-5h5" />
  </Svg>
);

export const WaveIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 10v4M8 7v10M12 4.5v15M16 8v8M20 10.5v3" />
  </Svg>
);

export const CaptionsIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M7 11h4M13 11h4M7 15h7" />
  </Svg>
);

/** Two pages split by a divider — compare the final page with the process. */
export const CompareIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M12 3v18" />
    <path d="M6.5 9h3M6.5 12.5h3M14.5 9h3" strokeDasharray="1.6 1.6" />
  </Svg>
);

/** A page with a folded corner — a PDF document. */
export const DocumentIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3.5V8h4.5" />
    <path d="M8.5 13h7M8.5 16.5h4.5" />
  </Svg>
);

export const SpeakerIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 5 6 9H3v6h3l5 4Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M18.4 5.6a9 9 0 0 1 0 12.8" />
  </Svg>
);

export const SparkleIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5 13.8 9a1.5 1.5 0 0 0 1 1l5.7 2-5.7 2a1.5 1.5 0 0 0-1 1L12 20.5 10.2 15a1.5 1.5 0 0 0-1-1L3.5 12l5.7-2a1.5 1.5 0 0 0 1-1Z" />
  </Svg>
);
