"use client";

/*
 * LiquidMetal — a flowing "liquid metal" surface: a WebGL2 fragment shader (fbm domain warping,
 * banded reflections, a specular glint and a tint), pushed around by the pointer.
 *
 * Variants: chrome · gold · mercury · oil (iridescent) and, for Inkling's light paper theme,
 * pearl (soft pearly paper-silk, the default) and teal (a light seafoam pearl for accents).
 *
 * Render paths
 *  - WebGL2 canvas: large surfaces (the hero). Pauses while off screen (IntersectionObserver),
 *    while the tab is hidden and when `paused`. At most MAX_LIVE_GL instances run at once; any
 *    more fall back to CSS automatically (browsers cap WebGL contexts at ~16 and several live
 *    canvases drain batteries).
 *  - CSS: `css` forces it (buttons, chips, borders), and it's what you get with no WebGL2, after
 *    a lost context, or with reduced motion. A conic/linear gradient surface whose
 *    background-position sweeps slowly; static under reduced motion.
 *  - maskText: renders that text filled with the variant's TEXT_SURFACE gradient (background-clip:
 *    text) — real, selectable text; the text gradients are dark enough for AA on paper.
 *
 * SSR renders the CSS surface (reduced-motion styles come from a hydration-safe hook); the canvas mounts after hydration and fades in on its first frame.
 */

import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "../../motion/usePrefersReducedMotion";

export type LiquidMetalVariant = "chrome" | "gold" | "mercury" | "oil" | "pearl" | "teal";

export interface LiquidMetalProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  children?: ReactNode;
  className?: string;
  /** Domain-warp strength (0.2–2). */
  distortion?: number;
  /** Render this text filled with the metal instead of a surface. */
  maskText?: string;
  /** Freeze the animation. */
  paused?: boolean;
  /** How strongly the pointer pushes the surface (true = 1, false = 0). */
  pointerInfluence?: number | boolean;
  /** Animation speed multiplier. */
  speed?: number;
  variant?: LiquidMetalVariant;
  /** Force the CSS gradient path (no WebGL) — for small elements. */
  css?: boolean;
  /** Element to render (a span for inline use inside buttons/text). */
  as?: "div" | "span";
  /**
   * Where pointer movement is read from: the element itself (default), or the whole window — for
   * a page background that sits behind content (its own listener would never fire).
   */
  pointerTarget?: "self" | "window";
  /** Frame-rate cap for the WebGL loop (a slow background doesn't need 60 fps). */
  maxFps?: number;
  /** Drawing-buffer pixel budget (the surface is upscaled by the browser). */
  maxPixels?: number;
}

interface Palette {
  lo: [number, number, number];
  hi: [number, number, number];
  tint: [number, number, number];
  tintMix: number;
  spec: number;
  oil?: boolean;
}

const PALETTES: Record<LiquidMetalVariant, Palette> = {
  chrome: { lo: [0.06, 0.07, 0.08], hi: [0.96, 0.97, 0.99], tint: [0.55, 0.6, 0.7], tintMix: 0.15, spec: 1.0 },
  gold: { lo: [0.22, 0.13, 0.03], hi: [1.0, 0.9, 0.58], tint: [0.95, 0.68, 0.28], tintMix: 0.3, spec: 0.9 },
  mercury: { lo: [0.18, 0.2, 0.23], hi: [0.9, 0.92, 0.95], tint: [0.62, 0.67, 0.72], tintMix: 0.12, spec: 1.0 },
  oil: { lo: [0.04, 0.04, 0.06], hi: [0.7, 0.72, 0.78], tint: [0.4, 0.3, 0.6], tintMix: 0.2, spec: 0.8, oil: true },
  pearl: { lo: [0.93, 0.95, 0.96], hi: [1.0, 1.0, 1.0], tint: [0.6, 0.86, 0.82], tintMix: 0.35, spec: 0.35 },
  teal: { lo: [0.8, 0.95, 0.93], hi: [0.97, 1.0, 0.99], tint: [0.45, 0.85, 0.8], tintMix: 0.45, spec: 0.3 },
};

/** CSS stand-in surfaces (no WebGL2, reduced motion, or `css`). */
export const FALLBACK_SURFACE: Record<LiquidMetalVariant, string> = {
  chrome:
    "conic-gradient(from 210deg at 50% 50%, #0b0d10, #e9edf2, #5b6470, #f8fafc, #1e242c, #cfd6de, #0b0d10)",
  gold: "conic-gradient(from 200deg at 50% 50%, #3a2206, #ffe7a3, #9c6a1c, #fff4cf, #5a3a0c, #f2c25c, #3a2206)",
  mercury:
    "conic-gradient(from 200deg at 50% 50%, #2b3038, #e6e9ee, #7d8590, #f5f7fa, #444b55, #c9ced6, #2b3038)",
  oil: "conic-gradient(from 180deg at 50% 50%, #0b0a12, #3b2f7a, #1f8a8a, #d6b85a, #8a2f6a, #2b3f9a, #0b0a12)",
  pearl:
    "radial-gradient(60% 80% at 20% 20%, rgb(255 255 255 / 0.95), transparent 60%), conic-gradient(from 200deg at 55% 45%, #eef2f4, #ffffff, #d7efeb, #f7f9fa, #e3f3f0, #ffffff, #e9eef1, #eef2f4)",
  teal: "radial-gradient(70% 90% at 25% 15%, rgb(255 255 255 / 0.9), transparent 60%), conic-gradient(from 210deg at 50% 50%, #ccfbf1, #f0fdfa, #99f6e4, #ecfeff, #a7f3d0, #f0fdfa, #ccfbf1)",
};

/** Text fills: dark enough stops to stay AA-legible on paper (large text ≥ 3:1, body ≥ 4.5:1). */
export const TEXT_SURFACE: Record<LiquidMetalVariant, string> = {
  chrome: "linear-gradient(100deg, #111827, #6b7280 25%, #111827 45%, #4b5563 70%, #111827)",
  gold: "linear-gradient(100deg, #78350f, #b45309 25%, #713f12 45%, #a16207 70%, #78350f)",
  mercury: "linear-gradient(100deg, #1f2937, #64748b 25%, #1f2937 45%, #475569 70%, #1f2937)",
  oil: "linear-gradient(100deg, #312e81, #0f766e 25%, #6b21a8 50%, #0e7490 75%, #312e81)",
  pearl: "linear-gradient(100deg, #0f172a, #0f766e 22%, #134e4a 42%, #0d9488 62%, #1e293b 82%, #0f172a)",
  teal: "linear-gradient(100deg, #134e4a, #115e59 25%, #0f4f4a 45%, #115e59 65%, #134e4a)", // every stop ≥ 5.5:1 even on the tinted background: safe for small text
};

/* ───────────── WebGL ───────────── */

const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_pointer;
uniform float u_push;
uniform float u_distortion;
uniform vec3 u_lo;
uniform vec3 u_hi;
uniform vec3 u_tint;
uniform float u_tintMix;
uniform float u_spec;
uniform float u_oil;
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float s = min(u_res.x, u_res.y);
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / s;
  vec2 ptr = (u_pointer - 0.5) * u_res / s;

  // Pointer push: displace the domain away from the pointer, falling off with distance.
  vec2 d = p - ptr;
  float fall = exp(-dot(d, d) * 5.0);
  p += normalize(d + 1e-4) * fall * u_push * 0.22;

  float t = u_time;
  vec2 b = p * 1.35;
  vec2 q = vec2(fbm(b + vec2(0.0, t * 0.12)), fbm(b + vec2(5.2, 1.3) - t * 0.10));
  vec2 r = vec2(
    fbm(b + u_distortion * 3.0 * q + vec2(1.7, 9.2) + t * 0.15),
    fbm(b + u_distortion * 3.0 * q + vec2(8.3, 2.8) - t * 0.126)
  );
  float f = fbm(b + u_distortion * 3.0 * r);

  // Banded reflections, like a polished surface catching a studio light.
  float bands = 0.5 + 0.5 * cos(6.2831 * (f * 1.6 + r.x * 0.6 + q.y * 0.3));
  vec3 col = mix(u_lo, u_hi, smoothstep(0.08, 0.95, bands));
  col += pow(clamp(bands, 0.0, 1.0), 18.0) * u_spec;
  col = mix(col, u_tint, u_tintMix * smoothstep(0.35, 1.0, length(q)));

  if (u_oil > 0.5) {
    vec3 irid = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + f * 1.5 + t * 0.05));
    col = mix(col, irid, 0.55);
  }

  // A whisper of vignette.
  col *= mix(1.0, 0.965, smoothstep(0.45, 1.1, length(uv - 0.5) * 1.4));
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

/** Live WebGL instances right now (module-wide budget). */
let liveGL = 0;
export const MAX_LIVE_GL = 3;

let gl2Supported: boolean | undefined;
function supportsWebGL2(): boolean {
  if (gl2Supported !== undefined) return gl2Supported;
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    gl2Supported = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    gl2Supported = false;
  }
  return gl2Supported;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/** Soft surfaces don't need full resolution: cap the drawing buffer. */
const MAX_PIXELS = 700_000;

export function LiquidMetal({
  children,
  className,
  distortion = 1,
  maskText,
  paused = false,
  pointerInfluence = 1,
  speed = 1,
  variant = "pearl",
  css = false,
  as = "div",
  pointerTarget = "self",
  maxFps = 60,
  maxPixels = MAX_PIXELS,
  style,
  ...rest
}: LiquidMetalProps) {
  // motion's hook drives the render path (effects only); the hydration-safe hook drives render-time
  // styles, so the server HTML and the first client render always match.
  const reduce = useReducedMotion();
  const reduceStyles = usePrefersReducedMotion();
  const rootRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gl, setGl] = useState(false);
  const [ready, setReady] = useState(false);
  const pausedRef = useRef(paused);
  const pointer = useRef({ x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, push: 0 });
  const influence = typeof pointerInfluence === "boolean" ? (pointerInfluence ? 1 : 0) : pointerInfluence;

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // Decide the render path after hydration (the server always renders the CSS surface).
  const wantGL = !css && !maskText && !reduce;
  useEffect(() => {
    if (!wantGL || !supportsWebGL2() || liveGL >= MAX_LIVE_GL) return;
    liveGL += 1;
    const id = requestAnimationFrame(() => setGl(true));
    return () => {
      cancelAnimationFrame(id);
      liveGL -= 1;
      setGl(false);
      setReady(false);
    };
  }, [wantGL]);

  // The WebGL loop.
  useEffect(() => {
    if (!gl) return;
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return;
    const ctx = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "low-power", preserveDrawingBuffer: false });
    if (!ctx) {
      setGl(false);
      return;
    }
    const vs = compile(ctx, ctx.VERTEX_SHADER, VERT);
    const fs = compile(ctx, ctx.FRAGMENT_SHADER, FRAG);
    const prog = ctx.createProgram();
    if (!vs || !fs || !prog) {
      setGl(false);
      return;
    }
    ctx.attachShader(prog, vs);
    ctx.attachShader(prog, fs);
    ctx.linkProgram(prog);
    if (!ctx.getProgramParameter(prog, ctx.LINK_STATUS)) {
      setGl(false);
      return;
    }
    ctx.useProgram(prog);
    const buf = ctx.createBuffer();
    ctx.bindBuffer(ctx.ARRAY_BUFFER, buf);
    // One oversized triangle covers the viewport.
    ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), ctx.STATIC_DRAW);
    const loc = ctx.getAttribLocation(prog, "a_pos");
    ctx.enableVertexAttribArray(loc);
    ctx.vertexAttribPointer(loc, 2, ctx.FLOAT, false, 0, 0);

    const u = (n: string) => ctx.getUniformLocation(prog, n);
    const uRes = u("u_res");
    const uTime = u("u_time");
    const uPointer = u("u_pointer");
    const uPush = u("u_push");
    const pal = PALETTES[variant];
    ctx.uniform1f(u("u_distortion"), distortion);
    ctx.uniform3fv(u("u_lo"), pal.lo);
    ctx.uniform3fv(u("u_hi"), pal.hi);
    ctx.uniform3fv(u("u_tint"), pal.tint);
    ctx.uniform1f(u("u_tintMix"), pal.tintMix);
    ctx.uniform1f(u("u_spec"), pal.spec);
    ctx.uniform1f(u("u_oil"), pal.oil ? 1 : 0);

    const resize = () => {
      const w = Math.max(1, root.clientWidth);
      const h = Math.max(1, root.clientHeight);
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const scale = Math.min(dpr, Math.sqrt(maxPixels / (w * h)));
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      ctx.viewport(0, 0, canvas.width, canvas.height);
      ctx.uniform2f(uRes, canvas.width, canvas.height);
    };
    resize();
    const ro = new ResizeObserver(() => {
      resize();
      if (!running) render(); // keep a paused surface sharp after a resize
    });
    ro.observe(root);

    let visible = true;
    let running = false;
    let raf = 0;
    let last = performance.now();
    let t = 3.7; // start mid-flow, not at the noise origin
    let first = true;

    const render = () => {
      const pt = pointer.current;
      pt.x += (pt.tx - pt.x) * 0.08;
      pt.y += (pt.ty - pt.y) * 0.08;
      pt.push *= 0.94;
      ctx.uniform1f(uTime, t);
      ctx.uniform2f(uPointer, pt.x, pt.y);
      ctx.uniform1f(uPush, pt.push);
      ctx.drawArrays(ctx.TRIANGLES, 0, 3);
      if (first) {
        first = false;
        setReady(true);
      }
    };
    const minFrame = 1000 / Math.max(1, maxFps);
    const loop = (now: number) => {
      if (now - last < minFrame - 1) {
        raf = requestAnimationFrame(loop);
        return;
      }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      t += dt * speed;
      render();
      raf = requestAnimationFrame(loop);
    };
    const update = () => {
      const shouldRun = visible && !document.hidden && !pausedRef.current;
      if (shouldRun && !running) {
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(loop);
      } else if (!shouldRun && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
    };
    render();

    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      update();
    });
    io.observe(root);
    const onVis = () => update();
    document.addEventListener("visibilitychange", onVis);
    const poll = window.setInterval(update, 250); // picks up `paused` changes without re-creating GL

    const onMove = (e: PointerEvent) => {
      if (!influence) return;
      const r = root.getBoundingClientRect();
      const pt = pointer.current;
      const nx = (e.clientX - r.left) / r.width;
      const ny = 1 - (e.clientY - r.top) / r.height;
      const v = Math.hypot(nx - pt.tx, ny - pt.ty);
      pt.tx = nx;
      pt.ty = ny;
      pt.push = Math.min(1, pt.push + v * 6 * influence);
    };
    const pointerSource: HTMLElement | Window = pointerTarget === "window" ? window : root;
    pointerSource.addEventListener("pointermove", onMove as EventListener, { passive: true });

    const onLost = (e: Event) => {
      e.preventDefault();
      setGl(false);
    };
    canvas.addEventListener("webglcontextlost", onLost);

    return () => {
      cancelAnimationFrame(raf);
      running = false;
      io.disconnect();
      ro.disconnect();
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVis);
      pointerSource.removeEventListener("pointermove", onMove as EventListener);
      canvas.removeEventListener("webglcontextlost", onLost);
      ctx.deleteBuffer(buf);
      ctx.deleteProgram(prog);
      ctx.deleteShader(vs);
      ctx.deleteShader(fs);
      ctx.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [gl, variant, distortion, speed, influence, pointerTarget, maxFps, maxPixels]);

  const animateCss = !reduceStyles && !paused;

  if (maskText) {
    const textStyle: CSSProperties = {
      backgroundImage: TEXT_SURFACE[variant],
      backgroundSize: "200% 100%",
      WebkitBackgroundClip: "text",
      backgroundClip: "text",
      WebkitTextFillColor: "transparent",
      color: "transparent",
      animation: animateCss ? `metal-sweep ${Math.max(4, 9 / Math.max(0.1, speed))}s ease-in-out infinite alternate` : undefined,
      ...style,
    };
    return (
      <span
        ref={rootRef as React.Ref<HTMLSpanElement>}
        data-liquid-metal="text"
        className={cn("inline-block", className)}
        style={textStyle}
        {...rest}
      >
        {maskText}
      </span>
    );
  }

  const Comp = as;
  const surfaceStyle: CSSProperties = {
    backgroundImage: FALLBACK_SURFACE[variant],
    backgroundSize: "220% 220%",
    backgroundPosition: "0% 50%",
    backgroundRepeat: "no-repeat",
    animation: animateCss ? `metal-sweep ${Math.max(6, 14 / Math.max(0.1, speed))}s ease-in-out infinite alternate` : undefined,
  };

  return (
    <Comp
      ref={rootRef as React.Ref<HTMLDivElement & HTMLSpanElement>}
      data-liquid-metal={gl ? "webgl" : "css"}
      className={cn("relative isolate overflow-hidden", variant === "pearl" || variant === "teal" ? "bg-[#f4f7f8]" : "bg-neutral-900", className)}
      style={style}
      {...rest}
    >
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 block" style={surfaceStyle} />
      {gl && (
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 -z-10 block h-full w-full transition-opacity duration-700",
            ready ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      {children}
    </Comp>
  );
}

export default LiquidMetal;
