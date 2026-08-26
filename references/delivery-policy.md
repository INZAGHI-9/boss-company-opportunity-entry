# 交付位置预设

报告位置按以下顺序确定：

1. 用户传入 `output_dir` 时使用该目录；不可写时说明原因并继续下一条。
2. 当前 Agent 有可写工作区时，使用 `reports/boss-company-opportunity-entry/{company_slug}-{snapshot_date}/`。
3. 无可写工作区时，直接在对话中交付，不猜测本机文件夹。

每次生成使用独立、自包含目录。目录只交付一份 `opportunity-entry-report.md`，另附 `analysis-input.json`、`evidence-map.json`、`manifest.json` 作为审计附件。`manifest.json` 只记录同目录内的相对路径、快照状态和有效 ISO `generatedAt`，其 `files` 必须列出这四个文件。不要创建“最新”别名、软链接或依赖用户目录缓存。
