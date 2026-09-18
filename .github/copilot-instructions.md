# Instructions for GitHub Copilot and other coding agents

The canonical agent guide for this repository is [AGENTS.md](../AGENTS.md)
in the repository root. Read it first and follow it strictly, in particular:

- the safety model: the extension is read-only by default, every mutating
  operation is gated by `assertWriteMode` in the Main process and confirmed
  in the UI, and message peeks never consume messages;
- the credentials rules: values come from Kubernetes Secrets or the manual
  form, stay in Main process memory, and are never sent to the renderer,
  logged or written to disk;
- the engine seams: `KubeReader` is the only Kubernetes read path and the
  `Forwarder` the only write-ish path, the Management API is reached only
  through the port-forward on `127.0.0.1`;
- the testing requirements: unit tests for every engine change, the Docker
  engine e2e, and the Playwright integration tests inside Freelens;
- the code style rules in AGENTS.md (biome, trunk, import order, no emoji).
