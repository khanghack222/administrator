/**
 * GetEduMail core API — shared by CLI + HTML server
 */
import { randomBytes } from "crypto";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export const API = "https://api.getedumail.com";
export const __dir = dirname(fileURLToPath(import.meta.url));
/** Folder acc gọn: acc/1.json, acc/2.json, … + acc/latest.json */
export const ACC_DIR = join(__dir, "acc");
export const LATEST_PATH = join(ACC_DIR, "latest.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const randUser = () =>
  randomBytes(8)
    .toString("base64url")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 10);
export const randPass = () => randomBytes(10).toString("base64url") + "A1!";

export function extractCode(raw) {
  const t = String(raw || "");
  const markers = [
    /letter-spacing:\s*8px[\s\S]{0,80}?([0-9]{6})/i,
    /Courier New[\s\S]{0,120}?([0-9]{6})/i,
    /font-size:\s*32px[\s\S]{0,80}?([0-9]{6})/i,
  ];
  for (const re of markers) {
    const m = t.match(re);
    if (m) return m[1];
  }
  const plain = t
    .replace(/\r\n/g, "\n")
    .replace(/=\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
  for (const re of markers) {
    const m = plain.match(re);
    if (m) return m[1];
  }
  return null;
}

export async function api(method, path, { token, body } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (token) headers.cookie = `userToken=${token}`;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, ok: res.ok, json, text };
}

/** Login → userToken (refresh JWT) */
export async function loginForToken(email, password) {
  if (!email || !password) return null;
  const r = await api("POST", "/getedumail/user/login", {
    body: { email, password },
  });
  if (!r.ok) return null;
  return r.json?.userToken || null;
}

/**
 * Token usable cho inbox list. Ưu tiên saved → login refresh → ghi lại acc nếu có id.
 */
export async function resolveToken({ email, password, userToken, id } = {}) {
  if (userToken) {
    const probe = await api(
      "GET",
      `/getedumail/emails/${encodeURIComponent(email)}/list?page=1`,
      { token: userToken }
    );
    if (probe.ok) return userToken;
  }
  const fresh = await loginForToken(email, password);
  if (!fresh) return userToken || null;
  if (id != null) {
    try {
      const p = join(ACC_DIR, `${id}.json`);
      if (existsSync(p)) {
        const d = JSON.parse(readFileSync(p, "utf8"));
        d.userToken = fresh;
        writeFileSync(p, JSON.stringify(slimAcc(d), null, 2));
        writeFileSync(LATEST_PATH, JSON.stringify(slimAcc(d), null, 2));
        writeFileSync(
          join(__dir, "getedumail-latest.json"),
          JSON.stringify(slimAcc(d), null, 2)
        );
      }
    } catch {
      /* */
    }
  }
  return fresh;
}

export async function waitCode(email, { tries = 40, onTick, token } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await api(
      "GET",
      `/getedumail/emails/${encodeURIComponent(email)}/list?page=1`,
      token ? { token } : undefined
    );
    const mails = r.json?.emails || [];
    if (mails.length) {
      const code = extractCode(mails[0].body?.text || "");
      if (code) return code;
    }
    onTick?.(i, mails.length);
    await sleep(1500);
  }
  throw new Error("Timeout: no verification code in inbox");
}

export function decodeQP(s) {
  return String(s || "")
    .replace(/\r\n/g, "\n")
    .replace(/=\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
}

export function htmlToText(html) {
  return decodeQP(html)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Inbox list — sau claim BẮT BUỘC userToken (guest = 403).
 * opts: { token, password, id } — password/id để auto-refresh JWT.
 */
export async function fetchInbox(email, page = 1, opts = {}) {
  let token = opts.token;
  if (!token && (opts.password || opts.id)) {
    token = await resolveToken({
      email,
      password: opts.password,
      userToken: opts.userToken,
      id: opts.id,
    });
  }
  let r = await api(
    "GET",
    `/getedumail/emails/${encodeURIComponent(email)}/list?page=${page}`,
    token ? { token } : undefined
  );
  // token hết hạn → login lại 1 lần
  if (r.status === 401 || r.status === 403) {
    if (opts.password) {
      token = await resolveToken({
        email,
        password: opts.password,
        userToken: null,
        id: opts.id,
      });
      if (token) {
        r = await api(
          "GET",
          `/getedumail/emails/${encodeURIComponent(email)}/list?page=${page}`,
          { token }
        );
      }
    }
  }
  if (!r.ok) throw new Error(`inbox ${r.status}: ${r.text}`);
  const emails = r.json?.emails || [];
  return {
    total: r.json?.total ?? emails.length,
    page,
    token,
    emails: emails.map((m, i) => ({
      index: i + 1,
      uid: m.uid ?? i + 1,
      subject: m.subject || "(no subject)",
      from:
        m.from?.[0]?.address ||
        m.from?.[0]?.name ||
        m.from ||
        "?",
      fromName: m.from?.[0]?.name || "",
      date: m.date || "",
      bodyRaw: m.body?.text || m.body?.html || "",
      preview: htmlToText(m.body?.text || m.body?.html || "").slice(0, 120),
    })),
  };
}

export async function fetchMailBody(email, uidOrIndex, opts = {}) {
  const box = await fetchInbox(email, 1, opts);
  const mail =
    box.emails.find((m) => String(m.uid) === String(uidOrIndex)) ||
    box.emails.find((m) => String(m.index) === String(uidOrIndex)) ||
    box.emails[Number(uidOrIndex) - 1];
  if (!mail) throw new Error("Không tìm thấy mail");
  return {
    ...mail,
    bodyText: htmlToText(mail.bodyRaw),
    codes: (htmlToText(mail.bodyRaw).match(/\b\d{4,8}\b/g) || []).slice(0, 10),
  };
}

/**
 * Smoke-test toàn bộ API flow (guest→reg→otp→list→verify→claim→inbox)
 * @returns {{ ok: boolean, steps: object[], email?: string, error?: string }}
 */
export async function testAllApi(opts = {}) {
  const domain = opts.domain || "warsawuni.edu.pl";
  const name = opts.name || "Api Test User";
  const password = opts.password || randPass();
  const username = "t" + randUser().slice(0, 9);
  const email = `${username}@${domain}`;
  const log = opts.log || (() => {});
  const steps = [];
  const push = (step, r, extra = {}) => {
    const row = {
      step,
      status: r?.status,
      ok: !!r?.ok,
      ms: extra.ms,
      note: extra.note || "",
      body: (r?.text || "").slice(0, 160),
    };
    steps.push(row);
    log(
      `${r?.ok ? "OK " : "FAIL"} ${String(r?.status).padStart(3)}  ${step}${extra.note ? " — " + extra.note : ""}`
    );
    return row;
  };

  const timed = async (label, fn) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      push(label, r, { ms: Date.now() - t0 });
      return r;
    } catch (e) {
      const r = { status: 0, ok: false, text: e.message, json: {} };
      push(label, r, { ms: Date.now() - t0, note: e.message });
      throw e;
    }
  };

  try {
    log(`\n── TEST ALL API ── ${email}`);

    // 1 availability
    await timed("GET  /emails/availability", () =>
      api(
        "GET",
        `/getedumail/emails/availability?email=${encodeURIComponent(email)}`
      )
    );

    // 2 guest
    let r = await timed("POST /emails/guest", () =>
      api("POST", "/getedumail/emails/guest", { body: { email } })
    );
    if (!r.ok) throw new Error("guest failed");
    const guestId = r.json.id;

    // 3 register
    r = await timed("POST /user/register", () =>
      api("POST", "/getedumail/user/register", {
        body: { name, email, password },
      })
    );
    if (!r.ok) throw new Error("register failed");
    let token = r.json.userToken;
    if (!token) throw new Error("no userToken");

    // 4 otp send (cookie auth)
    r = await timed("GET  /user/otp (send)", () =>
      api("GET", "/getedumail/user/otp", { token })
    );
    if (!r.ok) throw new Error("otp send failed");

    // 5 list poll
    log("… poll inbox for OTP");
    let code = null;
    let listR = null;
    for (let i = 0; i < 30 && !code; i++) {
      await sleep(1500);
      listR = await api(
        "GET",
        `/getedumail/emails/${encodeURIComponent(email)}/list?page=1`
      );
      const mails = listR.json?.emails || [];
      if (mails.length) {
        code = extractCode(mails[0].body?.text || "");
        if (code) break;
      }
      process.stdout.write(mails.length ? "m" : ".");
    }
    console.log("");
    push("GET  /emails/{email}/list", listR || { status: 0, ok: false, text: "no list" }, {
      note: code ? `code=${code}` : "no code",
    });
    if (!code) throw new Error("no OTP code");

    // 6 verify
    r = await timed("POST /user/verify-otp", () =>
      api("POST", "/getedumail/user/verify-otp", {
        token,
        body: { otp: code },
      })
    );
    if (!r.ok) {
      // retry numeric
      r = await timed("POST /user/verify-otp (num)", () =>
        api("POST", "/getedumail/user/verify-otp", {
          token,
          body: { otp: Number(code) },
        })
      );
    }
    if (!r.ok) throw new Error("verify-otp failed");
    if (r.json.userToken) token = r.json.userToken;

    // 7 claim
    r = await timed("POST /emails (claim)", () =>
      api("POST", "/getedumail/emails", { token, body: { email } })
    );
    if (!r.ok && r.status !== 201) {
      r = await timed("POST /emails/claim", () =>
        api("POST", "/getedumail/emails/claim", { token, body: { email } })
      );
    }
    if (!r.ok && r.status !== 201) throw new Error("claim failed");

    // 8 inbox after claim
    r = await timed("GET  /emails/{email}/list (after claim)", () =>
      api(
        "GET",
        `/getedumail/emails/${encodeURIComponent(email)}/list?page=1`
      )
    );

    // 9 optional: authenticated emails list
    r = await timed("GET  /emails (auth)", () =>
      api("GET", "/getedumail/emails", { token })
    );

    // 10 login check (re-register shape) — me endpoints
    for (const path of [
      "/getedumail/user",
      "/getedumail/user/me",
      "/getedumail/user/profile",
    ]) {
      r = await timed(`GET  ${path.replace("/getedumail", "")}`, () =>
        api("GET", path, { token })
      );
      if (r.ok) break;
    }

    const passed = steps.filter((s) => s.ok).length;
    const failed = steps.filter((s) => !s.ok).length;
    log(`\n── KẾT QUẢ: ${passed} OK / ${failed} FAIL / ${steps.length} steps ──`);
    log(`email=${email} guestId=${guestId} code=${code}`);

    // save test account
    const result = {
      ok: failed === 0,
      email,
      password,
      code,
      userToken: token,
      guestId,
      domain,
      testedAt: new Date().toISOString(),
      steps,
    };
    writeFileSync(
      join(__dir, "getedumail-api-test-last.json"),
      JSON.stringify(result, null, 2)
    );
    return result;
  } catch (e) {
    log(`[TEST STOP] ${e.message}`);
    const result = {
      ok: false,
      email,
      error: e.message,
      steps,
      testedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(__dir, "getedumail-api-test-last.json"),
      JSON.stringify(result, null, 2)
    );
    return result;
  }
}

/** Slim acc record (không cookieSnippet / rác) */
export function slimAcc(a) {
  if (!a) return null;
  return {
    email: a.email,
    password: a.password,
    fullName: a.fullName || a.name || "",
    userToken: a.userToken || "",
    domain: a.domain || (a.email || "").split("@")[1] || "",
    code: a.code || "",
    claimedAt: a.claimedAt || a.at || new Date().toISOString(),
    id: a.id,
  };
}

function ensureAccDir() {
  mkdirSync(ACC_DIR, { recursive: true });
}

/** Next free number: 1.json, 2.json, … */
export function nextAccId() {
  ensureAccDir();
  let max = 0;
  for (const f of readdirSync(ACC_DIR)) {
    const m = f.match(/^(\d+)\.json$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

export function listAccFiles() {
  ensureAccDir();
  return readdirSync(ACC_DIR)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => {
      const id = parseInt(f, 10);
      try {
        const d = slimAcc(JSON.parse(readFileSync(join(ACC_DIR, f), "utf8")));
        return { id, file: f, path: join(ACC_DIR, f), ...d };
      } catch {
        return { id, file: f, path: join(ACC_DIR, f), email: "?" };
      }
    })
    .sort((a, b) => b.id - a.id);
}

export function loadLatest() {
  // acc/latest.json → root getedumail-latest.json (legacy)
  for (const p of [LATEST_PATH, join(__dir, "getedumail-latest.json")]) {
    if (!existsSync(p)) continue;
    try {
      return slimAcc(JSON.parse(readFileSync(p, "utf8")));
    } catch {
      /* */
    }
  }
  const list = listAccFiles();
  return list[0] ? slimAcc(list[0]) : null;
}

export function loadAcc(id) {
  const p = join(ACC_DIR, `${id}.json`);
  if (!existsSync(p)) return null;
  return slimAcc(JSON.parse(readFileSync(p, "utf8")));
}

/** Lưu acc → acc/N.json + latest.json. Trả { id, path, acc } */
export function saveAccount(raw) {
  ensureAccDir();
  const id = nextAccId();
  const acc = slimAcc({ ...raw, id });
  acc.id = id;
  const path = join(ACC_DIR, `${id}.json`);
  writeFileSync(path, JSON.stringify(acc, null, 2));
  writeFileSync(LATEST_PATH, JSON.stringify(acc, null, 2));
  // alias root (bridge / script cũ)
  writeFileSync(join(__dir, "getedumail-latest.json"), JSON.stringify(acc, null, 2));
  return { id, path, acc };
}

/** Gộp getedumail-*.json cũ → acc/N.json, xóa file dài */
export function migrateOldAccounts(log = console.log) {
  ensureAccDir();
  const old = readdirSync(__dir).filter(
    (f) =>
      /^getedumail-.+\.json$/i.test(f) &&
      !/^getedumail-latest\.json$/i.test(f) &&
      !/^getedumail-api-test/i.test(f) &&
      !/^getedumail-batch/i.test(f)
  );
  let n = 0;
  const seen = new Set(
    listAccFiles().map((a) => (a.email || "").toLowerCase())
  );
  for (const f of old) {
    try {
      const d = JSON.parse(readFileSync(join(__dir, f), "utf8"));
      if (!d.email) continue;
      const key = String(d.email).toLowerCase();
      if (seen.has(key)) {
        unlinkSync(join(__dir, f));
        log(`[migrate] skip dup + del ${f}`);
        continue;
      }
      const { id } = saveAccount(d);
      seen.add(key);
      unlinkSync(join(__dir, f));
      log(`[migrate] ${f} → acc/${id}.json`);
      n++;
    } catch (e) {
      log(`[migrate] fail ${f}: ${e.message}`);
    }
  }
  // latest cũ
  const leg = join(__dir, "getedumail-latest.json");
  if (existsSync(leg)) {
    try {
      const d = slimAcc(JSON.parse(readFileSync(leg, "utf8")));
      if (d?.email && !seen.has(d.email.toLowerCase())) {
        saveAccount(d);
        n++;
      } else if (d?.email) {
        writeFileSync(LATEST_PATH, JSON.stringify(d, null, 2));
      }
    } catch {
      /* */
    }
  }
  return n;
}

/**
 * @param {object} opts
 * @param {string} [opts.domain]
 * @param {string} [opts.name]
 * @param {string} [opts.password]
 * @param {(msg:string)=>void} [opts.log]
 */
export async function createAccount(opts = {}) {
  const domain = opts.domain || "warsawuni.edu.pl";
  const fullName = opts.name || "Alex Kowalski";
  const username = opts.username || randUser();
  const email = `${username}@${domain}`;
  const password = opts.password || randPass();
  const log = opts.log || (() => {});

  log(`[1] Guest ${email}`);
  let r = await api("POST", "/getedumail/emails/guest", { body: { email } });
  if (!r.ok) throw new Error(`guest ${r.status}: ${r.text}`);
  const guestId = r.json.id;

  log(`[2] Register`);
  r = await api("POST", "/getedumail/user/register", {
    body: { name: fullName, email, password },
  });
  if (!r.ok) throw new Error(`register ${r.status}: ${r.text}`);
  let token = r.json.userToken;
  if (!token) throw new Error("no userToken");

  log(`[3] OTP send`);
  r = await api("GET", "/getedumail/user/otp", { token });
  if (!r.ok) throw new Error(`otp send ${r.status}: ${r.text}`);

  log(`[4] Wait code…`);
  const code = await waitCode(email, {
    token,
    onTick: (i) => log(`[4] polling ${i + 1}`),
  });
  log(`[4] Code ${code}`);

  log(`[5] Verify`);
  for (const otp of [code, Number(code)]) {
    r = await api("POST", "/getedumail/user/verify-otp", {
      token,
      body: { otp },
    });
    if (r.ok) break;
  }
  if (!r.ok) throw new Error(`verify-otp ${r.status}: ${r.text}`);
  if (r.json.userToken) token = r.json.userToken;
  log(`[5] Verified`);

  log(`[6] Claim`);
  const claimBodies = [
    { email },
    { username, domain },
    { email, username, domain },
  ];
  const claimPaths = [
    "/getedumail/emails/claim",
    "/getedumail/emails",
    "/getedumail/emails/create",
    "/getedumail/emails/custom",
  ];
  let claimed = null;
  for (const path of claimPaths) {
    for (const body of claimBodies) {
      r = await api("POST", path, { token, body });
      if (r.status === 404) continue;
      if (r.ok || r.status === 201) {
        claimed = { path, body, r };
        break;
      }
    }
    if (claimed) break;
  }
  if (!claimed) {
    log(`[6] API claim fail → browser`);
    const { claimBrowser } = await import("./getedumail-browser.mjs");
    await claimBrowser({ email, password });
    claimed = { path: "browser" };
  } else {
    log(`[6] Claimed via ${claimed.path}`);
  }

  const result = {
    ok: true,
    email,
    fullName,
    password,
    code,
    userToken: token,
    guestId,
    domain,
    claimedAt: new Date().toISOString(),
    claimPath: claimed.path,
  };

  const { id, path, acc } = saveAccount(result);
  log(`[saved] acc/${id}.json`);
  return { ...result, ...acc, id, path };
}
