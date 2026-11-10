# CUE 原文件只读 lease

`src/main/cue-read-lease.js` 为 CUE 元数据索引提供稳定的原文件窗口。独立 holder 用 Windows 共享访问约束持续持有原 CUE、最多 32 个引用文件及必要祖先目录。它只读取已持有 CUE 的最多 1 MiB 来核对 SHA-256，不读取或解码引用音频，不输出 CUE、歌词、音频或源路径。

```js
const {createCueReadLease, isVerifiedCueReadLease} = require('./cue-read-lease');

const lease = await createCueReadLease({
  runtimeRoot,
  request, // path, references, trackCount, authorizationRoot, encoding, contentHash
  signal: controller.signal,
  onLost: cause => controller.abort(cause)
});
if (!isVerifiedCueReadLease(lease, {request})) throw new Error('unverified lease');
await lease.check();
// 只有这时才允许独立 metadata 实例读入原 CUE。
// 在每次读入前、读取结束后及发布结果前调用 check()。
// 调用方须等精确实例的实际 child/tree-exit，再执行：
await lease.close();
```

`request` 必须是已有预检的六字段纯数据对象，引用数组有序、无重复，轨数为 1–99，编码为 `utf-8`、`utf-16le`、`utf-16be` 或 `gb18030`，哈希为原始 CUE 字节的小写 SHA-256。每个路径最多 2048 个 UTF-16 单元，合计最多 32768；只接受固定/可移除本地盘上的规范 NTFS 路径。此版本使用 NTFS 卷号及 64 位文件 ID，ReFS/FAT/exFAT 等其它文件系统拒绝，不把不同身份模型当作等价保证。UNC、设备路径、网络盘、ADS 路径、保留设备名、尾点/尾空格及目录穿越均拒绝。品牌完整绑定六字段的精确字符串与引用顺序，不用 Unicode 小写转换合并不同文件名。

Node 在启动 holder 前只捕获授权目录和源文件的 Windows `dev`、`ino`、`size` bigint 元数据。候选根的实际目录身份必须与授权根相同，防止大小写敏感目录仅名字相似。holder 取得锁后要求 `VolumeSerialNumber`、文件索引及长度与这些前置快照一致，拒绝同名字、同内容的新文件替换。原 CUE 的独立语法/引用重解析在 holder `READY` 后的锁窗口内完成；六字段不符时先完成 holder 清理，再拒绝，不交出已验证品牌。

重解析直接检查原始 `FILE` 列表，每个真实引用都必须属于实际授权根，并映射到已持有的 `dev/ino/size` 对象；数量和首遇顺序必须与请求相符。去重依据实际文件身份，不依据 Unicode 小写名称。因此即使早期预检把 NTFS 上的不同名称（如 `İ.wav` 与 `i` 加组合点的名称）合并，也会拒绝遗漏引用，不让索引器读取未锁定文件。

目录从盘根到每个源文件父目录依次打开，权限为 `FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES`，仅 `FILE_SHARE_READ`，加 `FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT`。必须是非 reparse 目录，句柄最终路径及实际授权根身份都要核对。文件使用 `GENERIC_READ | FILE_READ_ATTRIBUTES` 和仅 `FILE_SHARE_READ`；必须是普通磁盘文件、非目录、非 reparse、`nNumberOfLinks == 1`。离线、召回、加密、设备及虚拟等不支持属性拒绝。读权限使共享检查真实生效；仅属性权限不足以建立拒写约束。

每次 `CHECK` 都核对所有原持有句柄和同名路径的实际身份、类型与最终路径，复核文件长度、创建时间、写入时间和属性，再通过原 CUE 句柄重算哈希，最后再次检查。引用音频只做元数据检查。目录创建/写入时间不作为身份，独立兄弟缓存分支仍可创建新文件；源文件写入、文件替换/改名和祖先改名受共享访问限制。锁定后代也使这些现有目录不能被清空；fixture 的仅属性权限 junction 重设被 NTFS 拒绝145，只读/零权限重设拒绝5，并未把所有元数据操作误报为共享冲突32。实现保护普通进程对已锁本地路径的访问窗口，不保证对管理员、内核驱动、特权文件系统操作或被攻陷应用代码的防护。

`lease` 只有 `check(): Promise<void>` 和 `close(): Promise<void>`。私有 WeakMap 品牌绑定实际 `ChildProcess`、随机 nonce、请求摘要和原始身份；没有导出的构造器、绑定器或生产 spawn 注入参数。JSON、复制对象、相似方法或 `verified: true` 都无法还原品牌。`check()` 成功也不能代替调用方的索引进程退出证据。

取消获取期间，可以关闭尚未交出的 holder；获取失败会先尝试有界物理清理。取得 lease 后，外层 signal 取消只使品牌和 `check()` 失效并调用 `onLost`，不发送 `CLOSE`、不结束 stdin、不放锁。调用方先取消索引工作，等待真实 child/tree-exit，再显式 `close()`。如果 tree-exit 未证实，调用方必须保留 lease/controller 和失败状态，不能丢弃 owner 或假称已排空。同步抛出或返回拒绝 Promise 的 `onLost` 观察者不会跳过清理。

获取错误的 `cleanupPending` 只依据原始 child 的真实 `close` 事件设定。若仍为真，错误带有 `retainedController.close()`；模块自身也保留该 holder 的强引用。它复用同一关闭序号和物理退出 Promise，不会启动新进程、恢复失效品牌或强杀进程。超时不能伪造 `CLOSED`；调用方须把未确认退出作为阻断处理。

正常关闭成功必须同时具备 nonce/绑定/序号匹配的 `CLOSED`、源句柄计数归零，以及精确 child 的真实 `close`、exit0、无信号退出。只有 EOF、PID 消失、控制超时、exit0 或 `exit` 事件都不足够。任何意外退出都撤销品牌；恢复数据或收到后来的合法帧不会重新激活原品牌。

关闭期新发生的通道故障会持续保留：合法 `CLOSED` 后再来完整未知帧、重复帧、坏 nonce、超量输出、stderr 或流错误，即使缓冲随后被清空且实际 exit0，也必须拒绝关闭成功。物理 child 已关闭的事实仍保留，此时错误的 `cleanupPending` 为 false。关闭前已失效的 lease 可以做干净的物理清理；已在途的一个合法 `CHECKED` 只能在 `CLOSED` 前排空，不会把正常关闭误当作观察者丢失。

holder 固定接收 `--stdio-read-lease-v1 --parent-pid <process.pid>`。它从自身 kernel `PROCESS_BASIC_INFORMATION` 核对实际父 PID，取得仅 `SYNCHRONIZE | QUERY_LIMITED_INFORMATION` 的父 HANDLE，核对父仍存活、父创建时间严格早于自身，从而排除随意 PID 和创建后的 PID 复用。后台只读等待该父对象；父退出时 holder 可以自行退出，不控制其它进程。正常关闭先停止监视器，再发 `CLOSED`。生产始终 `detached: false`、`windowsHide: true`，raw child 有强 owner，从不 `unref`；没有自建 Job、桌面/媒体/输入 API 或其它进程终止接口。

本环境的普通父退出 fixture 中，精确 holder kernel HANDLE 已 signaled，源文件及父目录恢复可写，且没有 `CLOSED`；环境先行终止或管道 EOF 先于 managed watcher，未观察到设计中的 self-PARENT exit3 分支。旧的严格 exit3 失败记录和仅 fixture 的 detached 诊断均保留。这里只确认父死后物理释锁，不能声称该分支代码已实证；独立审查仍须评估这个具体覆盖限制。Node 对无 `CLOSED` 的 exit0 同样判失效，绝不判关闭成功。

标准输入是一次有界 `ACQUIRE1` 行，包含 nonce、绑定摘要、原始 CUE 哈希、编码、轨数、引用数、授权根与文件路径的 UTF-8 Base64、前置身份。Base64 只是管道编码。后续只接受带 nonce 和单调序号的 `CHECK1` / `CLOSE1`。输出仅限 `READY1`、`CHECKED1`、`CLOSED1`、有限错误代码和按索引排列的身份元数据；未知字段、跨 generation、超长、超速或非 ASCII 输出失效。Node 使用有界行缓冲、输出速率限制和 2 秒心跳，启动/检查/关闭分别有 6/5/5 秒控制预算；这些预算不能证明内核 I/O 已物理结束。

可信运行时固定在 `native/cue-read-lease/bin`，目录严格只含 `StillCueReadLease.exe`、`NOTICE.txt`、`runtime-manifest.json`。清单为 `{schemaVersion:1,kind:'still-cue-read-lease',architecture:'x64',files:[{path,bytes,sha256}, ...]}`，仅前两个固定文件。生产必须先通过中央 `readCueReadLeaseRuntimeAssets(runtimeRoot)` 取得源 registry 的第四固定资产 `cueReadLeaseManifest`，其固定相对路径为 `native/cue-read-lease/bin/runtime-manifest.json`。先核原始清单 SHA，再解析并核对闭库存、长度、文件 SHA、x64 PE 头和前后身份。邻近清单或本地重新计算的摘要从来不是批准。

`native/cue-read-lease/build.ps1 -CheckOnly` 仅读取本地编译前提。显式 `-FixtureOutputDirectory` 只可输出到被忽略的 cue-read-lease 证据树；`-BuildRuntime` 产生待审 bin 候选和清单，不修改源 registry、不自动批准 pin。输出目录必须新建或为空；任何既有条目（包括合法名称的 hardlink）都在编译/复制前拒绝，不覆盖已冻结资产。下一候选可先在新的 fixture 输出目录构建并复审。使用系统已安装的 .NET Framework x64 C# 编译器，零下载。运行需 Windows x64 与 .NET Framework 4.8；没有新增 MIT 或整体许可，NOTICE 不额外授予独立许可。

验证限于新建的 ignored CUE/48 字节 WAV、路径/链接和只读进程 fixture。它包括真实 Win32 写/文件改名/父目录改名拒绝32，普通 read 与兄弟缓存写可用，32 次 CHECK 的 holder 句柄数稳定，前置身份替换/越界/链接/hash错误拒绝，EOF 后实际退出释锁，以及父死物理退出的上述覆盖限制。未运行真实用户 CUE、音频、foobar/backend、Job、GUI、电脑控制、安装器或卸载器；生产 Node adapter 对真实 holder 的首次新 candidate 样本运行仍由负责人和 Reviewer 另行准入。
