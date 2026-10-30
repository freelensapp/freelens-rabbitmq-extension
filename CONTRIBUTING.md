# Contributing

Thanks for helping improve the Freelens RabbitMQ extension.

## Development setup

```sh
pnpm install
pnpm type:check && pnpm lint:check && pnpm knip:check && pnpm test:unit
pnpm build && pnpm pack   # `pnpm pack` does not build: build first, then write the .tgz to install in Freelens
pnpm pack:dev             # or both at once, with a throwaway prerelease version so Freelens reinstalls it
```

Run the engine against a real broker without Kubernetes:

```sh
pnpm rabbitmq:up && pnpm itest && pnpm rabbitmq:down
```

## Ground rules

- **Read-only by default.** Anything that mutates a broker (publish, purge, delete, policies…) must be gated by
  `RabbitmqSessionManager.assertWriteMode` in Main *and* confirmed in the UI. Message peeks always use
  `ackmode: ack_requeue_true`.
- **Secrets stay in Main.** Credential values are read from Kubernetes Secrets in the Main process and never sent
  to the renderer or written to disk.
- **No heavy clients.** The Management API is reached over the port-forward with Node's core `http`/`https`.
- **Bounded reads.** Lists are paginated and capped; add limits to any new endpoint.
- Keep engine modules pure where possible and colocate `*.test.ts`; UI hooks that touch React get jsdom tests
  (`src/renderer/hooks.test.tsx`).

## Pull requests

1. Branch from `main`; keep PRs focused. Plain, descriptive PR titles and commit messages, no
   Conventional Commits prefixes.
2. `pnpm biome:fix` and `pnpm trunk:fix` before committing; CI runs type check, lint (biome and
   trunk), knip, unit tests, the Playwright integration tests inside a packaged Freelens on kind,
   and the OSV scanner.
3. Add a line to `CHANGELOG.md`.
4. For UI changes attach a screenshot from Freelens.

## Releasing

Releases follow the freelensapp organization process, shared by every extension:

1. A maintainer runs the **Automated npm version** workflow (`npm-version.yaml`) choosing
   `patch`, `minor`, `major` or `prerelease`. It opens a pull request that bumps `version` in
   `package.json`.
2. The pull request is reviewed and merged.
3. A maintainer comments `/tag` on the merged pull request: the **Automated tag** workflow
   (`tag.yaml`) creates and pushes the `vX.Y.Z` tag, prerelease versions (`vX.Y.Z-N`) included.
4. The **Release** workflow (`release.yaml`) builds the extension, publishes
   `@freelensapp/rabbitmq-extension` to npm (Trusted Publishing with provenance, with
   `NPM_TOKEN` as fallback) and attaches the `.tgz`, its checksum and the SBOM to a GitHub
   Release. A version with a hyphen goes to the npm `next` dist-tag and its GitHub Release is
   marked as a prerelease, so users installing the package by name keep getting `latest`.

Do not push tags by hand and do not publish from a workstation.
