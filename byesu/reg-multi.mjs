#!/usr/bin/env node
/**
 * Multi reg ByesU — CDP only, mỗi worker Chrome profile + port riêng
 *
 *   node byesu/reg-multi.mjs -n 6 -w 2 --group Grok
 *   npm run byesu:multi -- -n 4 -w 2
 *
 * Worker W → port 9222+W, profile .pw-byesu-wW
 * 429: bật VPN / proxy trong từng Chrome profile
 */
import { spawn } from "child_process";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : def;
};
const HAS = (n) => args.includes(n);

function loadCfg() {
  const p = join(__dir, "config.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

const cfg = loadCfg();
const COUNT = Math.max(1, parseInt(flag("--count", flag("-n", "1")), 10) || 1);
const WORKERS = 1; // tuần tự - không đa luồng
const RETRIES = Math.max(
  0,
  Math.min(2, parseInt(flag("--retries", "1"), 10) || 1)
);
const GROUP = flag("--group", cfg.byesu?.group || "Grok");
const STAGGER_MS = 0;
const CDP_BASE = 9222;

const PASS_THROUGH = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (
    [
      "--count",
      "-n",
      "--workers",
      "-w",
      "--retries",
      "--stagger",
      "--group",
      "--headless",
      "--playwright",
      "--pw",
    ].includes(a)
  ) {
    if (
      ["--count", "-n", "--workers", "-w", "--retries", "--stagger", "--group"].includes(
        a
      )
    )
      i++;
    continue;
  }
  PASS_THROUGH.push(a);
}

function runOne(jobId, workerSlot) {
  return new Promise((resolve) => {
    const port = CDP_BASE + workerSlot;
    const childArgs = [
      join(__dir, "reg-byesu.mjs"),
      "--yes",
      "--count",
      "1",
      "--group",
      GROUP,
      "--worker",
      String(workerSlot),
      "--job",
      String(jobId),
      "--port",
      String(port),
      ...PASS_THROUGH,
    ];
    console.log(
      `\n══ JOB ${jobId}/${COUNT}  W${workerSlot}  CDP :${port}  group=${GROUP} ══`
    );
    const child = spawn(process.execPath, childArgs, {
      cwd: join(__dir, ".."),
      stdio: "inherit",
      env: {
        ...process.env,
        BYESU_YES: "1",
        BYESU_WORKER: String(workerSlot),
        BYESU_JOB: String(jobId),
        BYESU_CDP_PORT: String(port),
      },
    });
    child.on("exit", (code) => {
      resolve({
        jobId,
        workerSlot,
        port,
        code: code ?? 1,
        ok: code === 0,
      });
    });
    child.on("error", (e) => {
      resolve({
        jobId,
        workerSlot,
        code: 1,
        ok: false,
        error: e.message,
      });
    });
  });
}

async function runJobWithRetry(jobId, workerSlot) {
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`\n↻ RETRY job ${jobId} attempt ${attempt}/${RETRIES}`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
    last = await runOne(jobId, workerSlot);
    if (last.ok) return { ...last, attempts: attempt + 1 };
  }
  return { ...last, attempts: RETRIES + 1 };
}

async function main() {
  mkdirSync(join(__dir, "acc"), { recursive: true });
  mkdirSync(join(__dir, "keys"), { recursive: true });

  console.log(`
╔══════════════════════════════════════╗
║   BYESU MULTI REG (tuần tự CDP)      ║
╚══════════════════════════════════════╝
  jobs     ${COUNT}
  mode     tuần tự (1 Chrome)
  group    ${GROUP}
  retries  ${RETRIES}
  CDP      port ${CDP_BASE + 1}  profile .pw-byesu-w1
  429      VPN / proxy trong Chrome profile
`);

  const results = [];
  for (let jobId = 1; jobId <= COUNT; jobId++) {
    const r = await runJobWithRetry(jobId, 1);
    results.push(r);
    console.log(
      r.ok
        ? `✓ job ${jobId} OK (CDP :${CDP_BASE + 1})`
        : `✗ job ${jobId} FAIL code=${r.code}`
    );
    if (jobId < COUNT) await new Promise((r) => setTimeout(r, 2000));
  }

  const okN = results.filter((r) => r.ok).length;
  writeFileSync(
    join(__dir, "acc", "byesu-multi-last.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        count: COUNT,
        workers: WORKERS,
        group: GROUP,
        mode: "cdp-only",
        ok: okN,
        fail: results.length - okN,
        results,
      },
      null,
      2
    )
  );

  console.log(`
══════════════════════════════════════
  Kết quả multi (tuần tự): ${okN}/${results.length} OK
  group=${GROUP}
══════════════════════════════════════
`);
  process.exit(okN === results.length ? 0 : 2);
}

main().catch((e) => {
  console.error("[LỖI]", e.message || e);
  process.exit(1);
});
