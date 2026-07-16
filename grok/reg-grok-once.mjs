#!/usr/bin/env node
/**
 * 1 lượt reg Grok — reuse latest mail, proxy
 * Step-by-step, log rõ, không bấm Sign up with X
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
import { chromium } from "playwright";
import { api, htmlToText, loadLatest } from "../mail/getedumail-core.mjs";
import { pickLiveProxy, toPlaywrightProxy } from "./proxy.mjs";
import { solveTurnstileWithFallback } from "./turnstile.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIGNUP = "https://accounts.x.ai/sign-up";
const PROFILE = join(__dir, ".pw-grok-profile");

const acc = loadLatest();
if (!acc?.email) throw new Error("chưa có acc/latest.json — tạo mail trước");
const grokPass = acc.password || `Gx${Date.now().toString(36)}A1!`;
const email = acc.email;
const token = acc.userToken;

function extractXaiCode(text, subject = "") {
  const t = `${subject}\n${text || ""}`;
  return (
    (t.match(/\b([A-Z0-9]{2,4}-[A-Z0-9]{2,6})\b/) ||
      t.match(/\b(\d{6})\b/) ||
      [])[1] || null
  );
}

async function pollOtp() {
  for (let i = 0; i < 30; i++) {
    const r = await api(
      "GET",
      `/getedumail/emails/${encodeURIComponent(email)}/list?page=1`,
      { token }
    );
    const mails = r.json?.emails || [];
    for (const m of mails) {
      const blob = `${m.subject} ${JSON.stringify(m.from || "")}`;
      if (!/x\.ai|xai|confirmation/i.test(blob)) continue;
      const body = htmlToText(m.body?.text || m.body?.html || "");
      const code = extractXaiCode(body, m.subject || "");
      if (code) return { code, subject: m.subject };
    }
    process.stdout.write(".");
    await sleep(2000);
  }
  throw new Error("OTP timeout");
}

async function main() {
  console.log(`\n══ REG 1 LƯỢT ══\nemail: ${email}\npass : ${grokPass}\n`);

  const proxy = pickLiveProxy({ log: console.log });
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {
    /* */
  }
  mkdirSync(PROFILE, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    channel: "chrome",
    proxy: toPlaywrightProxy(proxy),
    args: ["--disable-blink-features=AutomationControlled"],
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] || (await context.newPage());

  console.log("[1] goto signup");
  await page.goto(SIGNUP, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await sleep(3000);

  // cookies
  for (const name of [/accept all cookies/i, /accept all/i]) {
    const b = page.getByRole("button", { name });
    if (await b.count()) {
      await b.first().click().catch(() => {});
      await sleep(400);
      break;
    }
  }

  console.log("[2] Sign up with email (NOT X)");
  const emailPath = page.getByRole("button", { name: /^sign up with email$/i });
  if (!(await emailPath.count())) {
    // list all buttons for debug
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll("button")].map((b) => b.innerText.trim())
    );
    console.log("[debug] buttons:", labels);
    throw new Error("Không thấy Sign up with email");
  }
  await emailPath.first().click();
  await sleep(1500);

  console.log("[3] fill email");
  const emailBox = page.locator('input[type="email"], input:not([type])').first();
  await emailBox.waitFor({ state: "visible", timeout: 15_000 });
  await emailBox.fill(email);
  console.log("    ", email);

  console.log("[4] click Sign up");
  await page.getByRole("button", { name: /^sign up$/i }).click();
  await sleep(2000);

  // wait verify screen
  await page
    .getByText(/verify your email|one time security code/i)
    .waitFor({ timeout: 30_000 })
    .catch(() => console.log("[warn] chưa thấy verify screen — poll OTP anyway"));

  console.log("[5] poll OTP");
  const otp = await pollOtp();
  console.log("\n    code:", otp.code, otp.subject);

  console.log("[6] fill OTP + confirm:", otp.code);
  // Gõ liền 1 lần ô đầu — UI tự nhảy ô (MEP-MXJ), không click từng ô
  await page.waitForSelector("form input", { timeout: 15_000 });
  const otpInputs = page.locator("form input:visible");
  const nOtp = await otpInputs.count();
  const raw = String(otp.code || "").replace(/\s/g, "");
  console.log("    otp inputs:", nOtp, "type liền:", raw);
  if (nOtp < 1) throw new Error("không thấy ô OTP");
  await otpInputs.first().click();
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.type(raw, { delay: 60 });
  await sleep(400);
  await page.getByRole("button", { name: /confirm email/i }).click();
  await sleep(2500);

  console.log("[7] profile form");
  await page.getByText(/complete your sign up/i).waitFor({ timeout: 20_000 }).catch(() => {});
  const inputs = page.locator("form input");
  // first, last, password — order from earlier MCP snapshot
  const n = await inputs.count();
  console.log("    inputs:", n);
  if (n >= 1) await inputs.nth(0).fill("Anna");
  if (n >= 2) await inputs.nth(1).fill("Wisniewski");
  if (n >= 3) await inputs.nth(2).fill(grokPass);
  // also try type=password
  const pw = page.locator('input[type="password"]');
  if (await pw.count()) await pw.first().fill(grokPass);

  console.log("[8] Turnstile fallback");
  const ts = await solveTurnstileWithFallback(page, {
    pageUrl: page.url(),
    useExtension: false,
    tryTokenApi: false,
    tryTokenApi: true,
    extTimeoutMs: 25_000,
    manualTimeoutMs: 45_000,
    log: console.log,
  });
  if (!ts.ok) console.log(`[captcha] fail via=${ts.via}`);

  if (ts.ok) {
    console.log("[9] Complete sign up");
    await page.getByRole("button", { name: /complete sign up/i }).click();
    await sleep(4000);
  } else {
    console.log("[9] Turnstile fail — bấm tay Complete trên browser");
  }

  writeFileSync(
    join(__dir, "grok-reg-latest.json"),
    JSON.stringify(
      {
        ok: ts.ok,
        email,
        grokPassword: grokPass,
        otp: otp.code,
        proxy: proxy?.exitIp,
        turnstile: ts.via,
        url: page.url(),
        at: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log("\n[saved] grok-reg-latest.json");
  console.log("URL:", page.url());
  console.log("Đóng browser khi xong.");
  await new Promise((r) => context.on("close", r));
}

main().catch((e) => {
  console.error("[FAIL]", e.message || e);
  process.exit(1);
});
