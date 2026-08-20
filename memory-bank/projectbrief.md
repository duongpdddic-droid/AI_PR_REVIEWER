# Tóm tắt dự án (projectbrief.md)

## Mục tiêu
Khởi tạo bộ khung điều phối độc lập cho agent AI PR Reviewer.
Tận dụng toàn bộ kiến trúc điều phối (rules Cline, Memory Bank, scripts verify, giao thức handoff GitHub, configs CLI agent) nhưng không lưu bất kỳ mã nguồn hay dữ liệu nghiệp vụ nào của dự án cũ.

## Phạm vi
- Điều phối agent Cline / GPT / Reviewer cục bộ qua GitHub (Issue, PR, nhãn nhãn, CI).
- Bộ công cụ kiểm tra tự động: `full-verify.mjs`, behavior map, kiểm thử logic thuần.
- Thông báo Telegram và tiếp nhận công việc từ GitHub.

## Ngoài phạm vi (v0 - bộ khung ban đầu)
- Mã nguồn ứng dụng cụ thể (sẽ được bổ sung vào `src/` theo từng tác vụ sau).
- Không chứa dữ liệu Google Sheets / CSV / Apps Script.