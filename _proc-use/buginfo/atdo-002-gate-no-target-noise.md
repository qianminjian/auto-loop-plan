# atdo-002: Gate 脚本在无目标项目环境中的噪声失败（P2）

## 症状
Phase 01 Gate G1 跑 `bash scripts/check-all.sh` 时 5 个 step 中 3 个报告 FAIL：
```
1/5 元信息头校验 → FAIL（asset-docs 目录不存在）
3/5 一致性校验   → FAIL（src 不存在）
5/5 Gate D       → FAIL（.phase-facts.md not found）
```
实际上这些"失败"不是脚本 bug——本 repo 是 skill 开发项目，没有目标 Java 代码可分析。

## 根因
`check-all.sh` 的设计假设它总是在"有 asset-docs/ 产出的目标项目"中运行。在 skill 自身的开发 repo 中，asset-docs/ 和 SRC_DIR 都不存在。`check-meta.sh`、`check-consistency.sh`、`check-phase-facts.sh` 没有"无目标项目"的优雅降级模式。

## 复现条件
在 study-code-output-standard repo 本身跑 `check-all.sh`（无目标 Java 项目）。

## 修复建议
1. `check-all.sh` 增加 `--no-target-project` 标志，跳过依赖 asset-docs/ 和 SRC_DIR 的 step
2. 或各子脚本在缺少必要目录时输出 "SKIP: no target project" 并 exit 0（而非 "ERROR: ..." 并 exit 1）
3. atdo Gate 检测增加"预期失败"白名单——如果 plan 声明了 `gate_noise_expected: true`，允许特定 step 失败

## 优先级
P2 — 不影响核心功能，但在 atdo 自动化流程中产生误导性 FAIL 输出，需要人工判断是否为真实失败。

## 关联
Phase 01/02/03 Gate G1/G2/G3 均触发，每次都需要 orchestrator 人工判断。
