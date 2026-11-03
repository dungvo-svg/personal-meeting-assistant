# Ba Claude của Dũng, Quân, Oanh trong một cuộc họp Zoom (thiết kế, 03/11/2026)

**Trạng thái:** thiết kế + mô-đun thuần (`src/cowork.ts`, Sonnet H), chưa nối vào host, chưa chạy.

Nguồn mục tiêu: owner, chuyển qua phiên điều phối. Zoom là khung họp. Claude của mỗi người nhận context và vai phù hợp, nhận việc và trả lời trong phạm vi người đó. Điểm quyết định hội tụ về phiên Dũng.

## Hai thứ khác nhau, không được lẫn

| | Vai mô phỏng trên Admin-PC | Claude thật của Quân / Oanh |
| --- | --- | --- |
| Chạy ở đâu | agent nền trên máy này, đọc `pma brief --as quan` / `--as oanh` | máy và tài khoản của chính người đó |
| Kết nối host | loopback, cùng host với phiên Dũng | **chưa có**: host chỉ nghe 127.0.0.1, không có endpoint ra ngoài |
| Đồng ý của người đó | không cần (không thay mặt ai) | **cần**: owner ghi `consentRef` và endpoint; chưa có thì `REMOTE_NOT_CONSENTED` |
| Được nói là "Claude của Quân" | **không**: luôn hiện là vai mô phỏng | chỉ khi có biên nhận kết nối thật |
| Trả lời có giá trị gì | đề xuất mang nhãn `simulated` | đề xuất của người đó, qua kênh của họ |

Hiện chỉ có cột trái. Cột phải là việc tương lai. Nó cần owner quyết về mạng, tài khoản và sự đồng ý của Quân và Oanh. Không cài, không mời, không gửi ra ngoài.

## Lát cắt dùng được ngay (trên máy này)

1. Phiên Dũng là phiên trung tâm (skill `hop`, mục 4 "Xúc tiến").
2. Owner nói vai và phạm vi trong chat. Claude ghi:
   - người dự vào context;
   - thẩm quyền bằng `pma grant` (mỗi người, mỗi phạm vi).
3. Quân và Oanh, nếu owner muốn mô phỏng, là hai agent nền. Mỗi agent:
   - đọc `pma brief --as quan|oanh`, là biên nhận context của vai đó;
   - nhận việc được giao cho đúng người đó;
   - trả lời bằng đề xuất có nguồn.
   - Không agent nào tự chốt.
4. `convergeToCentral` gom về phiên Dũng: đề xuất cần chốt, việc bị từ chối hoặc quá hạn, câu hỏi chờ người có thẩm quyền. Phiên Dũng chốt qua sổ quyết định. Thẩm quyền chỉ do owner giao.
5. Người nói không chắc vẫn là "chưa xác định". Không suy tên từ kênh, micro `Tôi`, khoảng lặng hay giọng.

## Các bước thử có kiểm soát (sau rà soát tĩnh và GO)

| # | Đầu vào | Phải thấy | Bằng chứng | Hỏng khi |
| --- | --- | --- | --- | --- |
| 1 | Owner: người dự Dũng, Quân, Oanh; vai và phạm vi | context có roster; thiếu vai của ai thì nằm trong `missing` | `pma brief --as chinh` | vai bị bịa khi owner chưa nói |
| 2 | Bật hai vai mô phỏng | `seat.kind = simulated_role`; trạng thái nói rõ là mô phỏng | trạng thái seat | hiện là "Claude của Quân" |
| 3 | Thử tạo seat `remote_claude` không có đồng ý | bị từ chối `REMOTE_NOT_CONSENTED` | lỗi trả về | được chấp nhận |
| 4 | Dũng giao việc cho Quân từ một quyết định | vai Quân thấy việc; vai Oanh không thấy | `roleView` của từng vai | Oanh thấy việc của Quân |
| 5 | Vai Quân trả lời kèm đề xuất | đề xuất nằm trong `convergeToCentral`, nhãn `simulated`, có nguồn | danh sách hội tụ | trả lời tự thành quyết định |
| 6 | Vai Oanh trả lời việc của Quân | bị từ chối | lỗi trả về | được chấp nhận |
| 7 | Dũng chốt đề xuất (người có thẩm quyền) | quyết định `decided`, việc sinh ra, kết quả/hoàn tác ghi lại | `pma decisions` | chốt bởi người không được giao |
| 8 | Một việc dài chạy nền, Dũng hỏi "đang chờ ai" | trả lời ngay từ danh sách hội tụ | thời gian trả lời so với job | phải chờ job |
| 9 | Context đổi (thêm phạm vi cho Oanh) | vai Oanh phải đọc lại brief; trả lời dựa trên bản cũ bị từ chối | `STALE_CONTEXT` | bản cũ vẫn được nhận |
| 10 | Kết thúc | `stop` trước; việc dở và đề xuất chưa chốt vào SUMMARY | kết quả `stop` | đề xuất chưa chốt thành "đã chốt" |

## Còn thiếu

- Mô-đun `cowork.ts`: nối RPC/CLI (`seat`, `assign`, `reply`, `converge`) và một mục trong skill.
- Kết nối Claude thật ở máy khác: cần endpoint, cách xác thực, sự đồng ý ghi lại, biên nhận. Không thuộc lượt này.
- Âm thanh, giọng nói, Zoom thật: ngoài phạm vi. Nghiệm thu ở buổi họp thật sau khi owner cho phép.
