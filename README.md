# AI Film Studio

Extension VS Code quản lý pipeline làm phim AI: **kịch bản tóm tắt → kịch bản chi tiết → phân đoạn → cảnh → hồ sơ cảnh (lời, âm thanh,
dựng, prompt) → Blender / gói Dreamina → ghi kết quả**. Mỗi việc một tab, chọn model AI cho từng bước, dashboard tiến độ.

Dự án đầu tiên dùng tool: phim *Bình Định Vương — Lam Sơn 600*. Kiến trúc: [`docs/KIEN-TRUC.md`](docs/KIEN-TRUC.md).

## Ba nguyên tắc
1. **File `.md` của dự án là nguồn sự thật.** Tool chỉ đọc và suy ra trạng thái, không có database.
2. **AI đề xuất, người duyệt.** Kết quả AI hiện thành diff; bấm *Nhận* mới ghi vào file. Tool không `git add`, không commit.
3. **Không làm lại thứ VS Code có sẵn**: sửa file bằng editor gốc, xem bằng preview gốc, so sánh bằng diff gốc.

## Có gì *(v1.0.0 — 28/10/2026 — phân đoạn ⑦ Lời: lưới bảng lời trong tab · ⑧ Dựng · cảnh chỉ còn ⑨ Prompt (prompt cảnh + ảnh @[…] dùng chung, 📋 chép) · ⑩ Blender (shot, key frame, file render _R) · bỏ Gói Dreamina / ghi kết quả · v0.9: phân đoạn: ⑤ Kịch bản phân đoạn → Tạo phân cảnh → ⑥ Phân cảnh, lưới ngay trong tab · v0.8: tập: ③ Dàn ý → Tạo phân đoạn → ④ Kịch bản chi tiết, duyệt từng phân đoạn → Phân cảnh · GUI hiện TAPxx + tên tập · thư mục tập = EPxx · v0.7: Trạng thái / Tài nguyên dự án / Ý tưởng – phong cách)*
| Phần | |
|---|---|
| **Sidebar "Dự án"** | **Trạng thái dự án** (dashboard) · **Tài nguyên dự án** · **Ý tưởng – phong cách** · tập → phân đoạn (thứ tự chiếu theo bảng README tập, mã đã bỏ hiện mờ) → cảnh (trạng thái, giây). Bấm vào = chọn bước để mở tab |
| **Thanh tiêu đề sidebar** | 📊 Tổng quan · ✔ Bắt đầu việc (git) · ⏹ Kết thúc phiên · ⚙ Cài đặt AI · ⟳ Quét lại. Chuột phải phân đoạn: ▦ sửa bảng cảnh, cấp mã cảnh, chạy script |
| **Tài nguyên dự án** | Mọi tài liệu dùng chung (sử liệu, quy trình, pipeline, kiến thức làm phim…) gom theo nhóm — `resources:` trong `project.yaml` (`path` một file · `dir` cả thư mục). Bấm = preview. File thuộc tài nguyên **không liệt kê** ở "File liên quan" của tab tập / phân đoạn / cảnh (gấp vào dòng 📚, AI vẫn đọc khi chạy) |
| **① Ý tưởng + phong cách** | Form trong tab: ý tưởng chính, thể loại, dạng hình (chọn sẵn hoặc gõ khác), phong cách chi tiết, người xem — `idea:` trong `project.yaml`, ghi `00_PROJECT/Y-TUONG_PHONG-CACH.md` (mỗi ô một mục `##`) |
| **② Kịch bản tóm tắt + Chia tập** | Sửa kịch bản tóm tắt ngay trong tab → **✨ Chia tập** (AI đề xuất danh sách tập, xem diff, Nhận) → **▦ Danh sách tập**: lưới thêm / bỏ / đổi thứ tự / sửa ô, 📁 tạo thư mục tập. **Mã sản xuất `EPnn`** cấp một lần, không đổi, bỏ thì không dùng lại, mới = số kế tiếp chưa dùng (`EP100` được); **số phát hành `TAPnn`** tool đánh lại theo thứ tự dòng mỗi lần lưu, bỏ qua tập ❌ / ⏸. Lịch phát hành, `{T}` tính theo TAP. Dòng AI ghi mã `MỚI` → tool cấp mã khi lưu |
| **③ Dàn ý (tập)** | Viết cả dàn ý tập trong tab (`<tập>/dan-y.md`) → **✨ Tạo phân đoạn**: lưu, chuyển sang ④, AI chạy luôn |
| **④ Kịch bản chi tiết + phân đoạn** | AI viết `kich-ban-chi-tiet.md` mở đầu bằng bảng phân đoạn → **Nhận**: phân đoạn mới vào bảng README tập (⬜ chưa duyệt), hiện thành mục con trên cây. Bảng trong tab: chọn **Đã duyệt / Chưa duyệt** từng phân đoạn → Lưu trạng thái · **xem** nhảy tới mục `## [X]` · **🎬 Phân cảnh**: phân đoạn đã duyệt mà chưa có cảnh → tạo thư mục từ mẫu + mở tab ⑤ và AI chia cảnh luôn |
| **⑤ Kịch bản phân đoạn** | Sửa đúng mục `## [X]` của kịch bản chi tiết ngay trong tab phân đoạn (ghi lại đúng mục đó) → **✨ Tạo phân cảnh**: lưu, sang ⑥, AI chia cảnh luôn |
| **⑥ Phân cảnh** | Lưới bảng cảnh **nằm ngay trong tab** (sửa ô, kéo cột, ▲▼, +, bỏ, trạng thái) — vẫn mở được ở tab riêng. Nút AI **Tạo lại phân cảnh (cảnh chưa duyệt)**: cảnh ✅ giữ nguyên; Nhận xong lưới tự tải lại |
| **⑦ Lời dẫn + thoại** | Lưới bảng `<X>_loi.md` ngay trong tab phân đoạn (`linesTable:` trong `project.yaml`): sửa từng câu, **+** thêm câu cùng cảnh (mã `<cảnh>_L` kế tiếp), bỏ, đổi thứ tự — ghi thẳng vào file |
| **⑨ Prompt ảnh + video (cảnh)** | Mục `## <cảnh>` trong `<X>_prompt.md` + prompt của **mọi ảnh `@[TÊN]`** cảnh nạp (tìm khối `**@[TÊN]**` trong `scenePrompts.shared`; `DON_` / `DC_` thử tên gốc), kèm "cũng dùng ở" các cảnh khác. Mỗi khối code có **📋 chép** |
| **⑩ Blender (cảnh)** | Shot / camera / frame (xem trong Blender) · dòng key frame + clip trong `<X>_render.md` · ảnh / clip render `_R` của cảnh · script render, kéo .blend · giao Claude Code. Ảnh / video AI không đưa vào tool |
| **Tên tập trên GUI** | `TAPxx <Tên tập>` (tên lấy từ cột Tên tập của danh sách tập); mã sản xuất EPxx ở mô tả. Teaser `EP00` = `TAP00` (`releaseFixed`); **⤴** trong lưới danh sách tập gộp nhiều EP vào một TAP (ô `↑ TAPnn`) |
| **Sidebar "Ghi chú @C / @T"** | Mọi `@C:` (việc cho AI, trừ dòng `✅ @C`) và `@T:` (câu hỏi cho người) trong các file `.md`, bấm là nhảy tới dòng |
| **Tab của đối tượng** | Bấm dự án / tập / phân đoạn / cảnh trong cây → mở **một tab** (mỗi đối tượng một tab, giữ lại khi mở lại VS Code). Trên cùng: **overview** (đường dẫn Lam Sơn › EP01 › K bấm được, số cảnh, giây, trạng thái, link bảng lưới / Blender / thư mục) và **sơ đồ các bước** của cấp đó `③ Kịch bản ✓ → ④ Chia cảnh 🔒 → ⑤a Lời …` (✓ đã có kết quả · 🔒 cổng chưa mở). Bấm bước nào → nội dung bước đó hiện bên dưới; lần đầu mở là **bước 1**. Mỗi bước giữ riêng yêu cầu thêm / model / các lần chạy |
| **✅ Duyệt theo cấp** | Nút trong overview: ở **cảnh** → chỉ dòng cảnh đó · ở **phân đoạn** → dòng phân đoạn trong README tập + mọi cảnh của phân đoạn · ở **tập** → mọi phân đoạn + mọi cảnh. Hỏi trước (liệt kê dòng sẽ đổi), chỉ thay ô Trạng thái (giữ ghi chú: `⬜ chờ duyệt · D01 đã render` → `✅ D01 đã render`), không đụng dòng đã bỏ ❌. **Bỏ duyệt** → `👀 chờ duyệt`. Duyệt phân đoạn mở luôn cổng ④ |
| **Nội dung bước** | File đầu vào / đầu ra kèm **xem** (render ngay trong tab, link và `đường/dẫn` bấm được) · **sửa** (editor bên cạnh, đúng dòng) · **preview đầy đủ**. Ghi chú @C/@T của các file đó. Nút chạy script liên quan |
| **AI trong tab** | Chọn model · ước tính token **trước khi gửi** + trần token · *Xem prompt gửi đi* · ô yêu cầu thêm · **Chạy** → diff (sửa được bản đề xuất) → **Nhận / Bỏ** · cổng duyệt (khóa nút Chạy, có *Bỏ qua cổng*) · nhật ký chạy + chi phí ở `.studio/runs/` |
| **So sánh 2 model** | Ô *So sánh với* → *Chạy cả 2* → hai thẻ kết quả, mỗi thẻ *Xem diff / Nhận / Bỏ* riêng — cách nhanh nhất để biết bước nào dùng model rẻ / local được |
| ⚙ **Cài đặt AI** (GUI) | Thư mục dự án, thư mục media, tên máy, trần token, Claude CLI · **bảng model** (thêm / sửa / xóa / đổi thứ tự, dán khóa API — lưu SecretStorage, nút *Thử*) · **bảng gán model theo bước**: cột *Dự án* ghi `.studio/models.yaml` (giữ chú thích), cột *Máy này* ghi đè riêng máy |
| ▦ **Bảng cảnh dạng lưới** | ⭐ *(v0.6.1)* **kéo mép tiêu đề cột đổi độ rộng** (nhớ theo tên cột; bấm đúp = mặc định — `sceneTable.columnWidths`) · ô **Trạng thái = danh sách chọn** (`sceneTable.statusChoices`, vd. ✅ Đã duyệt · ⬜ Chưa duyệt) · Sửa ô (gợi ý mã cỡ / góc / máy / cách / trạng thái từ `project.yaml`), ▲▼ đổi thứ tự chiếu, **+** thêm cảnh (tool cấp mã kế tiếp), *bỏ* = đánh dấu ❌ (không xóa dòng), tổng giây. Chỉ ghi lại khối dòng của bảng — phần chữ khác giữ nguyên; file bị sửa chỗ khác trong lúc mở thì hỏi trước |
| **⑦ Kết quả Dreamina** | Lưới ảnh / clip của cảnh (thư mục media + `seedance_clip/` trong repo) · **Nhập file…**: chép file tải về, đổi tên đúng mã (`EP01_K02_V3.mp4`, trùng thì `-v2`), file gốc giữ nguyên · form **số lần sinh · bản chốt · model video · lỗi** → sổ `<X>_ket-qua.md` · dashboard tính *lần sinh / cảnh* từ sổ này |
| 🧊 **Blender của tập** | Nút đầu tiên dưới mỗi tập (hoặc từ dashboard). **File .blend**: ở repo / dùng chung / dựng tại máy (nút ▶ chạy `.sh` / `.bat`), cỡ, script dựng, hướng dẫn, lần quét · **Shot ↔ cảnh** theo thứ tự chiếu: shot (= marker), file, camera, frame đầu – cuối, số frame, giây so với bảng cảnh, clip tham chiếu `_R1`, nguồn. Nút **Quét Blender đang mở** (socket addon MCP, cùng cổng `blender_bridge.py`) · **Quét bằng Blender máy này** (chạy nền) · **xem trong Blender** (đặt preview range + camera, không đổi file) · **chép lệnh render** · **kéo về** · **Ghi sổ `SO-BLENDER.md`** (diff trước; cột *Ra*, *Ghi chú* giữ khi ghi lại). Soát: cảnh V2 / BL / V6 chưa có frame, frame lệch giữa các nguồn, shot chồng nhau, giây lệch bảng cảnh, fps khác 24 |
| ⏹ **Kết thúc phiên** | Đọc `git diff --stat`, `git status`, các lần chạy AI hôm nay + STATE.md → AI nháp một mục nhật ký → diff → Nhận = chèn đầu "Nhật ký phiên" |
| **Bước agent** (Blender) | *Giao cho Claude Code*: ghi prompt ra file, mở Claude Code tương tác trong terminal — người vẫn duyệt từng quyền |
| **Dashboard** | Ô tổng · bảng các tập (cảnh theo trạng thái, giây so với trần, ngày phát hành) · ma trận **phân đoạn × bước** của tập đang chọn (bấm ô = mở tab) · số lần sinh video / cảnh (đếm file `_V` trong thư mục media) · chi phí AI tháng |
| **Soát nhất quán** | Hiện ở tab Problems: cảnh ngoài 4–30 s, tổng tập vượt trần, mã lời không có cảnh, `@[TÊN]` thiếu trong danh bạ, từ cấm trong prompt |
| ⭐ **Soát prompt video** *(v0.5)* | Mọi khối ``` có `【Cảnh k】` trong file `.md` của phân đoạn, so với dòng **Nạp:** phía trên (`src/core/promptLint.ts`, cấu hình `promptLint` trong `project.yaml`). **P1** nạp > 5 file (cảnh báo — chỉ khuyến khích) · > 9 ảnh (lỗi — giới hạn 2.0 / mini) · **P2** `@ImageN` không có trong Nạp · **P3** file nạp không được nhắc · **P4** có mốc giây · **P5** nạp ảnh nhiều góc (`@[DC_…]`) cho video · **P6** một cảnh hai vận động máy · **P7** tên nhân vật dùng trước khi khai báo (`…, người như @ImageN, là TÊN`) · **P8** tên chỉ nhắc một lần · **P9** con số đếm vật ("bốn quả") · **P10** thiếu câu mở / dòng Ràng buộc. Bỏ qua khung mẫu có ô `[…]`, bỏ qua chữ trong thoại `{…}`. Tắt luật: `promptLint.off: [P3]` |
| ⭐ **Sổ thử nghiệm** *(v0.5)* | Bảng **"Nhật ký lần sinh"** (cột Ngày · Cảnh · Bản · Model · Lần · Credit · Giây · ①…⑦ · Dùng được · Nhận xét) ở **bất kỳ** file `.md` nào của phân đoạn (`src/core/attempts.ts`). Bước ⑦ của cảnh có form **Ghi một lần sinh** → thêm dòng vào `<X>_ket-qua.md`, tự đánh số Lần. Tổng quan: **lần sinh tới bản dùng được**, tỉ lệ dùng được, **credit / giây dùng được**, theo model, **tiêu chí hay hỏng nhất**, cảnh chưa đạt. Tên tiêu chí: `attemptLog.criteria` |
| **Mã số** | Sổ `.studio/ma-da-cap.json` tự ghi mọi mã đang thấy → mã đã bỏ không bao giờ cấp lại · lệnh *Thêm phân đoạn* (cấp chữ kế tiếp, chép mẫu) · *Cấp mã cảnh mới* |
| **Quản lý thư mục** | *Khởi tạo .studio/* (mẫu tổng quát) · *Thêm tập* (chép thư mục mẫu) · *Cập nhật .gitignore* — chỉ ghi trong khối có đánh dấu, xem diff trước khi ghi · tool **không xóa file** |
| **Git** | *Bắt đầu việc*: hiện `git diff --stat` + file mới → hỏi rồi mới `git add -A` |

### Model
| Provider | Trạng thái |
|---|---|
| `claude-code` — Claude Code CLI (`claude -p`), không cần khóa API, chạy được ở máy chỉ có Claude Code | ✅ — mặc định. Tắt công cụ + MCP (`--tools "" --strict-mcp-config`) nên chỉ trả văn bản; tự đọc `CLAUDE.md` của dự án nên tool không nạp "lõi dự án" |
| `anthropic` — Messages API, khóa trong SecretStorage | ✅ |
| `openai` — Chat Completions | ✅ (chưa thử với khóa thật) |
| `openai-compatible` — Ollama, llama.cpp server, LM Studio, OpenRouter, vLLM | ✅ (thử bằng server giả trong bộ test) |
| `gemini` — generateContent | ✅ (chưa thử với khóa thật) |

## Cài trên máy cá nhân *(laptop Windows · máy nhà Ubuntu)*

### Cần có sẵn
| | Ghi chú |
|---|---|
| **VS Code** ≥ 1.90 | lệnh `code` trong PATH (Windows: tick *Add to PATH* lúc cài; không có thì cài file `.vsix` qua giao diện — xem bước 3) |
| **Node.js** ≥ 20 (kèm `npm`) | `node -v` để kiểm. Chỉ cần để đóng gói, extension chạy bằng Node của VS Code |
| **git** + khóa SSH GitHub | để clone repo tool `git@github.com:ngoctruongns/AI-film-studio.git` |
| **Claude Code** | extension Claude Code trong VS Code **hoặc** CLI `claude`, đã đăng nhập (chạy `claude` một lần). Tool tự tìm CLI: PATH → bản đi kèm extension |
| *(tùy chọn)* **Blender** | để quét / render `.blend` chạy nền trên máy này · addon *MCP for Blender* nếu muốn nút **Quét Blender đang mở** |
| *(tùy chọn)* **Ollama / llama.cpp / LM Studio** | model local — thêm trong ⚙ Cài đặt AI |

### 1. Lấy mã nguồn — đặt trong repo phim cho chung workspace
Repo phim đã có sẵn cấu hình `.studio/` và **gitignore thư mục `04_PRODUCTION/tools/studio/`**, nên clone repo tool vào đúng chỗ đó:
```bash
cd <repo phim>                       # vd. D:/code/ls26Main  hoặc  ~/code_ws/ls26Main
git pull                             # lấy .studio/ mới nhất của dự án
git clone git@github.com:ngoctruongns/AI-film-studio.git 04_PRODUCTION/tools/studio
```

### 2. Đóng gói
```bash
cd 04_PRODUCTION/tools/studio
npm install
npm run compile
npm test                             # tùy chọn — lõi + GUI trên bản sao repo phim, không đụng file thật
npm run package                      # → ai-film-studio-<phiên bản>.vsix (phiên bản trong package.json)
```

### 3. Cài vào VS Code
```bash
code --install-extension ai-film-studio-0.4.0.vsix --force      # đổi số phiên bản cho đúng file vừa tạo
```
Không có lệnh `code`: VS Code → **Extensions** (Ctrl+Shift+X) → nút **⋯** góc trên → **Install from VSIX…** → chọn file `.vsix`.
Rồi **Ctrl+Shift+P → Developer: Reload Window**.

### 4. Mở dự án + cài đặt lần đầu
1. **File → Open Folder… → thư mục gốc repo phim** (nơi có `.studio/project.yaml`). Thanh bên trái hiện biểu tượng **AI Film Studio** (khung phim ▶).
   Mở thư mục khác làm workspace thì đặt *Thư mục dự án* trong ⚙ Cài đặt AI.
2. Bấm **⚙** trên thanh tiêu đề sidebar → **Cài đặt AI**:
   | Mục | Laptop Windows (ví dụ) | Máy nhà Ubuntu (ví dụ) |
   |---|---|---|
   | Tên máy | `laptop` | `may-nha` |
   | Thư mục media | `D:/video/LS600/VIDEO_OUT` | `~/LS600/VIDEO_OUT` |
   | Blender dòng lệnh | `C:/Program Files/Blender Foundation/Blender 4.2/blender.exe` | `/usr/bin/blender` |
   | Blender đang mở (addon MCP) | `localhost : 9876` → bấm **Thử** | như trái |
   | Claude CLI | để trống (tự tìm) | để trống |
3. Bảng **Model của máy này** đã có sẵn 4 model Claude Code. Thêm model khác bằng **+ Thêm model** — vd. Ollama: nhà cung cấp *Local / tương thích
   OpenAI*, model `qwen2.5:14b`, API base `http://localhost:11434/v1` → **Thử**. Model cần khóa (OpenAI, Gemini, Anthropic API): dán khóa ở cột
   *Khóa API* (lưu trong kho bí mật của VS Code, không vào settings, không vào git).
4. Bảng **Gán model cho từng bước**: cột *Máy này* để dùng model local / rẻ riêng trên laptop mà không đổi cấu hình chung của dự án.

### Cập nhật khi có bản mới
Repo có sẵn file **`.vsix` bản mới nhất** (một file duy nhất) — không cần build:
```bash
cd <repo phim>/04_PRODUCTION/tools/studio
git pull
code --install-extension ai-film-studio-<phiên bản>.vsix --force
```
Sửa mã rồi tự build: **`npm install`** (lần đầu, hoặc khi package.json đổi — thiếu bước này sẽ lỗi `missing: yaml`) → `npm run package` (tự biên dịch TypeScript, đóng gói xong mới xóa `.vsix` cũ) → cài như trên.
→ **Developer: Reload Window**. Cài đặt, model, khóa API giữ nguyên.

### Gỡ
`code --uninstall-extension ngoctruongns.ai-film-studio` (hoặc Extensions → AI Film Studio → Uninstall).

### Lỗi hay gặp
| Hiện tượng | Cách xử lý |
|---|---|
| Không thấy biểu tượng AI Film Studio | chưa Reload Window · workspace không phải gốc repo phim → mở đúng thư mục hoặc đặt *Thư mục dự án* trong Cài đặt AI |
| Sidebar báo "chưa có .studio/project.yaml" | `git pull` repo phim (cấu hình `.studio/` nằm trong repo phim, không nằm trong repo tool) |
| Chạy AI báo "Không chạy được Claude CLI" | đăng nhập Claude Code (`claude` trong terminal) · hoặc điền đường dẫn CLI trong Cài đặt AI |
| **Quét Blender đang mở** báo không kết nối | Blender đã mở, addon MCP đã bấm *Connect*, cổng đúng (mặc định 9876; Blender ở máy khác thì chuyển cổng về) |
| `npm run package` lỗi mạng | máy cần internet lần đầu để tải `@vscode/vsce` |

### Chạy từ mã nguồn (sửa tool)
Mở thư mục tool trong VS Code → **F5** (*Chạy extension*) → cửa sổ mới mở repo phim với bản đang sửa. `npm run watch` để biên dịch liên tục.
Bộ thử: `test/smoke.ts` (lõi trên dữ liệu thật) · `test/gui.ts` (API VS Code giả `test/mockVscode.ts` + **jsdom chạy JS thật của webview** + LLM giả
+ Blender giả) — 78 kiểm tra.

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

**Blender** — mục `blender:` trong `project.yaml` (thư mục .blend / script / hướng dẫn, sổ, fps, tiền tố camera, cách làm cần Blender, lệnh render,
lệnh kéo về). Kết quả quét: `.studio/blender/<tập>/<file>.json` — **vào git**, để máy không có Blender (máy công ty) vẫn thấy frame thật.
Quy ước đọc shot: marker trên timeline = mã shot (`F01`, `F01_2`); camera `CAM_<shot>`; bảng hướng dẫn có cột `Cảnh`/`Shot` + `Frame` (`0 – 59`).

**Theo máy** (VS Code settings, không vào git): `aiFilmStudio.blenderPath` / `blenderHost` / `blenderPort`, `aiFilmStudio.models` (danh sách model kiểu Continue), `aiFilmStudio.stepModels` (ghi đè gán
model của máy này), `aiFilmStudio.projectRoot`, `aiFilmStudio.mediaRoot`, `aiFilmStudio.claudePath`, `aiFilmStudio.maxInputTokens`,
`aiFilmStudio.machineProfile`. Khóa API: lệnh **AI Film Studio: Đặt khóa API cho model** (SecretStorage).

Thêm model bằng **⚙ Cài đặt AI** (không cần sửa JSON). Ví dụ tương đương trong settings:
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
  results.ts     media theo mã cảnh + sổ <X>_ket-qua.md
  approve.ts     duyệt theo cấp (cảnh / phân đoạn / tập) — đổi ô Trạng thái
  tableEdit.ts   đọc / ghi lại bảng cho lưới (bảng cảnh, danh sách tập)
  episodeList.ts danh sách tập: mã EP, số phát hành TAP, mã kế tiếp
  idea.ts        form ① ý tưởng + phong cách ↔ file .md theo mục ##
  segmentTable.ts bảng phân đoạn README tập: đổi trạng thái một dòng · nhận bảng phân đoạn từ kịch bản AI
  resources.ts   Tài nguyên dự án (nhóm · file · thư mục)
  blender.ts     file .blend · shot ↔ frame ↔ cảnh từ 3 nguồn (quét Blender › sổ › hướng dẫn) · sổ SO-BLENDER.md
  blenderLink.ts socket addon MCP for Blender · Blender dòng lệnh
  providers/     claude-code · anthropic · openai (+ tương thích) · gemini
src/ui/          cây sidebar, dashboard, tab bước, Cài đặt AI, lưới bảng cảnh, tab Blender, lệnh
templates/default/.studio/   mẫu cho dự án mới
test/smoke.ts    chạy lõi trên dự án thật
test/gui.ts      thử GUI (mockVscode.ts + jsdom + LLM giả)
```

## Việc tiếp theo
- Thử thật OpenAI / Gemini / Ollama trên laptop → chỉnh adapter theo lỗi gặp.
- Xuất gói Dreamina cho điện thoại (một file tự đủ: prompt + bảng Nạp + danh sách ảnh cần nạp).
- Stream kết quả AI dần lên tab (hiện chờ đến khi xong) · bundle bằng esbuild cho nhẹ.
