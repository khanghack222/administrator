/** accounts.x.ai — fill theo step trong storage */

const { sleep, setNative, findInput, clickByText, toast, waitFor } =
  window.__grokEdu;

async function acceptCookies() {
  clickByText(/accept all cookies|accept all/i);
  await sleep(300);
}

async function fillEmail(email) {
  await acceptCookies();
  await sleep(400);
  if (!clickByText(/^sign up with email$/i)) {
    clickByText(/sign up with email|with email/i);
  }
  await sleep(900);

  const el = await waitFor(
    () =>
      findInput([
        (i) => i.type === "email",
        (i) => /email/i.test(i.name || ""),
        (i) => /email/i.test(i.autocomplete || ""),
        (i) => /mail/i.test(i.placeholder || ""),
        (i) => /email/i.test(i.id || ""),
      ]),
    { tries: 25 }
  );
  if (!el) {
    toast("FAIL: không thấy ô email xAI");
    return { ok: false, error: "no email" };
  }
  setNative(el, email);
  toast(`xAI email\n${email}`);
  await sleep(400);
  clickByText(/^sign up$/i) || clickByText(/continue|next|submit/i);
  return { ok: true };
}

async function fillOtp(otp) {
  const raw = String(otp || "").replace(/\s/g, "");
  await sleep(500);
  const el = await waitFor(
    () =>
      findInput([
        (i) =>
          /otp|code|verification/i.test(
            i.name + i.id + i.autocomplete + i.placeholder
          ),
        (i) => i.type === "text" || i.type === "tel" || i.inputMode === "numeric",
        (i) => i.type === "text" || !i.type,
      ]),
    { tries: 30 }
  );
  if (!el) {
    toast(`OTP dán tay: ${raw}`);
    return { ok: false, otp: raw };
  }
  el.click();
  setNative(el, raw);
  toast(`OTP ${raw}`);
  await sleep(400);
  clickByText(/confirm email|verify|confirm|continue|submit|next/i);
  return { ok: true };
}

async function fillProfile({ first, last, password }) {
  await sleep(800);
  const firstEl = await waitFor(
    () =>
      findInput([
        (i) =>
          /first|given/i.test(i.name + i.id + i.autocomplete + i.placeholder),
      ]),
    { tries: 20 }
  );
  const lastEl = findInput([
    (i) =>
      /last|family|surname/i.test(i.name + i.id + i.autocomplete + i.placeholder),
  ]);
  const passEl = findInput([
    (i) => i.type === "password",
    (i) => /password/i.test(i.name + i.id + i.autocomplete),
  ]);
  if (firstEl) setNative(firstEl, first || "Alex");
  if (lastEl) setNative(lastEl, last || "Kowalski");
  if (passEl) setNative(passEl, password || "");
  toast(`profile OK\nTurnstile tay + Complete\n${password || ""}`);
  return { ok: !!(firstEl || passEl) };
}

async function resumeFromStorage() {
  const { step, session, acc } = await chrome.storage.local.get([
    "step",
    "session",
    "acc",
  ]);
  const email = session?.email || acc?.email;
  if (!email) return;

  toast(`step=${step || "idle"}`);

  if (step === "xai_email" || step === "xai_open") {
    const r = await fillEmail(email);
    if (r.ok) {
      await chrome.storage.local.set({
        step: "xai_wait_otp",
        status: "chờ OTP xAI (xem tab edu inbox)",
      });
    }
    return;
  }

  if (step === "xai_otp" && session?.otp) {
    await fillOtp(session.otp);
    await chrome.storage.local.set({ step: "xai_profile" });
    await sleep(1200);
    await fillProfile({
      first: session.first,
      last: session.last,
      password: session.grokPass || session.password,
    });
    await chrome.storage.local.set({
      step: "xai_turnstile",
      status: "Turnstile tay rồi Complete",
    });
    return;
  }

  if (step === "xai_profile") {
    await fillProfile({
      first: session?.first,
      last: session?.last,
      password: session?.grokPass || session?.password || acc?.password,
    });
  }
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  (async () => {
    if (msg.type === "FILL_EMAIL") {
      reply(await fillEmail(msg.email));
      return;
    }
    if (msg.type === "FILL_OTP") {
      reply(await fillOtp(msg.otp));
      return;
    }
    if (msg.type === "FILL_PROFILE") {
      reply(
        await fillProfile({
          first: msg.first,
          last: msg.last,
          password: msg.password,
        })
      );
      return;
    }
    if (msg.type === "RESUME") {
      await resumeFromStorage();
      reply({ ok: true });
      return;
    }
    if (msg.type === "PING") {
      reply({ ok: true, host: "xai", href: location.href });
      return;
    }
    reply({ ok: false });
  })().catch((e) => reply({ ok: false, error: e.message }));
  return true;
});

resumeFromStorage().catch(() => {});
toast("Grok Edu (xAI) ready");
