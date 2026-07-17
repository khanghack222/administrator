# Công cụ GetEduMail

Bộ công cụ Node.js gồm ba phần:

- `mail/`: tạo, xác minh và lưu địa chỉ thư điện tử giáo dục GetEduMail.
- `grok/`: đăng ký tài khoản Grok/xAI bằng địa chỉ giáo dục, xử lý OTP, Cloudflare Turnstile, chạy nhiều luồng và tùy chọn xác thực 9router.
- `byesu/`: đăng ký tài khoản ByesU (半页酥 API), OTP temp mail, Turnstile, login, tạo API key theo group và lưu key theo file.

Chỉ sử dụng với tài khoản, hộp thư và hạ tầng mà bạn có quyền sử dụng. Tuân thủ điều khoản của GetEduMail, xAI, ByesU, Cloudflare và 9router.

---

## 1. Yêu cầu hệ thống

- Windows.
- Node.js 18 trở lên.
- Google Chrome (chế độ CDP / user Chrome).
- Playwright được cài trong dự án.
- 9router đang chạy nếu bật xác thực tự động 9router (phần Grok).
- Kết nối mạng ổn định tới GetEduMail, dịch vụ thư tạm, xAI, ByesU và 9router.

```powershell
node --version
npm --version
```

---

## 2. Cài đặt

```powershell
cd C:\Users\XUAN\Desktop\GetEduMail-Tool
npm install
npx playwright install chrome
```

Tạo cấu hình cục bộ (không ghi đè nếu đã có):

```powershell
Copy-Item mail\config.example.json mail\config.json
Copy-Item grok\config.example.json grok\config.json
Copy-Item byesu\config.example.json byesu\config.json
```

---

## 3. Cấu trúc dự án

```text
GetEduMail-Tool/
├── package.json
├── README.md
├── menu.mjs / menu.bat          trình đơn tổng
├── edu-menu.bat
├── grok-menu.bat
├── byesu-menu.bat
├── mail/
│   ├── config.json
│   ├── getedumail-menu.mjs
│   ├── getedumail-auto.mjs
│   ├── getedumail-core.mjs
│   └── acc/
├── grok/
│   ├── config.json
│   ├── grok-menu.mjs
│   ├── reg-grok.mjs
│   ├── reg-multi.mjs
│   ├── turnstile.mjs           Turnstile dùng chung (Grok + ByesU)
│   ├── proxy.mjs
│   ├── nine-router-auth.mjs
│   ├── acc/
│   └── proxies.txt
└── byesu/
    ├── config.json
    ├── byesu-menu.mjs
    ├── reg-byesu.mjs
    ├── tempmail.mjs            tempmail.lol (không mail.tm)
    ├── byesu-autofill.user.js
    ├── acc/                    JSON tài khoản reg
    ├── keys/                   API key txt theo group
    └── .pw-byesu-profile/      Chrome profile CDP
```

`grok/reg-grok.mjs` dùng `mail/getedumail-core.mjs`.  
`byesu/reg-byesu.mjs` dùng `grok/turnstile.mjs`, `grok/proxy.mjs` và `mail/getedumail-core.mjs` (extract OTP / randUser).

---

## 4. Phần mail: GetEduMail

### 4.1. Luồng

```text
1. Tạo hộp thư tạm (mail.tm)
2. Đăng ký GetEduMail bằng hộp thư tạm
3. Gửi OTP → đọc OTP temp
4. Xác minh → claim địa chỉ edu
5. Lưu mail/acc/
```

### 4.2. Lệnh

```powershell
npm run edu
.\edu-menu.bat
npm run edu:create
npm run edu:batch
```

### 4.3. Kết quả

- `mail/acc/N.json`, `mail/acc/latest.json`
- `mail/getedumail-latest.json`

Chi tiết cấu hình: `mail/config.json` (domain, name, password, proxy…).

---

## 5. Phần Grok/xAI

### 5.1. Luồng đăng ký

```text
1. Chọn / tạo mail edu
2. Chrome USER + CDP (mặc định) hoặc Playwright
3. Đăng ký xAI + OTP GetEduMail + Turnstile
4. Lưu grok/acc/
5. (Tuỳ chọn) 9router device OAuth
```

### 5.2. Lệnh

```powershell
npm run grok:menu
npm run grok:fresh
npm run grok:reuse
npm run grok:multi -- -n 5 -w 2
```

### 5.3. Trình duyệt

- Mặc định: **Chrome user + CDP** (`--user-chrome`), proxy cấu hình **trong Chrome**.
- Playwright / headless: dùng `config.proxy` / `proxies.txt`.

### 5.4. Kết quả

- `grok/acc/grok-ok-*.json`, `grok-results.jsonl`, `grok-latest.json`

Chi tiết: `grok/config.json` (domains, workers, nineRouter, autoClickCaptcha…).

---

## 6. Phần ByesU (半页酥 API)

### 6.1. Luồng auto reg

```text
1. Xóa cookie / session ByesU cũ
2. Tạo email tạm (tempmail.lol — domain xoay, không mail.tm)
3. Mở Chrome CDP (visible) → https://byesu.com/sign-up
4. Điền username / password / email + tick legal
5. Chờ Cloudflare Turnstile (token len > 20) rồi Send code
6. Poll OTP (hex 6 ký tự, ví dụ b263a0)
7. Create account
8. Login (bấm Sign in UI, chờ SPA → dashboard)
9. Vào /keys → tạo API key theo group (Grok, Claude Max, …)
10. Lưu acc JSON + append key vào keys/
11. Logout + wipe cookie (không quay form sign-up)
```

Group chỉ cho phép:

| Group | File key |
|---|---|
| Openai Codex | `keys/api key openai codex.txt` |
| Grok | `keys/api key grok.txt` |
| Gemini Business | `keys/api key gemini business.txt` |
| Claude Max | `keys/api key claude max.txt` |

Mỗi file: **một dòng một `sk-…`**, tự append sau mỗi lượt reg thành công.

### 6.2. Lệnh

```powershell
npm run byesu:menu
.\byesu-menu.bat
npm run byesu
npm run byesu -- --group Grok
npm run byesu -- --group "Claude Max"
npm run byesu -- --group 1
npm run byesu:multi
npm run byesu:pw
npm run byesu:headless
```

| Lệnh / flag | Ý nghĩa |
|---|---|
| `npm run byesu` | 1 lượt (Playwright + proxy xoay nếu có `proxies.txt`) |
| `npm run byesu:multi -- -n 6 -w 3` | Multi song song: 6 job, 3 workers |
| `--group` | `Grok` / `Claude Max` / … hoặc `1`–`4` |
| `--count` / `-n` | Số lượt (reg-multi) |
| `--workers` / `-w` | Số worker song song (≤ số proxy, tối đa 6) |
| `--retries` | Retry mỗi job khi fail |
| `--stagger` | ms trễ giữa worker start (mặc định 2500) |
| `--headless` | Headless Playwright |
| `--cdp` | Ép Chrome CDP (proxy set tay trong profile) |
| `--yes` | Không hỏi xác nhận |
| `--otp` | Dán OTP tay |
| `--no-proxy` | Tắt proxy |

**Multi reg (nhanh, tránh 429):**

```powershell
# 6 acc, 3 luồng, group Grok — mỗi job 1 proxy từ byesu/proxies.txt
npm run byesu:multi -- -n 6 -w 3 --group Grok

# khuyến nghị: workers ≤ số proxy; stagger 2–3s
npm run byesu:multi -- -n 10 -w 4 --group "Claude Max" --stagger 3000
```

**Test keys song song:**

```powershell
npm run byesu:test-keys
npm run byesu:test-keys -- -w 8
npm run byesu:test-keys -- --group grok -w 6
```

Trình đơn `byesu-menu`:

1. Auto reg 1 acc  
2. Auto reg nhiều lượt  
3. Tampermonkey userscript  
4. CDP mở Chrome + nạp helper  

### 6.3. Cấu hình `byesu/config.json`

```json
{
  "headless": false,
  "autoClickCaptcha": true,
  "password": "",
  "proxy": "",
  "byesu": {
    "group": "Grok",
    "keyName": "",
    "groupsAllowed": [
      "Openai Codex",
      "Grok",
      "Gemini Business",
      "Claude Max"
    ]
  }
}
```

- `group`: group mặc định khi tạo API key.
- `keyName`: tên key trên ByesU (trống = dùng username).
- `autoClickCaptcha`: `false` = tự giải captcha tay, script chỉ poll token.
- `proxy`: proxy cố định (tuỳ chọn). Khuyến nghị dùng danh sách `byesu/proxies.txt`.
- **CDP (`--cdp`):** proxy trong Chrome profile (`.pw-byesu-profile`), không nhét `user:pass` vào flag.
- **429 mà không có proxy:** bật VPN đổi IP rồi chạy lại (xem mục lỗi 429).

### 6.4. Kết quả

```text
byesu/acc/
  byesu-ok-<timestamp>.json    username, email, password, apiKey, group
  byesu-fail-*.json
  byesu-latest.json
  byesu-results.jsonl
byesu/keys/
  api key grok.txt
  api key claude max.txt
  api key openai codex.txt
  api key gemini business.txt
```

### 6.5. Lưu ý ByesU

- Có `byesu/proxies.txt`: mặc định **Playwright + proxy xoay** (chống 429). Không proxy: IP nhà dễ 429 → **bật VPN** hoặc thêm proxy.
- `--cdp`: Chrome visible, proxy set tay trong profile.
- Captcha: quét đến khi có token, **không bấm Send / Create / Sign in sớm**.
- Login: bấm nút **Sign in** trên UI (set cookie); không `goto` giữa chừng làm mất form.
- Sau login: chờ **dashboard** (pathname `/dashboard`, không tin `sign-in?redirect=%2Fdashboard`) rồi mới `/keys`.
- OTP: hex 6 ký tự từ tempmail.lol; provider không còn mail.tm.
- Đầu/cuối lượt: wipe cookie ByesU (không loop lại form sign-up khi cleanup).
- Test key: `npm run byesu:test-keys` — hết quota/invalid xóa khỏi `keys/`, chuyển `keys/dead/`.

---

## 7. Trình đơn tổng

```powershell
node menu.mjs
```

| Phím | Mục |
|---|---|
| 1 | Mail edu |
| 2 | Reg Grok |
| 3 | ByesU auto reg |
| 0 | Thoát |

---

## 8. Cloudflare Turnstile

Dùng chung `grok/turnstile.mjs`.

- `autoClickCaptcha: true`: tự click checkbox + poll token.
- `false`: xử lý tay; script chờ token (tối đa `--captcha-timeout`).

Thử thách hình ảnh có thể cần thao tác thủ công.

---

## 9. Proxy

```powershell
npm run proxy:test
npm run proxy:pick
```

Định dạng: `host:port:user:password` trong `grok/proxies.txt`.

- Grok/ByesU **CDP user Chrome**: proxy trong Chrome, không qua flag Playwright.
- Playwright/headless: `config.proxy` hoặc `--proxy`.

---

## 10. 9router (Grok)

```powershell
npm run 9r:ping
npm run 9r:device
```

Bật `nineRouter.autoAuth` trong `grok/config.json` sau khi reg Grok thành công.

---

## 11. Mã thoát (Grok / ByesU)

| Mã | Ý nghĩa |
|---:|---|
| 0 | Thành công |
| 1 | Lỗi chạy script |
| 2 | Một hoặc nhiều lượt fail |

---

## 12. Xử lý lỗi thường gặp

### ByesU: HTTP 429 / rate limit

- IP hiện tại bị giới hạn tần suất (Send code / reg / login).
- **Có proxy:** điền `byesu/proxies.txt` (`host:port:user:pass`), chạy `npm run byesu` — script dùng Playwright + xoay proxy, 429 tự đổi proxy rồi retry.
- **Không có proxy:** bật **VPN** (đổi IP), tắt VPN cũ / đổi server VPN, chờ vài phút rồi chạy lại. VPN và proxy không bắt buộc cùng lúc; ưu tiên proxy list nếu reg nhiều lượt.
- Giảm tốc: `--count 1`, chờ giữa các lượt; tránh spam reg liên tục cùng IP.
- CDP (`--cdp`) không gắn được proxy `user:pass` bằng flag — hoặc set proxy trong Chrome, hoặc dùng mặc định Playwright + `proxies.txt`.

### ByesU: `inbox=0` OTP timeout

- Kiểm tra `API /verification success=true`.
- Domain tempmail.lol có thể bị chặn; thử lại (domain xoay).
- Dán tay: `--otp b263a0`.

### ByesU: `ERR_NO_SUPPORTED_PROXIES`

- CDP không hỗ trợ `user:pass` trong `--proxy-server`.
- Đặt proxy trong Chrome profile ByesU, hoặc dùng Playwright với `byesu/proxies.txt` / `config.proxy`.

### ByesU: login xong vẫn `sign-in?redirect=%2Fdashboard`

- Cookie session chưa dính; script ưu tiên bấm Sign in UI và chờ pathname `/dashboard`.
- Không reload form khi captcha/login.

### Grok: OTP timeout / guest 400

- Xem README mục mail; giảm workers; kiểm tra GetEduMail token.

### Cloudflare không tự click

- `autoClickCaptcha: false`, xử lý tay.
- Dùng Chrome visible, không headless.

---

## 13. Bảo mật

Không đưa lên Git hoặc chia sẻ:

- `mail/config.json`, `grok/config.json`, `byesu/config.json`
- `grok/proxies.txt`
- `mail/acc/`, `grok/acc/`, `byesu/acc/`, `byesu/keys/`
- `xai-oauth*.json`, `getedumail-latest.json`
- Hồ sơ `.pw-*`
- Mật khẩu, cookie, token, API key, proxy auth

---

## 14. Kiểm tra nhanh

```powershell
node --check mail/getedumail-core.mjs
node --check grok/reg-grok.mjs
node --check grok/turnstile.mjs
node --check byesu/reg-byesu.mjs
node --check byesu/tempmail.mjs
node --check byesu/byesu-menu.mjs
```

```powershell
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); JSON.parse(require('fs').readFileSync('byesu/config.example.json','utf8')); console.log('JSON OK')"
```

Nguyên tắc:

- Không ghi secret vào mã nguồn / file mẫu.
- Không retry vô hạn với rate limit / 403.
- Giữ `mail/`, `grok/`, `byesu/` đồng cấp.
- Ưu tiên ít tác vụ, CDP visible cho ByesU/Grok khi bị chặn bot.
