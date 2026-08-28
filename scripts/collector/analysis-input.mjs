function createAnalysisInput({ candidate, coverage, capturedAt, jobs }) {
  const deduplicatedJobCount = new Set(jobs.map(job => job.jobId).filter(Boolean)).size;
  const publishedJobCount = Number(coverage?.advertisedTotal || coverage?.apiTotal || deduplicatedJobCount);
  const complete = coverage?.complete === true;
  const toleratedGap = coverage?.toleratedGap === true;
  const limitation = complete
    ? ""
    : toleratedGap
      ? `公司岗位页存在允许的动态缺口：页面公布 ${publishedJobCount} 个岗位，已去重 ${deduplicatedJobCount} 个岗位，缺 ${Number(coverage?.missingCount || 0)} 个岗位（${((Number(coverage?.missingRatio || 0)) * 100).toFixed(1)}%，容忍上限 ${((Number(coverage?.allowedMissingRatio || 0)) * 100).toFixed(1)}%）。`
      : `公司岗位页未完整采集：页面公布 ${publishedJobCount} 个岗位，已去重 ${deduplicatedJobCount} 个岗位，已读取 ${Number(coverage?.pagesCaptured || 0)} 页。`;

  return {
    company: {
      name: candidate.company,
      brandId: candidate.brandId || null,
      companyUrl: candidate.companyLink || `https://www.zhipin.com/gongsi/${candidate.brandId}.html`,
    },
    snapshot: {
      collectedAt: capturedAt,
      status: complete ? "complete" : toleratedGap ? "tolerated_gap" : "partial",
      publishedJobCount,
      deduplicatedJobCount,
      limitation,
    },
    jobs: jobs.map(job => ({
      jobId: job.jobId,
      title: job.title,
      url: job.finalUrl || job.jobLink || null,
      location: job.location || job.city || null,
      salary: job.salary || null,
      employmentMode: job.employmentMode || null,
      description: job.description || "",
    })),
  };
}

export { createAnalysisInput };
