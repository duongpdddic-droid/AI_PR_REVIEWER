<!-- module-version: 1 -->

# Module: project-qlda

Tự động tải khi làm việc trên repo `duongpdddic-droid/QLDA_DTXD`.

## Kiến trúc & deploy
- Google Apps Script + `QLDA_DDIC.html` (vanilla JS); backend `Backend/*.js`.
- Deploy: `pnpm exec clasp` (cấm npx); trước push chạy verify exit 0; deploy giữ deployment ID.
- GAS blocking → không async/await; batch get/setValues; LockService khi ghi đồng thời.

## Dữ liệu & protected paths
- CSV/Sheet tham chiếu chéo qua `MA_TIEN_NHIEM`/`MA_LIEN_KET_ME` — verify 0 orphan/0 self-ref.
- Memory Bank là truth trạng thái thực thi; repository là truth code.

## Ràng buộc review
- Project config: `.github/project-review-policy.json` pin canonical full SHA + policyVersion — không định nghĩa lại global protocol.
- Không sửa logic nghiệp vụ/dữ liệu ngoài phạm vi Issue; deploy luôn cần lệnh người dùng riêng.
