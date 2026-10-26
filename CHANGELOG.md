# Changelog

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
