# Khóa và thay đổi tài liệu

## Ba nghĩa khác nhau

`OWNER_LOCKED`: quyết định người dùng đã chốt, có ID và nguồn trong DECISION_LOG. Chỉ đổi khi có chỉ dẫn mới của người dùng; không suy từ một bài nghiên cứu hoặc kết quả tool thành quyền đổi sản phẩm.

`ENGINEERING_BASELINE`: thiết kế đang dùng để triển khai. Agent có thể cải tiến theo bằng chứng trong phạm vi được giao, ghi lý do và ảnh hưởng; không cần hỏi lại cho mọi sửa kỹ thuật. Nếu ảnh hưởng owner lock hoặc thay cách dùng đã chốt thì đưa thay đổi cụ thể cho người dùng quyết định.

`OPEN`: chưa đủ bằng chứng hoặc chưa lựa chọn. Không đổi OPEN thành PASS chỉ vì protocol/library có tính năng tương tự.

## Snapshot v0.2.0

`baseline.lock.json` chứa version và SHA-256 của bộ tài liệu/cấu hình/hướng dẫn/tool kiểm tra hiện hành. `python tools/verify_baseline.py` kiểm tra nội dung đúng snapshot và version khớp project.json. Lệnh không chạy app, capture, inference hoặc mạng.

Đây là kiểm tra toàn vẹn có thể sửa theo revision, không phải chữ ký, ACL hoặc khóa bất biến. Người có quyền sửa cả file lẫn manifest có thể tạo snapshot mới; lịch sử Git và nguồn quyết định là dấu vết review. Manifest không hash chính nó để tránh vòng tham chiếu. Handoff khởi tạo cũ là lịch sử, không nằm trong snapshot hiện hành.

## Khi thay đổi

1. Đọc owner locks và baseline, kiểm tra working tree và hash trước khi sửa.
2. Ghi thay đổi cụ thể, lý do, nguồn quyền/bằng chứng, các requirement/acceptance bị ảnh hưởng trong CHANGELOG.md và DECISION_LOG nếu cần.
3. Cập nhật tài liệu có liên quan cùng lượt; không để README, config và guide nói khác nhau.
4. Tăng version baseline khi nội dung trong snapshot thay đổi; cập nhật hashes sau khi review diff. Không chỉ đổi hash để che drift chưa giải thích.
5. Chạy verifier, kiểm tra JSON/link và các kiểm chứng phù hợp loại thay đổi. Staging exact paths, commit và push đúng branch; không nhập dữ liệu cá nhân.

Việc thêm bằng chứng test/live không được sửa lại kết quả cũ; lưu receipt/version mới và cập nhật mức hoàn thành thực tế. Những giới hạn chưa đóng tiếp tục hiện trong bàn giao.
