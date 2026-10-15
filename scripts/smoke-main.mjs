/**
 * Fast smoke test for the built Main bundle.
 *
 * Imports `dist/main.js` with the host API stubbed on `globalThis.FreelensExtensionApi`, to catch bundling
 * failures (a missing, ESM-only or optional-peer dependency, a CommonJS `require` left in the ESM bundle) that
 * make the Main process throw at load - the class of bug that yields a silent
 * "No handler registered" in Freelens. Unit tests cannot see this because they never load the bundled
 * dependencies.
 *
 * Runs at the end of `pnpm build`.
 */
import { fileURLToPath } from "node:url";

class Stub {}

globalThis.FreelensExtensionApi = {
  Common: {},
  Main: {
    LensExtension: Stub,
    Ipc: Stub,
    Catalog: { getAllClusters: () => [] },
    K8s: {},
  },
};

const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));

try {
  const mod = await import(entry);

  if (typeof mod.default !== "function") {
    throw new Error(`expected a default-exported extension class, got ${typeof mod.default}`);
  }

  console.log("smoke:main OK - Main bundle loads and exports an extension class");
} catch (error) {
  console.error("smoke:main FAILED - the Main bundle threw at load:\n", error?.stack ?? error);
  process.exit(1);
}
