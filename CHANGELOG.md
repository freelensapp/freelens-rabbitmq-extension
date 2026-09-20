# Changelog

## v0.3.1 - 2026-09-20

### Changed

- TypeScript 7. `moduleResolution=node10` is gone, so the Freelens core typings are now pinned through `tsconfig.json` `paths` (core's `exports` map has no `types` condition); `@freelensapp/core` is a devDependency for that reason only (#21, #33).

### Fixed

- Requests through the port-forward no longer time out when an idle keep-alive socket is reused: the HTTP client now opens a fresh connection per request, because the `@kubernetes/client-node` port-forward does not close the local socket when the pod closes the tunnel (#27).
- Discovery no longer lists the RabbitMQ Cluster Operator's own metrics Service as a cluster: Services labelled as operator components are skipped, and a Management port recognised only by its name now needs an AMQP port next to it (#25).
- Sidebar entries keep the selected RabbitMQ cluster: the target is remembered per Kubernetes cluster in the renderer session, so Queues, Exchanges and Connections no longer fall back to the first discovered cluster when opened from the sidebar (#26).

## v0.3.0 - 2026-09-19

### Changed

- The extension moved to the Freelens organisation. The npm package is now `@freelensapp/rabbitmq-extension` and the repository is `freelensapp/freelens-rabbitmq-extension`; the previous package `@tal-naeh/freelens-rabbitmq-extension` is deprecated and points here. Uninstall the old package in Freelens before installing the new one.
- CI, configuration and README aligned with the freelensapp extension standard, including integration tests that run the extension inside Freelens on a KinD cluster with a disposable RabbitMQ fixture.
- Dependency updates via Renovate (Vite 8.3, Vitest 4.1, Biome 2.5.14, pnpm 10.34.5 and others).

## 0.2.2

- Fix: Clusters page cards — name truncates with an ellipsis instead of wrapping, tags wrap inside the card, facts laid out as a grid; no more overlap/overflow.

## 0.2.1

- Fix: table cells that carried a tooltip `title` rendered the tooltip text instead of the value (Memory, Disk free, Client, Prefetch columns).
- Restore the full freelensapp workflow set (trunk, Renovate, osv-scanner, npm audit/dedupe) and add CONTRIBUTING.

## 0.2.0

First published release, as `@tal-naeh/freelens-rabbitmq-extension` on npm.

- Fix: detail drawers open reliably — the core Drawer treated the opening click itself as an outside click; drawers now open one tick later and opening clicks are marked handled.

- Fix: Cluster/vhost dropdown menus no longer render behind the sticky table header (portal z-index).

- Fix: queue/exchange detail drawers and the Connections tabs keep their state across background refreshes and page re-mounts (renderer-session SelectionStore; URL read only as a deep link, never written on open).

- Resizable table columns: drag a header cell's right edge, double-click it to reset; widths persist per table.

- Discovery of `RabbitmqCluster` CRs and Management-API Services (operator, Bitnami, generic).
- Credential resolution from operator default-user Secrets and workload env Secret refs; manual override.
- SPDY port-forward to a Ready broker pod + core-Node HTTP client for the Management API.
- Pages: Clusters, Overview (totals, rates, nodes), Queues (+ detail drawer, bindings, consumers, Message
  Inspector with `ack_requeue_true`), Exchanges (+ bindings, publish), Connections/Channels/Consumers.
- Session-scoped, confirmed Write Mode gating publish / purge / delete; enforced in Main.
- Unit tests for the engine and UI helpers; Docker e2e harness verified against RabbitMQ 4.3.5.
