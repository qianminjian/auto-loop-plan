#!/usr/bin/env bash
# scripts/test-unit.sh — 单元测试入口(跳过 E2E 集成场景)
# 用法: bash scripts/test-unit.sh [args...]
# 跳过: 含 E2E / integration 字样的套件(由 test-integration.sh 单独跑)
# 超时: 30s(单套件基线,见 .claude/rules/test-discipline.md)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_FILE="$SCRIPT_DIR/../_proc-use/reports/atdo.test.js"

if [ ! -f "$TEST_FILE" ]; then
  echo "[ERROR] 测试文件不存在: $TEST_FILE" >&2
  exit 1
fi

node --test --test-timeout=30000 --test-skip-pattern="E2E|integration" "$TEST_FILE" "$@"