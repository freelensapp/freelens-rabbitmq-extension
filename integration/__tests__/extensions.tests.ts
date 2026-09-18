/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Runs inside the Freelens repository (copied there by integration-tests.yaml),
// so the helpers come from freelens/integration/helpers.

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { kindReady } from "../helpers/kind";
import * as utils from "../helpers/utils";

import type { ConsoleMessage, ElectronApplication, Frame, Page } from "playwright";

const EXTENSION_NAME = "@freelensapp/rabbitmq-extension";
const EXTENSION_ID = "freelensapp--rabbitmq-extension";
const TEST_KIND_CLUSTER_NAME = process.env.TEST_KIND_CLUSTER_NAME || "kind";
// Namespace that kindReady() is allowed to wipe. It must differ from the
// fixture namespace (rabbitmq-e2e) applied by the workflow.
const TEST_NAMESPACE = process.env.TEST_NAMESPACE || "integration-tests";
const FIXTURE_TARGET = "rabbitmq-e2e/rabbitmq";

const outputErrorPattern = /\[out\]\s*error:/i;
const ansiEscapePattern = /\u001b\[[0-9;]*m/g;

interface ErrorCollector {
  errorLogs: string[];
  processErrorLogs: string[];
  logger: (msg: ConsoleMessage) => void;
  restore: () => void;
}

// Mirrors the skeleton test: collects renderer console errors and main
// process "[out] error:" lines so a silent failure still fails the run.
function collectErrors(): ErrorCollector {
  const errorLogs: string[] = [];
  const processErrorLogs: string[] = [];
  let processOutputBuffer = "";

  const collectOutputErrors = (chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    processOutputBuffer += text;

    if (processOutputBuffer.length > 200_000) {
      processOutputBuffer = processOutputBuffer.slice(-20_000);
    }

    const normalizedOutput = processOutputBuffer.replaceAll(ansiEscapePattern, "");

    if (outputErrorPattern.test(normalizedOutput)) {
      processErrorLogs.push(normalizedOutput.trim());
      processOutputBuffer = "";
    }
  };

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk, encoding, cb) => {
    collectOutputErrors(chunk);

    return originalStdoutWrite(chunk, encoding as never, cb as never);
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk, encoding, cb) => {
    collectOutputErrors(chunk);

    return originalStderrWrite(chunk, encoding as never, cb as never);
  }) as typeof process.stderr.write;

  const logger = (msg: ConsoleMessage) => {
    const text = msg.text();
    const normalizedText = text.replaceAll(ansiEscapePattern, "");

    console.log(text);

    if (msg.type() === "error" || outputErrorPattern.test(normalizedText)) {
      errorLogs.push(`[${msg.type()}] ${normalizedText}`);
    }
  };

  return {
    errorLogs,
    processErrorLogs,
    logger,
    restore: () => {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    },
  };
}

async function installExtension(app: ElectronApplication, window: Page): Promise<void> {
  console.log("await utils.clickWelcomeButton");
  await utils.clickWelcomeButton(window);

  console.log("await app.evaluate (navigate to extensions)");
  await app.evaluate(async ({ app }) => {
    await app.applicationMenu
      ?.getMenuItemById(process.platform === "darwin" ? "mac" : "file")
      ?.submenu?.getMenuItemById("navigate-to-extensions")
      ?.click();
  });

  const textbox = window.getByPlaceholder("Name or file path or URL");
  console.log("await textbox.fill");
  await textbox.fill(process.env.EXTENSION_PATH || EXTENSION_NAME);
  const installButtonSelector = 'button[class*="Button install-module__button--"]';
  console.log("await window.click [data-waiting=false]");
  await window.click(installButtonSelector.concat("[data-waiting=false]"));

  console.log('await window.waitForSelector div[class*="installed-extensions-module__extensionName--"]');
  const installedExtensionName = await (
    await window.waitForSelector('div[class*="installed-extensions-module__extensionName--"]', { timeout: 120_000 })
  ).textContent();
  expect(installedExtensionName).toBe(EXTENSION_NAME);
  const installedExtensionState = await (
    await window.waitForSelector('div[class*="installed-extensions-module__enabled--"]', { timeout: 120_000 })
  ).textContent();
  expect(installedExtensionState).toBe("Enabled");

  // Dismiss notifications so one still in its enter animation does not
  // intercept pointer events on the elements behind it.
  console.log("dismiss notifications");
  const notificationCloseSelector =
    'i[data-testid*="close-notification-for-notification_"], div[class*="close-button-module__closeButton--"][aria-label="Close"]';
  for (let attempt = 0; attempt < 10; attempt++) {
    const closeButtons = await window.$$(notificationCloseSelector);
    if (closeButtons.length === 0) break;
    for (const closeButton of closeButtons) {
      await closeButton.click({ force: true }).catch(() => {});
    }
    await window.waitForTimeout(200);
  }
}

describe("extensions page tests", () => {
  let window: Page;
  let cleanup: undefined | (() => Promise<void>);
  let errors: ErrorCollector;

  beforeAll(async () => {
    let app: ElectronApplication;

    errors = collectErrors();
    ({ window, cleanup, app } = await utils.start());
    window.on("console", errors.logger);
    await installExtension(app, window);
  }, 120 * 1000);

  afterAll(
    async () => {
      // Keep listeners active through cleanup to catch late shutdown errors in CI logs.
      await cleanup?.();
      window.off("console", errors.logger);
      errors.restore();
      expect([...errors.errorLogs, ...errors.processErrorLogs]).toEqual([]);
    },
    10 * 60 * 1000,
  );

  it(
    "installs and enables the extension",
    async () => {
      expect([...errors.errorLogs, ...errors.processErrorLogs]).toEqual([]);
    },
    100 * 60 * 1000,
  );
});

// The cluster tests need a kind cluster with the fixture from
// integration/fixtures/rabbitmq applied (integration-tests.yaml does both).
const clusterDescribe = kindReady(TEST_KIND_CLUSTER_NAME, TEST_NAMESPACE) ? describe : describe.skip;

async function launchKindClusterFromCatalog(window: Page): Promise<Frame> {
  const catalogList = window.locator('[data-testid^="catalog-list-for-"]');
  await catalogList.waitFor({ state: "visible", timeout: 120_000 });

  const search = catalogList.getByPlaceholder("Search...");
  await search.fill(`kind-${TEST_KIND_CLUSTER_NAME}`);
  await window.waitForSelector(`div.TableCell >> text='kind-${TEST_KIND_CLUSTER_NAME}'`, { timeout: 120_000 });

  return utils.launchKindClusterFromCatalog(TEST_KIND_CLUSTER_NAME, window);
}

// Freelens 1.10.3, the version the workflow builds, has no clickSidebarItem
// helper: open the RabbitMQ group first when the child entry is collapsed.
async function openRabbitmqMenuItem(frame: Frame, menuId: string): Promise<void> {
  const item = frame.locator(`[data-testid="link-for-sidebar-item-${EXTENSION_ID}-${menuId}"]`);
  if (!(await item.isVisible())) {
    await frame.click(`[data-testid="link-for-sidebar-item-${EXTENSION_ID}-rabbitmq"]`);
  }
  await item.click();
}

clusterDescribe("RabbitMQ cluster pages", () => {
  let window: Page;
  let cleanup: undefined | (() => Promise<void>);
  let frame: Frame;
  let errors: ErrorCollector;

  beforeAll(
    async () => {
      let app: ElectronApplication;

      errors = collectErrors();
      ({ window, cleanup, app } = await utils.start());
      window.on("console", errors.logger);
      await installExtension(app, window);

      console.log("await launchKindClusterFromCatalog");
      frame = await launchKindClusterFromCatalog(window);
    },
    10 * 60 * 1000,
  );

  afterAll(
    async () => {
      await cleanup?.();
      window.off("console", errors.logger);
      errors.restore();
    },
    10 * 60 * 1000,
  );

  it(
    "discovers the fixture broker on the Clusters page",
    async () => {
      console.log("await openRabbitmqMenuItem rabbitmq-clusters");
      await openRabbitmqMenuItem(frame, "rabbitmq-clusters");

      const card = frame.locator(".RmqClusterCard", { hasText: FIXTURE_TARGET });
      await card.waitFor({ state: "visible", timeout: 120_000 });
      // jest expect, not the Playwright one: read the values and assert on them.
      expect((await card.locator(".RmqClusterName").textContent())?.trim()).toBe(FIXTURE_TARGET);
      // Credentials are resolved from the Secret referenced by the StatefulSet env.
      expect(await card.textContent()).toContain("Secret rabbitmq-e2e-auth");
    },
    5 * 60 * 1000,
  );

  it(
    "opens the Overview of the fixture broker through the port-forward",
    async () => {
      console.log("await openRabbitmqMenuItem rabbitmq-overview");
      await openRabbitmqMenuItem(frame, "rabbitmq-overview");

      // The Overview renders its metrics only after the session (credentials,
      // port-forward, Management API) is up; an error panel would render
      // .RmqErrorHead instead.
      const metrics = frame.locator(".RmqMetrics").first();
      await metrics.waitFor({ state: "visible", timeout: 180_000 });
      expect(await frame.locator(".RmqErrorHead").count()).toBe(0);
      // The header names the selected target and shows the Write Mode switch in its default state.
      const header = (await frame.locator(".RmqHeader").first().textContent()) ?? "";
      expect(header).toContain(FIXTURE_TARGET);
      expect(header).toContain("Read-only");
    },
    5 * 60 * 1000,
  );

  it(
    "keeps the renderer and the main process free of RabbitMQ errors",
    async () => {
      const rabbitmqErrors = [...errors.errorLogs, ...errors.processErrorLogs].filter((line) => /rabbitmq/i.test(line));
      expect(rabbitmqErrors).toEqual([]);
    },
    60 * 1000,
  );
});
