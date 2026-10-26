# Trợ lý họp cá nhân

Trợ lý riêng giúp một người nghe, dịch Việt ↔ Lào, hiểu ngữ cảnh và phân tích khi được hỏi trên máy đang họp. Claude là lựa chọn định hướng ban đầu; có thể thay bằng AGY hoặc Codex qua adapter riêng.

**Trạng thái: đã khởi tạo dự án; chưa triển khai ứng dụng, thu âm hoặc kết nối AI.**

## Ranh giới dự án

- Repository, lịch sử Git, mã nguồn, cấu hình, dữ liệu, credential và nghiệm thu riêng.
- Chạy trên máy cá nhân; không cần AIOS hoặc sản phẩm phiên dịch dùng chung hoạt động.
- Không dùng chung lõi dịch, runtime, event package, queue, outbox, database hay quy trình phát hành với AIOS.
- Một trợ lý được người dùng chọn cho mỗi phiên. Claude, AGY và Codex là các lựa chọn thay thế; adapter thực tế đều chưa triển khai.
- Đầu ra ưu tiên text hiển thị riêng. Phân tích là yêu cầu riêng của người dùng; voice để sau.

## Bắt đầu làm việc

1. Đọc [phạm vi](docs/PROJECT_BRIEF.md), [kiến trúc](docs/ARCHITECTURE.md) và [lộ trình](docs/ROADMAP.md).
2. Đọc [AGENTS.md](AGENTS.md); Claude có điểm vào tại [CLAUDE.md](CLAUDE.md).
3. `project.json` là khai báo dự án. `config/personal.example.json` chỉ là bản nháp cấu hình, chưa có chương trình đọc/chạy.
4. Bước phát triển tiếp theo: khảo sát đường kết nối trợ lý và nguồn âm thanh trên máy cá nhân, rồi triển khai một lát cắt text bằng dữ liệu tổng hợp. Chưa có lệnh chạy ứng dụng.

## Thư mục

| Đường dẫn | Vai trò |
| --- | --- |
| `docs/` | Phạm vi, thiết kế, kế hoạch và tiêu chí nghiệm thu riêng |
| `config/` | Ví dụ cấu hình không chứa thông tin xác thực |
| `src/` | Nơi triển khai mới; hiện chỉ có hướng dẫn |
| `handoff/` | Metadata bàn giao khởi tạo dự án |
| `.local/` | Dự kiến chứa dữ liệu cá nhân, bị Git bỏ qua |

Không nhập lại audio, transcript, output cũ hoặc credential của AIOS. Nghiệm thu của sản phẩm AIOS không đại diện cho dự án cá nhân này.
