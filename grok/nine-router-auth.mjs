/**
 * xAI device OAuth → 9router provider connection
 *
 * API (public, confirmed):
 *   POST https://auth.x.ai/oauth2/device/code
 *   POST https://auth.x.ai/oauth2/token  (grant_type=device_code)
 *   GET  https://auth.x.ai/.well-known/openid-configuration
 *
 * 9router local (port 20128, header x-9r-cli-token):
 *   POST /api/oauth/xai/exchange  { code: <JWT access_token> }  → access_token conn
 *   POST /api/providers           { provider, name, apiKey }     → apikey (console key only)
 *
 *   node nine-router-auth.mjs --device          # in device, print URL+code
 *   node nine-router-auth.mjs --device --poll   # wait authorize
 *   node nine-router-auth.mjs --push TOKEN_JSON # push tokens → 9router
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dir = dirname(fileURLToPath(import.meta.url));

/** Acc vừa reg — grok-latest.json */
export function loadLatestGrokAcc() {
  const p = join(__dir, "acc", "grok-latest.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// Grok CLI / 9router public client (open-sse registry xai.js)
export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_SCOPE =
  "openid profile email offline_access grok-cli:access api:access";
export const XAI_DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
export const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_UA = "grok-cli/9router";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadGrokConfig() {
  const p = join(__dir, "config.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

export function nineRouterDefaults(cfg = loadGrokConfig()) {
  const n = cfg.nineRouter || cfg.ninerouter || {};
  return {
    enabled: n.autoAuth === true || n.enabled === true || cfg.autoAuth9router === true,
    baseUrl: String(n.baseUrl || process.env.NINEROUTER_URL || "http://127.0.0.1:20128").replace(
      /\/$/,
      ""
    ),
    dataDir:
      n.dataDir ||
      process.env.NINEROUTER_DATA ||
      (process.platform === "win32"
        ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "9router")
        : join(homedir(), ".9router")),
    // list Grok Build = provider grok-cli (device OAuth). KHÔNG dùng xai (API key / JWT rác).
    provider: n.provider || "grok-cli",
    namePrefix: n.namePrefix || "edu-auto",
  };
}

/** 9router CLI token = sha256(machineId + "9r-cli-auth" + cli-secret).slice(0,16) */
export function getNineRouterCliToken(dataDir) {
  const midPath = join(dataDir, "machine-id");
  const secPath = join(dataDir, "auth", "cli-secret");
  if (!existsSync(midPath) || !existsSync(secPath)) return "";
  const mid = readFileSync(midPath, "utf8").trim();
  const sec = readFileSync(secPath, "utf8").trim();
  if (!mid || !sec) return "";
  return createHash("sha256")
    .update(mid + "9r-cli-auth" + sec)
    .digest("hex")
    .slice(0, 16);
}

export async function nineRouterFetch(baseUrl, path, { method = "GET", body, token } = {}) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  if (token) headers["x-9r-cli-token"] = token;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { ok: res.ok, status: res.status, json, text };
}

/** RFC 8628 — request device code */
export async function requestDeviceCode({
  clientId = XAI_CLIENT_ID,
  scope = XAI_SCOPE,
} = {}) {
  const body = new URLSearchParams({
    client_id: clientId,
    scope,
  });
  const res = await fetch(XAI_DEVICE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": XAI_UA,
    },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.device_code) {
    throw new Error(
      `device/code ${res.status}: ${data.error || JSON.stringify(data).slice(0, 200)}`
    );
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete:
      data.verification_uri_complete ||
      `${data.verification_uri}?user_code=${encodeURIComponent(data.user_code)}`,
    expiresIn: data.expires_in || 1800,
    interval: Math.max(3, data.interval || 5),
  };
}

/** Poll token until authorized / expired */
export async function pollDeviceToken(device, {
  clientId = XAI_CLIENT_ID,
  timeoutMs,
  onTick,
  signal,
} = {}) {
  const limit = timeoutMs || (device.expiresIn || 1800) * 1000;
  const t0 = Date.now();
  let interval = (device.interval || 5) * 1000;
  while (Date.now() - t0 < limit) {
    if (signal?.aborted) throw new Error("aborted");
    await sleep(interval);
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.deviceCode,
      client_id: clientId,
    });
    const res = await fetch(XAI_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": XAI_UA,
      },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (data.access_token) {
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || null,
        expiresIn: data.expires_in || null,
        scope: data.scope || null,
        idToken: data.id_token || null,
        tokenType: data.token_type || "Bearer",
        raw: data,
      };
    }
    const err = data.error || "";
    onTick?.({ error: err, status: res.status });
    if (err === "slow_down") {
      interval += 2000;
      continue;
    }
    if (err === "authorization_pending") continue;
    if (err === "expired_token" || err === "access_denied") {
      throw new Error(`device auth ${err}`);
    }
    if (!res.ok && err) throw new Error(`token poll: ${err} ${data.error_description || ""}`);
  }
  throw new Error("device auth timeout");
}

export function emailFromIdToken(idToken) {
  if (!idToken || typeof idToken !== "string") return null;
  try {
    const b64 = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const p = JSON.parse(Buffer.from(pad, "base64").toString("utf8"));
    return p.email || null;
  } catch {
    return null;
  }
}

/**
 * Device code qua 9router (provider=grok-cli).
 * 9router tự poll xAI + tạo connection oauth đúng list Grok Build.
 * KHÔNG dùng POST /oauth/xai/exchange JWT — tạo xai/access_token Account N (email null).
 */
export async function requestNineRouterDeviceCode(opts = {}) {
  const cfg = nineRouterDefaults(opts.cfg || loadGrokConfig());
  const baseUrl = opts.baseUrl || cfg.baseUrl;
  const dataDir = opts.dataDir || cfg.dataDir;
  const token = opts.cliToken || getNineRouterCliToken(dataDir);
  const provider = opts.provider || cfg.provider || "grok-cli";
  if (!token) {
    throw new Error(
      `9router cli token missing — mở 9router app 1 lần (cần ${join(dataDir, "auth/cli-secret")})`
    );
  }
  const r = await nineRouterFetch(baseUrl, `/api/oauth/${provider}/device-code`, {
    method: "GET",
    token,
  });
  const d = r.json || {};
  if (!r.ok || !d.device_code) {
    throw new Error(
      `9r device-code ${r.status}: ${d.error || JSON.stringify(d).slice(0, 200)}`
    );
  }
  return {
    provider,
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUri: d.verification_uri,
    verificationUriComplete:
      d.verification_uri_complete ||
      `${d.verification_uri}?user_code=${encodeURIComponent(d.user_code || "")}`,
    expiresIn: d.expires_in || 1800,
    interval: Math.max(3, d.interval || 5),
    codeVerifier: d.codeVerifier || null,
    extraData: d.extraData || d,
    raw: d,
  };
}

/** Poll 9router đến khi connection oauth (grok-cli) được tạo. */
export async function pollNineRouterDevice(device, opts = {}) {
  const cfg = nineRouterDefaults(opts.cfg || loadGrokConfig());
  const baseUrl = opts.baseUrl || cfg.baseUrl;
  const dataDir = opts.dataDir || cfg.dataDir;
  const token = opts.cliToken || getNineRouterCliToken(dataDir);
  const provider = device.provider || cfg.provider || "grok-cli";
  if (!token) throw new Error("9router cli token missing");

  const limit = opts.timeoutMs || (device.expiresIn || 1800) * 1000;
  const t0 = Date.now();
  let interval = (device.interval || 5) * 1000;
  while (Date.now() - t0 < limit) {
    if (opts.signal?.aborted) throw new Error("aborted");
    await sleep(interval);
    const r = await nineRouterFetch(baseUrl, `/api/oauth/${provider}/poll`, {
      method: "POST",
      token,
      body: {
        deviceCode: device.deviceCode,
        codeVerifier: device.codeVerifier,
        extraData: device.extraData || device.raw,
      },
    });
    const j = r.json || {};
    opts.onTick?.({ status: r.status, json: j });

    // success: connection created
    if (r.ok && (j.success || j.connection || j.data?.connection)) {
      const conn = j.connection || j.data?.connection || j.data || j;
      return { ok: true, connection: conn, email: conn?.email || null, raw: j };
    }
    const err = j.error || j.message || "";
    const pending =
      j.pending === true ||
      err === "authorization_pending" ||
      err === "slow_down" ||
      /pending|slow.?down|waiting/i.test(err);
    if (err === "slow_down") {
      interval += 2000;
      continue;
    }
    if (pending) continue;
    if (!r.ok && err) throw new Error(`9r poll: ${err}`);
  }
  throw new Error("9r device poll timeout");
}

/** Lưu token local (backup). Không dùng exchange JWT → xai Account N. */
export async function pushTokensToNineRouter(tokens, opts = {}) {
  const cfg = nineRouterDefaults(opts.cfg || loadGrokConfig());
  const email =
    opts.email || emailFromIdToken(tokens.idToken) || opts.fallbackEmail || null;
  const name =
    opts.name ||
    `${cfg.namePrefix || "edu"}-${(email || "acc").split("@")[0]}-${Date.now().toString(36).slice(-4)}`;

  const outDir = join(__dir, "acc");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `xai-oauth-${Date.now()}.json`);
  const payload = {
    provider: "grok-cli",
    authType: "oauth",
    email,
    name,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    expiresAt: tokens.expiresIn
      ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
      : null,
    idToken: tokens.idToken,
    scope: tokens.scope,
    at: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(payload, null, 2));
  writeFileSync(join(outDir, "xai-oauth-latest.json"), JSON.stringify(payload, null, 2));

  // chỉ apikey thật (console key xai-…) khi user ép
  if (opts.asApiKey && tokens.accessToken && !String(tokens.accessToken).startsWith("eyJ")) {
    const baseUrl = opts.baseUrl || cfg.baseUrl;
    const dataDir = opts.dataDir || cfg.dataDir;
    const token = opts.cliToken || getNineRouterCliToken(dataDir);
    if (token) {
      const r = await nineRouterFetch(baseUrl, "/api/providers", {
        method: "POST",
        token,
        body: {
          provider: "xai",
          name,
          apiKey: tokens.accessToken,
          testStatus: "active",
        },
      });
      if (r.ok && r.json?.connection) {
        return { ok: true, via: "apikey", connection: r.json.connection, email, file };
      }
    }
  }

  return {
    ok: false,
    via: "file-only",
    file,
    email,
    hint: "Dùng device-code+poll grok-cli (autoAuth). File backup only.",
  };
}

/**
 * Snapshot UI device-auth — khớp URL/UI thật xAI:
 *   /oauth2/device?user_code=…     → enter code + Continue
 *   /oauth2/device/consent?…       → Authorize Grok Build + Allow|Deny
 *   /oauth2/device/done            → Device Authorized
 *   /sign-in?redirect=…user_code…  → Login with email|Google|X|Apple
 */
async function detectDeviceStep(page) {
  try {
    return await page.evaluate(() => {
      const text = (document.body?.innerText || "").slice(0, 8000);
      const lower = text.toLowerCase();
      const url = location.href;
      const path = location.pathname || "";
      const visible = (el) => {
        if (!el) return false;
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden") return false;
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      const inputs = [...document.querySelectorAll("input")].filter(visible);
      const buttons = [
        ...document.querySelectorAll("button,[role='button'],a"),
      ].filter(visible);
      const labels = buttons.map((b) =>
        (b.innerText || b.textContent || b.getAttribute("aria-label") || "").trim()
      );

      const hasEmail = inputs.some(
        (i) =>
          i.type === "email" ||
          /email/i.test(i.name + i.id + i.autocomplete + i.placeholder)
      );
      const hasPassword = inputs.some((i) => i.type === "password");
      const codeInputs = inputs.filter((i) => {
        if (i.type === "password" || i.type === "email" || i.type === "hidden")
          return false;
        const m = `${i.name} ${i.id} ${i.placeholder} ${i.autocomplete}`;
        return (
          /code|user.?code|device/i.test(m) ||
          i.type === "text" ||
          !i.type
        );
      });
      const hasCodeField = codeInputs.length > 0;
      const hasAllow = labels.some((t) => /^allow$/i.test(t));
      const hasDeny = labels.some((t) => /^deny$/i.test(t));
      const hasLoginEmail = labels.some((t) =>
        /login with email|sign in with email/i.test(t)
      );
      const hasContinue = labels.some((t) => /^continue$/i.test(t));

      // URL hard signals (screenshot-backed)
      const urlDone = /\/oauth2\/device\/done/i.test(path);
      const urlConsent = /\/oauth2\/device\/consent/i.test(path);
      const urlDevice =
        /\/oauth2\/device\/?$/i.test(path) ||
        (/\/oauth2\/device/i.test(path) && !urlConsent && !urlDone);
      const urlSignIn = /\/sign-in/i.test(path);

      const success =
        urlDone ||
        /device authorized|your device has been authorized|return to your terminal|you can close this window/i.test(
          lower
        );
      const consent =
        urlConsent ||
        (/authorize grok build/i.test(lower) && (hasAllow || hasDeny)) ||
        (/verify your identity|read your profile|read your email|use the xai api|make authenticated requests from grok build/i.test(
          lower
        ) &&
          hasAllow);
      const enterCode =
        (urlDevice && hasCodeField) ||
        /sign in to grok build|enter (the )?code|user code/i.test(lower) ||
        (hasCodeField && hasContinue && !consent);
      const loginChooser =
        urlSignIn ||
        (/log into your account|log in to your account/i.test(lower) &&
          (hasLoginEmail ||
            labels.some((t) => /login with (google|x|apple)/i.test(t))));
      const loginEmailForm =
        (hasEmail || hasPassword) &&
        /sign in|log in|email/i.test(lower) &&
        !consent &&
        !loginChooser;

      let step = "unknown";
      if (success) step = "success";
      else if (consent) step = "consent";
      else if (loginChooser) step = "login-chooser";
      else if (loginEmailForm) step = "login-email";
      else if (enterCode) step = "code";
      else if (urlDevice) step = "code";
      else if (urlSignIn) step = "login-chooser";

      return {
        step,
        url: url.slice(0, 140),
        path,
        hasEmail,
        hasPassword,
        hasCodeField,
        hasAllow,
        hasDeny,
        hasLoginEmail,
        hasContinue,
        labels: labels.filter(Boolean).slice(0, 14),
        snippet: text.slice(0, 140).replace(/\s+/g, " "),
      };
    });
  } catch (e) {
    return { step: "unknown", error: e.message };
  }
}

async function clickRole(page, patterns, { log, tag } = {}) {
  for (const re of patterns) {
    for (const role of ["button", "link"]) {
      const loc = page.getByRole(role, { name: re });
      const n = await loc.count().catch(() => 0);
      if (!n) continue;
      const b = loc.first();
      const dis = await b.isDisabled().catch(() => true);
      const vis = await b.isVisible().catch(() => false);
      if (dis || !vis) continue;
      log?.(`[9r] click ${tag || re} (${role})`);
      await b.click({ timeout: 8_000 }).catch(() => {});
      await sleep(900);
      return true;
    }
  }
  // fallback: text match visible buttons
  try {
    const hit = await page.evaluate((res) => {
      const list = [...document.querySelectorAll("button,[role='button'],a")];
      for (const el of list) {
        const t = (el.innerText || el.textContent || "").trim();
        if (!t) continue;
        for (const src of res) {
          const re = new RegExp(src, "i");
          if (re.test(t)) {
            const s = getComputedStyle(el);
            if (s.display === "none" || el.disabled) continue;
            el.click();
            return t.slice(0, 40);
          }
        }
      }
      return null;
    }, patterns.map((p) => (p instanceof RegExp ? p.source : String(p))));
    if (hit) {
      log?.(`[9r] click DOM "${hit}"`);
      await sleep(900);
      return true;
    }
  } catch {
    /* */
  }
  return false;
}

async function fillUserCode(page, userCode, log) {
  const raw = String(userCode || "").trim();
  const compact = raw.replace(/\s/g, "");
  // selectors ưu tiên
  const sels = [
    'input[name*="user_code" i]',
    'input[name*="usercode" i]',
    'input[name*="code" i]',
    'input[id*="code" i]',
    'input[placeholder*="code" i]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="text"]',
    'input[type="text"]',
    "form input:not([type=password]):not([type=email]):not([type=hidden])",
  ];
  for (const sel of sels) {
    const loc = page.locator(sel).first();
    if (!(await loc.count().catch(() => 0))) continue;
    const vis = await loc.isVisible().catch(() => false);
    if (!vis) continue;
    try {
      await loc.click({ timeout: 3000 });
      await loc.fill("");
      await loc.fill(compact);
      const v = await loc.inputValue().catch(() => "");
      if (v && v.replace(/-/g, "").length >= 4) {
        log(`[9r] filled code via ${sel} → ${v}`);
        return true;
      }
      // type chậm nếu fill hỏng (mask XXXX-XXXX)
      await loc.click();
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.type(compact, { delay: 40 });
      log(`[9r] typed code ${compact}`);
      return true;
    } catch {
      /* next */
    }
  }
  log("[9r] no code input — URL có thể đã prefill");
  return false;
}

/** React-safe fill — clear + native setter + verify (tránh pass sai/dính). */
async function fillReactInput(page, loc, value) {
  const want = String(value ?? "").trim();
  await loc.click({ timeout: 4000 }).catch(() => {});
  await loc.evaluate((el, v) => {
    el.focus();
    const proto =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    const set = (x) => {
      if (desc?.set) desc.set.call(el, x);
      else el.value = x;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    set("");
    set(v);
  }, want);
  let got = await loc.inputValue().catch(() => "");
  if (got !== want) {
    await loc.click().catch(() => {});
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.type(want, { delay: 28 });
    got = await loc.inputValue().catch(() => "");
  }
  // password: so length nếu value che
  if (got !== want) {
    const len = await loc.evaluate((el) => (el.value || "").length).catch(() => -1);
    if (len === want.length) return true;
  }
  return got === want;
}

/** Login email xAI (multi màn: email → Continue → password → Sign in). */
async function fillXaiEmailLogin(page, email, password, log) {
  email = String(email || "").trim();
  password = String(password || ""); // giữ nguyên ký tự, chỉ trim email
  if (!email || !password) {
    log("[9r] thiếu email/password — không login được");
    return false;
  }
  log(`[9r] login as ${email} passLen=${password.length}`);

  // email
  let emailOk = false;
  for (const sel of [
    'input[type="email"]',
    'input[name*="email" i]',
    'input[autocomplete="email"]',
    'input[autocomplete="username"]',
    'input[placeholder*="mail" i]',
  ]) {
    const em = page.locator(sel).first();
    if (!(await em.count().catch(() => 0))) continue;
    if (!(await em.isVisible().catch(() => false))) continue;
    emailOk = await fillReactInput(page, em, email);
    log(`[9r] email fill ${emailOk ? "OK" : "RETRY"} → ${email}`);
    if (!emailOk) {
      await em.fill("").catch(() => {});
      await page.keyboard.type(email, { delay: 20 });
    }
    break;
  }
  await clickRole(
    page,
    [/^continue$/i, /^next$/i, /^sign in$/i, /^log in$/i],
    { log, tag: "login→continue" }
  );
  await sleep(1200);

  // password màn 2 — CHỈ input type=password visible
  for (let i = 0; i < 10; i++) {
    const pw = page.locator('input[type="password"]:visible').first();
    const n = await pw.count().catch(() => 0);
    if (n && (await pw.isVisible().catch(() => false))) {
      const ok = await fillReactInput(page, pw, password);
      const len = await pw
        .evaluate((el) => (el.value || "").length)
        .catch(() => -1);
      log(
        `[9r] password fill ${ok ? "OK" : "?"} len=${len}/${password.length}`
      );
      if (len !== password.length) {
        // type lại sạch
        await pw.click().catch(() => {});
        await page.keyboard.press("Control+A").catch(() => {});
        await page.keyboard.press("Backspace").catch(() => {});
        await page.keyboard.type(password, { delay: 30 });
        const len2 = await pw
          .evaluate((el) => (el.value || "").length)
          .catch(() => -1);
        log(`[9r] password retype len=${len2}/${password.length}`);
      }
      await clickRole(
        page,
        [/^continue$/i, /^sign in$/i, /^log in$/i, /^next$/i, /^submit$/i],
        { log, tag: "login→submit" }
      );
      await sleep(1500);
      // wrong password banner?
      const bad = await page
        .evaluate(() =>
          /incorrect|wrong password|invalid (email|password)|couldn't sign|try again/i.test(
            document.body?.innerText || ""
          )
        )
        .catch(() => false);
      if (bad) {
        log("[9r] UI báo pass sai — đã fill đúng length? kiểm tra latest.json");
        return false;
      }
      return true;
    }
    await sleep(400);
  }
  log("[9r] không thấy ô password");
  return false;
}

/**
 * Multi-step theo screenshot xAI:
 *   code → Continue
 *   [đã login] → /consent → Allow → /done
 *   [chưa login] → sign-in → Login with email → email/pass (latest.json) → consent → Allow
 * KHÔNG logout / xóa cookie — cần session acc vừa reg.
 */
export async function authorizeDeviceInBrowser(
  page,
  device,
  { log = console.log, timeoutMs = 180_000, email, password } = {}
) {
  // bổ sung từ latest nếu thiếu
  if (!email || !password) {
    const latest = loadLatestGrokAcc();
    if (latest) {
      email = email || latest.email;
      password =
        password || latest.grokPassword || latest.eduPassword || latest.password;
      log(
        `[9r] acc từ latest.json: ${email || "?"} pass=${password ? "yes" : "no"}`
      );
    }
  }

  const url = device.verificationUriComplete;
  log(`[9r] device multi-step code=${device.userCode} as=${email || "?"}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(1200);

  await clickRole(
    page,
    [/accept all cookies/i, /accept all/i, /reject all/i],
    { log, tag: "cookie" }
  );

  let codeFilled = false;
  let lastPrimaryAt = 0;
  let lastStep = "";
  const t0 = Date.now();
  const throttle = (ms = 3500) => {
    if (Date.now() - lastPrimaryAt < ms) return false;
    lastPrimaryAt = Date.now();
    return true;
  };

  while (Date.now() - t0 < timeoutMs) {
    // URL fast-path (ổn định hơn DOM)
    const href = page.url();
    if (/\/oauth2\/device\/done/i.test(href)) {
      log("[9r] URL /device/done → Device Authorized");
      return { ok: true, step: "done-url" };
    }

    const d = await detectDeviceStep(page);
    if (d.step !== lastStep) {
      log(
        `[9r] step=${d.step} path=${(d.path || "").slice(0, 40)} btns=[${(d.labels || []).slice(0, 6).join(" | ")}]`
      );
      lastStep = d.step;
    }

    // ── /done ──
    if (d.step === "success") {
      log("[9r] Device Authorized");
      return { ok: true, step: "success" };
    }

    // ── /consent: Allow (primary đen) — KHÔNG bấm Deny ──
    if (d.step === "consent") {
      if (throttle(2500)) {
        // chỉ Allow — exact match trước
        let ok = await clickRole(page, [/^allow$/i], {
          log,
          tag: "consent→Allow",
        });
        if (!ok) {
          // fallback DOM: button đen Allow
          ok = await page.evaluate(() => {
            const btns = [...document.querySelectorAll("button")];
            const allow = btns.find((b) =>
              /^allow$/i.test((b.innerText || "").trim())
            );
            if (allow && !allow.disabled) {
              allow.click();
              return true;
            }
            return false;
          });
          if (ok) log("[9r] click Allow (DOM)");
        }
        if (ok) await sleep(1500);
      }
      continue;
    }

    // ── chưa login: Login with email (dùng acc latest) — KHÔNG Google/X ──
    if (d.step === "login-chooser") {
      if (!email || !password) {
        log("[9r] login-chooser nhưng thiếu email/pass (latest.json?)");
      }
      if (throttle(2800)) {
        await clickRole(
          page,
          [/^login with email$/i, /login with email|sign in with email/i],
          { log, tag: "chooser→Login with email" }
        );
      }
      await sleep(900);
      continue;
    }

    // ── form email → Continue → password → Sign in ──
    if (d.step === "login-email") {
      const okLogin = await fillXaiEmailLogin(page, email, password, log);
      if (okLogin) await sleep(1200);
      else if (throttle(2500)) {
        // partial: chỉ email/pass từng bước
        if (email) {
          const em = page
            .locator(
              'input[type="email"], input[name*="email" i], input[autocomplete="email"]'
            )
            .first();
          if (await em.count()) {
            await em.fill(email).catch(() => {});
            log(`[9r] login email: ${email}`);
          }
        }
        await clickRole(
          page,
          [/^continue$/i, /^next$/i, /^sign in$/i, /^log in$/i],
          { log, tag: "login-email→go" }
        );
        await sleep(800);
        if (password) {
          const pw = page.locator('input[type="password"]:visible').first();
          if ((await pw.count()) && (await pw.isVisible().catch(() => false))) {
            await fillReactInput(page, pw, password);
            log("[9r] login password filled (react)");
            await clickRole(
              page,
              [/^continue$/i, /^sign in$/i, /^log in$/i, /^next$/i],
              { log, tag: "login-pass→go" }
            );
          }
        }
      }
      continue;
    }

    // ── enter user code + Continue (đã login → consent; chưa → sign-in) ──
    if (d.step === "code") {
      if (!codeFilled || d.hasCodeField) {
        const filled = await fillUserCode(page, device.userCode, log);
        if (filled) codeFilled = true;
        await sleep(350);
      }
      if (throttle(3000)) {
        await clickRole(page, [/^continue$/i, /^next$/i, /^submit$/i], {
          log,
          tag: "code→Continue",
        });
      }
      await sleep(900);
      // sau Continue: nếu sign-in → login ngay bằng latest
      const href2 = page.url();
      if (/\/sign-in/i.test(href2) && email && password) {
        log("[9r] sau Continue → sign-in — login bằng latest acc");
        await clickRole(
          page,
          [/^login with email$/i, /login with email/i],
          { log, tag: "post-continue→email" }
        );
        await sleep(600);
        await fillXaiEmailLogin(page, email, password, log);
      }
      continue;
    }

    // ── unknown: theo URL ──
    if (/\/oauth2\/device\/consent/i.test(href)) {
      if (throttle(2500)) {
        await clickRole(page, [/^allow$/i], { log, tag: "url-consent→Allow" });
      }
    } else if (/\/sign-in/i.test(href)) {
      if (throttle(3000)) {
        await clickRole(page, [/^login with email$/i], {
          log,
          tag: "url-signin→email",
        });
      }
    } else if (/\/oauth2\/device/i.test(href) && !/\/done/i.test(href)) {
      if (!codeFilled) {
        codeFilled = await fillUserCode(page, device.userCode, log);
      }
      if (throttle(3000)) {
        await clickRole(page, [/^continue$/i, /^allow$/i], {
          log,
          tag: "url-device",
        });
      }
    }

    await sleep(600);
  }

  log("[9r] browser multi-step timeout — poll token vẫn chạy");
  return { ok: false, reason: "timeout", lastStep };
}

/**
 * Full: 9router device-code (grok-cli) → browser Allow → 9r poll → connection trong list.
 * page optional (user-chrome sau reg). Giữ session — không logout.
 */
export async function autoAuthNineRouter({
  page,
  email,
  password,
  cfg,
  log = console.log,
} = {}) {
  const n = nineRouterDefaults(cfg);
  if (!n.enabled && !cfg?.force) {
    return { ok: false, skipped: true, reason: "nineRouter.autoAuth=false" };
  }

  const latest = loadLatestGrokAcc();
  email = email || latest?.email;
  password =
    password ||
    latest?.grokPassword ||
    latest?.eduPassword ||
    latest?.password;

  log("[9r] grok-cli device OAuth (list Grok Build)…");
  log(`[9r] acc auth: ${email || "?"} pass=${password ? "set" : "MISSING"}`);
  if (!email || !password) {
    log("[9r] WARN: thiếu email/pass — nếu bị đá login sẽ fail");
  }

  // device code PHẢI từ 9router (có codeVerifier) — không gọi xAI trực tiếp rồi exchange JWT
  let device;
  try {
    device = await requestNineRouterDeviceCode({ cfg: { ...cfg, force: true } });
  } catch (e) {
    // slow_down → chờ 15s thử lại 1 lần
    log(`[9r] device-code fail: ${String(e.message || e).slice(0, 120)}`);
    if (/slow.?down|too many/i.test(String(e.message || e))) {
      log("[9r] rate limit — chờ 15s rồi thử lại…");
      await sleep(15_000);
      device = await requestNineRouterDeviceCode({ cfg: { ...cfg, force: true } });
    } else {
      throw e;
    }
  }
  log(`[9r] code ${device.userCode}`);
  log(`[9r] url  ${device.verificationUriComplete}`);

  let browserDone = Promise.resolve({ ok: false });
  if (page) {
    browserDone = authorizeDeviceInBrowser(page, device, {
      log,
      email,
      password,
      timeoutMs: 180_000,
    });
  } else {
    log("[9r] no page — mở URL tay rồi chờ poll");
  }

  // 9router poll = tự lấy token + ghi connection grok-cli oauth (có email)
  const polled = await pollNineRouterDevice(device, {
    cfg,
    timeoutMs: 180_000,
    onTick: (t) => {
      const err = t.json?.error || "";
      if (err === "authorization_pending" || t.json?.pending) process.stdout.write(".");
    },
  });
  console.log("");

  const br = await browserDone.catch((e) => ({ ok: false, error: e.message }));
  if (br?.ok) log(`[9r] browser done via=${br.step || "ok"}`);
  else log(`[9r] browser: ${br?.reason || br?.error || "pending/timeout"}`);

  const conn = polled.connection || {};
  const emailGuess = conn.email || email;
  log(
    `[9r] connection OK id=${conn.id || "?"} email=${emailGuess || "?"} provider=${conn.provider || "grok-cli"}`
  );

  // backup file (optional tokens không có từ poll response — chỉ conn)
  try {
    const outDir = join(__dir, "acc");
    mkdirSync(outDir, { recursive: true });
    const snap = {
      provider: "grok-cli",
      authType: "oauth",
      email: emailGuess,
      connectionId: conn.id,
      connection: conn,
      at: new Date().toISOString(),
    };
    writeFileSync(
      join(outDir, "xai-oauth-latest.json"),
      JSON.stringify(snap, null, 2)
    );
  } catch {
    /* */
  }

  const push = {
    ok: true,
    via: "grok-cli-device-poll",
    connection: conn,
    email: emailGuess,
  };
  log(`[9r] pushed via=${push.via} id=${conn.id || "?"}`);
  return { ok: true, device, push, email: emailGuess, connection: conn };
}

// CLI
const args = process.argv.slice(2);
if (process.argv[1]?.includes("nine-router-auth")) {
  const log = console.log;
  if (args.includes("--help") || args.length === 0) {
    console.log(`9router / xAI device OAuth

  Có API tạo device auth (không phải console API key):
    POST ${XAI_DEVICE_URL}
    client_id=${XAI_CLIENT_ID}

  9router local API key (gateway): POST /api/keys  { name }
  9router xAI connection: OAuth device / JWT exchange — không có "create oauth key" 1-shot public.

  node nine-router-auth.mjs --device
  node nine-router-auth.mjs --device --wait
  node nine-router-auth.mjs --ping          # test 9router cli token
  node nine-router-auth.mjs --push-latest  # push acc/xai-oauth-latest.json

config.json:
  "nineRouter": { "autoAuth": true, "baseUrl": "http://127.0.0.1:20128" }
`);
    process.exit(0);
  }
  if (args.includes("--ping")) {
    const n = nineRouterDefaults();
    const t = getNineRouterCliToken(n.dataDir);
    console.log("base", n.baseUrl);
    console.log("token", t ? t.slice(0, 6) + "…" : "(missing)");
    const r = await nineRouterFetch(n.baseUrl, "/api/providers", { token: t });
    console.log("providers", r.status, r.ok ? `n=${r.json?.connections?.length}` : r.json);
    process.exit(r.ok ? 0 : 1);
  }
  if (args.includes("--device")) {
    // luôn qua 9router grok-cli (list đúng) — không exchange JWT xai
    const d = await requestNineRouterDeviceCode({ cfg: loadGrokConfig() });
    console.log(JSON.stringify(d, null, 2));
    if (args.includes("--wait") || args.includes("--poll") || args.includes("--push")) {
      console.log("authorize at:", d.verificationUriComplete);
      const polled = await pollNineRouterDevice(d, {
        cfg: loadGrokConfig(),
        onTick: (t) => {
          if (t.json?.pending || t.json?.error === "authorization_pending")
            process.stdout.write(".");
        },
      });
      console.log("\n", {
        ok: true,
        id: polled.connection?.id,
        email: polled.connection?.email || polled.email,
        provider: polled.connection?.provider,
      });
      mkdirSync(join(__dir, "acc"), { recursive: true });
      writeFileSync(
        join(__dir, "acc", "xai-oauth-latest.json"),
        JSON.stringify(
          {
            provider: "grok-cli",
            connectionId: polled.connection?.id,
            connection: polled.connection,
            email: polled.connection?.email || polled.email,
            at: new Date().toISOString(),
          },
          null,
          2
        )
      );
    }
    process.exit(0);
  }
  if (args.includes("--push-latest")) {
    const p = join(__dir, "acc", "xai-oauth-latest.json");
    const j = JSON.parse(readFileSync(p, "utf8"));
    const tokens = {
      accessToken: j.accessToken || j.access_token,
      refreshToken: j.refreshToken || j.refresh_token,
      expiresIn: j.expiresIn || j.expires_in,
      idToken: j.idToken || j.id_token,
      scope: j.scope,
    };
    console.log(await pushTokensToNineRouter(tokens, { cfg: loadGrokConfig(), email: j.email }));
  }
}
