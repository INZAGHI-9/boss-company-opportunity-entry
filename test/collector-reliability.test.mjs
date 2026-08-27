import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
