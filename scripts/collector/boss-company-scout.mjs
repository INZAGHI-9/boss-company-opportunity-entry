#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  attachSinglePage,
  closePage,
  enforceSinglePage,
  evaluate,
  getPageState,
  launchOrConnectChrome,
  minimizeDedicatedChromeWindow,
  navigate,
  openAdditionalPage,
  sleep,
  stopDedicatedChrome,
} from "./cdp-client.mjs";
import { createAnalysisInput } from "./analysis-input.mjs";
import { createJsonCheckpointWriter } from "./checkpoint-writer.mjs";
import { companyHomeUrl, companyJobUrl } from "./company-navigation.mjs";
import { conflictingCompanyPages, mergeCompanyPageJobs, remainingCompanyPages } from "./company-page-batch.mjs";
import { waitForResult } from "./page-readiness.mjs";
import { MAX_CONCURRENT_PAGES, runRecoveryQueue } from "./recovery-queue.mjs";

const CODEX_HOME = process.env.CODEX_HOME || path.join(homedir(), ".codex");
const DATA_ROOT = path.resolve(process.env.BOSS_OPPORTUNITY_ENTRY_HOME || path.join(CODEX_HOME, "boss-company-opportunity-entry"));
const PROFILE_DIR = path.join(DATA_ROOT, ".boss-profile");
const OUTPUT_ROOT = path.join(DATA_ROOT, "output");
const BOSS_HOME = "https://www.zhipin.com/";
const SEARCH_JOB_LIST_PATH = "/wapi/zpgeek/search/joblist.json";
const COMPANY_JOB_LIST_PATH = "/wapi/zpgeek/brand/job/querylist.json";
const JOB_DETAIL_PATH = "/wapi/zpgeek/seo/job/detail.json";

function parseArgs(argv) {
  const options = {
    company: "",
    companyName: "",
    brandId: "",
    discoverOnly: false,
    loginOnly: false,
    checkLogin: false,
    stopChrome: false,
    background: false,
    maxPages: 50,
    maxJobs: null,
    minDelay: 2_500,
    maxDelay: 4_500,
    cdpPort: 9222,
    parallelPages: true,
    parallelDetails: true,
    previousJobs: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--company" && next) options.company = next, index += 1;
    else if (arg === "--company-name" && next) options.companyName = next, index += 1;
    else if (arg === "--brand-id" && next) options.brandId = next, index += 1;
    else if (arg === "--max-pages" && next) options.maxPages = Number(next), index += 1;
    else if (arg === "--max-jobs" && next) options.maxJobs = Number(next), index += 1;
    else if (arg === "--cdp-port" && next) options.cdpPort = Number(next), index += 1;
    else if (arg === "--parallel-pages") options.parallelPages = true;
    else if (arg === "--parallel-details") options.parallelDetails = true;
    else if (arg === "--previous-jobs" && next) options.previousJobs = next, index += 1;
    else if (arg === "--previous-jobs") throw new Error("--previous-jobs 需要上一期 jobs.json 路径");
    else if (arg === "--discover-only") options.discoverOnly = true;
    else if (arg === "--login-only") options.loginOnly = true;
    else if (arg === "--check-login") options.checkLogin = true;
    else if (arg === "--stop-chrome") options.stopChrome = true;
    else if (arg === "--background") options.background = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }

  for (const [key, label] of [["maxPages", "--max-pages"], ["cdpPort", "--cdp-port"]]) {
    if (!Number.isInteger(options[key]) || options[key] < 1) throw new Error(`${label} 必须是正整数`);
  }
  if (options.maxJobs !== null && (!Number.isInteger(options.maxJobs) || options.maxJobs < 1)) {
    throw new Error("--max-jobs 必须是正整数");
  }
  if (options.background && options.loginOnly) throw new Error("--background 不能与 --login-only 一起使用；登录必须在前台 Chrome 完成");
  return options;
}

function printHelp() {
  console.log(`
用法:
  node boss-company-scout.mjs --login-only
  node boss-company-scout.mjs --company "美图" --discover-only
  node boss-company-scout.mjs --company "美图" --brand-id "候选公司ID"

选项:
  --company NAME        全国搜索关键词
  --company-name NAME   按页面公司名称精确选择候选公司
  --brand-id ID         按 Boss 公司 ID 精确选择，优先级最高
  --discover-only       只输出候选公司名称和公司 ID
  --max-pages N         公司职位页安全上限，默认 50 页
  --max-jobs N          最多读取多少个详情；默认读取全部匹配岗位
  --previous-jobs FILE  与上一次本工具输出的 jobs.json 比较，输出岗位变化清单
  --cdp-port N          专用 Chrome CDP 端口，默认 9222
  --parallel-pages      默认启用；按公司岗位实际分页并行加载剩余页
  --parallel-details    默认启用；按岗位分页并行读取各页 JD
  --background           使用最小化的正常 Chrome 后台采集；遇到安全验证后改回前台模式恢复
  --login-only          打开专用 Chrome 的 Boss 页面供手动登录
  --check-login         只检查专用 Chrome 的 Boss 登录态
  --stop-chrome         关闭本工具的专用 Chrome

环境变量:
  BOSS_OPPORTUNITY_ENTRY_HOME  登录档案和输出目录，默认 ~/.codex/boss-company-opportunity-entry
  BOSS_CHROME_PATH      Chrome 可执行文件路径；自动发现失败时设置
`);
}

function slugify(value) {
  return value.trim().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-|-$/g, "") || "company";
}

function normalizeLocation(value) {
  return String(value || "")
    .split("·")
    .map(part => part.trim())
    .filter(Boolean)
    .join("·");
}

function normalizeCompany(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[（）()·•]/g, "")
    .replace(/股份有限公司|有限责任公司|有限公司|集团/g, "")
    .toLowerCase();
}

function randomDelay(options, factor = 1) {
  const milliseconds = options.minDelay
    + Math.floor(Math.random() * (options.maxDelay - options.minDelay + 1));
  return sleep(Math.round(milliseconds * factor));
}

function assertPageAccessible(state) {
  const text = state?.bodyText || "";
  if (!state?.url || state.url === "about:blank") {
    throw new Error("Boss 页面变成了 about:blank，已停止，避免继续产生请求");
  }
  if (/安全验证|访问异常|请完成验证|环境存在异常|访问频繁|captcha/i.test(text)) {
    throw new Error("Boss 要求安全验证或限制访问。请手动处理或稍后再试；脚本不会绕过验证");
  }
  if (/扫码登录|手机号登录|登录后查看|登录\/注册/.test(text)) {
    throw new Error("专用 Chrome 的 Boss 登录状态不可用，请先运行 --login-only");
  }
}

function assertJobListResponse(data) {
  const code = data?.code;
  const message = String(data?.message || data?.msg || "");
  if (code !== undefined && code !== 0) {
    if ([31, 37].includes(Number(code)) || /环境|异常|频繁|验证|限制/.test(message)) {
      throw new Error(`Boss 返回限制状态 code=${code}${message ? `：${message}` : ""}`);
    }
    throw new Error(`Boss 岗位接口返回 code=${code}${message ? `：${message}` : ""}`);
  }
  const jobs = data?.zpData?.jobList;
  if (!Array.isArray(jobs)) throw new Error("Boss 岗位接口响应缺少 zpData.jobList");
  if (jobs.length && !jobs.some(job => job.salaryDesc)) {
    throw new Error("岗位接口没有返回明文薪资，专用 Chrome 可能尚未登录");
  }
}

function assertCompanyJobListResponse(data, brandId) {
  assertJobListResponse(data);
  const mismatched = data.zpData.jobList.find(job => job.encryptBrandId !== brandId);
  if (mismatched) throw new Error("公司岗位接口混入了其他公司 ID，已停止采集");
}

function assertJobDetailResponse(data, jobId) {
  const code = data?.code;
  const message = String(data?.message || data?.msg || "");
  if (code !== undefined && code !== 0) {
    throw new Error(`Boss 岗位详情接口返回 code=${code}${message ? `：${message}` : ""}`);
  }
  if (!data?.zpData?.jobInfo?.postDescription) throw new Error("Boss 岗位详情接口缺少完整职位描述");
  if (jobId && data.zpData.jobInfo.encryptId !== jobId) {
    throw new Error(`岗位详情 ID 不匹配：期望 ${jobId}，实际 ${data.zpData.jobInfo.encryptId || "空"}`);
  }
}

class ResponseCapture {
  constructor(client, sessionId, urlPath, label) {
    this.client = client;
    this.sessionId = sessionId;
    this.urlPath = urlPath;
    this.label = label;
    this.requests = new Set();
    this.queue = [];
    this.waiters = [];
    this.disposeListener = client.onEvent(message => this.#onEvent(message));
  }

  dispose() {
    this.disposeListener();
    for (const waiter of this.waiters) waiter.reject(new Error(`${this.label}监听已停止`));
    this.waiters = [];
  }

  async #onEvent(message) {
    if (message.sessionId !== this.sessionId) return;
    const { method, params = {} } = message;
    if (method === "Network.responseReceived" && params.response?.url?.includes(this.urlPath)) {
      this.requests.add(params.requestId);
      return;
    }
    if (method !== "Network.loadingFinished" || !this.requests.has(params.requestId)) return;
    this.requests.delete(params.requestId);
    try {
      const result = await this.client.send(
        "Network.getResponseBody",
        { requestId: params.requestId },
        this.sessionId,
      );
      const body = result.base64Encoded
        ? Buffer.from(result.body, "base64").toString("utf8")
        : result.body;
      this.#publish(JSON.parse(body));
    } catch (error) {
      this.#publish({ __captureError: error.message });
    }
  }

  #publish(data) {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(data);
    } else {
      this.queue.push(data);
    }
  }

  async next(timeout, trigger) {
    if (this.queue.length) return this.queue.shift();
    let waiter;
    const response = new Promise((resolve, reject) => {
      waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(item => item !== waiter);
        reject(new Error(`等待${this.label}响应超时（${timeout}ms）`));
      }, timeout);
      this.waiters.push(waiter);
    });
    try {
      await trigger();
      const data = await response;
      if (data?.__captureError) throw new Error(`读取${this.label}响应失败：${data.__captureError}`);
      return data;
    } catch (error) {
      clearTimeout(waiter.timer);
      this.waiters = this.waiters.filter(item => item !== waiter);
      throw error;
    }
  }

  async nextMatching(timeout, trigger, predicate) {
    const deadline = Date.now() + timeout;
    await trigger();
    while (Date.now() < deadline) {
      const data = await this.next(Math.max(1, deadline - Date.now()), async () => {});
      if (predicate(data)) return data;
    }
    throw new Error(`等待匹配的${this.label}响应超时（${timeout}ms）`);
  }
}

function mapApiJob(raw) {
  const jobId = String(raw.encryptJobId || "");
  const brandId = String(raw.encryptBrandId || "");
  return {
    jobId,
    brandId,
    company: raw.brandName || "",
    title: raw.jobName || "",
    salary: raw.salaryDesc || "",
    city: raw.cityName || "",
    district: raw.areaDistrict || "",
    businessDistrict: raw.businessDistrict || "",
    location: [raw.cityName, raw.areaDistrict, raw.businessDistrict].filter(Boolean).join("·"),
    experience: raw.jobExperience || "不限",
    degree: raw.jobDegree || "不限",
    skills: raw.skills || [],
    labels: raw.jobLabels || [],
    benefits: raw.welfareList || [],
    companyScale: raw.brandScaleName || "",
    companyStage: raw.brandStageName || "",
    companyIndustry: raw.brandIndustry || "",
    recruiterTitle: raw.bossTitle || "",
    recruiterOnline: Boolean(raw.bossOnline),
    securityId: raw.securityId || "",
    lid: raw.lid || "",
    jobLink: jobId ? `https://www.zhipin.com/job_detail/${jobId}.html` : "",
    companyLink: brandId ? `https://www.zhipin.com/gongsi/${brandId}.html` : "",
  };
}

async function collectSearchResults(client, page, options) {
  const capture = new ResponseCapture(client, page.sessionId, SEARCH_JOB_LIST_PATH, "搜索岗位接口");
  try {
    const data = await capture.next(35_000, async () => {
      console.log(`打开候选定位搜索：${options.company}`);
      const url = new URL("https://www.zhipin.com/web/geek/job");
      url.searchParams.set("query", options.company);
      url.searchParams.set("city", "100010000");
      url.searchParams.set("page", "1");
      await navigate(client, page.sessionId, url.toString());
    });
    assertJobListResponse(data);
    const jobs = data.zpData.jobList.map(mapApiJob).filter(job => job.jobId && job.brandId);
    console.log(`候选定位响应：${jobs.length} 条岗位，用于识别公司主体`);
    return {
      jobs,
      coverage: { pagesCaptured: 1, complete: true, scope: "candidate_lookup_first_page" },
    };
  } finally {
    capture.dispose();
  }
}

function isManualRecoveryError(error, failure = {}) {
  const message = error?.message || "";
  if (/登录状态不可用/i.test(message)) return true;
  if (/安全验证|限制访问|about:blank/i.test(message)) return (failure.attempts || 1) > 1;
  return false;
}

function recoveryError(context, paused) {
  const first = paused[0];
  return new Error(
    `${context}已暂停：${first?.error?.message || "需要人工恢复"}。已采集内容已写入断点；请在保留的 Boss 页面完成验证或重新登录后，使用同一命令继续。`,
  );
}

function companyPageSummaryExpression(brandId, companyName, sourcePage = 1) {
  return `(() => {
    const clean = value => (value?.innerText || value?.textContent || "").trim();
    const normalizeLocation = value => String(value || "").split("·").map(part => part.trim()).filter(Boolean).join("·");
    const cards = [...document.querySelectorAll(".job-card-box")];
    const pageText = document.body?.innerText || "";
    const advertisedTotal = Number(
      pageText.match(/(\\d+)\\s*在招职位/)?.[1]
      || pageText.match(/招聘职位\\s*[（(](\\d+)[）)]/)?.[1]
      || 0
    );
    const pageCompany = document.title.match(/「(.+?)招聘」/)?.[1] || ${JSON.stringify(companyName)};
    return {
      advertisedTotal,
      company: pageCompany,
      jobs: cards.map((card, sourceIndex) => {
        const anchor = card.querySelector("a.job-name[href*='/job_detail/']");
        const href = anchor?.getAttribute("href") || "";
        const jobId = href.match(/\\/job_detail\\/([^/.]+)\\.html/)?.[1] || "";
        const tags = [...card.querySelectorAll(".tag-list li")].map(clean).filter(Boolean);
        const locationParts = [...card.querySelectorAll(".company-location a, .company-location span")]
          .map(clean)
          .map(part => part.replace(/^[·\\s]+/, ""))
          .filter(Boolean);
        const recruiterText = clean(card.querySelector(".boss-name"));
        const recruiterParts = recruiterText.split("·");
        return {
          jobId,
          brandId: ${JSON.stringify(brandId)},
          company: pageCompany,
          title: clean(anchor),
          salary: clean(card.querySelector(".job-salary")),
          city: locationParts[0] || "",
          district: locationParts[1] || "",
          businessDistrict: locationParts[2] || "",
          location: normalizeLocation(locationParts.join("·")),
          experience: tags[0] || "不限",
          degree: tags[1] || "不限",
          skills: [],
          labels: tags,
          benefits: [],
          recruiter: recruiterParts[0] || "",
          recruiterTitle: recruiterParts.slice(1).join("·"),
          recruiterOnline: Boolean(card.querySelector(".boss-online-icon")),
          jobLink: jobId ? "https://www.zhipin.com/job_detail/" + jobId + ".html" : "",
          companyLink: ${JSON.stringify(`https://www.zhipin.com/gongsi/${brandId}.html`)},
          sourcePage: ${sourcePage},
          sourceIndex
        };
      }).filter(job => job.jobId)
    };
  })()`;
}

async function clickCompanyNextPage(client, sessionId) {
  const clicked = await evaluate(client, sessionId, `(() => {
    const next = document.querySelector('a[ka="page-next"]');
    if (!next || next.classList.contains("disabled")) return false;
    next.click();
    return true;
  })()`);
  if (!clicked) throw new Error("公司岗位页没有可用的下一页按钮");
}

async function collectParallelCompanyPage(client, candidate, sourcePage, attempt = 1, isLastPage = false) {
  const page = await openAdditionalPage(client);
  let preservePage = false;
  try {
    await navigate(
      client,
      page.sessionId,
      companyJobUrl(candidate.brandId, sourcePage),
    );
    await sleep(500);
    assertPageAccessible(await getPageState(client, page.sessionId));
    const renderedPage = await evaluate(
      client,
      page.sessionId,
      companyPageSummaryExpression(candidate.brandId, candidate.company, sourcePage),
    );
    const jobs = mergeCompanyPageJobs(renderedPage.jobs);
    if (!jobs.length) throw new Error(`公司岗位第 ${sourcePage} 页未渲染岗位卡片`);
    return {
      sourcePage,
      jobs,
      apiTotal: null,
      hasMore: !isLastPage,
    };
  } catch (error) {
    preservePage = isManualRecoveryError(error, { attempts: attempt });
    throw error;
  } finally {
    if (!preservePage) await closePage(client, page.targetId);
  }
}

async function collectCompanyJobs(client, page, options, candidate, checkpointPath) {
  console.log(`打开公司主页：${candidate.company}（${candidate.brandId}）`);
  await navigate(client, page.sessionId, companyHomeUrl(candidate.brandId));
  await sleep(1_200);
  assertPageAccessible(await getPageState(client, page.sessionId));

  console.log(`打开公司全部岗位：${candidate.company}（${candidate.brandId}）`);
  await navigate(client, page.sessionId, companyJobUrl(candidate.brandId));
  await sleep(1_200);
  assertPageAccessible(await getPageState(client, page.sessionId));

  const firstPage = await evaluate(
    client,
    page.sessionId,
    companyPageSummaryExpression(candidate.brandId, candidate.company),
  );
  if (firstPage.company) candidate.company = firstPage.company;
  const jobs = new Map(firstPage.jobs.map(job => [job.jobId, job]));
  let advertisedTotal = firstPage.advertisedTotal;
  let apiTotal = null;
  let pagesCaptured = 1;
  let lastHasMore = advertisedTotal > jobs.size;
  console.log(`公司岗位第 1 页：${firstPage.jobs.length} 条，页面公布 ${advertisedTotal || "未知"} 条`);

  const pageResults = new Map([[1, {
    sourcePage: 1,
    jobs: firstPage.jobs,
    apiTotal: null,
    hasMore: lastHasMore,
  }]]);
  const failures = new Map();
  const existingCheckpoint = await loadJson(checkpointPath, null);
  if (existingCheckpoint?.candidate?.brandId === candidate.brandId
    && existingCheckpoint?.advertisedTotal === advertisedTotal) {
    for (const result of existingCheckpoint.pages || []) {
      if (result?.sourcePage > 1 && Array.isArray(result.jobs) && result.jobs.length) {
        pageResults.set(result.sourcePage, result);
      }
    }
  }
  const listingCheckpointWriter = createJsonCheckpointWriter(checkpointPath, () => ({
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      candidate,
      advertisedTotal,
      apiTotal,
      pages: [...pageResults.values()].sort((left, right) => left.sourcePage - right.sourcePage),
      failures: [...failures.entries()].map(([sourcePage, failure]) => ({
        sourcePage,
        attempts: failure.attempts,
        error: failure.error.message,
      })),
    }));
  const persistListingCheckpoint = () => listingCheckpointWriter.persist();

  const parallelPages = remainingCompanyPages({
    advertisedTotal,
    firstPageSize: firstPage.jobs.length,
    maxPages: options.maxPages,
  });
  if (options.parallelPages && parallelPages.length) {
    const capturePages = async sourcePages => {
      console.log(`并行加载公司岗位第 ${parallelPages[0]}-${parallelPages.at(-1)} 页：最多 ${MAX_CONCURRENT_PAGES} 个标签页，待读取 ${sourcePages.length} 页`);
      const recovery = await runRecoveryQueue(sourcePages, {
        concurrency: MAX_CONCURRENT_PAGES,
        worker: async (sourcePage, { attempt }) => {
          if (attempt > 1) console.log(`恢复公司岗位第 ${sourcePage} 页，第 ${attempt} 次尝试`);
          return collectParallelCompanyPage(
            client,
            candidate,
            sourcePage,
            attempt,
            sourcePage === parallelPages.at(-1),
          );
        },
        isManualRecoveryError,
        onAttemptError: async failure => {
          failures.set(failure.item, failure);
          await persistListingCheckpoint();
        },
        onCompleted: async ({ value }) => {
          pageResults.set(value.sourcePage, value);
          failures.delete(value.sourcePage);
          apiTotal = value.apiTotal || apiTotal;
          await persistListingCheckpoint();
        },
      });
      if (recovery.paused.length) throw recoveryError("公司岗位列表采集", recovery.paused);
    };
    const rebuildJobs = () => {
      jobs.clear();
      pagesCaptured = 0;
      for (const result of [...pageResults.values()].sort((left, right) => left.sourcePage - right.sourcePage)) {
        for (const job of result.jobs) jobs.set(job.jobId, job);
        pagesCaptured = Math.max(pagesCaptured, result.sourcePage);
        apiTotal = result.apiTotal || apiTotal;
        lastHasMore = result.hasMore;
        if (result.sourcePage > 1) console.log(`公司岗位第 ${result.sourcePage} 页：${result.jobs.length} 条，累计去重 ${jobs.size}/${advertisedTotal || apiTotal || "?"}`);
      }
    };

    await persistListingCheckpoint();
    await capturePages(parallelPages.filter(sourcePage => !pageResults.has(sourcePage)));
    rebuildJobs();
    while (jobs.size !== advertisedTotal || lastHasMore) {
      const conflictPages = conflictingCompanyPages([...pageResults.values()]);
      const pagesToRefresh = conflictPages.length ? conflictPages : parallelPages;
      console.log(`公司岗位页去重 ${jobs.size}/${advertisedTotal}，仅恢复第 ${pagesToRefresh.join("、")} 页`);
      for (const sourcePage of pagesToRefresh) pageResults.delete(sourcePage);
      await persistListingCheckpoint();
      await sleep(1_000);
      await capturePages(pagesToRefresh);
      rebuildJobs();
    }
  } else if (lastHasMore) {
    const capture = new ResponseCapture(client, page.sessionId, COMPANY_JOB_LIST_PATH, "公司岗位接口");
    try {
      while (pagesCaptured < options.maxPages && lastHasMore) {
        await randomDelay(options, 0.55);
        await enforceSinglePage(client, page.targetId);
        const data = await capture.next(25_000, () => clickCompanyNextPage(client, page.sessionId));
        assertCompanyJobListResponse(data, candidate.brandId);
        const sourcePage = pagesCaptured + 1;
        await sleep(500);
        const renderedPage = await evaluate(
          client,
          page.sessionId,
          companyPageSummaryExpression(candidate.brandId, candidate.company, sourcePage),
        );
        const apiById = new Map(data.zpData.jobList.map(mapApiJob).map(job => [job.jobId, job]));
        const pageJobs = renderedPage.jobs.map(job => ({ ...apiById.get(job.jobId), ...job }));
        if (!pageJobs.length) throw new Error(`公司岗位第 ${sourcePage} 页未渲染岗位卡片`);
        for (const job of pageJobs) jobs.set(job.jobId, job);
        pagesCaptured = sourcePage;
        apiTotal = Number(data.zpData.totalCount || data.zpData.jobCount || apiTotal || 0) || apiTotal;
        if (!advertisedTotal && apiTotal) advertisedTotal = apiTotal;
        lastHasMore = data.zpData.hasMore === true;
        console.log(`公司岗位第 ${sourcePage} 页：${pageJobs.length} 条，累计去重 ${jobs.size}/${advertisedTotal || apiTotal || "?"}`);
      }
    } finally {
      capture.dispose();
    }
  }

  const expectedTotal = advertisedTotal || apiTotal || jobs.size;
  const complete = jobs.size === expectedTotal && !lastHasMore;
  const coverage = {
    source: "company-job-list",
    advertisedTotal,
    apiTotal,
    collectedTotal: jobs.size,
    pagesCaptured,
    complete,
    lastHasMore,
    maxPages: options.maxPages,
  };
  if (!complete) {
    throw new Error(
      `公司岗位全集不完整：页面公布 ${expectedTotal} 条，实际去重 ${jobs.size} 条，已读取 ${pagesCaptured} 页`,
    );
  }
  return { jobs: [...jobs.values()], coverage };
}

function companyCandidates(jobs, query) {
  const queryName = normalizeCompany(query);
  const groups = new Map();
  for (const job of jobs) {
    const companyName = normalizeCompany(job.company);
    if (!companyName.includes(queryName) && !queryName.includes(companyName)) continue;
    const key = job.brandId;
    const current = groups.get(key) || {
      brandId: key,
      company: job.company,
      count: 0,
      cities: new Set(),
      companyLink: job.companyLink,
    };
    current.count += 1;
    if (job.city) current.cities.add(job.city);
    groups.set(key, current);
  }
  return [...groups.values()]
    .map(candidate => ({ ...candidate, cities: [...candidate.cities].sort() }))
    .sort((left, right) => right.count - left.count || left.company.localeCompare(right.company));
}

function selectCompany(jobs, candidates, options) {
  let matches = candidates;
  if (options.brandId) matches = candidates.filter(candidate => candidate.brandId === options.brandId);
  else if (options.companyName) {
    const requested = normalizeCompany(options.companyName);
    matches = candidates.filter(candidate => normalizeCompany(candidate.company) === requested);
  }
  if (matches.length !== 1) {
    const reason = matches.length ? "仍有多个公司主体" : "没有匹配的公司主体";
    throw new Error(`${reason}。请先使用 --discover-only，再通过 --brand-id 精确指定`);
  }
  const selected = matches[0];
  return {
    candidate: selected,
    jobs: jobs.filter(job => job.brandId === selected.brandId),
  };
}

function inlineExtractionExpression(job) {
  return `(() => {
    const source = ${JSON.stringify(job)};
    const text = element => (element?.innerText || element?.textContent || "").trim();
    const first = selectors => {
      for (const selector of selectors) {
        const value = text(document.querySelector(selector));
        if (value) return value;
      }
      return "";
    };
    const list = selectors => {
      for (const selector of selectors) {
        const values = [...document.querySelectorAll(selector)].map(text).filter(Boolean);
        if (values.length) return [...new Set(values)];
      }
      return [];
    };
    return {
      ...source,
      finalUrl: source.jobLink,
      title: first([".job-detail-header .job-name", ".job-detail-info .job-name"]) || source.title,
      salary: first([".job-detail-header .salary", ".job-detail-info .salary"]) || source.salary,
      description: first([
        ".job-detail-body .desc-wrapper .desc",
        ".job-detail-body .desc",
        ".job-detail-section .job-sec-text",
      ]),
      address: first([".job-detail-body .job-address-desc"]),
      recruiter: first([".job-detail-body .job-boss-info .name"]) || source.recruiter,
      recruiterTitle: first([".job-detail-body .boss-info-attr"]) || source.recruiterTitle,
      requirementTags: list([".job-detail-body .job-label-list li"]),
      capturedAt: new Date().toISOString()
    };
  })()`;
}

function mapDetailResponse(job, data) {
  assertJobDetailResponse(data, job.jobId);
  const detail = data.zpData;
  const info = detail.jobInfo;
  const boss = detail.bossInfo || {};
  const brand = detail.brandComInfo || {};
  return {
    ...job,
    securityId: detail.securityId || job.securityId,
    lid: detail.lid || job.lid,
    title: info.jobName || job.title,
    salary: info.salaryDesc || job.salary,
    city: info.locationName || job.city,
    location: normalizeLocation([info.locationName || job.city, job.district, job.businessDistrict].join("·")),
    experience: info.experienceName || job.experience,
    degree: info.degreeName || job.degree,
    skills: info.showSkills || job.skills || [],
    benefits: brand.labels || job.benefits || [],
    companyScale: brand.scaleName || job.companyScale || "",
    companyStage: brand.stageName || job.companyStage || "",
    companyIndustry: brand.industryName || job.companyIndustry || "",
    description: info.postDescription,
    address: info.address || "",
    jobStatus: info.jobStatusDesc || "",
    recruiter: boss.name || job.recruiter || "",
    recruiterTitle: boss.title || job.recruiterTitle || "",
    recruiterActive: boss.activeTimeDesc || "",
    recruiterOnline: Boolean(boss.bossOnline),
    requirementTags: info.showSkills || [],
    finalUrl: job.jobLink,
    capturedAt: new Date().toISOString(),
  };
}

async function clickCompanyJobCard(client, sessionId, jobId) {
  const result = await waitForResult(async () => evaluate(client, sessionId, `(() => {
    const cards = [...document.querySelectorAll(".job-card-box")];
    const card = cards.find(item => item.querySelector("a.job-name")?.href.includes(${JSON.stringify(jobId)}));
    if (!card) return null;
    const active = card.classList.contains("active");
    if (!active) card.click();
    return { active };
  })()`), { label: `岗位卡片 ${jobId}` });
  return result.active;
}

async function extractInlineDetail(client, page, job, capture, parallel = false) {
  if (!parallel) await enforceSinglePage(client, page.targetId);
  const activeCard = await waitForResult(async () => evaluate(client, page.sessionId, `(() => {
    const card = [...document.querySelectorAll(".job-card-box")]
      .find(item => item.querySelector("a.job-name")?.href.includes(${JSON.stringify(job.jobId)}));
    return card ? { active: card.classList.contains("active") } : null;
  })()`), { label: `岗位卡片 ${job.jobId}` });
  let detail;
  if (activeCard.active) {
    detail = await evaluate(client, page.sessionId, inlineExtractionExpression(job));
  } else {
    try {
      const data = await capture.nextMatching(
        20_000,
        () => clickCompanyJobCard(client, page.sessionId, job.jobId),
        response => response?.zpData?.jobInfo?.encryptId === job.jobId
          && Boolean(response.zpData.jobInfo.postDescription),
      );
      detail = mapDetailResponse(job, data);
    } catch {
      detail = await waitForResult(async () => {
        const fallback = await evaluate(client, page.sessionId, inlineExtractionExpression(job));
        return fallback.description ? fallback : null;
      }, { label: `岗位详情 ${job.jobId}` });
    }
  }
  assertPageAccessible(await getPageState(client, page.sessionId));
  if (!detail.description) detail.detailWarning = "未从当前详情页定位到职位描述";
  return detail;
}

async function collectCompanyPageDetails(client, page, options, candidate, targets, details, parallel, persistCheckpoint) {
  const pendingTargets = targets.filter(job => !details.has(job.jobId));
  if (!pendingTargets.length) return;
  const capture = new ResponseCapture(client, page.sessionId, JOB_DETAIL_PATH, "岗位详情接口");
  try {
    await navigate(client, page.sessionId, companyJobUrl(candidate.brandId, pendingTargets[0].sourcePage));
    await sleep(500);
    assertPageAccessible(await getPageState(client, page.sessionId));
    for (const job of pendingTargets) {
      const index = options.allTargets.findIndex(target => target.jobId === job.jobId);
      console.log(`读取第 ${job.sourcePage} 页详情 ${index + 1}/${options.allTargets.length}: ${job.title}`);
      const detail = await extractInlineDetail(client, page, job, capture, parallel);
      if (!detail.description) throw new Error(`岗位详情页没有读取到职位描述：${job.jobId}`);
      details.set(job.jobId, detail);
      await persistCheckpoint();
      if (!parallel) await randomDelay(options);
    }
  } finally {
    capture.dispose();
  }
}

function createDetailCheckpointWriter(checkpointPath, details) {
  const writer = createJsonCheckpointWriter(checkpointPath, () => [...details.values()]);
  const persist = () => writer.persist();
  persist.flush = () => writer.flush();
  return persist;
}

async function collectCompanyDetails(client, page, options, candidate, jobs, details, checkpointPath) {
  const targets = options.maxJobs ? jobs.slice(0, options.maxJobs) : jobs;
  const pending = targets.filter(job => !details.has(job.jobId));
  const persistCheckpoint = createDetailCheckpointWriter(checkpointPath, details);
  if (options.parallelDetails && pending.length) {
    const groups = new Map();
    for (const job of pending) {
      const group = groups.get(job.sourcePage) || [];
      group.push(job);
      groups.set(job.sourcePage, group);
    }
    const pageNumbers = [...groups.keys()].sort((left, right) => left - right);
    console.log(`按岗位分页并行读取详情：最多 ${MAX_CONCURRENT_PAGES} 个标签页，${pending.length} 份 JD`);
    const parallelOptions = { ...options, allTargets: targets };
    const recovery = await runRecoveryQueue(pageNumbers, {
      concurrency: MAX_CONCURRENT_PAGES,
      worker: async (pageNumber, { attempt }) => {
        const detailPage = await openAdditionalPage(client);
        let preservePage = false;
        try {
          if (attempt > 1) console.log(`恢复第 ${pageNumber} 页 JD，第 ${attempt} 次尝试`);
          await collectCompanyPageDetails(
            client,
            detailPage,
            parallelOptions,
            candidate,
            groups.get(pageNumber),
            details,
            true,
            persistCheckpoint,
          );
        } catch (error) {
          preservePage = isManualRecoveryError(error, { attempts: attempt });
          throw error;
        } finally {
          if (!preservePage) await closePage(client, detailPage.targetId);
        }
      },
      isManualRecoveryError,
      onAttemptError: async ({ item, attempts, error }) => {
        console.log(`第 ${item} 页 JD 第 ${attempts} 次失败：${error.message}`);
        await persistCheckpoint();
      },
    });
    await persistCheckpoint.flush();
    if (recovery.paused.length) throw recoveryError("岗位 JD 采集", recovery.paused);
    return targets;
  }
  const pageNumbers = [...new Set(targets.filter(job => !details.has(job.jobId)).map(job => job.sourcePage))]
    .sort((left, right) => left - right);
  const capture = new ResponseCapture(client, page.sessionId, JOB_DETAIL_PATH, "岗位详情接口");
  try {
    for (const pageNumber of pageNumbers) {
      await navigate(client, page.sessionId, companyJobUrl(candidate.brandId, pageNumber));
      await sleep(1_200);
      assertPageAccessible(await getPageState(client, page.sessionId));
      const pageTargets = targets.filter(job => job.sourcePage === pageNumber && !details.has(job.jobId));
      for (const job of pageTargets) {
        const index = targets.findIndex(target => target.jobId === job.jobId);
        console.log(`读取同页详情 ${index + 1}/${targets.length}: ${job.title} | ${job.location}`);
        const detail = await extractInlineDetail(client, page, job, capture);
        details.set(job.jobId, detail);
        await persistCheckpoint();
        await randomDelay(options);
      }
    }
  } finally {
    capture.dispose();
  }
  await persistCheckpoint.flush();
  return targets;
}

async function atomicWrite(filePath, content) {
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, filePath);
}

function writeJson(filePath, value) {
  return atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function loadJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function countBy(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function jobFamily(job) {
  const rules = [
    ["职能与支持", /人力|招聘|财务|法务|行政|采购|审计|战略|总助|助理|客服/],
    ["市场与商业化", /市场|营销|品牌|商务|销售|渠道|广告|投放|公关|客户成功/],
    ["运营与内容", /运营|用户增长|增长|内容|社区|直播|电商|编辑/],
    ["产品与项目", /产品|项目经理|项目管理|解决方案/],
    ["研发与数据", /算法|研发|开发|工程师|架构|测试|客户端|前端|后端|服务端|运维|数据|安全|技术|机器学习|C\+\+/i],
    ["设计与创意", /设计|视觉|交互|体验|创意|美术|剪辑|摄影/],
  ];
  const titleMatch = rules.find(([, pattern]) => pattern.test(job.title || ""));
  if (titleMatch) return titleMatch[0];
  return "其他";
}

function workMode(job) {
  const source = `${job.title} ${job.description || ""}`;
  if (/供稿|长期兼职|兼职设计师|远程接单|无需坐班|副业/.test(source)) return "灵活供稿/兼职";
  if (/实习/.test(job.title || "") || /[45]天\/周/.test(job.experience || "") || /在校/.test(job.experience || "")) {
    return "实习岗位";
  }
  return "社招岗位";
}

function qualityNote(job) {
  const deadline = String(job.description || "").match(/招聘截止时间[：:]?\s*(\d{4}-\d{2}-\d{2})/)?.[1];
  if (deadline && new Date(`${deadline}T23:59:59+08:00`) < new Date()) {
    return `JD 截止日期已过（${deadline}）`;
  }
  if (/半年前活跃/.test(`${job.recruiter || ""} ${job.recruiterActive || ""}`)) return "招聘者半年未活跃";
  return job.detailWarning || "未发现明显异常";
}

function percent(count, total) {
  return total ? `${(count * 100 / total).toFixed(1)}%` : "0.0%";
}

function topTerms(jobs) {
  const counts = new Map();
  for (const job of jobs) {
    const benefits = new Set(job.benefits || []);
    const detailTerms = (job.requirementTags || []).filter(term => !benefits.has(term));
    const terms = new Set([...(job.skills || []), ...(job.labels || []), ...detailTerms]);
    for (const term of terms) {
      const clean = String(term).trim();
      if (clean.length < 2 || /经验|学历|本科|大专|硕士|博士|年|福利|保险|奖金|补助|补贴|五险|团建|工装|旅游|体检|全勤|班车/.test(clean)) continue;
      counts.set(clean, (counts.get(clean) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 20);
}

function analyze(jobs, candidate, coverage) {
  const total = jobs.length;
  const cities = countBy(jobs.map(job => job.city || "未知"));
  const families = countBy(jobs.map(jobFamily));
  const experience = countBy(jobs.map(job => job.experience || "不限"));
  const degrees = countBy(jobs.map(job => job.degree || "不限"));
  const salaries = countBy(jobs.map(job => job.salary || "未标注"));
  const workModes = countBy(jobs.map(workMode));
  const skills = topTerms(jobs);
  const signals = [];
  const familyMap = Object.fromEntries(families);
  const topCity = cities[0];

  if (total <= 5) {
    signals.push(`当前仅检索到 ${total} 个岗位，招聘总量很低，不支持“大规模扩张”判断。`);
  }
  const flexible = jobs.filter(job => workMode(job) === "灵活供稿/兼职").length;
  if (flexible) {
    signals.push(`${flexible}/${total} 个岗位属于远程供稿或兼职招募，更像外部创作者供给，不宜计作常规员工编制。`);
  }
  const stale = jobs.filter(job => qualityNote(job).startsWith("JD 截止日期已过")).length;
  if (stale) {
    signals.push(`${stale} 个岗位的 JD 截止日期早于采集日，虽然仍出现在搜索结果中，但应视为可能未及时下线的存量信息。`);
  }
  if (topCity && topCity[1] / total >= 0.5 && !flexible) {
    signals.push(`岗位有 ${percent(topCity[1], total)} 集中在${topCity[0]}，招聘地域集中度较高。`);
  } else if (topCity && flexible) {
    signals.push(`页面地点显示以${topCity[0]}为主，但其中包含远程供稿岗位，不能直接推断实际办公地域或当地新增编制。`);
  } else if (cities.length >= 4) {
    signals.push(`岗位分布在 ${cities.length} 个城市，人才布局呈多城市特征。`);
  }
  if ((familyMap["研发与数据"] || 0) / total >= 0.4) {
    signals.push(`研发与数据岗位占 ${percent(familyMap["研发与数据"], total)}，当前人才投入明显偏技术能力。`);
  }
  if (((familyMap["产品与项目"] || 0) + (familyMap["设计与创意"] || 0)) / total >= 0.3) {
    const count = (familyMap["产品与项目"] || 0) + (familyMap["设计与创意"] || 0);
    signals.push(`产品、项目与设计岗位合计占 ${percent(count, total)}，产品体验与创意供给是显著需求。`);
  }
  if (((familyMap["运营与内容"] || 0) + (familyMap["市场与商业化"] || 0)) / total >= 0.35) {
    const count = (familyMap["运营与内容"] || 0) + (familyMap["市场与商业化"] || 0);
    signals.push(`运营、内容及商业化岗位合计占 ${percent(count, total)}，增长和业务兑现相关招聘较强。`);
  }
  const senior = jobs.filter(job => /3-5年|5-10年|10年以上/.test(job.experience) || /资深|专家|负责人|总监/.test(job.title)).length;
  if (senior / total >= 0.4) signals.push(`中高经验或资深岗位约占 ${percent(senior, total)}，招聘更偏成熟人才而非大规模初级人才补充。`);
  if (!coverage.complete) signals.push("公司岗位页未完整遍历，当前快照不应视为该公司的全部在招岗位。");
  if (!signals.length) signals.push("当前样本没有形成单一强特征，建议结合下一次快照观察新增、下线与长期在招岗位。");
  return { candidate, total, cities, families, experience, degrees, salaries, workModes, skills, signals, coverage };
}

function markdownTable(rows, headers) {
  if (!rows.length) return "暂无数据";
  const clean = value => String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map(row => `| ${row.map(clean).join(" | ")} |`),
  ].join("\n");
}

function distributionRows(items, total) {
  return items.map(([name, count]) => [name, count, percent(count, total)]);
}

function buildAppendix(jobs, analysis, capturedAt) {
  const coverageText = analysis.coverage.complete
    ? `公司岗位页已完整遍历 ${analysis.coverage.pagesCaptured} 页，去重结果 ${analysis.coverage.collectedTotal}/${analysis.coverage.advertisedTotal}`
    : `公司岗位页仅读取 ${analysis.coverage.pagesCaptured} 页，去重结果 ${analysis.coverage.collectedTotal}/${analysis.coverage.advertisedTotal}`;
  const jobRows = jobs.map(job => [
    job.title,
    job.location || job.address || "",
    job.salary,
    job.experience,
    job.degree,
    jobFamily(job),
    workMode(job),
    qualityNote(job),
    job.finalUrl || job.jobLink,
  ]);
  return `# ${analysis.candidate.company} Boss 直聘全国岗位快照

- 采集时间：${capturedAt}
- Boss 公司 ID：${analysis.candidate.brandId}
- 公司当前在招岗位：${analysis.total}
- 公司页覆盖：${coverageText}
- 口径：关键词搜索仅用于确认公司主体；岗位全集来自该 Boss 公司 ID 的招聘职位页，并按岗位 ID 去重

## 核心判断

${analysis.signals.map(signal => `- ${signal}`).join("\n")}

## 城市分布

${markdownTable(distributionRows(analysis.cities, analysis.total), ["城市", "岗位数", "占比"])}

## 职能分布

${markdownTable(distributionRows(analysis.families, analysis.total), ["职能", "岗位数", "占比"])}

## 用工形态

${markdownTable(distributionRows(analysis.workModes, analysis.total), ["形态", "岗位数", "占比"])}

## 经验与学历

${markdownTable(distributionRows(analysis.experience, analysis.total), ["经验", "岗位数", "占比"])}

${markdownTable(distributionRows(analysis.degrees, analysis.total), ["学历", "岗位数", "占比"])}

## 薪资分布

${markdownTable(distributionRows(analysis.salaries, analysis.total), ["薪资", "岗位数", "占比"])}

## 高频能力标签

${markdownTable(distributionRows(analysis.skills, analysis.total), ["标签", "涉及岗位", "岗位占比"])}

## 岗位清单

${markdownTable(jobRows, ["岗位", "地点", "薪资", "经验", "学历", "职能", "用工形态", "质量提示", "链接"])}

## 解读边界

- “全国全部岗位”指本次登录状态下，该 Boss 公司招聘职位页公开展示的全部当前岗位，不代表公司的内部编制总表。
- 单次快照适合识别地域和职能重心；判断扩张、收缩或业务转向需要按周或双周比较岗位新增和下线。
- 只有公司页遍历结束且去重岗位数等于页面公布总数时才标记为完整；安全验证或页数上限会使任务失败。
`;
}

function jdExcerpt(job, limit = 120, pattern) {
  const text = String(job.description || "").replace(/\s+/g, " ").trim();
  if (!text) return "未提取到 JD 正文";
  const matchIndex = pattern ? text.search(pattern) : -1;
  if (matchIndex < 0) return text.length > limit ? `${text.slice(0, limit)}...` : text;

  const start = Math.max(0, matchIndex - Math.floor(limit / 3));
  const end = Math.min(text.length, start + limit);
  return `${start ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

async function loadPreviousSnapshot(filePath) {
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 --previous-jobs ${filePath}: ${error.message}`);
  }
  const validCandidate = snapshot?.candidate && typeof snapshot.candidate === "object"
    && typeof snapshot.candidate.brandId === "string" && snapshot.candidate.brandId.trim();
  const validJobs = snapshot?.jobs && Array.isArray(snapshot.jobs)
    && snapshot.jobs.every(job => job && typeof job === "object" && !Array.isArray(job)
      && typeof job.jobId === "string" && job.jobId.trim());
  if (!validCandidate || !validJobs) {
    throw new Error(`无效的 --previous-jobs ${filePath}: 必须是本工具先前输出且包含 candidate.brandId 和 jobs 数组的 jobs.json`);
  }
  return { ...snapshot, filePath };
}

function assertPreviousSnapshotCandidate(snapshot, candidate) {
  if (!snapshot || snapshot.candidate.brandId === candidate.brandId) return;
  throw new Error(
    `--previous-jobs ${snapshot.filePath} 的 Boss 公司 ID ${snapshot.candidate.brandId} 与本期 Boss 公司 ID ${candidate.brandId} 不一致`,
  );
}

function compareSnapshots(currentJobs, previousJobs) {
  const previousById = new Map(previousJobs.map(job => [job.jobId, job]));
  const currentById = new Map(currentJobs.map(job => [job.jobId, job]));
  return {
    added: currentJobs.filter(job => !previousById.has(job.jobId)),
    removed: previousJobs.filter(job => !currentById.has(job.jobId)),
    persistent: currentJobs.filter(job => previousById.has(job.jobId)),
    currentJobs,
    previousJobs,
  };
}

function jobEvidence(job) {
  const link = job.finalUrl || job.jobLink || job.url;
  return link ? `[${job.title || "未标注岗位"}](${link})` : `《${job.title || "未标注岗位"}》`;
}

function topJobs(jobs, limit = 3) {
  return [...new Map(jobs.map(job => [job.jobId || job.title, job])).values()].slice(0, limit);
}

function roleSummary(jobs) {
  const roles = countBy(jobs.map(jobFamily));
  return roles.map(([role, count]) => `${role} ${count} 个`).join("、") || "暂无可归类职能";
}

function analysisChain(observation, crossCheck, interpretation) {
  return `- 观察：${observation}\n- 交叉验证：${crossCheck}\n- 解释：${interpretation}`;
}

function evidenceSection(insight) {
  if (insight.evidenceGroups) {
    return insight.evidenceGroups.map(group => [
      `  - ${group.label}：${group.strength}`,
      ...topJobs(group.jobs).map(job => `    - ${jobEvidence(job)}`),
    ].join("\n")).join("\n") || "  - 无可引用的岗位证据";
  }
  return topJobs(insight.evidence).map(job => `  - ${jobEvidence(job)}`).join("\n") || "  - 无可引用的岗位证据";
}

const EMERGING_CAPABILITY_LENSES = [
  {
    label: "AI 与智能内容能力",
    pattern: /\bAI\b|AIGC|大模型|机器学习|深度学习|多模态|智能体|Agent|计算机视觉|图像算法|数字人/i,
  },
  {
    label: "数据采集与数据工程能力",
    pattern: /数据采集|网络爬虫|反爬|数据清洗|数据挖掘|分布式技术|数据平台/i,
  },
  {
    label: "智能硬件与嵌入式能力",
    pattern: /嵌入式|STM32|RTOS|单片机|硬件|固件|通讯协议/i,
  },
  {
    label: "平台原生内容与数字化运营能力",
    pattern: /抖音|小红书|视频号|直播|MCN|短视频|数字营销|星图/i,
  },
];

function jobSearchText(job) {
  return [
    job.title,
    job.description,
    ...(job.skills || []),
    ...(job.requirementTags || []),
  ].filter(Boolean).join(" ");
}

function jobDirectCapabilityText(job) {
  return [
    job.title,
    ...(job.skills || []),
    ...(job.requirementTags || []),
  ].filter(Boolean).join(" ");
}

function hasJdCapabilityRequirement(job, lens) {
  const description = String(job.description || "");
  const matchIndex = description.search(lens.pattern);
  if (matchIndex < 0) return false;
  const context = description.slice(Math.max(0, matchIndex - 80), matchIndex + 120);
  return /任职要求|岗位要求|熟悉|掌握|具备|精通|经验|开发|研发|算法|模型|训练|推理|工程|设计|实现|搭建|优化|驱动|协议|采集|解析/.test(context);
}

function uniqueJobs(jobs) {
  return [...new Map(jobs.map(job => [job.jobId || job.title, job])).values()];
}

function emergingCapabilitySignals(jobs) {
  return EMERGING_CAPABILITY_LENSES.map(lens => {
    const directJobs = jobs.filter(job => lens.pattern.test(jobDirectCapabilityText(job)));
    const jdRequirementJobs = jobs.filter(job => hasJdCapabilityRequirement(job, lens));
    const descriptionOnlyJobs = jobs.filter(job =>
      !lens.pattern.test(jobDirectCapabilityText(job)) && !hasJdCapabilityRequirement(job, lens) && lens.pattern.test(job.description || ""),
    );
    const titleOrTagOnlyJobs = directJobs.filter(job => !jdRequirementJobs.includes(job));
    const evidenceJobs = uniqueJobs([...jdRequirementJobs, ...titleOrTagOnlyJobs, ...descriptionOnlyJobs]);
    return {
      ...lens,
      directJobs,
      jdRequirementJobs,
      descriptionOnlyJobs,
      titleOrTagOnlyJobs,
      jobs: evidenceJobs,
      strength: jdRequirementJobs.length >= 2 ? "较强信号" : "探索性信号",
    };
  }).filter(signal => signal.jobs.length);
}

function emergingSkillInsight(jobs, productSignals = []) {
  const signals = emergingCapabilitySignals(jobs);
  const strong = signals.filter(signal => signal.strength === "较强信号");
  const exploratory = signals.filter(signal => signal.strength === "探索性信号");
  const strongText = strong.length
    ? strong.map(signal => `${signal.label}（${signal.jdRequirementJobs.length} 个 JD 职责或要求）`).join("、")
    : "未形成重复出现的能力组合";
  const exploratoryText = exploratory.length
    ? exploratory.map(signal => `${signal.label}（${signal.jobs[0].title}）`).join("、")
    : "未发现单岗位的高专门性要求";
  const supportedLines = supportedProductLines(signals.flatMap(signal => signal.jdRequirementJobs), productSignals);
  const labels = signals.map(signal => signal.label).join("、") || "相关技能";

  return {
    title: "AI 相关职责与任职要求（新兴技能与特殊要求）",
    conclusion: `较强信号：${strongText}。探索性信号：${exploratoryText}。${supportedLines.length ? `这些岗位直接支撑${supportedLines.join("、")}的外部产品线观察。` : "当前未能将这些岗位对应到可识别产品线。"}重复出现的能力可作为当前人才需求的较强线索；只出现一次的特殊要求只能提示值得跟踪的现象，不能直接推断公司战略。`,
    analysis: analysisChain(
      `区分 JD 职责或任职要求、标题或标签、正文泛化提及，得到 ${signals.map(signal => `${signal.label} ${signal.jobs.length} 个有证据岗位`).join("、")}。`,
      strong.length
        ? `${strong.map(signal => `${signal.label} 的岗位覆盖 ${roleSummary(signal.jobs)}`).join("；")}，不是单一岗位的词汇提及。`
        : "没有任何能力在两份以上 JD 的职责或任职要求中重复出现。",
      "重复的正文能力要求可反映当前缺口；仅有标题词、单次正文提及或与工作职责无关的行业观察，均不提升为较强信号。",
    ),
    evidence: signals.flatMap(signal => signal.jobs),
    evidenceGroups: signals.flatMap(signal => [
      ...(signal.jdRequirementJobs.length ? [{
        label: signal.label,
        strength: signal.strength,
        jobs: signal.jdRequirementJobs,
        jdPattern: signal.pattern,
      }] : []),
      ...(signal.titleOrTagOnlyJobs.length ? [{
        label: signal.label,
        strength: "探索性信号（标题或标签线索）",
        jobs: signal.titleOrTagOnlyJobs,
      }] : []),
      ...(signal.descriptionOnlyJobs.length ? [{
        label: signal.label,
        strength: "探索性信号（正文泛化提及）",
        jobs: signal.descriptionOnlyJobs,
        jdPattern: signal.pattern,
      }] : []),
    ]),
    counter: "新兴能力词可能来自单个项目、外包需求或招聘文案。需在后续快照中确认是否持续出现，并结合产品负责人确认其业务归属。",
    summary: strong.length
      ? `新兴能力的较强信号包括${strong.map(signal => signal.label).join("、")}；单点特殊要求仅按探索性信号处理。`
      : "未形成重复出现的新兴能力组合；单点特殊要求仅作探索性记录。",
    supportedLines,
    actions: {
      sales: [],
      business: [],
      hr: [
        `重点监控${labels}相关岗位、任职要求和城市变化，作为人才供给与竞争强度的后续线索。`,
        "对重复出现的 AI 或稀缺技能进行候选人池、薪酬和外部人才流向预研；不将公开职位视为实际入职数据。",
      ],
    },
  };
}

const PRODUCT_LINE_LENSES = [
  {
    label: "智能内容与生成产品线",
    pattern: /AI\s*(视频|内容|创作)|视频模板|内容生成|AIGC\s*(产品|功能|生成|模型)|数字人\s*(生成|产品)|图像生成|视觉AI/i,
  },
  {
    label: "智能硬件产品线",
    pattern: /智能硬件|嵌入式|STM32|RTOS|单片机|硬件产品|固件/i,
  },
  {
    label: "数据产品与数据基础设施产品线",
    pattern: /数据平台|数据产品|数据采集|网络爬虫|数据清洗|数据解析|数据基础设施/i,
  },
  {
    label: "数字营销与商业工具产品线",
    pattern: /数字营销|营销工具|广告后台|SaaS|投放平台|星图/i,
  },
];

const PRODUCT_RESPONSIBILITY_PATTERN = /负责|规划|设计|研发|开发|交付|运营|推广|销售|营销|渠道|优化|实现|搭建|维护|管理|验证|调研/;

function hasExplicitProductResponsibility(job, lens) {
  const description = String(job.description || "");
  return description
    .split(/[。！？；\n]+/)
    .some(clause => lens.pattern.test(clause) && PRODUCT_RESPONSIBILITY_PATTERN.test(clause));
}

function productLineSignals(jobs) {
  return PRODUCT_LINE_LENSES.map(lens => {
    const matchedJobs = jobs.filter(job => hasExplicitProductResponsibility(job, lens));
    return {
      ...lens,
      jobs: matchedJobs,
      strength: matchedJobs.length >= 2 ? "可识别产品线信号" : "探索性产品线线索",
    };
  }).filter(signal => signal.jobs.length);
}

function supportedProductLines(jobs, productSignals) {
  return productSignals
    .filter(signal => jobs.some(job => signal.jobs.some(signalJob => signalJob.jobId === job.jobId)))
    .map(signal => signal.label);
}

function productLineInsight(jobs, analysis) {
  const signals = productLineSignals(jobs);
  const identified = signals.filter(signal => signal.strength === "可识别产品线信号");

  if (!identified.length) {
    return {
      title: "产品线研判",
      conclusion: `当前 ${analysis.total} 个岗位中没有形成可相互印证的产品线招聘组合。通用研发、产品或设计岗位不按产品线归类，避免将技术能力误读为具体产品策略。`,
      analysis: analysisChain(
        "未发现任一产品对象同时在至少两份 JD 的职责或任职要求中出现。",
        "仅存在的通用研发、产品或设计职位没有可归属的明确产品对象。",
        "当前只能确认能力建设，不能判断产品线布局。",
      ),
      evidence: jobs,
      counter: "补充岗位 JD 中的产品对象、用户场景和职责描述，或在后续快照中观察同一产品对象是否持续招募。",
      summary: "尚无足够证据按产品线拆分产品策略信号。",
      signals: [],
      actions: {
        sales: [],
        business: ["将岗位中的产品对象保留在外部产品线观察清单；后续确认是否形成两份以上 JD 的重复证据。"],
        hr: [],
      },
    };
  }

  return {
    title: "产品线研判",
    conclusion: `从岗位中的产品对象和职责描述，可识别 ${identified.map(signal => `${signal.label}（${signal.jobs.length} 个岗位）`).join("、")}。每条产品线仅依据对应岗位的明确表述，不以通用技术词跨线外推。`,
    facts: `产品线划分：JD 正文中反复出现的产品对象：${identified.map(signal => signal.label).join("、")}。`,
    inference: "产品线归类仅说明正在配置相关能力；业务阶段和实际投入以商业化研判为准。",
    validation: "验证产品名称、目标用户、上线状态和与现有业务的关系。",
    analysis: analysisChain(
      `只纳入 JD 正文同时出现产品对象与职责表述的岗位，并按产品对象分为 ${identified.map(signal => signal.label).join("、")}。`,
      `产品线内的职能组合：${identified.map(signal => `${signal.label} = ${roleSummary(signal.jobs)}`).join("；")}。每条线均至少有 ${Math.min(...identified.map(signal => signal.jobs.length))} 个岗位正文相互印证。`,
      "同一产品对象同时吸引研发、产品、运营或商业化岗位时，才把它作为产品线信号；职能组合说明的是当前招聘支撑方式，不等同于产品收入或路线图优先级。",
    ),
    evidence: identified.flatMap(signal => signal.jobs),
    evidenceGroups: identified.map(signal => ({
      label: signal.label,
      strength: signal.strength,
      jobs: signal.jobs,
      jdPattern: signal.pattern,
    })),
    counter: "同一岗位可能服务多个产品对象；公开 JD 未披露产品名称、商业优先级或实际团队编制，需以产品发布和连续岗位快照交叉验证。",
    summary: `已按岗位证据拆分 ${identified.map(signal => signal.label).join("、")}。`,
    signals: identified,
    actions: {
      sales: [],
      business: identified.map(signal => `将${signal.label}加入外部产品线观察清单；下期确认其岗位是否持续、是否新增市场侧或建设侧角色。`),
      hr: [],
    },
  };
}

function productLineBusinessStage(signal) {
  const buildJobs = signal.jobs.filter(job => ["研发与数据", "产品与项目", "设计与创意"].includes(jobFamily(job)));
  const marketJobs = signal.jobs.filter(job => ["市场与商业化", "运营与内容"].includes(jobFamily(job)));

  if (buildJobs.length && marketJobs.length) {
    return {
      label: "产品化与市场验证",
      hypothesis: "该方向正同时补齐产品能力与面向客户/内容的触点，业务上更接近从能力建设走向产品化与市场验证。",
      buildJobs,
      marketJobs,
    };
  }
  if (buildJobs.length >= 2) {
    return {
      label: "能力建设或产品迭代",
      hypothesis: "该方向的招聘集中在研发、产品或体验角色，业务上更可能处于能力建设或产品迭代阶段，尚不能确认已进入规模化商业化。",
      buildJobs,
      marketJobs,
    };
  }
  if (marketJobs.length >= 2) {
    return {
      label: "商业化放大与交付优化",
      hypothesis: "该方向的招聘集中在获客、渠道、内容或交付角色，业务上更可能在放大既有产品的获客、转化或服务能力，而非从零建设产品能力。",
      buildJobs,
      marketJobs,
    };
  }
  return {
    label: "定向能力补位",
    hypothesis: "当前仅能判断该产品对象存在定向招聘，尚不足以判断业务阶段。",
    buildJobs,
    marketJobs,
  };
}

function commercializationInsight(productSignals) {
  const stageSignals = productSignals.map(signal => ({ signal, ...productLineBusinessStage(signal) }));
  const activeSignals = stageSignals.filter(stage => stage.label !== "定向能力补位");
  const crossFunctionalSignals = activeSignals.filter(stage => stage.buildJobs.length && stage.marketJobs.length);
  return {
    title: "商业化研判",
    conclusion: activeSignals.length
      ? `可重点验证 ${activeSignals.map(stage => `${stage.signal.label}的${stage.label}`).join("、")}。`
      : "当前没有足够的跨职能岗位组合判断商业化阶段。",
    facts: activeSignals.length
      ? activeSignals.map(stage => `${stage.signal.label}：${roleSummary(stage.signal.jobs)}。`).join("\n")
      : "未出现由同一业务对象连接的建设侧与市场侧职责。",
    inference: activeSignals.length
      ? activeSignals.map(stage => `${stage.signal.label}：${stage.hypothesis}`).join("\n")
      : "不对客户需求、采购机会或商业化阶段作出推论。",
    analysis: analysisChain(
      activeSignals.length
        ? `识别到 ${activeSignals.map(stage => `${stage.signal.label} ${stage.signal.jobs.length} 个 JD 直接支持的岗位`).join("、")}。`
        : "没有产品对象同时获得两份以上 JD 的直接印证。",
      activeSignals.length
        ? activeSignals.map(stage => `${stage.signal.label}：建设侧 ${roleSummary(stage.buildJobs)}；市场侧 ${roleSummary(stage.marketJobs)}；对应 ${stage.label}`).join("；")
        : "缺少由同一业务对象连接的建设侧与市场侧职责。",
      activeSignals.length
        ? "岗位组合可用于提出阶段验证问题，不能替代客户、产品上线或采购信息。"
        : "没有跨职能岗位组合，不将单一岗位需求外推为商业化阶段。",
    ),
    inferenceBoundary: "招聘岗位只能显示待补充的能力组合，不能确认客户需求、采购机会、收入、产品发布或实际岗位编制。",
    validation: "核验产品是否已上线、目标客户、销售周期、渠道模式和交付约束；这些信息不能由招聘岗位单独确认。",
    actions: {
      sales: crossFunctionalSignals.map(stage => `围绕${stage.signal.label}准备“${stage.label}”的业务问题，向相关产品、渠道或交付负责人验证客户场景与效率瓶颈。`),
      business: activeSignals.map(stage => `持续跟踪${stage.signal.label}的建设侧与市场侧岗位变化；角色组合反转时更新阶段假设。`),
      hr: [],
    },
    evidence: activeSignals.flatMap(stage => stage.signal.jobs),
    evidenceGroups: activeSignals.map(stage => ({
      label: `${stage.signal.label}：${stage.label}`,
      strength: "业务阶段假设",
      jobs: stage.signal.jobs,
      jdPattern: stage.signal.pattern,
    })),
    counter: "岗位开放可能来自存量团队补员、替换或外包项目，必须由下一期岗位变化和外部业务信息复核。",
  };
}

function businessStageInsight(productSignals) {
  const stages = productSignals.map(signal => ({ signal, ...productLineBusinessStage(signal) }));
  if (!stages.length) {
    return {
      title: "业务阶段假设",
      conclusion: "未形成跨职能、可归属产品对象的岗位组合，因此不对当前业务阶段作出推论。",
      analysis: analysisChain(
        "没有产品对象在两份以上 JD 中获得直接印证。",
        "缺少同一业务对象下研发、产品、市场、运营或交付角色的组合。",
        "没有能力组合，就不把单一岗位需求推论为业务战略或阶段。",
      ),
      evidence: [],
      counter: "补充连续岗位快照、产品发布或经营指标后再判断。",
      inferenceBoundary: "招聘数据不能替代产品收入、用户增长、上线节奏或管理层战略表述。",
      summary: "缺少跨职能产品组合，暂不对业务阶段作出推论。",
    };
  }

  return {
    title: "业务阶段假设",
    conclusion: `基于同一产品对象下的跨职能招聘组合，形成 ${stages.map(stage => `${stage.signal.label}的“${stage.label}”假设`).join("、")}。这是对当前能力投入所服务业务阶段的推论，不是对营收、客户规模或战略优先级的事实判断。`,
    analysis: analysisChain(
      `识别到 ${stages.map(stage => `${stage.signal.label} ${stage.signal.jobs.length} 个岗位`).join("、")}，且岗位均在 JD 正文中明确产品对象和职责。`,
      stages.map(stage => `${stage.signal.label}：建设侧 ${roleSummary(stage.buildJobs)}；市场侧 ${roleSummary(stage.marketJobs)}；对应 ${stage.label}`).join("；"),
      stages.map(stage => `${stage.signal.label}：${stage.hypothesis}`).join("；"),
    ),
    evidence: stages.flatMap(stage => stage.signal.jobs),
    evidenceGroups: stages.map(stage => ({
      label: `${stage.signal.label}：${stage.label}`,
      strength: "业务阶段假设",
      jobs: stage.signal.jobs,
      jdPattern: stage.signal.pattern,
    })),
    counter: "后续若建设侧岗位消失而市场侧持续增加，或相反，阶段判断应随新快照调整；需用产品发布、客户转化和收入结构验证。",
    inferenceBoundary: "岗位开放只能说明正在寻找何种能力，不能证明能力已到位、产品已上线、客户已付费或公司已把该方向列为最高优先级。",
    summary: stages.map(stage => `${stage.signal.label}：${stage.label}`).join("；"),
  };
}

function isManagementHiring(job) {
  return /负责人|总监|主管|总经理|\bHead\b|\bDirector\b/i.test(job.title || "");
}

function isCoreRole(job) {
  const senior = /3-5年|5-10年|10年以上/.test(job.experience || "") || /高级|资深|专家|负责人|总监|首席|架构师/.test(job.title || "");
  return senior && ["研发与数据", "产品与项目", "市场与商业化", "运营与内容"].includes(jobFamily(job));
}

function leadershipInsight(jobs, productSignals = []) {
  const managementJobs = jobs.filter(isManagementHiring);
  const coreJobs = jobs.filter(isCoreRole);
  const coreProfessionalJobs = coreJobs.filter(job => !managementJobs.includes(job));
  const supportedLines = supportedProductLines(coreJobs, productSignals);
  const labels = managementJobs.length || coreProfessionalJobs.length
    ? [managementJobs.length ? "管理人员" : "", coreProfessionalJobs.length ? "核心专业" : ""].filter(Boolean).join("、")
    : "核心岗位";

  return {
    title: "核心岗位与管理人员招募",
    conclusion: managementJobs.length || coreProfessionalJobs.length
      ? `识别到 ${coreJobs.length} 个核心岗位，其中 ${managementJobs.length} 个明确包含管理人员招募信号。${supportedLines.length ? `这些岗位直接支撑${supportedLines.join("、")}的外部产品线观察。` : "当前未能将这些岗位对应到可识别产品线。"}管理岗反映组织对带队或关键决策能力的需求；核心专业岗反映关键能力补强，但公开招聘不足以确认汇报层级、团队规模或任命优先级。`
      : "当前未识别到以职位名称或 JD 明确表述的管理人员招募或核心专业岗位信号。",
    analysis: analysisChain(
      `按资深经验、资深职级或关键职能识别核心岗位 ${coreJobs.length} 个；按负责人、总监、主管等职位头衔识别管理人员招募 ${managementJobs.length} 个。`,
      coreJobs.length ? `核心岗位的职能分布为 ${roleSummary(coreJobs)}。` : "没有满足核心岗位规则的职位。",
      "管理头衔与核心专业能力需要分开看：前者提示组织带队需求，后者提示关键交付能力补强；两者都不能单独证明实际团队规模。",
    ),
    evidence: managementJobs.length || coreProfessionalJobs.length ? [...managementJobs, ...coreProfessionalJobs] : jobs,
    evidenceGroups: managementJobs.length || coreProfessionalJobs.length ? [
      ...(managementJobs.length ? [{ label: "管理人员招募", strength: `${managementJobs.length} 个岗位`, jobs: managementJobs }] : []),
      ...(coreProfessionalJobs.length ? [{ label: "核心专业岗位", strength: `${coreProfessionalJobs.length} 个岗位`, jobs: coreProfessionalJobs }] : []),
    ] : undefined,
    counter: "职位头衔可能与实际管理范围不一致，且核心岗位标准需结合组织架构、招聘负责人和最终入职信息确认。",
    summary: managementJobs.length || coreProfessionalJobs.length
      ? `核心岗位 ${coreJobs.length} 个，管理人员招募 ${managementJobs.length} 个。`
      : "未识别到明确的核心岗位或管理人员招募信号。",
    supportedLines,
    actions: {
      sales: [],
      business: [],
      hr: [
        `重点监控${labels}相关岗位、任职要求和城市变化，作为人才供给与竞争强度的后续线索。`,
        "对重复出现的 AI 或稀缺技能进行候选人池、薪酬和外部人才流向预研；不将公开职位视为实际入职数据。",
      ],
    },
  };
}

function buildAnalysisDimensions(jobs, analysis, reportContext) {
  const topCity = analysis.cities[0];
  const topCityJobs = topCity ? jobs.filter(job => (job.city || "未知") === topCity[0]) : [];

  const social = jobs.filter(job => workMode(job) === "社招岗位");
  const interns = jobs.filter(job => workMode(job) === "实习岗位");
  const flexible = jobs.filter(job => workMode(job) === "灵活供稿/兼职");
  const senior = jobs.filter(job =>
    /3-5年|5-10年|10年以上/.test(job.experience || "") || /资深|专家|负责人|总监/.test(job.title || ""),
  );

  const talentInsight = {
    title: "人才研判：人才补充以社招和中高经验岗位为主",
    conclusion: `用工结构为社招 ${social.length} 个、实习 ${interns.length} 个、灵活供稿/兼职 ${flexible.length} 个；${senior.length}/${analysis.total} 个岗位要求 3 年及以上经验，或以资深、专家、负责人、总监命名。当前样本更像面向既有能力缺口的成熟人才补强，同时保留有限人才管道。`,
    analysis: analysisChain(
      `社招占 ${social.length}/${analysis.total}，实习占 ${interns.length}/${analysis.total}；中高经验或资深职级岗位占 ${senior.length}/${analysis.total}。`,
      `中高经验岗位覆盖 ${roleSummary(senior)}，而实习岗位作为较小的人才管道同时存在。`,
      "该组合更符合成熟人才补强加有限梯队储备的招聘结构；它不代表实际录用人数或最终编制。",
    ),
    evidence: [...senior, ...interns, ...social],
    counter: "公开岗位不能说明实际入职人数、编制批准或最终候选人层级，需由招聘漏斗和入职数据验证。",
  };

  const locationInsight = topCity && topCity[1] / analysis.total >= 0.5
    ? {
        title: `招聘岗位主要投放在${topCity[0]}`,
        conclusion: `${topCity[1]}/${analysis.total} 个公开岗位位于${topCity[0]}。这可作为当前人才招募的地域信号，但不能直接推断该城市的团队规模或组织职责。`,
        analysis: analysisChain(
          `${topCity[0]} 集中 ${topCity[1]} 个岗位，占样本 ${Math.round(topCity[1] / analysis.total * 100)}%。`,
          `该城市岗位的职能分布为 ${roleSummary(topCityJobs)}。`,
          "地域集中说明公开招聘投放集中，尚不足以推出团队规模、组织归属或办公地点调整。",
        ),
        evidence: topCityJobs,
        counter: "需要观察后续岗位是否持续集中于该城市，以及实际入职地点是否一致。",
      }
    : {
        title: "招聘岗位呈多城市投放",
        conclusion: `本次岗位分布为${analysis.cities.map(([city, count]) => `${city} ${count} 个`).join("、")}。当前只能确认多城市投放，不能推断城市之间的组织分工。`,
        analysis: analysisChain(
          `岗位分布为 ${analysis.cities.map(([city, count]) => `${city} ${count} 个`).join("、")}。`,
          "未出现单一城市占半数以上的集中度。",
          "只能判断多城市投放，城市职能分工需按后续快照和岗位职责继续验证。",
        ),
        evidence: jobs,
        counter: "需要连续快照确认各城市的岗位类型是否稳定分化。",
  };
  const productInsight = productLineInsight(jobs, analysis);
  const skillInsight = emergingSkillInsight(jobs, productInsight.signals);
  const businessInsight = commercializationInsight(productInsight.signals);
  const leadership = leadershipInsight(jobs, productInsight.signals);

  const actions = {
    sales: ["核对相关岗位服务的目标客户、采购触发与销售周期；未验证前不将招聘信号视为采购需求。"],
    business: ["在下一次岗位快照中核对该能力要求是否持续出现或扩展。"],
    hr: ["与岗位业务负责人核对岗位归属、优先级和实际入职状态。"],
  };
  const factsFromEvidence = insight => {
    const evidenceJobs = insight.evidenceGroups
      ? insight.evidenceGroups.flatMap(group => group.jobs)
      : insight.evidence || [];
    const referencedJobs = topJobs(evidenceJobs).map(job => jobEvidence(job));
    return referencedJobs.length
      ? `本次公开 JD 的直接证据包括 ${referencedJobs.join("、")}。`
      : "当前没有可引用的公开 JD 直接证据。";
  };
  const normalizeInsight = insight => ({
    ...insight,
    facts: insight.facts || factsFromEvidence(insight),
    inference: insight.inference || insight.conclusion,
    validation: insight.validation || insight.counter || "当前无待验证项。",
    actions: insight.actions || actions,
  });

  return [
    { name: "商业动态信号", summary: businessInsight.conclusion, insights: [businessInsight] },
    { name: "产品策略信号", summary: productInsight.conclusion, insights: [productInsight] },
    { name: "人才招募信号", summary: `${talentInsight.conclusion} ${leadership.summary} ${skillInsight.summary}`, insights: [talentInsight, leadership, locationInsight, skillInsight] },
  ].map(dimension => ({
    ...dimension,
    insights: dimension.insights.map(normalizeInsight),
  }));
}

function normalizeReportContext(context = {}) {
  const purposes = Array.isArray(context.purposes) ? context.purposes : ["sales", "business", "hr"];
  const allowedPurposes = ["sales", "business", "hr"];
  return {
    mode: context.mode === "monitoring" ? "monitoring" : "baseline",
    purposes: purposes.filter(purpose => allowedPurposes.includes(purpose)),
    comparison: context.comparison || null,
  };
}

function monitoringActions(comparison) {
  const added = comparison?.added || [];
  const removed = comparison?.removed || [];
  if (!added.length && !removed.length) {
    return {
      sales: ["岗位 ID 未发生变化；继续核对既有岗位对应的客户场景与渠道信息，不推断采购进展。"],
      business: ["岗位 ID 未发生变化，继续观察岗位职责和持续时长；产品线仍须满足两份以上 JD 的证据门槛。"],
      hr: ["岗位 ID 未发生变化；继续核对岗位归属、招聘状态和任职要求是否调整。"],
    };
  }
  return {
    sales: ["针对本期新增或减少的岗位核对其服务的客户场景、渠道模式与业务问题；不将岗位变化视为采购、客户或收入事实。"],
    business: ["按上一期与本期的假设状态复核产品对象和职责证据；产品线仍须至少两份 JD 相互印证，再决定新增、增强、减弱或失效。"],
    hr: ["逐项核对本期变化岗位的业务归属、招聘状态和持续时长；标题或标签信号只保留为探索性人才线索。"],
  };
}

function actionMarkdown(actions, purposes) {
  const sections = [
    ["sales", "销售动作", actions.sales],
    ["business", "业务动作", actions.business],
    ["hr", "HR 动作", actions.hr],
  ];
  return sections
    .filter(([purpose]) => purposes.includes(purpose))
    .map(([, heading, items]) => `${heading}：\n${items?.length ? items.map(item => `- ${item}`).join("\n") : "当前无可用行动建议"}`)
    .join("\n\n");
}

function buildInsightMarkdown(insight, index, reportContext) {
  return `### 判断 ${index + 1}：${insight.title}

${insight.conclusion}

事实：
${insight.facts}

推论：
${insight.inference}

分析：
${insight.analysis}

${insight.inferenceBoundary ? `推论边界：${insight.inferenceBoundary}\n\n` : ""}证据：
${evidenceSection(insight)}

待验证：
${insight.validation}

反证与待验证：${insight.counter}

${actionMarkdown(insight.actions || {}, reportContext.purposes)}`;
}

function buildDimensionMarkdown(dimension, index, reportContext) {
  const headings = ["一", "二", "三"];
  return `## ${headings[index]}、${dimension.name}

${dimension.insights.map((insight, insightIndex) => buildInsightMarkdown(insight, insightIndex, reportContext)).join("\n\n")}`;
}

function comparisonJobEvidence(job) {
  return jobEvidence(job);
}

function comparisonEvidenceLine(label, jobs) {
  return `- ${label}：${jobs.length} 个${jobs.length ? `（${jobs.map(comparisonJobEvidence).join("、")}）` : ""}`;
}

function comparisonJobs(comparison) {
  return {
    previous: comparison.previousJobs || [...comparison.removed, ...comparison.persistent],
    current: comparison.currentJobs || [...comparison.added, ...comparison.persistent],
  };
}

const HYPOTHESIS_STATE_LABELS = {
  new: "新增（new）",
  strengthened: "增强（strengthened）",
  weakened: "减弱（weakened）",
  invalidated: "失效（invalidated）",
};

function hypothesisEvidenceState(previousCount, currentCount, threshold = 1) {
  const previousEligible = previousCount >= threshold;
  const currentEligible = currentCount >= threshold;
  if (!previousEligible && currentEligible) return "new";
  if (previousEligible && !currentEligible) return "invalidated";
  if (!previousEligible && !currentEligible) return null;
  if (currentCount > previousCount) return "strengthened";
  if (currentCount < previousCount) return "weakened";
  return null;
}

function signalMap(signals) {
  return new Map(signals.map(signal => [signal.label, signal]));
}

function productHypothesisUpdates(previousJobs, currentJobs) {
  const previousSignals = signalMap(productLineSignals(previousJobs));
  const currentSignals = signalMap(productLineSignals(currentJobs));
  return PRODUCT_LINE_LENSES.flatMap(lens => {
    const previousCount = previousSignals.get(lens.label)?.jobs.length || 0;
    const currentCount = currentSignals.get(lens.label)?.jobs.length || 0;
    const state = hypothesisEvidenceState(previousCount, currentCount, 2);
    if (!state) return [];
    return [`- 产品线假设：状态：${HYPOTHESIS_STATE_LABELS[state]}；${lens.label}上一期证据 ${previousCount} 个，本期 ${currentCount} 个；只有同一产品对象与职责在相近 JD 子句中共同出现的岗位计入，且产品线门槛始终为两份 JD。`];
  });
}

function commercializationStageMap(jobs) {
  return new Map(productLineSignals(jobs)
    .filter(signal => signal.jobs.length >= 2)
    .map(signal => [signal.label, { ...productLineBusinessStage(signal), count: signal.jobs.length }]));
}

function stageRank(stage) {
  if (!stage) return 0;
  if (stage.buildJobs.length && stage.marketJobs.length) return 2;
  return stage.label === "定向能力补位" ? 0 : 1;
}

function commercializationHypothesisUpdates(previousJobs, currentJobs) {
  const previousStages = commercializationStageMap(previousJobs);
  const currentStages = commercializationStageMap(currentJobs);
  return PRODUCT_LINE_LENSES.flatMap(lens => {
    const previous = previousStages.get(lens.label);
    const current = currentStages.get(lens.label);
    if (!previous && !current) return [];
    let stateLabel;
    if (!previous) stateLabel = HYPOTHESIS_STATE_LABELS.new;
    else if (!current) stateLabel = HYPOTHESIS_STATE_LABELS.invalidated;
    else if (stageRank(current) > stageRank(previous) || (stageRank(current) === stageRank(previous) && current.count > previous.count)) stateLabel = HYPOTHESIS_STATE_LABELS.strengthened;
    else if (stageRank(current) < stageRank(previous) || (stageRank(current) === stageRank(previous) && current.count < previous.count)) stateLabel = HYPOTHESIS_STATE_LABELS.weakened;
    else if (current.label !== previous.label) {
      stateLabel = `${HYPOTHESIS_STATE_LABELS.invalidated}并${HYPOTHESIS_STATE_LABELS.new}`;
    }
    else return [];
    return [`- 商业化假设：状态：${stateLabel}；${lens.label}由上一期“${previous?.label || "未形成"}”变为本期“${current?.label || "未形成"}”；仅作为阶段验证线索，不确认采购、客户、收入或产品发布。`];
  });
}

function talentHypothesisUpdates(previousJobs, currentJobs) {
  const previousSignals = signalMap(emergingCapabilitySignals(previousJobs));
  const currentSignals = signalMap(emergingCapabilitySignals(currentJobs));
  return EMERGING_CAPABILITY_LENSES.flatMap(lens => {
    const previous = previousSignals.get(lens.label);
    const current = currentSignals.get(lens.label);
    const previousCount = previous?.jobs.length || 0;
    const currentCount = current?.jobs.length || 0;
    const previousStrength = previous?.strength || "无信号";
    const currentStrength = current?.strength || "无信号";
    const previousStrengthRank = previous?.strength === "较强信号" ? 2 : previous ? 1 : 0;
    const currentStrengthRank = current?.strength === "较强信号" ? 2 : current ? 1 : 0;
    let state;
    if (previousStrengthRank && currentStrengthRank && currentStrengthRank > previousStrengthRank) state = "strengthened";
    else if (previousStrengthRank && currentStrengthRank && currentStrengthRank < previousStrengthRank) state = "weakened";
    else state = hypothesisEvidenceState(previousCount, currentCount);
    if (!state) return [];
    const strength = current?.strength || previous?.strength || "探索性信号";
    return [`- 人才假设：状态：${HYPOTHESIS_STATE_LABELS[state]}；${lens.label}上一期证据 ${previousCount} 个，本期 ${currentCount} 个；上一期${previousStrength}，本期${currentStrength}，按${strength}处理；标题或标签不能提升为较强信号。`];
  });
}

function monitoringHypothesisUpdates(comparison) {
  const { previous, current } = comparisonJobs(comparison);
  const lines = [
    ...commercializationHypothesisUpdates(previous, current),
    ...productHypothesisUpdates(previous, current),
    ...talentHypothesisUpdates(previous, current),
  ];
  if (!lines.length) {
    return "- 未检测到商业化、产品线或新兴人才假设的状态变化；继续观察，不将岗位持续展示等同于实际招聘进展。";
  }
  return lines.join("\n");
}

function monitoringSection(comparison, purposes) {
  if (!comparison) return "";
  return `## 本期变化

${comparisonEvidenceLine("新增岗位", comparison.added)}
${comparisonEvidenceLine("下线岗位", comparison.removed)}
${comparisonEvidenceLine("持续开放", comparison.persistent)}
- 假设更新：
${monitoringHypothesisUpdates(comparison)}
- 后续核对：
${actionMarkdown(monitoringActions(comparison), purposes)}`;
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(" | ") : String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

async function saveOutputs(directory, jobs, candidate, coverage, previousSnapshot = null) {
  const capturedAt = new Date().toISOString();
  const normalizedJobs = jobs.map(job => ({ ...job, location: normalizeLocation(job.location) }));
  const analysis = analyze(normalizedJobs, candidate, coverage);
  const analysisInput = createAnalysisInput({ candidate, coverage, capturedAt, jobs: normalizedJobs });
  const headers = [
    "jobId", "brandId", "company", "title", "salary", "city", "district", "businessDistrict",
    "experience", "degree", "skills", "labels", "benefits", "companyScale", "companyStage",
    "companyIndustry", "recruiter", "recruiterTitle", "address", "description", "url", "capturedAt",
  ];
  const rows = normalizedJobs.map(job => [
    job.jobId, job.brandId, job.company, job.title, job.salary, job.city, job.district, job.businessDistrict,
    job.experience, job.degree, job.skills, job.labels, job.benefits, job.companyScale, job.companyStage,
    job.companyIndustry, job.recruiter, job.recruiterTitle, job.address, job.description,
    job.finalUrl || job.jobLink, job.capturedAt,
  ]);
  const csv = [headers.map(csvCell).join(","), ...rows.map(row => row.map(csvCell).join(","))].join("\n");
  const outputs = [
    writeJson(path.join(directory, "jobs.json"), { capturedAt, candidate, coverage, jobs: normalizedJobs }),
    atomicWrite(path.join(directory, "jobs.csv"), `\ufeff${csv}\n`),
    writeJson(path.join(directory, "analysis-input.json"), analysisInput),
    atomicWrite(path.join(directory, "appendix.md"), buildAppendix(normalizedJobs, analysis, capturedAt)),
  ];
  if (previousSnapshot) {
    outputs.push(writeJson(path.join(directory, "job-change.json"), {
      capturedAt,
      comparedWith: previousSnapshot.filePath,
      comparison: compareSnapshots(normalizedJobs, previousSnapshot.jobs),
    }));
  }
  await Promise.all(outputs);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  if (options.stopChrome) {
    const count = await stopDedicatedChrome({ profileDir: PROFILE_DIR, port: options.cdpPort });
    console.log(`已关闭 ${count} 个专用 Chrome 主进程`);
    return;
  }
  if (!options.loginOnly && !options.checkLogin && !options.company) {
    throw new Error("请提供 --company，例如：node boss-company-scout.mjs --company \"美图\" --discover-only");
  }
  const previousSnapshot = options.previousJobs ? await loadPreviousSnapshot(options.previousJobs) : null;
  if (previousSnapshot && options.brandId) {
    assertPreviousSnapshotCandidate(previousSnapshot, { brandId: options.brandId });
  }

  await mkdir(OUTPUT_ROOT, { recursive: true });
  const { client, browserVersion, port } = await launchOrConnectChrome({
    profileDir: PROFILE_DIR,
    port: options.cdpPort,
    minimized: options.background,
  });
  console.log(`已连接 ${browserVersion}（CDP ${port}${options.background ? "，后台模式" : ""}）`);

  try {
    const page = await attachSinglePage(client);
    await enforceSinglePage(client, page.targetId);
    if (options.background) await minimizeDedicatedChromeWindow({ profileDir: PROFILE_DIR, port: options.cdpPort });
    if (options.loginOnly) {
      await navigate(client, page.sessionId, BOSS_HOME);
      console.log("已在唯一标签页打开 Boss。请在该专用 Chrome 中手动登录；登录态会保留供后续采集使用。");
      return;
    }

    await navigate(client, page.sessionId, BOSS_HOME);
    await sleep(750);
    assertPageAccessible(await getPageState(client, page.sessionId));
    if (options.checkLogin) {
      console.log("专用 Chrome 的 Boss 登录状态可用");
      return;
    }
    let candidate;
    if (options.brandId) {
      if (options.discoverOnly) throw new Error("--discover-only 不需要 --brand-id");
      candidate = {
        brandId: options.brandId,
        company: options.companyName || options.company,
        count: 0,
        cities: [],
        companyLink: `https://www.zhipin.com/gongsi/${options.brandId}.html`,
      };
      console.log(`使用指定 Boss 公司 ID：${candidate.brandId}`);
    } else {
      const search = await collectSearchResults(client, page, options);
      const candidates = companyCandidates(search.jobs, options.company);
      const discoveryDirectory = path.join(OUTPUT_ROOT, `${slugify(options.company)}-discovery`);
      await mkdir(discoveryDirectory, { recursive: true });
      await Promise.all([
        writeJson(path.join(discoveryDirectory, "candidates.json"), candidates),
        writeJson(path.join(discoveryDirectory, "search-jobs.json"), search),
      ]);

      console.log("\n候选公司主体：");
      for (const found of candidates) {
        console.log(`- ${found.company} | ${found.brandId} | ${found.count} 个岗位 | ${found.cities.join("、")}`);
      }
      if (options.discoverOnly) {
        console.log(`\n发现结果：${discoveryDirectory}`);
        return;
      }
      candidate = selectCompany(search.jobs, candidates, options).candidate;
    }
    assertPreviousSnapshotCandidate(previousSnapshot, candidate);
    const runDirectory = path.join(OUTPUT_ROOT, `${slugify(candidate.company)}-${candidate.brandId}-latest`);
    await mkdir(runDirectory, { recursive: true });
    const companyList = await collectCompanyJobs(
      client,
      page,
      options,
      candidate,
      path.join(runDirectory, "list-checkpoint.json"),
    );
    candidate = {
      ...candidate,
      count: companyList.jobs.length,
      cities: [...new Set(companyList.jobs.map(job => job.city).filter(Boolean))].sort(),
    };
    await writeJson(path.join(runDirectory, "list.json"), {
      capturedAt: new Date().toISOString(),
      candidate,
      coverage: companyList.coverage,
      jobs: companyList.jobs,
    });

    const checkpointPath = path.join(runDirectory, "checkpoint.json");
    const checkpoint = await loadJson(checkpointPath, []);
    const currentIds = new Set(companyList.jobs.map(job => job.jobId));
    const details = new Map(
      checkpoint
        .filter(job => currentIds.has(job.jobId) && job.description && !job.detailWarning)
        .map(job => [job.jobId, job]),
    );
    const targets = await collectCompanyDetails(
      client,
      page,
      options,
      candidate,
      companyList.jobs,
      details,
      checkpointPath,
    );

    const jobs = companyList.jobs.map(job => details.get(job.jobId) || {
      ...job,
      detailWarning: options.maxJobs ? "受 --max-jobs 限制，未读取详情" : "详情尚未读取",
    });
    await saveOutputs(runDirectory, jobs, candidate, companyList.coverage, previousSnapshot);
    console.log(`\n完成：公司页 ${jobs.length} 个岗位，读取 ${details.size}/${targets.length} 个目标详情`);
    console.log(`分析输入：${path.join(runDirectory, "analysis-input.json")}`);
    console.log(`CSV：${path.join(runDirectory, "jobs.csv")}`);
  } finally {
    client.close();
  }
}

export { analyze, compareSnapshots, saveOutputs };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`\n失败：${error.message}`);
    process.exitCode = 1;
  });
}
