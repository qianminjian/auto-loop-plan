## 改动概述
<!-- 1-2 句说明本 PR 做了什么 -->

## 关联
- 关联 buginfo: atdo-NNN
- 关联 finding: P[0-3]-NN（如适用）
- 关联 issue: #NNN（如适用）

## 改动类型
- [ ] feat / fix / docs / refactor / test / chore / perf / ci / security

## 协议-代码-测试三方一致性自检
- [ ] SKILL.md 协议章节已同步（如改动协议）
- [ ] phase-state.js 命令实现已完成（如新增命令）
- [ ] atdo.test.js 测试已新增（TDD red 已转 green）
- [ ] README 命令清单已同步（如新增命令）

## 红线自查
- [ ] 无 `git push --force` / `git reset --hard` / `git rm`（除非已与维护者确认）
- [ ] 无 .env / *.key / *.pem / credentials.* 等密钥硬编码
- [ ] 无 ~/.claude/ 配置修改
- [ ] commit message 符合 Angular convention，subject ≤ 100 chars

## 测试覆盖
- 本地 `node _proc-use/reports/atdo.test.js`: ___/___ pass
- CI 状态: ⏳ pending / ✅ green / ❌ red

## AI Review 触发（可选）
- [ ] 已运行 `/gsd-code-review` 并附 review report
- [ ] review report 位置: `_proc-use/reports/REVIEW-<PR>-<date>.md`

## 其他备注
<!-- 任何 reviewer 需要知道的上下文 -->
