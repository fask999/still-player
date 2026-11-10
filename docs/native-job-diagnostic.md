# r6 Native Job 自然退出诊断

这是一个独立的非 UI 诊断，不是 foobar、Beefweb、设备枚举或播放验证。它只回答：固定 r6 Native 启动器能否为一个已审查的自制程序产生真实 creation witness、READY、自然退出和 tree-empty 品牌。成功也不能宣布 r6 播放内核健康。

`scripts/verify-native-job-diagnostic.js` 默认只输出计划。实际 Native 尝试必须等负责人及 Reviewer 审查脚本、固定 stub 和作用域后，由负责人串行运行一次。它不执行安装器、Electron、官方 foobar core、音频、SMTC、键、电源、全局音频或音量接口；不读 C 用户数据、旧 D 软件/profile、用户媒体或认证数据。

## 先准备，不运行 stub

固定 C# 源码完全包含在脚本的 `STUB_SOURCE` 中：

```csharp
using System.Threading;
internal static class StillNaturalExitFixture {
  private static int Main(string[] args) { Thread.Sleep(1000); return 0; }
}
```

它忽略参数，仅睡眠一秒后自然返回 0，不读写文件、不启动子进程、不访问网络或音频。编译器固定为本机 .NET Framework x64 `csc.exe`，使用 `/target:exe /platform:x64`；没有可接受任意源码、编译器、目录或启动入口的 CLI 参数。

```powershell
node scripts/verify-native-job-diagnostic.js --plan
node scripts/verify-native-job-diagnostic.js --prepare
```

`--prepare` 先验证固定 r6 完整 trust root/511 文件，再在以下全新 UUID 内写源码、常量 JSON 和零字节 marker，编译并实算每个文件 SHA，不执行 stub 或 Native 启动器：

```text
review-evidence/20261108-public-release/non-ui-baseline/native-job-diagnostic/<uuid>/
  NaturalExit.cs
  prepared.json
  root/
    foobar2000.exe             # 仅自制自然退出 stub，不是官方 foobar
    portable_mode_enabled
    profile/beefweb/config.json # 仅固定诊断常量，不运行 Beefweb
```

名称 `foobar2000.exe` 和上述目录是现有 Native 接口的固定路径要求，不能用来伪称它是播放器。准备记录明确为 own fixture，并附 stub 源码 hash、编译 exit 0、实算文件 pins。只允许这些文件/目录；链接、hardlink、额外文件、既存陌生目标或源码/config 改动均拒绝。

## 唯一 Native 尝试

负责人检查准备结果后，显式传准备记录的 UUID 和完整 hash：

```powershell
node scripts/verify-native-job-diagnostic.js --execute --prepared-id <uuid> --prepared-sha256 <prepared.json的SHA256>
```

`--execute` 再次核 r6、准备记录及所有文件/hash/闭合 namespace，再用 `native-attempt.json` 的不覆盖创建阻止同一个 fixture 被重复运行。它仅从 r6 `resources/app/src/main/backend-job.js` 调用原始 `createBackendJobProcess()`；不传 spawn/platform/协议绑定 DI，也不直接构造 `bindBackendJobProcess()` 或 BackendSession/健康对象。r6 launcher 与其运行时 pins 完全不改。

实际 `onCreated` 必须通过同一 r6 模块的 `isOwnedCreationWitness()`。`job.ready` 只能由原解析器接受真实 Native READY 后完成，且 READY 帧验证了父进程持有 Job 的声明；这不是独立的“transfer”事件。child-exit 来自原解析器的已验证退出事件；tree-empty 必须再次由同一 r6 `isBackendJobTreeExit()` 的真实 WeakMap 接受。JSON 复制和 PID 缺席不提供这些品牌。

不发送 `/exit`、`requestExit`、kill、Breakaway 或权限/安全设置变化；stub 自然退出。创建前失败、创建后无 READY、超时、通道损坏或无 tree 品牌都失败，且从尝试 Native 调用起保持独立保留 timer，不能把 `created=false` 理解为 OS 没建过进程。只有真实 tree 品牌或根本未尝试 Native 才解除保留；不依赖返回结果或日志成功来保留。

`events.jsonl` / `result.json` 仅包含 typed 阶段、PID、已有帧/品牌观察、退出码及缺失证明；不保存 nonce、原始协议/错误文本、profile 内容或未知媒体信息。stdout/stderr 使用受审的 safe guard；observer 失败只令结果失败，不能阻断 ACK、安全观察或保留决策。Native 无阶段/Win32 错误的失败仍明确标为未知，不能猜成权限、Job 或 foobar DLL 故障。

## 解释结果

- 若自然退出 fixture 的 creation/READY/child/tree 均通过，只证明这个输入下的 Native 路径可用；不证明官方 foobar 或 Beefweb 可启动。
- 若同样在 creation/READY 前失败，可将“必须先运行 foobar 业务/音频才发生”从该 fixture 中排除，但仍需 typed Native stage/Win32 error 才能定具体根因；不得自行改安全或 Job 策略重试。
- 若 child 退出但 tree 缺证，或仅收到失败帧，保留执行器并报告失败。无法回补原第一个枚举执行器已经丢失的创建/退出品牌。

纯 fake 测试在 `tests/native-job-diagnostic.test.js`，不会编译或运行任何程序。原失败 run/result/events 保留不改；诊断与后续产品源码修复、重建或安装验证分别审查。
