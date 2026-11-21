# Chuyển file ghi âm thành chữ (`pma transcribe`)

Cho anh Lê Hoàng Duy (giao trong họp định kỳ 21/11, anh Quân chủ trì): chuyển tin nhắn thoại WhatsApp và file ghi âm trong app thành chữ tiếng Việt / Lào / Thái, chạy trên máy công ty, không gửi âm thanh ra ngoài.

## Làm được gì

- Nhận file `.opus`/`.ogg` (tin nhắn thoại WhatsApp), `.m4a`, `.mp3`, `.wav`, `.mp4`. Một lệnh nhận nhiều file.
- Ra một file chữ `.md`: mỗi dòng có vị trí trong file, ngôn ngữ (vi/lo/th) và cờ khi máy không chắc.
- Câu máy tự bịa khi im lặng hoặc mẩu quá ngắn (kiểu "Hãy subscribe cho kênh…", câu tin tức tiếng Lào "ທ່ານກ່າວວ່າ…") bị bỏ và đếm, không lẫn vào chữ.
- Đoạn tiếng Lào máy không chắc: in cả bản chữ Thái và bản đọc tiếng Lào bên dưới (`↳ lo`), để người dịch (Claude) dịch theo bản Lào, không theo chữ Thái phiên âm.
- Dịch sang tiếng Việt: Claude dịch khi đọc file chữ (không dùng dịch vụ nào khác).

## Kết quả thử (21/11, file cắt từ ghi âm họp, chuyển sang định dạng WhatsApp)

| File | Kết quả |
| --- | --- |
| 45 giây có tiếng Lào thật | Dòng chính ra chữ Thái phiên âm ("ราคาถือ" = "giá cầm"), bản Lào bên dưới đúng nghĩa: "ລາຄາຖືກ" = giá rẻ, "ເພິ່ນເລືອກສອງແບບ" = họ chọn hai loại |
| 30 giây tiếng Việt | Đúng: "có 12 mã đang cao hơn cái trúng 2026" |
| 4 giây nói ngắn | Đúng tiếng Việt; câu Lào bịa trước đây đã bị bỏ |

Tốc độ: khoảng 1,3 phút âm thanh xử lý trong 12–25 giây trên RTX 3050 (máy bậc `day-du`).

## Cách dùng

Trên máy đã cài PMA (`pma hardware` bậc `day-du` thì có tiếng Lào):

```bash
pma transcribe "D:/ghi-am/tin-nhan-1.opus" "D:/ghi-am/tin-nhan-2.opus" --out "D:/ghi-am/chu.md"
```

Không có `--out` thì ghi `<tên file>-chu.md` cạnh file đầu. Rồi nhờ Claude: "đọc file chu.md, dịch các dòng lo/th sang tiếng Việt".

## Cần anh Duy trả lời

1. File ghi âm nằm ở đâu: điện thoại (WhatsApp xuất ra), hay app của anh lưu trên máy chủ? Định dạng gì, mỗi file dài bao lâu, mỗi ngày bao nhiêu file?
2. Người nói chủ yếu tiếng gì (Lào, Việt, lẫn)? Có tên người, mã hàng, tên thuốc hay xuất hiện không (để thêm vào bảng tên cho máy nghe đúng)?
3. Cần chữ để làm gì: lưu biên bản, tìm lại, hay đưa vào app (khi đó cần đầu ra dạng JSON/CSV)?
4. Chạy ở đâu: gửi file về máy của Dũng chạy, hay cài PMA trên máy khác (cần NVIDIA ≥ 6 GB VRAM cho tiếng Lào, xem `pma hardware`)?
5. Ghi âm có thông tin nhạy cảm (giá vốn, công nợ, lương, khách hàng) không — chữ chỉ lưu trên máy công ty.

## Giới hạn

- Văn bản máy nghe chưa xác minh; số và tên tiếng Lào phải đối chiếu.
- Mẩu nói rất ngắn (dưới 3 giây) dễ ra chữ sai hoặc bị bỏ.
- Không có card NVIDIA thì không có tiếng Lào (ra chữ Thái phiên âm, được gắn cờ).
