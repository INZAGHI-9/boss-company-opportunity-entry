import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const skillDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const collectorDirectory = path.join(skillDirectory, "scripts", "collector");
const requiredModules = [
  "boss-company-scout.mjs",
  "analysis-input.mjs",
  "cdp-client.mjs",
  "checkpoint-writer.mjs",
  "company-navigation.mjs",
  "company-page-batch.mjs",
  "page-readiness.mjs",
  "recovery-queue.mjs",
  "scout-run-lock.mjs",
];

test("packages the complete Boss collector inside the opportunity-entry skill", () => {
  for (const module of requiredModules) {
    assert.equal(existsSync(path.join(collectorDirectory, module)), true, `missing bundled collector module: ${module}`);
  }

  const instructions = readFileSync(path.join(skillDirectory, "SKILL.md"), "utf8");
  assert.match(instructions, /scripts\/collector\/boss-company-scout\.mjs/);
  assert.match(instructions, /--check-login[\s\S]*自动选择 `brandId`[\s\S]*完整 JD[\s\S]*opportunity-entry-report\.md/);
  assert.doesNotMatch(instructions, /仅请求用户选择/);
  assert.doesNotMatch(instructions, /boss-company-talent-map/);
});

test("emits the analysis-input contract required by the opportunity report", async () => {
  const inputModule = pathToFileURL(path.join(collectorDirectory, "analysis-input.mjs")).href;
  const { createAnalysisInput } = await import(inputModule);
  const input = createAnalysisInput({
    candidate: {
      company: "示例公司",
      brandId: "brand-1",
      companyLink: "https://www.zhipin.com/gongsi/brand-1.html",
    },
    coverage: {
      complete: true,
      advertisedTotal: 1,
      collectedTotal: 1,
      pagesCaptured: 1,
    },
    capturedAt: "2026-08-26T00:00:00.000Z",
    jobs: [{
      jobId: "job-1",
      title: "内容运营",
      finalUrl: "https://www.zhipin.com/job_detail/job-1.html",
      location: "厦门",
      salary: "10-15K",
      description: "完整 JD",
    }],
  });

  assert.deepEqual(input.company, {
    name: "示例公司",
    brandId: "brand-1",
    companyUrl: "https://www.zhipin.com/gongsi/brand-1.html",
  });
  assert.deepEqual(input.snapshot, {
    collectedAt: "2026-08-26T00:00:00.000Z",
    status: "complete",
    publishedJobCount: 1,
    deduplicatedJobCount: 1,
    limitation: "",
  });
  assert.deepEqual(input.jobs, [{
    jobId: "job-1",
    title: "内容运营",
    url: "https://www.zhipin.com/job_detail/job-1.html",
    location: "厦门",
    salary: "10-15K",
    employmentMode: null,
    description: "完整 JD",
  }]);
});

test("retains the business-and-talent collector safeguards while adapting only the output contract", async () => {
  const scout = readFileSync(path.join(collectorDirectory, "boss-company-scout.mjs"), "utf8");
  assert.match(scout, /cdpPortExplicit/);
  assert.match(scout, /runSequentialFallback/);
  assert.match(scout, /assertCompleteDetails/);

  const recoveryModule = pathToFileURL(path.join(collectorDirectory, "recovery-queue.mjs")).href;
  const { runRecoveryQueue, runSequentialFallback } = await import(recoveryModule);
  assert.equal(typeof runSequentialFallback, "function");

  const result = await runRecoveryQueue(["failed"], {
    concurrency: 1,
    maxAttempts: 2,
    retryDelay: () => 0,
    worker: async (_item, { attempt }) => {
      throw new Error(attempt >= 3 ? "manual stop" : "detail unavailable");
    },
    isManualRecoveryError: error => error.message === "manual stop",
  });

  assert.equal(result.paused.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].attempts, 2);
});
