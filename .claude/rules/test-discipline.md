# atdo 测试运行纪律

> 创建:2026-06-26 | 适配:auto-loop-plan / atdo skill | 来源:借鉴 prismscan-rules v0.4.0 pytest 内存管理规范,改写为 Node.js + node:test 版本

## 核心约束

- 物理内存上限:**16G**(本机实测)
- `node --test` 单进程内存峰值:~200-400MB(纯 JS,无 coverage)
- 测试规模:379 用例 / 81 套件(`tests/atdo.test.js` 现状,2026-06-26 PLAN4 迁移后)
- 残留产物位置:`.phase-execution/state.json.tmp.*` / `.bak.{1,2,3}` / `lock`

## 禁止的反模式

1. **直接调 `node tests/atdo.test.js` 而不走 `scripts/` 入口** — 易漏 timeout / 清理
2. **并发跑多个 `node --test` 进程** — 内存叠加 ~400MB/进程
3. **跑完不清理** — `.phase-execution/*.tmp` 残留掩盖状态机异常信号
4. **不带 `--test-timeout` 的长跑** — hang 时无自动恢复机制
5. **调试时手动跑全量测试** — 应优先关键字 / 单文件精准定位

## 推荐调用方式(优先级从高到低)

| 场景 | 命令 | 用途 |
|------|------|------|
| 单套件调试 | `bash scripts/test-unit.sh` | 调一次测试套件,~10s |
| 关键字定位 | `bash scripts/test-unit.sh --test-name-pattern="set-phase"` | 精确定位失败用例 |
| 集成场景 | `bash scripts/test-integration.sh` | e2e 流程验证 |
| 全量验证 | `bash scripts/test.sh` | pre-push / Step 7 关口使用 |
| 紧急清理 | `bash scripts/test-cleanup.sh` | 手动清理残留 |

**禁止**绕过 `scripts/` 入口直接拼 `node --test ...`(违反反模式 #1)。

## timeout 策略

| 场景 | 超时 | 配置位置 |
|------|------|---------|
| 单套件 / 单文件 | 30s | `scripts/test-unit.sh` 内 `--test-timeout=30000` |
| 集成 / 全量 | 60s | `scripts/test.sh` 内 `--test-timeout=60000` |
| pre-commit | 60s | `.githooks/pre-commit` 直接 fail |

**实现要求**:Node.js ≥ 18(`--test-timeout` 标志在 v18+ 可用);本项目要求 Node.js ≥ 20 已在 SKILL.md 标注。

## 清理协议(每次测试后)

```bash
bash scripts/test-cleanup.sh
```

清理范围:
- `.phase-execution/state.json.tmp.*` — 状态机写入过程的中间文件(正常 exit 应自动清理)
- `.phase-execution/*.bak.{1,2,3}` — 备份轮转文件(正常路径不应残留)
- `.phase-execution/lock` — stale lock(对应 `watchdog.sh kill-stale` 检测)

**若清理时发现残留** → 说明 phase-state.js 异常退出,需查 `.phase-execution/` 下日志。

## 紧急处理 SOP(hang / 内存爆时)

```bash
# 1. 找 node 测试进程
ps aux | grep -E "node.*test|atdo\.test" | grep -v grep

# 2. 强杀具体 PID(不杀全 node —— 会误伤 watchdog / phase-state)
kill -9 <PID>

# 3. 清残留
bash scripts/test-cleanup.sh

# 4. 验证释放
free -h
```

## 自动化钩子(已配置)

```sh
# .githooks/pre-commit
echo "[pre-commit] running atdo tests..."
bash scripts/test-unit.sh
```

AI 与人类协作者**不需要**手动跑全部测试(除非调试)— 钩子自动触发。

## 与 atdo 运行时的衔接

| 文件 | 衔接点 |
|------|--------|
| `SKILL.md` Step 7 | 改 `npx jest --findRelatedTests` → `bash scripts/test.sh` |
| `scripts/watchdog.sh` | 新增 `check-test-runtime` 子命令扫 `node --test` 残留 |
| `scripts/phase-state.js` | 新增 `check-test-runtime` 命令(供 orchestrator 调用) |
| `.claude/CLAUDE.md` | 常用命令表列出新入口 |

## 验收标准(EARS)

- **The** 单套件测试 shall 在 30s 内完成(带 `--test-timeout=30000`)
- **The** 全量测试内存占用 shall ≤ 2G(单进程,vs 无 timeout 可能堆积 4-8G)
- **The** 清理协议 shall 在 pre-commit 钩子中自动执行
- **The** `SKILL.md` Step 7 shall 引用 `scripts/test.sh`(协议与实际一致)

## Why

2026-06-25 在 prismscan-rules 项目上发生 pytest 内存爆掉事件(16G 物理机、pytest + coverage instrumentation 叠加 ~2x、单测试无 timeout 保护 hang 无人收尸)。教训提炼为 5 条核心模式,在本项目(v20+ Node.js + node:test)按相同思路适配:

1. scripts/ 入口封装 → 避免拼错参数
2. 优先级调用 → 单文件 > 关键字 > 全量
3. timeout 保护 → hang 时可恢复
4. 清理协议 → 残留不掩盖 bug
5. 钩子自动化 → 不靠人记得跑

本规则与 `engineering-practices.md §1` 测试规范是互补关系:那是「测试本身怎么写」,本规则是「测试运行怎么管」。