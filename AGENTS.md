# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

> **Tip**: If you find yourself correcting the agent during interactive work, suggest adding a new rule to this file so the lesson is captured for future sessions.

## Project Overview

Freelens extension for RabbitMQ: a cluster-native RabbitMQ console. It discovers
RabbitMQ brokers in the connected Kubernetes cluster (RabbitMQ Cluster Operator
`RabbitmqCluster` resources, Bitnami charts, hand-rolled StatefulSets exposing the
Management API), opens a port-forward from the Freelens main process and renders
overview, queues, exchanges, connections and messages through the Management API.

- **Language**: TypeScript 5.x
- **Runtime**: Node.js >= 22.0.0, Freelens >= 1.8.0
- **Package manager**: pnpm 10.x (locked)
- **License**: MIT
- **npm package**: `@freelensapp/rabbitmq-extension`

## Common Commands

```bash
# Type checking
pnpm type:check

# Linting & formatting
pnpm biome:check          # TypeScript/TSX, JS, JSON, CSS/SCSS (biome)
pnpm biome:fix            # Auto-fix the formats above
pnpm trunk:check          # Markdown, YAML, TOML, and other formats not covered by biome
pnpm trunk:fix            # Auto-fix Markdown, YAML, etc.
pnpm lint:check           # Alias for biome:check
pnpm lint:fix             # Alias for biome:fix
pnpm knip:check           # Unused files, exports and dependencies

# Tests
pnpm test:unit            # vitest, colocated *.test.ts(x)
pnpm rabbitmq:up && pnpm itest && pnpm rabbitmq:down
                          # engine e2e against a real broker in Docker (no Kubernetes)

# Build
pnpm build                # Type check + electron-vite + Main bundle smoke test
pnpm build:production     # Production build (no preserveModules)
pnpm smoke:main           # Load the built Main bundle with host globals stubbed

# Pack for testing
pnpm pack:dev             # Bump prerelease version, build, and create .tgz for install in Freelens app

# Clean
pnpm clean                # Clean out/
pnpm clean:dts            # Remove generated *.d.scss.ts files
pnpm clean:all            # Clean everything (dts, node_modules, out, tgz)
```

## Architecture

Two processes, as every Freelens extension. See `ARCHITECTURE.md` for the engine diagram
and the safety model; the summary:

```text
src/
  common/                  # IPC channel names and DTOs, typed errors, constants, target ids
  main/index.ts            # Main process entry point
  main/ipc.ts              # One IPC handler per channel, delegates to the engine
  main/rabbitmq/           # Engine: discovery, credentials, pod resolver, port-forward,
                           # management client, http, normalize, session manager
  main/catalog-kube-reader.ts   # Kubernetes reads through Main.K8s (the only read seam)
  main/kubeconfig-resolver.ts   # Finds the user's kubeconfig for the port-forward
  renderer/index.tsx       # Renderer entry point: cluster pages and sidebar menus
  renderer/pages/          # Clusters, Overview, Queues, Exchanges, Connections, details
  renderer/components/     # Page shell, target selector, resizable columns, errors
  renderer/ipc-client.ts   # The only way the renderer talks to Main
  renderer/write-mode-store.ts  # Session-scoped, unpersisted Write Mode flag
test/e2e/                  # Docker broker fixture and engine e2e script
integration/               # Playwright tests and kind fixture run inside Freelens by CI
```

Build output goes to `out/`.

### Engine rules

- `KubeReader` (`catalog-kube-reader.ts`) is the only Kubernetes read seam; the
  `Forwarder` (`kube-forwarder.ts`, `@kubernetes/client-node` PortForward) is the only
  write-ish seam. Do not add other Kubernetes clients.
- The Management API is reached only through the port-forward tunnel on `127.0.0.1`,
  with Node core `http`/`https`. No heavy HTTP clients.
- Sessions are keyed by `(clusterId, targetId)`, idle-closed after 5 minutes.
- Lists are paginated and capped (`RABBITMQ_LIST_PAGE_SIZE`, `RABBITMQ_LIST_MAX_ITEMS`).
  Add limits to any new endpoint.
- Message peeks always use `ackmode: ack_requeue_true`, at most `RABBITMQ_PEEK_MAX_COUNT`
  messages, payloads truncated at `RABBITMQ_PEEK_TRUNCATE_BYTES`.

### Safety model (read-only by default)

- Every mutating handler in `src/main/ipc.ts` calls `assertWriteMode` first. A disarmed
  target yields `write-mode-disabled`.
- Enabling Write Mode in the renderer opens a confirm dialog, and each destructive action
  (publish, purge, delete) confirms again with the concrete object name.
- Never bypass or weaken these gates. New mutating operations need both the Main gate
  and the UI confirmation, plus unit tests for the disarmed path.

### Credentials

- Credential values come from Kubernetes Secrets or from the manual credentials form,
  are resolved in the Main process and live only in `RabbitmqSessionManager` memory.
- They are never sent to the renderer, never written to disk or `localStorage`, never
  logged. Error messages must not include them.
- TLS to the Management API is verified when a CA Secret is available; keep it that way.

## Key Dependencies (provided by Freelens host at runtime)

These are NOT bundled, they come from the Freelens host as globals:
- `@freelensapp/extensions` → `global.LensExtensions`
- `mobx` → `global.Mobx`
- `react` → `global.React`
- `react-dom` → `global.ReactDom`
- `mobx-react` → `global.MobxReact`
- `react-router-dom` → `global.ReactRouterDom`

Other dependencies ARE bundled into the extension output (`@kubernetes/client-node` is
bundled into the Main bundle).

## Code Style

- **Biome** formats **TypeScript/TSX, JS, JSON, CSS/SCSS**: double quotes, semicolons, trailing commas, 2-space indent, 120 char line width — use `pnpm biome:fix`
- **Trunk** formats **Markdown, YAML**, and other formats not covered by biome — use `pnpm trunk:fix`
- Import order (enforced by biome organizeImports): built-in modules → `@freelensapp/**` → packages → relative paths
- Keep engine modules pure where possible and colocate `*.test.ts`; UI hooks that touch React get jsdom tests with the `// @vitest-environment jsdom` pragma
- **No emoji** in Markdown files (`.md`), comments, or any source code

## Security

Never read, display, reference, or include the contents of the following files in any response or context, even if they are open in the editor:

- `.env`
- `.env.*`
- `.npmrc`
- `*.jks`
- `*.keystore`
- `*.p12`
- `*.pfx`
- `*.pem`
- `*.key`

## Electron Multi-Process

Extensions run in the same multi-process model as the Freelens host:

- **Main process** (`src/main/`) — Node.js environment, extension lifecycle, cluster connectivity, port-forward and Management API client
- **Renderer process** (`src/renderer/`) — Chromium browser, UI components

Code in `src/common/` is shared between both processes. The renderer never talks to Kubernetes or to RabbitMQ directly.

## Testing

- **Unit** (`pnpm test:unit`): vitest, fakes for `KubeReader`, `JsonHttpClient` and a TCP-pipe `Forwarder`. Every engine change ships with unit tests, including the failure and disarmed paths.
- **Engine e2e** (`pnpm rabbitmq:up && pnpm itest && pnpm rabbitmq:down`): the real HTTP client and normalisers against a Docker broker (`test/e2e/docker-compose.yml`).
- **Bundle smoke** (`pnpm smoke:main`, part of `pnpm build`): loads the built Main bundle with host globals stubbed.
- **Integration inside Freelens** (`integration/__tests__/`): Playwright tests run by CI inside a packaged Freelens on a kind cluster, with the disposable broker from `integration/fixtures/rabbitmq/`. They install the packed extension and check the RabbitMQ pages against the fixture.

Run unit tests, type check, lint and the engine e2e before opening a pull request. For UI changes, verify in Freelens with `pnpm pack:dev` and attach a screenshot.

## Troubleshooting

### Changes Not Appearing

1. Check that files are not in ignored output directories (`out/`, `dist/`, `node_modules/`)
2. Full clean and rebuild: `pnpm clean:all && pnpm build`
3. Reinstall the extension in Freelens (or restart the app in dev mode)

### Build Failures

1. Check for TypeScript errors: `pnpm type:check`
2. Check for linting errors: `pnpm lint:check`
3. Verify dependencies: `pnpm install`
4. Check Node.js version matches the `engines` field in `package.json`

### Runtime Errors

1. Open Freelens DevTools and check the Console tab for renderer errors
2. Check the terminal where Freelens was launched for main process errors
3. Look for stack traces with file:line numbers
4. `Management API unreachable through the tunnel`: the port-forward pod is not Ready or the Management plugin is not enabled on the broker
5. Validate both with `pnpm type:check` **and** `pnpm build` — runtime failures can appear only in bundled `out/` code

## Best Practices

1. **Use semantic search** to find examples and patterns in the codebase
2. **Follow existing patterns** — grep for similar implementations before creating new ones
3. **Test changes** before committing
4. **Run validation before committing:** `pnpm lint:fix && pnpm type:check && pnpm test:unit`
5. **For TypeScript/TSX, JS, JSON, CSS/SCSS files:** run `pnpm biome:fix` (or `biome check` directly if `biome` is installed locally)
6. **For Markdown, YAML, and other formats:** run `pnpm trunk:fix` (or `trunk check` directly if `trunk` is installed locally)
7. **Full build** when in doubt about cached state: `pnpm clean:all && pnpm build`
8. **Do not use Anthropic Fable for coding tasks** — Fable may be used only for planning,
   analysis, and thinking through problems. When writing or editing code,
   use standard editing tools instead.

## GitHub Actions (Claude Code Action) Rules

This project has a Claude Code workflow (`.github/workflows/claude.yaml`) triggered
via `@claude` comments on issues, PR comments, and reviews. When operating via that
workflow, follow these rules:

### Code Review

When reviewing code and proposing fixes:

1. **Show the diff first** — present every proposed change as a unified diff
   block using the `diff` language tag:

   ```diff
   --- a/path/to/file.ts
   +++ b/path/to/file.ts
   @@ -10,7 +10,7 @@
    const oldLine = "before";
   -const changedLine = "after";
   +const changedLine = "the fix";
    const unchangedLine = "same";
   ```

   You can generate this from the terminal with:
   ```bash
   git diff -u -- path/to/file
   ```

   If the change spans multiple files, group them under a single commit
   subject and show each file's diff sequentially.

2. **Propose a commit subject first** — before any code change, output a
   single line with the proposed commit subject:

   ```text
   **Proposed commit:** <short description>
   ```

   Do **not** use Conventional Commits prefixes (e.g. `fix:`, `feat:`,
   `chore:`, `refactor:`, `docs:`, `test:`, `ci:`). This project prefers
   plain, descriptive commit messages and PR titles without any prefix.

   Wait for the user to confirm (or adjust) the subject before applying the
   change.

3. **Comment style:**
   - Keep review comments concise and actionable
   - Reference specific lines (file + line number) when pointing out issues
   - Offer a concrete fix suggestion rather than just flagging a problem
   - Do **not** use emoji in any Markdown, comments, commit messages, or
     PR descriptions. The only exception is emoji that already appears
     inside code strings (e.g. application logs, user-facing messages).
   - Use GitHub's `suggestion` block for small targeted fixes so the PR
     author can accept the change with a single click:

     ````suggestion
     <same unified-diff format as shown above>
     ````

   - For larger multi-file changes, use `diff -u` blocks in a regular
     comment instead, with the proposed commit subject shown first

### Making Changes to a PR

When asked to implement a change on a PR:

1. Propose the commit subject (as above)
2. Describe what will change and why
3. After confirmation, apply the changes with commits on the PR branch
4. **One commit per fix** — when a review surfaces more than one issue or
   the plan includes more than one fix, apply and commit each fix
   separately. Do not batch multiple independent fixes into a single
   commit. This keeps the history bisectable and makes each change easy
   to revert individually.

### Branch Naming Conventions

When creating a branch from an issue, use a human-readable name that includes
the issue number and a short slug derived from the issue title:

```text
claude/issue-<number>-<short-slug>
```

- `<number>` is the GitHub issue number
- `<short-slug>` is a kebab-case summary of the issue title, kept short
  (3–6 words maximum, omit articles and filler words)

Do **not** use auto-generated timestamp suffixes (e.g.
`claude/issue-1957-20260612-2108`) — these are not human-readable and make
branch lists hard to scan.
