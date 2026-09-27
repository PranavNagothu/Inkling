"use client";

// Quiet entrances for app content: opacity + a small rise, once, as it comes into view (the
// landing page's Reveal/Stagger, tuned shorter for a working app). Reduced motion: the same
// elements, shown instantly (one element type either way, so hydration never swaps the subtree).
// Never wrap the ink canvas in these — it must not sit inside a transformed container.
import type { ElementType, ReactNode } from "react";
import { motion, type Variants } from "motion/react";
import { motionTokens } from "@/lib/motion";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

const { duration, easing, distance } = motionTokens;

type PassThrough = Record<`data-${string}` | `aria-${string}`, string | undefined>;

export function Reveal({
  children,
  className,
  delay = 0,
  as = "div",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: "div" | "section" | "header" | "footer" | "nav";
} & PassThrough) {
  const reduce = usePrefersReducedMotion();
  const Comp = motion[as] as ElementType;
  return (
    <Comp
      className={className}
      initial={{ opacity: 0, y: distance.sm }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.1 }}
      transition={reduce ? { duration: 0 } : { duration: duration.normal + 0.1, delay, ease: easing.smooth }}
      {...rest}
    >
      {children}
    </Comp>
  );
}

const containerVariants: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05, delayChildren: 0.04 } },
};
const itemVariants: Variants = {
  hidden: { opacity: 0, y: distance.sm },
  visible: { opacity: 1, y: 0, transition: { duration: duration.normal, ease: easing.smooth } },
};
const itemVariantsReduced: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0 } },
};

/** A list whose children (StaggerItem) rise in one after another. */
export function Stagger({
  children,
  className,
  as = "div",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "ul" | "ol" | "dl";
} & PassThrough) {
  const Comp = motion[as] as ElementType;
  return (
    <Comp
      className={className}
      variants={containerVariants}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.05 }}
      {...rest}
    >
      {children}
    </Comp>
  );
}

export function StaggerItem({
  children,
  className,
  as = "div",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "li" | "article";
} & PassThrough) {
  const reduce = usePrefersReducedMotion();
  const Comp = motion[as] as ElementType;
  return (
    <Comp className={className} variants={reduce ? itemVariantsReduced : itemVariants} {...rest}>
      {children}
    </Comp>
  );
}
