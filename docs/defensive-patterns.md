# RainCode 防御式模式清单（defensive-patterns）

> **定位**：把 [PROGRESS §4](../PROGRESS.md) 的问题流水账沉淀为可评审的原则清单——每条模式 = 陈述 + 违反症状 + RainCode 实战案例（含任务/日期锚点）+ 评审检查点。同类问题复现时先查此表归位；新问题按 §0 格式记录并标注模式编号。
> **来源**：[deepseek-harness 调研报告](research/2026-10-03-deepseek-harness.md) §3 #3 借鉴其六条模式条目名（P-1~P-6），陈述与案例为 RainCode 语境的适配展开；N-1~N-5 为 RainCode 原生沉淀（含调研报告 §4 #3 的采纳落地）。
> **收录标准**：只收「复现两次以上、或一旦发生代价高昂」的模式；单发且自解释的问题留在 PROGRESS §4 即可。新沉淀路径：先在 PROGRESS §4 记录事实 → 归位到本清单既有条目，或提炼为新条目。
> **关联**：[CONTRIBUTING §2](../CONTRIBUTING.md)（提交前自评审按附表速查）· [legacy-items](legacy-items.md) L-17 · [testing.md §7](testing.md)（护栏变红约定）。

## 0. 问题记录格式（后续沉淀按此）

PROGRESS §4 的记录行按此格式撰写：

```
[日期] <症状> → 根因 → 处置（归位 P-x / N-x + 修复锚点）
```

- **症状**写「观察到的现象 + 复现条件」，不写推测；
- **根因**写「机制层面为什么」，要一眼能判属于哪条模式；
- **处置**必须给修复锚点（提交 / 文件 / 任务号）并标注归位编号——**归不出任何编号，意味着本清单缺一条模式，或该问题不值得沉淀**。

示例（PROGRESS §4 2026-10-03 B5 条目的归位形态）：`B5 修复首跑失败（复测仍超时 + ERR_USE_AFTER_CLOSE）→ readline interface close 之后 prompt() 内部 resume() 对已关闭接口抛错 → LineChannel.next() 先消费队列/判定 EOF，仅实际挂起等待时才触碰 interface（P-4）`。

## P-1 正交结果独立上报

**陈述**：一个动作产生多个相互独立的结局时，每个结局独立上报，不得合并成一个笼统的成功/失败。RainCode 语境下的推论：**错误是数据不是异常**——工具执行失败、单个外部 server 故障、单个投影列缺失，都必须以结构化结果到达各自关心方，而不是炸掉整条链路或被静默吞掉。

**违反症状**：一处失败导致整批失败；错误只有一个布尔值没有原因；某列读数恒为 0/缺省却无人发现。

**实战案例**：

- **MCP 失败隔离**（T2.2）：单 server 故障仅影响自身命名空间；`mcp.servers.health` 并发探测逐 server 独立投影 `ok/latencyMs/lastError`，探测失败不改状态机、不拖垮其他 server 的结果。
- **工具错误数据级回传**（T3.5 插件，全部内置工具同口径）：插件 `execute` 抛错 → `TOOL_EXEC_FAILED` 数据级结果回传，模型携错误续答收束，turn 不崩。
- **turns_count 投影列漏累加**（T4.5 首跑）：usage 三个正交量（input/output/turns）在 `accumulateUsage` 只原子维护了两个，turns 恒 0 且被旧断言 `>= 0` 掩盖（见 N-2）——正交量必须逐列显式维护，修复为同一 SQL 语句原子自增。

**评审检查点**：

- 批量操作的每个单元都有独立成败投影（而非首错中断或全部成功才成功）；
- 错误同时携带机器可判的 code 与人类可读的原因；
- 每个聚合读数（usage/计数/状态行）可追溯到独立维护点，且测试断言对其有区分力。

## P-2 公共契约两侧遵守

**陈述**：共享契约的每一侧都必须完整遵守契约本身，而不是依赖对方当前实现的巧合行为。凡是「两侧」结构——协议帧的 server/client、schema 的读写形态、ctx 的组装方与消费方、stdin 的读方与写方——任何一侧都不得引入对方无法感知的假设；契约演化时两侧同步改。

**违反症状**：一侧加了字段/改了形态，另一侧集成时才炸；文档形态与代码校验各说各话；逐字段手拷漏项。

**实战案例**：

- **executor ctx 重建漏字段**（T4.4 首跑）：`executor.executeInner` 显式逐字段重建 handler ctx，新增 `expandSkill` 通道后漏拷 → 工具路径不可用。逐字段手拷是契约的第二份手工维护——能透传就透传，必须重建时用类型迫使完备（缺字段编译红）。
- **mcp.json 双形态**（T3.9 走查）：生态形态（serverKey 由 map 键承载）与方法面 schema（serverKey 必填字段）两侧都要被尊重——`loadFile` 按 map 键注入 + 显式字段一致性校验，写回向后兼容；smoke 一直写冗余字段，文档形态从未被真身文件暴露。
- **stdin 单读方契约**（2026-09-28，d4090ac）：同一 stdin 只允许挂一个 readline interface——双 interface 时按键被双消费各自回绘。「单读方」是读方之间约定，写方（管道另一端）无法替你执行。
- **畸形帧按角色处置**（06 §1.2，T2.8/T3.8）：同一帧协议两侧各自遵守处置规则（server 角色可定位 id 回 PARSE_ERROR、client 角色丢弃 + 告警，均不断开）；`WsSocketLike` 双面结构让 node/浏览器两侧满足同一结构面而 rpc 包零运行时依赖。
- **/json/new 目标 URL 的 `&` 截断**（2026-10-04，T4.7 走查首跑）：DevTools HTTP 端点 `/json/new?<url>` 的 query 解析在第一个 `&` 处截断目标 URL（直拼与 `url=` 编码两种形态实测一致），带多参数的工作台 URL 被静默剥掉 `&ws=` → 页面回退默认端点、「永远重连」假象——对外部接口的契约以实测行为为准而非文档想象；走查 openTab 改为 `/json/new?about:blank` 建 tab + targetId 连接 + `Page.navigate` 导航（CDP 通道不经 query 解析）。

**评审检查点**：

- 新增 ctx/port/params 字段时，全局搜索该结构的所有「重建/手拷」点位，而非只改消费点；
- 文档示例与 schema 校验器吃同一套形态（用真身文件冒烟，而非测试专用形态）；
- 独占资源（stdin/句柄/单写者链）在契约注释中写明唯一所有者。

## P-3 异步状态不是同步状态

**陈述**：在途、过期、投影中的异步状态，不得当作已落定的同步事实来读。三个 RainCode 推论：投影不是事实源、合并帧不是逐帧、端侧视图是缓存。「丢失/不一致」类判定必须以永不合并的事件或服务端投影为锚点。

**违反症状**：竞态窗口内的中间态被当最终态；重连后 UI 与服务端不一致；时序断言在负载波动下闪失败。

**实战案例**：

- **审批快照执行**（T2.7/T2.8）：审批闭环中 UI 收到的 `pendingApprovals` 是脱敏投影（复用 `permission.requested` payload，`normalizedInput`）；决策以服务端 grantId 唯一仲裁，补推是投影重建、不产生第二个决策通道；越界升级链「批准 = 批准审查时看到的那个绝对路径」（获批后 `pathPolicy allowEscaped` 精确放行该路径）——决策绑定快照，不重放可变状态。
- **delta 合并 × seq 缺口检测**（2026-10-02）：传输层合并帧 seq 取最新，端层若逐帧判缺口必然误报——规则定为「message.delta 只推进基线不判定缺口，其余事件跳变即真实丢帧」；web-client 连接期把全部已登记事件名挂上基线推进（未订阅事件也参与）。
- **setSeqBaseline 基线防回退**（T4.9 B3）：resume 响应与在途事件竞态时，过期 lastSeq 不得回退已观察基线（单测锁定）。
- **真浏览器 stale 分层判别**（T4.9 B3 / L-21）：第二窗口不更新时按序判别——node 第三连接探针 → 客户端路径完整模拟 → CDP 帧捕获——先证明服务端扇出与帧到达，再怀疑端侧。T4.7 walkthrough-web E 场景以 `Page.setWebLifecycleState` 冻结/解冻确定性复现并收口（L-21 ✅）：冻结期回合不达 → 解冻零交互补偿拉平；假说成立（Edge 后台标签冻结），无需修码。设计前提：端侧视图是缓存，必须允许它过期。
- **MCP Connected 事件 × listTools 竞态**（T2.2 教训）：状态事件先行 ≠ 工具清单就绪，refreshTools 重试兜底。

**评审检查点**：

- 「丢帧/丢失/不一致」判定使用永不合并的锚点事件或服务端投影，而非可合并流；
- 投影（快照/补推/脱敏视图）不携带仲裁权——决策字段唯一事实源在服务端；
- 时序敏感断言采样化（区间内恒成立 + 至少观测到一次），不做单点瞬态断言。

## P-4 dispose 必须达到静默

**陈述**：释放完成后必须达到「静默」——不再有任何回调、错误、写入从已释放的资源冒出来。RainCode 的 close 四步曲：**先设拒绝栅栏**（后到的请求得到类型化错误而非新句柄）**→ 排空在途工作 → 释放句柄 → 幂等**（重复 close 复用同一 promise）。

**违反症状**：close 后偶发 EBADF / ERR_USE_AFTER_CLOSE / SQLITE 错；进程退出有噪音；测试留下空转的孤儿进程。

**实战案例**：

- **Storage.close 收尾竞态四层修复**（T4.2，L-06 核销）：流内单写者链排空 → Storage `closing` 栅栏（close 后 `openSessionStream` 抛类型化 `STORAGE_CLOSED`，不再经 close 窗口重开句柄）→ `LoopEvents.flush()` → shutdownService 排空链（主会话 → subagent 停止级联 + `flushPersist` → 才关存储）；全部幂等。
- **readline close 后一切触发 resume() 的调用带雷**（T4.9 B5）：interface close 之后 `prompt()`/`question()` 内部 `resume()` 直接抛 `ERR_USE_AFTER_CLOSE`（管道 EOF 场景下队列非空也不能幸免）——`LineChannel.next()` 先消费队列/判定 EOF，仅实际挂起等待时才触碰 interface。
- **测试孤儿进程收割**（L-17）：挂起的测试子进程不退出会空转烧 CPU，破坏时序敏感用例——spawn 的每个子进程都要有收割路径；复跑套件前先查杀孤儿是习惯动作。
- **容器退出后 best-effort `docker rm -f`**（T3.1）：taskkill 硬杀防容器孤儿——dispose 责任归启动方，不指望环境兜底。

**评审检查点**：

- close 之后到达的调用得到类型化错误（栅栏），不重开句柄、不落写入；
- 收尾前有显式排空点（flush），close 幂等可重入；
- 测试/脚本 spawn 的子进程有对应收割路径。

## P-5 派发器收容回调异常

**陈述**：调用回调/插件/钩子的一方必须收容其异常——回调炸不等于宿主炸。fire-and-forget 与一切扩展点（域 init、插件 activate、抽取钩子、压缩钩子）都是派发器：异常必须降级为该单元的 failed 状态 + 诊断，宿主与无关单元照常。

**违反症状**：一个坏插件/坏配置让整个 agent 崩溃循环；`void` promise 的 rejection 无人处理。

**实战案例**：

- **域 init 降级不崩溃**（T3.9 走查）：损坏 mcp.json 使 `McpRuntime.init()` 拒绝，经 `void init()` 成为未处理拒绝 → agent 崩溃循环 5 次放弃——修复为 init 失败降级 stderr 诊断 + 域空转（节点其余功能照常），降级路径单测锁定。
- **插件故障隔离**（T3.5）：坏清单/activate 抛错 → 该插件 failed + lastError，不阻塞启动与其他插件（smoke case C 锁定）。
- **记忆抽取失败跳过**（T2.4）：MemoryExtractPort 30s 超时 / 宽容 JSON 解析 / 失败仅跳过——记忆是增强面，不得反噬主链路。
- **compact onBeforeReplace 钩子**（T2.4）：钩子失败仅诊断不阻塞压缩。

**评审检查点**：

- 每个 `void`-promise 的 rejection 都有归属（catch → 诊断/降级）；
- 扩展点边界有「单元级 failed 状态」可投影，而非仅 console 告警；
- 「增强面」（记忆/抽取/诊断上报）失败必须不影响主链路收束。

## P-6 不给不可信输出环境变量或可预测路径

**陈述**：执行不可信内容时，压缩其自由度——不传递环境变量、不使用可预测路径、默认从严显式收窄。RainCode 的不可信面 = 模型下发的命令/参数、外部 MCP server、插件代码、工作区之外的文件系统。

**违反症状**：拼接路径逃逸工作区；DNS/重定向绕过黑名单；密钥出现在日志/落盘/输出。

**实战案例**：

- **SSRF 强制黑名单 fail-closed**（T2.7）：IPv4 11 段 + IPv6 全族 + DNS 解析后逐 IP 校验 + DNS 失败 fail-closed + 重定向逐跳重校验上限 5 跳（`TOOL_SSRF_BLOCKED`）——黑名单在「解析后」与每一跳上生效才是真黑名单。
- **路径逃逸防护族**：技能/插件名 `[a-z0-9-]+` 校验、插件名与目录名一致性校验（T3.4/T3.5）；bash `guardPath` 保证 cwd ∈ workspace（T3.2）；web-host 静态资源路径穿越防护 + 421 纯 WS 端点提示（T3.8）。
- **秘密治理**（04 §5.3）：apiKeyRef 密钥引用制（响应/落盘/日志零明文）；web token 自动生成仅打印 stderr 绝不落盘；ws.auth sha256 + timingSafeEqual 常数时间比较。
- **插件 metadata 缺省从严**（T3.5）：`needsApproval=true` / `riskLevel=medium` 缺省、声明可收窄——不可信代码注册的工具默认走审批。
- **高危根命令通配 allow 强制降级 ask**（M1 Wave 5）：规则面自身也不被信任——过宽的 allow 被判定链降级。

**评审检查点**：

- 名字/路径类输入先过字符白名单与归一化校验，再触碰 fs；
- 网络类工具黑名单在 DNS 解析后与每次重定向上生效，失败 fail-closed；
- 凭据只走引用制与内存；新增日志/事件/落盘点前先过一遍密钥面。

## N-1 分辨率不足的信号不能单独支撑判定（mtime 盲窗）

**陈述**：Windows 文件时间戳有效粒度为系统时钟刻（实测 ~15.6ms）——「stat → 外部写 → stat 复检」整个窗口落在同一 tick 内时 mtime 完全不变，mtime 差分对同 tick 外部写天然盲视（smoke-memory case B 复跑失败率 ~80%；T3.3 时的 4/4 只是时序巧合）。

**处置**：变更判定用双指标收敛——`FileSnapshot` 增 `size`（字节数精确无粒度）与 mtime 并用，S2 复检与 rename 回退检查双路同口径，修复后 6/6 确定性；确定性要求更高的场景用注入钩子（`SectionEditHooks.onBeforeRecheck`）。

**检查点**：并发/变更检测依赖的每个信号，先问「它的分辨率足以表达我要检测的差异吗」；不足以时叠加第二指标或改用注入口。

## N-2 断言必须有区分力，测试不得自建平行装配

**陈述**：两条 M4 首跑教训——① smoke-kernel 旧断言 `turnsCount >= 0` 恒真，掩盖 turns_count 恒 0 的全链路失真（T4.5）；② 单测冒烟自建节点手装 memory 域，造成四个真实入口漏装 memory 域的测试盲区，记忆管理器 UI 全挂才暴露（T4.9 B2）。

**处置**：断言收紧到有区分力的下界（`>= 1` + storage 回归单测）；冒烟/走查一律走真实装配入口（`createAgentServiceNode` 全域默认形态），禁止为绕过装配成本而手装域。

**检查点**：写断言时先想「被测值坏掉时这条会红吗」；新增装配字段时 grep 全部真实入口（CLI context / stdio host / web 宿主 / 桌面 agent entry）。

## N-3 验证世界而非自述；guard 只在回归能变红时才叫 guard

**陈述**：调研报告 §4 #3 采纳落地——e2e 重读落盘文件而非信 agent 自述；走查驱动真实构建产物（CDP）而非 mock；护栏的价值在于「能变红」，恒真断言与从未触发过失败的降级路径都不算 guard。

**RainCode 落点**：walkthrough-desktop.mts（CDP 驱动 electron 构建产物 14 断言）；smoke 全链重读落盘数据断言；T4.3 `protocol:check` 的验收方式 = 手改生成文件必须变红、再 `protocol:gen` 恢复；T4.5 turns_count 断言收紧（N-2 同源）。

**检查点**：新增门禁/护栏/降级路径时，演示一次「变红路径」再合入。

## N-4 基准必须测真实存活的进程树

**陈述**：NFR-4 首测（T2.10）时 agent 子进程因 dev spawn 路径 bug 处于崩溃循环放弃状态，进程树仅含 main+renderer，339.8MB 读数偏保守失真——「能跑通的门禁」≠「联调过的功能」。

**处置**：修 spawn 路径后复跑（m2 报告 §7 补录 414.5MB / m3 报告 450.8MB，均含 agent 子进程真实存活）；基准报告必须注明进程树构成与口径。

**检查点**：性能基准前确认被测对象「真的活着且在跑真实路径」；读数异常乐观时先怀疑没测到。

## N-5 宿主环境假设必须显式化，并就地自检（T4.7 打包链沉淀）

**陈述**：构建产物要跨运行时世界与宿主环境交付——编译 ABI、OS 特权、路径语义、网络可达性都是「当前开发机恰好满足」的隐式假设。dev 树绿 ≠ 产物能用：每个环境假设要么消除，要么在打包/发布脚本中显式声明并就地自检（fail-fast 且报因），不得依赖「在我机器上能过」。同族四案发生在 T4.7 一次 dist 冒烟内，全部在关键交付路径上。

**违反症状**：换机器或装成产物后才炸（ABI 失配、特权缺失、路径解析语义变化、下载失败）；构建在 A 机绿 B 机红且报错指向随机深处。

**实战案例**（T4.7 L-04，修复锚点 apps/desktop/scripts/prepare-native.mjs · dist.mjs · src/main/main.ts）：

- **better-sqlite3 双 ABI 世界**：dev 树副本为系统 node 编译（CI/dev agent 都走 node），packaged agent 以 ELECTRON_RUN_AS_NODE 运行（electron ABI）——NODE_MODULE_VERSION 失配即崩。处置：prepare-native.mjs 暂存 electron-ABI 副本（ABI 号经本机 electron 二进制 `process.versions.modules` 实测，不维护映射表）→ extraResources 随包分发 → packaged env 以 NODE_PATH 回退注入（正常路径找不到才命中，不遮蔽 dev 树）→ 探针自检。探针自身踩坑：cwd 在仓库内时 require 先命中 dev 树副本造成假红/假绿——**自检探针的解析世界必须与目标世界同构**（cwd 挪到仓库外中性目录）。
- **winCodeSign 7z 内 darwin 符号链接**：普通权限解包即失败（「客户端没有所需的特权」），且两项 darwin 签名工具对 Windows 未签名构建毫无用处——dist.mjs 预填充 electron-builder 缓存（容忍该两项失败 + Windows 侧关键文件在位校验 + 删除 darwin 残目录）。
- **asar 虚拟路径作 spawn cwd**：`desktopRoot()` 的 `__dirname/../..` 算术在打包态解析进 app.asar（文件非目录）→ spawn ENOENT 且报错只指向 exe 本身。处置：agent 目录 asarUnpack 成真实文件，打包态入口/migrations 取 `app.asar.unpacked` 孪生路径、cwd 取安装根（`dirname(process.execPath)`）。
- **github 直连受限**：electron zip、electron-builder-binaries（nsis/winCodeSign）、better-sqlite3 prebuild 三条下载线全部经 gh-proxy 前缀镜像——dist.mjs / prepare-native.mjs 以 env 缺省注入（`ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` / `RAINCODE_GH_PROXY`），显式声明、可覆盖、不散落。

**检查点**：打包/发布脚本新增步骤时问「这一步对宿主环境做了哪些假设（ABI / 特权 / 路径语义 / 网络）」；自检探针先声明自己验证的是哪个世界（运行时、cwd、解析路径），与目标世界同构才算数。

---

## 附：速查表（提交前自评审用）

| 编号 | 一句话 | 代表案例 |
| --- | --- | --- |
| P-1 | 正交结果独立上报，错误是数据 | MCP 失败隔离 / turns_count 逐列维护 |
| P-2 | 公共契约两侧遵守，不依赖巧合 | executor ctx 手拷漏字段 / mcp.json 双形态 / stdin 单读方 / /json/new `&` 截断 |
| P-3 | 异步状态不是同步状态 | 审批快照执行 / seq 缺口锚点 / 端侧视图是缓存 |
| P-4 | dispose 必须达到静默（栅栏→排空→释放→幂等） | close 四步曲 / readline close 雷 / 孤儿进程收割 |
| P-5 | 派发器收容回调异常 | 域 init 降级不崩溃 / 插件 failed 隔离 |
| P-6 | 不可信输入：白名单 + fail-closed + 秘密不出内存 | SSRF / 路径逃逸防护族 / apiKeyRef |
| N-1 | 分辨率不足的信号叠加第二指标 | mtime + size 双指标 |
| N-2 | 断言有区分力，测试走真实装配 | `>= 0` 恒真教训 / B2 手装域盲区 |
| N-3 | 验证世界而非自述；guard 要能变红 | CDP 走查 / protocol:check 变红演示 |
| N-4 | 基准测真实存活进程树 | NFR-4 口径申报 |
| N-5 | 宿主环境假设显式化 + 探针声明自己的世界 | electron-ABI 暂存 / winCodeSign 特权 / asar 路径语义 / gh-proxy 镜像 |
