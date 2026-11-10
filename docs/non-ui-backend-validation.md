# r6 非 UI 播放内核基线验证

`scripts/verify-public-backend.js` 是独立 Node 执行器，不加载 Electron 的 `main`/`entry`，不使用 ComputerUse、浏览器、桌面接口、窗口读取、截图或输入。它不注册本应用的 SMTC、全局键或电源功能，不调用系统音量、默认音频设备、安装器、卸载器或外部账户接口。这里只验证正式公开包内核链，不能替代最终安装包或界面验收。

初次交付阶段只有源码、纯 fake 测试及文档。此后的实际执行结果以各 UUID 中保留的证据为准，不能用 fake 测试代替。实际准备、枚举与播放都由负责人在独立 Reviewer 核对脚本后串行运行，不需要再次向用户请求已有授权。启动失败的独立 Native 自然退出诊断见 [native-job-diagnostic.md](native-job-diagnostic.md)，它不提供播放器健康证明。

## 固定输入和写入范围

唯一运行包是 `dist/Still-public-1.1.0-candidate-20261108-r6`。`BUILD-INFO.json` 的信任根为 `4ea5c13f3cd0399f46c84260b388bd6ee8bbd2ecc831196801ad0a3d86f70550`；执行前逐文件检查全部 511 文件、395052707 字节。其中 `BUILD-INFO.files` 固定 509 项，另两项是固定 hash 覆盖的 BUILD-INFO 和其 checksum 文件。未声明文件、路径越界、链接/junction、文件 hardlink、输入变化或 hash 不符都会在启动前失败。

唯一源媒体是已授权的 `review-evidence/20261108-public-release/qa-media-auto-20261108/STILL-QA-silence-44100-stereo.wav`，2116844 字节，SHA256 `6f9d38879c041d549646d87ddd563a34b95c14d77ec3df2f14bbebd317d794cb`。除 hash 外还要求标准 PCM、44.1 kHz、16 位、双声道、12 秒及全部零样本。执行器不修改该源文件，只把完全相同的字节写入本次新数据中的 `qa-media/`。Beefweb 只允许这个副本目录，不配置其他库目录。

每次枚举和播放都新建不同 UUID：

```text
review-evidence/20261108-public-release/non-ui-baseline/<uuid>/
  events.jsonl
  result.json
  data/
    qa-media/STILL-QA-silence-44100-stereo.wav
    backend/foobar2000/
```

没有 data/backend/package 路径覆盖参数，不复用旧 UUID，也不删除旧记录。新建目录和文件采用不覆盖语义。除本次新目录外，执行器不写包目录、C 数据、旧 D 安装、用户软件、媒体库、profile 或认证数据。枚举记录只读本脚本目录中的指定 UUID `result.json`，不读取那个旧 run 的 profile。

## 正式 API 链

实际 CLI 只从 r6 `resources/app` 导入以下正式模块，不从当前开发中的 source 导入生产逻辑，也不给生产构造器传 `spawn`、`fetch`、`inspectSystem`、平台、session 或 brand 伪造 DI：

1. `backend-bootstrap.createBackendBootstrap({appRoot,dataDir,backendDir})`：`initialize()` 必须确认新目标和 schema 2 自动部署；`begin()` 仅用随包工具读取原封官方 setup；`complete({musicDirs:[本次qa-media]})` 校验 core/components 并建立新 profile。
2. `backend.createBackendManager({requireOwnedSession:true,requirePublicProvenance:true,startStopped:true,publicFiles,...})`：正式 Native Job 使用 `/hide /stop`、隐藏启动器和随机独立 loopback 端口。只有真实 Native READY、端口 owner、Beefweb 0.10 健康与 roots 通过，且 `isVerifiedBackendSession()` 认可同一对象时才允许下一步。
3. `foobar.createFoobarService()`：绑定那个真实 session；真实初态必须 healthy/stopped，再调用正式 `bootstrap.markReady(session,info)`。只进行设备枚举或明确设备的单首静音播放，不调用 Apple、频谱服务、SMTC、媒体系统、音量或键盘服务。
4. 正常结束要求 `service.stop()` 与独立 `getState()` 两次 healthy/stopped。关闭写入门后调用正式 `backend.close()`；同一 session 的 `isVerifiedBackendChildExit()`、`isVerifiedBackendTreeExit()` 和 `isOwnedTreeExited()` 必须全部认可真实退出，才 `markBackendExited()`、关闭 bridge。

不以 PID 缺席、JSON 字段、HTTP stopped 或关句柄代替 child/tree 品牌证据。失败清理只能用正式 shutdown stop 许可和同一 manager 的 graceful exit；不调用 kill、taskkill、安装/卸载或强制关闭 Job。如果 owned 退出仍未证明，结果失败，执行器保留生命周期防止主动退出关闭活体 Job，交负责人处理，不把强制退出当通过。

保留 timer 在构造/启动前已建立，主流程直接持有 manager/session/真实退出状态，不依赖 `runLifecycle` 是否成功返回结果。未知或抛错的 manager 状态同样保留。一旦尝试 `backend.initialize()`，即使 `startupCreated=false`、`owned=false` 也不能解除保留：它们只表示 JS 没收到创建见证，不能证明 OS 没建过挂起 child 或树已经退出。只有匹配的真实 child/tree 退出证明，或还未尝试启动的 manager，才解除保留。失败结果另外保留有界 typed manager snapshot，明确区分 creation witness 与 Native READY，不读 raw 日志。

观察器同步 throw、异步 reject、stdout/stderr 的 write 错误或 `error`/EPIPE 事件只置 typed observer 失败，不得打断 stop、graceful exit 或保留决策。观察器失败时即使物理退出成功也仍报告失败，不把退出事实改造成通过。

## 两阶段命令

默认计划与纯 fake 检查可以先运行：

```powershell
node scripts/verify-public-backend.js
node --test tests/public-backend-verification.test.js
```

`--check` 只做固定包、链接、WAV 的只读检查，不调用 bootstrap 或 backend。真实阶段须等源码/契约 Review 后，由负责人运行：

```powershell
node scripts/verify-public-backend.js --execute --stage enumerate
```

此阶段不选择输出、不播放，保存真实输出 ID/有界名称供负责人决定；也必须停止并证明同一 owned tree 退出。负责人从该记录显式指定真实 DX1 的具体共享 tuple，再以新 UUID 运行：

```powershell
node scripts/verify-public-backend.js --execute --stage play --enumeration-id <前次UUID> --type-id output --device-id <精确共享ID>
```

只允许 native shared provider `D41D2423-FBB0-4635-B233-7054F79814AB` 加非零具体设备 GUID；拒绝全零 Default 设备、独占 provider、ASIO、未知 provider 和设备名称匹配。provider 在某些列表中可带“默认”字样，但这里始终以非零 endpoint 指定具体设备，不查系统 Default role，也不自动选 DX1。前次枚举只证明候选 tuple 存在，不提供任何新 session/退出品牌。

选择后必须读回精确 tuple、精确 CoreAudio endpoint、connected 和明确 retry 成功。连接探测仅使用随包的 GetState，不执行额外独占初始化探测。播放只调用正式 `service.play({paths:[本次静音副本]})`；需要同一 WAV/subsong、同一输出、healthy/playing，以及至少三个读回中的实际位置推进至少一秒。瞬间 playing(position0)、冻结位置、另一个媒体、失联、stop 未确认或 tree 证据不足均失败。不会把进度或测试容器当作 DAC 格式/可听输出测量。

## 证据和覆盖边界

`events.jsonl` 与 `result.json` 只保存受限 phase、typed code/PID/port、输出 tuple/endpoint、该自制 WAV 的布尔身份和位置、stopped/child/tree 验证结果。不会保存 provider error 文本、堆栈、曲目标题、未知媒体路径、用户 profile 或认证内容。Core 自己生成的新 profile 数据保留在本次隔离目录，执行器不读取 raw debug.log。

stdout 的 `evidence-finalizing` 只表示进入证据保存阶段，不是通过判定。实际通过必须同时具备 CLI 退出码 0、持久化的 `result.json` 通过状态及全部真实证据门；观察器/输出/证据写入失败不能凭某条 phase 日志当通过。

测试文件使用纯 fake API、内存 PCM 和 fake 文件元数据验证拒绝条件；测试结果不代表真实 Native Job 或设备通过。实际阶段仍需独立留存 r6 pin、准备结果、设备选择、进度、双次 stopped 和同品牌 child/tree 退出。只在这些全部完成后，负责人才能把非 UI 基线视为通过；最终 Top5 净包的安装验证属于另外一次获授权的阶段。
