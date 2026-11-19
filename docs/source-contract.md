# SerialClaims 来源约定

此服务管理序列区间目录领取、核销声明解释及合同依据接收。
当前常规业务使用一个选定来源上下文处理直接列出的记录。目录请求为 `GET /registry/certificates`，返回 `registry` 与 `certificates`。每个目录成员以 `id`、`href` 提供来源身份与原文位置，原文中的 `certificate` 和 `registry` 必须与目录一致。

## 目录成员

登记机构按序列范围发布转移和核销后，同一证书的总证与多份拆分证明会作为不同目录成员共存。目录成员可附带提示字段：

```json
{
  "id": "GC200-S1",
  "href": "/registry/certificates/records/GC200-S1",
  "certificate": "GC200",
  "ranges": [[1000, 1099]]
}
```

`certificate` 省略时按 `id` 核对原文身份；`ranges` 提示该成员涉及的序列范围，用于在原件尚未开放时标记合同待领缺口。目录 `id` 不重复，同一 `certificate` 可出现在多个成员中。

## 整证记录含义

```json
{
  "certificate": "GC100",
  "registry": "R1",
  "generation": "GEN-A",
  "quantityMWh": "25",
  "beneficiary": "采购公司",
  "status": "retired"
}
```

这里的字段是来源提供的原始声明，数值文本必须符合十进制规则，不能把空白或未知值转换成零。领域解释保留核销与可转移状态、受益人收件边界、整证数量冲突。只有所选范围内且有充分常规依据的记录列入当前收件；其他范围、待确认、历史和冲突分别保留结果，不用覆盖旧原文消除分歧。

## 序列声明含义

按序列范围发布的原文以 `claims` 给出声明，一个声明可横跨几段不连续序列：

```json
{
  "certificate": "GC200",
  "registry": "R1",
  "claims": [
    { "ranges": [[1000, 1049], [1060, 1079]], "generation": "GEN-A", "beneficiary": "采购公司", "status": "retired", "quantityMWh": "35" },
    { "ranges": [[1040, 1049]], "beneficiary": "采购公司", "status": "reversed" }
  ]
}
```

- `ranges` 为 `[起点, 终点]` 闭区间，端点是非负整数；各段按原文保留，首尾相接的段不并合，因为相邻序列未必属于同一发电批次。
- `status` 为 `retired`（核销）、`transferable`（可转移）或 `reversed`（冲正）。冲正只退回其范围，其余已获核销依据的部分继续有效；冲正声明可不重复 `generation`。
- `quantityMWh` 可省略，出现时必须是正的十进制文本；整证数量与序列声明不能同时出现。
- 序列声明与整证记录重叠时不累计成额外电量：同一序列无论被几份声明覆盖只算一次。

## 本地合作源

`fixtures/source.json` 的 `resources` 是本地来源的 URL 路径到响应正文的映射；只绑定回环地址，不连接真实监管、银行或合作方。原文可通过目录声明的位置取得。同一来源也可发布关联资料，当前示例的关联资料位置为 `/registry/certificates/relations/GC100`，字段保留来源的业务含义：

```json
{
  "ranges": [
    [
      100,
      179
    ],
    [
      180,
      199
    ]
  ],
  "claims": [
    {
      "range": [
        170,
        199
      ],
      "beneficiary": "另一公司"
    }
  ]
}
```

`fixtures/ranges.json` 提供总证与拆分证明共存的序列场景：不连续声明、跨批次相邻段、受益人争议、部分冲正与尚未开放的原件。`fixtureSource` 支持独立实例、指定路径返回码、一次性来源故障、响应延迟与 `replace` 更新资源；访问记录保留实际请求路径，不凭空生成未收到的响应。测试在进程内操作夹具，不提供对外开放的管理接口。目录不承诺所有关联资料与当前目录同时发布；HTTP 404、403、503 不能自行解释为业务删除。

## 原文和收件

原文字节按 SHA-256 寻址，SQLite 保存来源位置、观察时间、收件范围、业务身份、领域记录与决策。收到原文不等于领域接收成功；重复的同一内容不新增收据，同一身份的不同内容不会覆盖原件。`.data/` 仅用于本机数据，演示使用临时目录，运行结束关闭服务并清理临时状态。

## 合同视图与历史

`contractStatus(archive, scope, contract)` 按合同涉及的范围（`{ certificates: [{ certificate, ranges }] }`）给出当前情况：

- `covered`：已获核销依据的序列，按各声明原样列出（不并接相邻段），保留发电批次、原文摘要与取得时间；`coveredSerials` 是合同范围内不同序列的数量，整证未按序列展开时为 `null`，不虚报数目。
- `disputed`：不同有效声明把重叠序列给了不同受益人的争议段，保留双方原文摘要与取得时间，不以最后收到的声明覆盖。
- `reversed`：冲正退回的范围；`awaiting`：已可转移但尚无核销依据的范围。
- `pendingOriginals`：目录已列而原件尚未开放的待领缺口；`missing`：既无有效依据、也非待领、也非冲正退回的缺口。
- `complete` 要求无缺口、无待领、无争议。

`contractHistory(archive, scope)` 回答历史上何时取得过哪些声明。收据与原文只增不删，合同视图由收据计算得出，不为清理当前视图抹掉任何资料。本服务不代企业交易或核销。
