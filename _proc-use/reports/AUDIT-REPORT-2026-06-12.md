# atdo 11-bug-fix 综合审计报告

| 字段 | 值 |
|------|-----|
| 审计范围 | commits 7bfac12..e0ff8293(11 个 bug fix) |
| 审计日期 | 2026-06-12 |
| 审计 agent | 独立审计(只审不改) |
| 测试基线 | 206/206 通过(46 个 suite) |
| 审计范围文件 | SKILL.md / scripts/phase-state.js / scripts/watchdog.sh / _proc-use/reports/atdo.test.js / README.md |

---

## 严重度统计

- **P0**: 0
- **P1**: 6
- **P2**: 8
- **P3**: 5
- **总计**: 19

---

## 各维度 findings

### 维度 1:协议一致性(Protocol Consistency)

#### [P1] Bug-05 marker 协议未应用到 reviewer/fixer/integration-checker
- 位置:SKILL.md:L600 / L622 / L664
- 现象:Bug-05 强制 `methodology=proxy|real|mixed` 字段(只覆盖 gsd-executor L540),且 L1211-1212 明确"适用范围: Gate Phase 任何包含 [AUTO-EXEC-RESULT] marker 的 agent 调用;含 gsd-executor / gsd-code-reviewer / gsd-integration-checker"。但 gsd-code-reviewer(L600)、gsd-code-fixer(L622)、gsd-integration-checker(L664)三处 marker 模板均未加 `methodology=...` 字段。orchestrator 按 L1211 协议应在所有 agent 调用上做 methodology 校验,但只有 1/4 模板声明此字段。
- 证据:grep "AUTO-EXEC-RESULT" SKILL.md 命中 4 处,仅 L540 含 `methodology=`
- 建议:在 L600/622/664 三处 marker 模板中追加 `, methodology=proxy|real|mixed` 字段,或明确收窄适用范围只到 gsd-executor

#### [P1] `get-current-phase` 未返回 `awaitingUserReview: true`(协议承诺未兑现)
- 位置:SKILL.md:L951-956 / scripts/phase-state.js:cmdGetCurrentPhase(L662-699)
- 现象:SKILL.md "8. `get-current-phase` 在 manual gate 期间的行为" 明确:"phase.status === 'awaiting_user_review' → 返回 `{ number, name, isGate, gateType: 'manual', status, awaitingUserReview: true, ... }`。orchestrator 据此判断:'当前 phase 已在 manual gate 中,等用户答复'——不调 CronCreate"。但 `cmdGetCurrentPhase` 实现(L662-699)无任何 `awaitingUserReview` 字段返回;E2E 实测(`set-phase 02 awaiting_user_review` 后调 `get-current-phase`)仅返回 `status: "awaiting_user_review"`,没有 `awaitingUserReview: true`。orchestrator 必须靠"status 字符串"判断,失去声明式判断的健壮性。
- 证据:E2E 实测输出 `{"number":"02",...,"status":"awaiting_user_review",...}` 无 `awaitingUserReview` 字段
- 建议:`cmdGetCurrentPhase` 在 `phase.status === 'awaiting_user_review'` 时追加 `awaitingUserReview: true` 字段,同时考虑返回顶层 `state.awaiting_user_review` 对象

#### [P1] `watchdog.sh` 不读 `state.awaiting_user_review`(协议承诺未兑现)
- 位置:SKILL.md:L909-912 / scripts/watchdog.sh(check_heartbeat 函数)
- 现象:SKILL.md L909-912 明确 "watchdog 看到 `awaiting_user_review` 应正常 hold,不应判定'心跳超时'。`state.json` 顶层 `awaiting_user_review` 字段就是给 watchdog 看的'我在等用户,别动我'信号"。但 `check_heartbeat` 函数(L50-105)只读 `HEARTBEAT_FILE`,不读 `STATE_FILE`,自然不识别 `awaiting_user_review` 标记。手动 gate 期间若用户 10 分钟不回复,watchdog 会发 SIGTERM 给正在等用户的进程,违反协议。
- 证据:grep "awaiting_user_review\|user-review" scripts/watchdog.sh → 0 命中
- 建议:`check_heartbeat` 在判定超时前先读 state.json 顶层 `awaiting_user_review` 字段,若存在则跳过 ALERT

#### [P1] `--no-audit` 与状态机互锁矛盾
- 位置:SKILL.md:L8 / L157 / L587 / L612-628
- 现象:`--no-audit` SKILL.md 声明 "Skip audit step (fast mode)"(L157 / L587),但 Bug-06 引入的严格状态机要求 `executed → audited → fixed → gated → completed` 必经 audited(L612-628)。如启用 `--no-audit`,orchestrator 不能跳过 `set-phase ... audited`,会陷入矛盾:`--no-audit` 协议说跳过 audit,状态机说必须经过 audited,二者无法同时满足。
- 证据:grep "no-audit" _proc-use/reports/atdo.test.js → 0 命中(无测试);SKILL.md 两处声明相互冲突
- 建议:明确 `--no-audit` 是否仅跳过"agent audit 报告生成"但保留状态机 audited 状态(`executed → audited` 自动完成),或彻底从 SKILL.md 移除(不兼容状态机)

#### [P1] README.md 测试统计过期(110 → 实际 206)
- 位置:README.md:L100-102
- 现象:README 报告"测试用例 110 / 测试套件 18",实际是 206 / 46。过期近 1 倍,误导用户。
- 证据:`node _proc-use/reports/atdo.test.js` 输出 `# tests 206, # suites 46`
- 建议:更新 README.md:L100-102 到"测试用例 206 / 测试套件 46 / 通过率 100%"。同 README 还说"SKILL.md 462 行"和"phase-state.js 621 行"也已过期(实际 1467 / 1058 行)

#### [P1] `cmdSanitize` 与 SKILL.md 安全集成场景的端到端未测试
- 位置:SKILL.md:L1250-1257
- 现象:SKILL.md "Secret Leak Prevention" 描述了完整流程(agent 写日志 → sanitize → 记录到 securityEvents),但 E2E 集成测试(atdo.test.js:L687-742)未走此流程,且因 cmdSanitize 不写 securityEvents(见维度 3 P2-1),实际集成不完整。
- 建议:补 E2E 集成测试(写一个含密钥的 audit-report.md → sanitize → 验证 state.json.securityEvents 含事件)或修复实现

#### [P2] Bug-02 章节缺少 `Bug-02` 标记
- 位置:SKILL.md:L351 `## state.json Schema`
- 现象:其他 10 个 fix commit 在 SKILL.md 章节标题都加 `(Bug-XX)` 标记(如 `## 过程文件命名与位置规范 (Bug-11)` L80 / `## Plan vs State 一致性规则 (Bug-09)` L423 / `### Manual Gate Protocol (Bug-06)` L775 / `## summary.md 长度约束 (Bug-10)` L1083 / `#### Lock 持有语义 (Bug-08)` L204),但 Bug-02 章节标题 L351 是 `## state.json Schema`,没有 `(Bug-02)` 标识。读者无法追溯此章节来自哪个 fix commit。
- 证据:grep "Bug-02\|Bug-03" SKILL.md → 只有"组合 Bug 标记"提及,无章节锚点
- 建议:改 L351 为 `## state.json Schema (Bug-02)` 与其他 fix 章节保持一致

#### [P2] SKILL.md 编号冲突:两个 `### 9.` 章节
- 位置:SKILL.md:L957 与 L994
- 现象:`### 8.4 Commit 失败处理(无论 Gate / 非 Gate)` 之后(L768),下一节是 `### 9. 完整状态机总览`(L957),然后是 `### 9. Phase Completion + Continuation`(L994)。两个章节都用 `### 9.` 编号。中间缺 8.5/8.6/8.7/8.8。
- 证据:grep "^### 8\.4\|^### 9\." SKILL.md → 只有 8.4 和两个 9
- 建议:将 `### 9. 完整状态机总览` 改为 `### 8.5`(作为 8.4 的延续),`### 9. Phase Completion + Continuation` 保持 `### 9.`

#### [P2] Bug-11 位置约束与 SKILL.md 其他章节矛盾
- 位置:SKILL.md:L107-110 vs L596 / L604 / L660-661 / L1002-1014
- 现象:Bug-11 L107-110 明确"阶段产物:`_proc-use/<phaseId>/` 下"、"关卡产物:`_proc-use/gates/<label>/` 下"。但 SKILL.md L596/L604/L660-661/L1002-1014 实际示例均把阶段产物、关卡产物、summary.md 写到 `.phase-execution/phases/<id>/` / `.phase-execution/gates/<label>/`(运行时 transient 目录,gitignored)。`PROCESS_FILE_POLICY` 章节(L52-78)又把过程文件划到 `_proc-use/` 下。读者搞不清"atdo runtime 临时文件"和"长期过程文件"应放哪。
- 证据:grep "phases/<N>\|phases/<phaseId>\|gates/" SKILL.md → 一边是 `_proc-use/...` (L107-110),一边是 `.phase-execution/...` (L596, L1002-1014)
- 建议:在 Bug-11 章节补充"atdo runtime 产物(临时 / transient)→ `.phase-execution/...` / 长期归档产物 → `_proc-use/...`"的边界说明,或在 PROCESS_FILE_POLICY 中加 .phase-execution 引用

#### [P2] Bug-11 stepName "严格白名单" vs "软约束" 自相矛盾
- 位置:SKILL.md:L93 vs L131-138
- 现象:L93 说 `stepName: 白名单,严格从以下取一`(看起来是硬约束),L101 又说"新增类别需明文加白名单(不可临时加新值)"。但 L131-138 又说"不引入硬阻断——避免 agent 因小文件名不规范而拒绝 commit"。两段在同章节内:严格 vs 软约束,语义冲突。
- 证据:L93 "严格" vs L134-138 "软约束"
- 建议:统一为软约束并删除 L93 的"严格"措辞,或明确"严格白名单 = 文档级硬约束,扫描后 WARN,不阻断"的中庸方案

#### [P3] `SKILL.md:PROCESS_FILE_POLICY` 章节位置与 Bug-11 重复/层级错位
- 位置:SKILL.md:L36-78(`## Process File Containment Policy`)与 L80-146(`## 过程文件命名与位置规范 (Bug-11)`)
- 现象:两个章节均规定过程文件位置,前者用"硬性" PROJECT POLICY 语气(L36,L52-78 code block),后者用"软约束"(L131-138)。PROCESS_FILE_POLICY 强调"`_proc-use/dev/`, `_proc-use/docs/`, `_proc-use/reports/`, `_proc-use/buginfo/`"子目录分类;Bug-11 强调"`_proc-use/<phaseId>/` 阶段产物"。两个规范对 `_proc-use/` 的子结构设计不一致。
- 证据:两个章节对 _proc-use/ 子目录定义不同
- 建议:在 Bug-11 章节顶部加 cross-reference: "本规范与 Core Rules / Process File Containment Policy 配合使用;Bug-11 只规定命名 + 阶段产物位置,不替代核心 _proc-use/ 分类"

---

### 维度 2:代码质量(Code Quality)

#### [P2] `cmdGetCurrentPhase` 重复 cmdSummary 的游标推进逻辑
- 位置:scripts/phase-state.js:L662-699 (cmdGetCurrentPhase) vs L847-867 (cmdSummary)
- 现象:两个函数用相同代码块(L669-681 / L851-859)从 currentPhaseIndex 找第一个 !== completed 的阶段。违反 DRY 原则。如未来游标推进逻辑需改(例:跳过 `user-review-fail` 而非仅 completed),两处都要改。
- 证据:grep "currentPhaseIndex.*|| 0" scripts/phase-state.js 命中 2 处
- 建议:抽 `findCurrentPhase(state)` helper,两边复用

#### [P2] `ACTIVE_STATUSES` 常量定义后从未使用(死代码)
- 位置:scripts/phase-state.js:L51
- 现象:`const ACTIVE_STATUSES = ['pending', 'in_progress', 'executed', 'audited', 'fixed', 'gated', 'awaiting_user_review'];` 定义后,在 1058 行文件中无任何引用。
- 证据:grep "ACTIVE_STATUSES" scripts/phase-state.js → 仅 1 处定义
- 建议:删除未使用的常量,或用于 `get-current-phase` 的"是否 active"判断

#### [P2] `state.networkStatus` 和 `state.exitReason` 字段从未被命令读写(死字段)
- 位置:scripts/phase-state.js:L559-564
- 现象:`networkStatus` 和 `exitReason` 在 init 阶段初始化,但所有 13 个命令中无任何命令写它们。`cmdSummary`(L847-867)只读 `exitReason` 输出(总是 null)。
- 证据:grep "networkStatus\|exitReason" scripts/phase-state.js → 只有 init 初始化 + summary 读出
- 建议:删除未使用的字段,或实现 `set-network-status` / `set-exit-reason` 命令支持

#### [P3] `cmdInit` 中 `P[0-3]-\d` 检测 regex 与 SKILL.md 不完全一致
- 位置:scripts/phase-state.js:L397 / L429 vs SKILL.md:L313
- 现象:SKILL.md L313 协议 regex 是 `/^###\s+P[0-3]-(\d{1,2})\b/m`(用 `\d{1,2}` 限制 1-2 位 + word boundary),但 `cmdInit` 检测用 `/^###\s+P[0-3]-\d/m`(只用单 `\d`,无 word boundary)。差异:`### P0-100`(3 位数字)会被简化 regex 误判为 Tier 3.5,但 parseTaskListPlan(L326)用的 `\d{1,2}\b` 会拒绝。实际行为是先通过检测,后 parseTaskListPlan 拒绝——但错误消息可能不一致。
- 证据:grep "P\\[0-3\\]-\\d" vs "P\\[0-3\\]-(.*\\d{1,2})" SKILL.md / phase-state.js
- 建议:统一为 `\d{1,2}\b` 或在 SKILL.md 同步简化为 `\d`(明确说明多位数不进入索引语义)

#### [P3] `check-disk` 使用 `execSync` 走 shell,与 P1-C 修复风格不一致
- 位置:scripts/phase-state.js:L273-286
- 现象:Phase-state.js 在 `acquireLock` 中用 `execFileSync('ps', [...], ...)` 走参数化不经过 shell(P1-C 修复,防命令注入)。但 `check-disk` 用 `execSync('df -m . | tail -1', { encoding: 'utf8' })` 走 shell。`df -m . | tail -1` 的 `df` 不接受用户输入,实际无注入风险,但与 P1-C 风格不一致(应当全部用 `execFileSync`)。
- 证据:grep "execSync\|execFileSync" scripts/phase-state.js → 1 处 execSync,1 处 execFileSync
- 建议:改为 `execFileSync('df', ['-m', '.'], { encoding: 'utf8' })` + 单独处理 tail(如用 readline/split)

---

### 维度 3:安全性(Security)

#### [P2] `cmdSanitize` 不写 `state.json.securityEvents`(协议承诺未兑现)
- 位置:SKILL.md:L1256(秘密泄漏防护第 4 条)vs scripts/phase-state.js:cmdSanitize(L811-845)
- 现象:SKILL.md L1256 明确 "Record all sanitization events to state.json.securityEvents"。但 `cmdSanitize` 实现仅 sanitize 文件 + 写 JSON 输出,从未读 state.json 写 securityEvents。Final Report Template "Security events: {securityEventCount}"(L1458)也是空值。
- 证据:grep "securityEvents" scripts/phase-state.js → 仅 init 初始化为空数组,无 push
- 建议:`cmdSanitize` 末尾读 state.json → push `{file, at: ISO timestamp, secretsFound: count}` → writeState

#### [P2] `record-confirm` 无 userConfirmations 数组长度上限
- 位置:scripts/phase-state.js:cmdRecordConfirm(L922-947)
- 现象:`userConfirmations` 数组可被无限 append(state.userConfirmations.push),无任何上限。LLM 幻觉或恶意脚本在循环中调用 `record-confirm 01 c` 可让 state.json 增长到 MB 级,加重每次 atomicWrite 的 I/O 负担。
- 证据:grep "userConfirmations" scripts/phase-state.js → push 操作无 length 检查
- 建议:在 push 前加 `if (state.userConfirmations.length > MAX_CONFIRMATIONS_PER_PHASE) die(...)`,如 MAX=10(同一 phase 最多 10 条确认)

#### [P2] `validate-summary` 字符数统计用 UTF-16 code unit(emoji/扩展平面字符误算)
- 位置:scripts/phase-state.js:L1017 vs SKILL.md:L1090-1093
- 现象:SKILL.md L1090 明确 "字符数统计:JS `text.length`(UTF-16 code unit)—— 与文件字节数无关,只计字符数"。但 `text.length` 是 UTF-16 code unit,BMP 外的字符(emoji 😀, 罕用汉字)每个算 2 chars。250 个 emoji = 500 chars(实际视觉上 250 字符),会通过 500 chars 限制。测试未覆盖此边界。
- 证据:node -e "console.log('😀'.length)" → 2
- 建议:协议层用 `Array.from(content).length` 算 Unicode code point 数,或 SKILL.md 文档显式说明"含 emoji 时按 UTF-16 算"作为已知限制

#### [P3] `validate-summary` UTF-8 校验仅检测 `�` 替换字符,可能漏判
- 位置:scripts/phase-state.js:L1003
- 现象:`content.includes('�')` 检测替换字符作为 UTF-8 无效的代理。实际有效的 UTF-8 文件永远不会产生 `�`,但少数 UTF-8 边缘情况(过短的 0xC0/0xC1 起始字节等)Node 仍可能产生 `�` — 这一部分被捕获。但若文件是合法 UTF-16 LE/BE 编码并被当 utf8 读取,可能产生大量 `�` 或乱码但仍被错误识别为"有替换字符 → 非 UTF-8"。当前实现可接受,边界需补充测试。
- 证据:无测试覆盖过短 UTF-8 序列
- 建议:补充测试用例:0xC0 0x80(过短起始字节)/ 0xFF 0xFE(UTF-16 BOM 字节)

---

### 维度 4:测试覆盖(Test Coverage)

#### [P2] README 测试数据严重过期(110 → 实际 206)
- 位置:README.md:L100-102
- 现象:README.md 声称"测试用例 110 / 测试套件 18 / 通过率 100%"。但当前实际是 **206 个测试 / 46 个 suite / 206 通过**(实测)。相差近 1 倍。原因:11 个 fix 增加了 96 个测试,但 README 未更新。
- 证据:实际 `node _proc-use/reports/atdo.test.js` 输出 `# tests 206`,`# suites 46`
- 建议:更新 README.md:L100-102 到"测试用例 206 / 测试套件 46 / 通过率 100%"

#### [P2] Bug-11 章节测试只覆盖"文档关键字匹配",无任何代码层校验
- 位置:_proc-use/reports/atdo.test.js:L2105-2162 (Bug-11 describe block)
- 现象:Bug-11 是"过程文件命名与位置规范"——纯文档规范(无对应 phase-state.js 命令),测试只验证 SKILL.md 章节存在 + 关键字出现。但"orchestrator 检查行为"是软约束(L131-138),所以确实无代码可测。可接受现状,但 L2119-2127 测试用了"或"条件(L2122-2124),任何一个匹配即 pass,降低了测试的约束力。
- 证据:grep "Bug-11" atdo.test.js → 4 个 test 全部为 skillContent.match
- 建议:测试可加一个集成测试:用 mock orchestrator 扫描 `_proc-use/` 目录,验证所有文件匹配命名正则(目前归为"软约束 = 不强制"是可接受)

#### [P2] `cmdGetCurrentPhase` 在 awaiting_user_review 状态行为无测试
- 位置:_proc-use/reports/atdo.test.js(L245-280 get-current-phase suite)
- 现象:测试覆盖"中间态不推进 / 全部 completed 返 done",但未测试 `phase.status === 'awaiting_user_review'` 时的输出。当前实现也无 `awaitingUserReview: true` 字段(见维度 1 P1-2),但协议承诺了此字段,测试应覆盖以固化协议。
- 证据:grep "awaiting_user_review" atdo.test.js → 仅在 Bug-06 状态机测试中用 `set-phase` 触发,未断言 `get-current-phase` 输出
- 建议:补充测试:set-phase 02 awaiting_user_review 后,get-current-phase 应返回 awaitingUserReview: true

#### [P2] Bug-10 字符数边界值 = 500 已测试,但 emoji/扩展平面字符未测
- 位置:_proc-use/reports/atdo.test.js:L2061-2095 (字符数测试)
- 现象:测试覆盖纯 ASCII(500 bytes = 500 chars)+ 混合中英(250 + 250 = 500),但未测纯 emoji(250 emoji = 500 UTF-16 code units)。如果按 code point 数应 PASS 250 emoji / FAIL 251 emoji;但按 code unit 数 250 emoji = 500 code unit,会 PASS 250 emoji 并 FAIL 251 emoji。当前实现按 code unit 计(协议 L1090-1093 明文),但未在测试中固化此行为。
- 建议:补充 2 个测试:250 emoji → exit 0(按 code unit 算 500 chars,边界 PASS)/ 251 emoji → exit 1

#### [P2] `cmdSanitize` 不写 `state.json.securityEvents` 无测试断言
- 位置:_proc-use/reports/atdo.test.js:无
- 现象:SKILL.md L1256 协议要求 sanitize 写 securityEvents,但无测试断言"调用 sanitize 后 state.json.securityEvents 数组非空"。
- 证据:grep "securityEvents" atdo.test.js → 0 命中
- 建议:补充测试,或修复实现+加测试

#### [P3] `cmdInit` 中 `P\d` priority 越界检测,SKILL.md 协议 L327 还提"priority 不在 0|1|2|3"作为 Tier 3.5 反例,但 init 实际通过 P9 也走"priority 越界"FATAL(L431),未提"接收 N 不是数字"边界
- 位置:scripts/phase-state.js:L431-432 vs SKILL.md:L329
- 现象:SKILL.md L329 列 "❌ `### P?-N` 但 N 不是数字 → FATAL",但 init 实现只在 `parseTaskListPlan` 内的 `TASK_HEADER_RE = /^###\s+P([0-3])-(\d{1,2})\b/`,依赖 `\d` 拒绝非数字。问题是 init 的越界 detection regex `/^###\s+P\d-\d/m` 在 L431,只检测"P + 数字"模式——若 plan 是 `### P?-abc`(问号)此 regex 不匹配,init 走"完全不像"路径,报"需要 JSON"。但 `### P4-1` 是 `P\d-\d` 模式 → 越界 FATAL。`### P-1` (无 priority)也走完全不像。测试未覆盖 "### P-1" 边缘。
- 建议:补充测试:`### P-1` → 应报"需要 JSON"或 FATAL

#### [P3] E2E 测试未覆盖 manual gate 完整流程的 cron 抑制
- 位置:_proc-use/reports/atdo.test.js(L687-742 E2E 3 阶段)
- 现象:E2E 测试走完 auto gate 全流程,但 manual gate 路径(从 gated → awaiting_user_review → user-review-pass → completed)未做端到端测试,只在 Bug-06 状态机测试中拆分测。集成兼容性存在但缺乏端到端断言。
- 建议:补充 E2E:plan 含 manual gate phase → 走完 auto + manual gate → done

#### [P3] `get-strikes` 边界测试缺失
- 位置:_proc-use/reports/atdo.test.js
- 现象:`inc-strike` 测试覆盖充分(L282-326),但 `get-strikes` 命令未单独测试。无 type 边界(空 / 数字 / 非法字符)、无 `regression` 维度独立测试。
- 建议:补 2-3 个测试:regression 累计 / 不存在 phaseId / type 含特殊字符

---

### 维度 5:文档准确性(Doc Accuracy)

#### [P2] README.md 章节锚点"硬约束(红线)"过时——未列 Bug-06 manual gate / Bug-08 unlock / Bug-10 summary 等
- 位置:README.md:L80-90
- 现象:README 红线表只列 "git push / rm / .env / ~/.claude/" 几类,未提 11 个 fix 中引入的新红线(Bug-08 unlock 必须带 reason / Bug-10 summary ≤ 500 chars 硬约束 / Bug-11 命名软约束)。读者只看 README 不知道 atdo v2.0 实际红线范围。
- 建议:在 README 红线表后追加"v2.0 协议红线"小节,枚举 11 个 fix 的硬约束

#### [P3] README.md "工作流"流程图未含 manual gate 分支
- 位置:README.md:L36-49
- 现象:README 工作流图 L47 写 "8. Git commit 仅关口通过时",但 Bug-06 引入的 manual gate 协议要求"manual gate 不调 CronCreate,等用户答复"。README 流程图未体现此分支,用户按 README 执行不会触发 manual gate 协议。
- 建议:在"6. 关口检测"步骤后追加 "6a. manual gate: 若 gateType=manual/hybrid,等用户答复,不调 CronCreate"

#### [P3] `SKILL.md:PROCESS_FILE_POLICY` code block 不含"`.phase-execution/`"子目录
- 位置:SKILL.md:L52-78
- 现象:PROCESS_FILE_POLICY code block 列出 `_proc-use/dev/`, `_proc-use/docs/`, `_proc-use/reports/`, `_proc-use/buginfo/`,但漏列 `.phase-execution/`(运行时状态,gitignored)。Agent spawn 时只被告知 `_proc-use/`,不知道 `.phase-execution/` 也是 atdo 管理的目录。
- 建议:在 `_proc-use/buginfo/` 行后追加 `.phase-execution/  运行时 transient 状态(自动 gitignore)` 一行,或单独加注释

---

### 维度 6:集成兼容性(Integration)

#### [P2] `record-confirm` 多次确认累积的 LIFO 语义未明
- 位置:scripts/phase-state.js:L949-963 (cmdHasConfirm)
- 现象:Bug-07 测试中 "同一 phase 多次 confirm → 数组累计 2 条"已测试,但 SKILL.md L1349 说"同一 phase 多次 confirm:c → s 流转不覆盖,保留历史",`has-confirm` 应仍 exit 0(任意 decision 都算已确认)。当前实现 `has-confirm` 用 `find` 取第一条(可能 decision='c' 之后又 'a',L955 `find` 返回首个 = 'c')。集成场景:phase 已 c 确认后用户想改 a 拒绝,has-confirm 仍返 c 的 decision 字符串——orchestrator 误以为用户同意。
- 证据:L955 `find` 不排序,L957 输出 found.decision(首个)
- 建议:`has-confirm` 应取 `userConfirmations` 数组中该 phaseId 的最后一条(LIFO),或协议层明文定义"取最后一条"语义

#### [P2] `validate-summary` 与 SKILL.md "Step 9 写 summary"集成未测
- 位置:SKILL.md:L1000-1014
- 现象:Step 9 命令是"cat heredoc → validate-summary",但测试未覆盖完整 Step 9 集成(写超长 → 校验失败 → 重写 → 再校验 → 通过)。当前测试只覆盖"直接调 validate-summary",不验证 Step 9 完整命令流。
- 建议:补充集成测试模拟 Step 9 命令流

#### [P3] `F-01` 任务列表型 plan 的 E2E 集成未测
- 位置:_proc-use/reports/atdo.test.js:L2175-2362
- 现象:F-01 测试覆盖单 plan 解析 + 冲突检测 + 越界 + checkbox,但未测"任务列表型 plan → 走完整个 phase 流程 → record-commit → done"的 E2E。验证解析 + 状态机 + commit 三层集成兼容性。
- 建议:补 E2E:任务列表型 plan 解析后,走完 phase 1,record-commit,完成

---

### 维度 7:已知遗留(Known Issues)

#### [P2] Bug-09 planHash 检测协议未实现自动化(仅文档层)
- 位置:SKILL.md:L459-477
- 现象:Bug-09 "3. plan vs state 不一致检测" 描述 orchestrator 可选做 hash 对比,但仅给示例 bash 命令,无 phase-state.js 命令实现。`get planHash` 可读,但无 `compare-plan-hash <plan-file>` 命令对比 plan-file 与 state.planHash。协议层承诺了能力,代码层未实现。
- 建议:加 `compare-plan-hash <plan-file>` 命令:读 plan-file 算 md5,与 state.planHash 对比,输出 match/mismatch,exit 0/1

#### [P3] state.json schema 未文档化 `awaiting_user_review` 字段形式
- 位置:SKILL.md:L857-878(state schema 扩展)
- 现象:SKILL.md L857-878 文档化 `awaiting_user_review` 顶层字段 schema,但仅在 Bug-06 章节提及。主 "state.json Schema" 章节(L351-422)未列此字段。读者从主 Schema 章节无法了解此字段。
- 建议:在 L415-422 "字段别名" 表格后追加 "顶层特殊字段" 小节,列举 `awaiting_user_review` / `userConfirmations` / `planHash` / `securityEvents` / `networkStatus` / `exitReason`

#### [P3] Bug-08 SKILL.md "24h lock 警告"无对应实现
- 位置:SKILL.md:L228-231
- 现象:SKILL.md L228-231 说"lock 持有超过 24h:警告但需人工确认(不自动释放)"。但 `acquireLock` / `watchdog.sh` / 任何 phase-state.js 命令均不检查 lock 持有时长。24h 后无自动警告。
- 建议:在 `get-current-phase` / `lock` / `summary` 中加 lock 持有时长检查,>24h 输出 WARN 到 stderr,或新加 `check-lock-age` 命令

---

## 优先级修复建议

| Finding | 严重度 | 修复难度 | 建议顺序 |
|---------|:---:|:---:|:---:|
| [P1] Bug-05 marker 协议未应用到 reviewer/fixer/integration-checker | P1 | 中(改 3 处模板) | 1 |
| [P1] `get-current-phase` 未返回 `awaitingUserReview: true` | P1 | 低(加 1 字段) | 2 |
| [P1] `watchdog.sh` 不读 `state.awaiting_user_review` | P1 | 中(改 1 函数) | 3 |
| [P1] `--no-audit` 与状态机互锁矛盾 | P1 | 中(明确边界) | 4 |
| [P1] README.md 测试统计过期(110 → 206) | P1 | 低(改 3 行) | 5 |
| [P1] `cmdSanitize` 与 SKILL.md 安全集成未测 | P1 | 中(补 E2E) | 6 |
| [P2] Bug-02 章节缺 `Bug-02` 标记 | P2 | 低(改 1 行) | 7 |
| [P2] SKILL.md 章节编号两个 `### 9.` | P2 | 低(改 1 行) | 8 |
| [P2] Bug-11 位置约束与其他章节矛盾 | P2 | 低(加 1 段说明) | 9 |
| [P2] Bug-11 stepName "严格" vs "软"自相矛盾 | P2 | 低(改措辞) | 10 |
| [P2] `cmdGetCurrentPhase` 重复 cmdSummary 逻辑 | P2 | 低(抽 helper) | 11 |
| [P2] `ACTIVE_STATUSES` 死代码 | P2 | 低(删除 1 行) | 12 |
| [P2] `networkStatus` / `exitReason` 死字段 | P2 | 低(删除或实现) | 13 |
| [P2] `cmdSanitize` 不写 `securityEvents` | P2 | 中(加 5 行) | 14 |
| [P2] `record-confirm` 无 userConfirmations 长度上限 | P2 | 低(加 1 检查) | 15 |
| [P2] `validate-summary` 字符数用 UTF-16 code unit(emoji 误算) | P2 | 中(改实现或文档) | 16 |
| [P2] README 测试数据 / 行数过期 | P2 | 低(改 README) | 17 |
| [P2] `cmdGetCurrentPhase` 在 awaiting_user_review 状态行为无测试 | P2 | 低(补 1 测试) | 18 |
| [P2] Bug-10 emoji 字符数边界未测 | P2 | 低(补 2 测试) | 19 |
| [P2] `cmdSanitize` 写 securityEvents 无测试断言 | P2 | 低(补 1 测试) | 20 |
| [P2] `record-confirm` 多次确认 LIFO 语义未明 | P2 | 低(改 has-confirm 或加文档) | 21 |
| [P2] `validate-summary` 与 Step 9 集成未测 | P2 | 低(补 E2E) | 22 |
| [P2] Bug-09 planHash 比较命令未实现 | P2 | 中(新命令 + 测试) | 23 |
| [P2] Bug-11 测试用"或"条件降低约束力 | P2 | 低(收紧) | 24 |
| [P2] SKILL.md `PROCESS_FILE_POLICY` 不含 `.phase-execution/` | P2 | 低(加 1 行) | 25 |
| [P2] README 红线表未含 v2.0 协议红线 | P2 | 低(补 1 节) | 26 |
| [P3] Bug-10 UTF-8 校验漏判边缘 | P3 | 低(补 2 测试) | 27 |
| [P3] F-01 E2E 未测 | P3 | 低(补 1 E2E) | 28 |
| [P3] state.json schema 未列特殊顶层字段 | P3 | 低(补 1 节) | 29 |
| [P3] Bug-08 24h lock 警告未实现 | P3 | 中(加检查) | 30 |
| [P3] 缺 `get-strikes` 边界测试 | P3 | 低(补 3 测试) | 31 |
| [P3] `cmdInit` priority 越界检测边缘 | P3 | 低(补 1 测试) | 32 |
| [P3] README 工作流图未含 manual gate 分支 | P3 | 低(改图) | 33 |
| [P3] `check-disk` 用 `execSync` 风格不一致 | P3 | 低(改 execFileSync) | 34 |
| [P3] cmdInit `P[0-3]-\d` regex 与 SKILL.md 不一致 | P3 | 低(统一 regex) | 35 |

**修复顺序建议**:1-6 (P1) → 7-26 (P2,按实现难度从低到中) → 27-35 (P3)

---

## 通过项(无需修改)

以下方面审计通过,可作为正向反馈:

1. **Bug-03 record-commit 多 hash**:实现完整,5 个测试覆盖单 hash / 多 hash / 无效 / 空 / 原子性,commas 周围空格 trim 正确处理
2. **Bug-05 methodology 字段文档**:SKILL.md L540 协议清晰,4 个测试断言 SKILL.md 含 methodology + INCONCLUSIVE + 人工放行
3. **Bug-06 状态机实现**:`ALLOWED_TRANSITIONS` 表 + `VALID_PREDECESSORS` 反向索引 + 终态保护三重防护,5 个测试覆盖合法/非法转换/跳过中间态
4. **Bug-06 state.json `awaiting_user_review` 字段管理**:`set-phase` 写入/清除时机正确(进入 awaiting_user_review 时写入,离开时清除),不误清其他 phase
5. **Bug-08 unlock 严格化**:6 个测试覆盖无参数 / alert / all-completed / aborted / 非法 reason / 空 reason 边界,lock 文件状态保护正确
6. **Bug-08 P1-C 锁抗注入**:`pidValid` 严格白名单(正整数)+ `execFileSync` 走参数化,4 个测试覆盖字符串/负数/浮点/null pid 攻击向量
7. **Bug-07 checkpoint 协议**:6 个测试覆盖 record-confirm c/s/a / 非法 / 多次累计 / 不存在 phaseId + has-confirm 退出码 0/1 + 向后兼容
8. **Bug-09 planHash**:5 个测试覆盖存在/缺失/非字符串/空/超长/边界值 md5/64 字符上限,get planHash 命令正常
9. **Bug-10 summary 长度校验**:8 个测试覆盖 500 边界/501 超长/中文字符/不存在/空文件/非 UTF-8/不存在 phaseId/无参数,字符数按 JS text.length 文档化清晰
10. **Bug-10 UTF-8 校验**:`buf.toString('utf8')` + `includes('�')` 检测合理,3 字节中文混 1 字节 ASCII 测试通过
11. **F-01 Tier 3.5 解析**:6 个测试覆盖基本解析/语义冲突/priority 越界/完全不像/JSON 向后兼容/checkbox 形式,3 位数字检测边界已测
12. **路径白名单 (P1-1)**:`cmdSanitize` realpathSync 双侧归一化(规避 macOS /var 符号链接陷阱),3 个测试覆盖外部文件/路径穿越/内部文件
13. **长度上限 (P2-D)**:name/goal/tasks/task 各档上限边界值(200/2000/50/500)有正反例测试
14. **E2E 3 阶段完整流程**:走完 pending → in_progress → executed → audited → fixed → gated → completed → record-commit → done,游标自动推进
15. **多版本 backup 轮转**:4 个测试覆盖连续 3 次 init 生成 bak.1/2/3 + 主损坏回退 bak.1 + bak.1 损坏回退 bak.2 + 全部损坏 die
16. **state.json 损坏回退 + WARN**:测试断言 stderr 含 `WARN.*state.json.bak.1` / `state.json.bak.2`,告警机制工作
17. **敏感文件检测正则**(SKILL.md:275):覆盖 `.env.local` / `config/.env` / `id_rsa` / `id_dsa` / `id_ed25519` / `credentials.*` / `secrets.*`,正向 13 个 + 反向 9 个文件全测
18. **commands 解析**:未知命令报 "未知命令" + 列可用命令,边界合理
19. **zero-dependency 原则**:`require('node:fs')` / `require('node:child_process')` 全用内置模块,无 npm 依赖
20. **readme "CronCreate (durable)"**:与 SKILL.md L1023 一致,跨会话续 wakeup 路径清晰

---

## 总结

11 个 fix commit 共引入 **6 个 P1 + 8 个 P2 + 5 个 P3 = 19 个 findings**,其中:

- **协议 vs 代码不一致**是最大问题(Bug-05 marker 适用范围、get-current-phase awaiting 标记、watchdog 不读 awaiting_user_review、--no-audit 与状态机互锁、securityEvents 协议未实现、README 严重过期)
- **文档/章节一致性**问题:BUG-02 缺标记、SKILL.md 重复 `### 9.` 编号、Bug-11 位置/严格性自相矛盾
- **死代码/死字段**:ACTIVE_STATUSES / networkStatus / exitReason 应清理
- **测试覆盖**:emojis 边界、manual gate E2E、cmdSanitize securityEvents 集成、record-confirm LIFO 语义需补
- **代码质量**:`check-disk` 与 P1-C 风格不一致、validate-summary 字符数算法协议与实现细节

**总测试基线 206/206 通过**,所有现有声明行为均经测试固化,findings 中"协议承诺未兑现"项的"测试通过"是合理的(测试只验证已实现的代码,未测试 SKILL.md 文档承诺但代码未实现的能力)。

**建议下一步**:按优先级修复建议表的顺序(1-6 P1 先修)实施后续 fix commit,优先解决"协议层承诺但代码层未实现"的 6 个 P1 项。
