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
After each phase: persist state → ScheduleWakeup → next turn continues.

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

## Execution Loop (ONE PHASE PER TURN)

After startup, find the first phase with status `pending` or `in_progress`. Process exactly ONE phase, then persist and exit via ScheduleWakeup.

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
Review all files changed in phase {N}. Check: lint, syntax, diff scope, debug residue, hardcoded secrets.
Write structured report to .phase-execution/phases/{N}/audit-report.md.
Use the template at ~/.agents/skills/atdo/references/templates/audit-report-template.md.

Output at end: [AUTO-EXEC-RESULT: status=SUCCESS|FAILED, blockers=<count>, warnings=<count>]
```

After agent returns:
- Run sanitize on audit report: `node scripts/phase-state.js sanitize .phase-execution/phases/{N}/audit-report.md`
- Update state: `executed → audited`

**5. Fix Loop** (max 3 attempts)

For each BLOCKER in audit-report:
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
Verify cross-phase integration for phases {1} through {N}.
Check: exports connect to imports, APIs have consumers, data flows end-to-end.
Write report to .phase-execution/gates/gate-{label}/integration-test-report.md.
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
node scripts/phase-state.js record-commit <phaseId> <commit-hash>
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
- Call the ScheduleWakeup tool to schedule the next turn:
  ```
  ScheduleWakeup(
    delaySeconds: 270,     // stay within 5-min cache window
    reason: "next phase auto-resume",
    prompt: "Resume atdo. Read .phase-execution/state.json. Continue from first phase with status 'pending'. Follow the execution loop protocol."
  )
  ```
- The wakeup will fire and continue with the next phase automatically.
- If you need longer delays (e.g., waiting for external CI), use up to 3600s, but prefer 270s to keep the prompt cache warm.

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
node ~/.agents/skills/atdo/scripts/phase-state.js record-commit <id> <h>  # Record commit hash
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
