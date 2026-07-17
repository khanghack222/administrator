#!/usr/bin/env node
/**
 * Test all API keys in byesu/keys/*.txt
 * Hết quota / invalid → xóa khỏi danh sách (ghi vào keys/dead/)
 *
 *   node byesu/test-keys.mjs
 *   node byesu/test-keys.mjs --group Grok
 *   node byesu/test-keys.mjs --dry   # không xóa
 *   node byesu/test-keys.mjs --keep-soft  # 429/503 không xóa (mặc định)
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  appendFileSync,
} from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = join(__dir, "keys");
const DEAD_DIR = join(KEYS_DIR, "dead");
/** ByesU UI:
 *  OpenAI / Codex → https://byesu.com/v1
 *  Claude / Gemini → https://byesu.com  (cũng thử /v1)
 */
const HOST = "https://byesu.com";
const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const HAS = (n) => args.includes(n);
const DRY = HAS("--dry");
const GROUP_FILTER = flag("--group", null);
const CONCURRENCY = Math.max(
  1,
  Math.min(12, Number(flag("--workers", flag("-w", "4"))) || 4)
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/** Model mặc định theo group (file name) */
const GROUP_MODELS = {
  grok: ["grok-3-mini", "grok-latest", "grok-4.3"],
  "claude max": [
    "claude-sonnet-4",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-sonnet",
    "claude-3-opus",
  ],
  "openai codex": ["gpt-4o-mini", "gpt-4o", "o4-mini", "codex-mini"],
  "gemini business": [
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-2.5-flash",
  ],
};

/** Base URL theo group (UI ByesU) */
function basesForGroup(group) {
  const g = String(group || "").toLowerCase();
  // OpenAI / Codex / Grok → /v1
  if (/openai|codex|grok/.test(g)) {
    return [`${HOST}/v1`, HOST];
  }
  // Claude / Gemini → host trước, rồi /v1
  if (/claude|gemini/.test(g)) {
    return [HOST, `${HOST}/v1`];
  }
  return [`${HOST}/v1`, HOST];
}

function parseGroupFromFile(name) {
  // "api key grok.txt" → "grok"
  const m = String(name)
    .toLowerCase()
    .match(/^api key (.+)\.txt$/i);
  return m ? m[1].trim() : null;
}

function loadKeys(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("sk-"));
}

function writeKeys(file, keys) {
  writeFileSync(file, keys.map((k) => k + "\n").join(""), "utf8");
}

async function listModels(key, base) {
  const url = `${base.replace(/\/$/, "")}/models`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: r.status, json, text: text.slice(0, 300), base };
}

async function chatTest(key, model, base) {
  const url = `${base.replace(/\/$/, "")}/chat/completions`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "1+1=?" }],
      max_tokens: 5,
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: r.status, json, text: text.slice(0, 400), base };
}

function classify(status, json, text) {
  const blob = JSON.stringify(json || {}) + " " + (text || "");
  const low = blob.toLowerCase();

  if (status === 200 && (json?.choices || json?.data)) {
    return { ok: true, reason: "ok", dead: false };
  }
  // dead: invalid / disabled / quota
  if (
    status === 401 ||
    /invalid.?api.?key|incorrect api key|authentication|unauthorized/i.test(blob)
  ) {
    return { ok: false, reason: "invalid_key", dead: true };
  }
  if (
    status === 402 ||
    /insufficient.?quota|quota.?exceeded|no.?quota|余额不足|额度|balance|pre-?consumed|user.?quota|剩余/i.test(
      low
    )
  ) {
    return { ok: false, reason: "quota_exhausted", dead: true };
  }
  if (/disabled|banned|suspended|forbidden|access.?denied/i.test(low) && status === 403) {
    return { ok: false, reason: "disabled", dead: true };
  }
  // soft: keep key
  if (status === 429 || /rate.?limit|too many/i.test(low)) {
    return { ok: false, reason: "rate_limit", dead: false };
  }
  if (
    status === 503 ||
    /no available channel|model_not_found|distributor/i.test(low)
  ) {
    return { ok: false, reason: "no_channel", dead: false };
  }
  if (status >= 500) {
    return { ok: false, reason: `server_${status}`, dead: false };
  }
  return { ok: false, reason: `fail_${status}`, dead: false };
}

async function pickModelAndBase(key, group) {
  const preferred = GROUP_MODELS[group] || ["grok-3-mini"];
  const bases = basesForGroup(group);
  let last = null;
  for (const base of bases) {
    const m = await listModels(key, base);
    last = m;
    if (m.status === 401 || /invalid.?api.?key/i.test(m.text)) {
      return {
        model: null,
        base,
        modelsRes: m,
        early: classify(m.status, m.json, m.text),
      };
    }
    if (m.status !== 200) continue;
    const ids = (m.json?.data || []).map((x) => x.id).filter(Boolean);
    if (!ids.length) continue;
    for (const p of preferred) {
      if (ids.includes(p)) return { model: p, base, modelsRes: m, early: null };
    }
    for (const p of preferred) {
      const head = p.split("-")[0].toLowerCase();
      const hit = ids.find((id) => id.toLowerCase().includes(head));
      if (hit) return { model: hit, base, modelsRes: m, early: null };
    }
    return { model: ids[0], base, modelsRes: m, early: null };
  }
  return {
    model: preferred[0],
    base: bases[0],
    modelsRes: last,
    early: last
      ? classify(last.status, last.json, last.text)
      : { ok: false, reason: "no_base", dead: false },
  };
}

async function testOne(key, group) {
  const short = key.slice(0, 12) + "…";
  const { model, base, modelsRes, early } = await pickModelAndBase(key, group);
  if (early?.dead || (early && !early.ok && early.reason === "invalid_key")) {
    return {
      key,
      short,
      group,
      model: null,
      base,
      ...early,
      detail: modelsRes?.text || "",
    };
  }
  if (!model) {
    return {
      key,
      short,
      group,
      model: null,
      base,
      ok: false,
      reason: "no_model",
      dead: false,
      detail: modelsRes?.text || "",
    };
  }
  const chat = await chatTest(key, model, base);
  const c = classify(chat.status, chat.json, chat.text);
  return {
    key,
    short,
    group,
    model,
    base,
    ...c,
    detail: c.ok
      ? (chat.json?.choices?.[0]?.message?.content || "ok").slice(0, 40)
      : chat.text.slice(0, 120),
  };
}

function listKeyFiles() {
  if (!existsSync(KEYS_DIR)) return [];
  return readdirSync(KEYS_DIR)
    .filter((f) => /^api key .+\.txt$/i.test(f))
    .map((f) => ({
      file: f,
      path: join(KEYS_DIR, f),
      group: parseGroupFromFile(f),
    }))
    .filter((x) => x.group)
    .filter((x) => {
      if (!GROUP_FILTER) return true;
      return x.group.includes(String(GROUP_FILTER).toLowerCase());
    });
}

function archiveDead(group, keys) {
  if (!keys.length) return;
  mkdirSync(DEAD_DIR, { recursive: true });
  const deadFile = join(DEAD_DIR, `api key ${group}.txt`);
  const stamp = new Date().toISOString();
  for (const k of keys) {
    appendFileSync(deadFile, `${k}  # ${stamp}\n`, "utf8");
  }
}

/** Pool song song — tối đa `limit` promise cùng lúc */
async function mapPool(items, limit, fn) {
  const ret = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return ret;
}

async function main() {
  const files = listKeyFiles();
  if (!files.length) {
    console.error("Không có file keys/api key *.txt");
    process.exit(1);
  }

  console.log(C.bold("ByesU test API keys"));
  console.log(C.dim("OpenAI/Codex/Grok → https://byesu.com/v1"));
  console.log(C.dim("Claude/Gemini     → https://byesu.com (+ /v1 fallback)"));
  console.log(C.dim(`workers ${CONCURRENCY} (song song)`));
  console.log(C.dim(DRY ? "DRY-RUN (không xóa)" : "hết quota/invalid → xóa + keys/dead/"));
  console.log("");

  let total = 0;
  let okN = 0;
  let deadN = 0;
  let softN = 0;

  for (const { file, path, group } of files) {
    const keys = loadKeys(path);
    if (!keys.length) {
      console.log(C.dim(`[${group}] empty ${file}`));
      continue;
    }
    console.log(C.bold(`── ${file} (${keys.length}) workers=${CONCURRENCY} ──`));

    const results = await mapPool(keys, CONCURRENCY, async (key, idx) => {
      try {
        const r = await testOne(key, group);
        return { ...r, idx };
      } catch (e) {
        return {
          key,
          short: key.slice(0, 12) + "…",
          group,
          ok: false,
          reason: "error",
          dead: false,
          detail: String(e.message || e).slice(0, 80),
          idx,
        };
      }
    });

    // in theo thứ tự file
    results.sort((a, b) => a.idx - b.idx);
    const keep = [];
    const dead = [];
    for (const r of results) {
      total++;
      const tag = `[${r.idx + 1}/${keys.length}] ${r.key.slice(0, 14)}…`;
      if (r.ok) {
        okN++;
        keep.push(r.key);
        console.log(
          C.dim(tag) +
            " " +
            C.green("OK") +
            ` ${C.dim(r.base || "")} model=${r.model} ${C.dim(r.detail)}`
        );
      } else if (r.dead) {
        deadN++;
        dead.push(r.key);
        console.log(
          C.dim(tag) + " " + C.red(`DEAD ${r.reason}`) + ` ${C.dim(r.detail)}`
        );
      } else {
        softN++;
        keep.push(r.key);
        console.log(
          C.dim(tag) +
            " " +
            C.yellow(`SOFT ${r.reason}`) +
            ` ${C.dim(r.detail)}`
        );
      }
    }

    if (dead.length && !DRY) {
      archiveDead(group, dead);
      writeKeys(path, keep);
      console.log(
        C.red(`  −${dead.length} dead`) +
          C.dim(` → keys/dead/api key ${group}.txt`) +
          `  remain ${keep.length}`
      );
    } else if (dead.length && DRY) {
      console.log(
        C.yellow(`  [dry] would remove ${dead.length}, remain ${keep.length}`)
      );
    } else {
      console.log(C.dim(`  remain ${keep.length}`));
    }
    console.log("");
  }

  console.log(C.bold("Tổng"));
  console.log(
    `  total ${total}  ${C.green("ok " + okN)}  ${C.red("dead " + deadN)}  ${C.yellow("soft " + softN)}`
  );
  process.exit(deadN > 0 && okN === 0 ? 2 : 0);
}

main().catch((e) => {
  console.error("[LỖI]", e.message || e);
  process.exit(1);
});
