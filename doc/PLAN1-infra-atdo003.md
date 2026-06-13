# atdo Plan 1: 基础设施 + atdo-003 P1 修复

> **本 Plan 范围（v2，审计后修订）**：拆为 2 个 Plan，本次仅做 **Stage A 基础设施 + Stage B atdo-003 P1**。atdo-001 / 002 / 004 + 完整 CI/Review 流程移到 **Plan 2**（待 Plan 1 完成且 GitHub Actions 全绿后再开）。
>
> **位置**：本文件是 plan 的项目内最终落地版（与项目同生命周期、可 git 跟踪）。Plan Mode 工具临时草稿在 `~/.claude/plans/floofy-singing-adleman.md`，需用户批准后删除。

---

## Context

### 为什么做这次

- atdo-003 **P1**：methodology=proxy 报告的 Gate 标准恢复流程缺失 — orchestrator 每次靠即兴判断（Bug-05 协议未给具体操作序列）
- 项目零 CI 基础设施 — 修 bug 同时建立最小可用 CI 闭环（test + markdown-lint），后续 bug 修复都依赖 CI 验证
- 项目无设计明灯文件（违反全局规则 §3.1）— 同步建立 `doc/BEACON.md`

### 审计结论已纳入

本 plan 是审计后第 2 版，已纳入 15 个 finding 中影响本 Plan 范围的 9 个：

| Finding | 修订 |
|---|---|
| **F1 [P0]** `proxy-recovery-decision` 必须强制 evidence 参数（防 LLM 偷懒触发"agent 自报告 auto-pass"违反 Bug-05） | 命令接受 `--evidence=<path>` JSON 文件，校验 5 维全 PASS |
| **F2 [P0]** atdo.test.js 怎么进 CI（撤销 commit 6dedf88 取消追踪决策） | 用户裁决：保留原位 + .gitignore 加例外 |
| **F7 [P2]** v3.2 误导稿删除触发红线 1 | 改 `git mv` 重命名为 `*.v3.2-DEPRECATED.md` 加 archive 头部 |
| **F8 [P1]** Stage A3 CI 骨架是 hard gate | A3 必须在 GitHub Actions 实跑全绿才能进 Stage B |
| **F10 [P1]** markdown-lint 中文文档兼容性未验证 | A3 前在本地试跑确认现有文档可通过 |
| **F12 [P2]** 协议层 TDD 弱保障 | atdo-003 加 e2e protocol fixture test |
| **F13 [P3]** 测试覆盖率估算偏低 | 11 tests for atdo-003（≥10/bug 保守估） |
| **F14 [P1]** 单 plan 体量大 | 用户裁决：拆为 2 个 plan，本次仅 Stage A + B |
| **F15 [P3]** Plan 持久化反复 | 接受工具限制，每次 plan mode 第一动作是同步到 `doc/` |

剩余 finding（F3 / F4 / F5 / F9 / F11 / F6 是 F2 的复制）全部移到 Plan 2。

### 关键发现（来自 Phase 1 调研）

- **proxy 协议三处**（SKILL.md L682 / L1058 / L1399）— 均已定义"不通过"原则；Bug-05 的合规口子是 **orchestrator-direct real validation**，不是 agent 自称安全（F1 核心）
- **commit 6dedf88 原意**："_proc-use/ 已在 .gitignore 中,此文件为早期误提交。本地保留不删除。" — 撤销此决策需用户明确批准（已批准）
- **状态机权威表 `ALLOWED_TRANSITIONS`**（phase-state.js L69-83）— atdo-003 无需扩展，仅新增"决策记录"层（state.phases[N].proxyRecovery）

---

## 设计原则

1. **TDD 严格 Red → Green → Refactor**：先写 fail 测试，再写最少实现
2. **协议-代码-测试三方一致**：SKILL.md 章节 + phase-state.js 命令 + atdo.test.js 测试 三同步
3. **不引入 npm 依赖**：仅 Node.js 内置 + GitHub Actions 官方/主流 action
4. **CI hard gate**：A3 不全绿不进 Stage B（不建沙滩楼阁）
5. **单文件原子 commit**：每 commit 解决一个 finding，符合 Angular convention
6. **不删除文件**：所有"废弃"文件用 `git mv` 改名归档（红线 1 友好）

---

## Stage A：基础设施（3 commits）

### A1 `feat(design): 建立 doc/ + BEACON.md + 归档 v3.2 误导稿`

**动作**：
1. 创建 `doc/BEACON.md`（≤ 80 行，按全局规则 §3.1 模板）
   - 目标：atdo v2.0.1 是少数能在零依赖纯 Node + 282 测试 100% 通过约束下达 S 级（97/100）的 orchestration skill
   - 范围：做 = Skill 主体 + Node 状态机 + 内置测试 + GH Actions CI；不做 = 引入 npm 依赖 / 修改外部目标项目
   - 设计决策：D1 单 turn 单阶段 / D2 Trust Nothing / D3 零依赖 / D4 atomic write + 4 级 backup
   - 当前状态：Plan 1 执行中（atdo-003 + 基础设施）
   - 引用：`@doc/PLAN1-infra-atdo003.md` / `@doc/DESIGN.md`
2. 同步本 plan 到 `doc/PLAN1-infra-atdo003.md`（已完成）
3. 创建 `doc/PLAN2-bug-001-002-004-ci-review.md` 占位文件（已完成）
4. 本地归档 v3.2 误导稿：`mv _proc-use/docs/README.md doc/archive/README.v3.2-DEPRECATED.md`（用户决策 D6：设计文档统一到根目录 doc/，gitignored 文件改名后进入 git 跟踪的 doc/archive/）
5. 在归档文件顶部插入 archive 头：
   ```markdown
   > **⚠️ DEPRECATED**：此文件描述被废弃的 v3.2 (auto-loop-plan bash 多文件方案)，与当前 atdo v2.0.1 (Skill + Node 状态机) **完全不符**。仅作历史参考。
   > 当前权威文档：根目录 README.md + SKILL.md。
   ```
6. 修复 README.md L186-188 死链（原指向 `_proc-use/docs/README.md` gitignored 文件）→ 改为指向 `doc/BEACON.md` + `doc/DESIGN.md`

**Commit**: 单个原子 commit（含上述 6 个动作）

### A2 `chore(git): _proc-use/ 恢复 git 跟踪 + push GitHub 排除机制`

**前置决策**（用户裁决）：撤销之前在 .gitignore 复杂例外上的折腾，**简化为**：
- `_proc-use/` 整体进 git 本地跟踪（撤销 commit 6dedf88）
- push GitHub 时由专门脚本 `scripts/push-public.sh` 剥离
- 不重写历史：6dedf88 保留，新 commit 通过 .gitignore + add 撤销其逻辑效果

**为什么简化**：原 A2 方案设计复杂 4 行例外（`_proc-use/*` + `!_proc-use/reports/` + `_proc-use/reports/*` + `!atdo.test.js`），易踩坑（A1 已踩过一次），且只放单文件进 git 是本末倒置——更好的做法是 _proc-use/ 全跟踪 + push 时剥离。

**动作**（4 步）：

#### 1. 修改 `.gitignore`：去掉 `_proc-use/` 整体排除
```gitignore
# ── 过程材料：本地 git 跟踪（push GitHub 时由专门机制排除）──
#   _proc-use/buginfo/  Bug 报告
#   _proc-use/dev/      安装/卸载脚本
#   _proc-use/reports/  审计/测试报告（含 atdo.test.js）
#   注：_proc-use/ 进 git 历史记录完整保留；推 GitHub 由独立 push 脚本/hook 剥离
#   注：项目设计文档统一在根目录 doc/（结果性文档，对外可见）
```

#### 2. 创建 `scripts/push-public.sh`（A=方案1：临时分支模式）
脚本逻辑：
- 前置检查：当前在 main / 工作区干净 / remote 存在
- 创建临时分支 `public-push-<ts>` from main
- `git rm -rf --cached _proc-use/` 剥离 index
- `git commit --amend` 加 release 标记
- `git push <remote> <temp>:<branch>` 推目标分支
- 切回 main + 删临时分支 + ERR trap 确保异常恢复
- 本地 _proc-use/ 物理文件不动

#### 3. `git add` _proc-use/ 全部 + 脚本 + .gitignore + README
```bash
git add .gitignore _proc-use/buginfo/ _proc-use/dev/ _proc-use/reports/ scripts/push-public.sh README.md doc/PLAN1-infra-atdo003.md
```

#### 4. README 测试章节加 push 约定
在 `## 测试状态` 章节后加：
```markdown
## 推送到 GitHub

`_proc-use/` 进 git 本地跟踪但不对外。推 GitHub 用专门脚本剥离 _proc-use/：
\`\`\`bash
bash scripts/push-public.sh                # push origin main，剥离 _proc-use/
bash scripts/push-public.sh origin develop # 自定义 remote/branch
\`\`\`
直接 `git push` 会带 _proc-use/，**不要直接 push 到对外 remote**。
```

**Commit message**：
```
chore(git): _proc-use/ 恢复 git 跟踪 + push GitHub 排除机制

- .gitignore 去掉 _proc-use/ 整体排除（撤销 6dedf88，不重写历史）
- _proc-use/ 14 文件进 git：buginfo (4) + dev (2) + reports (8 含 atdo.test.js)
- 新增 scripts/push-public.sh：push 时用临时分支剥离 _proc-use/
- README 加 push 约定（直接 git push 会带 _proc-use/，必须用脚本）
- 撤销原 A2 复杂 gitignore 例外方案（不再本末倒置）

仓库影响：本地 git +356K（_proc-use/ 全跟踪）；GitHub 通过 push 脚本剥离
原因（用户裁决）：避免在 .gitignore 上反复折腾，简化为常规追踪 + push 隔离
```

**验证**：
- `git ls-files _proc-use/ | wc -l` → 14
- `bash scripts/push-public.sh --help` → 显示用法（脚本可执行）
- `git status --porcelain | grep -v .serena` → 空

**不做**：
- ❌ 不 git revert / reset / rebase 6dedf88（历史完整保留）
- ❌ 不实现 pre-push hook（推迟到 Plan 2 / 出现误推时再加）
- ❌ 不动 atdo.test.js 内容（仅恢复跟踪）


### A3 `ci: GitHub Actions 骨架（test + markdown-lint）— hard gate`

**Hard prerequisite**：本 commit 完成后，GitHub Actions 必须实跑全绿才能进入 Stage B。任何 job 红 → 修复后重推，不进 Stage B。

**前置本地验证（A3 commit 前必跑）**：
```bash
# 在本地用 npx 试跑 markdownlint，不修改 package.json 不全局 install
npx --yes markdownlint-cli2 README.md SKILL.md doc/BEACON.md
```
- 全绿 → 用默认 `.markdownlint.json`（仅放宽 `MD013 line-length: false` / `MD033 no-inline-html: false` / `MD041 first-line-h1: false`）
- 报错 → 根据报错动态调 `.markdownlint.json` 直到通过

**动作**：
1. 创建 `.markdownlint.json`（经本地验证后定型）
2. 创建 `.github/workflows/ci.yml`：
   ```yaml
   name: CI
   on:
     push:
       branches: [main, 'feat/**', 'fix/**']
     pull_request:
       branches: [main]
   jobs:
     test:
       runs-on: ubuntu-latest
       strategy:
         matrix:
           node-version: [20, 22]
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: ${{ matrix.node-version }}
         - name: Run atdo tests
           run: node _proc-use/reports/atdo.test.js
     markdown-lint:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: DavidAnson/markdownlint-cli2-action@v16
           with:
             globs: 'README.md SKILL.md doc/*.md'
   ```
3. README.md 加 CI badge：
   ```markdown
   [![CI](https://github.com/<user>/auto-loop-plan/actions/workflows/ci.yml/badge.svg)](https://github.com/<user>/auto-loop-plan/actions/workflows/ci.yml)
   ```
   （`<user>` 待用户提供 GitHub username，本 commit 用占位符）

**用户动作（A3 commit 后）**：
- 用户 push 到 GitHub（**红线**：不由 agent 主动 push）
- 用户在 GitHub Actions 页面确认 2 个 job 全绿
- 全绿后告知 agent："A3 verified green，进入 Stage B"

**Commit**: 单个原子 commit

---

## Stage B：atdo-003 P1 修复（3 commits）

### B1 `test(state): atdo-003 proxy-recovery-decision Red`

在 `_proc-use/reports/atdo.test.js` 新增 `describe('atdo-003 proxy-recovery-decision')` 含 **11 个 test**（F1 + F12 + F13 修订后清单）：

| # | test 名 | 验证 |
|---|---|---|
| 1 | `verdict=auto-pass 不带 --evidence → die` | F1 核心：防 LLM 偷懒触发 agent 自报告 auto-pass |
| 2 | `verdict=auto-pass --evidence 文件不存在 → die` | F1 evidence 完整性 |
| 3 | `verdict=auto-pass --evidence 非 JSON → die` | evidence 格式校验 |
| 4 | `verdict=auto-pass --evidence 缺 5 维任一 → die` | evidence 完整性 |
| 5 | `verdict=auto-pass --evidence 任一维度 != "PASS" → die` | F1 核心：5 维必须全 PASS |
| 6 | `verdict=auto-pass --evidence 5 维全 PASS → 写 state.phases[N].proxyRecovery` | Green path |
| 7 | `verdict=manual-required 不需 evidence → 写 state.phases[N].proxyRecovery` | manual 路径 |
| 8 | `verdict 非法值（如 "skip"）→ die` | 白名单校验 |
| 9 | `幂等: 同 phase 同 verdict 重复调用 → exit 0 不重复写`（at 字段不变） | 幂等性 |
| 10 | `reason 超 200 chars → die` | 长度校验（沿用现有 cmdInit 阈值规范） |
| 11 | `e2e: 模拟 orchestrator 跑 5 维生成 evidence.json → 调命令 → 验 state shape` | F12 协议 fixture |

**全部 11 个 test 在 B1 commit 后必须 fail**（因为 cmdProxyRecoveryDecision 还不存在）。验证：
```bash
node _proc-use/reports/atdo.test.js 2>&1 | grep "atdo-003" | grep -E "fail|not ok"
# 期望: 11 个 fail
```

**Commit**: 单个原子 commit（仅 atdo.test.js 改动）

### B2 `fix(state): atdo-003 实现 proxy-recovery-decision + SKILL.md Proxy Recovery 章节`

**phase-state.js 改动**:
1. 新增常量：
   ```js
   const PROXY_VERDICTS = ['auto-pass', 'manual-required'];
   const REQUIRED_EVIDENCE_DIMENSIONS = ['fileExistence', 'syntax', 'diffRange', 'debugResidue', 'secretScan'];
   const PROXY_REASON_MAX_CHARS = 200;
   ```
2. 新增 `cmdProxyRecoveryDecision()`（~60 行），核心逻辑：
   ```js
   function cmdProxyRecoveryDecision() {
     const [phaseId, verdict, ...flags] = process.argv.slice(3);
     if (!PROXY_VERDICTS.includes(verdict)) die(`verdict 必须是 ${PROXY_VERDICTS.join('|')}`);
     const reason = parseFlag(flags, '--reason') || '';
     if (reason.length > PROXY_REASON_MAX_CHARS) die(`reason 超 ${PROXY_REASON_MAX_CHARS} chars`);
     const evidencePath = parseFlag(flags, '--evidence');

     if (verdict === 'auto-pass') {
       if (!evidencePath) die('verdict=auto-pass 必须带 --evidence=<path>');
       if (!fs.existsSync(evidencePath)) die(`evidence 文件不存在: ${evidencePath}`);
       const evidence = readJSON(evidencePath);
       if (!evidence) die('evidence 文件非合法 JSON');
       for (const dim of REQUIRED_EVIDENCE_DIMENSIONS) {
         if (evidence[dim] !== 'PASS') die(`evidence.${dim} 必须为 PASS（当前: ${evidence[dim] || 'missing'}）`);
       }
     }

     const state = readState();
     const phase = state.phases.find(p => p.number === phaseId);
     if (!phase) die(`phase ${phaseId} 不存在`);

     // 幂等
     if (phase.proxyRecovery && phase.proxyRecovery.verdict === verdict) {
       process.exit(0);
     }
     phase.proxyRecovery = { at: new Date().toISOString(), verdict, reason, evidence: evidencePath || null };
     writeState(state);
     console.log(`proxy-recovery-decision: phase ${phaseId} → ${verdict}`);
   }
   ```
3. 注册到 commands 表 L1335：`'proxy-recovery-decision': cmdProxyRecoveryDecision`

**SKILL.md 改动**:

在第 7 步 Gate 集成测试章节之后（约 L820 附近），新增 §"Proxy Recovery Protocol"：
```markdown
### Proxy Recovery Protocol（atdo-003 标准恢复流程）

**触发条件**：检测到 `[AUTO-EXEC-RESULT: ... methodology=proxy ...]`

**标准操作序列**（orchestrator 必须执行，agent 永不可触发 auto-pass）：

#### Step 1. 跑 5 维独立验证
orchestrator 直接执行（不委托 agent）:
1. fileExistence: `test -f <产出物路径>` 逐一
2. syntax: 项目编译器 `node -c` / `tsc --noEmit` / `bash -n`
3. diffRange: `git diff --stat HEAD~1` 变更量 0 < x < 10000
4. debugResidue: `grep -E 'console\.log|TODO|debugger'` 在变更文件
5. secretScan: `node scripts/phase-state.js sanitize <每个变更文件>`

#### Step 2. 生成 evidence.json
写到 `.phase-execution/phases/<id>/proxy-evidence.json`:
\`\`\`json
{
  "fileExistence": "PASS",
  "syntax": "PASS",
  "diffRange": "PASS",
  "debugResidue": "PASS",
  "secretScan": "PASS"
}
\`\`\`
任一维度 FAIL → 不写 evidence，跳到 Step 3b。

#### Step 3a. 5 维全 PASS → 调命令
\`\`\`bash
node scripts/phase-state.js proxy-recovery-decision <id> auto-pass \
  --evidence=.phase-execution/phases/<id>/proxy-evidence.json \
  --reason="<proxy 类型分类，如 bash-mock-fixture / tdd-red-fixture>"
\`\`\`
命令自身二次校验 evidence 文件完整性。phase 推进。

#### Step 3b. 任一 FAIL → 升 manual gate
\`\`\`bash
node scripts/phase-state.js proxy-recovery-decision <id> manual-required \
  --reason="<具体 FAIL 维度>"
\`\`\`
phase.status 升为 `awaiting_user_review`（Bug-06 manual gate 流程接管）。

**协议硬约束**：
- agent 自报告 SUCCESS 永不可触发 auto-pass —— 必须由 orchestrator 提交 evidence 文件支撑
- evidence 5 维必须全 PASS —— 任一缺失或非 PASS → die
- auto-pass 适用范围：bash 单测 mock / TDD red fixture 等"安全 fixture 类型" proxy
- auto-pass 不适用：端到端流程模拟（如 sleep 模拟 LLM 推理）、状态机模拟等"行为伪造类" proxy
```

**Commit**: 单个原子 commit（phase-state.js + SKILL.md + atdo.test.js 实现转绿）

### B3 `docs(skill): Bug-05 三处加交叉引用 + Trust Nothing 第 13 项加固`

**SKILL.md 改动**:
1. L682 处末尾追加：
   > **标准恢复流程见 §Proxy Recovery Protocol（atdo-003）。**
2. L1058 处末尾追加：
   > **见 §Proxy Recovery Protocol（atdo-003）的标准操作序列，含 auto-pass / manual-required 二选一决策树。**
3. L1399 处追加新段落：
   > **Proxy auto-pass 合规判据**：auto-pass 仅在 orchestrator 提交 evidence 文件（含 fileExistence / syntax / diffRange / debugResidue / secretScan 5 维全 PASS）时合规。agent 自报告 SUCCESS 永不可触发 auto-pass。命令 `proxy-recovery-decision <id> auto-pass` 强制校验 evidence 文件，缺失或非 PASS → die。详见 §Proxy Recovery Protocol。

**README.md 改动**：命令清单加 `proxy-recovery-decision <phaseId> <verdict> [--evidence=<path>] [--reason="..."]` 描述（命令数 19→20）。

**Commit**: 单个原子 commit

---

## CI 设计（本 Plan 范围 — 最小骨架）

完整 5 jobs（shell-lint / commit-lint / secret-scan / pre-commit hook）移到 Plan 2。

本 Plan 仅 2 个 job：
- **test**：matrix node 20 + 22 跑 `node _proc-use/reports/atdo.test.js`
- **markdown-lint**：markdownlint-cli2 检查 README.md + SKILL.md + `doc/*.md`

无 npm 依赖（用 `npx --yes` 或 GitHub Action 官方/主流 marketplace action）。

---

## Review 流程（本 Plan 不做）

完全推迟到 Plan 2，含：
- `.github/pull_request_template.md`
- `doc/REVIEW-PROTOCOL.md`
- `.githooks/pre-commit` 可选 hook
- AI 自审触发协议文档化

---

## 文件清单（本 Plan）

### 新增（5）
| 文件 | 用途 |
|---|---|
| `doc/BEACON.md` | 项目设计明灯（≤ 80 行） |
| `doc/PLAN1-infra-atdo003.md` | 本次执行 plan（plan 最终位置） |
| `doc/PLAN2-bug-001-002-004-ci-review.md` | Plan 2 占位 |
| `.github/workflows/ci.yml` | CI workflow 骨架 |
| `.markdownlint.json` | markdown lint 配置（经本地验证） |

### 改名 git mv（1）
| 原 | 新 | 原因 |
|---|---|---|
| `_proc-use/docs/README.md` | `doc/archive/README.v3.2-DEPRECATED.md` | F7 + D6：v3.2 (auto-loop-plan bash 方案) 误导稿，与现实代码不符；归档到 doc/archive/（用户 D6 决策：设计文档统一到根目录 doc/）；改名而非删除以遵守红线 1 |

### 修改（5）
| 文件 | 改动 |
|---|---|
| `.gitignore` | A2: `_proc-use/reports/atdo.test.js` 加例外 |
| `SKILL.md` | B2 新增 §Proxy Recovery Protocol；B3 三处加交叉引用 + Trust Nothing 13 项加固 |
| `scripts/phase-state.js` | B2 新增 `cmdProxyRecoveryDecision` + 注册（~60 行） |
| `_proc-use/reports/atdo.test.js` | B1 新增 11 个 atdo-003 test (~150 行) |
| `README.md` | A1 修复死链 + 改 doc/ 引用 / A2 测试章节加注 / A3 加 CI badge / B3 命令清单 19→20 |

### 删除（0）— 严格遵守红线 1

---

## 验证

### Stage 内验证

**A1**：
```bash
ls doc/BEACON.md doc/PLAN1-infra-atdo003.md doc/PLAN2-bug-001-002-004-ci-review.md
git log --oneline -1 | grep "feat(design)"
git diff HEAD~1 -- doc/archive/README.v3.2-DEPRECATED.md  # 验证改名（注：实际为本地 mv，非 git mv，gitignored 文件已迁移到 git 跟踪的 doc/archive/）
wc -l doc/BEACON.md  # 期望 ≤ 80
```

**A2**：
```bash
git ls-files | grep "_proc-use/reports/atdo.test.js"  # 期望命中
git status _proc-use/reports/atdo.test.js  # 期望 clean
```

**A3（hard gate）**：
- 本地：`npx --yes markdownlint-cli2 README.md SKILL.md doc/BEACON.md` → 全绿
- GitHub Actions：用户 push → Actions 页面 2 个 job（test x2 + markdown-lint）全绿
- 本步骤不全绿 → 不进入 Stage B

**B1**：
```bash
node _proc-use/reports/atdo.test.js 2>&1 | grep -E "atdo-003.*not ok" | wc -l
# 期望: 11
```

**B2**：
```bash
node _proc-use/reports/atdo.test.js
# 期望: tests = 282 + 11 = 293, pass = 293, fail = 0
```

**B3**：
```bash
grep -c "Proxy Recovery Protocol" SKILL.md  # 期望 ≥ 4
grep -c "proxy-recovery-decision" README.md  # 期望 ≥ 1
```

### End-to-End 验证（Stage B 完成后）
1. **测试全绿**: `node _proc-use/reports/atdo.test.js` → 293 tests, 0 fail
2. **CI 全绿**: GitHub Actions test (x2) + markdown-lint = 3 job 全绿
3. **协议-代码-测试一致性**:
   - SKILL.md § Proxy Recovery Protocol 存在 ✓
   - phase-state.js cmdProxyRecoveryDecision 已注册 ✓
   - atdo.test.js atdo-003 describe 11 tests ✓
4. **手动场景**（可选）：模拟 `methodology=proxy` 报告 → 跑 5 维生成 evidence.json → 调命令 → 验 `state.phases[N].proxyRecovery` 写入

---

## 风险与边界

### 风险
1. **F2 撤销 commit 6dedf88 决策可能引入回归** — atdo.test.js 进 git 后未来 PR 测试改动直接可见，但仓库体积增 ~170KB（可接受）
2. **A3 GitHub Actions 首跑可能 markdown-lint 报错** — A3 前已本地验证 + 动态调 `.markdownlint.json`，但 GH Actions 环境 node 版本可能不同（mitigation：matrix 双版本）
3. **README.md 多处改动散在 4 个 commit** — 每 commit 仅改 README 一个章节，保持原子性
4. **B2 cmdProxyRecoveryDecision 实现 ~60 行可能超估** — 接受最高 100 行，超出时拆 helper

### 不做（边界 — 本 Plan）
- ❌ 不在本 plan 修 atdo-001 / 002 / 004（移 Plan 2）
- ❌ 不建 Review 流程（移 Plan 2）
- ❌ 不建 shell-lint / commit-lint / secret-scan / pre-commit hook（移 Plan 2）
- ❌ 不引入 npm 依赖 / 不创建 package.json
- ❌ 不 git push（红线，由用户手动）
- ❌ 不删除任何文件（F7 改名归档）
- ❌ 不修改 ~/.claude/ 配置（红线）

---

## Plan 2 触发条件

**触发条件**：Plan 1 完成 + GitHub Actions 全绿 + 用户明确"启动 Plan 2"指令

**Plan 2 详细范围**见同目录 `PLAN2-bug-001-002-004-ci-review.md`。

---

## 关键复用点

| 复用 | 位置 | 用于（本 Plan） |
|---|---|---|
| `die()` | phase-state.js L200 | cmdProxyRecoveryDecision 错误退出 |
| `readState()` / `writeState()` | phase-state.js (atomic write) | proxyRecovery 持久化 |
| `readJSON()` helper | phase-state.js | evidence 文件解析 |
| `parseFlag()` helper（如有；否则新增） | phase-state.js | `--evidence` `--reason` 参数解析 |
| 测试 `spawnSync` 模式 | atdo.test.js L21-46 | 11 个新测试沿用 |
| `before()/after()` 临时目录 helper | atdo.test.js L76-79 | atdo-003 describe 块复用 |
| commands 表注册 | phase-state.js L1332-1352 | `proxy-recovery-decision` 注册 |
| `SECRET_PATTERNS` | phase-state.js L203-233 | Plan 2 secret-scan job 复用（本 plan 不用） |

---

## 后续动作（等用户指令）

按全局规则 4：不自动开始开发。

- "启动 Plan 1 实施" / "开始 Stage A1" → 执行 Stage A1（先创建 BEACON.md，再 git mv v3.2 文档 + 改 README 引用 + 单个原子 commit）
- "继续改 plan" → 告诉我改哪里
- "中止" → 留在原地

**Plan Mode 临时草稿**位于 `~/.claude/plans/floofy-singing-adleman.md`，删除该文件触发红线 1，需用户明确批准。
