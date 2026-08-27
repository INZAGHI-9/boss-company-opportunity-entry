import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const LOCK_DIRECTORY = "scout-run.lock";
const OWNER_FILE = "owner.json";

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function readOwner(lockPath) {
  try {
    return JSON.parse(await readFile(path.join(lockPath, OWNER_FILE), "utf8"));
  } catch {
    return null;
  }
}

async function acquireScoutRunLock(dataRoot, metadata = {}) {
  const lockPath = path.join(dataRoot, LOCK_DIRECTORY);
  const owner = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    company: metadata.company || null,
    cdpPort: metadata.cdpPort || null,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath);
      await writeFile(path.join(lockPath, OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
      let released = false;
      return {
        owner,
        async release() {
          if (released) return;
          released = true;
          await rm(lockPath, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const activeOwner = await readOwner(lockPath);
      if (activeOwner && !isProcessAlive(activeOwner.pid)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      const detail = activeOwner?.company ? `（${activeOwner.company}）` : "";
      throw new Error(`已有采集任务正在运行${detail}。请等待其完成后再启动新的采集命令。`);
    }
  }
  throw new Error("采集运行锁恢复失败，请稍后重试。");
}

export { acquireScoutRunLock };
