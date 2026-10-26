# Bộ công cụ cho trợ lý AI tham gia họp

Ta xây bộ công cụ trên máy cá nhân để **AI agent chủ động hỗ trợ cuộc họp đang mở**: bật bộ tai, lấy ngữ cảnh, dịch và cập nhật bảng text cho người dùng. Claude Desktop là host đầu tiên phải dùng được; AGY hoặc Codex có thể thay thế về sau.

**Trạng thái: baseline tài liệu v0.1.0; chưa triển khai tool server, thu âm hoặc tích hợp Claude Desktop.** Các lựa chọn chủ sản phẩm đã chốt và các điểm kỹ thuật còn cần chứng minh được ghi riêng.

## Ranh giới dự án

- Repository, lịch sử Git, mã nguồn, cấu hình, dữ liệu, credential và nghiệm thu riêng.
- Chạy trên máy cá nhân; không cần AIOS hoặc sản phẩm phiên dịch dùng chung hoạt động.
- Không dùng chung lõi dịch, runtime, event package, queue, outbox, database hay quy trình phát hành với AIOS.
- Agent làm chủ quá trình chọn và gọi công cụ. Tool thực hiện thao tác và trả bằng chứng; không có backend dịch riêng tự điều phối Claude như một hàm dịch.
- V1: hỗ trợ cuộc họp đã mở, bảng dịch trực tiếp; hỏi đáp làm sau.
- Tự lưu lịch sử text trên máy; audio chỉ tạm thời. Voice và phát nội dung cho người khác nằm ở giai đoạn sau.

## Bắt đầu làm việc

1. Đọc [bản khóa sản phẩm](docs/PRODUCT_BASELINE.md) và [sổ quyết định](docs/DECISION_LOG.md).
2. Xem [cách dùng dự kiến](docs/USER_GUIDE.md), [kỹ thuật](docs/TECHNICAL_BASELINE.md) và [phép thử Claude Desktop](docs/CLAUDE_DESKTOP_FEASIBILITY.md).
3. Đọc [AGENTS.md](AGENTS.md); Claude có điểm vào tại [CLAUDE.md](CLAUDE.md).
4. Kiểm tra snapshot tài liệu bằng `python tools/verify_baseline.py`. Lệnh chỉ đọc file, không mở app hoặc gọi AI.
5. Thực hiện [lộ trình](docs/ROADMAP.md) theo [tiêu chí nghiệm thu](docs/ACCEPTANCE.md). Chưa có lệnh chạy sản phẩm.

`project.json` và `config/personal.example.json` là khai báo thiết kế, chưa có runtime đọc/chạy. [Quy tắc thay đổi baseline](docs/CHANGE_CONTROL.md) giải thích phần nào đã khóa theo ý người dùng và phần nào là quyết định kỹ thuật có thể điều chỉnh theo bằng chứng.

## Thư mục

| Đường dẫn | Vai trò |
| --- | --- |
| `docs/` | Phạm vi, thiết kế, kế hoạch và tiêu chí nghiệm thu riêng |
| `config/` | Ví dụ cấu hình không chứa thông tin xác thực |
| `src/` | Nơi triển khai mới; hiện chỉ có hướng dẫn |
| `handoff/` | Metadata bàn giao khởi tạo dự án |
| `.local/` | Dự kiến chứa dữ liệu cá nhân, bị Git bỏ qua |

Không nhập lại audio, transcript, output cũ hoặc credential của AIOS. Nghiệm thu của sản phẩm AIOS không đại diện cho dự án cá nhân này.
