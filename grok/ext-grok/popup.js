const log = document.getElementById("log");
const cd = document.getElementById("cd");
const meta = document.getElementById("meta");
const ids = ["btn1", "btn1b", "btn2", "btnFull"];

function busy(on) {
  ids.forEach((id) => {
    document.getElementById(id).disabled = on;
  });
}

async function refresh() {
  const r = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  const h = await chrome.runtime.sendMessage({ type: "BRIDGE_HEALTH" });

  meta.innerHTML = `bridge: <b style="color:${h.ok ? "#7dffb3" : "#f66"}">${
    h.ok ? "ON" : "OFF"
  }</b> · step: <b>${r.step || "idle"}</b>`;

  const lines = [];
  if (r.status) lines.push(r.status);
  if (r.acc?.email) lines.push(r.acc.email);
  if (r.session?.otp) lines.push("otp " + r.session.otp);
  log.textContent = lines.join("\n") || "sẵn sàng";

  if (r.countdownEnd > Date.now()) {
    cd.textContent = Math.ceil((r.countdownEnd - Date.now()) / 1000) + "s";
  } else cd.textContent = "";
}

async function run(type, extra = {}) {
  busy(true);
  log.textContent = type + "…";
  try {
    const r = await chrome.runtime.sendMessage({ type, ...extra });
    if (!r?.ok) throw new Error(r?.error || "fail");
    const { ok, userToken, tabId, ...rest } = r;
    log.textContent = Object.entries(rest)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  } catch (e) {
    log.textContent = "ERR: " + (e.message || e);
  } finally {
    busy(false);
    refresh();
  }
}

document.getElementById("btn1").onclick = () => run("STEP1");
document.getElementById("btn1b").onclick = () => run("STEP1_BRIDGE");
document.getElementById("btn2").onclick = () => run("STEP2");
document.getElementById("btnFull").onclick = () => run("STEP_FULL");
document.getElementById("btnReset").onclick = () => run("RESET");

refresh();
setInterval(refresh, 1000);
