# CHIẾN LƯỢC KIỂM THỬ & CODE REVIEW

## 1. Nguyên tắc
- Test là deliverable, không phải afterthought. Khi thêm/sửa logic không tầm thường, PHẢI kèm cách kiểm chứng (tự động hoặc thủ công).
- Thực chứng trước khi tuyên bố xong: không kết luận sớm từ giả định, phải validate thực tế (chạy, parse, diff).

## 2. Phân tầng (Test Pyramid rút gọn — GAS + HTML Vanilla, chưa có test framework)
- Unit / syntax (nhiều, nhanh): `node scripts/full-verify.mjs` là orchestrator verify DUY NHẤT trước push (gồm `node --check`, BOM, dup function/id — chi tiết xem `06-gas-deployment.md` §1). Script tạm node (xóa sau) assert logic phức tạp (vd: `scripts/test-pure-logic.mjs` cho pure-logic tách ra).
- Integration (vừa): kiểm tra đồng bộ CSV→Sheet, `MA_TIEN_NHIEM`/`MA_LIEN_KET_ME` tham chiếu chéo (verify 0 orphan / 0 self-ref).
- E2E (ít): manual test trên Web App (deploy `@N`) cho UI/luồng người dùng.

## 3. Vùng BẮT BUỘC test (mọi hàm/logic)
- Happy path: input hợp lệ → output đúng.
- Edge cases: `null`/`undefined`, chuỗi rỗng, 0, boundary, max-length, ký tự đặc biệt.
- Error path: input sai, timeout, quyền bị từ chối, I/O fail.
- State transitions: trước/sau mutation, side effect.

## 4. Checklist chất lượng test
- [ ] Tên test mô tả kịch bản (không `test1`).
- [ ] AAA (Arrange-Act-Assert) rõ ràng.
- [ ] Không phụ thuộc thứ tự chạy.
- [ ] Không hardcoded sleep; dùng polling/event.
- [ ] Assertion cụ thể, không chỉ "không throw".

## 5. Coverage
- Không đuổi 100%. Tập trung business-critical (parse CSV, ánh xạ mã, phân quyền).
- Code chưa cover phải có lý do (UI rendering → E2E thủ công).

## 6. Code Review (khi review code)
### Quy trình
1. Hiểu context (đọc code + file liên quan) trước khi phê bình.
2. Phân loại theo mức độ nghiêm trọng.
3. Cụ thể & actionable: vấn đề + tại sao + gợi ý fix (kèm snippet).

### Phân loại
- 🔴 Critical: bug, lỗ hổng bảo mật, rủi ro mất dữ liệu.
- 🟡 Important: performance, thiếu xử lý lỗi, logic sai.
- 🟢 Suggestion: readability, naming, style, đơn giản hóa.

### Điểm soát
- Correctness: off-by-one, edge (`null`/empty/boundary), race condition, sai giả định về shape/API.
- Security: input chưa sanitize (XSS/SQLi/injection), secret hardcode, thiếu authn/authz, xử lý dữ liệu nhạy cảm.
- Performance: lặp gọi service N+1, tính toán lặp, memory leak, blocking nên async.
- Maintainability: hàm làm nhiều việc, logic trùng, naming mơ hồ, dead code.
- Error handling: exception nuốt (không log), thiếu `try/catch` ở I/O, message lỗi mù mờ, thiếu cleanup khi fail.

### Output format
Nhóm theo severity. Mỗi finding: file + dòng + vấn đề + rủi ro + fix. Kết thúc bằng tóm tắt chất lượng & action quan trọng nhất.
