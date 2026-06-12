---
name: atdo
description: >-
  Fully automated phased project execution. Reads any project plan format,
  executes phases sequentially, auto-audits each phase, auto-fixes issues,
  runs integration tests at gates, auto-commits at quality gates.
  Use for long-running multi-phase projects.
argument-hint: "<plan-file> [--from N] [--to N] [--only N] [--resume] [--dry-run] [--no-audit]"
---

# atdo

Automated phased project development orchestrator. One turn = one phase.
After each phase: persist state → CronCreate (durable) → next turn continues.

## Core Rules (READ FIRST)

### Context Budget (HARD LIMIT)
- This skill = ~2K tokens. Do NOT load full plan files into context.
- Each turn: ONLY load current phase plan-snippet (≤500 chars) + state.json.
- Completed phases: ONLY read summary.md (≤500 chars each), never detailed logs.
- Agent raw output: extract structured result, discard the rest.
- If context feels tight: compress immediately, don't wait.

### Red Lines (NEVER VIOLATE)
- NEVER `git push`, `git push --force`, `git reset --hard`
- NEVER delete files (`rm`, `git rm`)
- NEVER modify `.env`, secrets, tokens, `~/.claude/` config
- Before starting any service: `lsof -i:<port>` first
- Only `git add <precise files>` + `git commit`, never `git add -A`
- Record every commit hash to state.json

### Trust Nothing Principle
Agent output is UNTRUSTED. Every claim must be independently verified by the orchestrator (you) using direct shell commands. See Verification Protocol below.

### Process File Containment Policy (PROJECT POLICY)

> Defines the constant **`PROCESS_FILE_POLICY`**, prepended to the task
> prompt of **every** spawned agent (gsd-executor / gsd-code-reviewer /
> gsd-code-fixer / gsd-integration-checker). Reason: LLM context decays
> across turns — without per-phase re-injection, the executing agent
> will eventually forget "where to put process files" and pollute the
> project root. This is the single most common cleanup hazard in
> multi-phase runs.

**PROCESS_FILE_POLICY** — canonical definition. The orchestrator MUST
copy the code block below verbatim into every spawn prompt (Step 2/4/5/7)
at the marker `<<INJECT: copy the verbatim PROCESS_FILE_POLICY code block
from Core Rules>>`. Do not summarize, paraphrase, or shorten — LLM context
decay across turns is precisely why we re-inject the full text every time.

```
[项目政策 — 过程文件隔离,强制执行]

本项目所有非核心交付物的过程文件 — 包括:设计文档、部署/安装脚本、
测试脚本、调试输出、审计报告、临时测试产物 — 必须放在 _proc-use/ 下,
按性质分子目录:

  _proc-use/dev/      部署/安装/卸载脚本
  _proc-use/docs/     设计文档、变更记录
  _proc-use/reports/  测试报告、审计报告(运行产生)
  _proc-use/buginfo/  Bug 报告、复盘(长期保留,与 dev/docs/reports
                      等临时过程文件语义不同;未来版本化跟踪时,
                      应移到根目录的 buginfo/)
  _proc-use/_test-*/  临时单次测试产物(可清理)
  _proc-use/_audit-*/ 临时单次审计产物(可清理)

项目根目录只允许:Git 配置(.git/.gitignore)、核心交付物
(SKILL.md/README.md)、代码目录(scripts/、references/)、
License、IDE 配置。CI 配置统一放 .github/。
过程文件严禁散落根目录或其他未列出位置。

反向引用禁令:核心代码(SKILL.md/scripts/references/)不得
引用 _proc-use/ 下任何文件,即使测试代码反向引用生产代码。

完成本阶段后,自查:本阶段新增文件是否全在合法位置?根目录是否
无新孤儿?
```

## 过程文件命名与位置规范 (Bug-11)

> **背景**:根目录 / `_proc-use/` / 各种临时目录经常出现 `v3.0-check-1781181895.log`
> (带 timestamp)和 `v3.0-run-1.log`(不带)混着的情况。命名规则由 agent
> 自定,orchestrator 没规范,后续清理非常难。本节给出**强制命名 + 位置**
> 双约束。

### 1. 命名格式

**`{phaseId}-{stepName}-{index}.{ext}`**

- `phaseId`:2 位数字字符串(`00` / `01` / `02` / ... / `10`)
  - 关卡(gate)产物用 `gate-N-<label>` 形式,如 `gate-2-integration`
- `stepName`:白名单,文档级软约束(扫描后 WARN,不阻断 commit)从以下取一:
  - `execute` — 阶段执行
  - `audit` — 阶段审计
  - `fix` — bug 修复
  - `gate` — 关卡检查
  - `checkpoint` — checkpoint 记录
  - `summary` — 阶段总结
  - `plan-snippet` — 计划片段
  - **新增类别需明文加白名单**(不可临时加新值)
- `index`:从 `1` 递增。同一 phaseId + stepName 多次运行,index 加 1
- `ext`:常规扩展名(`md` / `log` / `json` / `txt`)

### 2. 位置约束

> **atdo runtime vs 长期归档边界(P2-3 明确)**:
> - **atdo runtime 临时 / transient 产物**(运行时中间状态,可被清理)→ `.phase-execution/...`
>   - 例:`.phase-execution/phases/01/audit-report.md` / `.phase-execution/gates/gate-2-integration/integration-test-report.md`
>   - 审计模板/集成测试报告模板等"运行时需要复现"的文件,放这里(gitignored)
> - **长期归档产物**(需 git 保留 / 跨会话追溯)→ `_proc-use/<phaseId>/` 或 `_proc-use/gates/<label>/`
>   - 例:`_proc-use/01/01-execute-1.log`、`_proc-use/02/02-audit-1.md`
>   - Bug-11 本节规定的"阶段产物 / 关卡产物"专指此类长期归档

- **阶段产物**:`_proc-use/<phaseId>/` 下
  - 例:`_proc-use/01/01-execute-1.log`、`_proc-use/02/02-audit-1.md`
- **关卡产物**:`_proc-use/gates/<label>/` 下
  - 例:`_proc-use/gates/integration/gate-2-integration-1.md`
- **主状态文件**:`_proc-use/state.json`(运行时由 phase-state.js 维护)
- **根目录严禁扔过程文件**(除 `README.md` / `SKILL.md` / `LICENSE` /
  `.gitignore` / `.github/` 等仓库元数据)
- **`.phase-execution/`**(gitignored)— 运行时 transient 状态,可保留

### 3. 反例 vs 正例

```
❌ v3.0-check-1781181895.log   # 带 timestamp,污染文件名
❌ v3.0-run-1.log              # phaseId 格式不对(v3.0)
❌ audit_report.md              # 无 phaseId,无 index
❌ 1-execute-1.log              # phaseId 必须 2 位(01)
❌ 01-EXEC-1.log                # stepName 必须在白名单内(用小写)
✅ 01-execute-1.log
✅ 01-audit-1.md
✅ 02-fix-2.log                 # 同一 phase+step 第二次,index=2
✅ gate-2-integration-1.md      # 关卡产物
✅ 00-plan-snippet-1.md         # plan 片段
```

### 4. orchestrator 检查行为(软约束)

- 阶段开始前 / 完成后,扫描 `_proc-use/<phaseId>/` 下文件,是否符合命名规范
- 不符合 → 输出 **WARN**(默认不阻断,仅提示)
- 根目录发现过程文件(非仓库元数据)→ 输出 **WARN**(不阻断)
- 这是**软约束**——LLM agent 不一定严格遵守,主要靠命名规范本身
  的"语义清晰、易清理"特性减少误用。**不引入硬阻断**——避免 agent
  因小文件名不规范而拒绝 commit,反而拖慢项目进度。

### 5. 明确禁止

- ❌ 文件名带 timestamp 后缀(如 `-1781181895`、`-20260612`)
- ❌ 同一 phase + step 多次运行覆盖同名文件(应递增 index)
- ❌ 过程文件散落根目录 / `scripts/` / `references/` 等核心代码目录
- ❌ stepName 取白名单之外的值(如 `run` / `check` / `test` / `debug`)

## Arguments

| Argument | Effect |
|----------|--------|
| `<plan-file>` | Path to project plan (any format) |
| `--from N` | Start from phase N |
| `--to N` | Stop after phase N |
| `--only N` | Execute only phase N |
| `--resume` | Resume from `.phase-execution/state.json` |
| `--dry-run` | Parse plan, show phases, don't execute |
| `--no-audit` | Skip agent audit 报告生成(状态机仍走 `executed → audited` 自动完成,不 spawn gsd-code-reviewer) |
| `--force-dirty` | Allow execution with dirty workspace (diff tracking may be unreliable) |
| `AUTO_PHASE_NO_CONFIRM=true` | Skip all checkpoints (fully unattended) |

## Startup Sequence

### Step 0: Environment Health Check
Run directly (no Agent delegation):
```bash
# 0a. Check workspace cleanliness (skip if --force-dirty)
# 约定:用户项目必须把 `.phase-execution/` 加入项目 .gitignore
#      (atdo 运行时自动生成的状态/报告目录,不应纳入版本控制)
#      过滤规则只放行 `?? .phase-execution/`(未跟踪)——若用户曾 `git add -f` 强提交,会变成 `M ` 状态,需先 `git rm --cached`
if [ "$FORCE_DIRTY" != "true" ]; then
  DIRTY=$(git status --porcelain | grep -v -E '^\?\? \.phase-execution/' || true)
  if [ -n "$DIRTY" ]; then
    echo "[FATAL] 工作区不干净，atdo 协议要求除 .phase-execution/ 外无任何未提交改动"
    echo ""
    echo "当前脏文件："
    echo "$DIRTY" | sed 's/^/  /'
    echo ""
    echo "修复方法（任选其一）："
    echo "  1. 提交: git add <files> && git commit -m 'WIP: 准备 atdo 执行'"
    echo "  2. 暂存: git stash push -u -m 'WIP before atdo'"
    echo "  3. 强制执行: 重启时使用 --force-dirty 标志（atdo 会忽略脏工作区，但后续 diff 判断会失效）"
    exit 1
  fi
else
  echo "[WARN] --force-dirty 模式：跳过工作区干净性检查，diff 判断可能失准"
fi

# 0b. Kill orphan agents
bash scripts/watchdog.sh cleanup

# 0c. Disk space check
node scripts/phase-state.js check-disk  # ≥500MB free
```
If any check fails → write ALERT.md, exit. Do NOT auto-fix environment issues.

### Step 1: Lock Acquisition
```bash
node scripts/phase-state.js lock
```
- Stale lock (pid dead): auto-clean, create new.
- Active lock (pid alive + matching startTime): report and exit.
- PID reused (startTime mismatch): clean and create new.

#### Lock 持有语义 (Bug-08)

> **背景**:本会话 Phase 01 完成后 lock 仍持久持有(协议没明确"何时释放")。
> 两种合理解读都讲得通——本协议**显式选择方案 A(持久持有)**,理由见下。
> 后续重构者请勿擅自改为"phase 间释放",否则会引入并发 /atdo 误启动风险。

**1. 持有时间**:**从 atdo 启动 → 所有 phase 完成时**才 unlock。
- **不**在 phase 间释放(杜绝并发实例误启动的真空期)。
- **不**在单个 phase 完成后释放(state.json 是真实状态,lock 文件只表达"有人正在跑")。

**2. 持有目的**:**防止并发 `/atdo` 实例误启动**。
- 并发 /atdo 不会因为"lock 文件还在"而拒绝启动,但它会**读取到不完整的 state.json**(phase 1 在 in_progress 而非 completed)导致游标错乱。
- lock 文件是粗粒度的"独占信号";phase 真实状态由 `state.json` 表达(single source of truth)。

**3. lock 文件状态 ≠ atdo 真实状态**:
- `state.json.currentPhaseIndex` + `phase.status` = atdo 真实状态
- `.phase-execution/lock` 只表达"**有进程声称在跑 atdo**"
- 即使 lock 文件长期存在 ≠ atdo 一直没结束——通过 state.json 心跳 / 进度 / phase 状态判断真实进展

**4. stale lock 处理**(已实现,文档化):
- 检测到 lock.pid 不存在 → stderr WARN + 自动清理 + 重建新锁
- 检测到 lock.pid 存在但 startTime 与当前进程不匹配 → 视为 PID 复用,清理 + 重建
- 检测到 lock.pid 注入攻击字符串 / 负数 / 浮点 / null → 静默清理 + 重建(P1-C 加固)

**5. lock 持有超过 24h**:
- 警告但需人工确认(不自动释放)
- 24h 后若 lock 仍存在 → 编排器应输出警告到 stderr,但**不会自动 unlock**
- 由用户决定是否手动 `unlock --reason=aborted`

**6. lock 释放时机(unlock 严格化,Bug-08 修复)**:
- ✅ **允许** unlock 的场景(必须显式 `--reason` 参数):
  - 所有 phase 已 `completed` → `unlock --reason=all-completed` (Step 9 收尾)
  - 用户显式终止(协议中 "aborted" 分支)→ `unlock --reason=aborted`
  - 3-strike ALERT 触发 → `unlock --reason=alert`
- ❌ **禁止**在以下情况 unlock:
  - 单个 phase 完成后
  - phase 处于 `in_progress` / `executed` / `audited` / `fixed` / `gated` 任何中间态
  - 任意时刻"觉得不再需要 lock"就释放

**7. 默认 reason + 显式确认**:
- `unlock` 无参数 → 拒绝(防止 orchestrator 误调)
- `unlock --reason=alert` → 默认 reason,仍要求显式确认(强制写明)
- 防止"误以为 unlock 是无害操作"的认知陷阱

**8. 反例(常见误读)**:
- ❌ "Phase 01 完成了,应该释放 lock 让 Phase 02 重新获取" → 错。同一 atdo 实例不应释放自己的 lock,会引入并发真空期。
- ❌ "lock 存在超过 1 小时说明 atdo 卡住了" → 错。lock 只是"有人在跑",真实进展看 state.json。
- ❌ "调用 unlock 不带 --reason 是默认行为" → 错。Bug-08 起 unlock 必须带显式 reason,防止误释放。

### Step 2: State Loading
If `--resume`: read state.json, skip plan parsing, go to Execution Loop.
Otherwise: parse plan → show at checkpoint → wait for confirmation → write state.json.

### Step 3: Plan Parsing (Four-Tier)

**Tier 1 — Known format**: If `.planning/ROADMAP.md` exists, use `gsd-tools query roadmap.analyze`.

**Tier 2 — Structured format**: If JSON/YAML with `phases[]`, parse directly.

**Tier 3 — Freeform Markdown 阶段序列型**: LLM-based extraction. Look for:
- Headers matching `## Phase N:` or `### Phase N:`
- Numbered sections `1.`, `2.` etc.
- Checkbox lists `- [ ]` as tasks
- Keywords "depends on", "gate", "关口" for gate detection

**Tier 3.5 — Freeform Markdown 任务列表型 (F-01)**: 用于"优先级任务列表"型 plan。
atdo 默认假设"plan = 阶段序列"(Phase 1 → Phase 2 → ...),但有些 plan 是"按
优先级排列的独立任务项"(P0-1, P0-2, ...),每项独立、互相不强依赖。F-01 起 atdo
识别并支持这种格式。识别规则:

- **一级标题(分块)**:`## <N>.` 或 `## <N>、`(N 是数字,0-N),**或**纯 `##` 标题(无
  数字前缀) — 后者视为整个 plan 一个分块
- **二级标题(任务项)**:`### P<priority>-<index>`(priority ∈ 0|1|2|3,index 是数字,
  允许 1-2 位),如 `### P0-1: state.json schema 文档` / `### P2-3: 任务校验`
- **任务内容**:紧跟二级标题,可能是 checkbox `- [ ]` 或纯文本项 `- xxx`
  两者都可;解析时合并成一个 `tasks[]` 数组(去掉 checkbox 前缀)
- **依赖关系**:任务列表型 plan **无 depends_on**(`### P?-N` 各项互相独立)
- **phase id**:用 `NN` 格式顺序编号(从 01 开始,与 Tier 3 阶段序列型保持一致)

**示例(输入)**:
```markdown
## 0. P0 - 必须修复

### P0-1: state.json schema 文档
- 在 SKILL.md 增加 schema 章节
- phase-state.js 错误消息改进

### P0-2: record-commit 多 hash 支持
- split(',') + trim + 校验

## 1. P1 - 高优先级

### P1-1: 非 Gate commit 规则
- ...
```

**示例(转换后 state.json)**:
```json
{
  "phases": [
    { "id": "01", "name": "P0-1: state.json schema 文档", "tasks": ["在 SKILL.md 增加 schema 章节", "phase-state.js 错误消息改进"], "depends_on": [] },
    { "id": "02", "name": "P0-2: record-commit 多 hash 支持", "tasks": ["split(',') + trim + 校验"], "depends_on": [] },
    { "id": "03", "name": "P1-1: 非 Gate commit 规则", "tasks": [...], "depends_on": [] }
  ]
}
```

**Tier 3.5 识别步骤**(init 内部 detection 阶段,按顺序执行):
1. **扫 `### P<priority>-<index>` 模式** → 命中 ≥ 1 个 → 启用 Tier 3.5
   (regex: `/^###\s+P[0-3]-(\d{1,2})\b/m`)
2. **检查冲突**:同时存在 `## Phase N:` 或 `### Phase N:` 模式 → FATAL
   (语义冲突:阶段序列和任务列表不能混用)
3. **解析 phase**:每个 `### P?-N` 作为一个 phase,后续内容(到下一个
   `### ` 或 `## ` 标题)为该 phase 的 tasks
4. **id 分配**:从 01 开始顺序编号(同 Tier 3)
5. **depends_on**:固定 `[]`(任务列表型无依赖)

**Tier 3.5 反例 / 边界**:
- ❌ 只有 `## 0.` 没有 `### P?-N` → FATAL("Tier 3.5 需要至少一个 P?-N 子项。
  提示:如果 plan 是阶段序列型,使用 `## Phase N:` 格式;如果是任务列表型,使用
  `### P<priority>-<index>` 格式")
- ❌ 同时有 `## Phase N:` 和 `## N.` 或 `### P?-N` → FATAL("plan 同时含阶段序列和
  任务列表,语义冲突。请统一为其中一种格式")
- ❌ `### P?-N` 但 priority 不在 0|1|2|3 → FATAL("P 后的优先级必须是 0/1/2/3,
  收到: <X>")
- ❌ `### P?-N` 但 N 不是数字 → FATAL("P?-N 的 N 必须是数字(1-2 位),
  收到: <X>")
- ❌ `### P?-N` 标题后无任何 task 内容 → 该 phase tasks 为空数组(允许,但建议补充)

**Tier 选择优先级**:
- init 时按 Tier 1 → Tier 2 → Tier 3 → Tier 3.5 顺序检测,**首个命中即采用**
  (互斥,不允许 plan 同时属于多档)
- 详细调度逻辑在 `scripts/phase-state.js` 的 `detectAndParsePlan` 函数中

**CRITICAL**: After freeform parsing, MUST show extracted phases at a checkpoint. Do NOT silently execute.

**Failure handling**: If parsing fails → ALERT.md + exit. Never guess.

**Dependency validation**: Build directed graph, topological sort. Cycle detected → ALERT.md + exit.

**Oversized phase detection**: If any phase has >15 tasks → warn, suggest splitting.

### Step 4: State Initialization
```bash
echo '<json>' | node scripts/phase-state.js init
```

## state.json Schema (Bug-02)

`phase-state.js init` 接受的 plan JSON 有 3 条隐性规则,违反时返回 FATAL。
第一次使用时,先看这里再写 plan — 避免试错。

### 最小可工作示例

```json
{
  "phases": [
    { "name": "环境准备",    "tasks": ["安装依赖", "配置环境"] },
    { "name": "核心实现",    "tasks": ["写代码", "写测试"], "depends_on": ["01"] },
    { "name": "发布",        "tasks": ["打包", "上线"],     "depends_on": ["02"], "is_gate": true }
  ]
}
```

### 3 条隐性规则(必须遵守)

1. **`tasks` 必须是 `string[]` — 不是 `number[]`,也不是 `{id, desc}[]`**
   每个元素是任务描述字符串,描述"做什么"(供 gsd-executor agent 读取执行)。

2. **阶段 id 是 2 位数字字符串(`"01"` / `"02"` / `"03"`),由位置自动分配**
   plan 输入**不读** `id` / `number` 字段,id 永远是 `String(数组下标 + 1).padStart(2, '0')`。
   `depends_on` 引用第 N 个阶段就写 `"0N"`,不是 `"phaseN"` / `"1"` / `"phase-1"`。

3. **`depends_on` 引用的 id 必须精确匹配某个阶段的 `number` 字段**
   否则 FATAL:`depends_on 引用不存在的阶段 "<id>"`。
   id 不存在 = 拼写错误,或依赖了尚未在数组中出现的阶段。

### 反例 vs 正例

```jsonc
// ❌ 反例 1:tasks 是 number[]
{ "phases": [{ "name": "a", "tasks": [1, 2, 3] }] }
//    → FATAL: 阶段 01 task 必须是字符串(string[]),不是 number 也不是 {id, desc}[]

// ❌ 反例 2:tasks 是 {id, desc} 对象数组
{ "phases": [{ "name": "a", "tasks": [{ "id": "t1", "desc": "task one" }] }] }
//    → FATAL: 阶段 01 task 必须是字符串(string[]),不是 number 也不是 {id, desc}[]

// ❌ 反例 3:depends_on 用了人类可读 id
{ "phases": [
    { "name": "a" },
    { "name": "b", "depends_on": ["phase1"] }   // 错:"phase1" 不是自动分配的 id
]}
//    → FATAL: 阶段 02 depends_on 引用不存在的阶段 "phase1"

// ✅ 正例:tasks 是 string[],depends_on 用 2 位数字 id
{ "phases": [
    { "name": "a", "tasks": ["task 描述 1", "task 描述 2"] },
    { "name": "b", "tasks": ["task 描述 3"], "depends_on": ["01"] }
]}
```

### 字段别名(plan 输入兼容写法)

| 标准字段 | 也接受 | 说明 |
|---------|--------|------|
| `name` | `id`(若 `name` 缺失) | 阶段显示名 |
| `depends_on` | `requires` | 依赖的阶段 id 列表 |
| `is_gate` | `gate` | 是否为质量关口 |
| `success_criteria` | (无别名) | 成功条件数组 |

### 长度上限(防 DoS / 误用)

- `name` ≤ 200 字符
- `goal` ≤ 2000 字符
- `tasks` 数组 ≤ 50 项
- 单个 `task` ≤ 500 字符
- 阶段总任务数 > 15 → 触发 WARN(建议拆分)

## Plan vs State 一致性规则 (Bug-09)

> **背景**:state.json 有 `phases[].tasks[]`,原 plan file(`_proc-use/EXECUTION_PLAN.md` /
> 用户传入的 `<plan-file>`)也有 task 列表。两者**没有自动同步机制**——
> plan 改了 state.json 不会跟变,反之亦然。潜在风险:数据漂移,
> orchestrator 不知道以哪个为准。
>
> **决策**:采用"**state.json 是 single source of truth (SSOT),plan file 只在 init 时读一次**"。
> 简单优先(YAGNI)—— init 一次性解析 plan → 后续 phase 启动不重新解析,
> 避免"plan 改 → state 跟 → 数据漂移"的复杂一致性协议。

### 1. SSOT 原则:state.json 是 single source of truth

- **state.json 包含执行所需的全部信息**:
  `phases[].id / name / tasks / status / commits / gateType / depends_on` 等
- **state.json 持久化机制已成熟**:
  atomic write + .bak.1/2/3 备份轮转 + heartbeat 监控 + lock 持有语义
  (见 §state.json Schema / Step 1 Lock 持有语义)
- **所有 phase 启动、set-phase、record-commit、inc-strike 等操作都以 state.json 为准**

### 2. plan file 角色:**只在 init 时读一次**

- plan file 的**唯一用途**:在 `node scripts/phase-state.js init` 阶段被读一次,
  内容(phases 数组)被**拷贝**到 state.json 的 `phases` 字段
- init 完成后,**orchestrator 不再读取 plan file**:
  - 不重新解析 tasks
  - 不与 state.json 对比
  - 不响应 plan file 的任何修改
- plan file 改了 → **不影响 atdo 执行**(这是 by design,不是 bug)
- 如果用户想用新 plan,应**重新 init**:
  ```bash
  rm .phase-execution/state.json
  # 然后重启 atdo 并传新 plan-file(走 init 流程)
  ```
  重新 init 会丢弃旧 state.json 的 phase 进度,这是 by design 的"硬 reset"。

### 3. plan vs state 不一致检测(防御性、可选)

> **作用**:纯防御性,避免误报,不阻断流程。

- state.json 顶层**可选**字段 `planHash: <md5-hex>`,
  记录 init 时 plan file 的 md5(由 `phase-state.js init` 计算)
- orchestrator **可选**在 phase 启动时做 hash 对比:
  ```bash
  # 示例:仅用于日志记录,不阻断
  CURRENT_HASH=$(md5 -q <plan-file>)
  STATE_HASH=$(node scripts/phase-state.js get planHash)
  if [ "$CURRENT_HASH" != "$STATE_HASH" ]; then
    echo "[INFO] plan file 已被修改(init 后),state.json 仍按原 plan 执行"
  fi
  ```
- 不一致 → 输出 **INFO 日志**(不是 WARN,不阻断)
- 协议层不强制 orchestrator 做这个检查(避免误报 + 性能开销)
- `--resume` 时**不**做 hash 校验(plan 可能在 init 之后改过,
  但 state.json 是合法的当前状态,不应被 hash 不匹配阻断 resume)

### 4. planHash 字段细节(phase-state.js init 行为)

| 场景 | planHash 行为 |
|------|--------------|
| plan JSON 顶层含 `planHash: "..."` | init 把它直接写入 state.json 顶层 |
| plan JSON 不含 `planHash` | init **不**计算,不 FATAL;state.json 顶层无 planHash 字段(向后兼容) |
| 旧 state.json 无 planHash 字段 | 所有命令把它当作"未设置",不影响行为 |

> **设计权衡**:init **不**自动从 plan file 读内容算 md5,因为
> `phase-state.js init` 只接收 stdin/arg 的 plan JSON,不接触原 plan file
> (避免路径校验、I/O 风险)。如果用户想让 state.json 记录 hash,
> 应在调用 init 前自己算好,放进 plan JSON 顶层。

### 5. 明确禁止(防止未来重构回退)

- ❌ orchestrator 在 phase 启动前**不得**重新读 plan file 解析 tasks
- ❌ orchestrator **不得**自动同步 plan 修改到 state.json
- ❌ orchestrator **不得**在 phase 启动时强制做 planHash 不一致阻断
  (防御性检测只能 INFO,不能 FAIL)
- ❌ `phase-state.js init` **不得**因 planHash 缺失而 FATAL
  (向后兼容,旧 init 调用无 planHash 字段时必须继续工作)

### 6. 用户答疑(常见问题)

| 用户问 | 协议回复 |
|-------|---------|
| "我改了 plan 怎么没生效?" | "atdo 启动后 plan 不再生效(state.json 是 single source of truth)。如需用新 plan,请 `rm .phase-execution/state.json` 后重新 init" |
| "planHash 有什么用?" | "纯防御性检测。orchestrator 可选在 phase 启动时做 md5 对比,不一致输出 INFO 日志(不阻断)。防止 orchestrator 误以为 plan 改动会自动生效" |
| "为什么 init 不自动算 planHash?" | "init 只接收 plan JSON,不接触原 plan file(避免路径校验、I/O 风险)。如果需要 hash,在调用 init 前自己算" |

## Execution Loop (ONE PHASE PER TURN)

After startup, find the first phase with status `pending` or `in_progress`. Process exactly ONE phase, then persist and schedule the next wakeup via CronCreate (durable, cross-session — NOT ScheduleWakeup, which requires /loop dynamic mode and fails silently in standard invocations).

### Phase Execution Protocol

```
[CHECKPOINT] Phase N/M: <phase-name> — reply 'c' to continue, 's' to skip, 'a' to abort
```
(Skip checkpoint if AUTO_PHASE_NO_CONFIRM=true)

**1. Pre-flight**
- Verify dependency phases have status `completed`
- Record `git rev-parse HEAD` as baseline
- Load plan-snippet (extract from state or plan file, ≤500 chars)
- Set phase to in_progress: `node scripts/phase-state.js set-phase <phaseId> in_progress`

**2. Agent Execution**
Spawn gsd-executor agent with this prompt structure:
```
<<INJECT: copy the verbatim PROCESS_FILE_POLICY code block from Core Rules>>
────────────────────────────────────────
(以下是你本阶段的任务)

Execute phase {N}: {name}.
Goal: {goal}
Tasks: {tasks}
Success criteria: {criteria}
Constraints: Work ONLY in {projectRoot}. Do NOT read .env files. Do NOT output secrets.

After completing your task, output EXACTLY this line:
[AUTO-EXEC-RESULT: status=SUCCESS|FAILED, methodology=proxy|real|mixed, files=<count>, tasks_done=<count>, errors=<count>]
```

**methodology 字段(强制)— 标识 agent 实际使用的测试/验证方法学:**

| 取值 | 含义 | 典型场景 |
|------|------|---------|
| `proxy` | bash 模拟 / mock / fixture / 代理测试(无真实 AI 推理或真实外部 API) | `sleep 0.05s` 模拟 AI 推理、shell 桩函数、固定 JSON fixture |
| `real` | 真实 AI 推理 / 真实外部 API / 真实代码执行(端到端无替代) | 调 Claude API、跑真实 DB、调用真实第三方服务 |
| `mixed` | 部分真实部分模拟(必须详细列出哪部分是 proxy) | 真实 DB + mock LLM,真实 API + stub 通知 |

**为什么强制:** proxy 测试不构成 gate 通过的充分证据(Bug-05 教训)。
agent 必须如实申报,orchestrator 才能识别"proxy 报告冒充 PASS"的情形
(如 Phase 02 Gate 2 用 `sleep 0.05s` 模拟 AI 推理,报告 §0.1-0.3
透明承认是 proxy 但仍判 PASS)。

After agent returns:
- Parse for `[AUTO-EXEC-RESULT: ...]` marker
- **Marker parsing rules**: Search the ENTIRE agent output for the marker line — it may appear inside code blocks, with leading/trailing whitespace, or after other content. Use: `grep -oP '\[AUTO-EXEC-RESULT:.*?\]'` or equivalent pattern match. If the agent output contains multiple markers (e.g., from restarted sub-agents), use the LAST one.
- **methodology 字段校验(强制)**:从 marker 提取 `methodology=...`,必须是 `proxy|real|mixed` 之一;缺失或非法值 → 视为 FAILED,触发 fix loop 要求 agent 重报(不静默放行)
- **proxy 报告处理(Bug-05 核心)**:若 `methodology=proxy` → 暂停 gate 流程,**不允许按 agent 报告的 SUCCESS/PASS 自行通过 gate**;输出警告 "⚠️ Gate X proxy-only, requires human sign-off or real validation",将 phase 标为 INCONCLUSIVE(等同"待人工放行或 real 验证")。**proxy 测试不构成 gate 通过的充分证据**——orchestrator 必须显式要求人工放行(由用户/上游确认)或 agent 重跑 real 验证后,才能进入下一阶段
- No marker found → treat as AGENT_OUTPUT_INCOMPLETE, retry once with shorter prompt
- Update state: `executed`

**3. Independent Verification** (orchestrator direct execution, NOT Agent)

Run these checks directly via Bash:
```bash
# 3a. File existence (for each declared deliverable)
test -f <path> && test -s <path>

# 3b. Syntax check (adapt to project language)
tsc --noEmit 2>&1 || cargo check 2>&1 || echo "no compiler found, skipping"

# 3c. Git diff sanity
git diff --stat HEAD  # verify changes are non-zero but < 10000 lines

# 3d. Debug residue scan
grep -rE 'console\.log|debugger|TODO|FIXME' --include='*.ts' --include='*.js' --include='*.py' --exclude-dir='.git' --exclude-dir='node_modules' . 2>/dev/null || true

# 3e. Secret format scan
grep -rE 'sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}' --exclude-dir='.git' --exclude-dir='node_modules' . 2>/dev/null || true
```

Any verification failure → trigger fix loop (step 5).
Record findings to execution-log.md.

**4. Agent Audit** (unless `--no-audit` flag is set)

> **P1-4 协议明确**:`--no-audit` 仅跳过"agent audit 报告生成"(不 spawn gsd-code-reviewer),但状态机 **必须** 仍走 `executed → audited`(orchestrator 在该模式下直接 `set-phase ... audited`,不依赖 audit 报告)。这样 `--no-audit` 与 Bug-06 严格状态机无矛盾:状态机推进不停,只是少一个 agent spawn。

Spawn gsd-code-reviewer agent:
```
<<INJECT: copy the verbatim PROCESS_FILE_POLICY code block from Core Rules>>
────────────────────────────────────────
(以下是审计任务)

Review all files changed in phase {N}. Check: lint, syntax, diff scope, debug residue, hardcoded secrets.
Write structured report to .phase-execution/phases/{N}/audit-report.md
(NOTE: atdo runtime report path — exempt from the _proc-use/ rule above).
Use the template at ~/.agents/skills/atdo/references/templates/audit-report-template.md.

Output at end: [AUTO-EXEC-RESULT: status=SUCCESS|FAILED, methodology=proxy|real|mixed, blockers=<count>, warnings=<count>]
```

After agent returns:
- Run sanitize on audit report: `node scripts/phase-state.js sanitize .phase-execution/phases/{N}/audit-report.md`
- Update state: `executed → audited`

**5. Fix Loop** (max 3 attempts)

For each BLOCKER in audit-report, spawn gsd-code-fixer with the standard
policy prepended:
```
<<INJECT: copy the verbatim PROCESS_FILE_POLICY code block from Core Rules>>
────────────────────────────────────────
(以下是修复任务)

Fix the following BLOCKERs from audit-report for phase {N}:
{blockerList}
Constraints: Make MINIMAL targeted changes only. Do NOT refactor surrounding
code. Do NOT change unrelated files. Verify each fix with a syntax check
before declaring done.

Output: [AUTO-EXEC-RESULT: status=SUCCESS|FAILED, methodology=proxy|real|mixed, fixes_applied=<count>, files_changed=<count>]
```

Then re-audit. Strike tracking:
```
Attempt 1: gsd-code-fixer → re-audit
Attempt 2: gsd-code-fixer → re-audit
Attempt 3: git checkout -- <files>  (rollback to pre-fix state) + ALERT.md + EXIT
```

Track strikes:
```bash
node scripts/phase-state.js inc-strike <phaseId> fix
# If count >= 3 → ALERT.md + exit
```

Update state: `audited → fixed`

**6. Gate Detection**

A phase is a gate if:
- Plan explicitly marks it `is_gate: true`
- Phase has `depends_on` referencing prior phases
- Every 2nd phase (default: phases 2, 4, 6, ...)
- **The final phase is ALWAYS a gate** (regardless of the above rules)

If NOT a gate: skip to step 8 (completion).

**7. Gate Integration Test** (gate phases only)

Spawn gsd-integration-checker agent:
```
<<INJECT: copy the verbatim PROCESS_FILE_POLICY code block from Core Rules>>
────────────────────────────────────────
(以下是关口集成测试)

Verify cross-phase integration for phases {1} through {N}.
Check: exports connect to imports, APIs have consumers, data flows end-to-end.
Write report to .phase-execution/gates/gate-{label}/integration-test-report.md
(NOTE: atdo runtime report path — exempt from the _proc-use/ rule above).
Use template at ~/.agents/skills/atdo/references/templates/integration-test-report-template.md.

Output: [AUTO-EXEC-RESULT: status=SUCCESS|FAILED, methodology=proxy|real|mixed, integration_errors=<count>]
```

If integration failures → gate fix loop (max 3 attempts):
```
Attempt 1: gsd-code-fixer (focus on integration layer, do NOT rollback phase code) → re-test integration
Attempt 2: gsd-code-fixer → re-test integration
Attempt 3: ALERT.md with detailed integration gap analysis + EXIT
  (Do NOT git checkout — integration gaps are design issues, not code bugs to revert)
```

Track strikes:
```bash
node scripts/phase-state.js inc-strike <phaseId> integration
```

**Code gate checks** (run directly after integration pass):
```bash
# Project lint
npm run lint 2>&1 || true

# Related tests only (not full suite unless plan says so)
# CHANGED = 相对 pre-flight 记录的 baseline commit 的所有变更
# 若 pre-flight 未 commit(可能 baseline = HEAD,即"相对未提交变更")
# baseline 的具体值由 orchestrator 在 Step 1 记录,此处用 $BASELINE 变量
CHANGED=$(git diff --name-only ${BASELINE:---} 2>/dev/null || git diff --name-only 2>/dev/null || echo "")
if [ -n "$CHANGED" ]; then
  npx jest --findRelatedTests $CHANGED 2>&1 || true
else
  echo "No changed files detected, skipping related tests"
fi
```

Full test suite only if plan explicitly declares it.

Update state: `fixed → gated`

**8. Git Commit 规则 (按阶段类型区分)**

> **Bug-04 修复**:此前小节标题 `Git Commit (gate phases only, after all checks pass)`
> 容易被字面理解为"非 Gate Phase 不允许 commit",与工程实践的"原子提交"原则冲突。
> 实际现象:Phase 01(非 Gate)agent 内部产生了 3 个原子 commit (`32db291` / `3c79edb` /
> `078de4c`),这符合"每个 commit 只解决一个问题"的最佳实践,但与协议字面冲突。
> 根因:协议对"非 Gate Phase 是否允许 agent 内部 commit"模糊。
> 修复:本节明文区分 **Gate Phase** 与 **非 Gate Phase** 的 commit 责任边界。

### 8.1 Gate Phase (质量关口) — orchestrator 强制在 phase 收尾 commit

- 触发条件:plan 中 `is_gate: true` / `gate: true` / 每隔一个阶段 / **最终阶段恒为 Gate** (Step 6 Gate Detection)
- commit 时机:Step 7 (Gate Integration Test) 通过后,Step 8 收尾强制 commit
- commit 主体:**orchestrator**(本协议运行方),不在 agent spawn prompt 中要求 agent commit
- commit 粒度:1 个 phase = 1 个 commit 块(可能含 agent 内部已产的多个 commit + orchestrator 的 gate summary commit)
- 安全检查:见下方 §8.3
- 强制要求:`git add <precise files>`,禁止 `git add -A`

```bash
# Security check(覆盖 .env.local / config/.env / id_rsa 等变体,锚定到路径末尾)
# 原 P0:'\.env$' 只匹配字面 .env,会漏掉 .env.local / .env.production / config/.env
#      'credentials' 无锚定,会误中;id_rsa 无扩展名需单独加
#      'secrets?' / 'credentials?' 覆盖单/复数;均锚定到路径末尾避免误中
# 白名单:.env.example/sample/template/dist/default 是约定俗成的模板文件,应允许 commit
git diff --name-only | grep -iE '(\.env(\.[^/]+)?$|\.pem$|\.key$|id_rsa$|id_dsa$|id_ed25519$|credentials?\.[^/]+$|secrets?\.[^/]+$)' | grep -viE '\.env\.(example|sample|template|dist|default)$' && echo "SECURITY: sensitive file in diff" && exit 1

# Precise add (NOT git add -A)
git add <list of expected changed files>

# Commit (orchestrator-only)
git commit -m "auto-phase: Phase {N} complete [gate:{label}] [audit:passed]"

# Record(支持单 hash 与 comma-separated 多 hash)
# Bug-03:支持单 hash 也支持 comma-separated 多 hash(agent 一次产 N 个 commit 场景)
#   例子:node scripts/phase-state.js record-commit 01 32db291,3c79edb,078de4c
#   - hash 之间用英文逗号分隔,逗号周围的空格会被自动 trim
#   - 任一 hash 无效 / 末尾悬空逗号 / 列表为空 → FATAL,不部分写入
node scripts/phase-state.js record-commit <phaseId> <hash[,hash,...]>
```

### 8.2 非 Gate Phase — agent 可在阶段内原子提交,orchestrator 不强制在 phase 收尾再 commit

- 触发条件:plan 中既无 `is_gate` 标记,也不在 Gate Detection 命中的"每 2 个阶段"列表中(且非最终阶段)
- commit 时机:**agent 内部随时**(完成任务 / 修复 bug / 文档更新),无需等 phase 收尾
- commit 主体:**agent (gsd-executor / gsd-code-fixer)**,orchestrator 不介入
- commit 粒度:**原子提交原则** —— 每个 commit 只解决一个问题 / 实现一个功能(参见全局规则 engineering-practices.md §2.1-2.2)
- orchestrator 在非 Gate Phase 收尾:**不需要 commit**,只需要持久化 state.json (set-phase completed + heartbeat + summary)

**为什么这么设计(对比 "orchestrator 强制在 phase 末尾统一 commit" 的旧理解):**

| 维度 | agent 内部原子提交(当前协议) | orchestrator 末尾统一 commit(旧理解) |
|------|-----------------------------|-------------------------------------|
| 粒度 | 细(每 commit 一个变更) | 粗(整 phase 一次 commit) |
| 回滚粒度 | 精准(bug 只影响 1 个 commit) | 整 phase(可能含多个无关变更) |
| 代码 review | 易(每个 commit 自解释) | 难(混杂多变更) |
| 故障恢复 | 好(中间 commit 已落盘) | 差(末尾 commit 失败 = 整 phase 丢失) |
| git history | 清晰(skill step / fix bug / docs 各自 commit) | 混乱(整 phase 1 commit) |

### 8.3 agent 内部 commit 必须遵守的红线(无论 Gate / 非 Gate)

1. **`git add <precise files>` 精确文件,禁止 `git add -A`**(防止误提交 .env / 临时文件)
2. **禁止 `git push` / `git push --force` / `git reset --hard`**(参见 Core Rules Red Lines)
3. **禁止 commit 敏感文件**:.env / .env.*(非 .example/sample/template/dist/default)/ .pem / .key / id_rsa / id_dsa / id_ed25519 / credentials.* / secrets.* (路径末尾锚定)
4. **commit hash 必须记录到 state.json**:`node scripts/phase-state.js record-commit <phaseId> <hash[,hash,...]>` (Bug-03 支持 comma-separated 多 hash)
5. **commit message 遵守 Angular 规范**:`<type>(<scope>): <subject>`,type 限于 feat / fix / docs / style / refactor / test / chore / perf / ci / revert / security / hotfix
6. **每个 commit ≤ 1 个问题/功能**(原子性);如发现一个 commit 含多个独立变更,应 `git reset HEAD~1` 后拆分重新提交

### 8.4 Commit 失败处理(无论 Gate / 非 Gate)

- pre-commit hook rejection → fix hook-reported issues, retry once
- merge conflict → ALERT.md + exit (do NOT auto-resolve)
- other errors → ALERT.md + exit
- agent 内部 commit 失败 → 在 agent prompt 中给出 `[AUTO-EXEC-RESULT: status=FAILED]`,由 orchestrator 触发 fix loop

### Manual Gate Protocol (Bug-06)

> **背景**:Gate 3 等场景是"人工对比多篇资产"——这是**用户判断**,agent 不可代理。
> 此前的协议(§7 Gate Integration Test)只覆盖 auto gate(Gate Integration Test 由 gsd-integration-checker 跑)。
> Manual gate 没有协议,orchestrator 只能临时拼凑 AskUserQuestion,流程是 ad-hoc。
> 本节**显式定义 manual gate 协议**,让 orchestrator 不再即兴发挥。

**核心问题**:§8.4 之后的 §9 "Phase Completion + Continuation" 假设 gate 总能 auto 通过。
但有些 gate 的"pass/fail"判断**只有人能做**(例:Gate 3 人工对比 02/03/10 三篇资产的一致性、主观质量)。
agent 跑 proxy 测试无法构成充分证据,LLM 自身判断也不可信。

**1. `gateType` 字段**(phase schema 扩展)

```jsonc
{
  "phases": [
    { "name": "Phase 01", "tasks": ["..."] },                                        // 默认 auto
    { "name": "Gate 1",   "is_gate": true,                       "gateType": "auto" },
    { "name": "Gate 2",   "is_gate": true, "gate_type": "manual", "tasks": ["人工对比 02/03/10 三篇资产"] },
    { "name": "Gate 3",   "is_gate": true, "gate_type": "hybrid" }
  ]
}
```

| 取值 | 含义 | orchestrator 行为 |
|------|------|------------------|
| `auto`(默认) | agent 全自动通过(原协议) | 跑 Gate Integration Test,orchestrator 决定 |
| `manual` | 必须用户判断 | §7 完成后**暂停**,等待 `AskUserQuestion`,agent 报告仅作背景信息 |
| `hybrid` | agent 报告 + orchestrator 自动化检查 + 用户最终签字 | 跑完 §7 后再触发 `AskUserQuestion`,用户可基于 agent 报告决定 pass / fail |

**字段别名**(plan 输入兼容写法,phase-state.js init 接受):
- 标准:`gateType` (camelCase)
- 别名:`gate_type` (snake_case,与 `is_gate` / `depends_on` 风格一致)
- 缺省:`auto`(向后兼容,旧 plan 无 `gateType` 时不报错)

**2. Manual gate 流程**(orchestrator 在 §7 之后执行)

```
phase 进入 §7 Gate Integration Test 完成(gated 状态)
        │
        ▼
[Check] phase.gateType?
        │
   ┌────┴────┐
   │         │
 auto      manual / hybrid
   │         │
   ▼         ▼
§9 normal  set-phase <id> awaiting_user_review   ← Bug-06 新状态
continue   │
            ▼
           state.awaiting_user_review = { phaseId, askedAt, optionsShown }
           │  (顶层字段,manual gate 进行时存在,get-current-phase 检测到该字段时返回 done=false + awaiting=true)
           ▼
           AskUserQuestion(
             question: "Phase N (gateType=manual) 是否通过?",
             header: "Gate N review",
             options: [
               { label: "pass",              description: "通过,继续下一阶段" },
               { label: "fail",              description: "不通过,触发 ALERT 并退出" },
               { label: "request-changes",   description: "回退到上一阶段重新执行" },
               { label: "skip",              description: "跳过本阶段(谨慎使用,记录到日志)" }
             ],
             multiSelect: false
           )
           │
           ▼
       收到答复 → set-phase <id> <user-review-decision>
            │
       ┌────┼────────┐
       │    │        │
     pass  fail  request-changes   skip
       │    │        │
       ▼    ▼        ▼
   user-  user-  回退到上一阶段    skip 当前 phase
   review- review- (set-phase ... pending + 当作新任务重做)
   pass   fail
       │    │
       ▼    ▼
   §9 续   ALERT.md + exit
```

**3. `state.json` schema 扩展**(与 phase-state.js 同步)

```jsonc
{
  "phases": [
    {
      "number": "02",
      "isGate": true,
      "gateType": "manual",   // ← 新字段,默认 auto,缺省时 phase-state.js 视作 auto
      "status": "awaiting_user_review"  // ← 新中间态,见下方
    }
  ],
  // ← 新顶层字段,可选,仅 manual gate 进行时存在
  //   phase-state.js set-phase 在进入 awaiting_user_review 时自动写入
  //   在 user-review-pass / user-review-fail / completed 时自动清除
  "awaiting_user_review": {
    "phaseId": "02",
    "askedAt": "2026-06-11T10:30:00Z",
    "optionsShown": ["pass", "fail", "request-changes", "skip"]
  }
}
```

**3a. 新增 phase status(Bug-06)**

| Status | 进入来源 | 离开目标 | 语义 |
|--------|---------|---------|------|
| `awaiting_user_review` | `gated` (manual/hybrid gate) | `user-review-pass` / `user-review-fail` | orchestrator 已发起 AskUserQuestion,等用户答复 |
| `user-review-pass` | `awaiting_user_review` | `completed` | 用户签字通过 |
| `user-review-fail` | `awaiting_user_review` | (终态) | 用户判定不通过,触发 ALERT |

**3b. 状态机合法转换表**(phase-state.js 校验,跳过任何中间态 → FATAL)

```
pending              → in_progress
in_progress          → executed
executed             → audited
audited              → fixed
fixed                → gated
gated                → completed              (auto gate 直通)
gated                → awaiting_user_review   (manual/hybrid gate 入口)
awaiting_user_review → user-review-pass | user-review-fail
user-review-pass     → completed
user-review-fail     → (终态,ALERT)
completed            → (终态)
```

**4. Fail Fast 设计**(故意不做的事)

- ❌ **不调 CronCreate**。Manual gate 进行时,atdo 完全 hold,不创建下一次自动唤醒。
  避免空转、避免 watchdog 误判超时、避免消耗 cron slot。
- ❌ **不设 timeout 默认值**。"用户不回复就 N 小时后跳过"是危险的反模式——
  会让 critical gate 被静默绕过。Manual gate 必须等用户显式答复。
- ❌ **不写 watchdog 超时 ALERT**。watchdog 看到 `awaiting_user_review` 应**正常 hold**,
  不应判定"心跳超时"。`state.json` 顶层 `awaiting_user_review` 字段就是给 watchdog
  看的"我在等用户,别动我"信号。
- ✅ **可恢复**。如需中止,用户/上游可:
  (a) 通过 `AskUserQuestion` 答复;
  (b) `CronList` + `CronDelete` 取消已存在的下一次 cron(若 §9 误创建了);
  (c) 编辑 state.json 把 phase 回退到 gated(应急,不走 set-phase 命令)。

**5. Bug-05 与 Manual gate 的关系**

- Bug-05 规定 `methodology=proxy` 报告不得判定 PASS,要求人工放行(human sign-off)。
- Manual gate 是 **Bug-05 协议的程序化实现**:把"人工放行"从一个临时补救流程,提升为协议级状态机。
- 触发条件:phase.gateType = manual / hybrid(显式声明),或 §7 检测到 methodology=proxy 时由 orchestrator
  主动将 phase 升级为 manual gate(set-phase ... awaiting_user_review)。

**6. 反例 vs 正例**

```jsonc
// ❌ 反例 1:plan 没标 gateType,§7 又检测到 proxy 报告 → orchestrator 只能临时拼 AskUserQuestion
{ "phases": [{ "name": "Gate 2", "is_gate": true }] }  // 默认 auto,遇到 proxy 报告无协议可循

// ✅ 正例 1:plan 显式标 manual,orchestrator 走 Manual Gate Protocol
{ "phases": [{ "name": "Gate 2", "is_gate": true, "gateType": "manual" }] }

// ✅ 正例 2:hybrid 模式,agent 报告作为背景,用户最终签字
{ "phases": [{ "name": "Gate 3", "is_gate": true, "gateType": "hybrid" }] }

// ✅ 正例 3:旧 plan 无 gateType,phase-state.js 默认 auto,完全向后兼容
{ "phases": [{ "name": "Gate 1", "is_gate": true }] }  // 等价于 auto,旧行为不变
```

**7. `phase-state.js` 命令扩展**

| 命令 | 新行为 |
|------|-------|
| `set-phase <id> awaiting_user_review` | 顶层写入 `awaiting_user_review = { phaseId, askedAt, optionsShown }` |
| `set-phase <id> user-review-pass` | 清除顶层 `awaiting_user_review`(若本 phase),写 status=user-review-pass,再由 orchestrator set-phase completed |
| `set-phase <id> user-review-fail` | 清除顶层 `awaiting_user_review`(若本 phase),写 status=user-review-fail(终态) |
| `set-phase <id> completed` | 清除顶层 `awaiting_user_review`(若本 phase),写 status=completed,推进游标 |
| `set-phase <id> <非法来源状态>` | **FATAL**:列出合法转换表,拒绝 |

**8. `get-current-phase` 在 manual gate 期间的行为**

- phase.status === 'awaiting_user_review' → 返回 `{ number, name, isGate, gateType: 'manual', status, awaitingUserReview: true, ... }`
- orchestrator 据此判断:"当前 phase 已在 manual gate 中,等用户答复"——不调 CronCreate
- 心跳 status 保持 `active`(不是 `paused`),让 watchdog 知道进程还活着

**8.5 完整状态机总览**(B1 修复后,可作为附录)

```
[pending]
   │  set-phase in_progress
   ▼
[in_progress]
   │  set-phase executed
   ▼
[executed]
   │  set-phase audited
   ▼
[audited]
   │  set-phase fixed
   ▼
[fixed]
   │  set-phase gated
   ▼
[gated] ─── set-phase completed (auto gate 直通) ──────────────┐
   │                                                             │
   │  set-phase awaiting_user_review (manual/hybrid gate)       │
   ▼                                                             │
[awaiting_user_review]                                            │
   │  user 答复 pass                                              │
   ▼                                                             │
[user-review-pass]                                                │
   │  set-phase completed                                        │
   └────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                            [completed]  (终态)

   │  user 答复 fail
   ▼
[user-review-fail]  (终态,触发 ALERT)
```

**9. Phase Completion + Continuation**

```bash
# Update state
node scripts/phase-state.js set-phase <phaseId> completed

# Write summary (≤500 chars,Bug-10 硬约束)
# 用 heredoc 写入避免特殊字符转义问题(单/双引号、$、反引号等)
mkdir -p .phase-execution/phases/<phaseId> .phase-execution/archive
cat > .phase-execution/phases/<phaseId>/summary.md <<'SUMMARY_EOF'
<phase summary here, ≤500 chars>
SUMMARY_EOF

# Bug-10:summary.md 写完立即校验,超 500 chars → FATAL
node scripts/phase-state.js validate-summary <phaseId>

# Write heartbeat
node scripts/phase-state.js heartbeat <phaseId> "" completed

# Archive detailed logs (only logs; summary.md 留在原位供后续 turn 加载)
find .phase-execution/phases/<phaseId> -maxdepth 1 -name '*.log' -exec mv {} .phase-execution/archive/ \; 2>/dev/null || true
```

**If this was the last phase:**
- Output final report
- Display: "All {N} phases complete. Changes committed locally. Review and push manually: `git push origin <branch>`"
- Release lock: `node scripts/phase-state.js unlock --reason=all-completed` (Bug-08:必须显式 reason,见 Step 1 "Lock 持有语义")

**If more phases remain:**
- Call the **CronCreate** tool (NOT ScheduleWakeup — that requires /loop
  dynamic mode and silently fails in standard invocations. See
  `_proc-use/buginfo/atdo-schedulewakeup-tool-mismatch-2026-06-11.md`).
  CronCreate is cross-session (durable: true) and works without /loop.
  Minimum granularity is 1 minute (no 270s equivalent).

  ```bash
  # Compute target time (now + 5 min, in cron syntax)
  TARGET_EPOCH=$(( $(date +%s) + 300 ))
  TARGET_MIN=$(date -r $TARGET_EPOCH +%M)
  TARGET_HOUR=$(date -r $TARGET_EPOCH +%H)
  ```
  ```
  CronCreate(
    cron: "${TARGET_MIN} ${TARGET_HOUR} * * *",
    durable: true,           # PERSIST across session — required for non-/loop mode
    recurring: false,        # one-shot — auto-deletes after firing
    prompt: "atdo auto-resume for next pending phase.

  ── DEFENSIVE CONTEXT CHECK (do this FIRST) ──
    Verify this is an atdo context. If any of these fail, exit cleanly
    with 'atdo: not in atdo context, ignoring auto-resume' — do NOT
    execute any other actions:
      a) Read ~/.agents/skills/atdo/SKILL.md — must exist (canonical install)
      b) Read .phase-execution/state.json — must exist (active run)

  ── INSTRUCTIONS FOR THE WOKEN-UP AGENT ──
    1. Read .phase-execution/state.json. Run:
         node ~/.agents/skills/atdo/scripts/phase-state.js get-current-phase
       to determine the next pending phase.
    2. If state shows all phases 'completed' (done=true) or get-current
       returns 'done':
       - Run: bash ~/.agents/skills/atdo/scripts/watchdog.sh cleanup
       - Output: 'atdo: all phases complete, exiting auto-resume'
       - Exit cleanly
    3. Else (pending phase exists):
       - Read ~/.agents/skills/atdo/SKILL.md to load the atdo protocol
         (this is the CANONICAL source — the symlink at
         ~/.claude/skills/atdo/SKILL.md also works)
       - Follow the Execution Loop from Step 1 (Pre-flight) for the
         pending phase returned by get-current-phase
       - After completing that phase, follow SKILL.md Step 9 to
         CronCreate the next wakeup (this continues the chain)
    4. DO NOT modify state.json directly — only via phase-state.js
       commands (use the installed path ~/.agents/skills/atdo/scripts/).
    5. STALE PHASE DETECTION (before processing): if any phase has
       status 'in_progress' with updatedAt > 60min ago, the previous
       wakeup didn't complete normally. Record the anomaly by running:
         node ~/.agents/skills/atdo/scripts/phase-state.js inc-strike <phaseId> regression
       then continue with the normal flow. The 60min threshold is
       generous (avoids false positives on slow tests / large refactors);
       do not treat it as a hard failure."
  )
  ```
- The cron will fire and continue with the next phase automatically.
- If the user wants to stop the chain: `CronList` → find the entry
  → `CronDelete <id>`. The lock + state remain for manual `--resume`.
- The recurring one-shot chain self-terminates when the final phase
  completes (Step 2 above triggers cleanup + exit).

## summary.md 长度约束 (Bug-10)

> **背景**:协议多处提到 "summary.md (≤500 chars)"(Context Budget 章节 / Step 9
> 写 summary 的 heredoc 注释),但没有强制校验。`--resume` 模式下,orchestrator
> 不知道哪些 phase 的 summary.md 已写、哪些超长——本次 atdo 实际手写 summary
> 476 chars 刚好过线,纯属运气。本节**强制** 500 chars 上限,杜绝侥幸。

### 1. 硬约束

- 每个 phase 的 `summary.md` 字符数 **≤ 500 chars**(中文字符按 1 char 计,不按字节)
- 字符数统计:`Array.from(content).length`(Unicode code point 数) — P2-16 修复。emoji 😀 / 罕用汉字 = 1 char(原 `text.length` UTF-16 code unit 会把扩展平面字符算 2 chars)。与文件字节数无关,**只计字符数**
- **orchestrator 校验时机**:phase 收尾时(Step 9 写完 summary.md 后)**立即**调
  `node scripts/phase-state.js validate-summary <phaseId>` 校验
- 超 500 chars → **FATAL**,要求重写(精简);不写大文件、不留半成品
- 这是**硬约束**(区别于 Bug-11 命名规范的"软约束"——summary 超长会污染后续 turn
  的 context,影响 `--resume`,代价是 hard fail)

### 2. 建议策略(写 summary 的取舍)

**应该写(关键决策 / 状态转换)**:
- ✅ phase 完成时的关键决策(架构选型 / 拒绝的方案 / 留下的 TODO)
- ✅ 关键 commit hash(阶段产物 commit / 修复 commit)
- ✅ 状态转换节点(gate 通过 / 触发 manual gate / 失败回退原因)
- ✅ **已知遗留**:本阶段未完成的子任务 / 后续阶段要接力的钩子
- ✅ 文件级引用(修改了哪些文件、产出了哪些交付物路径)

**不应该写(避免 context 膨胀)**:
- ❌ 详细日志(execution log / audit report 内容)— **归档到 archive/**
- ❌ 代码片段(具体实现细节)— 只写文件路径,代码靠 git history
- ❌ 完整的 LLM 推理 / 工具调用过程
- ❌ 与 git commit message 重复的内容(commit message 已落盘,summary 再写一遍是浪费)
- ❌ Markdown 装饰符(过度标题 / 表格 / 嵌套列表)— 字符数是硬上限,装饰费空间

### 3. 反例 vs 正例

```
❌ 反例:超长 summary(750 chars,违反 ≤500 上限)
─────────────────────────────────────────────────
## 实施记录

### 架构决策
经过 3 轮讨论,最终选用 TypeScript + Node.js + PostgreSQL 方案,理由:
1. TS 提供类型安全,降低重构成本
2. Node 生态成熟,库丰富
3. PostgreSQL 适合关系型数据,且支持 JSONB 字段

### 代码片段
src/api/users.ts 实现核心逻辑:
```ts
async function createUser(data: UserInput): Promise<User> {
  const validated = userSchema.parse(data);
  return await db.users.insert(validated);
}
```

### 测试覆盖
- 单元测试:src/api/users.test.ts,覆盖 happy path / 边界值
- 集成测试:tests/integration/api.test.ts,验证 HTTP 端到端
- 覆盖率:核心模块 85%,边缘模块 60%

### Git commits
- feat(api): 实现 createUser
- test(api): 补充 createUser 单测
- docs(api): 更新 API 文档

### 已知遗留
- 密码强度校验待补充(下阶段)
- 邮件通知未接入(下下阶段)
─────────────────────────────────────────────────
字符数:750 — FATAL


✅ 正例:精简 summary(287 chars,远低于 500)
─────────────────────────────────────────────────
决策:TS + Node + PG(类型安全 + 生态成熟)
文件:src/api/users.ts(createUser 实现) + tests/api/users.test.ts
Commit:abc1234,def5678
Gate:Gate 1 通过(methodology=real)
遗留:密码强度校验 / 邮件通知 — 留给 Phase 03
─────────────────────────────────────────────────
字符数:287 — PASS
```

### 4. 边界场景

| 场景 | 行为 |
|------|------|
| `summary.md` 不存在 | exit code 2(提示用户先写) |
| `summary.md` 是空文件 | exit code 4(空文件,无内容可校验) |
| `summary.md` 不是 UTF-8 | exit code 3(编码错误,无法按字符计数) |
| 字符数 ≤ 500 | exit code 0,stdout: `✅ summary.md is X chars (≤500)` |
| 字符数 > 500 | exit code 1,stderr: 实际字符数 + 前 100 字符预览(辅助用户定位冗余) |

> **设计权衡**:`--resume` 模式下,orchestrator 需要快速判断"哪些 phase 已完成 / 哪些
> summary.md 存在 / 哪些超长"——validate-summary 单独命令让这个检查可程序化调用,
> 不必每次都重读 SKILL.md 找上限。

## Verification Protocol (Orchestrator-Direct)

After EVERY agent call, run these independently (not via agent):

| Check | Command | Pass Condition |
|-------|---------|---------------|
| File exists | `test -f <path>` | exit 0 |
| File non-empty | `test -s <path>` | exit 0 |
| Syntax valid | `tsc --noEmit` or equivalent | exit 0 |
| Diff range sane | `git diff --stat` | changes >0 and <10000 lines |
| No debug residue | `grep -r 'console\.log\|debugger\|TODO'` | no output |
| No secret patterns | `grep -rE 'sk-|ghp_|AKIA'` | no output |

> **13. methodology=proxy 报告不得判定 PASS(Trust Nothing 第 13 项 / Bug-05)**
>
> 仅检查"文件存在 / 语法过 / diff 范围合理 / 无 debug 残留 / 无密钥"是不够的。
> Phase 02 Gate 2 的反例(用 `sleep 0.05s` 模拟 AI 推理)显示:**bash 模拟测试在
> 文件层、语法层、diff 层、debug 层、密钥层 5 个维度上全部 PASS,但实质是
> proxy 报告冒充 PASS**。orchestrator 没有任何机制识别这一点。
>
> **强约束**:
> - 读到 `[AUTO-EXEC-RESULT: ...]` marker 中 `methodology=proxy` →
>   **必须显式标 INCONCLUSIVE**,**不允许**让 agent 报告 SUCCESS 自行走 gate
> - 输出警告: `⚠️ Gate X proxy-only, requires human sign-off or real validation`
> - 暂停 gate 流程,等待以下任一处理:
>   - (a) **人工放行**(human sign-off) — 由用户/上游显式确认接受 proxy 证据
>   - (b) agent 重跑并改为 `methodology=real` 验证(端到端真实执行)
> - 恢复 gate 流程前,必须把 state.json 中该 phase 状态回退到 `executed`
>   (而非 `gated` / `completed`),防止误标通关
> - **proxy 测试不构成 gate 通过的充分证据** — 这是协议硬约束,不是建议
>
> 适用范围: Gate Phase 任何包含 `[AUTO-EXEC-RESULT]` marker 的 agent 调用;
> 含 gsd-executor / gsd-code-reviewer / gsd-integration-checker。

## Strike (3-Strike Rule)

Three dimensions, each tracked independently:

```json
{
  "strikes": {
    "phaseRetry": {"p3": {"fix": 2, "execution": 1}},
    "regression": 0,
    "sameCategory": {"type-safety": 3}
  }
}
```

| Dimension | Threshold | Action |
|-----------|-----------|--------|
| Same phase fix-retry | ≥ 3 | ALERT.md + exit |
| Regression (fix breaks prior phase) | ≥ 2 | ALERT.md + exit |
| Same issue category cumulative | ≥ 5 | ALERT.md + exit |

Check before each fix:
```bash
node scripts/phase-state.js inc-strike <phaseId> <type>
# If output.maxed == true → write ALERT.md + release lock + exit
```

## Network Interruption Protocol

| Error | Backoff | Max Retries | On Exhaustion |
|-------|---------|-------------|---------------|
| 4xx (auth) | none | 0 | exit immediately |
| 5xx (server) | 2^n sec | 3 | continue |
| Timeout/disconnect | 5^n sec | 5 | continue |
| DNS failure | 60s fixed | 5 | continue |
| Total backoff > 30min | — | — | sleep mode, save state, prompt user to `--resume` |

## Secret Leak Prevention

1. Every Agent prompt includes: "Do NOT read .env, .pem, .key, credentials.* files. If you need env vars, reference them without revealing values."
2. After writing ANY log/report INSIDE `.phase-execution/`: `node scripts/phase-state.js sanitize <file>`
   (P1-1 路径白名单:sanitize 只允许处理 `.phase-execution/` 下的文件,防止误改系统文件)
3. After audit report generation: sanitize the report file
4. Record all sanitization events to state.json.securityEvents

## Checkpoint Protocol

> **Bug-07 修复**:此前协议列 3 个 checkpoint(解析后、Phase 开始前、首次 fix 前),
> 触发条件重叠 / 模糊:
> - 用户 `c` 同意"启动 Phase 02"后,要不要再问"Phase 02 开始前"?本次没再问,但协议没明说
> - 修小 bug 时(2/3 次 fix retry),"后续 fix"按协议**不应**再问 —
>   orchestrator 怎么知道"是不是首次 fix"?需要跟踪 fix attempt 计数
>
> 修复:采用"幂等 token + phase 进入时一次性确认"机制(simple & YAGNI),
> 比 3 个独立 checkpoint 类型少一套判断逻辑。一次性确认 = 覆盖该 phase
> 的所有子步骤(execute / audit / fix / gate)。

### 模型:Phase-scoped 一次性确认

phase 进入时一次性确认:
```
[CHECKPOINT] Phase N/M: <name> — reply 'c' to continue, 's' to skip, 'a' to abort
```

| 维度 | 规则 |
|------|------|
| **触发时机** | phase 从 `pending` 进入子流程(Step 2 Pre-flight)前一次 |
| **作用域** | 该 phase 全部子步骤:execute / audit / fix / gate |
| **幂等性** | 同一 phase 一次确认 = 覆盖其所有子步骤;不再询问 |
| **可恢复** | state.json 记录 `userConfirmations[]`,中断后 `--resume` 时已 confirmed 的 phase 不会重复询问 |
| **手动放弃** | 用户仍可主动 `s` 跳过 / `a` 终止(per phase 一次) |

### 不在 Phase-scoped 范围(其他类型 checkpoint,独立协议)

- **3-strike checkpoint**(Step 5 / 7 fix loop 失败 ≥3 次)
  → 问"继续重试 / 跳过 / 终止" — 这是另一类 checkpoint
- **Manual gate checkpoint**(Bug-06)
  → 在 `gated` → `awaiting_user_review` 后,问"pass / fail / request-changes / skip" — 独立协议
- **首次 plan 解析确认**(Step 3 freeform 解析后)
  → 解析后首次 `c` 不属于任何 phase 的 checkpoint,但同样可以写入 userConfirmations(phaseId='plan')

### fix retry 不触发 checkpoint(关键边界)

```bash
# Phase 已 confirmed(c / s / a 任一)
# 后续 fix retry / 重新审计 / 重新跑 gate
# → 不再询问 checkpoint
# 原因:该 phase 已被用户"接受",子步骤属于已确认范围
```

| 场景 | 是否触发 checkpoint |
|------|---------------------|
| Phase 进入首次 execute | ✅ 触发(phase 边界) |
| Phase 内 fix retry(attempt 2) | ❌ 不触发(已 confirmed) |
| Phase 内 fix retry(attempt 3,3-strike) | ❌ 不触发 3-strike 之前的 checkpoint,但**触发** 3-strike 自己的 checkpoint(继续重试 / 跳过 / 终止) |
| Phase 内 manual gate 入口 | ❌ 不触发 phase-scoped checkpoint,触发 manual gate checkpoint |
| `--resume` 恢复已 confirmed phase | ❌ 不再问(state.json 有记录) |
| `--resume` 恢复未 confirmed phase | ✅ 触发 phase-scoped checkpoint |

### state.json 扩展

顶层新增 `userConfirmations[]` 数组(可选,按需写入):

```jsonc
{
  "userConfirmations": [
    {
      "phaseId": "01",
      "scope": "phase-full",         // 固定值,目前只有 phase-full
      "decidedAt": "2026-06-12T10:30:00Z",
      "decision": "c"                 // c | s | a
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `phaseId` | string | 阶段 id(2 位数字字符串,如 "01" / "02") |
| `scope` | string | 固定 `"phase-full"`,覆盖该 phase 所有子步骤 |
| `decidedAt` | string | ISO 8601 时间戳 |
| `decision` | string | `c` = 继续 / `s` = 跳过 / `a` = 终止 |

**向后兼容**:旧 state.json 无 `userConfirmations` 字段时视为空数组。
phase-state.js **不在 init 时**预创建该字段(按需写入,减少 state.json 体积)。

### phase-state.js 命令

| 命令 | 行为 |
|------|------|
| `record-confirm <phaseId> <decision>` | 追加 `{phaseId, scope:"phase-full", decidedAt, decision}` 到 `userConfirmations` |
| `has-confirm <phaseId>` | exit 0 = 已确认(任意 decision) / exit 1 = 未确认 |

`record-confirm` 校验:
- `decision` 必须严格 ∈ `c | s | a`,非法值 FATAL
- `phaseId` 必须存在(state.json phases 数组中)
- 同一 phase 多次 confirm:数组累计(c → s 流转不覆盖,保留历史)

### 环境变量优先级

```bash
AUTO_PHASE_NO_CONFIRM=true   # 跳过所有 checkpoint(无人值守)
                              # 优先于 state.json 的 userConfirmations
                              # 即:即使已 confirm,设此 env 也不再询问(完全无人值守)
```

### orchestrator 使用示例

```bash
# 1. phase 进入时,检查是否已确认
if node scripts/phase-state.js has-confirm <phaseId>; then
  # 已确认 → 跳过询问,直接执行
  echo "Phase <phaseId> 已 confirm,直接执行"
else
  # 未确认 → 询问用户
  echo "[CHECKPOINT] Phase N/M: <name> — 'c' 继续 / 's' 跳过 / 'a' 终止"
  read -r REPLY
  # 记录用户决策
  node scripts/phase-state.js record-confirm <phaseId> "$REPLY"
fi

# 2. phase 内 fix retry:不再询问
# (has-confirm 已 exit 0,跳过整个询问步骤)

# 3. 3-strike / manual gate:独立 checkpoint,见各自章节
```

### 反例 vs 正例

```bash
# ❌ 反例 1:每次 phase 子步骤都询问
for step in execute audit fix gate; do
  echo "[CHECKPOINT] $step — c / s / a"
  read -r
done
# 错:重复询问,违反"一次性确认 = 覆盖该 phase 的所有子步骤"

# ❌ 反例 2:不写入 state.json,中断后 --resume 重复问
echo "[CHECKPOINT] Phase 02 — c / s / a"
read -r REPLY
# 错:state.json 没有 userConfirmations,--resume 时会再问一次

# ✅ 正例 1:phase 进入时一次性询问 + 写 state.json
if ! node scripts/phase-state.js has-confirm 02; then
  echo "[CHECKPOINT] Phase 02/M: <name> — c / s / a"
  read -r REPLY
  node scripts/phase-state.js record-confirm 02 "$REPLY"
fi

# ✅ 正例 2:fix retry 不询问
# (Step 5 fix loop 内,不再调 has-confirm / 询问)
```

## Progress Display

Before each major step, output:
```
[Auto-Phase] Phase {N}/{M}: {name} | Step {X}/{Y}: {step-description}
```

Example:
```
[Auto-Phase] Phase 3/7: User Authentication | Step 2/8: Agent execution (gsd-executor)
```

## Utilities Reference

All scripts are in the `scripts/` directory of this skill. Run from your project root:

```bash
# State management
node ~/.agents/skills/atdo/scripts/phase-state.js init    # Initialize state (reads JSON from stdin)
node ~/.agents/skills/atdo/scripts/phase-state.js get [key]               # Read state
node ~/.agents/skills/atdo/scripts/phase-state.js get-current-phase       # Get pending phase
node ~/.agents/skills/atdo/scripts/phase-state.js set-phase <id> <status> # Update phase status
node ~/.agents/skills/atdo/scripts/phase-state.js inc-strike <id> <type>  # Increment strike
node ~/.agents/skills/atdo/scripts/phase-state.js get-strikes [phaseId]  # Query strike counts
node ~/.agents/skills/atdo/scripts/phase-state.js record-commit <id> <h[,h,...]>  # Record commit hash(es),comma-separated supported
node ~/.agents/skills/atdo/scripts/phase-state.js summary                 # State summary
node ~/.agents/skills/atdo/scripts/phase-state.js validate-summary <phaseId>  # Validate summary.md length (Bug-10, ≤500 chars)

# Safety
node ~/.agents/skills/atdo/scripts/phase-state.js lock                                                      # 获取锁
node ~/.agents/skills/atdo/scripts/phase-state.js unlock --reason=all-completed|aborted|alert            # 释放锁(Bug-08)
node ~/.agents/skills/atdo/scripts/phase-state.js check-disk              # Disk space check
node ~/.agents/skills/atdo/scripts/phase-state.js sanitize <file>         # Redact secrets
node ~/.agents/skills/atdo/scripts/phase-state.js heartbeat <p> <t> <s>   # Write heartbeat

# Watchdog
bash ~/.agents/skills/atdo/scripts/watchdog.sh cleanup                    # Kill orphan agents
bash ~/.agents/skills/atdo/scripts/watchdog.sh check-heartbeat            # Check heartbeat timeout
bash ~/.agents/skills/atdo/scripts/watchdog.sh kill-stale <pid>           # Force kill stale process
```

## Final Report Template

When all phases complete, output:

```
=== atdo: Execution Complete ===

Phases completed: {completed}/{total}
Total commits: {commitCount}
Gate checks passed: {gateCount}
Strikes: {strikeSummary}
Security events: {securityEventCount}

Phase summary:
{phaseNumber}. {phaseName} — {status} ({commitHash})

All changes committed locally.
To push: git push origin <branch>

Reports: .phase-execution/
```
