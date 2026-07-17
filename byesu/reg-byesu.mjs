#!/usr/bin/env node
/**
 * Auto reg ByesU + tạo API key theo group
 *   node reg-byesu.mjs
 *   node reg-byesu.mjs --headless
 *   node reg-byesu.mjs --group Grok
 *   node reg-byesu.mjs --count 3
 *   node reg-byesu.mjs --email x@y.com --password Pass123!
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";
import { execSync, spawn } from "child_process";
import { chromium } from "playwright";
import { extractCode, randUser } from "../mail/getedumail-core.mjs";
import {
  solveTurnstileWithFallback,
  turnstileState,
  clickTurnstileCheckbox,
  waitAndClickTurnstile,
} from "../grok/turnstile.mjs";
import { createTempInbox, waitOtp } from "./tempmail.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
/** acc/ = json tài khoản; keys/ = api key txt theo group */
const ACC_DIR = join(__dir, "acc");
const KEYS_DIR = join(__dir, "keys");
const SIGNUP_URL = "https://byesu.com/sign-up";
const PROFILE_DIR = join(__dir, ".pw-byesu-profile");
const CDP_PORT_BASE = 9222;
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const HAS = (n) => args.includes(n);
const YES = HAS("--yes") || HAS("-y") || process.env.BYESU_YES === "1";
// CHỈ CDP Chrome visible — không Playwright
const COUNT = Math.max(1, Math.min(20, Number(flag("--count", "1")) || 1));
const WORKER = Number(flag("--worker", process.env.BYESU_WORKER || "0")) || 0;
const JOB_ID = Number(flag("--job", process.env.BYESU_JOB || "0")) || 0;
const CDP_PORT =
  Number(flag("--port", process.env.BYESU_CDP_PORT || "0")) ||
  (WORKER > 0 ? CDP_PORT_BASE + WORKER : CDP_PORT_BASE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY_GROUP_DEFAULT = "Grok";
/** Chỉ cho phép các group này (đúng chuỗi ByesU UI). */
const KEY_GROUPS_ALLOWED = [
  "Openai Codex",
  "Grok",
  "Gemini Business",
  "Claude Max",
];

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const log = (...a) => console.log(C.dim("[byesu]"), ...a);
const logOk = (...a) => console.log(C.dim("[byesu]"), C.green("✓"), ...a);
const logWarn = (...a) => console.log(C.dim("[byesu]"), C.yellow("!"), ...a);
const logErr = (...a) => console.log(C.dim("[byesu]"), C.red("✗"), ...a);

function loadConfig() {
  const p = join(__dir, "config.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function randUsername() {
  return `u${randUser().slice(0, 8)}${randomBytes(2).toString("hex")}`;
}

function makePassword(cfg) {
  const fixed = flag("--password", null) || cfg.password || "";
  if (fixed && String(fixed).length >= 8) return String(fixed).slice(0, 20);
  // ByesU: 8–20 chars
  return (`Bx${randomBytes(5).toString("base64url")}A1!`).slice(0, 16);
}

function pickOtpFromBlob(blob) {
  const t = String(blob || "");
  // ByesU: hex 6 (vd 6ac9f2) hoặc 4–8 số
  const patterns = [
    /(?:code|otp|verification|验证码|驗證碼|mã|verify)(?:\s*(?:is|为|為))?[\s:：]+([a-f0-9]{6})\b/i,
    /(?:code|otp|verification|验证码|驗證碼|mã)(?:\s*(?:is|为|為))?[\s:：]+(\d{4,8})\b/i,
    /(?:is|为|為)\s+([a-f0-9]{6})\b/i,
    />([a-f0-9]{6})</i,
    /(?<![a-z0-9])([a-f0-9]*\d[a-f0-9]*|[a-f0-9]*[a-f][a-f0-9]*)(?![a-z0-9])/i, // fallback: 6-char hex w/ digit
  ];
  // fallback gọn: mọi token 6 hex có ít nhất 1 số
  const hex6 = t.match(/\b([0-9a-f]*\d[0-9a-f]*)\b/gi) || [];
  for (const re of patterns.slice(0, 4)) {
    const m = t.match(re);
    if (m?.[1] && /^[0-9a-f]{4,8}$/i.test(m[1])) return m[1].toLowerCase();
    if (m?.[1] && /^\d{4,8}$/.test(m[1])) return m[1];
  }
  for (const c of hex6) {
    if (c.length === 6 && /\d/.test(c) && /[a-f]/i.test(c)) return c.toLowerCase();
    if (c.length === 6 && /^\d+$/.test(c)) return c;
  }
  // pure 6 digits
  const d6 = t.match(/\b(\d{6})\b/);
  if (d6) return d6[1];
  const fromExtract = extractCode(t);
  if (fromExtract) return fromExtract;
  return null;
}

/** Poll OTP từ temp mail (tempmail.lol) */
async function waitByesuOtp(inbox, { timeoutMs = 90_000, onTick } = {}) {
  return waitOtp(inbox, {
    timeoutMs,
    onTick,
    pickCode: pickOtpFromBlob,
  });
}

async function setInput(page, selector, value) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: 20_000 });
  await loc.click({ timeout: 5000 }).catch(() => {});
  await loc.fill("");
  await loc.fill(String(value));
  await page.evaluate(
    ({ sel, v }) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { sel: selector, v: String(value) }
  );
}

/** Bắt buộc tick User Agreement — không tick thì Create/Send disabled. */
async function ensureLegalConsent(page) {
  const checked = await page.evaluate(() => {
    const box =
      document.querySelector("#legal-consent") ||
      document.querySelector('input[type="checkbox"][id*="legal" i]') ||
      [...document.querySelectorAll('input[type="checkbox"]')].find((el) => {
        const lab =
          el.closest("label")?.innerText ||
          document.querySelector(`label[for="${el.id}"]`)?.innerText ||
          "";
        return /user agreement|privacy policy|i have read|đồng ý/i.test(lab);
      });
    if (!box) return { ok: false, reason: "no-checkbox" };
    if (box.checked) return { ok: true, reason: "already" };
    box.focus();
    box.click();
    if (!box.checked) {
      box.checked = true;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.dispatchEvent(new Event("change", { bubbles: true }));
      box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    // Radix/shadcn: click label
    if (!box.checked) {
      const lab =
        box.closest("label") ||
        document.querySelector(`label[for="${box.id}"]`);
      lab?.click();
    }
    return { ok: !!box.checked, reason: box.checked ? "ticked" : "fail" };
  });

  if (!checked.ok) {
    // Playwright click
    const loc = page.locator("#legal-consent");
    if (await loc.count()) {
      await loc.check({ force: true }).catch(async () => {
        await loc.click({ force: true });
      });
    } else {
      await page
        .getByText(/i have read and agree/i)
        .click({ force: true })
        .catch(() => {});
    }
    await sleep(200);
  }

  const ok = await page.evaluate(() => {
    const box = document.querySelector("#legal-consent");
    return !!(box && box.checked);
  });
  if (ok) logOk("legal consent ✓");
  else logWarn("legal consent chưa tick — Create có thể disabled");
  return ok;
}

/** Chrome exe + profile ByesU (riêng worker) */
function chromePaths() {
  const local = process.env.LOCALAPPDATA || "";
  const pf = process.env.PROGRAMFILES || "C:\\Program Files";
  const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const exes = [
    join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    join(local, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter((p) => existsSync(p));
  const w = WORKER > 0 ? WORKER : 0;
  const userData =
    flag("--chrome-user-data", null) ||
    (w > 0 ? join(__dir, `.pw-byesu-w${w}`) : PROFILE_DIR);
  return { exe: exes[0] || "chrome", userData };
}

async function cdpAlive(url) {
  try {
    const u = url.replace(/\/$/, "") + "/json/version";
    const r = await fetch(u, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Mở Chrome CDP — profile riêng, KHÔNG kill toàn bộ Chrome hệ thống */
function launchChromeDebug(exe, userData, port) {
  mkdirSync(userData, { recursive: true });
  const w = WORKER > 0 ? WORKER : 0;
  const pos = `--window-position=${20 + (w % 4) * 50},${20 + (w % 3) * 50}`;
  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userData}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    pos,
    "about:blank",
  ];
  // spawn trực tiếp — tránh PS \n bug trong -ArgumentList
  try {
    const child = spawn(exe, chromeArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    log(`Chrome PID ${child.pid || "?"} port=${port}`);
    return String(child.pid || "");
  } catch (e) {
    logWarn(`spawn Chrome fail: ${String(e.message || e).slice(0, 80)}`);
    return "";
  }
}

/**
 * CDP only: attach port sẵn hoặc mở Chrome profile ByesU.
 * Proxy: set trong Chrome profile (khuyến nghị khi 429).
 * Multi: mỗi worker port 9222+W, profile .pw-byesu-wN — không kill Chrome khác.
 */
async function ensureByesuCdp() {
  const port = CDP_PORT;
  const cdp = `http://127.0.0.1:${port}`;
  const { exe, userData } = chromePaths();
  mkdirSync(userData, { recursive: true });

  if (await cdpAlive(cdp)) {
    log(`CDP sẵn ${cdp} — tab mới`);
    return cdp;
  }

  log(`mở Chrome CDP :${port}`);
  log(`  ${exe}`);
  log(`  ${userData}`);
  log("  proxy: set trong Chrome (profile) nếu 429");
  launchChromeDebug(exe, userData, port);

  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await cdpAlive(cdp)) {
      logOk(`CDP OK ${cdp} (${(i + 1) * 0.5}s)`);
      return cdp;
    }
    if (i === 10 || i === 30) log(`chờ CDP ${cdp}…`);
  }
  throw new Error(
    `CDP timeout ${cdp}.\n` +
      `  "${exe}" --remote-debugging-port=${port} --user-data-dir="${userData}"`
  );
}

/** CHỈ CDP Chrome visible — không Playwright */
async function launchBrowser(_cfg = {}, _opts = {}) {
  const cdp = await ensureByesuCdp();
  log(`CDP attach ${cdp}`);
  const browser = await chromium.connectOverCDP(cdp);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();
  try {
    await page.bringToFront();
  } catch {
    /* */
  }
  logOk(`mode=CDP port=${CDP_PORT} worker=${WORKER || 0}`);
  return {
    browser,
    context,
    page,
    userChrome: true,
    headless: false,
    proxy: null,
  };
}

/**
 * Chờ Turnstile xong hẳn (token len>20 hoặc Success UI).
 * Không bấm Sign in/Create khi captcha còn chạy.
 * @param {"signup"|"login"|"any"} kind
 */
async function waitCaptcha(page, cfg, kind = "any") {
  const pageUrl =
    kind === "login"
      ? "https://byesu.com/sign-in"
      : kind === "signup"
        ? SIGNUP_URL
        : page.url();
  const hardMs = Number(flag("--captcha-timeout", "90000")) || 90_000;

  // đã OK?
  try {
    const st0 = await turnstileState(page);
    if ((st0.success && st0.len > 20) || st0.len > 20) {
      logOk(`captcha already tokenLen=${st0.len}`);
      return { ok: true, via: "already-ok", len: st0.len };
    }
    if (st0.success && (st0.uiOk || st0.iframeOk)) {
      // UI success nhưng chưa token — poll thêm token
      log("captcha UI OK — chờ token…");
    }
  } catch {
    /* */
  }

  if (cfg.autoClickCaptcha === false) {
    logWarn(`captcha TAY — chờ tối đa ${hardMs / 1000}s (đừng bấm sớm)`);
    const t0 = Date.now();
    let last = 0;
    while (Date.now() - t0 < hardMs) {
      const st = await turnstileState(page);
      const sec = Math.round((Date.now() - t0) / 1000);
      if (sec - last >= 5) {
        last = sec;
        log(
          `  scan captcha +${sec}s token=${st.len} ui=${!!st.uiOk} iframe=${!!st.iframeOk} fail=${!!st.failed}`
        );
      }
      if (st.failed) {
        logWarn("captcha failed — chờ widget mới…");
        await sleep(1500);
        continue;
      }
      if (st.len > 20 || (st.success && (st.uiOk || st.iframeOk || st.boxOk))) {
        // ưu tiên token thật
        if (st.len > 20) {
          logOk(`captcha OK tokenLen=${st.len} +${sec}s`);
          return { ok: true, via: "manual-token", len: st.len };
        }
        // UI ok: poll thêm 5s lấy token
        const t1 = Date.now();
        while (Date.now() - t1 < 5000) {
          const st2 = await turnstileState(page);
          if (st2.len > 20) {
            logOk(`captcha OK tokenLen=${st2.len}`);
            return { ok: true, via: "manual-ui+token", len: st2.len };
          }
          await sleep(300);
        }
        logOk(`captcha UI OK (no token field) +${sec}s`);
        return { ok: true, via: "manual-ui", len: st.len };
      }
      await sleep(400);
    }
    return { ok: false, via: "manual-timeout" };
  }

  // auto: solve + poll dài, log từng bước
  log(`Turnstile scan (${kind}) max ${hardMs / 1000}s…`);
  const tStart = Date.now();
  let clicks = 0;
  let lastLog = 0;
  let lastClick = 0;

  // vòng solve ngắn trước
  await Promise.race([
    solveTurnstileWithFallback(page, {
      pageUrl,
      autoClick: true,
      extTimeoutMs: 15_000,
      manualTimeoutMs: 10_000,
    }).catch(() => null),
    sleep(18_000),
  ]);

  while (Date.now() - tStart < hardMs) {
    const st = await turnstileState(page);
    const sec = Math.round((Date.now() - tStart) / 1000);
    if (sec - lastLog >= 4) {
      lastLog = sec;
      log(
        `  captcha +${sec}s token=${st.len} success=${!!st.success} ui=${!!st.uiOk} widget=${!!st.hasWidget} fail=${!!st.failed}`
      );
    }
    if (st.failed) {
      logWarn("captcha Verification failed — click lại");
      await Promise.race([
        clickTurnstileCheckbox(page).catch(() => {}),
        sleep(2000),
      ]);
      clicks++;
      lastClick = Date.now();
      await sleep(1200);
      continue;
    }
    // token đủ dài = xong
    if (st.len > 20) {
      logOk(`captcha OK tokenLen=${st.len} +${sec}s clicks=${clicks}`);
      // ổn định 0.5s
      await sleep(500);
      const st2 = await turnstileState(page);
      if (st2.len > 20) return { ok: true, via: "token", len: st2.len };
    }
    if (st.success && (st.uiOk || st.iframeOk || st.boxOk)) {
      // chờ token thêm
      const t1 = Date.now();
      while (Date.now() - t1 < 6000) {
        const st2 = await turnstileState(page);
        if (st2.len > 20) {
          logOk(`captcha OK tokenLen=${st2.len} (sau UI)`);
          return { ok: true, via: "ui+token", len: st2.len };
        }
        await sleep(300);
      }
      logOk(`captcha UI OK +${sec}s`);
      return { ok: true, via: "ui", len: st.len };
    }
    // click checkbox định kỳ
    if (
      st.hasWidget &&
      clicks < 15 &&
      Date.now() - lastClick >= (clicks === 0 ? 800 : 2500)
    ) {
      const r = await Promise.race([
        clickTurnstileCheckbox(page).catch(() => ({ ok: false })),
        sleep(2500).then(() => ({ ok: false })),
      ]);
      if (r?.ok && r.via !== "already-ok") {
        clicks++;
        lastClick = Date.now();
        log(`  click captcha #${clicks} via=${r.via || "?"}`);
      } else lastClick = Date.now();
    }
    await sleep(400);
  }
  const stF = await turnstileState(page).catch(() => ({ len: 0 }));
  logWarn(`captcha timeout token=${stF.len || 0}`);
  return { ok: stF.len > 20, via: "timeout", len: stF.len || 0 };
}

/**
 * Auto click checkbox CF đến khi có token thật (len>20).
 * UI-only success không đủ — Sign in/Create hay fail.
 */
async function forceTurnstileToken(page, { maxMs = 45_000, label = "captcha" } = {}) {
  const t0 = Date.now();
  let clicks = 0;
  let lastLog = 0;
  while (Date.now() - t0 < maxMs) {
    const tok = await getTurnstileToken(page);
    if (tok) {
      logOk(`${label}: token len=${tok.length} clicks=${clicks}`);
      return { ok: true, via: "token", len: tok.length };
    }
    const st = await turnstileState(page).catch(() => ({ len: 0 }));
    if (st.len > 20) {
      logOk(`${label}: tokenLen=${st.len}`);
      return { ok: true, via: "state", len: st.len };
    }
    const sec = Math.round((Date.now() - t0) / 1000);
    if (sec - lastLog >= 4) {
      lastLog = sec;
      log(`  ${label} click… +${sec}s token=${st.len} ui=${!!st.uiOk} widget=${!!st.hasWidget}`);
    }
    const r = await Promise.race([
      clickTurnstileCheckbox(page, { force: true }).catch(() => ({ ok: false })),
      sleep(2500).then(() => ({ ok: false })),
    ]);
    if (r?.ok && r.via !== "already-ok") {
      clicks++;
      log(`  click CF #${clicks} via=${r.via || "?"}`);
      // sau click: poll token gấp
      const t1 = Date.now();
      while (Date.now() - t1 < 4000) {
        const t = await getTurnstileToken(page);
        if (t) {
          logOk(`${label}: token len=${t.length} sau click`);
          return { ok: true, via: "click+token", len: t.length };
        }
        await sleep(250);
      }
    } else {
      // fallback waitAndClick
      await Promise.race([
        waitAndClickTurnstile(page, {
          timeoutMs: 3500,
          clickEveryMs: 700,
          maxClicks: 3,
          onClick: (rr, n) => log(`  waitClick #${n} via=${rr?.via || "?"}`),
        }).catch(() => null),
        sleep(4000),
      ]);
    }
    await sleep(400);
  }
  const tok = await getTurnstileToken(page);
  return { ok: !!tok, via: tok ? "late-token" : "no-token", len: tok?.length || 0 };
}

/** Chặn submit cho đến khi captcha có TOKEN thật (len>20). */
async function requireCaptchaBeforeSubmit(page, cfg, kind, label) {
  log(`chờ Cloudflare xong trước khi ${label}…`);
  // đã có token?
  {
    const tok0 = await getTurnstileToken(page);
    if (tok0) {
      logOk(`${label}: captcha sẵn sàng (already len=${tok0.length})`);
      return { ok: true, via: "already", len: tok0.length };
    }
  }

  const r = await waitCaptcha(page, cfg, kind);
  let tok = await getTurnstileToken(page);
  if (tok) {
    logOk(`${label}: captcha sẵn sàng (${r.via} len=${tok.length})`);
    return { ok: true, via: r.via, len: tok.length };
  }

  // UI OK / success nhưng token trống → click checkbox đến khi có token
  logWarn(`${label}: token trống — auto click checkbox CF…`);
  const hard = await forceTurnstileToken(page, {
    maxMs: kind === "login" ? 50_000 : 40_000,
    label,
  });
  tok = await getTurnstileToken(page);
  if (tok) {
    logOk(`turnstile token len=${tok.length}`);
    return { ok: true, via: hard.via, len: tok.length };
  }
  if (!hard.ok && !r.ok) {
    logWarn(`${label}: captcha chưa OK (${hard.via}) — vẫn thử (có thể fail)`);
  } else {
    logWarn(`${label}: vẫn không có token field — submit có thể fail`);
  }
  return { ok: !!tok || r.ok, via: hard.via || r.via, len: tok?.length || r.len || 0 };
}

/** Lấy turnstile token từ DOM (nếu có). */
async function getTurnstileToken(page) {
  return page.evaluate(() => {
    const el =
      document.querySelector('input[name="cf-turnstile-response"]') ||
      document.querySelector('textarea[name="cf-turnstile-response"]');
    const v = el?.value || "";
    return v.length > 20 ? v : "";
  });
}

/**
 * Gửi OTP qua API ByesU (new-api):
 *   GET /api/verification?email=…&turnstile=…
 * Fallback: click nút Send code + bắt response.
 */
async function sendVerification(page, email) {
  log(`gửi OTP → ${email}`);
  await ensureLegalConsent(page).catch(() => {});

  let token = await getTurnstileToken(page);
  if (!token) {
    log("chưa có turnstile token — click captcha…");
    await waitCaptcha(page, { autoClickCaptcha: true });
    token = await getTurnstileToken(page);
  }
  if (token) logOk(`turnstile token len=${token.length}`);
  else logWarn("không lấy được turnstile token");

  // 1) API trực tiếp trong page (cookie/session)
  if (token) {
    const api = await page.evaluate(
      async ({ email, token }) => {
        try {
          const u = new URL("/api/verification", location.origin);
          u.searchParams.set("email", email);
          u.searchParams.set("turnstile", token);
          const r = await fetch(u.toString(), {
            method: "GET",
            credentials: "include",
            headers: { accept: "application/json" },
          });
          const text = await r.text();
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = { raw: text.slice(0, 300) };
          }
          return { status: r.status, ok: r.ok, json, text: text.slice(0, 300) };
        } catch (e) {
          return { status: 0, ok: false, json: null, text: String(e.message || e) };
        }
      },
      { email, token }
    );
    log(
      `API /verification status=${api.status} success=${api.json?.success ?? "?"} msg=${String(api.json?.message || api.text || "").slice(0, 100)}`
    );
    if (api.json?.success === true || (api.ok && api.json?.success !== false)) {
      logOk("OTP API: success");
      return { sent: true, via: "api", api };
    }
    // một số bản trả data null + success true khác shape
    if (api.status === 200 && !/fail|error|invalid|exist/i.test(JSON.stringify(api.json || {}))) {
      logOk("OTP API: HTTP 200");
      return { sent: true, via: "api-200", api };
    }
    logWarn(`OTP API fail — fallback click UI`);
  }

  // 2) Click nút + bắt response network
  const netHits = [];
  const onResp = async (res) => {
    try {
      const u = res.url();
      if (!/verification|otp|send.?code|email/i.test(u)) return;
      const status = res.status();
      let body = "";
      try {
        body = (await res.text()).slice(0, 400);
      } catch {
        /* */
      }
      netHits.push({ u: u.slice(0, 120), status, body });
    } catch {
      /* */
    }
  };
  page.on("response", onResp);

  const candidates = [
    page.getByRole("button", { name: /send code|resend/i }),
    page.locator("button").filter({ hasText: /send code|resend/i }),
  ];
  let btn = null;
  for (const loc of candidates) {
    try {
      if ((await loc.count()) > 0) {
        btn = loc.first();
        break;
      }
    } catch {
      /* */
    }
  }
  if (!btn) {
    page.off("response", onResp);
    throw new Error("Không thấy nút Send code");
  }

  for (let i = 0; i < 20; i++) {
    const txt = ((await btn.textContent().catch(() => "")) || "").trim();
    if (/resend\s*\(\s*\d+/i.test(txt)) {
      page.off("response", onResp);
      logOk(`đã gửi — ${txt}`);
      return { sent: true, via: "countdown", netHits };
    }
    const dis = await btn.isDisabled().catch(() => true);
    if (!dis) {
      log(`click Send try=${i + 1}`);
      await btn.click({ timeout: 5000 }).catch(async () => {
        await btn.click({ force: true, timeout: 3000 }).catch(() => {});
      });
      await sleep(2000);
      const txt2 = ((await btn.textContent().catch(() => "")) || "").trim();
      page.off("response", onResp);
      if (netHits.length) {
        for (const h of netHits) {
          log(`net ${h.status} ${h.u} ${h.body.slice(0, 80)}`);
        }
      }
      if (/resend/i.test(txt2)) {
        logOk(`đã gửi — ${txt2}`);
        return { sent: true, via: "click", netHits };
      }
      // kiểm tra API fail trong network
      const fail = netHits.find(
        (h) =>
          h.status >= 400 ||
          /"success"\s*:\s*false|already|exist|invalid|fail/i.test(h.body)
      );
      if (fail) {
        logWarn(`Send API lỗi: ${fail.status} ${fail.body.slice(0, 120)}`);
        return { sent: false, via: "api-error", netHits, error: fail.body };
      }
      log("đã bấm Send — chờ mail…");
      return { sent: true, via: "click-no-timer", netHits };
    }
    if (i === 0 || i % 4 === 0) {
      log(`Send disabled… ${i + 1}/20`);
      await ensureLegalConsent(page).catch(() => {});
      await Promise.race([
        clickTurnstileCheckbox(page).catch(() => {}),
        sleep(2000),
      ]);
    }
    await sleep(500);
  }
  page.off("response", onResp);
  logWarn("Send disabled — force click");
  await btn.click({ force: true, timeout: 5000 }).catch(() => {});
  await sleep(1500);
  return { sent: true, via: "force", netHits };
}

function extractApiKeyFromText(text) {
  return (
    String(text || "").match(
      /(sk-[A-Za-z0-9_\-]{20,}|byesu_[A-Za-z0-9_\-]{20,}|sk-or-v1-[A-Za-z0-9_\-]{20,})/
    )?.[1] || ""
  );
}

function resolveKeyGroup(cfg) {
  const raw = (
    flag("--group", null) ||
    cfg.byesu?.group ||
    cfg.byesuGroup ||
    KEY_GROUP_DEFAULT
  )
    .trim();
  if (!raw) return KEY_GROUP_DEFAULT;
  // số thứ tự 1–4
  if (/^[1-4]$/.test(raw)) return KEY_GROUPS_ALLOWED[Number(raw) - 1];
  const exact = KEY_GROUPS_ALLOWED.find(
    (g) => g.toLowerCase() === raw.toLowerCase()
  );
  if (exact) return exact;
  // alias ngắn
  const aliases = {
    codex: "Openai Codex",
    openai: "Openai Codex",
    "openai codex": "Openai Codex",
    grok: "Grok",
    gemini: "Gemini Business",
    "gemini business": "Gemini Business",
    claude: "Claude Max",
    "claude max": "Claude Max",
  };
  const a = aliases[raw.toLowerCase()];
  if (a) return a;
  const partial = KEY_GROUPS_ALLOWED.find((g) =>
    g.toLowerCase().includes(raw.toLowerCase())
  );
  if (partial) return partial;
  logWarn(
    `group "${raw}" không trong whitelist [${KEY_GROUPS_ALLOWED.join(" | ")}] → ${KEY_GROUP_DEFAULT}`
  );
  return KEY_GROUP_DEFAULT;
}

function resolveKeyName(cfg, username) {
  return (
    flag("--key-name", null) ||
    cfg.byesu?.keyName ||
    username ||
    `auto-${Date.now().toString(36)}`
  );
}

/** Gọi API ByesU trong session trình duyệt (cookie + New-Api-User). */
async function byesuApi(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const headers = { accept: "application/json" };
      if (body != null) headers["content-type"] = "application/json";
      // new-api: user id trong localStorage / session
      try {
        const uid =
          localStorage.getItem("user") ||
          localStorage.getItem("user_id") ||
          sessionStorage.getItem("user");
        let id = "";
        if (uid) {
          try {
            const j = JSON.parse(uid);
            id = String(j?.id || j?.user?.id || j || "");
          } catch {
            id = String(uid);
          }
        }
        if (!id) {
          // scan keys
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            const v = localStorage.getItem(k) || "";
            if (/user|auth|profile/i.test(k) && /"id"\s*:/.test(v)) {
              try {
                const j = JSON.parse(v);
                id = String(j?.id || j?.user?.id || j?.data?.id || "");
                if (id) break;
              } catch {
                /* */
              }
            }
          }
        }
        if (id && /^\d+$/.test(id)) headers["New-Api-User"] = id;
      } catch {
        /* */
      }
      const r = await fetch(path, {
        method,
        credentials: "include",
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 400) };
      }
      return { status: r.status, ok: r.ok, json, text: text.slice(0, 500) };
    },
    { method, path, body: body ?? null }
  );
}

async function listGroups(page) {
  const r = await byesuApi(page, "GET", "/api/user/self/groups");
  const data = r.json?.data ?? r.json;
  // data có thể là object { Grok: {...}, default: ... } hoặc array
  let all = [];
  if (Array.isArray(data)) {
    all = data.map((g) => g?.name || g?.group || g).filter(Boolean);
  } else if (data && typeof data === "object") {
    all = Object.keys(data);
  }
  // chỉ giữ group trong whitelist
  return KEY_GROUPS_ALLOWED.filter((g) =>
    all.some((x) => String(x).toLowerCase() === g.toLowerCase())
  ).length
    ? KEY_GROUPS_ALLOWED.filter((g) =>
        all.some((x) => String(x).toLowerCase() === g.toLowerCase())
      )
    : KEY_GROUPS_ALLOWED;
}

/**
 * Tạo API key group chỉ định.
 * new-api: POST /api/token/ → POST /api/token/{id}/key → sk-{key}
 */
async function createApiKey(page, { name, group, unlimited = true }) {
  const groups = await listGroups(page).catch(() => []);
  let g = resolveKeyGroup({ byesu: { group: group || KEY_GROUP_DEFAULT } });
  // khớp tên server nếu khác hoa/thường
  if (groups.length) {
    const hit = groups.find((x) => String(x).toLowerCase() === g.toLowerCase());
    if (hit) g = typeof hit === "string" ? hit : g;
  }
  if (!KEY_GROUPS_ALLOWED.some((x) => x.toLowerCase() === g.toLowerCase())) {
    throw new Error(
      `group bị chặn: ${g}. Chỉ: ${KEY_GROUPS_ALLOWED.join(" | ")}`
    );
  }
  log(`tạo key name=${name} group=${g}`);

  const body = {
    name: String(name).slice(0, 40),
    remain_quota: 0,
    expired_time: -1,
    unlimited_quota: unlimited !== false,
    model_limits_enabled: false,
    model_limits: "",
    allow_ips: "",
    group: g,
    cross_group_retry: false,
  };
  const created = await byesuApi(page, "POST", "/api/token/", body);
  if (!created.json?.success && !created.ok) {
    throw new Error(
      `POST /api/token/ ${created.status}: ${created.json?.message || created.text}`
    );
  }
  // id có thể trong data hoặc data.id
  let tokenId =
    created.json?.data?.id ??
    created.json?.data ??
    created.json?.id ??
    null;
  if (tokenId && typeof tokenId === "object") tokenId = tokenId.id;

  // list nếu không có id
  if (!tokenId) {
    const list = await byesuApi(page, "GET", "/api/token/?p=1&size=20");
    const items = list.json?.data?.items || list.json?.data || list.json || [];
    const arr = Array.isArray(items) ? items : items?.data || [];
    const found = arr.find(
      (t) => String(t?.name || "") === body.name || String(t?.group || "") === g
    );
    tokenId = found?.id;
  }
  if (!tokenId) {
    // một số bản success nhưng data là full key luôn
    const maybeKey = created.json?.data?.key || created.json?.data;
    if (typeof maybeKey === "string" && maybeKey.length > 10) {
      const k = maybeKey.startsWith("sk-") ? maybeKey : `sk-${maybeKey}`;
      return { apiKey: k, tokenId: null, group: g, name: body.name, raw: created.json };
    }
    throw new Error(`không lấy được token id: ${JSON.stringify(created.json).slice(0, 200)}`);
  }

  const keyRes = await byesuApi(page, "POST", `/api/token/${tokenId}/key`);
  const rawKey =
    keyRes.json?.data?.key ||
    keyRes.json?.data ||
    keyRes.json?.key ||
    "";
  if (!rawKey || typeof rawKey !== "string") {
    throw new Error(
      `POST /api/token/${tokenId}/key fail: ${keyRes.json?.message || keyRes.text}`
    );
  }
  const apiKey = rawKey.startsWith("sk-") ? rawKey : `sk-${rawKey}`;
  return { apiKey, tokenId, group: g, name: body.name, groups, raw: keyRes.json };
}

/**
 * UI Create API Key (panel phải — đúng form ByesU):
 *   + Create API Key
 *   Name: Enter a name
 *   Group: Select a group → Grok / …
 *   Expiration: Never
 *   Quantity: 1
 *   Unlimited Quota: ON
 *   Save changes
 * Bảng: Name | Status | API Key sk-… | Group | Actions (copy)
 */
async function createApiKeyUi(page, { name, group }) {
  const keyName = String(name || "a").slice(0, 40);
  const gWant = resolveKeyGroup({ byesu: { group: group || KEY_GROUP_DEFAULT } });

  await page.goto("https://byesu.com/keys", {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await sleep(1500);
  if (/sign-in|login/i.test(page.url())) throw new Error("UI keys: chưa login");
  log(`UI Create API Key name=${keyName} group=${gWant}`);

  // + Create API Key (góc phải)
  const createBtn = page
    .getByRole("button", { name: /^\+?\s*create api key$/i })
    .or(page.getByRole("button", { name: /create api key/i }));
  if ((await createBtn.count()) === 0) {
    const alt = page.locator("button").filter({ hasText: /create api key/i });
    if ((await alt.count()) === 0) throw new Error("UI: không thấy + Create API Key");
    await alt.first().click();
  } else {
    await createBtn.first().click();
  }
  // chờ panel "Create API Key" / "Add a new API key"
  await page
    .getByText(/create api key|add a new api key|enter a name/i)
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
  await sleep(500);

  // Name
  const nameInput = page
    .locator(
      'input[placeholder*="Enter a name" i], input[placeholder*="name" i], input[name="name"]'
    )
    .first();
  await nameInput.waitFor({ state: "visible", timeout: 10_000 });
  await nameInput.click();
  await nameInput.fill("");
  await nameInput.fill(keyName);
  log(`  name=${keyName}`);

  // Group — "Select a group" combobox
  const groupBox = page
    .getByRole("combobox")
    .filter({ hasText: /select a group|group|auto|grok|claude|gemini|codex/i })
    .or(page.locator("button, [role='combobox']").filter({ hasText: /select a group/i }))
    .first();
  if ((await groupBox.count()) === 0) {
    // click vùng Group gần label
    const lab = page.getByText(/^group$/i).first();
    if (await lab.count()) {
      const row = lab.locator("xpath=ancestor::*[.//button or .//*[@role='combobox']][1]");
      await row.locator("button, [role='combobox']").first().click().catch(() => {});
    }
  } else {
    await groupBox.click();
  }
  await sleep(400);

  // chọn option: Grok / Claude Max / …
  let picked = false;
  const opt = page.getByRole("option", { name: new RegExp(gWant, "i") });
  if (await opt.count()) {
    await opt.first().click();
    picked = true;
  } else {
    const item = page
      .locator(
        '[role="option"], [cmdk-item], [data-radix-collection-item], div[role="menuitem"]'
      )
      .filter({ hasText: new RegExp(gWant, "i") });
    if (await item.count()) {
      await item.first().click();
      picked = true;
    }
  }
  if (!picked) {
    // list text + ratio (Grok 0.02x)
    const row = page.locator("div, li, span").filter({
      hasText: new RegExp(`^\\s*${gWant.replace(/[()]/g, "\\$&")}`, "i"),
    });
    if (await row.count()) {
      await row.first().click().catch(() => {});
      picked = true;
    }
  }
  if (picked) logOk(`  group=${gWant}`);
  else logWarn(`  group UI không chọn được "${gWant}" — vẫn Save`);
  await sleep(300);

  // Expiration: Never (nút chip)
  const never = page.getByRole("button", { name: /^never$/i });
  if (await never.count()) {
    await never.first().click().catch(() => {});
  }

  // Quantity = 1
  const qty = page
    .locator('input[name="tokenCount"], input[name="quantity"]')
    .or(page.getByText(/^quantity$/i).locator("xpath=following::input[1]"))
    .first();
  if (await qty.count()) {
    await qty.fill("1").catch(() => {});
  }

  // Unlimited Quota ON
  const unlimLabel = page.getByText(/unlimited quota/i).first();
  if (await unlimLabel.count()) {
    const sw = page.locator('[role="switch"]').first();
    if (await sw.count()) {
      const on = await sw.getAttribute("data-state");
      if (on !== "checked") {
        await sw.click().catch(() => {});
        log("  unlimited ON");
      }
    }
  }

  // Save changes
  const save = page.getByRole("button", { name: /save changes|save|create/i });
  if ((await save.count()) === 0) throw new Error("UI: không thấy Save changes");
  log("  click Save changes…");
  await save.last().click();
  await sleep(2000);

  // toast success
  const toastOk = await page
    .getByText(/successfully created/i)
    .isVisible()
    .catch(() => false);
  if (toastOk) logOk("  toast: Successfully created");

  // đóng panel nếu còn
  const close = page.getByRole("button", { name: /^close$/i });
  if (await close.count()) await close.first().click().catch(() => {});
  await sleep(800);

  // lấy secret: copy icon trên hàng / API reveal
  let apiKey = extractApiKeyFromText(
    await page.innerText("body").catch(() => "")
  );

  // list token + POST /key
  if (!apiKey) {
    const list = await byesuApi(page, "GET", "/api/token/?p=1&size=20");
    const items = list.json?.data?.items || list.json?.data || list.json || [];
    const arr = Array.isArray(items) ? items : items?.data || [];
    const found =
      arr.find((t) => String(t?.name || "") === keyName) ||
      arr.find((t) => String(t?.group || "").toLowerCase() === gWant.toLowerCase()) ||
      arr[0];
    if (found?.id) {
      const keyRes = await byesuApi(page, "POST", `/api/token/${found.id}/key`);
      const raw =
        keyRes.json?.data?.key || keyRes.json?.data || keyRes.json?.key || "";
      if (typeof raw === "string" && raw.length > 8) {
        apiKey = raw.startsWith("sk-") ? raw : `sk-${raw}`;
        logOk(`  reveal id=${found.id}`);
        return {
          apiKey,
          tokenId: found.id,
          group: gWant,
          name: keyName,
          via: "ui+api-reveal",
        };
      }
    }
  }

  // click copy trên hàng Name
  if (!apiKey) {
    const row = page.locator("tr, [role='row']").filter({
      hasText: new RegExp(keyName, "i"),
    });
    if (await row.count()) {
      const copyBtn = row.first().locator("button").filter({
        has: page.locator("svg"),
      });
      // thường nút copy cạnh sk-***
      await row
        .first()
        .locator('button[aria-label*="copy" i], button')
        .nth(0)
        .click()
        .catch(() => {});
      await sleep(400);
      try {
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        if (/^sk-/.test(clip || "")) apiKey = clip.trim();
      } catch {
        /* */
      }
    }
  }

  if (!apiKey) {
    const via = await createApiKey(page, { name: keyName, group: gWant }).catch(
      () => null
    );
    if (via?.apiKey) return { ...via, via: "ui-fallback-api" };
    throw new Error("UI tạo key xong nhưng không đọc được sk- secret");
  }
  return { apiKey, tokenId: null, group: gWant, name: keyName, via: "ui" };
}

/** Xóa cookie + storage — không spam goto (tránh reload form giữa chừng). */
async function clearByesuSession(page, context, { navigate = false } = {}) {
  let n = 0;
  try {
    const all = await context.cookies().catch(() => []);
    n = all.filter((c) => /byesu/i.test(c.domain || "")).length;
    await context.clearCookies();
  } catch {
    await context.clearCookies().catch(() => {});
  }
  // clear storage nếu đang đứng trên byesu
  try {
    const u = page.url();
    if (/byesu\.com/i.test(u)) {
      await page.evaluate(() => {
        try {
          localStorage.clear();
          sessionStorage.clear();
        } catch {
          /* */
        }
      });
    }
  } catch {
    /* */
  }
  if (navigate) {
    try {
      await page.goto("https://byesu.com/", {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
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
  }
  log(`clear ByesU cookies≈${n} + storage`);
  return n;
}

/** Logout API + wipe cookie. navigateSignUp=false khi cleanup cuối (tránh loop form). */
async function logoutByesu(page, context, { navigateSignUp = true } = {}) {
  log("logout ByesU…");
  try {
    await page
      .evaluate(async () => {
        try {
          await fetch("/api/user/logout", { credentials: "include" });
        } catch {
          /* */
        }
      })
      .catch(() => {});
  } catch {
    /* */
  }
  await clearByesuSession(page, context, { navigate: false });
  if (navigateSignUp) {
    await page
      .goto(SIGNUP_URL, { waitUntil: "domcontentloaded", timeout: 20_000 })
      .catch(() => {});
  }
  logOk("logout + cookie wiped");
}

/**
 * Trước reg: luôn wipe session cũ (tránh dính acc trước).
 * force=true → luôn xóa.
 */
async function ensureLoggedOut(page, context, { force = true } = {}) {
  const cookies = await context.cookies().catch(() => []);
  const hit = cookies.filter((c) => /byesu/i.test(c.domain || "")).length;
  if (!force && hit === 0) {
    log("session clean");
    return false;
  }
  log(`session LOGOUT force=${force} cookies=${hit}`);
  // chỉ wipe cookie — 1 lần goto sign-up ở caller
  await clearByesuSession(page, context, { navigate: false });
  return true;
}

/** Pathname only — tránh match `sign-in?redirect=%2Fdashboard` */
function pagePath(page) {
  try {
    return new URL(page.url()).pathname.toLowerCase();
  } catch {
    return "";
  }
}

function isAuthPage(page) {
  const p = pagePath(page);
  return /sign-in|sign-up|login|register/.test(p);
}

function isAppPage(page) {
  const p = pagePath(page);
  // chỉ path thật, không query
  return (
    /^\/(dashboard|keys|console|playground|wallet|profile|usage|channel|models)?\/?$/.test(
      p
    ) ||
    p.startsWith("/dashboard") ||
    p.startsWith("/keys") ||
    p.startsWith("/console") ||
    p.startsWith("/_authenticated")
  );
}

/** Đã login? self API + không còn form sign-in */
async function isLoggedIn(page) {
  try {
    const self = await byesuApi(page, "GET", "/api/user/self");
    const ok = !!(self.json?.success && self.json?.data?.id);
    if (!ok) return false;
    // API ok nhưng URL vẫn sign-in = cookie session chưa dính browser
    if (isAuthPage(page)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Sau login: chờ rời sign-in + dashboard/app thật (pathname).
 * Không tin query `?redirect=%2Fdashboard`.
 */
async function waitDashboardReady(page, { timeoutMs = 60_000 } = {}) {
  log("chờ dashboard load sau login…");
  const t0 = Date.now();

  // 1) nếu còn auth page: thử vào dashboard (session cookie)
  if (isAuthPage(page)) {
    log("còn sign-in — goto /dashboard kiểm tra session…");
    await page
      .goto("https://byesu.com/dashboard", {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      })
      .catch(() => {});
    await sleep(1500);
  }

  // 2) poll đến khi pathname app + self OK
  while (Date.now() - t0 < timeoutMs) {
    const path = pagePath(page);
    const auth = isAuthPage(page);
    const sec = Math.round((Date.now() - t0) / 1000);

    if (auth) {
      if (sec % 5 === 0) log(`  +${sec}s vẫn auth page path=${path}`);
      // self API?
      const self = await byesuApi(page, "GET", "/api/user/self").catch(() => null);
      // còn auth page — chỉ chờ redirect SPA, không spam goto (mất form)
      if (sec > 0 && sec % 6 === 0) {
        log(`  +${sec}s path=${path} (chờ SPA, không reload form)`);
      }
      await sleep(1000);
      continue;
    }

    // không còn auth page
    const body = await page.innerText("body").catch(() => "");
    const uiReady =
      /api keys|playground|overview|wallet|usage logs|dashboard/i.test(body) ||
      (await page.getByRole("link", { name: /api keys/i }).count().catch(() => 0)) >
        0;
    const selfOk = await byesuApi(page, "GET", "/api/user/self")
      .then((r) => !!(r.json?.success && r.json?.data?.id))
      .catch(() => false);

    if (selfOk && (isAppPage(page) || uiReady)) {
      logOk(`dashboard ready +${sec}s path=${path}`);
      await sleep(2000); // hydrate SPA
      return true;
    }

    if (sec % 5 === 0) {
      log(`  +${sec}s path=${path} self=${selfOk} ui=${uiReady}`);
    }
    await sleep(800);
  }

  logWarn(
    `dashboard timeout path=${pagePath(page)} url=${page.url().slice(0, 70)}`
  );
  return false;
}

/** Điền form login (có thể gọi lại nếu SPA reset). */
async function fillLoginForm(page, userVal, password) {
  await page
    .waitForSelector(
      'input[name="username"], input[type="password"], input[placeholder*="username" i]',
      { timeout: 20_000 }
    )
    .catch(() => {});
  await sleep(400);
  await setInput(page, 'input[name="username"]', userVal).catch(async () => {
    const alt = page
      .locator(
        'input[type="text"], input[type="email"], input[placeholder*="username" i], input[placeholder*="email" i]'
      )
      .first();
    await alt.fill(String(userVal));
  });
  await setInput(page, 'input[name="password"]', password).catch(async () => {
    await page.locator('input[type="password"]').first().fill(String(password));
  });
  // verify không bị blank
  const u = await page
    .locator('input[name="username"]')
    .inputValue()
    .catch(() => "");
  const p = await page
    .locator('input[name="password"]')
    .inputValue()
    .catch(() => "");
  if (!u || !p) {
    logWarn("form trống sau fill — điền lại");
    await page.locator('input[name="username"]').fill(String(userVal)).catch(() => {});
    await page.locator('input[type="password"]').first().fill(String(password)).catch(() => {});
  }
  await ensureLegalConsent(page).catch(() => {});
}

/**
 * Login ByesU — ƯU TIÊN bấm Sign in UI (set cookie browser).
 * Không fetch API rồi goto dashboard (reset form / mất session SPA).
 */
async function loginByesu(page, cfg, { username, password, email }) {
  const loginUrl = "https://byesu.com/sign-in";
  const userVal = username || email;
  log(`login → ${userVal}`);

  if (await isLoggedIn(page)) {
    logOk("đã có session — bỏ qua form login");
    return { ok: true, via: "already" };
  }
  if (isAppPage(page) && (await isLoggedIn(page))) {
    return { ok: true, via: "already-url" };
  }

  // vào sign-in nếu cần — 1 lần
  if (!isAuthPage(page) || /sign-up/i.test(pagePath(page))) {
    await page.goto(loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await sleep(800);
  }

  // fill 1 lần
  await fillLoginForm(page, userVal, password);

  // captcha đến khi xong
  await requireCaptchaBeforeSubmit(page, cfg, "login", "Sign in");

  // kiểm tra form còn data (SPA đôi khi clear khi captcha xong)
  {
    const u = await page
      .locator('input[name="username"]')
      .inputValue()
      .catch(() => "");
    if (!u) {
      logWarn("form bị reset sau captcha — điền lại");
      await fillLoginForm(page, userVal, password);
      const st = await turnstileState(page);
      if (st.len < 20) {
        await requireCaptchaBeforeSubmit(page, cfg, "login", "Sign in (refill)");
      }
    }
  }

  // ── CHỈ bấm nút Sign in (không fetch API + goto — gây mất form) ──
  const signBtn = page.getByRole("button", {
    name: /sign in|đăng nhập|login/i,
  });
  for (let i = 0; i < 25; i++) {
    const st = await turnstileState(page);
    const dis = await signBtn.isDisabled().catch(() => true);
    const filled = await page
      .locator('input[name="username"]')
      .inputValue()
      .catch(() => "");
    if (!filled) {
      logWarn("username trống — fill lại");
      await fillLoginForm(page, userVal, password);
    }
    if (!dis && (st.len > 20 || st.success)) break;
    if (i % 3 === 0) {
      log(`  chờ Sign in… ${i + 1}/25 token=${st.len} dis=${dis}`);
      await ensureLegalConsent(page).catch(() => {});
      if (st.hasWidget && st.len < 20) {
        await Promise.race([
          clickTurnstileCheckbox(page).catch(() => {}),
          sleep(2000),
        ]);
      }
    }
    await sleep(500);
  }

  // final captcha gate
  {
    const st = await turnstileState(page);
    if (st.len < 20 && !st.success) {
      logWarn("captcha chưa OK — scan thêm 20s");
      await requireCaptchaBeforeSubmit(page, cfg, "login", "Sign in final");
      // refill nếu mất
      const u = await page
        .locator('input[name="username"]')
        .inputValue()
        .catch(() => "");
      if (!u) await fillLoginForm(page, userVal, password);
    }
  }

  log("click Sign in (giữ form, không goto)…");
  await signBtn.click({ timeout: 10_000 }).catch(async () => {
    await signBtn.click({ force: true, timeout: 5000 });
  });

  // chờ SPA tự redirect — KHÔNG page.goto (tránh reset)
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    if (!isAuthPage(page)) {
      logOk(`login redirect path=${pagePath(page)}`);
      await sleep(2000);
      const ready = await waitDashboardReady(page);
      if (ready || isAppPage(page)) return { ok: true, via: "ui" };
    }
    const b = await page.innerText("body").catch(() => "");
    if (/invalid|incorrect|wrong password|failed/i.test(b)) {
      const m = b.match(
        /(invalid[^.\n]{0,40}|incorrect[^.\n]{0,40}|wrong password|failed[^.\n]{0,40})/i
      );
      if (m) throw new Error(`login fail: ${m[0]}`);
    }
    const sec = Math.round((Date.now() - t0) / 1000);
    if (sec > 0 && sec % 5 === 0) {
      log(`  chờ redirect… +${sec}s path=${pagePath(page)}`);
    }
    // form bị wipe khi chờ? không refill nếu đã click — chỉ log
    await sleep(800);
  }

  // vẫn auth: thử 1 lần điền + click lại (không API)
  if (isAuthPage(page)) {
    logWarn("vẫn sign-in — fill + Sign in lần 2");
    await fillLoginForm(page, userVal, password);
    await requireCaptchaBeforeSubmit(page, cfg, "login", "Sign in retry");
    await signBtn.click({ force: true, timeout: 8000 }).catch(() => {});
    const t1 = Date.now();
    while (Date.now() - t1 < 30_000) {
      if (!isAuthPage(page)) {
        await waitDashboardReady(page);
        return { ok: true, via: "ui-retry" };
      }
      await sleep(800);
    }
  }

  throw new Error(
    `login timeout — path=${pagePath(page)} url=${page.url().slice(0, 70)}`
  );
}

async function ensureApiKey(page, cfg, username, password, email) {
  const group = resolveKeyGroup(cfg);
  const name = resolveKeyName(cfg, username);

  // đã login (caller vừa login) → chờ dashboard rồi /keys
  if (!(await isLoggedIn(page))) {
    log("chưa session — login 1 lần");
    const login = await loginByesu(page, cfg, { username, password, email });
    if (!login.ok) throw new Error("login fail");
  } else {
    logOk("session OK");
  }

  // bắt buộc: dashboard ổn định rồi mới keys
  await waitDashboardReady(page);

  // chỉ vào keys khi đã thoát auth page
  if (isAuthPage(page)) {
    throw new Error(
      `chưa vào được app (path=${pagePath(page)}) — session fail, không tạo key`
    );
  }

  log("dashboard xong → /keys…");
  await page.goto("https://byesu.com/keys", {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await sleep(1500);

  if (isAuthPage(page)) {
    throw new Error("/keys redirect sign-in — cookie session không dính");
  }

  await page
    .getByRole("button", { name: /create api key/i })
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch(() => {});
  await sleep(1000);

  const self = await byesuApi(page, "GET", "/api/user/self");
  if (self.json?.data?.id) {
    await page.evaluate((id) => {
      try {
        localStorage.setItem("user", JSON.stringify({ id }));
      } catch {
        /* */
      }
    }, self.json.data.id);
  }

  try {
    const r = await createApiKey(page, { name, group });
    logOk(`API key ${r.apiKey.slice(0, 12)}… group=${r.group}`);
    return r;
  } catch (e) {
    logWarn(`API create fail: ${e.message?.slice(0, 120)} → UI`);
    const r = await createApiKeyUi(page, { name, group });
    logOk(`API key (UI) ${r.apiKey.slice(0, 12)}… group=${r.group}`);
    return r;
  }
}

async function scrapeResult(page, context) {
  const url = page.url();
  const body = await page.innerText("body").catch(() => "");
  let apiKey = extractApiKeyFromText(body);
  if (!apiKey) {
    const ls = await page
      .evaluate(() => {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          out[k] = localStorage.getItem(k);
        }
        return out;
      })
      .catch(() => ({}));
    apiKey = extractApiKeyFromText(JSON.stringify(ls));
  }
  const cookies = await context.cookies("https://byesu.com").catch(() => []);
  return { url, apiKey, cookies, bodySnippet: body.slice(0, 500) };
}

/** Tên file txt theo group: "Claude Max" → "api key claude max.txt" */
function keyListFileName(group) {
  const g = String(group || KEY_GROUP_DEFAULT).trim() || KEY_GROUP_DEFAULT;
  return `api key ${g.toLowerCase()}.txt`;
}

/** Append 1 key / dòng → keys/api key <group>.txt */
function appendKeyToGroupFile(apiKey, group) {
  if (!apiKey || !String(apiKey).startsWith("sk-")) return null;
  mkdirSync(KEYS_DIR, { recursive: true });
  const file = join(KEYS_DIR, keyListFileName(group));
  let exists = false;
  if (existsSync(file)) {
    const prev = readFileSync(file, "utf8");
    exists = prev.split(/\r?\n/).some((l) => l.trim() === apiKey);
  }
  if (!exists) {
    appendFileSync(file, apiKey + "\n", "utf8");
    logOk(`+ key → keys/${keyListFileName(group)}`);
  } else {
    log(`key đã có trong keys/${keyListFileName(group)}`);
  }
  return file;
}

function saveResult(rec) {
  mkdirSync(ACC_DIR, { recursive: true });
  mkdirSync(KEYS_DIR, { recursive: true });
  const ts = Date.now();
  const name = rec.ok ? `byesu-ok-${ts}.json` : `byesu-fail-${ts}.json`;
  const path = join(ACC_DIR, name);
  writeFileSync(path, JSON.stringify(rec, null, 2));
  writeFileSync(join(ACC_DIR, "byesu-latest.json"), JSON.stringify(rec, null, 2));
  appendFileSync(
    join(ACC_DIR, "byesu-results.jsonl"),
    JSON.stringify(rec) + "\n"
  );
  if (rec.apiKey) {
    appendKeyToGroupFile(rec.apiKey, rec.group || resolveKeyGroup({}));
  }
  return path;
}

function is429(text) {
  return /429|too many requests|rate.?limit|quota.?exceeded|请求过多|频率/i.test(
    String(text || "")
  );
}

async function regOnce(cfg, { jobIndex = 0 } = {}) {
  const emailFlag = flag("--email", null);
  let tm = null;
  let email = emailFlag;
  let username =
    flag("--username", null) ||
    (email ? String(email).split("@")[0].replace(/[^a-zA-Z0-9_]/g, "").slice(0, 16) : null) ||
    randUsername();
  const password = makePassword(cfg);

  if (!email) {
    log("tạo temp mail (tempmail.lol)…");
    tm = await createTempInbox(log, "lol");
    email = tm.address;
    log(`domain=${tm.domain || email.split("@")[1]}`);
  }
  log(`user=${username}`);
  log(`email=${email}`);
  log(`passLen=${password.length}`);

  const { browser, context, page, userChrome } = await launchBrowser(cfg, {
    jobIndex,
  });
  let ok = false;
  let step = "start";
  let apiKey = "";
  let errMsg = "";

  try {
    // ── XÓA COOKIE / LOGOUT session cũ trước reg ──
    step = "logout";
    await ensureLoggedOut(page, context, { force: true });

    step = "goto";
    log(`mở ${SIGNUP_URL}`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(SIGNUP_URL, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        break;
      } catch (e) {
        logWarn(`goto try ${attempt}/3: ${String(e.message || e).slice(0, 100)}`);
        if (attempt === 3) throw e;
        await sleep(1500 * attempt);
      }
    }
    // chờ form (SPA)
    try {
      await page.waitForSelector('input[name="username"]', { timeout: 45_000 });
    } catch {
      logWarn(`URL hiện tại: ${page.url()}`);
      const body = await page.innerText("body").catch(() => "");
      logWarn(`body: ${body.slice(0, 120).replace(/\s+/g, " ")}`);
      throw new Error(
        "Trang sign-up không load form (username). Kiểm tra mạng/proxy/CF."
      );
    }
    logOk(`loaded ${page.url()}`);
    await sleep(500);

    step = "fill";
    await setInput(page, 'input[name="username"]', username);
    await setInput(page, 'input[name="password"]', password);
    await setInput(page, 'input[name="confirmPassword"]', password);
    await setInput(page, 'input[name="email"]', email);

    step = "legal";
    await ensureLegalConsent(page);

    step = "captcha";
    await requireCaptchaBeforeSubmit(page, cfg, "signup", "Send code");

    step = "send-code";
    // KHÔNG reload trang (mất form + captcha). Chỉ gửi API/click.
    let sendRes = await sendVerification(page, email);
    if (!sendRes.sent) {
      logWarn("gửi OTP fail — chờ captcha + gửi lại (không reload)");
      await requireCaptchaBeforeSubmit(page, cfg, "signup", "Resend");
      sendRes = await sendVerification(page, email);
    }
    if (!sendRes.sent) {
      throw new Error(
        `Gửi OTP fail: ${sendRes.error || sendRes.via || "unknown"}`
      );
    }
    logOk(`send via=${sendRes.via}`);

    // toast — bỏ false positive "Already have an account? Sign in" (link trang)
    const toast = await page.innerText("body").catch(() => "");
    if (is429(toast) || is429(sendRes.error) || is429(JSON.stringify(sendRes.api || ""))) {
      throw new Error("HTTP 429 rate limit — đổi proxy (next) rồi chạy lại");
    }
    const toastErr = toast.match(
      /(too many requests|rate limit|blocked|invalid email|email already|user already exists|failed to send[^.\n]{0,40}|verification failed)/i
    );
    if (toastErr) logWarn(`page: ${toastErr[0]}`);

    step = "otp-wait";
    let code = flag("--otp", null);
    if (!code) {
      if (!tm)
        throw new Error("Cần --otp khi dùng --email cố định (không temp mail)");
      log(`chờ OTP [${tm.provider}] → ${tm.address}`);
      const timeoutMs = Number(flag("--otp-timeout", "90000")) || 90_000;
      const tPoll = Date.now();
      let emptyStreak = 0;
      const got = await waitByesuOtp(tm, {
        timeoutMs,
        onTick: (i, info = {}) => {
          if (info.n === 0) emptyStreak++;
          else emptyStreak = 0;
          if (i === 0 || i % 4 === 0 || info.sub || info.err) {
            const sec = Math.round((Date.now() - tPoll) / 1000);
            log(
              `poll OTP #${i + 1} +${sec}s inbox=${info.n ?? "?"} ${info.err || ""} ${info.sub ? `«${String(info.sub).slice(0, 40)}»` : ""}`.trim()
            );
          }
          if (emptyStreak === 20 && !info.err) {
            logWarn("inbox=0 ~30s — resend OTP…");
            sendVerification(page, email).catch((e) =>
              logWarn(`resend: ${e.message?.slice(0, 80)}`)
            );
          }
        },
      });
      code = got.code;
      logOk(`OTP ${code} from=${got.from || "?"} sub=${got.subject || ""}`);
    }

    step = "otp-fill";
    // ô verification code — name rỗng, placeholder
    const otpSel =
      'input[placeholder*="Verification" i], input[placeholder*="code" i], input[name="code"], input[name="otp"]';
    const otpLoc = page.locator(otpSel).first();
    if ((await otpLoc.count()) === 0) {
      // fallback: input text không phải username
      const all = page.locator('input[type="text"]');
      const n = await all.count();
      for (let i = 0; i < n; i++) {
        const ph = await all.nth(i).getAttribute("placeholder");
        if (/code|verif/i.test(ph || "")) {
          await all.nth(i).fill(code);
          break;
        }
      }
    } else {
      await otpLoc.fill(code);
    }
    await sleep(400);

    // tick lại legal (form React có thể reset)
    step = "legal2";
    await ensureLegalConsent(page);

    // captcha LẠI trước Create — quét đủ, không bấm sớm
    step = "captcha2";
    await requireCaptchaBeforeSubmit(page, cfg, "signup", "Create account");

    step = "submit";
    await ensureLegalConsent(page);
    const createBtn = page.getByRole("button", { name: /create account/i });
    for (let i = 0; i < 20; i++) {
      const st = await turnstileState(page);
      const dis = await createBtn.isDisabled().catch(() => true);
      if (!dis && (st.len > 20 || st.success)) break;
      if (i % 3 === 0) {
        log(
          `Create wait… ${i + 1}/20 token=${st.len} dis=${dis}`
        );
        await ensureLegalConsent(page);
        if (st.hasWidget && st.len < 20) {
          await Promise.race([
            clickTurnstileCheckbox(page).catch(() => {}),
            sleep(2000),
          ]);
        }
      }
      await sleep(500);
    }
    log("click Create account (captcha đã scan)…");
    await createBtn.click({ timeout: 10_000 }).catch(async () => {
      await createBtn.click({ force: true, timeout: 5000 });
    });
    logOk("đã bấm Create account");

    // chờ rời sign-up (thường → sign-in hoặc dashboard)
    step = "wait-done";
    const t0 = Date.now();
    while (Date.now() - t0 < 45_000) {
      const u = page.url();
      // reg xong hay redirect sign-in / keys / dashboard
      if (
        /sign-in|login/i.test(u) ||
        /dashboard|console|keys|settings|home/i.test(u) ||
        !/sign-up|register/i.test(u)
      ) {
        ok = true;
        logOk(`reg xong → ${u.slice(0, 70)}`);
        break;
      }
      const b = await page.innerText("body").catch(() => "");
      if (
        /success|welcome|api key|dashboard|sign in/i.test(b) &&
        !/create an account/i.test(b.slice(0, 80))
      ) {
        ok = true;
        break;
      }
      if (/already exists|invalid|error|failed|incorrect/i.test(b)) {
        const m = b.match(
          /(already exists|invalid[^.\n]{0,40}|incorrect[^.\n]{0,40}|failed[^.\n]{0,40})/i
        );
        if (m) errMsg = m[0];
      }
      await sleep(800);
    }

    if (!ok && !errMsg) {
      const still = /sign-up/i.test(page.url());
      if (!still) ok = true;
      else errMsg = errMsg || "vẫn ở trang sign-up";
    }

    // ── Login 1 lần → chờ → /keys → tạo key (không loop form) ──
    let keyMeta = null;
    if (ok) {
      step = "login";
      try {
        if (await isLoggedIn(page)) {
          logOk("reg xong đã có session");
          await waitDashboardReady(page);
        } else if (/sign-in|login|sign-up/i.test(page.url())) {
          await loginByesu(page, cfg, { username, password, email });
          // loginByesu đã waitDashboardReady
        } else {
          await sleep(1500);
          if (!(await isLoggedIn(page))) {
            await loginByesu(page, cfg, { username, password, email });
          } else {
            await waitDashboardReady(page);
          }
        }
      } catch (e) {
        logWarn(`login: ${e.message?.slice(0, 140)}`);
        errMsg = errMsg || `login: ${e.message}`;
      }

      step = "create-key";
      try {
        keyMeta = await ensureApiKey(page, cfg, username, password, email);
        apiKey = keyMeta.apiKey || apiKey;
      } catch (e) {
        logWarn(`tạo key: ${e.message?.slice(0, 140)}`);
        if (!apiKey) errMsg = errMsg || `key: ${e.message}`;
      }
    }

    if (!apiKey) {
      const scraped = await scrapeResult(page, context);
      apiKey = scraped.apiKey;
    }

    const rec = {
      ok,
      step: ok ? (apiKey ? "done" : "reg-ok-no-key") : step,
      error: ok ? (apiKey ? "" : errMsg || "no api key") : errMsg || step,
      username,
      email,
      password,
      apiKey,
      group: keyMeta?.group || resolveKeyGroup(cfg),
      keyName: keyMeta?.name || "",
      tokenId: keyMeta?.tokenId || null,
      url: page.url(),
      at: new Date().toISOString(),
      tempMail: tm?.address || "",
    };
    const path = saveResult(rec);
    if (ok) logOk(`OK → ${path}`);
    else logErr(`FAIL ${errMsg || step} → ${path}`);

    // cleanup: wipe + redirect sign-up (để lần sau reg tiếp)
    step = "cleanup";
    await logoutByesu(page, context, { navigateSignUp: true }).catch((e) =>
      logWarn(`cleanup: ${String(e.message || e).slice(0, 80)}`)
    );
    return rec;
  } catch (e) {
    errMsg = e.message || String(e);
    logErr(errMsg);
    const rec = {
      ok: false,
      step,
      error: errMsg,
      username,
      email,
      password,
      apiKey: "",
      url: page.url?.() || "",
      at: new Date().toISOString(),
      tempMail: tm?.address || "",
    };
    saveResult(rec);
    await logoutByesu(page, context, { navigateSignUp: false }).catch(() => {});
    return rec;
  } finally {
    if (!userChrome) {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    } else {
      await page.close().catch(() => {});
      // giữ Chrome profile (cookie đã wipe)
    }
  }
}

async function main() {
  const cfg = loadConfig();
  log(C.bold(`ByesU auto reg ×${COUNT}`));
  log(`mode=CDP Chrome visible  port=${CDP_PORT} worker=${WORKER || 0}`);
  log("proxy: set trong Chrome profile nếu 429 (không Playwright)");
  log(`group=${resolveKeyGroup(cfg)}`);

  const results = [];
  for (let i = 1; i <= COUNT; i++) {
    if (COUNT > 1) console.log(`\n${C.cyan("──")} lượt ${i}/${COUNT} ${C.cyan("──")}`);
    const r = await regOnce(cfg, { jobIndex: i - 1 });
    results.push(r);
    if (is429(r?.error)) {
      logWarn("429 — bật VPN / đổi IP Chrome, chờ rồi chạy lại");
    }
    if (i < COUNT) await sleep(2000);
  }

  const okN = results.filter((r) => r.ok).length;
  console.log(`\n${C.bold("Kết quả")}: ${okN}/${results.length} OK`);
  for (const r of results) {
    console.log(
      `  ${r.ok ? C.green("OK") : C.red("FAIL")}  ${r.email}  ${r.group || "?"}  ${r.apiKey ? r.apiKey.slice(0, 14) + "…" : "(no key)"}`
    );
  }
  process.exit(okN === results.length ? 0 : 2);
}

main().catch((e) => {
  console.error("[LỖI]", e.message || e);
  process.exit(1);
});
