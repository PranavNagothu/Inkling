"use client";

// Quiet entrances for section content as it scrolls into view (opacity + a small rise, once).
// Reduced motion: the same elements, shown instantly (one element type either way, so hydration
// never swaps the subtree).
import type { ElementType, ReactNode } from "react";
import { motion, type Variants } from "motion/react";
import { motionTokens } from "@/lib/motion";
import { usePrefersReducedMotion } from "../motion/usePrefersReducedMotion";

const { duration, easing, distance, stagger } = motionTokens;

export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const reduce = usePrefersReducedMotion();
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: distance.md }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={reduce ? { duration: 0 } : { duration: duration.slow, delay, ease: easing.smooth }}
    >
      {children}
    </motion.div>
  );
}

const containerVariants: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: stagger, delayChildren: 0.05 } },
};
const itemVariants: Variants = {
  hidden: { opacity: 0, y: distance.lg },
  visible: { opacity: 1, y: 0, transition: { duration: duration.slow, ease: easing.smooth } },
};
const itemVariantsReduced: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0 } },
};

/** A grid/list whose children (StaggerItem) rise in one after another. */
export function Stagger({
  children,
  className,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "ul" | "ol";
}) {
  const Comp = motion[as] as ElementType;
  return (
    <Comp
      className={className}
      variants={containerVariants}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.15 }}
    >
      {children}
    </Comp>
  );
}

export function StaggerItem({
  children,
  className,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "li" | "article";
}) {
  const reduce = usePrefersReducedMotion();
  const Comp = motion[as] as ElementType;
  return (
    <Comp className={className} variants={reduce ? itemVariantsReduced : itemVariants}>
      {children}
    </Comp>
  );
}
