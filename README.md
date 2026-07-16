# Công cụ GetEduMail

Bộ công cụ Node.js gồm hai phần:

- `mail/`: tạo, xác minh và lưu địa chỉ thư điện tử giáo dục GetEduMail.
- `grok/`: đăng ký tài khoản Grok/xAI bằng địa chỉ giáo dục, xử lý OTP, Cloudflare Turnstile, chạy nhiều luồng và tùy chọn xác thực 9router.

Chỉ sử dụng với tài khoản, hộp thư và hạ tầng mà bạn có quyền sử dụng. Tuân thủ điều khoản của GetEduMail, xAI, Cloudflare và 9router.

---

## 1. Yêu cầu hệ thống

- Windows.
- Node.js 18 trở lên.
- Google Chrome nếu muốn hiện trình duyệt hoặc dùng Chrome người dùng qua CDP.
- Playwright được cài trong dự án.
- 9router đang chạy nếu bật xác thực tự động 9router.
- Kết nối mạng ổn định tới GetEduMail, dịch vụ thư tạm, xAI và 9router.

Kiểm tra phiên bản:

```powershell
node --version
npm --version
```

---

## 2. Cài đặt

Mở PowerShell tại thư mục dự án:

```powershell
cd C:\Users\XUAN\Desktop\GetEduMail-Tool
npm install
npx playwright install chrome
```

Tạo tệp cấu hình cục bộ từ tệp mẫu:

```powershell
Copy-Item grok\config.example.json grok\config.json
Copy-Item mail\config.example.json mail\config.json
```

Nếu đã có tệp cấu hình, không ghi đè. Chỉnh sửa trực tiếp bằng trình đơn hoặc trình soạn thảo văn bản.

---

## 3. Cấu trúc dự án

```text
GetEduMail-Tool/
├── package.json
├── README.md
├── grok-menu.bat
├── mail/
│   ├── config.example.json
│   ├── config.json                 tệp cục bộ, không đưa lên Git
│   ├── getedumail-menu.mjs         trình đơn quản lý mail
│   ├── getedumail-auto.mjs         trình chạy tạo mail và thao tác tự động
│   ├── getedumail-core.mjs         thư viện API dùng chung
│   ├── acc/                        tài khoản giáo dục cục bộ
│   └── getedumail-latest.json      tài khoản gần nhất, không đưa lên Git
└── grok/
    ├── config.example.json
    ├── config.json                 tệp cục bộ, không đưa lên Git
    ├── grok-menu.mjs               trình đơn đăng ký Grok
    ├── reg-grok.mjs                đăng ký một tài khoản
    ├── reg-multi.mjs               chạy nhiều lượt song song
    ├── reg-grok-once.mjs           luồng đăng ký một lượt cũ
    ├── turnstile.mjs               xử lý Cloudflare Turnstile
    ├── proxy.mjs                   đọc và kiểm tra proxy
    ├── nine-router-auth.mjs        xác thực Grok CLI với 9router
    ├── acc/                        kết quả Grok và bản sao OAuth cục bộ
    └── proxies.txt                 danh sách proxy cục bộ, không đưa lên Git
```

`grok/reg-grok.mjs` dùng `mail/getedumail-core.mjs`. Vì vậy phải giữ thư mục `mail/` và `grok/` cạnh nhau theo cấu trúc trên.

---

## 4. Phần mail: GetEduMail

### 4.1. Luồng hoạt động

Luồng tạo địa chỉ hiện tại:

```text
1. Tạo hộp thư tạm qua mail.tm
2. Đăng ký tài khoản GetEduMail bằng hộp thư tạm
3. Gửi mã xác minh GetEduMail
4. Đọc mã từ hộp thư tạm
5. Xác minh tài khoản GetEduMail
6. Nhận quyền sở hữu địa chỉ edu theo tên miền đã chọn
7. Lưu địa chỉ và mã truy cập cục bộ
```

Cách dùng hộp thư tạm giúp tránh giới hạn tạo hộp thư khách của GetEduMail. Hộp thư tạm chỉ dùng để nhận mã xác minh GetEduMail; địa chỉ edu sau khi claim mới là địa chỉ dùng cho bước đăng ký Grok.

### 4.2. Trình đơn mail

Mở trình đơn bằng một trong các lệnh:

```powershell
npm run edu
.\edu-menu.bat
```

Trình đơn có các chức năng:

| Lựa chọn | Chức năng |
|---|---|
| `1` | Tạo một địa chỉ edu |
| `2` | Tạo nhiều địa chỉ edu |
| `3` | Xem danh sách địa chỉ đã lưu |
| `4` | Xem hộp thư gần nhất |
| `5` | Đăng nhập lại địa chỉ gần nhất |
| `9` | Sửa tên miền, tên và mật khẩu mặc định |
| `0` | Thoát |

### 4.3. Tạo mail bằng dòng lệnh

```powershell
npm run edu:create
npm run edu:batch
node mail/getedumail-auto.mjs --count 5
node mail/getedumail-auto.mjs --domain iunp.edu.rs
```

Bản thân `getedumail-auto.mjs` dùng `getedumail-core.mjs`; không cần mở trình duyệt.

### 4.4. Tạo mail bằng thư viện

```powershell
node --input-type=module -e "import { createAccount } from './mail/getedumail-core.mjs'; const a=await createAccount({domain:'iunp.edu.rs',log:console.log}); console.log(a.email)"
```

Thay `iunp.edu.rs` bằng tên miền còn hiển thị trong giao diện GetEduMail.

`grok/reg-grok.mjs` tự gọi cùng hàm này khi không tìm thấy mail edu cũ chưa dùng.

### 4.5. Tệp kết quả

- `mail/acc/N.json`: tài khoản edu thứ `N`.
- `mail/acc/latest.json`: tài khoản edu gần nhất.
- `mail/getedumail-latest.json`: tệp tương thích cũ.
- `mail/getedumail-api-test-last.json`: kết quả kiểm tra API nếu có chạy kiểm tra.

Không chia sẻ các tệp này vì chúng có thể chứa mật khẩu, mã truy cập hoặc thông tin hộp thư.

### 4.6. Cấu hình mail

`mail/config.json`:

```json
{
  "configSeen": false,
  "domain": "iunp.edu.rs",
  "name": "Alex Kowalski",
  "password": "",
  "openBrowserAfterCreate": false,
  "randomName": true,
  "proxy": ""
}
```

| Khóa | Ý nghĩa |
|---|---|
| `domain` | Tên miền edu mặc định |
| `name` | Họ tên dùng khi đăng ký GetEduMail |
| `password` | Mật khẩu tài khoản GetEduMail |
| `openBrowserAfterCreate` | Có mở trình duyệt sau khi tạo mail hay không |
| `randomName` | Dùng tên ngẫu nhiên thay cho `name` |
| `proxy` | Proxy nếu luồng mail cần dùng proxy |

---

## 5. Phần Grok/xAI

### 5.1. Luồng đăng ký một tài khoản

```text
1. Chọn tài khoản edu cũ chưa đăng ký Grok hoặc tạo tài khoản edu mới
2. Xóa phiên xAI cũ nếu còn đăng nhập
3. Mở trang đăng ký xAI
4. Chọn đăng ký bằng email
5. Điền địa chỉ edu
6. Đọc OTP từ hộp thư GetEduMail
7. Điền họ, tên và mật khẩu Grok
8. Xử lý Cloudflare Turnstile
9. Bấm Complete sign up
10. Chờ rời khỏi trang sign-up
11. Lưu kết quả
12. Nếu bật 9router, xác thực device OAuth và giữ phiên đăng nhập
```

Bước kiểm tra đăng nhập riêng đã được loại khỏi luồng chính. Đăng ký được xem là hoàn tất khi trang rời khỏi `sign-up` hoặc chuyển sang trang tài khoản/app.

### 5.2. Lệnh đăng ký

```powershell
npm run grok:menu
npm run grok:fresh
npm run grok:reuse
npm run grok:multi -- -n 5 -w 2
npm run grok:multi -- -n 5 -w 3 --headless
```

| Lệnh | Chức năng |
|---|---|
| `npm run grok:menu` | Mở trình đơn Grok |
| `npm run grok:fresh` | Tạo mail edu mới rồi đăng ký Grok |
| `npm run grok:reuse` | Dùng tài khoản edu gần nhất |
| `npm run grok:multi -- -n 5 -w 2` | Chạy 5 lượt với 2 tác vụ song song |
| `npm run grok:multi -- -n 5 -w 3 --headless` | Chạy 5 lượt, 3 tác vụ song song, ẩn trình duyệt |

Có thể gọi trực tiếp:

```powershell
node grok/reg-grok.mjs --fresh --user-chrome --yes
node grok/reg-grok.mjs --reuse --user-chrome --yes
node grok/reg-multi.mjs --count 5 --workers 2
node grok/reg-multi.mjs --count 5 --workers 3 --headless
```

### 5.3. Chạy nhiều luồng

`grok/reg-multi.mjs` tạo các tiến trình con độc lập:

```powershell
node grok/reg-multi.mjs --count 10 --workers 3
```

- `--count`: tổng số lượt đăng ký.
- `workers`: số tác vụ chạy song song, tối đa 8.
- `--retries`: số lần thử lại cho mỗi lượt, tối đa 3.
- `--headless`: chạy Playwright với trình duyệt ẩn.

Khuyến nghị:

- Chrome hiện: `workers` từ 1 đến 2.
- Chế độ ẩn: `workers` từ 2 đến 4.
- Không đặt số tác vụ quá cao vì xAI, GetEduMail, hộp thư tạm và proxy đều có giới hạn tốc độ.
- Nhiều tác vụ dùng chung một proxy dễ làm tăng lỗi giới hạn hoặc bị từ chối.

### 5.4. Cấu hình Grok

`grok/config.json`:

```json
{
  "configSeen": false,
  "domain": "iunp.edu.rs",
  "domains": [
    "iunp.edu.rs",
    "iitp.edu.rs",
    "warsawuni.edu.pl"
  ],
  "headless": false,
  "workers": 2,
  "reuseUnusedEdu": true,
  "autoClickCaptcha": true,
  "name": "Alex Kowalski",
  "password": "",
  "openBrowserAfterCreate": false,
  "randomName": true,
  "proxy": "",
  "nineRouter": {
    "autoAuth": false,
    "baseUrl": "http://127.0.0.1:20128",
    "namePrefix": "edu-auto"
  }
}
```

| Khóa | Ý nghĩa |
|---|---|
| `domain` | Tên miền mặc định khi tạo edu |
| `domains` | Danh sách tên miền được luân phiên khi thử tạo mail |
| `headless` | `true` để ẩn trình duyệt; `false` để hiện Chrome người dùng |
| `workers` | Số tác vụ mặc định cho đăng ký nhiều lượt |
| `reuseUnusedEdu` | Dùng mail trong `mail/acc/` chưa xuất hiện trong kết quả Grok trước |
| `autoClickCaptcha` | Tự click ô Cloudflare Turnstile khi có thể |
| `name` | Tên mặc định khi tắt tên ngẫu nhiên |
| `password` | Mật khẩu Grok cố định; để trống để dùng mật khẩu edu hoặc mật khẩu ngẫu nhiên |
| `randomName` | Chọn tên ngẫu nhiên từ `mail/names.json` nếu tệp tồn tại |
| `proxy` | Proxy mặc định cho Playwright |
| `nineRouter.autoAuth` | Tự xác thực 9router sau khi đăng ký thành công |
| `nineRouter.baseUrl` | Địa chỉ API cục bộ của 9router |
| `nineRouter.namePrefix` | Tiền tố tên kết nối trong 9router |

### 5.5. Tên miền edu

Tên miền mặc định hiện tại là `iunp.edu.rs`. Danh sách `domains` chỉ nên chứa các tên miền đang thật sự xuất hiện trong giao diện GetEduMail và còn tạo được địa chỉ.

Nếu một tên miền không còn trong giao diện hoặc trả lỗi liên tục:

1. Xóa tên miền đó khỏi `domains`.
2. Đặt tên miền đang hoạt động vào `domain`.
3. Tắt hoặc giảm số tác vụ.
4. Không cố thử liên tục khi dịch vụ đang giới hạn.

### 5.6. Dùng lại mail edu cũ

Khi `reuseUnusedEdu` là `true`, Grok kiểm tra các tệp trong `mail/acc/`, loại địa chỉ đã xuất hiện trong `grok/acc/grok-results.jsonl`, rồi ưu tiên dùng địa chỉ cũ chưa đăng ký Grok.

Muốn luôn tạo mail mới:

```json
{
  "reuseUnusedEdu": false
}
```

Muốn dùng đúng tài khoản edu gần nhất:

```powershell
npm run grok:reuse
```

---

## 6. Cloudflare Turnstile

Khi `autoClickCaptcha` là `true`, công cụ sẽ:

1. Chờ widget Turnstile xuất hiện.
2. Tìm iframe Cloudflare.
3. Click vùng checkbox bên trái iframe.
4. Thử locator trong iframe nếu click tọa độ không thành công.
5. Kiểm tra token và trạng thái xác minh với chu kỳ ngắn.
6. Thử lại sau khi widget báo lỗi.
7. Bấm `Complete sign up` sau khi captcha được xác nhận.

Tắt tự click:

```json
{
  "autoClickCaptcha": false
}
```

Khi tắt, cần tự xử lý captcha trên trình duyệt hiện ra. Không phải mọi thử thách Cloudflare đều có thể tự click; thử thách hình ảnh hoặc xác minh bổ sung cần thao tác thủ công.

---

## 7. Chế độ trình duyệt

### 7.1. Hiện trình duyệt

Mặc định `headless` là `false`. Công cụ tự khởi chạy hoặc gắn vào Chrome người dùng qua CDP cổng `9222` khi cần.

```powershell
npm run grok:fresh
```

Nếu Chrome đang chạy mà không gắn được CDP, đóng Chrome rồi chạy lại lệnh trên để công cụ khởi tạo phiên sạch.

### 7.2. Ẩn trình duyệt

Đặt trong `grok/config.json`:

```json
{
  "headless": true
}
```

Hoặc chỉ áp dụng cho một lần:

```powershell
node grok/reg-multi.mjs --count 5 --workers 3 --headless
```

Chế độ ẩn dùng Playwright, không dùng phiên Chrome người dùng qua CDP. Vì vậy trạng thái đăng nhập cũ của Chrome người dùng không được dùng lại.

---

## 8. 9router

### 8.1. Điều kiện

- Ứng dụng 9router đang chạy.
- API mặc định ở `http://127.0.0.1:20128`.
- Có tệp khóa cục bộ trong thư mục dữ liệu 9router.
- Tài khoản đã đăng ký thành công và còn phiên xAI.

Bật trong `grok/config.json`:

```json
{
  "nineRouter": {
    "autoAuth": true,
    "baseUrl": "http://127.0.0.1:20128",
    "namePrefix": "edu-auto"
  }
}
```

### 8.2. Kiểm tra 9router

```powershell
npm run 9r:ping
```

### 8.3. Xác thực thủ công

```powershell
npm run 9r:device
```

Luồng đúng dùng nhà cung cấp `grok-cli`:

```text
1. 9router tạo device code
2. Mở URL xác thực xAI
3. Continue và đăng nhập nếu cần
4. Bấm Allow
5. 9router tự poll trạng thái
6. 9router tạo kết nối OAuth trong danh sách Grok Build
```

Không dùng đường dẫn `xai/exchange` để đẩy JWT tùy ý. Cách đó có thể tạo kết nối `xai` dạng `access_token`, tên `Account N`, không có email và không phải kết nối Grok Build mong muốn.

Sau khi 9router xác thực thành công, công cụ giữ cookie phiên xAI và không logout. Nếu tắt `autoAuth`, công cụ sẽ xử lý logout và xóa dữ liệu phiên theo luồng thông thường.

---

## 9. Proxy

Kiểm tra proxy:

```powershell
npm run proxy:test
```

Chọn proxy:

```powershell
npm run proxy:pick
```

Định dạng proxy:

```text
host:port:user:password
```

Danh sách cục bộ đặt trong `grok/proxies.txt`. Tệp này có thể chứa thông tin đăng nhập proxy nên đã bị loại khỏi Git.

Khuyến nghị:

- Kiểm tra proxy trước khi chạy nhiều tác vụ.
- Không dùng cùng một proxy cho quá nhiều tác vụ.
- Không ghi mật khẩu proxy vào `config.example.json`.
- Nếu Chrome người dùng đã có proxy, cấu hình proxy trong Chrome thay vì truyền lại cho Playwright.

---

## 10. Kết quả và nhật ký

Kết quả Grok được lưu cục bộ trong `grok/acc/`:

- `grok-latest.json`: kết quả gần nhất.
- `grok-results.jsonl`: mỗi lượt một dòng JSON.
- `grok-ok-*.json`: bản ghi lượt thành công.
- `grok-unknown-*.json`: bản ghi trạng thái chưa xác định.
- `xai-oauth-latest.json`: bản sao dữ liệu liên quan đến 9router nếu có.

Kết quả mail được lưu trong `mail/acc/`:

- `N.json`: từng tài khoản edu.
- `latest.json`: tài khoản edu gần nhất.

Không sửa hoặc xóa kết quả khi một tác vụ khác vẫn đang chạy. Đặc biệt, nhiều tác vụ cùng cập nhật tệp `latest.json` có thể làm tài khoản gần nhất thay đổi theo thứ tự hoàn thành.

---

## 11. Mã thoát

| Mã | Ý nghĩa |
|---:|---|
| `0` | Đăng ký thành công |
| `2` | Lỗi luồng hoặc đăng ký chưa hoàn tất |
| `7` | Tài khoản bị khóa hoặc đình chỉ |
| `8` | Mật khẩu không đúng trong luồng kiểm tra cũ |
| `9` | Email không tồn tại trong luồng kiểm tra cũ |

Luồng hiện tại không chạy bước kiểm tra đăng nhập riêng sau đăng ký. Trạng thái thành công dựa trên việc hoàn tất đăng ký và rời trang `sign-up`.

---

## 12. Xử lý lỗi thường gặp

### `Max number of temporary email accounts are exceeded`

- Giảm số tác vụ.
- Chờ trước khi thử lại.
- Kiểm tra dịch vụ hộp thư tạm.
- Không tạo quá nhiều tài khoản đồng thời.

### `guest 400`

Luồng hiện tại ưu tiên mail tạm để đăng ký GetEduMail rồi nhận quyền sở hữu địa chỉ edu, nhằm tránh giới hạn hộp thư khách. Kiểm tra kết nối tới `api.mail.tm` và mã OTP trong hộp thư tạm.

### `OTP timeout`

- Kiểm tra token GetEduMail.
- Kiểm tra hộp thư tạm có nhận thư hay không.
- Chờ thêm rồi thử lại.
- Không dùng lại địa chỉ đã claim hoặc đã hết hạn.

### `step=unknown` hoặc không thấy biểu mẫu email

- Đảm bảo Chrome không bị phiên cũ chặn khi công cụ chuẩn bị CDP.
- Đóng Chrome rồi chạy lại `npm run grok:fresh` để công cụ tạo phiên sạch.
- Xóa phiên xAI cũ theo luồng đăng xuất.
- Thử `--headless --playwright` để tách khỏi phiên Chrome hiện tại.

### Cloudflare không tự click

- Đặt `autoClickCaptcha` thành `false` và xử lý thủ công.
- Dùng trình duyệt hiện thay vì headless.
- Kiểm tra kích thước và vị trí iframe.
- Không bấm liên tục; Cloudflare có thể thay widget sau mỗi lần thử.

### `403 Access denied` từ xAI

Đây thường là từ chối phía xAI đối với tài khoản, tên miền, địa chỉ IP hoặc kết nối OAuth; không đồng nghĩa với lỗi điền mật khẩu. Hãy:

1. Dừng thử lại liên tục.
2. Giảm số tác vụ và đổi proxy hợp lệ nếu cần.
3. Kiểm tra tên miền còn hoạt động trên GetEduMail.
4. Tắt 9router để xác định lỗi nằm ở đăng ký hay bước OAuth.
5. Không đưa tài khoản bị từ chối vào danh sách retry vô hạn.

### 9router tạo `Account N` hoặc email trống

Kiểm tra nhà cung cấp là `grok-cli`, không phải `xai`. Chạy:

```powershell
npm run 9r:ping
```

Sau đó dùng lại device OAuth qua:

```powershell
npm run 9r:device
```

### Lỗi thiếu module

Đảm bảo đang chạy tại thư mục gốc và đã cài phụ thuộc:

```powershell
npm install
```

Không tách riêng `grok/` khỏi `mail/` vì `grok/reg-grok.mjs` nhập thư viện từ `mail/getedumail-core.mjs`.

---

## 13. Bảo mật

Không đưa các tệp sau lên Git hoặc gửi cho người khác:

- `grok/config.json`.
- `mail/config.json`.
- `grok/proxies.txt`.
- `grok/acc/`.
- `mail/acc/`.
- `xai-oauth*.json`.
- `getedumail-latest.json`.
- Hồ sơ trình duyệt `.pw-*`.
- Mật khẩu, cookie, token, khóa proxy và khóa API.

Các tệp mẫu chỉ chứa giá trị minh họa. Nếu một khóa hoặc mật khẩu đã lỡ đưa lên Git, hãy đổi hoặc thu hồi ngay tại dịch vụ tương ứng.

---

## 14. Ghi chú phát triển

Kiểm tra cú pháp các tệp JavaScript:

```powershell
node --check grok/grok-menu.mjs
node --check grok/nine-router-auth.mjs
node --check grok/proxy.mjs
node --check grok/reg-grok.mjs
node --check grok/reg-multi.mjs
node --check grok/turnstile.mjs
node --check mail/getedumail-core.mjs
```

Kiểm tra JSON:

```powershell
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); JSON.parse(require('fs').readFileSync('grok/config.example.json','utf8')); JSON.parse(require('fs').readFileSync('mail/config.example.json','utf8')); console.log('JSON hợp lệ')"
```

Mọi thay đổi cần giữ nguyên các nguyên tắc:

- Không ghi khóa bí mật vào mã nguồn.
- Không lưu tài khoản thật trong tệp mẫu.
- Không retry vô hạn đối với lỗi giới hạn hoặc `403`.
- Giữ `mail/` và `grok/` đồng cấp.
- Ưu tiên chạy ít tác vụ và xác minh từng bước trước khi tăng tải.
