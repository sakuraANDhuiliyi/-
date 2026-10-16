# 饭点 · 附近团购

一个本地运行的团购浏览验证页：扫码登录美团，输入城市和地址，按关键词浏览附近到店团购。

## 运行

需要 Node.js 18 或更新版本，无需安装 npm 依赖。

在此目录运行 `npm start`，然后打开终端显示的本地地址（默认 http://127.0.0.1:3217）。端口占用时会自动使用接下来的端口。可通过 `MEITUAN_WEB_PORT` 指定起始端口。

1. 点击“扫码登录美团”，用美团 App 扫码完成授权；二维码失败时可打开授权链接。
2. 输入包含城市的地址，例如“上海市徐家汇”，或主动选择使用美团最近位置。
3. 输入菜系、门店或套餐名称，点击“发现团购”。可选择距离并翻页。

页面只显示真实接口返回的数据；空结果、接口拒绝和网络错误会明确提示。显示的价格为搜索接口的 `salePrice`（团购售价），不代表最终实付价。本版本没有领券、创建订单或支付接口。

## 连接方式

网页 → 本地 Node.js 后端 → 美团 Passport / 团购服务。

登录与搜索协议来自 `puzige/meituan-living-assistant-skill`，固定参考提交 `a110520ecb5166b7bbb82b7af1f23c5d63d78f58`。将原 Agent 的命令调度改为 HTTP 路由；授权流程使用相同的客户端 ID 和校验方式，签名复用仓库随附的 CLIGuard 1.3.1 组件。没有运行原 Agent、Passport CLI 或自动更新守护进程。

登录请求：
- `GET passport.meituan.com/api/account/userauth/code`
- `GET passport.meituan.com/api/account/userauth/check`

浏览请求（`click.meituan.com/cps/ai/product/`）：
- `getQrCodeImage`
- `getLocationByAddress`
- `getUserRecentLocation`
- `searchProductByAgent`

登录凭证保存在本目录 `.runtime/credentials.json`，文件权限为 0600，不返回给浏览器。首次搜索前的“已登录”仅表示已有凭证；业务请求成功后才标为“连接已验证”。退出登录会清除本地凭证。

本地服务只绑定 `127.0.0.1`，仅供本机单人验证。它没有多用户会话隔离，不能直接部署到公共网络。没有把个人登录凭证上传至托管网站。

上游响应的安全诊断保存在 `.runtime/upstream.jsonl`，只含接口路径、时间、状态、耗时和响应类型等元数据，不含请求参数、Token、签名或原始响应正文。403 不会触发自动重试或清除登录；此时可点击“重新扫码授权”，成功后重新搜索。重新授权完成会清除旧分页游标，取消授权则保留原凭证。关于持续查询失败及重新登录恢复的实测，见 [403 核实记录](docs/403-investigation.md)。

## 验证

`npm test` 包含 14 项检查，覆盖请求参数与翻页、签名的字节切片、原请求头、长分页游标、诊断字段隔离、未登录阻断、扫码授权到凭证保存的闭环、已有凭证时重新授权成功/取消，以及距离和价格缺失处理。测试使用独立临时目录和模拟响应，不触碰实际登录凭证。

真实商品搜索需要用户扫码授权。首屏曾成功返回 7 款真实团购，随后搜索收到 HTTP 403；用户重新登录后，本地记录连续 7 次搜索返回 HTTP 和业务码 200。当前恢复已经验证，登录状态的长期稳定性仍需观察。详见 `验证记录.md`。

## 来源与许可

上游仓库：https://github.com/puzige/meituan-living-assistant-skill

`vendor/cliguard.cjs` 是上游 `scripts/vendor/cliguard/js/cliguard.js` 的原样副本，保留于本地个人验证。上游声明美团拥有原组件版权，商业使用及再分发须获许可；详见 `vendor/UPSTREAM-LICENSE`。
