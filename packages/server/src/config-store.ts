/**
 * ConfigStore：config 域持久层（04-architecture §5 配置体系，本波 P0 子集 = 全局层）。
 *
 * - config.json：<dataRoot>/config.json（04 §5.1 全局层；zod strict 写校验、原子写 tmp+rename）；
 * - 明文 key 隔离：providers.add 传入明文 apiKey 时写入独立密钥文件
 *   <dataRoot>/config/providers.local.json（.gitignore 模式：本地文件不入库，0600），
 *   config.json 仅存 apiKeyRef 引用 "file:config/providers.local.json#<providerId>"（04 §5.3）；
 * - 安全约束：明文 key 不进日志/错误信息——本模块所有错误只含路径与 providerId，绝不含 key 值。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  configDocumentSchema,
  configDocumentStrictSchema,
} from "@raincode/shared";
import type { ConfigDocument, ProviderAddInput, ProviderInfo, ProviderInput } from "@raincode/shared";

/** config.json 结构版本（04 §5.1 configVersion；与协议版本独立演进）。 */
export const CONFIG_VERSION = 1;

/** 密钥文件相对引用前缀（相对 config.json 所在目录 = dataRoot）。 */
const SECRETS_REL_PATH = "config/providers.local.json";

export type ConfigStoreErrorCode =
  | "CONFIG_INVALID"
  | "CONFIG_PATH_UNKNOWN"
  | "CONFIG_PROVIDER_INVALID"
  | "CONFIG_PROVIDER_NOT_FOUND"
  | "CONFIG_PROVIDER_ACTIVE";

/** 持久层业务错误（code 对齐 06 §4.3 段 3；message 已脱敏）。 */
export class ConfigStoreError extends Error {
  constructor(readonly code: ConfigStoreErrorCode, message: string) {
    super(`[${code}] ${message}`);
  }
}

export interface ConfigStoreOptions {
  /** 数据根（RAINCODE_HOME → ~/.raincode，05 §2.1）；config.json 与密钥文件的编址基准。 */
  dataRoot: string;
}

export class ConfigStore {
  readonly configPath: string;
  private readonly secretsPath: string;

  constructor(options: ConfigStoreOptions) {
    this.configPath = join(options.dataRoot, "config.json");
    this.secretsPath = join(options.dataRoot, SECRETS_REL_PATH);
  }

  // ---------------------------------------------------------------------------
  // config.json 文档读写
  // ---------------------------------------------------------------------------

  /** 读全局配置（文件缺失回退默认文档；非法 JSON / schema 失败 → CONFIG_INVALID）。 */
  read(): ConfigDocument {
    if (!existsSync(this.configPath)) {
      return { configVersion: CONFIG_VERSION };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.configPath, "utf8"));
    } catch (reason: unknown) {
      throw new ConfigStoreError("CONFIG_INVALID", `config.json is not valid JSON: ${this.configPath}`);
    }
    const result = configDocumentSchema.safeParse(parsed);
    if (!result.success) {
      throw new ConfigStoreError("CONFIG_INVALID", `config.json failed schema validation: ${this.configPath}`);
    }
    return result.data;
  }

  /** 写全局配置：整体过 strict schema（未知字段拒绝，04 §5.1）再原子落盘。 */
  write(doc: ConfigDocument): void {
    const result = configDocumentStrictSchema.safeParse(doc);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new ConfigStoreError(
        "CONFIG_INVALID",
        `config failed strict validation at "${issue?.path.join(".") ?? "?"}": ${issue?.message ?? "unknown"}`,
      );
    }
    const tmpPath = `${this.configPath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(result.data, null, 2)}\n`, "utf8");
    renameSync(tmpPath, this.configPath); // 同卷原子替换，杜绝半写状态（06 §2.3）
  }

  // ---------------------------------------------------------------------------
  // providers 域操作（06 §2.3）
  // ---------------------------------------------------------------------------

  /** Provider 生效视图（永不含明文 key；apiKeyConfigured = 凭据引用可解析或无需凭据）。 */
  listProviders(): { providers: ProviderInfo[]; activeProviderId?: string } {
    const doc = this.read();
    return {
      providers: (doc.providers ?? []).map((entry) => this.toInfo(entry)),
      ...(doc.activeProviderId !== undefined && { activeProviderId: doc.activeProviderId }),
    };
  }

  /** upsert 语义（06 §2.3）：id 已存在则整体替换；明文 key 落密钥文件 + 存 apiKeyRef 引用。 */
  addProvider(input: ProviderAddInput): ProviderInfo {
    if (input.apiKey !== undefined && input.apiKeyRef != null) {
      throw new ConfigStoreError("CONFIG_PROVIDER_INVALID", "apiKey and apiKeyRef are mutually exclusive");
    }
    const id = input.id ?? input.name;
    const doc = this.read();
    let apiKeyRef: string | null = input.apiKeyRef ?? null;
    if (input.apiKey !== undefined) {
      this.writeSecret(id, input.apiKey);
      apiKeyRef = `file:${SECRETS_REL_PATH}#${id}`;
    }
    const entry: ProviderInput = {
      id,
      name: input.name,
      baseURL: input.baseURL,
      model: input.model,
      maxContextTokens: input.maxContextTokens,
      apiKeyRef,
    };
    const providers = (doc.providers ?? []).filter((p) => p.id !== id);
    providers.push(entry);
    this.write({
      ...doc,
      providers,
      // 首个 Provider 引导为活跃（04 §5.2 activeProviderId；显式 switch 属 P1）
      activeProviderId: doc.activeProviderId ?? id,
    });
    return this.toInfo(entry);
  }

  /** 删除 Provider：活跃 Provider 须先 switch（P1 前=经 config.set activeProviderId），否则 CONFIG_PROVIDER_ACTIVE。 */
  removeProvider(id: string): void {
    const doc = this.read();
    const index = (doc.providers ?? []).findIndex((p) => p.id === id);
    if (index < 0) {
      throw new ConfigStoreError("CONFIG_PROVIDER_NOT_FOUND", `provider not found: ${id}`);
    }
    if (doc.activeProviderId === id) {
      throw new ConfigStoreError("CONFIG_PROVIDER_ACTIVE", `provider is active, switch first: ${id}`);
    }
    const providers = (doc.providers ?? []).filter((p) => p.id !== id);
    this.write({ ...doc, providers });
    // 密钥文件条目保留（防误删唯一凭据副本；无引用即不可达，无害）
  }

  // ---------------------------------------------------------------------------
  // apiKeyRef 解析（仅内存使用；绝不打印解析结果）
  // ---------------------------------------------------------------------------

  /**
   * apiKeyRef → 明文 key。仅支持 file:<path>[#<jsonKey>]（相对路径以 dataRoot 为基准）；
   * 无 fragment = 整文件内容即 key（trim）；有 fragment = JSON 对象取顶层键。
   * 解析失败抛 CONFIG_PROVIDER_INVALID（message 只含路径，不含 key 值）。
   */
  resolveApiKey(apiKeyRef: string | null | undefined): string | null {
    if (apiKeyRef == null || apiKeyRef.length === 0) {
      return null; // null = 本地 Provider 无需凭据（04 §5.2 Ollama 形态）
    }
    if (!apiKeyRef.startsWith("file:")) {
      throw new ConfigStoreError(
        "CONFIG_PROVIDER_INVALID",
        `unsupported apiKeyRef scheme "${apiKeyRef.split(":")[0] ?? ""}": only file: is supported in this wave`,
      );
    }
    const spec = apiKeyRef.slice("file:".length);
    const hash = spec.indexOf("#");
    const rawPath = hash >= 0 ? spec.slice(0, hash) : spec;
    const fragment = hash >= 0 ? spec.slice(hash + 1) : undefined;
    const keyPath = isAbsolute(rawPath) ? rawPath : join(dirname(this.configPath), rawPath);
    if (!existsSync(keyPath)) {
      throw new ConfigStoreError("CONFIG_PROVIDER_INVALID", `apiKeyRef file not found: ${keyPath}`);
    }
    const content = readFileSync(keyPath, "utf8");
    if (fragment === undefined) {
      const trimmed = content.trim();
      if (trimmed.length === 0) {
        throw new ConfigStoreError("CONFIG_PROVIDER_INVALID", `apiKeyRef file is empty: ${keyPath}`);
      }
      return trimmed;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ConfigStoreError("CONFIG_PROVIDER_INVALID", `apiKeyRef file is not valid JSON: ${keyPath}`);
    }
    const value = (parsed as Record<string, unknown> | null)?.[fragment];
    if (typeof value !== "string" || value.length === 0) {
      throw new ConfigStoreError("CONFIG_PROVIDER_INVALID", `apiKeyRef fragment missing: ${keyPath}#${fragment}`);
    }
    return value;
  }

  /** apiKeyConfigured 判定：无需凭据或引用可解析 → true（不抛出）。 */
  isConfigured(apiKeyRef: string | null | undefined): boolean {
    try {
      return apiKeyRef == null || this.resolveApiKey(apiKeyRef) !== null;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------

  private toInfo(entry: ProviderInput): ProviderInfo {
    return {
      id: entry.id ?? entry.name,
      name: entry.name,
      baseURL: entry.baseURL,
      model: entry.model,
      maxContextTokens: entry.maxContextTokens,
      apiKeyRef: entry.apiKeyRef ?? null,
      apiKeyConfigured: this.isConfigured(entry.apiKeyRef),
    };
  }

  /** 明文 key 写入密钥文件（JSON 顶层键 = providerId；0600，Windows 忽略 mode 位）。 */
  private writeSecret(id: string, key: string): void {
    mkdirSync(dirname(this.secretsPath), { recursive: true });
    const secrets = this.readSecrets();
    secrets[id] = key;
    writeFileSync(this.secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private readSecrets(): Record<string, string> {
    if (!existsSync(this.secretsPath)) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.secretsPath, "utf8"));
      if (parsed !== null && typeof parsed === "object") {
        return parsed as Record<string, string>;
      }
    } catch {
      // 落入下方统一报错
    }
    throw new ConfigStoreError("CONFIG_INVALID", `provider secrets file is not valid JSON: ${this.secretsPath}`);
  }
}
