#!/usr/bin/env bash
# scripts/test-cleanup.sh — atdo 测试运行残留清理
# 用法: bash scripts/test-cleanup.sh
# 清理范围:
#   1. .phase-execution/state.json.tmp.* — 状态机写入中间文件(正常 exit 应自动清理)
#   2. .phase-execution/state.json.bak.{1,2,3} — 备份轮转残留(异常中断时可能堆积)
#   3. .phase-execution/lock — stale 锁(PID 不存在才删,避免破坏并发控制)
#   4. 孤儿 node --test 进程(本会话外启动的)
# 退出码: 0=全部干净, 1=有 stale 残留被清理(可能掩盖 bug,需查日志)
# 参考: .claude/rules/test-discipline.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="$PROJECT_ROOT/.phase-execution"

# 安全护栏:不允许在项目根外执行(防止误删系统 /tmp)
case "$PROJECT_ROOT" in
  "/" | "/tmp" | "/Users/"*) ;;
  *) echo "[ERROR] 不允许的项目根: $PROJECT_ROOT" >&2; exit 2 ;;
esac

if [ ! -d "$STATE_DIR" ]; then
  echo "[cleanup] .phase-execution/ 不存在,无需清理"
  exit 0
fi

CLEANED=0

# ─── 1. tmp 中间文件 ────────────────────────────────────
TMP_COUNT=$(find "$STATE_DIR" -maxdepth 1 -name 'state.json.tmp.*' -type f 2>/dev/null | wc -l | tr -d ' ')
if [ "$TMP_COUNT" -gt 0 ]; then
  find "$STATE_DIR" -maxdepth 1 -name 'state.json.tmp.*' -type f -delete 2>/dev/null || true
  echo "[cleanup] 删除 $TMP_COUNT 个 state.json.tmp.* 中间文件"
  CLEANED=$((CLEANED + TMP_COUNT))
fi

# ─── 2. 备份轮转残留 ────────────────────────────────────
BAK_COUNT=$(find "$STATE_DIR" -maxdepth 1 -name 'state.json.bak.*' -type f 2>/dev/null | wc -l | tr -d ' ')
if [ "$BAK_COUNT" -gt 3 ]; then
  # 仅在超过 3 个(超过正常轮转上限)时报警 + 删最旧的
  find "$STATE_DIR" -maxdepth 1 -name 'state.json.bak.*' -type f -printf '%T@ %p\n' 2>/dev/null \
    | sort -n \
    | head -n -3 \
    | awk '{print $2}' \
    | xargs rm -f 2>/dev/null || true
  EXCESS=$((BAK_COUNT - 3))
  echo "[cleanup] 删除 $EXCESS 个超出轮转上限的 bak 备份(>3 个说明异常中断)"
  CLEANED=$((CLEANED + EXCESS))
fi

# ─── 3. stale lock ──────────────────────────────────────
LOCK_FILE="$STATE_DIR/lock"
if [ -f "$LOCK_FILE" ]; then
  LOCK_PID=$(node -e "try{process.stdout.write(String(require('$LOCK_FILE').pid))}catch{process.stdout.write('')}" 2>/dev/null || echo "")
  if [ -n "$LOCK_PID" ]; then
    if kill -0 "$LOCK_PID" 2>/dev/null; then
      echo "[cleanup] lock PID=$LOCK_PID 仍存活,跳过(可能正在执行 atdo)"
    else
      echo "[cleanup] 删除 stale lock(PID=$LOCK_PID 已不存在)"
      rm -f "$LOCK_FILE"
      CLEANED=$((CLEANED + 1))
    fi
  else
    echo "[cleanup] lock 文件格式无效,删除"
    rm -f "$LOCK_FILE"
    CLEANED=$((CLEANED + 1))
  fi
fi

# ─── 4. 孤儿 node --test 进程 ───────────────────────────
ORPHAN_PIDS=$(pgrep -f "node.*--test.*atdo\.test|node.*_proc-use.*atdo\.test" 2>/dev/null | grep -v "^$$\$" || true)
# 排除当前 shell PID 链上的进程
CURRENT_PIDS=$(pgrep -P $$ 2>/dev/null || true)
if [ -n "$ORPHAN_PIDS" ]; then
  for pid in $ORPHAN_PIDS; do
    # 跳过当前会话进程
    if echo "$CURRENT_PIDS" | grep -q "^${pid}$"; then
      continue
    fi
    # 跳过本 cleanup 脚本的子孙
    PARENT_PID=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || echo "")
    if [ "$PARENT_PID" = "$$" ]; then
      continue
    fi
    echo "[cleanup] 终止孤儿 node --test 进程: $pid"
    kill -KILL "$pid" 2>/dev/null || true
    CLEANED=$((CLEANED + 1))
  done
fi

# ─── 汇总 ──────────────────────────────────────────────
if [ "$CLEANED" -eq 0 ]; then
  echo "[cleanup] ✅ 全部干净,无需操作"
  exit 0
else
  echo "[cleanup] ⚠️  清理了 $CLEANED 项残留 — 若非手动中断,说明 phase-state.js 异常退出,需查日志"
  exit 1
fi