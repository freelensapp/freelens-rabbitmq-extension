import { afterEach, describe, expect, it, vi } from "vitest";
import { RabbitmqError } from "../../common/errors";
import { RabbitmqSessionManager, sessionKey } from "./session-manager";

import type { DiscoveredRabbitmqInfo } from "../../common/ipc";
import type { KubeReader } from "./kube-reader";
import type { Tunnel } from "./port-forward";

const noopReader: KubeReader = {
  listCustomResources: async () => [],
  listServices: async () => [],
  listWorkloads: async () => [],
  listPods: async () => [],
  getSecret: async () => null,
};

describe("RabbitmqSessionManager write-mode gate", () => {
  const mgr = new RabbitmqSessionManager({
    createReader: () => noopReader,
    openTunnel: () => Promise.reject(new Error("no tunnel in this test")),
  });

  it("is read-only by default and throws a typed error", () => {
    expect(mgr.isWriteMode("c", "t")).toBe(false);
    expect(() => mgr.assertWriteMode("c", "t", "Purging")).toThrowError(/Write Mode is off/);
    try {
      mgr.assertWriteMode("c", "t", "Purging");
    } catch (err) {
      expect(err).toMatchObject({ code: "write-mode-disabled" });
    }
  });

  it("arms and disarms per (cluster, target)", () => {
    mgr.setWriteMode("c", "t", true);
    expect(mgr.isWriteMode("c", "t")).toBe(true);
    expect(mgr.isWriteMode("other", "t")).toBe(false);
    expect(() => mgr.assertWriteMode("c", "t", "x")).not.toThrow();
    mgr.setWriteMode("c", "t", false);
    expect(mgr.isWriteMode("c", "t")).toBe(false);
  });

  it("closeAll resets write mode and manual credentials", () => {
    mgr.setWriteMode("c", "t", true);
    mgr.setManualCredentials("c", "t", "u", "p");
    expect(mgr.hasManualCredentials("c", "t")).toBe(true);
    mgr.closeAll();
    expect(mgr.isWriteMode("c", "t")).toBe(false);
    expect(mgr.hasManualCredentials("c", "t")).toBe(false);
  });

  it("builds stable session keys", () => {
    expect(sessionKey(undefined, "t")).toBe("active::t");
    expect(sessionKey("c", "t")).toBe("c::t");
  });
});

// -- opening sessions ---------------------------------------------------------------

const hooks = vi.hoisted(() => ({
  // resolved before the pod lookup; a test can hold it to act while the open is in flight
  credentialsGate: Promise.resolve(),
  whoami: async (auth: { username: string }) => ({ name: auth.username, tags: ["administrator"] as string[] }),
}));

vi.mock("./credentials", () => ({
  resolveCredentials: async () => {
    await hooks.credentialsGate;
    return { username: "default-user", password: "pw", source: "Secret shop/orders-default-user" };
  },
  resolveManagementTls: async () => undefined,
}));
vi.mock("./pod-resolver", () => ({
  resolveManagementPod: async () => ({ namespace: "shop", pod: "orders-server-0", port: 15672 }),
}));
vi.mock("./http", () => ({ createJsonHttpClient: (options: { auth: { username: string } }) => options }));
vi.mock("./management-client", () => ({
  RabbitmqManagementClient: class {
    constructor(private readonly http: { auth: { username: string } }) {}
    whoami() {
      return hooks.whoami(this.http.auth);
    }
  },
}));

const target = {
  targetId: "orders",
  name: "orders",
  namespace: "shop",
  source: "operator",
  provider: "RabbitMQ Cluster Operator",
  podSelector: "app=orders",
  managementPort: 15672,
  managementTls: false,
  amqpTls: false,
  credentialHint: { kind: "operator-default-user", secret: { namespace: "shop", name: "orders-default-user" } },
} as unknown as DiscoveredRabbitmqInfo;

function fakeTunnel(problem?: string): Tunnel {
  return {
    localHost: "127.0.0.1",
    localPort: 54321,
    target: { namespace: "shop", pod: "orders-server-0", port: 15672 },
    problem: vi.fn(async () => problem),
    close: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("RabbitmqSessionManager opening", () => {
  afterEach(() => {
    hooks.credentialsGate = Promise.resolve();
    hooks.whoami = async (auth) => ({ name: auth.username, tags: ["administrator"] });
  });

  it("does not start the tunnel of an open that closeAll stopped", async () => {
    const gate = deferred<void>();
    hooks.credentialsGate = gate.promise;
    const openTunnel = vi.fn(async () => fakeTunnel());
    const mgr = new RabbitmqSessionManager({ createReader: () => noopReader, openTunnel });

    const opening = mgr.getOrOpen("c", target, () => {});
    mgr.closeAll();
    gate.resolve();

    await expect(opening).rejects.toMatchObject({ code: "unreachable", message: expect.stringContaining("closed") });
    expect(openTunnel).not.toHaveBeenCalled();
    expect(mgr.openSessionCount()).toBe(0);
  });

  it("aborts a tunnel being opened and closes it if it still comes up", async () => {
    const tunnel = fakeTunnel();
    const pending = deferred<Tunnel>();
    let signal: AbortSignal | undefined;
    const mgr = new RabbitmqSessionManager({
      createReader: () => noopReader,
      openTunnel: (_cluster, _target, options) => {
        signal = options.signal;
        return pending.promise;
      },
    });

    const opening = mgr.getOrOpen("c", target, () => {});
    await vi.waitFor(() => expect(signal).toBeDefined());
    mgr.closeAll();
    expect(signal?.aborted).toBe(true);
    pending.resolve(tunnel);

    await expect(opening).rejects.toMatchObject({ code: "unreachable" });
    expect(tunnel.close).toHaveBeenCalled();
    expect(mgr.openSessionCount()).toBe(0);
  });

  it("opens again with manual credentials set while an open was in flight", async () => {
    const gate = deferred<void>();
    hooks.credentialsGate = gate.promise;
    const tunnels: Tunnel[] = [];
    const mgr = new RabbitmqSessionManager({
      createReader: () => noopReader,
      openTunnel: async () => {
        const tunnel = fakeTunnel();
        tunnels.push(tunnel);
        return tunnel;
      },
    });

    const opening = mgr.getOrOpen("c", target, () => {});
    mgr.setManualCredentials("c", "orders", "ops", "secret");
    gate.resolve();

    const session = await opening;
    expect(session).toMatchObject({ username: "ops", credentialSource: "manual (this session)" });
    expect(mgr.openSessionCount()).toBe(1);
    expect(tunnels).toHaveLength(1);
    mgr.closeAll();
  });

  it("reports the phases of preparing kubectl", async () => {
    const report = vi.fn();
    const mgr = new RabbitmqSessionManager({
      createReader: () => noopReader,
      openTunnel: async (_cluster, _target, options) => {
        options.onPhase?.("downloading kubectl 1.37.0");
        return fakeTunnel();
      },
    });

    await mgr.getOrOpen("c", target, report);
    expect(report).toHaveBeenCalledWith({
      value: 55,
      phase: "port-forward",
      label: "Preparing kubectl",
      detail: "downloading kubectl 1.37.0",
    });
    mgr.closeAll();
  });

  it("adds what kubectl printed to an unreachable Management API", async () => {
    const tunnel = fakeTunnel("error forwarding port 15672 to pod orders-server-0: connection refused");
    hooks.whoami = async () => {
      throw new RabbitmqError("unreachable", "socket hang up");
    };
    const mgr = new RabbitmqSessionManager({ createReader: () => noopReader, openTunnel: async () => tunnel });

    await expect(mgr.getOrOpen("c", target, () => {})).rejects.toMatchObject({
      code: "unreachable",
      message: "socket hang up: error forwarding port 15672 to pod orders-server-0: connection refused",
    });
    expect(tunnel.close).toHaveBeenCalled();
  });
});
