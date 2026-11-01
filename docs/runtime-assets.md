# 运行时原始资产清单

`src/main/runtime-assets.json` 集中记录两项固定资产的原始 SHA256：

- `src/main/backend-output-policy.json`：原 DX1 WASAPI 输出策略数据，保持已有端点、48 kHz / 32 bit / 2 channel 验证格式与 owned-exit 语义。
- `native/backend-job/StillBackendLauncher.exe`：仅供受控私有后端生命周期使用的 launcher。

清单只允许这两个固定相对路径。构建首先校验清单及实际文件的原始字节哈希，末尾再次核对；缺项或漂移会失败。策略的字段、端点及输出授权语义仍由运行时严格 loader 检查。文件哈希相符不代表新增输出类型已获支持，未知和 ASIO 输出仍须拒绝。

打包仅复制唯一 launcher 文件，不递归复制 native、编译器、cache 或 tools。policy 与清单随源码复制；源与包内三项哈希须相同，并进入 `sourceFrozenSnapshot` / `BUILD-INFO.json`。这些检查不执行 launcher，也不读取私有后端或用户 profile。

## 只读校验与待审候选

```sh
node scripts/promote-runtime-assets.js
```

默认仅完整校验。需要更新某项受审资产时，使用当前清单原始字节 SHA 生成候选：

```sh
node scripts/promote-runtime-assets.js --asset policy --expected-current-sha256 <registrySha256> --output review-evidence/runtime-candidate.json
```

`--asset` 也可选 `launcher`；`--output` 可省略，此时仅输出候选。工具仅读取选定资产的固定位置，拒绝已有输出、越界路径、链接和陈旧的清单 SHA，不接受任意输入文件或命令。候选始终是 `approved: false`，不会修改正式清单、policy 或 launcher。

policy 语义、launcher 源码和编译产物须先完成各自审查，再通过代码审查更新正式清单。候选本身只提供原始资产信息；安装器、构建与打包不会把它当作批准，也不会自动刷新任何其他交付清单 pin。
