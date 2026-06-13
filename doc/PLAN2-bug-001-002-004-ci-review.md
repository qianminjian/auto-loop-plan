# atdo Plan 2: atdo-001 / 002 / 004 + 完整 CI/Review 流程

> **位置**：本文件是 plan 的项目内最终落地版（与项目同生命周期、可 git 跟踪）。
>
> **本 Plan 范围（详细规划版，2026-06-13 展开）**：
> - 3 个 P2 bug 修复（atdo-001 / 002 / 004）
> - CI Jobs 补全（shell-lint + commit-lint + secret-scan）
> - Review 流程（PR 模板 + REVIEW-PROTOCOL.md + 可选 pre-commit hook）
> - README 同步收尾

---

## Context

### 为什么做这次

承接 Plan 1（已完成）后续工作。Plan 1 完成了：
- ✅ doc/ 统一明灯化（D6）
- ✅ _proc-use/ 进 git + push GitHub（D7）
- ✅ GitHub Actions CI 骨架（test + markdown-lint）
- ✅ atdo-003 P1 修复（proxy-recovery-decision，F1 落地）

Plan 2 完成 4 个真实生产 bug 中剩余 3 个 P2 + CI/Review 流程完整化。

### Plan 1 教训已纳入（写在前面，避免重蹈覆辙）

| 教训 | Plan 2 如何避免 |
|---|---|
| **L1**：Plan 1 A2 在 gitignore 上反复折腾（amend 模式只能用一次） | Plan 2 所有 git 操作仅用"新 commit 追加"模式；任何重写历史动作必须停下问 |
| **L2**：Plan 1 A1 commit 前没跑测试 → CI 红 | Plan 2 每个 commit 前**强制**本地 `node atdo.test.js`，全绿才 commit |
| **L3**：Plan 1 中过度问已批准 plan 步骤 | Plan 2 内 Stage 自动推进；仅红线动作（删文件、push、reset）停下问 |
| **L4**：用户提需求时没做技术评估 | Plan 2 每个 Bug 设计含"技术本质 + Edge Cases + 风险表"，提前识别隐患 |

### Plan 1 审计 finding 移到 Plan 2 的全部修订

| Finding | Plan 2 修订 |
|---|---|
| **F3 [P1]** atdo-004 advance-phase "稳态"定义模糊 | 按 phase.gateType 决策终点：auto → completed / manual\|hybrid → gated / awaiting_user_review\|completed → die |
| **F4 [P2]** atdo-001 豁免目录硬编码 vs 可配置 | YAGNI 接受硬编码（含 `.phase-execution/` / `doc/` / `_proc-use/` / `.serena/`）；未来可扩展为 config |
| **F5 [P2]** atdo-002 阈值无依据 | 对齐 cmdInit 现有阈值（每元素 ≤ 500、最多 50 个） |
| **F9 [P1]** secret-scan 实现伪代码 | 用纯 bash grep + 硬编码 SECRET_PATTERNS 正则（与 phase-state.js 同步），不依赖 phase-state.js sanitize 修改文件 |
| **F11 [P2]** commit-lint 中文友好 | `subject-max-length: [2, 'always', 100]` |
| **F12 [P2]** 协议层 TDD 弱保障 | 每个协议章节加 e2e fixture test |

### 关键发现（PLAN1 执行过程的新发现）

- **`.serena/` 是真实场景的脏文件**（Serena MCP 副产物）— PLAN1 启动 atdo Step 0 时撞过，atdo-001 豁免列表必须含
- **`_proc-use/` 已进 git**（D7 决策）— atdo-001 豁免列表应含（避免 Step 0a 把 _proc-use/ 内待 commit 文件误判为脏）
- **CI 实跑环境差异**（PLAN1 markdown-lint 默认规则在中文文档大量误报）— PLAN2 新加 CI Job 必须先本地 `npx --yes` 试跑，避免推 GitHub 才发现红

---

## 设计原则

1. **TDD 严格 Red → Green → Refactor**：先写 fail 测试，再写最少实现
2. **协议-代码-测试三方一致**：SKILL.md 章节 + phase-state.js 命令 + atdo.test.js 测试 三同步
3. **不引入 npm 依赖**：仅 Node.js 内置 + GitHub Actions 官方/主流 action
4. **每 commit 前本地全测试通过**（L2 教训）
5. **单文件原子 commit**：每 commit 解决一个 finding
6. **不重写 git 历史**：任何破坏性操作必须停下问

---

## Stage C：atdo-001 P2 修复（3 commits）

### 现状

SKILL.md Step 0a（L255-271）只豁免 `.phase-execution/`，其他脏文件一律 FATAL。
PLAN1 启动时撞过：`.serena/` 未跟踪 → atdo Step 0 拒绝启动。

### 设计

#### 1. phase-state.js 新增 `check-workspace --suggest` 命令

- 输入：stdin 读 `git status --porcelain` 输出
- 豁免目录列表（硬编码常量）：
  ```js
  const WORKSPACE_EXEMPT_PATHS = [
    '.phase-execution/',  // atdo 运行时
    'doc/',                // D6 设计文档目录
    '_proc-use/',          // D7 过程文档目录
    '.serena/',            // Serena MCP 副产物
  ];
  ```
- 决策：
  - 全部脏文件位于豁免目录 → exit 0 + stdout `SUGGEST_AUTO_STAGE\n<file1>\n<file2>...`
  - 任一脏文件不在豁免目录 → exit 0 + stdout `BLOCK: <non-exempt-files>`
  - 空输入 → exit 0 + stdout `CLEAN`

#### 2. SKILL.md Step 0a 改为调命令

```bash
DIRTY=$(git status --porcelain)
RESULT=$(echo "$DIRTY" | node scripts/phase-state.js check-workspace --suggest)
case "$RESULT" in
  CLEAN*)
    ;;
  SUGGEST_AUTO_STAGE*)
    echo "[INFO] 检测到豁免目录文件未提交（doc/_proc-use/.serena/.phase-execution）:"
    echo "$RESULT" | tail -n +2 | sed 's/^/  /'
    echo "建议：git add+commit 后再启动 atdo (输入 c 继续 / a 终止)"
    # 走 checkpoint 流程
    ;;
  BLOCK*)
    echo "[FATAL] $RESULT"
    exit 1
    ;;
esac
```

### TDD 11 个测试

| # | test 名 | 验证 |
|---|---|---|
| 1 | `全脏文件在 doc/ → SUGGEST_AUTO_STAGE` | D6 设计目录豁免 |
| 2 | `全脏文件在 _proc-use/ → SUGGEST_AUTO_STAGE` | D7 过程目录豁免 |
| 3 | `全脏文件在 .serena/ → SUGGEST_AUTO_STAGE` | MCP 副产物豁免 |
| 4 | `全脏文件在 .phase-execution/ → SUGGEST_AUTO_STAGE` | atdo 运行时豁免 |
| 5 | `src/main.js 非豁免 → BLOCK` | 源代码脏阻断 |
| 6 | `混合（豁免 + 非豁免）→ BLOCK` | 一个非豁免就 BLOCK |
| 7 | `空输入 → CLEAN` | 工作区干净 |
| 8 | `未跟踪 ?? doc/foo.md → SUGGEST_AUTO_STAGE` | git status ?? 前缀解析 |
| 9 | `已修改 M doc/foo.md → SUGGEST_AUTO_STAGE` | git status M 前缀解析 |
| 10 | `删除 D src/main.js → BLOCK` | git status D 前缀解析（非豁免目录）|
| 11 | `e2e: 模拟 atdo Step 0a 流程 → 豁免脏文件 → 命令返回 SUGGEST → orchestrator 解析无误` | 协议 fixture |

### Stage C commits

#### C1 `test(state): atdo-001 check-workspace TDD Red (11 tests)`
- atdo.test.js 新增 `describe('atdo-001 check-workspace')` 11 个 test，全 fail
- 验证：`node atdo.test.js` → `# tests 304 / # fail 11`（原 293 + 11）

#### C2 `fix(state): atdo-001 实现 cmdCheckWorkspace + SKILL.md Step 0a`
- phase-state.js 新增常量 WORKSPACE_EXEMPT_PATHS + cmdCheckWorkspace（~50 行）
- 注册到 commands 表：`'check-workspace': cmdCheckWorkspace`
- SKILL.md Step 0a 改为 RESULT case 分发（含 CHECKPOINT 流程）
- 验证：`node atdo.test.js` → 304 pass / 0 fail

#### C3 `docs(readme): atdo-001 命令清单更新 (20→21)`
- README 命令清单加 `check-workspace --suggest` 行
- README "推送到 GitHub" 章节附近加 atdo-001 修复说明

---

## Stage D：atdo-004 P2 修复（3 commits）

### 现状

SKILL.md `--no-audit` 模式（L242 / L723）状态机仍走 `executed → audited → fixed → gated`，orchestrator 实操：
```bash
node phase-state.js set-phase N audited
node phase-state.js set-phase N fixed
node phase-state.js set-phase N gated
node phase-state.js set-phase N completed
```
每 phase 4 次手动 set-phase。

### 设计（按 F3 修订）

#### 1. phase-state.js 新增 `advance-phase <phaseId> [--to=<status>]` 命令

```js
function cmdAdvancePhase() {
  const phaseId = args[0];
  if (!phaseId) die('advance-phase 需要 phaseId');

  // 解析 --to
  let targetStatus = null;
  for (const a of args.slice(1)) {
    const m = a.match(/^--to(?:=(.+))?$/);
    if (m && m[1]) targetStatus = m[1];
  }

  const state = readState();
  const phase = state.phases.find(p => p.number === phaseId);
  if (!phase) die(`phase ${phaseId} 不存在`);

  // 边界：终态/manual-gate 入口 → die
  if (['completed', 'user-review-fail', 'awaiting_user_review'].includes(phase.status)) {
    die(`phase ${phaseId} 当前 status="${phase.status}"，不可 advance（终态或 manual gate 中）`);
  }

  // 默认终点按 gateType 决策（F3 修订）
  if (!targetStatus) {
    const gateType = phase.gateType || 'auto';
    targetStatus = (gateType === 'manual' || gateType === 'hybrid') ? 'gated' : 'completed';
  }

  // 单步推进直到 targetStatus
  let current = phase.status;
  while (current !== targetStatus) {
    const nexts = ALLOWED_TRANSITIONS[current];
    if (!nexts || nexts.length === 0) {
      die(`advance-phase: 无法从 ${current} 推进到 ${targetStatus}`);
    }
    // 多分支选择：优先选"走向 targetStatus"的分支
    const next = chooseAutoPath(current, nexts, targetStatus);
    // 走完整 setPhase 校验（VALID_PREDECESSORS / TERMINAL_STATUSES）
    const r = setPhase(phaseId, next);
    if (!r) die(`advance-phase: setPhase 失败于 ${current} → ${next}`);
    current = next;
  }

  process.stdout.write(JSON.stringify({
    ok: true, phaseId, from: phase.status, to: targetStatus,
  }));
}

// helper: 多分支选择走向 target 的路径
function chooseAutoPath(current, nexts, target) {
  // 简单策略：取第一个能到 target 的（基于 ALLOWED_TRANSITIONS 反向 BFS）
  for (const next of nexts) {
    if (next === target) return next;
    if (canReach(next, target)) return next;
  }
  return nexts[0];  // fallback
}
```

#### 2. SKILL.md P1-4 章节更新

L723 附近加：
> `--no-audit` 模式 orchestrator 推进:
> ```bash
> node scripts/phase-state.js advance-phase <phaseId>
> ```
> 等价于连续多次 set-phase，按 phase.gateType 自动决策终点：
> - gateType=auto → 推到 `completed`
> - gateType=manual/hybrid → 推到 `gated`（让 manual gate 接管）
> - awaiting_user_review / completed → die

### TDD 8 个测试

| # | test 名 | 验证 |
|---|---|---|
| 1 | `pending → advance 默认 → completed (auto gate)` | 全路径推进 |
| 2 | `executed → advance 默认 → completed` | 中间态推进 |
| 3 | `gated (gateType=auto) → advance 默认 → completed` | gated 末段推进 |
| 4 | `gated (gateType=manual) → advance → die` | 不可越过 manual gate |
| 5 | `--to=audited → 推进后停在 audited` | --to 指定目标 |
| 6 | `--to=verified → 走 verification 路径` | 多分支选择 |
| 7 | `completed → advance → die` | 终态拒绝 |
| 8 | `awaiting_user_review → advance → die` | manual gate 中拒绝 |

### Stage D commits

#### D1 `test(state): atdo-004 advance-phase TDD Red (8 tests)`
- atdo.test.js 新增 `describe('atdo-004 advance-phase')` 8 个 test，全 fail
- 验证：`# tests 312 / # fail 8`

#### D2 `fix(state): atdo-004 实现 cmdAdvancePhase + SKILL.md P1-4 章节更新`
- phase-state.js 新增 cmdAdvancePhase + chooseAutoPath + canReach helper（~80 行）
- 注册命令：`'advance-phase': cmdAdvancePhase`
- SKILL.md L723 附近加 `--no-audit` 推荐使用
- 验证：312 pass / 0 fail

#### D3 `refactor(state): advance-phase 抽 chooseAutoPath / canReach 纯函数`
- 重构提取 helper，便于单测
- 加 5 个 helper 单测（chooseAutoPath / canReach 边界）

---

## Stage E：atdo-002 P2 修复（3 commits）

### 现状（澄清）

bug 报告中 `check-all.sh` 是外部 target 项目（study-code-output-standard）的脚本，**不在 atdo repo**。
atdo 协议层修复方向：让 plan 可以**声明**"某 step 失败属于预期"，orchestrator 解析集成测试报告时识别。

### 设计（按 F5 修订）

#### 1. plan schema 扩展（cmdInit）

```jsonc
{
  "phases": [{
    "id": "02",
    "name": "...",
    "isGate": true,
    "gate_noise_expected": [
      "check-meta",
      "check-consistency",
      "check-phase-facts"
    ]
  }]
}
```
- 字段类型: string[]（数组元素为 step 名或正则）
- **校验（F5 对齐 cmdInit task 阈值）**: 必须数组、每个元素 ≤ 500 chars、最多 50 个元素

#### 2. cmdGetCurrentPhase 输出 `gateNoiseExpected` 字段

#### 3. SKILL.md 第 7 步加 § Gate Noise Whitelist 章节

```markdown
### Gate Noise Whitelist (atdo-002)

> **背景**：Gate 集成测试在"非目标项目环境"产生预期 FAIL（如 atdo skill 自身仓库跑 `check-meta.sh` 因无 `asset-docs/` 而 FAIL）。
> 这些"噪声 FAIL"不是真错，需协议层声明白名单。

#### 触发条件
phase.gate_noise_expected: string[] 非空

#### 行为
orchestrator 解析 integration-test-report.md 时：
- 若 step 名匹配 phase.gate_noise_expected 中任一模式
- → 在报告中标记 "EXPECTED_NOISE"
- → 不计入 gate FAIL 总数

#### 反例 vs 正例
（含 plan JSON 示例 + integration-test-report 标记示例）
```

#### 4. references/templates/integration-test-report-template.md 新增 `expectedNoise: []` 段落

### TDD 6 个测试

| # | test 名 | 验证 |
|---|---|---|
| 1 | `init 接受 gate_noise_expected 数组` | 字段正常解析 |
| 2 | `init 拒绝非数组 → die` | 类型校验 |
| 3 | `init 拒绝单元素超 500 chars → die` | F5 元素长度阈值 |
| 4 | `init 拒绝数组超 50 个 → die` | F5 数组大小阈值 |
| 5 | `get-current-phase 输出 gateNoiseExpected 字段` | 输出含字段 |
| 6 | `字段缺失向后兼容 → 默认空数组` | 旧 plan 仍工作 |

### Stage E commits

#### E1 `test(state): atdo-002 gate_noise_expected TDD Red (6 tests)`
- atdo.test.js 新增 `describe('atdo-002 gate_noise_expected')` 6 个 test，全 fail
- 验证：`# tests 318 / # fail 6`

#### E2 `fix(state): atdo-002 init 校验 + cmdGetCurrentPhase 输出 + SKILL.md Gate Noise 章节`
- phase-state.js cmdInit 加 gate_noise_expected 校验
- cmdGetCurrentPhase 输出 gateNoiseExpected
- SKILL.md 加 § Gate Noise Whitelist 章节
- 验证：318 pass / 0 fail

#### E3 `docs(templates): integration-test-report-template 加 expectedNoise 段落`
- references/templates/integration-test-report-template.md 加 expectedNoise 段落示例

---

## Stage F：CI Jobs 补全（3 commits）

### F1 `ci: shell-lint job`

`.github/workflows/ci.yml` 新增 job：
```yaml
shell-lint:
  name: Shell Lint
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: ludeeus/action-shellcheck@2.0.0
      with:
        scandir: scripts
```

**前置验证**：本地 `shellcheck scripts/watchdog.sh` 全绿（如有报错先修）。

### F2 `ci: commit-lint job`

`commitlint.config.js`（新）：
```js
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always',
      ['feat','fix','docs','style','refactor','test','chore','perf','ci','revert','security','hotfix']
    ],
    'subject-max-length': [2, 'always', 100],  // F11: 中文友好（默认 50 对中文太短）
    'body-max-line-length': [0],  // 允许中文长行
  }
};
```

`.github/workflows/ci.yml` 新增 job：
```yaml
commit-lint:
  name: Commit Lint
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
      with: { fetch-depth: 0 }
    - uses: wagoid/commitlint-github-action@v6
      with: { configFile: commitlint.config.js }
```

### F3 `ci: secret-scan job (F9 可执行版)`

`.github/workflows/ci.yml` 新增 job（用纯 bash + grep，不依赖 phase-state.js sanitize 修改文件）：
```yaml
secret-scan:
  name: Secret Scan
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
      with: { fetch-depth: 0 }
    - name: Scan changed files for secrets
      run: |
        # PR vs push: 计算 diff 范围
        if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then
          BASE="origin/${GITHUB_BASE_REF}"
          git fetch origin "${GITHUB_BASE_REF}"
        else
          BASE="HEAD~1"
        fi
        CHANGED=$(git diff --name-only "$BASE"...HEAD | grep -E '\.(js|ts|sh|md|json|yml|yaml|py|go|rs)$' || true)
        if [ -z "$CHANGED" ]; then
          echo "no scannable changed files"
          exit 0
        fi

        # SECRET_PATTERNS（与 phase-state.js SECRET_PATTERNS 同步）
        PATTERNS='sk-[a-zA-Z0-9]{20,}|sk-ant-api[0-9]+-|ghp_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9]{20,}|gho_[a-zA-Z0-9]{20,}|ghu_[a-zA-Z0-9]{20,}|ghs_[a-zA-Z0-9]{20,}|ghr_[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}|glpat-[a-zA-Z0-9_-]{20,}|xox[abprs]-[a-zA-Z0-9-]{10,}|dckr_pat_[a-zA-Z0-9]{20,}|npm_[a-zA-Z0-9]{16,}|pypi-AgEIcHlwaS5vcmc|ATATT[a-zA-Z0-9]{20,}|-----BEGIN .* PRIVATE KEY-----'

        FOUND=0
        for f in $CHANGED; do
          [ -f "$f" ] || continue
          if grep -EHn "$PATTERNS" "$f"; then
            FOUND=1
          fi
        done
        if [ $FOUND -eq 1 ]; then
          echo "❌ Secrets detected in changed files"
          exit 1
        fi
        echo "✅ No secrets detected"
```

**注意**：SECRET_PATTERNS 与 phase-state.js 同步保持。Plan 2 完成后建议加 lint test：单独 test 校验 phase-state.js SECRET_PATTERNS 与 ci.yml 中 pattern 一致（防漂移）。本 Plan 不做此 test（YAGNI）。

### Stage F commits

#### F1 `ci(actions): shell-lint job`
- ci.yml 加 shell-lint job
- 验证：本地 shellcheck OK + push GH Actions 看 4 个 job 全绿

#### F2 `ci(actions): commit-lint job + commitlint.config.js (F11 中文友好)`
- commitlint.config.js 新增
- ci.yml 加 commit-lint job
- 验证：本地 `npx commitlint --from HEAD~5 --to HEAD` 全绿（历史 commit 应通过 ≤ 100 chars 规则）

#### F3 `ci(actions): secret-scan job (F9 可执行版)`
- ci.yml 加 secret-scan job（纯 bash + grep）
- 验证：本地写一个 fixture 文件含 `sk-test12345...` 试跑确认捕获

---

## Stage G：Review 流程（3 commits）

### G1 `chore(github): pull_request_template.md`

`.github/pull_request_template.md`（新）：
```markdown
## 改动概述
<!-- 1-2 句说明 -->

## 关联
- 关联 buginfo: atdo-NNN
- 关联 finding: P[0-3]-NN（如适用）

## 改动类型
- [ ] feat / fix / docs / refactor / test / chore / perf / ci / security

## 协议-代码-测试三方一致性自检
- [ ] SKILL.md 协议章节已同步（如改动协议）
- [ ] phase-state.js 命令实现已完成（如新增命令）
- [ ] atdo.test.js 测试已新增（TDD red 已转 green）
- [ ] README 命令清单已同步（如新增命令）

## 红线自查
- [ ] 无 `git push --force` / `git reset --hard` / `git rm`
- [ ] 无 .env / *.key / 密钥硬编码
- [ ] 无 ~/.claude/ 配置修改
- [ ] commit message 符合 Angular convention (subject ≤ 100 chars)

## AI Review 触发
- [ ] 已运行 `/gsd-code-review` 并附 review report
- [ ] review report 位置: `_proc-use/reports/REVIEW-<PR>-<date>.md`

## 测试覆盖
- 本地 `node _proc-use/reports/atdo.test.js`: ___/___ pass
- CI 状态: ⏳ pending / ✅ green / ❌ red
```

### G2 `docs(review): REVIEW-PROTOCOL.md`

`doc/REVIEW-PROTOCOL.md`（新，≤ 100 行）：
- **协议层 checklist**（修改 SKILL.md 时）：章节交叉引用、Bug-NN 协议是否仍生效、Trust Nothing 项是否需扩展
- **代码层 checklist**（修改 phase-state.js / watchdog.sh 时）：常量同步、命令注册、错误消息含上下文、red line 遵守
- **测试层 checklist**（修改 atdo.test.js 时）：TDD red 转 green 流程、新 describe 块独立 dir、断言含 stderr context
- **红线 checklist**：删文件、密钥、git push --force、~/.claude/、修改外部目标项目
- **跨 finding 影响 checklist**：当前 PR 是否触发既有 Bug 协议变化、其他 buginfo 是否被波及

### G3 `chore(githooks): pre-commit hook 可选启用`

`.githooks/pre-commit`（新，shell 脚本）：
```bash
#!/bin/sh
# atdo pre-commit hook (可选启用: git config core.hooksPath .githooks)
set -e

echo "[pre-commit] node atdo.test.js"
node _proc-use/reports/atdo.test.js > /dev/null

echo "[pre-commit] markdownlint"
npx --yes markdownlint-cli2 README.md SKILL.md doc/*.md > /dev/null

echo "[pre-commit] ✅ all checks passed"
```

README 加启用说明：
```markdown
## 可选：pre-commit hook

启用：`git config core.hooksPath .githooks`
内容：commit 前自动跑测试 + markdownlint

禁用：`git config --unset core.hooksPath`
```

**不强制启用**（按 safety-bounds.md：不修改用户 git 配置）。

---

## Stage H：收尾（1-2 commits）

### H1 `docs(readme): atdo-001/002/004 修复记录 + 命令清单 22 + CI 完整状态`

README 改动：
1. **命令清单更新 20 → 22**：
   - 新增 `check-workspace --suggest`（C2 已加 21）
   - 新增 `advance-phase <phaseId> [--to=<status>]`（D3 已加 22）
2. **生产故障修复记录章节**新增子节：
   ```markdown
   ### atdo-001/002/004 修复（Plan 2 — 2026-MM-DD）
   - atdo-001 P2: check-workspace --suggest 智能识别豁免目录
   - atdo-002 P2: gate_noise_expected 协议层白名单
   - atdo-004 P2: advance-phase 按 gateType 决策终点
   - 含 25 个新增测试（总 318）
   ```
3. **CI 状态完整表**：
   ```markdown
   ## CI Jobs
   | Job | 内容 |
   |---|---|
   | Tests (Node 20/22) | node atdo.test.js |
   | Markdown Lint | README/SKILL/doc/*.md |
   | Shell Lint | shellcheck scripts/ |
   | Commit Lint | conventional commits + subject ≤ 100 |
   | Secret Scan | grep 15 类 token pattern |
   ```

### H2 `docs(beacon): D8/D9 决策记录 + 演进日志 + 待解决问题更新`

doc/BEACON.md 改动：
1. 加 D8 决策：atdo-001 豁免目录硬编码（含 doc/_proc-use/.serena/.phase-execution）
2. 加 D9 决策：advance-phase 按 gateType 决策（auto→completed / manual→gated）
3. 演进日志加 3 条（Stage C/D/E 完成）
4. 待解决问题清空（Q1/Q2 已解决，Q3 仍 open 但已通过 D7 间接解决）

---

## 文件清单

### 新增（6）
| 文件 | 用途 |
|---|---|
| `.github/pull_request_template.md` | PR 模板 |
| `doc/REVIEW-PROTOCOL.md` | Review checklist (≤ 100 行) |
| `commitlint.config.js` | commitlint Angular + 中文友好 |
| `.githooks/pre-commit` | 可选 pre-commit hook |
| （CI 内嵌于 ci.yml，无新 yaml 文件）| — |

### 修改（6）
| 文件 | 改动 |
|---|---|
| `scripts/phase-state.js` | C2 新增 cmdCheckWorkspace / D2 新增 cmdAdvancePhase / D3 helper / E2 cmdInit 校验 + cmdGetCurrentPhase 输出 (~200 行新增) |
| `SKILL.md` | C2 Step 0a 改写 / D2 P1-4 章节加 advance-phase / E2 加 § Gate Noise Whitelist 章节 |
| `_proc-use/reports/atdo.test.js` | C1 11 tests / D1 8 tests / D3 5 helper tests / E1 6 tests (~400 行新增) |
| `.github/workflows/ci.yml` | F1/F2/F3 新增 3 jobs |
| `references/templates/integration-test-report-template.md` | E3 加 expectedNoise 段落 |
| `README.md` | C3 命令 +1 / D2 命令 +1 / H1 修复记录 + CI 状态表 |
| `doc/BEACON.md` | H2 D8/D9 决策 + 演进日志 |

### 删除（0）— 严格遵守红线 1

---

## 验证

### 每 Stage 内验证（每 commit 前必跑，L2 教训）

```bash
# 1. 测试全绿
node _proc-use/reports/atdo.test.js 2>&1 | tail -8
# 期望: # pass = # tests, # fail 0

# 2. markdown lint 全绿（如改 .md）
npx --yes markdownlint-cli2 README.md SKILL.md doc/*.md 2>&1 | tail -3
# 期望: 0 error(s)
```

### End-to-End 验证（Stage H 完成后）

1. **测试全绿**: `node atdo.test.js` → 318 pass / 0 fail（293 + 25 new = 318）
2. **CI 5 jobs 全绿**: GitHub Actions test (×2) + markdown-lint + shell-lint + commit-lint + secret-scan
3. **协议-代码-测试三方一致**:
   - SKILL.md 含 § Gate Noise Whitelist ✓
   - phase-state.js cmdCheckWorkspace + cmdAdvancePhase + cmdInit 扩展 ✓
   - atdo.test.js atdo-001/002/004 describe 块 ✓
4. **手动场景**:
   - 在测试 repo 制造 `.serena/` 脏 → 跑 atdo → 验证 SUGGEST_AUTO_STAGE 提示
   - plan 含 `gate_noise_expected` → 跑 atdo → 验证 gate 不计 FAIL
   - 跑 `node phase-state.js advance-phase 02` → 验证按 gateType 决策终点
   - PR 模板：开 PR 后验证模板自动加载

---

## 风险与边界

### 风险

| 风险 | 缓解 |
|---|---|
| commit-lint 跑历史 commit 失败（如旧 commit subject 超 100） | F2 commitlint config 只 lint 当前 PR 新 commit，不 lint 历史 |
| secret-scan 误报（正常 sk- 前缀但非密钥） | 接受偶发误报；用户可在 PR 标 `[skip secret-scan]` 绕过（待 F3 后续优化）|
| shell-lint 报现有 watchdog.sh 问题 | F1 前本地 `shellcheck scripts/watchdog.sh` 试跑，必要时先修 watchdog.sh |
| advance-phase 多分支选路径错误 | TDD 8 测试覆盖各分支；chooseAutoPath helper 单独 5 tests |
| atdo-001 豁免列表硬编码不灵活 | F4 YAGNI 接受；未来真需要可扩展为 config 文件 |
| CI 5 jobs 总耗时增加（从当前 ~30s 到可能 ~2min） | 接受（GitHub Actions 免费额度充足）|

### 不做（明确边界）

- ❌ 不实现 SECRET_PATTERNS 自动同步 lint（test 验证 phase-state.js 与 ci.yml 一致）— YAGNI
- ❌ 不实现 pre-commit hook 自动安装（用户手动 `git config`）
- ❌ 不实现 CODEOWNERS（按 Plan 1 用户决策：单人项目，AI 自审 + 用户批准）
- ❌ 不实现 branch protection（同上）
- ❌ 不修改外部目标项目（atdo 仅协议层修复 atdo-002，不动 target repo）
- ❌ 不引入 npm 依赖（commitlint 通过 GitHub Action 跑，不本地 install）
- ❌ 不删除任何文件
- ❌ 不 git push --force / reset --hard
- ❌ 不修改 ~/.claude/ 配置
- ❌ 不动 commit 6dedf88 / 499ea8c 等历史 commit

---

## 关键复用点（Plan 1 已成熟）

| 复用 | 位置 | 用于（本 Plan） |
|---|---|---|
| `die()` | phase-state.js L200 | 所有新命令错误退出 |
| `readState()` / `writeState()` | phase-state.js (atomic write) | 状态持久化 |
| `setPhase()` | phase-state.js L668-737 | advance-phase 单步推进复用 |
| `ALLOWED_TRANSITIONS` | phase-state.js L69-83 | advance-phase 路径计算 |
| `VALID_PREDECESSORS` | phase-state.js L86 | setPhase 校验 |
| `cmdInit` 长度校验 | phase-state.js | gate_noise_expected 阈值复用同模式 |
| `SECRET_PATTERNS` | phase-state.js L207-233 | F3 secret-scan job 同步保持 |
| 测试 `spawnSync` 模式 | atdo.test.js L21-46 | 新 describe 块沿用 |
| `before/after` 临时目录 helper | atdo.test.js L76-79 | 所有新 describe 块复用 |
| commands 表注册 | phase-state.js L1332-1352 | check-workspace / advance-phase 注册 |
| Plan 1 § Proxy Recovery Protocol 章节风格 | SKILL.md | Stage E § Gate Noise Whitelist 章节模仿同样的"反例 vs 正例" 结构 |

---

## 估算

| Stage | Commits | 主要工作 |
|---|---:|---|
| C (atdo-001) | 3 | TDD Red + 实现 + docs |
| D (atdo-004) | 3 | TDD Red + 实现 + refactor |
| E (atdo-002) | 3 | TDD Red + 实现 + template |
| F (CI 3 jobs) | 3 | shell-lint / commit-lint / secret-scan |
| G (Review) | 3 | PR template / REVIEW-PROTOCOL / pre-commit |
| H (收尾) | 2 | README / BEACON |
| **总** | **17** | — |

**新增测试**: ~30（atdo-001 11 + atdo-004 8+5 helper + atdo-002 6）
**总 tests**: 293 → ~323

---

## 后续动作（等用户启动）

按 §4 闸门：plan 已展开完成，**等用户明确"启动 Plan 2"指令**才开始 Stage C。

- 「启动 Plan 2」 / 「开始 Stage C」 → 我执行 Stage C1（atdo-001 TDD Red）
- 「先调整 plan」 → 告诉我改哪里（如某 Stage 拆分 / 某 Bug 优先级调整）
- 「暂停」 → 留现状

留在 Plan 2 待启动状态。
