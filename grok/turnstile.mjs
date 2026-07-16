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

function isNavDestroyed(e) {
  const m = String(e?.message || e || "");
  return /Execution context was destroyed|Target closed|Session closed|frame was detached|navigat/i.test(
    m
  );
}

function urlLooksPostSignup(url) {
  const u = String(url || "");
  if (/sign-up|sign_up|signup/i.test(u)) return false;
  return /grok\.x\.ai|console\.x\.ai|accounts\.x\.ai\/(account|home)|\/chat|\/home|\/c\/|welcome/i.test(
    u
  );
}

export async function turnstileState(page) {
  // nav khỏi signup = captcha/reg xong — không evaluate
  try {
    const url = page.url();
    if (urlLooksPostSignup(url)) {
      return {
        token: "",
        len: 99,
        failed: false,
        hasWidget: false,
        success: true,
        submitReady: true,
        iframeOk: true,
        uiOk: true,
        boxOk: false,
        viaNav: true,
      };
    }
  } catch {
    /* */
  }

  try {
    return await page.evaluate(() => {
      const inputs = [
        ...document.querySelectorAll(
          'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
        ),
      ];
      const token =
        inputs.map((i) => i.value).find((v) => v && v.length > 20) || "";
      const text = document.body?.innerText || "";
      const failed =
        /Verification failed|Error:\s*Invalid|try again later/i.test(text);
      const iframes = [...document.querySelectorAll("iframe")];
      const hasWidget = iframes.some((f) =>
        /turnstile|challenges\.cloudflare/i.test(
          `${f.src || ""} ${f.title || ""} ${f.name || ""}`
        )
      );
      const iframeOk = iframes.some((f) => {
        const t = `${f.title || ""} ${f.getAttribute("aria-label") || ""} ${f.name || ""}`;
        return /success|verified|complete|passed|done|you are (a )?human/i.test(
          t
        );
      });
      const boxOk = [
        ...document.querySelectorAll(
          '[aria-checked="true"], input[type="checkbox"]:checked, .cf-turnstile[data-state="success"]'
        ),
      ].some((el) => {
        if (el.matches?.('input[type="checkbox"]') && el.checked) return true;
        if (el.getAttribute?.("aria-checked") === "true") return true;
        const st = el.getAttribute?.("data-state") || "";
        return /success|complete|done/i.test(st);
      });
      const uiOk =
        /Success!|Success\b|verified you are human|verification (complete|successful)|you('re| are) (a )?human/i.test(
          text
        );
      const submitReady = [...document.querySelectorAll("button")].some((b) => {
        const n = (b.innerText || b.textContent || "").trim();
        if (!/complete sign up|create account|sign up|continue|submit/i.test(n))
          return false;
        return !b.disabled && b.getAttribute("aria-disabled") !== "true";
      });
      const success =
        !failed && (token.length > 20 || iframeOk || uiOk || boxOk);
      return {
        token: token.slice(0, 32),
        len: token.length,
        failed,
        hasWidget,
        success,
        submitReady,
        iframeOk,
        uiOk,
        boxOk,
      };
    });
  } catch (e) {
    // navigate mid-evaluate (sau Complete) → coi như OK nếu URL post-signup
    const url = (() => {
      try {
        return page.url();
      } catch {
        return "";
      }
    })();
    if (isNavDestroyed(e) || urlLooksPostSignup(url)) {
      return {
        token: "",
        len: 99,
        failed: false,
        hasWidget: false,
        success: true,
        submitReady: true,
        iframeOk: true,
        uiOk: true,
        boxOk: false,
        viaNav: true,
        navErr: String(e.message || e).slice(0, 80),
      };
    }
    return {
      token: "",
      len: 0,
      failed: false,
      hasWidget: false,
      success: false,
      submitReady: false,
      iframeOk: false,
      uiOk: false,
      boxOk: false,
      error: String(e.message || e).slice(0, 80),
    };
  }
}

/** Poll nhanh đến khi captcha OK. */
export async function waitTurnstileSolved(page, {
  timeoutMs = 60_000,
  pollMs = 80,
  requireToken = false,
} = {}) {
  const t0 = Date.now();
  let last = await turnstileState(page);
  while (Date.now() - t0 < timeoutMs) {
    last = await turnstileState(page);
    if (last.failed) return { ...last, ok: false, reason: "failed" };
    if (last.success) {
      if (!requireToken || last.len > 20)
        return { ...last, ok: true, reason: "solved" };
    }
    const url = page.url();
    if (
      !/sign-up|sign_up|signup/i.test(url) &&
      /account|console|dashboard|home|welcome|grok/i.test(url)
    ) {
      return { ...last, ok: true, reason: "nav" };
    }
    await sleep(pollMs);
  }
  return { ...last, ok: false, reason: "timeout" };
}

/** Chờ widget Turnstile xuất hiện (load xong) trước khi coi captcha. */
export async function waitTurnstileWidget(page, { timeoutMs = 30_000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await turnstileState(page);
    if (st.hasWidget || st.len > 20 || st.success) return st;
    await sleep(80);
  }
  return turnstileState(page);
}

/**
 * Scan checkbox/token OK → click Complete ngay (không sleep cứng).
 * settleMs: max chờ thêm sau success (mặc định 0 — click ngay khi nút enable).
 */
export async function clickSignupAfterCaptcha(page, {
  settleMs = 0,
  maxWaitMs = 45_000,
  pollMs = 80,
} = {}) {
  const patterns = [
    /complete sign up/i,
    /create (your )?account/i,
    /^continue$/i,
    /^submit$/i,
  ];

  async function findReadyBtn() {
    for (const re of patterns) {
      try {
        const loc = page.getByRole("button", { name: re });
        if (!(await loc.count().catch(() => 0))) continue;
        const b = loc.first();
        const dis = await b.isDisabled().catch(() => true);
        const vis = await b.isVisible().catch(() => false);
        if (!dis && vis) return b;
      } catch {
        /* nav */
      }
    }
    return null;
  }

  const t0 = Date.now();
  let sawSuccessAt = 0;
  while (Date.now() - t0 < maxWaitMs) {
    let st;
    try {
      st = await turnstileState(page);
    } catch (e) {
      if (isNavDestroyed(e) || urlLooksPostSignup(page.url?.() || ""))
        return { ok: true, reason: "nav-destroyed" };
      throw e;
    }
    // viaNav = đã rời signup. Token dài ≠ đã Complete — vẫn phải click.
    if (st.viaNav) return { ok: true, reason: "already-nav" };
    if (st.failed) return { ok: false, reason: "failed" };

    if (st.success || st.len > 20) {
      if (!sawSuccessAt) sawSuccessAt = Date.now();
      if (Date.now() - sawSuccessAt >= settleMs) {
        const btn = await findReadyBtn();
        if (btn) {
          try {
            await btn.click({ timeout: 8_000 });
          } catch (e) {
            if (isNavDestroyed(e)) return { ok: true, reason: "click-nav" };
          }
          const t1 = Date.now();
          while (Date.now() - t1 < 4_000) {
            let url = "";
            try {
              url = page.url();
            } catch {
              return { ok: true, reason: "clicked-nav" };
            }
            if (!/sign-up|sign_up|signup/i.test(url)) {
              return { ok: true, reason: "clicked-nav" };
            }
            const st2 = await turnstileState(page);
            if (st2.viaNav) return { ok: true, reason: "clicked-nav" };
            if (st2.failed) return { ok: false, reason: "failed-after-click" };
            await sleep(200);
          }
          return { ok: true, reason: "clicked" };
        }
      }
    } else {
      sawSuccessAt = 0;
    }

    if (st.success && st.submitReady) {
      const btn = await findReadyBtn();
      if (btn) {
        try {
          await btn.click({ timeout: 8_000 });
        } catch (e) {
          if (isNavDestroyed(e)) return { ok: true, reason: "click-nav" };
        }
        return { ok: true, reason: "clicked-ready" };
      }
    }

    await sleep(pollMs);
  }

  try {
    const st = await turnstileState(page);
    if (st.viaNav) return { ok: true, reason: "nav-late" };
    if (!st.success && st.len < 20) return { ok: false, reason: "no-token" };
    const btn = await findReadyBtn();
    if (!btn) return { ok: false, reason: "no-button" };
    await btn.click({ timeout: 8_000 });
    return { ok: true, reason: "clicked-late" };
  } catch (e) {
    if (isNavDestroyed(e)) return { ok: true, reason: "nav-late" };
    return { ok: false, reason: String(e.message || e).slice(0, 40) };
  }
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
      /turnstile|challenges\.cloudflare/i.test(f.src || f.title || "")
    );
    if (ifr) {
      const src = ifr.src;
      ifr.src = "";
      ifr.src = src.includes("#") ? src : src + "#r=" + Date.now();
    }
  });
  await sleep(600);
}

const CF_IFRAME_SEL =
  'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[title*="Widget containing a Cloudflare"], iframe[title*="cloudflare"], iframe[title*="Cloudflare"]';

/** Click checkbox trái widget (x≈26, giữa chiều cao). */
async function mouseClickIframeCheckbox(page, box) {
  if (!box || box.width < 10 || box.height < 10) return false;
  // challenge full-page: bỏ — chỉ widget checkbox (~300×65)
  if (box.width > 420 || box.height > 120) return false;
  const x = box.x + Math.min(28, Math.max(18, box.width * 0.12));
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 2 }).catch(() => {});
  await page.mouse.click(x, y, { delay: 30 });
  return true;
}

/**
 * Auto-click checkbox Turnstile.
 * Ưu tiên: mouse vào ô checkbox (trái iframe) → frameLocator → CDP.
 */
export async function clickTurnstileCheckbox(page, {
  timeoutMs = 2_500,
  force = true,
} = {}) {
  try {
    const st = await turnstileState(page);
    if (st.success || st.len > 20 || st.viaNav)
      return { ok: true, via: "already-ok" };
  } catch {
    /* */
  }

  // 1) mouse vào checkbox trái — ổn định nhất với CF cross-origin
  try {
    const ifr = page.locator(CF_IFRAME_SEL).first();
    await ifr.waitFor({ state: "visible", timeout: Math.min(1500, timeoutMs) }).catch(() => {});
    if ((await ifr.count().catch(() => 0)) > 0) {
      const box = await ifr.boundingBox().catch(() => null);
      if (await mouseClickIframeCheckbox(page, box)) {
        return { ok: true, via: "mouse-checkbox" };
      }
      // widget to hơn: thử góc trái giữa
      if (box && box.width > 10) {
        await page.mouse.click(box.x + 26, box.y + Math.min(box.height / 2, 40), {
          delay: 20,
        });
        return { ok: true, via: "mouse-left" };
      }
    }
  } catch {
    /* */
  }

  // 2) host checkbox
  try {
    const host = page.locator(
      '.cf-turnstile input[type="checkbox"], [data-sitekey] input[type="checkbox"], .cf-turnstile [role="checkbox"]'
    );
    if ((await host.count().catch(() => 0)) > 0) {
      const el = host.first();
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: timeoutMs, force });
        return { ok: true, via: "host-checkbox" };
      }
    }
  } catch {
    /* */
  }

  // 3) frameLocator / frames
  const frames = page.frames().filter((f) => {
    try {
      return /challenges\.cloudflare|turnstile|cdn-cgi\/challenge/i.test(f.url() || "");
    } catch {
      return false;
    }
  });
  const flocs = [page.frameLocator(CF_IFRAME_SEL).first(), ...frames];
  const targets = [
    'input[type="checkbox"]',
    'label.cb-lb',
    ".cb-lb",
    ".ctp-checkbox-label",
    '[role="checkbox"]',
    "#challenge-stage input",
    "#challenge-stage",
  ];
  for (const fl of flocs) {
    if (typeof fl?.locator !== "function") continue;
    for (const sel of targets) {
      try {
        const loc = fl.locator(sel).first();
        if (!(await loc.count().catch(() => 0))) continue;
        await loc.click({ timeout: 800, force, delay: 20 });
        return { ok: true, via: `iframe:${sel}` };
      } catch {
        /* next */
      }
    }
  }

  // 4) CDP Input — bypass overlay
  try {
    const box = await page.locator(CF_IFRAME_SEL).first().boundingBox().catch(() => null);
    if (box && box.width > 10) {
      const x = box.x + 26;
      const y = box.y + box.height / 2;
      const cdp = await page.context().newCDPSession(page).catch(() => null);
      if (cdp) {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        await cdp.detach().catch(() => {});
        return { ok: true, via: "cdp-mouse" };
      }
    }
  } catch {
    /* */
  }

  return { ok: false, via: "no-target" };
}

/**
 * Poll + auto-click checkbox (cooldown ngắn) đến khi captcha OK.
 */
export async function waitAndClickTurnstile(page, {
  timeoutMs = 45_000,
  pollMs = 80,
  clickEveryMs = 900,
  maxClicks = 12,
  onClick,
} = {}) {
  const t0 = Date.now();
  let lastClick = 0;
  let clicks = 0;
  let last = await turnstileState(page);
  while (Date.now() - t0 < timeoutMs) {
    last = await turnstileState(page);
    if (last.failed) return { ...last, ok: false, reason: "failed", clicks };
    if (last.success) {
      if (last.len > 20 || last.iframeOk || last.uiOk || last.boxOk || last.viaNav)
        return { ...last, ok: true, reason: "solved", clicks };
      return { ...last, ok: true, reason: "ui-success", clicks };
    }
    try {
      const url = page.url();
      if (
        !/sign-up|sign_up|signup/i.test(url) &&
        /account|console|dashboard|home|welcome|grok/i.test(url)
      ) {
        return { ...last, ok: true, reason: "nav", clicks };
      }
    } catch {
      /* */
    }

    const now = Date.now();
    // click ngay lần đầu khi có widget; sau đó cooldown ngắn
    if (
      clicks < maxClicks &&
      now - lastClick >= (clicks === 0 ? 0 : clickEveryMs) &&
      (last.hasWidget || clicks === 0)
    ) {
      const r = await clickTurnstileCheckbox(page);
      lastClick = now;
      if (r.ok && r.via !== "already-ok") {
        clicks++;
        await onClick?.(r, clicks);
        // sau click: poll token gấp (CF thường set token 0.3–1.5s)
        const t1 = Date.now();
        while (Date.now() - t1 < 2_000) {
          last = await turnstileState(page);
          if (last.success || last.len > 20)
            return { ...last, ok: true, reason: "post-click", clicks };
          if (last.failed) break;
          await sleep(60);
        }
        continue;
      }
      if (r.via === "already-ok")
        return { ...last, ok: true, reason: "already-ok", clicks };
    }
    await sleep(pollMs);
  }
  return { ...last, ok: false, reason: "timeout", clicks };
}

export async function waitExtensionTurnstile(page, {
  timeoutMs = 25_000,
  onFailed,
  pollMs = 80,
  autoClick = true,
} = {}) {
  const t0 = Date.now();
  let failCount = 0;
  let noWidgetTicks = 0;
  let lastClick = 0;
  let clicks = 0;
  while (Date.now() - t0 < timeoutMs) {
    const st = await turnstileState(page);
    if (st.success && st.len > 20) return { ok: true, via: "token-field", clicks };
    if (st.success && (st.iframeOk || st.uiOk || st.boxOk))
      return { ok: true, via: "checkbox-ok", clicks };
    if (st.success) return { ok: true, via: "ui-success", clicks };
    if (!st.hasWidget && !st.len) {
      noWidgetTicks++;
      if (noWidgetTicks >= 20) return { ok: false, via: "no-widget", clicks }; // ~1.6s
    } else noWidgetTicks = 0;
    if (st.failed) {
      failCount++;
      if (failCount === 1 || failCount % 4 === 0) {
        await reloadTurnstile(page);
        lastClick = 0;
        await onFailed?.(failCount);
      }
    } else if (autoClick && st.hasWidget && clicks < 12) {
      const now = Date.now();
      if (now - lastClick >= (clicks === 0 ? 0 : 900)) {
        const r = await clickTurnstileCheckbox(page);
        lastClick = now;
        if (r.ok && r.via !== "already-ok") clicks++;
      }
    }
    await sleep(pollMs);
  }
  return { ok: false, via: "timeout", clicks };
}

export async function solveTurnstileWithFallback(page, {
  pageUrl,
  useExtension = true,
  tryTokenApi = true,
  manualTimeoutMs = 45_000,
  extTimeoutMs = 25_000,
  autoClick = true,
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

  // click checkbox ngay nếu widget đã có
  if (autoClick) {
    await waitTurnstileWidget(page, { timeoutMs: 8_000 });
    const ck = await clickTurnstileCheckbox(page);
    steps.push({ step: "auto-click", ok: ck.ok, via: ck.via });
    if (ck.ok) {
      const t1 = Date.now();
      while (Date.now() - t1 < 2_500) {
        const st = await turnstileState(page);
        if (st.success || st.len > 20) {
          steps.push({ step: "auto-click-done", ok: true });
          return { ok: true, via: `click:${ck.via}`, steps };
        }
        if (st.failed) break;
        await sleep(60);
      }
    }
  }

  if (useExtension) {
    let r = await waitExtensionTurnstile(page, {
      timeoutMs: extTimeoutMs,
      autoClick,
    });
    steps.push({ step: "extension", ok: r.ok, via: r.via, clicks: r.clicks });
    // fallback: fail/timeout → reload widget + wait ngắn
    if (!r.ok && r.via !== "no-widget") {
      await reloadTurnstile(page);
      if (autoClick) await clickTurnstileCheckbox(page);
      r = await waitExtensionTurnstile(page, {
        timeoutMs: Math.min(15_000, extTimeoutMs),
        autoClick,
      });
      steps.push({ step: "extension-retry", ok: r.ok, via: r.via, clicks: r.clicks });
    }
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

  await waitTurnstileWidget(page, { timeoutMs: 15_000 });

  // auto-click loop — poll nhanh + click cooldown ngắn
  if (autoClick) {
    const r = await waitAndClickTurnstile(page, {
      timeoutMs: manualTimeoutMs,
      pollMs: 80,
      clickEveryMs: 900,
      maxClicks: 12,
    });
    if (r.ok) {
      steps.push({ step: "auto-click-loop", ok: true, via: r.reason, clicks: r.clicks });
      return { ok: true, via: `click-loop:${r.reason}`, steps };
    }
    steps.push({ step: "auto-click-loop", ok: false, reason: r.reason, clicks: r.clicks });
  } else {
    const r = await waitTurnstileSolved(page, {
      timeoutMs: manualTimeoutMs,
      pollMs: 80,
    });
    if (r.ok) {
      steps.push({ step: "manual", ok: true, via: r.reason });
      return { ok: true, via: `manual:${r.reason}`, steps };
    }
    steps.push({
      step: "manual",
      ok: false,
      reason: r.failed ? "failed" : r.reason,
    });
  }
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
