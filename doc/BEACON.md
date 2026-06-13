# BEACON: atdo — 全自动分阶段项目编排器
> 创建：2026-06-13 | 更新：2026-06-13 | 阶段：实现

## 目标与成功标准
- **核心目标**：让 atdo 在零外部依赖（纯 Node + 内置 test runner）约束下保持 S 级生产就绪（≥95/100）
- **成功标准**：282 测试 100% 通过 + 11 个 P0/P1 协议红线全覆盖 + 真实外部生产运行（study-code-output-standard）的 4 个 buginfo 闭环修复
- **当前价值**：用作 Claude Code Skill，按任意 plan 自动跑多阶段开发（execute → audit → fix → gate → commit），单 turn 单 phase + CronCreate 跨 turn 续航

## 范围边界
**做：** Skill 主体（SKILL.md 协议）+ Node 状态机（phase-state.js 19+ 命令）+ 内置测试（atdo.test.js node:test）+ GitHub Actions CI 骨架 + 设计文档统一到 `doc/`
**不做：** 引入 npm 依赖 / 修改外部目标项目 / 强制 CODEOWNERS / 自动 git push / 加 IDE 配置

## 设计决策
| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| D1 | 单 turn 单 phase + CronCreate 续航 | LLM 单 turn 上下文物理限制；ScheduleWakeup 需 /loop 模式不通用 | v2.0 |
| D2 | Trust Nothing：orchestrator 不信任 agent 任何声明 | agent 幻觉风险，所有断言必须独立 shell 验证 | v2.0 |
| D3 | 零外部依赖（纯 Node 内置） | 部署门槛低 + 跨平台一致 + 无供应链风险 | v2.0 |
| D4 | atomic write + 4 级 backup fallback（state.json） | kill -9 不损坏状态 + 历史 3 版本回溯 | v2.0.x |
| D5 | proxy-recovery-decision 命令强制 evidence | Bug-05 合规口子是 orchestrator-direct real validation，非 agent 自报告 | Plan 1 (2026-06-13) |
| D6 | 设计文档统一到根目录 `doc/`，纳入 git | 消除 `_proc-use/design/` 与 `_proc-use/docs/` 重叠；让 BEACON/DESIGN/PLAN 对外可见 | Plan 1 (2026-06-13) |

## 当前状态
**阶段：** Plan 1 实施中（基础设施 + atdo-003 P1）
**最近动作：** A1 设计文档合并到根目录 doc/，进入 git 跟踪
**下一步：** A2 atdo.test.js 加入 git → A3 CI 骨架（hard gate）→ B1/B2/B3 atdo-003 修复
**阻塞项：** 无

## 设计演进日志
| 日期 | 变更 | 原因 |
|------|------|------|
| 2026-06-13 | 设计文档统一到根目录 `doc/`（含 BEACON/DESIGN/PLAN/archive） | 用户决策，消除 `_proc-use/design/` 与 `_proc-use/docs/` 双目录重叠 |
| 2026-06-13 | Plan 1 拆分（原 17-20 commits → 6 commits） | 审计 finding F14，降低单 plan 风险 |
| 2026-06-13 | proxy-recovery 命令强制 --evidence 参数 | 审计 finding F1，防 agent 自报告绕过 Bug-05 |
| 2026-06-12 | v2.0.1 11 个生产故障修复 + S 级 97/100 | 首次外部生产运行（study-code-output-standard）反馈 |
| 2026-06-11 | v2.0 双审融合：单 turn 单 phase 修正 | v1 设计 LLM 内循环不可行 |

## 待解决问题
- [Q1] atdo-002 协议层 gate_noise_expected 阈值（移 Plan 2）
- [Q2] atdo-004 advance-phase 按 gateType 决策终点（移 Plan 2）
- [Q3] _proc-use/buginfo/ 是否进 git 追踪（当前 atdo-001~004 仅本地可见）

## 引用文件
- `@doc/PLAN1-infra-atdo003.md` — 当前执行 plan（Stage A + B）
- `@doc/PLAN2-bug-001-002-004-ci-review.md` — Plan 2 占位（待 Plan 1 完成）
- `@doc/DESIGN.md` — v2.0 双审融合架构稿（完整设计依据）
- `@doc/archive/README.v3.2-DEPRECATED.md` — v3.2 废弃稿（历史归档）
- `@_proc-use/buginfo/atdo-00{1,2,3,4}-*.md` — 4 个真实生产 bug 报告（仍在 _proc-use/，过程性）
