---
name: boss-company-opportunity-entry
description: Use when assessing a potential customer from its public Boss jobs, collecting the company snapshot and producing an evidence-bounded sales-entry report in one workflow. Do not use for business or talent strategy reports.
---

# 客户商机切入判断

输入公司名称后，先采集目标公司的当前可见 Boss 岗位与完整 JD，再转为一份自包含的销售进入报告。报告让销售看懂“是否值得约谈、推什么、先找谁、从什么业务事开场、首场会要拿到什么”；每个事实、未知和行动只在一个读者段落解释一次。证据账保留在审计附件中，不把分析工作表直接交给销售读者。不生成业务战略或人才战略报告。

## 输入与采集

需要 `target_company`，可选 `our_company_context` 与 `output_dir`。未传入我方上下文时读取 [默认上下文](references/default-our-company-context.yaml)；显式传入 `null` 时仍在同一份报告中生成客户已观察业务与关键未知，但不做我方产品映射。

本技能已内置采集器，采集时只使用本目录的 `scripts/collector/boss-company-scout.mjs` 及其相对导入模块；不得调用、安装或引用其他采集技能、工作区临时脚本或外部绝对路径。运行环境仍需要 Node.js、普通 Chrome，以及用户在本技能专用 Chrome 中完成 Boss 登录；登录、验证码和安全验证必须由用户处理，不能复制 Cookie、读取密码或绕过验证。

## 一次完整运行

先读取 [采集合同](references/collection-contract.md)，然后在不要求用户另行运行采集工具的前提下完成以下顺序：

1. 使用本技能内置脚本执行 `--check-login`；未登录时执行 `--login-only`，暂停等待用户完成登录并明确确认，再继续检查。
2. 以 `--company <target_company>` 直接搜索候选主体，并按公司名匹配度、公开岗位卡数量和稳定排序自动选择 `brandId`；保存全部候选、选择依据和置信度。只有调用方已明确指定主体时才传入 `--brand-id` 覆盖自动选择；低置信度继续采集并在报告数据校准处提示。
3. 在同一次正式运行中完成公司页岗位列表、完整 JD、断点和标准 `analysis-input.json`。先动态读取页面的职位类型，排除“全部”后逐类遍历并按岗位 ID 合并；标签名称和数量不得写死。每类使用真实末页和固定 3 个可复用工作页；新运行必须重新读取所有岗位列表页，不能复用上一轮的页码缓存；已完成 JD 可从断点复用。Windows 可使用 `--background` 最小化正常 Chrome。岗位详情以点击卡片后右侧已渲染的 JD 为准，不等待详情接口回包。页面出现“访问受限”“账户存在异常行为”“限制访问”、安全验证或登录失效时，立即保留断点与页面并暂停；不得重试、刷新或继续等待，待用户在前台恢复后用同一命令续跑。若采集进程仍在运行但 30 秒内断点数量或更新时间没有变化，主动检查专用 Chrome 页面；发现上述状态同样立即暂停。岗位卡片动态消失时，同页其余岗位必须继续读取；完成单页续采后只允许刷新岗位列表一次。若刷新后仍不可读的岗位使总动态缺口不超过 10%，从快照中剔除并生成 `tolerated_gap`，记录标签级缺口；超过则只交付部分快照，不循环刷新页面。
4. 将本次 `analysis-input.json` 复制至本次报告目录，并只用其中完整 JD 与允许的目标公司官方资料建立证据账。若快照为 `partial` 或 `tolerated_gap`，报告必须保留其限制，不能声称逐岗零缺失或覆盖全部岗位。
5. 生成本技能固定的报告和审计附件，并执行本技能的交付校验。

采集产生的专用 Chrome 登录档案和断点默认保存在 `~/.codex/boss-company-opportunity-entry/`；可用 `BOSS_OPPORTUNITY_ENTRY_HOME` 改为其他可写目录。它们是本技能的运行数据，不依赖项目工作区或其他技能。

## 判断顺序

读取 [执行指引](references/agent-guide.md)、[商机提示词](references/opportunity-prompts.md) 和[交付合同](references/delivery-contract.md)。从本次采集的全量 JD 与允许的目标公司官方资料建立证据账，再在内部形成每个候选入口的客户业务事实、可选产品、首个业务角色、首场会目标、推进条件、止步条件和来源锚点。完成判断后先建立 `evidence-map.json.reportBlocks`，再按固定读者段落生成报告；不得从同一事实重复写出结论、事实说明和进入叙事。

只有同时满足以下三项时，才能把一个产品放入报告的销售入口：

1. 目标公司存在可追溯的具体业务动作或决策场景。
2. `our_company_context` 中的一个命名产品能为该场景提供具体的决策材料或工作输入。
3. 招聘信息能支持建议优先接触的业务职能或岗位类型。

不按职位标题、行业印象或工具提及直接选产品；一个公司可有零个、一个或多个销售入口，不设固定数量。缺少任一项时，在报告中写“本轮不推产品”和还需确认的事实。不得用我方产品反推客户业务，不得把岗位招聘写成采购意向。

## 交付

读取 [交付位置预设](references/delivery-policy.md)。先在对话中呈现一份自包含报告，再写入可用目录：

- `opportunity-entry-report.md`
- `analysis-input.json`
- `evidence-map.json`
- `manifest.json`

商机报告固定依次写“给销售的结论”“销售入口总览”“这家公司当前在做什么”“关键未知与首轮验证”“怎么进入”“资料边界”。目标公司判断在自然句末附可跳转岗位链接，我方产品附官网链接。不要输出 Mermaid 思维导图、客户业务底稿、我方业务匹配诊断或相关性/需求证据等分析字段。交付前运行 `node scripts/validate-delivery.mjs --dir <报告目录>`；无法写入目录时，直接交付并说明未运行目录校验。
