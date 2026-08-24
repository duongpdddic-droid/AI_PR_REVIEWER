<!-- module-version: 1 -->

# Module: memory-bank

Read/update/checkpoint bộ nhớ thực thi (`memory-bank/`).

## Thứ tự đọc
`activeContext.md` → `progress.md`; chỉ đọc thêm file khác khi task cần.

## Ghi sau mỗi milestone
- `[x]` chỉ khi có evidence thật: file changed + change chính + verification.
- Giờ ghi bắt buộc `dd/MM/yyyy HH:mm` lấy từ lệnh hệ thống, cấm bịa.
- Lỗi phải sửa trong phiên → entry `L-NNN` vào `consolidatedLearnings.md` (Triệu chứng → Nguyên nhân gốc → Tránh lặp lại) ngay sau fix+verify.

## Checkpoint context
- ~70% context window: dừng tại ranh giới milestone an toàn, flush `activeContext.md` (+ dòng "Checkpoint"), compact/restart, recovery từ Next Step.
- Compact KHÔNG phải hoàn thành — chưa verify/evidence thì báo IN PROGRESS.
