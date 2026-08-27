---
name: boss-company-opportunity-entry
description: Use when assessing a potential customer from its public Boss jobs, collecting the company snapshot and producing an evidence-bounded sales-entry report in one workflow. Do not use for business or talent strategy reports.
---

# 客户商机切入判断

输入公司名称后，先采集目标公司的当前可见 Boss 岗位与完整 JD，再转为一份自包含的商机切入报告。报告按“客户业务底稿 → 我方业务匹配诊断 → 商机切入判断”组织章节；不生成业务战略或人才战略报告。

## 输入与采集

需要 `target_company`，可选 `our_company_context` 与 `output_dir`。未传入我方上下文时读取 [默认上下文](references/default-our-company-context.yaml)；显式传入 `null` 时仍在同一份报告中生成客户业务底稿，但不做我方产品映射。

本技能已内置采集器，采集时只使用本目录的 `scripts/collector/boss-company-scout.mjs` 及其相对导入模块；不得调用、安装或引用其他采集技能、工作区临时脚本或外部绝对路径。运行环境仍需要 Node.js、普通 Chrome，以及用户在本技能专用 Chrome 中完成 Boss 登录；登录、验证码和安全验证必须由用户处理，不能复制 Cookie、读取密码或绕过验证。

## 一次完整运行

先读取 [采集合同](references/collection-contract.md)，然后在不要求用户另行运行采集工具的前提下完成以下顺序：

1. 使用本技能内置脚本执行 `--check-login`；未登录时执行 `--login-only`，暂停等待用户完成登录并明确确认，再继续检查。
2. 以 `--company <target_company>` 直接搜索候选主体，并按公司名匹配度、公开岗位卡数量和稳定排序自动选择 `brandId`；保存全部候选、选择依据和置信度。只有调用方已明确指定主体时才传入 `--brand-id` 覆盖自动选择；低置信度继续采集并在报告数据校准处提示。
3. 在同一次正式运行中完成公司页岗位列表、完整 JD、断点和标准 `analysis-input.json`。采集器会锁定单一运行、读取真实末页，并使用固定 3 个可复用工作页；Windows 可使用 `--background` 最小化正常 Chrome。首次出现安全验证或登录失效时立即保留断点与页面并暂停，待用户在前台恢复后用同一命令续跑；页数上限或数量差额只交付部分快照，不循环刷新页面。
4. 将本次 `analysis-input.json` 复制至本次报告目录，并只用其中完整 JD 与允许的目标公司官方资料建立证据账。若快照为 `partial`，报告必须保留其限制，不能声称覆盖全部岗位。
5. 生成本技能固定的报告和审计附件，并执行本技能的交付校验。

采集产生的专用 Chrome 登录档案和断点默认保存在 `~/.codex/boss-company-opportunity-entry/`；可用 `BOSS_OPPORTUNITY_ENTRY_HOME` 改为其他可写目录。它们是本技能的运行数据，不依赖项目工作区或其他技能。

## 判断顺序

读取 [执行指引](references/agent-guide.md)、[商机提示词](references/opportunity-prompts.md) 和[交付合同](references/delivery-contract.md)。从本次采集的全量 JD 与允许的目标公司官方资料建立证据账，然后：

1. 在 `opportunity-entry-report.md` 的“客户业务底稿”章节，只描述目标公司自身的产品/服务、目标客户、交易或交付路径、可见业务动作和未知项。
2. 在同一报告的“我方业务匹配诊断”章节，基于底稿与 `our_company_context` 诊断匹配依据、错配或缺口及结论。
3. 在同一报告的“商机切入判断”章节，区分相关性证据与需求证据，提出首轮验证路径；不支持进入时写明止步原因和缺口，不生成产品方案映射。

不需要用户额外确认。报告必须自包含客户底稿、匹配诊断和切入/止步结论；不得用我方产品反推客户业务或把岗位招聘写成采购意向。

## 交付

读取 [交付位置预设](references/delivery-policy.md)。先在对话中呈现一份自包含报告，再写入可用目录：

- `opportunity-entry-report.md`
- `analysis-input.json`
- `evidence-map.json`
- `manifest.json`

商机报告以可渲染的 Mermaid 思维导图开始，目标公司判断附可跳转岗位链接，我方产品仅附其官网链接并标注为“我方产品背景”。交付前运行 `node scripts/validate-delivery.mjs --dir <报告目录>`；无法写入目录时，直接交付并说明未运行目录校验。
