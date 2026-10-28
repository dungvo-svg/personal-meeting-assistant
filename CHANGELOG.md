# Changelog

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
