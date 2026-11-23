# Kế hoạch cải tiến PMA sau ba buổi họp 23/11/2026

Trạng thái (23/11 tối): **đã code đủ 11 việc trên nhánh `pma/0.13-tich-hop` (0.13.0–0.13.3), test xanh; chưa gộp vào nhánh chính, chưa cài, chưa nghiệm thu ở họp thật.** Bản đang chạy trên máy vẫn là `pma` 0.12.8. Việc còn mở: issue #8 (4 dòng Lào/Thái lọt micro), #9 (`transcribe` chưa nhường GPU), #10 (bản Lào OTC chưa ra ba con số %). Hotwords của việc 8 tắt mặc định vì đo thấy bịa tên. Nghiệm thu ở họp thật tiếp theo, không tự thu âm để thử.

## Bằng chứng

Ba buổi họp trên Google Meet ngày 23/11:

| Buổi | Giờ | Ngôn ngữ | Điều rút ra chính |
| --- | --- | --- | --- |
| OTC | 08:11–08:55 | Lào + Việt | Lời Lào bị ghi thành chữ Việt vô nghĩa và mất số liệu; bức tranh không lũy tiến; lần lưu bức tranh cuối thất bại mà không báo |
| Họp thầu BV | 09:04–09:38 | Chủ yếu Việt | Việc recheck của buổi trước chiếm GPU; màn hình chia sẻ bị che; phải đoán người nói theo giọng |
| Làm việc theo dự án & phụ cấp | 14:05–14:29 | Chủ yếu Việt | Tiếng loa lọt vào micro "Tôi (mic tắt)" khoảng 10 lần; đoạn "tiếng Lào" 14:12–14:14 nghe lại hóa ra là chào hỏi; chưa biết mục đích họp nên đưa nhầm việc làm mẫu vào TASKS |

Nguồn đối chiếu:
- **PMA:** RAW, bức tranh, SUMMARY và TASKS của từng buổi (trên máy, `.local/runtime/reports/`).
- **Bot Claude trong phòng Meet:** có tên người nói, nhưng ghi tiếng Lào bằng chữ Thái.
- **Gemini:** phụ đề trong Meet, cộng thêm file thoại lúc 09:02. Chỉ dùng để đối chiếu, không dùng làm AI của công cụ.

## Nguyên tắc thiết kế (anh Dũng, chiều 23/11)

1. **Hai lớp khác nhau, đừng gộp.**
   - **Lớp nghe theo thời gian.** Các bộ giải mã chạy song song. Lời Lào–Việt xen nhau như những "điểm rơi": máy luôn ra một bản phiên âm, có lúc đúng, có lúc sai so với lời gốc. Lớp này giữ mọi bản phiên âm, không ép chọn sớm.
   - **Lớp tổng hợp.** Đọc mọi bản phiên âm cùng context, rồi dịch lại vào **đúng ô, đúng ngữ cảnh** (đang bàn, số liệu, đã chốt, việc–người–hạn).
2. **Danh từ riêng, tên người, biệt danh phụ thuộc context họp.** Bảng tên phải gồm người dự, **người được nhắc tên mà không dự họp**, và biệt danh (ví dụ Ta = chị Tar; Linh Lin = anh Quân).
3. **Bức tranh phải lũy tiến.** Mỗi lần cập nhật cộng thêm vào phần đã có, không chỉ phản ánh lô vừa nghe.
4. **Mục đích họp dẫn đường cho suy luận.** Họp thông báo hay hướng dẫn khác họp giao việc. Chỗ nghe không rõ được suy luận theo mục đích đó.
5. **Chức năng chính là tổng hợp đúng ngữ cảnh và xúc tiến theo nội dung họp.** Ghi âm và dịch thô là phần nền. Độ trễ hiện tại (35–45 giây) chấp nhận được; ưu tiên độ đúng.

## Danh sách việc

| # | Vấn đề và bằng chứng | Cải tiến | Cỡ | Nghiệm thu |
| --- | --- | --- | --- | --- |
| 1a | **Lời Lào bị ghi thành chữ Việt vô nghĩa** (OTC 08:51–08:53: "mục nông", "SBM lên được 3 năm"; mất ba con số % theo kênh). | **Lớp nghe:** mỗi mẩu chạy cả turbo-vi và BuzzASR-lo. Giữ cả hai bản ở mỗi điểm rơi, kèm điểm: điểm mô hình, tỷ lệ âm tiết Việt có nghĩa, phạt vòng lặp. Không ép chọn. | Lớn | Phát lại WAV OTC 08:49–08:54: bản Lào chứa đủ ba con số % và "ngày 1, kế hoạch năm sau". Tiếng Việt họp thầu không tụt so với RAW cũ |
| 1b | Lớp tổng hợp chỉ đọc một bản phiên âm. | **Lớp tổng hợp:** khi bản Việt vô nghĩa thì đọc bản Lào, dựa vào màn hình và bảng tên để đặt vào đúng ô. Ví dụ đã có: "La kha Vê nừng" = ລາຄາ P1 (giá P1); "Hàn khải nhốt" = ຮ້ານຂາຍຍ່ອຍ (cửa hàng bán lẻ). | Vừa | Bức tranh OTC dựng lại từ bộ thử có đủ các số và tên ở đúng ô |
| 2 | **Chưa bắt đúng người nói.** Âm thanh phòng Meet vào một kênh chung, PMA chỉ tách "Tôi" (micro) với "phòng" (loa). Buổi OTC: ngoài Dũng, không đoạn nào có tên. Tiếng loa lọt vào micro bị gán "Tôi (mic tắt)": OTC #5978, #6151; họp thầu #6628, #6642, #6663; họp 14:00 khoảng 10 lần (#6772, #6857, #6864, #6945, #6951…). Họp thầu phải đoán người nói, có tên "chưa chắc". | (1) **Chặn tiếng loa lọt micro:** so đoạn micro với đoạn loa cùng giờ; trùng chữ hoặc tương quan âm cao thì bỏ nhãn "Tôi". (2) **Ghép tên người nói từ bot Claude** qua connector meetings (`get_meeting_transcript` / `follow_meeting_transcript`). Ghép theo giờ: tên lấy từ bot, chữ lấy từ PMA. | Vừa | Phát lại buổi 14:00: không còn dòng "Tôi (mic tắt)" trùng với loa. RAW OTC có `[Sơn Nguyễn]` lúc 08:48:28 và `[Khounkham]` lúc 08:49:03 |
| 3 | **Không thấy màn hình chia sẻ trên Meet.** Họp thầu từ 09:10: ô trình bày bị khung "Mọi người" che, ảnh chụp trống. Họp 14:00: anh Quân chiếu app 14:09–14:20, không có ảnh nào. | **`pma screen` chế độ Meet:** tìm cửa sổ "Meet - …"; đọc UIA tên người trình bày và viền người đang nói; chụp khung khi ảnh đổi. Báo `MÀN HÌNH ẨN` khi vùng trình bày trống. | Vừa | Họp Meet tới có sự kiện share_start/stop đúng người và ảnh đọc được |
| 4 | **Việc nặng tranh GPU với họp mới.** Recheck của buổi OTC vẫn chạy khi mở họp thầu, chữ trễ 47 giây, phải dừng tay. | Khi `pma start`/`listen`: host tự dừng các recheck/transcribe do chính nó chạy cho phiên khác, ghi vào `unfinished`, chạy tiếp sau `stop`. | Nhỏ | Test giả qua điểm chèn, không đụng PID thật |
| 5 | **Lệnh lưu im lặng khi lỗi.** `pma picture --base 26` không in gì, bản 26 vẫn là bản cũ. `--sources` thiếu thì chỉ báo "Too small". | Mọi lệnh lưu phải in biên nhận hoặc lỗi rõ (ví dụ "cần ít nhất một #id có chữ thật"). | Nhỏ | Test CLI |
| 6 | **`participants` từ chối role rỗng** (BAD_LENGTH). | Cho phép bỏ trống role. | Nhỏ | Test |
| 7 | **Bộ dịch nền mất lô cuối.** Agent nền lưu bị `NO_OPEN_SESSION`, 14 dòng #6338–#6394 không có bản dịch. | `translate` nhận phiên vừa đóng trong khoảng ân hạn (ví dụ 10 phút). | Nhỏ | Test |
| 8 | **Nghe sai tên và từ khóa.** "Dũng nghiên cứu" thành "dùng nghiên cứu" (mất người được giao); Claude thành "crowd / Cloudy / groundy"; "Mittaphab" thành "mít ta pháp"; OKR thành "OKA"; Vimart thành "VMAT"; "file/folder" thành "phim/founder". | **Bảng tên theo context:** người dự, người được nhắc mà không dự, biệt danh, tên hệ thống. Nguồn: context trước họp, danh bạ theo kênh OTC/HC/SPM, tên đã gặp ở các buổi trước. Đưa vào gợi ý cho bộ nghe (hotwords); sửa sau theo bảng, có cờ `(sửa theo bảng tên)`; tên chưa chắc ghi "(nghe: …)". | Nhỏ–vừa | Phát lại #6327, #6409, #6858: ra đúng "Dũng", "Claude" |
| 9 | **Độ trễ** khoảng 25–30 giây tới chữ Lào, 35–45 giây tới bản Việt dùng được. | Giữ mức hiện tại, ưu tiên độ đúng. Tùy chọn giảm lô phiên trung tâm xuống 15–20 giây khi chiếu cửa sổ Claude cho cả phòng. | Nhỏ | Đo lại ở họp tới |
| 10 | **Bức tranh không lũy tiến.** OTC bản 12 có doanh số từng người, đến bản 26 chỉ còn số tổng. Phần thưởng năm 08:49–08:53 không vào bức tranh vì lần lưu cuối thất bại. | Tách bức tranh hai phần. **Phần cộng dồn** (đã chốt, việc–người–hạn, số liệu, câu hỏi mở): chỉ thêm vào, chỉ sửa khi có đính chính và ghi "đã sửa: cũ → mới". **Phần đang bàn:** thay theo lô. Host giữ phần cộng dồn để phiên trung tâm không phải viết lại toàn bộ mỗi lô. | Vừa | Bản bức tranh cuối của buổi tới chứa đủ mọi quyết định và việc có trong SUMMARY |
| 11 | **Không biết mục đích họp nên suy luận sai.** Họp 14:00: hai việc thầu anh Quân đẩy lên app khi làm mẫu bị đưa vào TASKS và hỏi lại người nhận. Đoạn chào hỏi 14:12–14:14 bị tưởng là phần giải thích bằng tiếng Lào. | `pma start --purpose` (thông báo / hướng dẫn / giao việc / bàn quyết định). `brief` in mục đích ở dòng đầu; bức tranh và SUMMARY có mục "Mục đích họp". Họp thông báo hoặc hướng dẫn: việc, tên, số nêu khi làm mẫu là ví dụ, không vào TASKS. Chỉ hỏi người dùng chỗ chưa rõ còn ảnh hưởng tới mục đích họp. | Nhỏ | Họp thông báo tới: TASKS không có việc làm mẫu; câu hỏi sau họp chỉ về chỗ liên quan mục đích |

## Thứ tự làm

1. **Đợt 1 – gỡ lỗi vận hành (nhỏ):** 4, 5, 6, 7, 11.
2. **Đợt 2 – nội dung đúng:** 10 (bức tranh lũy tiến), 2 (chặn loa lọt micro, ghép tên người nói từ bot Claude).
3. **Đợt 3 – Lào/Việt:** 1a rồi 1b. Đây là việc lớn nhất; cần bộ thử từ WAV OTC 23/11 và 21/11.
4. **Đợt 4:** 8 (bảng tên mở rộng), 3 (màn hình Meet), 9 (đo lại độ trễ).

Mỗi đợt là một bản phát hành có ghi trong CHANGELOG và DECISION_LOG. Chỉ làm khi anh Dũng cho bắt đầu.

## So với Gemini (đối chiếu buổi OTC)

- Gemini đọc bản dịch tiếng Việt ra tiếng, cho ý chính nhanh. Đoạn 08:43–08:46 Gemini nói "mua 30 tặng 1 … giá khác …", trong khi PMA chỉ có "30 ແທ້ມ" và chữ Việt vô nghĩa.
- Gemini không giữ được số chắc chắn, không ghi người nói, không có bản ghi để kiểm. Phụ đề Gemini để nguyên chữ Thái, không dịch lời chị Tar.
- Hướng làm: chỉ dùng Gemini để đối chiếu sau họp, không thay PMA. Công cụ chỉ dùng Claude làm AI.
