import { rename, writeFile } from "node:fs/promises";

async function writeJsonAtomically(filePath, value) {
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, filePath);
}

function createJsonCheckpointWriter(filePath, snapshot) {
  let writes = Promise.resolve();
  return {
    persist() {
      writes = writes.then(() => writeJsonAtomically(filePath, snapshot()));
      return writes;
    },
    flush() {
      return writes;
    },
  };
}

export { createJsonCheckpointWriter };
