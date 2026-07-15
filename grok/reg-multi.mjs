#!/usr/bin/env node
/**
 * Multi reg Grok — pool workers (mỗi worker = 1 process reg-grok)
 *
 *   node reg-multi.mjs --count 5 --workers 2
 *   node reg-multi.mjs -n 10 -w 3 --fresh
 *   node reg-multi.mjs -n 4 -w 2 --no-proxy
 *
 * Proxy: round-robin proxies.txt (1 proxy / job nếu có)
 * Kết quả: acc/grok-results.jsonl
 */
import { spawn } from "child_process";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadProxyLines, parseProxyLine, testProxy } from "./proxy.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : def;
};
const COUNT = Math.max(1, parseInt(flag("--count", flag("-n", "1")), 10) || 1);
const WORKERS = Math.max(
  1,
  Math.min(8, parseInt(flag("--workers", flag("-w", "2")), 10) || 2)
);
const NO_PROXY = args.includes("--no-proxy");
const EXTRA = args.filter(
  (a, i, arr) =>
    ![
      "--count",
      "-n",
      "--workers",
      "-w",
      "--no-proxy",
    ].includes(a) &&
    !["--count", "-n", "--workers", "-w"].includes(arr[i - 1])
);

function loadLiveProxies() {
  if (NO_PROXY) return [];
  const list = loadProxyLines();
  const cfgP = join(__dir, "config.json");
  if (existsSync(cfgP)) {
    try {
      const c = JSON.parse(readFileSync(cfgP, "utf8"));
      if (c.proxy) {
        const p = parseProxyLine(c.proxy);
        if (p) list.unshift(p);
      }
    } catch {
      /* */
    }
  }
  const live = [];
  const seen = new Set();
  for (const p of list) {
    const k = p.server + (p.username || "");
    if (seen.has(k)) continue;
    seen.add(k);
    process.stdout.write(`[proxy] test ${p.server} … `);
    const ip = testProxy(p);
    if (ip) {
      console.log(`OK ${ip}`);
      live.push({ ...p, exitIp: ip });
    } else console.log("FAIL");
  }
  return live;
}

function runOne(jobId, workerSlot, proxyRaw) {
  return new Promise((resolve) => {
    const childArgs = [
      join(__dir, "reg-grok.mjs"),
      "--fresh",
      "--auto-close",
      "--worker",
      String(workerSlot),
      ...EXTRA,
    ];
    if (proxyRaw) {
      childArgs.push("--proxy", proxyRaw);
    } else if (NO_PROXY) {
      childArgs.push("--no-proxy");
    }

    console.log(
      `\n══ JOB ${jobId}/${COUNT}  worker-slot=${workerSlot}  proxy=${proxyRaw || "default"} ══`
    );
    const child = spawn(process.execPath, childArgs, {
      cwd: __dir,
      stdio: "inherit",
      env: { ...process.env, GROK_WORKER: String(workerSlot) },
    });
    child.on("exit", (code) => {
      resolve({
        jobId,
        workerSlot,
        code: code ?? 1,
        ok: code === 0,
      });
    });
    child.on("error", (e) => {
      resolve({ jobId, workerSlot, code: 1, ok: false, error: e.message });
    });
  });
}

async function pool(jobs, concurrency, run) {
  const results = [];
  let i = 0;
  async function worker(slot) {
    while (i < jobs.length) {
      const idx = i++;
      const r = await run(jobs[idx], slot);
      results.push(r);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, (_, s) =>
      worker(s + 1)
    )
  );
  return results;
}

async function main() {
  mkdirSync(join(__dir, "acc"), { recursive: true });
  console.log(`
══ REG MULTI ══
count   : ${COUNT}
workers : ${WORKERS} (song song)
extra   : ${EXTRA.join(" ") || "(none)"}
`);

  const proxies = loadLiveProxies();
  console.log(`proxy live: ${proxies.length}`);

  const jobs = Array.from({ length: COUNT }, (_, i) => i + 1);
  let proxyIdx = 0;

  const results = await pool(jobs, WORKERS, async (jobId, slot) => {
    let proxyRaw = null;
    if (proxies.length) {
      proxyRaw = proxies[proxyIdx % proxies.length].raw;
      proxyIdx++;
    }
    return runOne(jobId, slot, proxyRaw);
  });

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
