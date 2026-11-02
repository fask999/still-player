# STILL · 静室

通过独立的 foobar2000/Beefweb 后端播放本地音乐，并提供受能力限制的 Apple 官方网页适配器。当前源码版本为 `1.0.1`。

## 源码检查

需要 Node.js 24 或更新版本，以及 npm。以下命令以干净的 Git 检出为工作目录；本机含历史测试归档的目录请用 `npm test` 限定当前测试。准备依赖后，默认测试使用隔离的模拟数据，不要求音乐库、私有后端、账号、原生编译器或本机历史归档。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run lint
npm test
node --test
npm run build
```

`--ignore-scripts` 用于源码检查，避免安装阶段下载或运行 Electron。`build` 检查语法、资源引用和已审运行时文件的完整性；它不生成可运行目录包。需要启动桌面应用时，应先按 [构建说明](docs/build-and-integration.md) 准备 Electron 和仅供本机使用的私有后端。

ESLint 只启用 `no-unused-vars` 和 `no-console`，不要求统一格式化。配置中逐一列出的 CLI 入口、唯一运行时日志出口 `src/main/runtime-log.js`，以及专门捕获 CLI 输出的测试有明确例外。原生、真实命名管道或网络集成测试须单独显式启用，不属于默认源码检查。

当前测试须首先安装 worker effect guard；开发约定、只读集成计划命令及历史 pipe pin 的适用限制见 [测试说明](docs/testing.md)。

## 仓库边界

Git 保存应用源码、测试、锁文件、必要文档，以及明确白名单中的小型原生运行时和随附许可。依赖、目录包、用户数据、私有 foobar 后端、认证资料、密钥、工具链、大型生成媒体和完整验收归档保留在本机，均被忽略。

未交付的新功能已保存在 `wip/frozen-pre-remediation-20261101` 分支和同名标签；本轮整改从 `baseline/delivered-0bf-source-20261101` 开始，溯源见 [去敏基线摘要](docs/source-baseline-0bf.json)。历史验收数字不代表当前源码的新一轮测试结果。

频谱组件继续按固定交付清单和精确四文件事务安装，参见 [迁移说明](docs/spectrum-install.md)。仓库不包含完整私有后端，也不提供该后端的公开再分发授权。保留 `native/apple-host/bin/` 与 `native/foobar-spectrum/package/` 中的全部许可文件；背景图来源见 [素材记录](docs/asset-provenance.json)。

私有后端基线集中在 `manifests/backend-baselines.json`。`node scripts/promote-backend-baseline.js` 默认只校验；显式候选始终为未批准状态，正式基线须经代码审查更新。命令与适用范围见 [基线维护说明](docs/backend-baselines.md)。

输出策略数据和后端 launcher 使用独立的固定路径原始资产清单，构建与打包都会校验，见 [运行时资产说明](docs/runtime-assets.md)。

频谱当前 client 的源码 pin 使用 [独立修订记录](docs/spectrum-client-revision.md)，与保持原样的 native 组件迁移证明分别核验。

恢复副本会跨重启阻止封面 GC；缓存不保证都可重建，归档和关闭条件见 [恢复与缓存说明](docs/recovery-and-cache-safety.md)。

本轮遗留的 library seed stage 已在独立完整备份和闭态核验后清理，后验审查通过；源库与已提交封面保留。该清理不代表本轮执行过真实播放或 GUI 验收。
