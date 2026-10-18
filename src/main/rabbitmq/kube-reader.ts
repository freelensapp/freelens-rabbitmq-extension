/** A loosely-typed Kubernetes object — enough for discovery/credential parsing and easy to fixture. */
export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: { kind?: string; name?: string }[];
  };
  spec?: any;
  status?: any;
}

export interface KubeSecret extends KubeObject {
  type?: string;
  /** base64-encoded values, as returned by the API. */
  data?: Record<string, string>;
}

/** Identifies a custom resource type. */
export interface CustomResourceRef {
  group: string;
  version: string;
  plural: string;
  kind: string;
}

/**
 * Read-only Kubernetes access needed by discovery, pod resolution and credential resolution.
 * A seam: production uses Freelens's connected cluster (`catalog-kube-reader.ts`); unit tests inject a fake.
 */
export interface KubeReader {
  listCustomResources(ref: CustomResourceRef, namespace?: string): Promise<KubeObject[]>;
  /** Pods in `namespace`, or in every namespace when it is omitted. */
  listPods(namespace?: string, labelSelector?: string): Promise<KubeObject[]>;
  listServices(namespace?: string): Promise<KubeObject[]>;
  /** Deployments + StatefulSets (each tagged with its `kind`), for env-based credential discovery. */
  listWorkloads(namespace?: string): Promise<KubeObject[]>;
  getSecret(namespace: string, name: string): Promise<KubeSecret | null>;
}
