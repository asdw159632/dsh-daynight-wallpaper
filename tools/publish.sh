#!/usr/bin/env bash
# 把当前工作区树同步到 GitHub 仓库并推送。
#
# 做法：在 tmp/publish/ 里维护一份「只含可发布文件」的检出（不含源动图），
# 把工作区里该发布的文件 rsync 过去，有改动就提交并推送。
#
# 用法：./tools/publish.sh [提交说明]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPO="${PUBLISH_REPO:-https://github.com/asdw159632/dsh-daynight-wallpaper.git}"
DIR="${PUBLISH_DIR:-$ROOT/tmp/publish/daynight-wallpaper}"
MESSAGE="${1:-sync: $(date '+%Y-%m-%d %H:%M')}"
BRANCH="${PUBLISH_BRANCH:-main}"

if [ -d "$DIR/.git" ]; then
  env -u GIT_CONFIG_COUNT -u GIT_CONFIG_VALUE_0 git -C "$DIR" pull --ff-only -q
else
  mkdir -p "$(dirname "$DIR")"
  env -u GIT_CONFIG_COUNT -u GIT_CONFIG_VALUE_0 git clone -q "$REPO" "$DIR"
fi

# 只同步要发布的：插件代码 + 素材 + 工具 + 截图 + 文档；源动图与被忽略的文件不进
rsync -a --delete \
  --exclude '.git' --exclude 'tmp' --exclude '*.gif' \
  "$ROOT"/ "$DIR"/

cd "$DIR"
git checkout -q -B "$BRANCH"
if [ -z "$(git status --porcelain)" ]; then
  echo "没有改动，已是最新：$REPO"
  exit 0
fi
git add -A
env -u GIT_CONFIG_COUNT -u GIT_CONFIG_VALUE_0 git \
  -c user.name="${GIT_AUTHOR_NAME:-asdw159632}" \
  -c user.email="${GIT_AUTHOR_EMAIL:-asdw159632@users.noreply.github.com}" \
  commit -q -m "$MESSAGE"
env -u GIT_CONFIG_COUNT -u GIT_CONFIG_VALUE_0 git push -q origin "HEAD:$BRANCH"
echo "已推送：$REPO"
