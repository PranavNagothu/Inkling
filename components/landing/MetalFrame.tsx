// A translucent white card inside a 1px liquid-metal (CSS path) frame: the metal reads as a fine
// pearly edge, the body stays white for legibility. Server-compatible wrapper; LiquidMetal is a client
// component rendered inside it.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { LiquidMetal, type LiquidMetalVariant } from "./ui/liquid-metal";

const RING_MASK: React.CSSProperties = {
  WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
  WebkitMaskComposite: "xor",
  mask: "linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)",
};

export function MetalFrame({
  children,
  className,
  innerClassName,
  variant = "teal",
  ringRadius,
}: {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
  variant?: LiquidMetalVariant;
  /** Radius class for the metal ring when the frame's radius isn't the default. */
  ringRadius?: string;
}) {
  return (
    <div className={cn("relative isolate rounded-[1.3rem] p-px shadow-card", className)}>
      {/* Only a 1px ring of metal is visible (masked), so translucent card bodies stay white. */}
      <LiquidMetal
        as="span"
        css
        variant={variant}
        speed={0.5}
        aria-hidden="true"
        className={cn("absolute inset-0 -z-10 rounded-[1.3rem] p-px", ringRadius)}
        style={RING_MASK}
      />
      <div className={cn("relative h-full rounded-[calc(1.3rem-1px)] bg-white/90 md:bg-white/80 md:backdrop-blur-md", innerClassName)}>
        {children}
      </div>
    </div>
  );
}
