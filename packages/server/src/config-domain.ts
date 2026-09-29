/**
 * ConfigDomain：config 域 5 方法（06-api-spec §2.3）+ Provider 运行时解析。
 *
 * - get/set：三级合并的 P0 子集 = 全局层（~/.raincode/config.json，04 §5.1）；
 *   get 按 path 定点读（缺省整文档），set 按路径定点改后整体过 strict schema 再落盘；
 * - providers.list/add/remove：Provider 四要素增删查（add 的明文 key 由 ConfigStore 隔离到密钥文件）；
 * - providerRuntime：session.create 的 providerId → 运行时 Provider 配置（明文 key 内存解析），
 *   未配置任何 Provider 时返回 null（调用方按 CONFIG_PROVIDER_NOT_FOUND 拒绝写入类操作）；
 * - 错误映射：ConfigStoreError → RpcCallError（06 §4.3 段 3 CONFIG_*）。
 */
import { RpcCallError } from "@raincode/rpc";
import type {
  ConfigDocument,
  ConfigGetParams,
  ConfigGetResult,
  ConfigProvidersAddParams,
  ConfigProvidersAddResult,
  ConfigProvidersListResult,
  ConfigProvidersRemoveParams,
  ConfigProvidersRemoveResult,
  ConfigSetParams,
  ConfigSetResult,
} from "@raincode/shared";
import type { ProviderRuntimeConfig } from "./agent-service.js";
import { ConfigStore, ConfigStoreError } from "./config-store.js";

export class ConfigDomain {
  constructor(private readonly store: ConfigStore) {}

  /** 方法表接线（agent-service buildMethods 展开；schema 校验仍由 METHOD_SCHEMAS 单点承担）。 */
  methods(register: (method: string, handler: (params: unknown) => Promise<unknown>) => unknown): Record<string, unknown> {
    return {
      "config.get": register("config.get", async (params) => this.get(params as ConfigGetParams)),
      "config.set": register("config.set", async (params) => this.set(params as ConfigSetParams)),
      "config.providers.list": register("config.providers.list", async () => this.providersList()),
      "config.providers.add": register("config.providers.add", async (params) =>
        this.providersAdd(params as ConfigProvidersAddParams)),
      "config.providers.remove": register("config.providers.remove", async (params) =>
        this.providersRemove(params as ConfigProvidersRemoveParams)),
    };
  }

  // ---------------------------------------------------------------------------
  // config.get / config.set
  // ---------------------------------------------------------------------------

  get(params: ConfigGetParams): ConfigGetResult {
    const doc = this.store.read();
    return {
      config: params.path !== undefined ? resolvePath(doc, params.path) : doc,
      configVersion: doc.configVersion,
    };
  }

  set(params: ConfigSetParams): ConfigSetResult {
    const doc = this.store.read();
    const next: ConfigDocument = withValueAtPath(doc, params.path, params.value);
    this.store.write(next); // strict 校验失败 → CONFIG_INVALID（含明文 apiKey 字段拒写）
    return { config: next, configVersion: next.configVersion };
  }

  // ---------------------------------------------------------------------------
  // providers 域
  // ---------------------------------------------------------------------------

  providersList(): ConfigProvidersListResult {
    return this.store.listProviders();
  }

  providersAdd(params: ConfigProvidersAddParams): ConfigProvidersAddResult {
    try {
      return { provider: this.store.addProvider(params.provider) };
    } catch (reason: unknown) {
      throw toRpcError(reason);
    }
  }

  providersRemove(params: ConfigProvidersRemoveParams): ConfigProvidersRemoveResult {
    try {
      this.store.removeProvider(params.id);
      return { removed: true };
    } catch (reason: unknown) {
      throw toRpcError(reason);
    }
  }

  /** configVersion（system.version 数据源）。 */
  configVersion(): number {
    return this.store.read().configVersion;
  }

  /**
   * providerId → 运行时 Provider 配置（明文 key 经 apiKeyRef 内存解析，绝不落日志）。
   * 解析顺序：显式 providerId → activeProviderId → 首个 Provider；均缺省 = null。
   * 显式 providerId 不存在 → CONFIG_PROVIDER_NOT_FOUND（06 §2.1 session.create 业务码）。
   */
  providerRuntime(providerId: string | undefined): ProviderRuntimeConfig | null {
    const { providers, activeProviderId } = this.store.listProviders();
    const id = providerId ?? activeProviderId ?? providers[0]?.id;
    if (id === undefined) {
      return null;
    }
    const entry = providers.find((p) => p.id === id);
    if (entry === undefined) {
      if (providerId === undefined) return null;
      throw new RpcCallError("CONFIG_PROVIDER_NOT_FOUND", `provider not found: ${id}`);
    }
    try {
      return {
        id: entry.id,
        name: entry.name,
        baseURL: entry.baseURL,
        model: entry.model,
        apiKey: this.store.resolveApiKey(entry.apiKeyRef),
        maxContextTokens: entry.maxContextTokens,
      };
    } catch (reason: unknown) {
      throw toRpcError(reason);
    }
  }
}

// ---------------------------------------------------------------------------

/** 点路径读取（"a.b.0.c"；数组段取下标）；不存在 → CONFIG_PATH_UNKNOWN。 */
function resolvePath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    current = stepInto(current, segment);
    if (current === undefined) {
      throw new ConfigStoreError("CONFIG_PATH_UNKNOWN", `config path not found: ${path}`);
    }
  }
  return current;
}

/** 点路径写入：中间节点必须已存在（否则 CONFIG_PATH_UNKNOWN），叶子允许新建。 */
function withValueAtPath(root: ConfigDocument, path: string, value: unknown): ConfigDocument {
  const segments = path.split(".");
  const docClone: ConfigDocument = structuredClone(root);
  let current: unknown = docClone;
  for (const segment of segments.slice(0, -1)) {
    if (stepInto(current, segment) === undefined) {
      throw new ConfigStoreError("CONFIG_PATH_UNKNOWN", `config path not found: ${path}`);
    }
    current = stepInto(current, segment);
  }
  assignAt(current, segments[segments.length - 1]!, value);
  return docClone;
}

function stepInto(current: unknown, segment: string): unknown {
  if (Array.isArray(current)) {
    const index = Number.parseInt(segment, 10);
    return Number.isInteger(index) ? current[index] : undefined;
  }
  if (current !== null && typeof current === "object") {
    return (current as Record<string, unknown>)[segment];
  }
  return undefined;
}

function assignAt(target: unknown, key: string, value: unknown): void {
  if (Array.isArray(target)) {
    const index = Number.parseInt(key, 10);
    if (!Number.isInteger(index)) {
      throw new ConfigStoreError("CONFIG_PATH_UNKNOWN", `array index expected: ${key}`);
    }
    target[index] = value;
    return;
  }
  if (target === null || typeof target !== "object") {
    throw new ConfigStoreError("CONFIG_PATH_UNKNOWN", `parent of "${key}" is not an object`);
  }
  (target as Record<string, unknown>)[key] = value;
}

function toRpcError(reason: unknown): unknown {
  if (reason instanceof ConfigStoreError) {
    return new RpcCallError(reason.code, reason.message.replace(/^\[CONFIG_[A-Z_]+\]\s*/, ""));
  }
  return reason;
}
