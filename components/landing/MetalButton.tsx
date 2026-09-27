"use client";

// The primary call-to-action: a rounded pill with a light teal LiquidMetal surface (CSS path — no
// WebGL for small elements), dark teal label, magnetic hover, and the global focus ring.
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Magnetic } from "./Magnetic";
import { LiquidMetal } from "./ui/liquid-metal";

const SIZES = {
  sm: "min-h-10 px-4 text-[13px] gap-1.5",
  md: "min-h-11 px-5 text-[14px] gap-2",
  lg: "min-h-12 px-7 text-[15px] gap-2",
} as const;

export function MetalLink({
  children,
  className,
  size = "lg",
  magnetic = true,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode; size?: keyof typeof SIZES; magnetic?: boolean }) {
  const link = (
    <a
      className={cn(
        "group relative isolate inline-flex items-center justify-center overflow-hidden rounded-full font-semibold whitespace-nowrap text-teal-950",
        "shadow-[0_1px_0_rgb(255_255_255/0.7)_inset,0_10px_24px_-12px_rgb(13_148_136/0.75)] ring-1 ring-teal-700/25",
        "transition-[box-shadow,transform] duration-200 ease-out hover:shadow-[0_1px_0_rgb(255_255_255/0.7)_inset,0_16px_32px_-12px_rgb(13_148_136/0.85)] hover:ring-teal-700/40 active:scale-[0.97]",
        SIZES[size],
        className,
      )}
      {...rest}
    >
      <LiquidMetal as="span" css variant="teal" speed={0.8} aria-hidden="true" className="absolute inset-0 -z-10 rounded-full" />
      {children}
    </a>
  );
  return magnetic ? <Magnetic>{link}</Magnetic> : link;
}
