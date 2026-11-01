# STILL 启动、诊断与恢复 / Start, diagnose and restore

STILL 的本地音频由应用自带的专属便携 foobar2000 播放，Beefweb **0.10** 仅监听独立本机端口 **18880**。正常打开 STILL 时，应用管理此内核并隐藏其原生窗口，只显示新的 STILL 界面。无需另开原来的 foobar2000。原 `D:\foobar2000` 安装、原 profile、备份和音乐均独立保留；初始化不会改音量、DSP 或输出。

## 日常启动

1. 保留整个 `Still-win32-x64` 目录，运行其中的 `Still.exe`。仅复制 exe 无法运行。
2. 后端固定在 `Still.exe` 同目录的 `backend\foobar2000`。应用不会向父目录寻找原程序，也不会在专属内核失败后回连原安装。
3. 后端缺失、文件核验失败、端口被占用或启动失败时，STILL 界面仍显示真实不可用状态。查看诊断并使用“重试”重新检查；这不会自动安装组件或覆盖 profile。
4. 最左侧“本地 / Apple”仅切换浏览。只有明确开始另一来源的播放，才会有序停止旧引擎、验证输出已释放并启动新引擎。底栏显示实际播放来源。无法证明释放时，目标播放会被阻止并给出错误。

通过原生选择器导入音乐后，STILL 先保存自己的索引。若新目录需要加入专属后端的允许范围，界面显示待应用状态；库管理不会打断当前音乐。下一次明确播放时才会确认停止并在安全条件下重载专属内核。被复用而非由本次应用启动的实例不会被退出或重配。索引成功不等于已验证音频可播放，实际后端错误保留在诊断中。

初始本地库来自已保存的真实既存播放列表快照，经库服务实际读取文件 metadata 与封面生成：12 表、324 个条目、217 个唯一曲目，保留顺序和重复项。它们是 STILL 可编辑副本；后续使用不依赖原 foobar2000。迁移只向尚无 `library.json` 的新数据目录写入，不覆盖已有库，也不复制音乐文件。

Apple Music 入口采用官方网页自身的登录与播放流程，不要求另买 Cider 或办理 Apple Developer 会员。仅在实际宿主与授权能力就绪时启用对应操作；未连接、未验证或不能读取的能力如实显示。DRM 探测成功不代表已登录、已有订阅库或已验证全曲播放。Apple Music 的实际播放验收单独记录。

## 错误与原生诊断

STILL 设置中的音频信息来自实际后端读回。离线、输出选择失败或播放没有得到确认，均应按界面显示的事实处理。若 Beefweb 没有返回原始错误，**原因未确认**；不能推断为设备独占占用、驱动故障或音频格式问题。

记录当时操作、完整错误和时间，可在 STILL 打开数据目录查看诊断。不要为了排错启动原 foobar2000 或把原 profile 覆盖进专属后端。若涉及输出独占，停止状态只是后端读回；独立设备访问探测是当时可用性的证据，不能推断 DAC 实际采样率或判定哪个应用持有设备。分享诊断时不要附带音频或凭据。

## 备份或重置 STILL

源代码运行使用 `D:\foobar2000\Still\data`；目录包使用 `Still.exe` 同目录的 `data`。显式设置 `STILL_DATA_DIR` 时以该目录为准。应用中的恢复信息显示当前实际路径。

1. 正常退出 STILL，等待进程结束。
2. 复制整个实际 `data` 目录到自己命名的备份位置。它包含 `library.json`、`settings.json`、歌词缓存和手动绑定、封面，以及便携 Chromium 配置。音乐仍在原来的路径。
3. 如需重置 STILL，可把原 `data` **重命名保留**，然后重新打开 STILL 创建新目录。
4. 如需恢复，先关闭 STILL，保留当前 `data`，再把自己备份的 STILL `data` 复制回实际数据位置。

上述操作只处理 STILL 自身状态。专属音频配置另存于 `backend\foobar2000\profile`，需要备份时先正常退出 STILL 并确认其专属内核结束，再独立复制此 profile。不要删除或移动原音乐，不要把原 foobar2000 profile 备份覆盖进 STILL `data`。重新构建保留既有 `data` 和已存在的专属后端，不覆盖其 profile。正常退出会先停止本次应用控制的本地播放，再优雅关闭它实际启动的专属进程；不会强杀原程序或其他音乐应用。

## 原 foobar2000 配置的独立回退

用户原有备份：`D:\foobar2000\Still-backup-20261028-before-beefweb`。该目录是 foobar2000 原 profile/components 的备份，**不是 STILL 数据目录**。项目中的任何构建、测试或恢复脚本都不改它。此前验收记录为 159 个文件的 SHA-256 核验无差异；这不替代恢复前再次检查备份内容。

如用户决定回退 foobar2000：先手动关闭 foobar2000 与 STILL；另行备份当前 foobar2000 profile/components；检查原备份实际包含的相对目录与文件，再由用户按原位置手动复制相应备份内容。保留当前状态以便撤销。不要把整个备份目录盲目覆盖整个程序目录，也不要动音乐文件。STILL 不执行这些步骤，不提供自动重装或覆盖脚本。

## Windows 目录包与验收资料

### 2026-11-01 第二轮热修

第一包 b88 的文件验收通过后，用户实际 Apple 播放仍失败；它不是声音已通过的版本。该失败包的 451 个代码文件完整归档在 `D:\foobar2000\Still\design-archive\package-v2-b88-before-hotfix-20261101`，MANIFEST SHA256 为 `807994f46518ec4c646a2c52c15d5c8dc15f5818902beacb6c36b3324afc8a8e`。此档案不含 data、backend 或认证 profile。

本热修增加真实本地频谱组件、封面原色模式、当前播放列表/手势与受控 WASAPI 交接恢复。Apple 阶段本地内核可能已正常退出并显示待命；明确选择本地目标后应用才会启动新的专属实例，核验停止/空队列/列表与偏好后播放新目标，不自动恢复旧歌。非空或未知临时队列、输出范围不匹配、快照或退出证据不一致时仍会阻止交接。实际出声、受保护全曲、组件加载、副屏 DPI 和硬件零瞬音尚待用户复验。

这次更新只在用户正常关闭且 app、私有 backend、AppleHost、SpectrumReader 的精确路径均确认停止后执行。当前受控备份只复制经过白名单核验的 data 文件，含歌词绑定/偏移、设置、封面缓存、脱敏诊断及存在时的 `owned-output-handoff.json`；认证 profile 原地不读不拷。备份清单、当前闭态基线与两个私有后端组件事务保存在 `review-evidence\apple-playback-polish-20261101\iteration-2-play-failure`，以最终 `launch-and-rollback.md` 为具体记录。

若要回退：先正常退出，保留当前完整应用代码与当前数据；核对所选代码档案的 MANIFEST，再在空的 `resources\app` 目的地恢复完整 `app` 树和对应根元数据，不能把不同版本文件混拷。data 和登录保持原位，不盲目覆盖旧库/歌词/偏移，不删除 `accentMode` 或交接状态来迁就旧代码；若旧版不兼容当前状态，停止回退并保留两份证据。b88 本身已知 Apple 失败，恢复它不能视为播放修复。

频谱组件/manifest 属于独立的精确四文件事务；需要撤销时，必须在相同停态下按 [迁移说明](spectrum-install.md) 使用该次备份和事务恢复，不用旧 profile 覆盖当前 profile、不手删未完成 marker。源码工具、回退路径、当前版本与备份 manifest 的实际 hash 以本轮外部交付说明为准，未执行的回退不能写成已经验证成功。

2026-11-01 Apple/歌词/播放页更新只保留用户当前会话与数据。用户后续已实际播放《黑色蝴蝶》并进行 Apple 操作，历史 Rose 14.54 秒及旧队列恢复计划不再是当前意图，不会自动执行；旧失败证据仍保留。

更新前已发玻璃包的应用代码恢复备份位于 `D:\foobar2000\Still\design-archive\package-v2-before-apple-polish-20261101`，445 个文件有稳定哈希清单。备份的 `app` 对应包内 `resources\app`，另有 Still.exe / BUILD-INFO / START-HERE；没有复制 data、backend 或认证 profile。回退必须先由用户正常退出，先保留更新后应用与数据，再核对清单和设置/歌词缓存兼容；不要用旧状态覆盖用户更新后的绑定、偏移或登录。当前支持强调色的这份玻璃版备份优先于更早 before-glass 档案。

`START-HERE.txt` 在 exe 同目录。完整指南随包位于 `resources\app\docs\foobar-install-restore.md`。保留 Electron、foobar2000 和组件的全部许可证。此组装目录包仅供本用户私用，不是可以公开分发的修改版 foobar2000；目录包未签名。

真实验收证据由协调者完成后在交付报告链接：服务测试/构建日志、真实 Electron 的 `desktop-smoke.json` 与截图、后端实际音频与输出读回。此指南本身不宣称这些尚未执行的验收成功。桌面 smoke 只允许读取 IPC，不发送播放、音量或输出切换命令；完整音频验收另行进行。

## English quick guide

Keep the entire directory package and run `Still.exe`. STILL manages only its manifest-verified private portable backend under `backend/foobar2000`, using loopback port 18880 and hidden native UI. It never discovers or launches the original installation. Failures remain visibly unavailable with diagnostics and explicit retry. New import directories are deferred until explicit playback; browsing/importing alone never stops the current music. Switching actual playback engines requires independent output-release confirmation.

Close STILL before backing up `data` or its separate private backend profile. Imported audio stays at its original location. `Still-backup-20261028-before-beefweb` contains the original profile/components and remains unchanged. Original-profile rollback is a manual user operation after separately preserving the current profile. Apple Music follows the official website sign-in route; a missing/unverified adapter remains disabled, and a DRM probe is not full-song playback proof. This assembled backend is for private local use, not public redistribution.
