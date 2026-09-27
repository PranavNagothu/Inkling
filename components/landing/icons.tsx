// Small inline icon set (no dependency, no third-party logos). Icons are decorative: always pair
// them with visible text or an aria-label on the control.
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
      strokeWidth={1.6}
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

/** Inkling mark: an ink drop resting on a dashed "ghost" rule (colours come from the theme tokens). */
export function InklingMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={className}>
      <path d="M16 2.5c-1.2 3.6-8 9.6-8 15a8 8 0 0 0 16 0c0-5.4-6.8-11.4-8-15Z" fill="var(--color-ink)" />
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

export const PlayIcon = (p: IconProps) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <path d="M8.5 5.2v13.6a1 1 0 0 0 1.53.85l10.6-6.8a1 1 0 0 0 0-1.7l-10.6-6.8a1 1 0 0 0-1.53.85Z" />
  </Svg>
);

export const PauseIcon = (p: IconProps) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <rect x="6" y="5" width="4" height="14" rx="1.2" />
    <rect x="14" y="5" width="4" height="14" rx="1.2" />
  </Svg>
);

export const ArrowUpRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 17 17 7M8 7h9v9" />
  </Svg>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9 18 6-6-6-6" />
  </Svg>
);

export const MenuIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const PenIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16.9 3.6a2 2 0 0 1 2.8 0l.7.7a2 2 0 0 1 0 2.8L8.6 18.9 4 20l1.1-4.6Z" />
    <path d="m14.5 6 3.5 3.5" />
  </Svg>
);

/** Pause-vs-baseline: a waveform with a flat stretch. */
export const SignalIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12h2.5l1.5-4 2 8 1.5-4H14" />
    <path d="M14 12h7" strokeDasharray="2 2.4" />
  </Svg>
);

/** A lightbulb-ish spark: the re-explanation. */
export const SparkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v2M5.6 5.6 7 7M3 12h2M19 12h2M17 7l1.4-1.4" />
    <path d="M9 17.5h6M10 21h4" />
    <path d="M8.5 14.5a5 5 0 1 1 7 0c-.8.8-1 1.6-1 3h-5c0-1.4-.2-2.2-1-3Z" />
  </Svg>
);

/** A dashed stroke — Inkling's "ghost ink" glyph. */
export const GhostInkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 16c3-6 5.5-8 8-5s5 1 9-5" strokeDasharray="3.2 3" />
  </Svg>
);

export const TimelineIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12h18" />
    <circle cx="7" cy="12" r="2" fill="var(--color-paper)" />
    <path d="m13 10 2 2-2 2-2-2Z" fill="var(--color-paper)" />
    <circle cx="19" cy="12" r="1.2" />
  </Svg>
);

export const FlaskIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 3h5M10.5 3v6L5 18.5A1.7 1.7 0 0 0 6.5 21h11a1.7 1.7 0 0 0 1.5-2.5L13.5 9V3" />
    <path d="M7.5 15h9" />
  </Svg>
);

export const GlobeVoiceIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="12" r="7" />
    <path d="M3 12h14M10 5c2 2.2 2.8 4.5 2.8 7s-.8 4.8-2.8 7c-2-2.2-2.8-4.5-2.8-7S8 7.2 10 5Z" />
    <path d="M19.5 9.5c.7.7 1 1.5 1 2.5s-.3 1.8-1 2.5" />
  </Svg>
);

export const ClassIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.6" />
    <circle cx="16.5" cy="9" r="2.1" />
    <path d="M3.5 18.5c.6-3 2.3-4.6 4.5-4.6s3.9 1.6 4.5 4.6M13.5 14.2c.9-.5 1.9-.7 3-.7 2 0 3.4 1.5 4 4" />
  </Svg>
);

export const CompareIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4" width="17" height="16" rx="1.5" />
    <path d="M12 4v16" />
    <path d="M6.5 9h3M6.5 12h3M14.5 9h3" />
    <path d="M14.5 12h3" strokeDasharray="1.6 1.6" />
  </Svg>
);

export const StudentIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m2.5 9 9.5-4.5L21.5 9 12 13.5Z" />
    <path d="M6.5 11v4.5c1.6 1.5 3.4 2.2 5.5 2.2s3.9-.7 5.5-2.2V11" />
    <path d="M21.5 9v5" />
  </Svg>
);

export const TeacherIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M7 12l3-3 2.5 2L17 7.5" />
    <path d="M9 20h6M12 16v4" />
  </Svg>
);

export const ChatIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.1A8 8 0 1 1 20 12Z" />
    <path d="M8.5 11h.01M12 11h.01M15.5 11h.01" strokeWidth={2.4} />
  </Svg>
);

export const SendIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
  </Svg>
);

export const StopIcon = (p: IconProps) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <rect x="7" y="7" width="10" height="10" rx="2" />
  </Svg>
);

export const EraserIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m7.5 20-4-4a2 2 0 0 1 0-2.8l9.8-9.8a2 2 0 0 1 2.8 0l4.2 4.2a2 2 0 0 1 0 2.8L12.5 20Z" />
    <path d="M20 20H7.5M8.6 8.1l7.3 7.3" />
  </Svg>
);

export const ResetIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.6" />
    <path d="M4 4v4.6h4.6" />
  </Svg>
);

export const EyeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </Svg>
);

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const HardDriveIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M5.5 13 8 5h8l2.5 8M7 16.5h.01M10.5 16.5h.01" />
  </Svg>
);

export const ShieldIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Svg>
);

export const KeyIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="m10.8 12.2 8.7-8.7M16.5 6.5l2.5 2.5M14 9l2 2" />
  </Svg>
);

export const WifiOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 3l18 18M8.5 16.2a5 5 0 0 1 7 0M5 12.6a10 10 0 0 1 4.4-2.5M19 12.6a10 10 0 0 0-2.4-1.7M2 9a15 15 0 0 1 4.3-2.8M22 9a15 15 0 0 0-10-3.8" />
    <path d="M12 20h.01" strokeWidth={2.4} />
  </Svg>
);
