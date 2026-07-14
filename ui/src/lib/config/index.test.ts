// Control UI tests cover config behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSchemaResponse, ConfigSnapshot } from "../../api/types.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createRuntimeConfigCapability,
  findAgentConfigEntryIndex,
} from "./index.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createGatewayHarness(client: GatewayBrowserClient) {
  let snapshot = { client, connected: true, sessionKey: "main" };
  const listeners = new Set<(next: typeof snapshot) => void>();
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    publish: (connected: boolean) => {
      snapshot = { client, connected, sessionKey: "main" };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Simple hash-tracking config.get/config.set/config.apply mock gateway. */
function createConfigServerMock() {
  let hashCounter = 1;
  let storedRaw = '{\n  "count": 1\n}\n';
  const submissions: Array<{ method: string; raw: string; baseHash: string }> = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.get") {
      return {
        config: JSON.parse(storedRaw) as Record<string, unknown>,
        raw: storedRaw,
        hash: `hash-${hashCounter}`,
        valid: true,
        issues: [],
      };
    }
    if (method === "config.set" || method === "config.apply") {
      const { raw, baseHash } = params as { raw: string; baseHash: string };
      submissions.push({ method, raw, baseHash });
      storedRaw = raw;
      hashCounter += 1;
      return {};
    }
    return {};
  });
  return { request, submissions, currentHash: () => `hash-${hashCounter}` };
}

/** Map-backed localStorage stub; node/jsdom test envs lack a stable one. */
function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  });
  return store;
}

describe("createRuntimeConfigCapability", () => {
  it("preserves a dirty draft and its original base hash across refreshes", async () => {
    let getCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "config.get") {
        return {};
      }
      getCount += 1;
      return getCount === 1
        ? { config: { count: 1 }, hash: "hash-1", valid: true, issues: [], raw: '{"count":1}' }
        : { config: { count: 3 }, hash: "hash-2", valid: true, issues: [], raw: '{"count":3}' };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);

    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["count"], 2);
    await runtimeConfig.refresh();

    expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-1");
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");

    await runtimeConfig.refresh({ discardPendingChanges: true });
    expect(runtimeConfig.state.configForm).toEqual({ count: 3 });
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configDraftBaseHash).toBe("hash-2");
    runtimeConfig.dispose();
  });

  it("serializes schema-coerced form values with the draft base hash", async () => {
    const submitted: Array<{ method: string; params: unknown }> = [];
    let configGetCount = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        configGetCount += 1;
        return {
          config: configGetCount === 1 ? { count: 1, enabled: false, tags: [1], label: "ok" } : {},
          hash: configGetCount === 1 ? "hash-1" : "hash-2",
          valid: true,
          issues: [],
        };
      }
      if (method === "config.schema") {
        return {
          schema: {
            type: "object",
            properties: {
              count: { type: "number" },
              enabled: { type: "boolean" },
              tags: { type: "array", items: { type: "integer" } },
              label: { type: "string", minLength: 1 },
            },
          },
          uiHints: {},
        };
      }
      submitted.push({ method, params });
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);

    await Promise.all([runtimeConfig.ensureLoaded(), runtimeConfig.ensureSchemaLoaded()]);
    runtimeConfig.patchForm(["count"], "42.5");
    runtimeConfig.patchForm(["enabled"], "true");
    runtimeConfig.patchForm(["tags"], ["7", ""]);
    runtimeConfig.patchForm(["label"], "");

    await expect(runtimeConfig.save()).resolves.toBe(true);
    const submission = submitted.find((entry) => entry.method === "config.set");
    expect(submission?.params).toMatchObject({ baseHash: "hash-1" });
    const raw = (submission?.params as { raw?: unknown } | undefined)?.raw;
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw as string)).toEqual({ count: 42.5, enabled: true, tags: [7] });
    runtimeConfig.dispose();
  });

  it("stages inherited agent overrides and the default through the public capability", async () => {
    const request = vi.fn(async (method: string) =>
      method === "config.get"
        ? {
            config: { agents: { list: [{ id: "main" }, { id: "reviewer" }] } },
            hash: "hash-1",
            valid: true,
            issues: [],
          }
        : {},
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    await runtimeConfig.ensureLoaded();

    expect(runtimeConfig.ensureAgentEntry("new-agent")).toBe(2);
    expect(runtimeConfig.stageDefaultAgent("reviewer")).toBe(true);
    expect(runtimeConfig.state.configForm).toMatchObject({
      agents: {
        list: [{ id: "main" }, { id: "reviewer", default: true }, { id: "new-agent" }],
      },
    });
    runtimeConfig.dispose();
  });

  it("copies the config path when opening the file fails", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return {
          config: {},
          hash: "hash-1",
          path: "/tmp/openclaw.json",
          valid: true,
          issues: [],
        };
      }
      if (method === "config.openFile") {
        return { ok: false, error: "not supported", path: "/tmp/openclaw.json" };
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    await runtimeConfig.ensureLoaded();

    await runtimeConfig.openFile();
    expect(writeText).toHaveBeenCalledWith("/tmp/openclaw.json");
    expect(runtimeConfig.state.lastError).toContain("File path copied to clipboard");
    runtimeConfig.dispose();
  });

  it("ignores a save completion from an earlier connection epoch", async () => {
    const save = deferred<unknown>();
    let getCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "config.get") {
        getCount += 1;
        return Promise.resolve({
          config: { value: getCount },
          hash: `hash-${getCount}`,
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set") {
        return save.promise;
      }
      return Promise.resolve({});
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["value"], 2);

    const staleSave = runtimeConfig.save();
    publish(false);
    publish(true);
    save.resolve({});

    await expect(staleSave).resolves.toBe(false);
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configSaving).toBe(false);
    runtimeConfig.dispose();
  });

  it("rejects stale config and schema work after reconnecting the same client", async () => {
    const firstConfig = deferred<ConfigSnapshot>();
    const secondConfig = deferred<ConfigSnapshot>();
    const firstSchema = deferred<ConfigSchemaResponse>();
    const secondSchema = deferred<ConfigSchemaResponse>();
    const configRequests = [firstConfig, secondConfig];
    const schemaRequests = [firstSchema, secondSchema];
    const request = vi.fn((method: string) => {
      const pending = method === "config.get" ? configRequests.shift() : schemaRequests.shift();
      if (!pending) {
        throw new Error(`unexpected request: ${method}`);
      }
      return pending.promise;
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const runtimeConfig = createRuntimeConfigCapability(gateway);

    const staleConfigLoad = runtimeConfig.ensureLoaded();
    const staleSchemaLoad = runtimeConfig.ensureSchemaLoaded();
    publish(false);
    publish(true);
    const currentConfigLoad = runtimeConfig.ensureLoaded();
    const currentSchemaLoad = runtimeConfig.ensureSchemaLoaded();

    firstConfig.resolve({ config: { source: "stale" }, valid: true, issues: [], raw: "{}" });
    firstSchema.reject(new Error("stale schema failure"));
    await Promise.all([staleConfigLoad, staleSchemaLoad]);

    expect(runtimeConfig.state.configSnapshot).toBeNull();
    expect(runtimeConfig.state.configSchema).toBeNull();
    expect(runtimeConfig.state.lastError).toBeNull();
    expect(runtimeConfig.state.configLoading).toBe(true);
    expect(runtimeConfig.state.configSchemaLoading).toBe(true);

    secondConfig.resolve({ config: { source: "current" }, valid: true, issues: [], raw: "{}" });
    secondSchema.resolve({
      schema: { type: "object" },
      uiHints: {},
      version: "current",
      generatedAt: "2026-07-09T00:00:00.000Z",
    });
    await Promise.all([currentConfigLoad, currentSchemaLoad]);

    expect(runtimeConfig.state.configSnapshot?.config).toEqual({ source: "current" });
    expect(runtimeConfig.state.configSchema).toEqual({ type: "object" });
    expect(runtimeConfig.state.configSchemaVersion).toBe("current");
    expect(runtimeConfig.state.configLoading).toBe(false);
    expect(runtimeConfig.state.configSchemaLoading).toBe(false);
    runtimeConfig.dispose();
  });
});

describe("config form auto-save", () => {
  function createHarness(request: GatewayBrowserClient["request"]) {
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    return { runtimeConfig: createRuntimeConfigCapability(gateway), publish };
  }

  it("debounces form edits into one config.set and marks needsApply", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    runtimeConfig.patchForm(["count"], 3);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS - 1);
    expect(server.submissions).toHaveLength(0);
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");

    await vi.advanceTimersByTimeAsync(1);
    expect(server.submissions).toEqual([
      { method: "config.set", raw: '{\n  "count": 3\n}\n', baseHash: "hash-1" },
    ]);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    expect(runtimeConfig.state.configNeedsApply).toBe(true);
    // The post-save reload rebased the clean draft onto the new hash.
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");
    runtimeConfig.dispose();
  });

  it("keeps mid-flight edits dirty and queues exactly one trailing save", async () => {
    vi.useFakeTimers();
    const firstSet = deferred<unknown>();
    let hashCounter = 1;
    let storedRaw = '{\n  "count": 1\n}\n';
    const submissions: Array<{ raw: string; baseHash: string }> = [];
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "config.get") {
        return Promise.resolve({
          config: JSON.parse(storedRaw) as Record<string, unknown>,
          raw: storedRaw,
          hash: `hash-${hashCounter}`,
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set") {
        const { raw, baseHash } = params as { raw: string; baseHash: string };
        submissions.push({ raw, baseHash });
        storedRaw = raw;
        hashCounter += 1;
        return submissions.length === 1 ? firstSet.promise : Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saving");

    // Edits during the in-flight save stay dirty and fold into one trailing save.
    runtimeConfig.patchForm(["count"], 3);
    runtimeConfig.patchForm(["count"], 4);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(submissions).toHaveLength(1);
    expect(runtimeConfig.state.configFormDirty).toBe(true);

    firstSet.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual({ raw: '{\n  "count": 4\n}\n', baseHash: "hash-2" });
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    runtimeConfig.dispose();
  });

  it("surfaces auto-save failures without retry-looping", async () => {
    vi.useFakeTimers();
    let setCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return {
          config: { count: 1 },
          raw: '{\n  "count": 1\n}\n',
          hash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        setCalls += 1;
        throw new Error("disk full");
      }
      return {};
    });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(setCalls).toBe(1);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configNeedsApply).toBe(false);
    expect(runtimeConfig.state.lastError).toContain("disk full");

    // No retry loop; only the next edit reschedules a save.
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 10);
    expect(setCalls).toBe(1);
    runtimeConfig.patchForm(["count"], 3);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(setCalls).toBe(2);
    runtimeConfig.dispose();
  });

  it("clears needsApply only on apply; a discarding refresh keeps the banner", async () => {
    vi.useFakeTimers();
    const store = stubLocalStorage();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configNeedsApply).toBe(true);

    // Discarding local edits does not undo the already-saved file: the
    // restart banner must survive until apply.
    runtimeConfig.patchForm(["count"], 9);
    await runtimeConfig.refresh({ discardPendingChanges: true });
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configNeedsApply).toBe(true);

    await expect(runtimeConfig.apply()).resolves.toBe(true);
    expect(runtimeConfig.state.configNeedsApply).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
    expect(server.submissions.at(-1)?.method).toBe("config.apply");
    expect(store.size).toBe(0);
    runtimeConfig.dispose();
  });

  it("persists needsApply across capability recreation keyed to the saved hash", async () => {
    vi.useFakeTimers();
    const store = stubLocalStorage();
    const server = createConfigServerMock();
    const first = createHarness(server.request as GatewayBrowserClient["request"]);
    await first.runtimeConfig.ensureLoaded();

    first.runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(first.runtimeConfig.state.configNeedsApply).toBe(true);
    expect([...store.values()]).toEqual([server.currentHash()]);
    first.runtimeConfig.dispose();

    // A fresh capability (page reload) re-derives the banner from storage.
    const second = createHarness(server.request as GatewayBrowserClient["request"]);
    await second.runtimeConfig.ensureLoaded();
    expect(second.runtimeConfig.state.configNeedsApply).toBe(true);

    await expect(second.runtimeConfig.apply()).resolves.toBe(true);
    expect(second.runtimeConfig.state.configNeedsApply).toBe(false);
    expect(store.size).toBe(0);
    second.runtimeConfig.dispose();

    // After apply cleared the record, a third load shows no banner.
    const third = createHarness(server.request as GatewayBrowserClient["request"]);
    await third.runtimeConfig.ensureLoaded();
    expect(third.runtimeConfig.state.configNeedsApply).toBe(false);
    third.runtimeConfig.dispose();
  });

  it("drops the persisted banner when the config hash moved out from under it", async () => {
    vi.useFakeTimers();
    const store = stubLocalStorage();
    store.set("openclaw.config.needsApplyHash.v1", "hash-from-another-life");
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    expect(runtimeConfig.state.configNeedsApply).toBe(false);
    runtimeConfig.dispose();
  });

  it("flushes the pending debounce before apply and leaves no dangling save", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 7);
    // Apply serializes the current form itself; the scheduled autosave is
    // cancelled and never fires afterwards.
    await expect(runtimeConfig.apply()).resolves.toBe(true);
    expect(server.submissions).toEqual([
      { method: "config.apply", raw: '{\n  "count": 7\n}\n', baseHash: "hash-1" },
    ]);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(server.submissions).toHaveLength(1);
    runtimeConfig.dispose();
  });

  it("reschedules a stranded dirty draft after reconnect", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig, publish } = createHarness(
      server.request as GatewayBrowserClient["request"],
    );
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    publish(false);
    // The disconnect cancelled the debounce; nothing fires while offline.
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 3);
    expect(server.submissions).toHaveLength(0);
    expect(runtimeConfig.state.configFormDirty).toBe(true);

    publish(true);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(server.submissions).toEqual([
      { method: "config.set", raw: '{\n  "count": 2\n}\n', baseHash: "hash-1" },
    ]);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configNeedsApply).toBe(true);
    runtimeConfig.dispose();
  });

  it("reports a base-hash conflict distinctly and recovers via discarding reload", async () => {
    vi.useFakeTimers();
    let rejectSet = true;
    const server = createConfigServerMock();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.set" && rejectSet) {
        // Exact gateway contract message from requireConfigBaseHash
        // (src/gateway/server-methods/config.ts).
        throw new Error("config changed since last load; re-run config.get and retry");
      }
      return server.request(method, params);
    });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    // No auto-rebase-and-retry: the whole-form draft would clobber the other writer.
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 5);
    expect(server.submissions).toHaveLength(0);

    // The Reload affordance discards the local draft and re-syncs from disk.
    rejectSet = false;
    await runtimeConfig.refresh({ discardPendingChanges: true });
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
    expect(runtimeConfig.state.configFormDirty).toBe(false);

    runtimeConfig.patchForm(["count"], 3);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(server.submissions).toEqual([
      { method: "config.set", raw: '{\n  "count": 3\n}\n', baseHash: "hash-1" },
    ]);
    runtimeConfig.dispose();
  });

  it("resets a stale Saved/error status as soon as a new edit lands", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");

    runtimeConfig.patchForm(["count"], 3);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");

    // Raw edits reset the indicator too.
    runtimeConfig.setRaw('{\n  "count": 9\n}\n');
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
    runtimeConfig.dispose();
  });

  it("flushes a dirty draft once on dispose instead of dropping it", async () => {
    vi.useFakeTimers();
    const store = stubLocalStorage();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.patchForm(["count"], 2);
    runtimeConfig.dispose();
    // The teardown flush leaves synchronously; no timer needs to fire.
    expect(server.submissions).toEqual([
      { method: "config.set", raw: '{\n  "count": 2\n}\n', baseHash: "hash-1" },
    ]);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 4);
    expect(server.submissions).toHaveLength(1);
    // The pending-apply marker survives even though the disposed capability
    // never reconciles it to the saved hash.
    expect([...store.values()]).toEqual(["__pending__"]);
  });

  it("does not flush clean or raw drafts on dispose", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    runtimeConfig.setRaw('{\n  "count": 5\n}\n');
    runtimeConfig.dispose();
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(server.submissions).toHaveLength(0);
  });

  it("applies a clean snapshot's raw bytes verbatim instead of reserializing", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    // Hand-formatted (but JSON-parseable) raw that serializeConfigForm would
    // rewrite into pretty-printed two-space form.
    const rawDraft = '{"count":9,"keepFormatting":true}\n';
    runtimeConfig.setRaw(rawDraft);
    const savePromise = runtimeConfig.save();
    await vi.advanceTimersByTimeAsync(0);
    await expect(savePromise).resolves.toBe(true);
    expect(server.submissions[0]?.raw).toBe(rawDraft);

    // The banner's apply must not destroy the formatting that was just saved.
    await expect(runtimeConfig.apply()).resolves.toBe(true);
    expect(server.submissions[1]).toMatchObject({ method: "config.apply", raw: rawDraft });
    runtimeConfig.dispose();
  });

  it("keeps the pending restart marker when the post-save reload fails", async () => {
    vi.useFakeTimers();
    const store = stubLocalStorage();
    let failReloads = false;
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        if (failReloads) {
          throw new Error("gateway went away");
        }
        return {
          config: { count: 1 },
          raw: '{\n  "count": 1\n}\n',
          hash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      return {};
    });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    failReloads = true;
    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);

    // The write happened; the un-reconciled marker must persist and match any
    // hash so the banner survives a page reload after the failed refresh.
    expect([...store.values()]).toEqual(["__pending__"]);
    expect(runtimeConfig.state.configNeedsApply).toBe(true);
    runtimeConfig.dispose();

    failReloads = false;
    const second = createHarness(request as GatewayBrowserClient["request"]);
    await second.runtimeConfig.ensureLoaded();
    expect(second.runtimeConfig.state.configNeedsApply).toBe(true);
    second.runtimeConfig.dispose();
  });

  it("does not report Saved while edits made during the reload are still dirty", async () => {
    vi.useFakeTimers();
    let hashCounter = 1;
    let storedRaw = '{\n  "count": 1\n}\n';
    let deferReload: ReturnType<typeof deferred<unknown>> | null = null;
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "config.get") {
        const response = {
          config: JSON.parse(storedRaw) as Record<string, unknown>,
          raw: storedRaw,
          hash: `hash-${hashCounter}`,
          valid: true,
          issues: [],
        };
        if (deferReload) {
          const pending = deferReload;
          deferReload = null;
          return pending.promise.then(() => response);
        }
        return Promise.resolve(response);
      }
      if (method === "config.set") {
        storedRaw = (params as { raw: string }).raw;
        hashCounter += 1;
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const { runtimeConfig } = createHarness(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    const reloadGate = deferred<unknown>();
    deferReload = reloadGate;
    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    // config.set acked; the post-save reload is held open while a new edit lands.
    runtimeConfig.patchForm(["count"], 3);
    reloadGate.resolve({});
    await vi.advanceTimersByTimeAsync(0);

    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");

    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    expect(runtimeConfig.state.configFormDirty).toBe(false);
    expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
    runtimeConfig.dispose();
  });

  it("never auto-saves raw-text drafts and submits them on manual save", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createHarness(server.request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();

    const rawDraft = '{\n  "count": 9,\n  "handEdited": true\n}\n';
    runtimeConfig.setRaw(rawDraft);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
    expect(server.submissions).toHaveLength(0);
    expect(runtimeConfig.state.configFormDirty).toBe(true);

    // Manual save must submit the raw bytes, not the stale form serialization.
    const savePromise = runtimeConfig.save();
    await vi.advanceTimersByTimeAsync(0);
    await expect(savePromise).resolves.toBe(true);
    expect(server.submissions[0]?.raw).toBe(rawDraft);
    expect(runtimeConfig.state.configNeedsApply).toBe(true);
    runtimeConfig.dispose();
  });
});

describe("agent config helpers", () => {
  it("finds explicit agent entries", () => {
    expect(
      findAgentConfigEntryIndex(
        {
          agents: {
            list: [{ id: "main" }, { id: "assistant" }],
          },
        },
        "assistant",
      ),
    ).toBe(1);
  });
});
