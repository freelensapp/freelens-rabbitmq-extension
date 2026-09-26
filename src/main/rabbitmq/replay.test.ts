import { describe, expect, it } from "vitest";
import { RabbitmqError } from "../../common/errors";
import { replayMessages } from "./replay";

import type { ReplayMessageInput } from "../../common/ipc";
import type { ReplayDependencies } from "./replay";

function deadLettered(index: number, overrides: Partial<ReplayMessageInput> = {}): ReplayMessageInput {
  return {
    index,
    payload: `{"order":${index}}`,
    payloadEncoding: "string",
    truncated: false,
    properties: {
      delivery_mode: 2,
      headers: {
        tenant: "acme",
        "x-death": [
          { count: 1, exchange: "shop", queue: "orders", reason: "rejected", "routing-keys": ["order.created"] },
        ],
        "x-first-death-queue": "orders",
        "x-delivery-count": 1,
      },
    },
    ...overrides,
  };
}

function deps(armed: boolean, routed: (routingKey: string) => boolean | Error = () => true) {
  const calls: { exchange: string; routingKey: string; payload: string; properties: Record<string, unknown> }[] = [];
  const d: ReplayDependencies = {
    assertWriteMode: () => {
      if (!armed) throw new RabbitmqError("write-mode-disabled", "Write Mode is off");
    },
    publish: async (exchange, body) => {
      calls.push({ exchange, routingKey: body.routingKey, payload: body.payload, properties: body.properties });
      const r = routed(body.routingKey);
      if (r instanceof Error) throw r;
      return { routed: r };
    },
  };
  return { d, calls };
}

describe("replayMessages", () => {
  it("publishes nothing when Write Mode is off (disarmed path)", async () => {
    const { d, calls } = deps(false);
    await expect(replayMessages("failed-queue", [deadLettered(0)], d)).rejects.toMatchObject({
      code: "write-mode-disabled",
    });
    expect(calls).toEqual([]);
  });

  it("checks the gate before validating the request", async () => {
    const { d } = deps(false);
    await expect(replayMessages("failed-queue", [], d)).rejects.toMatchObject({ code: "write-mode-disabled" });
  });

  it("publishes each message back to the queue it failed in, computed from its own headers", async () => {
    const { d, calls } = deps(true);
    const res = await replayMessages("failed-queue", [deadLettered(0), deadLettered(1)], d);
    expect(calls.map((c) => [c.exchange, c.routingKey, c.payload])).toEqual([
      ["", "orders", '{"order":0}'],
      ["", "orders", '{"order":1}'],
    ]);
    expect(calls[0].properties).toEqual({ delivery_mode: 2, headers: { tenant: "acme" } });
    expect(res).toMatchObject({ routed: 2, unroutable: 0, skipped: 0, failed: 0 });
  });

  it("publishes to the original exchange and routing key when asked", async () => {
    const { d, calls } = deps(true);
    await replayMessages("original-exchange", [deadLettered(0)], d);
    expect(calls.map((c) => [c.exchange, c.routingKey])).toEqual([["shop", "order.created"]]);
  });

  it("skips truncated payloads and messages without dead-letter history, and keeps going", async () => {
    const { d, calls } = deps(true);
    const res = await replayMessages(
      "failed-queue",
      [deadLettered(0, { truncated: true }), deadLettered(1, { properties: [] }), deadLettered(2)],
      d,
    );
    expect(calls.map((c) => c.payload)).toEqual(['{"order":2}']);
    expect(res.results.map((r) => [r.index, r.outcome])).toEqual([
      [0, "skipped"],
      [1, "skipped"],
      [2, "routed"],
    ]);
    expect(res.results[0].message).toMatch(/truncated/);
  });

  it("reports unroutable and failed publishes per message without stopping", async () => {
    const { d } = deps(true, (key) => (key === "orders" ? new Error("connection reset") : false));
    const res = await replayMessages("failed-queue", [deadLettered(0)], d);
    expect(res.results[0]).toMatchObject({ outcome: "failed", message: "connection reset" });
    const { d: d2 } = deps(true, () => false);
    const res2 = await replayMessages("original-exchange", [deadLettered(0)], d2);
    expect(res2).toMatchObject({ routed: 0, unroutable: 1 });
    expect(res2.results[0].message).toMatch(/no binding matched/);
    const res3 = await replayMessages("failed-queue", [deadLettered(0)], d2);
    expect(res3.results[0].message).toMatch(/No queue named "orders"/);
  });

  it("rejects an empty batch, more than 50 messages, and unknown destinations", async () => {
    const { d, calls } = deps(true);
    await expect(replayMessages("failed-queue", [], d)).rejects.toThrow(/No messages/);
    const many = Array.from({ length: 51 }, (_, i) => deadLettered(i));
    await expect(replayMessages("failed-queue", many, d)).rejects.toThrow(/At most 50/);
    await expect(replayMessages("somewhere" as never, [deadLettered(0)], d)).rejects.toThrow(
      /Unknown replay destination/,
    );
    expect(calls).toEqual([]);
  });
});
