function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function pageTransitionDelay(random = Math.random) {
  const value = Number(random());
  const fraction = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return Math.round(fraction * 2_000);
}

async function waitBetweenPages({ random = Math.random, sleep: wait = sleep } = {}) {
  const milliseconds = pageTransitionDelay(random);
  await wait(milliseconds);
  return milliseconds;
}

export { pageTransitionDelay, waitBetweenPages };
