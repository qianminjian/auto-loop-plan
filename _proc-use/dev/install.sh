#!/usr/bin/env bash
# install.sh — 过程文件，**不**纳入 git 管理
# 用途：把开发目录的源码部署到用户级 skill 目录，并注册到 Claude Code
#
# 部署模式（与"参考其他 skill"一致）：
#   1. 把 ./SKILL.md、./scripts/、./templates/ 复制到 ~/.agents/skills/atdo/
#   2. 创建软链 ~/.claude/skills/atdo -> ../../.agents/skills/atdo
#
# 用法：
#   bash .dev/install.sh           # 部署 + 注册
#   bash .dev/install.sh --check   # 仅检查状态
#   bash .dev/install.sh --unlink  # 仅做软链（源码已经手动放好了）

set -euo pipefail

SKILL_NAME="atdo"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# install.sh 位于 _proc-use/dev/，向上两级才是项目根目录
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_DIR="$HOME/.agents/skills/$SKILL_NAME"
LINK_PATH="$HOME/.claude/skills/$SKILL_NAME"

# 部署要复制的项（标准 skill 结构：SKILL.md + scripts/ + references/）
DEPLOY_ITEMS=("SKILL.md" "scripts" "references")

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'
log()  { echo -e "${GREEN}[install]${NC} $*"; }
warn() { echo -e "${YELLOW}[install]${NC} $*"; }
err()  { echo -e "${RED}[install]${NC} $*" >&2; }

# ── --check：只报告状态 ─────────────────────────────
if [ "${1:-}" = "--check" ]; then
  ERR=0
  if [ ! -d "$DEPLOY_DIR" ]; then
    err "用户级 skill 目录不存在: $DEPLOY_DIR"
    ERR=1
  else
    log "已部署: $DEPLOY_DIR"
  fi
  if [ ! -e "$LINK_PATH" ] && [ ! -L "$LINK_PATH" ]; then
    err "未注册: $LINK_PATH 不存在"
    ERR=1
  else
    target=$(readlink "$LINK_PATH" 2>/dev/null || echo "")
    if [ "$target" = "../../.agents/skills/$SKILL_NAME" ]; then
      log "已注册: $LINK_PATH -> $target"
    else
      err "软链异常: $LINK_PATH -> $target"
      ERR=1
    fi
  fi
  exit $ERR
fi

# ── --unlink：仅处理软链（不动部署目录）────────────
if [ "${1:-}" = "--unlink" ]; then
  if [ -L "$LINK_PATH" ]; then
    rm "$LINK_PATH"
    log "已移除软链: $LINK_PATH"
  fi
  exit 0
fi

# ── 主流程：部署 + 注册 ─────────────────────────────

# 1. 校验开发目录源
for item in "${DEPLOY_ITEMS[@]}"; do
  if [ ! -e "$PROJECT_DIR/$item" ]; then
    err "开发目录缺少: $item"
    err "路径: $PROJECT_DIR/$item"
    exit 1
  fi
done
log "开发目录源: $PROJECT_DIR"

# 2. 部署到用户级目录
#    策略：先清空 DEPLOY_DIR（确保旧文件不残留），再 rsync 复制
#    效果：用户级目录 = 开发目录的三项（SKILL.md/scripts/templates）的精确镜像
if ! command -v rsync >/dev/null 2>&1; then
  err "需要 rsync（macOS 自带；如缺失请 brew install rsync）"
  exit 1
fi

# 备份旧部署（如有）
if [ -d "$DEPLOY_DIR" ]; then
  BACKUP_DIR="$DEPLOY_DIR.bak.$(date +%Y%m%d-%H%M%S)"
  # 检测旧部署中是否有源码未跟踪的文件(用户自定义 notes/hooks/等)
  UNTRACKED=$(find "$DEPLOY_DIR" -mindepth 1 \
    -not -name 'SKILL.md' \
    -not -path "$DEPLOY_DIR/scripts/*" \
    -not -path "$DEPLOY_DIR/references/*" \
    2>/dev/null)
  if [ -n "$UNTRACKED" ]; then
    warn "旧部署中发现源码未跟踪的文件,这些文件将随旧部署一起 mv 到备份目录:"
    echo "$UNTRACKED" | sed 's/^/  /'
    warn "如需保留,请先手动 cp 到其他位置"
  fi
  warn "备份旧部署到: $BACKUP_DIR"
  mv "$DEPLOY_DIR" "$BACKUP_DIR"
fi

# 创建空目录并同步
mkdir -p "$DEPLOY_DIR"
for item in "${DEPLOY_ITEMS[@]}"; do
  if [ -d "$PROJECT_DIR/$item" ]; then
    rsync -a --delete \
      "$PROJECT_DIR/$item/" "$DEPLOY_DIR/$item/"
  elif [ -f "$PROJECT_DIR/$item" ]; then
    rsync -a "$PROJECT_DIR/$item" "$DEPLOY_DIR/$item"
  else
    err "未知类型，跳过: $PROJECT_DIR/$item"
    continue
  fi
done
log "已部署到: $DEPLOY_DIR"

# 3. 注册到 Claude Code
if [ -L "$LINK_PATH" ]; then
  old_target=$(readlink "$LINK_PATH")
  if [ "$old_target" = "../../.agents/skills/$SKILL_NAME" ]; then
    log "软链已存在: $LINK_PATH -> $old_target"
  else
    warn "替换旧软链: $LINK_PATH -> $old_target"
    rm "$LINK_PATH"
    ln -s "../../.agents/skills/$SKILL_NAME" "$LINK_PATH"
    log "新软链: $LINK_PATH -> ./.agents/skills/$SKILL_NAME"
  fi
elif [ -d "$LINK_PATH" ]; then
  err "$LINK_PATH 是真实目录（非软链），为避免覆盖拒绝安装"
  err "如确认要替换: rm -rf $LINK_PATH 后重跑"
  exit 1
elif [ -e "$LINK_PATH" ]; then
  err "$LINK_PATH 类型异常，请手动处理"
  exit 1
else
  ln -s "../../.agents/skills/$SKILL_NAME" "$LINK_PATH"
  log "已注册: $LINK_PATH -> ./.agents/skills/$SKILL_NAME"
fi

# 4. 验证：跑一个无副作用的命令
TMPDIR_CHECK=$(mktemp -d)
if (cd "$TMPDIR_CHECK" && \
   echo '{"phases":[{"name":"install-check","goal":"verify"}]}' | node "$DEPLOY_DIR/scripts/phase-state.js" init >/dev/null 2>&1); then
  log "脚本自检通过"
  rm -rf "$TMPDIR_CHECK"
else
  warn "脚本自检失败（请检查 node 环境和脚本完整性）"
  rm -rf "$TMPDIR_CHECK"
fi

echo ""
log "部署完成！"
log "  开发目录: $PROJECT_DIR"
log "  用户级: $DEPLOY_DIR"
log "  Claude Code 注册: $LINK_PATH"
echo ""
log "下次启动 Claude Code 即可使用 /$SKILL_NAME"
log "源码改动后重跑此脚本即可更新部署"
