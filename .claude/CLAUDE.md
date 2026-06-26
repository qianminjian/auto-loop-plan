# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 项目：auto-loop-plan（atdo skill）| 创建：2026-06-14 | 更新：2026-06-26

---

## 项目身份

这是一个 **Claude Code Skill**（`/atdo`），不是传统应用。核心产物是 `SKILL.md`（1680 行编排器协议）+ `scripts/phase-state.js`（1362 行零依赖状态机）+ `scripts/watchdog.sh`（进程监控）。

零外部依赖，纯 Node.js 内置模块 + Bash。无须 `npm install`，无须 build。

---

## 常用命令

```bash
# 测试入口（统一收口到 scripts/，见 .claude/rules/test-discipline.md）
bash scripts/test.sh              # 全量测试（~25s，带 --test-timeout=60000）
bash scripts/test-unit.sh         # 单测，跳过 E2E（~10s，带 --test-timeout=30000）
bash scripts/test-integration.sh  # 集成测试，仅 E2E（~20s，带 --test-timeout=60000）
bash scripts/test-cleanup.sh      # 清理 .phase-execution 残留 + 孤儿测试进程

# 直接调 node:test（调试时用，绕过入口脚本）
node --test --test-timeout=30000 _proc-use/reports/atdo.test.js

# Markdown lint
npx markdownlint-cli2 README.md SKILL.md doc/*.md

# Shell lint
shellcheck scripts/*.sh

# 在本项目内启动 atdo（自托管测试）
# 用 SKILL.md 作为 plan 输入，atdo 会解析 Tier 3 自由 Markdown
/atdo doc/PLAN1-infra-atdo003.md --dry-run     # 只解析展示
/atdo doc/PLAN2-bug-001-002-004-ci-review.md --only 1
```

---

## 项目级规则库

`.claude/rules/` 下存放项目级运行时规则，遵循工程实践 `engineering-practices.md §11` 模板：

| 规则文件 | 用途 |
|---------|------|
| `.claude/rules/test-discipline.md` | atdo 测试运行纪律（5 条核心模式：入口收口/优先级/超时/清理/钩子）|

修改测试入口或运行时纪律前，先 Read 该规则确认约束。

---

## 架构

### 三文件核心

| 文件 | 行数 | 角色 |
|------|------|------|
| `SKILL.md` | 1680 | 编排器协议 —— Claude Code 加载后按此执行 phase loop |
| `scripts/phase-state.js` | 1457 | 状态机 —— 24 个命令（含 `check-test-runtime`），读写 `.phase-execution/state.json` |
| `scripts/watchdog.sh` | 187 | 看门狗 —— 孤儿进程清理 + 心跳检查 + 僵死进程终止 |

### 关键设计原则

1. **Trust Nothing**：orchestrator 不信任任何 agent 输出，每步独立验证（文件存在/语法/diff 范围/调试残留/密钥扫描）
2. **单 turn 单 phase**：每 turn 只执行一个阶段，完成后 CronCreate 创建一次性 cron 跨 turn 续航
3. **state.json 是 single source of truth**：plan file 只在 init 时读一次，后续所有操作以 state.json 为准
4. **零依赖**：`phase-state.js` 只用 `fs/path/os` 内置模块，部署只需 Node.js
5. **测试纪律**：测试调用走 `scripts/test*.sh` 入口（自带超时 + 跳过参数），禁止 agent 直接拼 `node --test`（见 `test-discipline.md`）

### 运行时状态位置

- `.phase-execution/` —— transient 运行时状态（state.json + lock + heartbeat），已 gitignore
- `_proc-use/` —— 长期归档产物（测试报告、bug 报告），随 git 推送
- `doc/` —— 设计文档（BEACON.md + DESIGN.md + Plan 文件），git 跟踪

---

## GitHub 推送约束

本项目 GitHub 仓库（qianminjian/auto-loop-plan）仅包含 `/atdo` skill 运行时必要组件。

### 推送清单（✅ 推送）

| 文件/目录 | 说明 |
|----------|------|
| `SKILL.md` | skill 核心定义 |
| `scripts/` | 运行时脚本（含 `phase-state.js` / `watchdog.sh` / `test*.sh`） |
| `references/` | skill 引用模板 |
| `doc/DESIGN.md` | 最终设计文档 |
| `README.md` | 项目说明 |
| `.gitignore` | 忽略规则 |
| `.claude/rules/` | 项目级运行时规则（如 `test-discipline.md`）|

### 排除清单（❌ 不推送）

| 类别 | 文件/目录 |
|------|----------|
| 过程产物 | `_proc-use/` |
| 设计过程 | `doc/` 下除 `DESIGN.md` 外所有文件 |
| 开发工具链 | `.githooks/` `.github/` `.markdownlint.json` `commitlint.config.mjs` |
| 工具缓存 | `.serena/` |
| 运行时状态 | `.phase-execution/` |
| 系统文件 | `.DS_Store` `*.swp` `.idea/` `.vscode/` |

### 新项目同步

其他本地项目默认也按此清单执行，除非该项目 `.claude/CLAUDE.md` 有自定义覆盖。
