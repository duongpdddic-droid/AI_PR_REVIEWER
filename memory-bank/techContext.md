# Tech Context (AI_PR_REVIEWER)

## Công nghệ nền tảng
- Node.js >= 18, TypeScript strict (tùy theo module), JavaScript thuần cho scripts hạ tầng.
- Quản lý gói: `pnpm` (cấm npm/yarn).
- Scripts verify: Node stdlib (node --check, spawn), không phụ thuộc framework test nặng.
- Template GitHub: YAML `.github/ISSUE_TEMPLATE/gpt-task.yml`.

## Cấu hình công cụ Agent (.agent/)
- `config.json`: cấu hình chung cho CLI/Aider.
- `conventions-coder.md` / `conventions-reviewer.md`: quy ước theo từng vai trò.

## Quản lý Secret (cục bộ)
- Telegram: `~/.ai-pr-reviewer/tg.json` (ngoài repository).
- API keys của reviewer: biến môi trường (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`).