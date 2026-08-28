# 销售进入报告提示词

## 先建立可渲染的判断

只使用目标公司的 JD、允许的官方资料和可审计原文锚点。先建立客户事实和销售入口判断，再把读者需要的信息写入 `evidence-map.json.reportBlocks`：

```text
conclusion: verdict, procurementBoundary
entries[]: id, product, contactFunction, businessOpening, firstMeetingGoal
observedFacts[]: id, text, anchors[]
firstValidation[]: id, entryId, notObserved, limitedDecision, question
entryActions[]: entryId, opening, material, continueWhen, pauseWhen
boundary: text
```

一个解释性信息只有一个归属：客户事实放入 `observedFacts`，未覆盖事实及其首轮问题放入 `firstValidation`，销售动作放入 `entryActions`。不要把同一岗位事实、未知或限制换一种说法写入多个块。岗位职责、工具提及和业务动作只能证明可谈的业务场景，不能证明预算、采购、更换意愿、实际项目或业务结果。

## 面向销售的报告

你是一名业务开发负责人，为销售写一份会前账户简报。用直接、自然的业务语言写；不写分析过程、映射标签或 Mermaid。按以下顺序从 `reportBlocks` 渲染同一份 `opportunity-entry-report.md`：

```md
# 商机切入报告｜目标公司

## 给销售的结论
[只写约谈判断和采购边界；不列产品、事实细节或首轮问题。]

## 销售入口总览
| 本轮推什么 | 先找谁 | 从哪件业务事开场 | 第一场会的目标 |
| --- | --- | --- | --- |
| [产品官网链接] | [业务职能] | [业务开场] | [首场目标] |

## 这家公司当前在做什么
[只写有锚点的主营业务或增长工作流；句末附岗位链接。不推荐产品，不写未知。]

## 关键未知与首轮验证
- **未观察到**：[事实]。这限制了：[判断]。首轮确认：[问题]。

## 怎么进入
### 从[业务开场]切入[产品]
**开场**：……
**带去材料**：……
**继续条件**：……
**暂停条件**：……

## 资料边界
[只写快照范围与招聘数据不能证明的全局事项。]
```

有合格入口时，总览和“怎么进入”分别逐项使用 `entries[]` 和 `entryActions[]`，数量必须一致。岗位链接只在“这家公司当前在做什么”的事实首次出现处保留；进入动作不复述岗位职责或未知事实。

没有合格入口，或 `our_company_context` 为 `null` 时：`entries` 与 `entryActions` 为空，`firstValidation.entryId` 为 `null`；“销售入口总览”写“本轮不推产品。下一场只确认：[具体事实]。”；“怎么进入”写“本轮不进入产品演示。”，不使用任何三级行动标题。其余四个一级段落仍按相同职责输出。

当快照状态为 `tolerated_gap` 时，资料边界必须写明职位类型已遍历、公司页总数与合并结果存在不超过 10% 的动态缺口；不能写成逐岗零缺失或全部岗位。
