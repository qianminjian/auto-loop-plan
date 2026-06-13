# Auto-Phase-Executor: Code Audit Report

**Audit Date:** 2026-06-11
**Auditor:** Claude (manual adversarial review)
**Files Reviewed:** 5
**Status:** issues_found (6 blockers auto-fixed, 3 critical auto-fixed, 11 warnings, 8 info)

---

## Summary

Adversarial review of the auto-phase-executor skill (SKILL.md, phase-state.js, watchdog.sh, 2 templates). Found 6 BLOCKER bugs (all auto-fixed), 3 CRITICAL issues (all auto-fixed), 11 WARNING items, and 8 INFO items. The skill is architecturally sound but had significant correctness gaps in crash recovery, cross-platform compatibility, atomic write guarantees, and strike tracking completeness.

---

## BLOCKER Issues (Auto-Fixed)

### BL-01: watchdog.sh invoked with wrong interpreter

**File:** `~/.agents/skills/auto-phase-executor/SKILL.md:55`
**Issue:** `node scripts/watchdog.sh cleanup` tries to execute a bash script with Node.js. This will fail with a syntax error at runtime.
**Fix applied:** Changed to `bash scripts/watchdog.sh cleanup`.

### BL-02: getCurrentPhase cannot find crashed phases — breaks resume

**File:** `~/.agents/skills/auto-phase-executor/scripts/phase-state.js:275`
**Issue:** The execution flow sets phases to intermediate statuses (`executed`, `audited`, `fixed`, `gated`) before `completed`, but `getCurrentPhase` only searched for `pending` or `in_progress`. If the orchestrator crashes mid-turn (e.g., after agent execution but before completion), the next turn would return `done: true` and exit prematurely — all remaining phases would be lost.
**Fix applied:** Added `executed`, `audited`, `fixed`, `gated` to the active statuses search list in both `cmdGetCurrentPhase` and `cmdSummary`. Added proper `if (!phase)` guard that was missing from the broken code.

### BL-03: Orphan cleanup misses processes adopted by init

**File:** `~/.agents/skills/auto-phase-executor/scripts/watchdog.sh:31`
**Issue:** The `cleanup_orphans` function skips processes whose parent PID is 1 (`[ "$ppid" != "1" ]`). When the orchestrator parent dies, child processes are adopted by init (ppid=1), leaving them running indefinitely. Both the agent orphan loop (line 31) and node orphan loop (line 49) had this bug.
**Fix applied:** Changed condition to `[ "$ppid" = "1" ] || ! kill -0 "$ppid"` — kills orphans whether they were adopted by init or have a non-existent parent.

### BL-04: atomicWrite opens file in read-only mode before fsync

**File:** `~/.agents/skills/auto-phase-executor/scripts/phase-state.js:56`
**Issue:** `fs.openSync(TMP_FILE, 'r')` opens the temp file in read-only mode, then `fsyncSync` is called. On POSIX systems, `fsync` on a read-only file descriptor is either a no-op or returns an error — the data written by `writeFileSync` may not be flushed to disk before the `rename`. This defeats the atomic write guarantee entirely.
**Fix applied:** Changed to `fs.openSync(TMP_FILE, 'r+')` (read+write mode) which allows `fsync` to properly flush the buffer.

### BL-05: Stale lock detection broken on macOS (uses /proc)

**File:** `~/.agents/skills/auto-phase-executor/scripts/phase-state.js:131`
**Issue:** `fs.readFileSync('/proc/${lock.pid}/cmdline')` accesses the Linux `/proc` filesystem, which does not exist on macOS. The `catch {}` silently swallows the `ENOENT` error. On macOS this means:
- If a lock PID is alive with matching hostname → `/proc` check fails silently → falls through → lock is overwritten (treated as stale) → concurrent execution allowed.
- Two instances can silently overwrite each other's locks on macOS.
**Fix applied:** Replaced with cross-platform `ps -o comm= -p ${lock.pid}` via `execSync`. Works on both macOS and Linux.

### BL-06: inc-strike doesn't track all three strike dimensions

**File:** `~/.agents/skills/auto-phase-executor/scripts/phase-state.js:307-315`
**Issue:** SKILL.md defines three strike dimensions: phase retry (>=3), regression (>=2), sameCategory cumulative (>=5). But `cmdIncStrike` only checked `phaseRetry[phaseId][type] >= 3`. The `regression` and `sameCategory` counters were never checked, so the orchestrator could silently exceed those thresholds.
**Fix applied:** Added `maxedRegression` (>=2) and `maxedCategory` (>=5) checks. The output now includes all three booleans so the orchestrator can react to any dimension being maxed.

---

## CRITICAL Issues (Auto-Fixed)

### CR-01: Disk space check returns ok:true on failure

**File:** `~/.agents/skills/auto-phase-executor/scripts/phase-state.js:167`
**Issue:** The `checkDisk` catch block returned `{ ok: true, note: '...' }` when the `df` command failed. The orchestrator would see `ok: true` and proceed even if disk space couldn't be verified — exactly when the check is most important.
**Fix applied:** Changed to `{ ok: false, ... }` with the error message included.

### CR-02: watchdog.sh uses macOS-only date -j with no Linux fallback

**File:** `~/.agents/skills/auto-phase-executor/scripts/watchdog.sh:77`
**Issue:** The heartbeat time parser used `date -j -f` (macOS-only) as the primary method, with `node -e` as a fallback. The `date -j` produces confusing stderr on Linux. More critically, the watch order was wrong — it tried platform-specific before cross-platform.
**Fix applied:** Reordered to try `node -e` first (works everywhere), then fall back to `date -j` (macOS) or `date -d` (Linux).

### CR-03: Verification grep commands scan entire filesystem tree

**File:** `~/.agents/skills/auto-phase-executor/SKILL.md:144-148`
**Issue:** Both the debug residue scan and secret format scan ran `grep -r` on `.` without excluding `.git/` or `node_modules/`. The debug residue scan also lacked the `-E` flag, making `\|` alternation behave as literal characters in basic regex.
**Fix applied:** Added `--exclude-dir='.git' --exclude-dir='node_modules'` to both commands. Added `-E` flag to the debug residue scan for proper extended regex.

---

## WARNING Issues

### WR-01: Phase status lifecycle missing in_progress transition

**File:** `~/.agents/skills/auto-phase-executor/SKILL.md:130`
**Issue:** The execution flow transitions `pending → executed` without ever setting `in_progress`. The `set-phase` command only records `startedAt` for `in_progress` status, meaning phases will always have `startedAt: null`. Add a `set-phase <id> in_progress` step at the start of the execution protocol.

### WR-02: isGate logic conflates explicit false with undefined

**File:** `~/.agents/skills/auto-phase-executor/scripts/phase-state.js:205`
**Issue:** The original code `p.is_gate || p.gate || false` uses `||` which treats both `false` and `undefined` identically. If someone sets `is_gate: false, gate: true`, the result is `true` instead of the explicitly requested `false`.
**Fix applied:** Changed to ternary: `p.is_gate !== undefined ? p.is_gate : (p.gate !== undefined ? p.gate : false)`. This respects explicit `false` values.

### WR-03: Shared TMP_FILE risks concurrent corruption

**File:** `~/.agents/skills/auto-phase-executor/scripts/phase-state.js:29`
**Issue:** `TMP_FILE` is a single shared path (`.phase-execution/state.json.tmp`). While the lock should prevent concurrent access, if the lock mechanism fails (e.g., on macOS as described in BL-05), two atomic writes could interleave on the same temp file. Should use a unique temp filename per write (e.g., append PID or random suffix).

### WR-04: Gate test placeholder unfilled

**File:** `~/.agents/skills/auto-phase-executor/SKILL.md:218`
**Issue:** `npx jest --findRelatedTests <changed-files>` is a placeholder. The orchestrator must generate the actual changed-files list from `git diff --name-only` against the baseline commit, but this step is not specified.

### WR-05: Phase summary write unsafe

**File:** `~/.agents/skills/auto-phase-executor/SKILL.md:250`
**Issue:** `echo "<phase summary>" > .phase-execution/phases/<phaseId>/summary.md` assumes the per-phase directory exists. Neither the `init` command nor the execution flow creates `phases/<N>/` subdirectories. Special characters in the summary could break the echo command.

### WR-06: Archive directory may not exist

**File:** `~/.agents/skills/auto-phase-executor/SKILL.md:256`
**Issue:** `mv ... .phase-execution/archive/` assumes the archive directory exists, but it's never created. The `2>/dev/null || true` silently discards the error.

### WR-07: Orphan detection pattern too broad

**File:** `~/.agents/skills/auto-phase-executor/scripts/watchdog.sh:44`
**Issue:** `pgrep -f "node.*claude"` matches any process whose command line contains "node" followed by "claude" anywhere. This could match `node /path/to/claude-wrapper.js` or `node some-app --claude-mode`, potentially terminating unrelated processes.

### WR-08: Gate detection too simplistic

**File:** `~/.agents/skills/auto-phase-executor/SKILL.md:191`
**Issue:** "Every 2nd phase" heuristic marks phases 2, 4, 6... as gates. If a project has 7 phases, phase 7 (the final deliverable) is never gate-tested. A project with 3 phases would only test phase 2. The final phase should always be treated as a gate.

### WR-09: ScheduleWakeup mechanism undefined

**File:** `~/.agents/skills/auto-phase-executor/SKILL.md:265`
**Issue:** The core orchestration loop depends on ScheduleWakeup to trigger the next turn, but the mechanism is never defined. What tool/API does it use? How does it pass the resume prompt? This is an architectural gap that prevents automated execution.

### WR-10: Empty phase list silently accepted

**File:** `~/.agents/skills/auto-phase-executor/scripts/phase-state.js:198`
**Issue:** If `plan.phases` is empty or not an array, `init` creates a state with zero phases and outputs `{ phases: 0 }`. The orchestrator would proceed with an empty execution. Should warn or return an error for zero phases.

### WR-11: Plan JSON passed as shell argument risks escaping issues

**File:** `~/.agents/skills/auto-phase-executor/SKILL.md:94`
**Issue:** `node scripts/phase-state.js init '<json>'` passes the plan JSON as a shell argument. If the JSON contains single quotes, the shell quoting breaks. Should pipe via stdin or write to a temp file first.

---

## INFO Items

### IN-01: Template syntax requires rendering engine

**File:** `~/.agents/skills/auto-phase-executor/templates/*.md`
**Issue:** Templates use `{{placeholder}}`, `{{#each}}`, `{{#if}}` Handlebars/Mustache syntax, but no template renderer is included. The SKILL.md instructs agents to "Use the template," implying the LLM fills in values. This is workable but fragile — a programmatic renderer would be more reliable.

### IN-02: Heartbeat command produces no output

**File:** `~/.agents/skills/auto-phase-executor/scripts/phase-state.js:381`
**Issue:** The `heartbeat` command writes to disk but produces no stdout output. The orchestrator cannot programmatically verify the heartbeat was written successfully. Should output `{ ok: true }` like other commands.

### IN-03: Corrupt heartbeat file returns no-alarm

**File:** `~/.agents/skills/auto-phase-executor/scripts/watchdog.sh:73`
**Issue:** `check_heartbeat` returns 0 (no alarm) when the heartbeat file exists but contains invalid JSON. A corrupt heartbeat could mean the orchestrator crashed mid-write, which should trigger an alarm, not a pass.

### IN-04: Inconsistent script path references

**File:** `~/.agents/skills/auto-phase-executor/SKILL.md:55,56,94,353-375`
**Issue:** The startup sequence uses `scripts/phase-state.js` (relative path), while the Utilities Reference section (line 353) says "All in `~/.agents/skills/auto-phase-executor/scripts/`" but shows commands without any path prefix. The orchestrator must resolve the correct path, which is ambiguous.

### IN-05: No commit hash validation

**File:** `~/.agents/skills/auto-phase-executor/scripts/phase-state.js:331`
**Issue:** `cmdRecordCommit` accepts any string as a commit hash without validation. An empty string or invalid hash would be stored without error.

### IN-06: set-phase only timestamps in_progress and completed

**File:** `~/.agents/skills/auto-phase-executor/scripts/phase-state.js:266-267`
**Issue:** The `set-phase` command only sets `startedAt` for `in_progress` status and `completedAt` for `completed` status. Since the execution flow never uses `in_progress`, `startedAt` is always null. Other status transitions (`executed`, `audited`, `fixed`, `gated`) also go unrecorded.

### IN-07: Agent output marker uses ambiguous format

**File:** `~/.agents/skills/auto-phase-executor/SKILL.md:123`
**Issue:** The `[AUTO-EXEC-RESULT: ...]` marker is parsed by LLM pattern matching, not programmatically. If the agent outputs the marker inside a code block or with extra whitespace, the orchestrator might miss it and trigger an unnecessary retry.

### IN-08: Gate fix loop copies phase fix loop but has different semantics

**File:** `~/.agents/skills/auto-phase-executor/SKILL.md:207`
**Issue:** The gate fix loop references "same as step 5, max 3" but step 5's attempt 3 action is `git checkout -- <files>` (code rollback). For integration test failures, rolling back code makes no sense — you'd want to fix the integration layer, not discard the phase implementation.

---

## Files Modified (Auto-Fix)

| File | Lines Changed | Fixes Applied |
|------|--------------|---------------|
| `SKILL.md` | 55, 145, 148 | BL-01, CR-03 |
| `phase-state.js` | 56, 131, 167, 205, 273-292, 307-315, 363-364 | BL-02, BL-04, BL-05, BL-06, CR-01, WR-02 |
| `watchdog.sh` | 31, 49, 77-86 | BL-03, CR-02 |
| `templates/audit-report-template.md` | — | No logic changes needed |
| `templates/integration-test-report-template.md` | — | No logic changes needed |

---

_Reviewed: 2026-06-11_
_Auditor: Claude (adversarial manual review)_
_Depth: deep_
_Total findings: 28 (6 blockers, 3 critical, 11 warnings, 8 info)_
_Files fixed: 3_
