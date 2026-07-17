#!/usr/bin/env node
/**
 * Edu mail + Grok/xAI signup
 * Mặc định: Chrome USER profile + CDP
 *   node reg-grok.mjs
 *   node reg-grok.mjs --reuse
 *   node reg-grok.mjs --yes
 *   node reg-grok.mjs --cdp http://127.0.0.1:9222
 *   node reg-grok.mjs --playwright
 *   node reg-multi.mjs -n 5
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";
import { chromium } from "playwright";
import {
  createAccount,
  api,
  htmlToText,
  loginForToken,
  resolveToken,
  listAccFiles,
  loadAcc,
  __dir as MAIL_DIR,
  loadLatest as loadLatestAcc,
} from "../mail/getedumail-core.mjs";
import {
  solveTurnstileWithFallback,
  clickSignupAfterCaptcha,
  reloadTurnstile,
} from "./turnstile.mjs";
import {
  parseProxyLine,
  pickLiveProxy,
  toPlaywrightProxy,
} from "./proxy.mjs";
import {
  autoAuthNineRouter,
  nineRouterDefaults,
} from "./nine-router-auth.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const REUSE = args.includes("--reuse");
const FRESH = args.includes("--fresh");
const NO_PROXY = args.includes("--no-proxy");
const AUTO_CLOSE = args.includes("--auto-close");
const USE_CHROME = !args.includes("--chromium");
// default = user Chrome; --playwright / --pw = legacy PW profile
const PLAYWRIGHT =
  args.includes("--playwright") ||
  args.includes("--pw") ||
  process.env.GROK_PLAYWRIGHT === "1";
const USER_CHROME =
  !PLAYWRIGHT ||
  args.includes("--user-chrome") ||
  args.includes("--real");
const YES =
  args.includes("--yes") ||
  args.includes("-y") ||
  process.env.GROK_YES === "1" ||
  USER_CHROME; // multi/user: không hỏi kill mỗi job
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

/** Log dễ đọc: [W0] · bước · nội dung */
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
function log(...a) {
  console.log(`${C.dim(`[${TAG}]`)}`, ...a);
}
function logOk(...a) {
  console.log(`${C.dim(`[${TAG}]`)} ${C.green("✓")}`, ...a);
}
function logWarn(...a) {
  console.log(`${C.dim(`[${TAG}]`)} ${C.yellow("!")}`, ...a);
}
function logErr(...a) {
  console.log(`${C.dim(`[${TAG}]`)} ${C.red("✗")}`, ...a);
}
function logPhase(title) {
  console.log(`\n${C.cyan("──")} ${C.bold(title)} ${C.cyan("────────────────────────────")}`);
}
function logKv(label, value) {
  console.log(`${C.dim(`[${TAG}]`)}   ${String(label).padEnd(12)} ${value}`);
}

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

/** Domain list: domains[] + domain, rotate theo worker/time. */
function pickDomain(cfg, worker = "0") {
  const list = [
    ...(Array.isArray(cfg.domains) ? cfg.domains : []),
    cfg.domain,
  ]
    .map((d) => String(d || "").trim().toLowerCase())
    .filter(Boolean);
  const uniq = [...new Set(list)];
  if (!uniq.length) return "iunp.edu.rs";
  const w = Number(worker) || 0;
  const idx = (w + Date.now()) % uniq.length;
  return uniq[idx];
}

/** Email đã dùng reg grok (ok/fail) — từ results.jsonl + grok-*.json */
function usedGrokEmails() {
  const set = new Set();
  const add = (e) => {
    if (e) set.add(String(e).toLowerCase());
  };
  const jsonl = join(__dir, "acc", "grok-results.jsonl");
  if (existsSync(jsonl)) {
    try {
      for (const line of readFileSync(jsonl, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          add(JSON.parse(line).email);
        } catch {
          /* */
        }
      }
    } catch {
      /* */
    }
  }
  try {
    const accDir = join(__dir, "acc");
    if (existsSync(accDir)) {
      for (const f of readdirSync(accDir)) {
        if (!/^grok-.*\.json$/i.test(f) || f === "grok-results.jsonl") continue;
        try {
          add(JSON.parse(readFileSync(join(accDir, f), "utf8")).email);
        } catch {
          /* */
        }
      }
    }
  } catch {
    /* */
  }
  return set;
}

/** Lấy edu mail cũ chưa reg Grok (mail/acc/*.json). */
function pickUnusedEdu(cfg) {
  if (cfg.reuseUnusedEdu === false) return null;
  const used = usedGrokEmails();
  let list = [];
  try {
    list = listAccFiles();
  } catch {
    return null;
  }
  // cũ trước (id nhỏ) — luân phiên stock
  const unused = list
    .filter((a) => a.email && !used.has(String(a.email).toLowerCase()))
    .sort((a, b) => (a.id || 0) - (b.id || 0));
  if (!unused.length) return null;
  const pick = unused[0];
  try {
    return loadAcc(pick.id) || pick;
  } catch {
    return pick;
  }
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

async function pollOtp(email, token, { password, log = console.log } = {}) {
  let tok = token;
  let authTried = false;
  for (let i = 0; i < POLL_MAX; i++) {
    let mails = [];
    try {
      mails = await listInbox(email, tok);
    } catch (e) {
      const msg = e.message || "";
      log(`[otp] ${msg}`);
      // fallback: inbox 401/403 → login lại lấy token
      if (!authTried && password && /403|401|inbox/i.test(msg)) {
        authTried = true;
        const fresh =
          (await resolveToken({ email, password, userToken: tok })) ||
          (await loginForToken(email, password));
        if (fresh) {
          tok = fresh;
          log("[otp] token refresh OK — poll lại");
          continue;
        }
        log("[otp] token refresh FAIL");
      }
      await sleep(POLL_MS);
      continue;
    }
    for (const m of mails) {
      if (!isXaiMail(m)) continue;
      const body = htmlToText(m.body?.text || m.body?.html || "");
      const code = extractXaiCode(body, m.subject || "");
      if (code) {
        log(`[otp] ${code}  ← ${m.subject}`);
        return { code, subject: m.subject, body, userToken: tok };
      }
    }
    process.stdout.write(i % 15 === 14 ? "\n" : ".");
    await sleep(POLL_MS);
  }
  console.log("");
  throw new Error("Timeout: không thấy OTP xAI (cần token + mail xAI)");
}

function isXaiCookie(c) {
  const d = String(c.domain || "")
    .toLowerCase()
    .replace(/^\./, "");
  return (
    /(^|\.)x\.ai$/i.test(d) ||
    /grok/i.test(d) ||
    /auth\.x\.ai/i.test(d) ||
    /accounts\.x\.ai/i.test(d)
  );
}

function isNavDestroyed(e) {
  const m = String(e?.message || e || "");
  return /Execution context was destroyed|Target closed|Session closed|frame was detached|navigat/i.test(
    m
  );
}

function safePageUrl(page) {
  try {
    return page.url() || "";
  } catch {
    return "";
  }
}

/** URL-only detect — không evaluate (an toàn khi đang navigate). */
function detectFromUrl(url) {
  const u = String(url || "");
  const onSignup = /sign-up|sign_up|signup|register/i.test(u);
  const onSignin = /sign-in|sign_in|login/i.test(u) && !onSignup;
  const onApp =
    !onSignup &&
    /grok\.x\.ai|console\.x\.ai|\/chat|\/home|\/c\/|welcome|accounts\.x\.ai\/(account|settings)/i.test(
      u
    );
  if (onApp) return { step: "done", url: u.slice(0, 120), via: "url" };
  if (onSignup) return { step: "signup", url: u.slice(0, 120), via: "url" };
  if (onSignin) return { step: "signin", url: u.slice(0, 120), via: "url" };
  return null;
}

/**
 * Snapshot DOM signup — nguồn truth cho mọi step.
 * An toàn khi navigate: retry 1 lần + fallback URL.
 */
async function detectPage(page) {
  const url0 = safePageUrl(page);
  const urlHit = detectFromUrl(url0);
  if (urlHit?.step === "done") {
    return {
      step: "done",
      url: urlHit.url,
      hasEmailInput: false,
      hasPassword: false,
      hasFirst: false,
      hasLast: false,
      hasOtp: false,
      otpCount: 0,
      hasSignupEmailBtn: false,
      hasComplete: false,
      hasSignOut: false,
      captcha: false,
      turnstileOk: false,
      err: false,
      errSnippet: "",
      via: "url-done",
    };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) {
        await sleep(400);
        await page.waitForLoadState?.("domcontentloaded").catch(() => {});
      }
      return await page.evaluate(() => {
        const url = location.href;
        const text = (document.body?.innerText || "").slice(0, 6000);
        const lower = text.toLowerCase();

        const visible = (el) => {
          if (!el) return false;
          const s = getComputedStyle(el);
          if (
            s.display === "none" ||
            s.visibility === "hidden" ||
            s.opacity === "0"
          )
            return false;
          const r = el.getBoundingClientRect();
          return r.width > 2 && r.height > 2;
        };
        const inputs = [...document.querySelectorAll("input")].filter(visible);
        const buttons = [
          ...document.querySelectorAll("button,[role='button'],a"),
        ].filter(visible);
        const btnText = (b) => (b.innerText || b.textContent || "").trim();

        const hasEmailInput = inputs.some(
          (i) =>
            i.type === "email" ||
            /email/i.test(i.name + i.id + i.autocomplete + i.placeholder)
        );
        const hasPassword = inputs.some(
          (i) =>
            i.type === "password" ||
            /password/i.test(i.name + i.id + i.autocomplete)
        );
        const hasFirst = inputs.some((i) =>
          /first|given/i.test(i.name + i.id + i.autocomplete + i.placeholder)
        );
        const hasLast = inputs.some((i) =>
          /last|family|surname/i.test(
            i.name + i.id + i.autocomplete + i.placeholder
          )
        );
        const otpInputs = inputs.filter((i) => {
          if (i.type === "password" || i.type === "email" || i.type === "hidden")
            return false;
          const meta = `${i.name} ${i.id} ${i.autocomplete} ${i.placeholder} ${i.inputMode}`;
          if (/otp|one.?time|verif|code|pin/i.test(meta)) return true;
          if (i.maxLength > 0 && i.maxLength <= 2) return true;
          if (i.inputMode === "numeric" && !/phone|tel/i.test(meta)) return true;
          return false;
        });
        const hasOtp =
          otpInputs.length >= 1 &&
          !hasPassword &&
          (/verif|confirm|code|one.?time|enter the code|check your email/i.test(
            lower
          ) ||
            otpInputs.length >= 4 ||
            otpInputs.some((i) => /otp|code|verif/i.test(i.name + i.id)));

        const hasSignupEmailBtn = buttons.some((b) =>
          /^sign up with email$/i.test(btnText(b))
        );
        const hasSignupX = buttons.some((b) =>
          /sign up with x\b|continue with x\b/i.test(btnText(b))
        );
        const hasComplete = buttons.some((b) =>
          /complete sign up|create (your )?account/i.test(btnText(b))
        );
        const hasSignOut = buttons.some((b) =>
          /sign out|log out|logout/i.test(btnText(b))
        );
        const hasSignInForm =
          /sign in|log in/i.test(lower) &&
          hasEmailInput &&
          hasPassword &&
          !/sign up with email/i.test(lower);

        const turnstileIframe = [...document.querySelectorAll("iframe")].some(
          (f) => /turnstile|challenges\.cloudflare/i.test(f.src || f.title || "")
        );
        const cfToken = [
          ...document.querySelectorAll(
            'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
          ),
        ].some((i) => (i.value || "").length > 20);
        const turnstileOk =
          cfToken ||
          [...document.querySelectorAll("iframe")].some((f) =>
            /success|verified|complete|passed/i.test(
              `${f.title || ""} ${f.getAttribute("aria-label") || ""}`
            )
          ) ||
          /Success!|verified you are human/i.test(text);

        const err =
          /something went wrong|try again|already (been )?registered|email (is )?already|invalid (email|code)|too many|blocked|suspended|rate limit/i.test(
            text
          );

        const onSignup = /sign-up|sign_up|signup|register/i.test(url);
        const onSignin = /sign-in|sign_in|login/i.test(url) && !onSignup;
        const onApp =
          !onSignup &&
          !onSignin &&
          /grok\.x\.ai|console\.|\/chat|\/home|\/c\//i.test(url);

        let step = "unknown";
        if (onApp || hasSignOut) step = "done";
        else if (
          /start chatting|go to grok|open grok|welcome to grok/i.test(lower) &&
          !hasEmailInput
        )
          step = "done";
        else if (hasOtp) step = "otp";
        else if (
          hasPassword &&
          (hasFirst || hasLast || hasComplete || turnstileIframe)
        )
          step = "profile";
        else if (hasPassword && hasEmailInput && hasSignInForm) step = "signin";
        else if (hasEmailInput && onSignup) step = "email";
        else if (hasSignupEmailBtn || (hasSignupX && onSignup)) step = "chooser";
        else if (onSignin) step = "signin";
        else if (onSignup) step = "chooser";
        else if (/you are (already )?signed in|welcome back/i.test(lower))
          step = "logged";

        const captcha = !!(turnstileIframe || cfToken);

        return {
          step,
          url: url.slice(0, 120),
          hasEmailInput,
          hasPassword,
          hasFirst,
          hasLast,
          hasOtp,
          otpCount: otpInputs.length,
          hasSignupEmailBtn,
          hasComplete,
          hasSignOut,
          captcha,
          turnstileOk,
          err: !!err,
          errSnippet: err
            ? text.match(
                /[^\n]{0,40}(already|invalid|blocked|wrong|limit)[^\n]{0,40}/i
              )?.[0]
            : "",
        };
      });
    } catch (e) {
      const url = safePageUrl(page);
      const fromUrl = detectFromUrl(url);
      if (fromUrl?.step === "done" || isNavDestroyed(e)) {
        // navigate sau Complete → done
        if (fromUrl?.step === "done" || (!/sign-up|signup/i.test(url) && url)) {
          return {
            step: fromUrl?.step === "done" || !/sign-up|signup|sign-in/i.test(url)
              ? "done"
              : fromUrl?.step || "unknown",
            url: url.slice(0, 120),
            hasEmailInput: false,
            hasPassword: false,
            hasFirst: false,
            hasLast: false,
            hasOtp: false,
            otpCount: 0,
            hasSignupEmailBtn: false,
            hasComplete: false,
            hasSignOut: false,
            captcha: false,
            turnstileOk: false,
            err: false,
            errSnippet: "",
            via: "nav-recover",
            navErr: String(e.message || e).slice(0, 80),
          };
        }
        if (attempt < 2) continue;
      }
      if (attempt < 2 && isNavDestroyed(e)) continue;
      return {
        step: fromUrl?.step || "unknown",
        url: url.slice(0, 120),
        hasEmailInput: false,
        hasPassword: false,
        hasFirst: false,
        hasLast: false,
        hasOtp: false,
        otpCount: 0,
        hasSignupEmailBtn: false,
        hasComplete: false,
        hasSignOut: false,
        captcha: false,
        turnstileOk: false,
        err: !isNavDestroyed(e),
        errSnippet: String(e.message || e).slice(0, 80),
      };
    }
  }
  return { step: "unknown", url: safePageUrl(page).slice(0, 120), err: true };
}

function saveGrokResult(result) {
  mkdirSync(join(__dir, "acc"), { recursive: true });
  const latest = join(__dir, "acc", "grok-latest.json");
  writeFileSync(latest, JSON.stringify(result, null, 2));
  writeFileSync(
    join(__dir, "acc", "grok-results.jsonl"),
    JSON.stringify(result) + "\n",
    { flag: "a" }
  );
  // phân loại file theo status nếu có
  const st = result.test?.status || (result.ok ? "ok" : "fail");
  writeFileSync(
    join(__dir, "acc", `grok-${st}-${Date.now()}.json`),
    JSON.stringify(result, null, 2)
  );
  return latest;
}

/**
 * Đọc banner lỗi login/signup trên page.
 * status: ok | wrong_pass | wrong_mail | die | suspended | rate_limit | incomplete | captcha | unknown
 */
async function classifyAccountUi(page) {
  try {
    return await page.evaluate(() => {
      const text = (document.body?.innerText || "").slice(0, 8000);
      const lower = text.toLowerCase();
      const url = location.href;

      const checks = [
        {
          status: "suspended",
          re: /suspended|banned|disabled|deactivated|terminated|violat|not allowed to|account (has been )?locked/i,
        },
        {
          status: "wrong_pass",
          re: /incorrect password|wrong password|password (is )?incorrect|invalid password|password you entered|doesn't match/i,
        },
        {
          status: "wrong_mail",
          re: /no account|couldn't find|user not found|email (not|isn't) (found|registered)|invalid email|we don't recognize|doesn't exist/i,
        },
        {
          status: "rate_limit",
          re: /too many|rate limit|try again later|slow down|temporarily blocked/i,
        },
        {
          status: "die",
          re: /account (is )?(closed|deleted|removed)|no longer available|does not exist/i,
        },
        {
          status: "captcha",
          re: /verify you are human|turnstile|captcha|security check/i,
        },
      ];
      for (const c of checks) {
        if (c.re.test(text)) return { status: c.status, snippet: text.slice(0, 100) };
      }

      // URL / UI success
      if (
        /grok\.x\.ai|console\.x\.ai|\/chat|\/home|\/c\//i.test(url) ||
        /start chatting|welcome to grok|signed in as/i.test(lower)
      ) {
        return { status: "ok", snippet: url.slice(0, 80) };
      }
      if (/sign-up|signup/i.test(url) && /complete sign up|create account/i.test(lower)) {
        return { status: "incomplete", snippet: "vẫn form signup" };
      }
      if (/sign-in|login/i.test(url)) {
        return { status: "need_login", snippet: "ở trang sign-in" };
      }
      return { status: "unknown", snippet: text.slice(0, 80).replace(/\s+/g, " ") };
    });
  } catch (e) {
    const url = safePageUrl(page);
    if (/grok\.x\.ai|\/chat|\/home/i.test(url))
      return { status: "ok", snippet: url, via: "url" };
    return {
      status: "unknown",
      snippet: String(e.message || e).slice(0, 60),
    };
  }
}

/**
 * Test acc TRƯỚC khi lưu: session hiện tại hoặc login email/pass.
 * Fallback theo status.
 */
async function testGrokAccount(page, { email, password, logFn = log } = {}) {
  const out = {
    status: "unknown",
    ok: false,
    tries: [],
    at: new Date().toISOString(),
  };

  const push = (t) => {
    out.tries.push(t);
    logFn(`test: ${t.status}${t.note ? " — " + t.note : ""}`);
  };

  // 1) session hiện tại
  let ui = await classifyAccountUi(page);
  push({ status: ui.status, note: "session", snippet: ui.snippet });

  if (ui.status === "ok") {
    // xác nhận vào grok
    try {
      await page.goto("https://grok.x.ai/", {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      });
      await sleep(1200);
      ui = await classifyAccountUi(page);
      push({ status: ui.status, note: "grok.x.ai", snippet: ui.snippet });
    } catch (e) {
      push({ status: "unknown", note: `nav grok: ${String(e.message || e).slice(0, 40)}` });
    }
    if (ui.status === "ok" || /grok\.x\.ai/i.test(safePageUrl(page))) {
      out.status = "ok";
      out.ok = true;
      out.note = "session live";
      return out;
    }
  }

  // 2) login bằng email/pass (từ latest / reg)
  if (!email || !password) {
    out.status = ui.status === "need_login" ? "wrong_mail" : ui.status;
    out.ok = false;
    out.note = "thiếu email/pass để test login";
    return out;
  }

  const loginOnce = async (pass, tag) => {
    try {
      await page.goto("https://accounts.x.ai/sign-in", {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      await sleep(800);
      await clickFirst(page, [/accept all cookies|accept all/i]).catch(() => {});

      // Login with email
      const emailBtn = page.getByRole("button", {
        name: /login with email|sign in with email/i,
      });
      if (await emailBtn.count()) {
        await emailBtn.first().click({ timeout: 8000 }).catch(() => {});
        await sleep(800);
      }

      await fillFirst(
        page,
        [
          'input[type="email"]',
          'input[autocomplete="email"]',
          'input[autocomplete="username"]',
          'input[name*="email" i]',
        ],
        email
      );
      await clickFirst(page, [/^continue$/i, /^next$/i, /^sign in$/i]);
      await sleep(1000);

      // password
      for (let i = 0; i < 8; i++) {
        const pw = page.locator('input[type="password"]:visible').first();
        if ((await pw.count()) && (await pw.isVisible().catch(() => false))) {
          await fillReact(page, pw, pass);
          break;
        }
        await sleep(400);
      }
      await clickFirst(page, [
        /^continue$/i,
        /^sign in$/i,
        /^log in$/i,
        /^next$/i,
        /^submit$/i,
      ]);
      await sleep(2000);

      const r = await classifyAccountUi(page);
      push({ status: r.status, note: tag, snippet: r.snippet });
      return r;
    } catch (e) {
      const r = {
        status: "unknown",
        snippet: String(e.message || e).slice(0, 60),
      };
      push({ ...r, note: tag + "-err" });
      return r;
    }
  };

  let r = await loginOnce(password, "login#1");

  // ── fallbacks ──
  if (r.status === "wrong_pass") {
    logWarn("Sai mật khẩu → gõ lại 1 lần (react fill)");
    r = await loginOnce(password, "login#2-retype");
  }

  if (r.status === "rate_limit") {
    logWarn("Rate limit → chờ 8s thử lại");
    await sleep(8000);
    r = await loginOnce(password, "login#rate-retry");
  }

  if (r.status === "captcha") {
    logWarn("Captcha lúc login — chờ tay 45s");
    const t0 = Date.now();
    while (Date.now() - t0 < 45_000) {
      await sleep(1500);
      r = await classifyAccountUi(page);
      if (r.status === "ok" || r.status === "need_login") break;
      if (["wrong_pass", "wrong_mail", "die", "suspended"].includes(r.status))
        break;
    }
    push({ status: r.status, note: "after-captcha-wait" });
    if (r.status === "need_login") r = await loginOnce(password, "login#post-captcha");
  }

  if (r.status === "ok" || /grok\.x\.ai|console/i.test(safePageUrl(page))) {
    // probe app
    try {
      await page.goto("https://grok.x.ai/", {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      await sleep(1000);
      r = await classifyAccountUi(page);
      push({ status: r.status, note: "probe-app" });
    } catch {
      /* */
    }
  }

  // need_login sau submit ≠ wrong_pass (form chưa load / chưa create)
  // chỉ wrong_pass khi UI báo sai MK rõ ràng
  out.status = r.status;
  if (out.status === "unknown" && /grok\.x\.ai/i.test(safePageUrl(page))) {
    out.status = "ok";
  }
  if (out.status === "need_login") {
    out.status = "unknown";
    out.note = "login xong vẫn sign-in — reg dở / captcha / fill";
  }
  out.ok = out.status === "ok";
  out.note = out.note || r.snippet || "";
  out.url = safePageUrl(page).slice(0, 120);

  // gợi ý fallback
  const tips = {
    ok: "Acc live — lưu + 9r (nếu bật)",
    wrong_pass: "Sai MK — kiểm tra fill React / latest.grokPassword; không push 9r",
    wrong_mail: "Sai/không có mail — reg lại edu, không push 9r",
    die: "Acc chết/xóa — bỏ, reg acc mới",
    suspended: "Acc khóa/suspend — bỏ, reg acc mới",
    rate_limit: "Bị limit — đổi proxy / chờ, thử lại sau",
    incomplete: "Reg dở (chưa Complete / còn sign-up) — không test login, chạy lại",
    captcha: "Kẹt captcha login — giải tay rồi test lại",
    unknown: "Không rõ (có thể reg dở / form chưa load) — xem snippet / URL",
  };
  out.tip = tips[out.status] || tips.unknown;
  return out;
}

/** Chờ step ∈ want (hoặc predicate). Không retry action — chỉ poll. */
async function waitStep(page, want, { timeoutMs = 30_000, pollMs = 120, logFn = log } = {}) {
  const set = new Set(Array.isArray(want) ? want : [want]);
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    const d = await detectPage(page);
    const key = `${d.step}|e=${d.hasEmailInput}|o=${d.hasOtp}|p=${d.hasPassword}|c=${d.captcha}`;
    if (key !== last) {
      logFn(`step=${d.step} captcha=${!!d.captcha}${d.err ? " ERR" : ""}`);
      last = key;
    }
    if (set.has(d.step)) return d;
    if (d.step === "done" && set.has("done")) return d;
    await sleep(pollMs);
  }
  return detectPage(page);
}

/** Đếm mọi cookie *.x.ai (không chỉ session name). */
async function countXaiCookies(context) {
  let all = [];
  try {
    all = await context
      .cookies([
        "https://accounts.x.ai",
        "https://grok.x.ai",
        "https://x.ai",
        "https://auth.x.ai",
      ])
      .catch(() => context.cookies());
  } catch {
    try {
      all = await context.cookies();
    } catch {
      all = [];
    }
  }
  const xai = all.filter(isXaiCookie);
  const sess = xai.filter((c) =>
    /session|auth|token|sid|jwt|access|refresh|st-|__Host|__Secure|cf_clearance|sso/i.test(
      c.name
    )
  );
  return {
    cookieHit: xai.length,
    sessionHit: sess.length,
    sessionNames: sess.map((c) => c.name).slice(0, 12),
    names: xai.map((c) => c.name).slice(0, 12),
  };
}

/** Detect còn session / đã login — nới lỏng: 1 cookie xAI + không form signup = login. */
async function detectLoggedIn(page, context) {
  const ck = await countXaiCookies(context);
  const d = await detectPage(page);
  const url = d.url || safePageUrl(page);
  const onSignupForm = ["chooser", "email", "otp", "profile"].includes(d.step);
  const onSignupUrl = /sign-up|sign_up|signup/i.test(url);
  const uiLogged =
    d.step === "done" ||
    d.step === "logged" ||
    d.hasSignOut ||
    /signed in as|you are signed in/i.test(d.snippet || "");
  // cookie bất kỳ trên x.ai + không đang form signup = coi là còn session
  const cookieLogged =
    (ck.sessionHit >= 1 || ck.cookieHit >= 1) && !onSignupForm;
  // URL app / unknown khi đáng lẽ signup
  const urlLogged =
    /grok\.x\.ai|console\.x\.ai|\/chat|\/home|\/c\//i.test(url) &&
    !onSignupUrl;
  const logged = uiLogged || cookieLogged || urlLogged;

  return {
    logged,
    cookieHit: ck.cookieHit,
    sessionHit: ck.sessionHit,
    sessionNames: ck.sessionNames,
    ui: d.step,
    page: d,
    url,
  };
}

/** Xóa cookie + storage xAI/Grok (CDP) — MỌI cookie domain x.ai. */
async function clearXaiSession(page, context, logFn = log) {
  let n = 0;
  try {
    const cookies = await context.cookies().catch(() => []);
    const drop = cookies.filter(isXaiCookie);
    n = drop.length;
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
        // thử thêm domain với/không chấm đầu
        try {
          const dom = String(c.domain || "").replace(/^\./, "");
          await cdp.send("Network.deleteCookies", {
            name: c.name,
            domain: "." + dom,
            path: c.path || "/",
          });
        } catch {
          /* */
        }
      }
      // wipe storage origin accounts / grok / auth
      for (const origin of [
        "https://accounts.x.ai",
        "https://grok.x.ai",
        "https://auth.x.ai",
        "https://x.ai",
      ]) {
        try {
          await cdp.send("Storage.clearDataForOrigin", {
            origin,
            storageTypes:
              "cookies,local_storage,session_storage,indexeddb,cache_storage,service_workers",
          });
        } catch {
          /* */
        }
      }
      try {
        await page.evaluate(() => {
          try {
            localStorage.clear();
            sessionStorage.clear();
          } catch {
            /* */
          }
        });
      } catch {
        /* */
      }
      logFn(`clear xAI cookies=${n} + Storage.clearDataForOrigin`);
    } else if (drop.length) {
      await context.clearCookies();
      logFn("clearCookies(all context)");
    } else {
      logFn("clear xAI: 0 cookies listed");
    }
  } catch (e) {
    logFn(`clear session: ${e.message?.slice(0, 80)}`);
  }
  return n;
}

/** Logout xAI/Grok — wipe cookie TRƯỚC + URL sign-out + UI. */
async function logoutXai(page, context, logFn = log) {
  logFn("logout xAI (force wipe)…");
  // 1) wipe cookies/storage trước (kể cả khi không vào được sign-out)
  await clearXaiSession(page, context, logFn);

  const urls = [
    "https://accounts.x.ai/sign-out",
    "https://accounts.x.ai/logout",
    "https://auth.x.ai/logout",
    "https://grok.x.ai/",
  ];
  for (const u of urls) {
    try {
      await page.goto(u, { waitUntil: "domcontentloaded", timeout: 10_000 });
      await sleep(400);
    } catch {
      /* */
    }
  }
  try {
    const btn = page.getByRole("button", {
      name: /sign out|log out|logout|đăng xuất/i,
    });
    if (await btn.count()) {
      await btn.first().click({ timeout: 5000 }).catch(() => {});
      await sleep(400);
    }
    const link = page.getByRole("link", {
      name: /sign out|log out|logout/i,
    });
    if (await link.count()) {
      await link.first().click({ timeout: 5000 }).catch(() => {});
      await sleep(400);
    }
  } catch {
    /* */
  }
  // 2) wipe lại sau sign-out (cookie mới có thể set)
  await clearXaiSession(page, context, logFn);
  try {
    await page.goto("https://accounts.x.ai/sign-up", {
      waitUntil: "domcontentloaded",
      timeout: 12_000,
    });
  } catch {
    /* */
  }
  const again = await countXaiCookies(context);
  if (again.cookieHit > 0) {
    logFn(`logout còn ${again.cookieHit} cookies — wipe lần 3`);
    await clearXaiSession(page, context, logFn);
  }
  logFn("logout xong");
}

/**
 * Trước reg: force logout nếu còn cookie / UI login / không thấy form signup.
 * force=true → luôn wipe (dùng khi email step fail).
 */
async function ensureLoggedOut(page, context, logFn = log, { force = false } = {}) {
  const st = await detectLoggedIn(page, context);
  const need =
    force ||
    st.logged ||
    st.cookieHit >= 1 ||
    !["chooser", "email"].includes(st.ui);

  if (!need && !force) {
    logFn(`session: clean step=${st.ui} cookies=${st.cookieHit}`);
    return false;
  }
  logFn(
    `session LOGOUT force=${force} cookies=${st.cookieHit} sess=${st.sessionHit} ui=${st.ui} [${(st.sessionNames || []).join(",")}]`
  );
  await logoutXai(page, context, logFn);
  return true;
}

/**
 * Fill React-safe: clear → native value setter → input/change events.
 * Playwright .fill() hay sót / dính text cũ trên xAI → "wrong password".
 */
async function fillReact(page, loc, value) {
  const want = String(value ?? "");
  await loc.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  await loc.click({ timeout: 3000 }).catch(() => {});
  // clear triệt để
  await loc.fill("").catch(() => {});
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  // native setter (React controlled)
  await loc.evaluate((el, v) => {
    el.focus();
    const proto =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, "");
    else el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    if (desc?.set) desc.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    try {
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: v,
          inputType: "insertText",
        })
      );
    } catch {
      /* */
    }
  }, want);
  // verify
  let got = await loc.inputValue().catch(() => "");
  if (got !== want) {
    // fallback type từng ký tự
    await loc.click().catch(() => {});
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.type(want, { delay: 25 });
    got = await loc.inputValue().catch(() => "");
  }
  return got === want || got.replace(/\s/g, "") === want.replace(/\s/g, "");
}

async function fillFirst(page, selectors, value) {
  const want = String(value ?? "");
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (!(await loc.count().catch(() => 0))) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    try {
      const ok = await fillReact(page, loc, want);
      if (ok) return true;
      // chấp nhận fill gần đúng (password type hay che)
      const got = await loc.inputValue().catch(() => "");
      if (got && got.length === want.length) return true;
    } catch {
      /* next */
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
  const live = pickLiveProxy({
    prefer: cli || undefined,
    file: file ? join(__dir, file) : undefined,
    log: console.log,
  });
  if (live) return live;
  // fallback: CLI proxy không test được → vẫn thử (exit IP unknown)
  if (cli && cli !== "0" && cli !== "off") {
    const p = parseProxyLine(cli);
    if (p) {
      log("proxy test FAIL — vẫn dùng CLI proxy (no exit check)");
      return p;
    }
  }
  log("proxy: không live — chạy direct (fallback). Dùng --no-proxy để im lặng.");
  return null;
}

/** Step-aware: chooser → email → fill → submit. Chỉ retry khi vẫn đúng step. */
async function fillSignupEmail(page, email) {
  await clickFirst(page, [/accept all cookies|accept all|reject all/i]).catch(
    () => {}
  );

  for (let attempt = 1; attempt <= 2; attempt++) {
    let d = await detectPage(page);
    log(
      `email-step try=${attempt} now=${d.step} emailIn=${!!d.hasEmailInput} url=${(d.url || "").slice(0, 50)}`
    );

    // đã qua email → không fill lại
    if (["otp", "profile", "done"].includes(d.step)) {
      log(`skip fill email — đã ở step=${d.step}`);
      return true;
    }

    // unknown/done/signin: thử bấm email path dù detect lỏng
    if (
      d.step === "chooser" ||
      d.hasSignupEmailBtn ||
      (d.step === "unknown" && !d.hasEmailInput)
    ) {
      const emailBtn = page.getByRole("button", {
        name: /^sign up with email$/i,
      });
      if (await emailBtn.count()) {
        log("click Sign up with email");
        await emailBtn.first().click({ timeout: 10_000 }).catch(() => {});
      } else {
        const alt = page.getByRole("button", {
          name: /sign up with email|with email/i,
        });
        if (await alt.count())
          await alt.first().click({ timeout: 10_000 }).catch(() => {});
        else {
          // DOM fallback
          await page
            .evaluate(() => {
              const b = [...document.querySelectorAll("button,a")].find((el) =>
                /sign up with email/i.test(el.innerText || "")
              );
              if (b) b.click();
            })
            .catch(() => {});
        }
      }
      d = await waitStep(page, ["email", "otp", "profile", "chooser"], {
        timeoutMs: 12_000,
      });
    }

    if (d.step !== "email" && !d.hasEmailInput) {
      if (attempt === 1) {
        log(`chưa có ô email (step=${d.step}) — reload signup 1 lần`);
        await page.goto(SIGNUP_URL, {
          waitUntil: "domcontentloaded",
          timeout: 90_000,
        });
        await sleep(1000);
        continue;
      }
      log(`FAIL: step=${d.step} không phải email`);
      return false;
    }

    const ok = await fillFirst(
      page,
      [
        'input[type="email"]',
        'input[name="email"]',
        'input[autocomplete="email"]',
        'input[placeholder*="mail" i]',
        'input[id*="email" i]',
      ],
      email
    );
    if (!ok) {
      log(`FAIL fill email (step=${d.step})`);
      return false;
    }
    log(`email filled: ${email}`);

    // submit chỉ khi còn email step
    d = await detectPage(page);
    if (d.step === "email" || d.hasEmailInput) {
      await clickFirst(page, [/^sign up$/i, /^continue$/i, /^next$/i]);
    }
    d = await waitStep(page, ["otp", "profile", "email", "error"], {
      timeoutMs: 15_000,
    });
    if (d.step === "otp" || d.step === "profile") return true;
    if (d.err) {
      log(`email submit ERR: ${d.errSnippet || "?"}`);
      return false;
    }
    // vẫn email = chưa chuyển — retry 1 lần thôi
    if (d.step === "email" && attempt < 2) {
      log("vẫn step=email sau submit — retry 1");
      continue;
    }
    return d.step === "otp" || d.step === "profile" || d.hasEmailInput;
  }
  return false;
}

/** OTP — chỉ gõ khi detect step=otp. */
async function typeOtp(page, code) {
  const raw = String(code || "").replace(/\s/g, "");
  let d = await waitStep(page, ["otp", "profile", "done"], {
    timeoutMs: 20_000,
  });
  if (d.step === "profile" || d.step === "done") {
    log(`skip OTP type — đã step=${d.step}`);
    return true;
  }
  if (d.step !== "otp") {
    log(`OTP: expect step=otp got=${d.step} — CODE=${raw} dán tay nếu cần`);
    // vẫn thử fill nếu có input lạ
  }

  // input OTP: ưu tiên form inputs ngắn / không password
  const otpLoc = page.locator(
    'form input:not([type="password"]):not([type="email"]):not([type="hidden"]):visible'
  );
  const nOtp = await otpLoc.count().catch(() => 0);
  log(`otp code=${raw} inputs=${nOtp} step=${d.step}`);
  if (nOtp < 1) {
    log(`CODE = ${raw}  ← dán tay`);
    return false;
  }
  if (nOtp === 1 || raw.includes("-")) {
    await otpLoc.first().click();
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.type(raw, { delay: 50 });
  } else {
    const chars = raw.replace(/-/g, "").split("");
    for (let i = 0; i < Math.min(chars.length, nOtp); i++) {
      await otpLoc.nth(i).fill(chars[i]);
    }
  }
  await clickFirst(page, [
    /confirm email|verify email|^verify$|^confirm$|^continue$|^next$|^submit$/i,
  ]);
  d = await waitStep(page, ["profile", "done", "otp"], { timeoutMs: 20_000 });
  if (d.step === "otp" && d.err) {
    log(`OTP ERR: ${d.errSnippet || "invalid?"}`);
    return false;
  }
  return d.step === "profile" || d.step === "done" || d.step === "otp";
}

/** Profile — chỉ fill khi step=profile. */
async function fillProfileStep(page, first, last, password) {
  let d = await waitStep(page, ["profile", "done", "otp"], {
    timeoutMs: 25_000,
  });
  if (d.step === "done") {
    log("skip profile — already done");
    return true;
  }
  if (d.step === "otp") {
    log("vẫn OTP — chưa fill profile");
    return false;
  }
  if (d.step !== "profile" && !d.hasPassword) {
    log(`profile: expect profile got=${d.step}`);
    // 1 wait thêm
    d = await waitStep(page, ["profile", "done"], { timeoutMs: 10_000 });
    if (d.step !== "profile" && !d.hasPassword) return false;
  }
  if (d.hasFirst || d.step === "profile") {
    await fillFirst(
      page,
      ['input[name*="first" i]', 'input[autocomplete="given-name"]'],
      first || "Alex"
    );
  }
  if (d.hasLast || d.step === "profile") {
    await fillFirst(
      page,
      ['input[name*="last" i]', 'input[autocomplete="family-name"]'],
      last || "Kowalski"
    );
  }
  // chỉ ô password visible — tránh fill nhầm hidden
  const passSels = [
    'input[type="password"]:visible',
    'input[name="password"]:visible',
    'input[autocomplete="new-password"]:visible',
    'input[autocomplete="current-password"]:visible',
    'input[type="password"]',
  ];
  const passOk = await fillFirst(page, passSels, password);
  // verify length (value password browser đôi khi rỗng khi đọc)
  const len = await page
    .locator('input[type="password"]')
    .first()
    .evaluate((el) => (el.value || "").length)
    .catch(() => -1);
  if (!passOk || (len >= 0 && len !== String(password).length)) {
    logWarn(
      `password fill nghi ngờ len=${len} expect=${String(password).length} — type lại`
    );
    const pw = page.locator('input[type="password"]').first();
    await pw.click().catch(() => {});
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.type(String(password), { delay: 30 });
  }
  logOk(
    `profile filled passLen=${String(password).length} (không log pass)`
  );
  return true;
}

async function launchBrowser(proxy, cfg = {}) {
  const headless =
    args.includes("--headless") ||
    process.env.GROK_HEADLESS === "1" ||
    cfg.headless === true;

  // headless → Playwright (CDP user Chrome không headless được)
  if ((USER_CHROME || CDP) && !headless) {
    if (USER_CHROME) CDP = await ensureUserChromeCdp(CDP || CDP_DEFAULT);
    else if (!(await cdpAlive(CDP))) {
      throw new Error(`CDP không sống: ${CDP}`);
    }
    log(`CDP attach ${CDP} → tab mới (giữ Chrome user)`);
    const browser = await chromium.connectOverCDP(CDP);
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = await context.newPage();
    try {
      await page.bringToFront();
    } catch {
      /* */
    }
    return { context, page, browser, userChrome: true, headless: false };
  }

  if (headless) log("headless Playwright");
  else log("⚠ --playwright profile — dễ fail login; bỏ flag / headless=false");
  if (FRESH || (WORKER && WORKER !== "0")) wipeProfile();
  mkdirSync(PROFILE_DIR, { recursive: true });
  const pwProxy = toPlaywrightProxy(proxy);
  if (pwProxy) log(`proxy → ${pwProxy.server} (exit ${proxy.exitIp || "?"})`);
  const channel = USE_CHROME ? "chrome" : undefined;
  const w = Number(WORKER) || 0;
  const origin = { x: 40 + (w % 4) * 40, y: 40 + (w % 3) * 40 };
  const browser = await chromium.launch({
    headless,
    channel: headless ? undefined : channel,
    proxy: pwProxy,
    args: [
      "--disable-blink-features=AutomationControlled",
      ...(headless ? [] : [`--window-position=${origin.x},${origin.y}`]),
    ],
  });
  const context = await browser.newContext({ locale: "en-US" });
  return {
    context,
    page: await context.newPage(),
    browser,
    userChrome: false,
    headless,
  };
}

async function main() {
  const cfg = loadConfig();

  let acc;
  if (REUSE) {
    acc = loadLatest();
    if (!acc?.email) throw new Error("Không có getedumail-latest.json — bỏ --reuse");
    console.log(`[reuse] ${acc.email}`);
    if (acc.email && acc.password) {
      const t = await resolveToken({
        email: acc.email,
        password: acc.password,
        userToken: acc.userToken,
      });
      if (t) acc.userToken = t;
    }
  } else {
    // ưu tiên edu cũ chưa reg Grok
    const stock = pickUnusedEdu(cfg);
    if (stock?.email) {
      acc = stock;
      console.log(`[edu] stock chưa reg: ${acc.email} (id=${acc.id || "?"})`);
      if (acc.email && acc.password) {
        const t = await resolveToken({
          email: acc.email,
          password: acc.password,
          userToken: acc.userToken,
          id: acc.id,
        });
        if (t) acc.userToken = t;
      }
    } else {
      const name =
        cfg.randomName !== false
          ? pickRandomName() || cfg.name || "Alex Kowalski"
          : cfg.name || "Alex Kowalski";
      const domains = [
        ...(Array.isArray(cfg.domains) ? cfg.domains : []),
        cfg.domain,
      ]
        .map((d) => String(d || "").trim())
        .filter(Boolean);
      const uniq = [...new Set(domains.length ? domains : ["iunp.edu.rs"])];
      let lastErr;
      for (let t = 1; t <= 3; t++) {
        const domain = uniq[(t - 1 + Number(WORKER || 0)) % uniq.length];
        console.log(`[edu] tạo mail domain=${domain} name=${name} try=${t}/3`);
        try {
          acc = await createAccount({
            domain,
            name,
            password: cfg.password || undefined,
            log: console.log,
          });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          const msg = String(e.message || e);
          console.warn(`[edu] fail try=${t}: ${msg.slice(0, 140)}`);
          if (/max number of temporary|try again later|mail\.tm/i.test(msg)) {
            console.warn("[edu] limit — chờ 5s, đổi domain…");
            await sleep(5000);
          } else {
            await sleep(800 * t);
          }
        }
      }
      if (lastErr) throw lastErr;
    }
  }

  const grokPass =
    flag("--password", null) ||
    acc.password ||
    `Gx${Math.random().toString(36).slice(2, 10)}A1!`;

  const wantHeadless =
    args.includes("--headless") ||
    process.env.GROK_HEADLESS === "1" ||
    cfg.headless === true;
  const userChromeMode = !wantHeadless && (USER_CHROME || !!CDP);
  const proxy = userChromeMode ? null : resolveProxy();
  if (userChromeMode && !NO_PROXY) {
    log("user-chrome: bỏ proxy Playwright (proxy trong Chrome user)");
  }

  logPhase("Thông tin reg");
  logKv("Edu mail", acc.email);
  logKv("Edu pass", acc.password || "(n/a)");
  logKv("Grok pass", grokPass);
  logKv(
    "Trình duyệt",
    wantHeadless
      ? "Playwright headless"
      : userChromeMode
        ? "Chrome USER (CDP)"
        : "Playwright"
  );
  logKv(
    "Proxy",
    proxy
      ? `${proxy.server} → ${proxy.exitIp || "?"}`
      : userChromeMode
        ? "trong Chrome user"
        : "tắt"
  );
  logKv("Captcha", cfg.autoClickCaptcha === false ? "tay" : "auto-click");
  logKv("9router", nineRouterDefaults(cfg).enabled ? "tự auth SAU reg (giữ login)" : "tắt");

  const { context, page, browser, userChrome } = await launchBrowser(
    userChromeMode ? null : proxy,
    cfg
  );

  logPhase("1/6  Chuẩn bị phiên (cookie / logout nếu cần)");
  // luôn probe cookie trước — acc cũ hay sót session
  try {
    await page.goto("https://accounts.x.ai/sign-in", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
  } catch {
    /* */
  }
  await sleep(800);
  // force logout nếu còn cookie / không phải form login sạch
  {
    const st = await detectLoggedIn(page, context);
    const d0 = st.page || (await detectPage(page));
    const onFreshLogin =
      d0.step === "signin" ||
      /sign-in|login/i.test(st.url || "") ||
      d0.hasEmailInput;
    if (st.logged || st.cookieHit >= 1 || d0.step === "done" || d0.step === "unknown") {
      await ensureLoggedOut(page, context, log, {
        force: st.cookieHit >= 1 || d0.step === "done" || d0.step === "unknown",
      });
    } else if (!onFreshLogin && d0.step !== "chooser" && d0.step !== "email") {
      log(`session odd step=${d0.step} — force logout`);
      await ensureLoggedOut(page, context, log, { force: true });
    } else {
      log(`session ok-ish step=${d0.step} cookies=${st.cookieHit}`);
    }
  }
  try {
    await page.goto(SIGNUP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
  } catch {
    /* */
  }
  await sleep(1000);
  // nếu signup redirect / không chooser → logout lại
  {
    const d1 = await detectPage(page);
    if (
      !["chooser", "email"].includes(d1.step) &&
      !d1.hasSignupEmailBtn &&
      !d1.hasEmailInput
    ) {
      log(
        `signup không ra form (step=${d1.step} url=${(d1.url || "").slice(0, 60)}) → force logout + reload`
      );
      await ensureLoggedOut(page, context, log, { force: true });
      await page.goto(SIGNUP_URL, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      await sleep(1000);
    }
  }
  logPhase("2/6  Điền email Grok");
  let emailFilled = await fillSignupEmail(page, acc.email);
  if (!emailFilled) {
    logWarn("Chưa thấy form email → logout mạnh + thử lại 1 lần");
    await ensureLoggedOut(page, context, log, { force: true });
    try {
      await page.goto(SIGNUP_URL, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
    } catch {
      /* */
    }
    await sleep(1200);
    emailFilled = await fillSignupEmail(page, acc.email);
  }
  if (!emailFilled) {
    logErr("Dừng: không vào được bước email (không poll OTP bừa)");
    process.exit(4);
  }
  logOk("Email đã gửi — chờ OTP");

  // ── STEP otp ──
  {
    const d = await detectPage(page);
    if (!["otp", "email", "profile"].includes(d.step)) {
      logWarn(`Sau email step lạ=${d.step} — chờ otp/profile`);
      await waitStep(page, ["otp", "profile", "done"], { timeoutMs: 20_000 });
    }
  }

  logPhase("3/6  Lấy OTP từ hộp thư edu");
  log(`Đang poll inbox: ${acc.email}`);
  let otp;
  {
    const d = await detectPage(page);
    if (d.step === "profile" || d.step === "done") {
      log(`skip poll OTP — UI đã ${d.step}`);
      otp = { code: null };
    } else {
      try {
        otp = await pollOtp(acc.email, acc.userToken, {
          password: acc.password,
          log: console.log,
        });
        if (otp.userToken) acc.userToken = otp.userToken;
      } catch (e) {
        console.error(e.message);
        // 1 fallback login only nếu vẫn step=otp
        const d2 = await detectPage(page);
        if (acc.password && d2.step === "otp") {
          log("otp fallback: token refresh (vẫn step=otp)");
          const fresh = await loginForToken(acc.email, acc.password);
          if (fresh) {
            try {
              otp = await pollOtp(acc.email, fresh, {
                password: acc.password,
                log: console.log,
              });
            } catch (e2) {
              console.error(e2.message);
            }
          }
        }
        if (!otp?.code) {
          log("FAIL OTP mail — dừng");
          if (!AUTO_CLOSE && !userChrome) {
            await new Promise((resolve) => {
              context.on("close", resolve);
              if (browser) browser.on("disconnected", resolve);
            });
            return;
          }
          process.exit(3);
        }
      }
    }
  }

  if (otp?.code) {
    logPhase("4/6  Gõ OTP + hồ sơ Grok");
    logOk(`OTP: ${otp.code}`);
    const otpOk = await typeOtp(page, otp.code);
    if (!otpOk) {
      const d = await detectPage(page);
      if (d.step !== "profile" && d.step !== "done") {
        logErr("Dừng: gõ OTP thất bại (không fill profile bừa)");
        process.exit(5);
      }
    }
  } else {
    logPhase("4/6  Hồ sơ Grok (bỏ OTP — UI đã qua)");
  }

  const [first, ...rest] = String(
    pickRandomName() || cfg.name || "Alex Kowalski"
  ).split(/\s+/);
  const profOk = await fillProfileStep(
    page,
    first || "Alex",
    rest.join(" ") || "Kowalski",
    grokPass
  );
  if (!profOk) {
    const d = await detectPage(page);
    if (d.step === "done") {
      logOk("Đã vào app — bỏ captcha");
    } else {
      logErr(`Dừng: profile step=${d.step}`);
      process.exit(6);
    }
  } else {
    logOk("Đã điền tên + mật khẩu Grok");
  }

  logPhase("5/6  Captcha + Complete sign up");
  let ts = { ok: false, via: "skip" };
  let signupClicked = false;
  {
    let d = await detectPage(page);
    if (d.step === "done") {
      ts = { ok: true, via: "already-done" };
      signupClicked = true;
      logOk("Đã ở app (không cần captcha)");
    } else if (d.step === "profile" || d.captcha || d.hasComplete) {
      const autoClick = cfg.autoClickCaptcha !== false;
      log(
        autoClick
          ? "Chờ Cloudflare — auto-click checkbox…"
          : "Chờ Cloudflare — giải tay…"
      );
      ts = await solveTurnstileWithFallback(page, {
        pageUrl: page.url(),
        useExtension: false,
        tryTokenApi: false,
        autoClick,
        manualTimeoutMs: userChrome ? 180_000 : 90_000,
      });
      if (!ts.ok) {
        d = await detectPage(page);
        if (d.step === "profile" && d.captcha) {
          logWarn("Captcha fail → reload widget 1 lần");
          await reloadTurnstile(page);
          ts = await solveTurnstileWithFallback(page, {
            pageUrl: page.url(),
            useExtension: false,
            tryTokenApi: false,
            autoClick,
            manualTimeoutMs: 60_000,
          });
        } else if (d.step === "done") {
          ts = { ok: true, via: "nav-done" };
          signupClicked = true;
        }
      }
      if (ts.ok && !signupClicked) {
        d = await detectPage(page);
        if (d.step === "done") {
          signupClicked = true;
        } else {
          logOk(`Captcha xong (${ts.via}) → bấm Complete…`);
          let clk = await clickSignupAfterCaptcha(page, {
            settleMs: 0,
            maxWaitMs: 30_000,
            pollMs: 200,
          });
          if (!clk.ok) {
            d = await detectPage(page);
            if (d.step === "profile" || d.hasComplete) {
              logWarn(`Click fail (${clk.reason}) — thử lại 1 lần`);
              clk = await clickSignupAfterCaptcha(page, {
                settleMs: 0,
                maxWaitMs: 12_000,
                pollMs: 200,
              });
            } else if (d.step === "done") {
              clk = { ok: true, reason: "already-done" };
            }
          }
          signupClicked = !!clk.ok;
          if (clk.ok) logOk(`Complete: ${clk.reason}`);
          else logErr(`Complete fail: ${clk.reason}`);
        }
      } else if (!ts.ok) {
        logErr(`Captcha fail via=${ts.via}`);
      }
    } else {
      logWarn(`Bỏ captcha — step=${d.step}`);
      ts = { ok: d.step === "done", via: `step-${d.step}` };
      signupClicked = d.step === "done";
    }
  }

  // truth cuối: CHỈ done khi rời signup / step=done. Token+click giả ≠ reg xong.
  let final = { step: "unknown", url: safePageUrl(page) };
  try {
    // chờ settle sau Complete (nav có thể chậm)
    if (signupClicked) {
      const t0 = Date.now();
      while (Date.now() - t0 < 12_000) {
        const u = safePageUrl(page);
        if (u && !/sign-up|sign_up|signup/i.test(u)) break;
        const d = await detectPage(page).catch(() => null);
        if (d?.step === "done") break;
        await sleep(400);
      }
    }
    final = await detectPage(page);
  } catch (e) {
    log(`detect final: ${String(e.message || e).slice(0, 80)}`);
    const u = safePageUrl(page);
    if (!/sign-up|signup/i.test(u) && u) final = { step: "done", url: u };
  }
  if (
    final.step !== "done" &&
    !/sign-up|signup/i.test(final.url || safePageUrl(page))
  ) {
    final = { ...final, step: "done", via: "post-click-url" };
  }
  // reg xong = rời form signup. Không test login.
  const regOk = final.step === "done";
  if (regOk) logOk("Reg xong — rời sign-up");
  else logErr(`Reg dở — step=${final.step} url=${(final.url || "").slice(0, 60)}`);

  const result = {
    ok: regOk,
    worker: TAG,
    email: acc.email,
    eduPassword: acc.password,
    grokPassword: grokPass,
    otp: otp?.code || null,
    proxy: proxy ? { server: proxy.server, exitIp: proxy.exitIp } : null,
    turnstile: ts.via,
    step: final.step,
    url: (final.url || safePageUrl(page) || "").slice(0, 160),
    at: new Date().toISOString(),
  };

  logPhase("6/6  Lưu + 9router / logout");
  try {
    const p = saveGrokResult(result);
    if (regOk) logOk(`Đã lưu: ${acc.email}`);
    else logWarn(`Đã lưu (fail): ${acc.email}`);
    logKv("File", p);
  } catch (e) {
    logErr(`Lưu file thất bại: ${e.message}`);
  }

  const want9r = regOk && nineRouterDefaults(cfg).enabled;
  try {
    if (want9r) {
      log("9router: reg xong → giữ login, device auth…");
      try {
        writeFileSync(
          join(__dir, "acc", "grok-latest.json"),
          JSON.stringify(result, null, 2)
        );
        const nine = await autoAuthNineRouter({
          page,
          email: acc.email,
          password: grokPass || acc.password,
          cfg: { ...cfg, force: true },
          log,
        });
        result.nineRouter = {
          ok: !!nine?.ok,
          via: nine?.push?.via || null,
          connectionId: nine?.push?.connection?.id || null,
          email: nine?.email || null,
          file: nine?.push?.file || null,
        };
        if (nine?.ok) logOk("9router: đã đẩy token");
        else logWarn(`9router: ${nine?.push?.error || "chưa push đủ"}`);
      } catch (e) {
        logErr(`9router: ${String(e.message || e).slice(0, 120)}`);
        result.nineRouter = {
          ok: false,
          error: String(e.message || e).slice(0, 160),
        };
      }
      try {
        writeFileSync(
          join(__dir, "acc", "grok-latest.json"),
          JSON.stringify(result, null, 2)
        );
      } catch {
        /* */
      }
      log("Giữ cookie (autoAuth) — không logout");
    } else if (!regOk) {
      logWarn("Reg dở → logout, không push 9r");
      await logoutXai(page, context, log).catch(() => {});
    } else {
      log("autoAuth tắt → logout + xóa cookie xAI");
      await logoutXai(page, context, log).catch((e) =>
        logWarn(`logout: ${String(e.message || e).slice(0, 80)}`)
      );
    }
  } catch (e) {
    logWarn(`sau reg: ${String(e.message || e).slice(0, 100)}`);
  }

  console.log(`
${regOk ? C.green("══ KẾT QUẢ ══") : C.red("══ KẾT QUẢ ══")}
  email  : ${acc.email}
  pass   : ${grokPass}
  reg    : ${regOk ? "ok" : "fail"}
  step   : ${result.step}
  9r     : ${result.nineRouter?.ok ? "OK" : want9r ? "fail/skip" : "tắt"}
`);

  if (userChrome || USER_CHROME) {
    try {
      await page.close({ runBeforeUnload: false }).catch(() => {});
    } catch {
      /* */
    }
    log(
      want9r
        ? "Đóng tab reg · cookie còn (9r)"
        : "Đóng tab reg · đã xử lý session"
    );
    try {
      browser?.removeAllListeners?.("disconnected");
    } catch {
      /* */
    }
    process.exit(regOk ? 0 : 2);
  }

  if (AUTO_CLOSE) {
    await sleep(800);
    await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    process.exit(regOk ? 0 : 2);
  }

  log("đóng browser khi xong (hoặc --auto-close)");
  await new Promise((resolve) => {
    context.on("close", resolve);
    if (browser) browser.on("disconnected", resolve);
  });
}

main().catch((e) => {
  const msg = String(e?.message || e);
  console.error(`[${TAG}]`, msg);
  // partial save nếu đã có acc trong scope — best effort từ env
  if (isNavDestroyed(e)) {
    console.error(
      `[${TAG}] navigate mid-script — nếu reg xong check grok/acc/grok-latest.json`
    );
  }
  process.exit(1);
});
