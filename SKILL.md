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
[AUTO-EXEC-RESULT: status=SUCCESS|FAILED, files=<count>, tasks_done=<count>, errors=<count>]
```

After agent returns:
- Parse for `[AUTO-EXEC-RESULT: ...]` marker
- **Marker parsing rules**: Search the ENTIRE agent output for the marker line — it may appear inside code blocks, with leading/trailing whitespace, or after other content. Use: `grep -oP '\[AUTO-EXEC-RESULT:.*?\]'` or equivalent pattern match. If the agent output contains multiple markers (e.g., from restarted sub-agents), use the LAST one.
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

**8. Git Commit** (gate phases only, after all checks pass)

```bash
# Security check(覆盖 .env.local / config/.env / id_rsa 等变体,锚定到路径末尾)
# 原 P0:'\.env$' 只匹配字面 .env,会漏掉 .env.local / .env.production / config/.env
#      'credentials' 无锚定,会误中;id_rsa 无扩展名需单独加
#      'secrets?' / 'credentials?' 覆盖单/复数;均锚定到路径末尾避免误中
# 白名单:.env.example/sample/template/dist/default 是约定俗成的模板文件,应允许 commit
git diff --name-only | grep -iE '(\.env(\.[^/]+)?$|\.pem$|\.key$|id_rsa$|id_dsa$|id_ed25519$|credentials?\.[^/]+$|secrets?\.[^/]+$)' | grep -viE '\.env\.(example|sample|template|dist|default)$' && echo "SECURITY: sensitive file in diff" && exit 1

# Precise add (NOT git add -A)
git add <list of expected changed files>

# Commit
git commit -m "auto-phase: Phase {N} complete [gate:{label}] [audit:passed]"

# Record
# Bug-03: 支持单 hash 也支持 comma-separated 多 hash(agent 一次产 N 个 commit 场景)
#   例子:node scripts/phase-state.js record-commit 01 32db291,3c79edb,078de4c
#   - hash 之间用英文逗号分隔,逗号周围的空格会被自动 trim
#   - 任一 hash 无效 / 末尾悬空逗号 / 列表为空 → FATAL,不部分写入
node scripts/phase-state.js record-commit <phaseId> <hash[,hash,...]>
```

Commit failure handling:
- pre-commit hook rejection → fix hook-reported issues, retry once
- merge conflict → ALERT.md + exit (do NOT auto-resolve)
- other errors → ALERT.md + exit

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
- Release lock: `node scripts/phase-state.js unlock`

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
node ~/.agents/skills/atdo/scripts/phase-state.js lock / unlock           # Concurrency control
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
