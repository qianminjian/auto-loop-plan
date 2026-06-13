# atdo Review Protocol

> 适用场景：PR review（人工或 `/gsd-code-review` 自动审）。按 5 个层次检查。

---

## 协议层 checklist（修改 SKILL.md 时）

- [ ] 新增章节有清晰标题（含 atdo-NNN / Bug-NN 来源标记）
- [ ] 章节交叉引用更新（其他章节如有引用本章节）
- [ ] Bug-NN 协议是否仍生效（特别注意 Bug-05/06/11 等核心协议）
- [ ] Trust Nothing 章节是否需扩展（13 项是否需补）
- [ ] PROCESS_FILE_POLICY 是否需更新（如新增目录约定）

## 代码层 checklist（修改 phase-state.js / watchdog.sh 时）

- [ ] 新增常量在文件顶部定义（与 SECRET_PATTERNS / VALID_STATUSES 等同级）
- [ ] 新增命令注册到 commands 表（L1332+）
- [ ] 错误消息含上下文（phaseId / pid / file / count / reason）
- [ ] 错误退出统一用 `die()`，不用 throw
- [ ] 命令复用既有 helper（readState / writeState / readJSON / SECRET_PATTERNS）
- [ ] 子进程调用用 `execFileSync` / `spawnSync` 参数化（防注入）

## 测试层 checklist（修改 atdo.test.js 时）

- [ ] TDD 严格 Red → Green（先 commit Red，再 commit Green）
- [ ] 新 describe 块独立 dir（before/after 创建/清理临时目录）
- [ ] 断言含 stderr 上下文（`assert.equal(r.code, 0, r.stderr)`）
- [ ] 边界测试覆盖（空输入 / 超长 / 非法类型 / 不存在 / 重复调用）
- [ ] e2e fixture test（协议级，模拟 orchestrator 行为）

## 红线 checklist（每个 PR 必查）

- [ ] 无 `rm` / `git rm` 删除文件（除非用户明确批准）
- [ ] 无 `.env` / `*.key` / `*.pem` / `id_rsa*` / `credentials.*` / `secrets.*`
- [ ] 无 `git push --force` / `git push --force-with-lease` / `git reset --hard` / `git rebase`
- [ ] 无 `~/.claude/` 配置修改
- [ ] 无外部目标项目修改（atdo 协议层修复，不动 target repo）
- [ ] commit message 符合 Angular convention，type ∈ {feat,fix,docs,style,refactor,test,chore,perf,ci,revert,security,hotfix}
- [ ] subject ≤ 100 chars（commitlint F11 阈值）

## 跨 finding 影响 checklist

- [ ] 当前 PR 是否触发既有 Bug 协议变化？（grep Bug-05 / Bug-06 / Bug-11 等）
- [ ] 其他 buginfo 是否被波及？（_proc-use/buginfo/atdo-*.md）
- [ ] 测试套件总数变化是否符合预期？（# tests N → N+M，M 应等于新增 describe 块的 test 数）
- [ ] state.json schema 变化是否向后兼容？（旧 state.json 缺新字段时所有命令仍正常工作）

---

## AI Review 触发方式

用户在 PR 描述里调 `/gsd-code-review`，agent 按本协议生成 review report：
- 路径: `_proc-use/reports/REVIEW-<PR>-<date>.md`
- 内容: 上述 5 个层次 checklist + 具体 finding（按严重度 P0/P1/P2/P3）
- 摘要贴 PR comment

决策权: 用户 merge（AI 仅建议，不自动 merge）。
