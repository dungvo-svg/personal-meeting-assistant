# Lộ trình riêng

## P0 — Khởi tạo

Thư mục riêng, lịch sử Git mới, tài liệu phạm vi và bản nháp cấu hình. Chỉ kiểm tra cấu trúc; chưa có ứng dụng chạy được.

## P1 — Khảo sát trên máy cá nhân

Xác định client trợ lý và nguồn âm thanh thực tế. Kiểm chứng các khả năng được hỗ trợ bằng tài liệu và phép thử phù hợp phạm vi người dùng cho phép. Chọn cách nối trợ lý, nguồn/ASR và giao diện text; ghi riêng chi phí/quota nếu có. Không kế thừa cơ chế AIOS.

## P2 — Một lát cắt text cục bộ

Triển khai hợp đồng nguồn/context và hiển thị bằng fixture tổng hợp, sau đó một adapter được chọn. Giữ lần phát ngôn lặp, số/phủ định, bản sửa và khoảng thiếu. Chạy được độc lập khi AIOS không khả dụng.

## P3 — Tai/context độc lập

Sau khi nguồn và quyền đã rõ, triển khai nghe liên tục, vùng lưu giới hạn, backlog, STOP và giữ nguồn. Kiểm tra lúc trợ lý đang xử lý hoặc người dùng đang hỏi phân tích. Không đánh đồng fixture với device capture thực tế.

## P4 — Nghiệm thu cá nhân

Người dùng thử Việt ↔ Lào trên máy của mình. Đo đủ lời, chất lượng, độ trễ tới màn hình, backlog, phiên dài, gián đoạn và STOP. Chốt tiêu chí định lượng theo nhu cầu thật; không lấy số đo hoặc SLA của AIOS.

## P5 — Thay trợ lý và tính năng bổ sung

Thêm adapter AGY/Codex/Claude còn thiếu khi cần; kiểm tra đổi trợ lý rõ ràng và cách chuyển context. Voice hoặc chia sẻ ra cuộc họp là phạm vi sau, có thiết kế và kiểm chứng riêng.
