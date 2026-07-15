#!/usr/bin/env node
/**
 * Edu mail + Grok/xAI signup + NopeCHA
 *   node reg-grok.mjs
 *   node reg-grok.mjs --reuse
 *   node reg-grok.mjs --no-nopecha
 *   node reg-grok.mjs --url https://accounts.x.ai/sign-up
 *   node reg-grok.mjs --fresh --proxy host:port:user:pass
 *   node reg-grok.mjs --fresh --proxy-file proxies.txt
 *   node reg-grok.mjs --chromium
 *   node reg-grok.mjs --cdp http://127.0.0.1:9222
 *   node reg-grok.mjs --user-chrome          # đóng Chrome → mở lại profile user + CDP
 *   node reg-grok.mjs --user-chrome --yes    # bỏ hỏi confirm kill
 *   node reg-grok.mjs --user-chrome --reuse
 *   node reg-grok.mjs --worker 3 --auto-close
 *   node reg-multi.mjs --count 5 --workers 2
 * Key: config.nopechaKey | env NOPECHA_KEY | --nopecha KEY
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";
import { chromium } from "playwright";
import {
  createAccount,
  api,
  htmlToText,
  __dir as MAIL_DIR,
  loadLatest as loadLatestAcc,
} from "../mail/getedumail-core.mjs";
import {
  resolveNopechaKey,
  ensureExtension,
  EXT_DIR,
} from "./nopecha.mjs";
import {
  solveTurnstileWithFallback,
  clickSignupAfterCaptcha,
} from "./turnstile.mjs";
import {
  parseProxyLine,
  pickLiveProxy,
  toPlaywrightProxy,
} from "./proxy.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const REUSE = args.includes("--reuse");
const FRESH = args.includes("--fresh");
const NO_NOPECHA = args.includes("--no-nopecha");
const NO_PROXY = args.includes("--no-proxy");
const AUTO_CLOSE = args.includes("--auto-close");
const USE_CHROME = !args.includes("--chromium");
const USER_CHROME = args.includes("--user-chrome") || args.includes("--real");
const YES = args.includes("--yes") || args.includes("-y") || process.env.GROK_YES === "1";
const CDP_DEFAULT = "http://127.0.0.1:9222";
let CDP = flag("--cdp", USER_CHROME ? CDP_DEFAULT : null);
const WORKER = flag("--worker", process.env.GROK_WORKER || "0");
const SIGNUP_URL = flag("--url", "https://accounts.x.ai/sign-up");
const PROFILE_DIR = join(
  __dir,
  WORKER && WORKER !== "0" ? `.pw-w${WORKER}` : ".pw-grok-profile"
);
const TAG = WORKER && WORKER !== "0" ? `W${WORKER}` : "W0";
const POLL_MS = 1500;
const POLL_MAX = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${TAG}]`, ...a);

function chromePaths() {
  const local = process.env.LOCALAPPDATA || "";
  const pf = process.env["PROGRAMFILES"] || "C:\\Program Files";
  const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const exes = [
    join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    join(local, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter((p) => existsSync(p));
  const userData =
    flag("--chrome-user-data", null) ||
    join(local, "Google", "Chrome", "User Data");
  return { exe: exes[0] || "chrome", userData };
}

async function cdpAlive(url = CDP_DEFAULT) {
  try {
    const u = url.replace(/\/$/, "") + "/json/version";
    const r = await fetch(u, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function chromeRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    return /chrome\.exe/i.test(out) && !/No tasks|INFO:/i.test(out);
  } catch {
    return false;
  }
}

function killChrome() {
  log("đóng toàn bộ chrome.exe (taskkill /T /F) …");
  for (const cmd of [
    "taskkill /IM chrome.exe /T /F",
    "taskkill /F /IM chrome.exe",
  ]) {
    try {
      execSync(cmd, { stdio: "ignore", windowsHide: true, timeout: 20000 });
    } catch {
      /* */
    }
  }
  // chờ process chết hẳn (profile unlock)
  for (let i = 0; i < 20; i++) {
    if (!chromeRunning()) {
      log("Chrome đã tắt");
      return true;
    }
    try {
      execSync("taskkill /IM chrome.exe /T /F", {
        stdio: "ignore",
        windowsHide: true,
        timeout: 10000,
      });
    } catch {
      /* */
    }
    try {
      execSync("powershell -NoProfile -Command Start-Sleep -Milliseconds 500", {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5000,
      });
    } catch {
      /* */
    }
  }
  if (chromeRunning()) {
    throw new Error(
      "Không tắt được chrome.exe — đóng tay Task Manager rồi chạy lại."
    );
  }
  return true;
}

function launchChromeDebug(exe, userData, port) {
  // Windows: spawn chrome args đôi khi nuốt flag; dùng PowerShell Start-Process chắc hơn
  const ps = [
    `$p = Start-Process -FilePath ${JSON.stringify(exe)}`,
    `-ArgumentList @(`,
    `  '--remote-debugging-port=${port}',`,
    `  '--remote-debugging-address=127.0.0.1',`,
    `  '--user-data-dir=${userData.replace(/'/g, "''")}',`,
    `  '--no-first-run',`,
    `  '--no-default-browser-check',`,
    `  'about:blank'`,
    `) -PassThru; Write-Output $p.Id`,
  ].join(" ");
  try {
    const id = execSync(
      `powershell -NoProfile -Command ${JSON.stringify(ps)}`,
      { encoding: "utf8", windowsHide: true, timeout: 15000 }
    ).trim();
    log(`Chrome PID ${id || "?"}`);
    return id;
  } catch (e) {
    log(`Start-Process fail → spawn: ${e.message?.slice(0, 80)}`);
    const child = spawn(
      exe,
      [
        `--remote-debugging-port=${port}`,
        `--remote-debugging-address=127.0.0.1`,
        `--user-data-dir=${userData}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { detached: true, stdio: "ignore", windowsHide: true }
    );
    child.unref();
    return String(child.pid || "");
  }
}

/** Sync confirm (ESM-safe). */
function confirmKillChromeSync() {
  if (YES) return true;
  if (!chromeRunning()) return true;
  try {
    const ans = execSync(
      'powershell -NoProfile -Command "$r = Read-Host \'⚠ Dong HET Chrome roi mo lai profile user. Tiep tuc? [y/N]\'; Write-Output $r"',
      { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"], timeout: 120000 }
    )
      .trim()
      .toLowerCase();
    return ans === "y" || ans === "yes";
  } catch {
    return false;
  }
}

/**
 * Đóng Chrome (nếu cần) → mở lại profile user + CDP → attach.
 * Tab signup mới. Không đóng Chrome khi script xong.
 */
async function ensureUserChromeCdp(cdpUrl = CDP_DEFAULT) {
  const prefer = cdpUrl || CDP_DEFAULT;
  const port = (prefer.match(/:(\d+)/) || [])[1] || "9222";
  const { exe, userData } = chromePaths();
  if (!existsSync(userData)) {
    throw new Error(`Không thấy Chrome User Data: ${userData}`);
  }

  // CDP đã sống → chỉ tab mới, không kill
  if (await cdpAlive(prefer)) {
    log(`CDP sẵn ${prefer} — tab mới`);
    return prefer;
  }

  if (!confirmKillChromeSync()) {
    throw new Error("Đã hủy — không đóng Chrome.");
  }

  // LUÔN kill trước khi mở debug — Chrome thường (không port) chặn CDP
  if (chromeRunning()) {
    killChrome();
    await sleep(2000);
  }
  if (chromeRunning()) {
    throw new Error(
      "Chrome vẫn chạy sau taskkill — đóng tay rồi chạy lại --user-chrome --yes"
    );
  }

  log(`mở Chrome user + debug :${port}`);
  log(`  ${exe}`);
  log(`  ${userData}`);
  launchChromeDebug(exe, userData, port);

  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await cdpAlive(prefer)) {
      log(`CDP OK ${prefer} (${(i + 1) * 0.5}s)`);
      return prefer;
    }
    if (i === 10 || i === 30) {
      log(`chờ CDP… chrome=${chromeRunning() ? "ON" : "OFF"}`);
    }
  }
  throw new Error(
    `CDP không lên sau khi mở Chrome (${prefer}).\n` +
      `  Chrome process: ${chromeRunning() ? "còn" : "không"}\n` +
      `  Thử tay:\n` +
      `  "${exe}" --remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --user-data-dir="${userData}"`
  );
}

function loadConfig() {
  const p = join(__dir, "config.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function loadLatest() {
  return loadLatestAcc();
}

function pickRandomName() {
  const p = join(MAIL_DIR, "names.json");
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    const list = data.names || data;
    if (!Array.isArray(list) || !list.length) return null;
    return list[Math.floor(Math.random() * list.length)];
  } catch {
    return null;
  }
}

function extractXaiCode(text, subject = "") {
  const t = `${subject}\n${text || ""}`;
  // xAI: RP5-EXX / ECU-X17
  const m =
    t.match(/\b([A-Z0-9]{2,4}-[A-Z0-9]{2,6})\b/) ||
    subject.match(/\b([A-Z0-9]{2,4}-[A-Z0-9]{2,6})\b/) ||
    t.match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}

function isXaiMail(m) {
  const blob = `${m.subject || ""} ${JSON.stringify(m.from || "")}`.toLowerCase();
  return /x\.ai|xai|noreply@x\.ai|confirmation code|spacexai/.test(blob);
}

/** Inbox list — BẮT BUỘC userToken (guest = 403) */
async function listInbox(email, token) {
  const r = await api(
    "GET",
    `/getedumail/emails/${encodeURIComponent(email)}/list?page=1`,
    { token }
  );
  if (!r.ok) throw new Error(`inbox ${r.status}: ${r.text?.slice(0, 120)}`);
  return r.json?.emails || [];
}

async function pollOtp(email, token, { log = console.log } = {}) {
  for (let i = 0; i < POLL_MAX; i++) {
    let mails = [];
    try {
      mails = await listInbox(email, token);
    } catch (e) {
      log(`[otp] ${e.message}`);
      await sleep(POLL_MS);
      continue;
    }
    for (const m of mails) {
      if (!isXaiMail(m)) continue;
      const body = htmlToText(m.body?.text || m.body?.html || "");
      const code = extractXaiCode(body, m.subject || "");
      if (code) {
        log(`[otp] ${code}  ← ${m.subject}`);
        return { code, subject: m.subject, body };
      }
    }
    process.stdout.write(i % 15 === 14 ? "\n" : ".");
    await sleep(POLL_MS);
  }
  console.log("");
  throw new Error("Timeout: không thấy OTP xAI (cần token + mail xAI)");
}

/** Logout xAI/Grok sau reg — clear cookie domain, về sign-in. */
async function logoutXai(page, context, logFn = log) {
  logFn("logout xAI…");
  const urls = [
    "https://accounts.x.ai/sign-out",
    "https://accounts.x.ai/logout",
    "https://grok.x.ai/",
  ];
  for (const u of urls) {
    try {
      await page.goto(u, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await sleep(800);
    } catch {
      /* */
    }
  }
  // bấm Sign out / Log out nếu còn UI
  try {
    const btn = page.getByRole("button", {
      name: /sign out|log out|logout|đăng xuất/i,
    });
    if (await btn.count()) {
      await btn.first().click({ timeout: 5000 }).catch(() => {});
      await sleep(800);
    }
    const link = page.getByRole("link", {
      name: /sign out|log out|logout/i,
    });
    if (await link.count()) {
      await link.first().click({ timeout: 5000 }).catch(() => {});
      await sleep(800);
    }
  } catch {
    /* */
  }
  // clear cookies x.ai / grok (không đụng cookie site khác trên Chrome user)
  try {
    const cookies = await context.cookies();
    const drop = cookies.filter((c) =>
      /(^|\.)x\.ai$|(^|\.)grok\.x\.ai$/i.test(String(c.domain || "").replace(/^\./, "").replace(/^/, ".")) ||
      /\.x\.ai$/i.test(c.domain || "") ||
      /x\.ai$/i.test(c.domain || "")
    );
    if (drop.length && typeof context.addCookies === "function") {
      // Playwright: clearCookies() xóa hết context — với user Chrome dùng CDP delete
      const cdp = await context.newCDPSession(page).catch(() => null);
      if (cdp) {
        for (const c of drop) {
          try {
            await cdp.send("Network.deleteCookies", {
              name: c.name,
              domain: c.domain,
              path: c.path || "/",
            });
          } catch {
            /* */
          }
        }
        logFn(`logout cookies cleared ~${drop.length}`);
      } else {
        await context.clearCookies();
        logFn("logout clearCookies(all context)");
      }
    }
  } catch (e) {
    logFn(`logout cookie: ${e.message?.slice(0, 60)}`);
  }
  try {
    await page.goto("https://accounts.x.ai/sign-in", {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
  } catch {
    /* */
  }
  logFn("logout xong");
}

async function fillFirst(page, selectors, value) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) {
      try {
        await loc.fill(value, { timeout: 3000 });
        return true;
      } catch {
        /* next */
      }
    }
  }
  return false;
}

async function clickFirst(page, names) {
  for (const name of names) {
    const btn = page.getByRole("button", { name });
    if (await btn.count().catch(() => 0)) {
      try {
        await btn.first().click({ timeout: 3000 });
        return true;
      } catch {
        /* next */
      }
    }
  }
  return false;
}

function wipeProfile() {
  if (!existsSync(PROFILE_DIR)) return;
  try {
    rmSync(PROFILE_DIR, { recursive: true, force: true });
    console.log(`[browser] wiped profile ${PROFILE_DIR}`);
  } catch (e) {
    console.warn(`[browser] wipe fail: ${e.message} — đóng Chromium cũ rồi chạy lại`);
  }
}

function resolveProxy() {
  if (NO_PROXY) return null;
  const cli = flag("--proxy", null);
  const file = flag("--proxy-file", null);
  if (cli === "0" || cli === "off") return null;
  return pickLiveProxy({
    prefer: cli || undefined,
    file: file ? join(__dir, file) : undefined,
    log: console.log,
  });
}

async function launchBrowser(useNopecha, nopechaKey, proxy) {
  // Chrome profile user / CDP: chrome.exe --remote-debugging-port=9222
  if (USER_CHROME || CDP) {
    if (USER_CHROME) CDP = await ensureUserChromeCdp(CDP || CDP_DEFAULT);
    else if (!(await cdpAlive(CDP))) {
      throw new Error(`CDP không sống: ${CDP}`);
    }
    log(`CDP attach ${CDP} → tab mới (giữ Chrome)`);
    const browser = await chromium.connectOverCDP(CDP);
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = await context.newPage(); // tab mới only
    try {
      await page.bringToFront();
    } catch {
      /* */
    }
    return { context, page, browser, userChrome: true };
  }

  // multi: luôn profile sạch theo worker
  if (FRESH || (WORKER && WORKER !== "0")) wipeProfile();
  mkdirSync(PROFILE_DIR, { recursive: true });
  const pwProxy = toPlaywrightProxy(proxy);
  if (pwProxy) {
    log(`proxy → ${pwProxy.server} (exit ${proxy.exitIp || "?"})`);
  }

  const channel = USE_CHROME ? "chrome" : undefined;
  log(`browser ${channel || "chromium"} profile=${PROFILE_DIR}`);

  // offset cửa sổ theo worker (tránh chồng)
  const w = Number(WORKER) || 0;
  const origin = { x: 40 + (w % 4) * 40, y: 40 + (w % 3) * 40 };

  if (useNopecha) {
    const path = ensureExtension(nopechaKey);
    log(`nopecha ${path}`);
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      channel,
      proxy: pwProxy,
      args: [
        `--disable-extensions-except=${path}`,
        `--load-extension=${path}`,
        "--disable-blink-features=AutomationControlled",
        `--window-position=${origin.x},${origin.y}`,
      ],
      locale: "en-US",
      viewport: { width: 1100, height: 800 },
    });
    const page = context.pages()[0] || (await context.newPage());
    return { context, page, browser: null };
  }

  const browser = await chromium.launch({
    headless: false,
    channel,
    proxy: pwProxy,
    args: [
      "--disable-blink-features=AutomationControlled",
      `--window-position=${origin.x},${origin.y}`,
    ],
  });
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  return { context, page, browser };
}

async function main() {
  const cfg = loadConfig();
  const nopechaKey = resolveNopechaKey(flag("--nopecha", null));
  const useNopecha = !NO_NOPECHA && existsSync(join(EXT_DIR, "manifest.json"));

  let acc;
  if (REUSE) {
    acc = loadLatest();
    if (!acc?.email) throw new Error("Không có getedumail-latest.json — bỏ --reuse");
    console.log(`[reuse] ${acc.email}`);
  } else {
    const name =
      cfg.randomName !== false
        ? pickRandomName() || cfg.name || "Alex Kowalski"
        : cfg.name || "Alex Kowalski";
    console.log(`[edu] tạo mail domain=${cfg.domain || "warsawuni.edu.pl"} name=${name}`);
    acc = await createAccount({
      domain: cfg.domain || "warsawuni.edu.pl",
      name,
      password: cfg.password || undefined,
      log: console.log,
    });
  }

  const grokPass =
    flag("--password", null) ||
    acc.password ||
    `Gx${Math.random().toString(36).slice(2, 10)}A1!`;

  const userChromeMode = USER_CHROME || !!CDP;
  const proxy = userChromeMode ? null : resolveProxy();
  if (userChromeMode && !NO_PROXY) {
    log("user-chrome: bỏ proxy Playwright (dùng proxy/extension trong Chrome user)");
  }

  console.log(`
─── EDU ───
Email : ${acc.email}
Pass  : ${acc.password || "(n/a)"}
─── GROK ───
URL   : ${SIGNUP_URL}
Pass  : ${grokPass}
Browser: ${userChromeMode ? "USER CHROME" : "Playwright"}
Proxy  : ${proxy ? `${proxy.server} → ${proxy.exitIp}` : userChromeMode ? "user" : "off"}
`);

  // user Chrome: proxy/extension do browser user lo; skip load NopeCHA PW
  const { context, page, browser, userChrome } = await launchBrowser(
    userChromeMode ? false : useNopecha,
    nopechaKey,
    userChromeMode ? null : proxy
  );

  console.log("[browser] signup — email path only (không bấm Sign up with X)");
  await page.goto(SIGNUP_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
  if (useNopecha && !userChrome) await sleep(2500);

  // cookie banner
  await clickFirst(page, [/accept all cookies|accept all|reject all/i]).catch(
    () => {}
  );
  await sleep(500);

  // BẮT BUỘC: Sign up with email — không match "Sign up with X"
  const emailBtn = page.getByRole("button", {
    name: /^sign up with email$/i,
  });
  if (await emailBtn.count()) {
    console.log("[browser] click Sign up with email");
    await emailBtn.first().click({ timeout: 10_000 });
    await sleep(1000);
  } else {
    const alt = page.getByRole("button", { name: /with email|email/i });
    if (await alt.count()) {
      console.log("[browser] click email button (alt)");
      await alt.first().click({ timeout: 10_000 });
      await sleep(1000);
    } else {
      console.log("[browser] không thấy nút email — thử fill trực tiếp");
    }
  }

  const emailFilled = await fillFirst(
    page,
    [
      'input[type="email"]',
      'input[name="email"]',
      'input[autocomplete="email"]',
      'input[placeholder*="mail" i]',
      'input[id*="email" i]',
    ],
    acc.email
  );
  if (!emailFilled) {
    console.log("[browser] FAIL: không có ô email — có thể đang ở Sign up with X");
  } else {
    console.log(`[browser] email filled: ${acc.email}`);
  }

  // bước 1 xAI chỉ có email + Sign up (password ở bước sau)
  await clickFirst(page, [/^sign up$/i, /continue|next|submit/i]);
  await sleep(1500);

  console.log(`[otp] poll ${acc.email}`);

  let otp;
  try {
    otp = await pollOtp(acc.email, acc.userToken, { log: console.log });
  } catch (e) {
    console.error(e.message);
    console.log("Giữ browser mở — dán OTP tay nếu mail về");
    await new Promise((resolve) => {
      context.on("close", resolve);
      if (browser) browser.on("disconnected", resolve);
    });
    return;
  }

  // OTP xAI: gõ liền vào ô đầu (UI auto-advance) — MEP-MXJ / ABC-XYZ
  {
    const raw = String(otp.code || "").replace(/\s/g, "");
    const typed = raw.includes("-") ? raw : raw; // giữ dấu - nếu có
    const otpInputs = page.locator("form input:visible");
    await page.waitForTimeout(800);
    const nOtp = await otpInputs.count();
    console.log(`[otp] code=${raw} inputs=${nOtp} → type liền ô đầu`);
    if (nOtp < 1) {
      console.log(`[otp] CODE = ${raw}  ← dán tay`);
    } else {
      await otpInputs.first().click();
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.type(typed, { delay: 60 });
    }
    await sleep(400);
    await clickFirst(page, [/confirm email|verify|confirm|continue|submit|next/i]);
  }

  // Form profile (sau verify email)
  await sleep(2000);
  await fillFirst(page, ['input[name*="first" i]', 'input[autocomplete="given-name"]'], "Alex");
  await fillFirst(page, ['input[name*="last" i]', 'input[autocomplete="family-name"]'], "Kowalski");
  await fillFirst(
    page,
    ['input[type="password"]', 'input[name="password"]', 'input[autocomplete="new-password"]'],
    grokPass
  );

  const ts = await solveTurnstileWithFallback(page, {
    pageUrl: page.url(),
    useExtension: useNopecha && !userChrome,
    tryTokenApi: !userChrome,
    extTimeoutMs: userChrome ? 8_000 : 25_000,
    manualTimeoutMs: userChrome ? 180_000 : 90_000,
  });

  let signupClicked = false;
  if (ts.ok) {
    const clk = await clickSignupAfterCaptcha(page, {
      settleMs: 2800,
      maxWaitMs: 25_000,
    });
    signupClicked = !!clk.ok;
    if (clk.ok) await sleep(3000);
  }

  const regOk = ts.ok && signupClicked;
  const result = {
    ok: regOk,
    worker: TAG,
    email: acc.email,
    eduPassword: acc.password,
    grokPassword: grokPass,
    otp: otp?.code || null,
    proxy: proxy ? { server: proxy.server, exitIp: proxy.exitIp } : null,
    turnstile: ts.via,
    at: new Date().toISOString(),
  };

  mkdirSync(join(__dir, "acc"), { recursive: true });
  writeFileSync(
    join(__dir, "acc", "grok-latest.json"),
    JSON.stringify(result, null, 2)
  );
  const jl = join(__dir, "acc", "grok-results.jsonl");
  writeFileSync(jl, JSON.stringify(result) + "\n", { flag: "a" });
  writeFileSync(
    join(__dir, "acc", `grok-${Date.now()}.json`),
    JSON.stringify(result, null, 2)
  );
  log(`saved ok=${regOk} ${acc.email}`);

  // reg xong → logout session (clear cookie xAI) rồi đóng tab reg
  if (regOk) {
    await logoutXai(page, context, log);
  }

  if (userChrome || USER_CHROME) {
    try {
      await page.close({ runBeforeUnload: false }).catch(() => {});
    } catch {
      /* */
    }
    log("xong — đã save + logout, đóng tab reg. Chrome user giữ nguyên.");
    try {
      browser?.removeAllListeners?.("disconnected");
    } catch {
      /* */
    }
    process.exit(regOk ? 0 : 2);
  }

  if (AUTO_CLOSE) {
    await sleep(1500);
    await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    process.exit(ts.ok ? 0 : 2);
  }

  log("đóng browser khi xong (hoặc --auto-close)");
  await new Promise((resolve) => {
    context.on("close", resolve);
    if (browser) browser.on("disconnected", resolve);
  });
}

main().catch((e) => {
  console.error(`[${TAG}]`, e.message || e);
  process.exit(1);
});
