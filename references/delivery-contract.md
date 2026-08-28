# 商机切入交付合同

每次生成使用自包含目录，交付一份自包含报告及机器可审计附件：

```text
analysis-input.json
opportunity-entry-report.md
evidence-map.json
manifest.json
```

`evidence-map.json` 保留客户业务事实、岗位或官方来源原文锚点、我方产品关联线索、销售入口判断与证据缺口，并新增面向读者的 `reportBlocks`：

```text
conclusion: verdict, procurementBoundary
entries[]: id, product, contactFunction, businessOpening, firstMeetingGoal
observedFacts[]: id, text, anchors[]
firstValidation[]: id, entryId, notObserved, limitedDecision, question
entryActions[]: entryId, opening, material, continueWhen, pauseWhen
boundary: text
```

每条 `observedFacts` 只写有锚点的客户事实；每条 `firstValidation` 同时说明未观察事实、受限判断和首轮问题；每条 `entryActions` 只写销售行动。`entryId` 必须对应一个入口；当 `entries` 为空时，`firstValidation.entryId` 必须为 `null`，`entryActions` 必须为空。未知只能来自本次允许资料未覆盖的事实，不能被标注为客户痛点、工具缺口、预算或采购意向。

`manifest.json` 记录有效 ISO `generatedAt`、快照状态和同目录相对文件名；`files` 必须包含且仅包含上述一份报告及附件。报告即使止步，也在同一文件中说明止步原因。

`opportunity-entry-report.md` 只能按以下顺序使用 `reportBlocks`：

1. “给销售的结论”只写 `conclusion`。
2. “销售入口总览”只写 `entries` 的产品、建议接触职能、业务开场和首场目标；有入口时使用“本轮推什么、先找谁、从哪件业务事开场、第一场会的目标”四列，无入口时明确写“本轮不推产品”。
3. “这家公司当前在做什么”只写 `observedFacts`，自然句末保留岗位或官方锚点。
4. “关键未知与首轮验证”只写 `firstValidation`。
5. “怎么进入”对每个 `entries` 写一个动作块，只写对应 `entryActions` 的开场、材料、继续条件和暂停条件。
6. “资料边界”只写 `boundary`，包括快照状态与全局证据限制。

不得新增其他读者一级段落。原文锚点保留为自然句末的链接；不得把客户业务底稿、我方业务匹配诊断、相关性证据或需求证据作为读者报告章节。
