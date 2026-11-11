# Baseline sản phẩm v0.11.1

Bản sửa kỹ thuật 03/11/2026, chỉ trong worktree isolated, chưa tích hợp/phát hành. Windows launcher giữ lựa chọn explicit `PMA_MIC=0` và `PMA_AUTO_SOURCE=0` trước khi host tạo runtime. Không đổi mặc định, OWN-027 hoặc chính sách share/capture/WAV/RAW. Các quyết định sản phẩm dưới đây giữ nguyên nguồn ngày 31/10.

Ngày 31/10/2026. **Đây là nơi chốt sản phẩm hiện hành.** Quyết định có nguồn ở [DECISION_LOG.md](DECISION_LOG.md). Kế hoạch triển khai ở [PLAN_0_11.md](PLAN_0_11.md). Hành vi khi họp do skill [`hop`](../.claude/skills/hop/SKILL.md) định nghĩa. Các bản trước nằm trong [`docs/history/`](history/): chỉ để tra lại, không còn hiệu lực.

## Sản phẩm là gì

Trợ lý họp cá nhân của owner, chạy trên máy của owner.
- **Claude trong phiên làm việc là người dùng công cụ.** Claude dùng công cụ để phục vụ owner và cuộc họp, phân tích trực tiếp, real-time.
- Công cụ là **tai và bộ ghi** của Claude. Nó không phải một dịch vụ cho người khác, không phải một phần mềm thi đấu với AI có sẵn của Zoom/Meet. Các AI đó thiếu ngữ cảnh và không linh hoạt; ở công ty owner, ai cũng có Claude.

Việc chính của trợ lý:
1. **Chuẩn bị context trước họp** từ nội dung owner gửi: mục tiêu, người dự, ngôn ngữ họ nói, vai trò, thuật ngữ, tên dễ nghe sai.
2. **Trong họp:** nghe, theo dõi, dịch thô cho người dự, trả lời owner.
3. **Sau họp:** RAW + SUMMARY + TASKS. Ghi âm, phân tích, tóm tắt là hiển nhiên.

## Quyết định đang hiệu lực (owner)

| Chủ đề | Quyết định | Nguồn |
| --- | --- | --- |
| Dự án | Cá nhân, repo riêng, độc lập AIOS | OWN-001 |
| Host | Claude Code trong Claude Desktop; chỉ Claude là AI; âm thanh/ASR là mã nguồn mở chạy trên máy | OWN-003, OWN-013, OWN-014 |
| Vòng đời | Sống theo phiên họp: không có tiến trình chờ sẵn khi không họp | OWN-021 |
| Ghi âm | Bắt đầu khi owner kích hoạt `pma start` (thời gian chờ vào phòng để nạp mô hình). Ghi tới khi owner gõ kết thúc. WAV là âm thanh thật cả buổi, **giữ tới khi người dùng tự xoá** | OWN-022, OWN-023 |
| Ưu tiên runtime | Không sót, không ngắt. Nghe real-time chỉ là hỗ trợ, được phép thiếu nhưng phải biết và báo chỗ thiếu | OWN-015, OWN-022 |
| Nghe lại | Việc của Claude: khi Claude chưa nghe rõ thì tự nghe lại từ WAV hoặc đánh dấu `[chưa nghe rõ]`. Owner đã nghe trực tiếp nên không cần nghe lại | OWN-024 |
| Hai phiên khi họp | Phiên **dịch thô** (Haiku, effort low, lô 15 s): như một người ngồi dịch, owner share phiên đó cho người dự. Phiên **tổng hợp** (Sonnet, lô 60 s): chat với owner. Không có màn hình/trang web nào khác | OWN-019, OWN-025 |
| Ngôn ngữ | Việt, Lào, Thái (nhóm Tai-Kadai). Đạt khi người nói Lào mà máy ra chữ Thái, dịch ra tiếng Việt không đổi nghĩa. Thuật ngữ phụ thuộc context trước họp; thiếu context thì ghi thô là bình thường | OWN-026 |
| Micro "Tôi" | Luôn ghi, không phụ thuộc nền tảng. Phân loại: mic bật trong họp / mic tắt (nói riêng) / không rõ | OWN-017, OWN-027 |
| Kết thúc | Khi owner gõ kết thúc trong chat. Sau này học câu chào cuối buổi | OWN-028 |
| Báo cáo | RAW + SUMMARY + TASKS sau họp, có nguồn #id | OWN-010 |
| Cách làm việc | Audit → plan → hỏi owner một lần → build. Nghiệm thu bằng buổi họp thật tiếp theo, không tự thu âm để tự kiểm mình. Opus quyết kiến trúc, Sonnet làm; tham khảo agent mạnh như hỏi người giỏi | U23 |

Các quyết định đã bị thay, vẫn ghi trong DECISION_LOG để tra:
- OWN-004/OWN-007: bảng dịch trực tiếp.
- OWN-005: audio tạm.
- OWN-008: pilot chỉ tiếng Việt.
- OWN-012: chỉ Việt–Lào.
- OWN-016: micro khi được.
- OWN-018: WAV tự xoá 7 ngày.
- OWN-002/OWN-011 (thay được bằng AGY/Codex/MCP host khác): vẫn hiệu lực nhưng **không ưu tiên**; mọi thiết kế hiện tại nhắm Claude Code.

## Kiến trúc (0.11)

```
pma start ─► host phiên (src/daemon.ts) — chỉ sống trong phiên họp
             ├─ bộ ghi (tools/recorder.py): loa + micro → WAV khúc 10 phút + timeline.jsonl; không model; tự chạy lại; sống cả khi host chết
             └─ bộ nghe (tools/audio_worker.py --follow): đọc WAV từ giây 0, đuổi kịp, nhận dạng vi/lo/th trên GPU
Claude ─► pma brief (context trước họp) · pma follow · pma translate · pma note · pma recheck · pma coverage · pma stop
```

Chi tiết và quy ước file: [PLAN_0_11.md](PLAN_0_11.md). Cách vận hành trong họp: skill `hop`.

## Ranh giới hoàn thành

- Test qua không phải là dùng được trong họp. Mỗi bản phải qua **buổi họp thật tiếp theo**.
- Phải đo được ở buổi đó: WAV liên tục cả buổi, chữ lên phiên dịch thô kịp, không phải gõ "tiếp tục", phần tiếng Lào/Thái dịch giữ nghĩa, chỗ nghe thiếu được Claude nghe lại hoặc đánh dấu.
- Kết quả buổi đó quyết định lần sửa tiếp theo.
