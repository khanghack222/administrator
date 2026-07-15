#!/usr/bin/env node
/**
 * Menu CLI Reg Grok (tách riêng — không gộp GetEduMail)
 *   node grok-menu.mjs
 *   grok-menu.bat
 */
import { createInterface } from "readline";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";

const __dir = dirname(fileURLToPath(import.meta.url));
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) =>
  new Promise((resolve) =>
    rl.question(q, (a) => resolve(String(a || "").trim()))
  );

function runNode(script, args = []) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(__dir, script), ...args], {
      cwd: __dir,
      stdio: "inherit",
    });
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} exit ${code}`))
    );
    p.on("error", reject);
  });
}

function banner() {
  let proxy = "(proxies.txt / config)";
  const cfgP = join(__dir, "config.json");
  if (existsSync(cfgP)) {
    try {
      const c = JSON.parse(readFileSync(cfgP, "utf8"));
      if (c.proxy) proxy = String(c.proxy).split(":").slice(0, 2).join(":") + ":…";
      if (c.nopechaKey) proxy += " | nopecha:set";
    } catch {
      /* */
    }
  }
  console.log(`
╔══════════════════════════════════════╗
║         Reg Grok — Menu CLI          ║
╚══════════════════════════════════════╝
  proxy/key: ${proxy}
  results  : grok/acc/grok-results.jsonl
  mail     : ../mail/acc/
`);
}

function menu() {
  console.log(`
  [1] Reg ×1 Playwright (fresh edu)
  [2] Reg ×1 Playwright (reuse edu)
  [3] Multi (count + workers)
  [4] Bridge server (ext-grok)
  [5] Proxy test
  [6] NopeCHA setup
  [8] Reg ×1 Chrome USER (fresh)
  [9] Reg ×1 Chrome USER (reuse)
  [0] Thoát
`);
}

/** Hỏi trước khi kill Chrome. true = tiếp tục. */
async function confirmCloseChrome() {
  console.log(`
⚠  Bước này sẽ:
   • Đóng HẾT cửa sổ Google Chrome (mọi tab đang mở)
   • Mở lại Chrome profile user + remote debugging
   • Mở tab signup xAI mới
`);
  const a = (await ask("Tiếp tục? [y/N]: ")).toLowerCase();
  return a === "y" || a === "yes";
}

async function main() {
  async function pause() {
    await ask("\n[Enter] quay lại menu… ");
  }

  banner();
  for (;;) {
    menu();
    const c = await ask("Chọn: ");
    console.log("");
    if (c === "0" || c.toLowerCase() === "q") break;
    try {
      if (c === "1") {
        console.log("Reg Grok ×1 --fresh …\n");
        await runNode("reg-grok.mjs", ["--fresh"]);
      } else if (c === "2") {
        console.log("Reg Grok ×1 --reuse …\n");
        await runNode("reg-grok.mjs", ["--reuse"]);
      } else if (c === "3") {
        const n = await ask("Count (số acc, Enter=3): ");
        const w = await ask("Workers song song (Enter=2, max 8): ");
        const count = Math.max(1, parseInt(n || "3", 10) || 3);
        const workers = Math.max(1, Math.min(8, parseInt(w || "2", 10) || 2));
        console.log(`\nMulti n=${count} w=${workers} …\n`);
        await runNode("reg-multi.mjs", [
          "--count",
          String(count),
          "--workers",
          String(workers),
        ]);
      } else if (c === "4") {
        console.log("Bridge http://127.0.0.1:3847 — Ctrl+C dừng\n");
        await runNode("bridge-server.mjs");
      } else if (c === "5") {
        await runNode("proxy.mjs", ["--test"]);
      } else if (c === "6") {
        await runNode("nopecha.mjs", ["--setup"]);
      } else if (c === "8") {
        if (!(await confirmCloseChrome())) {
          console.log("Đã hủy.");
        } else {
          console.log("Reg Chrome USER (fresh) …\n");
          await runNode("reg-grok.mjs", ["--fresh", "--user-chrome", "--yes"]);
        }
      } else if (c === "9") {
        if (!(await confirmCloseChrome())) {
          console.log("Đã hủy.");
        } else {
          console.log("Reg Chrome USER (reuse) …\n");
          await runNode("reg-grok.mjs", ["--reuse", "--user-chrome", "--yes"]);
        }
      } else {
        console.log("Không hợp lệ. Mail → ..\\edu-menu.bat");
      }
    } catch (e) {
      console.error("[LỖI]", e.message || e);
    }
    await pause();
  }
  rl.close();
  console.log("Bye.");
  process.exit(0);
}

main();
