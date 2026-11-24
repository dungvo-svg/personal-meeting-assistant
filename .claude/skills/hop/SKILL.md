---
name: hop
description: Trợ lý họp chạy trên máy. Claude dùng bộ công cụ `pma` để phục vụ người dùng trong cuộc họp Zoom/Google Meet nói tiếng Việt, Lào, Thái — chuẩn bị context trước họp, ghi âm cả buổi (WAV), theo dõi trong một phiên trung tâm (tổng hợp, chat với người dùng; dịch thô Lào/Thái chạy nền khi được bật), tự nghe lại chỗ chưa rõ, sau họp làm RAW + SUMMARY + TASKS. Dùng khi người dùng gửi link Zoom/Meet kèm nội dung họp, nói "nghe họp", "vào họp", "theo dõi cuộc họp", gõ /hop, hoặc muốn phát lại một file ghi hình họp.
---

# Trợ lý họp (`pma`)

Quy trình họp nằm trong công cụ và đi cùng phiên bản của nó; kỹ năng này chỉ chỉ đường. Việc đầu tiên, mỗi lần dùng (và khi vào giữa một cuộc họp):

```bash
"./pma" guide
```

(`"./pma"` là trong thư mục PMA. Thư mục họp khác dùng bản kỹ năng do `pma connect` chép, đã ghi sẵn đường dẫn đầy đủ của máy đó.)

Đọc hết và làm đúng theo đó; mọi lệnh trong hướng dẫn đã ghi đường dẫn đầy đủ nên chạy được từ thư mục nào. Phần cho agent dịch nền: `"./pma" guide dich`.

Lệnh trên lỗi (không có công cụ, không có file hướng dẫn): báo người dùng đúng lỗi, không làm theo trí nhớ.
