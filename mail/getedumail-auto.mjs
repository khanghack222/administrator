#!/usr/bin/env node
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import {
  createAccount,
  listAccFiles,
  loadLatest,
  fetchInbox,
  resolveToken,
  accountLoginEmail,
} from "./getedumail-core.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const count = Math.max(1, parseInt(flag("--count", "1"), 10) || 1);
const WEB_LOGIN_URL = "https://getedumail.com/login";
const PROFILE_DIR = join(__dir, ".pw-getedumail");

async function openLoggedInBrowser(email, password) {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: false,
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(WEB_LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email Address").fill(email);
  await page.getByLabel("Password").fill(password);
  await Promise.all([
    page.waitForURL("**/mail/inbox", { timeout: 30_000 }),
    page.getByRole("button", { name: "Sign In" }).click(),
  ]);
}
const cfgPath = join(__dir, "config.json");
const examplePath = join(__dir, "config.example.json");

function loadConfig() {
  for (const path of [cfgPath, examplePath]) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      /* */
    }
  }
  return {};
}

async function main() {
  const cfg = loadConfig();
  const domain = flag("--domain", cfg.domain || "iunp.edu.rs");
  const password = flag("--password", cfg.password || undefined);

  if (args.includes("--login")) {
    const latest = loadLatest();
    if (!latest?.email || !latest.password) {
      throw new Error("Không có mail gần nhất kèm mật khẩu");
    }
    const loginEmail = accountLoginEmail(latest);
    const token = await resolveToken({ ...latest, loginEmail, userToken: null });
    if (!token) throw new Error("Đăng nhập GetEduMail thất bại: server không trả userToken");
    console.log(`Đăng nhập API thành công: ${loginEmail}`);
    await openLoggedInBrowser(loginEmail, latest.password);
    console.log("Đã mở trình duyệt và đăng nhập GetEduMail.");
    return;
  }

  if (args.includes("--list")) {
    const list = listAccFiles();
    if (!list.length) console.log("Chưa có tài khoản edu cục bộ.");
    for (const acc of list) {
      console.log(`${acc.id}. ${acc.email}  ${acc.claimedAt || ""}`);
    }
    return;
  }

  if (args.includes("--inbox")) {
    const latest = loadLatest();
    if (!latest?.email) throw new Error("Chưa có mail gần nhất");
    const box = await fetchInbox(latest.email, 1, latest);
    console.log(`Hộp thư ${latest.email}: ${box.total} thư`);
    for (const mail of box.emails) {
      console.log(`${mail.index}. ${mail.subject} — ${mail.from}`);
    }
    return;
  }

  for (let i = 1; i <= count; i++) {
    console.log(`\n── Tạo mail ${i}/${count} ──`);
    const acc = await createAccount({
      domain,
      name: cfg.name || "Alex Kowalski",
      password,
      log: console.log,
    });
    console.log(`Hoàn tất: ${acc.email}`);
  }
}

main().catch((e) => {
  console.error("[LỖI]", e.message || e);
  process.exitCode = 1;
});
