import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const skillDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const collectorDirectory = path.join(skillDirectory, "scripts", "collector");

test("uses the actual last page instead of estimating pages from the first card batch", async () => {
  const moduleUrl = pathToFileURL(path.join(collectorDirectory, "company-page-batch.mjs")).href;
  const { remainingCompanyPages } = await import(moduleUrl);

  const pages = remainingCompanyPages({
    advertisedTotal: 276,
    firstPageSize: 15,
    lastPage: 14,
    maxPages: 50,
  });

  assert.deepEqual(pages, Array.from({ length: 13 }, (_value, index) => index + 2));
});

test("selects every dynamic position tab except the all-jobs tab", async () => {
  const moduleUrl = pathToFileURL(path.join(collectorDirectory, "position-tab-coverage.mjs")).href;
  const { selectCollectiblePositionTabs } = await import(moduleUrl);

  const tabs = selectCollectiblePositionTabs([
    { key: "position_0", label: "全部", advertisedCount: 463, href: "/gongsi/job/brand.html" },
    { key: "position_290000", label: "服务业", advertisedCount: 209, href: "/gongsi/job/290000/brand.html" },
    { key: "position_160000", label: "销售", advertisedCount: 73, href: "/gongsi/job/160000/brand.html" },
  ]);

  assert.deepEqual(tabs, [
    { key: "position_290000", label: "服务业", advertisedCount: 209, href: "/gongsi/job/290000/brand.html" },
    { key: "position_160000", label: "销售", advertisedCount: 73, href: "/gongsi/job/160000/brand.html" },
  ]);
});

test("paces pagination transitions with a bounded 0-to-2-second random delay", async () => {
  const moduleUrl = pathToFileURL(path.join(collectorDirectory, "page-pacing.mjs")).href;
  const { pageTransitionDelay, waitBetweenPages } = await import(moduleUrl);

  assert.equal(pageTransitionDelay(() => 0), 0);
  assert.equal(pageTransitionDelay(() => 0.5), 1000);
  assert.equal(pageTransitionDelay(() => 0.999999), 2000);

  const waits = [];
  const delay = await waitBetweenPages({
    random: () => 0.5,
    sleep: async milliseconds => waits.push(milliseconds),
  });
  assert.equal(delay, 1000);
  assert.deepEqual(waits, [1000]);
});

test("paces parallel and fallback pagination before navigating to the next page", async () => {
  const scout = await readFile(path.join(collectorDirectory, "boss-company-scout.mjs"), "utf8");
  assert.match(scout, /import \{ waitBetweenPages \} from "\.\/page-pacing\.mjs"/);
  assert.match(scout, /async function collectParallelCompanyPage[\s\S]*?await waitBetweenPages\(\);[\s\S]*?await navigate/);
  assert.match(scout, /if \(paceBeforeNavigation\) await waitBetweenPages\(\);/);
  assert.match(scout, /collectPositionTabPage\(client, workerContext, candidate, task\.tab, task\.sourcePage, true\)/);
  assert.match(scout, /collectPositionTabPage\(client, page, candidate, task\.tab, task\.sourcePage, true\)/);
});

test("records a dynamic-listing gap within tolerance without calling it complete", async () => {
  const moduleUrl = pathToFileURL(path.join(collectorDirectory, "position-tab-coverage.mjs")).href;
  const { reconcileCoverageWithCompletedJobs, summarizePositionTabCoverage } = await import(moduleUrl);
  const ids = (prefix, count) => Array.from({ length: count }, (_value, index) => `${prefix}-${index + 1}`);

  const coverage = summarizePositionTabCoverage({
    advertisedTotal: 463,
    tabs: [
      { key: "position_290000", label: "服务业", advertisedCount: 209 },
      { key: "position_160000", label: "销售", advertisedCount: 73 },
      { key: "position_200000", label: "其他", advertisedCount: 181 },
    ],
    tabResults: [
      { key: "position_290000", jobIds: ids("service", 200), pagesCaptured: 14, terminalReached: true },
      { key: "position_160000", jobIds: ids("sales", 73), pagesCaptured: 5, terminalReached: true },
      { key: "position_200000", jobIds: ids("other", 181), pagesCaptured: 13, terminalReached: true },
    ],
  });

  assert.equal(coverage.source, "company-position-tabs");
  assert.equal(coverage.advertisedTotal, 463);
  assert.equal(coverage.tabAdvertisedTotal, 463);
  assert.equal(coverage.collectedTotal, 454);
  assert.equal(coverage.missingCount, 9);
  assert.equal(coverage.missingRatio, 9 / 463);
  assert.equal(coverage.allowedMissingRatio, 0.1);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.toleratedGap, true);
  assert.equal(coverage.allTabsTerminal, true);
  assert.deepEqual(coverage.overlapPairs, []);

  const reconciled = reconcileCoverageWithCompletedJobs(coverage, [
    ...ids("service", 197).map(jobId => ({ jobId, sourceTab: "position_290000", description: "完整 JD" })),
    ...ids("sales", 73).map(jobId => ({ jobId, sourceTab: "position_160000", description: "完整 JD" })),
    ...ids("other", 181).map(jobId => ({ jobId, sourceTab: "position_200000", description: "完整 JD" })),
  ]);
  assert.equal(reconciled.collectedTotal, 451);
  assert.equal(reconciled.missingCount, 12);
  assert.equal(reconciled.toleratedGap, true);
  assert.equal(reconciled.positionTabs[0].missingCount, 12);
});

test("flushes the position-tab listing checkpoint through its checkpoint writer", async () => {
  const scout = await readFile(path.join(collectorDirectory, "boss-company-scout.mjs"), "utf8");
  assert.doesNotMatch(scout, /persistListingCheckpoint\.flush\(\)/);
  assert.match(scout, /listingCheckpointWriter\.flush\(\)/);
  assert.doesNotMatch(scout, /checkpointMatches/);
  assert.doesNotMatch(scout, /existingCheckpoint\?\.schemaVersion === 2/);
});

test("continues a position page after an individual JD card disappears", async () => {
  const scout = await readFile(path.join(collectorDirectory, "boss-company-scout.mjs"), "utf8");
  assert.match(scout, /const pageFailures = \[\]/);
  assert.match(scout, /for \(const job of pendingTargets\)/);
  assert.match(scout, /if \(pageFailures\.length\)/);
  assert.match(scout, /async function readCompanyJobCardState/);
  assert.match(scout, /throw missingJobCardError\(job\.jobId\)/);
  assert.match(scout, /timeout: 3_000,[\s\S]*label: `前端岗位详情/);
  assert.doesNotMatch(scout, /JOB_DETAIL_PATH/);
  assert.match(scout, /for \(let listingRefresh = 0; listingRefresh < 2; listingRefresh \+= 1\)/);
  assert.match(scout, /reconcileCoverageWithCompletedJobs\(companyList\.coverage, completedJobs/);
});

test("stops immediately when Boss renders an account access restriction", async () => {
  const moduleUrl = pathToFileURL(path.join(collectorDirectory, "access-guard.mjs")).href;
  const { assertPageAccessible } = await import(moduleUrl);

  assert.throws(
    () => assertPageAccessible({
      url: "https://www.zhipin.com/gongsi/job/example.html",
      bodyText: "访问受限 您的账户存在异常行为，已暂时被限制访问！请耐心等待",
    }),
    /人工恢复|访问受限/,
  );
});

test("checks page accessibility while a detail is still pending", async () => {
  const readinessUrl = pathToFileURL(path.join(collectorDirectory, "page-readiness.mjs")).href;
  const { waitForResult } = await import(readinessUrl);
  let checks = 0;

  await assert.rejects(
    () => waitForResult(
      async () => null,
      {
        timeout: 100,
        interval: 1,
        onPending: async () => {
          checks += 1;
          throw new Error("访问受限，需人工恢复");
        },
      },
    ),
    /访问受限/,
  );
  assert.equal(checks, 1);
});

test("wires the access guard into every pending detail check", async () => {
  const scout = await readFile(path.join(collectorDirectory, "boss-company-scout.mjs"), "utf8");
  const guard = await readFile(path.join(collectorDirectory, "access-guard.mjs"), "utf8");
  assert.match(
    scout,
    /onPending: async \(\) => assertPageAccessible\(await getPageState\(client, page\.sessionId\)\)/,
  );
  assert.match(guard, /访问受限\|限制访问\|账户存在异常行为/);
});

test("prevents a second collector from taking the same dedicated runtime", async () => {
  const moduleUrl = pathToFileURL(path.join(collectorDirectory, "scout-run-lock.mjs")).href;
  const { acquireScoutRunLock } = await import(moduleUrl);
  const root = await mkdtemp(path.join(os.tmpdir(), "boss-opportunity-lock-"));
  try {
    const first = await acquireScoutRunLock(root, { company: "示例公司", cdpPort: 9222 });
    await assert.rejects(
      () => acquireScoutRunLock(root, { company: "另一家公司", cdpPort: 9222 }),
      /已有采集任务正在运行/,
    );
    await first.release();
    const second = await acquireScoutRunLock(root, { company: "另一家公司", cdpPort: 9222 });
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reuses fixed worker contexts instead of creating a browser page for every queued task", async () => {
  const moduleUrl = pathToFileURL(path.join(collectorDirectory, "recovery-queue.mjs")).href;
  const { runRecoveryQueue } = await import(moduleUrl);
  const workers = [{ id: "worker-1" }, { id: "worker-2" }];

  const result = await runRecoveryQueue([1, 2, 3, 4], {
    concurrency: 2,
    workerContexts: workers,
    worker: async (item, { workerContext }) => `${workerContext.id}:${item}`,
  });

  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.completed.map(entry => entry.value), ["worker-1:1", "worker-2:2", "worker-1:3", "worker-2:4"]);
});

test("keeps fixed worker pages alive until the batch ends and preserves a paused verification page", async () => {
  const moduleUrl = pathToFileURL(path.join(collectorDirectory, "cdp-client.mjs")).href;
  const { createFixedPagePool } = await import(moduleUrl);
  const calls = [];
  let targetNumber = 0;
  const client = {
    async send(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Target.createTarget") return { targetId: `target-${++targetNumber}` };
      if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` };
      return {};
    },
  };

  const pool = await createFixedPagePool(client, 2);
  assert.deepEqual(pool.workers.map(worker => worker.targetId), ["target-1", "target-2"]);
  await pool.close({ preserveTargetIds: ["target-2"] });

  assert.deepEqual(
    calls.filter(call => call.method === "Target.closeTarget").map(call => call.params.targetId),
    ["target-1"],
  );
});
