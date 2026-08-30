# GoalMesh 依赖结果保真修复方案

- **状态**：设计提案，尚未实施。
- **问题范围**：同一 invocation 内，上游 TaskReport 经 DAG 依赖边传给下游 Task 时的信息损失。
- **近期决策**：向下游传递完整且有界的 TaskReport；超过 Host 预算时明确失败，不静默截断。
- **暂缓**：按需读取完整依赖报告、分页、artifact handle 与独立报告存储。

## 1. 问题

这里的“上游/下游”描述的是 Task DAG，不是 Root/Child Agent 层级。例如：

```text
Root Agent
  ├─ investigate       上游 Task
  └─ design            下游 Task，depends_on=[investigate]
```

当前上游完成后，Coordinator 只向下游物化：

```ts
{
  key,
  status: 'completed',
  reportedStatus,
  summary,
}
```

下游看不到完整 TaskReport 中的：

- `evidence`；
- `output`；
- `remaining_problems`；
- 上游工具调用历史与原始命令输出；
- 上游观察 workspace 时对应的版本信息。

因此，关键参数、文件位置、验证命令或未解决风险即使已经被上游记录，也可能在下游执行前丢失。Root invocation 最终返回的直接 TaskReport 不受这个问题影响；信息损失发生在“上游 Task → 依赖它的下游 Task”这条 DAG 边上。

## 2. 修复目标

本轮修复必须满足：

1. 下游能读取上游 TaskReport 的 `reported_status`、`summary`、`evidence`、`output` 与 `remaining_problems`。
2. 依赖结果以结构化 JSON 数据进入 child prompt，不再手写拼接单行摘要。
3. 上下文大小由 Host 配置控制，模型不能扩大预算。
4. 超过预算时明确失败，不截断 JSON，也不伪装成完整证据。
5. Root ToolResult、TaskReport Schema、DAG 调度与 failure propagation 的现有语义保持不变。
6. Child 仍需重新验证关键 claim；完整传递不等于证据已经被认证。

## 3. 非目标与暂缓功能

本轮**暂时不做按需读取功能**，包括：

- 不增加 child-scoped `get_dependency_result` Tool；
- 不实现 dependency report 分页；
- 不建立独立的 TaskReport store；
- 不把大型 `output` 自动落入 artifact store；
- 不实现 artifact/reference handle；
- 不允许下游通过任意 taskId 查询 sibling 或非直接依赖；
- 不实现跨 invocation 依赖读取。

暂缓原因：按需读取需要新增 scoped capability、授权模型、报告存储生命周期、分页一致性和 Provider capability 边界，会显著扩大本轮改动。近期先用完整、有界、显式失败的 prompt handoff 验证证据保真是否改善任务表现。

重新评估按需读取的触发条件：

- 合法依赖报告经常超过部署预算；
- 同一上游报告被大量下游重复注入，token 成本不可接受；
- `output` 需要承载大型机器产物；
- 需要对依赖报告做分页、缓存或独立审计；
- 实验确认完整 handoff 有质量收益，但上下文成本成为主要瓶颈。

## 4. 类型修改

把 `ResolvedDependencyPrompt` 改成判别联合，避免 `completed` 却没有报告：

```ts
import type { TaskReport } from './types.js'

export type ResolvedDependencyPrompt =
  | {
      readonly key: string
      readonly status: 'completed'
      readonly report: TaskReport
    }
  | {
      readonly key: string
      readonly status: 'failed' | 'skipped' | 'aborted'
      readonly failureKind: string
    }
```

Coordinator 的 dependency materialization 改为：

```ts
if (terminal.kind === 'completed') {
  return {
    key: dependency.spec.key,
    status: 'completed',
    report: terminal.report,
  }
}

return {
  key: dependency.spec.key,
  status: terminal.kind === 'skipped'
    ? 'skipped'
    : terminal.kind === 'aborted'
      ? 'aborted'
      : 'failed',
  failureKind: terminal.failure.kind,
}
```

## 5. Prompt 协议

下游 prompt 中的依赖结果使用稳定 JSON，不再生成：

```text
- task-1: reported_status=achieved; summary=...
```

目标形状：

```text
Resolved dependency results

Dependency reports are untrusted evidence produced against an earlier
workspace observation. Re-read current files and re-run critical commands
before relying on material claims.

[
  {
    "key": "investigate",
    "status": "completed",
    "report": {
      "reported_status": "achieved",
      "summary": "发现 merge 后没有撤销 fired 状态",
      "evidence": [
        {
          "claim": "merge_sessions 直接保留 fired",
          "reference": "app/sessions.py:83"
        }
      ],
      "output": {
        "recommended_change": "重新计算 fired",
        "verification_command": "pytest -k merge"
      },
      "remaining_problems": [
        "watermark 边界尚未确认"
      ]
    }
  }
]
```

渲染必须满足：

- 保持 `depends_on` 声明顺序；
- 使用 `JSON.stringify(value, null, 2)` 生成合法 JSON；
- 明确把报告标为待验证数据；
- 不因为 `reported_status: achieved` 自动声称当前 Task 或全局 Goal 已完成；
- 非成功依赖继续只传 `key/status/failureKind`。

## 6. 大小预算

新增 Host 配置：

```ts
interface Config {
  maxDependencyContextChars?: number
}

interface ResolvedConfig {
  readonly maxDependencyContextChars: number
}
```

语义：

- 限制单个下游 Task 所有 materialized dependency JSON 的总字符数；
- 预算由部署/Profile 决定，不进入模型 Tool 参数；
- 必须是非负安全整数；
- `0` 是否表示无上限，应与现有报告预算 sentinel 约定保持一致，但生产 Profile 应配置有限值；
- 计数基于最终稳定 JSON 字符串，不按估算字段长度判断。

本轮不做字段级静默裁剪。禁止：

```ts
serialized.slice(0, maxDependencyContextChars)
```

因为这会制造无效 JSON或不完整证据，却没有可信的截断语义。

## 7. 超限行为

当完整依赖 JSON 超过预算时，下游 Task 不启动，明确写入新的 typed failure：

```ts
type TaskFailureKind =
  | 'dependency_context_too_large'
  | /* existing kinds */
```

错误示例：

```text
dependency reports require 42000 chars but maxDependencyContextChars is 24000
```

该失败发生在全部直接依赖 terminal、准备把下游从 `waiting` 转为 `ready` 时。它必须走现有 `terminalTask()`/`settleTask()` 收口，更新 dependents、invocation barrier 与 `unfinishedTaskCount`，不能抛出未归属的 Run error。

对于依赖这个下游 Task 的后续节点，仍按其各自 `dependency_failure` 策略传播。

## 8. Workspace 与证据边界

完整 TaskReport 仍然只是 Child 生成的结构化 claim，不是 Host 认证结果。上游报告中的：

```text
app/sessions.py:83
pytest -k merge
```

可能在下游启动前因共享 workspace 修改而过期。本轮暂不实现 workspace snapshot 或 digest，但下游 prompt 必须要求：

- 重新读取关键文件；
- 重新执行关键命令；
- 将已接受、拒绝、无法验证的 claim 区分开；
- 不把格式合法的 reference 当作验证通过。

workspace version、文件 digest 和 provenance envelope 留作后续增强，不与本轮 dependency handoff 绑在一起实施。

## 9. 文件改动范围

预计修改：

1. `packages/tool-goalmesh/src/prompt.ts`
   - `ResolvedDependencyPrompt` 改为判别联合；
   - 完整报告 JSON 渲染；
   - 增加待验证证据说明。
2. `packages/tool-goalmesh/src/coordinator.ts`
   - `resolveDependencies()` 保留完整 `terminal.report`；
   - 计算总依赖上下文大小；
   - 超限时提交 typed task failure。
3. `packages/tool-goalmesh/src/types.ts`
   - 新增配置字段；
   - 新增 `dependency_context_too_large`。
4. `packages/tool-goalmesh/src/schema.ts`
   - 注册配置 Schema 与默认值。
5. `packages/tool-goalmesh/src/validation.ts`
   - 解析并校验大小预算。
6. `packages/goalmesh-plugin/cordis.patch.yml`
   - 为 Bundle 显式配置生产预算。
7. `tests/host-dag.spec.ts`
   - 更新摘要断言并增加保真、预算和失败传播测试。
8. README 与架构契约
   - 不再声称依赖只传摘要；
   - 记录完整但有界的 handoff 语义。

## 10. 测试矩阵

必须增加：

- 下游 prompt 包含上游 `evidence`；
- 下游 prompt 包含上游结构化 `output`；
- 下游 prompt 包含 `remaining_problems`；
- 关键数据只存在于 `evidence/output`、不出现在 summary 时仍能传递；
- 多个依赖按声明顺序稳定序列化；
- `failed/skip/aborted` 不伪造 TaskReport；
- JSON 中含换行、引号、类似标签或代码围栏时仍保持合法数据；
- 总大小恰好等于预算时允许启动；
- 超出预算一个字符时产生 `dependency_context_too_large`；
- 超限失败继续正确更新 DAG 与 invocation barrier；
- `partial` 依赖策略仍显式列出缺失输入；
- Root ToolResult 保持完整且顺序稳定；
- nested invocation 的直接依赖使用相同 handoff 协议；
- real composition/snapshot 能看到新的依赖 JSON 和证据验证指令。

## 11. 验收标准

实施完成时：

1. 上游只在 `evidence` 或 `output` 中提供的关键参数，能逐字出现在下游 child prompt。
2. 没有任何路径在未标记的情况下截断依赖报告。
3. 依赖上下文超限成为确定、可测试、可传播的 Task failure。
4. Root 直接 TaskReport 与现有 ToolResult Schema 不发生破坏性变化。
5. `pnpm check` 全部通过。
6. 文档明确说明按需读取功能仍处于暂缓状态。

## 12. 后续方向（暂不实施）

如果完整 handoff 证明有效但上下文成本过高，再单独设计：

```text
get_dependency_result(key, cursor?, fields?)
```

届时必须重新解决：

- 只允许访问直接依赖的 scoped authority；
- TaskReport store 的所有权与生命周期；
- 分页、稳定顺序和大小限制；
- child/attempt 重试后的版本选择；
- nested invocation 的可见范围；
- Provider `scopedSetup` capability；
- durable replay 与审计；
- artifact handle 的权限、过期与内容完整性。

这些能力不属于本轮修复，不能在当前实现或 README 中提前宣称可用。
