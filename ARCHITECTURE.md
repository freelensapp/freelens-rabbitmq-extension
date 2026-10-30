# Architecture

Two processes, as every Freelens extension:

| Layer | Location | Role |
| --- | --- | --- |
| Renderer | `src/renderer/` | React pages registered as `clusterPages` + sidebar menus. Talks to Main only through `RabbitmqIpcRenderer`. |
| Common | `src/common/` | `ipc.ts` (channel names + DTOs), `errors.ts` (typed error serialised through Electron's message-only rejection), `constants.ts`, `target.ts`. |
| Main | `src/main/` | `RabbitmqIpcMain` registers one handler per channel and delegates to the engine. |

## Engine (`src/main/rabbitmq/`)

```text
discover ──▶ DiscoveredRabbitmqInfo[]      (discovery.ts; KubeReader seam)
                 │
      target ────┤ SessionManager.withSession(clusterId, target)
                 │   ├─ resolveCredentials(hint)     credentials.ts   (Secrets → user/pass, CA)
                 │   ├─ resolveManagementPod         pod-resolver.ts  (Ready pod + numeric port)
                 │   ├─ openTunnel(clusterId, pod)   port-forward.ts  (kubectl port-forward via Freelens)
                 │   └─ RabbitmqManagementClient     management-client.ts + http.ts + normalize.ts
                 └─ assertWriteMode()                for publish / purge / delete
```

- **KubeReader** is the only Kubernetes read seam: production uses `Main.K8s` through Freelens'
  connected cluster (`catalog-kube-reader.ts`); unit tests inject a fake.
- **Tunnel opener** is the only Kubernetes write-ish seam: `createKubectlTunnelOpener` runs
  `kubectl port-forward --address 127.0.0.1 pod/<pod> :<port>` with the kubectl and the environment
  Freelens itself uses for the cluster (`Main.Shell.getKubectlPath` / `getEnvironment`), so the tunnel
  goes through the Freelens proxy and honours the cluster's proxy settings. kubectl picks the local port;
  the tunnel is ready on its `Forwarding from` line. kubectl exits when the cluster disconnects, the
  session closes it on idle or close, and a Main-process exit hook kills any still running. Needs the
  `pods/portforward` permission, as `kubectl port-forward` does.
- Sessions are keyed by `(clusterId, targetId)`, idle-closed after 5 min, reopened once on `unreachable`.
- Manual credentials and the Write Mode set live only in `RabbitmqSessionManager` memory.

## Safety model

1. Renderer `WriteModeStore` is session-scoped and unpersisted; enabling it opens a `ConfirmDialog`.
2. The store calls `writeModeSet` so Main's gate is armed for that target.
3. Every mutating handler calls `assertWriteMode` first; a disarmed target yields `write-mode-disabled`.
4. Each mutating UI action confirms again with the concrete object name.
5. `peekMessages` hard-codes `ackmode: ack_requeue_true`, caps `count` at 50, truncates payloads at 64 KiB.
6. Replay (`replay.ts`) is copy-only: it publishes copies of dead-lettered messages and never takes
   the originals off the dead-letter queue. Main computes each destination from the message's own
   `x-death` headers (`planReplay` in `src/common/dead-letter.ts`), refuses truncated payloads,
   strips broker-managed headers (`x-death*`, delivery counts) and, when sending back to the failed
   queue, CC/BCC.

## Testing

- `vitest` unit tests colocated with the engine and UI helpers (fakes for `KubeReader`, `JsonHttpClient`,
  a fake-spawn kubectl for the tunnel opener).
- `test/e2e/integration.local.ts` runs the real HTTP client + normalisers against a Docker broker.
- `scripts/smoke-main.mjs` imports the built Main bundle with the host API stubbed (catches bundling errors).
