# 私有后端基线维护

`manifests/backend-baselines.json` 是打包脚本与频谱安装器共用的受审基线。它仅保存 source/target 的原始清单 SHA256、原有 canonical SHA256、后端 ID 和固定相对目标位置，不包含私有 profile、音乐目录、认证资料或开发机绝对路径。构建只校验该 JSON，不读取实际后端。

相对路径不改变既有哈希语义：canonical SHA256 仍按原清单的 `JSON.stringify` 结果计算，原清单的本机 metadata 也在其内。新机器上重新组装的后端必须单独审查，不能把路径改写视为已批准的同一基线。

## 默认校验

在项目根运行：

```sh
node scripts/promote-backend-baseline.js
```

该命令只读取正式 JSON，输出其 `policySha256`，不读取实际后端，不创建文件。

## 生成待审候选

准备显式保存于项目 `review-evidence/` 下的、频谱组件迁移之前的私有清单快照。工具只检查该 JSON 的结构与固定目的位置；它不遍历后端文件，也不证明实际文件完整性。

```sh
node scripts/promote-backend-baseline.js --backend source --manifest review-evidence/backend-snapshot.json --expected-current-sha256 <policySha256> --output review-evidence/backend-candidate.json
```

`--backend` 也可选 `target`。`--expected-current-sha256` 使用默认校验输出的完整值；正式 JSON 或快照在规划中改变会失败。`--output` 可省略，此时仅输出候选；指定时目标文件必须不存在，父目录须已存在。未知参数、越界路径、链接、已有组件迁移标记与不符合固定目标的快照会被拒绝。

所有候选都带有 `candidateOnly: true` 和 `approved: false`。该工具没有 apply 模式，任何模式都不能写正式 JSON；安装器和打包脚本不会读取候选文件。核对候选、实际文件完整性和回归结果后，通过独立代码审查更新正式 JSON，才形成新基线。完整快照与候选保留在被 Git 忽略的本地证据目录。

交付清单及 client 源码的供应链 SHA、运行时与组件固定白名单、进程停止检查、安装事务与恢复门禁继续独立生效。新安装计划绑定正式 JSON 的精确字节 SHA；已有受审事务的回滚仍使用原计划及备份证据，不要求当前基线 JSON 存在。
