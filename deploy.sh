#!/usr/bin/env bash
# 在服务器上执行：构建前端 + 装后端依赖 + 用 pm2 常驻（监听 80 端口）
# 用法： bash deploy.sh
set -e
cd "$(dirname "$0")"
ROOT="$PWD"

echo "==> [0/4] 拉取最新代码（不然会用旧源码重复构建旧版本）"
git pull --ff-only || echo "⚠ git pull 失败（有本地改动或无网络），继续用当前代码构建"

echo "==> [1/4] 构建前端"
cd "$ROOT/app"
npm install
npm run build
BUILT_JS="$(basename "$(ls -1 "$ROOT"/app/dist/assets/index-*.js 2>/dev/null | head -1)")"
echo "   前端产物: ${BUILT_JS:-未找到}"
if grep -rq 'eric-fuhan' "$ROOT/app/dist/assets/" 2>/dev/null; then
  echo "   ✅ 已含新版标识 eric-fuhan（免同步码/夜间模式等已打包）"
else
  echo "   ⚠ 未检测到 eric-fuhan：可能仍是旧源码，请确认 git pull 成功"
fi

echo "==> [2/4] 安装后端依赖"
cd "$ROOT/server"
npm install --omit=dev

PORT="${PORT:-8787}"
echo "==> [3/4] 用 pm2 启动（${PORT} 端口，进度存 server/data）"
pm2 delete thiefbook >/dev/null 2>&1 || true
PORT="$PORT" STATIC_DIR="$ROOT/app/dist" DATA_DIR="$ROOT/server/data" \
  pm2 start index.js --name thiefbook
pm2 save

echo ""
echo "✅ 部署完成！浏览器打开  http://<你的公网IP>:${PORT}  即可。"
echo "   进度数据存在 $ROOT/server/data/store.json"
