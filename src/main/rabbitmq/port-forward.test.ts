import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createKubectlTunnelOpener, runningKubectlCount, STDERR_TAIL_CHARS } from "./port-forward";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import type { KubectlTunnelDependencies } from "./port-forward";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => {
    this.emit("exit", null, "SIGTERM");
    return true;
  });
}

function setup(overrides: Partial<KubectlTunnelDependencies> = {}) {
  const child = new FakeChild();
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const open = createKubectlTunnelOpener({
    getKubectlPath: async () => "/opt/freelens/kubectl",
    getEnvironment: async () => ({ KUBECONFIG: "/tmp/proxy-kubeconfig" }),
    cwd: "/extensions/rabbitmq",
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return child as unknown as ChildProcess;
    },
    ...overrides,
  });
  return { child, calls, open };
}

const target = { namespace: "shop", pod: "orders-server-0", port: 15672 };

describe("createKubectlTunnelOpener", () => {
  it("runs the host kubectl with the Freelens environment and resolves on the Forwarding line", async () => {
    const { child, calls, open } = setup();
    const opening = open(target);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]?.command).toBe("/opt/freelens/kubectl");
    expect(calls[0]?.args).toEqual([
      "port-forward",
      "--address",
      "127.0.0.1",
      "--namespace",
      "shop",
      "pod/orders-server-0",
      ":15672",
    ]);
    expect(calls[0]?.options.env).toEqual({ KUBECONFIG: "/tmp/proxy-kubeconfig" });
    expect(calls[0]?.options.cwd).toBe("/extensions/rabbitmq");

    child.stdout.write("Forwarding from 127.0.0.1:");
    child.stdout.write("54321 -> 15672\n");
    const tunnel = await opening;
    expect(tunnel).toMatchObject({ localHost: "127.0.0.1", localPort: 54321, target });

    tunnel.close();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("rejects as unreachable with kubectl's stderr when it exits before forwarding", async () => {
    const { child, calls, open } = setup();
    const opening = open(target);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    child.stderr.write('error: pods "orders-server-0" is forbidden: cannot create resource "pods/portforward"\n');
    await new Promise((r) => setImmediate(r));
    child.emit("exit", 1, null);

    await expect(opening).rejects.toMatchObject({
      code: "unreachable",
      message: expect.stringContaining("pods/portforward"),
    });
  });

  it("kills kubectl and rejects when it is not ready in time", async () => {
    const { child, calls, open } = setup({ readyTimeoutMs: 20 });

    await expect(open(target)).rejects.toMatchObject({
      code: "unreachable",
      message: expect.stringContaining("not ready"),
    });
    expect(calls).toHaveLength(1);
    expect(child.kill).toHaveBeenCalled();
  });

  it("rejects when kubectl cannot be started, and forgets the child", async () => {
    const { child, calls, open } = setup();
    // a child that fails to spawn emits error and never exits
    child.kill.mockImplementation(() => true);
    const before = runningKubectlCount();
    const opening = open(target);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(runningKubectlCount()).toBe(before + 1);

    child.emit("error", new Error("spawn ENOENT"));
    await expect(opening).rejects.toMatchObject({ code: "unreachable", message: expect.stringContaining("ENOENT") });
    expect(runningKubectlCount()).toBe(before);
  });

  it("keeps only the tail of stderr", async () => {
    const { child, calls, open } = setup();
    const opening = open(target);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    child.stderr.write("x".repeat(STDERR_TAIL_CHARS * 3));
    child.stderr.write("error: the last line\n");
    await new Promise((r) => setImmediate(r));
    child.emit("exit", 1, null);

    const error = (await opening.catch((err: unknown) => err)) as Error;
    expect(error.message).toContain("error: the last line");
    expect(error.message.length).toBeLessThan(STDERR_TAIL_CHARS + 200);
  });

  it("reports what kubectl prints after the tunnel is ready, such as a port the pod does not have", async () => {
    const { child, calls, open } = setup();
    const opening = open(target);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.write("Forwarding from 127.0.0.1:54321 -> 15672\n");
    const tunnel = await opening;

    expect(await tunnel.problem(10)).toBeUndefined();
    const problem = tunnel.problem(1_000);
    child.stderr.write(
      "E1015 portforward.go:424] error copying from local connection to remote stream: connection refused\n",
    );
    expect(await problem).toContain("connection refused");
  });

  it("does not start kubectl when the open is aborted while kubectl is prepared", async () => {
    const controller = new AbortController();
    const { calls, open } = setup({
      getEnvironment: async () => {
        controller.abort();
        return {};
      },
    });
    await expect(open(target, { signal: controller.signal })).rejects.toMatchObject({
      code: "unreachable",
      message: expect.stringContaining("cancelled"),
    });
    expect(calls).toHaveLength(0);
  });

  it("kills kubectl when the open is aborted before it is ready", async () => {
    const controller = new AbortController();
    const { child, calls, open } = setup();
    const opening = open(target, { signal: controller.signal });
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    controller.abort();
    await expect(opening).rejects.toMatchObject({ message: expect.stringContaining("cancelled") });
    expect(child.kill).toHaveBeenCalled();
  });

  it("rejects when the host has no kubectl for the cluster", async () => {
    const { calls, open } = setup({
      getKubectlPath: async () => {
        throw new Error("cluster is not connected");
      },
    });
    await expect(open(target)).rejects.toThrow("cluster is not connected");
    expect(calls).toHaveLength(0);
  });

  it("adds the kubectl preparation problems to the error and logs and passes on its phases", async () => {
    const log = vi.fn();
    const { child, calls, open } = setup({
      log,
      getKubectlPath: async (options) => {
        options.onPhase?.("verifying the download");
        options.onProblem?.("checksum mismatch, using the bundled kubectl");
        return "/opt/freelens/kubectl";
      },
    });
    const onPhase = vi.fn();
    const opening = open(target, { onPhase });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(onPhase).toHaveBeenCalledWith("verifying the download");

    child.stderr.write("error: unable to forward port\n");
    child.emit("exit", 1, null);
    await expect(opening).rejects.toMatchObject({
      code: "unreachable",
      message: expect.stringContaining("(kubectl: checksum mismatch, using the bundled kubectl)"),
    });
    expect(log).toHaveBeenCalledWith("kubectl for shop/orders-server-0:15672: verifying the download");
  });
});
