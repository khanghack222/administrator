#!/usr/bin/env node
/**
 * Menu CLI Reg Grok — Chrome USER only
 *   node grok-menu.mjs
 *   grok-menu.bat
 *
 * [9] Config: ↑↓ chọn · Space bật/tắt · Enter sửa text · s lưu · q thoát
 */
import { createInterface } from "readline";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { stdin as input, stdout as output } from "process";

const __dir = dirname(fileURLToPath(import.meta.url));
const CFG_PATH = join(__dir, "config.json");
const CFG_EXAMPLE = join(__dir, "config.example.json");

let rl = null;
function ensureRl() {
  if (!rl) rl = createInterface({ input, output });
  return rl;
}
function closeRl() {
  if (rl) {
    rl.close();
    rl = null;
  }
}
const ask = (q) =>
  new Promise((resolve) => {
    ensureRl().question(q, (a) => resolve(String(a || "").trim()));
  });

function runNode(script, args = []) {
  return new Promise((resolve, reject) => {
    closeRl();
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

const DEFAULT_CFG = {
  configSeen: false,
  domain: "iunp.edu.rs",
  domains: ["iunp.edu.rs", "iitp.edu.rs", "warsawuni.edu.pl"],
  name: "Alex Kowalski",
  password: "",
  openBrowserAfterCreate: false,
  randomName: true,
  headless: false,
  workers: 2,
  reuseUnusedEdu: true,
  autoClickCaptcha: true,
  proxy: "",
  nineRouter: {
    autoAuth: false,
    baseUrl: "http://127.0.0.1:20128",
    namePrefix: "edu-auto",
  },
};

function loadConfig() {
  if (!existsSync(CFG_PATH)) {
    if (existsSync(CFG_EXAMPLE)) copyFileSync(CFG_EXAMPLE, CFG_PATH);
    else writeFileSync(CFG_PATH, JSON.stringify(DEFAULT_CFG, null, 2));
  }
  try {
    const c = JSON.parse(readFileSync(CFG_PATH, "utf8"));
    // merge defaults cho key thiếu (không ghi đè user)
    if (c.nineRouter == null) c.nineRouter = { ...DEFAULT_CFG.nineRouter };
    if (c.configSeen == null) c.configSeen = false;
    return c;
  } catch {
    return { ...DEFAULT_CFG };
  }
}

function saveConfig(cfg) {
  writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
}

/** Chưa xem config lần nào (user mới / configSeen=false). */
function needsFirstConfig(cfg = loadConfig()) {
  return cfg.configSeen !== true;
}

function markConfigSeen(cfg) {
  cfg.configSeen = true;
  saveConfig(cfg);
}

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

function setPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Cấu hình hiển thị trong menu [9]
 * label: tên ngắn · help: giải thích chi tiết (tiếng Việt)
 */
const CONFIG_ITEMS = [
  {
    path: "randomName",
    label: "Tên ngẫu nhiên (edu)",
    type: "bool",
    help: "BẬT: mỗi lần tạo mail edu lấy tên từ names.json (tránh trùng). TẮT: dùng đúng ô «Tên mặc định» bên dưới.",
  },
  {
    path: "openBrowserAfterCreate",
    label: "Mở trình duyệt sau tạo edu",
    type: "bool",
    help: "BẬT: tạo xong mail edu thì mở browser xem inbox. TẮT: chỉ tạo API, không mở browser (nhanh, dùng khi reg Grok).",
  },
  {
    path: "nineRouter.autoAuth",
    label: "9router tự auth sau reg",
    type: "bool",
    help: "BẬT: reg xong GIỮ cookie/login → device OAuth grok-cli → push 9router. TẮT: logout sau reg.",
  },
  {
    path: "headless",
    label: "Ẩn browser (headless)",
    type: "bool",
    help: "BẬT: Playwright headless, không hiện cửa sổ. TẮT: Chrome USER (CDP) hiện browser. Multi + headless = song song ổn hơn.",
  },
  {
    path: "autoClickCaptcha",
    label: "Auto-click Cloudflare",
    type: "bool",
    help: "BẬT: tự click checkbox Turnstile. TẮT: chờ giải tay.",
  },
  {
    path: "reuseUnusedEdu",
    label: "Dùng edu cũ chưa reg",
    type: "bool",
    help: "BẬT: lấy mail từ mail/acc chưa có trong grok-results trước khi tạo mail mới. TẮT: luôn tạo mail mới.",
  },
  {
    path: "domain",
    label: "Domain mặc định",
    type: "text",
    help: "Domain GetEduMail chính, ví dụ iunp.edu.rs. Dùng khi domains rỗng hoặc fallback.",
  },
  {
    path: "domains",
    label: "Domains (luân phiên)",
    type: "text",
    help: "Danh sách domain cách nhau dấu phẩy: iunp.edu.rs,iitp.edu.rs. Fail 1 domain → thử domain khác.",
  },
  {
    path: "workers",
    label: "Số worker song song",
    type: "text",
    help: "Multi reg: số process chạy cùng lúc (1–8). Headless khuyến nghị 2–4. Chrome USER: 1–2.",
  },
  {
    path: "name",
    label: "Tên mặc định",
    type: "text",
    help: "Họ tên khi «Tên ngẫu nhiên» TẮT.",
  },
  {
    path: "proxy",
    label: "Proxy (host:port:user:pass)",
    type: "secret",
    help: "Proxy HTTP. Headless/Playwright dùng ô này. Chrome USER: set proxy trong Chrome.",
  },
  {
    path: "nineRouter.baseUrl",
    label: "Địa chỉ 9router",
    type: "text",
    help: "URL API 9router (mặc định http://127.0.0.1:20128).",
  },
  {
    path: "nineRouter.namePrefix",
    label: "Tiền tố tên 9router",
    type: "text",
    help: "Tên connection: {prefix}-{user}-{id}.",
  },
];

function maskSecret(v) {
  const s = String(v || "");
  if (!s) return "(trống)";
  if (s.length <= 6) return "•••";
  return s.slice(0, 3) + "…" + s.slice(-2);
}

function fmtVal(item, cfg) {
  const v = getPath(cfg, item.path);
  if (item.type === "bool") return v ? "BẬT" : "TẮT";
  if (item.type === "secret") return maskSecret(v);
  if (Array.isArray(v)) return v.join(", ") || "—";
  return v === "" || v == null ? "—" : String(v);
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function hideCursor() {
  try {
    output.write("\x1b[?25l");
  } catch {
    /* */
  }
}
function showCursor() {
  try {
    output.write("\x1b[?25h");
  } catch {
    /* */
  }
}

/** Raw key: arrows / space / enter / s / q / digits */
function readKey() {
  return new Promise((resolve) => {
    const wasRaw = input.isRaw;
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.once("data", (buf) => {
      if (input.isTTY) input.setRawMode(!!wasRaw);
      const s = buf.toString("utf8");
      // Ctrl+C
      if (s === "\u0003") {
        resolve({ name: "ctrl-c" });
        return;
      }
      if (s === "\r" || s === "\n") {
        resolve({ name: "enter" });
        return;
      }
      if (s === " " || s === "\u00a0") {
        resolve({ name: "space" });
        return;
      }
      if (s === "\u001b[A" || s === "\u001bOA") {
        resolve({ name: "up" });
        return;
      }
      if (s === "\u001b[B" || s === "\u001bOB") {
        resolve({ name: "down" });
        return;
      }
      if (s === "\u001b[D" || s === "\u001bOD") {
        resolve({ name: "left" });
        return;
      }
      if (s === "\u001b[C" || s === "\u001bOC") {
        resolve({ name: "right" });
        return;
      }
      if (s === "\u001b") {
        resolve({ name: "escape" });
        return;
      }
      resolve({ name: "char", ch: s });
    });
  });
}

async function readLineRaw(prompt) {
  // line mode for text edit
  if (input.isTTY) input.setRawMode(false);
  showCursor();
  const line = await new Promise((resolve) => {
    ensureRl().question(prompt, (a) => resolve(a));
  });
  closeRl();
  hideCursor();
  if (input.isTTY) input.setRawMode(true);
  return String(line ?? "");
}

async function configScreen({ firstRun = false } = {}) {
  closeRl();
  let cfg = loadConfig();
  if (!cfg.nineRouter) cfg.nineRouter = { ...DEFAULT_CFG.nineRouter };
  let idx = 0;
  let dirty = false;
  hideCursor();

  const wrapHelp = (text, width = 58) => {
    const words = String(text || "").split(/\s+/);
    const lines = [];
    let cur = "";
    for (const w of words) {
      if ((cur + " " + w).trim().length > width) {
        if (cur) lines.push(cur);
        cur = w;
      } else cur = (cur + " " + w).trim();
    }
    if (cur) lines.push(cur);
    return lines;
  };

  const draw = () => {
    output.write("\x1b[2J\x1b[H");
    const W = 62;
    const bar = "═".repeat(W);
    if (firstRun) {
      console.log(`
╔${bar}╗
║  \x1b[1mCHÀO MỪNG — thiết lập lần đầu\x1b[0m${" ".repeat(W - 30)}║
║  ↑↓ chọn · \x1b[1mSpace\x1b[0m bật/tắt · Enter sửa · \x1b[1mq\x1b[0m vào menu${" ".repeat(Math.max(0, W - 48))}║
╚${bar}╝
  Mặc định: proxy/key trống · 9router autoAuth \x1b[33mTẮT\x1b[0m
  Điền proxy / 9router nếu cần → bấm \x1b[1mq\x1b[0m
`);
    } else {
      console.log(`
╔${bar}╗
║  \x1b[1mCẤU HÌNH\x1b[0m  ·  Space bật/tắt  ·  ↑↓  ·  Enter  ·  q${" ".repeat(Math.max(0, W - 48))}║
╚${bar}╝
  ${dirty ? "\x1b[33m* chưa lưu (bool tự lưu)\x1b[0m" : "\x1b[32m✓ đã lưu\x1b[0m"}
`);
    }

    // nhóm: bật/tắt | chữ
    const bools = CONFIG_ITEMS.map((it, i) => ({ it, i })).filter(
      (x) => x.it.type === "bool"
    );
    const texts = CONFIG_ITEMS.map((it, i) => ({ it, i })).filter(
      (x) => x.it.type !== "bool"
    );

    const drawRow = (item, i) => {
      const sel = i === idx;
      const val = fmtVal(item, cfg);
      let badge;
      if (item.type === "bool") {
        badge = getPath(cfg, item.path)
          ? "\x1b[32m● BẬT\x1b[0m"
          : "\x1b[2m○ TẮT\x1b[0m";
      } else {
        badge = "\x1b[2m  ·  \x1b[0m";
      }
      const body = `${badge}  ${pad(item.label, 32)} ${val}`;
      if (sel) {
        console.log(`\x1b[36m▸\x1b[0m\x1b[7m ${pad(item.label, 32)} ${pad(val, 18)} \x1b[0m`);
      } else {
        console.log(`  ${body}`);
      }
    };

    console.log("  \x1b[1mBật / tắt\x1b[0m  (Space)");
    console.log("  " + "─".repeat(56));
    for (const { it, i } of bools) drawRow(it, i);
    console.log("\n  \x1b[1mGiá trị chữ\x1b[0m  (Enter sửa)");
    console.log("  " + "─".repeat(56));
    for (const { it, i } of texts) drawRow(it, i);

    const item = CONFIG_ITEMS[idx];
    const kind =
      item.type === "bool"
        ? "Bật/tắt — nhấn Space"
        : item.type === "secret"
          ? "Bí mật — Enter sửa (che khi hiện)"
          : "Chữ — Enter sửa";
    console.log(`
┌─ \x1b[1m${item.label}\x1b[0m
│  ${kind}
│  \x1b[2m${item.path}\x1b[0m`);
    for (const ln of wrapHelp(item.help || "", 56)) {
      console.log(`│  ${ln}`);
    }
    console.log(`└${"─".repeat(58)}
  \x1b[2mSpace\x1b[0m bật/tắt   \x1b[2mEnter\x1b[0m sửa   \x1b[2ms\x1b[0m lưu   \x1b[2mq\x1b[0m thoát
`);
  };

  try {
    for (;;) {
      draw();
      const k = await readKey();
      if (
        k.name === "ctrl-c" ||
        k.name === "escape" ||
        (k.name === "char" && (k.ch === "q" || k.ch === "Q"))
      ) {
        // lần đầu: bắt buộc đánh dấu đã xem trước khi vào menu
        markConfigSeen(cfg);
        break;
      }
      if (k.name === "char" && (k.ch === "s" || k.ch === "S")) {
        cfg.configSeen = true;
        saveConfig(cfg);
        dirty = false;
        continue;
      }
      if (k.name === "up" || (k.name === "char" && k.ch === "k")) {
        idx = (idx - 1 + CONFIG_ITEMS.length) % CONFIG_ITEMS.length;
        continue;
      }
      if (k.name === "down" || (k.name === "char" && k.ch === "j")) {
        idx = (idx + 1) % CONFIG_ITEMS.length;
        continue;
      }

      const item = CONFIG_ITEMS[idx];

      // Space / left / right → toggle bool
      if (
        item.type === "bool" &&
        (k.name === "space" || k.name === "left" || k.name === "right")
      ) {
        const cur = !!getPath(cfg, item.path);
        setPath(cfg, item.path, !cur);
        dirty = true;
        // auto-save toggles (nhanh)
        saveConfig(cfg);
        dirty = false;
        continue;
      }

      // Space on non-bool: ignore or beep
      if (k.name === "space" && item.type !== "bool") continue;

      // Enter → edit text/secret; bool also toggle
      if (k.name === "enter") {
        if (item.type === "bool") {
          setPath(cfg, item.path, !getPath(cfg, item.path));
          saveConfig(cfg);
          dirty = false;
          continue;
        }
        showCursor();
        if (input.isTTY) input.setRawMode(false);
        const cur = getPath(cfg, item.path);
        const shown =
          item.type === "secret" && cur
            ? `(đang ${maskSecret(cur)} — Enter trống = giữ nguyên)`
            : cur
              ? `(hiện: ${cur})`
              : "(đang trống)";
        output.write("\n");
        if (item.help) {
          for (const ln of wrapHelp(item.help, 56)) console.log(`  ${ln}`);
        }
        const nv = await readLineRaw(
          `  ${item.label} ${shown}\n  giá trị mới: `
        );
        if (input.isTTY) input.setRawMode(true);
        hideCursor();
        if (item.type === "secret" && nv === "") {
          // keep
        } else {
          let val = nv;
          if (item.path === "domains") {
            val = String(nv)
              .split(/[,;\s]+/)
              .map((s) => s.trim())
              .filter(Boolean);
          } else if (item.path === "workers") {
            val = Math.max(1, Math.min(8, parseInt(nv, 10) || 2));
          }
          setPath(cfg, item.path, val);
          saveConfig(cfg);
          dirty = false;
        }
        continue;
      }
    }
  } finally {
    showCursor();
    if (input.isTTY) {
      try {
        input.setRawMode(false);
      } catch {
        /* */
      }
    }
    output.write("\x1b[2J\x1b[H");
  }
}

function banner() {
  const c = loadConfig();
  let proxy = "tắt";
  if (c.proxy) proxy = String(c.proxy).split(":").slice(0, 2).join(":") + ":…";
  const on = (v) => (v ? "\x1b[32mBẬT\x1b[0m" : "\x1b[2mTẮT\x1b[0m");
  const doms = (c.domains || [c.domain]).filter(Boolean).join(", ") || "—";
  console.log(`
╔════════════════════════════════════════════╗
║     \x1b[1mReg Grok\x1b[0m  ·  multi + headless          ║
╚════════════════════════════════════════════╝
  Browser       ${c.headless ? "headless" : "Chrome USER :9222"}
  Domain        ${doms}
  Workers       ${c.workers || 2}   stock edu ${on(c.reuseUnusedEdu !== false)}
  Captcha       ${on(c.autoClickCaptcha !== false)}  9r ${on(c.nineRouter?.autoAuth)}
  Proxy         ${proxy}
  Kết quả       grok/acc/grok-latest.json
`);
}

function menu() {
  console.log(`  \x1b[1mReg\x1b[0m
  [1]  Reg ×1 — edu stock/mới
  [2]  Reg ×1 — reuse latest edu
  [3]  Multi — song song (workers)

  \x1b[1mCông cụ\x1b[0m
  [4]  Kiểm tra proxy
  [5]  Mở Chrome user + debug :9222
  [6]  9router — ping / device OAuth

  \x1b[1mHệ thống\x1b[0m
  [9]  Cấu hình  (Space bật/tắt)
  [0]  Thoát
`);
}

async function confirmCloseChrome() {
  console.log(`
⚠  Có thể:
   • Đóng HẾT Chrome nếu CDP chưa bật
   • Mở lại profile user + remote debugging :9222
   • Tab signup mới (Chrome giữ sau khi xong)
`);
  const a = (await ask("Tiếp tục? [y/N]: ")).toLowerCase();
  return a === "y" || a === "yes";
}

async function main() {
  async function pause() {
    await ask("\n[Enter] quay lại menu… ");
  }

  // lần đầu (configSeen ≠ true): ép mở cấu hình trước menu
  if (needsFirstConfig()) {
    console.log(`
╔══════════════════════════════════════╗
║  Lần đầu chạy — mở Cấu hình          ║
╚══════════════════════════════════════╝
  Chưa có thiết lập (hoặc configSeen=false).
  Xem từng mục, Space bật/tắt, Enter sửa.
  Bấm q khi xong → vào menu chính.
`);
    await ask("[Enter] mở cấu hình… ");
    await configScreen({ firstRun: true });
  }

  banner();
  for (;;) {
    ensureRl();
    menu();
    const c = await ask("Chọn: ");
    console.log("");
    if (c === "0" || c.toLowerCase() === "q") break;
    try {
      if (c === "1") {
        if (!(await confirmCloseChrome())) {
          console.log("Đã hủy.");
        } else {
          console.log("Reg ×1 fresh (Chrome USER) …\n");
          await runNode("reg-grok.mjs", ["--fresh", "--user-chrome", "--yes"]);
        }
      } else if (c === "2") {
        if (!(await confirmCloseChrome())) {
          console.log("Đã hủy.");
        } else {
          console.log("Reg ×1 reuse (Chrome USER) …\n");
          await runNode("reg-grok.mjs", ["--reuse", "--user-chrome", "--yes"]);
        }
      } else if (c === "3") {
        const cfg = loadConfig();
        const n = await ask("Count (số acc, Enter=3): ");
        const count = Math.max(1, parseInt(n || "3", 10) || 3);
        const wDef = String(cfg.workers || 2);
        const wIn = await ask(`Workers song song (Enter=${wDef}): `);
        const workers = Math.max(1, Math.min(8, parseInt(wIn || wDef, 10) || 2));
        const needChrome = !cfg.headless;
        if (needChrome && !(await confirmCloseChrome())) {
          console.log("Đã hủy.");
        } else {
          console.log(
            `\nMulti n=${count} w=${workers} ${cfg.headless ? "headless" : "chrome"} …\n`
          );
          await runNode("reg-multi.mjs", [
            "--count",
            String(count),
            "--workers",
            String(workers),
            "--yes",
            ...(cfg.headless ? ["--headless"] : []),
          ]);
        }
      } else if (c === "4") {
        await runNode("proxy.mjs", ["--test"]);
      } else if (c === "5") {
        closeRl();
        await new Promise((resolve, reject) => {
          const p = spawn("cmd.exe", ["/c", join(__dir, "chrome-user.bat")], {
            cwd: __dir,
            stdio: "inherit",
          });
          p.on("exit", () => resolve());
          p.on("error", reject);
        });
      } else if (c === "6") {
        const sub = await ask("a=ping 9router | b=device OAuth+wait+push: ");
        if (sub.toLowerCase() === "b") {
          await runNode("nine-router-auth.mjs", [
            "--device",
            "--wait",
            "--push",
          ]);
        } else {
          await runNode("nine-router-auth.mjs", ["--ping"]);
        }
      } else if (c === "9" || c.toLowerCase() === "c") {
        await configScreen();
        banner();
        continue; // no pause
      } else {
        console.log("Không hợp lệ. Mail → ..\\edu-menu.bat");
      }
    } catch (e) {
      console.error("[LỖI]", e.message || e);
    }
    await pause();
  }
  closeRl();
  console.log("Bye.");
  process.exit(0);
}

main();
