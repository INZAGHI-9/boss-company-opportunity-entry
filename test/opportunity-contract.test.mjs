import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const skillDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("limits opportunity entry to a customer-business baseline and entry judgment without modes", () => {
  const instructions = [
    "SKILL.md",
    "references/agent-guide.md",
    "references/opportunity-prompts.md",
    "references/delivery-contract.md",
  ].map((relativePath) => readFileSync(path.join(skillDirectory, relativePath), "utf8")).join("\n");

  assert.match(instructions, /客户业务底稿/);
  assert.match(instructions, /我方业务匹配诊断/);
  assert.match(instructions, /同一份 `opportunity-entry-report\.md`/);
  assert.match(instructions, /客户业务事实、我方能力或产品、匹配依据、错配或缺口、诊断结论/);
  assert.match(instructions, /商机切入报告/);
  assert.match(instructions, /不需要用户额外确认/);
  assert.doesNotMatch(instructions, /business-strategy-report\.md|talent-strategy-report\.md|quick-prompt\.md|deep-prompts\.md|快速版|深化版/);
});
