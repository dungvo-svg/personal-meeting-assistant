# Hợp đồng `pma-seat/1`: Claude của Quân, Oanh nối với phiên trung tâm của Dũng

Nháp 03/11/2026, chưa dùng ở họp thật. Owner quyết: có dùng kênh này không, đặt ở folder Drive nào, chia cho ai.

## Ai chạy gì

| Máy | Chạy | Không chạy |
|---|---|---|
| Dũng | PMA (ghi âm, ASR, host), phiên trung tâm `/hop` trong dự án thầu, connector Google Drive bằng tài khoản công ty của Dũng | |
| Quân, Oanh | Claude (Desktop hoặc claude.ai) + plugin `hop-vai` (chỉ skill) + connector Google Drive bằng tài khoản công ty **của chính người đó** | PMA, ASR, GPU, ghi âm, MCP server, code nào khác |

Mỗi cuộc họp chỉ một bộ ghi, trên máy Dũng; WAV và transcript không rời máy đó. PMA không có mạng: nó không gửi, không nhận gì từ máy khác. Đường đi duy nhất là các file JSON trong **một folder Drive công ty riêng cho phối hợp họp** (không phải folder "Thau BV": folder đó chỉ chứa file làm việc). Mỗi Claude đọc/ghi folder đó bằng connector của chính mình; người ghi một file là tài khoản Drive đã ghi nó.

## Folder và tên file

```
<folder phối hợp>/<meetingId>/
  packet-<personKey>.json         Dũng ghi (phiên trung tâm, từ `pma seat export`)
  receipt-<personKey>.json        Claude của người đó ghi: đã đọc packet nào
  reply-<personKey>-<n>.json      Claude của người đó ghi: nhận / từ chối / trả lời một việc (n = 1, 2, …; không ghi đè)
```

`personKey` = tên viết thường, bỏ dấu, chỉ `a-z0-9-` (Quân → `quan`, Oanh → `oanh`). `meetingId` = id phiên PMA (UUID).

## packet (Dũng → người đó)

```json
{
  "schema": "pma-seat/1", "kind": "packet",
  "meetingId": "<uuid>", "meetingTitle": "…", "person": "Quân", "personKey": "quan",
  "seatGeneration": 1762182000000, "contextVersion": "<version của context pack>",
  "issuedAt": "<ISO>",
  "role": { "description": "<chủ mô tả, hoặc null>", "scope": "<phạm vi chủ giao, hoặc null>" },
  "missing": ["role_description:Quân", "…"],
  "view": {
    "topics": ["…"],
    "decisions": [{ "id": 3, "text": "…", "status": "decided|proposed|superseded|withdrawn" }],
    "actions": [{ "id": 1, "decisionId": 3, "description": "…", "status": "…" }],
    "questions": [{ "id": 2, "text": "…" }],
    "assignments": [{ "id": 7, "text": "…", "status": "open|accepted|declined|answered", "dueAt": "<ISO hoặc null>", "sourceIds": [12, 13] }]
  },
  "rules": ["…"]
}
```

Không có transcript, không có âm thanh, không có giá vốn/công nợ/lương/danh sách khách hàng ngoài những gì chủ đã đưa vào việc giao. Cái gì chủ chưa cho thì là `null` và nằm trong `missing`, không được điền.

## receipt (người đó → Dũng), ghi trước mọi reply

```json
{
  "schema": "pma-seat/1", "kind": "receipt",
  "meetingId": "<uuid>", "person": "Quân", "seatGeneration": 1762182000000, "contextVersion": "<đúng như packet>",
  "readAt": "<ISO>",
  "preflight": { "plugin": "hop-vai <version>", "driveAccount": "<email công ty đang dùng>", "folderReadable": true, "folderWritable": true }
}
```

## reply (người đó → Dũng)

```json
{
  "schema": "pma-seat/1", "kind": "reply",
  "meetingId": "<uuid>", "person": "Quân", "seatGeneration": 1762182000000, "contextVersion": "<đúng như packet>",
  "assignmentId": 7, "step": "accept|decline|reply",
  "text": "<lời trả lời; decline: lý do>", "propose": "<đề xuất, tuỳ chọn>", "sourceIds": [12],
  "writtenAt": "<ISO>"
}
```

Một reply **không chốt gì**. `propose` chỉ là đề xuất; chốt là việc của người được chủ giao thẩm quyền, ở phiên trung tâm (`pma decide`).

## Phía Dũng: nhập vào PMA

Phiên trung tâm đọc file qua connector Drive, rồi đưa cho host **nội dung file kèm metadata Drive nó đọc được**:

```
./pma seat import --file - <<'JSON'
{ "file": { …nội dung receipt hoặc reply… },
  "drive": { "fileId": "…", "name": "reply-quan-1.json", "modifiedByEmail": "…", "ownerEmail": "…", "modifiedTime": "<ISO>" } }
JSON
```

Host kiểm theo thứ tự, lỗi đầu tiên thắng:

1. `schema`/`kind` đúng, `meetingId` là cuộc họp này → `INVALID_SEAT_FILE` / `SEAT_FILE_OF_ANOTHER_MEETING`
2. người đó có seat `remote_claude` → `NO_REMOTE_SEAT`
3. `drive.modifiedByEmail` (và `ownerEmail` khi có) đúng email chủ đã ghi cho seat → `IDENTITY_MISMATCH`
4. `seatGeneration` đúng seat hiện tại → `STALE_GENERATION` / `NOT_BOUND`
5. `contextVersion` đúng bản context hiện tại → `CONTEXT_NOT_CURRENT` (phiên trung tâm xuất packet mới)
6. reply mà người đó chưa có receipt cho đúng bản này → `NO_RECEIPT`
7. cùng `drive.fileId` + `modifiedTime` đã nhập → trả lại đúng kết quả cũ, không nhập lần hai

**Giới hạn phải nói thật:** host không tự xem được Drive. Metadata là do phiên trung tâm đọc qua connector của Dũng rồi chuyển vào; trạng thái kết nối vì thế là `RELAYED_VIA_DRIVE`, không bao giờ là "đã kiểm kết nối". Muốn chắc hơn thì người kiểm mở file trên Drive và xem "Người sửa đổi".

## Tạo seat từ xa (chỉ khi chủ nói)

```
./pma seat "Quân" --remote --endpoint drive:<folderId> --email <email công ty của Quân> --consent "<lời chủ trong chat, kèm ngày>"
```

Thiếu một trong ba (endpoint, email, consent) → `REMOTE_NOT_CONSENTED`. Consent là lời **chủ** (Dũng) rằng người đó đồng ý và được dùng kênh này; không lấy từ lời trong họp.

## Trạng thái seat

| connection | Nghĩa |
|---|---|
| `SIMULATED` | vai giả lập trên máy Dũng, không phải Claude thật của người đó |
| `NOT_CONNECTED` | seat từ xa đã ghi (endpoint, email, consent) nhưng chưa nhập được receipt nào cho bản context hiện tại |
| `RELAYED_VIA_DRIVE` | đã nhập receipt cho bản context hiện tại, đúng email; kèm thời điểm và fileId |
