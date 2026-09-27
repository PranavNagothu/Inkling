"use client";

// A small accessible radio group (WAI-ARIA APG): role="radiogroup" with role="radio" buttons,
// aria-checked, roving tabindex (only the checked option is in the tab order) and Arrow/Home/End
// keys that move and select. Options render their own visuals; every target is ≥ 44px.
import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface RadioOption<T extends string> {
  value: T;
  /** Accessible name. */
  label: string;
  /** Visual content (defaults to the label). */
  children?: ReactNode;
  /** Language/direction of the label, for multilingual options. */
  lang?: string;
  dir?: "rtl" | "ltr";
}

export function RadioGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
  optionClassName,
  disabled = false,
}: {
  label: string;
  options: RadioOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  className?: string;
  optionClassName?: (checked: boolean, value: T) => string;
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = options.findIndex((o) => o.value === value);
  const focusable = index === -1 ? 0 : index;

  const move = (to: number) => {
    const n = options.length;
    const i = (to + n) % n;
    onChange(options[i].value);
    refs.current[i]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={label} className={cn("flex items-center", className)}>
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={o.children ? o.label : undefined}
            lang={o.lang}
            dir={o.dir}
            tabIndex={i === focusable ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const k = e.key;
              if (k === "ArrowRight" || k === "ArrowDown") move(i + 1);
              else if (k === "ArrowLeft" || k === "ArrowUp") move(i - 1);
              else if (k === "Home") move(0);
              else if (k === "End") move(options.length - 1);
              else return;
              e.preventDefault();
            }}
            className={cn(
              "inline-flex min-h-11 min-w-11 items-center justify-center rounded-full transition-[background-color,color,box-shadow] duration-200 disabled:opacity-50",
              optionClassName?.(checked, o.value),
            )}
          >
            {o.children ?? o.label}
          </button>
        );
      })}
    </div>
  );
}
