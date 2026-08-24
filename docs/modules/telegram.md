<!-- module-version: 1 -->

# Module: telegram

Notification/retry/evidence.

## Gửi chuẩn
- `node scripts/notify-telegram.mjs --event '<json>'` với `{eventType, repo, ref, state, summary, nextAction, link}`.
- Shell nuốt nháy kép → ghi JSON ra file tạm, dùng `--event-file <path>`.

## Idempotency & retry
- Khóa `repo::ref::eventType::state` (lưu `~/.qldadtxd/notify-keys.json`); state đổi → gửi lại hợp lệ.
- Lõi pure: `scripts/tg-notify-core.mjs` — `withRetry` tối đa 3 lần; mark SENT chỉ sau khi gửi thành công.

## Fail-closed
- Không kết thúc phiên khi notifier FAIL — ghi bằng chứng, không báo hoàn thành.
- `nextAction` luôn nêu rõ việc người dùng cần làm tiếp (nhất là needs-input/blocked).

## Bảo mật
- KHÔNG gửi token/key/secret vào tin nhắn; KHÔNG báo cáo task con vào group nghiệp vụ.
