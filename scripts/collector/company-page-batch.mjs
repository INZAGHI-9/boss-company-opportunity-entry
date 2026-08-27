function remainingCompanyPages({ advertisedTotal, firstPageSize, lastPage = null, maxPages }) {
  if (!Number.isInteger(lastPage) || lastPage <= 0) return [];
  const pageCount = lastPage;
  const safePageCount = Math.min(pageCount, maxPages);
  return Array.from({ length: Math.max(0, safePageCount - 1) }, (_, index) => index + 2);
}

function mergeCompanyPageJobs(renderedJobs, apiJobs = []) {
  const apiById = new Map(apiJobs.map(job => [job.jobId, job]));
  return renderedJobs.map(job => ({ ...apiById.get(job.jobId), ...job }));
}

function conflictingCompanyPages(pageResults) {
  const pagesByJobId = new Map();
  for (const page of pageResults) {
    for (const job of page.jobs || []) {
      const pages = pagesByJobId.get(job.jobId) || [];
      pages.push(page.sourcePage);
      pagesByJobId.set(job.jobId, pages);
    }
  }
  return [...pagesByJobId.values()]
    .filter(pages => pages.length > 1)
    .flatMap(pages => pages.slice(1))
    .filter((page, index, pages) => pages.indexOf(page) === index)
    .sort((left, right) => left - right);
}

export { conflictingCompanyPages, mergeCompanyPageJobs, remainingCompanyPages };
