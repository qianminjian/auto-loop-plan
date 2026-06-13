# atdo-003: methodology=proxy 报告的 Gate 处理流程缺失（P1）

## 症状
Phase 02 gsd-executor 返回 `methodology=proxy`：
```
[AUTO-EXEC-RESULT: status=SUCCESS, methodology=proxy, files=10, tasks_done=10, errors=0]
```
按 Bug-05 协议，proxy 报告不得自动通过 Gate。但协议没有明确定义 orchestrator 的**标准恢复流程**——orchestrator 需要"人工判断 proxy 是否可接受"还是"自动跑 orchestrator-direct 验证"？

## 根因
Bug-05 定义了"proxy 报告 ≠ Gate PASS"的原则和 manual gate 触发条件，但没有定义：
1. orchestrator 在检测到 proxy 报告后的**标准操作序列**
2. 什么情况下 proxy 是可接受的（如：bash 脚本的 mock fixture 测试）
3. orchestrator-direct 验证的结果如何与 agent proxy 报告合并

## 实际处理（本次）
Orchestrator 手动跑了 `bash _proc-use/tests/run-all.sh`（real bash 执行），确认 41/41 测试 PASS。由于测试是真实 bash 执行（非模拟），判定 methodology=proxy 仅指 TDD fixture 使用了 mock 数据，核心验证是真实的。

## 修复建议
atdo 协议 §Verification Protocol 增加：
- **proxy 可接受条件白名单**：如果 agent 声明 methodology=proxy 但 orchestrator-direct 验证（bash -n + run-all.sh + 文件存在性）全部 PASS，则 proxy 可接受（因为 bash 脚本的单元测试天然使用 mock fixture，这是行业标准做法）
- **proxy 不可接受条件**：如果 orchestrator-direct 验证 FAIL，或 agent 声称"端到端测试通过"但实际用 `sleep 0.05s` 模拟 AI 推理
- **标准化恢复流程**：检测 proxy → 立即跑 orchestrator-direct 验证 → PASS 则放行 / FAIL 则触发 fix loop

## 优先级
P1 — Bug-05 原则正确，但缺少可操作的恢复协议，导致 orchestrator 每次都要即兴发挥。

## 关联
Phase 02 Gate G2 触发。
