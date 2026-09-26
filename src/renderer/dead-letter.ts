/**
 * Summarise why a batch of peeked messages was dead-lettered, and search them. Pure: no IPC, no
 * React. The header decoding itself lives in `src/common/dead-letter.ts` (shared with Main).
 */
import { deathReason, parseDeath } from "../common/dead-letter";

import type { PeekedMessageDto } from "../common/ipc";

export {
  DEATH_HEADER_KEYS,
  DEATH_REASON_TEXT,
  type DeathEntry,
  type DeathInfo,
  deathReason,
  parseDeath,
} from "../common/dead-letter";

export interface DeathSummary {
  total: number;
  deadLettered: number;
  /** Most frequent first. Counted per message by its most recent death. */
  byReason: { reason: string; messages: number }[];
  byQueue: { queue: string; messages: number }[];
}

function ranked(counts: Map<string, number>): [string, number][] {
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Why a batch of peeked messages failed: counts by reason and by the queue they died in. */
export function summarizeDeaths(messages: PeekedMessageDto[]): DeathSummary {
  const reasons = new Map<string, number>();
  const queues = new Map<string, number>();
  let deadLettered = 0;
  for (const m of messages) {
    const death = parseDeath(m);
    if (!death) continue;
    deadLettered += 1;
    const reason = deathReason(death);
    const queue = death.lastQueue ?? "unknown";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    queues.set(queue, (queues.get(queue) ?? 0) + 1);
  }
  return {
    total: messages.length,
    deadLettered,
    byReason: ranked(reasons).map(([reason, n]) => ({ reason, messages: n })),
    byQueue: ranked(queues).map(([queue, n]) => ({ queue, messages: n })),
  };
}

/**
 * Case-insensitive search over what an operator looks for in a failed message: payload (text
 * payloads only), routing key, exchange, and every property and header value.
 */
export function matchesMessage(message: PeekedMessageDto, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    message.payloadEncoding === "string" ? message.payload : "",
    message.routingKey,
    message.exchange,
    JSON.stringify(message.properties ?? {}),
  ];
  return haystack.some((text) => text.toLowerCase().includes(q));
}

/** Filter by the reason of the most recent death; "" keeps everything, "none" keeps messages never dead-lettered. */
export function matchesReason(message: PeekedMessageDto, reason: string): boolean {
  if (!reason) return true;
  const death = parseDeath(message);
  if (reason === "none") return !death;
  return death !== undefined && deathReason(death) === reason;
}
