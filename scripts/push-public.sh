#!/bin/bash
# push-public.sh — 推送到 GitHub 时剥离 _proc-use/（项目策略：过程文档本地 git 跟踪，不对外）
# 用法: bash scripts/push-public.sh [remote] [branch]
#   默认: remote=origin, branch=main
#
# 工作原理（临时分支模式，不污染 main 历史）：
#   1. 从当前 main 创建临时分支 public-<timestamp>
#   2. 临时分支上 git rm --cached _proc-use/（仅去 index 不删本地）
#   3. amend 形成"无 _proc-use/"的 commit
#   4. push 临时分支到 remote 的目标 branch
#   5. 切回 main，删临时分支
#   6. 本地 _proc-use/ 文件物理保留，main branch 完全不动
#
# 安全保证：
#   - main branch 历史不变
#   - 本地 _proc-use/ 物理文件不删
#   - 任一步失败 → 脚本退出，main 仍可恢复（git checkout main 即可）

set -euo pipefail

REMOTE="${1:-origin}"
BRANCH="${2:-main}"
TEMP_BRANCH="public-push-$(date +%s)"
ORIG_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# 前置检查 1: 必须在 main 分支（防 release 分支等误用）
if [ "$ORIG_BRANCH" != "main" ]; then
  echo "[push-public] ❌ 当前在分支 '$ORIG_BRANCH'，必须在 main 分支才能 push public"
  exit 1
fi

# 前置检查 2: 工作区干净（防未提交改动丢失）
if [ -n "$(git status --porcelain | grep -v '^?? .serena/')" ]; then
  echo "[push-public] ❌ 工作区不干净（除 .serena/ 外有未提交改动）"
  echo "请先 commit 或 stash 后再 push"
  git status --short
  exit 1
fi

# 前置检查 3: remote 存在
if ! git remote get-url "$REMOTE" > /dev/null 2>&1; then
  echo "[push-public] ❌ remote '$REMOTE' 不存在"
  echo "可用 remote: $(git remote)"
  exit 1
fi

echo "[push-public] 远端: $REMOTE → 目标分支: $BRANCH"
echo "[push-public] 临时分支: $TEMP_BRANCH"

# 1. 创建临时分支
git checkout -b "$TEMP_BRANCH" > /dev/null
trap 'echo "[push-public] ⚠️  异常退出，回到 $ORIG_BRANCH"; git checkout "$ORIG_BRANCH" > /dev/null 2>&1 || true; git branch -D "$TEMP_BRANCH" > /dev/null 2>&1 || true' ERR

# 2. 剥离 _proc-use/ from index（保留 atdo.test.js，CI 需要）
if git ls-files _proc-use/ | head -1 | grep -q .; then
  COUNT=$(git ls-files _proc-use/ | wc -l | tr -d ' ')
  git rm -rf --cached _proc-use/ > /dev/null
  # 保留 atdo.test.js（CI 工作流需要测试文件可访问）
  git add _proc-use/reports/atdo.test.js
  echo "[push-public] 剥离 $((COUNT - 1)) 个 _proc-use/ 文件，保留 atdo.test.js (CI 需要)"
else
  echo "[push-public] _proc-use/ 不在 git 索引中，跳过剥离"
fi

# 2b. 替换 .gitignore 为 GitHub-friendly 版本（让 _proc-use/ 在 GitHub 上显示为 ignored）
# 解决一致性 bug：剥离 _proc-use/ 文件后，.gitignore 也必须改为不允许 _proc-use/
# 否则 clone 用户看到"应允许跟踪但仓库为空"的矛盾
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$SCRIPT_DIR/.gitignore.public" ]; then
  echo "[push-public] ❌ 未找到 $SCRIPT_DIR/.gitignore.public 模板"
  exit 1
fi
cp "$SCRIPT_DIR/.gitignore.public" .gitignore
git add .gitignore
echo "[push-public] .gitignore 替换为 GitHub-friendly 版本（_proc-use/ ignored）"

# 3. amend commit（保留原 message + Co-Authored-By，加 release 标记）
ORIG_MSG=$(git log -1 --pretty=%B)
git commit --amend -m "$ORIG_MSG" -m "[push-public] _proc-use/ stripped for GitHub" > /dev/null
echo "[push-public] amend commit 完成"

# 4. push 到 remote
echo "[push-public] push $TEMP_BRANCH → $REMOTE/$BRANCH"
git push "$REMOTE" "$TEMP_BRANCH:$BRANCH"

# 5. 清理：回原分支 + 删临时分支
git checkout "$ORIG_BRANCH" > /dev/null
git branch -D "$TEMP_BRANCH" > /dev/null

# 6. 完成
trap - ERR
echo ""
echo "[push-public] ✅ 完成"
echo "  - 本地 main: 不变（_proc-use/ 仍在 git）"
echo "  - 远端 $REMOTE/$BRANCH: 已更新（不含 _proc-use/）"
echo "  - 本地 _proc-use/ 物理文件: 不变"
