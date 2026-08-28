function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForResult(read, {
  timeout = 15_000,
  interval = 250,
  label = "页面内容",
  onPending = async () => {},
} = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() <= deadline) {
    const result = await read();
    if (result) return result;
    await onPending();
    await sleep(interval);
  }
  throw new Error(`等待${label}出现超时`);
}

export { waitForResult };
