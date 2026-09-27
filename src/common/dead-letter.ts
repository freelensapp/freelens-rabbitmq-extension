/**
 * Decode RabbitMQ dead-letter headers (`x-death`, `x-first-death-*`). Shared by the renderer (the
 * Message Inspector) and Main (replay computes destinations itself). Pure: no IPC, no React.
 *
 * Shape as returned by the Management API (verified on RabbitMQ 4.3.5): `x-death` is a list, most
 * recent death first, one entry per (queue, reason) with `count`, `exchange`, `queue`, `reason`,
 * `routing-keys` (list) and `time` in seconds since the epoch.
 */
/** Anything carrying AMQP properties as the Management API returns them (`[]` when there are none). */
export interface WithProperties {
  properties: Record<string, unknown> | unknown[];
}

export interface DeathEntry {
  queue: string;
  reason: string;
  count: number;
  /** Exchange and routing keys the message had when it died in `queue`. */
  exchange: string;
  routingKeys: string[];
  /** Epoch ms. */
  time?: number;
}

export interface DeathInfo {
  /** Most recent first, as the broker orders it. */
  history: DeathEntry[];
  /** Total times the message was dead-lettered, across queues and reasons. */
  total: number;
  firstQueue?: string;
  firstReason?: string;
  lastQueue?: string;
  lastReason?: string;
  /**
   * Where the message was first published to: the exchange and routing keys of its first death.
   * A replay to the original destination would publish here.
   */
  original?: { exchange: string; routingKeys: string[]; queue: string };
}

/** What each dead-letter reason means, for the inspector. */
export const DEATH_REASON_TEXT: Record<string, string> = {
  rejected: "A consumer rejected or nacked it without requeueing.",
  expired: "Its time-to-live ran out (message TTL or the queue's x-message-ttl).",
  maxlen: "The queue was over its length limit (x-max-length / x-max-length-bytes).",
  delivery_limit: "It was redelivered more times than the quorum queue's delivery limit allows.",
};

/** Header keys the decoded view replaces; the raw Headers list hides them. */
export const DEATH_HEADER_KEYS = new Set([
  "x-death",
  "x-first-death-queue",
  "x-first-death-reason",
  "x-first-death-exchange",
  "x-last-death-queue",
  "x-last-death-reason",
  "x-last-death-exchange",
]);

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function headersOf(message: WithProperties): Record<string, unknown> {
  // The Management API sends `properties: []` when a message has none.
  const headers = (message.properties as { headers?: unknown }).headers;
  return headers && typeof headers === "object" && !Array.isArray(headers) ? (headers as Record<string, unknown>) : {};
}

function toEntry(raw: unknown): DeathEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const queue = str(r.queue);
  const reason = str(r.reason);
  if (!queue || !reason) return undefined;
  const count = typeof r.count === "number" && r.count > 0 ? r.count : 1;
  const keys = Array.isArray(r["routing-keys"])
    ? r["routing-keys"].filter((k): k is string => typeof k === "string")
    : [];
  return {
    queue,
    reason,
    count,
    exchange: str(r.exchange) ?? "",
    routingKeys: keys,
    time: typeof r.time === "number" ? r.time * 1000 : undefined,
  };
}

/** Dead-letter details of a message, or undefined when it was never dead-lettered. */
export function parseDeath(message: WithProperties): DeathInfo | undefined {
  const headers = headersOf(message);
  const raw = headers["x-death"];
  const history = (Array.isArray(raw) ? raw : []).map(toEntry).filter((e): e is DeathEntry => Boolean(e));
  const firstQueue = str(headers["x-first-death-queue"]);
  const firstReason = str(headers["x-first-death-reason"]);
  if (history.length === 0 && !firstQueue) return undefined;

  const firstEntry =
    history.find((e) => e.queue === firstQueue && (!firstReason || e.reason === firstReason)) ?? history.at(-1);
  const original = firstEntry
    ? { exchange: firstEntry.exchange, routingKeys: firstEntry.routingKeys, queue: firstEntry.queue }
    : firstQueue
      ? { exchange: str(headers["x-first-death-exchange"]) ?? "", routingKeys: [], queue: firstQueue }
      : undefined;

  return {
    history,
    total: history.reduce((s, e) => s + e.count, 0) || 1,
    firstQueue: firstQueue ?? firstEntry?.queue,
    firstReason: firstReason ?? firstEntry?.reason,
    lastQueue: str(headers["x-last-death-queue"]) ?? history[0]?.queue,
    lastReason: str(headers["x-last-death-reason"]) ?? history[0]?.reason,
    original,
  };
}

/** The reason of the most recent death; "unknown" when only partial headers are present. */
export function deathReason(death: DeathInfo): string {
  return death.lastReason ?? "unknown";
}

/**
 * Where a replay publishes:
 * - `failed-queue`: straight back to the queue the message first failed in, through the default
 *   exchange. Only the consumer that failed it receives it again.
 * - `original-exchange`: to the exchange and routing key it was first published with. Every queue
 *   bound there receives a copy, including consumers that already processed it.
 */
export type ReplayDestination = "failed-queue" | "original-exchange";

export interface ReplayPlan {
  exchange: string;
  routingKey: string;
  properties: Record<string, unknown>;
}

/**
 * Headers the broker maintains; they are never replayed. A stale `x-death` also makes RabbitMQ's
 * dead-letter cycle detection treat a replayed message that fails again as a loop and drop it.
 */
const BROKER_HEADERS = new Set([...DEATH_HEADER_KEYS, "x-delivery-count", "x-acquired-count"]);
/** Sender-selected extra routing keys: on the default exchange they would copy the message into other queues. */
const EXTRA_ROUTING_HEADERS = new Set(["CC", "BCC"]);

/**
 * How to replay one dead-lettered message to `destination`: the exchange, the routing key and the
 * properties to publish with (payload and every other property unchanged, broker-managed headers
 * removed; CC/BCC also removed for `failed-queue`). An `error` when the message cannot be replayed
 * there. Pure; Main uses it to publish, the renderer to preview the confirmation.
 */
export function planReplay(message: WithProperties, destination: ReplayDestination): ReplayPlan | { error: string } {
  const death = parseDeath(message);
  if (!death) return { error: "Not dead-lettered: there is no x-death history to replay from." };

  const props = Array.isArray(message.properties) ? {} : { ...message.properties };
  const drop = (key: string) =>
    BROKER_HEADERS.has(key) || (destination === "failed-queue" && EXTRA_ROUTING_HEADERS.has(key));
  const headers = Object.fromEntries(Object.entries(headersOf(message)).filter(([k]) => !drop(k)));
  delete props.headers;
  const properties = Object.keys(headers).length > 0 ? { ...props, headers } : props;

  if (destination === "failed-queue") {
    const queue = death.firstQueue;
    if (!queue) return { error: "The queue it first failed in is unknown (no x-first-death-queue)." };
    return { exchange: "", routingKey: queue, properties };
  }
  const original = death.original;
  if (!original || original.routingKeys.length === 0) {
    return { error: "The original routing key is unknown (no routing-keys in x-death)." };
  }
  return { exchange: original.exchange, routingKey: original.routingKeys[0], properties };
}
