# AI Film Studio

Extension VS Code quản lý pipeline làm phim AI: **kịch bản tóm tắt → kịch bản chi tiết → phân đoạn → cảnh → hồ sơ cảnh (lời, âm thanh,
dựng, prompt) → Blender / gói Dreamina → ghi kết quả**. Mỗi việc một tab, chọn model AI cho từng bước, dashboard tiến độ.

Dự án đầu tiên dùng tool: phim *Bình Định Vương — Lam Sơn 600*. Kiến trúc: [`docs/KIEN-TRUC.md`](docs/KIEN-TRUC.md).

## Ba nguyên tắc
1. **File `.md` của dự án là nguồn sự thật.** Tool chỉ đọc và suy ra trạng thái, không có database.
2. **AI đề xuất, người duyệt.** Kết quả AI hiện thành diff; bấm *Nhận* mới ghi vào file. Tool không `git add`, không commit.
3. **Không làm lại thứ VS Code có sẵn**: sửa file bằng editor gốc, xem bằng preview gốc, so sánh bằng diff gốc.

## v0.1 có gì
| Phần | |
|---|---|
| **Sidebar "Dự án"** | Tổng quan · cả dự án · tập → phân đoạn (thứ tự chiếu theo bảng README tập, mã đã bỏ hiện mờ) → cảnh (trạng thái, giây). Bấm vào = chọn bước để mở tab |
| **Sidebar "Ghi chú @C / @T"** | Mọi `@C:` (việc cho AI, trừ dòng `✅ @C`) và `@T:` (câu hỏi cho người) trong các file `.md`, bấm là nhảy tới dòng |
| **Tab bước** | Mỗi cặp (bước, đối tượng) một tab, giữ lại khi mở lại VS Code. File đầu vào / đầu ra kèm **xem** (render ngay trong tab, link và `đường/dẫn` bấm được) · **sửa** (editor bên cạnh, đúng dòng) · **preview đầy đủ**. Ghi chú @C/@T của các file đó. Nút chạy script liên quan |
| **AI trong tab** | Chọn model · ước tính token **trước khi gửi** + trần token · *Xem prompt gửi đi* · ô yêu cầu thêm · **Chạy** → diff (sửa được bản đề xuất) → **Nhận / Bỏ** · cổng duyệt (khóa nút Chạy, có *Bỏ qua cổng*) · nhật ký chạy + chi phí ở `.studio/runs/` |
| **Bước agent** (Blender) | *Giao cho Claude Code*: ghi prompt ra file, mở Claude Code tương tác trong terminal — người vẫn duyệt từng quyền |
| **Dashboard** | Ô tổng · bảng các tập (cảnh theo trạng thái, giây so với trần, ngày phát hành) · ma trận **phân đoạn × bước** của tập đang chọn (bấm ô = mở tab) · số lần sinh video / cảnh (đếm file `_V` trong thư mục media) · chi phí AI tháng |
| **Soát nhất quán** | Hiện ở tab Problems: cảnh ngoài 4–30 s, tổng tập vượt trần, mã lời không có cảnh, `@[TÊN]` thiếu trong danh bạ, từ cấm trong prompt |
| **Mã số** | Sổ `.studio/ma-da-cap.json` tự ghi mọi mã đang thấy → mã đã bỏ không bao giờ cấp lại · lệnh *Thêm phân đoạn* (cấp chữ kế tiếp, chép mẫu) · *Cấp mã cảnh mới* |
| **Quản lý thư mục** | *Khởi tạo .studio/* (mẫu tổng quát) · *Thêm tập* (chép thư mục mẫu) · *Cập nhật .gitignore* — chỉ ghi trong khối có đánh dấu, xem diff trước khi ghi · tool **không xóa file** |
| **Git** | *Bắt đầu việc*: hiện `git diff --stat` + file mới → hỏi rồi mới `git add -A` |

### Model
| Provider | Trạng thái |
|---|---|
| `claude-code` — Claude Code CLI (`claude -p`), không cần khóa API, chạy được ở máy chỉ có Claude Code | ✅ — mặc định. Tắt công cụ + MCP (`--tools "" --strict-mcp-config`) nên chỉ trả văn bản; tự đọc `CLAUDE.md` của dự án nên tool không nạp "lõi dự án" |
| `anthropic` — Messages API, khóa trong SecretStorage | ✅ |
| `openai` · `openai-compatible` (Ollama, llama.cpp, LM Studio, OpenRouter) · `gemini` | ⏸ khung — báo "chưa làm" |

## Cài và chạy
```bash
cd 04_PRODUCTION/tools/studio      # trong workspace của dự án phim
npm install
npm run compile
npm test                            # chạy thử phần lõi trên repo phim ở ../../.. (không cần VS Code)
```
- **Chạy thử trong VS Code:** mở thư mục tool, `F5` (*Chạy extension*) → cửa sổ mới mở repo phim.
- **Cài hẳn:** `npm run package` → `code --install-extension ai-film-studio-0.1.0.vsix`.

## Cấu hình
**Theo dự án** (vào git của dự án phim) — `<dự án>/.studio/`:
| File | |
|---|---|
| `project.yaml` | cấu trúc thư mục, mẫu tên file, cột bảng, regex mã, ký hiệu trạng thái, lịch phát hành, từ cấm, khối `.gitignore`, script |
| `pipeline.yaml` | các bước: phạm vi, đầu vào / đầu ra (có `select: heading:… / row:…`), cổng, mẫu prompt, executor |
| `models.yaml` | gán **tên** model cho từng bước + dự phòng |
| `prompts/*.md` | mẫu prompt từng bước — biến `{{inputs}} {{current}} {{request}} {{ep}} {{X}} {{scene}}`… |
| `ma-da-cap.json` | sổ mã đã cấp (tool tự ghi) |
| `runs/` | nhật ký chạy AI — tool tự thêm vào `.gitignore` |

**Theo máy** (VS Code settings, không vào git): `aiFilmStudio.models` (danh sách model kiểu Continue), `aiFilmStudio.stepModels` (ghi đè gán
model của máy này), `aiFilmStudio.projectRoot`, `aiFilmStudio.mediaRoot`, `aiFilmStudio.claudePath`, `aiFilmStudio.maxInputTokens`,
`aiFilmStudio.machineProfile`. Khóa API: lệnh **AI Film Studio: Đặt khóa API cho model** (SecretStorage).

Ví dụ thêm model local trên laptop (khi adapter làm xong):
```jsonc
"aiFilmStudio.models": [
  { "id": "claude-code", "provider": "claude-code" },
  { "id": "local-qwen", "provider": "openai-compatible", "apiBase": "http://localhost:11434/v1", "model": "qwen2.5:14b" }
],
"aiFilmStudio.stepModels": { "am-thanh": "local-qwen", "dung": "local-qwen" }
```

## Cấu trúc mã
```
src/core/        không phụ thuộc VS Code — chạy thử được bằng node
  config.ts      đọc .studio/*.yaml, ký hiệu trạng thái
  markdown.ts    bảng GFM, mục theo tiêu đề, select heading:/row:
  scanner.ts     quét tập / phân đoạn / cảnh / media
  context.ts     giải bước, cổng, dựng prompt, ước tính token, ghép kết quả
  codes.ts       sổ mã + cấp mã
  lint.ts · notes.ts · gitignore.ts · runs.ts
  providers/     claude-code · anthropic · (khung) openai, gemini
src/ui/          cây sidebar, dashboard, tab bước, lệnh
templates/default/.studio/   mẫu cho dự án mới
test/smoke.ts    chạy lõi trên dự án thật
```

## Việc tiếp theo
- P1b: adapter OpenAI-compatible (Ollama / llama.cpp), Gemini, OpenAI · so sánh 2 model cùng một bước.
- P2: tab kết quả Dreamina (lưới ảnh / clip theo mã, chọn bản ✅, ghi số lần sinh), xuất gói cho điện thoại, nhập file media đổi tên theo mã.
- P3: bảng cảnh dạng lưới · nút *Kết thúc phiên* (nháp nhật ký STATE.md).
