# 播放设备恢复与 Apple Music 输出边界

核验日期：2026-11-08。

## USB 设备变更与本地内核连接

本机故障中，foobar2000 / Beefweb 正常响应，保存的 DX1 II 输出却仍指向已经不存在的 CoreAudio endpoint。Windows 为当前设备枚举了新的 endpoint ID。播放器可以连接内核，同时无法使用旧输出；这两种状态必须分别显示。

`0x80070490` 在本次 `IMMDeviceEnumerator.GetDevice` 调用中表示指定 ID 不对应现有设备（`ERROR_NOT_FOUND`），不能解释为“设备空闲”或“独占占用”。参见 [Microsoft GetDevice 返回值](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-immdeviceenumerator-getdevice) 和 [Windows 系统错误代码](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--1000-1299-)。

遇到此状态，在“音频与设置 → 本地输出设备”明确选择当前列出的设备，再发起播放。应用不按设备名称猜测新旧端点、不自动恢复播放，也不修改 Windows 默认输出。名称相同不代表 endpoint 相同。

连接观察只使用 `GetDevice`、`GetId` 与 `GetState`，不创建音频流。共享释放探测也先核对同一端点和 ACTIVE 状态；缺失、禁用或拔出的设备不执行音频初始化。

若已核验并绑定的自有内核在首次状态读取时暂时失败，后续轮询可以对同一会话重试只读查询。成功回读后恢复连接显示；恢复不会自动播放、重选设备或清除尚未确认的写入风险。会话变更、资源交接、退休和退出期间仍关闭该读取准入。

切换到 Apple 时，旧端点缺失本身不能作为释放证明。只有严格验证的原生探测证据，配合原有的相同会话、完整快照、两次真实 stopped、精确输出范围，以及本应用拥有的后台进程树完整退出，才能完成该恢复路径。坏数据、超时、资源清理失败和未确认退出仍会阻止交接。未知结果始终保留为 unknown，不改成空闲。

## Apple Music 使用官方网页的系统音频路线

本适配器通过 WebView2 承载 Apple 官方网页和公开 MusicKit 控制方法。现有接口没有向本应用交付解码 PCM，也没有本应用拥有的 WASAPI 独占渲染流，因此**不提供 Apple Music USB 真独占、bit-perfect 或自动切换 DAC 采样率**。

能力字段明确返回 `exclusiveOutput:false`、`outputSelection:false`、`pcmAccess:false`；`audioOutput` 描述所实现的系统共享路线。它不是 DAC 的物理测量，实际独占状态和 `actualDacRate` 仍为 `null`。本地输出设置只控制本地 foobar2000，不能作为 Apple 输出证据。若 Windows 已将网页音频送到 USB DAC，可沿该正常系统路线播放；本应用不会暗改全局或逐应用路由。

[Apple MusicKit](https://developer.apple.com/musickit/)提供网页播放与控制。Microsoft 的 [IsMuted](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.ismuted) 和 [IsDocumentPlayingAudio](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.isdocumentplayingaudio) 是网页状态/静音接口，不是 PCM 出口或 DAC 测量。网页报告正在播放且未静音，也不能证明物理设备实际出声。

没有把 loopback 捕获包装成已完成的 Apple 独占：[Microsoft loopback 文档](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)说明受保护内容可能禁止捕获，[进程树捕获样例](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)没有承诺 DRM 音频可读或静音后仍有数据。[WASAPI 独占](https://learn.microsoft.com/en-us/windows/win32/coreaudio/exclusive-mode-streams)还可能抢占同一设备的网页共享流。仅成功占用一个静音独占流，不能证明 Apple 音频经过该流；捕获后重采样也不能称为原始位完美。

[Apple Windows 无损说明](https://support.apple.com/en-us/118295)适用于官方 Apple Music Windows 应用，可配合外接 DAC。该说明不能转移为本 WebView2 适配器支持无损或独占的证据。

## 验证记录

手动保存的诊断还包含有界的本地控制时序：固定操作类型、请求编号、HTTP 状态及进度校验阶段。只记录写入和校验事件，轮询读取不会挤掉关键请求；不记录原始路由、请求内容、文件路径或凭据。日志保留在原有 200 条内存环形缓冲中，只有主动保存诊断才落盘。

本轮源码检查、独立审查、界面前后图、真实设备和播放验证分别保存于本机 `review-evidence/20261108-upgrade/`。可运行目录包的 `BUILD-INFO.json` 记录本次验证与仍未验证项目；源码单测、网页进度回读和真实听音验收分别报告，不能互相替代。
