/**
 * Cloudflare Turnstile helpers
 *
 * Plan Discord/Free: Token API → 402 (unavailable). Dùng extension.
 * Paid plan có turnstile token: solveTurnstileToken()
 *
 *   node turnstile.mjs --status
 *   node turnstile.mjs --solve --sitekey 0x4AAAA… --url https://accounts.x.ai/sign-up
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const API = "https://api.nopecha.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadKey() {
  if (process.env.NOPECHA_KEY) return process.env.NOPECHA_KEY.trim();
  const p = join(__dir, "config.json");
  if (existsSync(p)) {
    try {
      const c = JSON.parse(readFileSync(p, "utf8"));
      if (c.nopechaKey) return String(c.nopechaKey).trim();
    } catch {
      /* */
    }
  }
  return "";
}

export async function keyStatus(key = loadKey()) {
  const url = key
    ? `${API}/v1/status?key=${encodeURIComponent(key)}`
    : `${API}/v1/status`;
  const r = await fetch(url);
  return r.json();
}

/**
 * Token API — cần plan hỗ trợ Turnstile token (Starter+ thường).
 * Discord/Free → error 18 Feature unavailable.
 */
export async function solveTurnstileToken({
  sitekey,
  url,
  key = loadKey(),
  timeoutMs = 25_000,
} = {}) {
  if (!sitekey) throw new Error("missing sitekey");
  if (!url) throw new Error("missing url");
  if (!key) throw new Error("missing nopecha key");

  const post = await fetch(`${API}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "turnstile", sitekey, url, key }),
  }).then((r) => r.json());

  if (post.error != null || !post.data) {
    const msg = post.message || JSON.stringify(post);
    if (post.error === 18 || /unavailable|plan/i.test(msg)) {
      throw new Error(
        `Turnstile Token API không có trên plan hiện tại (${msg}). Dùng extension: npm run grok`
      );
    }
    throw new Error(`nopecha token post: ${msg}`);
  }

  const jobId = post.data;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1500);
    const got = await fetch(
      `${API}/token?key=${encodeURIComponent(key)}&id=${encodeURIComponent(jobId)}`
    ).then((r) => r.json());
    if (got.error === 14 || got.message === "Incomplete job") continue;
    if (got.error != null) throw new Error(`nopecha token get: ${JSON.stringify(got)}`);
    if (typeof got.data === "string" && got.data.length > 20) return got.data;
  }
  throw new Error("Turnstile token timeout");
}

/** Lấy sitekey từ page HTML / iframe src */
export async function extractSitekey(page) {
  const fromDom = await page.evaluate(() => {
    const el =
      document.querySelector("[data-sitekey]") ||
      document.querySelector(".cf-turnstile") ||
      document.querySelector("[class*='turnstile']");
    if (el?.getAttribute?.("data-sitekey")) return el.getAttribute("data-sitekey");
    const ifr = [...document.querySelectorAll("iframe")].find((f) =>
      /turnstile|challenges\.cloudflare/i.test(f.src || "")
    );
    if (ifr?.src) {
      const m = ifr.src.match(/0x[0-9A-Za-z_-]{10,}/);
      if (m) return m[0];
    }
    return null;
  });
  if (fromDom) return fromDom;
  // fallback xAI known
  return "0x4AAAAAAAhr9JGVDZbrZOo0";
}

/**
 * Inject token vào widget (khi có token từ API).
 * Không bypass được nếu site validate server-side + bot score.
 */
export async function injectTurnstileToken(page, token) {
  await page.evaluate((t) => {
    const names = [
      "cf-turnstile-response",
      "g-recaptcha-response",
      "h-captcha-response",
    ];
    for (const n of names) {
      document.querySelectorAll(`[name="${n}"]`).forEach((el) => {
        el.value = t;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    if (window.turnstile?.getResponse) {
      /* noop */
    }
    // callback hooks
    document.querySelectorAll("[data-callback]").forEach((el) => {
      const cb = el.getAttribute("data-callback");
      if (cb && typeof window[cb] === "function") {
        try {
          window[cb](t);
        } catch {
          /* */
        }
      }
    });
  }, token);
}

export async function turnstileState(page) {
  return page.evaluate(() => {
    const inputs = [
      ...document.querySelectorAll(
        'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
      ),
    ];
    const token =
      inputs.map((i) => i.value).find((v) => v && v.length > 20) || "";
    const text = document.body?.innerText || "";
    const failed = /Verification failed/i.test(text);
    const hasWidget = [...document.querySelectorAll("iframe")].some((f) =>
      /turnstile|challenges\.cloudflare/i.test(f.src || f.title || "")
    );
    const iframeOk = [...document.querySelectorAll("iframe")].some((f) => {
      const t = `${f.title || ""} ${f.getAttribute("aria-label") || ""}`;
      return /success|verified|complete|passed/i.test(t);
    });
    const uiOk =
      /Success!|verified you are human|verification (complete|successful)/i.test(
        text
      );
    const submitReady = [...document.querySelectorAll("button")].some((b) => {
      const n = (b.innerText || b.textContent || "").trim();
      if (!/complete sign up|create account|sign up|continue|submit/i.test(n))
        return false;
      return !b.disabled && b.getAttribute("aria-disabled") !== "true";
    });
    // Chỉ token / iframe / UI — KHÔNG tin submitReady một mình (nút hay enabled sớm)
    const success = !failed && (token.length > 20 || iframeOk || uiOk);
    return {
      token: token.slice(0, 32),
      len: token.length,
      failed,
      hasWidget,
      success,
      submitReady,
      iframeOk,
      uiOk,
    };
  });
}

/** Chờ widget Turnstile xuất hiện (load xong) trước khi coi captcha. */
export async function waitTurnstileWidget(page, { timeoutMs = 30_000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await turnstileState(page);
    if (st.hasWidget || st.len > 20 || st.success) return st;
    await sleep(500);
  }
  return turnstileState(page);
}

/** Chờ token ổn định + nút ready → click Complete ×1. */
export async function clickSignupAfterCaptcha(page, {
  settleMs = 2500,
  maxWaitMs = 20_000,
} = {}) {
  await sleep(settleMs);
  const t0 = Date.now();
  let stable = 0;
  while (Date.now() - t0 < maxWaitMs) {
    const st = await turnstileState(page);
    if (st.success && !st.failed) {
      stable++;
      if (stable >= 2) break;
    } else stable = 0;
    await sleep(600);
  }
  const st = await turnstileState(page);
  if (st.failed) return { ok: false, reason: "failed" };
  if (!st.success && st.len < 20) return { ok: false, reason: "no-token" };

  const patterns = [
    /complete sign up/i,
    /create (your )?account/i,
    /^continue$/i,
  ];
  let btn = null;
  const waitBtn = Date.now();
  while (Date.now() - waitBtn < 15_000) {
    for (const re of patterns) {
      const loc = page.getByRole("button", { name: re });
      if (!(await loc.count())) continue;
      const b = loc.first();
      const dis = await b.isDisabled().catch(() => true);
      const vis = await b.isVisible().catch(() => false);
      if (!dis && vis) {
        btn = b;
        break;
      }
    }
    if (btn) break;
    await sleep(400);
  }
  if (!btn) return { ok: false, reason: "no-button" };
  await btn.click({ timeout: 10_000 });
  await sleep(2000);
  return { ok: true, reason: "clicked-once" };
}

export async function reloadTurnstile(page) {
  await page.evaluate(() => {
    const links = [...document.querySelectorAll("a, button")].filter((el) =>
      /troubleshoot|refresh|retry|try again/i.test(el.textContent || "")
    );
    if (links[0]) {
      links[0].click();
      return;
    }
    const ifr = [...document.querySelectorAll("iframe")].find((f) =>
      /turnstile|challenges\.cloudflare/i.test(f.src || "")
    );
    if (ifr) {
      const src = ifr.src;
      ifr.src = "";
      ifr.src = src.includes("#") ? src : src + "#refresh";
    }
  });
  await sleep(2000);
}

export async function waitExtensionTurnstile(page, {
  timeoutMs = 25_000,
  onFailed,
} = {}) {
  const t0 = Date.now();
  let failCount = 0;
  let noWidgetTicks = 0;
  while (Date.now() - t0 < timeoutMs) {
    const st = await turnstileState(page);
    if (st.success && st.len > 20) return { ok: true, via: "token-field" };
    if (st.success) return { ok: true, via: "ui-success" };
    if (!st.hasWidget && !st.len) {
      noWidgetTicks++;
      if (noWidgetTicks >= 5) return { ok: false, via: "no-widget" };
    } else noWidgetTicks = 0;
    if (st.failed) {
      failCount++;
      if (failCount === 1 || failCount % 3 === 0) {
        await reloadTurnstile(page);
        await onFailed?.(failCount);
      }
    }
    await sleep(1200);
  }
  return { ok: false, via: "timeout" };
}

export async function solveTurnstileWithFallback(page, {
  pageUrl,
  useExtension = true,
  tryTokenApi = true,
  manualTimeoutMs = 45_000,
  extTimeoutMs = 25_000,
} = {}) {
  const steps = [];
  const sitekey = await extractSitekey(page).catch(
    () => "0x4AAAAAAAhr9JGVDZbrZOo0"
  );

  {
    const st = await turnstileState(page);
    if (st.success && st.len > 20) {
      steps.push({ step: "already", ok: true });
      return { ok: true, via: "already", steps };
    }
  }

  if (useExtension) {
    const r = await waitExtensionTurnstile(page, { timeoutMs: extTimeoutMs });
    steps.push({ step: "extension", ok: r.ok, via: r.via });
    if (r.ok) return { ok: true, via: `extension:${r.via}`, steps };
  } else {
    steps.push({ step: "extension", ok: false, skip: true });
  }

  if (tryTokenApi) {
    try {
      const token = await solveTurnstileToken({
        sitekey,
        url: pageUrl || page.url(),
        timeoutMs: 20_000,
      });
      await injectTurnstileToken(page, token);
      await sleep(1000);
      const st = await turnstileState(page);
      const ok = st.len > 20 || st.success;
      steps.push({ step: "token-api", ok, tokenLen: token.length });
      if (ok) return { ok: true, via: "token-api", steps };
    } catch (e) {
      steps.push({ step: "token-api", ok: false, error: e.message });
    }
  }

  await waitTurnstileWidget(page, { timeoutMs: 25_000 });

  const t0 = Date.now();
  let manualFails = 0;
  while (Date.now() - t0 < manualTimeoutMs) {
    const st = await turnstileState(page);
    if (st.success || st.len > 20) {
      steps.push({ step: "manual", ok: true });
      return { ok: true, via: "manual", steps };
    }
    if (st.failed) {
      manualFails++;
      if (manualFails === 1 || manualFails % 3 === 0) await reloadTurnstile(page);
    }
    const url = page.url();
    if (
      !/sign-up|sign_up|signup/i.test(url) &&
      /account|console|dashboard|home|welcome|grok/i.test(url)
    ) {
      steps.push({ step: "manual", ok: true, note: "nav" });
      return { ok: true, via: "manual-nav", steps };
    }
    await sleep(1000);
  }
  steps.push({ step: "manual", ok: false, manualFails });
  return { ok: false, via: "all-failed", steps };
}

export function printManualFailHelp() {}

// CLI
const args = process.argv.slice(2);
if (process.argv[1]?.includes("turnstile")) {
  const key = loadKey();
  if (args.includes("--status")) {
    console.log(await keyStatus(key));
  } else if (args.includes("--solve")) {
    const i = args.indexOf("--sitekey");
    const u = args.indexOf("--url");
    const sitekey = i >= 0 ? args[i + 1] : "0x4AAAAAAAhr9JGVDZbrZOo0";
    const url = u >= 0 ? args[u + 1] : "https://accounts.x.ai/sign-up";
    try {
      const t = await solveTurnstileToken({ sitekey, url, key });
      console.log(t);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  } else {
    console.log(`Turnstile paths:
  1) Extension (plan Discord/Free OK):  npm run grok
  2) Token API (cần plan paid):         node turnstile.mjs --solve --sitekey 0x… --url …
  3) Click tay trên Chrome USER / Playwright headed

  node turnstile.mjs --status`);
    if (key) console.log("\nkey status:");
    if (key) console.log(await keyStatus(key));
  }
}
