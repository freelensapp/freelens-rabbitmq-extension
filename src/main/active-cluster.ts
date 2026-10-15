import { Main } from "@freelensapp/extensions";

/** The id of the cluster the user is currently viewing (falls back to the first). */
export function activeClusterId(): string {
  const clusters = Main.Catalog.getAllClusters();
  const active = clusters.find((c) => c.isActive) ?? clusters[0];
  if (!active) throw new Error("no Kubernetes cluster is available");
  return active.id;
}
