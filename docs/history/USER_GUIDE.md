# Cách dùng V1 — hợp đồng trải nghiệm

Baseline v0.2.0. Hướng dẫn thao tác runtime pilot tiếng Việt hiện có ở [PILOT_RUNTIME_20261026.md](PILOT_RUNTIME_20261026.md). Phần dưới mô tả trải nghiệm V1 phiên dịch mục tiêu, chưa được nghiệm thu. Các câu lệnh bên dưới là ví dụ người dùng nói với agent sau khi tích hợp hoàn tất.

## Lần đầu

Cài bộ tools vào đúng Claude Desktop đang dùng, kiểm tra tool xuất hiện và mở được bảng cá nhân. Người dùng chọn nơi lưu text và nguồn âm thanh được phép. Phần thiết lập cho biết nội dung nào được đưa tới trợ lý/ASR đã chọn; chạy trên máy cá nhân không đồng nghĩa toàn bộ suy luận offline.

Các giá trị chưa được xác minh như đường audio, quota hoặc khả năng duy trì vòng tools phải hiển thị là chưa sẵn sàng, không cho thấy trạng thái “đang dịch” chỉ vì extension đã kết nối.

## Giao phiên cho agent

Ví dụ: “Hỗ trợ cuộc họp đang mở này. Nghe nguồn âm thanh tôi đã chọn, dịch Việt–Lào lên bảng riêng. Giữ nguyên câu lặp, lưu lịch sử text trên máy và dừng khi tôi kết thúc.”

Agent kiểm tra tools, phiên và nguồn hiện tại, lấy context đã được người dùng cung cấp, chuẩn bị bảng và bật tai trong phạm vi được giao. Nếu nguồn/đích ngôn ngữ còn mơ hồ, hỏi một lần để chọn đúng. Nếu host cần xác nhận quyền công cụ thì dùng cơ chế được host hỗ trợ; không yêu cầu xác nhận lại cho từng đoạn trong cùng phạm vi đã cấp.

Agent không cần mở lời mời hay Join. Người dùng đang ở trong cuộc họp bằng ứng dụng họp của mình. Bảng riêng phục vụ người dùng đó.

## Trong cuộc họp

Bảng có vùng bản dịch đang tới, lịch sử có mốc thời gian và trạng thái nguồn/agent. Bản tạm có nhãn; khi sửa, bản mới thay cách hiển thị của cùng lần phát ngôn và lịch sử vẫn cho biết đã sửa. Câu được nói lại thật xuất hiện thành lần mới.

Agent nhận phần nguồn mới qua tools, dùng ngữ cảnh để dịch và gọi tool công bố text. Bộ tai tiếp tục tiếp nhận trong lúc agent suy luận, trong giới hạn bộ nhớ/đĩa đã cấu hình. Agent kiểm tra backlog và lỗi để tiếp tục hoặc báo cần hỗ trợ. Người dùng không phải gửi lại từng đoạn audio/text.

V1 không có ô hỏi đáp/phân tích. Ngữ cảnh vẫn phục vụ bản dịch: tên người, chủ đề và glossary đã cung cấp. Muốn làm hỏi đáp sẽ mở phạm vi giai đoạn sau.

| Tình trạng thực tế | Bảng phải cho biết | Hành vi |
| --- | --- | --- |
| Có nguồn, agent đang xử lý | Đang nghe / đang dịch; thời điểm kết quả mới nhất | Tiếp tục trong scope |
| Không nhận được nguồn | Chưa có âm thanh hoặc mất nguồn, theo bằng chứng | Kiểm tra nguồn; không tạo bản dịch để lấp chỗ trống |
| Có nguồn nhưng text cũ dần | Đang chờ trợ lý / chậm so với cuộc họp | Hiện backlog và cách tiếp tục; không báo live bình thường |
| Host yêu cầu người dùng tiếp tục | Cần tiếp tục trong Claude | Giữ dữ liệu còn trong hạn; trạng thái này chưa đạt tự vận hành V1 |
| Hết dung lượng/giới hạn | Đã tạm dừng nghe vì giới hạn | Giữ text, ghi khoảng gián đoạn, không âm thầm bỏ nguồn |
| Người dùng tạm dừng nghe | Đã tạm dừng nguồn | Không nhận nguồn mới; kết quả của nguồn đã nhận có thể hoàn tất |

## Kết thúc và dừng ngay

“Kết thúc phiên” dừng nguồn mới trước, hoàn tất phần đang xử lý trong thời gian kết thúc đã cấu hình, lưu text và ghi rõ phần còn thiếu nếu không hoàn tất. Sau đó đóng quyền của phiên và thu dọn audio tạm. Không giữ phiên vô hạn để đợi model.

“Dừng ngay” hoặc nút dừng cục bộ dừng nguồn và ngăn công bố mới ngay; text đã lưu được giữ. Tool phải thực hiện được việc này khi agent bận, không phản hồi hoặc Claude Desktop bị đóng. Kết quả đến muộn không được nhập vào phiên đã kết thúc.

Mở lại ứng dụng chỉ cho xem lịch sử và tình trạng dọn dữ liệu. Không tự bật tai hoặc khởi động lại một phiên cũ.

## Sau cuộc họp

Text của phiên được tự lưu: bản nguồn dạng text nếu thực sự có, bản dịch và lịch sử sửa, mốc thời gian, trạng thái thiếu/chưa xử lý. Audio cục bộ chỉ tạm và phải được thu dọn khi hết phiên; thông báo kết quả dọn phải phản ánh lỗi nếu có. Sau khi audio bị xóa, không hứa nghe lại hay tái kiểm chứng ngữ âm từ lịch sử text.

Người dùng có thể xem hoặc chủ động xóa text đã lưu. Xuất/chia sẻ cho người khác và chính sách tự xóa text theo số ngày là các lựa chọn chưa đưa vào V1. Xóa audio cục bộ không phải bằng chứng xóa bản dữ liệu đã được host/provider xử lý theo chính sách riêng.
