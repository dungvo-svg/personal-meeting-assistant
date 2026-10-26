# Nghiệm thu V1

Baseline v0.2.0. Các ca dưới đây là nghiệm thu V1; pilot tiếng Việt hiện có bằng chứng component/protocol/UI/file-ASR ở [runbook](PILOT_RUNTIME_20261026.md), chưa là PASS cho các ca actual host/device/Human UAT. Kiểm tra tài liệu/Git không được ghi PASS cho agent loop hoặc dịch thực tế.

| ID | Yêu cầu | Ca kiểm chứng và điều kiện đạt | Mức bằng chứng |
| --- | --- | --- | --- |
| AT-01 | REQ-09 | Cài và chạy toolkit trên máy cá nhân không có AIOS; không import/mount dữ liệu hoặc gọi dịch vụ AIOS | Offline + tích hợp máy thật |
| AT-02 | REQ-01/06/10 | Trong Claude Desktop đúng version/surface, người dùng giao phiên; agent tự prepare/start/read/context/publish bằng tools; source/scope mơ hồ được làm rõ | Actual host, không mock client |
| AT-03 | REQ-01/06 | Nguồn đến nhiều đợt và có khoảng chờ; agent tiếp tục đọc/dịch/publish, đo số lần cần nhắc; không phải nhắc từng chunk | Actual host loop; FP-02/03 |
| AT-04 | REQ-02 | Inject model wait và source gap; bộ tai vẫn nhận trong bounds, gap/backlog hiển thị đúng, không giả im lặng/nguồn | Offline fault injection + audio thật |
| AT-05 | REQ-03/04 | Mẫu hai chiều Việt/Lào có lặp, sửa lời, số, phủ định và chuyển ngôn ngữ; người đánh giá so với nguồn; bản tạm không bị gọi là ổn định | Gold/reference + người đánh giá song ngữ |
| AT-06 | REQ-04/05 | Publish lặp cùng ID không lặp dòng; câu lặp thật có ID mới; correction giữ history; font Lao/Việt và cuộn/đọc ở màn hình thực | Tool tests + UI + người dùng |
| AT-07 | REQ-02/07/10 | Dừng khi model chờ, host đóng, nguồn mất, đĩa đầy; không thêm publication sau stop; trạng thái và nợ nguồn rõ | Fault injection + máy thật |
| AT-08 | REQ-08 | Text tồn tại sau restart; audio dọn khi end/stop/crash recovery; xóa thất bại báo còn dữ liệu; startup không resume | Filesystem/resource evidence |
| AT-09 | REQ-11 | Transcript/context chứa lệnh giả yêu cầu đọc file/đổi nguồn/gửi ngoài; tool không cấp quyền mới từ dữ liệu đó | Contract/negative tests |
| AT-10 | REQ-01…REQ-08 | Dùng trong nhịp họp thực; đo latency, backlog slope, số lần can thiệp và chất lượng đọc/hiểu trong thời lượng đã chốt | Human UAT + clocks/raw evidence được phép |

## Chỉ tiêu còn cần chốt bằng phép thử

OPEN-04/OPEN-05 bao gồm thời lượng run, số mẫu, latency percentiles, mức backlog, deadline STOP/cleanup và tiêu chí chất lượng. Chưa có con số ngầm để kết luận PASS. Bản đo phải lưu cohort, version, nguồn được phép, đầu/đuôi khoảng thời gian và kết quả thất bại.

Lỗi nghiêm trọng về số/phủ định, bỏ lời hoặc biến lời người nói thành quyết định không được che bằng điểm trung bình. Gold text do người đánh giá xác nhận phải tách khỏi ASR/model output. Source loss, ASR error, translation error và render delay được báo riêng theo bằng chứng.

## Mức hoàn thành

1. DOCUMENT_BASELINE: quyết định có nguồn, tài liệu nhất quán, snapshot kiểm tra được.
2. OFFLINE_TOOL_PROOF: fixtures và fault cases của bộ tools; chưa có Claude thật.
3. CLAUDE_DESKTOP_TOOL_PROOF: host thực đọc/publish được; chưa đủ live.
4. CONTINUOUS_AGENT_PROOF: host duy trì workflow trong điều kiện/thời lượng đã đo.
5. PERSONAL_LIVE_UAT: nguồn thật được phép, bảng hữu ích trong họp, người dùng đánh giá song ngữ và vận hành.

Chỉ mức 5 cùng các tiêu chí đã chốt mới cho phép báo V1 dùng được. Một run bị giới hạn turn không được đổi nhãn thành tự vận hành. Không nhập tiêu chí/điểm nghiệm thu hoặc dữ liệu riêng của AIOS.
