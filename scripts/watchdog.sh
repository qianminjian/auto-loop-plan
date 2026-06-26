#!/usr/bin/env bash
# watchdog.sh — atdo 看门狗脚本
# 功能：孤儿进程清理、心跳监控、僵尸 Agent 终止
#
# 用法:
#   bash watchdog.sh cleanup         清理孤儿 agent 进程
#   bash watchdog.sh check-heartbeat 检查心跳是否超时
#   bash watchdog.sh kill-stale <pid> 强制终止僵死进程

set -euo pipefail

STATE_DIR=".phase-execution"
HEARTBEAT_FILE="$STATE_DIR/heartbeat.json"
LOCK_FILE="$STATE_DIR/lock"
STATE_FILE="$STATE_DIR/state.json"
# P0-1 (Task Timeout & Heartbeat Protocol):
# 三级响应常量(fallback 场景,当 heartbeat.json 无 taskDeadline 字段时使用)
WARN_TIMEOUT=300        # 5 min  → 软警告(stderr 输出,不写 state)
STRIKE_TIMEOUT=600      # 10 min → 硬警告(调 inc-strike slow-heartbeat)
KILL_TIMEOUT=900        # 15 min → 终止(SIGTERM + 30s 后 SIGKILL + 清 lock)
# 有 taskDeadline 时 → 用相对阈值(taskDuration × 33% / 66% / 100%)
STRIKE_KIND="slow-heartbeat"  # inc-strike 的 type 字段

# ─── 清理孤儿进程 ───────────────────────────────────────

cleanup_orphans() {
  echo "[watchdog] 开始清理孤儿进程..."

  # 清理可能残留的 gsd agent 子进程
  local orphan_pids
  orphan_pids=$(pgrep -f "gsd-executor|gsd-code-reviewer|gsd-code-fixer|gsd-integration-checker" 2>/dev/null || true)

  if [ -n "$orphan_pids" ]; then
    for pid in $orphan_pids; do
      # 检查父进程是否还存在
      local ppid
      ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
      if [ -n "$ppid" ]; then
        if [ "$ppid" = "1" ] || ! kill -0 "$ppid" 2>/dev/null; then
          echo "[watchdog] 终止孤儿 agent 进程: pid=$pid (父进程 $ppid 已不存在或为 init)"
          kill -TERM "$pid" 2>/dev/null || true
          sleep 2
          kill -KILL "$pid" 2>/dev/null || true
        fi
      fi
    done
  fi

  # 清理 node 子进程（atdo 仅调用 gsd-* agents;只有 cmdline 同时含 node+gsd- 才视为孤儿）
  # 避免误杀 `node ~/.claude/agents/my-tool.js` 这类用户脚本
  local node_orphans
  node_orphans=$(pgrep -f "node.*gsd-executor|node.*gsd-code-reviewer|node.*gsd-code-fixer|node.*gsd-integration-checker" 2>/dev/null || true)
  if [ -n "$node_orphans" ]; then
    for pid in $node_orphans; do
      local ppid
      ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
      if [ -n "$ppid" ]; then
        if [ "$ppid" = "1" ] || ! kill -0 "$ppid" 2>/dev/null; then
          echo "[watchdog] 终止孤儿 node 进程: pid=$pid"
          kill -KILL "$pid" 2>/dev/null || true
        fi
      fi
    done
  fi

  echo "[watchdog] 孤儿进程清理完成"
}

# ─── 心跳检查 ───────────────────────────────────────────

check_heartbeat() {
  if [ ! -f "$HEARTBEAT_FILE" ]; then
    echo "[watchdog] 心跳文件不存在，编排器可能未启动"
    return 0
  fi

  # P1-3: 检查 state.json 顶层 awaiting_user_review 标记
  # manual gate 期间用户在答复,心跳可能暂停(等用户)。
  # SKILL.md 协议明确:watchdog 看到 awaiting_user_review 应正常 hold,不应判定心跳超时
  if [ -f "$STATE_FILE" ]; then
    local awaiting
    # P2-6: 前置守护 — state.json 损坏/非 JSON 时 node require 会抛 SyntaxError,
    # 虽然 node -e 内部 try/catch 已兜底,但再前置一道存在性 + 大小检查,
    # 减少不必要的 node 进程起降,并避免 0 字节文件触发奇怪错误
    if [ ! -s "$STATE_FILE" ]; then
      awaiting="NO"
    else
      awaiting=$(node -e "try{const s=require('./$STATE_FILE');process.stdout.write(s.awaiting_user_review?'YES':'NO')}catch{process.stdout.write('NO')}" 2>/dev/null || echo "NO")
    fi
    if [ "$awaiting" = "YES" ]; then
      echo "[watchdog] 检测到 awaiting_user_review 标记 (manual gate 期间),跳过心跳超时判定"
      return 0
    fi
  fi

  local hb_time
  # P2-6: 前置守护 — heartbeat 文件损坏/0 字节时直接走 fallback,避免无意义 node 调用
  if [ -s "$HEARTBEAT_FILE" ]; then
    hb_time=$(node -e "try{process.stdout.write(require('./$HEARTBEAT_FILE').timestamp)}catch{}" 2>/dev/null || echo "")
  else
    hb_time=""
  fi

  if [ -z "$hb_time" ]; then
    echo "[watchdog] ALERT: 心跳文件损坏或格式无效，编排器可能崩溃"
    return 1
  fi

  local now_sec hb_sec diff_sec
  now_sec=$(date +%s)

  # Try node first (most portable across macOS/Linux)
  hb_sec=$(node -e "console.log(Math.floor(new Date('$hb_time').getTime()/1000))" 2>/dev/null || echo 0)

  if [ "$hb_sec" = "0" ]; then
    # Fallback: try macOS date, then Linux date
    hb_sec=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${hb_time%%.*}" +%s 2>/dev/null || date -d "${hb_time%%.*}" +%s 2>/dev/null || echo 0)
  fi

  if [ "$hb_sec" = "0" ]; then
    echo "[watchdog] 无法解析心跳时间"
    return 0
  fi

  diff_sec=$((now_sec - hb_sec))

  # P0-1:优先读 taskDeadline(若有)→ 相对阈值;否则用 fallback 绝对值 5/10/15 min
  local warn_threshold strike_threshold kill_threshold use_relative
  use_relative=false
  if [ -s "$HEARTBEAT_FILE" ]; then
    local task_deadline_sec
    task_deadline_sec=$(node -e "try{const d=require('./$HEARTBEAT_FILE').taskDeadline;if(!d)process.exit(1);process.stdout.write(String(Math.floor(new Date(d).getTime()/1000)))}catch{process.exit(1)}" 2>/dev/null || echo "0")
    if [ -n "$task_deadline_sec" ] && [ "$task_deadline_sec" -gt 0 ]; then
      local task_duration=$((task_deadline_sec - hb_sec))
      if [ "$task_duration" -gt 0 ]; then
        warn_threshold=$((task_duration / 3))
        strike_threshold=$((task_duration * 2 / 3))
        kill_threshold=$task_duration
        use_relative=true
      fi
    fi
  fi
  if [ "$use_relative" = false ]; then
    warn_threshold=$WARN_TIMEOUT
    strike_threshold=$STRIKE_TIMEOUT
    kill_threshold=$KILL_TIMEOUT
  fi

  # P0-1:三级响应 — soft warn / hard warn(strike) / kill
  if [ "$diff_sec" -ge "$kill_threshold" ]; then
    action_kill "$diff_sec" "$kill_threshold" "$use_relative"
    return 1
  elif [ "$diff_sec" -ge "$strike_threshold" ]; then
    action_strike "$diff_sec" "$strike_threshold" "$use_relative"
    return 1
  elif [ "$diff_sec" -ge "$warn_threshold" ]; then
    action_warn "$diff_sec" "$warn_threshold" "$use_relative"
    return 0
  else
    echo "[watchdog] 心跳正常 (${diff_sec}s 前)"
    return 0
  fi
}

# ─── P0-1:三级响应 action 函数 ───────────────────────────────
# 设计:action_warn 不写 state(避免误判);action_strike 调 inc-strike;
#       action_kill 发送 SIGTERM → 30s 后 SIGKILL → 清 lock + heartbeat

action_warn() {
  local diff="$1" threshold="$2" relative="$3"
  local kind
  [ "$relative" = "true" ] && kind="相对阈值(taskDuration×33%)" || kind="fallback 绝对阈值(${WARN_TIMEOUT}s)"
  echo "[watchdog] [WARN] heartbeat slow: ${diff}s ≥ ${threshold}s (${kind})"
  echo "[watchdog] orchestrator 下一 turn 检查到 warn 后应注入提示给 agent"
}

action_strike() {
  local diff="$1" threshold="$2" relative="$3"
  local kind
  [ "$relative" = "true" ] && kind="相对阈值(taskDuration×66%)" || kind="fallback 绝对阈值(${STRIKE_TIMEOUT}s)"
  echo "[watchdog] [STRIKE] heartbeat slow: ${diff}s ≥ ${threshold}s (${kind})"
  # 调 phase-state.js inc-strike 写 state
  # 用 watchdog.sh 所在目录解析 scripts/phase-state.js 绝对路径,避免 cwd 漂移导致找不到
  local phase_state_bin="${WATCHDOG_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/phase-state.js"
  local current_phase
  current_phase=$(node -e "try{const s=require('./$STATE_FILE');process.stdout.write(s.phases?.[s.currentPhaseIndex]?.number||'')}catch{process.stdout.write('')}" 2>/dev/null || echo "")
  if [ -n "$current_phase" ]; then
    node "$phase_state_bin" inc-strike "$current_phase" "$STRIKE_KIND" 2>&1 | tail -1 || true
  else
    echo "[watchdog] [WARN] 无法读 currentPhaseIndex,跳过 strike 写入"
  fi
}

action_kill() {
  local diff="$1" threshold="$2" relative="$3"
  local kind
  [ "$relative" = "true" ] && kind="相对阈值(taskDuration×100%)" || kind="fallback 绝对阈值(${KILL_TIMEOUT}s)"
  echo "[watchdog] [KILL] heartbeat timeout: ${diff}s ≥ ${threshold}s (${kind})"
  # 读取锁文件确认
  if [ -f "$LOCK_FILE" ]; then
    local lock_pid
    lock_pid=$(node -e "try{process.stdout.write(String(require('./$LOCK_FILE').pid))}catch{}" 2>/dev/null || echo "")
    if [ -n "$lock_pid" ]; then
      if ! kill -0 "$lock_pid" 2>/dev/null; then
        echo "[watchdog] 编排器进程 $lock_pid 已不存在，清理锁文件"
        rm -f "$LOCK_FILE"
      else
        echo "[watchdog] 编排器进程 $lock_pid 仍存活但无心跳，发送 SIGTERM"
        kill -TERM "$lock_pid" 2>/dev/null || true
        sleep 30
        if kill -0 "$lock_pid" 2>/dev/null; then
          echo "[watchdog] 进程未响应 SIGTERM，发送 SIGKILL"
          kill -KILL "$lock_pid" 2>/dev/null || true
        fi
      fi
    fi
  fi
  # 清 heartbeat(避免下一轮立刻再次 kill)
  rm -f "$HEARTBEAT_FILE" 2>/dev/null || true
}

# ─── 强制终止 ───────────────────────────────────────────

kill_stale() {
  local target_pid="$1"
  if [ -z "$target_pid" ]; then
    echo "[watchdog] 未指定 pid"
    exit 1
  fi

  if kill -0 "$target_pid" 2>/dev/null; then
    echo "[watchdog] 发送 SIGTERM 到 $target_pid"
    kill -TERM "$target_pid" 2>/dev/null || true
    sleep 3
    if kill -0 "$target_pid" 2>/dev/null; then
      echo "[watchdog] 进程未响应，发送 SIGKILL"
      kill -KILL "$target_pid" 2>/dev/null || true
    fi
  else
    echo "[watchdog] 进程 $target_pid 已不存在"
  fi
  # 清理相关资源
  cleanup_orphans
  echo "[watchdog] 僵死进程清理完毕"
}

# ─── 入口 ────────────────────────────────────────────────

case "${1:-}" in
  cleanup)
    cleanup_orphans
    ;;
  check-heartbeat)
    check_heartbeat
    ;;
  kill-stale)
    kill_stale "${2:-}"
    ;;
  *)
    echo "用法: watchdog.sh {cleanup|check-heartbeat|kill-stale <pid>}"
    exit 1
    ;;
esac
