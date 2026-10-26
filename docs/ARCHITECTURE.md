# Kiến trúc đề xuất

Tài liệu thiết kế; các thành phần dưới đây chưa triển khai.

```text
Nguồn trên máy người dùng được phép sử dụng
  -> công cụ nghe + vùng lưu nguồn cục bộ
  -> input/context phù hợp khả năng adapter được chọn
  -> trợ lý cá nhân: Claude HOẶC AGY HOẶC Codex
  -> bản dịch text hiển thị riêng cho người dùng
                         -> phân tích riêng khi được hỏi
```

## Hợp đồng nội bộ dự kiến

Adapter cung cấp khả năng kiểm tra năng lực, mở phiên, nhận nguồn/context, trả kết quả và dừng. Kiểu dữ liệu và giao thức chỉ chốt sau khi kiểm tra client thật. Chưa khẳng định cả ba trợ lý nhận cùng loại audio hoặc hỗ trợ cùng cách kết nối.

Các trường nguồn dự kiến gồm mã lần phát ngôn, vị trí thời gian, ngôn ngữ nếu biết và tham chiếu nguồn. Kết quả cần phân biệt bản tạm, bản sửa, khoảng thiếu và nội dung phân tích. Không gộp hai lần nói giống nhau chỉ vì text trùng.

Nguồn tiếp tục được tiếp nhận độc lập khi trợ lý đang xử lý. Giới hạn lưu, độ trễ và cách báo backlog sẽ được đo và thiết kế riêng; chưa chọn queue, database hay số worker. STOP phải kết thúc công việc thuộc phiên và báo rõ nguồn/kết quả còn giữ.

## Dữ liệu và vòng đời

Mã và cấu hình ví dụ nằm trong repository này. Dữ liệu cá nhân và cấu hình thật dự kiến nằm ở `.local/`, bị Git bỏ qua; chính sách lưu/xóa cụ thể chưa triển khai. Credential thuộc kết nối cá nhân được người dùng chọn, không lấy từ AIOS.

Mỗi phiên chỉ chọn một trợ lý dịch. Đổi trợ lý là thao tác rõ ràng, không phải fallback tự động; chuyển context nào sang trợ lý mới phải minh bạch với người dùng.

MCP, CLI hoặc kết nối khác là phương án cần kiểm tra, chưa là dependency. Không có dịch vụ, cổng mạng, API key hay model được kích hoạt bởi cấu trúc dự án này.

## Quan hệ với AIOS

Hai sản phẩm triển khai và phát hành riêng. Không import package nội bộ, mount nguồn/dữ liệu, symlink, submodule, remote Git hoặc dịch vụ runtime của AIOS vào dự án này. Có thể học từ kinh nghiệm kỹ thuật và dùng thư viện phổ thông được chọn độc lập.
