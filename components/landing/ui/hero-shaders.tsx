"use client";

// The hero's Paper Shaders orb (PulsingBorder), split out so it is code-split and only ever loaded
// in the browser (see the `dynamic(..., { ssr: false })` import in hero.tsx) — and only when WebGL2
// exists. Re-coloured teal for the light paper theme. Paper Shaders stop their rAF loop while the
// canvas is off screen or the tab is hidden; `animate=false` (reduced motion, or the hero
// scrolled away) additionally sets speed to 0.

import { PulsingBorder } from "@paper-design/shaders-react";

export function HeroPulse({ animate }: { animate: boolean }) {
  return (
    <PulsingBorder
      colors={["#0d9488", "#14b8a6", "#2dd4bf", "#0891b2", "#5eead4", "#0f766e"]}
      colorBack="#00000000"
      speed={animate ? 1.2 : 0}
      roundness={1}
      thickness={0.1}
      softness={0.25}
      intensity={3}
      spots={5}
      spotSize={0.1}
      pulse={0.1}
      smoke={0.4}
      smokeSize={4}
      scale={0.65}
      rotation={0}
      frame={9161408.251009725}
      style={{ width: "60px", height: "60px", borderRadius: "50%" }}
    />
  );
}
