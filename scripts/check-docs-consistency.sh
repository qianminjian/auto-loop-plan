#!/usr/bin/env bash
# check-docs-consistency.sh — 验证文档中声称的行数/指标与实际一致
# 退出码: 0=全部一致, 1=存在差异
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

ERRORS=0

check() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" != "$actual" ]; then
    echo "[FAIL] $label: expected '$expected', got '$actual'"
    ERRORS=$((ERRORS + 1))
  else
    echo "[PASS] $label: $actual"
  fi
}

echo "=== 文档一致性检查 ==="
echo

# SKILL.md
SKILL_ACTUAL=$(wc -l < SKILL.md | awk '{print $1}')
check "SKILL.md 行数" "2432" "$SKILL_ACTUAL"

# phase-state.js (2026-06-28 P0-F 审计修复后)
PS_ACTUAL=$(wc -l < scripts/phase-state.js | awk '{print $1}')
check "phase-state.js 行数" "2346" "$PS_ACTUAL"

# watchdog.sh (2026-06-28 P0-F 审计修复后)
WD_ACTUAL=$(wc -l < scripts/watchdog.sh | awk '{print $1}')
check "watchdog.sh 行数" "294" "$WD_ACTUAL"

# atdo.test.js
TEST_ACTUAL=$(wc -l < tests/atdo.test.js | awk '{print $1}')
check "atdo.test.js 行数" "5173" "$TEST_ACTUAL"

echo
echo "=== 检查完成: $ERRORS 个不一致 ==="
[ $ERRORS -eq 0 ]
