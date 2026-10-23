# 本人访问与安全维护

公网入口使用 Dev Tunnel 的 Owner only 访问控制。手机浏览器先登录创建隧道的 Microsoft 账号，再在 `/auth/login` 输入阅读器访问密码。桌面端在设置中点击“登录同步服务”，登录窗口与同步请求共享 Cookie。旧版桌面端需要更新后才能同步；本地缓存仍可阅读。

`server/.env` 必须配置随机 `WEB_ACCESS_CODE`（至少24字符）、`AUTH_SESSION_SECRET`（至少32字符）及准确的 HTTPS `PUBLIC_ORIGIN`。这些值不能写入前端、Git、截图或日志。同步码只用于定位原有进度，不承担鉴权。浏览器会话有效期30天，Cookie 为 HttpOnly、SameSite=Lax、Secure；修改会话密钥可使所有旧会话失效。

家中常驻服务优先使用 `%LOCALAPPDATA%\thiefbook\runtimes\node-v22.23.4\node.exe`，与其他项目的 Node 安装分开。安装新安全补丁时，应核验官方 SHA-256、运行测试，再更新守护脚本的运行时路径并重启服务。容器部署需传入同样的秘密环境变量，并通过 `HOST=0.0.0.0` 监听容器网卡；Windows 默认仅监听 `127.0.0.1`。

`scripts/status.ps1` 和隧道守护程序在内存中申请仅具 connect 权限的短期令牌，用于检查私有公网入口；令牌不会落盘或打印。遇到401/403先刷新一次，再判定故障。不要为了让健康检查通过重新开放匿名访问。

应用审计位于 `DATA_DIR/security/access.jsonl`，记录时间、方法、无查询参数的路径、状态与鉴权类型，并按大小轮转。`peerIp` 是直接连接方地址；经本机隧道时通常为回环地址，不能据此识别公网真实来源。2026-10-23之前的旧日志不包含完整访问记录，不能用它证明没有匿名访问。

默认上传限制16 MiB、同时1次；进度总记录上限2000；请求速率和登录失败次数可在 `.env.example` 对照配置。听书默认每日3000次新合成、30万字及5元估算预算保护，缓存命中不计新合成。金额以模型实际用量结算，单次实际费用高于预约值时仍可能小幅超预算；需要严格费用封顶时应另设供应商侧额度。

修改安全相关逻辑后运行后端 `npm test`、前端 `npm test` 与 `npm run build`，桌面策略测试 `node --test desktop/network-policy.test.cjs`；`desktop/session-fetch.smoke.cjs` 可在真实 Electron 中检查 Cookie、Origin 和禁止跨站跟随。发布时使用 `--publish never`，不要把 `.env` 或私密审计备份放入桌面包。
