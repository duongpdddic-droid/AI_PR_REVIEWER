# BẢO MẬT VÀ QUẢN LÝ SECRET

## 1. OWASP cơ bản
- Parameterized query 100%; không nối chuỗi dữ liệu người dùng vào SQL/NoSQL query.
- Authorization phải được kiểm tra tại service layer cho tài nguyên cần bảo vệ.
- Refresh Token lưu trong `HttpOnly Secure Cookie`.
- Không lưu JWT/Refresh Token vào `localStorage` hoặc `sessionStorage`.

## 2. Cấm in/log/trích dẫn secret (tuyệt đối)
- KHÔNG BAO GIỜ đọc hoặc in giá trị thật của env/API keys/token/mật khẩu/nội dung file cấu hình (`*.env`, `*.json` secret) ra khung chat — chỉ tham chiếu bằng tên file/cấu trúc cấu hình.
- Khi báo cáo xong việc liên quan secret: CHỈ ghi tóm tắt tên file + trạng thái (Ví dụ: "Đã di chuyển key.env thành công"), TUYỆT ĐỐI KHÔNG trích dẫn nội dung bên trong.
- Coi file đuôi `.env`, `*key*`, `*secret*`, `*token*` là vùng cấm in nội dung.
- Telegram token: `~/.qldadtxd/tg.json` (ngoài repo) — KHÔNG đưa vào source.

## 3. Security Audit (kích hoạt: yêu cầu audit / pre-deploy / đổi dependency / đánh giá tuân thủ)
### Phase 1 — Recon
- Attack surface: API, input người dùng, file upload, endpoint auth, admin panel.
- Trust boundaries: chỗ dữ liệu đi từ untrusted → trusted.
- Sensitive data: PII, token, credentials.
- Dependencies: lib bên thứ 3, external service.

### Phase 2 — Phân tích hệ thống (OWASP)
- A. Injection (A03): query parameterized 100%; không nối chuỗi input; template auto-escape.
- B. Authn & Session (A07): token random mật mã, có expiry/rotation, không hardcode secret, rate-limit login.
- C. Authz & Access Control (A01): mọi endpoint ép authz (không chỉ authn); IDOR; admin không bị vượt qua bằng client state; CORS chỉ origin mong đợi.
- D. Sensitive Data Exposure (A02): không hardcode secret; không log dữ liệu nhạy cảm; encrypt at rest/in transit; error message không lộ internal.
- E. Security Misconfig (A05): scope `appsscript.json` least-privilege; không lộ `.env`.
- F. Vulnerable Dependencies (A06): `pnpm audit` đã chạy; không CVE critical/high; lockfile committed.

### Phase 3 — Secrets scan (regex qua `search_files`)
- API key: `(api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9]`
- AWS: `AKIA[0-9A-Z]{16}`
- Generic: `(password|secret|token)\s*[:=]\s*['"][^'"]+`
- Private key: `-----BEGIN (RSA |EC |)PRIVATE KEY-----`
- Connection string: `(mongodb|postgres|mysql|redis):\/\/[^\s]+`

## 4. Threat Modeling (STRIDE)
| Threat | Câu hỏi | Ví dụ |
|--------|---------|-------|
| Spoofing | Giả mạo user/system? | JWT giả, session hijack |
| Tampering | Sửa dữ liệu trái phép? | thao túng param URL, payload không sign |
| Repudiation | Phủ nhận hành động? | thiếu audit log admin |
| Info Disclosure | Đọc dữ liệu không được phép? | IDOR, error verbose |
| DoS | Làm hệ thống không dùng được? | query vô hạn, thiếu rate limit, regex DoS |
| Elevation | Leo quyền? | thiếu role check, thao túng JWT claim |

## 5. Pre-completion checklist & Severity
- [ ] 10 hạng mục OWASP đã đánh giá.
- [ ] Secrets scan đã chạy.
- [ ] Findings phân loại severity + remediation cụ thể.
- [ ] Executive summary (tổng theo mức độ, top 3 ưu tiên).
- Severity: CRITICAL (sửa trước deploy) / HIGH (sprint này) / MEDIUM (track) / LOW (opportunistic).
