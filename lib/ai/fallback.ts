import "server-only";

// The safe card shown when a model's answer can't be used (invalid twice, timeout, provider down).
// Built only from the moment itself; stored with source 'fallback' and regenerated on next open.
import { cleanUntrusted } from './prompts';
import type { HelpCardCore, HelpContext } from './types';
import { truncateWords } from './validate';

export function fallbackHelpCard(ctx: HelpContext): HelpCardCore {
  const topic = cleanUntrusted(ctx.conceptLabel || 'this part of the lecture', 80);
  const said = truncateWords(cleanUntrusted(ctx.excerpt, 400), 30).replace(/…$/, '');
  const reexplain = truncateWords(
    `Let’s slow down on “${topic}”.${said ? ` The lecture said: “${said}…”.` : ''} Replay the 20 seconds below, then say the idea back in one sentence of your own. If you can’t, that sentence is exactly what to ask about.`,
    80,
  );
  return {
    reexplain,
    mcq: {
      q: 'What is the best next step for this part of the lecture?',
      options: [
        'Replay it and restate the idea in your own words',
        'Skip it, it probably won’t come up again',
        'Copy the notes again without replaying',
        'Wait until the exam to review it',
      ],
      answerIdx: 0,
      why: 'Restating an idea in your own words shows whether you really understood it; the other options only postpone the gap.',
    },
  };
}
