# 频谱 client 的独立源码修订

`native/foobar-spectrum/delivery-manifest.json` 继续保留原始 SHA256 `284dae8ad48b96a464c635d8e848bc20d1699dfa74948987f8765d4ac94a131f`。其 DLL、reader、许可文件及已安装后端的迁移来源证明没有变化；这次 client 自愈/冷却整改不要求重新迁移私有后端。

当前受审 client 由 `manifests/spectrum-client-revision.json` 单独记录：固定模块路径、字节数、原始 SHA256、原 native manifest SHA、原 client SHA 和受审摘要的 `proofHash`。该 record 自身的原始 SHA 也由源码 verifier 固定；不能通过同时修改 client 和 JSON 来自动接纳新代码。构建不要求本机完整 review evidence，record 中的 proof 是去敏的审查索引。

新 client 缺 record、record 字节变化、源码变化或兼容锚不匹配都会失败。唯一 legacy 分支是精确的原 `20573` 字节 client，SHA256 为 `b7967d3723ab742b9f426a8ae0d00024616d04f2849bd1a2bf30a50b5da7b652`；它可按原 native 清单验证，不构成未知源码的 fallback。

打包只额外复制这一份 record，不递归复制 `manifests/`。`BUILD-INFO.json` 和 `sourceFrozenSnapshot` 记录实际使用的当前 client、record SHA 与审查摘要，不能用历史 client 锚冒充当前源码。完成阶段会再次同步核对源与包内的 client/record，再移除不完整标记。

回滚继续使用原来的完整 verifier。若当前源码或 revision record 损坏，先恢复受审源码再执行旧事务恢复；本轮没有新增放宽校验的 native-only recovery 路径。
