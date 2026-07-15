/**
 * NopeCHA automation extension for Playwright
 *   node nopecha.mjs --setup          # tải chromium_automation.zip
 *   node nopecha.mjs --key YOUR_KEY   # ghi key vào manifest + config
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

export const __dir = dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = join(__dir, "ext");
export const MANIFEST = join(EXT_DIR, "manifest.json");
const ZIP_URL =
  "https://github.com/NopeCHALLC/nopecha-extension/releases/download/0.6.1/chromium_automation.zip";

export function loadConfig() {
  const p = join(__dir, "config.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

export function saveConfig(cfg) {
  writeFileSync(join(__dir, "config.json"), JSON.stringify(cfg, null, 2));
}

export function resolveNopechaKey(cliKey) {
  if (cliKey) return String(cliKey).trim();
  if (process.env.NOPECHA_KEY) return process.env.NOPECHA_KEY.trim();
  const cfg = loadConfig();
  return String(cfg.nopechaKey || cfg.nopecha?.key || "").trim();
}

/** Ghi key + bật captcha types vào ext/manifest.json */
export function applyNopechaKey(key) {
  if (!existsSync(MANIFEST)) {
    throw new Error(`Thiếu ${MANIFEST} — chạy: node nopecha.mjs --setup`);
  }
  const man = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const n = man.nopecha || {};
  n.key = key || "";
  n.enabled = true;
  n.recaptcha_auto_open = true;
  n.recaptcha_auto_solve = true;
  n.hcaptcha_auto_open = true;
  n.hcaptcha_auto_solve = true;
  n.turnstile_auto_solve = true;
  n.funcaptcha_auto_open = true;
  n.funcaptcha_auto_solve = true;
  n.awscaptcha_auto_open = true;
  n.awscaptcha_auto_solve = true;
  man.nopecha = n;
  writeFileSync(MANIFEST, JSON.stringify(man, null, 2));
  return man;
}

export function ensureExtension(key) {
  if (!existsSync(MANIFEST)) {
    throw new Error(
      "NopeCHA ext chưa có. Chạy: node nopecha.mjs --setup\n" +
        "Hoặc tải chromium_automation.zip → giải nén vào folder ext/"
    );
  }
  if (key) applyNopechaKey(key);
  const man = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (!man.nopecha?.key) {
    console.warn(
      "[nopecha] key trống — free/limit theo IP. Set config.nopechaKey hoặc --nopecha KEY"
    );
  } else {
    console.log(
      `[nopecha] key …${String(man.nopecha.key).slice(-4)}  ext=${EXT_DIR}`
    );
  }
  return EXT_DIR;
}

/** Launch args cho chromium.launchPersistentContext / launch */
export function extensionLaunchOptions({ key, headless = false } = {}) {
  const k = resolveNopechaKey(key);
  const path = ensureExtension(k);
  // Extension cần headed Chromium (không headless shell)
  if (headless) {
    console.warn("[nopecha] extension cần headed — bỏ --headless");
  }
  return {
    headless: false,
    args: [
      `--disable-extensions-except=${path}`,
      `--load-extension=${path}`,
      "--disable-blink-features=AutomationControlled",
    ],
    EXT_DIR: path,
  };
}

async function downloadZip(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

function unzipWindows(zip, dest) {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  // PowerShell Expand-Archive
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: "inherit" }
  );
}

async function setup() {
  const tmp = join(__dir, "chromium_automation.zip");
  console.log("[nopecha] download", ZIP_URL);
  await downloadZip(ZIP_URL, tmp);
  console.log("[nopecha] unzip →", EXT_DIR);
  unzipWindows(tmp, EXT_DIR);
  // nested folder?
  if (!existsSync(MANIFEST)) {
    const sub = readdirSync(EXT_DIR, { withFileTypes: true }).find(
      (d) => d.isDirectory()
    );
    if (sub && existsSync(join(EXT_DIR, sub.name, "manifest.json"))) {
      // move up — rare
      console.log("[nopecha] nested", sub.name);
    }
  }
  if (!existsSync(MANIFEST)) throw new Error("manifest.json not found after unzip");
  const key = resolveNopechaKey(null);
  if (key) applyNopechaKey(key);
  console.log("[nopecha] OK", EXT_DIR);
}

// CLI
const args = process.argv.slice(2);
if (args.includes("--setup") || args.includes("--key") || process.argv[1]?.includes("nopecha")) {
  const isMain = process.argv[1]?.includes("nopecha");
  if (!isMain) {
    /* imported */
  } else {
    const i = args.indexOf("--key");
    const key = i >= 0 ? args[i + 1] : null;
    if (args.includes("--setup")) {
      await setup();
    }
    if (key) {
      applyNopechaKey(key);
      const cfg = loadConfig();
      cfg.nopechaKey = key;
      saveConfig(cfg);
      console.log("[nopecha] key saved → config.json + manifest");
    }
    if (!args.includes("--setup") && !key) {
      console.log(`Usage:
  node nopecha.mjs --setup
  node nopecha.mjs --key YOUR_NOPECHA_KEY
  # hoặc env NOPECHA_KEY / config.nopechaKey`);
    }
  }
}
