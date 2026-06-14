# atdo Plan 1+2 完成后深度审计

> 审计日期：2026-06-14
> 审计基线：commit `849b341`（本会话 28 个 commit 完成 + CI 全绿）
> 审计范围：11 维度生产就绪度（沿用 v2.0.1 审计方法）
> 对比基线：v2.0.1 = 97/100 (S 级)

## 评分总览

| 维度 | 权重 | 得分 | 状态 | vs v2.0.1 |
|---|:-:|:-:|:-:|:-:|
| 1. 核心正确性 | 15 | **15/15** | ✅ | = |
| 2. 可靠性 | 15 | **14/15** | ✅ | = |
| 3. 安全性 | 15 | **15/15** | ✅ | = |
| 4. 可观测性 | 10 | **9/10** | △ | -1 |
| 5. 兼容性 | 10 | **8/10** | △ | = |
| 6. 性能 | 10 | **9/10** | △ | -1 |
| 7. 文档 | 5 | **5/5** | ✅ | = |
| 8. 可维护性 | 5 | **5/5** | ✅ | = |
| 9. 可部署性 | 5 | **4/5** | △ | -1 |
| 10. 失败恢复 | 5 | **5/5** | ✅ | = |
| 11. 协议完整性 | 5 | **5/5** | ✅ | = |
| **总计** | **100** | **94/100** | **A** | **-3** |

## 决策

**🟢 可立即用于生产**

评分变化解释：v2.0.1 97 分基线下，引入 3 个新命令 + 6 CI jobs + 完整 Review 流程是显著扩展，引入新表面风险也正常。94 仍是 A 级。

## 基线数据

| 数据 | 值 |
|---|---|
| 测试覆盖 | 282 → **318** (+36, +12.8%) |
| 命令数 | 19 → **22** (+3：proxy-recovery-decision / check-workspace / advance-phase) |
| 真实 bug 闭环 | 0/4 → **4/4** |
| CI Jobs | 0 → **6**（test×2 / markdown / shell / commit / secret） |
| 本会话 commits | **28** |
| 设计文档 | 散落 → **doc/ 统一** (BEACON / DESIGN / PLAN1 / PLAN2 / REVIEW-PROTOCOL) |
| 仓库规模 | .git 4.9M / doc 92K / _proc-use 380K / scripts 84K |

## 11 维度详细

### 1. 核心正确性 (15/15)

- 318/318 测试全绿，64+ describe 块
- 4 个真实生产 bug 全闭环（atdo-001/002/003/004）
- 4 处新增 e2e fixture test
- 状态机 ALLOWED_TRANSITIONS 11 条转换无破坏
- F1 [P0] 协议落地：cmdProxyRecoveryDecision 强制 evidence 5 维全 PASS
- F3/F4/F5/F9/F11 finding 修订全纳入

证据：`node atdo.test.js` 318/318；CI run 27469202082 全绿。

### 2. 可靠性 (14/15)

强项：继承 v2.0.1 atomic write + 4 级 backup + execFileSync 参数化。新增 cmdAdvancePhase 的 safety limit 20 防死循环。

**-1 分**：writeState 每次双 bak 拷贝（v2.0.1 已识别，未优化）。

### 3. 安全性 (15/15)

**新增防御层**：
- secret-scan CI job（15 类 token pattern）
- pre-commit hook 可选（atdo.test.js + markdownlint）
- PR template 红线 self-check
- REVIEW-PROTOCOL 5 层 checklist 含红线层

**新命令注入审计**：
- cmdAdvancePhase: `spawnSync('node', [__filename, ...])` 参数化 ✓
- cmdCheckWorkspace: 从 stdin 读，无 shell 调用 ✓
- cmdProxyRecoveryDecision: fs.existsSync 不调 shell ✓

### 4. 可观测性 (9/10)

强项：CI 6 jobs 即时反馈；PR template 强制 self-check；BEACON D1-D9 决策全可追溯。

**⚠️ -1 分**：`commitlint.config.mjs` 本地无法跑（需 `npm install @commitlint/cli`），开发者只能依赖 CI 反馈。

### 5. 兼容性 (8/10)

强项：shellcheck 全绿；markdown-lint 13 规则放宽中文兼容；commitlint subject ≤ 100 中文友好。

**⚠️ -2 分**：
- commitlint v6 要求 .mjs (ESM)：本会话踩坑一次（commit `849b341` 修复）
- Node 20 actions 即将弃用（2026-09-16）：CI 用的 actions 都跑 Node 20

### 6. 性能 (9/10)

强项：测试 ~26s（318 测试，每 test ~80ms）；CI 6 jobs 并行 ~30s。

**⚠️ -1 分**：cmdAdvancePhase 用 spawnSync 子进程，长路径（pending → completed = 6 步）= **~600ms-1s 开销**。可优化：内联 setPhase 核心逻辑去 spawnSync。

### 7. 文档 (5/5)

- README 22 命令 + CI 状态表 + Plan 1/2 修复记录
- BEACON 53 行（≤ 80），D1-D9 决策清晰
- PLAN1 504 行 + PLAN2 693 行（同等详细）
- REVIEW-PROTOCOL 58 行 5 层 checklist
- SKILL.md 1895 行（+215，含 Proxy Recovery + Gate Noise 协议章节）

### 8. 可维护性 (5/5)

- 设计文档统一 doc/（D6）解决历史散落
- 28 commit 全 Angular convention + subject ≤ 100 + 详细 body
- TDD Red/Green 分 commit 清晰可追溯
- 每个 commit 单一主题

### 9. 可部署性 (4/5)

**⚠️ -1 分**：`_proc-use/dev/install.sh` 未在本会话审计是否仍兼容 D6/D7 新结构（doc/ + _proc-use/ 进 git）。

### 10. 失败恢复 (5/5)

- 状态机严格（D 测试覆盖完成 / awaiting_user_review / 终态 4 种失败路径）
- advance-phase safety limit + die() 错误退出
- atomic write + 4 级 backup（继承 v2.0.1）

### 11. 协议完整性 (5/5)

- atdo-003: § Proxy Recovery Protocol + Bug-05 三处交叉引用 + Trust Nothing 13 项加固
- atdo-002: § Gate Noise Whitelist + template expectedNoise
- atdo-001: Step 0a 改用 check-workspace
- atdo-004: P1-4 章节加 advance-phase 推荐
- 4 处协议级 e2e fixture test 兜底

## 已知遗留（已审计入分）

| ID | 严重度 | 描述 | 状态 |
|---|---|---|---|
| **R1** | P2 | commitlint 本地无法跑（需 npm install） | 可观测性 -1 |
| **R2** | P2 | Node 20 actions 2026-09 弃用警告 | 兼容性 -1 |
| **R3** | P3 | cmdAdvancePhase spawnSync 性能 ~1s | 性能 -1 |
| **R4** | P3 | install.sh 未审计 D6/D7 兼容 | 可部署性 -1 |
| **R5** | P3 | _proc-use/buginfo/atdo-00* 未标 RESOLVED | 微小，不扣分 |
| **R6** | P3 | writeState 双 bak 拷贝未优化 | 继承 v2.0.1 已识别 |

## 与 v2.0.1 (97/100) 对比

| 维度 | v2.0.1 | 现状 | 变化原因 |
|---|---|---|---|
| 核心正确性 | 15 | 15 | 测试 +36，bug -4，命令 +3 |
| 可靠性 | 14 | 14 | = |
| 安全性 | 15 | 15 | 新增 CI secret-scan 增强 |
| 可观测性 | 10 | 9 | commitlint 本地缺失 |
| 兼容性 | 8 | 8 | = |
| 性能 | 10 | 9 | advance-phase spawnSync 开销 |
| 文档 | 5 | 5 | doc/ 统一 + 5 个新文件 |
| 可维护性 | 5 | 5 | = |
| 可部署性 | 4 | 4 | install.sh 未验证 |
| 失败恢复 | 5 | 5 | = |
| 协议完整性 | 5 | 5 | 2 个新协议章节 |
| **总** | **97** | **94** | **-3（新表面引入新风险）** |

## 生产判断

**🟢 可立即用于生产**

理由：
1. 318/318 测试全绿，6/6 CI job 全绿
2. 4 个真实生产 bug 全闭环
3. 协议-代码-测试三方一致
4. 红线全合规（无 secret / 无 force push 历史 / 无 ~/.claude 修改）
5. 6 个遗留风险全为 P2/P3，无 P0/P1 阻塞

## 5 个改进建议（按优先级）

| # | 建议 | 优先级 | 工作量 |
|---|---|---|---|
| 1 | 给 4 个 buginfo 加 RESOLVED 标记（atdo-001~004） | P3 | 极小 |
| 2 | 升级 CI action 到 Node 24 版本（应对 2026-09 弃用） | P2 | 小 |
| 3 | install.sh 审计是否兼容 doc/ + _proc-use/ 新结构 | P3 | 中 |
| 4 | cmdAdvancePhase 重构：内联 setPhase 核心逻辑，去 spawnSync 开销 | P3 | 中 |
| 5 | commitlint 本地启用方式文档化（`npx --yes @commitlint/cli@19`） | P3 | 极小 |

不做这些不影响生产可用性。
