import { spawn, execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

function chromeCandidates() {
  const override = process.env.BOSS_CHROME_PATH;
  if (process.platform === "darwin") {
    return [override, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  }
  if (process.platform === "win32") {
    return [
      override,
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
      process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    ];
  }
  return [override, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

export async function findChromePath() {
  for (const candidate of chromeCandidates().filter(Boolean)) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next standard location.
    }
  }
  throw new Error(
    "未找到 Google Chrome。请安装 Chrome，或设置 BOSS_CHROME_PATH 指向浏览器可执行文件。",
  );
}

export function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchJson(url, timeout = 3_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`${url} 返回 HTTP ${response.status}`);
  return response.json();
}

async function chromeCommandLines() {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"name = 'chrome.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ]);
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter(Boolean)
      .map(item => `${item.ProcessId} ${item.CommandLine || ""}`.trim());
  }
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
  return stdout.split("\n").map(line => line.trim()).filter(Boolean);
}

export function discoverDedicatedChromePorts(profileDir, processLines) {
  const profileArg = `--user-data-dir=${profileDir}`;
  const ports = new Set();
  for (const line of processLines) {
    const normalized = line.replaceAll('"', "");
    if (!/Google Chrome|chrome|chromium/i.test(normalized) || !normalized.includes(profileArg)) continue;
    for (const match of normalized.matchAll(/--remote-debugging-port=(\d+)/g)) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0) ports.add(port);
    }
  }
  return [...ports].sort((left, right) => left - right);
}

async function matchingChromeProcesses(profileDir, port) {
  const profileArg = `--user-data-dir=${profileDir}`;
  const portArg = `--remote-debugging-port=${port}`;
  return (await chromeCommandLines()).filter(line => {
    const normalized = line.replaceAll('"', "");
    return /Google Chrome|chrome|chromium/i.test(normalized)
      && normalized.includes(profileArg)
      && normalized.includes(portArg);
  });
}

async function waitForDebugger(port, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`);
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }
  throw new Error(`等待 Chrome CDP 端口 ${port} 超时：${lastError?.message || "未知错误"}`);
}

export function chromeLaunchArgs({ profileDir, port, minimized = false }) {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    minimized ? "--start-minimized" : "--start-maximized",
    "--remote-allow-origins=*",
  ];
}

export function isBackgroundChrome(processLines = []) {
  return processLines.some(line => /--start-minimized(?:\s|$)/i.test(line));
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function windowsMinimizeScript(profileDir, port) {
  return `
Add-Type @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT { public int length; public int flags; public int showCmd; public POINT ptMinPosition; public POINT ptMaxPosition; public RECT rcNormalPosition; }
public static class WindowControl {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);
}
'@
$profileArg = ${powershellQuote(`--user-data-dir=${profileDir}`)}
$portArg = ${powershellQuote(`--remote-debugging-port=${port}`)}
$window = Get-CimInstance Win32_Process -Filter "name = 'chrome.exe'" |
  Where-Object { $_.CommandLine -like "*$profileArg*" -and $_.CommandLine -like "*$portArg*" } |
  ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1
if (-not $window) { throw "未找到专用 Chrome 主窗口" }
[WindowControl]::ShowWindow($window.MainWindowHandle, 6) | Out-Null
$placement = New-Object WINDOWPLACEMENT
$placement.length = [Runtime.InteropServices.Marshal]::SizeOf($placement)
[WindowControl]::GetWindowPlacement($window.MainWindowHandle, [ref]$placement) | Out-Null
if ($placement.showCmd -ne 2) { throw "Chrome 未进入最小化状态" }
"WINDOW_MINIMIZED=true"
`;
}

export async function minimizeDedicatedChromeWindow({ profileDir, port = 9222 }) {
  if (process.platform !== "win32") {
    throw new Error("--background 当前仅支持 Windows；其他系统请保持正常 Chrome 采集");
  }
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    windowsMinimizeScript(profileDir, port),
  ]);
  if (!stdout.includes("WINDOW_MINIMIZED=true")) throw new Error("专用 Chrome 未确认最小化");
}

export async function launchOrConnectChrome({ profileDir, port = 9222, minimized = false, reuseExistingPort = true }) {
  await mkdir(profileDir, { recursive: true });
  let activePort = port;
  const endpoint = `http://127.0.0.1:${activePort}/json/version`;
  let version;
  try {
    version = await fetchJson(endpoint);
  } catch {
    version = null;
  }

  if (!version && reuseExistingPort) {
    const processLines = await chromeCommandLines();
    for (const candidatePort of discoverDedicatedChromePorts(profileDir, processLines)) {
      if (candidatePort === activePort) continue;
      try {
        version = await fetchJson(`http://127.0.0.1:${candidatePort}/json/version`);
        activePort = candidatePort;
        break;
      } catch {
        // Ignore stale Chrome command lines and try the next matching dedicated port.
      }
    }
  }

  const matching = await matchingChromeProcesses(profileDir, activePort);
  if (version && matching.length === 0) {
    throw new Error(
      `CDP 端口 ${activePort} 已被其他 Chrome 占用。请关闭占用者，或用 --cdp-port 指定其他端口。`,
    );
  }

  if (version && isBackgroundChrome(matching) !== minimized) {
    await stopDedicatedChrome({ profileDir, port: activePort });
    await sleep(500);
    version = null;
    activePort = port;
  }

  if (!version) {
    const chromePath = await findChromePath();
    const child = spawn(chromePath, chromeLaunchArgs({ profileDir, port: activePort, minimized }), {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    await writeFile(path.join(profileDir, "chrome.pid"), `${child.pid}\n`);
    version = await waitForDebugger(activePort);
  }

  if (!version.webSocketDebuggerUrl) throw new Error("Chrome 未返回 webSocketDebuggerUrl");
  return {
    client: await CdpClient.connect(version.webSocketDebuggerUrl),
    browserVersion: version.Browser || "Chrome",
    port: activePort,
  };
}

export async function stopDedicatedChrome({ profileDir, port = 9222 }) {
  const matching = await matchingChromeProcesses(profileDir, port);
  const pids = new Set();
  for (const line of matching) {
    const pid = Number(line.split(/\s+/, 1)[0]);
    if (Number.isInteger(pid) && pid > 1) pids.add(pid);
  }
  try {
    const savedPid = Number((await readFile(path.join(profileDir, "chrome.pid"), "utf8")).trim());
    if (Number.isInteger(savedPid) && matching.some(line => line.startsWith(`${savedPid} `))) pids.add(savedPid);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const pid of pids) process.kill(pid, "SIGTERM");
  return pids.size;
}

export class CdpClient {
  constructor(webSocket) {
    this.webSocket = webSocket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();

    webSocket.addEventListener("message", event => this.#handleMessage(event.data));
    webSocket.addEventListener("close", () => this.#rejectPending(new Error("CDP WebSocket 已关闭")));
    webSocket.addEventListener("error", () => this.#rejectPending(new Error("CDP WebSocket 连接错误")));
  }

  static async connect(url) {
    const webSocket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接 Chrome CDP 超时")), 10_000);
      webSocket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      webSocket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("无法连接 Chrome CDP WebSocket"));
      }, { once: true });
    });
    return new CdpClient(webSocket);
  }

  #handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.method) {
      for (const listener of this.listeners) listener(message);
    }
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}, sessionId = undefined, timeout = 30_000) {
    const id = ++this.nextId;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeout}ms）`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.webSocket.send(JSON.stringify(message));
    });
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.webSocket.close();
  }
}

export async function attachSinglePage(client) {
  let { targetInfos } = await client.send("Target.getTargets");
  let pages = targetInfos.filter(target => target.type === "page");
  let keep = pages.find(target => target.url.includes("zhipin.com")) || pages[0];
  if (!keep) {
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    keep = { targetId, url: "about:blank", type: "page" };
    pages = [keep];
  }
  for (const page of pages) {
    if (page.targetId !== keep.targetId) {
      await client.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
    }
  }
  const { sessionId } = await client.send("Target.attachToTarget", {
    targetId: keep.targetId,
    flatten: true,
  });
  // Runtime.evaluate works without Runtime.enable. Avoid subscribing to console
  // events because Boss treats an attached Runtime console listener as a debug
  // environment and navigates away from the page.
  await Promise.all([
    client.send("Page.enable", {}, sessionId),
    client.send("Network.enable", {}, sessionId),
  ]);
  return { targetId: keep.targetId, sessionId };
}

export async function openAdditionalPage(client) {
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
  await Promise.all([
    client.send("Page.enable", {}, sessionId),
    client.send("Network.enable", {}, sessionId),
  ]);
  return { targetId, sessionId };
}

export async function createFixedPagePool(client, count) {
  const workerCount = Math.max(1, Number.isInteger(count) ? count : 1);
  const workers = [];
  try {
    for (let index = 0; index < workerCount; index += 1) workers.push(await openAdditionalPage(client));
  } catch (error) {
    await Promise.all(workers.map(worker => closePage(client, worker.targetId)));
    throw error;
  }
  let closed = false;
  return {
    workers,
    async close({ preserveTargetIds = [] } = {}) {
      if (closed) return;
      closed = true;
      const preserved = new Set(preserveTargetIds);
      await Promise.all(workers
        .filter(worker => !preserved.has(worker.targetId))
        .map(worker => closePage(client, worker.targetId)));
    },
  };
}

export async function closePage(client, targetId) {
  await client.send("Target.closeTarget", { targetId }).catch(() => {});
}

export async function enforceSinglePage(client, targetId) {
  const { targetInfos } = await client.send("Target.getTargets");
  const pages = targetInfos.filter(target => target.type === "page");
  if (!pages.some(page => page.targetId === targetId)) throw new Error("唯一浏览器标签页已被关闭");
  for (const page of pages) {
    if (page.targetId !== targetId) {
      await client.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
    }
  }
  return pages.length;
}

export async function evaluate(client, sessionId, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "页面 JavaScript 执行失败");
  }
  return result.result?.value;
}

export async function navigate(client, sessionId, url) {
  const result = await client.send("Page.navigate", { url }, sessionId, 60_000);
  if (result.errorText) throw new Error(`页面导航失败：${result.errorText}`);
  await waitForDocument(client, sessionId);
  return getPageState(client, sessionId);
}

export async function waitForDocument(client, sessionId, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await evaluate(client, sessionId, "document.readyState").catch(() => "");
    if (ready === "interactive" || ready === "complete") return;
    await sleep(250);
  }
  throw new Error("等待页面加载完成超时");
}

export function getPageState(client, sessionId) {
  return evaluate(client, sessionId, `(() => ({
    url: location.href,
    title: document.title,
    bodyText: (document.body?.innerText || "").slice(0, 5000),
    bodyTextLength: (document.body?.innerText || "").length
  }))()`);
}
