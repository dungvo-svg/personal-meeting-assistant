# Ngoại lệ khi họp (0.12.1, 03/11/2026)

Nguồn: owner 03/11 10:35 (giờ VN), chuyển qua phiên điều phối PMA: "hỏi/điều chỉnh khi cần → ví dụ tôi k trả lời thì sao → … toàn bộ độ phức tạp ngoại lệ, có thể là tư duy ngược tình huống".

**Trạng thái:** bảng thiết kế. Cột "Có ở mã/test" nói phần nào đã có trong `pma/v5-cursor`; phần ghi **chưa** là việc còn lại, không phải đã làm.

## Nguyên tắc

1. **Im lặng không phải đồng ý.** Owner không trả lời thì:
   - việc an toàn, độc lập vẫn chạy: ghi âm đã được bật, nghe, giữ bức tranh, nghe lại;
   - điều chưa chốt được ghi lại kèm nguồn (`#id`, giờ, "chưa xác nhận");
   - chỉ dừng đúng việc cần quyền hoặc quyết định nghiệp vụ.
2. **Không tự chốt thay owner.** Không đoán người được giao, hạn, giá, quyết định. Không tự bật dịch, không tự tắt tiến trình của phiên khác, không ghi âm thêm sau khi kết thúc.
3. **Nhắc một lần, có hạn.** Câu hỏi chờ owner được nhắc tối đa một lần sau 10 phút, rồi đưa vào mục "Câu hỏi mở" của bức tranh và SUMMARY. Không hỏi lại mỗi lô.
4. **Mỗi ngoại lệ để lại bằng chứng bền**: một dòng hoặc cờ trong RAW, một mục trong bức tranh, hoặc trạng thái trong `pma status`. Không chỉ nói trong chat.

## Tư duy ngược: những kết cục phải tránh

| Kết cục xấu | Chặn bằng |
| --- | --- |
| Ghi âm mà không ai biết | Chỉ ghi sau khi owner chọn nguồn (`select`); `status` luôn nói `recorder.state`; một máy một host (`RUNTIME_BUSY`, ENG-36) |
| Quyết định sai (tự chốt) | Bức tranh tách "đã chốt" với "đang bàn"; owner/hạn chỉ khi được nói rõ; câu hỏi mở không tự đóng |
| Mất context hoặc mất nguồn | WAV cả buổi; `committed` theo vai (ENG-38); bức tranh lưu theo bản; phiên mới nối mạch bằng `brief` + `picture` |
| Trùng việc, trùng ghi âm | Khoá máy (ENG-36); lease một tiến trình mỗi vai; `picture`/`translate` lưu lại cùng nội dung không tạo bản mới |
| Kẹt vì chờ owner | Việc độc lập không chờ; chỉ việc phụ thuộc dừng (nguyên tắc 1) |
| Lộ lời mic riêng | OWN-030 ở host; mốc thời gian không tin được thì mất `MIC_SHARE_OK` (ENG-39) |
| Gán sai người phụ trách | `Tôi` là kênh micro, không phải danh tính; không gán người từ khoảng lặng, khúc ghi hay kênh |

## Bảng ngoại lệ

| Tình huống | Trạng thái nhận ra | Việc an toàn làm ngay | Giả định đảo được / cần xác nhận | Phục hồi | Có ở mã/test |
| --- | --- | --- | --- | --- | --- |
| Owner vắng, không trả lời | câu hỏi chờ > 10 phút | nghe, giữ bức tranh, nghe lại | không giả định gì về câu hỏi; cần xác nhận | nhắc một lần, rồi để vào "Câu hỏi mở" | skill (nguyên tắc 1–3); **chưa** có trạng thái "câu hỏi chờ" ở host |
| Owner sửa hai lần mâu thuẫn | hai lời sửa cùng chủ đề | ghi cả hai kèm giờ, dùng lời mới nhất cho hiển thị | lời mới nhất là giả định đảo được; nghiệp vụ cần xác nhận | hỏi một câu gộp | **chưa** (sửa lỗi chỉ ở glossary/RAW) |
| Đổi mục tiêu/phạm vi giữa họp | owner nói rõ | ghi mốc đổi vào bức tranh | phạm vi mới thay cho phần sau mốc | — | skill |
| Hai lệnh start / hai controller | `RUNTIME_BUSY` | báo đúng pid/cổng/thư mục | không tự tắt host kia; cần owner | owner duyệt rồi tắt sạch | ENG-36, `tests/machine.test.mjs` |
| UI hoặc agent mất kết nối | Monitor hết hạn, follow thoát, `followers.*.at` cũ | bật lại Monitor/agent nền | — | đọc tiếp từ `committed` | ENG-31/38, `tests/follow.test.mjs`, `tests/session.test.mjs` |
| Bộ nghe đứng | `BỘ NGHE ĐỨNG` (90 s không ra gì) | báo owner; WAV vẫn ghi | không tự dừng tiến trình phiên khác | owner duyệt; sau họp `coverage`/`recheck` | ENG-33 |
| ASR tin cậy thấp | cờ `Lào kém`, `ngôn ngữ không chắc` | `recheck` | không đoán chữ | `[chưa nghe rõ]` | có |
| Không biết ai nói | không có bằng chứng | để "chưa xác định" | không gán từ khoảng lặng/khúc/kênh `Tôi` | owner xác nhận sau họp | skill; **chưa** có lớp bằng chứng người nói |
| Bị từ chối quyền / hết quota | lỗi ghi file, lỗi gọi | báo một lần là đang suy giảm; phần được phép tiếp tục | không vòng qua quyền | owner sửa quyền | `committed` không tiến khi lưu lỗi (ENG-38); **chưa** có cờ "suy giảm" ở host |
| Lưu dở, mất phản hồi (ACK) | `committed` < chỗ đã in | — | — | bật lại đọc lại từ `committed`; lưu lại không trùng | ENG-38, G1 |
| Context cũ hoặc gửi nhầm người nhận | ngày context khác hôm nay; phiên đọc không đúng cuộc họp | không dùng context cũ làm context hôm nay | cần xác nhận | ghim `sessionId`; context cũ ghi là cũ | có (`savedIsCurrent`, follow ghim cuộc họp); **chưa** có ràng buộc phiên bản/hash context |
| Kết thúc/huỷ khi việc nền đang chạy | owner gõ kết thúc | dừng ghi trước, cho nghe nốt | — | báo phần còn treo trong SUMMARY | có (`stop` drain); **chưa** có báo cáo việc nền dang dở |
| Host chết, bộ ghi còn chạy | khoá có PID bộ ghi sống | host cùng thư mục dữ liệu nhận lại | host khác bị từ chối | reattach, vai đọc tiếp | ENG-31/36 |
| Tạm dừng rồi tiếp tục | `pause` | chỉ dừng nhận dạng, vẫn ghi | chỉ tiếp khi owner nói `listen` | đuổi kịp từ chỗ dừng | có |
| Mốc thời gian không hợp lệ | `TIMESTAMP_INVALID …` | giữ chữ, bỏ mốc, giữ giá trị thô | không kẹp mốc | ghi vào RAW để kiểm | ENG-39, `tests/share.test.mjs` |

## Khi owner im lặng gặp ngoại lệ khác

1. **Owner im lặng + `RUNTIME_BUSY`** (một host thử đang chiếm máy).
   - Không tự tắt host kia, vì đó là tiến trình của phiên khác.
   - Cuộc họp của owner chưa ghi được: báo một lần, nói rõ hậu quả ("chưa ghi âm buổi này"), rồi chờ.
   - Không lách bằng cách mở host thứ ba.
   - Đây là chỗ duy nhất phải dừng thật, vì ghi âm cần quyền của owner.
2. **Owner im lặng + bộ nghe đứng giữa họp.**
   - WAV vẫn ghi đủ, nên không mất gì không lấy lại được.
   - Bức tranh ghi "từ HH:MM chưa có chữ" kèm lý do.
   - Không tự dừng tiến trình phiên khác.
   - Sau họp, `stop` cho nghe nốt, rồi `coverage`/`recheck` lấp phần thiếu.
   - Không coi im lặng là đồng ý tắt tiến trình.
3. **Owner im lặng + lưu bản dịch bị từ chối quyền.**
   - Bản dịch đã in nhưng không lưu: `committed` đứng yên, đúng như mong đợi.
   - Báo một lần "dịch đang suy giảm: không lưu được".
   - Không ghi vòng qua chỗ khác để né.
   - Phần nghe và bức tranh vẫn chạy.
   - Khi quyền được mở, vai dịch bật lại đọc từ `committed` và lưu bù.

## Còn thiếu

- Trạng thái "câu hỏi chờ owner" có hạn và nhắc một lần ở host.
- Cờ "suy giảm" ở host khi lưu bị từ chối.
- Ràng buộc phiên bản/hash context với từng phiên đọc.
- Lớp bằng chứng người nói.
- Báo việc nền còn dở khi kết thúc.
- Test đầu-cuối qua agent thật.
