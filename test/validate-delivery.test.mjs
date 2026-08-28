import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const skillDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = path.join(skillDirectory, "scripts", "validate-delivery.mjs");
const files = ["analysis-input.json", "opportunity-entry-report.md", "evidence-map.json", "manifest.json"];

function stableBlocks({ entries = null, firstValidation = null, entryActions = null, observedFacts = null } = {}) {
  const defaultEntries = [{
    id: "content-review",
    product: "蝉妈妈",
    contactFunction: "内容运营",
    businessOpening: "内容复盘",
    firstMeetingGoal: "确认一个内容项目",
  }];
  const resolvedEntries = entries ?? defaultEntries;
  return {
    conclusion: { verdict: "建议约谈", procurementBoundary: "尚不能视为采购项目" },
    entries: resolvedEntries,
    observedFacts: observedFacts ?? [{ id: "content-workflow", text: "岗位负责内容复盘", anchors: ["job-1"] }],
    firstValidation: firstValidation ?? [{
      id: "current-tool",
      entryId: resolvedEntries.length > 0 ? "content-review" : null,
      notObserved: "现用工具",
      limitedDecision: "不能判断工具缺口",
      question: "当前项目如何复盘",
    }],
    entryActions: entryActions ?? (resolvedEntries.length > 0 ? [{
      entryId: "content-review",
      opening: "从内容复盘开场",
      material: "项目参照",
      continueWhen: "存在重复复盘任务",
      pauseWhen: "没有具体项目",
    }] : []),
    boundary: { text: "招聘不能证明采购意向" },
  };
}

function entryReport({ headingOrder = null, includeRemovedSection = false } = {}) {
  const sections = {
    conclusion: ["## 给销售的结论", "建议先从内容复盘切入；尚不能把它当作采购项目。"],
    overview: ["## 销售入口总览", "| 本轮推什么 | 先找谁 | 从哪件业务事开场 | 第一场会的目标 |", "| --- | --- | --- | --- |", "| 蝉妈妈 | 内容运营 | 内容复盘 | 确认一个内容项目 |"],
    observed: ["## 这家公司当前在做什么", "岗位负责内容复盘。"],
    validation: ["## 关键未知与首轮验证", "未观察到现用工具，因此不能判断工具缺口。首轮确认：当前项目如何复盘。"],
    entry: ["## 怎么进入", "### 从内容复盘切入蝉妈妈", "**开场**：从当前内容复盘任务开始。", "**带去材料**：项目参照。", "**继续条件**：存在重复复盘任务。", "**暂停条件**：没有具体项目。"],
    boundary: ["## 资料边界", "招聘不能证明采购意向。"],
  };
  const order = headingOrder ?? ["conclusion", "overview", "observed", "validation", "entry", "boundary"];
  const lines = ["# 商机切入报告"];
  for (const key of order) lines.push(...sections[key]);
  if (includeRemovedSection) lines.splice(lines.length - 2, 0, "## 这轮先不谈什么", "不重复讨论。");
  return lines.join("\n");
}

function noEntryReport() {
  return ["# 商机切入报告", "## 给销售的结论", "本轮不建议推产品。", "## 销售入口总览", "本轮不推产品。下一场只确认：当前内容工作流。", "## 这家公司当前在做什么", "岗位负责内容复盘。", "## 关键未知与首轮验证", "未观察到现用工具。首轮确认：当前项目如何复盘。", "## 怎么进入", "本轮不进入产品演示。", "## 资料边界", "招聘不能证明采购意向。"].join("\n");
}

function createDelivery({ report = entryReport(), reportBlocks = stableBlocks(), jobs = [{ jobId: "job-1" }] } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "boss-opportunity-entry-"));
  writeFileSync(path.join(directory, "analysis-input.json"), JSON.stringify({ jobs }), "utf8");
  writeFileSync(path.join(directory, "opportunity-entry-report.md"), report, "utf8");
  writeFileSync(path.join(directory, "evidence-map.json"), JSON.stringify({ reportBlocks }), "utf8");
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ generatedAt: "2026-08-26T00:00:00.000Z", files, generation: { branch: "opportunity-entry" } }), "utf8");
  return directory;
}

function runValidator(directory) {
  return spawnSync(process.execPath, [validator, "--dir", directory], { encoding: "utf8" });
}

test("accepts a self-contained report with stable blocks and a matching action", () => {
  const result = runValidator(createDelivery());
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /opportunity-entry delivery contract passed/);
});

test("accepts a no-entry report when validation is not assigned to a product entry", () => {
  const result = runValidator(createDelivery({ report: noEntryReport(), reportBlocks: stableBlocks({ entries: [] }) }));
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("rejects an analysis-shaped report that lacks a sales entry overview", () => {
  const result = runValidator(createDelivery({ report: "# 商机切入报告\n## 给销售的结论\n建议进入。" }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /销售入口总览/);
});

test("rejects a sales-entry report that omits observed-work and first-validation sections", () => {
  const report = ["# 商机切入报告", "## 给销售的结论", "建议进入。", "## 销售入口总览", "| 本轮推什么 | 先找谁 | 从哪件业务事开场 | 第一场会的目标 |", "| --- | --- | --- | --- |", "| 蝉妈妈 | 内容运营 | 内容复盘 | 确认一个内容项目 |"].join("\n");
  const result = runValidator(createDelivery({ report }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /这家公司当前在做什么/);
});

test("rejects a report that retains the removed redundancy section", () => {
  const result = runValidator(createDelivery({ report: entryReport({ includeRemovedSection: true }) }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /这轮先不谈什么/);
});

test("rejects a report with reader sections out of order", () => {
  const result = runValidator(createDelivery({ report: entryReport({ headingOrder: ["conclusion", "overview", "validation", "observed", "entry", "boundary"] }) }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /section order/);
});

test("rejects first validation without its reader question", () => {
  const reportBlocks = stableBlocks({ firstValidation: [{ id: "current-tool", entryId: "content-review", notObserved: "现用工具", limitedDecision: "不能判断工具缺口" }] });
  const result = runValidator(createDelivery({ reportBlocks }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /firstValidation.*question/);
});

test("rejects a missing action for one of two sales entries", () => {
  const entries = [...stableBlocks().entries, { id: "creator-collaboration", product: "蝉圈圈", contactFunction: "达人合作", businessOpening: "达人协作", firstMeetingGoal: "确认一项合作任务" }];
  const reportBlocks = stableBlocks({ entries });
  const report = entryReport().replace("## 资料边界", "### 从达人协作切入蝉圈圈\n**开场**：从合作任务开始。\n**带去材料**：候选清单。\n**继续条件**：存在重复协作。\n**暂停条件**：没有具体任务。\n## 资料边界");
  const result = runValidator(createDelivery({ report, reportBlocks }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /entryActions.*entries/);
});

test("rejects an observed fact anchored to a job outside the raw snapshot", () => {
  const reportBlocks = stableBlocks({ observedFacts: [{ id: "content-workflow", text: "岗位负责内容复盘", anchors: ["missing-job"] }] });
  const result = runValidator(createDelivery({ reportBlocks }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown jobId/);
});

test("rejects a no-entry report whose validation names a product entry", () => {
  const reportBlocks = stableBlocks({ entries: [], firstValidation: [{ id: "current-tool", entryId: "content-review", notObserved: "现用工具", limitedDecision: "不能判断工具缺口", question: "当前项目如何复盘" }] });
  const result = runValidator(createDelivery({ report: noEntryReport(), reportBlocks }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /firstValidation.*entryId/);
});

test("rejects the legacy multi-report delivery shape", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "boss-opportunity-entry-legacy-"));
  const legacyFiles = ["analysis-input.json", "customer-business-baseline.md", "business-fit-diagnosis.md", "sales-entry-opportunity-report.md", "evidence-map.json", "manifest.json"];
  writeFileSync(path.join(directory, "analysis-input.json"), "{}", "utf8");
  writeFileSync(path.join(directory, "customer-business-baseline.md"), "# 客户业务底稿", "utf8");
  writeFileSync(path.join(directory, "business-fit-diagnosis.md"), "# 我方业务匹配诊断", "utf8");
  writeFileSync(path.join(directory, "sales-entry-opportunity-report.md"), "# 商机切入报告", "utf8");
  writeFileSync(path.join(directory, "evidence-map.json"), "{}", "utf8");
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ generatedAt: "2026-08-26T00:00:00.000Z", files: legacyFiles, generation: { branch: "sales" } }), "utf8");
  const result = runValidator(directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /opportunity-entry-report/);
});
