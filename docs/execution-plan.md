# DSH GoalMesh 执行计划

## 执行原则

- 架构基线：`dsh-goalmesh-tool-architecture.md`。
- 新实现仓库：`D:\harness learning\dsh-goalmesh-plugin`，由计划点 2 创建并初始化 Git。
- Harness 前置改动：`D:\harness learning\deepseek-harness`。该仓库已有与本任务无关的 working tree 修改；每次只按明确路径暂存本计划文件，不改、不暂存、不整理用户改动。
- 每个编号完成全部代码、文档与聚焦验证后只提交一次；验证失败时继续修复，不用“修复提交”掩盖同一计划点。
- 计划点 1 和 6 在 `deepseek-harness` 提交；计划点 2、3、4、5、7 在新插件仓库提交。
- 计划点 4 完成后形成 `0.1` 产品闭环；计划点 5 形成 `0.2`；计划点 7 形成 `0.3`。

## 计划点 1：Harness 支持下游 ignorable log-only Session event

**仓库**：`deepseek-harness`

**产出**：non-surface `Session.append(type, data, { ignorable: true })` 写入能力；类型、snapshot、seed/restore、持久化 round-trip、双语 Session 文档与 Agent Note 一致。

**验收**：未传 option 的现有事件仍为 required-on-read；只有 `true` 合法；未知且 ignorable 的事件可经 JSONL/SQLite 重载；聚焦测试、typecheck、doc-sync、lint 与 `git diff --check` 通过。

**commit**：`feat(session): allow ignorable downstream log events`

## 计划点 2：创建可安装 Bundle 与三包 workspace

**仓库**：`dsh-goalmesh-plugin`

**产出**：Bundle distribution、Host 包、Web client 包、构建/测试配置、根 README，以及定稿架构和本计划的仓库内副本；Bundle patch 一次插入 invariant registry、Host、Host invariant 与 Web Entry，保证默认 Profile 自洽加载。

**验收**：依赖安装、typecheck、空实现 build、package tarball 检查和 patch 静态测试通过；本地 `dsh plugin add` 能解析四个 Entry。

**commit**：`chore: scaffold agent swarm plugin workspace`

## 计划点 3：实现 0.1 Host 固定批调度与 durable trajectory

**仓库**：`dsh-goalmesh-plugin`

**产出**：Config/provider lifecycle、root Tool schema、TaskReport 收窄与大小限制、Coordinator/Scheduler/Launcher、collect-all、并发限制、attempt/Swarm deadline、取消、quiescent dispose、八类 ignorable trajectory event、Recorder、invariant companion、generic card。

**验收**：1/4/5/64 task、乱序稳定结果、start/result/dispose failure、timeout/cancel race、plugin dispose、`ToolExecutionToken` 重入、exact-key admission、trajectory 合法前缀、Native/Code Mode 与 assembled composition 覆盖通过。

**commit**：`feat: add foreground agent swarm scheduler`

## 计划点 4：实现 0.1 Web 动态 Agent 树

**仓库**：`dsh-goalmesh-plugin`

**产出**：ConversationNodeDefinition、live/replay/prepend 等价 fold、树与详情面板、locale/CSS、listed Session 与 catalog-proven subagent 导航、remote run 不可导航处理。

**验收**：组件、fold、64 节点、orphan/cycle/depth cap、导航权限、client dispose 与真实 Web composition 测试通过；刷新后树与实时树一致。

**commit**：`feat(web): render durable agent swarm trajectory`

## 计划点 5：实现 0.2 invocation 内 DAG 与 failure mode

**仓库**：`dsh-goalmesh-plugin`

**产出**：版本化 Tool schema、DAG admission、waiting/ready、dependency materialization、fail/skip/partial、fail-fast/quorum、deadlock audit 与 Web 依赖详情。

**验收**：missing/cycle 原子拒绝、join、三种传播、invocation-scoped fail-fast/quorum、无 ready work 的 deadlock、稳定结果与 replay 测试通过。

**commit**：`feat: add swarm dag and failure policies`

## 计划点 6：Harness 支持 one-shot subagent scopedSetup

**仓库**：`deepseek-harness`

**产出**：`SubagentCapabilities.scopedSetup`、`SubagentStartRequest.scopedSetup`、service capability check、spawn/fork creation transaction 集成、remote false 声明、双语 subagent 文档与 Agent Note。

**验收**：setup 在 publication/首个 followup 前完成；async setup 和 commit failure 完整 rollback；dispose 撤销 scoped registration；provider 不支持时 fail loud；聚焦测试、snapshot、typecheck、doc-sync、lint 与 `git diff --check` 通过。

**commit**：`feat(subagent): add scoped one-shot setup`

## 计划点 7：实现 0.3 nested GoalMesh

**仓库**：`dsh-goalmesh-plugin`

**产出**：SwarmLease issue/revoke、child-scoped 同名 Tool、nested barrier、controller 子树、`waiting_children/ready_to_resume`、permit 释放与重获、attempt fencing、分层取消、nested trajectory。

**验收**：`maxConcurrency=1` 不死锁；nested goal/伪造 ID 被拒绝；parent 未重获 permit 前 Tool Promise 不返回；parent/child/root 三层取消范围正确；lease/scoped Tool 随 dispose 撤销；remote provider fail loud；真实组合与 snapshot 通过。

**commit**：`feat: support nested agent swarms`

## 最终验证（不产生额外 commit）

- 两个仓库 working tree 仅保留用户原有无关修改，计划提交全部干净。
- 插件仓库运行 test、typecheck、lint、build、package smoke 与 `git diff --check`。
- Harness 对两个提交分别保留聚焦验证证据，并在最终头部状态运行受影响 package tests、typecheck、lint、doc-sync 与 `git diff --check`。
- 在 Web Profile 安装 Bundle，验证 Tool 可见、固定批/DAG/nested 三条真实路径、trajectory 实时更新、刷新回放和 child Session 导航。
- 汇总每个 commit hash、验证命令、已知限制与未触碰的用户改动。
