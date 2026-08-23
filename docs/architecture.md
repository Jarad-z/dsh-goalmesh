# DSH GoalMesh 架构设计

- **状态**：0.3 实施基线（已核对并补齐 DeepSeek Harness 的 Tool、Subagent、Session 与 Web API）。
- **目标平台**：DeepSeek Harness `0.1.0-rc.5` 官方基线 `47f943859b`，加仓库内 `harness-patches/goalmesh-prerequisites.patch`（对应本地前置能力至 `e03b614c79`，2026-08-22）。
- **输入设计**：`GoalMesh批调度器设计指南.md`。
- **交付形态**：一个可安装的 DSH Plugin，向模型注册前台 `goal_mesh` Tool；内部复用 `ctx.subagents` 启动 child Agent。

## 1. 架构结论

第一版不要把 GoalMesh 做成另一个 Agent Runtime，也不要把它做成 `Promise.all(ctx.subagents.start(...))`。

实现由一个 DSH Host Tool plugin 和一个 Web client companion 组成。Host 包可在 headless Profile 独立运行；可安装 Bundle 同时插入两者，Web Profile 因而始终带 trajectory UI。Host 内部的 `SwarmCoordinator` 创建在插件 Fiber 中，位于所有 root/child Agent 之上；所有 GoalMesh Tool 变体都把命令提交给这一个共享对象。

```text
goal_mesh Tool Adapter
  root 使用全局 Tool；child 使用同名 agent-scoped Tool，并捕获 SwarmLease
            ↓
SwarmCoordinator
  插件级共享对象：Goal、Invocation barrier、Task/DAG 账本、单写者状态迁移
            ↓
SwarmScheduler
  ready/resume 队列、execution permit、timeout、取消、唯一结算
            ↓
SubagentLauncher
  适配 ctx.subagents.start()、publication 前 scoped setup、result 和 dispose()
            ↓
DSH Subagent Provider
  当前：spawn / fork；未来：满足必需 capability 的 remote provider

Coordinator commit
            ↓
TrajectoryRecorder → root Session 的 log-only events
            ↓
DSH Web ConversationNodeDefinition → 动态 Agent 树 → child Session 详情
```

这正是“传一个共同对象，放在 Agents 更高一级”的实现，但不要把完整可变 `SwarmRun` 直接交给每个 child。child 只拿一个不可伪造、可撤销、绑定当前 attempt 的 `SwarmLease`；它通过 agent-scoped `goal_mesh` Tool 的宿主闭包向共享 Coordinator 发命令。这样共享的是同一份权威账本，写入仍经过单写者队列，不会让兄弟 Agent 直接改彼此的 `Map`。

Host 调度内核仍是一个 npm 包，不新增公开 `ctx.goalMesh` Service；Web 只消费 durable events，不是第二个调度 owner。当前只有 Tool Adapter 一个 Host 消费者，公开 Service 会制造没有第二个消费者的能力面。等出现 CLI、RPC、后台控制器或替代 Scheduler Provider 后，再把 Coordinator 提升成正式的 Service Definition / Provider / Consumer seam。

必须分阶段交付：

| 版本 | 能力 | 是否需要修改 Harness |
|---|---|---|
| Harness 前置 | 下游 log-only Session event 可显式写入 `ignorable: true` | 已实现：`729b820e44` |
| `0.1` | root 调用、固定 task 集合、前台 collect-all、并发上限、稳定结果、取消和 timeout；durable trajectory 与 Web 动态树 | GoalMesh Host 否；需安装 Web client companion |
| `0.2` | invocation 内静态 DAG、依赖失败传播、fail-fast/quorum | 否 |
| `0.3` | child 嵌套调用自动 attach 同一 Swarm、`waiting_children` 释放 permit | 是；需要 one-shot child 的 publication 前 scoped setup 能力 |
| 后续 | 有限 task rerun、Provider-aware capacity、持久化恢复、effect reconciliation | 需要独立证据后再设计 |

`0.1` 不支持 background/detached task。Tool 返回前，它创建的全部 child 和尚未完成的 `ctx.subagents.start()` 都必须停止并完成资源释放。

## 2. 与现有 DSH 能力的边界

### 2.1 直接复用

GoalMesh 必须复用：

- `ctx.tools.register(defineTool(...))`：模型 Tool 的唯一注册与执行入口；
- `ToolRunContext.agent`：调用者身份与授权来源；
- `ToolRunContext.callId`：本次 invocation 的幂等相关 ID；
- `ToolRunContext.token`：同一次已接受 Tool execution 的不可伪造进程内幂等键；
- `ToolRunContext.signal`：root 或 nested ToolCall 的取消来源；
- `ctx.subagents.start(provider, request)`：child 创建和运行；
- `SubagentRun.id/localAgent/result/dispose()`：child identity、completion 与停稳；
- `SubagentResult.stopReason/output/structured`：任务终态；
- `outputSchema`：要求 child 返回结构化 TaskReport；
- Agent scoped tools、persona、tool filter 与 delegation depth；
- child `agent.ctx` 的 scoped Tool 变体与 Fiber 自动清理；
- DSH 自己的 `llm-retry`、`dsh-timeout` deadline primitive 和 Session log；
- Web 端 `ConversationNodeDefinition`、`conversation.chat.node` keyed slot、SessionRuntime 与 subagent catalog 导航。

### 2.2 不复用 `workflow` 作为内部执行器

现有 `workflow` Tool 很适合模型编写 JavaScript 的 map/pipeline/parallel 编排，但它不是 GoalMesh 的内部实现层：

| 维度 | `workflow` | `goal_mesh` |
|---|---|---|
| 模型输入 | JavaScript 脚本 | 声明式 Goal + TaskGoal[] |
| 状态 owner | worker 中的脚本运行 | host 中的 Coordinator |
| 任务图 | 脚本控制流 | 显式 Task/DAG 账本 |
| child 失败 | 普通失败折叠为 `null` | typed TaskResult/TaskFailure |
| 嵌套生产 | 不支持嵌套 workflow | 目标能力：child attach 同一 Swarm |
| Goal | 没有全局 Goal/局部 TaskGoal 协议 | root Goal 只读，child 执行局部目标 |
| 适用场景 | 大型但可先写成脚本的编排 | 递归分解、依赖感知、证据聚合 |

不要在 GoalMesh 内生成 workflow script 再执行。那会产生两套并发、取消、结果和错误账本，也会丢失 task/invocation 的直接身份。

### 2.3 不使用 `ctx.jobs`

GoalMesh 的首版是前台结构化并发：父 ToolCall 必须等待自己的 invocation。`ctx.jobs` 面向已经发布、可独立收集和取消的后台工作，生命周期语义不同。

如果未来要支持 background swarm，应在 root 调用开始前显式选择模式，并让原生 JobRegistry 持有整个 SwarmRun；不能在运行中把前台 Swarm “升级”为后台。

## 3. Plugin 目录设计

新建一个仓库、三个 DSH npm 包。`dsh-goalmesh-plugin` 是用户安装的 Bundle 包；Host Tool 与 Web client companion 分包，沿用现有 `dsh-tool-workflow` / `dsh-client-ui-workflow-run` 的所有权边界。Bundle 包依赖 invariant registry 与两个运行包，并一次插入 registry、Host、Host invariant companion 与 Web client 四个 Entry：

```text
dsh-goalmesh-plugin/
├─ package.json              # workspace 根，仅 private scripts
├─ pnpm-workspace.yaml
├─ packages/
│  ├─ goalmesh-plugin/    # 可安装 Bundle distribution
│  │  ├─ package.json
│  │  ├─ index.js            # inert node entry
│  │  └─ cordis.patch.yml    # 一次插入 registry/Host/invariant/Web 四个 Entry
│  ├─ tool-goalmesh/      # Host：模型 Tool、共享状态、持久事件
│  │  ├─ package.json
│  │  ├─ src/
│  │  │  ├─ index.ts
│  │  │  ├─ tool.ts
│  │  │  ├─ coordinator.ts
│  │  │  ├─ scheduler.ts
│  │  │  ├─ launcher.ts
│  │  │  ├─ state.ts
│  │  │  ├─ result.ts
│  │  │  ├─ failure.ts
│  │  │  ├─ types.ts         # browser-safe Session event payload
│  │  │  ├─ recorder.ts      # root Session trajectory
│  │  │  └─ invariant.ts    # 作为 ./invariant 子路径发布
│  │  └─ tests/
│  └─ client-ui-goalmesh/ # Web：事件折叠、动态树、Session 导航
│     ├─ package.json
│     ├─ src/
│     │  ├─ index.ts         # node half 可保持 inert
│     │  └─ client/
│     │     ├─ index.ts
│     │     ├─ trajectory-definition.ts
│     │     ├─ SwarmTrajectoryPanel.tsx
│     │     ├─ projection.ts
│     │     ├─ locales.ts
│     │     └─ SwarmTrajectoryPanel.module.css
│     └─ tests/
└─ README.md
```

Bundle distribution 的 `package.json` 使用当前 DSH bundle 格式，并把 invariant registry 与两个运行包声明为普通依赖，保证 Profile 解析 patch 中的裸包名。默认 Web Profile 不提供 `invariants` Service，因此 Bundle 必须自带 registry；只插入 companion 会让 Loader 永久等待：

```json
{
  "name": "dsh-goalmesh-plugin",
  "type": "module",
  "main": "index.js",
  "dependencies": {
    "@deepseek-ai/dsh-invariants": "^0.1.0-rc.5",
    "dsh-tool-goalmesh": "0.1.0",
    "dsh-client-ui-goalmesh": "0.1.0"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

Bundle 的 `cordis.patch.yml` 插入四个 Entry。Registry 与 invariant companion 独立于产品逻辑加载；Web 包的 node half 是 inert，只有 Web 的 client module scanner 会运行其 browser half：

```yaml
- insert:
    - id: goalmesh-invariants
      name: '@deepseek-ai/dsh-invariants'
    - id: goalmesh
      name: dsh-tool-goalmesh
      config:
        provider: spawn
        nestedMode: local-only
        maxConcurrency: 4
        maxTasks: 64
        maxDepth: 3
        swarmTimeoutMs: 900000
        attemptTimeoutMs: 300000
        maxTaskReportChars: 12000
        maxRenderedResultChars: 50000
    - id: goalmesh-invariant
      name: dsh-tool-goalmesh/invariant
    - id: ui-goalmesh
      name: dsh-client-ui-goalmesh
```

Web companion 在自己的 `package.json` 声明 client bundle metadata：

```json
{
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-conversation"
      ],
      "platform": "web"
    }
  }
}
```

插件入口：

```ts
export const name = 'goalmesh'
export const inject = ['tools', 'subagents', 'systemPrompt']

export function apply(ctx: Context, config: Config): void {
  const recorder = createTrajectoryRecorder(ctx)
  const coordinator = new SwarmCoordinator(ctx, resolveConfig(config), recorder)
  bindProviderAndToolLifecycle(ctx, coordinator, config)
  ctx.effect(
    () => async () => { await coordinator.dispose() },
    'goalmesh.coordinator()',
  )
}
```

Host 注册都通过 `ctx.tools.register()`、child scoped `childCtx.tools.register()`、`ctx.systemPrompt.section()`、`ctx.on()` 或 `ctx.effect()` 完成。Web 只通过 `ctx.conversationEvents.register()` 和 `ctx.slots.register()` 组合 UI；两边都随各自 Fiber 撤销。Coordinator 的 disposer 必须同步关闭 admission，再异步取消并等待所有 run 与 start promise 停稳。

`bindProviderAndToolLifecycle()` 先注册 `subagent/provider-added|removed` listener，再检查 `ctx.subagents.getProvider(config.provider)`，避免检查与订阅之间漏掉同步变更。只有 provider 满足 `outputSchema/depthLimit`，并在 `nestedMode: local-only` 下额外满足 `scopedSetup` 时，才挂载 root Tool 与对应 prompt section；能力不满足在 provider mount 时 fail loud。provider removal 立即撤下 Tool、关闭新 admission，但不撤销已经发布并由 Coordinator 持有的 run；排队 task 后续 start 若 provider 已不存在，按 `launch_failed` 结算。

## 4. 模型可见的 Tool 协议

### 4.1 Tool 参数

Tool 名默认为 `goal_mesh`。root 与 nested 使用同名但不同的参数 schema；发布的 schema 必须跟随版本能力，不能提前接受尚未实现的字段：

```ts
interface GoalMeshRootArgsV01 {
  readonly goal: {
    readonly statement: string
    readonly success_criteria: readonly string[]
    readonly constraints?: readonly string[]
  }

  readonly tasks: readonly {
    /** 只在本 invocation 内唯一，便于 depends_on 引用。 */
    readonly key: string
    readonly description: string
    readonly objective: string
    readonly acceptance_criteria: readonly string[]
    readonly expected_outputs?: readonly string[]
  }[]
}

interface GoalMeshRootArgsV02 extends GoalMeshRootArgsV01 {
  readonly tasks: readonly (GoalMeshRootArgsV01['tasks'][number] & {
    readonly depends_on?: readonly string[]
    readonly dependency_failure?: 'fail' | 'skip' | 'partial'
  })[]
  readonly failure_mode?: 'collect_all' | 'fail_fast' | 'quorum'
  readonly quorum?: number
}

interface GoalMeshNestedArgsV03 extends Omit<GoalMeshRootArgsV02, 'goal'> {}
```

`defineTool()` 当前把参数编译为隐式开放的顶层 object。两个 Adapter 因此必须先执行 exact-key 检查，再做 schema 之外的交叉校验；不能只依赖 TypeScript 推断或忽略未知字段：

1. `0.1` root 顶层只允许 `goal/tasks`；`0.2` 才增加 `failure_mode/quorum`。
2. `0.3` nested 顶层只允许 `tasks/failure_mode/quorum`，`goal` 和所有未知字段都拒绝。
3. `tasks` 非空且不超过部署 `maxTasks` 的剩余预算。
4. `key` 在 invocation 内唯一。
5. `depends_on` 只能引用本 invocation 已声明的 key，不能 self-depend，整图必须无环。
6. `quorum` 只允许和 `failure_mode: quorum` 一起出现，并满足 `1 <= quorum <= tasks.length`。
7. 模型不得传 `swarmId`、`invocationId`、`taskId`、`attemptId`、owner、provider 或任何未声明字段。

最后一条是授权边界：Swarm 归属来自 child scoped Tool 闭包里的不可伪造 `SwarmLease`，不来自模型可伪造的字符串，也不依赖事后用 Agent 做全局查表。

### 4.2 结构化 child 输出

每个 child 通过 `ctx.subagents.start(..., { outputSchema })` 返回统一 TaskReport：

```ts
interface SwarmGoal {
  readonly version: number
  readonly statement: string
  readonly successCriteria: readonly string[]
  readonly constraints: readonly string[]
}

interface TaskGoal {
  readonly objective: string
  readonly acceptanceCriteria: readonly string[]
  readonly expectedOutputs: readonly string[]
}

interface TaskReport {
  readonly reported_status: 'achieved' | 'not_achieved' | 'blocked'
  readonly summary: string
  readonly evidence: readonly {
    readonly claim: string
    readonly reference?: string
  }[]
  readonly output?: JsonValue
  readonly remaining_problems?: readonly string[]
}
```

`reported_status` 是 child 对局部 TaskGoal 的自评，不是 Coordinator 对全局 Goal 的判断。`InvocationTaskResult.status: completed` 只表示 child 正常结束并提交了有效 TaskReport；它不等价于 `reported_status: achieved`。Coordinator 在 provider 验证之外重新收窄 `structured: unknown`，并拒绝超过 `maxTaskReportChars` 的 JSON 投影，不能静默截断结构化证据后仍报告成功。

child prompt 必须由 host 构造，而不是让 root 模型复制整段上下文：

```text
Global goal（只读）
Success criteria
Constraints

Your local task
Acceptance criteria
Expected outputs
Resolved dependency results

Execution rules
- 只完成本地任务，不宣称全局 Goal 已完成。
- 需要进一步独立分解时，调用 goal_mesh；省略 goal 并等待返回。
- 最后按 structured_output schema 提交 TaskReport。
```

Global Goal 与 TaskGoal 会作为 child 的首条 user message 进入其 Session log，满足 DSH “model-visible means logged”的要求。

### 4.3 Tool 规范返回值

```ts
interface InvocationTaskResult {
  readonly taskId: string
  readonly key: string
  readonly status: 'completed' | 'failed' | 'skipped' | 'aborted'
  readonly attempts: number
  readonly childId?: string
  readonly report?: TaskReport
  readonly failure?: {
    readonly kind: string
    readonly message: string
  }
}

interface GoalMeshToolValue {
  readonly swarmId: string
  readonly invocationId: string
  readonly kind: 'root' | 'nested'
  readonly terminalReason:
    | 'all_tasks_settled'
    | 'quorum_reached'
    | 'failed_fast'

  /** 本 invocation 直接登记的任务，按输入顺序返回。 */
  readonly tasks: readonly InvocationTaskResult[]
  readonly summary: {
    readonly completed: number
    readonly failed: number
    readonly skipped: number
    readonly aborted: number
    readonly descendants: number
    readonly reportedAchieved: number
    readonly reportedNotAchieved: number
    readonly reportedBlocked: number
  }
}
```

Admission failure、Swarm deadline、调用者取消、plugin dispose 和 `state_corrupted` 不返回上述成功值；Tool Registry 把它们规范化为 `isError`。`budget_exhausted` 因而是 admission error，不是一个已登记 invocation 的 `terminalReason`。`collect_all` 中的 task 失败属于成功返回的聚合数据，父 Agent 仍能读取兄弟结果。

root ToolResult 返回时，结构化等待保证所有前台后代已经 terminal。root 返回可以在部署大小预算内附带 descendant evidence 摘要，但权威的直接结果仍是 `tasks`；不要把同一个后代重复展开到每一层 ancestor result。

返回值中禁止出现 `globalGoalAchieved`。root Agent 在 ToolResult 返回后，根据原始 `success_criteria`、所有直接 TaskReport 及其证据自行验收；若不足，它决定是否再开一轮 Swarm。

### 4.4 Tool 调度模式与 UI

`goal_mesh` 不声明 `isConcurrencySafe`，保持 exclusive：

- nested 调用会改变 caller task 的 `running/waiting_children` 状态；
- 避免同一个 child 在一次 assistant response 中并行开启多个 nested invocation，导致 permit 重入语义复杂化；
- 一次 ToolCall 本身已经可以提交整个 task 数组，不需要靠多个并行 ToolCall 提高吞吐。

UI 使用 generic card：

- pending title：`goal_mesh: <N> tasks`；
- rawInput：Goal statement 或 task description 列表；
- completed title：`goal_mesh: <completed>/<total> settled`。

`presentCall` 只能读取 args；`output.presentationMeta` 生成有界摘要，`presentResult` 只能读取 args、`result.content/isError` 与 `result.meta`，不能读取 Coordinator live state 或规范返回值的进程内引用。

## 5. 配置

```ts
interface Config {
  provider: string
  toolName?: string
  maxConcurrency: number
  maxTasks: number
  maxDepth: number
  swarmTimeoutMs: number
  attemptTimeoutMs: number
  maxTaskReportChars: number
  maxRenderedResultChars: number
  defaultFailureMode?: 'collect_all' | 'fail_fast'
  nestedMode?: 'disabled' | 'local-only'
  childAgentOptions?: AgentOptions
  childToolFilter?: ToolRestriction
}
```

所有部署可调数值都必须进入 Config 并在 `apply()` 时验证。建议首版默认：

| 配置 | 默认 | 说明 |
|---|---:|---|
| `provider` | `spawn` | 复用已注册的 subagent provider |
| `maxConcurrency` | `4` | 同一 Swarm 的 execution permit 上限 |
| `maxTasks` | `64` | 包含全部动态后代的总 task 上限 |
| `maxDepth` | `3` | 相对 Swarm root 的 task 深度上限；直接 task 的 depth 为 1 |
| `swarmTimeoutMs` | `900000` | 从 root admission 到 quiescence 的总期限 |
| `attemptTimeoutMs` | `300000` | 从 permit 授予到该 attempt 停稳的期限；排队只受 Swarm 总期限约束 |
| `maxTaskReportChars` | `12000` | 单个 TaskReport 的完整 JSON 字符上限；超限使该 task 失败 |
| `maxRenderedResultChars` | `50000` | 父模型看到的 Tool 内容上限 |
| `defaultFailureMode` | `collect_all` | 部分结果仍有价值 |
| `nestedMode` | `disabled` in 0.1 | 0.3 完成 scoped setup 后可设为 `local-only` |

配置的 `max*` 是硬上限。模型请求可以选择更保守的语义，但不能扩大部署预算。

Config 也按版本开放：`0.1` 不接受 `defaultFailureMode` 的非 `collect_all` 值，也不接受 `nestedMode: local-only`；`0.2` 开放 failure mode，`0.3` 才开放 local nested。配置提前写入未来值必须在 plugin load 时失败，不能静默忽略。

Launcher 传给 DSH 的绝对 `maxDepth` 必须计算为 `delegationDepthOf(rootAgent) + config.maxDepth`；不能把相对 Swarm 深度直接当作 DSH 的绝对 delegation depth。计算溢出在 admission 阶段失败。

当前 `spawn` 与 `fork` provider 同时支持结构化输出、depth limit 和 `scopedSetup`，可运行 `0.3` local nested。当前 ACP、Codex、Claude Code 与 DSH SDK provider 不支持必需的 `outputSchema/depthLimit/scopedSetup` 组合，配置成这些 provider 必须在最早可解析时 fail loud；架构图中的 remote provider 是未来兼容目标，不是当前支持声明。

## 6. 运行态

### 6.1 ID

内部全部使用 branded ID：

```ts
type SwarmId = Branded<'SwarmId'>
type InvocationId = Branded<'InvocationId'>
type SwarmTaskId = Branded<'SwarmTaskId'>
type AttemptId = Branded<'AttemptId'>
type LeaseToken = Branded<'LeaseToken'>
```

相关性：

```text
SwarmId
  └─ InvocationId（一次 ToolCall）
      └─ SwarmTaskId（一次不可变工作说明）
          └─ AttemptId（一次具体 child 运行）

Command key = ToolRunContext.token
```

`ToolExecutionToken` 是 Tool Registry 为一次已接受 execution 分配的不可伪造 `symbol`，比字符串拼接 `AgentId + callId` 更准确：`callId` 不承诺跨 turn 全局唯一，字符串拼接也有碰撞风险。Coordinator 用 token 做进程内幂等；重复执行同一 Tool body 时返回既有 invocation 或 terminal result，不得重复扩张任务树。首版不承诺跨进程重放，因此不把 token 持久化。

### 6.2 SwarmRun

```ts
interface SwarmRunState {
  readonly id: SwarmId
  readonly rootAgent: Agent
  readonly rootSession: Session
  readonly goal: SwarmGoal
  readonly controller: AbortController
  readonly deadlineAt: number

  readonly invocations: Map<InvocationId, InvocationState>
  readonly invocationsByCommand: Map<ToolExecutionToken, InvocationId>
  readonly tasks: Map<SwarmTaskId, TaskState>
  readonly results: Map<SwarmTaskId, TaskTerminalResult>
  readonly dependents: Map<SwarmTaskId, Set<SwarmTaskId>>

  readonly ready: SwarmTaskId[]
  readonly readyToResume: SwarmTaskId[]
  readonly activeAttempts: Map<AttemptId, ActiveAttempt>
  readonly activeLeases: Map<LeaseToken, LeaseRecord>
  readonly inFlightEffects: Set<Promise<void>>

  unfinishedTaskCount: number
  permitsInUse: number
  phase: 'running' | 'cancelling' | 'finished'
}
```

Coordinator 另有插件级 `rootInvocationsByCommand: Map<ToolExecutionToken, { swarmId; invocationId }>`。root command 在 Swarm 尚未存在时不能从 `SwarmRunState.invocationsByCommand` 反查；插件级索引负责第一次定位，run 内索引负责 nested command。索引随 run 的最后一个 invocation handle 释放，不能永久保留每次 Tool execution。

Coordinator 是这份状态的唯一写者，也是所有 Agent 之上的共同对象。Launcher、lease、timer、Promise callback 和事件 listener 只能提交命令，不能直接写 `ready/results/remainingTaskIds`。TrajectoryRecorder 只消费已经 commit 的 transition，同样不能反写调度状态。

### 6.3 SwarmLease：传给 child 的窄能力

`SwarmLease` 是共享 Coordinator 针对一个活跃 attempt 签发的宿主对象。它不是模型参数，也不是 `SwarmRunState` 的可变引用：

```ts
interface SwarmLease {
  readonly token: LeaseToken
  readonly swarmId: SwarmId
  readonly parentTaskId: SwarmTaskId
  readonly attemptId: AttemptId
  readonly goalVersion: number
  invokeNested(input: NestedInvocationInput): InvocationHandle
}
```

`invokeNested()` 内部只做参数封装并向 Coordinator 的单写者队列 enqueue；Coordinator 仍要核验 lease token 存活、attempt fencing、深度、总 task 预算和 `ToolExecutionToken` 幂等。child 拿不到 `tasks`、`results` 或兄弟 lease，因此不能绕开状态机。

约束：

- 插件 Fiber 中只有一个共享 `SwarmCoordinator`，它可以同时服务 root 与所有本地 child；
- child 创建时拿到 `Object.freeze()` 后的 lease，并由 agent-scoped 同名 Tool 的闭包持有；
- Tool 通过 lease 发命令，而不是从模型参数读取 `swarmId/taskId`，也不是调用后再用 `WeakMap<Agent, ...>` 猜关联；
- attempt terminal、取消或 dispose 时，Coordinator 先 revoke lease，再拒绝所有迟到 nested command；
- JavaScript 对象只能在同一进程传递；remote Provider 首版不支持 nested。未来若要支持，必须把 lease 降级为 opaque token，并通过 Host RPC 回到同一个 Coordinator。

### 6.4 ToolInvocation

```ts
interface InvocationState {
  readonly id: InvocationId
  readonly swarmId: SwarmId
  readonly commandToken: ToolExecutionToken
  readonly callId: CallId
  readonly callerAgent: Agent
  readonly parentTaskId?: SwarmTaskId
  readonly controller: AbortController
  readonly taskIds: readonly SwarmTaskId[]
  readonly remainingTaskIds: Set<SwarmTaskId>
  readonly completion: PromiseWithResolvers<InvocationResult>
  phase: 'open' | 'awaiting_resume' | 'settled'
}
```

一个 invocation 的 task barrier 只有：

```text
remainingTaskIds.size === 0
```

它只登记本次调用直接创建的 task。后代不需要展平到所有祖先；父 task 在 nested ToolResult 返回前不能 terminal，因此 ancestor 会传递性等待后代。root invocation 在 barrier 清零后可以 settle；nested invocation 先进入 `awaiting_resume`，只有 parent task 重新取得 permit 后才 resolve Tool Promise 并进入 `settled`。否则 nested work 虽然完成，parent Agent 会在没有 permit 的情况下恢复执行。

### 6.5 Task 与 TaskState

TaskSpec 创建后不可变：

```ts
interface TaskSpec {
  readonly id: SwarmTaskId
  readonly key: string
  readonly invocationId: InvocationId
  readonly parentTaskId?: SwarmTaskId
  readonly depth: number
  readonly taskGoal: TaskGoal
  readonly dependencies: readonly SwarmTaskId[]
  readonly dependencyFailure: 'fail' | 'skip' | 'partial'
}
```

可变账本单独保存：

```ts
type TaskPhase =
  | 'waiting'
  | 'ready'
  | 'starting'
  | 'running'
  | 'waiting_children'
  | 'ready_to_resume'
  | 'terminal'

interface TaskState {
  readonly spec: TaskSpec
  readonly controller: AbortController
  phase: TaskPhase
  unmetDependencies: number
  attemptNo: number
  currentAttemptId?: AttemptId
  currentAgentId?: SessionId
  openChildInvocationIds: Set<InvocationId>
  terminal?: TaskTerminalResult
}
```

`0.1` 只使用 `ready/starting/running/terminal`；`0.2` 增加 `waiting`；`0.3` 增加 `waiting_children/ready_to_resume`。先把状态字段和不变量设计好，但不要在首版暴露尚未实现的模型能力。

取消控制器形成 `SwarmRun → Invocation → Task → Attempt deadline` 层级。attempt 传给 provider 的 signal 是这四层信号的组合；取消一个 nested invocation 不会触碰 sibling，取消 parent task 会先取消其未完成的 child invocation 子树，取消 Swarm 才覆盖整棵树。每层只记录第一个终止原因，结果分类读取最先获胜的 signal reason。

## 7. Scheduler

### 7.1 单写者命令队列

JavaScript 单线程不等于没有竞态；每个 `await` 都允许 completion、timeout、cancel 和 nested call 交错。

每个 SwarmRun 使用同步 drain 的命令队列：

```ts
enqueue(command)
  → 若当前未 drain，queueMicrotask(drain)

drain()
  → 顺序 reduce command 到 state
  → 收集需要启动/取消/resolve 的 effect
  → 提交状态后执行 effect
```

锁或 reducer 内不等待 `ctx.subagents.start()`。外部 Promise 只能在 settle callback 中重新 enqueue 命令。

### 7.2 permit 与 task 生命周期分离

`maxConcurrency` 限制的是正在执行或恢复 Agent 的 permit，不是 non-terminal task 总数：

```text
waiting / ready               不占 permit
starting / running            占 1 permit
waiting_children              不占 permit
ready_to_resume               不占 permit，排队申请
terminal                      不占 permit
```

调度优先级：

```ts
while (hasCapacity() && readyToResume.length > 0) grantResumePermit()
while (hasCapacity() && ready.length > 0) startAttempt()
auditIfStalled()
finishIfComplete()
```

优先 resume 是为了避免已经拿到 child 结果的父 task 被新任务长期饿死。

### 7.3 统一 attempt 结算

所有 terminal 路径最终只提交一个 `AttemptSettled(attemptId, outcome)` command：

```text
校验 attemptId 仍是 task.currentAttemptId
  → 释放 permit
  → 写 terminal 或按明确策略 requeue
  → 更新 dependency 与 invocation 两本账
  → requestSchedule()
```

命令 reducer 内不能 `await SubagentRun.dispose()`。Launcher 在 effect 侧统一观察 `run.result`，随后等待 memoized `run.dispose()`，清理 signal listener/deadline，并在 child 停稳后 enqueue `AttemptSettled`。timeout 与 cancel 只 abort signal 并触发同一个 memoized disposer；start rejection 只有在 provider 已清理未发布资源后才 enqueue `AttemptLaunchRejected`。这些 callback 不得直接写 task result。

### 7.4 完成条件

不能用 `ready.length === 0 && active.size === 0` 判断 Swarm 完成。

权威条件：

```text
root Invocation 返回：remainingTaskIds.size === 0
nested Invocation 返回：remainingTaskIds.size === 0 AND parent 已重新取得 permit

Swarm 正常结束：
  rootInvocation.remainingTaskIds.size === 0
  AND unfinishedTaskCount === 0
  AND 所有 nested invocation 已 settled
  AND activeAttempts / inFlightEffects 为空
  AND permitsInUse === 0
```

如果 `ready=0、active=0、unfinished>0`，必须执行 dependency/wait audit，不能返回成功。

## 8. Launcher 对 `ctx.subagents` 的适配

```ts
interface AttemptControl {
  readonly attemptId: AttemptId
  readonly taskId: SwarmTaskId
  readonly signal: AbortSignal
}

type TaskCompletionOutcome =
  | { readonly ok: true; readonly report: TaskReport }
  | { readonly ok: false; readonly failure: TaskFailure }

interface Launcher {
  start(task: MaterializedTask, attempt: AttemptControl, lease?: SwarmLease): Promise<LaunchedTask>
}

interface LaunchedTask {
  readonly childId: SessionId
  readonly localAgent?: Agent
  /** 只在 result 与 dispose 都完成后 settle。 */
  readonly settled: Promise<TaskCompletionOutcome>
  /** 幂等触发取消并返回同一个 quiescence promise。 */
  dispose(): Promise<void>
}
```

实现步骤：

```ts
const run = await ctx.subagents.start(config.provider, {
  label: task.description,
  prompt: [{ type: 'text', text: task.prompt }],
  parent: task.parentAgent,
  signal: attempt.signal,
  outputSchema: TASK_REPORT_SCHEMA,
  maxDepth: task.absoluteMaxDepth,
  agentOptions: config.childAgentOptions,
  toolFilter: config.childToolFilter,
  ...(lease === undefined ? {} : {
    scopedSetup: childCtx => installChildGoalMeshTool(childCtx, lease),
  }),
})
```

其中 `scopedSetup` 是 0.3 需要补进 subagent seam 的能力；0.1/0.2 的 `nestedMode: disabled` 不传它。`childToolFilter` 只限制 global Tool，DSH 明确保证 scoped registration 仍可见，因此它不会隐藏后注册的 child-scoped `goal_mesh`。

然后同时观察 `run.result` 与 `run.dispose()`。业务结果失败和清理失败是正交结果：

- child 失败优先保留其 TaskFailure；
- child 失败且 dispose 也失败，保留原 TaskFailure，并附加已清洗的 cleanup diagnostic；不能把原失败替换成 AggregateError 文本；
- child 成功但 dispose 失败，该 task 不能报告为干净成功；
- 只有 dispose 完成后才能释放 permit 和结算 attempt。

### 8.1 DSH 当前能力对 retry 的限制

当前 `SubagentRun` 是 one-shot handle：只有 `result` 和 `dispose()`，没有 `resume()` 或 `retry()`。因此：

- `0.1` 固定 `maxAttemptsPerTask = 1`；
- Provider 请求层的 429/短暂错误交给已存在的 `llm-retry`；
- Scheduler 不通过错误字符串重新实现 Provider 429 策略；
- 未来 task rerun 只能明确表示“创建新 child 从头执行”；
- “同 Agent retry”必须先扩展 subagent seam，不能在 GoalMesh 文档里假装已经存在。

## 9. root 调用生命周期

```text
模型调用 goal_mesh(goal, tasks)
  → global Tool Adapter 从 exec.agent 取得 root owner
  → Coordinator 以 exec.token 去重
  → 单写者 commit SwarmRun + root Invocation + tasks
  → Recorder append run-start / invocation-start / task-created
  → ready task 入队
  → Scheduler 在 permit 内启动 ctx.subagents.start()
  → child publication 后 commit childId，append attempt-start
  → child 返回 TaskReport / stopReason
  → settleAttempt 唯一 commit
  → Launcher 等待 child dispose 停稳
  → append attempt-end / task-transition
  → 解锁 dependents，更新 invocation barrier
  → root barrier 清零且全局账本一致
  → 确认 active run 与 in-flight start 全部停稳
  → append invocation-end / run-end
  → 返回唯一 GoalMeshToolValue
```

root `exec.signal` abort：

```text
abort Swarm controller
  → 停止新派发
  → abort 所有 active attempt
  → waiting/ready task 结算为 aborted
  → 保留已经 terminal 的结果
  → 等待所有 SubagentRun.dispose()
  → Tool 返回包含已完成/已取消计数的 cancelled `isError`
```

调用者取消、Swarm deadline 与 plugin dispose 都映射为 `isError`；不要提供同一原因有时成功、有时失败的双重语义。已经完成的结果留在 trajectory 与有界错误摘要中，但取消不是普通成功值。

## 10. nested attach 与结构化等待（0.3）

### 10.1 scoped capability injection

child 调用 `goal_mesh` 时不传 `swarmId`。它看到的是创建窗口中注册的 agent-scoped 同名 Tool，该 Tool 的宿主闭包已经捕获 exact `SwarmLease`：

```text
Plugin Fiber
└─ shared SwarmCoordinator
   ├─ global goal_mesh Tool → invokeRoot()
   └─ child Agent scope
      └─ scoped goal_mesh Tool → captured lease.invokeNested()
```

因此 root/nested 不是运行到 Tool body 后再查表猜出来的，而是由 DSH Tool scope 在解析时决定。child Tool 被 Fiber dispose 时自动移除，lease 由 Coordinator 独立 revoke。

### 10.2 Harness scopedSetup 前置（已实现）

Harness 的 in-process driver 用 `parent.ctx.agents.create({ setup })` 完成 child composition，并在 `agents.create()` 返回后由 `drivePublishedRun()` 提交首条 `followup`。仓库内最小 Harness 前置补丁（源自提交 `e03b614c79`）已把 consumer-owned `scopedSetup` 暴露给 `ctx.subagents.start()`，因此 scoped Tool 会在 publication 和首个 request 前完成安装；实现不能退回到 `start()` 返回后再注册 Tool 的竞态方案。

subagent seam 的 publication 前 setup 是显式且受 capability 检查的：

```ts
interface SubagentCapabilities {
  readonly scopedSetup: boolean
}

interface SubagentStartRequest {
  readonly scopedSetup?: AgentSetup
}
```

约束：

- `scopedSetup` 只用于 trusted same-process child composition，可保留 `AgentSetup` 的 async setup 与同步 publication commit 语义；
- `ctx.subagents.start()` 在 provider 不支持 `scopedSetup` 时 fail loud；
- spawn/fork in-process provider 在现有 `applyChildComposition()` 之后调用它，并把返回值原样交给 `agents.create({ setup })`；Agent publication 与首个 `followup` 都发生在它完成之后；
- scoped setup 的注册归 child Agent scope；setup/commit 失败回滚整个未发布 child，child dispose 自动撤销已发布注册；
- ACP/Codex/Claude Code 等 remote provider 声明 `scopedSetup: false`；
- GoalMesh `nestedMode: local-only` 要求 provider 支持此能力，插件加载或首次可解析 provider 时失败，而不是静默降级。

GoalMesh 的 scoped setup 注册一个 child-scoped 同名 Tool。模型只看到普通 Tool schema；共享 Coordinator 与 lease 只存在于宿主闭包：

```ts
scopedSetup(childCtx) {
  const caller = childCtx.agent
  childCtx.tools.register(defineTool({
    name: config.toolName,
    description: NESTED_GOAL_MESH_DESCRIPTION,
    parameters: NESTED_GOAL_MESH_PARAMETERS,
    output: GOAL_MESH_OUTPUT,
    async execute(args, exec) {
      assertNestedArgsV03(args)
      if (exec.agent !== caller) throw new Error('nested caller does not own this lease')
      return await settleInvocationHandle(lease.invokeNested({
        callerAgent: caller,
        callId: exec.callId,
        commandToken: exec.token,
        args,
        signal: exec.signal,
      }))
    },
  }))
  childCtx.effect(
    () => () => coordinator.revokeLease(lease.token, 'child scope disposed'),
    'goalmesh.lease()',
  )
}
```

不要把完整 `SwarmRunState` 用 `childCtx.set()` 暴露成可写 Service。需要共享的是上层 Coordinator 的对象身份；需要传给 child 的只是带 fencing 的最小写入能力。DSH 的 global Tool restriction 不影响 scoped registration，因此 `childToolFilter` 与 nested Tool 可以组合，不需要伪造额外 allowlist。
### 10.3 nested 状态迁移

```text
父 child 正在 running
  → 调用 nested goal_mesh(tasks only)
  → 校验 lease token、revocation 与 attempt fencing
  → 原子创建 nested Invocation + child tasks
  → parent task: running → waiting_children
  → 释放 parent execution permit
  → nested tasks 调度、结算
  → nested invocation barrier 清零
  → parent task: waiting_children → ready_to_resume
  → 优先队列重新取得 permit
  → nested Tool Promise 返回唯一 ToolResult
  → parent Agent 继续当前 turn
  → parent child 最终提交 TaskReport
```

`completeTask` 必须校验 `openChildInvocationIds.size === 0`。否则 parent child 的迟到 completion 不能让父 task 提前 terminal。

### 10.4 nested 取消范围

| 来源 | 影响范围 |
|---|---|
| nested ToolCall signal | 当前 nested invocation 的前台 task 子树 |
| parent task timeout/cancel | parent attempt + 它尚未完成的全部 nested invocation |
| root ToolCall signal | 整个 SwarmRun |
| plugin/service dispose | 所有 live SwarmRun，等待 quiescence |

nested invocation 的普通 task 失败只汇总进 nested ToolResult，让 parent Agent 决定如何继续；不能自动取消不相关 invocation 或整个 Swarm。

## 11. DAG

`0.2` 只开放 invocation 内依赖。模型使用局部 `key`，Coordinator 在登记时解析为内部 TaskId。

```text
task1、task2 ready
task3 depends_on=[task1, task2] → waiting(unmet=2)

task1 terminal → unmet=1
task2 terminal → unmet=0
  → 按 dependency_failure 策略处理失败依赖
  → materialize 成功依赖的 TaskReport 摘要
  → task3 ready
```

依赖结果只在 task 进入 ready 时生成一次 prompt。TaskSpec 仍不可变；materialized prompt 属于 attempt 输入。

失败传播：

- `fail`：下游写 `dependency_failed`，terminal failed；
- `skip`：下游 terminal skipped；
- `partial`：只使用成功依赖继续，prompt 显式列出缺失输入。

每个上游 terminal 都要更新 `dependents`。级联产生的新 terminal 也必须走同一 `settleTask()` 入口，更新 invocation barrier 与 `unfinishedTaskCount`。

## 12. 错误模型

Admission、task 与 run failure 的身份字段不同，不能塞进一个强制 `taskId` 的类型：

```ts
type AdmissionFailureKind =
  | 'invalid_input'
  | 'budget_exhausted'
  | 'dependency_missing'
  | 'dependency_cycle'
  | 'unsupported_provider'

interface AdmissionFailure {
  readonly kind: AdmissionFailureKind
  readonly scope: 'invocation'
  readonly message: string
}

type TaskFailureKind =
  | 'launch_failed'
  | 'child_error'
  | 'max_tokens'
  | 'refusal'
  | 'timeout'
  | 'cancelled'
  | 'structured_result_missing'
  | 'structured_result_invalid'
  | 'structured_result_too_large'
  | 'dependency_failed'
  | 'dependency_deadlock'
  | 'cleanup_failed'
  | 'unknown'

interface TaskFailure {
  readonly kind: TaskFailureKind
  readonly phase: 'launch' | 'running' | 'waiting' | 'finalizing' | 'scheduler'
  readonly scope: 'attempt' | 'task'
  readonly message: string
  readonly code?: string
  readonly taskId: SwarmTaskId
  readonly attemptId?: AttemptId
  readonly childId?: SessionId
  readonly occurredAt: number
}

type RunFailureKind = 'deadline_exceeded' | 'cancelled' | 'plugin_disposed' | 'state_corrupted'
```

`stale_attempt` 是被 fencing 拒绝的 diagnostic event/metric，不是覆盖当前 task 的失败结果。Admission 在任何 run/task/event 创建前原子失败；run failure 取消并停稳已登记工作后成为 Tool `isError`。

DSH 映射：

| DSH 结果 | GoalMesh 终态 |
|---|---|
| `SubagentResult.stopReason === completed` 且 `structured` 通过 TaskReport 收窄与大小检查 | completed |
| `completed` 但缺少 structured | `structured_result_missing` |
| `structured` 结构不合法或超过 `maxTaskReportChars` | `structured_result_invalid` / `structured_result_too_large` |
| `max-tokens` | `max_tokens` |
| `refusal` | `refusal` |
| `aborted` 且 attempt timedOut | `timeout` |
| `aborted` 且上游 signal aborted | `cancelled`，按上游 scope 传播 |
| `error` | `child_error` |
| `ctx.subagents.start()` reject | `launch_failed`；取消竞态优先分类为 cancelled |
| `run.dispose()` reject | 原结果成功时写 `cleanup_failed`；原结果失败时保留原失败并附 cleanup diagnostic |
| 旧 attempt completion | 记录 `stale_attempt` diagnostic，拒绝写账 |

错误信息进入 Session 或 ToolResult 前必须清洗，不持久化原始 `cause`、stack、凭证或 Provider 响应体。

### 12.1 首版重试决策

`0.1` 到 `0.3` 都不自动重跑 task。理由：

1. DSH request 层已经拥有 Provider retry；
2. one-shot SubagentRun 不支持 same-agent retry；
3. task 可能使用具有副作用的工具；
4. GoalMesh 尚无 effect ledger/reconciliation；
5. 盲目新建 child 会重复写外部世界。

未来加入 rerun 时，TaskSpec 必须先声明 `effects: 'none' | 'idempotent' | 'unknown'`，且只允许 typed transient failure、预算未耗尽、旧 run 已确认停稳时新建 child。

## 13. 核心不变量

实现和测试必须共同守住：

1. 一个 TaskState 任意时刻只处于一个 phase。
2. `unfinishedTaskCount` 在登记 task 时加一，只在第一次 terminal 时减一。
3. terminal result 只写一次；迟到 completion 不覆盖。
4. 每个 attempt 只 release 一次；signal listener、deadline 和 child run 都被清理。
5. `permitsInUse` 永不小于 0，永不超过 `maxConcurrency`。
6. `waiting_children` 不占 permit，但仍计入 unfinished。
7. parent task terminal 推出其所有 nested invocation 已 settled。
8. invocation 只 resolve 一次；root 要求 `remainingTaskIds` 清零，nested 还要求 parent 已重新取得 permit。
9. root invocation 完成推出所有前台后代 terminal。
10. `results.size + unfinishedTaskCount === tasks.size`。
11. finished 后任何 timer、listener、Promise callback 都不能再写状态。
12. dispose 返回时没有 active SubagentRun、in-flight start、deadline、listener 或未撤销 SwarmLease。
13. 模型不能用 args 选择或伪造 owner、Swarm ID、Task ID、Attempt ID、LeaseToken，任何未知顶层字段都在 admission 前拒绝。
14. 每条 trajectory event 都对应一个已经 commit 的状态；Recorder 不能反写调度器。
15. 同一 Session event 序列的实时 fold、完整 replay 与分页 prepend 必须得到同一棵树。
16. Coordinator 不输出全局 Goal 是否实现。
17. 每个持久 trajectory event 都带 `ignorable: true`；缺少 companion 的 Harness 可以安全忽略整条投影而不影响 Session 重建。

任何无法同时满足这些条件的状态都进入 `state_corrupted`，停止该 Swarm 的新派发并取消剩余工作；不能通过猜测继续。

## 14. Trajectory 持久记录与 Web 动态树

运行态先保持内存态；首版不承诺进程崩溃后恢复执行。Trajectory 是“已提交调度状态的持久投影”，不是第二个可写状态机，也不是 crash-recovery journal。不要序列化 Promise、AbortController、Error、Agent、Coordinator 或 lease 对象。

### 14.1 端到端数据流

```text
root / child scoped goal_mesh Tool
              ↓ command
共享 SwarmCoordinator 单写者 commit
              ↓ committed transition
TrajectoryRecorder
              ↓ Session.append("tool-goalmesh/*")
root caller Session（包括所有 nested 后代）
              ↓ DSH 已有 Session 实时流 / 历史加载
ConversationNodeDefinition 按 swarmId fold
              ↓
SwarmTrajectoryPanel 动态树
              ↓ 点击 task/agent
SessionRuntime.open() / openSubagent() → child 完整 Session
```

这里不需要 child 把 task “回传给父 Agent”。child scoped Tool 直接调用同一个 Host Coordinator；Coordinator 持有 root Session，并把 root 与 nested 的全部已提交 transition 都 append 到该 Session。Web 因而只订阅一个权威事件源，不需要新增 WebSocket、轮询或浏览器侧 scheduler store。

### 14.2 Durable event 协议

Host Tool package 在 root caller Session 写 browser-safe、log-only 事件。它与仓库内 `dsh-tool-workflow` 的关键差异是：GoalMesh 属于下游包，不在 Harness 构建时生成的 `KNOWN_SESSION_EVENT_TYPES` 中。Harness 前置改动必须让 non-surface `Session.append()` 接受 `{ ignorable: true }`，Recorder 每次都显式传入；否则持久化后连安装了插件的同一 Harness 构建也会拒绝重载 Session。

```text
tool-goalmesh/run-start
tool-goalmesh/invocation-start
tool-goalmesh/task-created
tool-goalmesh/attempt-start
tool-goalmesh/task-transition
tool-goalmesh/attempt-end
tool-goalmesh/invocation-end
tool-goalmesh/run-end
```

事件 payload 只存树和诊断所需的有界事实，不复制 child 的完整 prompt、assistant token stream 或工具调用；这些细节继续由 child Session 持有：

```ts
type SwarmTaskViewStatus =
  | 'waiting' | 'ready' | 'starting' | 'running'
  | 'waiting_children' | 'ready_to_resume'
  | 'completed' | 'failed' | 'skipped' | 'cancelled' | 'timed_out'

interface SwarmEventBase {
  readonly swarmId: SwarmId
}

interface SwarmRunStartData extends SwarmEventBase {
  readonly rootSessionId: SessionId
  readonly goalSummary: string       // bounded
}

interface SwarmInvocationStartData extends SwarmEventBase {
  readonly invocationId: InvocationId
  readonly parentTaskId?: SwarmTaskId
  readonly callerSessionId: SessionId
}

interface SwarmTaskCreatedData extends SwarmEventBase {
  readonly invocationId: InvocationId
  readonly taskId: SwarmTaskId
  readonly key: string
  readonly label: string             // bounded description
  readonly objectiveSummary: string  // bounded
  readonly acceptanceCriteriaSummary: readonly string[] // bounded item/count
  readonly parentTaskId?: SwarmTaskId
  readonly dependencies: readonly SwarmTaskId[]
  readonly depth: number
}

interface SwarmAttemptStartData extends SwarmEventBase {
  readonly taskId: SwarmTaskId
  readonly attemptId: AttemptId
  readonly attemptNo: number
  readonly childId: SessionId
  readonly parentSessionId: SessionId
  readonly provider: string
  readonly local: boolean
  readonly requestedModel?: string
}

interface SwarmTaskTransitionData extends SwarmEventBase {
  readonly taskId: SwarmTaskId
  readonly from: SwarmTaskViewStatus
  readonly to: SwarmTaskViewStatus
  readonly reason?: string            // enum/bounded diagnostic, not raw Error
}

interface SwarmAttemptEndData extends SwarmEventBase {
  readonly taskId: SwarmTaskId
  readonly attemptId: AttemptId
  readonly outcome: 'completed' | 'failed' | 'cancelled' | 'timed_out'
  readonly failureKind?: TaskFailureKind
}

interface SwarmInvocationEndData extends SwarmEventBase {
  readonly invocationId: InvocationId
  readonly status: 'completed' | 'partial' | 'failed' | 'cancelled' | 'timed_out'
}

interface SwarmRunEndData extends SwarmEventBase {
  readonly status: 'completed' | 'partial' | 'failed' | 'cancelled' | 'timed_out'
  readonly completed: number
  readonly failed: number
  readonly skipped: number
  readonly cancelled: number
  readonly timedOut: number
}
```

时间线使用 Session envelope 的 `event.time`，全序使用 `event.seq`；payload 不再复制第二份时钟。`partial` 表示调度按策略正常返回，但至少一个直接或后代 task 没有干净完成；`failed` 只表示调度器/runtime failure。UI 不得把 `completed` 与 child 的 `reported_status: achieved` 混为一谈。

记录规则：

- 一个 `swarmId` 只有一个 `run-start`；所有其他事件必须位于它之后、`run-end` 之前；
- invocation start/end、attempt start/end 必须按 ID 成对；task 必须先 created，transition 的 `from` 必须等于上次 `to`；
- 状态先 commit，再 append event；Recorder 从 commit 结果取值，不能读取半写状态；
- 每次 append 都调用 `session.append(type, data, { ignorable: true })`；这些事件只提供可视化，丢失不会改变模型历史或 Session 重建语义；
- 第一次 append 失败后禁用该 Swarm 后续记录并告警，使 Session 保持“空或合法连续前缀”，不能跳过失败事件后继续写；
- task/attempt/invocation 的缺失 end 后缀是合法中断证据，不是日志损坏；
- 只有全部 child `dispose()` 达到 quiescence 后才能 append `run-end`，然后 Tool 才 settle；
- root 与 nested 全部写入 root caller Session；不要在每个 child Session 再复制同一套 trajectory；
- Code Mode 的 Tool transport 事件继续由 `tool/code-dispatch` 表达；trajectory 只记录 Swarm 领域状态，避免重复画两棵调用树。
- `attempt-start` 只在 `ctx.subagents.start()` 成功发布 run 后写，因此一定有 `childId`；publication 前 launch rejection 只用 `ready → starting → failed` task transition 表达，不伪造 attempt start/end 对。

### 14.3 Web 事件折叠

Web companion 注册一个 `ConversationNodeDefinition<SwarmTrajectoryState>`，`kind` 与 keyed renderer 都使用 `goalmesh-trajectory`：

```ts
const swarmTrajectoryDefinition: ConversationNodeDefinition<SwarmTrajectoryState> = {
  kind: 'goalmesh-trajectory',
  target: 'chat',
  match(event) {
    if (event.type === 'tool-goalmesh/run-start') {
      return { id: String(event.data.swarmId), role: 'start' }
    }
    if (isSwarmUpdateEvent(event)) {
      return { id: String(event.data.swarmId), role: 'update' }
    }
    return null
  },
  start: startSwarmProjection,
  update: foldSwarmEvent,
  buildViewNode: buildSwarmTrajectoryNode,
}
```

`isSwarmUpdateEvent` 必须是穷举七类 update event 的 closed type guard，不能用前缀把未来未知事件误收进当前 reducer。折叠 state 建议包含 `tasksById`、`childrenByParent`、`attemptsByTask`、`invocationsById`、`runStatus` 和单调 `revision`。更新必须按 Session `seq` 纯函数化；不得订阅 Host Coordinator，也不得把业务状态塞进全局 client store。

与现有 `ui-workflow-run` 一致：历史尾页如果先看到 update 而还没加载 `run-start`，Definition 保持 pending；较早页面 prepend 后再构建节点。实时 append、完整历史 replay、分页 prepend 三条路径必须生成完全一致的数据。

### 14.4 Agent 树投影

树的主层级只用 `parentTaskId`：

```text
Swarm <goal summary>                         running  3/7
├─ Agent A / task: search-schema             completed
├─ Agent B / task: inspect-api               running
│  ├─ Agent B.1 / task: trace-auth            completed
│  └─ Agent B.2 / task: inspect-retry         waiting
└─ Agent C / task: integrate                  waiting on A, B
```

投影规则：

- `run-start` 产生一个虚拟 Swarm root；每个 `task-created` 产生逻辑 Task 节点；
- `attempt-start` 后节点显示 child Agent identity、provider/model、开始时间和 Session 导航能力；启动前仍显示为 Task placeholder；
- nested task 通过 `parentTaskId` 成为当前 Agent 节点的 child；`invocationId` 只作为分组/徽标，不额外制造一层空节点；
- `dependencies` 是 DAG 横向边，不参与树父子关系。首版在详情里列“依赖/被依赖”，避免交叉 SVG 线把树画乱；
- task retry 未来出现时仍只有一个 Task 节点，attempt 历史在详情中展开，不能把重试误画成兄弟任务；
- 找不到 parent 的合法历史尾页暂放 `unlinked` 组；加载完整历史后重挂。检测到 parent cycle 或深度超限时停止递归并显示诊断，不能卡死渲染；
- 状态用 DSH semantic token 和 `StateDot` 表达；不能用硬编码颜色作为唯一信息。

`maxTasks=64` 时用递归 disclosure + `childrenByParent` 索引即可，不需要引入重型 graph 库。以后若上限超过 200，再增加虚拟化；布局算法不能反向成为 scheduler 的依赖。

### 14.5 点击 Agent 后查看具体运行

`SwarmTrajectoryPanel` 作为独立 Chat Conversation Node 锚定在 root Session 的 `run-start` 位置，默认可折叠，并提供“展开”进入宽屏树。面板采用“左树 + 右详情”或窄屏 drawer。单击节点先在当前 trajectory 中选中，不立即丢失根视图。右侧至少显示：

- TaskGoal 的 bounded description、acceptance criteria 摘要；
- 当前状态、排队时长、运行时长、depth、invocation、依赖；
- attemptNo、childId、parentSessionId、provider/model；
- 按事件 seq 排列的状态时间线；
- terminal outcome、failureKind 和已清洗的 bounded reason；
- `打开完整 Agent 会话` 操作。

完整运行详情不在 root trajectory 中重复实现。点击“打开完整 Agent 会话”后复用现有 Session UI，它已经拥有 assistant streaming、ToolCall、Tool result、usage、错误和审批等细节：

1. `attempt-start.local === false` 时只显示 provider run identity 与“不支持打开会话”，不能把 remote run id 当成本地 Session；
2. local child 在 `useSessions` snapshot 中存在、`origin === subagent` 且 `parentId === parentSessionId` 时调用 `ctx.sessions.open(childId)`；
3. 已完成或隐藏 local child 先调用 `ctx.sessions.subagentAddress(childId)`；只有返回的 direct address 同时匹配事件中的 parent/child 才调用 `openSubagent(address)`；
4. address 尚未发现时可触发一次 `refreshSubagents(parentSessionId)`，完成后重新读取 `subagentAddress()`；仍不存在则保持不可导航，不能直接把事件字符串拼成 address。

这样运行中 Agent 和已持久化的已完成 Agent 都能查看；浏览器返回后仍回到原 Swarm 节点。Web renderer 只接收注入的 `openSession/openSubagent` 动作与 Session selector hook，组件本身不持有 `ctx`。

### 14.6 一致性、中断与恢复边界

- 实时：Session append 经 DSH 现有事件流触发 Conversation Node fold，树随 commit 动态更新，不轮询；
- 重连：重新加载 root Session 后从 log-only events 重建同一棵树；
- Turn/Step 已关闭但缺 `run-end` 时，UI 把仍开放节点投影为 `interrupted`，同时显示“轨迹记录可能不完整”；
- Recorder append 失败不影响真实调度结果，UI 只承认已持久化前缀，不根据 child Session 列表脑补状态；
- Host 进程崩溃后，首版只提供历史查看，不恢复 scheduler。要恢复执行，必须另做 durable journal、lease 重建、effect reconciliation 和 Provider 对账。

### 14.7 性能、隐私与权限

- 不写逐 token、逐 chunk 或完整 Tool 参数；root trajectory 只保存 bounded label、ID、状态和诊断枚举；
- child 的敏感内容沿用 Session 自身的权限和脱敏策略，tree 不创建旁路副本；
- 所有文本在 Host 写入前限长并清洗 raw Error、stack、凭证和 Provider response；
- 面板只允许打开 SessionRuntime 已列出或 catalog 已证明 lineage 的 child；仅凭事件里的任意字符串不能导航；
- fold 使用 `Map` 和稳定数组投影，按变更节点更新 revision；折叠分支不渲染后代 DOM。

建议指标：排队时间、运行时间、成功/失败/取消/timeout、最大并发、waiting_children 数、resume 等待时间、dependency deadlock、stale attempt、重复 command、trajectory append failure、tree replay mismatch 和 cleanup failure。

### 14.8 Trajectory/Web 测试

- Host invariant：重复 start、无 created 的 transition、未配对 attempt、run-end 后更新、开放 attempt 的 run-end 都拒绝；合法中断前缀接受；
- Recorder：commit 后写、首个 append 失败即停写、记录失败不改变 ToolResult；
- Definition：live append、full replay、history prepend 得到相同 tree snapshot；
- Tree：nested 三层、DAG 横向依赖、orphan、cycle、depth cap、64 节点折叠；
- 交互：运行中 listed child 用 `open()`，已完成 catalog child 用 `openSubagent()`，错误 parent 或 remote child 不导航；
- 生命周期：client plugin dispose 后 Definition、locale 与 keyed slot 全部撤销；
- 真实 Web composition：运行中的状态变化可见，刷新后可回放，点击 Agent 能进入对应 child Session。

## 15. Tool Adapter 骨架

```ts
export function registerRootGoalMeshTool(
  ctx: Context,
  coordinator: SwarmCoordinator,
  config: ResolvedConfig,
): void {
  ctx.tools.register(defineTool({
    name: config.toolName,
    description: ROOT_GOAL_MESH_DESCRIPTION,
    parameters: ROOT_GOAL_MESH_PARAMETERS,
    output: {
      schema: GOAL_MESH_OUTPUT,
      render: (_args, value) => [{
        type: 'text',
        text: renderBoundedSwarmResult(value, config.maxRenderedResultChars),
      }],
      presentationMeta: (_args, value) => summarizeForCard(value),
    },
    // Deliberately exclusive: no isConcurrencySafe.
    async execute(args, exec) {
      assertRootArgsV01(args)
      const caller = exec.agent
      if (caller === undefined) {
        throw new Error('goal_mesh requires a calling agent')
      }

      const invocation = coordinator.invokeRoot({
        rootAgent: caller,
        callId: exec.callId,
        commandToken: exec.token,
        args,
        signal: exec.signal,
      })

      return await settleInvocationHandle(invocation)
    },
    presentCall: presentGoalMeshCall,
    presentResult: presentGoalMeshResult,
  }))
}
```

`settleInvocationHandle()` 以 `Promise.allSettled` 分别保存 invocation outcome 与 handle cleanup：主执行失败时 cleanup failure 只能成为附加诊断，不能覆盖主失败；主执行成功但 cleanup 失败时返回 `isError`。Coordinator 自己用 `dsh-timeout.deadline()` 管理 Swarm 总期限，因此 Tool 不再同时声明同值的 `timeoutMs` 制造两套 deadline owner。

全局 Tool 只走 `coordinator.invokeRoot()`；child-scoped 同名 Tool 只走已捕获的 `lease.invokeNested()`。两者都在创建 task 前完成 exact-key、版本字段、DAG 与预算校验，不再靠运行时 Agent association 选择分支。

## 16. 测试矩阵

### 16.1 `0.1` 必须通过

- 1、4、5、64 个 task；超过 `maxTasks` 在启动前拒绝；
- 未知顶层字段、身份字段和 `0.1` 尚未开放的 DAG/failure-mode 字段在创建 run 前拒绝；
- completion 乱序但 ToolResult 保持输入顺序；
- `maxConcurrency` 永不越界；
- 一个 child start reject，兄弟在 collect-all 下继续；
- `completed` 无 structured 不能算成功；
- structured 非法或超过 `maxTaskReportChars` 不能算成功；
- `max-tokens/refusal/error` 映射正确；
- 一个 task timeout 只取消自己的 child；
- timeout 与 completion 同时发生只 settle 一次；
- root cancel 保留 completed，其余区分 starting/running/ready aborted；
- Tool 返回或报错前全部 `SubagentRun.dispose()` 已完成；
- dispose 抛错不会造成 unhandled rejection，也不会被误报为成功；
- Tool/Plugin Fiber dispose 后工具消失，live run 被取消并停稳；
- 同一 `ToolExecutionToken` 重入不重复创建 task；不同 token 即使 callId 相同也互不折叠；
- ToolResult 只返回一次，迟到 callback 不改状态；
- Native、Code Mode 和 assembled real composition 都有覆盖；
- generic card 可从持久化 args/result 纯重放；
- root Session event invariant 接受合法中断前缀、拒绝乱序/重复/未配对记录；
- 每条 trajectory event 都带 `ignorable: true`，缺少插件类型的持久化 reader 仍可重载 Session；
- Web tree 的 live append、full replay、history prepend snapshot 一致；
- 点击 running 与 completed child 能打开经过 lineage 证明的正确 Session。

### 16.2 `0.2` 增加

- DAG join 只在全部依赖 terminal 后解锁；
- cycle/missing dependency 在 admission 阶段拒绝；
- fail/skip/partial 三种传播；
- `ready=0/active=0/unfinished>0` 触发 deadlock audit；
- fail-fast 只取消本 invocation；
- quorum 达到后取消本 invocation 剩余 task。

### 16.3 `0.3` 增加

- child 在 publication 与首个 request 前已有捕获 exact lease 的 scoped `goal_mesh` Tool；
- nested 调用自动 attach 且拒绝 goal；
- 没有该 scoped Tool/lease 的 Agent 不能用伪造 ID 附着已有 Swarm；
- parent waiting_children 释放 permit，`maxConcurrency=1` 时后代仍能运行；
- nested 完成后 parent 先拿到 resume permit，再返回 ToolResult；
- parent completion 在 child invocation 未完时被 fencing 拒绝；
- nested cancel 不影响 sibling invocation；
- parent cancel 递归取消自己的后代；
- root cancel 取消整棵树；
- plugin/child dispose 撤销 scoped Tool 并 revoke 全部 active lease；
- remote provider 在 `nestedMode: local-only` 下 fail loud。

## 17. 实施切片

### PR 0：Harness 下游 log-only event 写入

在 `deepseek-harness` 中给 non-surface `Session.append()` 增加可选 `{ ignorable: true }`：

- 类型、JSON snapshot、seed/restore 与持久化 round-trip；
- 未传参数的现有调用保持 required-on-read；只有字面量 `true` 合法；
- Session subsystem/README 双语契约与 Agent Note；
- focused unit、persistence contract、typecheck、doc gates。

这不是 GoalMesh event registry。它只开放 Session envelope 已经存在但 writer API 尚未暴露的 unknown-event skip marker；GoalMesh invariant/client companion 仍负责理解自己的 payload。

### PR 1：可安装 Bundle 与 Host 固定批 Tool + durable trajectory

在三个包的 workspace 完成：

- 可安装 Bundle distribution、Host 与 inert Web companion wiring；
- Config、provider capability admission 与相对 depth 解析；
- Tool schema、TaskReport schema 和有界 renderer；
- private shared Coordinator/Scheduler/Launcher；
- `collect_all`、maxConcurrency、timeout、root cancel；
- 八类带 `ignorable: true` 的 root Session trajectory events、Recorder 与 invariant companion；
- 单元、real composition、snapshot。

该切片不接收 `depends_on`、`quorum`，Tool description 也不宣传 nested，但 event schema 从第一天保留 `parentTaskId/invocationId/attemptId`。

### PR 2：Web 动态 Agent 树

在 `client-ui-goalmesh` 包完成：

- browser-safe event types 依赖；
- `ConversationNodeDefinition` 的 live/replay/prepend fold；
- `conversation.chat.node` keyed renderer；
- 可折叠 Agent tree、状态和右侧详情；
- running `SessionRuntime.open()` 与 completed catalog `openSubagent()` 导航；
- locale、CSS Modules、dispose、component 与 real Web composition 测试。

`0.1` 的产品交付定义为 PR 0 + PR 1 + PR 2；Host 可以 headless 运行，但没有 PR 2 就不满足本设计的 trajectory 可视化需求。

### PR 3：静态 DAG 与 invocation failure mode

- `waiting/ready`、dependents 反向索引；
- dependency materialization；
- fail/skip/partial；
- fail-fast/quorum；
- tree 详情显示横向依赖与 deadlock audit。

### PR 4：Harness scoped child setup

在 `deepseek-harness` 中给 one-shot subagent seam 增加 `scopedSetup` capability，并更新：

- `SubagentCapabilities` 与 `SubagentStartRequest` 类型；
- spawn/fork in-process Provider，把 consumer `scopedSetup` 合并进现有 `agents.create({ setup })` 创建事务；
- capability 检查与 remote Provider 的 `false` 声明；
- publication/首个 followup/rollback/dispose 测试；
- subagent 文档与 Agent Note。

这项改动必须先独立证明：scoped setup 在 publication 和首个 request 前完成，失败会完整 rollback，child dispose 会撤销 scoped 注册。

### PR 5：nested GoalMesh

- issue/revoke `SwarmLease`，child-scoped 同名 Tool 捕获 exact lease；
- `waiting_children/ready_to_resume`；
- nested invocation barrier；
- permit 释放/重获；
- 分层取消与 attempt fencing；
- nested trajectory tree、real composition 与 snapshot。

### 暂缓

- 自动 task retry；
- same-agent resume/retry；
- Provider-aware 429 capacity；
- background Swarm；
- durable journal / crash recovery；
- 外部 effect ledger 与 reconciliation；
- 跨 invocation DAG 依赖。

这些都需要新的真实消费者、badcase 或恢复要求，不能仅因完整指南中存在就一起公开。

## 18. MVP 验收标准

`0.1` 可以称为可用 DSH Tool + Web trajectory 的最低标准：

- Profile 加载后模型能看到一个 `goal_mesh` Tool；Fiber dispose 后该 Tool 消失。
- 一次调用可提交多个独立 TaskGoal，并通过配置限制总数和并发。
- child 全部通过真实 `ctx.subagents` Provider 运行，不直接构造 AgentLoop。
- 每个 child 必须返回结构化 TaskReport；缺失或非法结果不会伪装成功。
- TaskReport 超过配置上限会明确失败，不会截断后伪装成完整证据。
- 结果按输入顺序稳定聚合，单 task 失败不丢失兄弟结果。
- timeout、root cancel、Plugin dispose 都走 Abort，并在 Tool settle 前等待 published child 与 in-flight start quiescence。
- ToolResult 不宣称全局 Goal 已实现，由 root Agent 根据 success criteria 验收。
- 没有 detached work、重复结算、泄漏 timer/listener/child run/lease 或伪造 owner/Swarm ID/LeaseToken 的入口。
- real composition 与 snapshot 证明模型可见 schema、prompt、结果和错误文案。
- 每个 root run 都产生合法连续的 root Session trajectory；Web 在运行中动态更新 Agent 树。
- 每个 trajectory event 都是可安全跳过的 log-only event，未安装 companion 的 reader 仍可重载 Session。
- 刷新/历史加载后重建相同树；缺失终态显示 interrupted，而不是假成功。
- 点击运行中或已完成的本地 Agent 节点，可以进入经过 lineage 证明的对应 child Session。

PR 0 + PR 1 + PR 2 达到这些标准后，再进入 DAG 和 nested attach；不要反过来先做递归生产，再补基础结算与 trajectory 正确性。

## 19. 参考源码

- `deepseek-harness/packages/core/tools/src/index.ts`：`ToolDefinition`、`ToolRunContext.token/signal`、规范 JSON 输出与 presentation。
- `deepseek-harness/packages/core/tools/src/schema.ts`：`defineTool()` 的隐式开放顶层参数 object。
- `deepseek-harness/packages/core/session/src/index.ts` 与 `types.ts`：`Session.append()` 和 event envelope 的 `ignorable` 字段。
- `deepseek-harness/packages/subagent/subagent/src/types.ts`：`SubagentStartRequest`、`SubagentRun`、`SubagentResult` 和 Provider capability。
- `deepseek-harness/packages/subagent/subagent/src/index.ts`：`ctx.subagents.start()` 与生命周期事件。
- `deepseek-harness/packages/subagent/tool-subagent/src/index.ts`：前台 child 收集、stopReason 映射和 dispose 处理。
- `deepseek-harness/packages/subagent/subagent-in-process-driver/src/index.ts`：in-process child publication、首条 prompt 与 quiescent dispose 的真实时序。
- `deepseek-harness/packages/workflow/workflow/src/index.ts`：现有 Workflow seam 与错误分类。
- `deepseek-harness/packages/workflow/workflow-worker-thread/src/`：并发、取消、强制终止与 child 清理的已实现参照。
- `deepseek-harness/packages/workflow/tool-workflow/src/index.ts`：长运行前台 Tool、Session recorder 与 UI card 的参照。
- `deepseek-harness/packages/workflow/tool-workflow/src/types.ts`：browser-safe log-only Session event payload 与 `SessionEventMap` 声明参照。
- `deepseek-harness/packages/client/ui-workflow-run/src/client/workflow-definition.ts`：`ConversationNodeDefinition` 的 start/update/replay fold 参照。
- `deepseek-harness/packages/client/ui-workflow-run/src/client/WorkflowRunPanel.tsx`：状态展示与 child Session 导航参照。
- `deepseek-harness/packages/client/runtime/src/client/sessions/service.ts`：`open()`、`openSubagent()` 与 catalog address 能力。
- `deepseek-harness/packages/client/runtime/src/client/contract/sessions.ts`：`subagentAddress()`、`refreshSubagents()` 与导航权限。
- `deepseek-harness/packages/util/timeout/src/index.ts`：可分类的 deadline 与 signal fusion。
- `deepseek-harness/docs/cookbook/adding-a-tool.md`：DSH Tool authoring 契约。
- `GoalMesh批调度器设计指南.md`：SwarmRun/Invocation/Task/Attempt 分层、结构化等待、DAG 与错误恢复输入。
