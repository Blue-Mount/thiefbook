# 摸鱼看书 · 跨端小说阅读器（自建版）

一套自己的、进度多端同步的小说阅读器，替代付费闭源的 thief-book。

- **前端** `app/`：Vite + Vue 3 的 PWA 阅读器，手机/电脑浏览器都能用，可"添加到主屏幕"当 App，支持离线阅读。
- **后端** `server/`：极简 Node 同步服务，用「同步码」区分用户，进度 last-write-wins（谁最新用谁）。可顺带托管前端，一个网址搞定。
- **脚本** `scripts/build-book.mjs`：把 txt 小说（自动识别 GBK/UTF-8）转成前端用的分章 JSON。

## 核心用法：怎么实现"公司/家里进度同步"

两台设备打开同一个网址，在 **设置 ⚙ → 多端同步** 里填**相同的同步码**（比如 `eric-2026`），就会自动同步。
在公司看到第 20 章，回家打开自动跳到第 20 章。

---

## 一、本地跑起来（开发/自测）

```bash
# 1) 生成书籍数据（已生成过一次，换书时再跑）
node scripts/build-book.mjs "《覆汉》作者：榴弹怕水.txt" fuhan

# 2) 装依赖
cd app && npm install
cd ../server && npm install

# 3a) 开发模式（前端热更新，端口 5173；另开一个终端跑同步服务）
cd app && npm run dev
cd server && npm run dev     # 同步服务 http://localhost:8787
#   → 设置里"服务器地址"填 http://localhost:8787

# 3b) 或：一体化模式（先构建前端，再由同步服务托管，一个端口）
cd app && npm run build
cd ../server && npm start     # 打开 http://localhost:8787
#   → 一体化模式下"服务器地址"留空即可
```

### 手机和电脑同一 WiFi 下先试同步（不用上云）
1. 电脑上跑「一体化模式」。
2. 查电脑内网 IP（`ipconfig`，如 `192.168.1.20`）。
3. 手机浏览器打开 `http://192.168.1.20:8787`，设置里同步码填成和电脑一样。

> 注意：这只在同一 WiFi 下有效。要实现「公司 ↔ 家里」跨网络同步，需要下面的上云部署。

## 二、换一本别的小说

```bash
node scripts/build-book.mjs "你的小说.txt" mybook
```
会在 `app/public/books/mybook.json` 生成数据（编码自动识别）。目前前端写死读 `fuhan`，多书书架在下一阶段做。

## 三、上云部署（免费 + 进度持久化，Fly.io 方案）

已备好 `Dockerfile` 和 `fly.toml`（含持久化卷，香港节点）。

```bash
# 装 flyctl 并登录（需注册 fly.io 账号）
# Windows: iwr https://fly.io/install.ps1 -useb | iex
fly auth login
fly launch --copy-config --no-deploy   # 确认 app 名唯一
fly volumes create thiefbook_data --size 1 --region hkg
fly deploy
```
部署完成后得到一个 `https://xxx.fly.dev` 网址：手机和电脑都打开它，填相同同步码即可。

> 其它免费平台（Render/Railway 等）多数**没有持久化磁盘**，重启会丢进度。若要用，需把存储换成外部数据库（如 Upstash Redis），可后续扩展——`server/index.js` 的存储层已单独封装，方便替换。

## 路线图

- [x] MVP：网页阅读器读《覆汉》+ 进度云同步
- [ ] 多书书架 / 上传 txt
- [ ] 桌面端 Electron 套壳 + 摸鱼隐身（老板键、透明置顶、任务栏伪装）
- [ ] 阅读体验：翻页动画、自动翻页、夜间定时
