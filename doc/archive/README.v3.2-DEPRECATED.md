> **⚠️ DEPRECATED**：此文件描述被废弃的 v3.2 (auto-loop-plan bash 多文件方案)，与当前 atdo v2.0.1 (Skill + Node 状态机) **完全不符**。仅作历史参考。
> 当前权威文档：根目录 README.md + SKILL.md。
> 项目设计明灯：doc/BEACON.md。

---

# auto-loop-plan v3.2

> 从任意 markdown 计划文件一键驱动多阶段项目自动执行。
> **v3.2**：Claude Code 自身作为编排器，逐阶段实时反馈。

## 快速开始

### Slash Command（推荐）

```bash
# 在 Claude Code 对话中
/cc-auto-orchestrate plan.md           # 执行
/cc-auto-orchestrate plan.md --dry-run # 预览
/atdo plan.md                          # 缩写别名
```

Claude Code 逐阶段调用 `run-phase.sh`，每阶段输出实时显示在对话中，失败时可交互式选择重试/跳过/中止。

### 终端模式

```bash
# 安装（到 ~/.local，免 sudo）
./install.sh

# 进入目标项目
cd /path/to/your-project
cc-auto-orchestrate 重构方案.md --dry-run   # 预览
cc-auto-orchestrate 重构方案.md             # 执行
```

也支持 `sudo ./install.sh /usr/local` 安装到系统目录。`./install.sh --check` 检查版本，`--uninstall` 卸载。

## 架构

```
SKILL.md（Claude Code 编排层）
  → 解析 plan → 展示概览
  → 逐阶段调用 run-phase.sh
  → 失败交互式处理
  → 汇总报告

run-phase.sh（单阶段执行引擎）
  → execute → audit → fix（最多 3 次）→ ci-gate → commit
  → --regression 模式：关口回归测试
```

## Plan 文件格式

支持 4 种格式，自动检测，无需手动适配：

### 格式 1：§9.1 阶段表格（推荐）

```markdown
### 9.1 3 阶段

| 阶段 | 关键产物 | 工时 | 验收 | 关口 |
|------|--------|------|------|------|
| **阶段 1：初始化** | 项目骨架 | **1** | lint pass | |
| **阶段 2：核心** | 主要模块 | **3** | 单测 pass | ✓ |
| **阶段 3：集成** | e2e 测试 | **1** | all pass | |
```

### 格式 2：标题即阶段

```markdown
## 阶段一：项目初始化
工期：**2** 小时
关键产物：项目骨架 + CI 配置
验收：lint 全部通过

## 阶段二：核心模块
工期：**4** 小时
关键产物：10 个 lib 模块
验收：单测覆盖率 ≥ 75%
```

也可使用 `## Phase 1: Title`、`## 1. Title`、`## 第一阶段：Title`、`## Step 1: Title` 等格式。

### 格式 3：任意阶段标题下的表格

```markdown
## 实施计划

| 阶段 | 产物 | 工时 |
|------|------|------|
| **阶段 1：准备** | 环境 | **1** |
| **阶段 2：执行** | 代码 | **3** |
```

### 格式 4：单文档兜底

任意无阶段结构的 markdown 文件会被当作单一阶段整体执行。

## CLI 参考

```
cc-auto-orchestrate [PLAN_FILE] [options]

PLAN_FILE 可省略，自动探测：plan.md → PLAN.md → 实施方案.md
                           → 实施计划.md → IMPLEMENTATION.md

选项：
  --plan=FILE    计划文件（也可直接作为位置参数）
  --from=ID      起始阶段（默认第一个）
  --to=ID        结束阶段（默认最后一个）
  --dry-run      打印流程不执行
  --resume       从崩溃点恢复
  --help, -h     帮助
```

## 执行流程

每阶段 5 步：

```
execute → audit → fix（子循环，最多 3 次）→ ci-gate → commit
```

- **execute**：调用 `claude -p` 按 plan 内容执行
- **audit**：对照验收标准审查产出
- **fix**：修复 audit 发现的问题，重跑 lint
- **ci-gate**：运行 `_proc-use/_test-unit/` 下 4 个 lint 脚本（缺失则跳过）
- **commit**：git commit（无 git repo 自动 init）

**关口**：plan 中标记关口的阶段完成后，额外执行回归测试。

**重试**：每步最多重试 3 次，超过触发告警并退出。

## 跨项目使用

### 前提

目标项目需要一个 plan 文件（任意上述格式）。

### 可选配置

| 路径 | 用途 |
|------|------|
| `_proc-use/_test-unit/*.sh` | CI gate lint 脚本（缺失则跳过） |
| `_proc-use/_reports/` | 过程文档目录 |

### 环境变量

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `ALERT_MACOS` | macOS 通知 | 1（开启，设 0 关闭） |
| `ALERT_WEBHOOK_URL` | Webhook 告警地址 | 空（不发送） |
| `ALERT_EMAIL_TO` | 邮件告警收件人 | 空（不发送） |
| `ALERT_LOG_PATH` | 告警日志路径 | `_proc-use/_reports/alerts.md` |

## 项目结构

```
auto-loop-plan/
├── bin/cc-auto-orchestrate          主入口（267 行，薄封装）
├── bin/cc-auto-orchestrate.d/
│   ├── run-phase.sh                 单阶段执行引擎（277 行）
│   └── lib/                         7 个核心模块
│       ├── plan-adapter.py          灵活 plan 解析（4 种格式）
│       ├── plan-parser.sh           plan 解析 shell 封装 + jq 查询
│       ├── handover.sh              HandoverContract JSON 校验
│       ├── ci-gate.sh              CI gate（4 lint 脚本）
│       ├── auto-commit.sh          git commit
│       ├── lock.sh                 进程互斥锁（flock/mkdir）
│       ├── alert.sh + alert-multi.sh 多通道告警
├── skills/auto-execute/SKILL.md     Slash command 定义
├── tests/                          4 套测试（13 + 17 + 3 + 6 = 39 assertions）
├── ci-default/                     默认 CI lint 脚本
└── _proc-use/                      过程文档
```

## 当前状态

| 项 | 状态 |
|---|------|
| 代码行数 | ~1050 行（9 文件） |
| 单元测试 | 4 套 / 39 assertions |
| Plan 格式 | 4 种（§9.1 表格 / 标题即阶段 / 阶段表格 / 单文档兜底） |
| 依赖 | bash + python3 + jq + claude CLI |
