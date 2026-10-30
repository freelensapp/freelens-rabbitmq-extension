import { RabbitmqError } from "../../common/errors";
import type { ChildProcess, SpawnOptions } from "node:child_process";

export interface PodPort {
  namespace: string;
  pod: string;
  port: number;
}

export interface Tunnel {
  readonly localHost: string;
  readonly localPort: number;
  readonly target: PodPort;
  /**
   * What the tunnel printed on stderr since it became ready, waiting up to `waitMs` for a first line. A connection
   * that fails through the tunnel (a pod without that port, a pod that went away) is reported there, not to the client.
   */
  problem(waitMs?: number): Promise<string | undefined>;
  close(): void;
}

export interface TunnelOpenOptions {
  /** Receives each phase of preparing kubectl, such as downloading the version-matched binary. */
  onPhase?: (message: string) => void;
  /** Aborting before the tunnel is ready stops it: kubectl is not started, or is killed. */
  signal?: AbortSignal;
}

/** Opens a local tunnel to a pod port. */
export type TunnelOpener = (target: PodPort, options?: TunnelOpenOptions) => Promise<Tunnel>;

/** The reporting callbacks of `Main.Shell.KubectlDownloadOptions` the tunnel uses. */
export interface KubectlPreparationOptions {
  onPhase?: (message: string) => void;
  onProblem?: (message: string) => void;
}

export interface KubectlTunnelDependencies {
  /** The kubectl Freelens runs for the cluster (`Main.Shell.getKubectlPath`), which may download it. */
  getKubectlPath(options: KubectlPreparationOptions): Promise<string>;
  /** An environment whose kubeconfig reaches the cluster through Freelens (`Main.Shell.getEnvironment`). */
  getEnvironment(options: KubectlPreparationOptions): Promise<Record<string, string>>;
  /** Where a preparation phase (such as downloading the version-matched kubectl) is logged. */
  log?: (message: string) => void;
  /** The working directory of kubectl: the application's own is unspecified (`/` for a macOS app from Finder). */
  cwd: string;
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess;
  readyTimeoutMs?: number;
}

const LOCAL_HOST = "127.0.0.1";
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_PROBLEM_WAIT_MS = 500;
const FORWARDING_LINE = /^Forwarding from 127\.0\.0\.1:(\d+) ->/m;
// kubectl keeps running for the life of the session, so only the end of what it prints is kept.
export const STDERR_TAIL_CHARS = 4096;

// kubectl children still running; killed when the Main process exits so a quit never leaves one behind.
const running = new Set<ChildProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const child of running) child.kill();
  });
}

/** The kubectl children not yet exited, for tests. */
export function runningKubectlCount(): number {
  return running.size;
}

function appendTail(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length > STDERR_TAIL_CHARS ? next.slice(next.length - STDERR_TAIL_CHARS) : next;
}

function abortError(target: PodPort): RabbitmqError {
  return new RabbitmqError("unreachable", `the port-forward to ${describe(target)} was cancelled`);
}

/**
 * {@link TunnelOpener} that runs `kubectl port-forward` with the kubectl and the kubeconfig Freelens itself uses
 * for the cluster, so the tunnel goes through the Freelens proxy like the app's own port-forwards. kubectl picks a
 * free local port; the tunnel is ready once it prints the `Forwarding from` line.
 */
export function createKubectlTunnelOpener(deps: KubectlTunnelDependencies): TunnelOpener {
  const readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  return async (target, openOptions = {}) => {
    const { signal } = openOptions;
    // A problem preparing the version-matched kubectl does not stop the call (Freelens goes on with the bundled
    // kubectl), but it explains a tunnel that then fails, so it is added to the error.
    const problems = new Set<string>();
    const options: KubectlPreparationOptions = {
      onPhase: (message) => {
        deps.log?.(`kubectl for ${describe(target)}: ${message}`);
        openOptions.onPhase?.(message);
      },
      onProblem: (message) => problems.add(message),
    };
    // The ready timeout starts below, after kubectl is prepared, so a download does not count against it.
    const [kubectl, env] = await Promise.all([deps.getKubectlPath(options), deps.getEnvironment(options)]);
    if (signal?.aborted) throw abortError(target);
    const args = [
      "port-forward",
      "--address",
      LOCAL_HOST,
      "--namespace",
      target.namespace,
      `pod/${target.pod}`,
      `:${target.port}`,
    ];
    const child = deps.spawn(kubectl, args, { cwd: deps.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    running.add(child);
    installExitHook();
    // A child that cannot be started emits `error` and may never emit `exit`.
    child.once("error", () => running.delete(child));
    child.once("exit", () => running.delete(child));

    return new Promise<Tunnel>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      // stderr printed after the tunnel is ready, and the callers of `problem` waiting for it
      let afterReady = "";
      const waiters = new Set<() => void>();
      let settled = false;

      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        child.kill();
        const notes = [...problems].map((problem) => ` (kubectl: ${problem})`).join("");
        reject(new RabbitmqError("unreachable", `${message}${notes}`));
      };

      const timer = setTimeout(
        () => fail(`kubectl port-forward to ${describe(target)} was not ready after ${readyTimeoutMs} ms`),
        readyTimeoutMs,
      );

      const onAbort = () => fail(abortError(target).message);
      signal?.addEventListener("abort", onAbort, { once: true });

      const problem = (waitMs = DEFAULT_PROBLEM_WAIT_MS) => {
        if (afterReady.trim()) return Promise.resolve(afterReady.trim());
        return new Promise<string | undefined>((done) => {
          const finish = () => {
            clearTimeout(wait);
            waiters.delete(finish);
            done(afterReady.trim() || undefined);
          };
          const wait = setTimeout(finish, waitMs);
          waiters.add(finish);
        });
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return;
        stdout = appendTail(stdout, chunk.toString());
        const match = FORWARDING_LINE.exec(stdout);
        if (!match) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({
          localHost: LOCAL_HOST,
          localPort: Number(match[1]),
          target,
          problem,
          close: () => child.kill(),
        });
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        if (!settled) {
          stderr = appendTail(stderr, text);
          return;
        }
        afterReady = appendTail(afterReady, text);
        for (const finish of [...waiters]) finish();
      });
      child.once("error", (err) => fail(`could not run kubectl port-forward: ${err.message}`));
      child.once("exit", (code, exitSignal) => {
        const reason = stderr.trim() || `exited with ${exitSignal ?? `code ${code}`}`;
        fail(`kubectl port-forward to ${describe(target)} failed: ${reason}`);
      });
    });
  };
}

function describe(target: PodPort): string {
  return `${target.namespace}/${target.pod}:${target.port}`;
}
