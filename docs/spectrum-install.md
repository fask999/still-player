# 精确频谱运行时与私有组件迁移

这是私用 STILL 目录包的文件交付说明。脚本的默认行为只生成计划，不启动、停止或杀死任何应用、播放器或 helper，也不连接 HTTP、音频设备或命名管道。

source/target 私有后端的既有受审基线现集中在 `manifests/backend-baselines.json`，由打包和安装器共用；原 SHA 与 canonical 语义保持不变。新候选默认不被批准，维护流程见 [基线维护说明](backend-baselines.md)。

本轮 client 源码整改使用 [独立修订记录](spectrum-client-revision.md)。原 native 清单、reader/DLL/许可及既有后端 provenance 保持不变；清单里的旧 client 三字段作为历史兼容锚，不代表当前生效源码。

`native/foobar-spectrum/delivery-manifest.json` 固定 SHA256 为 `284dae8ad48b96a464c635d8e848bc20d1699dfa74948987f8765d4ac94a131f`。构建检查会验证清单、client 源码、全部白名单文件的字节数和 SHA256，以及 reader/DLL 的 PE x64 标头；不会加载 DLL 或执行 reader。

打包到 `resources/app/native/foobar-spectrum/package/` 的文件只有：

- `StillSpectrumReader.exe`
- `foobar2000-sdk-license.txt`
- `pfc-license.txt`
- `COMPONENT-DETAILS.md`

`foo_still_spectrum.dll` 不进入 app。私有后端的独立迁移只允许在 `profile/user-components-x64/foo_still_spectrum/` 增加该 DLL 和以上三个说明文件。脚本不递归读取或复制 `native/foobar-spectrum/` 的 `tools`、`cache`、`shared`、`vendor`、`build`，不从系统工具路径寻找运行时。

`BUILD-INFO.json` 的 `spectrum` 记录清单、client、运行时哈希、后端组件状态与未验收范围。四项 app 运行时也进入原有 `hashes` 和 `sourceFrozenSnapshot`。最终打包强制 source 与任何被复用的 target 均已单独迁移：清单、四项真实文件及来源标记必须匹配，且没有未完成 marker；缺项、错哈希或未知组件项会使打包失败。校验还会还原受控的 manifest 差异，以固定规范哈希核对全部旧条目和 metadata，拒绝 UUID、config、mutability 等额外变化；新建目录包仅允许 packager 原有的受控新 UUID、目标和打包来源字段。`backendReused: true` 仅表示沿用原有私有后端，复用不会安装组件。成功产物中 `spectrum.backendComponent.installed`、`actualFilesVerified`、`oldManifestContentVerified` 为 true，`hostRuntimeValidated` 仍为 false。

## 只读计划

在 STILL 项目根运行：

```powershell
node scripts/install-spectrum-component.js --backend source
node scripts/install-spectrum-component.js --backend target
```

`source` 仅指本项目的 `backend/foobar2000`；`target` 仅指 `dist/Still-V2-preview-win32-x64/backend/foobar2000`。原安装 `D:/foobar2000/profile` 不是允许目标。CLI 不接受任意项目根或后端目录。

输出包含 `planSha256` 和完整 `plan`。计划核对旧 manifest 的固定首装 SHA256、backendId、destinationDir、专属端口、完整 config、旧条目及其 mutability。不可变项必须匹配旧 manifest；可变项按当时实际字节生成快照，不重置为历史哈希。额外同名文件、未知组件目录项、重复或越界路径、链接、junction、硬链接及不可读文件均拒绝。计划本身不创建目录、备份或 marker。

两份首装 manifest 的固定基线分别为：

- source：`1f0de056014825a60f3f49838b8d4f76cfef82e8930fddf0135ba68a8e01e5c5`
- target：`48117102e48e6d52d3ff15d79bac71ca9b1dffef29423691597c3b9638cea490`

安装后的再次迁移需要另行审查新的基线；脚本不会通过自动改写允许哈希来绕过这一检查。

## 受控应用与恢复

真实 source 或 target 的应用必须先获得对应目录的明确部署授权。target 必须等待用户正常退出，再获得新鲜的关闭状态；旧计划不能替代关闭确认。正常启动可能改变 SQLite 等可变文件，因此退出后需要重新生成计划、审查 `planSha256`，再应用。脚本不会为达成停态而终止进程。

编程接口：

```javascript
const migration = require('./scripts/install-spectrum-component');
const plan = migration.planSpectrumInstall({backendDir});
const reviewedSha256 = migration.planSha256(plan);
// 只有已审查这份计划且已获得此目录的部署授权，才能调用：
await migration.applySpectrumInstall(plan, {
  expectedPlanSha256: reviewedSha256,
  authorization: migration.APPLY_AUTHORIZATION,
  evidenceDir: '<项目>/review-evidence/<批次>/spectrum-package-<唯一事务名>'
});
```

CLI `--apply --reviewed-plan <计划JSON> --plan-sha256 <已审查SHA> --evidence-dir <新证据目录> --authorization apply-reviewed-spectrum-component-only` 接受默认计划输出的 envelope 或原始 plan。`--rollback <同一证据目录> --plan-sha256 <原计划SHA> --authorization rollback-reviewed-spectrum-component-only` 使用同一份已审查计划恢复。授权字符串是显式操作防误触参数；它本身不代表用户已授权。

应用会重新核验计划、全部旧字节与交付文件，并通过 Windows 进程信息检查此目录的 app/backend/helper 路径。任何同名进程的可执行路径不可读，或进程检查失败，都按未确认停态拒绝。`profile/running`、SQLite WAL/SHM 存在也拒绝。首次停态检查之前不写任何文件。暂存期间再次出现进程，只保留证据目录，不写后端。

全部前置检查通过后，独立证据目录保存原 manifest 的精确字节、将覆盖的已授权组件字节（如有）、四项暂存文件、新 manifest 与事务日志。暂存及备份写入后执行文件 flush。后端先写 `.spectrum-component-install-incomplete.json`，再以排他创建增加组件文件，最后通过同目录临时文件 rename 原子替换 manifest。部署全过程不打开 SQLite，不改 DSP、输出、音量、resume 设置或 STILL data、授权 profile。旧 manifest 的全部条目和对象值保持，只有四个新增条目、相应 totals 和受控 `spectrumComponent` 来源标记形成内容差异。

该 marker 是后端启动拒绝标记。成功验证后移除；中断或失败保留 marker、备份与错误日志，禁止继续启动并交给审查恢复。恢复在每次删除文件、替换 manifest 和最终移除 marker 之前，先完成最后一次停态检查，再同步复验此时的精确文件快照、原计划 SHA、交付源、暂存和备份、旧条目、当前 manifest 与 marker；任何新字节、未知文件或漂移都会保留，并使恢复记录为失败。恢复只撤销本事务新增文件，按精确备份恢复 manifest，不删除未知文件。该复验关闭脚本中已知的 await/onPhase 检查窗口，不构成对任意特权并发写入的文件系统锁。恢复中断同样保留 marker 和日志。不要手动删除 marker 来绕过失败。

reader 的 marker gate 是分层调用合同：backend manager 在成功读取 manifest 和启动前拒绝 marker；main 仅可向 spectrum client 提供由 manager 验证、当前有效且属于 STILL 的 `backendSession`。迁移要求对应 backend/app/helper 全部停止，因此 marker 期间不能建立合法的新 session；未知或手工直启的非 owned backend 不提供给 reader。固定 C# reader 只接收 PID/采样间隔，不读取 backend 路径、profile 或 marker；client 也不独立读取 profile marker。此边界不要求修改已受审的 reader、client 或 delivery manifest。main 的 marker→无合法 session/不启动 reader 需要独立的集成测试证据，不能由本脚本的文件事务测试替代。

这些文件事务和 fake-process 测试不构成 foobar 宿主加载、真实管道、播放/暂停/seek/切曲时序、音频线程影响、关闭竞争、DAC/输出设备或 Apple 受保护音频频谱的验收。实际结果必须由后续得到授权的真实宿主测试确认。
