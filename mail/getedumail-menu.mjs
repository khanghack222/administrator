#!/usr/bin/env node
/**
 * Menu CLI GetEduMail
 *   node getedumail-menu.mjs
 *   edu-menu.bat
 */
import { createInterface } from "readline";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import {
  createAccount,
  fetchInbox,
  fetchMailBody,
  testAllApi,
  loadLatest,
  listAccFiles,
  loadAcc,
  migrateOldAccounts,
  ACC_DIR,
  __dir,
} from "./getedumail-core.mjs";

const CONFIG_PATH = join(__dir, "config.json");
const NAMES_PATH = join(__dir, "names.json");
const DEFAULT_CONFIG = {
  domain: "warsawuni.edu.pl",
  name: "Alex Kowalski",
  password: "",
  openBrowserAfterCreate: true,
  randomName: true,
};

function pickRandomName() {
  if (!existsSync(NAMES_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(NAMES_PATH, "utf8"));
    const list = data.names || data;
    if (!Array.isArray(list) || !list.length) return null;
    return list[Math.floor(Math.random() * list.length)];
  } catch {
    return null;
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) =>
  new Promise((resolve) =>
    rl.question(q, (a) => resolve(String(a || "").trim()))
  );

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function banner() {
  const c = loadConfig();
  console.log(`
╔══════════════════════════════════════╗
║         GetEduMail — Menu CLI        ║
╚══════════════════════════════════════╝
  domain: ${c.domain}
  name  : ${c.randomName ? "(random từ names.json)" : c.name}
  pass  : ${c.password ? "••••" : "(random)"}
  open  : ${c.openBrowserAfterCreate ? "yes" : "no"}`);
}

function menu() {
  console.log(`
  [1] Tạo email + claim
  [2] Login latest (mở browser)
  [3] Login từ file JSON
  [4] Xem latest
  [5] Liệt kê acc/1.json …
  [m] Migrate file cũ → acc/
  [6] Xem inbox (latest)
  [7] Xem inbox (chọn account / email)
  [8] Config
  [9] Xem / thử random name
  [a] Test all API
  [0] Thoát
`);
}

function listAccounts() {
  return listAccFiles().map((a) => ({
    file: `acc/${a.file}`,
    email: a.email,
    at: a.claimedAt,
    password: a.password,
    userToken: a.userToken,
    id: a.id,
  }));
}

async function pickAccount() {
  const list = listAccounts();
  if (!list.length) {
    console.log("Chưa có acc/*.json — chạy [1] hoặc migrate.");
    return null;
  }
  console.log("\nAccounts (acc/N.json):");
  list.slice(0, 30).forEach((a) => {
    console.log(`  [${a.id}] ${a.email}  ${a.at || ""}`);
  });
  const pick = await ask("\nChọn id (1,2,3…) hoặc email: ");
  if (!pick) return null;
  const n = parseInt(pick, 10);
  if (n >= 1) {
    const acc = loadAcc(n);
    if (acc) return acc;
  }
  if (pick.includes("@")) {
    const hit = list.find(
      (a) => a.email?.toLowerCase() === pick.toLowerCase()
    );
    if (hit) return loadAcc(hit.id);
    return { email: pick };
  }
  console.log("Không tìm thấy.");
  return null;
}

async function openLogin({ email, password } = {}) {
  if (!email || !password) {
    throw new Error("cần email + password (login form, không cookie)");
  }
  console.log(`[login] form ${email} → mở browser…\n`);
  const { openLoggedIn } = await import("./getedumail-browser.mjs");
  // wait:false — không chặn menu, Enter quay lại
  await openLoggedIn({ email, password, wait: false });
}

async function doConfig() {
  let cfg = loadConfig();
  console.log("─── CONFIG (Enter = giữ nguyên) ───");
  console.log(`Hiện tại: domain=${cfg.domain} | name=${cfg.name} | open=${cfg.openBrowserAfterCreate}`);
  console.log(`File: ${CONFIG_PATH}\n`);

  console.log("Domain:");
  console.log("  [1] warsawuni.edu.pl");
  console.log("  [2] iunp.edu.rs");
  console.log("  [3] gõ domain khác");
  const dPick = await ask(`Chọn (Enter=${cfg.domain}): `);
  if (dPick === "1") cfg.domain = "warsawuni.edu.pl";
  else if (dPick === "2") cfg.domain = "iunp.edu.rs";
  else if (dPick === "3") {
    const custom = await ask("Domain: ");
    if (custom) cfg.domain = custom.replace(/^@/, "");
  } else if (dPick.includes(".")) cfg.domain = dPick.replace(/^@/, "");

  const rnd = await ask(
    `Random name từ names.json? y/n (Enter=${cfg.randomName ? "y" : "n"}): `
  );
  if (rnd.toLowerCase() === "y") cfg.randomName = true;
  if (rnd.toLowerCase() === "n") cfg.randomName = false;

  if (!cfg.randomName) {
    const name = await ask(`Tên cố định (Enter=${cfg.name}): `);
    if (name) cfg.name = name;
  }

  const pass = await ask(
    `Password (Enter=${cfg.password ? "giữ" : "random"} | "-" = random): `
  );
  if (pass === "-") cfg.password = "";
  else if (pass) cfg.password = pass;

  const open = await ask(
    `Mở browser sau create? y/n (Enter=${cfg.openBrowserAfterCreate ? "y" : "n"}): `
  );
  if (open.toLowerCase() === "y") cfg.openBrowserAfterCreate = true;
  if (open.toLowerCase() === "n") cfg.openBrowserAfterCreate = false;

  saveConfig(cfg);
  console.log("\nĐã lưu config.json:");
  console.log(JSON.stringify(cfg, null, 2));
}

async function doCreate() {
  const cfg = loadConfig();
  const name =
    cfg.randomName ? pickRandomName() || cfg.name : cfg.name;
  console.log(
    `Dùng config → ${cfg.domain} | ${name}${cfg.randomName ? " (random)" : ""} | pass=${cfg.password || "random"} | open=${cfg.openBrowserAfterCreate}`
  );
  console.log("(Đổi ở menu [8] Config)\n");

  const result = await createAccount({
    domain: cfg.domain,
    name,
    password: cfg.password || undefined,
    log: (m) => console.log(m),
  });

  console.log("\n─── KẾT QUẢ ───");
  console.log(`Email    : ${result.email}`);
  console.log(`Password : ${result.password}`);
  console.log(`Code     : ${result.code}`);
  console.log(`Token    : ${result.userToken.slice(0, 40)}…`);
  console.log(`File     : acc/${result.id}.json + acc/latest.json`);

  if (cfg.openBrowserAfterCreate)
    await openLogin({
      email: result.email,
      password: result.password,
      userToken: result.userToken,
    });
  else console.log("\nLogin: [2] | Inbox: [6] | Config: [8]");
}

function printInboxList(box, email) {
  console.log(`\n─── INBOX: ${email}  (${box.total} mail) ───`);
  if (!box.emails.length) {
    console.log("(trống)");
    return;
  }
  for (const m of box.emails) {
    const when = m.date ? new Date(m.date).toLocaleString() : "";
    console.log(
      `\n  [${m.index}] ${m.subject}\n      From: ${m.fromName ? m.fromName + " " : ""}<${m.from}>\n      ${when}`
    );
    if (m.preview)
      console.log(`      ${m.preview.replace(/\n/g, " ").slice(0, 100)}…`);
  }
}

function authForEmail(email) {
  const latest = loadLatest();
  if (latest?.email?.toLowerCase() === email?.toLowerCase()) return latest;
  const hit = listAccounts().find(
    (a) => a.email?.toLowerCase() === email?.toLowerCase()
  );
  return hit ? loadAcc(hit.id) : null;
}

async function doInbox(email) {
  if (!email) {
    console.log("Thiếu email.");
    return;
  }
  const acc = authForEmail(email);
  const opts = {
    token: acc?.userToken,
    userToken: acc?.userToken,
    password: acc?.password,
    id: acc?.id,
  };
  if (!opts.token && !opts.password) {
    console.log("Thiếu userToken/password trong acc — không list được (API 403).");
    return;
  }
  console.log(`Đang tải inbox ${email}…`);
  let box = await fetchInbox(email, 1, opts);
  if (box.token) opts.token = box.token;
  printInboxList(box, email);

  for (;;) {
    const cmd = await ask(
      "\n[số]=đọc mail  [r]=refresh  [b]=browser inbox  [Enter]=menu: "
    );
    if (!cmd) break;
    if (cmd.toLowerCase() === "r") {
      box = await fetchInbox(email, 1, opts);
      if (box.token) opts.token = box.token;
      printInboxList(box, email);
      continue;
    }
    if (cmd.toLowerCase() === "b") {
      if (!acc?.password) {
        console.log("Không có password — không login form được.");
        continue;
      }
      await openLogin({
        email: acc.email || email,
        password: acc.password,
      });
      continue;
    }
    const n = parseInt(cmd, 10);
    if (!n) {
      console.log("Lệnh không hợp lệ.");
      continue;
    }
    try {
      const mail = await fetchMailBody(email, n, opts);
      console.log("\n════════════════════════════════");
      console.log(`Subject : ${mail.subject}`);
      console.log(`From    : ${mail.from}`);
      console.log(`Date    : ${mail.date}`);
      if (mail.codes?.length) console.log(`Codes   : ${mail.codes.join(", ")}`);
      console.log("────────────────────────────────");
      console.log(mail.bodyText.slice(0, 3000));
      if (mail.bodyText.length > 3000) console.log("\n…(cắt 3000 ký tự)");
      console.log("════════════════════════════════");
    } catch (e) {
      console.error(e.message);
    }
  }
}

async function main() {
  if (!existsSync(CONFIG_PATH)) saveConfig(DEFAULT_CONFIG);
  async function pauseMenu() {
    await ask("\n[Enter] quay lại menu… ");
  }

  banner();
  for (;;) {
    menu();
    const c = await ask("Chọn: ");
    console.log("");
    if (c === "0" || c.toLowerCase() === "q") break;
    try {
      if (c === "1") await doCreate();
      else if (c === "2") {
        const latest = loadLatest();
        if (!latest) console.log("Chưa có latest. Chạy [1] trước.");
        else if (!latest.password)
          console.log("latest thiếu password — tạo lại [1].");
        else
          await openLogin({
            email: latest.email,
            password: latest.password,
          });
      } else if (c === "3") {
        const acc = await pickAccount();
        if (acc?.email && acc?.password)
          await openLogin({
            email: acc.email,
            password: acc.password,
          });
        else if (acc) console.log("File thiếu email/password.");
      } else if (c === "4") {
        const latest = loadLatest();
        if (!latest) console.log("Chưa có latest.");
        else {
          console.log(
            JSON.stringify(
              {
                id: latest.id,
                email: latest.email,
                password: latest.password,
                code: latest.code,
                claimedAt: latest.claimedAt,
                userToken: latest.userToken?.slice(0, 48) + "…",
              },
              null,
              2
            )
          );
        }
      } else if (c === "5") {
        const list = listAccounts();
        if (!list.length) console.log("Trống — acc/");
        else
          list.forEach((a) =>
            console.log(`  ${a.id}.json  ${a.email}  ${a.at || ""}`)
          );
        console.log(`dir: ${ACC_DIR}`);
      } else if (c === "m" || c === "M") {
        const n = migrateOldAccounts(console.log);
        console.log(`migrate xong: ${n} file → acc/`);
      } else if (c === "6") {
        const latest = loadLatest();
        if (!latest) console.log("Chưa có latest. Chạy [1] trước.");
        else await doInbox(latest.email);
      } else if (c === "7") {
        const typed = await ask("Email (Enter = chọn từ list): ");
        if (typed.includes("@")) await doInbox(typed);
        else {
          const acc = await pickAccount();
          if (acc?.email) await doInbox(acc.email);
        }
      } else if (c === "8") await doConfig();
      else if (c === "9") {
        if (!existsSync(NAMES_PATH)) console.log("Thiếu names.json");
        else {
          const data = JSON.parse(readFileSync(NAMES_PATH, "utf8"));
          console.log(`names.json: ${data.count || data.names?.length} tên`);
          console.log(`source: ${data.source || "?"}`);
          console.log("Sample random ×10:");
          for (let i = 0; i < 10; i++) console.log("  ·", pickRandomName());
        }
      } else if (c === "a" || c === "A" || c === "10") {
        const cfg = loadConfig();
        const r = await testAllApi({
          domain: cfg.domain,
          name: cfg.randomName ? pickRandomName() || cfg.name : cfg.name,
          password: cfg.password || undefined,
          log: console.log,
        });
        console.log("\n── SUMMARY ──");
        console.log(r.ok ? "PASS" : "FAIL");
        if (r.email) console.log("test email:", r.email);
        if (r.error) console.log("error:", r.error);
      } else console.log("Không hợp lệ. Grok → ..\\grok-menu.bat hoặc grok\\grok-menu.bat");
    } catch (e) {
      console.error("[LỖI]", e.message || e);
    }
    await pauseMenu();
  }
  rl.close();
  console.log("Bye.");
  process.exit(0);
}

main();
