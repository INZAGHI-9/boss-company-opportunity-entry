function companyHomeUrl(brandId) {
  return `https://www.zhipin.com/gongsi/${brandId}.html`;
}

function companyJobUrl(brandId, page = 1) {
  const url = new URL(`https://www.zhipin.com/gongsi/job/${brandId}.html`);
  if (page > 1) url.searchParams.set("page", String(page));
  return url.toString();
}

export { companyHomeUrl, companyJobUrl };
