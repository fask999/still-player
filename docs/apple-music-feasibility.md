# Apple Music：实际能力与交付边界

核验日期：**2026-10-30**。当前默认后端是 **officialWeb**：本程序自有的 Microsoft WebView2 窗口打开真正的 `https://music.apple.com/cn/new`，使用该官网已经配置的 MusicKit 实例。用户不需要另买 Cider 或注册 Apple Developer；仍须有可用的 Apple Music 订阅，并亲自在真实 Apple 页面登录。

这是官网上下文中的公开方法互操作，**不是 Apple 承诺稳定的无界面播放器 SDK**。官网变化、账号授权、浏览器播放手势或 DRM 许可证都可能使部分能力失效。界面必须按实际能力启用，不能用示例歌曲、试听或成功样式代替验证。

## 已实际完成的核验

| 项目 | 实际结果 | 证据 |
| --- | --- | --- |
| stock Electron 45.1.0 / Chromium 156 | AAC/AVC 解码与 EME API 存在；测试的 Widevine、PlayReady、FairPlay 请求均 `NotSupportedError`；ClearKey 可用，不能代表 Apple DRM | [完整日志](evidence/apple-music-electron-20261030.log) |
| 本机 WebView2 Evergreen 155.0.4283.62 | 在回环页与真正 Apple HTTPS 页，Widevine 的三组配置可用；PlayReady 的 AAC/AVC 两组配置可用；FairPlay 不可用 | [EME 探测](evidence/apple-music-webview2-20261030/webview2-eme.json) |
| 官网已经配置的实例 | `MusicKit.getInstance()` 成功；公开的 play/pause/stop/next/previous/seek/setQueue/api.music 入口存在；未登录、未播放 | [公开方法矩阵](evidence/apple-official-public-probe-20261030/webview2-eme.json) |
| 真实目录读取 | 在官网上下文只调用一次公开 `api.music('/v1/catalog/cn/search?...')`，成功返回一条真实歌曲的 ID、名称、作者和时长白名单 | [目录探测](evidence/apple-official-catalog-probe-20261030/webview2-eme.json) |
| 正式原生组件 | 编译成功；未登录时带真实业务字符串 ID 的 playlist-songs 请求正确返回 `needs-auth`，没有发出曲库请求；窗口音频为静音 | [原生 smoke](evidence/apple-official-native-smoke-20261030.json) |
| 自有进程释放 | 正式组件正常关闭后实际收到 `BrowserProcessExited=true` 与 `helperExited=true` | 同上；这是无播放状态下的生命周期实证，尚未验证实际订阅播放中的跨引擎切换 |

EME 查询仅证明运行时提供相应 CDM 接口。它没有取得任何歌曲许可证，不能证明 Apple 接受该 CDM、账号订阅有效、歌曲能播全曲或 DAC 当前采用何种采样率。本次没有登录、授权账户、播放音乐或启动用户原来的 foobar2000。

## 当前能力与未验证项

| 能力 | 入口和实现 | 当前证据限度 |
| --- | --- | --- |
| 登录 | 可见的真实 Apple 会话与必要的 Apple 授权弹窗；用户自行操作 | 工具未代操作认证；真实登录尚未验收 |
| 搜索 | 官网已配置实例的公开 `api.music`，固定目录搜索路径 | 一次真实目录搜索通过；生产桥接的参数与白名单由 fixture 验证 |
| 曲库 | 固定 `/v1/me/library/...` 公开 API 路径 | 未登录时明确 `needs-auth`；已登录曲库、分页、详情未做真实账号验证 |
| 队列 | 只读公开 `MusicKit.queue.items`，分页返回必要元数据 | 空队列真实读取通过；队列写操作当前关闭 |
| 单曲播放 | `setQueue({songs:[id]})` 后调用公开 play，再确认目标 ID 与播放进度实际前进 | 只有 synthetic fixture；真实订阅播放与完整歌曲未验证 |
| 曲库歌曲播放 | 只有真实曲库响应明确给出 catalogId 时才映射播放 | 不猜 ID；没有目录映射的条目禁用播放 |
| 专辑、歌单、艺术家 | 可展示目录；授权后的部分曲库详情有固定只读路径 | 集合直接播放、艺术家直接播放未开放；详情真实账号读取未验证 |
| 暂停、继续、前后曲、seek、音量 | 逐项公开方法与实际状态回读 | 入口存在；只有 fixture 控制回归，未执行真实音频操作 |
| 歌词、播放顺序 | 当前无已验收接口 | 能力为 false，不借用本地歌曲 ID 假配歌词 |

浏览器音频门默认关闭：打开会话、登录和浏览不会解除本程序 WebView2 的静音。只有播放器协调器明确允许 Apple play/resume 后，目标歌曲准备完成且官网回读其正在播放，原生层才解除静音。官网窗口内用户自行点击的静音播放报告为 `muted`、`controlled=false`、`authorizedAudio=false`，不能冒充本程序已接管的活动来源。

没有修改 UA、自动播放策略、证书验证、DRM 设置或权限。若网站拒绝无可信手势的播放，返回安全错误并让用户在真正的官方会话中完成必要点击；不伪造用户手势。

## 数据和安全边界

原站配置、Apple developer token、music user token、密码、Cookie、许可证、媒体 URL 和完整 SDK 对象均不跨出官网上下文。本程序不读取或枚举它们。桥仅调用固定高层方法，并返回白名单标题、作者、ID、时长、公开状态与能力布尔。完整原站 console、错误对象、HTTP headers 和响应对象均不转发。

RPC 关联字段是 `rpcId`，Apple 内容标识始终是单独的字符串 `id`。原生消息核对主页面的真实 Apple Music origin、在途 RPC 与 nonce；认证弹窗只允许必要的 Apple HTTPS 域，不给弹窗安装主桥。renderer 没有执行任意 JS、指定网页 URL 或读取文件的入口。

官网浏览器的本机配置目录为运行时 `dataDir/apple-music/official-webview-profile`。它由 WebView2 管理网站会话；程序不读取其中的 Cookie、凭据或存储。该目录和任何 Temp/profile/data/credentials 文件都不得打包。

停止或取消尚未完成的播放时，会失效旧请求；必要时直接销毁本程序拥有的浏览器上下文，防止迟到的 setQueue/play 发声。跨到本地引擎时，只有自有 WebView2 浏览器进程和宿主退出证据，或另行注入的真实端点释放证据，才能报告释放；单纯 paused/stopped/muted 不够。Apple 音频的 `exclusive`、`actualDacRate` 保持 unknown/null，不标成 foobar2000 独占输出。

如果原生启动已成功，但后续目标/进度验证失败，程序会关闭该次操作绑定的真实会话并等待退出。若清理失败，不会仅因内部授权标志被撤销就显示“静音”：仍按 SDK 与真实浏览器 mute 状态报告 playing/audible，无法读取时报告 unknown 和错误。此时保留输出归属并阻止本地引擎接管，直到实际退出证据成立。

## 先前路线研究（均不是当前默认依赖）

MusicKit 自建网站可以完全自定义，但由应用开发者提供合法 developer token。Apple 要求 Media ID、Media Services private key 和签名 token；普通使用者不需要人人注册 Developer。[Apple 官方概览](https://developer.apple.com/musickit/)、[创建 Media ID 与私钥](https://developer.apple.com/help/account/capabilities/create-a-media-identifier-and-private-key/)、[WWDC 官方说明](https://developer.apple.com/videos/play/wwdc2022/10148/)。[Musish 自托管说明](https://github.com/Musish/Musish#self-hosting)要求 `APPLE_TOKEN` 与 `BACKEND_URL`；其 [MusicKitProvider.tsx 第 25–26 行](https://github.com/Musish/Musish/blob/master/src/app/components/Providers/MusicKitProvider.tsx#L25)把环境配置传给 SDK。未提取其网站或他人客户端的 token。

Cider 的当前官方 [v2 API](https://taproom.cider.sh/docs/api)允许外部应用通过用户批准的本机 `apptoken` 控制。其 [Apple Music 代理](https://taproom.cider.sh/docs/api/amapi)明确由 Cider 处理自身 Apple 凭据；外部应用只需 library scope。该本机配对凭据不是 Apple developer token。用户已拒绝额外付费后端，因此当前程序不会默认连接、购买、启动或打包 Cider。[Taproom](https://taproom.cider.sh/)核验时为一次性 USD 8.49 加税；这不是当前路线的费用或前提。

[PluginKit](https://github.com/ciderapp/PluginKit)是 MIT 的闭源 Cider host 插件桥，不是可独立分发的播放器核心。[Spun](https://github.com/yappologistic/Spun#start-listening)展示“自己的 UI + Cider 认证/串流”的架构，但采用 PolyForm Noncommercial，不能称为 OSI 开源；本程序没有复制其实现。Cider 1 已归档，使用 [CastLabs 版 Electron](https://github.com/ciderapp/Cider/blob/main/package.json#L83)；CastLabs 的 [官方说明](https://github.com/castlabs/electron-releases)另有 CDM 安装与生产 VMP 签名要求，不能等同 stock Electron。没有安装 CastLabs 或下载第三方 CDM。

[LitoMusic](https://github.com/lujjjh/LitoMusic)是 MIT、MusicKit JS + WebView2 的历史参考，2023-06-30 归档。其若干目录读取被工具明确拒绝后已停止该入口，未绕过或打开 token.json；未确认其具体签发配置。[Sidra](https://github.com/wimpysworld/sidra/blob/main/docs/SPECIFICATION.md)是官方站点 wrapper + CastLabs；保留 Apple 原 UI 不等于完全自定义 MusicKit 产品。

## 官方平台主源

- [Apple MusicKit 与 Web 文档入口](https://developer.apple.com/musickit/)
- [MusicKit JS v3 Getting Started](https://js-cdn.music.apple.com/musickit/v3/docs/iframe.html?path=/story/get-started--page)（本次文本抓取不能完整读取动态文档，未据此虚称参数已验证）
- [Microsoft WebView2 概览](https://learn.microsoft.com/en-us/microsoft-edge/webview2/)
- [Microsoft Edge 与 WebView2 差异](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/browser-features)（浏览器 Edge 支持不自动证明 WebView2 支持）
- [Microsoft WinForms WebView2 承载方式](https://learn.microsoft.com/en-us/microsoft-edge/webview2/get-started/winforms)
- [Microsoft 官方 SDK 包](https://www.nuget.org/packages/Microsoft.Web.WebView2)；本机采用 1.0.4258.31，仅用于构建自有宿主，官方 DLL 数字签名已核验为 Microsoft Corporation

本次 probe、编译、fixture 与限制的交接见 [原生组件集成说明](apple-official-integration.md)。真实订阅登录、完整歌曲、受保护许可证、实际 seek/队列/控制、播放中跨引擎切换和实际 DAC 采样率仍未验收。
