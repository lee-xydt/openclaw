// Control UI runtime config capability and shared config-domain mutations.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSchemaResponse, ConfigSnapshot, ConfigUiHints } from "../../api/types.ts";
import { schemaType, type JsonSchema } from "../../components/config-form.shared.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { copyToClipboard } from "../clipboard.ts";
import {
  cloneConfigObject,
  removePathValue,
  sanitizeRedactedFormForSubmit,
  serializeConfigForm,
  setPathValue,
} from "../config-form-utils.ts";

export type ConfigAutoSaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

/** Debounce window between the last form edit and its automatic config.set. */
export const CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS = 800;

/**
 * localStorage key recording the config hash of the last successful
 * config.set that has not been applied yet. Keyed to the saved hash so the
 * restart banner survives page reloads and capability recreation, and clears
 * itself when the file changes out from under us. Known limitation: an
 * out-of-band gateway restart that leaves the file untouched keeps the banner
 * up until the next apply (a protocol follow-up tracks exposing the gateway's
 * live config generation).
 */
const CONFIG_NEEDS_APPLY_STORAGE_KEY = "openclaw.config.needsApplyHash.v1";

function readStoredNeedsApplyHash(): string | null {
  try {
    return getSafeLocalStorage()?.getItem(CONFIG_NEEDS_APPLY_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function storeNeedsApplyHash(hash: string | null): void {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return;
    }
    if (hash) {
      storage.setItem(CONFIG_NEEDS_APPLY_STORAGE_KEY, hash);
    } else {
      storage.removeItem(CONFIG_NEEDS_APPLY_STORAGE_KEY);
    }
  } catch {
    // Storage-disabled contexts fall back to process-local banner state.
  }
}

/**
 * Gateway contract: requireConfigBaseHash in
 * src/gateway/server-methods/config.ts rejects writes whose baseHash no
 * longer matches the file with exactly this message. A conflict means another
 * writer changed openclaw.json; retrying the whole-form draft would clobber
 * their edit, so callers surface a reload affordance instead.
 */
function isConfigBaseHashConflictError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("config changed since last load");
}

type ConfigState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  applySessionKey: string;
  configLoading: boolean;
  configRaw: string;
  configRawOriginal: string;
  configValid: boolean | null;
  configIssues: unknown[];
  configSaving: boolean;
  configApplying: boolean;
  configAutoSaveStatus: ConfigAutoSaveStatus;
  /** True after a successful config.set until config.apply restarts the gateway. */
  configNeedsApply: boolean;
  configSnapshot: ConfigSnapshot | null;
  configDraftBaseHash?: string | null;
  configSchema: unknown;
  configSchemaVersion: string | null;
  configSchemaLoading: boolean;
  configUiHints: ConfigUiHints;
  configForm: Record<string, unknown> | null;
  configFormOriginal: Record<string, unknown> | null;
  configFormDirty: boolean;
  configFormMode: "form" | "raw";
  configSearchQuery: string;
  configActiveSection: string | null;
  configActiveSubsection: string | null;
  lastError: string | null;
  chatError?: string | null;
};

const autoAllowlistedPluginIdsByState = new WeakMap<ConfigState, Set<string>>();
const requestVersionsByState = new WeakMap<ConfigState, { config: number; schema: number }>();
const connectionEpochsByState = new WeakMap<object, number>();

type RuntimeConfigGatewaySnapshot = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
};

type RuntimeConfigGateway = {
  readonly snapshot: RuntimeConfigGatewaySnapshot;
  subscribe: (listener: (snapshot: RuntimeConfigGatewaySnapshot) => void) => () => void;
};

export type RuntimeConfigCapability = {
  readonly state: ConfigState;
  ensureLoaded: () => Promise<void>;
  ensureSchemaLoaded: () => Promise<void>;
  refresh: (options?: LoadConfigOptions) => Promise<void>;
  refreshSchema: () => Promise<void>;
  patchForm: (path: Array<string | number>, value: unknown) => void;
  removeFormValue: (path: Array<string | number>) => void;
  setRaw: (value: string) => void;
  resetDraft: () => void;
  save: () => Promise<boolean>;
  apply: () => Promise<boolean>;
  openFile: () => Promise<void>;
  ensureAgentEntry: (agentId: string) => number;
  stageDefaultAgent: (agentId: string) => boolean;
  patch: (options: ConfigPatchOptions) => Promise<boolean>;
  lookupSchemaPath: (path: string) => Promise<unknown>;
  subscribe: (listener: (state: ConfigState) => void) => () => void;
  dispose: () => void;
};

type LoadConfigOptions = {
  discardPendingChanges?: boolean;
};

type ConfigPatchOptions = {
  raw: string | Record<string, unknown>;
  note: string;
  /** Array paths the caller intentionally shrinks; required by the gateway's destructive-array guard. */
  replacePaths?: string[];
};

type ConfigGatewayClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

type ConfigConnectionState = {
  client: ConfigGatewayClient | null;
  connected: boolean;
};

type ConfigGatewayState = Pick<
  ConfigState,
  "connected" | "applySessionKey" | "configSnapshot" | "lastError" | "chatError"
> & {
  client: ConfigGatewayClient | null;
};

function createInitialConfigState(snapshot?: Partial<RuntimeConfigGatewaySnapshot>): ConfigState {
  return {
    client: snapshot?.client ?? null,
    connected: snapshot?.connected ?? false,
    applySessionKey: snapshot?.sessionKey ?? "main",
    configLoading: false,
    configRaw: "{\n}\n",
    configRawOriginal: "",
    configValid: null,
    configIssues: [],
    configSaving: false,
    configApplying: false,
    configAutoSaveStatus: "idle",
    configNeedsApply: false,
    configSnapshot: null,
    configDraftBaseHash: null,
    configSchema: null,
    configSchemaVersion: null,
    configSchemaLoading: false,
    configUiHints: {},
    configForm: null,
    configFormOriginal: null,
    configFormDirty: false,
    configFormMode: "form",
    configSearchQuery: "",
    configActiveSection: null,
    configActiveSubsection: null,
    lastError: null,
  };
}

function nextRequestVersion(state: ConfigState, key: "config" | "schema"): number {
  const current = requestVersionsByState.get(state) ?? { config: 0, schema: 0 };
  const next = { ...current, [key]: current[key] + 1 };
  requestVersionsByState.set(state, next);
  return next[key];
}

function currentConfigConnectionEpoch(state: object): number {
  return connectionEpochsByState.get(state) ?? 0;
}

function invalidateConfigConnection(state: object): void {
  connectionEpochsByState.set(state, currentConfigConnectionEpoch(state) + 1);
}

function isCurrentConfigConnection(
  state: ConfigConnectionState,
  client: ConfigGatewayClient,
  connectionEpoch: number,
): boolean {
  return (
    state.connected &&
    state.client === client &&
    currentConfigConnectionEpoch(state) === connectionEpoch
  );
}

function isCurrentRequest(
  state: ConfigState,
  key: "config" | "schema",
  version: number,
  client: GatewayBrowserClient,
  connectionEpoch: number,
): boolean {
  return (
    isCurrentConfigConnection(state, client, connectionEpoch) &&
    requestVersionsByState.get(state)?.[key] === version
  );
}

async function loadConfig(state: ConfigState, options: LoadConfigOptions = {}) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const version = nextRequestVersion(state, "config");
  state.configLoading = true;
  state.lastError = null;
  state.chatError = null;
  try {
    const res = await client.request<ConfigSnapshot>("config.get", {});
    if (!isCurrentRequest(state, "config", version, client, connectionEpoch)) {
      return;
    }
    applyConfigSnapshot(state, res, options);
  } catch (err) {
    if (isCurrentRequest(state, "config", version, client, connectionEpoch)) {
      state.lastError = String(err);
    }
  } finally {
    if (isCurrentRequest(state, "config", version, client, connectionEpoch)) {
      state.configLoading = false;
    }
  }
}

async function loadConfigSchema(state: ConfigState) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  if (state.configSchemaLoading) {
    return;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const version = nextRequestVersion(state, "schema");
  state.configSchemaLoading = true;
  try {
    const res = await client.request<ConfigSchemaResponse>("config.schema", {});
    if (!isCurrentRequest(state, "schema", version, client, connectionEpoch)) {
      return;
    }
    applyConfigSchema(state, res);
  } catch (err) {
    if (isCurrentRequest(state, "schema", version, client, connectionEpoch)) {
      state.lastError = String(err);
    }
  } finally {
    if (isCurrentRequest(state, "schema", version, client, connectionEpoch)) {
      state.configSchemaLoading = false;
    }
  }
}

function applyConfigSchema(state: ConfigState, res: ConfigSchemaResponse) {
  state.configSchema = res.schema ?? null;
  state.configUiHints = res.uiHints ?? {};
  state.configSchemaVersion = res.version ?? null;
}

function asConfigRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function resolveEditableSnapshotConfig(
  snapshot: ConfigSnapshot | null | undefined,
): Record<string, unknown> | null {
  return (
    asConfigRecord(snapshot?.sourceConfig) ??
    asConfigRecord(snapshot?.resolved) ??
    asConfigRecord(snapshot?.config)
  );
}

export function currentConfigObject(
  state: Pick<ConfigState, "configForm" | "configSnapshot">,
): Record<string, unknown> | null {
  return state.configForm ?? resolveEditableSnapshotConfig(state.configSnapshot);
}

function applyConfigSnapshot(
  state: ConfigState,
  snapshot: ConfigSnapshot,
  options: LoadConfigOptions = {},
) {
  const preservePendingChanges = state.configFormDirty && options.discardPendingChanges !== true;
  if (options.discardPendingChanges === true) {
    // Discard resets pending edits and stale save status, but NOT the restart
    // banner: a saved-but-unapplied config still needs an apply even after
    // the local draft is thrown away.
    state.configAutoSaveStatus = "idle";
  }
  // needsApply is persisted keyed to the saved hash (see
  // CONFIG_NEEDS_APPLY_STORAGE_KEY); deriving it on every snapshot keeps the
  // banner across reloads and drops it when the file changed out-of-band.
  // Without a stored record (storage-disabled contexts) the process-local
  // value stands.
  const storedNeedsApplyHash = readStoredNeedsApplyHash();
  if (storedNeedsApplyHash !== null) {
    state.configNeedsApply = Boolean(snapshot.hash) && storedNeedsApplyHash === snapshot.hash;
  }
  const draftBaseHash = state.configDraftBaseHash ?? state.configSnapshot?.hash ?? null;
  state.configSnapshot = snapshot;
  const editableConfig = resolveEditableSnapshotConfig(snapshot);
  const rawAvailable =
    typeof snapshot.raw === "string" || Boolean(editableConfig) || Boolean(state.configForm);
  if (!rawAvailable && state.configFormMode === "raw") {
    state.configFormMode = "form";
  }
  const rawFromSnapshot: string =
    typeof snapshot.raw === "string"
      ? snapshot.raw
      : editableConfig
        ? serializeConfigForm(editableConfig)
        : state.configRaw;
  if (!preservePendingChanges) {
    state.configRaw = rawFromSnapshot;
  } else if (state.configFormMode !== "raw" && state.configForm) {
    state.configRaw = serializeConfigForm(state.configForm);
  } else if (state.configFormMode !== "raw") {
    state.configRaw = rawFromSnapshot;
  }
  state.configValid = typeof snapshot.valid === "boolean" ? snapshot.valid : null;
  state.configIssues = Array.isArray(snapshot.issues) ? snapshot.issues : [];

  if (!preservePendingChanges) {
    state.configForm = cloneConfigObject(editableConfig ?? {});
    state.configFormOriginal = cloneConfigObject(editableConfig ?? {});
    state.configRawOriginal = rawFromSnapshot;
    state.configFormDirty = false;
    state.configFormMode = "form";
    state.configDraftBaseHash = snapshot.hash ?? null;
    autoAllowlistedPluginIdsByState.delete(state);
  } else {
    state.configDraftBaseHash = draftBaseHash;
  }
}

function asJsonSchema(value: unknown): JsonSchema | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonSchema;
}

function coerceNumberString(value: string, integer: boolean): number | undefined | string {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  if (integer && !Number.isInteger(parsed)) {
    return value;
  }
  return parsed;
}

function coerceBooleanString(value: string): boolean | string {
  const trimmed = value.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  return value;
}

function coerceFormValues(value: unknown, schema: JsonSchema): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (schema.allOf && schema.allOf.length > 0) {
    let next: unknown = value;
    for (const segment of schema.allOf) {
      next = coerceFormValues(next, segment);
    }
    return next;
  }

  const type = schemaType(schema);
  if (schema.anyOf || schema.oneOf) {
    const variants = (schema.anyOf ?? schema.oneOf ?? []).filter(
      (variant) =>
        !(
          variant.type === "null" ||
          (Array.isArray(variant.type) && variant.type.includes("null"))
        ),
    );

    if (variants.length === 1) {
      const variant = variants[0];
      return variant ? coerceFormValues(value, variant) : value;
    }
    if (typeof value === "string") {
      for (const variant of variants) {
        const variantType = schemaType(variant);
        if (variantType === "number" || variantType === "integer") {
          const coerced = coerceNumberString(value, variantType === "integer");
          if (coerced === undefined || typeof coerced === "number") {
            return coerced;
          }
        }
        if (variantType === "boolean") {
          const coerced = coerceBooleanString(value);
          if (typeof coerced === "boolean") {
            return coerced;
          }
        }
      }
    }
    for (const variant of variants) {
      const variantType = schemaType(variant);
      if (variantType === "object" && typeof value === "object" && !Array.isArray(value)) {
        return coerceFormValues(value, variant);
      }
      if (variantType === "array" && Array.isArray(value)) {
        return coerceFormValues(value, variant);
      }
    }
    return value;
  }

  if (type === "number" || type === "integer") {
    if (typeof value === "string") {
      const coerced = coerceNumberString(value, type === "integer");
      if (coerced === undefined || typeof coerced === "number") {
        return coerced;
      }
    }
    return value;
  }
  if (type === "boolean") {
    if (typeof value === "string") {
      const coerced = coerceBooleanString(value);
      if (typeof coerced === "boolean") {
        return coerced;
      }
    }
    return value;
  }
  if (type === "string") {
    return typeof value === "string" && value.length === 0 && schema.minLength ? undefined : value;
  }
  if (type === "object") {
    if (typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const props = schema.properties ?? {};
    const additional =
      schema.additionalProperties && typeof schema.additionalProperties === "object"
        ? schema.additionalProperties
        : null;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const propSchema = props[key] ?? additional;
      const coerced = propSchema ? coerceFormValues(val, propSchema) : val;
      if (coerced !== undefined) {
        result[key] = coerced;
      }
    }
    return result;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      return value;
    }
    const items = schema.items;
    if (Array.isArray(items)) {
      return value.map((item, index) => {
        const itemSchema = index < items.length ? items[index] : undefined;
        return itemSchema ? coerceFormValues(item, itemSchema) : item;
      });
    }
    return items
      ? value.map((item) => coerceFormValues(item, items)).filter((item) => item !== undefined)
      : value;
  }
  return value;
}

/**
 * Serialize the form state for submission to `config.set` / `config.apply`.
 *
 * HTML `<input>` elements produce string `.value` properties, so numeric and
 * boolean config fields can leak into `configForm` as strings.  We coerce
 * them back to their schema-defined types before JSON serialization so the
 * gateway's Zod validation always sees correctly typed values.
 */
function serializeFormForSubmit(state: ConfigState): string {
  if (state.configFormMode !== "form" || !state.configForm) {
    return state.configRaw;
  }
  const schema = asJsonSchema(state.configSchema);
  const form = schema
    ? (coerceFormValues(state.configForm, schema) as Record<string, unknown>)
    : state.configForm;
  const sanitized = sanitizeRedactedFormForSubmit(
    form,
    state.configFormOriginal,
    state.configRawOriginal,
  );
  return serializeConfigForm(sanitized);
}

type ConfigSubmitMethod = "config.set" | "config.apply";
type ConfigSubmitBusyKey = "configSaving" | "configApplying";

async function submitConfigChange(
  state: ConfigState,
  method: ConfigSubmitMethod,
  busyKey: ConfigSubmitBusyKey,
  extraParams: Record<string, unknown> = {},
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected) {
    return false;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const isCurrent = () => isCurrentConfigConnection(state, client, connectionEpoch);
  state[busyKey] = true;
  state.lastError = null;
  state.chatError = null;
  try {
    const raw = serializeFormForSubmit(state);
    const baseHash = state.configDraftBaseHash ?? state.configSnapshot?.hash;
    if (!baseHash) {
      state.lastError = "Config hash missing; reload and retry.";
      return false;
    }
    await client.request(method, { raw, baseHash, ...extraParams });
    if (!isCurrent()) {
      return false;
    }
    state.configFormDirty = false;
    state.configDraftBaseHash = null;
    autoAllowlistedPluginIdsByState.delete(state);
    if (method === "config.apply") {
      // Applied config is now live; drop the persisted restart marker before
      // the reload re-derives needsApply from storage.
      storeNeedsApplyHash(null);
      state.configNeedsApply = false;
      state.configAutoSaveStatus = "idle";
    }
    await loadConfig(state);
    if (method === "config.set" && isCurrent()) {
      // config.set writes openclaw.json without restarting; record the saved
      // post-reload hash so the restart banner survives page reloads.
      storeNeedsApplyHash(state.configSnapshot?.hash ?? null);
      state.configNeedsApply = true;
      state.configAutoSaveStatus = "saved";
    }
    return isCurrent();
  } catch (err) {
    if (isCurrent()) {
      state.lastError = String(err);
      if (method === "config.set") {
        state.configAutoSaveStatus = isConfigBaseHashConflictError(err) ? "conflict" : "error";
      }
    }
    return false;
  } finally {
    if (isCurrent()) {
      state[busyKey] = false;
    }
  }
}

/**
 * Auto-save submission for debounced form edits. Unlike the manual
 * `submitConfigChange` path it never raises `configSaving` (editors must stay
 * interactive while typing) and it only clears the dirty flag when the draft
 * still matches the submitted bytes — edits made while the request was in
 * flight stay dirty so the trailing save picks them up.
 */
async function autoSaveConfig(state: ConfigState): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected || !state.configFormDirty || state.configFormMode !== "form") {
    return false;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const isCurrent = () => isCurrentConfigConnection(state, client, connectionEpoch);
  const submittedRaw = serializeFormForSubmit(state);
  const baseHash = state.configDraftBaseHash ?? state.configSnapshot?.hash;
  if (!baseHash) {
    state.configAutoSaveStatus = "error";
    state.lastError = "Config hash missing; reload and retry.";
    return false;
  }
  state.configAutoSaveStatus = "saving";
  state.lastError = null;
  state.chatError = null;
  try {
    await client.request("config.set", { raw: submittedRaw, baseHash });
    if (!isCurrent()) {
      return false;
    }
    const drained = serializeFormForSubmit(state) === submittedRaw;
    if (drained) {
      state.configFormDirty = false;
      autoAllowlistedPluginIdsByState.delete(state);
    }
    state.configDraftBaseHash = null;
    await loadConfig(state);
    if (isCurrent()) {
      // Record the saved post-reload hash so the restart banner survives page
      // reloads (see CONFIG_NEEDS_APPLY_STORAGE_KEY).
      storeNeedsApplyHash(state.configSnapshot?.hash ?? null);
      state.configNeedsApply = true;
      state.configAutoSaveStatus = "saved";
      if (state.configFormDirty) {
        // The gateway now holds submittedRaw; rebase the surviving draft onto
        // the fresh hash so the trailing save passes the baseHash guard.
        state.configDraftBaseHash = state.configSnapshot?.hash ?? null;
      }
    }
    return isCurrent();
  } catch (err) {
    if (isCurrent()) {
      state.lastError = String(err);
      state.configAutoSaveStatus = isConfigBaseHashConflictError(err) ? "conflict" : "error";
    }
    return false;
  }
}

function syncConfigDraft(state: ConfigState, nextForm: Record<string, unknown>) {
  const original = cloneConfigObject(
    state.configFormOriginal ?? resolveEditableSnapshotConfig(state.configSnapshot) ?? {},
  );
  const nextRaw = serializeConfigForm(nextForm);
  const originalRaw = serializeConfigForm(original);
  state.configForm = nextForm;
  state.configRaw = nextRaw;
  state.configFormDirty = nextRaw !== originalRaw;
  // configFormMode tracks which draft is authoritative for submission; a form
  // edit supersedes any earlier raw-text draft.
  state.configFormMode = "form";
  resetStaleAutoSaveStatus(state);
}

/**
 * A new dirty edit invalidates a lingering "Saved"/"Save failed" indicator;
 * an in-flight "saving" stays visible until its request settles.
 */
function resetStaleAutoSaveStatus(state: ConfigState) {
  if (state.configFormDirty && state.configAutoSaveStatus !== "saving") {
    state.configAutoSaveStatus = "idle";
  }
}

async function saveConfig(state: ConfigState): Promise<boolean> {
  return submitConfigChange(state, "config.set", "configSaving");
}

async function applyConfig(state: ConfigState): Promise<boolean> {
  return submitConfigChange(state, "config.apply", "configApplying", {
    sessionKey: state.applySessionKey,
  });
}

async function patchConfig(
  state: ConfigGatewayState,
  options: ConfigPatchOptions,
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected) {
    return false;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const baseHash = state.configSnapshot?.hash;
  if (!baseHash) {
    state.lastError = "Config hash missing; refresh and retry.";
    return false;
  }
  state.lastError = null;
  state.chatError = null;
  try {
    await client.request("config.patch", {
      baseHash,
      raw: typeof options.raw === "string" ? options.raw : JSON.stringify(options.raw),
      sessionKey: state.applySessionKey,
      note: options.note,
      ...(options.replacePaths?.length ? { replacePaths: options.replacePaths } : {}),
    });
    return isCurrentConfigConnection(state, client, connectionEpoch);
  } catch (err) {
    if (isCurrentConfigConnection(state, client, connectionEpoch)) {
      state.lastError = String(err);
    }
    return false;
  }
}

async function lookupConfigSchemaPath(
  state: { client: ConfigGatewayClient | null; connected: boolean },
  path: string,
): Promise<unknown> {
  const client = state.client;
  if (!client || !state.connected) {
    return null;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  try {
    const result = await client.request("config.schema.lookup", { path });
    return isCurrentConfigConnection(state, client, connectionEpoch) ? result : null;
  } catch (error) {
    if (!isCurrentConfigConnection(state, client, connectionEpoch)) {
      return null;
    }
    throw error;
  }
}

function mutateConfigForm(state: ConfigState, mutate: (draft: Record<string, unknown>) => void) {
  const base = cloneConfigObject(
    state.configForm ?? resolveEditableSnapshotConfig(state.configSnapshot) ?? {},
  );
  mutate(base);
  syncConfigDraft(state, base);
}

function trackAutoAllowlistedPluginId(state: ConfigState, pluginId: string) {
  const pluginIds = autoAllowlistedPluginIdsByState.get(state);
  if (pluginIds) {
    pluginIds.add(pluginId);
  } else {
    autoAllowlistedPluginIdsByState.set(state, new Set([pluginId]));
  }
}

function untrackAutoAllowlistedPluginId(state: ConfigState, pluginId: string) {
  const pluginIds = autoAllowlistedPluginIdsByState.get(state);
  if (!pluginIds) {
    return;
  }
  pluginIds.delete(pluginId);
  if (pluginIds.size === 0) {
    autoAllowlistedPluginIdsByState.delete(state);
  }
}

function syncEnabledPluginAllowlist(
  state: ConfigState,
  draft: Record<string, unknown>,
  path: Array<string | number>,
  value: unknown,
) {
  if (
    path.length !== 4 ||
    path[0] !== "plugins" ||
    path[1] !== "entries" ||
    typeof path[2] !== "string" ||
    path[3] !== "enabled"
  ) {
    return;
  }
  const pluginId = path[2];
  const plugins =
    draft.plugins && typeof draft.plugins === "object" && !Array.isArray(draft.plugins)
      ? (draft.plugins as Record<string, unknown>)
      : null;
  const allow = Array.isArray(plugins?.allow) ? plugins.allow : null;
  if (!allow) {
    untrackAutoAllowlistedPluginId(state, pluginId);
    return;
  }
  if (value === true) {
    if (allow.includes(pluginId)) {
      return;
    }
    if (allow.length === 0) {
      untrackAutoAllowlistedPluginId(state, pluginId);
      return;
    }
    setPathValue(draft, ["plugins", "allow"], [...allow, pluginId]);
    trackAutoAllowlistedPluginId(state, pluginId);
    return;
  }
  const autoAllowlistedPluginIds = autoAllowlistedPluginIdsByState.get(state);
  if (!autoAllowlistedPluginIds?.has(pluginId)) {
    return;
  }
  setPathValue(
    draft,
    ["plugins", "allow"],
    allow.filter((entry) => entry !== pluginId),
  );
  untrackAutoAllowlistedPluginId(state, pluginId);
}

function updateConfigFormValue(state: ConfigState, path: Array<string | number>, value: unknown) {
  mutateConfigForm(state, (draft) => {
    setPathValue(draft, path, value);
    if (path[0] === "plugins" && path[1] === "allow") {
      autoAllowlistedPluginIdsByState.delete(state);
      return;
    }
    syncEnabledPluginAllowlist(state, draft, path, value);
  });
}

function updateConfigRawValue(state: ConfigState, value: string) {
  state.configRaw = value;
  // A raw-text edit becomes the authoritative draft; without this,
  // serializeFormForSubmit would submit the stale form and drop raw edits.
  state.configFormMode = "raw";
  state.configFormDirty = value !== state.configRawOriginal;
  resetStaleAutoSaveStatus(state);
  if (state.configFormDirty) {
    state.configDraftBaseHash = state.configDraftBaseHash ?? state.configSnapshot?.hash ?? null;
  } else {
    state.configDraftBaseHash = state.configSnapshot?.hash ?? null;
  }
}

function resetConfigPendingChanges(state: ConfigState) {
  const editableConfig = resolveEditableSnapshotConfig(state.configSnapshot);
  state.configForm = cloneConfigObject(state.configFormOriginal ?? editableConfig ?? {});
  state.configRaw =
    state.configRawOriginal ??
    serializeConfigForm(state.configFormOriginal ?? editableConfig ?? {});
  state.configFormDirty = false;
  state.configFormMode = "form";
  state.configDraftBaseHash = state.configSnapshot?.hash ?? null;
  autoAllowlistedPluginIdsByState.delete(state);
}

function removeConfigFormValue(state: ConfigState, path: Array<string | number>) {
  mutateConfigForm(state, (draft) => removePathValue(draft, path));
}

export function findAgentConfigEntryIndex(
  config: Record<string, unknown> | null,
  agentId: string,
): number {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    return -1;
  }
  const list = (config as { agents?: { list?: unknown[] } } | null)?.agents?.list;
  if (!Array.isArray(list)) {
    return -1;
  }
  return list.findIndex(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      "id" in entry &&
      (entry as { id?: string }).id === normalizedAgentId,
  );
}

function ensureAgentConfigEntry(state: ConfigState, agentId: string): number {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    return -1;
  }
  const source = state.configForm ?? resolveEditableSnapshotConfig(state.configSnapshot);
  const existingIndex = findAgentConfigEntryIndex(source, normalizedAgentId);
  if (existingIndex >= 0) {
    return existingIndex;
  }
  const list = (source as { agents?: { list?: unknown[] } } | null)?.agents?.list;
  const nextIndex = Array.isArray(list) ? list.length : 0;
  updateConfigFormValue(state, ["agents", "list", nextIndex, "id"], normalizedAgentId);
  return nextIndex;
}

function stageDefaultAgentConfigEntry(state: ConfigState, agentId: string): boolean {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    return false;
  }
  const source = state.configForm ?? resolveEditableSnapshotConfig(state.configSnapshot);
  const targetIndex = findAgentConfigEntryIndex(source, normalizedAgentId);
  if (targetIndex < 0) {
    return false;
  }
  mutateConfigForm(state, (draft) => {
    const list = (draft as { agents?: { list?: unknown[] } } | null)?.agents?.list;
    if (!Array.isArray(list)) {
      return;
    }
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (i === targetIndex) {
        record.default = true;
      } else {
        delete record.default;
      }
    }
  });
  return true;
}

async function openConfigFile(state: ConfigState): Promise<void> {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const isCurrent = () => isCurrentConfigConnection(state, client, connectionEpoch);
  state.lastError = null;
  state.chatError = null;
  try {
    const res = await client.request<{ ok: boolean; path?: string; error?: string }>(
      "config.openFile",
      {},
    );
    if (!isCurrent()) {
      return;
    }
    if (!res.ok) {
      let errorMessage = res.error || "Failed to open config file";
      const path = res.path || state.configSnapshot?.path;
      if (path) {
        if (await copyToClipboard(path)) {
          errorMessage += `\n\nFile path copied to clipboard: ${path}`;
        } else {
          errorMessage += `\n\nFile path: ${path}`;
        }
      }
      if (isCurrent()) {
        state.lastError = errorMessage;
      }
    }
  } catch (err) {
    if (!isCurrent()) {
      return;
    }
    const errorMessage = String(err);
    const path = state.configSnapshot?.path;
    if (path) {
      await copyToClipboard(path);
    }
    if (isCurrent()) {
      state.lastError = errorMessage;
    }
  }
}

export function createRuntimeConfigCapability(
  gateway: RuntimeConfigGateway,
): RuntimeConfigCapability {
  const state = createInitialConfigState(gateway.snapshot);
  const listeners = new Set<(state: ConfigState) => void>();
  let configLoad: Promise<void> | null = null;
  let schemaLoad: Promise<void> | null = null;
  let disposed = false;
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let autoSaveInFlight: Promise<unknown> | null = null;
  let autoSaveTrailing = false;

  const publish = () => {
    if (disposed) {
      return;
    }
    for (const listener of listeners) {
      listener(state);
    }
  };
  const run = async <T>(task: () => Promise<T>): Promise<T> => {
    try {
      const result = task();
      // Async config owners mutate their busy flag before the first await.
      // Publish that transition so editors can lock before accepting more input.
      publish();
      return await result;
    } finally {
      publish();
    }
  };
  const mutate = (task: () => void) => {
    task();
    publish();
  };
  const trackLoad = (key: "config" | "schema", promise: Promise<void>): Promise<void> => {
    const next = promise.finally(() => {
      if (key === "config" && configLoad === next) {
        configLoad = null;
      } else if (key === "schema" && schemaLoad === next) {
        schemaLoad = null;
      }
    });
    if (key === "config") {
      configLoad = next;
    } else {
      schemaLoad = next;
    }
    return next;
  };
  const loadOnce = (key: "config" | "schema", task: () => Promise<void>): Promise<void> => {
    const current = key === "config" ? configLoad : schemaLoad;
    return current ?? trackLoad(key, run(task));
  };
  const cancelScheduledAutoSave = () => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    autoSaveTrailing = false;
  };
  const runAutoSave = () => {
    if (disposed) {
      return;
    }
    if (autoSaveInFlight) {
      // Exactly one trailing save catches edits made while a save is in
      // flight; further edits fold into that same trailing run.
      autoSaveTrailing = true;
      return;
    }
    const flight = run(() => autoSaveConfig(state))
      .catch(() => undefined)
      .finally(() => {
        autoSaveInFlight = null;
        if (autoSaveTrailing && !disposed) {
          autoSaveTrailing = false;
          runAutoSave();
        }
      });
    autoSaveInFlight = flight;
  };
  const scheduleAutoSave = () => {
    // Only form-draft edits auto-save; raw-text drafts stay manual so a
    // half-typed JSON5 buffer never gets written to disk.
    if (disposed || !state.configFormDirty || state.configFormMode !== "form") {
      return;
    }
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
    }
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      runAutoSave();
    }, CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
  };
  // Manual save/apply serialize the current draft themselves; cancel any
  // dangling debounce and settle an in-flight autosave first so the explicit
  // write does not race it on the baseHash guard. The submit starts
  // synchronously when nothing is in flight so it binds to the current
  // connection epoch.
  const afterAutoSaveSettled = (task: () => Promise<boolean>): Promise<boolean> => {
    cancelScheduledAutoSave();
    const pending = autoSaveInFlight;
    return run(async () => {
      if (pending) {
        await pending;
      }
      return task();
    });
  };
  const ensureLoaded = () =>
    state.configSnapshot ? Promise.resolve() : loadOnce("config", () => loadConfig(state));
  const ensureSchemaLoaded = () =>
    state.configSchema ? Promise.resolve() : loadOnce("schema", () => loadConfigSchema(state));
  const stopGateway = gateway.subscribe((snapshot) => {
    const clientChanged = state.client !== snapshot.client;
    const connectionChanged = state.connected !== snapshot.connected;
    state.client = snapshot.client;
    state.connected = snapshot.connected;
    state.applySessionKey = snapshot.sessionKey;
    if (clientChanged || connectionChanged) {
      configLoad = null;
      schemaLoad = null;
      // A reconnect may reuse the client object. Keep generations monotonic so work
      // from the previous connection cannot commit into the new connection epoch.
      invalidateConfigConnection(state);
      cancelScheduledAutoSave();
      state.configLoading = false;
      state.configSchemaLoading = false;
      state.configSaving = false;
      state.configApplying = false;
      if (state.configAutoSaveStatus === "saving") {
        state.configAutoSaveStatus = "idle";
      }
      // A reconnect must not strand a dirty draft whose debounce was just
      // cancelled; reschedule against the new connection. If the file moved
      // while offline, the save reports a baseHash conflict instead of
      // clobbering the other writer.
      if (state.connected && state.client) {
        scheduleAutoSave();
      }
    }
    publish();
  });

  return {
    get state() {
      return state;
    },
    ensureLoaded,
    ensureSchemaLoaded,
    refresh: (options) => {
      if (options?.discardPendingChanges) {
        cancelScheduledAutoSave();
      }
      return trackLoad(
        "config",
        run(() => loadConfig(state, options)),
      );
    },
    refreshSchema: () =>
      trackLoad(
        "schema",
        run(() => loadConfigSchema(state)),
      ),
    patchForm: (path, value) => {
      mutate(() => updateConfigFormValue(state, path, value));
      scheduleAutoSave();
    },
    removeFormValue: (path) => {
      mutate(() => removeConfigFormValue(state, path));
      scheduleAutoSave();
    },
    setRaw: (value) => mutate(() => updateConfigRawValue(state, value)),
    resetDraft: () => {
      cancelScheduledAutoSave();
      mutate(() => resetConfigPendingChanges(state));
    },
    save: () => afterAutoSaveSettled(() => saveConfig(state)),
    apply: () => afterAutoSaveSettled(() => applyConfig(state)),
    openFile: () => run(() => openConfigFile(state)),
    ensureAgentEntry: (agentId) => {
      const index = ensureAgentConfigEntry(state, agentId);
      publish();
      scheduleAutoSave();
      return index;
    },
    stageDefaultAgent: (agentId) => {
      const changed = stageDefaultAgentConfigEntry(state, agentId);
      publish();
      scheduleAutoSave();
      return changed;
    },
    patch: (options) => run(() => patchConfig(state, options)),
    lookupSchemaPath: (path) => run(() => lookupConfigSchemaPath(state, path)),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      cancelScheduledAutoSave();
      invalidateConfigConnection(state);
      state.connected = false;
      state.configLoading = false;
      state.configSchemaLoading = false;
      state.configSaving = false;
      state.configApplying = false;
      stopGateway();
      listeners.clear();
      requestVersionsByState.delete(state);
      autoAllowlistedPluginIdsByState.delete(state);
    },
  };
}
