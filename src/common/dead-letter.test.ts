import { describe, expect, it } from "vitest";
import { planReplay } from "./dead-letter";

// Properties exactly as the Management API returned them on RabbitMQ 4.3.5 (2026-09-26): published
// to exchange `shop` with routing key `order.created` and CC `audit`, then rejected in `orders`.
const deadLettered = {
  properties: {
    message_id: "m-7",
    delivery_mode: 2,
    headers: {
      CC: ["audit"],
      tenant: "acme",
      "x-acquired-count": 1,
      "x-death": [
        {
          count: 1,
          exchange: "shop",
          queue: "orders",
          reason: "rejected",
          "routing-keys": ["order.created", "audit"],
          time: 1790443798,
        },
      ],
      "x-delivery-count": 1,
      "x-first-death-exchange": "shop",
      "x-first-death-queue": "orders",
      "x-first-death-reason": "rejected",
      "x-last-death-exchange": "shop",
      "x-last-death-queue": "orders",
      "x-last-death-reason": "rejected",
    },
  },
};

describe("planReplay", () => {
  it("sends a message back to the queue it failed in, without broker headers or CC", () => {
    // CC on the default exchange would also copy it into the `audit` queue (verified on the broker).
    expect(planReplay(deadLettered, "failed-queue")).toEqual({
      exchange: "",
      routingKey: "orders",
      properties: { message_id: "m-7", delivery_mode: 2, headers: { tenant: "acme" } },
    });
  });

  it("replays to the original exchange and first routing key, keeping CC to reproduce the original routing", () => {
    expect(planReplay(deadLettered, "original-exchange")).toEqual({
      exchange: "shop",
      routingKey: "order.created",
      properties: { message_id: "m-7", delivery_mode: 2, headers: { CC: ["audit"], tenant: "acme" } },
    });
  });

  it("targets the first failure on a multi-hop history (e.g. a retry queue that expired it later)", () => {
    const multiHop = {
      properties: {
        headers: {
          "x-death": [
            { count: 2, exchange: "", queue: "orders.retry", reason: "expired", "routing-keys": ["orders.retry"] },
            {
              count: 1,
              exchange: "shop",
              queue: "orders",
              reason: "delivery_limit",
              "routing-keys": ["order.created"],
            },
          ],
          "x-first-death-queue": "orders",
          "x-first-death-reason": "delivery_limit",
        },
      },
    };
    expect(planReplay(multiHop, "failed-queue")).toMatchObject({ exchange: "", routingKey: "orders" });
    expect(planReplay(multiHop, "original-exchange")).toMatchObject({ exchange: "shop", routingKey: "order.created" });
  });

  it("drops the headers object entirely when only broker headers were present", () => {
    const plan = planReplay(
      {
        properties: {
          content_type: "text/plain",
          headers: {
            "x-death": [{ count: 1, exchange: "", queue: "q", reason: "expired", "routing-keys": ["q"] }],
            "x-first-death-queue": "q",
          },
        },
      },
      "failed-queue",
    );
    expect(plan).toEqual({ exchange: "", routingKey: "q", properties: { content_type: "text/plain" } });
  });

  it("refuses messages that were never dead-lettered, including `properties: []`", () => {
    expect(planReplay({ properties: [] }, "failed-queue")).toEqual({
      error: expect.stringMatching(/Not dead-lettered/),
    });
    expect(planReplay({ properties: { headers: { tenant: "acme" } } }, "original-exchange")).toHaveProperty("error");
  });

  it("refuses the original exchange when the routing keys are unknown", () => {
    const partial = { properties: { headers: { "x-first-death-queue": "orders", "x-first-death-exchange": "shop" } } };
    expect(planReplay(partial, "original-exchange")).toEqual({
      error: expect.stringMatching(/routing key is unknown/),
    });
    // Going back to the queue only needs the queue name.
    expect(planReplay(partial, "failed-queue")).toMatchObject({ exchange: "", routingKey: "orders" });
  });

  it("does not modify the message it plans for", () => {
    const copy = structuredClone(deadLettered);
    planReplay(deadLettered, "failed-queue");
    expect(deadLettered).toEqual(copy);
  });
});
