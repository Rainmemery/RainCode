# 贡献指南（CONTRIBUTING）

感谢关注 RainCode！本项目为 vibecoding 产物（AI 协作设计与开发），欢迎以同样的人机协作方式参与贡献。

## 1. 开发环境

- Node.js ≥ 20、pnpm 11（`packageManager` 已锁定）
- Windows 优先（CI 与开发均在 Windows 验证）

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm architecture:check   # 环境健康自检
pnpm smoke:p0                                            # 功能冒烟
```

## 2. 开发流程

1. **先读文档再动代码**：阅读 [docs/README.md](docs/README.md) 索引中对应模块的设计文档；开发会话开始时读 [PROGRESS.md](PROGRESS.md) 了解当前进度与下一步队列。
2. **小步提交**：一个功能点一个提交，提交信息使用 `feat:` / `fix:` / `docs:` / `refactor:` / `chore:` 前缀，聚焦"为什么"而非流水账。
3. **提交前门禁全绿**（缺一不可）：
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm architecture:check
   pnpm smoke:p0        # 涉及功能链路时
   pnpm bench:all       # 涉及性能路径时，与上一里程碑基准对比不劣化 ±10%
   ```
4. **架构约束**：跨包依赖只允许 `architecture/policy.yaml` 白名单中的 `requires`；跨包导入只能从对方 `index.ts`；单文件 ≤ 500 行；禁止循环依赖。越权改动请先在 Issue 中讨论并同步更新 policy。

## 3. 文档更新协议（强制）

文档与代码**同 PR 演进**，对应关系如下（与 [PROGRESS.md §6](PROGRESS.md) 一致）：

| 你改动了什么 | 必须同步更新 |
| --- | --- |
| 完成任务/波次 | [PROGRESS.md](PROGRESS.md) §1 状态快照 + §3 任务日志（含提交号） |
| 解决了一个值得复用的问题 | PROGRESS.md §4 问题记录 |
| 用户可见功能 | [README.md](README.md) 功能清单与用法 |
| 测试脚本/门禁 | [docs/testing.md](docs/testing.md) |
| 里程碑验收 | `docs/benchmarks/` 新增基准留存报告 + README 状态徽章 |
| 协议/架构/存储层 | 对应设计文档 `docs/04` / `05` / `06`（ADR 记录到 04-architecture） |
| API/事件契约变更 | `docs/06-api-spec.md` + `packages/shared` schema 同步 |

## 4. 安全红线

- **API Key 等凭据绝不入库**：本地配置使用 `config/*.local.json`（已被 .gitignore 隔离）或 `file:` 密钥引用；任何输出、日志、测试断言中不得出现明文密钥。
- 测试一律使用临时 `RAINCODE_HOME` 与本机回环 mock，禁止污染真实用户数据。

## 5. Issue 与 PR

- Bug 报告请附：复现步骤、预期/实际行为、`pnpm smoke:*` 相关结果、OS 与 Node 版本。
- PR 请描述：动机、改动范围、门禁运行结果；涉及协议变更需先开 Issue 对齐 `docs/06-api-spec.md`。
