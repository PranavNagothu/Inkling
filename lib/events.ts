// Client-safe shaping of stored events: the stored help card carries the check question's answer,
// so it never leaves the server with an event (the client asks POST /api/events/[id]/help instead).
import type { HelpCard, PublicHelpCard, TimelineEvent } from './types';

/** The event without its stored help card. */
export function toClientEvent(event: TimelineEvent): TimelineEvent {
  if (!event.help) return event;
  const rest = { ...event };
  delete rest.help;
  return rest;
}

export const toClientEvents = (events: TimelineEvent[]): TimelineEvent[] => events.map(toClientEvent);

/** The help card without the answer. */
export function publicHelp(help: HelpCard): PublicHelpCard {
  return {
    reexplain: help.reexplain,
    mcq: { q: help.mcq.q, options: [...help.mcq.options] },
    source: help.source ?? 'ai',
    provider: help.provider ?? 'unknown',
  };
}
