"use client";

// Magnetic wrapper: the child drifts a little toward the pointer while it's over it and springs
// back on leave. Transform only; off for touch/coarse pointers and reduced motion.
import type { ReactNode } from "react";
import { motion, useMotionValue, useSpring } from "motion/react";
import { springs } from "@/lib/motion";
import { useFinePointer } from "./usePointerCapabilities";
import { usePrefersReducedMotion } from "../motion/usePrefersReducedMotion";

export function Magnetic({
  children,
  strength = 0.28,
  className = "",
}: {
  children: ReactNode;
  strength?: number;
  className?: string;
}) {
  const fine = useFinePointer();
  const reduce = usePrefersReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, springs.follow);
  const sy = useSpring(y, springs.follow);
  const on = fine && !reduce;

  return (
    <motion.span
      className={`inline-flex ${className}`}
      style={{ x: sx, y: sy }}
      onPointerMove={(e) => {
        if (!on || e.pointerType !== "mouse") return;
        const r = e.currentTarget.getBoundingClientRect();
        x.set((e.clientX - (r.left + r.width / 2)) * strength);
        y.set((e.clientY - (r.top + r.height / 2)) * strength);
      }}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
    >
      {children}
    </motion.span>
  );
}
