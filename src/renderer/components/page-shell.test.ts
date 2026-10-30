import { describe, expect, it } from "vitest";
import { errorHint } from "./page-shell";

describe("errorHint", () => {
  it("points a port-forward denied by RBAC to the Kubernetes permission", () => {
    const hint = errorHint({
      code: "unreachable",
      message:
        'kubectl port-forward failed: pods "rabbitmq-0" is forbidden: User "system:serviceaccount:qa:viewer" cannot create resource "pods/portforward" in API group "" in the namespace "qa"',
    });
    expect(hint).toMatch(/pods\/portforward/);
    expect(hint).not.toMatch(/management plugin/);
  });

  it("keeps the management plugin hint for other unreachable errors", () => {
    const hint = errorHint({ code: "unreachable", message: "connect ECONNREFUSED 127.0.0.1:41234" });
    expect(hint).toMatch(/management plugin/);
  });
});
