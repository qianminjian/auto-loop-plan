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

## Arguments

| Argument | Effect |
|----------|--------|
| `<plan-file>` | Path to project plan (any format) |
| `--from N` | Start from phase N |
| `--to N` | Stop after phase N |
| `--only N` | Execute only phase N |
| `--resume` | Resume from `.phase-execution/state.json` |
| `--dry-run` | Parse plan, show phases, don't execute |
| `--no-audit` | Skip audit step (fast mode) |
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

### Step 3: Plan Parsing (Three-Tier)

**Tier 1 — Known format**: If `.planning/ROADMAP.md` exists, use `gsd-tools query roadmap.analyze`.

**Tier 2 — Structured format**: If JSON/YAML with `phases[]`, parse directly.

**Tier 3 — Freeform Markdown**: LLM-based extraction. Look for:
- Headers matching `## Phase N:` or `### Phase N:`
- Numbered sections `1.`, `2.` etc.
- Checkbox lists `- [ ]` as tasks
- Keywords "depends on", "gate", "关口" for gate detection

**CRITICAL**: After freeform parsing, MUST show extracted phases at a checkpoint. Do NOT silently execute.

**Failure handling**: If parsing fails → ALERT.md + exit. Never guess.

**Dependency validation**: Build directed graph, topological sort. Cycle detected → ALERT.md + exit.

**Oversized phase detection**: If any phase has >15 tasks → warn, suggest splitting.

### Step 4: State Initialization
```bash
echo '<json>' | node scripts/phase-state.js init
```

## state.json Schema

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

Spawn gsd-code-reviewer agent:
```
<<INJECT: copy the verbatim PROCESS_FILE_POLICY code block from Core Rules>>
────────────────────────────────────────
(以下是审计任务)

Review all files changed in phase {N}. Check: lint, syntax, diff scope, debug residue, hardcoded secrets.
Write structured report to .phase-execution/phases/{N}/audit-report.md
(NOTE: atdo runtime report path — exempt from the _proc-use/ rule above).
Use the template at ~/.agents/skills/atdo/references/templates/audit-report-template.md.

Output at end: [AUTO-EXEC-RESULT: status=SUCCESS|FAILED, blockers=<count>, warnings=<count>]
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

Output: [AUTO-EXEC-RESULT: status=SUCCESS|FAILED, fixes_applied=<count>, files_changed=<count>]
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

Output: [AUTO-EXEC-RESULT: status=SUCCESS|FAILED, integration_errors=<count>]
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

**9. 完整状态机总览**(B1 修复后,可作为附录)

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

# Write summary (≤500 chars)
# 用 heredoc 写入避免特殊字符转义问题(单/双引号、$、反引号等)
mkdir -p .phase-execution/phases/<phaseId> .phase-execution/archive
cat > .phase-execution/phases/<phaseId>/summary.md <<'SUMMARY_EOF'
<phase summary here, ≤500 chars>
SUMMARY_EOF

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

At these points, pause and display:
```
[CHECKPOINT] <description>
Reply: 'c' = continue | 's' = skip | 'a' = abort
```

Checkpoints:
1. After plan parsing, before first execution
2. Before each phase starts
3. Before first fix attempt (not before retries)

Skip all checkpoints when `AUTO_PHASE_NO_CONFIRM=true`.

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
