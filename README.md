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

## 三、Windows 本机常驻服务

如果用这台 Windows 电脑托管阅读器和 Dev Tunnel 公网地址，在登录 Windows 后运行一次：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-autostart.ps1
```

此脚本安装服务器计划任务和登录后启动的隧道守护进程。守护进程会检查本地及公网健康状态，连接断开时重启，并在 Dev Tunnel 凭据过期时尝试用当前 Windows 会话自动续签。查看状态：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/status.ps1
```

公网地址依赖电脑已开机、Windows 用户已登录，以及 Microsoft 登录会话仍可续签。若账户要求重新交互登录，需在桌面运行 `devtunnel user login`，然后守护进程会自动重连。

## 网页听书（阿里云语音）

手机或电脑浏览器打开阅读器，点顶部 **♫ 听书**，可以从当前阅读位置朗读。收起播放器后，点正文中的任意一句可从那句开始听；朗读位置会写入本地并随阅读进度同步，在其他网页设备上继续听时恢复到对应句。播放器支持自动续章、逐句跟读、前后跳转 15 秒、0.75～2 倍速、切换音色、定时关闭以及手机锁屏媒体控制。桌面端 Electron 小窗不启用听书。

支持 MP3 MediaSource 的浏览器（如安卓 Chrome）会把同章音频接入连续缓冲，并提前加载后续三句，避免锁屏后每句结束都需要重新启动播放。长时间播放会释放一分钟以前的音频缓冲；不支持该接口的浏览器沿用逐句播放方式。

听书需要在运行同步服务的电脑上配置阿里云百炼华北2（北京）的 API Key 和业务空间 ID。复制 `server/.env.example` 为 `server/.env`，填写：

```dotenv
DASHSCOPE_API_KEY=你的百炼APIKey
SFM_WORKSPACE_ID=你的业务空间ID
TTS_ACCESS_CODE=自己设置的一段听书密码
```

重启同步服务后，在每台设备的听书面板填写同一个听书密码。API Key 只保存在服务端，不会发送到浏览器或 Git。服务端仅接受书库中现有正文的朗读请求，按段生成 `qwen-audio-3.1-tts-flash` 音频，并将结果缓存在 `server/data/tts-cache`（或 `DATA_DIR/tts-cache`），缓存上限 512 MB。面板显示本次新合成的估算模型费用；阿里云实际账单以百炼控制台为准。没有配置密钥时，阅读与同步仍可正常使用。

## 四、上云部署（免费 + 进度持久化，Fly.io 方案）

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
