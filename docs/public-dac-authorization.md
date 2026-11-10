# USB DAC 授权

在音频设置中选中当前连接的 USB DAC，选择授权范围、操作和 48 kHz 双声道 PCM 验证格式，然后在 STILL 的确认窗口中审阅。独占格式检查会按所选格式短暂申请音频流并释放。交接退出授权允许 STILL 在既有条件满足时正常关闭自己的播放内核。

两种范围均绑定所选端点。授权保存 30 天，可在同一设置区块撤销。

| 范围 | 核对依据 |
| --- | --- |
| USB 硬件实例 | Windows 在物理 USB 节点报告系统范围内唯一的实例身份，且当前端点可核验。 |
| 此 Windows 端点 | 本机当前端点、Windows USB 音频类驱动、USB 父链和连接位置，以及端点和 USB 节点的到达记录。Windows 报告换口、新端点或重新枚举后需要再次确认。 |

Windows 端点授权的识别范围以 Windows 报告的连接记录为限。若 Windows 无法区分同型号设备的替换，此范围也无法区分。端点、身份、内核或组件版本变化后，请按当前输出重新确认。[Windows 实例标识](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/instance-ids)、[设备位置路径](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/devpkey-device-locationpaths)

## 主进程接入

主进程创建一个 `createDacAuthorizationService`，注入可信的 `readCurrent`、`getCurrent`、`isVerifiedSession` 和 `confirmUser`。`readCurrent({signal})` 从当前自有内核读取已选输出，`getCurrent()` 同步返回当前会话对象、播放 generation、选中输出 epoch、输出元组及版本范围。版本范围包含 `backendId`、实际会话的 `executableSha256` 对应的 `coreSha256`、已审组件清单的 `componentsSha256`、固定的 `probeSha256` 和 `providerPolicyVersion`。接入方只为已审内置 WASAPI 提供者提供该范围。

`createDacIdentityReader({probePath})` 使用 `DAC_IDENTITY_PROBE_SHA256` 核验随包探针。主进程用自己的安装目录构造路径，传入 `readIdentity({endpointId, scope, signal})`。探针核对活动渲染端点、端点 GUID、属性存储和现存 PnP 父链。端点实例属性为空时，Windows 必须读回同一容器的实际 AudioEndpoint 节点和该节点唯一的活动渲染接口。Windows 端点范围还要求两次独立枚举和完整 PnP 读回一致。每种范围生成独立摘要和内存证明。[Core Audio 属性](https://learn.microsoft.com/en-us/windows/win32/coreaudio/device-properties)、[端点 GUID](https://learn.microsoft.com/en-us/windows/win32/coreaudio/pkey-audioendpoint-guid)、[设备接口枚举](https://learn.microsoft.com/en-us/windows/win32/api/cfgmgr32/nf-cfgmgr32-cm_get_device_interface_listw)、[PnP 父节点](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/determining-the-parent-of-a-device)、[Windows USB 音频类驱动](https://learn.microsoft.com/en-us/windows-hardware/drivers/usbcon/supported-usb-classes)

`createDacAuthorizationStore({dataDir, seal, unseal})` 接受主进程提供的封存函数。`seal` 将 UTF-8 文本封存为 `Buffer`，`unseal` 返回 UTF-8 文本。Windows 接入可检查 Electron `safeStorage` 加密能力后绑定 `encryptString` 和 `decryptString`。封存或校验失败时停用保存。服务通过封存文件持有元组、身份摘要和版本，renderer 只接收确认令牌、操作、格式、到期时间和随机授权编号。

主进程从受信 IPC 事件构造 `{sender, windowGeneration}`。`prepare({scope, capabilities, validationFormat}, caller)` 接受 `hardware-instance` 或 `windows-endpoint`，读取该范围的身份并签发 90 秒单次令牌。`confirm` 消耗令牌、显示所选范围、重新读回该范围的身份和选中输出，并在提交封存前核对上下文。主进程在窗口失效、选择变更和会话退休时调用 `invalidate()`。同一精确端点与版本重新确认后，以本次确认的范围、能力和格式替换原授权。

`issueUsePermit` 先定位当前端点的唯一授权，再重读该条授权的范围，签发绑定真实会话对象和操作上下文的 10 秒凭证。`consumeUsePermit` 只接受原凭证对象一次，返回范围与 `checkCurrent()`。在原资源派发门最后检查 `checkCurrent()`。退出仍由现有 stopped、释放、进程及完整 Job 树证明裁决。身份检查不调用音频客户端，实际独占检查走原受限路径。

设置区块通过 `STILLDacAuthorization.createModule({app}).render({current})` 装配，使用 `dac:list`、`dac:prepare`、`dac:confirm` 和 `dac:revoke`。主进程拥有确认窗口、选中输出和封存能力。
