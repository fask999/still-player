# STILL 歌词服务

服务接口以 `architecture-contract.md` 为准。所有歌词请求只读，不写音频标签，不调用 foobar2000，也不承担播放工作。

## 格式、来源与时间

- 本地：LRC、增强 LRC、YRC、已解密明文 QRC / `LyricContent` XML、SRT、TXT，以及含 `yrc/lrc/lyric/syncedLyrics/plainLyrics` 等明文字段的 JSON。
- 字节解码：严格 UTF-8，带 BOM 的 UTF-16LE/BE；不符合 UTF-8 的本地文本回退严格 GB18030（兼容 GBK）。损坏字节、二进制、HTML、空正文、加密 QRC 均报 `parse-error`。无 BOM 的 UTF-16 不自动猜测。
- 在线自动主源为 LRCLIB；主进程可显式注入 QQ Music 公开普通 LRC 客户端，供严格自动备用与用户手动搜索、预览、绑定使用。QQ 现有 `trans` 仅在来源实际返回时解码；没有实现 QRC 解密、自动翻译或自动生成逐词时间轴。
- 已索引的普通单曲音频可只读提取内嵌 `common.lyrics` 对象/文本与原始 `LYRICS`、`UNSYNCEDLYRICS`、ID3 USLT 等标签。具体安全边界和不可靠标签的降级见下文；不写音频、不扫描曲库。
- `kind:word` 要求源正文有真实词时间戳；LRC 行时间只产生 `kind:line`。词尾可使用源中下一词起点或行边界作为结束边界，不按字符/词数分配时间。源记录的 `hasWordSync` 声明不能启用逐词模式。
- 译文默认只按规范化后完全相同的时间戳匹配；不按数组行号配对。缺失、重排和不同文件 offset 不会把下一行译文移到上一行。可选容差匹配要求双方唯一最近邻。
- 文件内 LRC `offset` 按源格式从时间戳中扣除；用户 `offsetMs` 独立持久化且不改写源时间。播放器用 `audioMs - offsetMs`，正值使高亮延后。
- `plainTranslation` 是可选的完整译文文本。无时间译文保留在此字段，不制造逐行关系；有时间原文仍保留自身时间轴。TXT 译文侧车支持 `.translation.txt`、`.trans.txt`、`.zh.txt`，LRC 同名后缀优先。

## 选择、缓存与请求隔离

优先级：手动绑定/导入快照 → 本地侧车 → 可靠内嵌歌词 → 与当前元数据匹配的持久缓存 → LRCLIB 自动查找 → 满足严格匹配条件的 QQ Music 备用查找。

CUE/ISO 容器、`source:cue` 或 `cueTrack:true` 的真实引用音频（包括 `subsong:0`），以及非零/未知 subsong，均跳过自动整文件侧车和内嵌歌词，避免套到错误分轨。手动绑定/导入仍可明确选择该分轨的歌词。请求与缓存指纹区分 `subsong:null` 和 `0`，并保留 CUE 身份；普通未设置 subsong 的旧索引继续等同 0。

自动选择要求曲名、歌手规范化后相同；有专辑时专辑也须匹配；已知时长时相差最多 2 秒。Live、Remaster 等题名信息不会被清除。有多个相符搜索结果时返回 `selection-required`，交由用户预览绑定。手动候选保留来源 ID、来源 URL、曲名、歌手、专辑、真实时长及解析出来的类型，服务不自行“修复”来源文字或猜测版本。

搜索返回多个候选；预览不绑定。公开预览有独立的同曲请求序号，后一个预览或新搜索使旧预览失效。绑定使用私有读取路径，用户同时读另一个候选不取消绑定。绑定、导入、解绑使旧搜索与预览失效。失效响应标记 `superseded:true`，旧搜索异常也不能发布成新的错误。

同曲自动解析用请求代数隔离；新强制刷新及手动操作使旧自动请求失效。不同 trackId 分离。异步查询抓取曲目快照，返回前核对当前元数据；查询期间的版本/路径/子曲目变化不会把旧歌词标成新版本。持久缓存指纹包含路径、subsong、曲名、歌手、专辑和时长；旧版本指纹会安全失效并重新查询。

手动修改与下载缓存通过全局串行事务保存：从最近成功的状态生成草稿，写临时文件，原子替换成功后才发布到内存。失败修改不会被另一曲目的后续保存带到磁盘；失败事务也不会回滚另一曲目已经成功提交的状态。解绑保存期间的解析等待解绑结果。

手动导入保存内容快照，原文件删除后仍能离线恢复。用户偏移单独保存。关闭下载缓存会跳过缓存读写，不删除手动绑定。强制刷新绕开下载缓存读取；网络错误或正文解析错误时，可继续显示原有可用缓存，并以 `refreshStatus` 标记此次失败。缓存保存失败时当前真实歌词仍可用，以 `cacheWarning` 说明未保存。

`setOffset` 的事务成功后，响应附 `offsetCommitted:true` 与最近成功提交的 `offsetMs`。随后曲目删除、标签查询或歌词重新读取失败时返回无旧正文的标准 `not-found` 文档，`reason:offset-read-failed` 与 `offsetWarning` 明确“偏移已保存”；不能把读取失败误报成保存失败而使界面回滚已落盘值。验证/提交前失败和原子提交失败仍 reject。

手动绑定的正文按需读取，内存正文 LRU 默认按序列化内容计 8 MiB 预算；绑定元数据、磁盘正文与用户偏移不会因该 LRU 淘汰。已有 resolved 副本缓存仍独立受限，不能把它当作磁盘绑定的删除策略。cold read 与 commit 仍可产生 O(file) 的全 JSON 暂态读写/解析，8 MiB 不代表整个应用或所有暂态对象的 RAM 上限。原磁盘格式与公开结果保持兼容；本轮没有读取或清理真实用户歌词文件。

状态恢复检查文档 trackId、状态/类型一致性和真实数值时间轴；忽略错曲、空白正文或无效词时间。损坏的整体 JSON 会保留为 `state-corrupt-*.json`，不会破坏播放。

## 状态与边界

`ready`、`plain`、`instrumental`、`not-found`、`network-error`、`parse-error` 各自保留含义。无歌词的空记录不是纯音乐；只有明确纯音乐字段或受支持标记才是 `instrumental`。

LRCLIB 请求串行、带应用 User-Agent、有超时与响应大小限制，遵守 HTTP 429 的 Retry-After。API JSON 必须是严格 UTF-8；本地 GBK 回退不应用于网络 JSON。来源已经包含的合法 UTF-8 乱码、错误歌词、不完整时间轴和数据库版本质量无法由解析器可靠修复，需用户预览后选择或导入本地文件。

## 双来源手动搜索与 QQ 译文（2026-11-08 当前实现）

`search({trackId,source:'lrclib'|'qq',query?})` 缺省 `source:'lrclib'`，`query` 为最多 500 字符的自由文本；非空 query 直接作为该提供方搜索词，与自动匹配用的曲目元数据分开，不改曲目版本。返回 `{trackId,query,provider,source,sourceUrl,status,results,fromCache,...}`，其中 `provider` 为小写来源键，`source` 是 `LRCLIB` 或 `QQ Music` 显示名。非法来源、非文本 query、超长 query 均拒绝；QQ 未注入时明确返回 `status:not-found/reason:source-unavailable`，不伪造候选。

`preview({trackId,candidate})` 和 `bind({trackId,candidate})` 沿用已有接口，客户端原样回传所选候选。QQ 候选保留 `id/sourceId/sourceKey:qq:<songmid>`、`provider:qq`、固定来源 URL 以及来源实际曲名、歌手、专辑和时长。QQ 搜索只有元数据，候选标记 `kind:none/status:not-loaded/preview:''`；歌词类型由预览真实正文后判定，这个候选状态不属于 LyricsDocument 状态。LRCLIB 的旧数字 sourceId 与 `lrclib:<id>` 继续兼容。

QQ 不接受调用方自造歌曲 ID 或版本信息。服务端仅接受同 trackId、当前元数据指纹、最近搜索返回的权威记录；检查来源、ID、固定 URL 和所有候选版本字段，再使用服务端记录下载。近期候选按 32 首曲目 LRU、10 分钟 TTL 与 8 MiB 总序列化预算约束；新搜索或来源切换使同曲旧候选失效，淘汰、超时或元数据变化给出“重新搜索”错误。该元数据索引独立于下载缓存开关，因此关闭缓存仍能完成搜索后预览绑定，但不会读写下载缓存。QQ ID 永不发送到 LRCLIB；同一 QQ ID 的新搜索元数据与旧 recordCache 不同时会丢弃旧记录并重新获取，迟到旧请求不能覆盖新版本。

搜索/正文缓存键按提供方分区。关闭 online 或将 preferredSource 设为已有的 local 禁用来源时不新发网络请求；下载期间关闭 online 不发布新候选或提交绑定。已有内存正文可在启用缓存时离线预览，持久绑定快照在关闭 online/cache、重启且不注入 QQ 客户端时仍可恢复。预览与私有绑定请求代数分开；新搜索取消旧公开预览，但不会取消用户已经发起并捕获权威记录的绑定。不同 trackId、手动导入、解绑、强制刷新及落盘事务仍遵守前述隔离规则。

QQ 返回的原文 `lyric` 与非空可选 `trans` 均要求规范 Base64 和严格 UTF-8，不使用本地 GB18030 回退。缺失、null、空串、纯空白 trans 字段，或解码后只有空白的译文，均视为没有译文。坏 Base64/坏 UTF-8/非文本 trans 仅产生 `translationWarning/translationErrorCode` 并保留正确原文；坏译文时间轴产生明确 translationWarning，不能参与逐行匹配。合法译文经现有 parseLyrics/alignTranslation 按各自文件 offset 规范化后的时间戳对齐，缺失、重排的行不按下标误配。无时间译文保留为 plainTranslation。正常/警告文档与实际对齐结果随绑定或自动成功缓存恢复，损坏状态中的非文本 translation/plainTranslation 被拒绝。

## 内嵌歌词读取（2026-11-08 当前实现）

仅 `getTrack(trackId)` 返回的已知绝对音频路径可进入读取；不接受 tag 内路径、URL 或凭证，不读取引用文件，也不遍历库目录。`valid:true` 本身不构成文件授权。读取独立检查路径所有祖先为无符号链接的普通目录、叶子为单链接普通文件；只读 `O_RDONLY|O_NOFOLLOW`（平台支持时）打开，核对 handle 与路径身份，并在读取后重查文件 dev/ino/size/mtime/ctime 与祖先身份。Windows 没有 O_NOFOLLOW 常量时仍执行 lstat、已打开 handle 和后验核验；检测到链接、替换或变动便不发布其歌词。请求返回前还核对当前曲目的路径/版本/subsong/CUE 指纹。软链接/junction/多硬链接文件的内嵌歌词会保守跳过。

使用既有 `music-metadata.parseFromTokenizer`，`duration:false/skipCovers:true`；正规继承纯 JS `strtok3.FileTokenizer` 公共 export，由子类构造器合法 `super(realFileHandle,options)` 接收真正以只读/no-follow 标志打开的 Node FileHandle，避免 parseFile 重新打开路径。子类覆写公开 `readBuffer/peekBuffer`，调用继承的 protected `normalizeOptions/validateBufferSize` 验证请求，再累计字节/次数并在 `super` 读取前后检查取消；不直接实例化 protected 基类、不伪造 handle、不 deep-import 或复制包的私有实现。升级这两个包需重跑句柄与限额回归。不新增 native 模块、不执行解析脚本或播放器。单音频最大 8 GiB；累计实际请求读取最多 16 MiB / 4096 次（包括重读，不包括随机跳过的音频或封面），单次解析分配上限 2 MiB，元数据列表上限 4096，最多 16 个歌词候选与合计 2 MiB 文本。该分配限额不是整个进程 RAM 上限。

解析物理并发为 1、最多 15 个等待任务；包含排队的逻辑预算 3 秒。超时或 close 及时结束逻辑等待，但仍保留物理槽至底层解析、读取和句柄关闭真正结算，不虚报已停止不合作的 parser；同步 JavaScript CPU 工作仍不能被计时器抢占。取消由每次读取前后的 guard 控制，不把 abortSignal 交给基类改变句柄生命周期。所有成功/失败路径都在拥有者 finally 中等待基类 close，只有真实 FileHandle 尚未关闭时再补 close；二次清理错误不会遮蔽原始读取失败，关闭失败也不会发布伪成功正文。不写文件。

原始 native LRC 优先于 common 的规范化对象，因为 music-metadata 的 common 转换可能丢失 LRC offset 或重复行时间戳。无原始标签时，common.lyrics 可读取字符串、对象 text 或有真实毫秒时间戳的 ILyricsTag.syncText；对象不被强制 stringify，MPEG frame number 不猜换算为毫秒，非歌词 contentType 不当作歌词。不会把 plain 标签制造为逐词时间轴，也不会猜测多个语言标签是原文与译文。多个不同可用正文、损坏时间轴、读取限额/权限/身份失败均跳过内嵌，继续匹配缓存/在线，并以 embeddedWarning 说明；空或不存在的标签正常继续。内嵌文档为 `source:内嵌歌词/provider:embedded/local:true`，不当作下载缓存写盘。

## 2026-11-08 离线验证

`node --test tests/lyrics-features.test.js tests/lyrics-parser.test.js tests/lyrics-service.test.js tests/qq-lyrics.test.js`：185 项通过、0 失败、0 跳过。覆盖 QQ 自由搜索、伪造/跨曲/过期候选、ID 与来源缓存隔离、同 ID 新版本和旧回复、在线禁用、绑定与自动缓存断网重启、不同 offset/缺行/重排译文及可选译文损坏；offset 提交后 getTrack 抛错/曲目消失/后续 resolve 失败均返回真实落盘确认且重启恢复，提交前失败仍拒绝。音频 fixture 均为测试现场合成 FLAC/Vorbis LYRICS/UNSYNCEDLYRICS、WAV 内 ID3 USLT 与自编文本；含 3 MiB 跳过封面，解析后音频 SHA-256 不变。公开 FileTokenizer 正规子类、真实句柄及 read/peek 累计限额、关闭失败保留原错误、对象型 common、hardlink、父目录 junction、实际 rename 替换、读字节/次数/分配限额、超时/close 物理槽与真正 handle.close 均实测通过。无真实歌曲正文新增、无外网请求、无播放器/GUI/浏览器/Computer Use/设备/真实用户库操作。

ESLint 定点检查 5 个 JS 文件与 `node scripts/build.js` 源码完整性构建检查通过（当前环境 npx 不可用，直接运行 node node_modules/eslint/bin/eslint.js）。日志见 `review-evidence/20261108-feature-media/lyrics-regression-final.log`、`lyrics-lint-features.log`、`lyrics-build.log`。未做新增在线供应商端点探测、实际 Electron 网络通路或音频播放验证；历史端点成功只说明当时探针，不代表本轮重新联网验证。

以下 2026-10-30 至 2026-11-01 小节为历史记录，包含当时限制与真实授权探针。涉及“当时尚无 QQ 手动候选/内嵌”等陈述仅描述当时状态；当前能力与边界以上述 2026-11-08 章节为准。

## 2026-10-30 验证

离线、临时目录 fixture：`node --test tests/lyrics-parser.test.js tests/lyrics-service.test.js`，47 项通过，0 失败；覆盖真正 GBK/GB18030 字节、时间对齐译文、手动正偏移与离线重启、旧错误/预览隔离、解绑与未完成绑定竞争、查询中元数据变化、错曲缓存恢复，以及真实文件目标阻塞导致的持久化失败。后者包含 A 绑定还在下载、B 偏移已提交、A 保存失败、其他修改失败后恢复保存与重启，检查 B 不被覆盖及 A 失败内容不泄漏。

语法：`node --check` 对歌词源文件与两个测试文件均通过。项目没有专用 lint 脚本；本服务检查未运行应用构建、GUI 或音频操作，整体构建由集成负责人验收。

实际在线证据（非 fixture）：2026-10-30T02:04:38.676Z，使用生产 `createLrclibClient` 对 `https://lrclib.net/api/get` 发出一次只读元数据请求，查询 Rick Astley / Never Gonna Give You Up / Whenever You Need Somebody / 213 秒。源返回 ID 1009665、时长 214 秒、`instrumental:false`。生产解析器得到 `ready` / `line`、1 行、0 词时间戳，来源为 `https://lrclib.net/api/get/1009665`。这仅证明实际源连接及该响应的解析结果，不证明整首歌词完整性或逐词支持。

为核对单行响应边界而随后读取该 ID 时，源返回 HTTP 503，客户端按 `network-error` 报告；未继续重试。没有据此声称该记录完整或更改其正文。

## 2026-11-01 暂态网络恢复

本节记录 QQ 接入之前的 LRCLIB 恢复工作；当前 QQ 合同与验收见本文最后一节。手动绑定/导入、本地侧车和匹配缓存继续优先。公开来源有歌词查询能力，不代表所有中文歌曲、版本或逐词歌词均可用。

- 每个网络端点操作最多 3 次尝试（首次 + 最多 2 次重试）；仅 HTTP 408/500/502/503/504、网络连接/读取失败及超时可重试。默认退避 800 / 1600 ms，每次发送仍遵守 700 ms 串行间隔。
- 每次尝试默认上限 8 秒；端点操作从获得串行执行权开始共用 28 秒预算，包含发送间隔、退避、响应读取。队列最多 16 项。预算用尽或次数达到上限即返回真实错误，不在后台持续轮询。自动精确查询无结果后可能进入搜索，这是独立端点操作。
- HTTP 429 不自动重试；全局冷却遵守 Retry-After 秒数或 HTTP 日期，并增加最多 30% 随机延迟。缺失、无效或已过期的值保守等待 60 秒。冷却中的新请求直接返回 RATE_LIMITED，不排后台定时重试。
- 关闭服务、取消信号和新的同通道代数会中断请求/退避。自动解析与绑定共用修改代数；搜索及公开预览保留独立通道，读取预览不会取消绑定。重试前核对曲目元数据，旧版本不会继续发请求或持久化。测试中的不响应 AbortSignal 的 fetch 也能被关闭逻辑及时结算；生产 fetch 同时接收 AbortSignal。
- 强制刷新在网络失败后继续返回原有有效缓存，保留 `status:ready/plain/instrumental`、`fromCache:true`，同时附 `refreshStatus:network-error`、真实 `error` 和 `errorCode`（如 HTTP_502）；没有缓存时返回 network-error。永久 HTTP 错误、损坏 JSON/UTF-8、正文解析失败不重复请求。错误不写入成功缓存。
- 内部客户端第三参数支持 `{ signal, isCurrent }`，仅供主进程内部隔离；未增加 UI/IPC 合同。

来源核验：2026-11-01T00:42:31.092Z，官方 [API 文档](https://lrclib.net/docs.md) 返回 HTTP 200，说明匿名读取无需 API key、请求需客户端标识、429 必须尊重 Retry-After，返回 plainLyrics/syncedLyrics 等真实字段。官方 [源码仓库](https://github.com/tranxuanthang/lrclib) 也说明其为同步歌词数据库/API。文档新列出的 Lyricsfile/hasWordSync 能力不等于本客户端已经读取该专用格式；仍以实际解析出的词时间戳作为逐词依据。

当日使用修改前的生产 createLrclibClient 对 `/api/search?track_name=黑色蝴蝶&artist_name=汪苏泷` 仅发出一次只读请求，实际得到 HTTP 502 / HTTP_502。没有成功歌词正文、没有继续重试、也没有据此判定该歌曲不存在。完整官方文档文本、时间、查询参数及实际状态存于 `review-evidence/apple-playback-polish-20261101/lyrics-live-source.json`。raw.githubusercontent.com 的 README 抓取失败，已如实记录；官方 GitHub 页面由浏览工具成功核对。仅查询公开文本/元数据，未读取真实用户 data 或认证信息。

验证日志见同目录 `lyrics-tests.log`、`lyrics-checks.log`；检查仅运行歌词 parser/service 的离线临时 fixture 与 node --check。项目无专用 lint 脚本；本次未运行应用构建、全量 package、GUI、helper、播放器或 nativehost 自测。

### 同日真实样本扩展核验（不启动播放器）

只读索引命中 `track_471d036503fa56e8b2da85919de3bd0d`：汪苏泷《黑色蝴蝶》，专辑《传世乐章》，227.03648526077097 秒，subsong 0。仅读该 FLAC 标签确认曲名/歌手一致，未发现 common.lyrics 或 native LYRIC 字段，MusicBrainz album/releaseGroup ID 均不存在。同 stem 的六种已支持侧车均不存在；当前 `data/lyrics/state.json` 也不存在。这些检查不扫描整盘、不写音频标签或真实状态。详见 `lyrics-track-inspection.json`。

网络路径检查发现 Windows 已启用 `127.0.0.1:7897` 系统代理、未配置 PAC，而 Node 的 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NODE_USE_ENV_PROXY 均未设置。这只是路径差异证据，不能据此断言 HTTP 502 的根因。经授权再做一次使用该现有代理的 `/api/get` 完整元数据查询：上限 10 秒/512 KiB、拒绝重定向、无 cookies/credentials/default auth、正常 TLS 校验且不改系统配置；实际仍返回 HTTP 502（16 bytes）。未再尝试。记录于 `lyrics-proxy-comparison.json`。没有成功响应，未把错误正文当作歌词或制造缓存，真实歌曲的在线成功与缓存离线验收仍未完成。

已安装 ESLyric 且其组件目录已有 `enable_script_control` 标志；已知 eslyric-data 没有显式 cache 目录，专用 cfg 中未识别出歌词文件路径。这不证明其他缓存绝对不存在，也不授权扩大 profile 扫描。官方 [外部 JS 控制接口](https://github.com/ESLyric/release/wiki/%E5%A4%96%E9%83%A8JS%E9%9D%A2%E6%9D%BF%E6%8E%A7%E5%88%B6%E6%8E%A5%E5%8F%A3) 定义 RequestLyric(title, artist) 和播放歌词回调，但并非现有 STILL 可用的 HTTP API。本轮没有调用 COM、启动宿主、修改其配置或运行其歌词源脚本；这些调用可能依赖宿主状态，不能声称已完成桥接。

最小网络集成建议已交主进程负责人：使用独立、非 persist、无 cookies 的公开 Chromium session.fetch，经现有 fetchImpl 注入；保留取消、时限、严格来源 URL 与真实失败反馈。[Electron 官方 session.fetch 文档](https://www.electronjs.org/docs/latest/api/session#sesfetchinput-init) 确认其使用 Chromium 网络栈，与 Node fetch 不同。本轮未修改 main，也未启动 Electron 验证；代理路径本身已失败，所以切换网络栈的实际成功率不能由本轮证据保证。由于当前文件无内嵌歌词，本轮不增加无样本收益且需扩展读取边界的嵌入标签读取器。

本轮随后按负责人方向只读已安装来源流程而未执行：`netease.js` 使用加密 linuxapi forward 和固定匿名 Cookie；不纳入无凭证适配。`kugou.js` 搜索后要求返回的 accesskey 下载 KRC，且候选缺少专辑字段；本轮没有使用该字段、发下载请求、解密 KRC 或把其当普通 LRC。没有核对第三家或请求多家供应商。无正文/凭证值的文件哈希、决策及行位见 `lyrics-installed-source-boundaries.json`。这只能说明这些安装流程不满足本轮限定，不能推论供应商永远没有其他公开接口。仍没有已验证的普通 LRC 备用来源，因此未先重构多源 ID/缓存/绑定。

### 最后一次定点 QQ 公开流程：真实成功（后于上述限制）

经负责人新增明确授权，只读 `qqmusic.js:225-319` 保留的普通 LRC 流程，不执行其脚本或 QRC 分支。该段只使用固定 guest 参数（g_tk=5381、loginUin=0、hostUin=0），无需读取账号 Cookie、动态签名或身份凭证。对源中的旧 HTTP 地址提升为同 host HTTPS 后，经用户现有代理只发出一次搜索和一次命中后的普通歌词 GET；各自上限 10 秒/512 KiB、拒绝重定向、无 cookies/auth、正常 TLS。

2026-11-01T01:09:20.584Z，`https://c.y.qq.com/soso/fcgi-bin/client_search_cp` 返回 HTTP 200 / API code 0。十个候选中唯一曲名/歌手/专辑完全匹配者：黑色蝴蝶／汪苏泷／传世乐章／227 秒，songmid `004CAUsM4ZX5x5`，与本地时长相差约 0.036 秒；Live、不同歌手和其他候选均未选。随后 `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg` 返回 HTTP 200 / API code 0，普通 Base64 LRC 经严格 UTF-8 解码和生产 parseLyrics 解析为 `ready` / `line`、81 行、0 词时间戳。没有声称逐词歌词，也没有修改正文、调用签名算法、复制 Cookie 或付费权限。完整无正文证据（端点、安装脚本哈希/行号、参数边界、候选元数据、歌词哈希）见 `lyrics-qq-guest-probe.json`。

此探针当时证明定点公开请求与解析成功，尚未接入生产服务或保存真实缓存；后续实现与验收如下。

## 2026-11-01 QQ 公开普通 LRC 备用接入

`src/main/qq-lyrics.js` 导出 `createQqLyricsClient({fetchImpl,timeoutMs,minRequestIntervalMs,maxResponseBytes})`，返回 `search(track,context)`、`get(record,context)` 和 `close()`。`context` 为主进程内部的 `{signal,isCurrent}`。`createLyricsService` 新增可选 `fallbackClient`，默认 `null`；已有测试、离线服务或自定义 LRCLIB fetch 不会因此隐式联网。正常主进程负责使用公开网络 fetch 显式注入，UI/IPC 合同不变。

只允许固定 HTTPS host `c.y.qq.com` 的 `/soso/fcgi-bin/client_search_cp` 和 `/lyric/fcgi-bin/fcg_query_lyric_new.fcg`。GET、`credentials:omit`、拒绝重定向；固定公开 `Accept:application/json`、应用 User-Agent、`Referer:https://y.qq.com/`（另设相同 referrer 和 strict-origin 策略）。调用方不能提供任意 URL、请求头或凭证。仅使用已验证的固定 guest 参数 `g_tk=5381/loginUin=0/hostUin=0` 与普通 LRC 参数；不读取账号、Cookie、动态签名，不执行安装脚本、COM、QRC 或解密流程。

每次自动备用最多一次搜索和一次唯一匹配后的普通 LRC GET，无自动重试。每个操作默认 10 秒总预算（含串行等待间隔和响应读取）、512 KiB 响应上限、700 ms 串行间隔、最多 16 个已接纳操作。只读取 Content-Length 与 Retry-After 响应元数据；HTTP 429 依其秒数/日期共享冷却，无自动重试。网络 JSON 和 Base64 解码后的正文均严格 UTF-8，拒绝损坏 JSON、非成功 API code、非规范 Base64、无效候选 ID 和结构。返回仅含规范歌曲元数据与普通 LRC，其他提供方字段不向服务传递。

LRCLIB 用完有限重试或得到 not-found/parse-error 后才考虑备用。主源 `selection-required` 不绕过选择；取消、关闭、缺元数据、禁用 online 或 preferredSource 不为 lrclib 时均不启动备用。QQ 必须有曲名、歌手、专辑和已知正时长：NFKC、大小写和空白标准化后，前三者严格相同且时长差不超过 2 秒，保留所有标点、Live/Remaster/Cover 等版本内容。最多检查前十个候选；零匹配不下载，多匹配返回 selection-required，不自动取首项。歌词返回后再次检查 ID 和全部版本元数据。

成功文档保留 `source:QQ Music`、`provider:qq`、`sourceId/sourceKey:qq:<songmid>` 和固定 `https://y.qq.com/n/ryqq/songDetail/<songmid>` 来源 URL；LRCLIB 继续使用数字 sourceId，并增加 `provider:lrclib/sourceKey:lrclib:<id>`。旧版 LRCLIB 缓存和手动绑定缺少新增字段仍可恢复。恢复时拒绝矛盾的 QQ/来源 ID/URL 或已存在但不一致的 LRCLIB provider/sourceKey。手动搜索、预览、候选绑定仍只支持已有 LRCLIB 流程；QQ 备用结果不会被当成 LRCLIB 数字候选。绑定快照、本地文件及匹配缓存优先级保持原规则。

QQ 按生产 parseLyrics 的实际正文保留 line/plain/instrumental 或真实词时间，不生成逐词时间。文档附 `primarySource/primaryStatus/primaryErrorCode` 记录主源失败；备用失败不写成功缓存。强制刷新若主源网络/解析失败且备用也失败，继续显示原有成功缓存。取消、关闭、新请求代数和元数据检查覆盖备用搜索、读取、间隔与落盘；旧回复不能覆盖新曲或缓存。close 使逻辑请求和排队等待及时结束，但不宣称忽略 AbortSignal 的底层请求已经退出；其物理槽仍保留到 fetch/read/cancel 真实结算。

实际验收：2026-11-01T01:20:23.173Z，生产 adapter + service，对《黑色蝴蝶》／汪苏泷／传世乐章／227.03648526077097 秒，经现有 `127.0.0.1:7897` 代理只请求 QQ 搜索和唯一命中 LRC 各一次，均 HTTP 200。LRCLIB 使用先前真实 HTTP 502 状态回放三次，零新增 LRCLIB 网络请求。自动选择 `qq:004CAUsM4ZX5x5`，得到 ready/line、81 行、0 词时间戳。

真实结果实际写入独立证据临时目录 `review-evidence/apple-playback-polish-20261101/lyrics-fallback-real-temp/data/lyrics/state.json`（6095 bytes），未写真实用户 data。关闭后新建 service、onlineEnabled=false、未注入备用客户端，零网络调用仍为 ready/fromCache/QQ Music/81 行0词；在线、落盘和离线时间轴 SHA-256 均为 `f7ff50912e8ff40e53566b9d08160eced7b873698c678126c7b257030a4944b3`。无正文证据见 `lyrics-fallback-live.json`，执行脚本与日志同前缀保留。该脚本有每端点一次硬上限，不应重复运行。

确定性检查 `node --test tests/lyrics-parser.test.js tests/lyrics-service.test.js tests/qq-lyrics.test.js`：83 项通过，0 失败；覆盖备用失败/无匹配、多版本拒绝、关闭/超时/限流、断网重启和快速切曲旧回复隔离。6 个 JS/CJS 文件的 node --check 均通过，详见 `lyrics-fallback-final-tests.log` 与 `lyrics-fallback-checks.log`。项目没有专用 lint。未在实际 Electron/app 中验证 session.fetch 网络路径，未验证全中文曲库或多曲覆盖；未运行构建、打包、原生 helper、播放器、UI 或音频操作。

随后独立 Reviewer 复现超时后的物理串行槽问题：逻辑请求结束，而忽略 AbortSignal 的底层 fetch 尚未结束时不能发送后续请求。QQ adapter 已改为保持真实 fetch、body read 和 cancel 的槽位直到实际结算，16 个已接纳上限同样保持；逻辑超时/close 仍及时返回，迟到结果不发布或写缓存。修后本组 **88 / 88**；原三个超时请求只留下一个物理请求，独立原场景与新增 focused 检查通过。原真实缓存离线证据未变，没有重复联网。日志为 `lyrics-fallback-transport-tests.log`、`reviewer-qq-transport-fixed-review.md`；phase83 与 phase88 为各自实际执行记录，不相加为用例总数。
