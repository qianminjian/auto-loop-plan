# BEACON: atdo — 全自动分阶段项目编排器
> 创建：2026-06-13 | 更新：2026-06-13 | 阶段：实现

## 目标与成功标准
- **核心目标**：让 atdo 在零外部依赖（纯 Node + 内置 test runner）约束下保持 S 级生产就绪（≥95/100）
- **成功标准**：318 测试 100% 通过 + 4 个真实生产 bug 全闭环 + 6 CI jobs 全绿
- **当前价值**：用作 Claude Code Skill，按任意 plan 自动跑多阶段开发；单 turn 单 phase + CronCreate 跨 turn 续航

## 范围边界
**做：** Skill 主体 + Node 状态机（22 命令）+ 内置测试（318 个）+ GitHub Actions CI（6 jobs）+ 设计文档统一在根目录 `doc/`
**不做：** 引入 npm 依赖 / 修改外部目标项目 / 强制 CODEOWNERS / 自动 git push / 修改用户 git 配置

## 设计决策
| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| D1 | 单 turn 单 phase + CronCreate 续航 | LLM 单 turn 上下文物理限制 | v2.0 |
| D2 | Trust Nothing：orchestrator 不信任 agent 任何声明 | agent 幻觉风险 | v2.0 |
| D3 | 零外部依赖（纯 Node 内置） | 部署门槛低 + 跨平台一致 | v2.0 |
| D4 | atomic write + 4 级 backup fallback | kill -9 不损坏状态 | v2.0.x |
| D5 | proxy-recovery-decision 强制 evidence | Bug-05 合规口子是 orchestrator-direct real validation | Plan 1 |
| D6 | 设计文档统一根目录 `doc/`，纳入 git | 消除 `_proc-use/design/` 与 `_proc-use/docs/` 重叠 | Plan 1 |
| D7 | 撤销 push-public.sh，直接 git push（_proc-use/ 进 GitHub）| amend 模式产生历史分叉，本末倒置 | Plan 1 |
| D8 | atdo-001 豁免目录硬编码（F4 YAGNI）| `.phase-execution/` / `doc/` / `_proc-use/` / `.serena/` 覆盖项目实际场景 | Plan 2 |
| D9 | advance-phase 按 gateType 决策终点（F3 修订）| auto→completed / manual→gated；避免越过 manual gate | Plan 2 |

## 当前状态
**阶段：** Plan 1 + Plan 2 全部完成
**最近动作：** Stage H 收尾（README 修复记录 + CI 状态表 + BEACON D8/D9）
**下一步：** push GitHub 触发 6 CI jobs 验证全绿
**阻塞项：** 无

## 设计演进日志
| 日期 | 变更 | 原因 |
|------|------|------|
| 2026-06-13 | Plan 2 完成（atdo-001/002/004 + CI 6 jobs + Review 流程）| 真实生产 bug 闭环 + CI/Review 基础设施完整化 |
| 2026-06-13 | D9：advance-phase 按 gateType 决策终点 | F3 审计 finding 修订 |
| 2026-06-13 | D8：atdo-001 豁免目录硬编码 | F4 YAGNI；覆盖 doc/ _proc-use/ .serena/ .phase-execution/ |
| 2026-06-13 | D7：撤销 push-public.sh 方案 | amend 模式产生历史分叉 |
| 2026-06-13 | D6：设计文档统一根目录 `doc/` | 消除 _proc-use/design/ 与 docs/ 重叠 |
| 2026-06-13 | D5：proxy-recovery 强制 evidence | F1 防 agent 自报告 auto-pass |
| 2026-06-12 | v2.0.1 11 个生产故障修复 + S 级 97/100 | 首次外部生产运行反馈 |
| 2026-06-11 | v2.0 双审融合 | v1 设计 LLM 内循环不可行 |

## 待解决问题
- 无（Q1/Q2 已由 Plan 2 解决；Q3 由 D7 间接解决）

## 引用文件
- `@doc/PLAN1-infra-atdo003.md` — Plan 1 执行（基础设施 + atdo-003 P1）
- `@doc/PLAN2-bug-001-002-004-ci-review.md` — Plan 2 执行（atdo-001/002/004 + CI/Review）
- `@doc/DESIGN.md` — v2.0 双审融合架构稿
- `@doc/REVIEW-PROTOCOL.md` — 5 层 PR review checklist
- `@_proc-use/buginfo/atdo-00{1,2,3,4}-*.md` — 4 个真实生产 bug 报告

