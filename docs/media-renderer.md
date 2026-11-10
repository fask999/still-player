# 媒体渲染层

听音歌词栏提供 -100 / +100 毫秒和重置。偏移正值使高亮延后，沿用真实时间戳与现有时间轴；即时更新后按曲目串行保存 `lyrics:offset`。失败恢复最近确认值。各曲的偏移版本保护正在进行的解析、导入、绑定和解绑，避免旧响应覆盖新值。无可用歌词时控件不可用。

歌词搜索对话框显式选择 LRCLIB 或 QQ 音乐，并把完整候选原样传给 preview / bind；搜索关闭或来源不可用时显示服务返回的状态。QQ 搜索候选尚未读取正文时类型显示“待预览”，不推断时间轴。

本地 Track 的 `coverThumbnailUrl` 优先用于行与底栏，`coverLargeUrl` 优先用于专辑卡片、详情与听音大封面；缺失时回退 `coverUrl`。封面依赖按尺寸读取最新库快照，增量更新与释放后的恢复复用现有绑定和图片池。

设置模块可调用 `features.registerSettingsSection(id, render)`。`id` 必须唯一；`render({app, current})` 同步返回 DOM 节点，`current()` 判断所属对话框是否仍然有效。区块异常被隔离并显示不可用提示；每次打开设置都重新构建。样式文件 `media-enhancements.css` 需在 renderer HTML 中加载。

`tests/renderer-media.test.js` 使用纯 Node DOM fixture，不启动 Electron、浏览器或真实音频。它验证 UI 状态、IPC 负载、快速操作、失败与异步竞态，并不证明真实窗口的视觉布局或设备行为。
