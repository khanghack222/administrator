// ==UserScript==
// @name         ByesU Autofill Helper
// @namespace    local
// @version      1.1.0
// @match        https://byesu.com/sign-up*
// @match        https://byesu.com/register*
// @match        https://byesu.com/dashboard*
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const q = (sel, root = document) => [...root.querySelectorAll(sel)];
  const qv = (sel) => q(sel).find((el) => {
    if (!(el instanceof HTMLElement)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  });

  const fireInput = (el) => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const setValue = (el, value) => {
    if (!el || value == null) return false;
    el.focus();
    el.value = String(value);
    fireInput(el);
    return true;
  };

  const readStore = () => {
    try {
      return JSON.parse(localStorage.getItem("byesuAutofill") || "{}");
    } catch {
      return {};
    }
  };
  const saveStore = (patch) => {
    const cur = readStore();
    const data = { ...cur, ...patch };
    localStorage.setItem("byesuAutofill", JSON.stringify(data));
    return data;
  };
  const promptStore = () => {
    const cur = readStore();
    const email = prompt("Email", cur.email || "") || cur.email || "";
    const username = prompt("Username", cur.username || (email.includes("@") ? email.split("@")[0] : "")) || cur.username || "";
    const password = prompt("Password", cur.password || "") || cur.password || "";
    return saveStore({ email, username, password });
  };

  const getMeta = (el) =>
    `${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${el.autocomplete || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("type") || ""}`.toLowerCase();

  const pick = (patterns) => {
    const list = q("input,textarea").filter(Boolean).filter((i) => qv(`input[name="${CSS.escape(i.name || "")}"]`) || i.offsetParent);
    return list.find((el) => {
      if (!qv("input") || !el.offsetParent) return false;
      const meta = getMeta(el);
      return patterns.some((r) => r.test(meta));
    });
  };

  const pickPasswordInputs = () => q("input[type='password']").filter((i) => i.offsetParent);

  const state = () => {
    const token = q('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]')
      .map((i) => String(i.value || ""))
      .find((v) => v.length > 20) || "";
    const byText = /success!|verified you are human|verification complete/i.test(document.body.innerText || "");
    const byFrame = q("iframe").some((f) => /(success|verified|complete|passed)/i.test(`${f.title || ""} ${f.getAttribute("aria-label") || ""}`));
    return {
      ok: token.length > 20 || byText || byFrame,
      tokenLen: token.length,
      hasSend: !!qv('button:disabled,button').find((b) => /send code/i.test((b.textContent || "").trim())),
      createBtn: qv("button")?.textContent.includes("Create account") ? qv("button") : null,
    };
  };

  const fillSignup = () => {
    const data = Object.keys(readStore()).length ? readStore() : promptStore();
    const username = (data.username || "").trim() || "user_" + Date.now().toString(36);
    const email = (data.email || "").trim();
    const password = (data.password || "").trim();

    setValue(pick([/username|user|account/]), username);
    const pw = pickPasswordInputs();
    if (pw[0]) setValue(pw[0], password);
    if (pw[1]) setValue(pw[1], password);
    setValue(pick([/email|verification email/]), email);

    const agree = q("input[type='checkbox']").find((cb) => {
      const meta = getMeta(cb);
      return !/(turnstile|captcha)/i.test(meta) && cb.offsetParent;
    });
    if (agree && !agree.checked) agree.click();

    syncStatus();
  };

  const fillOtp = async () => {
    let code = "";
    try {
      const text = await navigator.clipboard.readText();
      const m = String(text || "").match(/\b\d{4,8}\b/);
      if (m) code = m[0];
    } catch {
      /* no-op */
    }
    code = (prompt("OTP", code) || "").trim();
    if (!code) return;
    const otp = pick([/verify|verification|otp|code/]) || q("input").find((i) => !i.type.startsWith("password") && i.type !== "email" && i.offsetParent);
    if (!otp) return alert("Không thấy ô OTP");
    setValue(otp, code);
    syncStatus();
  };

  const copyKey = async () => {
    const text = document.body.innerText || "";
    const key = text.match(/(sk-[A-Za-z0-9_\-]{20,}|byesu_[A-Za-z0-9_\-]{20,})/)?.[1];
    if (!key) return alert("Không thấy API key trên trang");
    await navigator.clipboard.writeText(key);
    alert(`Copied: ${key.slice(0, 8)}…`);
  };

  const panelId = "byesu-autofill-panel";
  const panel = document.getElementById(panelId) || document.createElement("div");
  panel.id = panelId;
  panel.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:999999;background:#111;color:#fff;padding:10px;border-radius:10px;font:13px system-ui;display:grid;gap:6px;box-shadow:0 6px 30px #0008;";
  panel.innerHTML = `
    <button data-a="save">Lưu data</button>
    <button data-a="fill">Fill signup</button>
    <button data-a="otp">Paste OTP</button>
    <button data-a="copy">Copy API key</button>
    <div class="s">đang kiểm tra…</div>
  `;

  panel.addEventListener("click", async (e) => {
    const a = e.target?.dataset?.a;
    if (a === "save") promptStore();
    if (a === "fill") fillSignup();
    if (a === "otp") fillOtp();
    if (a === "copy") copyKey();
    syncStatus();
  });

  const syncStatus = () => {
    const st = state();
    const btn = panel.querySelector(".s");
    if (!btn) return;
    btn.textContent = `${st.ok ? "captcha OK" : "captcha chưa OK"} (${st.tokenLen})`;
  };

  if (!document.getElementById(panelId)) document.body.appendChild(panel);
  setInterval(syncStatus, 700);
  syncStatus();
})();