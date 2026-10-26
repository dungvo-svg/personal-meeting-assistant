# Phạm vi dự án cá nhân

Bản hiện hành: [PRODUCT_BASELINE.md](PRODUCT_BASELINE.md), v0.1.0 ngày 26/10/2026. File này là bản tóm tắt, không tạo thêm quyết định ngoài baseline.

Xây bộ tools để trợ lý AI chủ động hỗ trợ cuộc họp đang mở trên máy người dùng: tự bật tai trong scope được giao, lấy context, dịch Việt ↔ Lào và cập nhật bảng riêng. Claude Desktop là host đầu tiên; AGY/Codex là các lựa chọn thay thế sau.

V1 chỉ bảng dịch trực tiếp, chưa hỏi đáp. Text tự lưu cục bộ; audio tạm. Agent làm chủ workflow; tools thực hiện thao tác, giữ bằng chứng nguồn, quản lý tài nguyên và STOP. Repository/runtime/dữ liệu/credential/nghiệm thu độc lập AIOS.

Đã khóa quyết định người dùng trong [DECISION_LOG.md](DECISION_LOG.md). Kiến trúc và hợp đồng tool ở [TECHNICAL_BASELINE.md](TECHNICAL_BASELINE.md). Local MCP là đường đầu tiên cần chứng minh; vòng agent liên tục, nguồn audio/ASR, profile giới hạn và chỉ tiêu latency còn cần phép thử.

Hiện có tài liệu và kiểm tra snapshot. Chưa có tool server, extension, capture, model integration hoặc Human UAT. Không dùng trạng thái tài liệu để suy ra trạng thái sản phẩm.
