// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectionStore, useDeferredOpen, useResource, useSelectionParam, useStoredPageParam } from "./hooks";

import type { Renderer } from "@freelensapp/extensions";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

/** Minimal PageParam double: synchronous URL store, like the observable history in practice. */
function fakeParam(initial = "") {
  const store = { value: initial };
  const param = {
    get: () => store.value,
    set: (v: string) => {
      store.value = v;
    },
  } as unknown as Renderer.Navigation.PageParam<string>;
  return { param, store };
}

let container: HTMLDivElement;
let root: Root | undefined;

/** Renders into the one root of the test container, creating it on first use (React 19 has no legacy `render`). */
function render(element: ReactNode): void {
  root ??= createRoot(container);
  root.render(element);
}

function unmount(): void {
  root?.unmount();
  root = undefined;
}

// Tells React that the test drives updates through `act`, so it does not warn about them.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let latest: { value: string; set: (v: string) => void; renders: number };

function Probe({
  param,
  tick,
  store,
}: {
  param: Renderer.Navigation.PageParam<string>;
  tick: number;
  store: SelectionStore;
}) {
  const [value, set] = useSelectionParam("test.sel", param, store);
  latest = { value, set, renders: (latest?.renders ?? 0) + 1 };
  return <div data-tick={tick}>{value ? `open:${value}` : "closed"}</div>;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  act(() => unmount());
  container.remove();
});

describe("useSelectionParam", () => {
  let store: SelectionStore;
  beforeEach(() => {
    store = new SelectionStore();
  });

  it("survives a full unmount/remount of the page (route re-render) while the URL is empty", () => {
    const { param } = fakeParam();
    act(() => render(<Probe param={param} tick={0} store={store} />));
    act(() => latest.set("%2F/orders"));
    expect(container.textContent).toBe("open:%2F/orders");
    act(() => unmount());
    act(() => render(<Probe param={param} tick={1} store={store} />));
    expect(container.textContent).toBe("open:%2F/orders");
  });

  it("opens on set, survives a re-render where the URL param reads empty, closes on set('')", () => {
    const { param, store: url } = fakeParam();
    act(() => render(<Probe param={param} tick={0} store={store} />));
    expect(container.textContent).toBe("closed");

    act(() => latest.set("%2F/orders"));
    expect(container.textContent).toBe("open:%2F/orders");
    expect(url.value).toBe("");

    // Background refresh: parent re-renders; URL still has nothing for us.
    act(() => render(<Probe param={param} tick={1} store={store} />));
    expect(container.textContent).toBe("open:%2F/orders");

    act(() => latest.set(""));
    expect(container.textContent).toBe("closed");

    act(() => latest.set("%2F/other"));
    expect(container.textContent).toBe("open:%2F/other");
  });

  it("adopts a deep link present at mount and a later non-empty URL change; closing clears the URL", () => {
    const { param, store: url } = fakeParam("%2F/deep");
    act(() => render(<Probe param={param} tick={0} store={store} />));
    expect(container.textContent).toBe("open:%2F/deep");

    url.value = "%2F/navigated";
    act(() => render(<Probe param={param} tick={1} store={store} />));
    expect(container.textContent).toBe("open:%2F/navigated");

    act(() => latest.set(""));
    expect(container.textContent).toBe("closed");
    expect(url.value).toBe("");
  });

  it("opens even when the URL write is asynchronous or ignored", () => {
    const url = { value: "" };
    const param = { get: () => url.value, set: () => {} } as unknown as Renderer.Navigation.PageParam<string>;
    act(() => render(<Probe param={param} tick={0} store={store} />));
    act(() => latest.set("%2F/x"));
    expect(container.textContent).toBe("open:%2F/x");
    act(() => render(<Probe param={param} tick={1} store={store} />));
    expect(container.textContent).toBe("open:%2F/x");
  });
});

function OpenProbe({ open }: { open: boolean }) {
  return <div>{useDeferredOpen(open) ? "open" : "closed"}</div>;
}

let latestStored: { value: string; set: (v: string) => void };

function StoredProbe({ param, store }: { param: Renderer.Navigation.PageParam<string>; store: SelectionStore }) {
  const [value, set] = useStoredPageParam("target:test", param, store);
  latestStored = { value, set };
  return <div>{value || "none"}</div>;
}

describe("useStoredPageParam", () => {
  let store: SelectionStore;
  beforeEach(() => {
    store = new SelectionStore();
  });

  it("keeps the selected target across a sidebar navigation that carries no target (#26)", () => {
    // Clusters page opened target B explicitly: URL carries it.
    const first = fakeParam("b");
    act(() => render(<StoredProbe param={first.param} store={store} />));
    expect(container.textContent).toBe("b");
    // Sidebar entry: a new page mount whose URL param is empty (page defaults).
    act(() => unmount());
    const second = fakeParam("");
    act(() => render(<StoredProbe param={second.param} store={store} />));
    expect(container.textContent).toBe("b");
  });

  it("selecting a target writes both the URL and the session store; a later deep link wins", () => {
    const { param, store: url } = fakeParam("");
    act(() => render(<StoredProbe param={param} store={store} />));
    expect(container.textContent).toBe("none");
    act(() => latestStored.set("a"));
    expect(url.value).toBe("a");
    expect(store.get("target:test")).toBe("a");
    act(() => unmount());
    const deep = fakeParam("c");
    act(() => render(<StoredProbe param={deep.param} store={store} />));
    expect(container.textContent).toBe("c");
    expect(store.get("target:test")).toBe("c");
  });
});

let latestResource: { data?: number; loading: boolean; reload: () => void };

function ResourceProbe({ loader, refreshMs }: { loader: () => Promise<number>; refreshMs?: number }) {
  const res = useResource("queue:test", loader, { refreshMs });
  latestResource = res;
  return <div>{res.data === undefined ? "loading" : `messages:${res.data}`}</div>;
}

describe("useResource", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("polls when refreshMs is set, so a stale count after a purge corrects itself (#39)", async () => {
    // Broker statistics lag: the first two reads still report the old count, the third the real one.
    const counts = [5, 5, 0];
    const loader = vi.fn(() => Promise.resolve(counts[Math.min(loader.mock.calls.length - 1, counts.length - 1)]));
    act(() => render(<ResourceProbe loader={loader} refreshMs={5_000} />));
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toBe("messages:5");
    // The reload right after the purge lands inside the stale window.
    await act(async () => {
      latestResource.reload();
      await Promise.resolve();
    });
    expect(container.textContent).toBe("messages:5");
    // The next periodic refresh picks up the corrected statistics.
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(container.textContent).toBe("messages:0");
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it("keeps the previous data visible while a refresh is in flight", async () => {
    let resolveSecond: (n: number) => void = () => {};
    const loader = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(5)
      .mockImplementationOnce(() => new Promise((r) => (resolveSecond = r)));
    act(() => render(<ResourceProbe loader={loader} refreshMs={5_000} />));
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toBe("messages:5");
    act(() => vi.advanceTimersByTime(5_000));
    expect(latestResource.loading).toBe(true);
    expect(container.textContent).toBe("messages:5");
    await act(async () => {
      resolveSecond(0);
      await Promise.resolve();
    });
    expect(container.textContent).toBe("messages:0");
  });
});

describe("useDeferredOpen", () => {
  it("opens one tick after the flag flips, closes immediately", () => {
    vi.useFakeTimers();
    try {
      act(() => render(<OpenProbe open={false} />));
      expect(container.textContent).toBe("closed");
      act(() => render(<OpenProbe open={true} />));
      // Still closed within the same tick: the opening click can bubble to window harmlessly.
      expect(container.textContent).toBe("closed");
      act(() => {
        vi.runAllTimers();
      });
      expect(container.textContent).toBe("open");
      act(() => render(<OpenProbe open={false} />));
      expect(container.textContent).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });
});
