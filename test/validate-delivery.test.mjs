import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const skillDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = path.join(skillDirectory, "scripts", "validate-delivery.mjs");

test("accepts a single self-contained opportunity report", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "boss-opportunity-entry-"));
  const files = [
    "analysis-input.json",
    "opportunity-entry-report.md",
    "evidence-map.json",
    "manifest.json",
  ];

  writeFileSync(path.join(directory, "analysis-input.json"), "{}", "utf8");
  writeFileSync(path.join(directory, "opportunity-entry-report.md"), "# 商机切入报告\n```mermaid\nmindmap\n```", "utf8");
  writeFileSync(path.join(directory, "evidence-map.json"), "{}", "utf8");
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({
    generatedAt: "2026-08-26T00:00:00.000Z",
    files,
    generation: { branch: "opportunity-entry" },
  }), "utf8");

  const result = spawnSync(process.execPath, [validator, "--dir", directory], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /opportunity-entry delivery contract passed/);
});

test("rejects the legacy multi-report delivery shape", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "boss-opportunity-entry-missing-fit-"));
  const files = [
    "analysis-input.json",
    "customer-business-baseline.md",
    "business-fit-diagnosis.md",
    "sales-entry-opportunity-report.md",
    "evidence-map.json",
    "manifest.json",
  ];

  writeFileSync(path.join(directory, "analysis-input.json"), "{}", "utf8");
  writeFileSync(path.join(directory, "customer-business-baseline.md"), "# 客户业务底稿", "utf8");
  writeFileSync(path.join(directory, "business-fit-diagnosis.md"), "# 我方业务匹配诊断", "utf8");
  writeFileSync(path.join(directory, "sales-entry-opportunity-report.md"), "```mermaid\nmindmap\n```", "utf8");
  writeFileSync(path.join(directory, "evidence-map.json"), "{}", "utf8");
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({
    generatedAt: "2026-08-26T00:00:00.000Z",
    files,
    generation: { branch: "sales" },
  }), "utf8");

  const result = spawnSync(process.execPath, [validator, "--dir", directory], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /opportunity-entry-report/);
});
