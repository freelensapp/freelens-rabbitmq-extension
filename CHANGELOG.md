# Changelog

## v0.4.0 - 2026-09-25

### Added

- **Health** page: runs read-only checks against the selected cluster and lists what needs attention, critical first, each with a link to the queue, channel or node concerned. It flags nodes that are down or partitioned, memory and disk alarms and the headroom before them, file descriptors, sockets and Erlang processes near their limits, crashed or minority queues, quorum queues with offline or too few replicas (replicas on a stopped node are counted in that node's finding, not warned per queue), backlogs with no consumers (dead-letter queues reported as info, streams skipped), growing backlogs, low consumer capacity, redeliveries, channels that stay full to their prefetch with no acks for five minutes or hold unacked messages without a prefetch limit, and unroutable publishes, dropped or returned. It refreshes every 15 seconds from the overview, queues and channels endpoints the other pages already use.
- Queue summaries carry the quorum and stream replica lists (`members`, `online`), and the overview carries the dropped unroutable rate (`drop_unroutable`) next to the returned one.
- **Clients** tab on the Connections page: groups the connections by the workload (Deployment, StatefulSet…) or the pod that opened them, busiest first, with each client's connections, share of the total, channels, client library, traffic and the age of its oldest connection. A client that holds most of the broker's connections, such as a leaking connection pool, stands out as one row instead of thousands. Peer addresses are matched to pod IPs through the Freelens cluster connection (a pod behind a ReplicaSet is reported as its Deployment); addresses that match no pod, and loopback addresses from a service-mesh sidecar, are labelled as such. A workload row opens exactly its pods, a pod row its connections.
- **Dead letters in the Message Inspector**: dead-letter headers (`x-death`, `x-first-death-*`) are decoded for every peeked message: the reason in plain words (rejected, expired, maxlen, delivery_limit), the queue it died in, how many times, the full history for messages that were dead-lettered more than once, and the exchange and routing key it was first published to. A summary above the messages counts them by reason and by queue, and the peeked messages can be searched (payload, routing key, properties, headers) and filtered by reason. Read-only; nothing changes on the broker.

### Changed

- Dependency updates via Renovate (Vite 8.3.1, sass 1.105, knip 6.38).

### Fixed

- The Overview **Unroutable** rate now includes publishes the broker dropped for matching no binding, not only mandatory publishes returned to the publisher; the common non-mandatory case was shown as zero.
- The Message Inspector no longer keeps the previous queue's peeked messages when the queue drawer switches to another queue.
- Tables that scroll sideways (a narrow window, or zoomed in) no longer cut their rows short: the row background, borders and header now continue under every column instead of stopping at the visible edge. The growing column (Name, Client...) is measured at its minimum width, so long names do not widen the rows.
- The queue drawer refreshes live at the same interval as the Queues table, so its message counts no longer stay stale after a purge and Ready, Unacked and the rates stay current while the drawer is open (#39, #41).
- The cluster card shows the Management API port number instead of the named tunnel port (`15672 (management)`), and the Overview **Ready** counter is highlighted only when messages are waiting and the broker has no consumers at all (#40, #42).

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
