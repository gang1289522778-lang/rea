import { EventEmitter } from "node:events";

import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openBrowser: vi.fn(),
  storage: undefined as
    | {
        initialize: ReturnType<typeof vi.fn>;
        settle: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
      }
    | undefined,
  finishEvents: vi.fn(),
}));

vi.mock("./PlaywrightScenarioBrowser.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./PlaywrightScenarioBrowser.js")>()),
  openPlaywrightScenarioBrowser: mocks.openBrowser,
}));

vi.mock("./PlaywrightScenarioStorage.js", () => ({
  PlaywrightScenarioStorage: {
    create: vi.fn(async () => mocks.storage),
  },
}));

vi.mock("./PlaywrightScenarioEvents.js", () => ({
  PlaywrightScenarioEvents: class {
    finish() {
      mocks.finishEvents();
    }

    result() {
      return { events: [] };
    }

    limitations() {
      return [];
    }

    setStep() {}

    nextSequence() {
      return 1;
    }

    lastSequence() {
      return 0;
    }
  },
}));

import { browserScenarioSchema } from "../domain/browserScenario.js";
import { PlaywrightScenarioSession } from "./PlaywrightScenarioSession.js";
import { PlaywrightScenarioBrowserCleanupOwner } from "./PlaywrightScenarioBrowser.js";

const scenario = browserScenarioSchema.parse({
  browser: { mode: "launch", executable_path: process.execPath },
  start_url: { url: "https://storage.example.test/" },
  actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
  storage: {
    local_storage: [
      {
        origin: "https://storage.example.test",
        entries: [{ name: "seed", value: { source: "literal", value: "v" } }],
      },
    ],
  },
});

const fixture = () => {
  const page = Object.assign(new EventEmitter(), {
    url: () => "about:blank",
    goto: vi.fn(async () => undefined),
    evaluate: vi.fn(async (_script: unknown) => false),
    addInitScript: vi.fn(async (_script: unknown) => undefined),
    context: () => context,
  });
  const context = Object.assign(new EventEmitter(), {
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    addCookies: vi.fn(async () => undefined),
    browser: () => browser,
  });
  const browser = Object.assign(new EventEmitter(), {
    version: () => "Chrome 154",
  });
  let browserClosed = false;
  const close = vi.fn(async (finishEvents?: () => Promise<void>) => {
    await finishEvents?.();
    browserClosed = true;
  });
  const cleanup = {
    close,
    get browserClosed() {
      return browserClosed;
    },
  };
  const opened = {
    page,
    context,
    browser,
    cleanup,
    profilePath: "/tmp/profile",
  };
  mocks.openBrowser.mockResolvedValue(opened);
  mocks.storage = {
    initialize: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  return { cleanup, page, context, storage: mocks.storage, opened };
};

beforeEach(() => {
  vi.clearAllMocks();
});

it("finishes initialization cleanup independently of request cancellation", async () => {
  const { context, opened } = fixture();
  const controller = new AbortController();
  const closeBrowser = vi.fn(async () => undefined);
  const removeProfile = vi.fn(async () => undefined);
  mocks.openBrowser.mockResolvedValue({
    ...opened,
    cleanup: new PlaywrightScenarioBrowserCleanupOwner({
      closeBrowser,
      removeProfile,
    }),
  });
  context.addCookies.mockImplementationOnce(async () => {
    controller.abort();
  });
  const retainCleanup = vi.fn();

  await expect(
    PlaywrightScenarioSession.open(
      scenario,
      {},
      {
        signal: controller.signal,
        retainCleanup,
      },
    ),
  ).rejects.toMatchObject({ _tag: "AnalysisCancelledError" });
  expect(closeBrowser).toHaveBeenCalledTimes(1);
  expect(removeProfile).toHaveBeenCalledTimes(1);
  expect(retainCleanup).not.toHaveBeenCalled();
});

it("can retry cleanup of a browser that opened after request cancellation", async () => {
  const { opened } = fixture();
  const closeBrowser = vi
    .fn()
    .mockRejectedValueOnce(new Error("transport close failed"))
    .mockResolvedValueOnce(undefined);
  const removeProfile = vi.fn(async () => undefined);
  const lateOpened = {
    ...opened,
    cleanup: new PlaywrightScenarioBrowserCleanupOwner({
      closeBrowser,
      removeProfile,
    }),
  };
  let resolveOpening: ((value: typeof lateOpened) => void) | undefined;
  const opening = new Promise<typeof lateOpened>((resolve) => {
    resolveOpening = resolve;
  });
  mocks.openBrowser.mockReturnValueOnce(opening);
  const controller = new AbortController();
  const retained: (() => Promise<unknown>)[] = [];
  const result = PlaywrightScenarioSession.open(
    scenario,
    {},
    {
      signal: controller.signal,
      retainCleanup: (close) => retained.push(close),
    },
  );
  const cancelled = expect(result).rejects.toMatchObject({
    _tag: "AnalysisCancelledError",
  });
  controller.abort();
  await cancelled;
  resolveOpening?.(lateOpened);
  await vi.waitFor(() => expect(closeBrowser).toHaveBeenCalledTimes(1));
  expect(retained).toHaveLength(1);
  await expect(retained[0]?.()).resolves.toBeUndefined();
  expect(closeBrowser).toHaveBeenCalledTimes(2);
  expect(removeProfile).toHaveBeenCalledTimes(1);
});

it("uses browser disconnect as terminal storage release after detach failure", async () => {
  const { cleanup, storage } = fixture();
  const detachFailure = new Error("CDP detach rejected");
  storage.close.mockRejectedValueOnce(detachFailure);
  const session = await PlaywrightScenarioSession.open(scenario, {}, {});

  await expect(session.close()).resolves.toBe("terminated-owned-process");
  expect(storage.close).toHaveBeenCalledTimes(1);
  expect(cleanup.close).toHaveBeenCalledTimes(1);
  expect(mocks.finishEvents).toHaveBeenCalledTimes(1);
  await expect(session.close()).resolves.toBe("terminated-owned-process");
  expect(storage.close).toHaveBeenCalledTimes(1);
});

it("leaves attached service-worker state alone when the policy allows it", async () => {
  const { cleanup, page } = fixture();
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "allow" },
  });
  const session = await PlaywrightScenarioSession.open(attached, {}, {});

  expect(mocks.openBrowser).toHaveBeenCalledWith(
    attached,
    {},
    expect.any(Object),
  );
  expect(page.evaluate).not.toHaveBeenCalled();
  expect(page.addInitScript).not.toHaveBeenCalled();
  await expect(session.close()).resolves.toBe("disconnected-external");
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("blocks new attached service-worker registration without removing existing registrations", async () => {
  const { cleanup, page } = fixture();
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "block" },
  });
  const session = await PlaywrightScenarioSession.open(attached, {}, {});

  expect(page.evaluate).toHaveBeenCalledTimes(2);
  expect(page.addInitScript).toHaveBeenCalledTimes(1);
  expect(page.addInitScript).toHaveBeenCalledWith(
    expect.stringContaining("service workers are blocked by scenario policy"),
  );
  expect(page.addInitScript).toHaveBeenCalledWith(
    expect.not.stringContaining("getRegistrations"),
  );
  expect(page.addInitScript).toHaveBeenCalledWith(
    expect.not.stringContaining("unregister"),
  );
  await expect(session.close()).resolves.toBe("disconnected-external");
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("rejects attached block when caller-owned registrations already exist", async () => {
  const { cleanup, page } = fixture();
  page.evaluate.mockResolvedValueOnce(true);
  const attached = browserScenarioSchema.parse({
    ...scenario,
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "target",
    },
    environment: { service_workers: "block" },
  });

  await expect(
    PlaywrightScenarioSession.open(attached, {}, {}),
  ).rejects.toMatchObject({
    _tag: "BrowserObservationError",
    reason: "target_not_allowed",
  });
  expect(page.addInitScript).not.toHaveBeenCalled();
  expect(cleanup.close).toHaveBeenCalledTimes(1);
});

it("preserves both cleanup failures and retries retained owners", async () => {
  const { cleanup, storage } = fixture();
  const detachFailure = new Error("CDP detach rejected");
  const transportFailure = new Error("Playwright transport close failed");
  storage.close
    .mockRejectedValueOnce(detachFailure)
    .mockResolvedValueOnce(undefined);
  cleanup.close
    .mockRejectedValueOnce(transportFailure)
    .mockImplementationOnce(async (finishEvents?: () => Promise<void>) => {
      await finishEvents?.();
    });
  const session = await PlaywrightScenarioSession.open(scenario, {}, {});

  let failure: unknown;
  try {
    await session.close();
  } catch (cause: unknown) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([
    detachFailure,
    transportFailure,
  ]);
  expect(storage.close).toHaveBeenCalledTimes(1);
  expect(cleanup.close).toHaveBeenCalledTimes(1);

  await expect(session.close()).resolves.toBe("terminated-owned-process");
  expect(storage.close).toHaveBeenCalledTimes(2);
  expect(cleanup.close).toHaveBeenCalledTimes(2);
});
