/**
 * RainCode 官方示例插件（T3.5；examples/plugins/hello）。
 *
 * 安装（发布）：将本目录整个拷贝到 `<RAINCODE_HOME>/plugins/hello/`，重启会话服务或经
 * `plugins.setEnabled {name:"hello", enabled:true}` 激活；工具以
 * `plugin__hello__greet` / `plugin__hello__word_count` 全名注册（source=plugin）。
 *
 * 插件模块契约（06-api-spec §2.10）：
 * - `activate(context)`：必选，返回工具描述符数组（name/description/execute 必填，
 *   parametersJsonSchema 可选 JSON Schema 直通，metadata 可选——缺省从严 needsApproval=true）；
 * - `deactivate()`：可选，停用/收尾时被调用（抛错仅诊断，不阻塞工具注销）。
 */
export function activate() {
  return [
    {
      name: "greet",
      description: "生成一句问候语（示例插件工具；参数 name 可选，缺省 world）",
      parametersJsonSchema: {
        type: "object",
        properties: { name: { type: "string", description: "被问候的名字" } },
      },
      metadata: { readOnly: true, needsApproval: false, riskLevel: "low" },
      async execute(args) {
        const name = typeof args?.name === "string" && args.name.trim().length > 0 ? args.name.trim() : "world";
        return `Hello, ${name}!（来自 RainCode 示例插件 hello）`;
      },
    },
    {
      name: "word_count",
      description: "统计文本的字符数与词数（示例插件工具；演示 JSON Schema 参数与非字符串返回值序列化）",
      parametersJsonSchema: {
        type: "object",
        properties: { text: { type: "string", description: "待统计文本" } },
        required: ["text"],
      },
      async execute(args) {
        const text = typeof args?.text === "string" ? args.text : "";
        return { chars: Array.from(text).length, words: text.split(/\s+/).filter(Boolean).length };
      },
    },
  ];
}

export function deactivate() {
  // 无需清理；保留导出以演示可选反激活钩子
}
