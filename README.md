# atdo

> Claude Code Skill · 全自动分阶段项目编排器(v2.0)

按任意格式的项目计划,**单 turn 单阶段**串行执行。每阶段自动:执行 → 独立验证 → 审计 → 修复(≤3 次)→ 关口集成测试 → commit。失败累积触发 3-strike 告警退出。

---

## 快速开始

```bash
# 在项目根目录调用 skill(项目根需有 git 仓库)
/atdo .planning/ROADMAP.md                 # 默认从阶段 1 执行到结束
/atdo .planning/ROADMAP.md --dry-run       # 只解析计划,展示阶段不执行
/atdo .planning/ROADMAP.md --from 3        # 从阶段 3 开始
/atdo .planning/ROADMAP.md --only 2        # 只执行阶段 2
/atdo .planning/ROADMAP.md --resume        # 从 .phase-execution/state.json 恢复
/atdo .planning/ROADMAP.md --no-audit      # 跳过审计(快速模式)
AUTO_PHASE_NO_CONFIRM=true /atdo plan.md   # 完全无人值守(跳过所有检查点)
```

## 参数

| 参数 | 效果 |
|------|------|
| `<plan-file>` | 项目计划文件(GSD ROADMAP / JSON `phases[]` / 自由 Markdown) |
| `--from N` | 从阶段 N 开始 |
| `--to N` | 执行到阶段 N 后停止 |
| `--only N` | 只执行阶段 N |
| `--resume` | 从 `state.json` 恢复(适合中断后) |
| `--dry-run` | 解析计划、显示阶段,不执行 |
| `--no-audit` | 跳过审计步骤(快速模式) |
| `--force-dirty` | 允许在脏工作区执行(diff 判断会失准) |
| `AUTO_PHASE_NO_CONFIRM=true` | 跳过所有检查点 |

## 工作流(单阶段,每 turn 一个)

```
[CHECKPOINT] 阶段 N/M: <name> — 'c' 继续 / 's' 跳过 / 'a' 终止
  1. Pre-flight        依赖阶段 completed?记录 baseline commit
  2. Agent 执行        gsd-executor → 解析 [AUTO-EXEC-RESULT] 标记
  3. 独立验证          文件存在/语法/diff 范围/调试残留/密钥 — 编排器直跑
  4. Agent 审计        gsd-code-reviewer → 写入 audit-report.md
  5. 修复循环          最多 3 次(gsd-code-fixer)
  6. 关口检测          is_gate / depends_on / 每 2 阶段 / 最后一阶段
  7. Gate 集成测试     gsd-integration-checker + lint + jest --findRelatedTests
  8. Git commit        仅关口通过时,精确 add + 提交 + 记录 hash
  9. 状态持久化        atomic write + backup + CronCreate (durable, 跨会话续)
```

## 三档计划解析

1. **GSD ROADMAP** — `.planning/ROADMAP.md` 存在时走 `gsd-tools`
2. **结构化** — JSON / YAML `phases[]` 数组,直接解析
3. **自由 Markdown** — LLM 提取 `## Phase N:` 章节,提取后**必须经检查点确认**

解析失败 / 检测到环依赖 / 阶段 > 15 任务 → 告警退出,不静默执行。

## 运行时产物

```
<project>/.phase-execution/                # 加入项目 .gitignore
├── state.json                              # 主状态(atomic write + .bak.1/2/3)
├── state.json.tmp                          # 写入中(被忽略)
├── heartbeat.json                          # 当前阶段心跳
├── progress.md                             # 人类可读进度
├── lock                                    # 并发锁({pid, startTime, hostname})
├── ALERT.md                                # 严重告警(3-strike 触发时)
├── phases/<N>/
│   ├── plan-snippet.md                     # ≤500 字(上下文预算)
│   ├── execution-log.md
│   ├── audit-report.md                     # 脱敏后写入
│   ├── fix-log.md
│   └── summary.md                          # ≤500 字(供后续 turn 加载)
├── gates/<label>/
│   └── integration-test-report.md
└── archive/                                # 已完成阶段的详细日志
```

## 硬约束(红线)

### 基础红线(全局)

| 类别 | 规则 |
|------|------|
| 网络 | `git push` / `git push --force` / `git reset --hard` **禁止** |
| 文件 | `rm` / `git rm` / `git add -A` **禁止** — 只 `git add <精确文件>` |
| 密钥 | `.env` / `*.key` / `*.pem` / `id_rsa*` / `credentials.*` / `secrets.*` 写入检查正则阻断 |
| 系统 | `~/.claude/` 配置 **禁止修改** |
| 服务 | 启动前 `lsof -i:<port>` 检查 |
| 退出 | 同阶段 3 次失败 / 回归 ≥ 2 / 同类问题 ≥ 5 → ALERT.md + 解锁 + exit |
| 上下文 | 单 turn ≤ 500 字计划摘要 + ≤ 500 字已完成阶段 summary,详情归档 |

### v2.0 协议红线(P2-26 补 — 11 个 fix 引入的新硬约束)

| 类别 | 规则 | 来源 |
|------|------|------|
| 状态机 | phase 状态机严格 `pending → in_progress → executed → audited → fixed → gated → completed`(`--no-audit` 仅跳过 agent spawn,状态机仍走 `executed → audited` 自动完成) | Bug-06 / P1-4 |
| 关口 | manual gate 期间 phase.status = `awaiting_user_review`,orchestrator 不调 CronCreate,等用户答复 | Bug-06 |
| unlock | `unlock` 必须显式带 `--reason={all-completed|aborted|alert}`,空值 FATAL | Bug-08 |
| lock 注入 | `acquireLock` 用 `execFileSync` 参数化,pid 必须正整数 | Bug-08 (P1-C) |
| checkpoint | `record-confirm <phaseId> <decision>` decision ∈ `{c, s, a}`;同一 phase 最多 10 条确认(超限 FATAL) | Bug-07 / P2-15 |
| summary | `summary.md` 字符数 ≤ 500(Unicode code point 数,emoji 按 1 char) | Bug-10 / P2-16 |
| log 命名 | 阶段产物 `{phaseId}-{stepName}-{index}.{ext}` 软约束;位置 `_proc-use/<phaseId>/`(长期归档) / `.phase-execution/phases/<id>/`(atdo runtime transient) | Bug-11 / P2-3 |
| 安全 | 路径白名单(sanitize 只处理 `.phase-execution/` 内文件);敏感文件检测(`.env` / `id_rsa*` / `credentials.*` 等) | P0 / P1-1 |
| 状态漂移 | `state.json` 是 single source of truth,plan 与 state 用 md5(`planHash`)检测漂移 | Bug-09 |
| commit 主体 | Gate Phase: orchestrator 强制在 phase 收尾 commit;非 Gate Phase: agent 内部原子 commit | Bug-04 |
| method 强制 | `[AUTO-EXEC-RESULT]` marker 必须含 `methodology=proxy|real|mixed` 字段(gsd-executor / reviewer / fixer / integration-checker 全部适用) | Bug-05 / P1-1 |
| watchdog | `awaiting_user_review` 期间 watchdog 跳过心跳超时判定 | P1-3 |

## 测试状态

```bash
node _proc-use/reports/atdo.test.js
```

| 项目 | 数量 |
|------|------|
| 测试套件 | 48 |
| 测试用例 | 210 |
| 通过率 | 100% |

覆盖:init / get / set-phase / get-current / inc-strike / record-commit / sanitize / check-disk / heartbeat / lock / backup rotation / E2E 完整流程 + 9 个安全注入回归(路径穿越、命令注入、LLM 幻觉、敏感文件检测、P2 6 项加固)。

## 文件清单

```
SKILL.md                                   # 主编排器(1477 行)
scripts/phase-state.js                     # 13 个状态管理命令(1101 行,零依赖)
scripts/watchdog.sh                        # 孤儿进程清理 + 心跳检查
references/templates/
├── audit-report-template.md               # 审计报告模板
└── integration-test-report-template.md    # 集成测试报告模板
```

完整协议见 `SKILL.md`。本文档只列日常使用,详细执行逻辑以 `SKILL.md` 为准。
