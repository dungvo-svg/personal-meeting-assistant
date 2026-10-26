# Phạm vi dự án cá nhân

Ngày khởi tạo: 26/10/2026.

## Mục đích

Giúp một người đang họp nghe và đọc bản dịch Việt ↔ Lào trên máy của mình, giữ ngữ cảnh và hỏi trợ lý để hiểu hoặc phân tích thêm. Bản dịch giữ lời được nói, cả lặp lại và sửa lời; phần phân tích được trình bày riêng khi người dùng yêu cầu.

Claude là lựa chọn ban đầu về sản phẩm. AGY hoặc Codex có thể thay thế theo lựa chọn người dùng. Việc có tài khoản trợ lý không tự chứng minh khả năng nghe liên tục, đọc audio, dùng MCP hay đáp ứng thời gian thực; mỗi adapter cần khảo sát và kiểm tra thực tế.

## Quyết định đã có

- Dự án, thư mục và Git repository riêng bên cạnh dự án AIOS hiện hữu.
- Trợ lý cá nhân hoạt động trên máy người họp, độc lập AIOS.
- Bộ tai và context là công cụ phụ trợ trợ lý; không tái sử dụng engine dịch dùng chung.
- Không chia sẻ lõi, runtime, queue, dữ liệu, credential hoặc release với AIOS.
- Text hiển thị cá nhân trước; chức năng nói phát triển sau.
- Nghiệm thu cá nhân riêng, chưa có kết quả tích hợp hoặc Human UAT.

## Phạm vi lần khởi tạo

Tạo cấu trúc tài liệu, bản nháp cấu hình, hướng dẫn agent và repository độc lập. Chưa chọn ngôn ngữ/framework triển khai, nguồn capture/ASR hoặc giao thức adapter. Không sao chép mã/runtime/dữ liệu phiên họp từ repo cũ.

## Cần xác minh trước khi tích hợp

1. Client trợ lý thực tế người dùng muốn dùng và đường kết nối được client đó hỗ trợ.
2. Hệ điều hành, thiết bị/nguồn âm thanh cuộc họp và quyền thu nguồn đó.
3. Trợ lý nhận audio trực tiếp hay cần ASR riêng; chất lượng Lào/Việt của đường được chọn.
4. Vòng lặp nguồn, buffer, STOP, giới hạn quota/context và nhu cầu hiển thị text.

Đây là công việc của bước khảo sát tiếp theo, không phải lý do trì hoãn việc tạo repository.
