const MAX_CONCURRENT_PAGES = 5;
const DEFAULT_MAX_ATTEMPTS = 1;

function defaultRetryDelay(attempt) {
  return Math.min(15_000, 750 * (2 ** Math.min(attempt - 1, 5)));
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function runRecoveryQueue(items, {
  concurrency = MAX_CONCURRENT_PAGES,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  worker,
  retryDelay = defaultRetryDelay,
  isManualRecoveryError = () => false,
  onAttemptError = async () => {},
  onCompleted = async () => {},
} = {}) {
  if (!Array.isArray(items)) throw new Error("恢复队列需要任务数组");
  if (typeof worker !== "function") throw new Error("恢复队列需要 worker 函数");
  const queue = [...items];
  const completed = [];
  const failed = [];
  const paused = [];
  const attemptLimit = Math.max(1, Number.isInteger(maxAttempts) ? maxAttempts : DEFAULT_MAX_ATTEMPTS);
  const workerCount = Math.min(
    MAX_CONCURRENT_PAGES,
    Math.max(1, Number.isInteger(concurrency) ? concurrency : MAX_CONCURRENT_PAGES),
    queue.length,
  );
  let pausedForManualRecovery = false;

  async function runWorker() {
    while (!pausedForManualRecovery && queue.length) {
      const item = queue.shift();
      let attempt = 0;
      while (true) {
        attempt += 1;
        try {
          const value = await worker(item, { attempt });
          const result = { item, value, attempts: attempt };
          completed.push(result);
          await onCompleted(result);
          break;
        } catch (error) {
          const failure = { item, error, attempts: attempt };
          await onAttemptError(failure);
          if (isManualRecoveryError(error, failure)) {
            pausedForManualRecovery = true;
            paused.push(failure);
            return;
          }
          if (attempt >= attemptLimit) {
            failed.push(failure);
            break;
          }
          await wait(Math.max(0, Number(retryDelay(attempt, error)) || 0));
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return { completed, failed, paused, remaining: [...queue] };
}

async function runSequentialFallback(items, {
  worker,
  onAttemptError = async () => {},
} = {}) {
  if (!Array.isArray(items)) throw new Error("顺序续采需要任务数组");
  if (typeof worker !== "function") throw new Error("顺序续采需要 worker 函数");
  const completed = [];
  const failed = [];
  for (const item of items) {
    try {
      const value = await worker(item);
      completed.push({ item, value });
    } catch (error) {
      const failure = { item, error, attempts: 1 };
      failed.push(failure);
      await onAttemptError(failure);
    }
  }
  return { completed, failed };
}

export { MAX_CONCURRENT_PAGES, runRecoveryQueue, runSequentialFallback };
