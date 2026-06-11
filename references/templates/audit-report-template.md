# 阶段审计报告

<!-- 此模板由 atdo 的 Agent（gsd-code-reviewer）使用。
     {{placeholder}} 语法由 LLM 直接填充，无需程序化模板引擎。 -->

**阶段**: {{phaseNumber}} - {{phaseName}}
**审计时间**: {{auditTimestamp}}
**审计 Agent**: gsd-code-reviewer
**状态**: {{auditStatus}}

---

## 审计摘要

| 维度 | 结果 |
|------|------|
| 代码规范 (lint) | {{lintResult}} |
| 语法正确性 | {{syntaxResult}} |
| 变更范围 (diff) | {{diffResult}} |
| 调试残留 | {{debugResidueResult}} |
| 密钥安全 | {{secretResult}} |
| 类型安全 | {{typeResult}} |
| 依赖正确性 | {{dependencyResult}} |

---

## 发现的问题

### BLOCKER (必须修复)

{{#each blockers}}
- **{{severity}}**: {{description}}
  - 文件: `{{file}}`
  - 行号: {{line}}
  - 建议修复: {{suggestion}}
{{/each}}

{{#if noBlockers}}
无 BLOCKER 级别问题。
{{/if}}

### WARNING (建议修复)

{{#each warnings}}
- **{{severity}}**: {{description}}
  - 文件: `{{file}}`
  - 建议修复: {{suggestion}}
{{/each}}

{{#if noWarnings}}
无 WARNING 级别问题。
{{/if}}

### INFO (参考信息)

{{#each infos}}
- {{description}}
{{/each}}

{{#if noInfos}}
无 INFO 级别提示。
{{/if}}

---

## 修改文件清单

{{#each changedFiles}}
- `{{path}}` ({{additions}}+ / {{deletions}}-)
{{/each}}

---

## 安全性检查

| 检查项 | 状态 |
|--------|------|
| 硬编码密钥 | {{hardcodedSecret}} |
| 敏感文件变更 (.env/.pem/.key) | {{sensitiveFileChange}} |
| 不安全的依赖引入 | {{unsafeDependency}} |

---

## 审计结论

{{auditConclusion}}

---

*此报告由 atdo 自动生成*
