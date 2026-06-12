# 关口回归测试报告

<!-- 此模板由 atdo 的 Agent（gsd-integration-checker）使用。
     {{placeholder}} 语法由 LLM 直接填充，无需程序化模板引擎。 -->

**关口**: {{gateLabel}}
**测试时间**: {{testTimestamp}}
**覆盖阶段**: {{phaseRange}}
**测试 Agent**: gsd-integration-checker
**状态**: {{testStatus}}
**测试方法学**: {{methodology}} (proxy|real|mixed — Bug-05 强制字段,SKILL.md L710 协议;orchestrator 据此判定 gate 是否需人工放行;proxy 报告不构成 gate 通过的充分证据)
**是否为 manual gate 阶段**: {{isManualGate}} (true|false)
**manual gate 协议状态**: {{manualGateProtocol}} (n/a|awaiting_user_review|user-review-pass|user-review-fail;Bug-06 新增)

---

## 测试摘要

| 维度 | 结果 |
|------|------|
| 单元测试 (增量) | {{unitTestResult}} |
| 集成测试 (跨阶段) | {{integrationTestResult}} |
| 类型检查 | {{typeCheckResult}} |
| Lint 检查 | {{lintCheckResult}} |
| 构建验证 | {{buildResult}} |

---

## 回归测试结果

### 已有测试用例 (回归)

| 测试套件 | 通过 | 失败 | 跳过 | 变化 |
|----------|------|------|------|------|
{{#each regressionSuites}}
| {{name}} | {{passed}} | {{failed}} | {{skipped}} | {{delta}} |
{{/each}}

### 新增测试用例

| 测试用例 | 状态 | 覆盖内容 |
|----------|------|----------|
{{#each newTests}}
| {{name}} | {{status}} | {{coverage}} |
{{/each}}

---

## 跨阶段集成验证

### 接口契约检查

| 接口 | 提供方 (阶段) | 消费方 (阶段) | 状态 |
|------|-------------|-------------|------|
{{#each interfaceChecks}}
| {{interface}} | {{provider}} | {{consumer}} | {{status}} |
{{/each}}

### 数据流验证

| 数据流 | 起点 | 终点 | 状态 |
|--------|------|------|------|
{{#each dataFlows}}
| {{flow}} | {{source}} | {{target}} | {{status}} |
{{/each}}

---

## 发现的问题

### BLOCKER (必须修复)

{{#each gateBlockers}}
- **{{severity}}**: {{description}}
  - 受影响阶段: {{affectedPhases}}
  - 建议修复: {{suggestion}}
{{/each}}

{{#if noGateBlockers}}
无 BLOCKER 级别问题。
{{/if}}

### WARNING (建议关注)

{{#each gateWarnings}}
- {{description}}
{{/each}}

{{#if noGateWarnings}}
无 WARNING 级别问题。
{{/if}}

---

## 修复记录

{{#each fixRecords}}
### 修复尝试 {{attempt}}

- 修复内容: {{description}}
- 修复结果: {{result}}
- 修复后测试: {{retestResult}}
{{/each}}

---

## 关口结论

**综合判定**: {{gateVerdict}}

{{gateDetails}}

---

*此报告由 atdo 自动生成*
