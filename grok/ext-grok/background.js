/**
 * Step (chrome.storage — nhớ qua tab):
 *   idle → creating → countdown → edu_login → edu_inbox
 *        → xai_email → xai_wait_otp → xai_otp → xai_profile → xai_turnstile
 */
const API = "https://api.getedumail.com";
const BRIDGE = "http://127.0.0.1:3847";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NAMES = [
  "Szymon Jablonski",
  "Anna Kowalski",
  "Piotr Nowak",
  "Magdalena Wisniewski",
  "Tomasz Wojcik",
  "Katarzyna Kaminski",
  "Michal Lewandowski",
  "Agnieszka Zielinski",
];

function randUser() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => (b % 36).toString(36)).join("").slice(0, 10);
}
function randPass() {
  return "Gx" + randUser() + "A1!";
}
function splitName(full) {
  const p = String(full || "Alex Kowalski").trim().split(/\s+/);
  return { first: p[0] || "Alex", last: p.slice(1).join(" ") || "Kowalski" };
}
async function setState(patch) {
  await chrome.storage.local.set(patch);
}

async function api(method, path, { token, body } = {}) {
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
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, ok: res.ok, json, text };
}

function extractEduCode(raw) {
  const t = String(raw || "");
  return (
    (t.match(/letter-spacing:\s*8px[\s\S]{0,80}?([0-9]{6})/i) ||
      t.match(/\b([0-9]{6})\b/) ||
      [])[1] || null
  );
}
function extractXaiCode(text, subject = "") {
  const t = `${subject}\n${text || ""}`;
  return (
    (t.match(/\b([A-Z0-9]{2,4}-[A-Z0-9]{2,6})\b/) ||
      t.match(/\b(\d{6})\b/) ||
      [])[1] || null
  );
}
function htmlToText(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function createEduAccount({ domain = "warsawuni.edu.pl" } = {}) {
  const fullName = NAMES[Math.floor(Math.random() * NAMES.length)];
  const email = `${randUser()}@${domain}`;
  const password = randPass();

  await setState({ step: "creating", status: `[1] guest ${email}` });
  let r = await api("POST", "/getedumail/emails/guest", { body: { email } });
  if (!r.ok) throw new Error(`guest ${r.status}`);

  await setState({ status: "[2] register" });
  r = await api("POST", "/getedumail/user/register", {
    body: { name: fullName, email, password },
  });
  if (!r.ok) throw new Error(`register ${r.status}`);
  let token = r.json.userToken;
  if (!token) throw new Error("no userToken");

  await setState({ status: "[3] otp send" });
  r = await api("GET", "/getedumail/user/otp", { token });
  if (!r.ok) throw new Error(`otp send ${r.status}`);

  let code = null;
  for (let i = 0; i < 40 && !code; i++) {
    await setState({ status: `[4] edu OTP… ${i + 1}/40` });
    await sleep(1500);
    const list = await api(
      "GET",
      `/getedumail/emails/${encodeURIComponent(email)}/list?page=1`
    );
    if (list.json?.emails?.[0])
      code = extractEduCode(list.json.emails[0].body?.text || "");
  }
  if (!code) throw new Error("edu OTP timeout");

  await setState({ status: `[5] verify ${code}` });
  for (const otp of [code, Number(code)]) {
    r = await api("POST", "/getedumail/user/verify-otp", {
      token,
      body: { otp },
    });
    if (r.ok) break;
  }
  if (!r.ok) throw new Error(`verify ${r.status}`);
  if (r.json.userToken) token = r.json.userToken;

  await setState({ status: "[6] claim" });
  for (const path of ["/getedumail/emails", "/getedumail/emails/claim"]) {
    r = await api("POST", path, { token, body: { email } });
    if (r.ok || r.status === 201) break;
  }

  return {
    email,
    fullName,
    password,
    userToken: token,
    domain,
    at: new Date().toISOString(),
  };
}

async function pollXaiOtp(email, token, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await setState({ status: `xAI OTP… ${i + 1}/${tries}` });
    const r = await api(
      "GET",
      `/getedumail/emails/${encodeURIComponent(email)}/list?page=1`,
      { token }
    );
    for (const m of r.json?.emails || []) {
      const blob = `${m.subject || ""} ${JSON.stringify(m.from || "")}`;
      if (!/x\.ai|xai|confirmation|spacexai/i.test(blob)) continue;
      const code = extractXaiCode(
        htmlToText(m.body?.text || m.body?.html || ""),
        m.subject || ""
      );
      if (code) return code;
    }
    await sleep(2000);
  }
  throw new Error("xAI OTP timeout — xem tab edu inbox");
}

async function sendToTab(tabId, msg, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      await sleep(500);
    }
  }
  throw new Error("content script chưa sẵn sàng");
}

async function openTab(url, active = true) {
  return (await chrome.tabs.create({ url, active })).id;
}

async function countdown30(label) {
  const end = Date.now() + 30_000;
  await setState({ step: "countdown", countdownEnd: end, status: label });
  while (Date.now() < end) {
    const left = Math.ceil((end - Date.now()) / 1000);
    await setState({ status: `${label} — ${left}s` });
    await sleep(500);
  }
  await setState({ countdownEnd: 0 });
}

function sessionFromAcc(acc, extra = {}) {
  const { first, last } = splitName(acc.fullName);
  return {
    email: acc.email,
    password: acc.password,
    grokPass: acc.password,
    first,
    last,
    userToken: acc.userToken,
    ...extra,
  };
}

/** Lưu acc + countdown + mở login form edu */
async function saveAndOpenEdu(acc, { skipCountdown = false } = {}) {
  const session = sessionFromAcc(acc);
  await setState({ acc, session, status: `acc ${acc.email}` });

  if (!skipCountdown) await countdown30(`OK ${acc.email}`);

  await setState({ step: "edu_login", status: "mở edu login form…" });
  const tabId = await openTab("https://getedumail.com/login", true);
  await sleep(2000);
  try {
    await sendToTab(tabId, {
      type: "EDU_LOGIN",
      email: acc.email,
      password: acc.password,
    });
  } catch {
    /* content resume step=edu_login */
  }
  await setState({
    step: "edu_inbox",
    status: `edu: ${acc.email} / ${acc.password}`,
  });
  return { email: acc.email, password: acc.password, tabId };
}

async function loadBridge() {
  let r;
  try {
    r = await fetch(`${BRIDGE}/latest`).then((x) => x.json());
  } catch {
    throw new Error("bridge OFF — chạy edu-bridge.bat");
  }
  if (!r?.ok || !r.email) throw new Error(r?.error || "chưa có latest — edu-create.bat");
  if (!r.password) throw new Error("latest thiếu password");
  if (!r.userToken) throw new Error("latest thiếu userToken");
  return {
    email: r.email,
    password: r.password,
    fullName: r.fullName || "Alex Kowalski",
    userToken: r.userToken,
    domain: r.domain,
    at: r.claimedAt || new Date().toISOString(),
  };
}

async function bridgeHealth() {
  try {
    return await fetch(`${BRIDGE}/health`).then((x) => x.json());
  } catch {
    return { ok: false };
  }
}

/** STEP 1: tạo mail (API) hoặc lấy bridge → countdown → edu login */
async function step1({ fromBridge = false, domain } = {}) {
  const acc = fromBridge
    ? await loadBridge()
    : await createEduAccount({ domain });
  return saveAndOpenEdu(acc);
}

/** STEP 2: xAI reg (dùng acc đã lưu) */
async function step2() {
  const { acc, session: s0 } = await chrome.storage.local.get(["acc", "session"]);
  if (!acc?.email || !acc?.userToken) throw new Error("chưa có acc — bấm Bước 1");

  const session = { ...sessionFromAcc(acc), ...(s0 || {}) };
  await setState({ session, step: "xai_email", status: "mở xAI…" });

  const xaiTab = await openTab("https://accounts.x.ai/sign-up", true);
  await sleep(2500);
  try {
    await sendToTab(xaiTab, { type: "FILL_EMAIL", email: acc.email });
  } catch {
    /* resume */
  }

  await setState({
    step: "xai_wait_otp",
    status: "chờ OTP — xem tab edu inbox",
  });
  const otp = await pollXaiOtp(acc.email, acc.userToken);
  session.otp = otp;
  await setState({ session, step: "xai_otp", status: `OTP ${otp}` });

  try {
    await sendToTab(xaiTab, { type: "FILL_OTP", otp });
    await sleep(1500);
    await sendToTab(xaiTab, {
      type: "FILL_PROFILE",
      first: session.first,
      last: session.last,
      password: session.grokPass,
    });
  } catch {
    await chrome.tabs.update(xaiTab, { active: true });
  }

  await setState({
    step: "xai_turnstile",
    session,
    status: `Turnstile tay → Complete\n${acc.email}\n${session.grokPass}`,
  });
  return { email: acc.email, password: session.grokPass, otp };
}

/** Full = 1 rồi 2 */
async function stepFull(opts) {
  await step1(opts);
  return step2();
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  (async () => {
    switch (msg.type) {
      case "STEP1":
        reply({ ok: true, ...(await step1({ fromBridge: false, domain: msg.domain })) });
        break;
      case "STEP1_BRIDGE":
        reply({ ok: true, ...(await step1({ fromBridge: true })) });
        break;
      case "STEP2":
        reply({ ok: true, ...(await step2()) });
        break;
      case "STEP_FULL":
        reply({
          ok: true,
          ...(await stepFull({ fromBridge: !!msg.fromBridge, domain: msg.domain })),
        });
        break;
      case "GET_STATE": {
        const s = await chrome.storage.local.get([
          "acc",
          "status",
          "session",
          "step",
          "countdownEnd",
        ]);
        reply({ ok: true, ...s });
        break;
      }
      case "BRIDGE_HEALTH":
        reply(await bridgeHealth());
        break;
      case "RESET":
        await setState({
          step: "idle",
          status: "reset",
          countdownEnd: 0,
          session: null,
        });
        reply({ ok: true });
        break;
      default:
        reply({ ok: false, error: "unknown " + msg.type });
    }
  })().catch((e) => reply({ ok: false, error: e.message || String(e) }));
  return true;
});
