/**
 * ToolRegistry 白名单投影（02-module-design §4.1/§4.3）：
 * 子会话与主会话共享同一 ToolRegistry 实例，但以白名单过滤投影隔离可见工具——
 * 子会话投影不含 `agent` 工具（层级固定 2，防递归失控，02 §4.4 天然不可达）。
 *
 * 实现：class extends + override（不改 tools 包任何现有签名与行为；ToolRegistry 的
 * private 字段不阻断 extends——投影经闭包委托底层 registry，而非自有注册表）。
 * 投影不可变：register/unregister 一律抛错；sourceOf 透传（来源信息无保密需求，02 §4.3）。
 */
import { ToolRegistry } from "@novacode/tools";
import type { Tool, ToolDescriptor, ToolSource } from "@novacode/tools";

/** 只读白名单投影：get/has/list/size 只暴露 allow 集合内的工具；写操作一律抛错。 */
export function projectRegistry(registry: ToolRegistry, allow: ReadonlySet<string>): ToolRegistry {
  class ProjectedRegistry extends ToolRegistry {
    override get(name: string): Tool<any, any> | undefined {
      return allow.has(name) ? registry.get(name) : undefined;
    }

    override has(name: string): boolean {
      return allow.has(name) && registry.has(name);
    }

    override list(filter?: { source?: ToolSource }): ToolDescriptor[] {
      return registry.list(filter).filter((descriptor) => allow.has(descriptor.name));
    }

    override register(_tool: Tool<any, any>, _source?: ToolSource): void {
      throw new Error("read-only projection");
    }

    override unregister(_name: string): boolean {
      throw new Error("read-only projection");
    }

    override sourceOf(name: string): ToolSource | undefined {
      return registry.sourceOf(name);
    }

    /** 与 list 语义一致的可见数量。 */
    override get size(): number {
      return registry.list().filter((descriptor) => allow.has(descriptor.name)).length;
    }
  }
  return new ProjectedRegistry();
}
