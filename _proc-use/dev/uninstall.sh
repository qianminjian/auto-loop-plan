#!/usr/bin/env bash
# uninstall.sh — 过程文件，**不**纳入 git 管理
# 用途：完全移除 atdo skill（部署目录 + Claude Code 注册）
#
# 注意：会同时删除 ~/.agents/skills/atdo/，源码会被清空
#       重新安装请跑 install.sh（会自动从开发目录重新部署）

set -euo pipefail

SKILL_NAME="atdo"
LINK_PATH="$HOME/.claude/skills/$SKILL_NAME"
DEPLOY_DIR="$HOME/.agents/skills/$SKILL_NAME"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'
log()  { echo -e "${GREEN}[uninstall]${NC} $*"; }
warn() { echo -e "${YELLOW}[uninstall]${NC} $*"; }
err()  { echo -e "${RED}[uninstall]${NC} $*" >&2; }

# 1. 软链
if [ -L "$LINK_PATH" ]; then
  target=$(readlink "$LINK_PATH")
  log "移除软链: $LINK_PATH -> $target"
  rm "$LINK_PATH"
elif [ -d "$LINK_PATH" ]; then
  err "$LINK_PATH 是真实目录而非软链，为避免误删拒绝操作"
  err "如确认要删除: rm -rf $LINK_PATH"
  exit 1
elif [ -e "$LINK_PATH" ]; then
  err "$LINK_PATH 类型异常，请手动处理"
  exit 1
else
  log "软链不存在: $LINK_PATH (跳过)"
fi

# 2. 部署目录
if [ -d "$DEPLOY_DIR" ]; then
  warn "删除部署目录: $DEPLOY_DIR"
  rm -rf "$DEPLOY_DIR"
  log "已删除"
elif [ -L "$DEPLOY_DIR" ]; then
  warn "$DEPLOY_DIR 是软链，删除"
  rm "$DEPLOY_DIR"
else
  log "部署目录不存在: $DEPLOY_DIR (跳过)"
fi

echo ""
log "卸载完成。开发目录未受影响，重新安装请跑 install.sh"
