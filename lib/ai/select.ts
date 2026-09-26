import "server-only";

// Which provider (if any) serves AI requests, read from the environment on every request so adding
// a key to .env.local takes effect without code changes:
//   DEMO_MODE=1         → 'demo': bundled fixtures + cache, offline fake for the rest; never the network
//   AI_PROVIDER=fake    → 'fake': deterministic, offline (tests)
//   AI_PROVIDER=openai|groq|gemini|grok → that provider (its key is required)
//   otherwise           → auto: OPENAI_API_KEY, then GROQ_API_KEY, then GEMINI_API_KEY, then XAI_API_KEY
// Groq (gsk_… keys) and xAI Grok (xai-… keys) are different companies: GROQ_API_KEY vs XAI_API_KEY.
// INKLING_DISABLE_AI=1 turns every network provider off (tests set it; 'fake' still works).
import { createCompatProvider, envKey, type CompatConfig, type Env } from './compat';
import { createFakeProvider } from './fake';
import { geminiConfig } from './gemini';
import { grokConfig } from './grok';
import { createGroqProvider, groqConfig, groqVisionConfig } from './groq';
import { openAiConfig } from './openai';
import type { AiMode, AiProvider, AiStatus, ProviderName } from './types';

// Client-safe types live in ./types (client components import them from there).
export type { AiMode, AiStatus } from './types';

export interface ProviderSelection {
  mode: AiMode;
  provider: AiProvider | null;
  /** Why this choice (for logs and the quiet "needs a key" note). */
  reason: string;
}

type NetworkProvider = Exclude<ProviderName, 'fake'>;

/** Auto-detect order (by available key). */
const AUTO_ORDER = ['openai', 'groq', 'gemini', 'grok'] as const satisfies readonly NetworkProvider[];

const KEY_VAR: Record<NetworkProvider, string> = {
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY',
  grok: 'XAI_API_KEY',
};

const CONFIG: Record<NetworkProvider, (env: Env) => CompatConfig | null> = {
  openai: openAiConfig,
  groq: groqConfig,
  gemini: geminiConfig,
  grok: grokConfig,
};

const truthy = (v: string | undefined) => !!v && /^(1|true|yes|on)$/i.test(v.trim());

export function selectProvider(env: Env = process.env, deps: { fetch?: typeof fetch } = {}): ProviderSelection {
  if (truthy(env.DEMO_MODE)) return { mode: 'demo', provider: createFakeProvider(), reason: 'DEMO_MODE=1 (fixtures, offline)' };
  const wanted = envKey(env, 'AI_PROVIDER')?.toLowerCase() ?? null;
  if (wanted === 'fake') return { mode: 'fake', provider: createFakeProvider(), reason: 'AI_PROVIDER=fake' };
  if (truthy(env.INKLING_DISABLE_AI)) return { mode: 'off', provider: null, reason: 'INKLING_DISABLE_AI=1' };

  const live = (name: NetworkProvider, cfg: CompatConfig): ProviderSelection => ({
    mode: 'live',
    provider: name === 'groq' ? groqProvider(env, cfg, deps.fetch) : createCompatProvider({ ...cfg, fetch: deps.fetch }),
    reason: `${name} (${cfg.model})`,
  });

  if (wanted) {
    if (!(wanted in CONFIG)) {
      return { mode: 'off', provider: null, reason: `AI_PROVIDER must be openai, groq, gemini, grok or fake (got "${wanted}")` };
    }
    const name = wanted as NetworkProvider;
    const cfg = CONFIG[name](env);
    return cfg ? live(name, cfg) : { mode: 'off', provider: null, reason: `AI_PROVIDER=${name} but ${KEY_VAR[name]} is not set` };
  }
  for (const name of AUTO_ORDER) {
    const cfg = CONFIG[name](env);
    if (cfg) return live(name, cfg);
  }
  return { mode: 'off', provider: null, reason: 'No AI key: add OPENAI_API_KEY (or GROQ_API_KEY / GEMINI_API_KEY / XAI_API_KEY) to .env.local' };
}

/**
 * Groq: text on GROQ_MODEL, handwriting on GROQ_VISION_MODEL; when Groq can't read images, the
 * next configured provider (in auto order) reads them instead.
 */
function groqProvider(env: Env, text: CompatConfig, fetchImpl: typeof fetch | undefined): AiProvider {
  const other = AUTO_ORDER.filter((n) => n !== 'groq')
    .map((n) => CONFIG[n](env))
    .find((c): c is CompatConfig => c !== null);
  return createGroqProvider(text, groqVisionConfig(env), {
    fetch: fetchImpl,
    visionFallback: other ? createCompatProvider({ ...other, fetch: fetchImpl }) : null,
  });
}

export function aiStatusFrom(sel: ProviderSelection): AiStatus {
  return {
    enabled: sel.provider !== null,
    mode: sel.mode,
    provider: sel.provider?.name ?? null,
    model: sel.provider?.model ?? null,
  };
}
