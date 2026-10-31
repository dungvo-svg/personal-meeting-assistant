# Changelog

## 0.10.1 —31/10/2026

- Owner: "các đoạn là phần dịch theo dõi, còn wav phải ghi được đầy đủ". **WAV ghi mặc định** mỗi lần nghe (tắt bằng `--no-save-audio` hoặc `PMA_SAVE_AUDIO=0`), tự xoá sau 7 ngày (`--keep-days`). Worker ghi mọi khối âm thô trước khi lọc im lặng/nhận dạng, nên WAV đủ cả phần ASR bỏ qua.
- **File ghép `<lượt nghe>-mix.wav`** (16 kHz mono) do `tools/mix_audio.py` làm sau khi tạm dừng/kết thúc, chạy tiến trình riêng, không làm chậm `pause`/`stop`: loa + micro, micro chỉ cộng vào lúc người dùng nói (tránh tiếng loa lọt vào bị đôi). Dùng file này cho `pma replay`. `pma audio list` chỉ file ghép.
- Thử thật 10 s: loa 44,1 kHz 10,68 s, micro 10,59 s, file ghép 16 kHz 10,68 s. Test: 49 Node, 49 Python.

## 0.10.0 —30/10/2026

Sửa theo buổi thử thật 30/10 trên Google Meet (`docs/PLAN_0_10.md`). Opus chốt kiến trúc, 5 agent Sonnet làm song song (A–E), Opus gộp.

- **Tiếng Lào (A3, A2/B2):**
  - Model BuzzASR/lao bị CTranslate2 coi là English-only, nên từ 0.6 đến 0.9 tiếng Lào được giải mã với `<|en|>`. Đã sửa.
  - Đo trên FLEURS (GPU), sai ký tự tiếng Lào giảm: 33,2% → 24,4% (sửa lỗi trên) → 21,3% (thêm beam 5).
  - Tiếng Việt 4,33% → 4,09%.
  - Đoạn Lào ngắn 1,5–3 s nhận đúng 78,7% → 90,0%, nhờ giải mã cả hai bên khi bộ dò không chắc. Đổi lại, mảnh Việt 1–3 chữ giảm 3–5 điểm; tắt bằng `LANG_PICK_DEFAULT`.
- **Tận dụng GPU:** beam 5 trên cuda (CPU giữ 1). Đoạn âm tối thiểu 3 s trên GPU.
- **Phản hồi nhanh hơn:** `pma follow` mặc định lô 15 s (trước 60 s; đo 30/10: ASR chỉ trễ ~0,3 s, chậm nằm ở lô và chờ đủ đoạn).
- **Hai phiên theo dõi:** dịch thô (Haiku, effort low, `--batch 15 --as dich --no-notes`) và tổng hợp (Sonnet, `--batch 60`).
  - Mỗi người theo dõi có con trỏ và heartbeat riêng.
  - Stop hook giữ đúng từng phiên.
  - Skill `hop` mở phiên dịch thô ngay sau LISTENING.
- **Micro "Tôi" không phụ thuộc nền tảng (A1/B4):**
  - Bỏ đọc nút mute Zoom của 0.9.0.
  - Micro luôn mở; lấy micro mà ứng dụng họp (Zoom, trình duyệt, Teams…) đang giữ, không có thì micro mặc định Windows. Kiểm lại mỗi 30 s (`tools/mic_in_use.ps1`).
  - Tiếng loa lọt vào vẫn bị bỏ. Lời nói khi đang tắt mic trên Zoom/Meet cũng vào "Tôi".
- **Google Meet:** `--link https://meet.google.com/…` mở trình duyệt; báo cáo ghi "Google Meet <mã>".
- **Tạm dừng giữ mô hình (A9):** `pma pause` → `pma listen` có chữ ngay.
- **Số đo nạp mô hình (A4):** 1.273 s ở buổi 30/10 là thời gian chờ họp bị tính nhầm. Nay tách `modelLoadSeconds` và `waitedForSourceSeconds`.
- **Lưu âm thanh (B3, opt-in):** `pma listen --save-audio [--keep-days 7]`; WAV từng kênh trên máy, tự xoá; `pma audio [list|purge]`.
- **Lọc chữ (A5, A6):**
  - Câu bịa "video hấp dẫn", "nhấn chuông"…
  - "Cảm ơn." đứng một mình chỉ bị lọc khi đoạn gần như im lặng.
  - Vòng lặp 2–4 chữ gộp `cụm [×N]`, cả với dữ liệu cũ.
- **Giờ họp (A10):** `pma at HH:MM` sửa giờ họp theo lịch sau khi mở phiên.
- **Dịch Lào→Việt (B1):** Claude dịch trong phiên; `pma translate` lưu, RAW in `→ (Claude dịch) …`. Màn hình chung `/live` đã làm rồi bỏ theo owner (U21: họp trên session, không qua web).
- **Phát lại bản ghi Zoom 11,9 phút ở tốc độ thật (GPU, 0.10):**
  - Nạp model 13,3 s.
  - ASR trễ p50 0,4 s / p90 0,7 s / max 3,6 s.
  - Đoạn dài p50 8,4 s, p90 15,5 s.
  - 3/180 đoạn cắt cưỡng bức.
  - VRAM đỉnh 4,4 GB / 6 GB.
  - 3/180 mảnh Việt ~3 s bị gắn `lo` (có cờ ngôn ngữ không chắc).
- **Test:** 45 Node, 33 Python.

## 0.9.0 —30/10/2026

- Owner (U19): micro “Tôi” **bật mặc định** và chỉ lấy tiếng khi **nút micro Zoom đang bật**. `tools/zoom_mic_state.ps1` đọc tên nút micro trong cửa sổ họp qua Windows UI Automation và micro Zoom đang dùng qua Core Audio (chỉ đọc). Tắt mic, chưa vào họp hoặc không đọc được đều tính là tắt. Micro chọn theo micro Zoom đang dùng, không có thì micro mặc định Windows. `pma listen --no-mic` để tắt cho một buổi; `select-mic` không cần `--consent` nữa.
- Sửa theo buổi họp thật 30/10:
  - `pma follow` in mỗi đoạn một dòng; đoạn dài nối dòng `↳`, vì Monitor cắt dòng dài khoảng 500 ký tự.
  - Bảng tên từ chối biến thể quá ngắn, là từ thông dụng, hoặc đã thuộc tên khác; thêm `--force` và `pma glossary help`.
  - `start` báo lần trước nạp mô hình mất bao lâu; `listen` chờ tới 5 phút.
  - `start --at HH:MM` để RAW/SUMMARY/TASKS ghi **độ phủ** (nghe được từ–đến, lỡ bao nhiêu phút đầu).
  - `start --me "Tên"`, nhớ cho lần sau: RAW ghi `Tôi — Tên (micro)`, TASKS.md có mục **Việc của tôi**.
  - Câu “Chào mừng” đứng một mình được coi là câu ảo.
  - Skill `hop`: nhắc bật lại Monitor sau 30 phút.
- Chưa làm, để vào issue chờ thêm dữ liệu họp: phân biệt người nói, từ nghiệp vụ nghe sai, thời gian nạp mô hình lúc dài lúc ngắn, kiểm micro Zoom trên buổi họp thật.
- Test: 32 Node, 18 Python.

## 0.8.0 —29/10/2026

- Sửa theo audit 2 buổi họp 29/10 (`docs/AUDIT_HOP_20261029.md`): nạp sẵn mô hình, cắt đoạn ở chỗ yên nhất (tối đa 20 s), báo độ trễ, câu ảo xuống phụ lục, gộp đoạn lặp, bảng tên, kênh micro “Tôi”, nhắc ghi chú.

## 0.7.0 —28/10/2026

- Owner: “Nâng tiếng Việt GPU”. Model chính trên GPU là **Whisper large-v3-turbo** (MIT, tự chuyển từ bản gốc `41f01f3` bằng `tools/convert_whisper_model.py`): nhận diện vi/lo và nhận dạng tiếng Việt. Tiếng Lào vẫn qua BuzzASR/lao. Không có GPU thì về small trên CPU.
- Chọn model bằng `.local/models/asr-profile.json` (mẫu `config/asr-profile.example.json`): `main`, `lo`, và tùy chọn `vi` cho model chỉ-tiếng-Việt. Bộ thu, phát lại và nhận dạng video dùng chung.
- Đo FLEURS tiếng Việt (40 clip, toàn luồng GPU): small 9,9% → turbo **4,8%**; turbo + PhoWhisper-large 3,9%; turbo + PhoWhisper-medium 5,9%. Nhận diện ngôn ngữ với turbo: Việt 40/40, Lào 39/40; CER Lào 36,4%.
- Không chọn PhoWhisper mặc định: trên họp thật nó viết toàn chữ thường, đọc số thành chữ ("một trăm năm mươi"), sai tên viết tắt ("enancy" cho NNC), chậm hơn 1,6 lần và cần 5,4 GB VRAM (turbo: 3,6 GB).
- Video họp 28/10 (44 phút): câu ảo 35 → 18, tên "Sơn" nhận được 6 → 41 lần, "NNC" 3 → 8; xử lý 4,3 phút. Test: 25 Node, 9 Python.

## 0.6.0 —28/10/2026

- Owner: “Làm tiếng Lào GPU”. ASR chạy CUDA trên RTX 3050 (cuBLAS/cuDNN từ wheel NVIDIA, `requirements-gpu.lock.txt`); không có GPU thì tự về CPU như trước.
- Tiếng Lào: đoạn được Whisper small nhận là `lo` (gồm cả `th`) chuyển sang **BuzzASR/lao** (MIT, Whisper large-v3 fine-tune, revision `14f66e2`), chuyển sang CTranslate2 bằng `tools/convert_lao_model.py`. Sửa tokenizer: bộ từ vựng thay thế giữ tên token đặc biệt ở id thấp, model dùng id 51865+; thiếu `lang_ids` làm faster-whisper coi là model tiếng Anh và ra rỗng.
- Đo trên FLEURS (40 clip mỗi ngôn ngữ, `tools/eval_asr.py`): nhận diện ngôn ngữ 100%/100%; CER Lào 36,3% (trước: 100,2%, toàn chữ Thái), chữ Lào 3.570 / chữ Thái 0; CER Việt 9,9%; tốc độ 0,12 (Lào) và 0,06 (Việt) so với thời gian thực. FLEURS là giọng đọc, chưa phải họp.
- Phát lại file trộn công khai Việt→Lào→Lào qua `pma replay` trên GPU: đoạn Việt ra chữ Việt, đoạn Lào ra chữ Lào.
- `tools/setup_lao_gpu.sh` cài toàn bộ (thư viện CUDA, model, dữ liệu chấm điểm, môi trường chuyển đổi riêng). Test: 25 Node, 8 Python.

## 0.5.0 —28/10/2026

- Audit MCP (`docs/AUDIT_MCP_20261028.md`) theo yêu cầu owner: MCP không hợp làm lõi. Chuyển sang **dịch vụ nghe chạy nền một bản mỗi máy** (`src/daemon.ts`), **CLI `pma`** (`src/cli.ts`, `./pma`, `pma.cmd`), **skill `/hop`** (`.claude/skills/hop/SKILL.md`) và **Monitor trên `pma follow`**. MCP (`src/server.ts`) còn là lớp mỏng chuyển tiếp, không giữ trạng thái hay cổng.
- Dịch vụ được tạo qua WMI trên Windows: không kế thừa đường ống/job của lệnh gọi, sống qua khởi động lại Claude; tự thoát sau 30 phút không có phiên. RPC loopback có token trong `daemon.json`; trình duyệt bị từ chối.
- `pma follow` in text theo lô (mặc định 60 s) và gửi heartbeat; Stop hook cho phép kết thúc lượt khi có Monitor theo dõi, chặn khi không ai theo dõi; hook dùng `node:http` (fetch làm Node crash lúc thoát trên Windows, khiến quyết định chặn bị bỏ qua) và vẫn đọc được server cũ qua `panel.json`.
- `pma replay`: phát lại file ghi hình qua đúng worker, cắt đoạn và ASR; thử trên clip FLEURS tiếng Việt: 2 đoạn `vi`, báo hết phát lại, RAW đúng.
- Kiểm chứng: 25 test Node (runtime + dịch vụ/CLI/hook), 4 test Python, probe MCP qua lớp mỏng PASS. Chưa chạy trọn một cuộc họp thật với Monitor.

## 0.4.0 —28/10/2026

- Owner (U16–U17): host Claude Code; chỉ Claude là AI, công cụ âm thanh/ASR/dịch mã nguồn mở chạy trên máy; theo dõi đến khi người dùng kết thúc; mọi thao tác qua Claude. Ghi OWN-013..016, ENG-14..16; backlog `docs/V0_4_BACKLOG.md`.
- T01: Stop hook giữ lượt khi đang họp (`tools/meeting_stop_hook.mjs`), cài cục bộ ở `.claude/settings.local.json`.
- T02: tool `source_select` + `source_list.suggested`; không cần mở trình duyệt để cấp quyền nguồn loa.
- T04/T05: quá tải ASR ghi khoảng trống thay vì dừng; câu ảo khi im lặng, lặp từ và tiếng Lào chữ Thái được gắn cờ (dùng chung cho bộ thu và `tools/transcribe_recording.py`).
- T06: `session_status`/`hearing_pause`/`session_finish` trả bản gọn (< 4 KB); phiên bị bỏ dở do crash kết thúc ở thời điểm có nguồn cuối cùng.
- Thêm `tools/transcribe_recording.py`: nhận dạng lại file ghi hình họp trên máy thành một RAW.md.
- Kiểm chứng: 20 contract test, 4 test Python, probe 17 tools, hook thử với phiên không liên quan (cho dừng) và phiên đang họp (chặn). Chưa đo hook trong cả một cuộc họp thật.

## 0.3.0 —28/10/2026

- Owner (U12–U14): nghe họp từ link Zoom + nội dung, sau họp có RAW + Summary + Task; bộ công cụ dùng được cho host không phải Claude. Ghi OWN-009..011; OWN-009 thay phần “không tự mở link/Join” của OWN-007.
- Lần chạy thật đầu tiên 28/10 qua Claude Code: G243FW không nhận khung âm nào vì Zoom phát ra loa mặc định Realtek. Thêm đo mức âm từng nguồn loa (không mở microphone), chọn sẵn nguồn có tiếng trên bảng, phát im lặng giữ khung âm loopback, cảnh báo nguồn im lặng quá 30 giây, bỏ dừng phiên khi tràn bộ đệm và không đưa đoạn hoàn toàn im lặng vào ASR.
- Tools mới: `meeting_open`, `report_raw`, `report_save_summary`, `report_save_tasks`; `session_prepare` nhận agenda; `history_read` đọc 100 đoạn/trang. `session_finish` tự ghi RAW.md. Agenda đã lưu của ngày khác không còn được dùng làm context.
- Bảng: bỏ chữ Claude cố định, thêm Tải RAW/Summary/Task và lời giao việc mới. Thêm `handoff/MEETING_START.vi.txt` và `tools/mcp_config.py` in cấu hình cho Claude Code, Claude Desktop, Codex, Antigravity.
- Owner (U15): nghe lẫn Việt–Lào (OWN-012). Mỗi đoạn được chọn vi/lo, có nhãn ngôn ngữ trên bảng/RAW/tools; `session_prepare(languages)` mặc định `[vi, lo]`. Đo trên clip tiếng Việt công khai: vẫn chọn vi, ~5,3s cho 11,3s âm (chỉ vi ~3,4s; máy đang chạy song song một phiên ASR khác). Ép tiếng Lào với whisper small ra chữ Thái: gắn cờ, nội dung tiếng Lào chưa dùng được. Gộp sửa nóng của phiên họp 28/10: điểm Thái tính vào Lào, đoạn tối thiểu 6 giây khi nghe hai thứ tiếng, `max_new_tokens=160` chống lặp.
- Kiểm chứng: 17 contract test, protocol probe 16 tools, kiểm tra keepalive trên G243FW im lặng, bảng chọn đúng nguồn có tiếng. Chưa có phiên họp đầy đủ chạy bản 0.3.0, chưa thử Codex/Antigravity thật.

## 0.2.0 —26/10/2026

- Owner bổ sung pilot chiều nay: chỉ tiếng Việt, không phiên dịch; nguồn G243FW, chủ động tự restart Claude sau. Không thực hiện restart/capture test thay người dùng.
- Dựng local MCP tools, SQLite text/history/export, panel loopback và WASAPI/faster-whisper worker. Agent đọc nguồn/context và ghi chú có nguồn khi được yêu cầu.
- Pin dependencies/model; PyAV 16.0.1 sửa lỗi tương thích decode quan sát ở 19.0.2. Audio cuộc họp chỉ RAM, scope/capture hữu hạn, giữ sở hữu recorder qua STOP và có parent watchdog.
- Kiểm tra offline contracts, SDK protocol/HTTP, browser UI, resampling/watchdog và một file tiếng Việt công khai. Chưa actual Claude/device/continuous-agent/Human UAT.
- Lần chỉnh MCP config có backup/readback bị app đang chạy ghi đè; thêm installer chỉ apply khi Claude đã thoát, cùng runbook/prompt. Owner sẽ tự thoát, hoàn tất cài và mở lại. Snapshot v0.2.0 phản ánh phạm vi/evidence hiện tại; giữ tag baseline v0.1.0.

## 0.1.0 —26/10/2026

- Khóa 7 quyết định người dùng: dự án riêng, thay host được, Claude Desktop trước, bảng dịch V1, lưu text/audio tạm, agent làm chủ workflow và hỗ trợ cuộc họp đã mở.
- Điều chỉnh khung ban đầu thành bộ tools quanh agent; bỏ hỏi đáp khỏi V1, bổ sung cách dùng và vòng đời phiên/dữ liệu.
- Lập baseline kỹ thuật local MCP, TypeScript/Node, panel cá nhân, source/revision/STOP và giới hạn tài nguyên; các lựa chọn kỹ thuật mang nhãn ENGINEERING_BASELINE.
- Ghi nguồn công khai và kế hoạch kiểm chứng Claude Desktop, đặc biệt vòng tools qua turn boundary và nguồn audio/ASR.
- Thêm ma trận nghiệm thu, quy tắc đổi baseline và kiểm tra snapshot SHA-256. Chưa có runtime hoặc thử tích hợp/live.

## Khởi tạo —26/10/2026

Commit `1f4270b`: tạo repository và tài liệu nền độc lập. Bản đó là lịch sử; v0.1.0 hiện hành thay thế các mô tả phạm vi/kiến trúc ban đầu có khác biệt.
