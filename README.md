# Trợ lý họp cá nhân

Trợ lý họp chạy trên máy của owner. **Claude trong phiên làm việc dùng bộ công cụ này** để nghe, ghi, dịch thô và tổng hợp cuộc họp Zoom / Google Meet nói tiếng Việt, Lào, Thái. Sau họp, Claude làm RAW + SUMMARY + TASKS.

- **Định hướng hiện hành:** [docs/PRODUCT_BASELINE.md](docs/PRODUCT_BASELINE.md) (v0.12). Quyết định có nguồn: [docs/DECISION_LOG.md](docs/DECISION_LOG.md).
- **Cách họp:** skill [`hop`](.claude/skills/hop/SKILL.md). Owner gõ `/hop` kèm link + nội dung họp, Claude làm phần còn lại qua `./pma`. Owner chỉ share cửa sổ phiên dịch thô; không có trang web nào.
- **Kiến trúc và quy ước file:** [docs/PLAN_0_11.md](docs/PLAN_0_11.md); thay đổi 0.12: [docs/PLAN_0_12.md](docs/PLAN_0_12.md).
- **Thay đổi theo bản:** [CHANGELOG.md](CHANGELOG.md).
- **Tài liệu cũ** (bảng dịch trực tiếp, pilot 26/10, MCP…): [docs/history/](docs/history/). Chỉ để tra lại.

## Thành phần

| Đường dẫn | Vai trò |
| --- | --- |
| `src/daemon.ts` | Host phiên họp: chỉ sống trong phiên, giữ SQLite, giám sát bộ ghi và bộ nghe; chỉ phục vụ `/rpc` loopback có token |
| `src/runtime.ts`, `src/cli.ts` | Logic phiên và lệnh `pma` |
| `src/brief.ts`, `src/participants.ts`, `src/owner.ts` | Context trước họp (`pma brief`) |
| `tools/recorder.py` | Bộ ghi hộp đen: loa + micro → WAV khúc 10 phút + `timeline.jsonl` |
| `tools/audio_worker.py` | Bộ nghe: nhận dạng vi/lo/th trên GPU từ WAV (`--follow`), nghe lại (`--recheck`) |
| `tools/mix_audio.py` | Ghép `meeting-mix.wav` cả buổi theo giờ thật |
| `tools/mic_state.ps1`, `tools/mic_state.py` | Trạng thái micro Zoom/Meet để phân loại lời "Tôi" |
| `tools/meeting_stop_hook.mjs` | Stop hook: giữ phiên Claude theo dõi khi họp còn chạy |
| `.local/` | Model, âm thanh, lịch sử, context cá nhân. Không vào Git |

Cần Node 24.14+, Python venv `.venv` và model trong `.local/models` (`config/asr-profile.example.json`). Chạy test: `npm test` và `.venv/Scripts/python.exe -m unittest discover -s tests -p "test_*.py"`.

Dự án độc lập với AIOS. Chỉ Claude là AI; âm thanh và ASR là mã nguồn mở chạy trên máy.
