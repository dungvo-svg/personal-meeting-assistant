# Lộ trình triển khai

Baseline v0.2.0; mỗi bước phải có sản phẩm và bằng chứng. Phạm vi gốc ưu tiên kiểm tra vòng agent. Owner bổ sung pilot chiều nay chỉ tiếng Việt, không dịch: ASR và panel chạy cục bộ, Claude đọc theo lượt khi được giao. Runtime pilot đã dựng với bằng chứng riêng trong [runbook](PILOT_RUNTIME_20261026.md); chưa đánh dấu P2/P5 đạt cho V1 phiên dịch.

| Bước | Sản phẩm công việc | Điều kiện đóng |
| --- | --- | --- |
| P0 — Khóa nền | Product/usage/technical/decision/acceptance + snapshot version | 8 owner locks được phản ánh, link/JSON/hash hợp lệ; không coi snapshot là nghiệm thu runtime |
| P1 — Lát cắt tool | TypeScript MCP local + nguồn text tổng hợp + publish lên panel + text store + STOP | Offline tool proof, sau đó FP-01 trong Claude Desktop thật |
| P2 — Chứng minh agentic | Nguồn paced, context có giới hạn, trạng thái chờ, turn boundary và host disconnect | FP-02/03; nếu thiếu tự vận hành phải ghi giới hạn và xử lý lựa chọn host/workflow trước khi mở rộng |
| P3 — Tai/context thật | Chọn source/ASR hoặc audio trực tiếp, capture worker, temp lifecycle và profile hữu hạn | FP-04/05; bằng chứng source/cleanup và phạm vi dữ liệu rõ |
| P4 — Bảng dịch V1 | Luồng người dùng hoàn chỉnh, lịch sử/correction, lưu text, trạng thái lỗi và dừng | AT-01…AT-09 theo mức cần thiết; không để fixture thay human QA |
| P5 — Dùng thực | Phiên cá nhân Việt/Lào, chất lượng, latency, backlog và thời lượng đã chốt | AT-10/Human UAT; ghi nhận giới hạn và lỗi còn lại |

Sau V1: hỏi đáp/phân tích theo context, công cụ hỗ trợ bổ sung, host AGY/Codex và voice. Mỗi phần có phạm vi riêng; không tự thêm vào V1 vì mục tiêu dài hạn hỗ trợ tối đa.

## Gói triển khai tiếp theo

P1 bắt đầu bằng schema tools và fixtures tổng hợp, không cần nguồn cuộc họp thật. Pin runtime/SDK sau khi đọc phiên bản hiện hành, triển khai tool server tối thiểu, panel cục bộ và phép thử source/read/publish/idempotency/stop. Các thay đổi cài vào host hoặc thử bằng tài khoản thật phải có phạm vi rõ trong nhiệm vụ tích hợp; tài liệu baseline hiện tại không chứng minh đã thực hiện những bước đó.
