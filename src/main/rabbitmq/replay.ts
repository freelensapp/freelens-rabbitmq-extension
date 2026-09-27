/**
 * Copy replay of dead-lettered messages: publish copies to the destination their own x-death
 * headers point to; the originals stay in the dead-letter queue, so nothing can be lost.
 *
 * The Write Mode gate is checked before anything else, the destination is computed here from each
 * message's headers (never taken from the renderer), truncated payloads are refused, and every
 * message is published on its own so one failure does not stop the rest.
 */
import { RABBITMQ_PEEK_MAX_COUNT } from "../../common/constants";
import { planReplay } from "../../common/dead-letter";
import { RabbitmqError } from "../../common/errors";

import type { ReplayDestination } from "../../common/dead-letter";
import type { PublishResultDto, ReplayMessageInput, ReplayMessageResult, ReplayResultDto } from "../../common/ipc";

export interface ReplayDependencies {
  /** Throws `write-mode-disabled` when the target is not armed. */
  assertWriteMode: () => void;
  publish: (
    exchange: string,
    body: {
      routingKey: string;
      payload: string;
      payloadEncoding: "string" | "base64";
      properties: Record<string, unknown>;
    },
  ) => Promise<PublishResultDto>;
}

const DESTINATIONS: ReplayDestination[] = ["failed-queue", "original-exchange"];

export async function replayMessages(
  destination: ReplayDestination,
  messages: ReplayMessageInput[],
  deps: ReplayDependencies,
): Promise<ReplayResultDto> {
  deps.assertWriteMode();
  if (!DESTINATIONS.includes(destination)) {
    throw new RabbitmqError("unknown", `Unknown replay destination "${String(destination)}".`);
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new RabbitmqError("unknown", "No messages to replay.");
  }
  if (messages.length > RABBITMQ_PEEK_MAX_COUNT) {
    throw new RabbitmqError("unknown", `At most ${RABBITMQ_PEEK_MAX_COUNT} messages can be replayed at once.`);
  }

  const results: ReplayMessageResult[] = [];
  for (const m of messages) {
    if (m.truncated) {
      results.push({
        index: m.index,
        outcome: "skipped",
        message: "The peeked payload was truncated; replaying it would publish a cut-off message.",
      });
      continue;
    }
    const plan = planReplay(m, destination);
    if ("error" in plan) {
      results.push({ index: m.index, outcome: "skipped", message: plan.error });
      continue;
    }
    try {
      const res = await deps.publish(plan.exchange, {
        routingKey: plan.routingKey,
        payload: m.payload,
        payloadEncoding: m.payloadEncoding === "base64" ? "base64" : "string",
        properties: plan.properties,
      });
      results.push({
        index: m.index,
        exchange: plan.exchange,
        routingKey: plan.routingKey,
        outcome: res.routed ? "routed" : "unroutable",
        message: res.routed
          ? undefined
          : plan.exchange === ""
            ? `No queue named "${plan.routingKey}" exists any more; the copy was dropped (the original is still in the dead-letter queue).`
            : "Published, but no binding matched; the copy was dropped (the original is still in the dead-letter queue).",
      });
    } catch (err) {
      results.push({
        index: m.index,
        exchange: plan.exchange,
        routingKey: plan.routingKey,
        outcome: "failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const count = (outcome: ReplayMessageResult["outcome"]) => results.filter((r) => r.outcome === outcome).length;
  return {
    results,
    routed: count("routed"),
    unroutable: count("unroutable"),
    skipped: count("skipped"),
    failed: count("failed"),
  };
}
