# 离线默认测试与显式集成

安装锁定依赖后，`npm test` 仅运行当前 `tests/*.test.js` 和 `tests/*.test.cjs`。干净源码检出也应能直接运行 `node --test`。本机保留的历史归档可能包含旧测试，Git 的忽略规则不控制 Node 的测试发现，因此在包含这些归档的工作目录使用 `npm test` 限定当前测试。

每个测试文件须在任何业务、进程或网络模块导入之前安装 guard：

```js
'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
```

guard 只在 Node 测试 worker 中拦截真实子进程、进程终止和网络 API，包括 loopback、DNS、fetch 与 WebSocket；正常父 runner 可以创建测试 worker。注入的 fake 仍可使用。默认测试不得编译原生代码、查询编译器、执行 helper、连接真实管道或访问网络，也不依赖本机历史 evidence。

普通 CLI 使用 `run-integration.js` 这类非测试文件名；`test-*.js` 会进入 Node 的默认测试发现，不能用于带直接执行入口的辅助工具。

## 显式集成入口

以下命令仅显示计划，不执行集成：

```sh
npm run test:integration -- --suite apple-host-protocol
```

四个原生 suite 为 `apple-host-protocol`、`spectrum-reader-protocol`、`spectrum-dsp-native` 和 `spectrum-pipe`。另有 `spectrum-sdk-source`，仅审计本机已准备的 SDK 构建输入；该 suite 的 worker guard 始终启用。只有额外指定 `--execute` 才启动当前 Node 的单一固定测试文件；入口设置 `STILL_TEST_INTEGRATION=1` 和精确的 `STILL_TEST_INTEGRATION_SUITE`。其他测试 worker 的 guard 不会因此关闭。CI 不传这些参数或标记。

本轮整改没有执行真实 native、编译器、reader 或 pipe 集成。历史 pipe 的 compiled manifest 包含旧测试源码哈希；必要的测试隔离修改使该 pin 失配，仍会拒绝执行。须重新完成原 artifact 审查流程后才能恢复真实集成，不能仅改哈希来借用历史认可。
