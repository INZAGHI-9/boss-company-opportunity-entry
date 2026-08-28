import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const skillDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("requires a sales-reader entry contract instead of exposing the analysis worksheet", () => {
  const instructions = [
    "SKILL.md",
    "references/agent-guide.md",
    "references/opportunity-prompts.md",
    "references/delivery-contract.md",
  ].map((relativePath) => readFileSync(path.join(skillDirectory, relativePath), "utf8")).join("\n");

  assert.match(instructions, /同一份 `opportunity-entry-report\.md`/);
  assert.match(instructions, /给销售的结论/);
  assert.match(instructions, /销售入口总览/);
  assert.match(instructions, /这家公司当前在做什么/);
  assert.match(instructions, /关键未知与首轮验证/);
  assert.match(instructions, /怎么进入/);
  assert.match(instructions, /资料边界/);
  assert.match(instructions, /reportBlocks/);
  assert.match(instructions, /observedFacts/);
  assert.match(instructions, /firstValidation/);
  assert.match(instructions, /entryActions/);
  assert.match(instructions, /未观察到/);
  assert.match(instructions, /工具缺口.*预算.*采购意向/);
  assert.match(instructions, /首轮必须围绕推荐入口确认/);
  assert.match(instructions, /本轮推什么/);
  assert.match(instructions, /先找谁/);
  assert.match(instructions, /从哪件业务事开场/);
  assert.match(instructions, /第一场会的目标/);
  assert.match(instructions, /本轮不推产品/);
  assert.match(instructions, /证据账/);
  assert.doesNotMatch(instructions, /报告按“客户业务底稿 → 我方业务匹配诊断 → 商机切入判断”组织章节/);
  assert.match(instructions, /不需要用户额外确认/);
  assert.doesNotMatch(instructions, /## 这轮先不谈什么/);
  assert.doesNotMatch(instructions, /business-strategy-report\.md|talent-strategy-report\.md|quick-prompt\.md|deep-prompts\.md|快速版|深化版/);
});
