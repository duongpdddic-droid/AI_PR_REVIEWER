<!-- module-version: 1 -->

# Module: escalation

Blocked, Decision Gate, GPT/user escalation.

## Khi được dừng hỏi người dùng
1. Nhiều task hợp lệ/mâu thuẫn, không xác định được ưu tiên.
2. Mở rộng phạm vi hoặc quyết định kỹ thuật lớn ngoài Issue.
3. Merge, deploy, force-push, reset, xóa dữ liệu — hành động phá hủy/khó hoàn tác.
4. Thiếu quyền truy cập hoặc bằng chứng không thể tự xác minh.
5. Đạt `status:blocked` hoặc Decision Gate.

Ngoài 5 trường hợp trên: tự thực hiện trọn workflow an toàn, không dừng xin phép từng bước.

## Quy trình blocked
1. Cập nhật GitHub state trước (`status:blocked` / label tương ứng).
2. Gửi Telegram đúng 1 lần qua `--event` với `nextAction` rõ ràng.
3. Dừng chờ — không tự suy diễn câu trả lời để tiếp tục.

## Lệnh tối thiểu
`Xử lý tiếp.` / `Thực thi tiếp.` = tự khám phá và tiếp tục toàn bộ workflow an toàn đang hoạt động.
