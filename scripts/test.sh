#!/usr/bin/env bash
# scripts/test.sh — atdo 全量测试入口
# 用法: bash scripts/test.sh [args...]
# 自动应用: --test-timeout=60000 + 退出码透传
# 设计: 避免 SKILL.md/agent 拼错参数,统一超时基线
# 参考: .claude/rules/test-discipline.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_FILE="$SCRIPT_DIR/../tests/atdo.test.js"

if [ ! -f "$TEST_FILE" ]; then
  echo "[ERROR] 测试文件不存在: $TEST_FILE" >&2
  exit 1
fi

node --test --test-timeout=60000 "$TEST_FILE" "$@"