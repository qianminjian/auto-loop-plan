# atdo-001: 工作区脏检查阻断启动（P2）

## 症状
atdo Step 0a 检测到工作区不干净，拒绝启动：
```
[FATAL] 工作区不干净，atdo 协议要求除 .phase-execution/ 外无任何未提交改动
 M docs/design/v3.5-parallel-architecture.md
 M docs/design/v3.6-architecture.md
 M docs/design/v3.6-quality-execution.md
 M references/parallel-mode.md
?? docs/design/v4.0-architecture.md
```

## 根因
planning/design 阶段产生的设计文档（SUPERSEDED 标记、v4.0 主方案）未提交。这些文件是 atdo 执行的前置产物，但不是"脏工作区"的合理拦截对象——它们本身就是 atdo 计划的一部分。

## 复现条件
- Plan Mode 中产出了设计文档变更
- ExitPlanMode 后直接 `/atdo`，未手动提交

## 修复建议
atdo Step 0a 增加检测：如果脏文件全部是 `docs/design/` 下的设计文档，自动询问用户是否先提交再继续，而不是直接 FATAL。或者 `/atdo` 启动时自动 stash + 执行 + unstash。

## 优先级
P2 — 不阻塞功能，但增加手动步骤，影响自动化体验。

## 关联
Phase 01 启动时触发，手动 `git add + git commit` 后恢复。
