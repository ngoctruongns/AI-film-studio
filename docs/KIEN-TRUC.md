# AI FILM STUDIO — kiến trúc extension VS Code *(bản 2 · 26/10/2026 · ✅ Trường duyệt hướng đi, trả lời §10)*

> Mục tiêu: chia pipeline `04_PRODUCTION/PIPE_LINE.md` (① kịch bản tóm tắt → ⑥ prompt Seedance) thành **các bước có giao diện**, mỗi việc
> một tab, chọn model AI cho từng bước, có dashboard tiến độ, tool tự quản thư mục + `.gitignore`.
> Tên: **AI Film Studio** (`ai-film-studio`) — **tổng quát cho phim AI**; dự án Lam Sơn 600 dùng đầu tiên để thử và hoàn thiện.
> Mọi chi tiết riêng của một dự án nằm ở `<dự án>/.studio/*.yaml`, không nằm trong mã. Tình trạng từng pha: §9.

---

## 0. Ba nguyên tắc thiết kế

1. ⭐ **File `.md` trong repo là nguồn sự thật duy nhất.** Tool **đọc / phân tích** file, không giữ bản sao dữ liệu riêng. Dashboard, cây tập,
   trạng thái cảnh… đều **suy ra từ file**. Trường sửa tay file `.md` thì tool thấy ngay (file watcher). Không có database.
2. ⭐ **AI không ghi đè thẳng — AI đề xuất, Trường duyệt.** Mọi kết quả AI hiện dưới dạng **diff** (bản đề xuất ↔ file hiện tại); Trường
   bấm *Nhận* / *Nhận một phần* / *Bỏ*. Khớp với quy trình git hiện nay (phần Claude đổi nằm ngoài stage, Trường đọc bằng diff).
3. ⭐ **Không làm lại thứ VS Code đã có.** Soạn `.md` dùng editor gốc của VS Code (có undo, tìm kiếm, git, Claude Code); xem dùng markdown
   preview. Tool chỉ làm những gì VS Code không có: **mô hình dự án, bước pipeline, chạy AI, dashboard, mã số**.

---

## 1. Sơ đồ khối

```
┌──────────────────────────── VS Code ─────────────────────────────────────────────────────┐
│  SIDEBAR (TreeView)            EDITOR AREA (Webview tab, mỗi tab = 1 việc)                │
│  ├ 📊 Dashboard                ┌──────────────┐ ┌──────────────┐ ┌──────────────┐          │
│  ├ 🎬 EP01 Nước mất            │③ Kịch bản A  │ │⑥ Blender F10 │ │⑤ Prompt K02  │  …       │
│  │  ├ A Mở đầu Tây Đô          └──────┬───────┘ └──────┬───────┘ └──────┬───────┘          │
│  │  │  ├ A01 · A02 …                  │ postMessage (giao thức có kiểu)  │                  │
│  ├ 📝 Ghi chú @C / @T          ───────┴───────────────┬──────────────────┴──────           │
│  └ ⚙️ Models & bước                                    │                                    │
├───────────────────────────────────────────────────────┼────────────────────────────────────┤
│  EXTENSION HOST (TypeScript)                           ▼                                    │
│   ProjectModel ◄── Parser (remark + gfm) ◄── FileWatcher        CodeRegistry (cấp mã)       │
│   StepRegistry (pipeline.yaml)   ContextBuilder → TokenEstimator   Linter (soát nhất quán)  │
│   ProviderRegistry ─► Anthropic · OpenAI · Gemini · OpenAI-compatible (Ollama/llama.cpp/LM  │
│                       Studio/OpenRouter) · Claude Code (agent, CLI/Agent SDK)               │
│   RunManager (stream, hủy, log chi phí)   ProposalService (diff → nhận/bỏ)                  │
│   ScaffoldService (thư mục, .gitignore)   GitService (vscode.git API)   ScriptRunner (python)│
│   MediaIndex (thư mục media ngoài repo, quét theo mã)                                       │
└────────────────────────────────────────────────────────────────────────────────────────────┘
        │ đọc/ghi                             │ khóa API                    │ media
   repo (chỉ văn bản) + .studio/        SecretStorage của VS Code     mediaRoot (Drive / ổ D:)
```

---

## 2. Dữ liệu — để ở đâu

| Thứ | Vị trí | Vào git? |
|---|---|---|
| Mô tả cấu trúc dự án (thư mục, mẫu tên file, cột bảng) | `.studio/project.yaml` | ✅ |
| Định nghĩa các bước pipeline (đầu vào, đầu ra, cổng duyệt, mẫu prompt) | `.studio/pipeline.yaml` + `.studio/prompts/<bước>.md` | ✅ |
| Gán model cho từng bước (chỉ **tên** model, không khóa) | `.studio/models.yaml` | ✅ |
| Sổ mã đã cấp (kể cả mã đã bỏ — để không tái dùng) | `.studio/ma-da-cap.json` | ✅ |
| Danh sách model + endpoint của **từng máy** (laptop / công ty / máy nhà) | VS Code **User settings** `aiFilmStudio.models` | ❌ |
| Khóa API | VS Code **SecretStorage** (keychain của hệ điều hành) | ❌ tuyệt đối |
| Nhật ký các lần chạy AI (prompt gửi đi, model, token, chi phí, kết quả) | `.studio/runs/` | ❌ (gitignore) |
| Media (ảnh `_I`, video `_V`, audio `_L` `_A`) | `mediaRoot` khai trong settings, mặc định `04_PRODUCTION/VIDEO_OUT/` | ❌ |

Mẫu `.studio/models.yaml`:
```yaml
mac_dinh: claude-sonnet
buoc:
  kich-ban-chi-tiet: claude-opus        # ③ cần suy luận sử liệu, giọng văn
  chia-canh:         claude-sonnet      # ④
  ho-so-loi:         claude-opus        # ⑤ lời dẫn — chỉ bản nháp, Trường viết bản cuối
  ho-so-am-thanh:    local-qwen         # ⑤ việc dạng bảng, model local đủ
  ho-so-dung:        local-qwen
  prompt-anh-video:  gpt                # ⑤⑥ thử so sánh với Claude
  soat-nhat-quan:    gemini-flash       # lint bằng AI: rẻ, ngữ cảnh dài
  blender:           claude-code        # ⑥ BẮT BUỘC agent có công cụ (MCP Blender)
du_phong: [claude-sonnet, local-qwen]   # model chính lỗi / hết hạn mức thì thử lần lượt
```

---

## 3. Các bước (StepRegistry) — khớp `PIPE_LINE.md`

Mỗi bước khai trong `pipeline.yaml`: **phạm vi** (dự án / tập / phân đoạn / cảnh) · **đầu vào** (file + mục cần nạp) · **đầu ra** (file + mục
được ghi) · **cổng** (điều kiện mở bước) · **mẫu prompt** · **loại executor** (`chat` hay `agent`).

| Bước | Phạm vi | Đầu vào chính | Đầu ra | Cổng | Executor |
|---|---|---|---|---|---|
| ① Ý tưởng + tóm tắt | dự án | — (Trường viết) | `SERIES_OUTLINE.md` | — | không AI / góp ý |
| ② Chia tập | dự án | `SERIES_OUTLINE.md` | `SERIES_OUTLINE.md` (mục tập) | ① có | chat |
| ③ Kịch bản chi tiết | tập | outline tập + `GHI-CHU-01` + ngôn ngữ điện ảnh | `kich-ban-chi-tiet.md` + bảng `README.md` | ② ✅ | chat |
| ④ Chia cảnh | phân đoạn | kịch bản § [X] + quy ước mã | `<X>_canh.md` → chạy `chu_thich_ma.py` | ③ **✅ duyệt** | chat |
| ⑤a Lời | phân đoạn | `<X>_canh.md` | `<X>_loi.md` → chạy `tong_hop_loi_dan.py` | ④ có | chat |
| ⑤b Âm thanh · ⑤c Dựng | phân đoạn | `<X>_canh.md`, `<X>_loi.md` | `<X>_am-thanh.md` · `<X>_dung.md` | ④ có | chat |
| ⑤d Prompt ảnh/video | cảnh | dòng cảnh + danh bạ `@[TÊN]` + `seedance-chung.md` | `<X>_prompt.md` (mục cảnh) | ④ có | chat |
| ⑥a Blender | cảnh | ghi chú sửa + script + `.blend` | script `.py`, `.blend`, render | ④ có | **agent** |
| ⑥b Gói Dreamina / V6 | cảnh | prompt + key frame `_R1_I*` | `<X>_goi-…md`, bảng **Nạp** | ⑤d có | chat / script |
| ⑦⑧ Trường | cảnh | — | ghi kết quả: số lần sinh `_V`, bản chốt ✅, lỗi | — | không AI (form ghi nhận) |

⭐ **Cổng duyệt** là luật cứng của dự án ("chưa duyệt ③ thì chưa sang ④"). Tool **khóa** nút chạy AI của bước sau, nhưng Trường luôn có nút
*Bỏ qua cổng* (ghi lại vào log) — tool phục vụ, không cản.

---

## 4. Giao diện

### 4.1 Tab công việc (yêu cầu 1, 2)
- Mỗi tab = một **cặp (bước, đối tượng)**, ví dụ `(③, EP01·A)`, `(⑥a, EP01·F10)`. Mở lại cùng cặp thì **nhảy về tab cũ**, không mở trùng.
- Tab sống sót khi tắt/mở VS Code (`WebviewPanelSerializer`).
- Bố cục một tab:
  ```
  ┌ ③ Kịch bản chi tiết · EP01 · Phân đoạn A ───────── trạng thái: 👀 chờ duyệt ── [Duyệt ✅] ┐
  │ FILE LIÊN QUAN (đầu vào / đầu ra)          │ VÙNG LÀM VIỆC                                   │
  │  📄 SERIES_OUTLINE.md §T01   [xem][mở]     │  Preview mục § [A] của kich-ban-chi-tiet.md      │
  │  📄 GHI-CHU-01 §12           [xem][mở]     │  (bấm [Sửa] → mở editor VS Code bên cạnh,       │
  │  📄 kich-ban-chi-tiet.md §A  [xem][mở]  ⬅ra │   đúng dòng của mục)                             │
  │ GHI CHÚ @C trong phạm vi này: 2            │                                                 │
  ├────────────────────────────────────────────┴─────────────────────────────────────────────────┤
  │ AI: [claude-opus ▾]  ngữ cảnh ≈ 18 400 token · ước tính ≈ 0,9 USD   [Chạy] [Xem prompt gửi đi]  │
  │ Yêu cầu thêm: [ thêm cảnh Lê Lợi nhìn Tây Đô cháy ............................. ]            │
  │ Kết quả → [Xem diff] [Nhận] [Nhận một phần] [Bỏ] [Chạy lại bằng model khác]                  │
  └──────────────────────────────────────────────────────────────────────────────────────────────┘
  ```
- **Xem / sửa file:** preview render bằng cùng thư viện markdown với VS Code (bảng, `<details>`, emoji); `[mở]` = `vscode.open` ở cột bên
  cạnh, nhảy đúng dòng của mục; link trong preview bấm được (mở file, nhảy tới mã cảnh `F02`, tới `@[TÊN]` trong danh bạ).
- ⚠️ **Không tự viết editor `.md` trong webview** (sửa trong webview + editor gốc cùng lúc sẽ ghi đè lẫn nhau). Ngoại lệ cân nhắc ở pha 3:
  **bảng cảnh dạng lưới** (sửa ô giây / cỡ / góc bằng dropdown mã) — vẫn ghi qua `WorkspaceEdit` vào chính file `.md`.

### 4.2 Tab riêng theo loại bước
| Tab | Thêm gì so với khung chung |
|---|---|
| ④ Chia cảnh | bảng cảnh + **tổng giây** của phân đoạn và cả tập so với **trần 20′**; nút *Cấp mã cảnh mới* (CodeRegistry) |
| ⑤a Lời | danh sách `_L` theo thứ tự chiếu, cột ✍ Trường / ⬜ nháp, **đã thu chưa** (có `EP01_D02_L1.wav` trong mediaRoot), giây thật của file thu |
| ⑤d Prompt | mỗi prompt một ô + nút **Sao chép**; kiểm tra: tiếng Việt tự nhiên, không đòi AI sinh chữ, `@[TÊN]` có trong danh bạ; bảng **Nạp** |
| ⑥a Blender | ghi chú sửa (viết vào `<X>_canh.md` dưới dạng `@C:` hoặc file ghi chú của cảnh) · script `.py` liên quan · camera `CAM_<cảnh>` · ảnh render gần nhất · nút **Giao cho Claude Code** · nút `blender_bridge.py pull` |
| ⑦ Kết quả Dreamina | lưới ảnh/clip theo mã (`_R1_I0`, `_I0`, `_V1…_V9`) đọc từ mediaRoot · chọn bản ✅ · ghi **số lần sinh + lỗi** → ghi vào `<X>_canh.md` |

### 4.3 Dashboard (yêu cầu 5)
- **Ma trận tập × bước**: 20 hàng (EP00–EP20) × cột ①…⑧, ô màu theo trạng thái; bấm ô = mở tab tương ứng.
- **Cây tiến độ tập**: phân đoạn → cảnh, mỗi cảnh có thanh `canh · loi · am · dung · prompt · R · I · V · L` (có/chưa).
- **Lịch phát hành**: 1 tập/tuần từ giữa 09/2027, tập cuối ≈ 26/01/2028 → mỗi tập có **hạn**, tô đỏ tập chậm.
- **Thời lượng**: tổng giây từng tập / trần 20′.
- ⭐ **Số lần sinh Seedance trung bình mỗi cảnh** (đếm `_V*`) — đây là ẩn số lớn nhất của dự án (CLAUDE.md §9), dashboard nên đo nó liên tục.
- **Chi phí**: token + tiền AI theo bước / model / tháng, so với **trần 10–15 triệu VNĐ** (`BUDGET.md`).
- **Việc treo**: mọi `@C:` (việc cho AI) và `@T:` (câu hỏi cho Trường), mục "Đang chờ bạn" của `STATE.md`.

---

## 5. Model & agent (yêu cầu 3, 4)

⚠️ **Sửa khái niệm:** ChatGPT / Gemini / Llama gọi qua API là **model** (vào chữ, ra chữ) — **không phải agent**. Chúng không tự đọc repo, không
sửa file, không điều khiển Blender. Vì vậy tool phải **tự làm phần "agent"**: gom ngữ cảnh, gửi đi, nhận về, đề xuất diff. Tool chia 2 loại:

| Loại | Ví dụ | Làm được |
|---|---|---|
| **chat** (adapter API) | Anthropic API · OpenAI · Gemini · OpenAI-compatible: Ollama, llama.cpp server, LM Studio, OpenRouter | bước ②–⑤, ⑥b — văn bản vào, văn bản ra |
| **agent** (có công cụ) | **Claude Code** (CLI `claude -p` / Agent SDK, dùng lại `.claude/skills/` và MCP Blender) · sau này Codex CLI, Gemini CLI | ⑥a Blender, việc cần đọc nhiều file, chạy script |

Settings kiểu Continue (`aiFilmStudio.models`, ở **User settings**, mỗi máy một bộ):
```jsonc
[
  { "id": "claude-opus",   "provider": "anthropic", "model": "claude-opus-5-5",   "secret": "anthropic" },
  { "id": "claude-sonnet", "provider": "anthropic", "model": "claude-sonnet-5-5", "secret": "anthropic" },
  { "id": "gpt",           "provider": "openai",    "model": "…",                 "secret": "openai" },
  { "id": "gemini-flash",  "provider": "gemini",    "model": "…",                 "secret": "gemini" },
  { "id": "local-qwen",    "provider": "openai-compatible", "apiBase": "http://localhost:11434/v1", "model": "qwen…" },
  { "id": "claude-code",   "provider": "claude-code", "kind": "agent" }
]
```
Mỗi model khai thêm: `contextWindow`, `giá / 1M token vào–ra` (để ước tính tiền), `maxOutput`. Nút **Thử kết nối**.

### 5.1 ContextBuilder — phần quan trọng nhất khi dùng nhiều model
Hiện Claude Code "biết" dự án nhờ `CLAUDE.md` + skill. Model khác không có. ContextBuilder ghép cho mỗi lần chạy:
1. **Lõi dự án** (ngắn, cố định): 4 nguyên tắc, phân vai, chính sách sử liệu, 7 điều cấm — trích từ `CLAUDE.md`, ~2k token.
2. **Hướng dẫn bước**: `.studio/prompts/<bước>.md` — **chuyển từ các skill** `kich-ban-tap`, `lam-phim-lich-su`, `video-ai-dreamina` sang dạng
   mẫu prompt dùng chung cho mọi model (skill gốc vẫn giữ cho Claude Code).
3. **Đầu vào của bước**: đúng **mục** cần thiết (§ [A] của kịch bản, không cả file), danh bạ `@[TÊN]`, quy ước mã.
4. **Yêu cầu thêm** Trường gõ trong tab.

Trước khi chạy hiện **số token + tiền ước tính** và nút *Xem prompt gửi đi* — đúng yêu cầu "dự đoán trước, hạn chế token". Có **trần token mỗi
lần chạy** trong settings; vượt thì hỏi.
Prompt dài lặp lại (lõi + hướng dẫn) đặt ở đầu để dùng **prompt caching** của Anthropic / OpenAI → rẻ hơn khi chạy nhiều cảnh liên tiếp.

### 5.2 Đầu ra có cấu trúc
Yêu cầu model trả về **khối có đánh dấu** (`<<<FILE path §mục>>> … <<<END>>>`) → ProposalService ghép vào đúng mục của file → diff. Model local
yếu hay trả sai khuôn → validator báo lỗi, cho *chạy lại* hoặc *chuyển model dự phòng*.

---

## 6. Quản lý thư mục & `.gitignore` (yêu cầu 6)

⚠️ **Sửa yêu cầu:** dự án **đã có** cấu trúc chạy thật (`00_PROJECT … 99_INBOX`, `EPISODES/<tập>/phan-doan/<X>_…`). Tool không nên "tự đặt ra"
cấu trúc mà **đọc cấu trúc từ `.studio/project.yaml`**. Hai chế độ:
- **Nhận dự án có sẵn** (repo này): quét, sinh `project.yaml` khớp hiện trạng, **không di chuyển file nào**.
- **Dự án mới**: tạo khung từ `project.yaml` mẫu (+ `EPISODES/_TEMPLATE_TAP/`).

ScaffoldService:
- **Tạo khi cần, không tạo sẵn**: thêm tập → copy `_TEMPLATE_TAP`; chia cảnh phân đoạn mới → tạo `phan-doan/<X>_<ten>/<X>_canh.md`. File chưa cần
  thì chưa tạo (đúng PIPE_LINE).
- **`.gitignore` theo khối có đánh dấu**: tool chỉ ghi giữa `# >>> ai-film-studio` … `# <<< ai-film-studio`, **không đụng phần Trường tự viết**.
  Quy tắc lấy từ `project.yaml` (repo chỉ văn bản · ngoại lệ `.blend` · ngoại lệ `seedance_clip/*.mp4|png` · chặn `ban_do_*.blend`, `_gis/` ·
  chặn `.studio/runs/`). Hiện diff trước khi ghi.
- **Toàn quyền của người dùng**: tool **không bao giờ xóa** file (nhớ quy ước "render: tạo file, không xóa"); đổi tên / di chuyển chỉ khi
  Trường bấm, có xác nhận và diff. Sửa tay bất cứ gì → tool đọc lại, không "sửa ngược".
- **mediaRoot ngoài repo**: tool tạo `VIDEO_OUT/<tập>/<phân đoạn>/` và **đặt tên đúng mã** (`EP01_F02_V3.mp4`), có nút *Nhập file* (kéo file
  tải từ Dreamina vào → tool đổi tên theo mã cảnh đang mở).

---

## 7. Những thứ còn thiếu trong danh sách của Trường *(Claude đề xuất thêm)*

| # | Thiếu | Vì sao cần |
|---|---|---|
| 7.1 | ⭐ **CodeRegistry — cấp mã tự động** | Luật "mã không đổi, bỏ không dùng lại, chèn lấy mã kế tiếp chưa dùng" rất dễ sai bằng tay. Mã đã bỏ không còn trong file → phải có sổ `ma-da-cap.json` |
| 7.2 | ⭐ **Cổng duyệt + trạng thái thống nhất** | Một bộ ký hiệu dùng chung mọi file: ⬜ chưa · ✍ đang viết · 👀 chờ duyệt · ✅ duyệt · ⏸ treo · ❌ bỏ. Dashboard chỉ đúng khi trạng thái đúng |
| 7.3 | ⭐ **Ước tính token / chi phí + sổ chi phí** | Trường dùng credit công ty, ngân sách trần 10–15 tr |
| 7.4 | ⭐ **Diff đề xuất thay vì ghi thẳng** | Giữ quy trình git; model rẻ viết sai không phá file |
| 7.5 | **Linter soát nhất quán** (không cần AI) | mã cảnh trong `_loi`/`_prompt` phải có trong `_canh` · `@[TÊN]` có trong danh bạ · giây cảnh 4–30 · tổng tập ≤ 20′ · prompt không đòi sinh chữ · từ cấm (đèn lồng đỏ, hanfu, guzheng…) · file `-v<n>` |
| 7.6 | **Bảng @C / @T** | gom mọi ghi chú, bấm là nhảy tới dòng; "xử lý @C" giao cho model của bước tương ứng |
| 7.7 | **ScriptRunner** | nút cho `tong_hop_loi_dan.py`, `chu_thich_ma.py`, `blender_bridge.py pull`, `cat_clip_seedance.py`, `lam_goi_v6.py` — chạy tự động sau bước liên quan |
| 7.8 | **Ghi nhận kết quả Dreamina** (bước ⑦) | số lần sinh, lỗi, bản chốt → phản hồi ngược để chỉnh prompt; đo ẩn số lớn nhất |
| 7.9 | **Xuất gói cho điện thoại** | Trường làm Dreamina trên điện thoại (máy công ty không vào được) → xuất một trang HTML/MD gọn: prompt + bảng Nạp + ảnh/clip cần nạp |
| 7.10 | **Hồ sơ máy** (laptop / công ty / máy nhà) | model, mediaRoot, đường Blender khác nhau mỗi máy — như `cau_hinh_render.py` |
| 7.11 | **Bàn giao phiên** | nút *Kết thúc phiên* → AI nháp mục nhật ký `STATE.md` từ log các lần chạy hôm đó |
| 7.12 | **Git đầu việc** | nút *Bắt đầu việc* = `git diff` (hiện những gì Trường vừa sửa) + `git add -A`. **Không bao giờ commit** |
| 7.13 | **So sánh 2 model** cùng một bước | chạy song song 2 model, xem 2 diff cạnh nhau — cách nhanh nhất để biết bước nào dùng model rẻ được |

---

## 8. Công nghệ

| Phần | Chọn | Lý do |
|---|---|---|
| Extension | TypeScript, VS Code API ≥ 1.90 | chuẩn |
| Webview UI | **Svelte** (hoặc React) + Vite, `@vscode/webview-ui-toolkit`-style CSS theo theme VS Code | nhẹ, hợp theme sáng/tối |
| Phân tích `.md` | `unified` + `remark-parse` + `remark-gfm` (bảng) | đọc bảng cảnh, mục `§ [A]`, ghi chú `@C:` |
| Render preview | `markdown-it` (cùng họ với preview VS Code) | hiển thị giống hệt |
| Diff | `vscode.diff` (editor so sánh gốc) | không phải tự làm |
| AI | gọi HTTP trực tiếp qua fetch (adapter mỏng) hoặc SDK chính hãng; Claude Code qua `child_process` / Agent SDK | ít phụ thuộc |
| Đếm token | ước lượng theo ký tự cho tiếng Việt + API count-tokens khi có | đủ chính xác để báo trước |
| Git | extension `vscode.git` API | không gọi shell |

Mã nguồn ở **repo riêng** `github.com/ngoctruongns/AI-film-studio`, đặt trong workspace phim tại `04_PRODUCTION/tools/studio/` (repo phim
gitignore thư mục này). Repo phim chỉ giữ `.studio/` (cấu hình + mẫu prompt + sổ mã).

**v0.1 thực tế:** webview viết HTML + JS thuần (chưa cần Svelte) · render markdown bằng lệnh `markdown.api.render` của chính VS Code (không thêm
thư viện) · đọc bảng / mục bằng parser nhỏ tự viết (`src/core/markdown.ts`) thay cho remark · phụ thuộc duy nhất: `yaml`.

---

## 9. Lộ trình làm

| Pha | Nội dung | Dùng được ngay để |
|---|---|---|
| ✅ **v0.1** *(26/10/2026)* | P0 đủ + P1 với Claude (Claude Code CLI, Anthropic API) + một phần P2 (cấp mã, `.gitignore`, script, đếm media) — chi tiết `README.md` | thử trên T01 |
| **P0** — đọc | ProjectModel + parser · cây tập/phân đoạn/cảnh · tab có preview + link mở file · dashboard chỉ đọc · bảng @C/@T · linter cơ bản | nhìn toàn cảnh T01, soát mã |
| **P1** — AI | settings model + SecretStorage · gán model theo bước · ContextBuilder + ước tính token · chạy ③④⑤ → diff → nhận/bỏ · log chi phí | chạy bước văn bản bằng nhiều model |
| **P2** — sản xuất | CodeRegistry · ScaffoldService + `.gitignore` · ScriptRunner · MediaIndex + tab kết quả Dreamina · xuất gói điện thoại | quản file, đo số lần sinh |
| **P3** — agent | tab Blender giao Claude Code · so sánh 2 model · bảng cảnh dạng lưới · bàn giao phiên | thay dần thao tác chat |

⭐ Đề xuất **làm P0 trên chính T01** (đủ dữ liệu: 12 phân đoạn, ~77 câu lời, F có 32+ cảnh) — parser sẽ lộ ra chỗ nào trong các file `.md` đang
viết chưa đều (cột bảng, ký hiệu trạng thái), sửa cho đều trước khi chuyển EP02–EP20.

---

## 10. Trường đã trả lời *(26/10/2026)*

1. ✅ Tool **tổng quát** cho các dự án phim AI; Lam Sơn là dự án thử nghiệm đầu tiên, dự án khác cập nhật thêm cho tool.
2. ✅ **Máy công ty chỉ dùng Claude** (giữ flow hiện tại — Claude Code). Cài đặt model khác chỉ áp dụng cho laptop cá nhân.
3. ✅ Model local chỉ chạy trên laptop. **Ưu tiên Claude trước**; model khác mới **lên khung** (adapter OpenAI / OpenAI-compatible / Gemini trả
   lỗi "chưa làm"), thử nghiệm sau.
4. ✅ Chốt bộ ký hiệu trạng thái §7.2 → **D-24** (`00_PROJECT/DECISIONS.md` của repo phim).
5. ✅ Tách repo `ngoctruongns/AI-film-studio`.
