# Baseline sản phẩm v0.12.0

Ngày 01/11/2026. **Đây là nơi chốt sản phẩm hiện hành.** Quyết định có nguồn ở [DECISION_LOG.md](DECISION_LOG.md). Kế hoạch triển khai ở [PLAN_0_11.md](PLAN_0_11.md) (kiến trúc 0.11) và [PLAN_0_12.md](PLAN_0_12.md) (chia sẻ mic, gỡ panel, độ tin cậy follow). Hành vi khi họp do skill [`hop`](../.claude/skills/hop/SKILL.md) định nghĩa. Các bản trước nằm trong [`docs/history/`](history/): chỉ để tra lại, không còn hiệu lực.

## Sản phẩm là gì

Trợ lý họp cá nhân của owner, chạy trên máy của owner.
- **Claude trong phiên làm việc là người dùng công cụ.** Claude dùng công cụ để phục vụ owner và cuộc họp, phân tích trực tiếp, real-time.
- Công cụ là **tai và bộ ghi** của Claude. Nó không phải một dịch vụ cho người khác, không phải một phần mềm thi đấu với AI có sẵn của Zoom/Meet. Các AI đó thiếu ngữ cảnh và không linh hoạt; ở công ty owner, ai cũng có Claude.

Việc chính của trợ lý:
1. **Chuẩn bị context trước họp** từ nội dung owner gửi: mục tiêu, người dự, ngôn ngữ họ nói, vai trò, thuật ngữ, tên dễ nghe sai.
2. **Trong họp:** nghe, theo dõi, xúc tiến cuộc họp và trả lời owner trong một phiên trung tâm; dịch thô Lào/Thái chạy nền khi được bật.
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
| Phiên khi họp | Một **phiên trung tâm** (`/hop`, Sonnet, lô 60 s): xúc tiến cuộc họp, giữ bức tranh cả buổi, trả lời owner. **Dịch thô** (vai `dich`, Haiku, lô 15 s) tuỳ chọn, chạy nền như agent, không mở phiên chat; bản dịch lưu lại và đọc khi được hỏi. Phân tích dài cũng chạy nền. Không có màn hình/trang web nào | OWN-019, OWN-025 (thay một phần), OWN-031 |
| Ngôn ngữ | Việt, Lào, Thái (nhóm Tai-Kadai). Đạt khi người nói Lào mà máy ra chữ Thái, dịch ra tiếng Việt không đổi nghĩa. Thuật ngữ phụ thuộc context trước họp; thiếu context thì ghi thô là bình thường | OWN-026 |
| Micro "Tôi" | Luôn ghi, không phụ thuộc nền tảng. Phân loại: mic bật trong họp / mic tắt (nói riêng) / không rõ | OWN-017, OWN-027 |
| Chia sẻ lời "Tôi" | Lời khi **mic tắt** hoặc **không rõ** không bao giờ tới vai dịch (không chữ gốc, không phương án, không bản dịch). Tiếng loa của người dự vẫn được dịch. WAV/RAW không đổi | OWN-030 |
| Bức tranh cuộc họp | Phiên tổng hợp giữ bức tranh **cả** cuộc họp, viết lại sau mỗi lô (`pma picture`), không chỉ tóm khung 60 s. Owner chỉ gõ `/hop` | OWN-029 |
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
- OWN-002/OWN-011 (thay được bằng host khác qua MCP): **đã bỏ** 11/11 (OWN-035). Công cụ chỉ có một mặt: CLI `pma` + kỹ năng `hop` chỉ đường tới `pma guide`. Bộ MCP cuối cùng ở thẻ `archive/mcp-adapter-0.12.1`.

## Kiến trúc (0.12)

```
pma start ─► host phiên (src/daemon.ts) — chỉ sống trong phiên họp
             ├─ bộ ghi (tools/recorder.py): loa + micro → WAV khúc 10 phút + timeline.jsonl; không model; tự chạy lại; sống cả khi host chết
             └─ bộ nghe (tools/audio_worker.py --follow): đọc WAV từ giây 0, đuổi kịp, nhận dạng vi/lo/th trên GPU
Claude ─► pma brief (context trước họp) · pma follow · pma translate · pma picture · pma say · pma recheck · pma coverage · pma stop
          (CLI ─► /rpc loopback có token; không còn trang web nào. Host lọc dòng cho vai dịch trước khi giao)
```

Chi tiết và quy ước file: [PLAN_0_11.md](PLAN_0_11.md). Cách vận hành trong họp: skill `hop`.

## Ranh giới hoàn thành

- Test qua không phải là dùng được trong họp. Mỗi bản phải qua **buổi họp thật tiếp theo**.
- Phải đo được ở buổi đó: WAV liên tục cả buổi, chữ lên phiên trung tâm kịp, dịch nền (nếu bật) theo kịp, không phải gõ "tiếp tục", phần tiếng Lào/Thái dịch giữ nghĩa, chỗ nghe thiếu được Claude nghe lại hoặc đánh dấu, **không có lời mic tắt/không rõ trong bản dịch** trong khi tiếng loa vẫn được dịch.
- Ghi trạng thái từng phần riêng: implemented / tested / integrated / released / used. Test xanh không phải "used".
- Kết quả buổi đó quyết định lần sửa tiếp theo.
