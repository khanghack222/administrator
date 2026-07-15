/**
 * Proxy helpers
 * Format dòng: host:port:user:pass  hoặc  http://user:pass@host:port
 *
 *   node proxy.mjs --test
 *   node proxy.mjs --pick
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dir = dirname(fileURLToPath(import.meta.url));
export const PROXIES_FILE = join(__dir, "proxies.txt");

export function parseProxyLine(line) {
  const s = String(line || "").trim();
  if (!s || s.startsWith("#")) return null;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return {
        server: `${u.protocol}//${u.hostname}:${u.port || (u.protocol === "https:" ? 443 : 80)}`,
        username: decodeURIComponent(u.username || ""),
        password: decodeURIComponent(u.password || ""),
        url: s.replace(/\/$/, ""),
        raw: s,
      };
    } catch {
      return null;
    }
  }
  // host:port:user:pass
  const parts = s.split(":");
  if (parts.length < 2) return null;
  const [host, port, user, pass] = parts;
  if (!host || !port) return null;
  const username = user || "";
  const password = parts.slice(3).join(":") || pass || "";
  const url =
    username || password
      ? `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`
      : `http://${host}:${port}`;
  return {
    server: `http://${host}:${port}`,
    username,
    password,
    url,
    raw: s,
    host,
    port,
  };
}

export function loadProxyLines(file = PROXIES_FILE) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map(parseProxyLine)
    .filter(Boolean);
}

export function loadConfigProxy() {
  const p = join(__dir, "config.json");
  if (!existsSync(p)) return null;
  try {
    const c = JSON.parse(readFileSync(p, "utf8"));
    if (c.proxy) return parseProxyLine(c.proxy);
  } catch {
    /* */
  }
  return null;
}

/** curl -x test → ip string or null */
export function testProxy(proxy, { timeoutSec = 12 } = {}) {
  if (!proxy?.url) return null;
  try {
    const out = execFileSync(
      "curl.exe",
      [
        "-sS",
        "--connect-timeout",
        String(Math.min(8, timeoutSec)),
        "--max-time",
        String(timeoutSec),
        "-x",
        proxy.url,
        "https://api.ipify.org",
      ],
      { encoding: "utf8", timeout: (timeoutSec + 2) * 1000 }
    ).trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(out)) return out;
    return null;
  } catch {
    return null;
  }
}

/** Pick first live from config.proxy → proxies.txt */
export function pickLiveProxy({
  prefer,
  file = PROXIES_FILE,
  log = console.log,
} = {}) {
  const list = [];
  if (prefer) {
    const p = typeof prefer === "string" ? parseProxyLine(prefer) : prefer;
    if (p) list.push(p);
  }
  const cfg = loadConfigProxy();
  if (cfg) list.push(cfg);
  for (const p of loadProxyLines(file)) list.push(p);

  const seen = new Set();
  for (const p of list) {
    const key = p.server + (p.username || "");
    if (seen.has(key)) continue;
    seen.add(key);
    log(`[proxy] test ${p.server} …`);
    const ip = testProxy(p);
    if (ip) {
      log(`[proxy] OK ${p.server} → ${ip}`);
      return { ...p, exitIp: ip };
    }
    log(`[proxy] FAIL ${p.server}`);
  }
  return null;
}

/** Playwright proxy option */
export function toPlaywrightProxy(p) {
  if (!p) return undefined;
  const opt = { server: p.server };
  if (p.username) opt.username = p.username;
  if (p.password) opt.password = p.password;
  return opt;
}

// CLI
if (process.argv[1]?.includes("proxy")) {
  const args = process.argv.slice(2);
  if (args.includes("--test") || args.includes("--pick") || args.length === 0) {
    const list = loadProxyLines();
    console.log(`proxies.txt: ${list.length} dòng`);
    let ok = 0;
    for (const p of list) {
      const ip = testProxy(p);
      console.log(`${ip ? "OK  " : "FAIL"} ${p.server} ${ip || ""}`);
      if (ip) ok++;
    }
    console.log(`live ${ok}/${list.length}`);
    if (args.includes("--pick")) {
      const live = pickLiveProxy({ log: () => {} });
      if (live) {
        console.log("\nPICK", live.url, "ip", live.exitIp);
        const cfgPath = join(__dir, "config.json");
        const cfg = existsSync(cfgPath)
          ? JSON.parse(readFileSync(cfgPath, "utf8"))
          : {};
        cfg.proxy = live.raw || live.url;
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
        console.log("saved config.proxy");
      }
    }
  }
}
