import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const argumentsList = process.argv.slice(2);
const directoryIndex = argumentsList.indexOf("--dir");

if (directoryIndex === -1 || !argumentsList[directoryIndex + 1]) {
  console.error("Usage: node validate-delivery.mjs --dir <delivery-directory>");
  process.exit(1);
}

const directory = path.resolve(argumentsList[directoryIndex + 1]);
const requiredFiles = [
  "analysis-input.json",
  "opportunity-entry-report.md",
  "evidence-map.json",
  "manifest.json"
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(fileName, errorMessage) {
  try {
    return JSON.parse(readFileSync(path.join(directory, fileName), "utf8"));
  } catch {
    fail(errorMessage);
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    fail(`${name} must be an array`);
  }
  return value;
}

function requireFields(value, name, fields) {
  requireObject(value, name);
  for (const field of fields) {
    if (!nonEmptyString(value[field])) {
      fail(`${name}.${field} must be a non-empty string`);
    }
  }
}

for (const fileName of requiredFiles) {
  if (!existsSync(path.join(directory, fileName))) {
    fail(`Missing required file: ${fileName}`);
  }
}

const manifest = readJson("manifest.json", "manifest.json must contain valid JSON");
if (!nonEmptyString(manifest.generatedAt) || Number.isNaN(Date.parse(manifest.generatedAt))) {
  fail("manifest.generatedAt must be a valid timestamp");
}
if (!Array.isArray(manifest.files) || manifest.files.length !== requiredFiles.length) {
  fail("manifest.files must list the four required files");
}
for (const fileName of requiredFiles) {
  if (!manifest.files.includes(fileName)) {
    fail(`manifest.files is missing ${fileName}`);
  }
}
if (Array.isArray(manifest.reports)) {
  fail("Legacy multi-report delivery is not valid for opportunity-entry");
}
if (manifest.generation?.branch !== "opportunity-entry") {
  fail("manifest.generation.branch must be opportunity-entry");
}

const analysisInput = readJson(
  "analysis-input.json",
  "analysis-input.json must contain valid JSON"
);
if (!Array.isArray(analysisInput.jobs)) {
  fail("analysis-input.json.jobs must be an array");
}
const sourceJobIds = new Set(
  analysisInput.jobs
    .map((job) => job?.jobId)
    .filter((jobId) => nonEmptyString(jobId))
);

const evidenceMap = readJson("evidence-map.json", "evidence-map.json must contain valid JSON");
const reportBlocks = requireObject(evidenceMap.reportBlocks, "evidence-map.reportBlocks");

requireFields(reportBlocks.conclusion, "reportBlocks.conclusion", ["verdict", "procurementBoundary"]);
const entries = requireArray(reportBlocks.entries, "reportBlocks.entries");
const observedFacts = requireArray(reportBlocks.observedFacts, "reportBlocks.observedFacts");
const firstValidation = requireArray(reportBlocks.firstValidation, "reportBlocks.firstValidation");
const entryActions = requireArray(reportBlocks.entryActions, "reportBlocks.entryActions");
requireFields(reportBlocks.boundary, "reportBlocks.boundary", ["text"]);

const entryIds = new Set();
for (const [index, entry] of entries.entries()) {
  const name = `reportBlocks.entries[${index}]`;
  requireFields(entry, name, ["id", "product", "contactFunction", "businessOpening", "firstMeetingGoal"]);
  if (entryIds.has(entry.id)) {
    fail(`${name}.id must be unique`);
  }
  entryIds.add(entry.id);
}

for (const [index, fact] of observedFacts.entries()) {
  const name = `reportBlocks.observedFacts[${index}]`;
  requireFields(fact, name, ["id", "text"]);
  const anchors = requireArray(fact.anchors, `${name}.anchors`);
  if (anchors.length === 0) {
    fail(`${name}.anchors must contain at least one anchor`);
  }
  for (const anchor of anchors) {
    if (!nonEmptyString(anchor)) {
      fail(`${name}.anchors must contain non-empty strings`);
    }
    if (!sourceJobIds.has(anchor) && !/^https?:\/\//.test(anchor)) {
      fail(`${name}.anchors contains unknown jobId: ${anchor}`);
    }
  }
}

if (firstValidation.length === 0) {
  fail("reportBlocks.firstValidation must contain at least one item");
}
for (const [index, validation] of firstValidation.entries()) {
  const name = `reportBlocks.firstValidation[${index}]`;
  requireFields(validation, name, ["id", "notObserved", "limitedDecision", "question"]);
  if (entryIds.size === 0) {
    if (validation.entryId !== null) {
      fail(`${name}.entryId must be null when entries is empty`);
    }
  } else if (!nonEmptyString(validation.entryId) || !entryIds.has(validation.entryId)) {
    fail(`${name}.entryId must reference reportBlocks.entries`);
  }
}

if (entryIds.size === 0 && entryActions.length !== 0) {
  fail("reportBlocks.entryActions must be empty when reportBlocks.entries is empty");
}
if (entryIds.size > 0 && entryActions.length !== entryIds.size) {
  fail("reportBlocks.entryActions must match reportBlocks.entries");
}
const actionEntryIds = new Set();
for (const [index, action] of entryActions.entries()) {
  const name = `reportBlocks.entryActions[${index}]`;
  requireFields(action, name, ["entryId", "opening", "material", "continueWhen", "pauseWhen"]);
  if (!entryIds.has(action.entryId)) {
    fail(`${name}.entryId must reference reportBlocks.entries`);
  }
  if (actionEntryIds.has(action.entryId)) {
    fail(`${name}.entryId must be unique`);
  }
  actionEntryIds.add(action.entryId);
}
for (const entryId of entryIds) {
  if (!actionEntryIds.has(entryId)) {
    fail("reportBlocks.entryActions must match reportBlocks.entries");
  }
}

const report = readFileSync(path.join(directory, "opportunity-entry-report.md"), "utf8");
const lines = report.split(/\r?\n/);
const requiredHeadings = [
  "给销售的结论",
  "销售入口总览",
  "这家公司当前在做什么",
  "关键未知与首轮验证",
  "怎么进入",
  "资料边界"
];
const headingPositions = requiredHeadings.map((heading) => {
  const position = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (position === -1) {
    fail(`opportunity-entry-report.md must contain a ${heading} section`);
  }
  return position;
});
for (let index = 1; index < headingPositions.length; index += 1) {
  if (headingPositions[index - 1] >= headingPositions[index]) {
    fail("opportunity-entry-report.md has invalid section order");
  }
}
if (lines.some((line) => line.trim() === "## 这轮先不谈什么")) {
  fail("opportunity-entry-report.md must not contain a 这轮先不谈什么 section");
}

const overviewText = lines
  .slice(headingPositions[1] + 1, headingPositions[2])
  .join("\n");
const howToEnterLines = lines.slice(headingPositions[4] + 1, headingPositions[5]);
const actionHeadingCount = howToEnterLines.filter((line) => /^###\s+/.test(line)).length;
const overviewTableLines = overviewText
  .split(/\r?\n/)
  .filter((line) => line.trim().startsWith("|") && line.trim().endsWith("|"));
const hasEntryTable = overviewTableLines.length >= 3;

if (entryIds.size > 0) {
  if (!hasEntryTable) {
    fail("销售入口总览 must contain the required entry table");
  }
  if (actionHeadingCount !== entryIds.size) {
    fail("怎么进入 action blocks must match reportBlocks.entries");
  }
} else {
  if (!overviewText.includes("本轮不推产品")) {
    fail("销售入口总览 must explicitly state 本轮不推产品 when entries is empty");
  }
  if (actionHeadingCount !== 0) {
    fail("怎么进入 must not contain action blocks when entries is empty");
  }
}

const reportJobIds = [...report.matchAll(/https:\/\/www\.zhipin\.com\/job_detail\/([^/.]+)\.html/g)]
  .map((match) => match[1]);
for (const jobId of reportJobIds) {
  if (!sourceJobIds.has(jobId)) {
    fail(`report contains unknown jobId: ${jobId}`);
  }
}

console.log(`opportunity-entry delivery contract passed: ${directory}`);
