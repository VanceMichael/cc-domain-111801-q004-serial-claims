# SerialClaims

SerialClaims 为业务资料员提供序列区间目录领取与原文保管，已支持来源目录预览、直接记录领取、核销与可转移状态、受益人收件边界、整证数量冲突以及按业务范围形成收件记录。原文与领域收件结论分开保存，便于复查来源内容。

登记机构按序列范围发布转移和核销后，同一证书的总证与拆分证明可在目录中共存，一个声明可横跨几段不连续序列。`contractStatus` 按合同涉及的范围给出当前情况：已获依据的序列（重叠声明不累计成额外电量，首尾相接的序列不并段）、不同受益人重叠声明的争议（保留双方原文，不以后到者覆盖）、冲正后的归属（部分冲正不影响其余有效段）、目录已列而原件尚未开放的待领缺口与缺口。`contractHistory` 回答历史上何时取得过哪些声明，收据与原文只增不删。本服务不代企业交易或核销。

## 环境与运行

使用 Node.js 22.23.4，依赖版本由 `package-lock.json` 固定。仅使用 Node.js 内置模块，无需外部数据库进程或第三方运行服务。

```sh
npm ci
npm run build
npm test
npm run demo
npm run demo:ranges
```

`npm run demo` 在本机启动合作源，用独立临时目录完成真实领取、原文保存和领域接收，输出实际结果后清理；不要求外网资料。`npm run demo:ranges` 演示总证与拆分证明共存的序列场景：部分冲正、受益人争议、待领原件开放后的补领，以及合同当前情况与历史取得记录。`npm start` 可单独启动本地来源供交互查看，终端会打印实际回环地址，Ctrl-C 关闭。通过 `PORT` 指定监听端口，省略或设置为 `0` 时自动分配；仅监听回环地址。根路径返回可用资源目录与运行状态。

## 容器

```sh
docker build -t serial-claims:local .
docker run --rm --network none serial-claims:local
```

镜像构建时准备依赖，容器运行时不联网，演示只使用回环通信。可改用 `docker run --rm --network none serial-claims:local npm test` 运行回归。存储通过 `Archive` 传入本机目录，不包含生产账号、真实业务资料或凭据。

## 代码与来源约定

`src/source.mjs` 负责来源目录与原文身份，`src/interpret.mjs` 解释当前领域记录，`src/receiving.mjs` 决定选定范围内的收件结果，`src/ranges.mjs` 提供序列区间数学，`src/contract.mjs` 把收据折叠成合同视图与历史。`src/archive.mjs` 提供原文保管及收据落库，`src/app.mjs` 连接日常业务，`fixtures/` 与 `src/fixture-source.mjs` 提供可独立复查的本地合作源。详细字段与来源声明见 `docs/source-contract.md`。
