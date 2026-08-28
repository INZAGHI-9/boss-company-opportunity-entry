const DEFAULT_ALLOWED_MISSING_RATIO = 0.1;

function selectCollectiblePositionTabs(tabs = []) {
  const seen = new Set();
  return tabs.filter(tab => {
    if (!tab?.key || tab.key === "position_0" || !tab.href || seen.has(tab.key)) return false;
    seen.add(tab.key);
    return true;
  }).map(tab => ({
    key: tab.key,
    label: tab.label || tab.key,
    advertisedCount: Number(tab.advertisedCount || 0),
    href: tab.href,
  }));
}

function summarizePositionTabCoverage({
  advertisedTotal = 0,
  tabs = [],
  tabResults = [],
  allowedMissingRatio = DEFAULT_ALLOWED_MISSING_RATIO,
} = {}) {
  const resultByKey = new Map(tabResults.map(result => [result.key, result]));
  const allJobIds = new Set();
  const ownersByJobId = new Map();
  const perTab = tabs.map(tab => {
    const result = resultByKey.get(tab.key);
    const jobIds = [...new Set(result?.jobIds || [])];
    for (const jobId of jobIds) {
      allJobIds.add(jobId);
      const owners = ownersByJobId.get(jobId) || [];
      owners.push(tab.key);
      ownersByJobId.set(jobId, owners);
    }
    return {
      key: tab.key,
      label: tab.label,
      advertisedCount: tab.advertisedCount,
      collectedCount: jobIds.length,
      missingCount: Math.max(0, tab.advertisedCount - jobIds.length),
      pagesCaptured: Number(result?.pagesCaptured || 0),
      terminalReached: result?.terminalReached === true,
    };
  });
  const overlapPairs = [...ownersByJobId.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([jobId, owners]) => ({ jobId, tabKeys: owners.sort() }));
  const expectedTotal = Number(advertisedTotal || perTab.reduce((sum, tab) => sum + tab.advertisedCount, 0));
  const collectedTotal = allJobIds.size;
  const missingCount = Math.max(0, expectedTotal - collectedTotal);
  const missingRatio = expectedTotal ? missingCount / expectedTotal : 0;
  const allTabsTerminal = perTab.length > 0 && perTab.every(tab => tab.terminalReached);
  const complete = allTabsTerminal && collectedTotal === expectedTotal;
  const toleratedGap = allTabsTerminal && !complete && missingRatio <= allowedMissingRatio;

  return {
    source: "company-position-tabs",
    advertisedTotal: expectedTotal,
    tabAdvertisedTotal: perTab.reduce((sum, tab) => sum + tab.advertisedCount, 0),
    collectedTotal,
    missingCount,
    missingRatio,
    allowedMissingRatio,
    complete,
    toleratedGap,
    allTabsTerminal,
    overlapPairs,
    positionTabs: perTab,
  };
}

function reconcileCoverageWithCompletedJobs(coverage, jobs = []) {
  const completedByTab = new Map();
  const completedIds = new Set();
  for (const job of jobs) {
    if (!job?.jobId || !String(job.description || "").trim() || completedIds.has(job.jobId)) continue;
    completedIds.add(job.jobId);
    completedByTab.set(job.sourceTab, (completedByTab.get(job.sourceTab) || 0) + 1);
  }
  const positionTabs = (coverage.positionTabs || []).map(tab => {
    const collectedCount = completedByTab.get(tab.key) || 0;
    return {
      ...tab,
      collectedCount,
      missingCount: Math.max(0, Number(tab.advertisedCount || 0) - collectedCount),
    };
  });
  const advertisedTotal = Number(coverage.advertisedTotal || 0);
  const collectedTotal = completedIds.size;
  const missingCount = Math.max(0, advertisedTotal - collectedTotal);
  const missingRatio = advertisedTotal ? missingCount / advertisedTotal : 0;
  const complete = coverage.allTabsTerminal === true && collectedTotal === advertisedTotal;
  const toleratedGap = coverage.allTabsTerminal === true
    && !complete
    && missingRatio <= Number(coverage.allowedMissingRatio || DEFAULT_ALLOWED_MISSING_RATIO);
  return {
    ...coverage,
    collectedTotal,
    missingCount,
    missingRatio,
    complete,
    toleratedGap,
    positionTabs,
  };
}

export {
  DEFAULT_ALLOWED_MISSING_RATIO,
  reconcileCoverageWithCompletedJobs,
  selectCollectiblePositionTabs,
  summarizePositionTabCoverage,
};
