/**
 * Temp mail providers cho ByesU (không dùng mail.tm).
 * Mặc định: tempmail.lol — domain xoay (gardianwaves, icodetensor, …)
 *
 *   createTempInbox() → { address, token, provider }
 *   waitOtp(inbox, { timeoutMs, onTick, pickCode }) → { code, subject, from }
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOL = "https://api.tempmail.lol";

/** Tạo inbox tempmail.lol */
export async function createLolInbox(log = () => {}) {
  const r = await fetch(`${LOL}/v2/inbox/create`, {
    method: "POST",
    headers: { accept: "application/json" },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.address || !j.token) {
    throw new Error(
      `tempmail.lol create ${r.status}: ${JSON.stringify(j).slice(0, 120)}`
    );
  }
  log(`[tempmail.lol] ${j.address}`);
  return {
    address: j.address,
    token: j.token,
    provider: "tempmail.lol",
    domain: String(j.address).split("@")[1] || "",
  };
}

/** Poll inbox tempmail.lol */
export async function listLolMessages(inbox) {
  const r = await fetch(
    `${LOL}/v2/inbox?token=${encodeURIComponent(inbox.token)}`,
    { headers: { accept: "application/json" } }
  );
  if (!r.ok) throw new Error(`tempmail.lol inbox ${r.status}`);
  const j = await r.json().catch(() => ({}));
  if (j.expired) throw new Error("tempmail.lol inbox expired");
  return Array.isArray(j.emails) ? j.emails : [];
}

/**
 * @param {object} inbox
 * @param {{ timeoutMs?: number, onTick?: Function, pickCode?: (blob:string)=>string|null }} opts
 */
export async function waitOtp(inbox, { timeoutMs = 90_000, onTick, pickCode } = {}) {
  if (!pickCode) throw new Error("waitOtp: missing pickCode");
  const t0 = Date.now();
  let i = 0;
  let lastCount = -1;
  while (Date.now() - t0 < timeoutMs) {
    let list = [];
    try {
      if (inbox.provider === "tempmail.lol" || inbox.token) {
        list = await listLolMessages(inbox);
      } else {
        throw new Error(`unknown provider: ${inbox.provider}`);
      }
    } catch (e) {
      onTick?.(i++, { err: String(e.message || e).slice(0, 60), n: 0 });
      await sleep(2000);
      continue;
    }

    if (list.length !== lastCount) {
      lastCount = list.length;
      const first = list[0] || {};
      onTick?.(i, {
        n: list.length,
        sub: first.subject || first.from || "",
      });
    } else {
      onTick?.(i, { n: list.length });
    }
    i++;

    for (const m of list) {
      const blob = [
        m.subject,
        m.from,
        m.to,
        m.body,
        m.html,
        m.text,
        m.raw,
        typeof m === "string" ? m : "",
      ]
        .filter(Boolean)
        .join("\n");
      const plain = String(blob)
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ");
      const code = pickCode(blob) || pickCode(plain);
      if (code) {
        return {
          code,
          subject: m.subject || "",
          from: m.from || m.sender || "",
        };
      }
    }
    await sleep(1500);
  }
  throw new Error(
    `OTP timeout (${Math.round(timeoutMs / 1000)}s) provider=${inbox.provider} inbox≈${lastCount} addr=${inbox.address}`
  );
}

/** API thống nhất */
export async function createTempInbox(log = () => {}, prefer = "lol") {
  // chỉ lol hiện tại (mail.tm bỏ)
  if (prefer === "lol" || prefer === "tempmail.lol" || !prefer) {
    return createLolInbox(log);
  }
  return createLolInbox(log);
}
