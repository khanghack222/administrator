#!/usr/bin/env node
import { createInterface } from "readline";
import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  listAccFiles,
  loadLatest,
  fetchInbox,
  fetchMailBody,
} from "./getedumail-core.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const cfgPath = join(__dir, "config.json");
const examplePath = join(__dir, "config.example.json");
const ask = (question) =>
  new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || "").trim());
    });
  });

function loadConfig() {
  for (const path of [cfgPath, examplePath]) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      /* */
    }
  }
  return {
    configSeen: false,
    domain: "iunp.edu.rs",
    name: "Alex Kowalski",
    password: "",
    randomName: true,
    openBrowserAfterCreate: false,
    proxy: "",
  };
}

function saveConfig(cfg) {
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

function runAuto(args = []) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(__dir, "getedumail-auto.mjs"), ...args], {
      cwd: __dir,
      stdio: "inherit",
    });
    p.on("exit", (code) => resolve(code ?? 1));
    p.on("error", () => resolve(1));
  });
}

function showAccounts() {
  const list = listAccFiles();
  if (!list.length) {
    console.log("Chưa có tài khoản edu cục bộ.");
    return;
  }
  console.log("\n── TÀI KHOẢN EDU ──");
  for (const acc of list) {
    console.log(`${acc.id}. ${acc.email}  ${acc.claimedAt || ""}`);
  }
}

async function showInbox() {
  const latest = loadLatest();
  if (!latest?.email) {
    console.log("Chưa có mail gần nhất.");
    return;
  }
  try {
    const box = await fetchInbox(latest.email, 1, latest);
    console.log(`\n── HỘP THƯ ${latest.email} (${box.total}) ──`);
    if (!box.emails.length) return;
    for (const mail of box.emails) {
      console.log(`${mail.index}. ${mail.subject} — ${mail.from}`);
      if (mail.codes.length) console.log(`   Mã: ${mail.codes.join(", ")}`);
    }
    const choice = await ask("Xem thư số [Enter bỏ qua]: ");
    if (!choice) return;
    const mail = await fetchMailBody(latest.email, choice, latest);
    console.log(`\n── ${mail.subject} ──\n${mail.bodyText || "(Thư không có nội dung văn bản)"}`);
  } catch (e) {
    console.log(`[LỖI] ${e.message || e}`);
  }
}

async function editConfig() {
  const cfg = loadConfig();
  console.log("\nĐể trống để giữ giá trị cũ.");
  const domain = await ask(`Tên miền [${cfg.domain || "iunp.edu.rs"}]: `);
  const name = await ask(`Tên mặc định [${cfg.name || "Alex Kowalski"}]: `);
  const password = await ask("Mật khẩu mặc định [để trống = ngẫu nhiên]: ");
  if (domain) cfg.domain = domain;
  if (name) cfg.name = name;
  if (password) cfg.password = password;
  cfg.configSeen = true;
  saveConfig(cfg);
  console.log(`Đã lưu ${cfgPath}`);
}

async function main() {
  for (;;) {
    const cfg = loadConfig();
    console.log(`
╔══════════════════════════════════════╗
║          MENU GETEDUMAIL             ║
╚══════════════════════════════════════╝
  Tên miền : ${cfg.domain || "iunp.edu.rs"}
  Gần nhất : ${loadLatest()?.email || "chưa có"}

  [1] Tạo một mail edu
  [2] Tạo nhiều mail edu
  [3] Xem danh sách mail đã lưu
  [4] Xem hộp thư mail gần nhất
  [5] Làm mới token và mở trang đăng nhập
  [9] Cấu hình
  [0] Thoát
`);
    const choice = await ask("Chọn: ");
    if (choice === "0" || choice.toLowerCase() === "q") return;
    if (choice === "1") {
      await runAuto([]);
    } else if (choice === "2") {
      const raw = await ask("Số lượng [3]: ");
      const count = Math.max(1, parseInt(raw || "3", 10) || 3);
      await runAuto(["--count", String(count)]);
    } else if (choice === "3") {
      showAccounts();
    } else if (choice === "4") {
      await showInbox();
    } else if (choice === "5") {
      const code = await runAuto(["--login"]);
      if (code) console.log("Đăng nhập thất bại. Tài khoản cũ có thể thiếu email đăng nhập gốc.");
    } else if (choice === "9") {
      await editConfig();
    } else {
      console.log("Lựa chọn không hợp lệ.");
    }
    await ask("\n[Enter] quay lại menu… ");
  }
}

main().catch((e) => {
  console.error("[LỖI]", e.message || e);
  process.exit(1);
});
