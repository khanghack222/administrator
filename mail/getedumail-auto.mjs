#!/usr/bin/env node
/**
 * CLI wrapper
 *   node getedumail-auto.mjs
 *   node getedumail-auto.mjs --domain warsawuni.edu.pl --name "Jane" --password "x"
 *   node getedumail-auto.mjs --count 3 --no-open
 *   node getedumail-auto.mjs --login
 *   node getedumail-auto.mjs --login path.json
 */
import { writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { createAccount, loadLatest, __dir } from "./getedumail-core.mjs";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const DOMAIN = flag("--domain", "warsawuni.edu.pl");
const FULL_NAME = flag("--name", "Alex Kowalski");
const COUNT = Math.max(1, parseInt(flag("--count", "1"), 10) || 1);
const FIXED_PASS = flag("--password", null);
const OPEN_BROWSER = !args.includes("--no-open");

async function main() {
  if (args.includes("--login")) {
    const { openLoggedIn } = await import("./getedumail-browser.mjs");
    const idx = args.indexOf("--login");
    const file =
      args[idx + 1] && !args[idx + 1].startsWith("--")
        ? args[idx + 1]
        : null;
    const data = file
      ? JSON.parse(readFileSync(file, "utf8"))
      : loadLatest();
    if (!data?.email || !data?.password)
      throw new Error(`cần email+password (acc/latest.json hoặc --login file)`);
    console.log(`[login] form ${data.email}`);
    await openLoggedIn({ email: data.email, password: data.password, wait: true });
    return;
  }

  const results = [];
  for (let i = 0; i < COUNT; i++) {
    try {
      const one = await createAccount({
        domain: DOMAIN,
        name: FULL_NAME,
        password: FIXED_PASS || undefined,
        log: console.log,
      });
      results.push(one);
      console.log(
        JSON.stringify(
          {
            email: one.email,
            password: one.password,
            code: one.code,
            claimedAt: one.claimedAt,
          },
          null,
          2
        )
      );
    } catch (e) {
      console.error(`[FAIL] ${e.message}`);
      results.push({ ok: false, error: e.message });
    }
  }
  if (COUNT > 1) {
    console.log(`Batch: ${results.filter((x) => x.ok).length} OK → acc/*.json`);
  }
  if (results.some((x) => !x.ok)) process.exit(1);

  const last = [...results].reverse().find((x) => x.ok && x.email && x.password);
  if (OPEN_BROWSER && last) {
    console.log(`\n[7] Mở browser login form → inbox`);
    const { openLoggedIn } = await import("./getedumail-browser.mjs");
    await openLoggedIn({
      email: last.email,
      password: last.password,
      wait: true,
    });
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
