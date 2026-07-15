/**
 * Browser: login form email/pass (+ cookie fallback nếu form React stuck)
 *   node getedumail-browser.mjs --file getedumail-latest.json
 *   node getedumail-browser.mjs --email a@b.edu --password xxx
 */
import { chromium } from "playwright";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const LOGIN_URL = "https://getedumail.com/login";
const INBOX_URL = "https://getedumail.com/mail/inbox";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fillLoginForm(page, context, email, password) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(600);

  for (const re of [/accept all/i, /necessary only/i]) {
    const b = page.getByRole("button", { name: re });
    if (await b.count()) {
      await b.first().click().catch(() => {});
      await sleep(300);
      break;
    }
  }

  const emailBox = page.locator("#email, input[type=email], input[name=email]").first();
  const passBox = page.locator("#password, input[type=password]").first();
  if (!(await emailBox.count())) throw new Error("không thấy ô email trên /login");
  if (!(await passBox.count())) throw new Error("không thấy ô password trên /login");

  await emailBox.click();
  await emailBox.fill(email);
  await passBox.click();
  await passBox.fill(password);

  const formSubmit = page.locator('form button[type="submit"]');
  if (await formSubmit.count()) await formSubmit.first().click();
  else {
    await page
      .locator("form")
      .getByRole("button", { name: /^sign in$/i })
      .first()
      .click();
  }

  await page
    .waitForURL(/mail|inbox|dashboard|create/i, { timeout: 20_000 })
    .catch(() => {});
  await sleep(800);

  if (/\/login/i.test(page.url())) {
    console.log("[browser] form stuck — API login + set cookie");
    const tok = await page.evaluate(
      async ({ email, password }) => {
        const res = await fetch(
          "https://api.getedumail.com/getedumail/user/login",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, password }),
          }
        );
        const j = await res.json();
        return j.userToken || null;
      },
      { email, password }
    );
    if (!tok) throw new Error("login form + API login đều fail");
    await context.addCookies([
      { name: "userToken", value: tok, domain: "getedumail.com", path: "/" },
      { name: "userToken", value: tok, domain: ".getedumail.com", path: "/" },
    ]);
    await page.goto(INBOX_URL, { waitUntil: "domcontentloaded" });
  }
}

/**
 * @param {boolean} [opts.wait=false] true = chặn đến khi đóng browser (CLI).
 *   false = login xong return ngay, browser giữ mở (menu Enter).
 */
export async function openLoggedIn({
  email,
  password,
  url = INBOX_URL,
  headless = false,
  wait = false,
} = {}) {
  if (!email || !password) {
    throw new Error("cần email + password");
  }

  const browser = await chromium.launch({
    headless,
    channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();

  console.log(`[browser] login form → ${email}`);
  await fillLoginForm(page, context, email, password);

  if (!/mail|inbox/i.test(page.url()) || url !== INBOX_URL) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  console.log(`[browser] OK → ${page.url()}`);
  if (!wait) {
    // giữ ref — tránh GC đóng browser khi return menu
    globalThis.__eduBrowsers = globalThis.__eduBrowsers || [];
    globalThis.__eduBrowsers.push(browser);
    console.log(`[browser] giữ cửa sổ mở — Enter về menu (không Ctrl+C)`);
    return { browser, page, url: page.url() };
  }
  console.log(`[browser] đóng cửa sổ browser để thoát CLI`);
  await new Promise((resolve) => browser.on("disconnected", resolve));
}

export async function claimBrowser({ email, password, headless = true } = {}) {
  if (!email || !password) throw new Error("claim cần email + password");
  const browser = await chromium.launch({ headless, channel: "chrome" });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await fillLoginForm(page, context, email, password);
    await page.goto("https://getedumail.com/mail/create", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const user = email.split("@")[0];
    const domain = email.split("@")[1];
    const userBox = page.getByPlaceholder(/username/i);
    if (await userBox.count()) await userBox.first().fill(user);
    const sel = page.locator("select");
    if (await sel.count()) {
      await sel
        .first()
        .selectOption(domain)
        .catch(async () => {
          await page.locator("[role=combobox]").first().click();
          await page.getByRole("option", { name: domain }).click();
        });
    }
    await page
      .getByRole("button", { name: /Claim Email Address|Create Email/i })
      .click();
    await page.waitForURL(/mail\/inbox/, { timeout: 30_000 }).catch(() => {});
    return { url: page.url() };
  } finally {
    await browser.close();
  }
}

if (process.argv[1]?.includes("getedumail-browser")) {
  const args = process.argv.slice(2);
  const flag = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : null;
  };
  let email = flag("--email");
  let password = flag("--password");
  const f = flag("--file");
  if (f) {
    const data = JSON.parse(readFileSync(f, "utf8"));
    email = email || data.email;
    password = password || data.password;
  } else if (!email) {
    const { loadLatest } = await import("./getedumail-core.mjs");
    const data = loadLatest();
    email = data?.email;
    password = password || data?.password;
  }
  if (!email || !password) {
    console.error("Usage: node getedumail-browser.mjs --file acc/1.json");
    process.exit(1);
  }
  await openLoggedIn({ email, password, wait: true });
}
