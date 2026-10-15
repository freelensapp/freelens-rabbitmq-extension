import { type Common, Renderer } from "@freelensapp/extensions";
import { withPageErrorBoundary } from "./components/error-boundary";
import { TargetCache } from "./components/target-selection";
import { RabbitmqIcon } from "./icon";
import { RabbitmqIpcRenderer } from "./ipc-client";
import { RABBITMQ_CLUSTER_MENU_MANIFEST, RABBITMQ_CLUSTER_PAGE_MANIFEST, type RabbitmqPageId } from "./navigation";
import { ClustersPage } from "./pages/clusters-page";
import { ConnectionsPage } from "./pages/connections-page";
import { ExchangesPage } from "./pages/exchanges-page";
import { HealthPage } from "./pages/health-page";
import { OverviewPage } from "./pages/overview-page";
import { QueuesPage } from "./pages/queues-page";
import { WriteModeStore } from "./write-mode-store";
import "./styles.scss";

import type { PageDeps } from "./pages/page-deps";

export default class RabbitmqExtensionRenderer extends Renderer.LensExtension {
  private readonly cache = new TargetCache();
  private readonly writeMode = new WriteModeStore((targetId, enabled) =>
    this.client.writeModeSet({ clusterId: this.clusterId, targetId, enabled }),
  );

  private get client(): RabbitmqIpcRenderer {
    return RabbitmqIpcRenderer.createInstance(this);
  }

  /** Id of the cluster this frame is showing, so Main queries the right connected cluster. */
  private get clusterId(): string | undefined {
    return Renderer.Catalog.getActiveCluster()?.id;
  }

  private get deps(): PageDeps {
    return {
      kubernetesClusterId: this.clusterId,
      client: this.client,
      cache: this.cache,
      writeMode: this.writeMode,
      navigate: (pageId: RabbitmqPageId, params?: Record<string, string>) => {
        void this.navigate(pageId, params);
      },
    };
  }

  // Every page renders inside an error boundary, so an error it throws stays in the page instead of replacing the
  // cluster view. The host renders a page with `params` only; the extension's dependencies come from here.
  clusterPages: Renderer.LensExtension["clusterPages"] = [
    {
      ...RABBITMQ_CLUSTER_PAGE_MANIFEST[0],
      components: {
        Page: ({ params }: Common.Types.PageComponentProps) => (
          <ClustersPage {...this.deps} params={{ query: params.query }} />
        ),
      },
    },
    {
      ...RABBITMQ_CLUSTER_PAGE_MANIFEST[1],
      components: {
        Page: ({ params }: Common.Types.PageComponentProps) => (
          <OverviewPage {...this.deps} params={{ target: params.target }} />
        ),
      },
    },
    {
      ...RABBITMQ_CLUSTER_PAGE_MANIFEST[2],
      components: {
        Page: ({ params }: Common.Types.PageComponentProps) => (
          <QueuesPage
            {...this.deps}
            params={{
              target: params.target,
              vhost: params.vhost,
              query: params.query,
              queue: params.queue,
              view: params.view,
            }}
          />
        ),
      },
    },
    {
      ...RABBITMQ_CLUSTER_PAGE_MANIFEST[3],
      components: {
        Page: ({ params }: Common.Types.PageComponentProps) => (
          <ExchangesPage
            {...this.deps}
            params={{ target: params.target, vhost: params.vhost, query: params.query, exchange: params.exchange }}
          />
        ),
      },
    },
    {
      ...RABBITMQ_CLUSTER_PAGE_MANIFEST[4],
      components: {
        Page: ({ params }: Common.Types.PageComponentProps) => (
          <ConnectionsPage {...this.deps} params={{ target: params.target, query: params.query, view: params.view }} />
        ),
      },
    },
    {
      ...RABBITMQ_CLUSTER_PAGE_MANIFEST[5],
      components: {
        Page: ({ params }: Common.Types.PageComponentProps) => (
          <HealthPage {...this.deps} params={{ target: params.target }} />
        ),
      },
    },
  ].map((registration) => withPageErrorBoundary(this, registration));

  clusterPageMenus = RABBITMQ_CLUSTER_MENU_MANIFEST.map(({ pageId, ...menu }, index) => ({
    ...menu,
    target: { pageId },
    components: index === 0 ? { Icon: RabbitmqIcon } : {},
  }));
}
