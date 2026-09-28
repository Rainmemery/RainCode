/**
 * 最小 zod → JSON Schema 投影（02 §2.3：ToolRegistry.list 含 zod→JSONSchema 投影）。
 *
 * 说明：刻意自实现而非引入 zod-to-json-schema（工具包零新增三方依赖约束），仅覆盖本仓库
 * 内置工具 schema 用到的子集（object/string/number/boolean/enum/literal/array/optional/
 * nullable/default/union/record/unknown）；未识别节点降级为 `{}`（JSON Schema「任意值」）。
 * 后续可整体替换为 zod-to-json-schema 原生实现，调用方接口（ToolDescriptor.parametersSchema）不变。
 */
import type { z } from "zod";

type UnknownRecord = Record<string, unknown>;

interface ZodDefLike {
  typeName?: string;
  description?: string;
  value?: unknown;
  values?: unknown[];
  innerType?: z.ZodTypeAny;
  type?: z.ZodTypeAny;
  valueType?: z.ZodTypeAny;
  shape?: () => UnknownRecord;
  unknownKeys?: string | (() => string);
  checks?: Array<{ kind: string; value?: unknown }>;
}

function defOf(schema: z.ZodTypeAny): ZodDefLike {
  return (schema as unknown as { _def: ZodDefLike })._def ?? {};
}

function descriptionOf(schema: z.ZodTypeAny): UnknownRecord | null {
  const description = schema.description;
  return typeof description === "string" && description.length > 0 ? { description } : null;
}

function stringSchema(schema: z.ZodTypeAny, def: ZodDefLike): UnknownRecord {
  const out: UnknownRecord = { type: "string" };
  for (const check of def.checks ?? []) {
    if (check.kind === "min") out.minLength = check.value;
    else if (check.kind === "max") out.maxLength = check.value;
  }
  return { ...out, ...descriptionOf(schema) };
}

function numberSchema(schema: z.ZodTypeAny, def: ZodDefLike): UnknownRecord {
  const out: UnknownRecord = { type: "number" };
  for (const check of def.checks ?? []) {
    if (check.kind === "int") out.type = "integer";
    else if (check.kind === "min") out.minimum = check.value;
    else if (check.kind === "max") out.maximum = check.value;
  }
  return { ...out, ...descriptionOf(schema) };
}

function objectSchema(schema: z.ZodTypeAny, def: ZodDefLike): UnknownRecord {
  const shape = def.shape?.() ?? {};
  const properties: UnknownRecord = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const child = value as z.ZodTypeAny;
    properties[key] = toJsonSchemaOrNull(child);
    const childDef = defOf(child);
    const optional =
      childDef.typeName === "ZodOptional" ||
      childDef.typeName === "ZodDefault" ||
      childDef.typeName === "ZodNullable";
    if (!optional) required.push(key);
  }
  const unknownKeys = typeof def.unknownKeys === "function" ? def.unknownKeys() : def.unknownKeys;
  const out: UnknownRecord = { type: "object", properties };
  if (required.length > 0) out.required = required;
  if (unknownKeys === "strict") out.additionalProperties = false;
  return { ...out, ...descriptionOf(schema) };
}

function toJsonSchemaOrNull(schema: z.ZodTypeAny): UnknownRecord {
  const def = defOf(schema);
  switch (def.typeName) {
    case "ZodString":
      return stringSchema(schema, def);
    case "ZodNumber":
      return numberSchema(schema, def);
    case "ZodBoolean":
      return { type: "boolean", ...descriptionOf(schema) };
    case "ZodLiteral":
      return { const: def.value, ...descriptionOf(schema) };
    case "ZodEnum":
      return { enum: def.values ?? [], ...descriptionOf(schema) };
    case "ZodArray": {
      const items = def.type ? toJsonSchemaOrNull(def.type) : {};
      return { type: "array", items, ...descriptionOf(schema) };
    }
    case "ZodObject":
      return objectSchema(schema, def);
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault": {
      const inner = def.innerType ? toJsonSchemaOrNull(def.innerType) : {};
      return { ...inner, ...descriptionOf(schema) };
    }
    case "ZodUnion": {
      const options = (schema as unknown as { options?: z.ZodTypeAny[] }).options ?? [];
      return { anyOf: options.map(toJsonSchemaOrNull), ...descriptionOf(schema) };
    }
    case "ZodRecord": {
      const values = def.valueType ? toJsonSchemaOrNull(def.valueType) : {};
      return { type: "object", additionalProperties: values, ...descriptionOf(schema) };
    }
    default:
      // ZodUnknown / ZodAny / 未识别节点：JSON Schema 任意值
      return { ...descriptionOf(schema) };
  }
}

/** 投影入口：永不抛出（异常节点降级为 `{}`），保证 tool.tools.list 出口稳定。 */
export function zodToJsonSchema(schema: z.ZodTypeAny): UnknownRecord {
  try {
    return toJsonSchemaOrNull(schema);
  } catch {
    return {};
  }
}
