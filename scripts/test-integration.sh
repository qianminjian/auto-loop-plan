#!/usr/bin/env bash
# scripts/test-integration.sh — 集成测试入口(仅跑 E2E / integration)
# 用法: bash scripts/test-integration.sh [args...]
# 仅跑: 名称匹配 E2E / integration 的套件
# 超时: 60s(集成场景含 io 等待,见 .claude/rules/test-discipline.md)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_FILE="$SCRIPT_DIR/../tests/atdo.test.js"

if [ ! -f "$TEST_FILE" ]; then
  echo "[ERROR] 测试文件不存在: $TEST_FILE" >&2
  exit 1
fi

node --test --test-timeout=60000 --test-name-pattern="E2E|integration" "$TEST_FILE" "$@"