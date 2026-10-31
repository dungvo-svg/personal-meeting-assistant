# Plan 0.10.0 — sửa theo buổi thử thật 30/10 (họp 16494, Google Meet)

Đầu vào: `.local/drafts/TOOL-FEEDBACK-20261030.md` (A1–A12, B1–B6). Opus chốt kiến trúc và phương pháp ở đây; 4 agent Sonnet làm song song, mỗi agent một nhánh worktree, chỉ sửa vùng code của mình. Opus gộp nhánh, chạy test, viết skill/docs.

## Quyết định của owner (30/10 chiều)
- Làm cả 3 đợt, song song.
- **Micro: "biết tôi nói vào mic là được, không phụ thuộc nền tảng".** Bỏ việc đọc nút micro Zoom. Micro luôn mở; đoạn nào là tiếng người dùng nói vào micro thì là "Tôi", tiếng loa lọt vào micro thì bỏ (đã có `mic_is_own_voice`). Thay OWN-017.
- A4 không phải nạp chậm: 1.273 s là thời gian chờ họp bị tính vào `modelLoadSeconds` (worker bấm giờ trước khi nạp, báo khi bắt đầu nghe). Nạp thật 15,3 s.
- B3 (lưu âm thanh) được duyệt: chỉ khi bật cho từng lần nghe, lưu trên máy, tự xoá.

## Luật chung cho mọi agent
- Làm trong worktree của mình. Tạo junction tới thư mục chính để có model, dữ liệu, môi trường:
  `cmd /c mklink /J .local D:\WORK\Agent\Agent-first\personal-meeting-assistant\.local` (tương tự `.venv`, `node_modules`). Không commit junction (đã nằm trong .gitignore; kiểm `git status`).
- Không gọi `./pma` vào dịch vụ đang chạy ở cổng 8796, không dừng nó. Test tự dùng thư mục tạm và cổng riêng.
- Việc nặng GPU (chỉ agent A): trước khi chạy, kiểm `./pma status` ở thư mục chính; nếu `captureState` là `LISTENING` thì chờ.
- Code giống code quanh nó: ít chú thích, tên rõ, câu chú thích nói *vì sao*. Chuỗi hiện cho người dùng bằng tiếng Việt.
- Chỉ sửa đúng vùng ghi dưới đây. Cần đổi chỗ khác thì ghi trong báo cáo, không tự sửa.
- Xong: `npm test` (Node) và `.venv/Scripts/python.exe -m unittest tests/test_audio_worker.py` đều qua, commit trên nhánh của mình (cuối message: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), không push, không bump version.
- Báo cáo ≤ 300 từ: đã đổi gì (file:hàm), số đo, test, điều chưa kiểm.

## A — Tiếng Lào (A3, A2, B2). Vùng: `tools/audio_worker.py` các hàm `load_models`, `transcribe_chunk`, hằng `LAO_*`, `LANG_*`; `tools/eval_asr.py`; test mới.
1. **A3 – gốc lỗi đã xác minh:** CTranslate2 coi `buzzasr-lao-ct2` (vocab 53.474) là English-only (`model.is_multilingual == False`), nên `transcribe(language='lo')` thực ra giải mã với `<|en|>` (cảnh báo "The current model is English-only…"). Sửa: sau khi nạp model Lào, bọc `lao_model.model` bằng proxy trả `is_multilingual = True` (mọi thuộc tính khác chuyển tiếp). Trước đó kiểm `lao_model.hf_tokenizer.token_to_id('<|lo|>')` nằm trong `lang_ids` của `config.json` và chuỗi SOT thực tế chứa id đó.
2. **Đo trước/sau** bằng `tools/eval_asr.py` trên FLEURS 40 clip Lào + 40 clip Việt (GPU): CER, số chữ Lào/Thái, tốc độ. Không cải thiện thì vẫn giữ sửa (đúng về mặt kỹ thuật) nhưng ghi rõ số.
3. **A2/B2 – câu ngắn và chỗ chuyển ngôn ngữ, giữ chế độ hỗn hợp:** khi phiên có cả vi và lo, nếu tỷ lệ của ngôn ngữ thắng < 0,85 hoặc đoạn < 4 s thì giải mã cả hai (main với `vi`, model Lào với `lo`) và chọn bên có `avg_logprob` trung bình (theo độ dài) cao hơn; còn lại giữ như cũ. Ngưỡng là hằng số. Thêm chế độ vào `eval_asr.py`: cắt clip FLEURS thành đoạn 1,5–3 s để đo độ đúng nhận diện ngôn ngữ, và chạy `.local/eval/mixed-vi-lo-public.wav`. Chỉ bật mặc định nếu: đúng ngôn ngữ ở đoạn ngắn tiếng Lào tăng rõ, tiếng Việt giảm ≤ 2 điểm, tốc độ ≤ 0,3 lần thời gian thực trên GPU.
4. Test unit cho proxy và hàm chọn ngôn ngữ (không cần model thật).

## B — Luồng thu (A1/B4 micro, A4, A9, B3). Vùng: `tools/audio_worker.py` hàm `capture`, `reader`, `ZoomMicWatch`, `pick_mic`, `mic_gate`, args; `tools/zoom_mic_state.ps1` (đổi thành `tools/mic_in_use.ps1`); `src/runtime.ts` các hàm `start`, `launch`, `spawnWorker`, `warmUp`, `stopCapture`, `finish`, `compact` (phần capture); `src/daemon.ts` method `listen`, `pause`, việc dọn file âm định kỳ; `src/cli.ts` lệnh `listen`, `pause`.
1. **Micro không phụ thuộc nền tảng:** bỏ đọc nút micro (UI Automation) và `mic_gate`. Micro luôn mở; giữ lọc tiếng loa lọt vào. Chọn thiết bị: micro đang bị một ứng dụng họp giữ (Core Audio, như C# hiện có, mở rộng tên tiến trình: Zoom, chrome, msedge, firefox, brave, opera, ms-teams, Teams, slack…), không có thì micro mặc định Windows. Kiểm lại mỗi 30 s; nếu ứng dụng họp đổi sang micro khác thì phát `status` `micDeviceChanged` (không đổi giữa chừng). `--no-mic` giữ nguyên.
2. **A4:** sự kiện `ready` không được tính thời gian chờ nguồn vào `modelLoadSeconds`; báo `modelLoadSeconds` (chỉ nạp) và `waitedForSourceSeconds`. Runtime không ghi đè số nạp từ sự kiện `warm`.
3. **A9 – tạm dừng giữ model:** worker nhận `pause` trên stdin: dừng luồng đọc, đóng thiết bị, xả đoạn đang dở, phát lại `warm` rồi chờ dòng nguồn JSON mới (vòng lặp). `stop` vẫn thoát hẳn. Runtime `pause` gửi `pause`, trạng thái về `WARM_READY`; `listen` sau đó có chữ ngay.
4. **B3 – lưu âm thanh (opt-in):** `pma listen --save-audio [--keep-days 7]`. Worker ghi WAV PCM16 mono từng kênh (`speaker`, `mic`) ở tần số thiết bị vào `<dataDir>/audio/<sessionId>/<captureId>-<kênh>.wav`, ghi dần trong lúc nghe. Daemon xoá thư mục âm quá hạn khi khởi động và mỗi giờ; `pma audio purge [--older-than N]`. `status`/RAW ghi rõ đã lưu âm ở đâu và tới ngày nào xoá. Không có cờ thì vẫn RAM_ONLY như cũ. `pma replay` dùng được file đó.
5. Test: tách được phần logic (chọn micro theo danh sách tiến trình, đường dẫn/ngày xoá, vòng pause) thành hàm thuần để test.

## C — Lọc chữ, link Meet, giờ họp (A5, A6, A10, A11/B4 link). Vùng: `tools/audio_worker.py` hằng `SILENCE_*`, `REPEAT`, hàm `segment_flags`, `collapse_repeats`; `src/text.ts`; `src/runtime.ts` hàm `zoomLaunchUrl`, `openMeeting`, hàm mới `setSchedule`; `src/daemon.ts` method `open`, method mới `schedule`; `src/cli.ts` lệnh `start --link`, lệnh mới `at`.
1. **A6:** thêm cụm câu bịa ("không bỏ lỡ", "video hấp dẫn", "nhấn chuông"…). "Cảm ơn." đứng một mình chỉ gắn cờ khi `no_speech_prob > 0,3` hoặc `avg_logprob < -0,8` (người ta vẫn nói "cảm ơn" thật).
2. **A5:** vòng lặp nhiều chữ: cụm 1–4 chữ lặp liền ≥ 4 lần trong một đoạn → `cụm [×N]` (worker `collapse_repeats`, và `text.ts` khi hiển thị cho dữ liệu cũ). `foldRuns` gộp cả các đoạn liền nhau mà phần lớn là cùng một cụm lặp. Có test với chuỗi kiểu "Thủy của Thủy của …".
3. **A10:** `pma at HH:MM` sửa giờ họp theo lịch của phiên đang mở (cập nhật context trong DB); độ phủ tính lại.
4. **A11/B4 link:** nhận `https://meet.google.com/xxx-xxxx-xxx` (kiểm mẫu, dựng lại URL), mở bằng trình duyệt mặc định; `context.meeting.platform = 'meet'`. Báo cáo ghi "Google Meet <mã>".

## D — Màn hình chung + dịch Lào→Việt (A8, B1, B5, A12). **Cập nhật 30/10 (U21): bỏ màn hình chung `/live`, chỉ giữ `pma translate` + dòng dịch trong RAW.** Vùng: file mới `web/live.html`; `src/runtime.ts` bảng mới `translations` và hàm mới (`translate`, `liveState`), dòng dịch trong `writeRaw`; `src/daemon.ts` route mới `/live`, `/api/live`, `/api/live-events`, method RPC mới `translate`; `src/cli.ts` lệnh mới `translate`, `live`.
1. **Cách người dự xem:** người dùng mở `http://127.0.0.1:<port>/live` rồi **chia sẻ cửa sổ đó trong Zoom/Meet**. Dịch vụ vẫn chỉ nghe trên 127.0.0.1, không mở ra mạng. Trang chỉ đọc, dùng cookie như bảng hiện có.
2. **Trang:** khoảng 40 đoạn gần nhất, chữ to, tự cuộn. Mỗi đoạn: giờ, nhãn vi/lo, chữ gốc (đã áp bảng tên), dòng "Tôi" nếu là micro; dưới đoạn tiếng Lào là bản dịch tiếng Việt "(Claude dịch)" khi có. Ẩn câu ảo. Dải trên cùng: "Chữ nhận dạng tự động, chưa xác minh; bản dịch do Claude, trễ vài chục giây". Cập nhật qua SSE ngay khi có đoạn mới (A12: chữ gần thời gian thực, bản dịch theo lô).
3. **Dịch do Claude (chỉ AI Claude):** phiên Claude theo dõi họp chạy `pma follow --batch 15` khi bật màn hình chung, dịch các đoạn `lo` và lưu: `pma translate --source <id> --text "<tiếng Việt>"` hoặc `pma translate --file t.json` (`[{"sourceId":..,"text":".."}]`). Kiểm: đoạn thuộc phiên, ngôn ngữ `lo`, ≤ 2000 ký tự; dịch lại thì thay bản cũ. RAW ghi bản dịch ngay dưới đoạn Lào: `  → (Claude dịch) …`.
4. `pma live` in đường dẫn trang và cách chia sẻ cửa sổ. Test: lưu/thay bản dịch, từ chối đoạn không phải Lào hoặc ngoài phiên, RAW có dòng dịch, `/live` trả HTML và `/api/live` trả đoạn + bản dịch.
5. Ghi vào báo cáo một đoạn ngắn hướng dẫn cho skill `hop` (Opus sẽ đưa vào skill).

## Gộp (Opus)
Thứ tự: C → A → B → D. Sửa xung đột, bump 0.10.0, skill `hop`, CHANGELOG, DECISION_LOG (OWN-017 sửa, ENG mới), cập nhật issue #1–#5 + issue mới cho phần chưa xong, chạy toàn bộ test.
