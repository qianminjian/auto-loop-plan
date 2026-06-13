# Auto-Phase-Executor: 自动化分阶段开发管理插件（v2.0 — 双审融合）

## Context

用户需要一个 Claude Code 插件，实现项目分阶段自动化开发管理。核心诉求：
1. 分阶段自动执行（按项目计划，不限格式）
2. 每阶段完成后自动深度审计 + 修复 + 报告
3. 关口自动回归测试 + 修复 + 报告
4. 全程自动化 loop，可对话式暂停/取消
5. 关口自动 CI + commit
6. 人工手动 push
7. 同一任务失败 3 次 → 严重告警退出
8. 长时间无响应/异常 → 自动停止重试

## 双审碰撞结论

两个独立 agent（code-reviewer + debugger）分别从架构可执行性和故障边界角度审查，**共识**：

**P0 致命问题（必须修复才能可用）**：
1. "对每个阶段循环"在 SKILL.md 指令层面不可行——Claude 是 LLM 不是运行时，单 turn 最多 2-3 阶段就上下文溢出
2. Agent 输出不可信——无结构化完成标记，无独立验证，Agent 幻觉可能传播到后续阶段
3. 状态文件无原子写入 + 无备份恢复——kill -9 时状态损坏无法恢复
4. 锁文件无 PID 检查 + 无 stale lock 自动恢复——残留锁导致永远无法启动
5. Agent 输出可能泄露密钥——审计报告和对话日志无脱敏
6. 无上下文预算管理——编排指令 + 计划 + Agent 输出可轻易超出窗口

**解决方案已全部纳入 v2.0 设计。**

## 设计决策

**方案：单一 Claude Code Skill（轻量级编排器）**

核心架构修正——**单 turn 单阶段**：
- 原 v1 设计为"一个 turn 内循环所有阶段"——不可行
- v2 修正为"每个 turn 只处理**一个**阶段，完成后用 ScheduleWakeup 延续到下一阶段"
- ScheduleWakeup 成为真正的循环驱动器，而非仅是安全阀

```
Turn 1: 启动 → 环境检查 → 计划解析 → 阶段 1 执行/审计/修复/gate/commit → 状态持久化 → ScheduleWakeup → 结束
Turn 2: 唤醒 → 读 state.json → 阶段 2 执行/审计/修复/gate/commit → 状态持久化 → ScheduleWakeup → 结束
Turn N: 唤醒 → 读 state.json → 阶段 N 执行 → ... → 全部完成 → 输出报告 → 结束
```

## 文件结构

```
~/.agents/skills/auto-phase-executor/
  SKILL.md                              # 主编排器（~500 行）
  scripts/
    phase-state.js                      # 状态管理（~200 行，零依赖）
    watchdog.sh                         # 孤儿进程清理 + 心跳检查（~50 行）
  templates/
    audit-report-template.md            # 结构化审计报告模板（{{placeholder}}）
    integration-test-report-template.md # 结构化回归报告模板

~/.claude/skills/auto-phase-executor   # symlink → SKILL.md

<项目>/.phase-execution/               # 运行时状态目录
  state.json                            # 主状态（含所有阶段子状态、strike 计数、commit hash）
  state.json.backup                     # 自动备份
  progress.md                           # 人类可读进度
  ALERT.md                              # 严重告警
  lock                                  # 并发锁（JSON: {pid, startTime, hostname}）
  phases/<N>/
    plan-snippet.md                     # 当前阶段计划摘要（≤500 字）
    execution-log.md                    # 执行日志
    audit-report.md                     # 审计报告
    fix-log.md                          # 修复日志
    summary.md                          # 阶段摘要（≤500 字，供后续 turn 加载）
  gates/<label>/
    integration-test-report.md          # 回归测试报告
  archive/                              # 已完成阶段的详细输出归档
```

## SKILL.md 核心设计

### 参数
- `--from N` / `--to N` / `--only N`：控制执行范围
- `--resume`：从 state.json 恢复
- `--dry-run`：仅展示计划
- `--no-audit`：跳过审计
- 环境变量 `AUTO_PHASE_NO_CONFIRM=true`：跳过所有检查点（完全无人值守）

### 上下文管理协议（硬规则）

```
1. 本 Skill 自身指令 ~2K tokens
2. 当前阶段计划摘要（plan-snippet.md）≤ 500 字
3. 已完成阶段只读 summary.md（每个 ≤ 500 字），不加载详细日志
4. 每个 turn 只处理一个阶段，完成后立即结束 turn
5. Agent 原始输出提取摘要后丢弃——只保留 phase-state.js 写回的结构化数据
6. 上下文中仅保留：SKILL.md + state.json + 当前 plan-snippet + 上一阶段 summary
```

### 启动/恢复流程

1. **环境清洁度检查**（编排器直接执行，不委托 Agent）：
   - `git status --porcelain` 检查工作区（允许 `.phase-execution/` 变更）
   - `df -h .` 检查磁盘空间 ≥ 500MB
   - `node --version` 匹配项目要求
   - 不满足 → ALERT.md + 退出

2. **锁文件获取**：
   - 读 lock → 检查 pid 是否存活（`kill -0 <pid>`）
   - 进程已死 → 清理 stale lock，创建新锁
   - 进程存活且 startTime 匹配 → 输出"编排器已在运行 (pid X)"并退出
   - 进程存活但 PID 复用（startTime 不匹配）→ 清理并创建新锁
   - 锁持有超过 24h → 警告但需人工确认

3. **状态恢复**：
   - 读 state.json → JSON.parse 失败 → 读 state.json.backup → 仍失败 → 检查 git log 重建
   - 若 `.phase-execution/state.json.tmp` 存在 → 上次写入未完成，忽略
   - 当前阶段状态为 `in_progress` 且时间戳 > 5min → 判定僵死，清理后重试

4. **计划加载**：
   - `--resume` 时跳过计划解析，直接读 state.json
   - 否则执行计划解析（三档策略，见下）

### 计划解析（三档 + 安全阀）

1. **已知格式**：GSD ROADMAP.md → `gsd-tools query roadmap.analyze`
2. **结构化格式**：JSON/YAML `phases[]` 数组
3. **自由格式**：LLM 识别 Markdown 章节 → **解析后必须在检查点展示给用户确认**，不静默执行

**解析失败处理**：不猜测，不降级。直接 ALERT.md 退出，列出期望格式示例。

**阶段依赖验证**：构建有向图 → 拓扑排序检测环路 → 发现环路拒绝执行

**超大阶段检测**：tasks > 15 → 输出警告，建议拆分。用户可坚持不拆分。

### 主执行流程（单阶段，每 turn 一个）

```
[CHECKPOINT] 阶段 N/M: <阶段名> — 回复 'c' 继续, 's' 跳过, 'a' 终止

1. 前置检查
   ├── 验证依赖阶段 completed
   ├── 记录 git rev-parse HEAD
   └── 加载 plan-snippet.md（≤500 字）

2. Agent 执行（gsd-executor）
   ├── prompt 末尾追加：[AUTO-EXEC-RESULT: status=SUCCESS|FAILED, files=X, tasks_done=Y, errors=Z]
   ├── 等待返回 → 解析完成标记
   ├── 未找到标记 → 视为 AGENT_OUTPUT_INCOMPLETE，重试 1 次
   └── 更新 state: pending → executed

3. 独立验证（编排器直接执行，不委托 Agent）
   ├── 文件存在性：计划产出物列表逐一 test -f / test -s
   ├── 语法检查：tsc --noEmit / cargo check / 等
   ├── 调试残留：grep -r 'console.log\|debugger\|TODO' --include='*.ts'
   └── 任一失败 → 触发修复循环

4. Agent 审计（gsd-code-reviewer）
   ├── 只检查结构化指标：lint / 语法 / diff 范围 / 调试残留 / 密钥硬编码
   ├── 输出 audit-report.md（{{placeholder}} 模板填充）
   └── 更新状态: executed → audited

5. 修复循环（最多 3 次，gsd-code-fixer）
   ├── 第 1 次：修复 → 重新审计
   ├── 第 2 次：修复 → 重新审计
   ├── 第 3 次：不修复，回滚到修复前 git 状态 + ALERT.md + 退出
   ├── strike_count 持久化到 state.json
   └── 更新状态: audited → fixed

6. 关口检测
   ├── 判断条件：is_gate:true / depends_on 非空 / 每 N 阶段（默认每 2 阶段）
   ├── 若是关口：
   │   ├── Agent 回归测试（gsd-integration-checker）
   │   ├── 修复循环（同上，最多 3 次）
   │   ├── 代码关口：项目 lint + jest --findRelatedTests
   │   └── 全量测试仅在计划显式声明时触发
   └── 更新状态: fixed → gated

7. Git commit（仅关口且通过时）
   ├── 安全检查：git diff 中无 .env/*.key/*.pem
   ├── git add <预期文件列表>  # 精确添加，不用 git add -A
   ├── git commit -m "auto-phase: Phase N complete [gate: <label>] [audit:passed]"
   ├── 记录 commit hash 到 state.json
   ├── commit 失败分类：
   │   ├── pre-commit hook 拒绝 → 修复 + 重试 1 次
   │   ├── merge conflict → ALERT.md + 退出（不自动处理）
   │   └── 其他 → ALERT.md + 退出
   └── 更新状态: gated → completed

8. 状态持久化 + 延续
   ├── 原子写入 state.json（.tmp → fsync → rename）
   ├── 复制 state.json.backup
   ├── 写入 summary.md（≤500 字）
   ├── 归档已完成阶段详细日志到 archive/
   ├── 若是最后阶段 → 输出最终报告 + 提示 "所有阶段完成，请人工 push"
   └── 否则 → ScheduleWakeup(30s) + 结束当前 turn
```

### Agent 调用协议

**输出标记**：每个 Agent prompt 末尾强制追加：
```
After completing your task, output exactly this line:
[AUTO-EXEC-RESULT: status=SUCCESS|FAILED, files=<count>, tasks_done=<count>, errors=<count>]
```

**验证步骤**（编排器执行，不委托 Agent）：
1. 文件存在性检查：`test -f <产出物路径>` + `test -s <产出物路径>`
2. 语法检查：项目编译器（`tsc --noEmit` / `cargo check`）
3. Git diff 验证：`git diff --stat HEAD~1` 变更量合理（非 0 也非 >10000 行）
4. 调试残留检查：`grep -r 'console.log\|TODO\|debugger'`
5. 密钥格式扫描：`grep -E 'sk-\|ghp_\|AKIA'`

**不可信原则**：编排器不信任 Agent 的任何声明。所有声明必须由编排器直接独立验证。

### 多维度 Strike 机制

```
1. 阶段内重试 strike：同阶段审计-修复循环 ≥ 3 → ALERT.md + 退出
2. 全局回归 strike：修复引入之前已通过阶段的回归 ≥ 2 → ALERT.md + 退出
3. 同类问题 strike：同一审计分类标签累计 ≥ 5 → ALERT.md + 退出

state.json 记录：
{
  "strikes": {
    "phaseRetry": {"p3": 2},
    "regression": 0,
    "sameCategory": {"type-safety": 3}
  },
  "exitReason": null
}
```

### 网络中断协议

| 错误类型 | 退避策略 | 最大重试 | 后续 |
|---------|---------|---------|------|
| 4xx (认证/权限) | 不重试 | 0 | 立即退出 |
| 5xx (服务器) | 指数退避 2^n 秒 | 3 | 继续 |
| 超时/断开 | 指数退避 5^n 秒 | 5 | 继续 |
| DNS 失败 | 固定 60s | 5 | 继续 |

总退避上限 30 分钟 → 进入休眠模式，保存状态，提示用户恢复网络后 `--resume`

### 密钥泄露防护

1. Agent prompt 中注入：禁止读取 .env/.pem/.key 文件，禁止输出密钥值
2. 编排器写入日志前执行脱敏扫描（正则匹配 sk-、ghp_、AKIA、private.*key 等）
3. 审计报告生成后自动扫描 → 匹配到替换为 [REDACTED]
4. state.json 记录 securityEvents 数组

### 检查点机制（用户交互）

在以下节点暂停，输出 `[CHECKPOINT] 描述 — 'c'继续 's'跳过 'a'终止`：
- 计划解析完成后、首次执行前
- 每个阶段开始前
- 每次修复循环前（第 1 次）

环境变量 `AUTO_PHASE_NO_CONFIRM=true` 跳过所有检查点，实现完全无人值守。

### 红线合规（硬编码）
- 禁止 git push / git push --force / git reset --hard
- 禁止删除文件（rm / git rm）
- 禁止修改 .env / 密钥 / ~/.claude/ 系统配置
- 启动服务前必须 lsof -i:<port>
- 只做 git add <精确文件> + git commit，不做 git add -A
- git commit 记录 hash 到 state.json

## 集成现有资源

| 任务 | Agent |
|------|-------|
| 阶段实现 | gsd-executor |
| 深度审计 | gsd-code-reviewer |
| 审计修复 | gsd-code-fixer |
| 回归测试 | gsd-integration-checker |
| Bug 调试 | gsd-debugger |
| 无计划时生成 | gsd-planner |

## 实现步骤

1. 创建 `~/.agents/skills/auto-phase-executor/` 目录结构
2. 编写 `scripts/phase-state.js`（原子读写、锁管理、状态恢复、脱敏扫描、磁盘检查）
3. 编写 `scripts/watchdog.sh`（孤儿进程清理、心跳检查）
4. 编写 `templates/audit-report-template.md`（结构化 {{placeholder}}）
5. 编写 `templates/integration-test-report-template.md`
6. 编写 `SKILL.md`（~500 行，包含上述所有协议）
7. 创建 symlink
8. 测试完整流程 + 边界情况

## 验证方式

1. 创建测试项目 + 2 阶段简单计划（Markdown 格式）
2. `/auto-phase-executor test-plan.md --dry-run` → 验证阶段识别 + 检查点展示
3. `/auto-phase-executor test-plan.md` → 验证：
   - 阶段顺序执行（每个阶段一个 turn）
   - ScheduleWakeup 自动延续
   - 每阶段后审计报告生成（audit-report.md）
   - [AUTO-EXEC-RESULT] 标记解析
   - 独立验证步骤执行
   - 关口回归测试报告生成
   - 自动 commit + commit hash 记录
   - progress.md 实时更新
4. 模拟中断恢复：kill -9 会话 → `--resume` → 验证状态恢复
5. 模拟 3 次修复失败 → 验证 ALERT.md + 退出
6. 模拟 stale lock 残留 → 验证自动清理
7. 并发启动两次 → 验证锁拒绝

## 风险评级

修订后方案风险从 **高** 降为 **中**。核心剩余风险：
- Agent 幻觉不确定性（Schema 验证 + 独立验证可降低，无法根除）
- 上下文窗口的物理限制（单 turn 单阶段 + 摘要化可控制）
- 建议：首次使用在实验性项目，关键关口保持人工确认
