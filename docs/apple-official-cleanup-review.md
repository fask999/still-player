# 播放验证失败后的音频清理复核

日期：2026-10-30。范围仅为 `src/main/apple-official-web.js`、Apple fixture 与交接文档；没有改本地播放器、打包或界面，没有启动真实网页、认证或音频。

独立复核的 synthetic repro 指出：原生 play 已返回并解除静音，SDK 进度随后冻结时，`official-track-unconfirmed` 的 catch 只撤销逻辑授权并 cancel；此时没有未完成 RPC，cancel 不会静音。SDK 仍 playing、真实 mute=false，但旧映射误报 muted。原证据保存在 [review 记录](../review-evidence/supervisor-apple-verification-failure-audio-repro-20261030.txt)。

本次修复：

- play/resume 派发前记录具体 native session；失败后明确 `closeSession` 并等待 browser/helper 退出。逻辑 cancel 不再代替物理清理。
- 清理期间和缺退出证据时保留 sticky `audioReleaseUnverified`，禁新播放；有潜在孤立音频时，单个本地端点验证不能豁免浏览器退出证据。
- 音频状态只依据真实 SDK 与 native `outputMuted`。撤销 `authorizedAudio` 只影响控制归属，不改变物理状态；失败后仍 audible 就报告 playing/audible+error，读不到或宿主失联则 unknown/null+mayBeAudible+error。账号授权消失也不能隐藏仍然发声的引擎。
- 独立 audio-attempt epoch 与 native session 句柄防止旧失败撤销新播放、旧 close 关闭新宿主。新操作等待清理屏障，之后重新检查 epoch 与资源状态。

新增 5 项有实际断言的 synthetic 回归：冻结进度后的真实 close 调用；cleanup fail 后 SDK 仍 playing/unmuted 的真实映射与协调器拒绝启动 local；helper-only 退出后的 unknown 音频；不依赖 coordinator generation 的旧请求迟到失败与较新播放；旧 native session handle 对新宿主无效。

检查：Apple **21/21 pass、0 skip**，完整 [fixture 日志](evidence/apple-official-cleanup-tests-20261030.log)；source build passed。原生 C# 和七个二进制资源未改，既有无登录 native smoke 仍作为其既有证据，不声称本次做过真实登录或全曲验证。

## 2026-10-31：已成功播放后的会话失联与正常退出

独立复核补充发现，旧清理只覆盖 play/resume 验证失败。若先成功回读播放，随后 helper 失联或状态读取失败，旧实现会退回 unavailable，且正常 `close()` 忽略浏览器/宿主退出证明。`releaseOutput()` 还可能用单个端点探测豁免仍可能发声的浏览器。四项修复前的 synthetic 回归均失败，见 [当日复现](../review-evidence/finish-delivery-20261031/apple-lifecycle-before-fix.log)。

现在从实际 play/resume dispatch 开始，记录该 session 的持续音频风险；逻辑取消、暂停、停止和状态恢复均不能自行消除该风险。仅该 session 的 `browserProcessExited=true` 和 `helperExited=true` 同时成立，才清除风险。宿主失联或状态读错保留 sticky `audioReleaseUnverified`：能读到时保留实际 playing/audible 加错误，读不到时为 unknown/null/mayBeAudible。风险未清前不能重新打开会话、新播放或以单端点证明交给另一引擎。

`close()` 在缺双退出证明时 reject `official-audio-cleanup-unverified`，不提前将服务永久设成 closed；后续有真实证明的关闭可以重试并完成。退出调用链必须保留这个 reject，不能显示正常退出成功。`cancelPending()` 若确实销毁未完成的开始操作，会接收其双退出证明；已成功播放后的普通 cancel 不会伪造此证明。

另补充两个交叉回归：背景 `getState()` 若在 play/resume 验证期间失败，即使后续目标和进度读取恢复，也不能升级成成功；必须进入该次 dispatch 的会话关闭与双退出核验。修复前 play 会错误成功，见 [交叉复现](../review-evidence/finish-delivery-20261031/apple-background-read-before-fix.log)。

当日 Apple 测试 **28/28 pass、0 skip**，含原 21 项和上述新增 7 项：[最终日志](../review-evidence/finish-delivery-20261031/apple-tests-final.log)。官方 SDK 重编译与 source build 通过；重编译产物仅运行 `--protocol-self-test` 的纯 synthetic 分支，该分支在 Form/WebView 初始化前返回。没有正常启动 host、打开 Apple 网页、认证、播放音频或接触用户 profile；真实订阅全曲及播放中跨引擎切换仍未验证。运行时七个 native/bin 文件未修改。
