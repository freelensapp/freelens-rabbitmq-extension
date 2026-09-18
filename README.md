# @freelensapp/rabbitmq-extension

<!-- markdownlint-disable MD013 -->

[![Home](https://img.shields.io/badge/%F0%9F%8F%A0-freelens.app-02a7a0)](https://freelens.app)
[![GitHub](https://img.shields.io/github/stars/freelensapp/freelens-rabbitmq-extension?style=flat&label=GitHub%20%E2%AD%90)](https://github.com/freelensapp/freelens-rabbitmq-extension)
[![DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/freelensapp/freelens-rabbitmq-extension)
[![Release](https://img.shields.io/github/v/release/freelensapp/freelens-rabbitmq-extension?display_name=tag&sort=semver)](https://github.com/freelensapp/freelens-rabbitmq-extension/releases)
[![Unit tests](https://github.com/freelensapp/freelens-rabbitmq-extension/actions/workflows/unit-tests.yaml/badge.svg?branch=main)](https://github.com/freelensapp/freelens-rabbitmq-extension/actions/workflows/unit-tests.yaml)
[![Integration tests](https://github.com/freelensapp/freelens-rabbitmq-extension/actions/workflows/integration-tests.yaml/badge.svg?branch=main)](https://github.com/freelensapp/freelens-rabbitmq-extension/actions/workflows/integration-tests.yaml)
[![npm](https://img.shields.io/npm/v/@freelensapp/rabbitmq-extension.svg)](https://www.npmjs.com/package/@freelensapp/rabbitmq-extension)

<!-- markdownlint-enable MD013 -->

## Overview

[Freelens](https://freelens.app) extension for **RabbitMQ**: a cluster-native
RabbitMQ console inside the tool you already use for the cluster.

The extension discovers the RabbitMQ clusters running in the Kubernetes
cluster you are connected to, reads their credentials from the Secrets the
operator or the chart created, opens a port-forward to the Management API and
lets you inspect queues, exchanges, bindings, connections, channels,
consumers and messages, **read-only by default**. Everything lives in the
cluster sidebar under **RabbitMQ**: **Clusters**, **Overview**, **Queues**,
**Exchanges** and **Connections**.

![Queues](docs/screenshots/queues.png)

![Overview](docs/screenshots/overview.png)

The extension is modelled on the
[freelens-kafka-extension](https://github.com/freelensapp/freelens-kafka-extension)
architecture, tailored for RabbitMQ.

## Requirements

- **Freelens >= 1.8.0.** Verified on Freelens 1.10.3, the version the
  integration tests run against.
- **RabbitMQ management plugin** enabled on the brokers. It is included in
  the `*-management` images, in the RabbitMQ Cluster Operator and in the
  Bitnami chart.
- **Kubernetes access** through the kubeconfig Freelens uses for the
  cluster. Discovery reads `RabbitmqCluster` resources, Services, workloads
  and Secrets through the Freelens connection; the port-forward uses your
  kubeconfig context.
- **Node.js** is required only when building the extension from source; it
  is not needed to run it. The package is a self-contained bundle.

## Supported sources

<!-- markdownlint-disable MD013 -->

| Source | Found through | Credentials |
| --- | --- | --- |
| RabbitMQ Cluster Operator `RabbitmqCluster` resources | CRs and their client Service | The `<cluster>-default-user` Secret, the operator CA Secret for TLS listeners |
| In-cluster Services exposing the Management API (`15672`/`15671`) | Services next to AMQP (`5672`/`5671`): Bitnami charts, hand-rolled StatefulSets | The Secret referenced by `RABBITMQ_DEFAULT_USER/PASS` or `RABBITMQ_USERNAME/PASSWORD` on the workload |
| Any discovered target | The error panel of the target | Manual username and password, held in the Main process for the session only |

<!-- markdownlint-enable MD013 -->

Passwords are never sent to the renderer, never persisted and never logged.

## Installation

Install the extension from the Freelens **Extensions** page
(`ctrl`+`shift`+`E` or `cmd`+`shift`+`E`) by npm name:

```text
@freelensapp/rabbitmq-extension
```

Alternatively, download the `.tgz` from the
[GitHub releases](https://github.com/freelensapp/freelens-rabbitmq-extension/releases)
page and drag it into the Freelens window, or provide its path on the
Extensions page.

You can also build and pack the extension yourself, see
[Build from the source](#build-from-the-source).

## Getting started

1. Connect to a cluster in Freelens. A **RabbitMQ** entry appears in the
   cluster's left sidebar.
2. Open **Clusters**. It lists what discovery found, with provider, version,
   replicas, ports and credential source. Click **Open** on a target.
3. Browse **Overview**, **Queues**, **Exchanges** and **Connections**. Pick a
   different target from the header selector.
4. To peek at messages: open a queue, then the **Messages** tab, then
   **Peek**. Nothing is consumed.
5. To mutate: switch **Read-only** to **Write Mode** in the header, confirm,
   then use Purge, Delete or Publish. Write Mode resets whenever Freelens
   restarts.

If discovery finds the cluster but the credentials fail, the error panel
offers a username and password form.

## Features

- **Autodiscovery** of `RabbitmqCluster` resources (RabbitMQ Cluster
  Operator) and of plain Services exposing the Management API next to AMQP:
  Bitnami charts, hand-rolled StatefulSets.
- **Zero-config credentials** from the operator default user Secret or from
  the Secret the workload references in its environment. TLS management
  listeners use the operator CA Secret. Manual credentials can be entered per
  session.
- **Lightweight transport**: no AMQP client. A Kubernetes SPDY port-forward
  to one broker pod's management port plus a small JSON-over-HTTP client on
  Node's core `http`/`https`.
- **Views**
  - *Clusters*: every discovered target with provider, version, replicas,
    ports and credential source.
  - *Overview*: object totals, message rates, cluster and session facts,
    per-node memory, disk and file descriptor gauges and alarms.
  - *Queues*: sortable table (ready, unacked, total, consumers, publish and
    deliver rates, memory, features) with a detail drawer: definition,
    bindings, consumers and the **Message Inspector**.
  - *Exchanges*: table with publish in and out rates, drawer with outgoing
    and incoming bindings and a Publish form.
  - *Connections*: live tabs for connections, channels (prefetch, unacked,
    confirm and tx mode) and consumers.
- **Resizable columns**: drag the right edge of any table header to resize,
  double-click it to reset; widths are remembered per table.
- **Safety first**
  - Everything is read-only until you enable **Write Mode** for a target, a
    per-session switch with an explicit confirmation, enforced in the Main
    process (a disarmed target yields a `write-mode-disabled` error).
  - Message peeks always use `ackmode: ack_requeue_true`; nothing is consumed
    or lost. Peeked messages do get the `redelivered` flag, a Management API
    property.
  - Every mutating action (publish, purge, delete queue or exchange) asks for
    confirmation again with the concrete object name.
  - Lists are bounded and paginated (`page_size=500`, at most 5 000 objects);
    peeks are capped at 50 messages and 64 KiB per payload.

### How connectivity works

<!-- markdownlint-disable MD013 -->

```text
Renderer (React pages) ── IPC ──▶ Main (Node)
                                   ├─ discovery:  Main.K8s (Freelens cluster connection) → CRDs, Services, Workloads
                                   ├─ credentials: Secrets → username/password (+ CA)
                                   ├─ port-forward: @kubernetes/client-node SPDY → pod:15672 ⇄ 127.0.0.1:<random>
                                   └─ HTTP client: GET/POST/DELETE /api/... (Basic auth)
```

<!-- markdownlint-enable MD013 -->

One session (tunnel and client) per target, reused across pages, closed after
5 minutes idle and reopened transparently if the tunnel dies. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for the engine and the safety model.

## Limits

- The write operations are publish, purge and delete of queues and
  exchanges. Policies, users, vhosts and permissions are not managed.
- The Management API over TLS is verified only when a CA Secret is available;
  without one the certificate of the pod is accepted inside the port-forward.
- Brokers are reached through a port-forward to one Ready pod of the target,
  so a target without port-forwardable pods cannot be opened.

## Development

Node 24.15.0 (`.nvmrc`, `mise.toml`) and `corepack pnpm`. Run the local
gates after every change:

```sh
pnpm type:check
pnpm lint:check      # biome (lint:fix to auto-format)
pnpm trunk:check     # Markdown, YAML and the other formats
pnpm build           # electron-vite, then a Main bundle smoke test
pnpm knip:check
pnpm test:unit
```

Engine end-to-end against a real broker (Docker, no Kubernetes):

```sh
pnpm rabbitmq:up     # rabbitmq:4-management on 127.0.0.1:15672 (user e2e / e2e-password)
pnpm itest           # auth, overview, publish, list, peek, purge, delete
pnpm rabbitmq:down
```

The Playwright integration tests in [integration/](./integration) run in CI
inside a packaged Freelens on a kind cluster, against the disposable broker
from `integration/fixtures/rabbitmq`.

More about the repository:

- [ARCHITECTURE.md](./ARCHITECTURE.md): the two processes, the engine and
  the safety model.
- [CONTRIBUTING.md](./CONTRIBUTING.md): ground rules, pull requests and the
  release process.
- [CHANGELOG.md](./CHANGELOG.md): what each release adds and changes.
- [AGENTS.md](./AGENTS.md): the guide for coding agents.

## Build from the source

You can build the extension from this repository.

### Prerequisites

Use [NVM](https://github.com/nvm-sh/nvm),
[mise-en-place](https://mise.jdx.dev/), or
[windows-nvm](https://github.com/coreybutler/nvm-windows) to install the
required Node.js version.

From the root of this repository:

```sh
nvm install
# or
mise install
# or
winget install CoreyButler.NVMforWindows
nvm install 24.15.0
nvm use 24.15.0
```

Install pnpm:

```sh
corepack install
# or
curl -fsSL https://get.pnpm.io/install.sh | sh -
# or
winget install pnpm.pnpm
```

### Build extension

```sh
pnpm i
pnpm build
pnpm pack
```

One script to build and pack the extension for testing:

```sh
pnpm pack:dev
```

This bumps a throwaway prerelease version, builds, and writes a
`freelensapp-rabbitmq-extension-*.tgz` into the repo root. The version bump
makes Freelens treat each rebuild as an upgrade, so re-installing actually
reloads your changes.

### Install built extension

The tarball will be placed in the current directory. In Freelens, navigate
to the Extensions page (`ctrl`+`shift`+`E` or `cmd`+`shift`+`E`) and provide
the path to the tarball, or drag and drop the `.tgz` file into the Freelens
window. Enable it if prompted.

### Check code statically

```sh
pnpm lint:check
```

or

```sh
pnpm trunk:check
```

and

```sh
pnpm build
pnpm knip:check
```

### Testing the extension with unpublished Freelens

In the Freelens working repository:

```sh
rm -f *.tgz
pnpm i
pnpm build
pnpm pack -r
```

Then in the extension repository:

```sh
echo "overrides:" >> pnpm-workspace.yaml
for i in ../freelens/*.tgz; do
  name=$(tar zxOf $i package/package.json | yq -r .name)
  echo "  \"$name\": $i" >> pnpm-workspace.yaml
done

pnpm clean:node_modules
pnpm build
```

## License

Copyright (c) 2025-2026 Freelens Authors.

[MIT License](https://opensource.org/licenses/MIT)
