# GetEduMail CLI

CLI Node.js cho [GetEduMail](https://getedumail.com): tạo hộp thư kiểu edu qua API, lưu tài khoản, xem inbox, mở Chrome đăng nhập.

**Không liên kết với GetEduMail.** Chỉ dùng cho tài khoản bạn sở hữu và tuân ToS dịch vụ.

## Tính năng

- Tạo + claim địa chỉ (guest → đăng ký → OTP → xác minh → claim)
- Menu tương tác hoặc CLI một lệnh
- Lưu account JSON gọn: `acc/1.json` … `acc/N.json` + `acc/latest.json`
- Xem inbox / đọc mail (cần `userToken` hoặc email+password)
- Tùy chọn login form Chrome (Playwright) mở web inbox
- Tên hiển thị ngẫu nhiên từ `names.json`
- Config: domain, mật khẩu cố định/ngẫu nhiên, mở browser sau create

## Yêu cầu

- **Node.js 18+** (`fetch` built-in)
- **Chrome** (tùy chọn — chỉ khi login menu / mở browser)
- Mạng tới `https://api.getedumail.com`

## Cài đặt

```bash
git clone <your-repo-url>.git
cd <repo>          # thư mục này nếu standalone
npm install
npx playwright install chrome   # chỉ khi dùng browser login
```

Copy config:

```bash
cp config.example.json config.json
# Windows: copy config.example.json config.json
```

Sửa `config.json` nếu cần. **Không commit mật khẩu/token thật.**

Lần chạy menu đầu: nếu thiếu `config.json` / `acc/` tool **tự tạo**.

## Bắt đầu nhanh

### Menu (khuyên dùng)

```bash
npm start
# hoặc
node getedumail-menu.mjs
# Windows
edu-menu.bat
```

| Phím | Việc |
|------|------|
| `1` | Tạo email + claim |
| `2` | Login account mới nhất (Chrome) |
| `3` | Login từ `acc/N.json` |
| `4` | Xem account mới nhất |
| `5` | Liệt kê `acc/*.json` |
| `6` | Inbox (mới nhất) |
| `7` | Inbox (chọn account) |
| `8` | Config |
| `9` | Thử tên ngẫu nhiên |
| `a` | Smoke-test full flow API |
| `m` | Migrate JSON cũ ở root → `acc/` |
| `0` | Thoát |

Sau create/login: **Enter** về menu (cửa sổ browser vẫn mở khi `wait:false`).

### CLI một lệnh

```bash
# Tạo 1 account (không mở browser)
node getedumail-auto.mjs --no-open

# Domain / tên / mật khẩu tùy chọn
node getedumail-auto.mjs --domain warsawuni.edu.pl --name "Jane Doe" --password "YourPass1!" --no-open

# Batch
node getedumail-auto.mjs --count 3 --no-open

# Mở Chrome login latest (hoặc file)
node getedumail-auto.mjs --login
node getedumail-auto.mjs --login acc/1.json
```

npm scripts:

```bash
npm run create
npm run login
npm run batch
```

## Config (`config.json`)

| Trường | Mặc định | Ý nghĩa |
|--------|----------|---------|
| `domain` | `warsawuni.edu.pl` | Domain mail |
| `name` | `Alex Kowalski` | Tên cố định nếu `randomName` = false |
| `password` | `""` | Rỗng = random mỗi lần create |
| `openBrowserAfterCreate` | `true` / `false` | Menu: mở Chrome sau `[1]` |
| `randomName` | `true` | Lấy từ `names.json` |

Domain phụ thuộc GetEduMail (menu `[8]` liệt kê domain phổ biến).

## File account

```
acc/
  1.json
  2.json
  …
  latest.json    # alias bản vừa tạo
```

Ví dụ:

```json
{
  "email": "user@warsawuni.edu.pl",
  "password": "…",
  "fullName": "…",
  "userToken": "eyJ…",
  "domain": "warsawuni.edu.pl",
  "code": "123456",
  "claimedAt": "2026-07-13T00:00:00.000Z",
  "id": 1
}
```

- **API inbox** cần `userToken` hợp lệ sau claim (list guest → **403**).  
  CLI refresh token bằng login khi có password, ghi lại file.
- `getedumail-latest.json` ở root = alias latest (script/bridge cũ).

## Cấu trúc project

```
mail/
  getedumail-core.mjs      # API: create, inbox, save, migrate
  getedumail-menu.mjs      # Menu tương tác
  getedumail-auto.mjs      # CLI create / login / batch
  getedumail-browser.mjs   # Playwright Chrome login
  names.json               # Tên đầy đủ random
  config.example.json
  config.json              # local only (gitignore)
  acc/                     # local only (gitignore)
  edu-menu.bat
  edu-create.bat
  edu-login.bat
```

## Ghi chú API

Base: `https://api.getedumail.com`

Flow create điển hình:

1. `POST /getedumail/emails/guest`
2. `POST /getedumail/user/register`
3. `GET  /getedumail/user/otp` (cookie `userToken`)
4. Poll `GET /getedumail/emails/{email}/list` → lấy mã 6 số
5. `POST /getedumail/user/verify-otp`
6. `POST /getedumail/emails` (hoặc path claim) kèm token

Claim API fail → core có thể fallback claim browser trên `/mail/create`.

## Xử lý lỗi

| Hiện tượng | Cách xử lý |
|------------|------------|
| `inbox 403` | Cần token: login lại bằng password, hoặc `[2]` một lần; account trong `acc/` phải có `password` |
| OTP timeout | Kiểm domain còn dùng được; đợi rồi create lại |
| Không tìm thấy Chrome | Cài Google Chrome, hoặc `npx playwright install chrome` |
| Claim fail | Menu `[a]` smoke test; kiểm trạng thái API |

## Bảo mật

- Không commit `config.json`, `acc/`, token.
- Hộp thư edu coi như disposable; đổi password nếu share.
- Tool tự động hóa dịch vụ bên thứ ba — bạn chịu trách nhiệm tuân thủ.

## License

Dùng tự chịu rủi ro. Không bảo hành.
