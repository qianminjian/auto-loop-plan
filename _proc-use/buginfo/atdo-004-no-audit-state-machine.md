# atdo-004: --no-audit 模式下状态机手动推进繁琐（P2）

## 症状
Phase 01/02/03 均使用 `--no-audit` 跳过 gsd-code-reviewer spawn。但协议要求状态机仍走 `executed → audited → fixed → gated`，需要 orchestrator 手动逐条执行：
```bash
node phase-state.js set-phase N executed
node phase-state.js set-phase N audited
node phase-state.js set-phase N fixed
node phase-state.js set-phase N gated
```

## 根因
`--no-audit` 的设计意图是"跳过 audit agent spawn 但不跳过状态机推进"。但协议没有提供批量推进命令（如 `set-phase N audited --skip-agent` 自动完成 audited→fixed→gated）。

## 修复建议
`phase-state.js` 增加 `advance-phase <phaseId>` 命令：
```bash
node phase-state.js advance-phase 01  # 自动: executed → audited → fixed → gated
```
等价于连续执行 4 次 set-phase，但一次调用完成。适用于 --no-audit 或 audit 报告无 blocker 的场景。

## 优先级
P2 — 不阻塞功能，但每 Phase 多 4 次手动命令调用，降低自动化程度。

## 关联
全部 3 个 Phase 均触发。
