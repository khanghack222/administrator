/** getedumail.com — login form (không cookie). Step nhớ trong storage. */

const { sleep, setNative, findInput, clickByText, toast, waitFor, visible, qAll } =
  window.__grokEdu;

async function dismissCookie() {
  clickByText(/accept all/i) || clickByText(/necessary only/i);
  await sleep(300);
}

async function loginForm(email, password) {
  await dismissCookie();
  await sleep(400);

  // đi thẳng /login nếu đang ở trang khác
  if (!/\/login/i.test(location.pathname)) {
    location.href = "https://getedumail.com/login";
    return { ok: true, redirect: true };
  }

  const emailEl = await waitFor(
    () =>
      findInput([
        (i) => i.id === "email",
        (i) => i.type === "email",
        (i) => /email/i.test(i.name || ""),
        (i) => /email|mail/i.test(i.placeholder || ""),
      ]),
    { tries: 30 }
  );
  const passEl = await waitFor(
    () =>
      findInput([
        (i) => i.id === "password",
        (i) => i.type === "password",
        (i) => /password/i.test(i.name || ""),
      ]),
    { tries: 20 }
  );

  if (!emailEl || !passEl) {
    toast("FAIL: không scan được form login edu");
    return { ok: false, error: "no form" };
  }

  setNative(emailEl, email);
  await sleep(150);
  setNative(passEl, password);
  await sleep(200);

  // nút Sign In trong form — tránh cookie banner
  const formBtn = document.querySelector('form button[type="submit"]');
  if (formBtn && visible(formBtn)) formBtn.click();
  else if (!clickByText(/^sign in$/i, { exact: true })) {
    clickByText(/sign in|log in/i);
  }

  toast(`login form\n${email}`);
  await sleep(2000);
  return { ok: true, url: location.href };
}

async function resumeFromStorage() {
  const { step, session, acc } = await chrome.storage.local.get([
    "step",
    "session",
    "acc",
  ]);
  const email = session?.email || acc?.email;
  const password = session?.password || acc?.password;
  if (!email || !password) return;

  if (step === "edu_login" || step === "edu_open") {
    toast(`step=${step}\nđiền login…`);
    const r = await loginForm(email, password);
    if (r.redirect) return;
    if (r.ok) {
      await chrome.storage.local.set({
        step: "edu_inbox",
        status: `edu logged ${email}`,
      });
      // inbox để xem OTP xAI
      if (!/inbox/i.test(location.pathname)) {
        await sleep(800);
        location.href = "https://getedumail.com/mail/inbox";
      }
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  (async () => {
    if (msg.type === "EDU_LOGIN") {
      reply(await loginForm(msg.email, msg.password));
      return;
    }
    if (msg.type === "PING") {
      reply({ ok: true, host: "edu", href: location.href });
      return;
    }
    reply({ ok: false });
  })().catch((e) => reply({ ok: false, error: e.message }));
  return true;
});

// auto resume khi mở tab mới — KHÔNG quên step (storage)
resumeFromStorage().catch(() => {});
toast("Grok Edu (getedumail) ready");
