#!/usr/bin/env node
import { createInterface } from "readline";
import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { execFile, spawn } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));
const userScript = join(__dir, "byesu-autofill.user.js");
const regScript = join(__dir, "reg-byesu.mjs");
const profileDir = join(__dir, ".pw-byesu-profile");
const signupUrl = "https://byesu.com/sign-up";

const ask = (question) =>
  new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || "").trim());
    });
  });

function runReg(extraArgs = []) {
  return new Promise((resolve) => {
    // Mặc định CDP Chrome thật — không --playwright/--headless
    const child = spawn(process.execPath, [regScript, "--yes", ...extraArgs], {
      cwd: join(__dir, ".."),
      stdio: "inherit",
    });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}

function chromeExe() {
  const local = process.env.LOCALAPPDATA || "";
  const paths = [
    join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    join(local, "Google", "Chrome", "Application", "chrome.exe"),
  ];
  return paths.find((p) => existsSync(p)) || "chrome.exe";
}

async function cdpAlive(cdp) {
  return fetch(`${cdp}/json/version`)
    .then((r) => r.ok)
    .catch(() => false);
}

async function startChrome(port) {
  const cdp = `http://127.0.0.1:${port}`;
  if (await cdpAlive(cdp)) return cdp;
  if (!existsSync(profileDir)) {
    const parent = dirname(profileDir);
    if (!existsSync(parent)) throw new Error(`Thiếu thư mục: ${parent}`);
  }
  const child = execFile(
    chromeExe(),
    [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      signupUrl,
    ],
    { windowsHide: true }
  );
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (await cdpAlive(cdp)) return cdp;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome CDP timeout: ${cdp}`);
}

async function jsMode() {
  console.log(`
[1] JS / Tampermonkey
File: ${userScript}
URL : ${signupUrl}

Tampermonkey → Create new script → paste file → Save.
Mở URL, panel ByesU tự hiện.
`);
  await ask("[Enter] quay lại… ");
}

function cdpCall(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Date.now() * 1000 + Math.random() * 1000);
    const onMessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id !== id) return;
      ws.removeEventListener("message", onMessage);
      if (data.error) reject(new Error(data.error.message || JSON.stringify(data.error)));
      else resolve(data.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function getByesuTarget(cdp) {
  let tabs = await fetch(`${cdp}/json`).then((r) => r.json());
  let target = tabs.find((t) => t.type === "page" && /byesu\.com/i.test(t.url || ""));
  if (target) return target;
  const created = await fetch(`${cdp}/json/new?${encodeURIComponent(signupUrl)}`, {
    method: "PUT",
  }).then((r) => r.json());
  if (created?.webSocketDebuggerUrl) return created;
  tabs = await fetch(`${cdp}/json`).then((r) => r.json());
  return tabs.find((t) => t.type === "page");
}

async function waitPageReady(ws) {
  for (let i = 0; i < 60; i++) {
    const result = await cdpCall(ws, "Runtime.evaluate", {
      expression: "document.readyState !== 'loading' && !!document.body",
      returnByValue: true,
    }).catch(() => null);
    if (result?.result?.value === true) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("ByesU page load timeout");
}

async function injectHelper(ws) {
  const source = readFileSync(userScript, "utf8");
  const result = await cdpCall(ws, "Runtime.evaluate", {
    expression: `${source}\n//# sourceURL=byesu-autofill.user.js`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "Inject helper failed");
  }
  const panel = await cdpCall(ws, "Runtime.evaluate", {
    expression: "Boolean(document.querySelector('#byesu-autofill-panel'))",
    returnByValue: true,
  });
  if (panel?.result?.value !== true) throw new Error("Helper injected nhưng không thấy panel");
}

async function cdpMode() {
  const port = (await ask("CDP port [9222]: ")) || "9222";
  const cdp = await startChrome(port);
  const target = await getByesuTarget(cdp);
  if (!target?.webSocketDebuggerUrl) throw new Error("Không lấy được tab CDP.");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  await cdpCall(ws, "Page.enable").catch(() => {});
  await cdpCall(ws, "Runtime.enable").catch(() => {});
  await cdpCall(ws, "Page.bringToFront").catch(() => {});
  await waitPageReady(ws);
  await injectHelper(ws);
  ws.close();
  console.log(`Đã mở + nạp helper: ${signupUrl}`);
  await ask("[Enter] quay lại… ");
}

const GROUPS = [
  "Openai Codex",
  "Grok",
  "Gemini Business",
  "Claude Max",
];

async function pickGroup() {
  console.log(`
  Group:
  [1] Openai Codex
  [2] Grok          (mặc định)
  [3] Gemini Business
  [4] Claude Max
`);
  const a = (await ask("Chọn group [2]: ")) || "2";
  if (/^[1-4]$/.test(a)) return GROUPS[Number(a) - 1];
  const hit = GROUPS.find((g) => g.toLowerCase() === a.toLowerCase());
  if (hit) return hit;
  const partial = GROUPS.find((g) => g.toLowerCase().includes(a.toLowerCase()));
  return partial || "Grok";
}

async function autoOnce() {
  const group = await pickGroup();
  console.log(`Auto reg 1 acc + key group=${group}…\n`);
  await runReg(["--group", group]);
  await ask("[Enter] quay lại… ");
}

async function autoMulti() {
  const n = (await ask("Số lượt [4]: ")) || "4";
  const group = await pickGroup();
  console.log("Multi tuần tự (1 Chrome, nối tiếp).");
  const multi = join(__dir, "reg-multi.mjs");
  const extra = [
    "--count",
    String(Math.max(1, Math.min(20, Number(n) || 4))),
    "--group",
    group,
  ];
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [multi, ...extra], {
      cwd: join(__dir, ".."),
      stdio: "inherit",
    });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
  await ask("[Enter] quay lại… ");
}

async function main() {
  if (!existsSync(userScript)) throw new Error(`Thiếu file: ${userScript}`);
  if (!existsSync(regScript)) throw new Error(`Thiếu file: ${regScript}`);
  for (;;) {
    console.log(`
╔══════════════════════════════════════╗
║             BYESU MENU               ║
╚══════════════════════════════════════╝

  [1] Auto reg 1 acc
  [2] Auto reg nhiều lượt
  [3] Test API keys (xóa hết quota)
  [4] JS  — Tampermonkey userscript
  [5] CDP — mở Chrome + nạp helper (thủ công)
  [0] Thoát
`);
    const choice = await ask("Chọn: ");
    if (choice === "0" || choice.toLowerCase() === "q") return;
    if (choice === "1") await autoOnce();
    else if (choice === "2") await autoMulti();
    else if (choice === "3") {
      const tw = (await ask("Workers test keys [4]: ")) || "4";
      await new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [join(__dir, "test-keys.mjs"), "-w", String(tw)],
          { cwd: join(__dir, ".."), stdio: "inherit" }
        );
        child.on("exit", () => resolve());
        child.on("error", () => resolve());
      });
      await ask("[Enter] quay lại… ");
    } else if (choice === "4") await jsMode();
    else if (choice === "5") await cdpMode();
    else console.log("Lựa chọn không hợp lệ.");
  }
}

main().catch((e) => {
  console.error("[LỖI]", e.message || e);
  process.exit(1);
});
