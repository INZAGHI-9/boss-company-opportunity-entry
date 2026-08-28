function companyHomeUrl(brandId) {
  return `https://www.zhipin.com/gongsi/${brandId}.html`;
}

function companyJobUrl(brandId, page = 1) {
  const url = new URL(`https://www.zhipin.com/gongsi/job/${brandId}.html`);
  if (page > 1) url.searchParams.set("page", String(page));
  return url.toString();
}

function companyPositionJobUrl(href, page = 1) {
  const url = new URL(href, "https://www.zhipin.com");
  if (page > 1) url.searchParams.set("page", String(page));
  else url.searchParams.delete("page");
  return url.toString();
}

export { companyHomeUrl, companyJobUrl, companyPositionJobUrl };
