# Plan 0.11.0 — trợ lý họp "sống theo phiên họp", bản ghi là hộp đen

Opus quyết định ngày 31/10/2026, dựa trên câu trả lời của owner (Dũng). Báo cáo `.local/drafts/AUDIT-KIEN-TRUC-20261031.md` (Fable) **chỉ để tham khảo kỹ thuật**; các chỗ bác bỏ ghi ở cuối. Sonnet làm song song theo vùng file, Opus gộp. Nghiệm thu sản phẩm bằng **buổi họp thật tiếp theo**. Không ai tự thu âm để tự kiểm mình: agent chỉ dùng test, dữ liệu giả, file ghi có sẵn.

## Định hướng sản phẩm (owner, 31/10)
1. **Claude trong phiên là người dùng công cụ**: Claude dùng công cụ để phục vụ owner và cuộc họp, phân tích trực tiếp, real-time. Công cụ là tai + bộ ghi của Claude, không phải dịch vụ cho người khác, không thi đấu với AI có sẵn của Zoom/Meet.
2. **Hai phiên Claude khi họp** (giữ như owner chốt 30/10):
   - Phiên **dịch thô** (Haiku, effort low, lô 15 s) là "màn hình": như một người ngồi dịch, owner share phiên đó cho người dự.
   - Phiên **tổng hợp** (Sonnet, lô 60 s) ngồi chat với owner.
   - Không build màn hình/trang web nào.
3. **Sổ phiên = context trước họp.** Claude chuẩn bị từ nội dung owner gửi: mục tiêu, người dự, ngôn ngữ, thuật ngữ, tên dễ nghe sai. Không phải bảng giám sát runtime.
4. **WAV = âm thanh thật của cả buổi, là hộp đen.**
   - Ghi từ lúc `pma start` tới khi owner gõ kết thúc. Giữ tới khi người dùng tự xoá.
   - Nghe real-time chỉ là hỗ trợ, được phép thiếu nhưng phải biết và báo chỗ thiếu.
   - Ưu tiên runtime không sót, không ngắt.
5. **Nghe lại là việc của Claude, không phải của người.** Owner đã nghe trực tiếp. Khi Claude chưa nghe rõ (cờ ngôn ngữ không chắc, Lào kém, đoạn ngắn, khoảng trống, câu vô nghĩa), Claude tự `pma recheck` từ WAV. Vẫn không rõ thì đánh dấu `[chưa nghe rõ]`, không đoán.
6. **Ba ngôn ngữ Việt / Lào / Thái** (nhóm Tai-Kadai). Đạt khi người nói Lào mà máy ra chữ Thái, dịch ra tiếng Việt không đổi nghĩa. Thuật ngữ phụ thuộc context trước họp; thiếu thì ghi thô là bình thường.
7. **Micro "Tôi"** luôn ghi, phân loại: mic bật trong họp / mic tắt (nói riêng) / không rõ.
8. Kết thúc khi owner gõ kết thúc trong chat (sau này học câu chào cuối buổi — issue).

## Kiến trúc 0.11
```
pma start ─► host phiên (src/daemon.ts, chỉ sống trong phiên họp; thoát sau stop + ghép WAV)
             ├─ recorder (tools/recorder.py): loa + micro → WAV khúc 10 phút + timeline.jsonl, không model, tự chạy lại khi lỗi
             └─ bộ nghe (tools/audio_worker.py --follow <thư mục âm>): nạp model, đọc WAV từ giây 0, đuổi kịp, nhận dạng
Claude (2 phiên) ─► pma brief · pma follow · pma translate · pma note · pma recheck · pma coverage · pma stop
```
- Không còn trần 2 giờ.
- Lỗi ASR một đoạn: ghi `[KHOẢNG TRỐNG ASR]`, chạy tiếp. Bộ nghe chết: host chạy lại, tối đa 3 lần/10 phút rồi báo.
- Host chết: recorder vẫn ghi. Host mới gắn lại cùng phiên.
- `stop`: bộ nghe nhận dạng nốt rồi mới thoát; ghép WAV xong host mới thoát.
- `pause` chỉ dừng ASR, recorder vẫn ghi.

## Bốn quy ước chung (mọi agent theo đúng)
**Q-1. Thư mục âm của phiên.** `<dataDir>/audio/<sessionId>/`:
- `seg-0001-speaker.wav`, `seg-0001-mic.wav`, `seg-0002-…`: PCM16 mono ở tần số thiết bị. Khúc mới mỗi 10 phút, khi đổi thiết bị, hoặc khi recorder chạy lại. Header vá sau mỗi lần ghi.
- `timeline.jsonl`: mỗi dòng một JSON có `t` (giờ ISO, giờ thật) và `type`:
  - `open {seg, channel, rate, device}`
  - `tick {seg, channel, samples}` (≈ 1 s một lần; `samples` là số mẫu đã ghi của khúc đó; dùng để đổi giờ thật ↔ mẫu)
  - `lost {seg, channel, seconds, reason}`
  - `close {seg, channel, samples}`
  - `mic_state {state: on|off|unknown|none, app, by}`
  - `error {channel, message}`
  - `end {}` khi recorder kết thúc hẳn.
- `meeting-mix.wav`: 16 kHz mono, ghép mọi khúc theo giờ thật. Có khi kết thúc, và bản tạm khi `pause`.
- `expires.json` giữ nguyên định dạng; mặc định **không hết hạn** (`expiresAt: null`) cho tới khi người dùng xoá.

**Q-2. Bộ nghe đọc file.** `audio_worker.py --follow <dir> --languages vi,lo,th`:
- Đọc từng kênh theo khúc, từ mẫu 0. Khúc đang ghi thì đọc tới phần đã có rồi chờ.
- Chunk như cũ, kênh `speaker`/`mic` như cũ.
- Sự kiện `source` giữ trường cũ, thêm `wall` (giờ thật lúc bắt đầu đoạn, tính từ timeline) và `seg`.
- Kết thúc khi gặp `end` trong timeline và đã đọc hết. Lệnh stdin: `stop` (đọc nốt rồi thoát), `pause`/`resume`.
- `audio_worker.py --recheck <dir> --from <ISO> --to <ISO> [--channel speaker|mic] [--beam 8]`: cắt theo timeline, nhận dạng lại, cho ra JSON `{text, language, alternatives:[{language,text,score}], silent}`.

**Q-3. Nhận biết phiên đang sống.** Vẫn dùng `<dataDir>/daemon.json`, giữ để hook/cli cũ đọc được. Thêm trường `sessionId`, `recorderPid`, `workerPid`. Host chỉ được tạo bởi `pma start`; lệnh khác khi không có phiên thì tự bật host chỉ để đọc lịch sử, rồi thoát sau 2 phút rảnh.

**Q-4. Nhãn mới trong `boundary`:**
- `MIC_STATE_ON`, `MIC_STATE_OFF`, `MIC_STATE_UNKNOWN`
- `ASR_ERROR`, `ASR_RESTARTED`, `RECHECKED`
- ngôn ngữ `th` được nhận ở mọi nơi đang nhận `vi`/`lo`.

## Chia việc Sonnet (worktree riêng; trước hết `git merge --no-edit codex/personal-assistant-init`)
| Agent | Vùng file | Việc |
| --- | --- | --- |
| **R — recorder** | mới `tools/recorder.py`, `tools/timeline.py`, sửa `tools/mix_audio.py`, mới `tests/test_recorder.py` | Theo Q-1. Nguồn đọc qua lớp trừu tượng (thiết bị thật / nguồn giả cho test). Đếm mẫu mất bằng `perf_counter`. Lỗi thiết bị → khúc mới ≤ 2 s. Nếu `tools/mic_state.ps1` có thì chạy nó và ghi `mic_state` vào timeline. Ghép `meeting-mix.wav` theo timeline (micro chỉ cộng lúc là tiếng người dùng). |
| **W — bộ nghe** | `tools/audio_worker.py`: phần đọc nguồn/`capture`/`run_listening`/`read_commands`, chế độ `--follow` và `--recheck` theo Q-2, bọc lỗi ASR từng đoạn (`ASR_ERROR`), `stop` đọc nốt; `tests/test_audio_worker.py` (test mới) | Không đụng `transcribe_chunk`, `LANG_*`, `segment_flags` (agent L). Giữ `--replay`. |
| **H — host phiên** | `src/daemon.ts`, `src/client.ts`, `src/runtime.ts` (vòng đời, `prepare/start/pause/stopCapture/finish`, spawn + giám sát recorder/bộ nghe, bỏ trần 7200, không đánh `ended` khi recorder còn sống, hàm mới `recheck`, `coverage`), `src/audio.ts` (không hết hạn mặc định), `src/cli.ts` (`start/listen/pause/stop/recheck/coverage/audio`), test Node | Theo Q-1..Q-4. `recheck` gọi worker `--recheck`, lưu kết quả và gắn `RECHECKED`. `coverage` liệt kê chỗ WAV có âm mà không có chữ, đoạn lỗi, đoạn cờ không chắc. |
| **L — ba ngôn ngữ** | `tools/audio_worker.py`: `transcribe_chunk`, `LANG_*`, `segment_flags`, `pick_by_score`; `tools/eval_asr.py`; validate ngôn ngữ trong `src/runtime.ts`/`src/daemon.ts` (chỉ các dòng kiểm `vi`/`lo`) | Nhãn `th`. LID ba ngôn ngữ. Đoạn Tai không chắc → chạy Whisper-`th` và BuzzASR-`lo`, giữ cả hai (`alternatives`) để Claude dịch theo nghĩa. Đo FLEURS `th` (GPU, khi không có phiên họp đang nghe). |
| **C — context trước họp + micro** | mới `src/brief.ts`, `config/owner.example.json`, `src/cli.ts` lệnh `brief`, `participants`, cờ `start --participants`; mới `tools/mic_state.ps1` (Zoom + Chrome/Edge UIA, chỉ đọc), mới `tools/mic_state.py` (hàm thuần gán nhãn đoạn micro theo timeline), `src/text.ts` nhãn hiển thị, `cli.ts` `me --on/--off` | Brief ≤ 2 KB: tôi là ai (`.local/context/owner.json`), người dự, mục tiêu, ngôn ngữ, thuật ngữ, tên dễ nghe sai; thêm một dòng tình trạng ngắn. Gắn nhãn micro vào worker: Opus nối khi gộp. |

Opus làm sau khi gộp:
- nối nhãn micro vào worker;
- `follow`: xả lô ngay khi có dòng `lo`/`th` (phiên dịch), tự thoát phút 29 và in `BẬT LẠI`;
- skill `hop` (hai phiên, recheck của Claude, context trước họp);
- PRODUCT_BASELINE 0.11, DECISION_LOG, CLAUDE.md/AGENTS.md/README/project.json, chuyển tài liệu cũ sang `docs/history/`;
- CHANGELOG, bump 0.11.0.

Push sau buổi họp thật tiếp theo.

## Khuyến nghị của Fable không theo, và vì sao
- **"Một phiên Sonnet"**: owner chốt hai phiên. Phiên dịch thô là "người ngồi dịch" được share cho người dự; mục đích là người dự thấy, không phải giảm độ trễ của một chuỗi.
- **"Real-time cho người xem lấy từ dòng `pma follow`"**: màn hình là phiên Claude dịch, không phải log công cụ.
- **"Owner chọn 3 chỗ để nghe lại"**: nghe lại là việc của Claude.
- **"Sổ phiên giám sát trạng thái/chỗ hổng"**: sổ phiên là context trước họp. Trạng thái chỉ một dòng.
- **"Khôi phục `/live`"**: không build màn hình.
