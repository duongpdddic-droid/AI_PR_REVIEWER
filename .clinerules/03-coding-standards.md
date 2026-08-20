# TIÊU CHUẨN LẬP TRÌNH VÀ FRONTEND

## 1. Môi trường & Stack
- Node.js dùng `pnpm` (CẤM npm/yarn cho thao tác).
- TypeScript strict mode.
- Python 3.10+.
- Ngoại lệ Apps Script: JavaScript thuần nếu repository yêu cầu.
- File text (`Backend/*.js`, `*.csv`, `*.md`, `*.json` config) phải **UTF-8, không BOM** (`U+FEFF`). GAS/CSV nhạy cảm BOM → luôn kiểm tra trước push (xem `06-gas-deployment.md`).
- Khi sửa file >200 dòng: ưu tiên edit dạng diff (thay thế đoạn nhỏ / insert tại dòng cụ thể) thay vì đọc rồi ghi lại toàn file — giảm rủi ro mất nội dung và lãng phí token.

## 2. Đặt tên
- Hàm/biến: `camelCase`.
- Hằng số: `UPPER_SNAKE_CASE`.
- Type/component: `PascalCase`.
- File/folder: `kebab-case`.
- Interface không dùng tiền tố `I`.
- Không dùng tên mơ hồ (`process`, `handle`, `doStuff`, `usr`, `cfg`, `btn`) nếu có thể cụ thể.

## 3. Quy ước hàm
- `get...`: đọc dữ liệu đồng bộ.
- `fetch...`: truy xuất async/IO.
- `calculate...`: tính toán.
- `is...`, `has...`: boolean.
- `validate...`, `assert...`: validation.

## 4. API Error
Dùng envelope: `{ success: false, error: { code, message, details?, traceId } }`.
Không trả HTTP 200 cho lỗi nếu status code phù hợp có thể biểu đạt lỗi.

## 5. Frontend Web Vanilla (áp dụng `QLDA_DDIC.html`)
- **XSS (quan trọng nhất)** — hierarchy render từ an toàn nhất:
  1. `.textContent` — LUÔN dùng cho text (tự escape, chặn XSS).
  2. `document.createElement()` + `.append()` — an toàn cấu trúc.
  3. `innerHTML` — NGUY HIỂM. Cấm với dữ liệu user/API. Nếu bắt buộc: comment `// DANGER: MUST sanitize` + lib.
- **JS**: `let`/`const` không `var`; `async/await` cho fetch/async; magic value lặp → `const` đầu file; hàm không tầm thường → JSDoc ngắn; validate input tại trust boundary (form/modal có label).
- **Perf & Memory**: event delegation trên parent cho list con; cleanup `removeEventListener` khi xóa element; dọn `setInterval`/`setTimeout`.
- **HTML & A11y**: semantic HTML; mọi `<img>` có `alt`; element tương tác keyboard-accessible; input quan trọng có `<label>`.
- **CSS**: CSS Custom Properties (`--color-primary`) cho theming; mobile-first responsive; hạn chế `!important`.
- **RPC/UI** (`google.script.run`): xem `06-gas-deployment.md` §9.
- **Quy tắc chung**: state-first (thiết kế state vững trước khi thêm feature); tăng dần (đơn giản → phức tạp, test sau mỗi bước).


## Giao tiếp & Kết quả
- Tất cả ngôn ngữ giao tiếp, mô tả, comment và báo cáo **phải bằng tiếng Việt**. Chỉ dùng tiếng Anh khi chứa tên kỹ thuật, hàm, file, hoặc ký tự code.

## 6. Quality Gate
Nếu project có cấu hình tương ứng, chạy:
- `pnpm lint`;
- `pnpm test`;
- `pnpm build`.
