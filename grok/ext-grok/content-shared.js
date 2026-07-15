/** Shared DOM helpers — inject trên edu + xAI */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setNative(el, value) {
  if (!el) return false;
  el.focus();
  el.click();
  const proto =
    el.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  return true;
}

function qAll(sel) {
  return [...document.querySelectorAll(sel)];
}

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return (
    r.width > 0 &&
    r.height > 0 &&
    s.display !== "none" &&
    s.visibility !== "hidden" &&
    s.opacity !== "0"
  );
}

function findInput(preds) {
  const inputs = qAll("input, textarea").filter(visible);
  for (const p of preds) {
    const hit = inputs.find(p);
    if (hit) return hit;
  }
  return null;
}

function clickByText(re, { exact } = {}) {
  const nodes = [
    ...qAll("button"),
    ...qAll('[role="button"]'),
    ...qAll("a"),
    ...qAll('input[type="submit"]'),
  ].filter(visible);
  const el = nodes.find((n) => {
    const t = (n.textContent || n.value || "").replace(/\s+/g, " ").trim();
    return exact ? re.test(t) && t.length < 40 : re.test(t);
  });
  if (el) {
    el.click();
    return true;
  }
  return false;
}

function toast(msg) {
  let t = document.getElementById("grok-edu-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "grok-edu-toast";
    Object.assign(t.style, {
      position: "fixed",
      bottom: "16px",
      right: "16px",
      zIndex: "2147483647",
      background: "#111",
      color: "#0f0",
      padding: "10px 14px",
      borderRadius: "8px",
      font: "12px/1.4 monospace",
      maxWidth: "380px",
      boxShadow: "0 4px 20px #0008",
      whiteSpace: "pre-wrap",
    });
    document.documentElement.appendChild(t);
  }
  t.textContent = msg;
}

async function waitFor(fn, { tries = 40, ms = 400 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(ms);
  }
  return null;
}

window.__grokEdu = {
  sleep,
  setNative,
  qAll,
  visible,
  findInput,
  clickByText,
  toast,
  waitFor,
};
