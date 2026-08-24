<!-- module-version: 1 -->

# Invariants (luôn tải cho mọi task)

Không task nào được vi phạm các điều sau, bất kể vai trò:

1. **GPT là reviewer phê duyệt cuối duy nhất**; local/CI không bao giờ `status:approved`; CI PASS ≠ approval.
2. **Approval khóa full HEAD SHA** — HEAD đổi thì approval vô hiệu, GPT review lại.
3. **Fail-closed tuyệt đối**: canonical/version/module/override lỗi → `BLOCKED_*`, không fallback embedded/local/stale.
4. **Không tự merge / deploy / force-push / reset** — người dùng quyết merge, deploy cần lệnh riêng.
5. **Secret không bao giờ in/log/trích dẫn** vào chat, log, comment, Telegram.
6. **Không commit generated global manifests** làm nguồn luật; effective policy chỉ là artifact tạm.
7. Bàn giao review chỉ khi đã **commit + push + read-back HEAD + CI đúng SHA + PR evidence đủ**.

Canonical: `.github/ai-review-policy.json` + `docs/AGENT_HANDOFF_PROTOCOL.md`. File này chỉ trỏ, không thay thế.
