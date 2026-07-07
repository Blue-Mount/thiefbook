#!/usr/bin/env bash
# 在服务器上执行：构建前端 + 装后端依赖 + 用 pm2 常驻（监听 80 端口）
# 用法： bash deploy.sh
set -e
cd "$(dirname "$0")"
ROOT="$PWD"

echo "==> [1/3] 构建前端"
cd "$ROOT/app"
npm install
npm run build

echo "==> [2/3] 安装后端依赖"
cd "$ROOT/server"
npm install --omit=dev

echo "==> [3/3] 用 pm2 启动（80 端口，进度存 server/data）"
pm2 delete thiefbook >/dev/null 2>&1 || true
PORT=80 STATIC_DIR="$ROOT/app/dist" DATA_DIR="$ROOT/server/data" \
  pm2 start index.js --name thiefbook
pm2 save

echo ""
echo "✅ 部署完成！浏览器打开  http://<你的公网IP>  即可。"
echo "   进度数据存在 $ROOT/server/data/store.json"
