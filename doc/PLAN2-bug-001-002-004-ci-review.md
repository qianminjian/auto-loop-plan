# atdo Plan 2: atdo-001 / 002 / 004 + 完整 CI/Review 流程

> **状态**：占位文件。Plan 2 的详细内容**待 Plan 1 完成 + GitHub Actions 全绿 + 用户明确"启动 Plan 2"指令后再展开规划**。
>
> 当前仅声明范围与触发条件，不展开实施细节。

---

## 触发条件

满足全部 3 条才能启动 Plan 2 详细规划：

1. ✅ Plan 1（`PLAN1-infra-atdo003.md`）全部 6 个 commit 完成
2. ✅ GitHub Actions test + markdown-lint 全绿
3. ✅ 用户明确指令："启动 Plan 2 规划" / 类似

---

## Plan 2 范围（声明，不展开）

### Bug 修复（3 个 P2）

| Bug | 设计要点（来自 Plan 1 审计 finding） |
|---|---|
| **atdo-001 P2** | `check-workspace --suggest` 智能识别豁免目录（项目设计文档目录，如 `doc/` / `docs/` / `_proc-use/buginfo/` / `.phase-execution/` 等约定俗成位置）。SKILL.md Step 0a 改用此命令。 |
| **atdo-002 P2** | 协议层 `gate_noise_expected` 白名单。cmdInit 解析 phase.gate_noise_expected 数组，校验对齐 cmdInit 现有阈值（每元素 ≤ 500、最多 50 个）。cmdGetCurrentPhase 输出此字段。SKILL.md 第 7 步加 § Gate Noise Whitelist。 |
| **atdo-004 P2** | `advance-phase` 批量推进。**修订**（来自 Plan 1 审计 F3）：按 phase.gateType 决策终点：auto → 推到 `completed`；manual/hybrid → 推到 `gated`。awaiting_user_review / completed → die。 |

### CI Jobs 补全（3 个）

| Job | 关键修订（来自 Plan 1 审计） |
|---|---|
| **shell-lint** | shellcheck `scripts/watchdog.sh`（用 ludeeus/action-shellcheck@2.0.0） |
| **commit-lint** | wagoid/commitlint-github-action@v6。F11 修订：`subject-max-length: [2, 'always', 100]` 中文友好。 |
| **secret-scan** | F9 修订：用 `git diff origin/main...HEAD --name-only` 取 PR diff；CI 内 `init` 临时 state；遍历变更文件调 `phase-state.js sanitize`；任一密钥触发 → fail。写出**可执行 bash**，不留伪代码。 |

### Review 流程

| 项 | 内容 |
|---|---|
| `.github/pull_request_template.md` | PR 模板（关联 buginfo / finding ID / 改动类型 / 三方一致性自检 / 红线自查 / AI Review 触发） |
| `doc/REVIEW-PROTOCOL.md` | Review checklist（协议层 / 代码层 / 测试层 / 红线层 / 跨 finding 影响层） |
| `.githooks/pre-commit` | 可选 pre-commit hook（不修改用户 git 配置，README 说明启用方式） |
| AI 自审协议 | 用户手动调 `/gsd-code-review`；review report 写到 `_proc-use/reports/REVIEW-<PR>-<date>.md` |

### README 同步

- 命令清单 20 → 22（新增 check-workspace / advance-phase；Plan 1 已加 proxy-recovery-decision）
- bug 修复记录章节加 atdo-001 / 002 / 003 / 004
- CI badge 状态确认（Plan 1 已加占位）

---

## 估算

- **Stage C** (atdo-001 P2): 3 commits
- **Stage D** (atdo-004 P2): 3 commits
- **Stage E** (atdo-002 P2): 3 commits
- **Stage F** (CI/Review 补全): 3-4 commits
- **Stage G** (收尾): 1-2 commits

**Plan 2 总 commits**: ~13-15

---

## 关键决策依赖（待 Plan 1 完成后再定）

- 豁免目录列表是否硬编码可接受（F4 YAGNI vs 可配置）
- gate_noise_expected 校验阈值具体数值（F5 对齐 cmdInit）
- pre-commit hook 是否包含 lint（性能 vs 完整性）
- AI Review 是否需要自动化触发（vs 用户手动）

这些决策点待 Plan 2 启动规划时通过 AskUserQuestion 确认。

---

## 后续

Plan 1 完成后，等用户明确"启动 Plan 2 规划"指令后，本文件将被展开为完整 Plan（参照 Plan 1 结构）。
