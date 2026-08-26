# Boss 岗位采集合同

本合同让不同 Agent、不同浏览器和不同操作系统产出同一份分析输入。采集方法可以不同，输入质量要求相同。

## 允许的方式

使用当前技能目录中的 `scripts/collector/boss-company-scout.mjs` 及其专用 Chrome 会话。不得调用、安装或依赖其他 Boss 采集技能、工作区临时脚本或其他浏览器档案。

不得复制 Cookie、读取账号密码或验证码、伪造设备信息、轮换代理，或绕过 Boss 的安全验证。遇到验证或限制时暂停，等待用户手动恢复。

## 采集顺序

1. 检查已登录状态；未登录时引导用户在专用浏览器会话中登录。
2. 搜索并确认目标公司主体。名称相似时必须根据公司主页、产品、岗位或用户选择区分主体。
3. 从确认主体的公司招聘页读取可见岗位全集和完整 JD。
4. 保留采集状态。失败时只重试受影响页面；无法恢复时交付部分快照，不假称完整。

## 完整性

能确认公司页公布岗位总数时，只有以下条件同时成立才可标为完整快照：

- 分页或页面接口已结束；
- 按岗位唯一标识去重后的数量等于公司页公布总数；
- 每个纳入岗位都有岗位链接和非空 JD。

平台没有提供岗位总数时，记录实际分页结束依据并标为“可见岗位快照”，不要声称全国全部岗位。

## 标准分析输入

分析开始前生成 `analysis-input.json`。字段名可按当前 Agent 的实现调整，但必须包含以下信息：

```json
{
  "company": {
    "name": "目标公司名称",
    "brandId": "平台主体标识或 null",
    "companyUrl": "公司主页链接或 null"
  },
  "snapshot": {
    "collectedAt": "ISO 时间",
    "status": "complete | partial | visible_snapshot",
    "publishedJobCount": 0,
    "deduplicatedJobCount": 0,
    "limitation": "采集限制"
  },
  "jobs": [
    {
      "jobId": "岗位唯一标识",
      "title": "岗位名称",
      "url": "岗位详情链接",
      "location": "城市或地区",
      "salary": "薪资原文或 null",
      "employmentMode": "用工方式或 null",
      "description": "完整 JD 原文"
    }
  ]
}
```

原始岗位内容必须保留在当前 Agent 的授权工作区，不得作为无关样本、日志或公开材料传播。保存分析输入与报告时，按 [交付位置预设](delivery-policy.md) 选择目录。
