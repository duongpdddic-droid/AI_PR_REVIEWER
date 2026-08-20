# Bối cảnh sản phẩm (productcontext.md)

## Vấn đề cần giải quyết
Khi ChatGPT / API bị giới hạn tốc độ hoặc không khả dụng, một reviewer cục bộ dự phòng
cần đọc bản diff, chạy bài kiểm thử và đăng các finding lên GitHub mà không làm giảm
tính độc lập của pipeline review.

## Người dùng mục tiêu
Người phát triển muốn vận hành quy trình review tự động kết hợp local và cloud.

## Trải nghiệm mong đợi
- Cline thực hiện và sửa lỗi theo từng finding. Reviewer (local hoặc GPT) đăng các finding
  một cách độc lập.
- GitHub duy trì vai trò nguồn chân cho việc bàn giao trạng thái.

## Ràng buộc
- Reviewer chỉ đọc mã nguồn, không điều chỉnh trực tiếp vào code.
- Quy tắc ghi nhận finding: `[LOCAL-REV-NNN]` hoặc `[GPT-REV-NNN]`.
- Không tự động merge hoặc deploy.