# AN TOÀN TERMINAL VÀ SHELL

## 1. Môi trường
Terminal là Windows PowerShell.
Cấm dùng trực tiếp: `grep`, `sed`, `awk`, `head`, `tail`, `cat`.
Ưu tiên tool tích hợp: `read_file`, `search_files`, `write_to_file`, các công cụ đọc/sửa file native của Cline.
Không dùng shell nếu tool tích hợp đã đáp ứng được yêu cầu.

## 2. PowerShell
Khi bắt buộc dùng shell để đọc text:
`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Content -Encoding utf8 <path>`
Dùng `Select-Object -First` / `Select-Object -Last` thay cho `head`/`tail`.

## 3. Node.js
- Cấm `node -e "..."` inline.
- Cho phép tạo temporary Node.js script bằng tool tích hợp khi cần xử lý text/logic phức tạp.
- Script tạm phải có cleanup trong `finally` và tự xóa sau khi chạy.

## 4. Lệnh destructive
Không tự thực thi: `git push -f`, `git reset --hard`, `git clean -fd`, `rm -rf`, `rd /s /q`, cài package global.
Nếu cần destructive action → Decision Gate.

## 5. Lệnh power state (shutdown / sleep / hibernate)
Mặc định KHÔNG tự thực thi — thuộc nhóm hành động hệ thống.
**Ngoại lệ có điều kiện**: khi Bố ra chỉ thị dạng "sau khi xong task thì ngủ đông / sleep / tắt máy", Cline ĐƯỢC PHÉP chạy lệnh tương ứng sau khi task thực sự hoàn thành và báo Bố:
- Ngủ đông: `shutdown /h` (hoặc `rundll32.exe powrprof.dll,SetSuspendState 0,1,0`)
- Sleep: `rundll32.exe powrprof.dll,SetSuspendState 0,1,0`
- Tắt máy: `shutdown /s` (nên kèm hoãn, ví dụ `/t 60`)

Điều kiện bắt buộc:
1. Chỉ thị rõ ràng, nêu tên hành động và điều kiện kích hoạt ("sau khi xong task").
2. Chỉ chạy khi task hoàn thành + verification xong + Memory Bank cập nhật.
3. Báo Bố trước khi chạy (1 câu: lệnh gì, sẽ chạy).
4. Không chạy nếu task còn defer issue chặn, tiến trình đang chạy quan trọng, hoặc có dấu hiệu máy đang dùng.

Cơ chế watchdog tự động (`scripts/watchdog-hibernate.mjs`): xem đầy đủ điều kiện tại `01-execution-workflow.md` §7–8. Nguyên tắc chung: KHÔNG tự ý shutdown/sleep/hibernate ngoài 2 cơ chế đã liệt kê (chỉ thị trực tiếp / watchdog đã duyệt).
