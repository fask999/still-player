# 界面预览素材与来源

本目录的图片展示本次功能更新之前的 STILL 实际 renderer 界面布局，不代表新增功能的最终界面。截图中的曲名、艺术家、专辑、播放列表、歌词和八张抽象几何封面均为专门编写或绘制的演示素材；没有附带音频。播放状态和连接状态是静态模拟数据，并非真实播放或设备验收。

截图由隐藏的 Electron offscreen 窗口生成，使用新建的临时配置、模拟只读数据和禁用音频的窗口。渲染时拒绝网络、设备权限、下载和生产 IPC；没有使用账户、用户曲库、真实后端或用户诊断。截图均为 1183 × 628 像素，画面内标注“演示数据 / 非真实播放”。生成前后核对了下列 renderer 文件的 SHA-256 一致性。

| 图片 | 内容 | SHA-256 |
| --- | --- | --- |
| [library.png](library.png) | 本地唱片库 | `2043bacb71f6c490afc17d4c759def25553ba629656a524806d38b4a41ba9c91` |
| [listening.png](listening.png) | 听音与歌词 | `2d01931023eb8321a0ca77d9c7d301da3dff3d398f646cb937d1fad2bfdacd54` |

## 渲染源码快照

路径相对于 `src/renderer/`。环境背景图的原始来源记录见 [素材记录](../asset-provenance.json)。

| 文件 | SHA-256 |
| --- | --- |
| `index.html` | `d3da0c8be9e257b7d8cadb84b0490af6e3caaaee280f7beb91952852801439e8` |
| `styles.css` | `6d06c2561b72f0b1ed73da82f11ff94c872057b2d6d50d4bf34fd7f1abf5bf51` |
| `room.css` | `a70ef089d4900af03b4502ea87e0fdbc52f9cbea0781b89ff3158e04ca1f2be4` |
| `timeline.js` | `d4c695ab7ab9e4d5c5d6a8e72a99b3a1a4ceb7040643800f3b9ac68bf2b01ff7` |
| `library-state.js` | `2b997474814883f03ee58b1dfa57dea3bf9c370a5f057861cdcd2cb18358a449` |
| `glass.js` | `db21aa665634bd93d83bca4d634e56c29f092ec78d0b0ff80a83cdd2bcf6118f` |
| `app.js` | `c08337b7e4cf8fca43b171276be49bd47e13a378c119e6a1834b1bb8a0c89ffe` |
| `features.js` | `d48938ed1c4eb7a6da37fed905e5c742066e596e1eef64dfb888072df5076fe8` |
| `bootstrap.js` | `7de7776e6ccad3dc611c2af272365171c8ceb29e19e794a6bd92caff7020fd99` |
| `backend-setup.js` | `73701d83b0dc5fc4f534eaa6a604081ebaf25c58422a35a2ae201bdd98b2970b` |
| `assets/moonlit-lake-v1.png` | `322ec904c52069c49cfdc347ce5ef244f4aa3f5ed757e416ebe0f5f6c7bd41e7` |
