## Issue liên quan

Ref #
<!-- Chỉ dùng "Closes #" khi PR này hoàn tất trọn vẹn Issue. -->

## HEAD đã pre-review

- Full SHA: `<điền full 40-hex SHA của commit cuối>`
- Kết quả CI: PASS (required checks theo `.github/ai-review-policy.json`)
- Pre-review: `PRE_REVIEW_PASS` (reviewer:local) — approval cuối thuộc GPT qua `scripts/gpt-approval.mjs`

## Mục tiêu

Mô tả ngắn gọn kết quả của thay đổi này.

## Phạm vi đã thay đổi

- File/module:
- Hàm hoặc khu vực:
- Không thay đổi:

## Thay đổi đã thực hiện

- [ ] Thay đổi 1
- [ ] Thay đổi 2
- [ ] Cập nhật test liên quan
- [ ] Cập nhật Memory Bank

## Bằng chứng kiểm tra

### Kiểm tra tổng hợp

```text
pnpm verify
Kết quả:
```

### Unit test

```text
pnpm test
Kết quả:
```

### Kiểm tra thủ công

- Kịch bản:
- Kết quả:
- Ảnh hoặc bằng chứng:

## Rủi ro và ảnh hưởng

- Mức rủi ro: Thấp / Trung bình / Cao
- Ảnh hưởng dữ liệu:
- Có cần deploy: Có / Không
- Khả năng hoàn tác:

## Tự kiểm tra phạm vi

- [ ] Chỉ sửa các file được Issue cho phép
- [ ] Không thực hiện refactor ngoài phạm vi
- [ ] Không chứa secret hoặc dữ liệu nhạy cảm
- [ ] Không có file tạm, backup hoặc log
- [ ] Không tự ý deploy
- [ ] Không tự ý merge vào `main`

## Trạng thái bàn giao

- [ ] Draft — Cline đang thực hiện
- [ ] Ready for GPT review (`status:review-requested` + `agent:gpt`; CI PASS + PRE_REVIEW_PASS tại HEAD ghi trên)
- [ ] Đã xử lý toàn bộ review thread

## Ghi chú cho GPT (final reviewer)

Liệt kê khu vực cần GPT kiểm tra kỹ hoặc quyết định còn mở.
GPT phê duyệt cuối được relay qua `node scripts/gpt-approval.mjs --repo <o/r> --pr <n> --note "<quyết định>"`;
merge/deploy vẫn do người dùng thực hiện.
