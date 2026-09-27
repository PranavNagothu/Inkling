"use client";

// The one background for the whole page: a fixed, full-viewport pearl LiquidMetal (the page's
// single live WebGL surface) behind every section, pushed around by the pointer anywhere on the
// page, under a light white veil so text stays easy to read. Reduced motion / no WebGL2: the
// same pearl gradient, static (LiquidMetal's CSS path).
import { LiquidMetal } from "./ui/liquid-metal";

export function PageBackground() {
  return (
    <LiquidMetal
      data-page-bg=""
      aria-hidden="true"
      variant="pearl"
      speed={0.3}
      distortion={0.7}
      pointerTarget="window"
      maxFps={40}
      maxPixels={520_000}
      className="pointer-events-none fixed inset-0 -z-10"
    >
      <div className="absolute inset-0 bg-white/35" />
    </LiquidMetal>
  );
}
