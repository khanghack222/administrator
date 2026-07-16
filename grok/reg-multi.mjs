#!/usr/bin/env node
/**
 * Multi reg Grok — song song N workers
 *
 *   node reg-multi.mjs --count 5
 *   node reg-multi.mjs -n 10 -w 3
 *   node reg-multi.mjs -n 5 --headless
 *
 * config.json: workers, headless, domains, reuseUnusedEdu, autoClickCaptcha
 * Kết quả: acc/grok-results.jsonl
 */
import { spawn } from "child_process";
import { mkdirSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : def;
};

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
const WORKERS = Math.max(
  1,
  Math.min(
    8,
    parseInt(flag("--workers", flag("-w", String(cfg.workers || 2))), 10) || 2
  )
);
const RETRIES = Math.max(
  0,
  Math.min(3, parseInt(flag("--retries", "1"), 10) || 0)
);
const HEADLESS =
  args.includes("--headless") ||
  process.env.GROK_HEADLESS === "1" ||
  cfg.headless === true;

const EXTRA = args.filter(
  (a, i, arr) =>
    ![
      "--count",
      "-n",
      "--workers",
      "-w",
      "--retries",
      "--no-proxy",
      "--headless",
    ].includes(a) &&
    !["--count", "-n", "--workers", "-w", "--retries"].includes(arr[i - 1])
);

function runOne(jobId, workerSlot) {
  return new Promise((resolve) => {
    const childArgs = [
      join(__dir, "reg-grok.mjs"),
      "--fresh",
      "--yes",
      "--auto-close",
      "--worker",
      String(workerSlot),
      ...(HEADLESS ? ["--headless", "--playwright"] : ["--user-chrome"]),
      ...EXTRA,
    ];
    console.log(
      `\n══ JOB ${jobId}/${COUNT}  W${workerSlot} ${HEADLESS ? "headless" : "chrome"} ══`
    );
    const child = spawn(process.execPath, childArgs, {
      cwd: __dir,
      stdio: "inherit",
      env: {
        ...process.env,
        GROK_YES: "1",
        GROK_WORKER: String(workerSlot),
        ...(HEADLESS ? { GROK_HEADLESS: "1", GROK_PLAYWRIGHT: "1" } : {}),
      },
    });
    child.on("exit", (code) => {
      resolve({ jobId, workerSlot, code: code ?? 1, ok: code === 0 });
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
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    last = await runOne(jobId, workerSlot);
    if (last.ok) return { ...last, attempts: attempt + 1 };
  }
  return { ...last, attempts: RETRIES + 1 };
}

async function main() {
  mkdirSync(join(__dir, "acc"), { recursive: true });
  console.log(`
══ REG MULTI ══
count   : ${COUNT}
workers : ${WORKERS} (song song)
retries : ${RETRIES} / job
mode    : ${HEADLESS ? "headless Playwright" : "Chrome USER CDP"}
domains : ${(cfg.domains || [cfg.domain]).filter(Boolean).join(", ") || "—"}
stock   : ${cfg.reuseUnusedEdu === false ? "tắt" : "dùng edu cũ chưa reg"}
extra   : ${EXTRA.join(" ") || "(none)"}
`);

  const results = [];
  let next = 1;
  const slots = Array.from({ length: Math.min(WORKERS, COUNT) }, (_, i) =>
    (async () => {
      const slot = i + 1;
      while (true) {
        const jobId = next++;
        if (jobId > COUNT) break;
        results.push(await runJobWithRetry(jobId, slot));
      }
    })()
  );
  await Promise.all(slots);

  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  console.log(`
══ DONE ══
OK   : ${ok}
FAIL : ${fail}
log  : acc/grok-results.jsonl
`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
