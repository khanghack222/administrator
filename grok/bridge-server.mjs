/**
 * Local bridge: extension đọc mail do edu-create.bat / menu tạo
 *   node bridge-server.mjs
 *   http://127.0.0.1:3847/latest
 *   http://127.0.0.1:3847/health
 */
import { createServer } from "http";
import { readFileSync, existsSync, watch } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const MAIL_DIR = join(__dir, "..", "mail");
const PORT = Number(process.env.EDU_BRIDGE_PORT || 3847);
// mail/acc/latest.json (folder tách)
const LATEST_CANDIDATES = [
  join(MAIL_DIR, "acc", "latest.json"),
  join(MAIL_DIR, "getedumail-latest.json"),
];

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readLatest() {
  for (const p of LATEST_CANDIDATES) {
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      /* */
    }
  }
  return null;
}

const server = createServer((req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ ok: true, port: PORT, hasLatest: !!readLatest() })
    );
    return;
  }

  if (url.pathname === "/latest") {
    const data = readLatest();
    if (!data) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: "no acc/latest.json — chạy edu-create.bat",
        })
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        email: data.email,
        password: data.password,
        fullName: data.fullName,
        userToken: data.userToken,
        claimedAt: data.claimedAt,
        domain: data.domain,
      })
    );
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "try /health or /latest" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[bridge] http://127.0.0.1:${PORT}/latest`);
  console.log(`[bridge] http://127.0.0.1:${PORT}/health`);
  console.log(`[bridge] files: ../mail/acc/latest.json`);
  console.log(`[bridge] Ctrl+C dừng`);
});

for (const p of LATEST_CANDIDATES) {
  try {
    watch(p, () =>
      console.log(`[bridge] updated ${p} ${new Date().toISOString()}`)
    );
  } catch {
    /* */
  }
}
