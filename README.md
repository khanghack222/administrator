# GetEduMail Tool

Node.js tools for creating GetEduMail addresses, registering Grok accounts, optional Cloudflare checkbox clicking, parallel workers, and 9router Grok CLI OAuth.

## Setup

```powershell
npm install
npx playwright install chrome
Copy-Item grok/config.example.json grok/config.json
Copy-Item mail/config.example.json mail/config.json
```

Local secrets and generated accounts are ignored: `config.json`, `proxies.txt`, `acc/`, OAuth snapshots, browser profiles.

## Commands

```powershell
npm run edu
npm run grok:menu
npm run grok:fresh
npm run grok:multi -- -n 5 -w 2
npm run grok:multi -- -n 5 -w 3 --headless
npm run 9r:ping
npm run 9r:device
```

## Grok config

`grok/config.json` supports:

- `domains`: edu domains rotated between attempts.
- `workers`: parallel worker count, maximum 8.
- `headless`: use headless Playwright instead of Chrome user CDP.
- `reuseUnusedEdu`: consume old unused accounts from `mail/acc/` first.
- `autoClickCaptcha`: click the Cloudflare Turnstile checkbox automatically.
- `nineRouter.autoAuth`: authorize through 9router `grok-cli` device OAuth after registration.

## Layout

```text
mail/   GetEduMail API, temp-mail verification, local edu account store
grok/   Grok registration, Turnstile handling, multi-worker runner, 9router OAuth
```

`grok/reg-grok.mjs` imports `mail/getedumail-core.mjs`; keep both directories together.

Use only with accounts you own and according to each service's terms.
