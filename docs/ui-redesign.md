# STILL 界面重构 · 2026-10-30

界面重构围绕真实音乐内容展开：炭灰背景、暖白文字与少量琥珀提示；保留最左侧本地 / Apple 双来源轨道，缩小导航和标题所占空间，让曲目与封面提前进入首屏。

## 最终布局

- 标准窗口采用 54 px 来源轨道、154 px 导航、52 px 顶栏和 84 px 底栏。较短窗口将底栏收至 76 px，曲目行保持 49 px；正常曲目行 52 px。主要曲名 12 px，保留真实封面与独立艺术家、专辑、时长列。
- 移除重复的英文眉题、大段引导文案和重色导航块。导入操作使用暖白轻按钮，琥珀仅用于选中来源、图标与当前歌词。
- 专辑使用自适应封面网格；艺术家采用双列列表，图像仍来自对应的真实专辑，不制造艺术家照片。专辑、艺术家、播放列表详情展示实际封面与元数据。
- 沉浸歌词将封面固定在左侧，右侧留给逐行或逐词原文及译文；轻微进入、悬停、颜色过渡尊重系统与应用内减少动效设置。
- 窄窗口保留双来源、曲目操作、播放器；更窄时艺术家移到曲名下方，避免挤占曲名。底栏只根据 player.source 标注播放来源。

## 保留的行为

库、专辑、艺术家、播放列表、搜索、导入、排序、管理、临时队列、音频设置与播放器控制继续使用原 IPC。没有增加渲染进程音频引擎。歌词时间轴、正负偏移、点击定位、暂停冻结、双语开关、全文译文、候选预览 / 绑定 / 导入、缓存与错误状态，以及快切请求隔离均保留。

Apple 官方会话按 provider 与 capabilities 门控；官方路径不呈现 Cider / 开发者凭据配置引导。新增官方会话未打开、已登录待验证、需要用户操作三种状态文案，动作文字来自真实 descriptor.actionLabel。main 尚未提供 Apple 专用队列读取通道，因此未把本地队列伪装成 Apple 队列。

## 实际验证

执行 `node --test tests/renderer-shell.test.js tests/renderer-timeline.test.js`：49 项通过，0 失败。覆盖原 45 项及测试歌词双处标记、紧凑艺术家详情、进度轨道读回与预览、官方会话门控。

执行 `node scripts/build.js`：全应用 JS 语法与资源完整性检查通过。本机 PATH 无 npm，因此直接执行 package.json 中 build 对应的原脚本。未自行启动 STILL、foobar、音频输出或真实播放；只读桌面 smoke 由 desktop owner 执行。

实际截图位于 [desktop-smoke-astra-20261030-c](../tests/desktop-smoke-astra-20261030-c/desktop-smoke.json)，已逐张目视：

| 视图 | 证据 | 结果 |
| --- | --- | --- |
| 曲目库 | [01-library.png](../tests/desktop-smoke-astra-20261030-c/01-library.png) | 1173×601 / DPR 3.25，按行边界测得 6 完整行 |
| 专辑 | [02-albums.png](../tests/desktop-smoke-astra-20261030-c/02-albums.png) | 5 列真实封面，首屏可见下一排 |
| 艺术家 | [03-artists.png](../tests/desktop-smoke-astra-20261030-c/03-artists.png) | 双列名称与真实封面，非伪造人物照片 |
| 设置 | [04-settings.png](../tests/desktop-smoke-astra-20261030-c/04-settings.png) | 单滚动区域，诊断折叠，控件可见 |
| 沉浸歌词 | [05-lyrics-fixture.png](../tests/desktop-smoke-astra-20261030-c/05-lyrics-fixture.png) | 双语、逐词局部高亮、封面与文本构图；可见测试标签 |
| 窄窗口 | [06-narrow.png](../tests/desktop-smoke-astra-20261030-c/06-narrow.png) | 972×653 / DPR 3.25，7 完整行 |

该轮 smoke 使用真实 217 首库与 12 个列表；没有横向溢出、失效图片或 console diagnostics。歌词与暂停播放器为明确标记的只读测试 fixture，报告 simulatedUIFixture=true，actualPlayer 是真实 offline 状态。截图不构成真实匹配歌词、真实播放、Apple 订阅全曲、DAC 或独占输出验收。目标 1280×800 未在本机实际屏幕上捕获；较短的真实 1173×601 窗口已通过 6 行底线。

目视后修正了 Apple 官方会话被误显示为“未知”的文案；不影响上述布局截图。最终包与官方会话状态复拍由 desktop owner 提供。
