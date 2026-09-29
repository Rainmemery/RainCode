/**
 * Provider 配置解析（04-architecture §5 配置体系 / 06-api-spec §2.3 Provider 四要素）。
 *
 * 优先级（低 → 高，字段级就近覆盖）：
 *   ① 配置文件  config/providers.local.json（.gitignore 已隔离 config/*.local.json）
 *   ② 环境变量  RAINCODE_PROVIDER_BASE_URL / _MODEL / _API_KEY / _NAME / _MAX_CONTEXT_TOKENS
 *   ③ CLI 参数  --base-url / --model / --api-key / --name
 *
 * apiKey 两种来源（本波约定）：
 *   - 配置文件 apiKeyRef: "file:<path>"（相对路径以配置文件所在目录为基准）；不支持的前缀直接报错；
 *   - 明文 env 注入 RAINCODE_PROVIDER_API_KEY（或配置文件 apiKey 字段，仅限本地开发）。
 * 安全约束（04 §5.3）：明文 key 不落日志——本模块所有错误信息只含文件路径，绝不含 key 值。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface ProviderCliArgs {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  name?: string;
}

export interface ResolvedProviderConfig {
  name: string;
  baseURL: string;
  model: string;
  apiKey: string | null;
  maxContextTokens: number;
  /** baseURL 实际命中的最高优先级来源（诊断用，不含凭据）。 */
  source: "cli" | "env" | "config";
}

export interface ResolveProviderOptions {
  args?: ProviderCliArgs;
  env?: NodeJS.ProcessEnv;
  /** 显式配置文件路径；缺省 <cwd>/config/providers.local.json，可被 RAINCODE_PROVIDER_CONFIG 覆盖。 */
  configPath?: string;
}

interface ProviderConfigLayer {
  name?: string;
  baseURL?: string;
  model?: string;
  apiKey?: string | null;
  apiKeyRef?: string | null;
  maxContextTokens?: number;
}

interface ConfigFileShape extends ProviderConfigLayer {
  providers?: Array<ProviderConfigLayer & { id?: string }>;
  activeProviderId?: string;
}

export const DEFAULT_MAX_CONTEXT_TOKENS = 32768;

/** 解析 Provider 配置；无任何来源可用时返回 null（调用方决定报错方式）。 */
export function resolveProviderConfig(options: ResolveProviderOptions = {}): ResolvedProviderConfig | null {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? env["RAINCODE_PROVIDER_CONFIG"] ?? defaultConfigPath();
  const configLayer = readConfigLayer(configPath);
  const envLayer = readEnvLayer(env);
  const argsLayer = options.args ?? {};

  const baseURL = argsLayer.baseUrl ?? envLayer.baseURL ?? configLayer.baseURL;
  if (baseURL === undefined || baseURL.length === 0) {
    return null;
  }
  const source: ResolvedProviderConfig["source"] =
    argsLayer.baseUrl !== undefined ? "cli" : envLayer.baseURL !== undefined ? "env" : "config";

  const model = argsLayer.model ?? envLayer.model ?? configLayer.model;
  if (model === undefined || model.length === 0) {
    throw new Error(
      `provider model missing: set --model, RAINCODE_PROVIDER_MODEL, or "model" in ${configPath}`,
    );
  }

  const name = argsLayer.name ?? envLayer.name ?? configLayer.name ?? model;
  const maxContextTokens =
    envLayer.maxContextTokens ?? configLayer.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;

  // api key：CLI > env（明文注入）> 配置文件（apiKey 明文或 apiKeyRef file: 引用，normalizeLayer 已展开）
  const apiKey = argsLayer.apiKey ?? envLayer.apiKey ?? configLayer.apiKey ?? null;

  return { name, baseURL, model, apiKey, maxContextTokens, source };
}

function defaultConfigPath(): string {
  return resolve("config", "providers.local.json");
}

function readConfigLayer(configPath: string): ProviderConfigLayer {
  if (!existsSync(configPath)) {
    return {};
  }
  let parsed: ConfigFileShape;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as ConfigFileShape;
  } catch (reason: unknown) {
    throw new Error(`provider config is not valid JSON: ${configPath} (${String(reason)})`);
  }
  // 两种形态：04 §5.2 的 { providers[], activeProviderId } 或单 Provider 平铺对象
  if (Array.isArray(parsed.providers) && parsed.providers.length > 0) {
    const active =
      parsed.providers.find((p) => p.id !== undefined && p.id === parsed.activeProviderId) ??
      parsed.providers[0]!;
    return normalizeLayer(active, configPath);
  }
  return normalizeLayer(parsed, configPath);
}

function normalizeLayer(layer: ProviderConfigLayer, configPath: string): ProviderConfigLayer {
  const resolved: ProviderConfigLayer = { ...layer };
  if (typeof resolved.maxContextTokens !== "number" || !Number.isInteger(resolved.maxContextTokens) || resolved.maxContextTokens <= 0) {
    delete resolved.maxContextTokens;
  }
  // file: 引用在此展开为明文（仅内存；不打印内容）
  if (resolved.apiKey === undefined && typeof resolved.apiKeyRef === "string" && resolved.apiKeyRef.length > 0) {
    resolved.apiKey = readApiKeyRef(resolved.apiKeyRef, dirname(configPath));
  }
  return resolved;
}

/** apiKeyRef 解析：仅支持 file:<path>（相对路径以配置文件目录为基准）；keyring:// 等随凭据库波次补齐。 */
function readApiKeyRef(ref: string, baseDir: string): string | undefined {
  if (!ref.startsWith("file:")) {
    throw new Error(`unsupported apiKeyRef scheme "${ref.split(":")[0] ?? ""}": only file: is supported in this wave`);
  }
  const rawPath = ref.slice("file:".length);
  const keyPath = isAbsolute(rawPath) ? rawPath : join(baseDir, rawPath);
  if (!existsSync(keyPath)) {
    throw new Error(`apiKeyRef file not found: ${keyPath}`);
  }
  const content = readFileSync(keyPath, "utf8").trim();
  return content.length > 0 ? content : undefined;
}

function readEnvLayer(env: NodeJS.ProcessEnv): ProviderConfigLayer {
  const layer: ProviderConfigLayer = {};
  const baseURL = env["RAINCODE_PROVIDER_BASE_URL"];
  if (typeof baseURL === "string" && baseURL.length > 0) layer.baseURL = baseURL;
  const model = env["RAINCODE_PROVIDER_MODEL"];
  if (typeof model === "string" && model.length > 0) layer.model = model;
  const name = env["RAINCODE_PROVIDER_NAME"];
  if (typeof name === "string" && name.length > 0) layer.name = name;
  const apiKey = env["RAINCODE_PROVIDER_API_KEY"];
  if (typeof apiKey === "string" && apiKey.length > 0) layer.apiKey = apiKey;
  const tokens = env["RAINCODE_PROVIDER_MAX_CONTEXT_TOKENS"];
  if (typeof tokens === "string" && tokens.length > 0) {
    const parsed = Number.parseInt(tokens, 10);
    if (Number.isInteger(parsed) && parsed > 0) layer.maxContextTokens = parsed;
  }
  return layer;
}
