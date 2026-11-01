# 官方 Apple Music 会话集成

核验日期：2026-10-30。默认导出 `require('./apple-music').createAppleMusicService` 与 `createOfficialAppleMusicService` 均指向 officialWeb；Cider 仅保留 `createCiderMusicService` 可选源码，没有默认连接或付费依赖。旧 developer-key 模块也不在默认路径执行。

## 主进程接口

工厂选项为 `{dataDir, emit, verifyOutputReleased?, artworkUrlFor?}`。`initialize()`只查文件和已安装 Runtime，不启动宿主或访问 Apple/Cider。关闭状态的 `getState()`也不会启动宿主。同步 `lookupMetadata({id,kind})` 只返回当前或已浏览的真实公开歌曲元数据副本，不发请求。

- `authorize()`：仅在用户明确点击后打开可见官方会话，用户自行登录；返回安全 descriptor。主 IPC 可以包装为 `{status}`。
- `status()` / `getStatus()`：同步安全 descriptor；`provider:'officialWeb'`，`actionLabel:'打开 Apple Music 会话'`，逐项能力布尔与实际授权状态。没有 token/key/path。
- `search({term,types,limit,offset})`：types 为 songs/albums/artists/playlists，最多四类；limit 1–25。
- `library({kind,id?,limit,offset})`：songs/albums/artists/playlists，或带 id 的 album-songs/playlist-songs/artist-albums；limit 1–100。未授权直接 `needs-auth`。
- 上述列表返回 `{kind,items,offset,limit,hasMore,nextOffset?}`；条目只含白名单歌曲元数据，时长为秒。公开封面经严格域/路径/模板校验后交 `artworkUrlFor` 注册，只给 renderer `still-apple-art://art/<64hex>`；无合法图或 resolver 时为空。远程 URL 不直接进入 renderer。
- `play({id,kind,ids?},ctx)`：只支持 songs，以及已真实读到 catalogId 的 library-songs；多 ids、集合和未知 ID 映射明确拒绝。必须目标 ID 相符且实际进度前进才标记 selectedPlaybackReadback；full-song/DAC 标志保持未验证。
- `pause/resume/next/previous/seek(seconds)/setVolume(0..1)/stop/getState`：实际公开方法和回读，错误均为安全 code/短语。没有自动播放策略绕过。
- `getQueue({limit,offset})`：只读公开队列，limit 1–200；`queueActions:[]`，写操作拒绝。SDK 播放顺序、官方歌词能力仍为 false；应用另以 `capabilities.externalLyrics:true` 提供基于真实公开元数据的泛歌词服务。
- `cancelPending()`：同步失效 generation，返回已派发写入/自有上下文关闭屏障；不会让旧 play 占住长验证队列。
- play/resume 在原生启动成功后若状态或进度验证失败，明确关闭该次 dispatch 绑定的自有 session，并等待浏览器与宿主退出；不是只调用逻辑 cancel。清理失败保留 `audioReleaseUnverified`、真实 SDK playing/audible 或 unknown 与错误，禁新播放和跨引擎接管。旧请求的清理不能关闭新 session 或撤销较新播放。
- `releaseOutput()`：曾实际 dispatch play/resume 的 session 必须取得自有 browser/helper 双退出证明；单个端点探测不能豁免潜在遗留音频。只有未授权过音频的会话才保留注入的真实端点验证后备；缺证据返回 `released:false`。不杀外部浏览器、Cider 或用户 foobar。
- `close()`：关闭本程序自有官方会话，不检查或删除用户 Cookie。曾授权音频而缺双退出证明时 reject 并保留可重试状态；调用者不能吞掉该错误后报告正常退出。
- 成功回读播放后仍持续记录该 session 的音频风险。helper 失联或状态读错后保留 `audioReleaseUnverified`、unknown/mayBeAudible 或真实 playing/audible+error；后续普通 cancel/stop、读取恢复或重新 authorize 都不能清除风险。只有匹配 session 的双退出证明才清除。

`controlled` 与 `authorizedAudio`区分官网窗口自身的静音播放和协调器允许的音频。只有后一种能作为实际活动来源。库/搜索/状态读取不启动新窗口，不修改已明确播放的 Apple 音频静音状态。

## 原生资源与构建

构建：`node scripts/apple-build-host.js --sdk-dir <已解压的官方 Microsoft.Web.WebView2 SDK>`。它仅调用本机 .NET Framework csc，不下载或安装 Runtime/CDM。当前构建使用 Microsoft SDK 1.0.4258.31；NuGet 包 SHA-256：`56F7F4B8BF9AEE4B8EFEFBBDD4F67D5F74EBD1B100ED0806DA71BF76AF481AA9`。

打包时将 `native/apple-host/bin` 的以下七个文件复制到 `resources/app/native/apple-host/bin`：

1. `StillAppleHost.exe`
2. `Microsoft.Web.WebView2.Core.dll`
3. `Microsoft.Web.WebView2.WinForms.dll`
4. `WebView2Loader.dll`
5. `official-bridge.js`
6. `WebView2-LICENSE.txt`
7. `WebView2-NOTICE.txt`

默认路径相对 `src/main` 向上两级定位 `native/apple-host/bin/StillAppleHost.exe`；bridge 在同目录。工作目录没有额外要求。**不要复制 Temp、SDK 全目录、data、profile、Cookie、.p8 或 credentials 文件。**终端用户使用已编译宿主及已安装 WebView2 Runtime，无需安装开发 SDK。

原生协议以换行 JSON 传输：`rpcId`只用于关联，`id`保留业务字符串。宿主只接受固定高层 method，没有 eval/arbitrary JS 入口；官方主 frame origin、nonce、RPC 都必须匹配。SDK 错误只返回自定义 code，原始 console/异常/headers 不跨上下文。

音频门保持静音，直到 SDK 返回所选目标、`isPlaying=true`，才解除静音；旧 A 不会在慢 setQueue(B) 时提前发声。程序层还需看到 B 的进度前进，才记录已回读播放。取消正在开始的播放会销毁该自有上下文；关闭等待 WebView2 `BrowserProcessExited` 与宿主退出。

## 历史 2026-10-30 检查与回归

- 已运行并通过：官方 SDK C# 编译；`node --test tests/apple-official.test.js` **21/21、0 skip**；`node scripts/build.js`。
- 这 21 项使用明确 synthetic fixture，验证公开字段白名单、无 token 读取、未登录拦截、真实 NativeHost wire 的 rpcId/id 分离、编译 C# 音频门、取消迟到 setQueue、启动 singleflight、close/start 两种竞态、状态与完整歌曲声明分离，以及启动后的进度冻结、清理失败保持真实 audible/unknown、协调器阻断本地接管、旧请求失败不破坏新播放、旧 session handle 不关闭新宿主。它们没有登录或播放真实音频。
- 已实际运行：独立 stock Electron / WebView2 EME probe；一次官网 catalog 只读请求；正式 NativeHost 未登录 smoke（带字符串业务 ID 的 playlist detail 返回 needs-auth），并实际回读 browser/helper 退出。
- 第一次正式 host smoke 因官网全局先出现、实例尚未配置而返回 player-not-ready；已改为等待具体公开实例就绪，一次修复后通过。没有更改安全策略。
- 独立复核发现并修复：RPC id 覆盖内容 id；准备新曲前提前 unmute；异步 start 并发产生多宿主及 close racing startup。均有上述回归用例。
- 后续独立复核发现并修复：启动完成后进度验证失败不能只 cancel。清理必须有真实退出证据；缺证据时错误和物理播放状态保留，不能把 `authorizedAudio=false` 当成浏览器已经静音。新增 5 项回归见 [测试日志](evidence/apple-official-cleanup-tests-20261030.log) 与 [修复说明](apple-official-cleanup-review.md)。本次仅修改 Node adapter/fixture，原生二进制未变，没有重复启动真实网页会话。
- 该历史阶段未运行：真实用户登录、Apple 订阅全曲/许可证、真实音频控制、登录后曲库和播放中的跨引擎释放。后续用户已登录/曲库实证见下方 2026-11-01 小节；订阅全曲与真实交接仍不据此标为通过。

逐文件完整 SHA-256 见 [artifact manifest](evidence/apple-official-artifact-hashes-20261030.json)。实际无账号 smoke 见 [记录](evidence/apple-official-native-smoke-20261030.json)，目录只读证据见 [记录](evidence/apple-official-catalog-probe-20261030/webview2-eme.json)。

2026-10-31 交付复核：原四项修复仍在；新增成功播放后的 helper/状态失联、正常关闭缺证明、endpoint-only 豁免，以及背景读取失败与 play/resume 验证的交叉修复，细节见 [补充复核](apple-official-cleanup-review.md)。当日 Apple **28/28 pass、0 skip**、source build 通过，官方 SDK 重编译及纯协议自检通过，日志和前置失败复现保存在 `review-evidence/finish-delivery-20261031/apple-*`。该轮未启动正常 WebView/Apple 网页、认证或音频，没有用历史 99/99 代替当日结果。官网接口变化、账号、DRM 和实际订阅全曲限制仍适用。

## 2026-11-01 第一包 b88 的定点修复与实际失败

用户确认是在 STILL 打开的官方窗口内登录。用户手动导出的脱敏诊断记录了真实授权、100 首歌曲、83 张专辑及专辑内 11 曲读取成功，随后一次播放未获进度确认、出现静音/停止并关闭会话。旧诊断没有保留失败命令阶段/错误码，因此不能据此归咎未登录、token 缺失或具体 DRM/交互原因。原始脱敏证据与有限摘要位于 `review-evidence/apple-playback-polish-20261101/user-apple-diagnostics-*.json`。

本次修复了可重复的工程缺陷：

- 官方 `play()` 的 void 返回不代表已经 playing。桥在静音门内有界等待公开目标与 isPlaying，Node 再验证进度；没有自动播放、DRM 或用户手势绕过。
- library/play 在授权预检前刷新既有会话的公开 probe，不因旧缓存 false 拒绝已完成登录的会话。不会为后台读取新开宿主。
- 原始 `i.*` library ID 只通过已真实读到的 catalogId 送入 songs setQueue。实际 MediaItem 明确为 library-songs，或公开 isLibrary=true / kind=song / 合法 catalogId 时，读回规范为 catalog ID 并保留原 item.id；普通歌曲、错误或缺失映射不能冒充目标。
- 新 play/resume/pause/stop/cancel/close 退役旧 pending-start nonce；桥的等待同样检查 generation。已排队的旧成功回包不能在暂停/停止/切源/关闭后迟到放声，C# 的精确目标与 isPlaying 谓词保留。只读 probe 不改已授权的音频状态。
- 封面原来在桥和 Node 两处写死空值；现通过无凭证、固定 HTTPS 域/路径的本地图片协议自动下载并缓存。文件 MIME/魔数/像素、2 MiB、8 秒、并发/队列、取消和受限磁盘缓存均有检查。失败响应 no-store，不永久记住失败；同一稳定 URL 可在刷新后重试。公开封面缺失时保持占位，不抓认证或猜图。

新的 Apple-only 手动诊断保留 methodSupport 和最新显式 lastOperation 的固定阶段/code；仅 play 可带严格业务 kind/id。状态在同一轮公开读取后取得，背景 probe 不擦除操作失败。该 scope 不调用本地 audioDetails/coordinator 全源读取，不触发本地 CoreAudio helper，也不导出凭证、原始提供方对象或截图。

独立审查关闭了 generic library 形态和迟到门控 finding，**48 / 48** Apple fake/VM/wire 回归通过。C# 已重新编译；独立 Reviewer 确认精确 `--protocol-self-test` 分支在 Form/WebView/profile/network/audio 初始化前退出，然后只执行该非 UI 分支一次，退出 0、全部协议与六种取消意图检查通过，C#/EXE hash 未变。正常宿主/真实歌曲没有由 agent 启动。全量 Node suite 为避免重复执行该已验证分支而精确过滤其测试项，不能写成 native 本轮未测。

完整证据：`apple-findings.md`、`apple-library-shape-tests-final.log`、`apple-artifact-hashes.json`、`reviewer-native-review.md`、`reviewer-apple-final-fixed-review.md`。公开封面实际落盘/离线同 SHA 的证据为 `artwork-public-probe.json`；这不是实际用户 Apple 曲库全覆盖或订阅全曲通过。实际新包的登录后播放、受保护全曲、真实用户手势要求、设备/引擎交接和 DAC 输入格式仍需用户手动体验与后续脱敏诊断。

## 2026-11-01 第二轮热修：释放证明、最新意图与临时权限

用户打开 b88 后实际播放仍失败，不能把第一次文件验收当作声音验收。两份新脱敏导出保存在 `review-evidence/apple-playback-polish-20261101/iteration-2-play-failure/`。它们证明已登录会话可读真实资料库、公开播放方法存在；后来单次尝试首先被本地交接的 `CoreAudio 释放探测失败：0x887C001A` 阻断，Apple play 尚未派发。该 HRESULT 的完整含义仍未知，既不是成功释放也不被归为设备占用；未重置登录、认证 profile 或设备。

本轮已实现的受控工程路径：

- 正常停止与同一明确端点的 shared 初始化探测仍优先。只有探测未知、真实停止、临时队列可确认为空、列表/occurrence/偏好完整且稳定、精确自有专属 DX1 WASAPI 输出匹配时，才可正常退出这个已验证的私有 foobar 实例，并凭本次 ChildProcess 真实 exit 品牌确认本地引擎释放。不会把未知 HRESULT 改写为设备可用；ASIO、DSD、外部 host、复用进程、非空或未知队列不继承此证明。无 kill、设备切换或 DSP/音量/resume 设置修改。
- 停止且没有 activeItem 是可确认的空当前项；缺失读取与未知仍拒绝。持久化真实列表 path/subsong/occurrence/order 和偏好，不盲信跨 session playlistId。下一次明确本地目标请求经协调器允许后启动新专属 session，先读回 stopped、空队列及语义一致，再播放用户所选目标；不恢复旧歌发声。
- 冷启动保存着完整 awaiting/stopped/空队列与闭态指纹时，只可在明确 Apple 歌曲请求内部做一次受控 stopped 准备并重新取得当前 owned 退出证明。bootstrap、后台读取和频谱不会启动或恢复后端；磁盘 JSON 不是进程退出证明。prepared、残缺、外部变化、复用或退出未证实仍拒绝。
- 已复现的 Apple A→B→C 同源竞争等待旧 browser/helper 确切关闭和新实例真正 ready；旧取消/关闭不能关掉或静音 C，也不能替 A 开声。`sources.apple.capabilities.canSubmitPlayIntent` 与 `playIntentTypes:['songs','library-songs']` 仅允许已真实浏览且可播的单歌曲明确请求在重建空档受理；不伪装 online，不开放读取、容器播放或其他 transport。
- ready 依赖当前 NavigationId/epoch 的真实 SDK 与 bridge 就绪，超时不再报告成功。Node 继续要求规范目标与实际进度前进；原生默认静音和精确目标门均保留。

本机 bundled WebView2 SDK **1.0.4258.31** 已通过只读 metadata 与 compile-only API 证明公开 `Autoplay`、`PermissionRequested`、`SavesInProfile` 读写存在。用户已有 Runtime **156.0.4314.50** 的 build 4314 满足微软公开的 release SDK/Runtime build 兼容规则；这不是实际权限事件或 setter 生效证明。来源与编译证据见 `apple-temporary-autoplay-final.md`、`apple-autoplay-sdk-metadata.json`。

临时 app-local handler 只允许精确 HTTPS music.apple.com 的当前主 Core、当前导航和有效 play/resume nonce，或同 epoch 已确认播放 session 的自然续曲。先成功设置并读回 `SavesInProfile=false`，再复查当前权限作用域才 Allow；不支持或失败即不授予。授权随合法播放 session 存续；同源 seek/音量/上一首/下一首只能保留已有授权，不能在暂停后新造授权。pause/stop、真正 cancel、切源、关闭、导航立即撤销。其他权限不由本 handler grant；未加 browser flags、CDP、模拟点击、私有 API、UA/DRM 或全局策略改动，也不向认证 profile 保存权限。

诊断只新增 `autoplayPolicy:{configured,seen,decision}` 三个白名单字段，保留 temporary-policy-unavailable / handler-unavailable 跨关闭原因；不导出 URI、query、nonce 或原事件。`configured=true` 与 `seen=true` 均不能代表已经实际播放。Apple-only 导出另外保留构建身份、缓存交接 stage/HRESULT 与至多 16 项显式操作历史；cleanup 不覆盖首个失败。

最终 C# 的精确非 UI 协议分支已经独立静态放行并执行一次，19 项共享临时权限 fixture 和原有目标/nonce/ready 门全部通过；未创建正常 Form/WebView、读取认证 profile、访问网络或设备音频。最终统一源测试、构建、审查和二进制 hash 以本热修 `validation.json`、`reviewer-final-*` 及新 `BUILD-INFO.json` 为准。真实 Runtime 权限触发、Apple 出声/订阅全曲、硬件零瞬音、DAC 格式和跨引擎交接仍由用户手动验证。
