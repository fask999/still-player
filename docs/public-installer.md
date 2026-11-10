# STILL 公开安装版

本安装包面向 Windows 10 或更新版本的 x64 系统，为当前 Windows 用户安装 STILL。程序默认安装到 `%LOCALAPPDATA%\Programs\STILL`，可在安装器中选择其他专用本地目录。库、偏好、Apple 登录状态和专属播放内核始终位于独立的 `%LOCALAPPDATA%\STILL`，不随程序目录改变。导入音乐不会移动或复制原音频。

本发布中的原生辅助程序统一要求系统具备 **.NET Framework 4.8 或更新版本**，运行已打包的 STILL 无需安装 Node.js、开发 SDK 或既有 foobar2000。Apple Music 功能另需系统提供 **Microsoft Edge WebView2 Runtime**；随包的 WebView2 SDK DLL 提供宿主接口，并不包含浏览器运行时。参见 Microsoft 的[支持环境说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/#supported-programming-environments-and-devices)和[Runtime 分发说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)。

双击 `STILL-<版本>-Setup-x64.exe` 完成安装，然后从开始菜单打开 STILL。安装器不请求管理员权限、不安装驱动、不修改其他 foobar2000 安装，也不自动打开或播放音频。

自选目录必须是新的或确认为空的专用目录，不能是磁盘根、系统目录、链接目录，也不能等于数据目录或与它互相包含。若已有 STILL 注册或旧快捷方式，安装器会要求先正常卸载旧程序，保留数据后再安装到新位置；不会只搬文件或覆盖旧注册。所选绝对路径与安装收据、注册信息、卸载器和快捷方式绑定。

## 无界面安装参数

STILL 自身的 Setup 支持大写 `/S`，默认目录仍为 `%LOCALAPPDATA%\Programs\STILL`；可用最后一个参数 `/D=<本地盘符绝对路径>` 选择专用目录。`/D` 的路径不加引号，含空格也按原始命令行保留。此入口拒绝未知、重复、错序、大小写错误的开关，以及带引号、相对路径或附加开关文本的 `/D` 值。目录校验在安装 Section 开头再次执行，silent 跳过目录页面也不会跳过安全门。

例如下面只是调用格式，先把 `$setup` 指向已校验的 STILL Setup；使用独立 FileName 和原始 Arguments，不通过 shell 拼接执行：

```powershell
$setup = (Resolve-Path '.\STILL-1.1.0-Setup-x64.exe').Path
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $setup
$start.Arguments = '/S /D=D:\Apps with space\STILL'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$process = [Diagnostics.Process]::Start($start)
$process.WaitForExit()
$process.ExitCode
```

只有程序文件、收据及当前用户注册信息写入并回读验证成功才返回 `0`；失败返回非零且 silent 错误路径不弹窗口。脚本错误码包括 `10` 参数错误、`16` 系统前提不满足、`20/21` 目录安全检查失败、`22` 既有注册或安装锁冲突、`23` 同名文件冲突、`24` 写入失败、`25` 成功条件回读失败；NSIS 自身的取消、校验或提取错误也会返回非零。失败可能保留本次已经写入的程序文件，不会强制覆盖旧注册或清理未知条目。

此参数合同只针对 STILL 的安装入口，不是 foobar2000 官方安装器的静默开关，也不提供或验证卸载 CLI。既有卸载被系统或产品策略拒绝时，不得用此入口、其他 helper 或命令行绕过。安装器不启动 STILL、播放内核或音频；程序首次启动后的功能仍需单独验收。

首次打开 STILL 时，程序校验随包携带的原始官方 foobar2000 安装文件和独立的 7-Zip 命令行工具，自动把白名单中的官方文件部署到本用户的专属目录，并建立新的 portable 标记和独立配置。此过程在本机完成，不需要再操作官方安装向导。失败会保留明确的未就绪状态，不会改用或导入机器上已有的 foobar2000。官方安装文件、独立工具和组件的许可分别适用；下载包不分发已解压或带用户配置的 foobar2000 core，也不表示第三方作者为 STILL 背书。

foobar2000 的[官方 FAQ](https://www.foobar2000.org/FAQ) 对修改安装包及第三方重打包提出警示。本方案保留原封官方安装文件，只在接收者本机使用独立工具部署明确成员；这是对原安装器再分发和本机使用条款的解释，并非 foobar2000 作者对该集成方式的专项授权。分发不包含预展开 core、用户 profile 或 foobar 视觉皮肤；STILL 的集成与使用支持由 STILL 项目承担。

STILL 当前未进行代码签名，Windows 可能显示未知发布者。发布附件附有 SHA-256 校验值。哈希检查只能核对下载内容，不能代替发布者签名。

从 Windows 已安装的应用或开始菜单中的 Uninstall STILL 卸载程序。卸载只删除安装时列出的程序文件，默认保留 `%LOCALAPPDATA%\STILL` 中的库、登录、设置和专属内核。卸载也不删除原音乐。需要升级时，请先关闭 STILL，卸载旧程序，再安装新版；保存的数据可继续使用。安装目录中自行添加的未知文件会被保留，若阻止重新安装，请先手动备份或移走它们。不要搬移卸载器或将安装目录改为链接、junction。

程序保留各第三方原始 LICENSE/NOTICE：Electron 及 Chromium 位于安装根目录；WebView2、foobar2000 SDK/PFC 和生产 npm 依赖位于 `resources\app` 各自目录。独立 7-Zip CLI、完整二进制许可证 `License.txt`、全文 LGPL `COPYING.txt`、完整同版源码 `7z2606-src.7z` 和来源声明 `Source-Info.txt` 都位于 `resources\app\bootstrap\7zip`。安装根目录的 `THIRD-PARTY-NOTICES.txt` 提供位置索引。7-Zip 作为独立程序调用；现有 STILL 项目授权保持不变，第三方许可证授予的权利也保持有效。

## 构建与核对

使用 Windows x64、Node 24 或更新版本和项目锁定的依赖。公开构建入口独立于私用便携包，不读取 `backend`、`data` 或旧 `dist` 的内容。

先准备固定版本的原始官方资源。准备脚本从 `installer/bootstrap-sources.json` 中的官方地址获取精确版本，检查 SHA-256 和官方安装器 Authenticode，并只解出 Beefweb 的 x64 组件及网页资源；它不会提取或运行 foobar2000 安装器，也不会运行 7-Zip。将官方 26.06 x64 发行包中的原始 `7z.exe`、`7z.dll` 放在下面指定的工具目录，脚本会严格核对已审字节。资源保存在 ignored `tools/public-bootstrap-auto-20261108`，重复执行会拒绝覆盖。已有相同的原始 foobar/Beefweb 下载文件可通过 `--from-directory <目录>` 提供；完整原始 7-Zip 源码可通过 `--extractor-source <7z2606-src.7z>` 提供，否则只从固定官方 URL 获取。

```powershell
node scripts/prepare-public-bootstrap.js --extractor-directory tools/7zip-26.06-official-core/portable
```

受审的 schema2 `manifests/public-backend.json` 记录官方安装器、关键核心身份文件、逐组件哈希和六项独立解包工具/许可/源码资源。核心基线来自官方原安装器的离线取证，portable marker 使用零字节约定；构建只复制官方原始 setup、明确组件和工具资源，不复制离线取出的 core。真正的部署、组件加载和播放体验另行验收。

```powershell
node scripts/package-public.js --output dist/Still-public-<新构建名称>
node scripts/build-installer.js --package dist/Still-public-<新构建名称> --output dist/Still-public-<新安装包名称>
```

公开 packer 只复制 `installer/public-files.json`、`installer/dependency-files.json`、`installer/electron-files.json` 和已审 schema2 bootstrap manifest 明确列出的文件。生产依赖逐文件哈希来自一次干净的、禁用生命周期脚本的锁文件安装；Electron 文件按锁定版本逐文件冻结。源、依赖、Electron、许可证或清单有变化时，必须审查并更新相应清单。新文件、内容漂移、符号链接、junction、输入 hardlink 和已存在的输出目录会阻止构建。不会覆盖或清理旧包。

安装器使用官方 NSIS 3.13 ZIP 中的编译器，工具只保存在 ignored `tools`。`installer/nsis-toolchain.json` 记录官方来源、ZIP SHA-256 及解压文件清单，编译前后核对。构建不运行 NSIS 安装 EXE、不执行 STILL、foobar2000 或安装后的应用。安装器仅包含逐文件 `File`/`Delete` 列表，使用当前用户安装权限；卸载没有通配符或递归目录删除。

安装首先解出文件到 NSIS 的独立临时目录，再以 Windows `CopyFileW` 的 fail-if-exists 模式逐文件创建目标。每个目标均检查链接与冲突；出现占用、既有文件或竞态冲突会中止，不截断已存在的同名文件。

目录包的 `BUILD-INFO.json` 记录全部有效载荷、源快照和输入清单哈希，`BUILD-INFO.sha256` 校验该记录。安装器输出包含 EXE、`SHA256SUMS.txt`、`INSTALLER-INFO.json` 及编译日志。可按同一锁文件、白名单和工具链重复构建；时间记录和安装器压缩元数据可能造成最终 EXE 哈希不同，未承诺逐字节可复现。

自动化验收覆盖文件完整性、白名单、私用数据隔离、异常路径和安装器生成规则。真实 Windows 新账户中的安装、卸载、升级、首次自动部署、组件加载、音频播放和设备行为需单独人工验收；编译成功与哈希一致不表示这些体验已通过。

卸载先核对完整程序清单，并通过受管理的程序资源和持续启动锁确认 STILL 及其专属内核闭态。随后只对安装根的精确 `debug.log` 做普通文件、非链接、链接计数为 1、属性、数据流和句柄身份检查，不解释日志内容；能够安全确认时，将原始字节无覆盖复制到 `%LOCALAPPDATA%\STILL\logs` 的唯一名称下并落盘，复核完成后才通过原源句柄移除源文件，支持程序和数据位于不同磁盘。无法确认、正在占用或复制、落盘、精确移除失败时停止删除程序文件并提示状态，保留可确认的日志副本。其他未知条目继续保留，不通配删除。该流程保留用户数据，不承诺程序文件删除具有事务原子性。
