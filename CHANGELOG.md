# Changelog

## 0.12.1 — 03/11/2026

Nhánh `pma/v5-cursor`, nền `pma/v5-int` `55a0394` (0.12.0 chưa tích hợp).

- **Nội dung nháp chỉ tới host đang chạy, và chỉ tính khi đúng người đọc đúng context** (Codex review 9b02494): `picture`, `translate`, `participants`, `summary`, `tasks`, `job done` không còn tự mở host (`HOST_NOT_RUNNING`); bức tranh, SUMMARY, TASKS qua host cần vai `chinh` đã đọc context hiện tại (`CONTEXT_NOT_READ` / `CONTEXT_NOT_CURRENT`; sau họp `pma brief --as chinh` đọc cuộc họp gần nhất); `pma picture --expect-revision N` báo `PICTURE_REVISION_CONFLICT` thay vì đè bản mới hơn; báo cáo ghi ra đĩa và đọc lại trước rồi mới vào DB, đĩa lỗi thì `REPORT_NOT_WRITTEN` và không ghi gì; gửi lại đúng nội dung không thêm dòng.
- **Biên nhận đọc context, khoá chống gửi lại, token việc nền** (Codex review 8a53bb0): mỗi lần `pma brief --as <vai>` có biên nhận riêng `rcpt-…` do host cấp; bức tranh, SUMMARY, TASKS qua host cần `--receipt` của một lần đọc của vai `chinh` đúng bản context hiện tại (đầu đọc chung `agent` không còn được tính). Biên nhận chỉ chứng minh người cầm nó đã được cho xem bản context đó, không phải định danh hay ACK của người nhận. Năm loại nháp (picture, translations, participants, summary, tasks) kiểm thêm theo schema pma-draft/1; `--key K`: cùng khoá + cùng nội dung trả kết quả cũ, khác nội dung thì `IDEMPOTENCY_KEY_REUSED`; kết quả có receipt `SAVED` (delivered/confirmed: NOT_AVAILABLE). `pma job start` trả token; `job done/fail` thiếu token thì `JOB_TOKEN_REQUIRED`. `listen --no-mic/--mic` khi bộ ghi đang chạy: lưu và khởi động lại bộ ghi như `select`.
- **Khoá, token và bản gốc ghi cùng một lần** (Codex review 9124eb3): khoá chống gửi lại được giữ chỗ TRƯỚC khi lưu và hoàn tất sau, cùng một giao dịch: không ghi được khoá thì không lưu gì, lưu lỗi thì không còn khoá (file báo cáo đã ra đĩa hay bảng tên là bản chiếu, dòng DB là bản ghi). Việc nền và token tạo cùng một giao dịch; việc tạo sau mốc có token mà thiếu token thì `JOB_TOKEN_MISSING`, không coi là việc cũ. Bức tranh, SUMMARY, TASKS qua host BẮT BUỘC `--base <bản đã đọc>` (lần đầu 0): kết quả trễ dựng từ bản cũ bị `PICTURE_REVISION_CONFLICT` / `REPORT_REVISION_CONFLICT`; gửi lại đúng nội dung đã lưu không phải xung đột. `pma status` có `revisions`.
- **MCP adapter theo cùng hợp đồng với CLI** (0.12.1): `context_read` trả biên nhận context; `report_save_summary`/`report_save_tasks` cần `receipt` + `expectedRevision`, chỉ gửi cho host đang chạy; `session_prepare`/`source_select`/`hearing_start` có `mic` tường minh. Khoá của bức tranh dành riêng cho `pma picture`: `note_publish` với khoá đó bị `PICTURE_KEY_RESERVED`. Phá vỡ: client MCP cũ không có biên nhận thì không lưu được báo cáo.
- **Tắt micro giữ suốt phiên** (Codex review tĩnh 1c51bc4): `--no-mic` lưu vào context phiên; `select`/`listen` không kèm lựa chọn giữ nguyên, host nhận lại phiên và bộ ghi khởi động lại đều đọc từ đó; bật lại chỉ khi `--mic` hoặc chọn micro. `PMA_MIC=0` vẫn thắng. Mặc định vẫn ghi micro (OWN-027).
- **Giao diện với BidOps** (docs/BIDOPS_INTERFACE.md): PMA là công cụ nghe/tổng hợp/provenance; mạng agent và gói seat thuộc BidOps.
- **Vai của từng người qua host** (cowork, docs/COWORK_3CLAUDE.md): `pma seat` tạo vai giả lập cho Dũng / Quân / Oanh trên máy này (nhãn "vai giả lập", không bao giờ báo là đã nối); host tự tạo mã vai và thế hệ, mã chỉ hiện một lần, tạo lại vai thì mã cũ hết dùng. `pma role --seat` là biên nhận đọc context; `pma reply/accept/decline --seat` chỉ nhận khi vai đã đọc bản context hiện tại (CONTEXT_NOT_CURRENT), ai trả lời và thế hệ nào lấy từ sổ của host, không từ lời người gọi. Trả lời không chốt gì: `pma converge` gom đề xuất, việc bị từ chối, quá hạn, câu hỏi treo về phiên trung tâm; `converge promote` chỉ đưa vào sổ quyết định dưới dạng đề xuất, ghi rõ của vai giả lập nào. Claude từ xa: `REMOTE_NOT_CONNECTED` (chưa có endpoint, consent, kết nối thật). Theo review Codex a3e1fb3: thế hệ vai so với mọi consumer; host bắt buộc kèm context khi trả lời.
- **Tiến độ từng vai bền qua host restart** (ENG-31):
  - con trỏ đã ack và giờ của mỗi vai ghi thêm vào bảng SQLite `followers`;
  - host mới nhận lại cuộc họp còn ghi thì `chinh` và `dich` đọc tiếp đúng chỗ, không chiếu lại 40 dòng;
  - không khôi phục nhịp tim hay lease: tiến trình follow còn chạy giành lại vai ngay, không bị `FOLLOWER_BUSY`;
  - bảng mới, thêm vào; bảng cũ không đổi, bản 0.11/0.12.0 bỏ qua bảng này.
- **`pma recheck`/`pma stop` không còn "fetch failed" khi host làm lâu** (ENG-32; lỗi thật ở họp thầu 03/11, host 0.11: `pma recheck 1775` báo `{"error":"fetch failed"}` khi bộ nghe đang chạy):
  - nguyên nhân: CLI gọi host bằng `fetch`, mà `fetch` của Node bỏ chờ sau 300 s chưa có header trả lời (`UND_ERR_HEADERS_TIMEOUT`), bất kể CLI cho chờ 15 phút (recheck) hay 20 phút (stop). Tái hiện bằng server giả cùng giới hạn của host, trả lời sau 330 s: `FAIL after 307 s … UND_ERR_HEADERS_TIMEOUT`;
  - sửa: `src/client.ts` gọi `/rpc` bằng `node:http`, giới hạn duy nhất là thời gian của từng lệnh;
  - host vẫn làm tiếp và lưu kết quả recheck khi CLI mất kết nối, nên chạy `pma coverage` trước khi gọi lại.
- **`BỘ NGHE ĐỨNG`** (ENG-33; lỗi thật ở họp thầu 03/11): từ 09:08 một host PMA thứ hai (bản thử `PMA_MIC=0`, cổng 18816) ghi trùng loa và chạy bộ nghe riêng, GPU 6 GB đầy, bộ nghe của cuộc họp đứng khoảng 20 phút. Suốt lúc đó `status` vẫn báo `LISTENING`, trễ 1,2 s (số của đoạn cuối cùng làm xong), không lỗi. Nay host báo `captureInfo.asrStalledSeconds` khi bộ nghe đang nghe mà 90 s không gửi gì; `pma follow` in `BỘ NGHE ĐỨNG` thay cho cảnh báo trễ; skill `hop` ghi cách xử lý. Không tự dừng hay khởi động lại gì.
- **Một máy chỉ một host họp** (ENG-36; họp thầu 03/11). Trước khi nạp model, mở thiết bị, ghi âm, nghe lại hay nhận lại cuộc họp, host lấy khoá máy `runtime.lock` (thư mục `PMA_LOCK_DIR`, mặc định `%LOCALAPPDATA%\pma`), không phụ thuộc checkout, thư mục dữ liệu hay cổng. Host thứ hai bị từ chối `RUNTIME_BUSY`, kèm pid, cổng, thư mục dữ liệu của host đang giữ.
  - Khoá không có hạn giờ. Chỉ hết hiệu lực khi host giữ nó đã mất: PID chết, hoặc PID còn sống nhưng giờ khởi động khác (PID bị dùng lại).
  - Host chết mà bộ ghi/bộ nghe của nó còn chạy thì máy vẫn bị giữ; chỉ host cùng thư mục dữ liệu được nhận lại cuộc họp đó.
  - Phiên fixture (không âm thanh, không model) không lấy khoá. `recheck` sau họp mượn khoá trong lúc nghe lại.
  - Giành khoá cũ một host một lúc (khoá phụ `runtime.lock.takeover`): host thứ hai đã thấy khoá cũ không dời được khoá mới của host thứ nhất (review Codex 5e903de, điểm a; có test xen kẽ tất định).
  - Chỉ nhả khoá khi không còn gì của host chạy: bộ nghe, bộ ghi, `recheck`, hay dọn dẹp chưa xác nhận (`CLEANUP_UNCONFIRMED`) (review điểm b). Host thoát trước thì khoá ở lại kèm PID cho quy tắc tiến trình mồ côi.
  - Giới hạn: host bản cũ (0.11, 0.12.0, bản thử `PMA_MIC=0` hiện tại) không biết khoá này nên không bị chặn.
- **`pma status` và MCP `session_status` chỉ đọc** (ENG-37): không có host thì trả `NOT_RUNNING` kèm ai đang giữ máy, không tự bật host (03/11: `pma status` của một phiên khác đã bật host 0.11 lúc 09:01). MCP adapter không còn bật host khi khởi động; lệnh đầu tiên cần host mới bật nó.
- **Công việc "đã lưu" khác "đã in"** (ENG-38): mỗi vai có `committed` = dòng cuối mà mọi dòng tới đó đã xong: với `chinh` là đã có bức tranh dẫn tới nó; với vai dịch là không cần dịch (bị ẩn, không phải Lào/Thái, câu ảo) hoặc bản dịch đã lưu. Tính từ dữ liệu đã lưu nên đầu ra và các dòng nó phủ được ghi cùng một lần; lưu lỗi thì không tiến. `follow` bật lại đọc tiếp từ `committed`, không từ chỗ đã in. Không thêm bước nào cho model.
- **Một phiên trung tâm, dịch thô chạy nền** (OWN-031, U29; skill `hop`): phiên `/hop` xúc tiến cuộc họp và trả lời owner; dịch thô Lào/Thái tuỳ chọn, chạy như agent nền Haiku (follow `--minutes 9` lặp lại), không mở phiên chat; phân tích dài cũng chạy nền. `pma read` của owner in `→ (Claude dịch)` dưới dòng đã dịch. Owner chỉ nói ý định; lệnh là việc của agent. Giới hạn: agent nền không tự báo vào chat, chỉ báo khi kết thúc; chưa dùng ở họp thật; chưa có test đầu-cuối qua agent thật.
- **Kiểm mốc thời gian đoạn nhận dạng trước khi tin** (ENG-39; đợt kiểm âm thanh riêng 03/11 thấy đoạn báo vượt độ dài file vào): mốc không phải số, âm, cuối trước đầu, dài hơn một khúc (25 s), giờ thật hỏng, sau hiện tại hoặc trước phiên thì đoạn vẫn giữ chữ cho RAW nhưng bỏ mốc, gắn `TIMESTAMP_INVALID <lý do> {giá trị thô}`, không đẩy vị trí nhận dạng, và dòng micro mất `MIC_SHARE_OK`. Không kẹp mốc.
- **Bản dịch lưu lại không xoá bản cũ** (ENG-40): lưu lại cùng chữ thì không đổi gì; khác chữ thì bản cũ chuyển sang `translation_history` (chữ, giờ tạo, giờ bị thay).
- **Người phụ trách có nguồn gốc** (ENG-41): `ownerBasis` = `stated` / `confirmed` / `inferred`. Suy luận hiện "(suy luận, cần xác nhận)" và không vào "Việc của tôi". Skill: lúc kết thúc, dừng hoặc chờ agent phân tích nền, việc bỏ dở ghi vào SUMMARY.
- **Sửa theo review Codex 1def228 và ee528c1** (ENG-42):
  - khoá phụ giành khoá: xuất hiện nguyên vẹn (hard-link một file tạm đã đầy), không bao giờ bị lấy từ người giữ còn sống dù cũ bao lâu, chỉ người giữ đã mất mới mất nó; người giữ chỉ xoá khi nó còn là của mình. Test: host khác thử giành ngay trong vùng găng của host kia;
  - bộ ghi gắn sẵn không chịu dừng (STOP rồi kill vẫn còn): giữ PID và trạng thái `STOP_UNCONFIRMED`, giữ khoá máy; host khác vẫn `RUNTIME_BUSY` tới khi tiến trình thật sự mất. Khoá ghi PID bộ ghi còn sống cả sau khi phiên đã đóng;
  - `committed` của `chinh` là hợp đồng mốc cao của bức tranh cả cuộc họp: bản lưu khi `chinh` đã được giao tới N, dẫn tới M, phủ tới min(M, N), chốt lúc lưu (`coversUpTo`). Dẫn trước một dòng chưa giao không phủ gì. `status` tính mà không ghi gì; chỉ `next`/`release` lưu;
  - đoạn nhận dạng được đối chiếu với khúc ghi thật trong `timeline.jsonl` (seg, kênh, lúc mở, các tick số mẫu): nằm ngoài khúc đó thì `PAST_ITS_SEGMENT`/`BEFORE_ITS_SEGMENT`. Đoạn không tin được mốc giờ là chữ suy giảm chỉ cho owner: bỏ dấu nghe trực tiếp (`SOURCE_TIME_UNTRUSTED`), nên không vai chia sẻ nào nhận;
  - review 13cd5e8: test không còn đụng PID thật nào (bộ ghi "không chịu dừng" giả qua điểm chèn `alive`/`killPid` của runtime, thay cho PID hệ thống); khoá phụ của host đã chết không bao giờ bị host khác gỡ (đóng an toàn, lỗi chỉ đúng file cần xoá); lệnh dừng tới bộ ghi qua ống của nó trước mọi lần ghi đĩa (file STOP, daemon.json, khoá), có test thứ tự với file STOP ghi lỗi;
  - skill: owner nói kết thúc thì `./pma stop` **ngay**, trước mọi chờ dịch/phân tích; dịch nền vẫn nhận lô cuối trong lúc `stop` cho nhận dạng nốt.
- **Kiểm lại micro ngay lúc giao cho vai chia sẻ** (ENG-44): bộ nghe gắn `MIC_SHARE_OK` một lần lúc nhận dạng; nay host còn đối chiếu lại timeline hiện có (luật `share_ok` chép sang `src/mic_share.ts`, test so cùng ca với `tools/mic_state.py`) ngay trước `next`/`read` của vai chia sẻ. Không còn đủ bằng chứng (micro không ON suốt dòng +1,5 s, bộ đọc không còn thấy sống, không có giờ thật) thì dòng bị gắn `MIC_SHARE_REVOKED <lý do>` và không bao giờ được giao nữa; owner, RAW, WAV giữ nguyên (OWN-027). Giới hạn: phần đã giao trước khi bằng chứng đổi thì không lấy lại được.
- **Lưu lỗi dòng N không chặn dòng N+1** (test): bản dịch N+1 vẫn lưu và giữ; mốc `committed` đứng trước N; bật lại thì giao lại từ N, lưu lại N+1 cùng chữ không đổi gì.
- **Một điểm kích hoạt từ mọi thư mục** (ENG-47, Sonnet B): lệnh `pma`/MCP ở checkout hay thư mục dữ liệu khác nối vào đúng host đang giữ máy (`attached.via: machine`), kiểm pid, cổng, địa chỉ loopback trước khi gửi token; không bao giờ mở host thứ hai khi có host giữ máy còn sống (không với tới được thì `RUNTIME_BUSY`). `pma status` vẫn chỉ đọc.
- **Gói context có phiên bản và nguồn gốc** (ENG-45, Sonnet A): `src/context_pack.ts`; mỗi follow ghi lại đã đọc phiên bản nào (`CONTEXT v…`), `status` cho từng vai `READY`/`DEGRADED`/`NOT_READY`/`NEEDS_REBIND`; context đổi giữa họp thì follow tự đọc lại. Thiếu context không chặn ghi âm, nhưng không chốt gì dựa trên phần thiếu.
- **Việc nền, câu hỏi chờ chủ, suy giảm** (ENG-46, Sonnet C): `src/jobs.ts`; `pma job`, `pma ask`/`answer`/`questions`, `pma degraded`. Câu hỏi nhắc một lần rồi vào "Câu hỏi mở"; suy giảm báo một lần; `stop` dừng việc còn chạy, xếp câu hỏi còn mở và in `unfinished` cho SUMMARY.
- **Test không bao giờ chạm host thật của người dùng** (ENG-48; review Astra 75feff5): từ khi client nối vào host giữ máy, một test chỉ đặt thư mục dữ liệu và cổng tạm vẫn có thể tìm thấy host thật qua khoá máy của người dùng rồi gọi prepare/finish/shutdown/purge. Nay hai lớp chặn: ở chế độ thử (`PMA_TEST_MODE=1`) mà không có `PMA_LOCK_DIR`, khoá máy nằm trong thư mục dữ liệu của test; và client ở chế độ thử chỉ dùng host trả lời `testMode: true`, mọi host khác chỉ nhận được ping. Test `follow` dùng host giả giờ chạy ở chế độ thử. Chưa chạy (giữ của phiên gốc).
- **Xúc tiến: quyết định → việc → kết quả** (ENG-49, Sonnet D, owner 03/11): `src/decisions.ts`; `pma grant` (thẩm quyền chỉ từ lời chủ), `propose`, `decide`, `change` (thay quyết định), `withdraw`, `act`, `action done|fail|rollback`, `decisions`. Không có thẩm quyền thì không chốt và tạo một câu hỏi chờ đúng người. `stop` in `decisions` cho SUMMARY. Skill có mục "Xúc tiến" là việc chính.
- **Context: đọc mới là biên nhận** (ENG-45 sửa theo review): `pma brief --as <vai>` ghi nhận vai đó đã đọc phiên bản nào; follow không còn tự xác nhận thay, chỉ nhắc `CONTEXT CHƯA ĐỌC`/`CONTEXT ĐỔI`. `pma correct` (nghe sai → đúng, xác nhận hay suy luận, cuộc họp hay công ty, nguồn) và `pma doc` vào gói context; brief in phần sửa và tài liệu. Bản sửa người dùng xác nhận luôn thắng bản suy luận.
- **File nháp đi qua host, không ghi vào `.local`** (OWN-032, owner 03/11: "Giữ chặn, qua host"): `--file -` đọc nội dung từ stdin ở `participants`, `start --participants`, `picture`, `translate`, `summary`, `tasks`, `job done`; skill bỏ mọi bước ghi `.local/drafts`. `owner.json` tạm bỏ: tên lấy từ `pma start --me` (chỉ là thông tin). Luật chặn `.local/**` không đổi.
- **Tắt micro tường minh tới được bộ ghi** (review Codex f6d5dc8): `PMA_MIC` nay được chuyển cho host khởi động qua WMI (danh sách env của client và host); `pma start --no-mic` quyết trước khi nguồn loa đã nhớ tự bật bộ ghi; `select --no-mic` khi bộ ghi đang chạy có micro thì khởi động lại bộ ghi không micro ngay. Mặc định không đổi: micro luôn ghi (OWN-027). Test `tests/no_mic.test.mjs` (bộ ghi giả, chỉ xem tham số) chưa chạy.
- **Bộ khung test cách ly** (Sonnet E, `tests/harness.mjs`): mỗi test có gốc, dữ liệu, khoá riêng; trước mọi lời gọi (kể cả dọn dẹp sau khi test hỏng) phải chứng minh host là host thử do chính test bật; không thì không gửi gì. Các test tích hợp daemon/afterwards/capture/follow/session đã chuyển sang. Chưa chạy.
- **Test tiến trình thoát muộn** (Sonnet F, `tests/fake_process.mjs`, `tests/late_exit.test.mjs`): chưa chạy. Chúng chỉ ra ba lỗ, đã sửa:
  - không đọc được còn sống hay không (lỗi, hoặc giá trị lạ) nay coi là còn sống, giữ khoá; trước đó có thể văng lỗi hoặc nhả khoá;
  - bộ nghe thoát muộn sau dọn dẹp chưa xác nhận nay là xác nhận dọn xong, không còn bị coi là sập rồi bật lại;
  - lệnh nhả khoá định kỳ của host không còn làm văng lỗi.
- **Kịch bản thử giả lập Dũng–Quân–Oanh** (`tests/pilot_dqo.test.mjs`, chưa chạy): thẩm quyền từ chủ, đề xuất chờ đúng người, quyết định thành việc, đổi quyết định chặn việc cũ, việc nền và câu hỏi vẫn hỏi được, kết thúc báo đủ. Chạy trong tiến trình, runtime chế độ thử, không host, không tiến trình con. Không phải test đầu-cuối qua agent thật.
- **`runtime.test` không bao giờ nạp bộ nghe thật:** `PMA_WARM=0` cho cả file và `warm:false` ở runtime không phải chế độ thử (review Astra 75feff5).
- **Rào theo cuộc họp:** id của việc nền, câu hỏi, quyết định, việc làm thuộc cuộc họp khác thì bị từ chối (`…_OF_ANOTHER_MEETING`).
- **Giới hạn:** test của ba phần này đã viết nhưng **chưa chạy** (lệnh giữ của phiên gốc cho mọi test có tác động tiến trình); chỉ `tsc` qua. Chưa có test đầu-cuối qua agent Claude thật.
- **Bảng ngoại lệ** [docs/EXCEPTIONS_0_12.md](docs/EXCEPTIONS_0_12.md): im lặng không phải đồng ý, tư duy ngược các kết cục phải tránh, từng ngoại lệ với việc an toàn, cần xác nhận, phục hồi, phần đã có và phần chưa có.
- **Bức tranh cuộc họp tới 30.000 ký tự** (ENG-34; họp thầu 03/11: họp 30 phút đã chạm giới hạn 8.000 ký tự của ghi chú). Ghi chú thường vẫn 8.000.
- **Báo cáo sau `pma stop` không cần `--session`** (ENG-35; họp thầu 03/11: `pma summary`/`pma tasks` báo "expected string, received undefined"). Sau `stop` host rời đi, lệnh kế tiếp mở host mới không có cuộc họp nào; `summary`, `tasks`, `raw` (như `recheck`, `coverage` đã làm) nay lấy cuộc họp đang mở, nếu không có thì cuộc họp gần nhất. Lệnh cần cuộc họp đang mở mà không có thì báo `NO_OPEN_SESSION: không có cuộc họp nào đang mở; thêm --session <id> (pma history)`.
- **Lời nhắc `NHẮC GHI CHÚ`** chỉ sang `pma picture --file … --sources …`, không còn `pma note` (bức tranh đã thay ghi chú cuốn chiếu từ 0.11).
- **Sửa khoá baseline:** khoá 0.12.0 hash `AGENTS.md`, `README.md`, `docs/PRODUCT_BASELINE.md` theo bản CRLF trong worktree tích hợp, trong khi git lưu LF. Mọi checkout mới vì vậy FAIL `verify_baseline` ở ba file đó. 0.12.1 khoá lại từ checkout sạch (LF).
- **Giới hạn còn mở:** như 0.12.0, trừ mục "tiến độ follower nằm trong bộ nhớ host" đã đóng. Lease vẫn chỉ ở bộ nhớ.
- **Trạng thái:** implemented trong worktree riêng; xem dòng Test bên dưới. Chưa integrated, chưa released, chưa used ở họp thật.

## 0.12.0 — 01/11/2026

Refactor plan v5 (Codex audit → Opus quyết, 3 agent Sonnet làm song song trong worktree `pma/v5-host`, `pma/v5-worker`, `pma/v5-panel`, Opus gộp ở `pma/v5-int`). Plan và cách xử lý bản review độc lập S4: [docs/PLAN_0_12.md](docs/PLAN_0_12.md).

- **Lời mic tắt/không rõ không tới phiên dịch đang share** (OWN-030, U27):
  - Host lọc trước khi giao cho mọi vai khác `chinh` (`next`, `pma read --as`). Dòng ẩn mất cả chữ lẫn `↳`; con trỏ vẫn đi qua.
  - Dòng micro chỉ được giao khi có `MIC_SHARE_OK`: bộ nghe chỉ gắn cờ này khi **cả đoạn** là mic bật (`whole_on`), không theo đa số. Nhãn đa số giữ cho RAW.
  - Dòng loa chỉ được giao khi host đã gắn nguồn gốc nghe trực tiếp (`SOURCE_LIVE_FOLLOW`). Replay file trộn bị chặn, follow in một dòng `GIỚI HẠN` không nội dung.
  - Tiếng loa của người dự vẫn được dịch khi mic tắt. Phiên tổng hợp, WAV và RAW không đổi.
- **Gộp dòng giữ nhãn** (G7): không gộp qua ranh giới mic bật/tắt/không rõ hay kênh; nhóm lặp in kèm nhãn.
- **Gỡ bảng web cũ** (ENG-29): bỏ `web/index.html`, `GET /`, cookie, `/api/*`, SSE, `panel.json`; mọi đường ngoài `/rpc` trả 404. Nhập tay giữ bằng `pma say --text` (RAW ghi "nhập tay"). `probe.mjs`, `doctor.py`, stop hook chuyển sang `/rpc`.
- **Follow tin cậy hơn, bề mặt model không đổi** (ENG-30):
  - con trỏ vai = chỗ đã in (`ack`), không mất lô khi follow bị ngắt;
  - một tiến trình một vai (`lease`, 90 s); MCP không lease không đổi tiến độ của vai đang có người giữ;
  - `release` trước BẬT LẠI / KẾT THÚC / DỪNG; vai share bật lại chỉ chiếu lại 40 dòng gần nhất (`BỎ QUA` không nội dung);
  - `pma picture` lưu lại cùng nội dung không tạo bản mới.
- **Tài liệu:** DECISION_LOG v0.12.0 (U26–U28, OWN-029/030, ENG-28..30, ENG-03/17 ghi đã thay), baseline v0.12, skill `hop` (brief dịch thô chỉ dùng brief/follow/translate, không in dòng `[Tôi]` riêng).
- **Sửa sau review độc lập của bản tích hợp** (agent review + peer review Codex, 01/11):
  - stop hook bảo vai dịch đọc bằng `./pma read --as <vai>` (trước đó là read đủ của owner: có thể in lời mic tắt lên màn hình share); `unread` của vai share chỉ đếm dòng nó được thấy;
  - `follow` ghim cuộc họp: mọi `next`/`read`/`release` mang `sessionId`; cuộc họp A kết thúc và B mở giữa hai lần gọi thì tiến trình A in nốt, nhả vai, `KẾT THÚC`, không bao giờ đọc/giữ/ack B; `--session` khác phiên đang mở bị từ chối;
  - `release` sau khi phiên vừa kết thúc vẫn ghi ack cuối nếu đúng phiên + vai + lease (không mở lại phiên); lease cũ hoặc phiên khác không đổi gì;
  - micro: `MIC_SHARE_OK` chỉ khi mic còn đọc là bật thêm 1,5 s sau đoạn và bản ghi đã tới mốc đó (bộ đọc nút micro trễ ~1 s); dòng micro cần cả `SOURCE_LIVE_FOLLOW`;
  - micro, sống của bộ đọc (peer review PMA-MIC-READER-LIVENESS): âm thanh còn chạy không chứng minh bộ đọc nút micro còn sống. Bộ ghi viết lại trạng thái không đổi mỗi 2 s (nhịp tim); bộ nghe chỉ gắn `MIC_SHARE_OK` khi thấy bộ đọc tự động đọc ở/trước đầu đoạn, **có một lần đọc ở/sau mốc cuối đoạn + 1,5 s** (quan sát dương qua mốc cuối, không phải lần đọc cũ kéo dài; peer review PMA-LIVENESS-BOUNDARY) và không hở quá 4 s giữa các lần đọc (`reader_alive`). Chưa có lần đọc đó lúc xử lý đoạn thì giữ lại, tiếng loa vẫn đi qua. Mục `pma me` thủ công không tính là dấu hiệu bộ đọc sống;
  - micro, nhãn thủ công (peer review PMA-MANUAL-LABEL-PUBLICATION): `pma me` (ENG-26, kỹ thuật) chỉ đổi nhãn RAW. Chia sẻ (`share_ok`) cần cả nhãn ON lẫn **bộ đọc tự động** thấy ON suốt đoạn: `--on` thủ công trên OFF/UNKNOWN tự động không được chia sẻ, `--off` thủ công trên ON tự động cũng không. Không có quyết định owner nào cho ngoại lệ này; OWN-030 (01/11) áp dụng;
  - `GIỚI HẠN` đọc `status.replay` (trước đó đọc nhầm chỗ nên không bao giờ in);
  - lỗi gọi tạm thời lúc giành vai được thử lại như vòng chính rồi `DỪNG`, không văng ra ngoài;
  - test Python cho tiếng loa thật (không im) trong lúc mic tắt.
- **Giới hạn còn mở (ghi rõ, chưa sửa):**
  - giới hạn cảm biến còn lại: không có phát hiện tắt mic tức thời: bộ đọc hỏi nút micro khoảng mỗi giây, nên một lần tắt mic chỉ thấy được ở lần hỏi sau (đã đệm 1,5 s và đòi lần đọc sau mốc đó); nếu giao diện Zoom/Meet chậm cập nhật nút hơn mức đó thì vẫn có thể lọt. Bộ đọc còn sống nhưng đọc sai nút (giao diện Zoom/Meet đổi) thì không phát hiện được: 1,5 s và nhịp tim chỉ chứng minh bộ đọc còn chạy, không chứng minh nút micro đúng;
  - `pma me --on` (thủ công) không đủ để chia sẻ khi bộ đọc tự động không chạy: lời "Tôi" lúc đó chỉ ở phiên tổng hợp/RAW;
  - lời "Tôi" lúc mic bật có thể không lên phiên dịch khi nhận dạng theo kịp sát thời gian thực (bản ghi hoặc lần đọc micro chưa tới mốc +1,5 s lúc xử lý đoạn): chọn ẩn khi thiếu bằng chứng; đo tỷ lệ này ở họp thật;
  - lệnh MCP không lease có thể đẩy con trỏ `chinh` đúng lúc lease cũ vừa hết hạn (90 s) mà tiến trình mới chưa giành lại; tiến trình cũ đang chờ có thể giành vai trước tiến trình bật lại ở phút 29;
  - tiến độ follower nằm trong bộ nhớ host, không bền qua host restart.
- **Test (worktree `pma/v5-int`):** lần chạy tích hợp đầu Node 97 qua / 1 hỏng (test đếm số lần hỏi trong cửa sổ 1 s, phụ thuộc tải máy; sửa test giữ bất biến) → 98/98. Khi sửa theo peer review micro, test host thật hỏng 1/3 lần chạy riêng (đọc cursor trước khi ack của dòng vừa in tới host ở lần hỏi kế); sửa test chờ ack, 4/4 lần qua. Sau các sửa trên: Node 100/100 (exit 0); Python 155 chạy = 154 qua + 1 bỏ qua (BuzzASR không cài) (exit 0). Không có test âm thanh thật, micro, ASR hay host thật.
- **Trạng thái:** implemented + tested trong worktree riêng. Chưa integrated vào nhánh chính của owner, chưa released, chưa used ở họp thật.

## 0.11.0 —31/10/2026

Audit thiết kế 31/10 (owner: "có vẻ bạn đang làm sai thiết kế").
- Fable 5.1 audit kiến trúc độc lập, chỉ để tham khảo. Báo cáo: `.local/drafts/AUDIT-KIEN-TRUC-20261031.md`.
- Opus quyết theo câu trả lời của owner: `docs/PLAN_0_11.md`, `docs/PRODUCT_BASELINE.md` v0.11.
- 5 agent Sonnet làm song song (R, W, H, L, C), Opus gộp và nối.

- **Định hướng:**
  - Claude trong phiên dùng công cụ phục vụ owner và cuộc họp, real-time.
  - Sống theo phiên họp, không dịch vụ chờ sẵn.
  - Việc chính là context trước họp.
  - Không thi đấu AI của Zoom/Meet.
- **Bộ ghi hộp đen** (`tools/recorder.py`, `tools/timeline.py`):
  - loa + micro → WAV khúc 10 phút + `timeline.jsonl` (giờ thật ↔ mẫu, mất mẫu, đổi thiết bị, trạng thái micro);
  - không model; lỗi thiết bị thì khúc mới ≤ 2 s;
  - sống khi host chết; chỉ dừng khi có `stop`, file `STOP` hoặc trần 12 giờ.
  - `tools/mix_audio.py` ghép `meeting-mix.wav` theo giờ thật.
  - **WAV giữ tới khi người dùng xoá.**
- **Bộ nghe đọc từ WAV** (`audio_worker.py --follow`, `tools/follow_source.py`):
  - đọc từ giây 0, đuổi kịp (thử 42 s âm thanh: xong trong 49 s kể cả 34 s nạp model);
  - lỗi ASR một đoạn thành `[KHOẢNG TRỐNG ASR]` rồi chạy tiếp;
  - `stop` đọc nốt; chạy lại sau lỗi bằng `--from-wall`.
- **Host theo phiên** (`src/daemon.ts`, `src/runtime.ts`):
  - `pma start` nạp model và tự ghi nếu nguồn loa lần trước còn;
  - không còn trần 2 giờ;
  - bộ nghe chết thì chạy lại 3 lần/10 phút; bộ ghi chết thì chạy lại;
  - host mới gắn lại phiên có bộ ghi còn sống;
  - `stop` dừng ghi → đọc nốt → ghép WAV → RAW → host thoát.
- **Nghe lại là việc của Claude:**
  - `pma recheck <#id>` hoặc `--from/--to`: nhận dạng lại từ WAV với beam 8, các phương án vi/lo/th. RAW ghi `(đã nghe lại)`.
  - `pma coverage` liệt kê chỗ có âm mà không có chữ, đoạn lỗi, đoạn không chắc.
- **Ba ngôn ngữ Việt / Lào / Thái** (`th` mới):
  - Bộ dò Whisper không tách được Lào–Thái (AUC 0,50), nên đoạn Tai chạy cả hai mô hình và chọn theo điểm (AUC 0,91 clip đủ).
  - Phương án còn lại gửi kèm (`↳ lo:`/`↳ th:`) để Claude dịch theo nghĩa.
  - FLEURS: Thái CER 11,3%, Lào 23,9% (34 clip đi `lo`), Việt 4,69%.
  - Lào/Thái tách đúng khỏi Việt 100% trên clip đủ. Đoạn ngắn 1,5–3 s: Lào 81%, Thái 59% đúng ngôn ngữ (88% đúng nhóm).
  - **Lào nghe ra chữ Thái → dịch Việt** (10 cặp, Opus chấm khi đọc chữ Thái theo âm Lào): đúng nghĩa 5, ý chính 3, sai 2 (một sai số, một bị cắt cụt). Skill dặn đọc theo âm Lào và đối chiếu số giữa hai bản.
- **Micro "Tôi" phân loại:**
  - `tools/mic_state.ps1` đọc nút micro Zoom và Meet (Chrome/Edge) qua UI Automation, chỉ đọc.
  - Đoạn "Tôi" mang nhãn mic bật / mic tắt (nói riêng) / không rõ.
  - `pma me --on/--off/--auto`.
- **Context trước họp:** `pma brief` (≤ 2 KB), `pma participants`, `pma start --participants`, `.local/context/owner.json`. Tên dễ nghe sai của người dự vào bảng tên.
- **Hai phiên khi họp (giữ):**
  - dịch thô Haiku lô 15 s = "màn hình" owner share cho người dự, gửi lô ngay khi có dòng lo/th;
  - tổng hợp Sonnet lô 60 s chat với owner.
  - `follow` tự thoát phút 29 và in `BẬT LẠI`.
  - Không build màn hình web.
- **Tài liệu:**
  - PRODUCT_BASELINE 0.11 là chỗ chốt duy nhất; DECISION_LOG có U23–U25, OWN-021..028, ENG-24..27.
  - 11 tài liệu cũ + `handoff/` sang `docs/history/`.
  - CLAUDE.md, AGENTS.md, README, project.json, skill `hop` viết lại.
- **Chạy thật trên máy owner 31/10** (Google Meet mở một mình trên Chrome, phát file công khai Việt–Lào ra loa):
  - Nút micro Meet đọc đúng: "Turn off microphone" → on, "Turn on microphone" → off, trễ ~1 s; sổ thời gian ghi đúng lúc tắt/bật.
  - Tìm và sửa hai lỗi chỉ lộ ra trên thiết bị thật: bộ ghi khoá chết khi hai luồng cùng nạp DLL (PortAudio + numpy), và micro báo `-9999` vì luồng mở thiết bị chưa khởi tạo COM.
  - Sau khi sửa:
    - lần mở phiên thứ hai bộ ghi tự chạy 2 s sau `pma start` (nhớ nguồn loa);
    - WAV loa 101,29 s, micro 100,36 s, file ghép 101,29 s;
    - `pma stop` 1 s;
    - `pma coverage` liệt kê 5 đoạn Lào/Thái chưa chắc;
    - `pma recheck #1764` (22 s) cho bản Lào đủ ý hơn;
    - host tự thoát sau 2 phút rảnh.
- **Phiên tổng hợp giữ bức tranh cả cuộc họp** (owner: "lô 60s phải đảm bảo được toàn bộ cảnh họp liên tục"):
  - `pma picture` đọc, `pma picture --file f.md --sources …` lưu bản mới;
  - `follow` của phiên tổng hợp in `CẬP NHẬT BỨC TRANH` sau mỗi lô;
  - brief chỉ bản mới nhất;
  - SUMMARY dựng từ bức tranh cuối.
- **Kiểm:**
  - 70 test Node, 122 test Python; chạy thật bộ nghe/nghe lại trên GPU bằng file công khai.
  - **Không thu âm thật để tự kiểm.** Bộ ghi với thiết bị thật, Meet UI Automation, hai phiên và họp dài sẽ kiểm ở buổi họp thật tiếp theo.

## 0.10.1 —31/10/2026

- Owner: "các đoạn là phần dịch theo dõi, còn wav phải ghi được đầy đủ". **WAV ghi mặc định** mỗi lần nghe (tắt bằng `--no-save-audio` hoặc `PMA_SAVE_AUDIO=0`), tự xoá sau 7 ngày (`--keep-days`). Worker ghi mọi khối âm thô trước khi lọc im lặng/nhận dạng, nên WAV đủ cả phần ASR bỏ qua.
- **File ghép `<lượt nghe>-mix.wav`** (16 kHz mono) do `tools/mix_audio.py` làm sau khi tạm dừng/kết thúc, chạy tiến trình riêng, không làm chậm `pause`/`stop`: loa + micro, micro chỉ cộng vào lúc người dùng nói (tránh tiếng loa lọt vào bị đôi). Dùng file này cho `pma replay`. `pma audio list` chỉ file ghép.
- Thử thật 10 s: loa 44,1 kHz 10,68 s, micro 10,59 s, file ghép 16 kHz 10,68 s. Test: 49 Node, 49 Python.

## 0.10.0 —30/10/2026

Sửa theo buổi thử thật 30/10 trên Google Meet (`docs/PLAN_0_10.md`). Opus chốt kiến trúc, 5 agent Sonnet làm song song (A–E), Opus gộp.

- **Tiếng Lào (A3, A2/B2):**
  - Model BuzzASR/lao bị CTranslate2 coi là English-only, nên từ 0.6 đến 0.9 tiếng Lào được giải mã với `<|en|>`. Đã sửa.
  - Đo trên FLEURS (GPU), sai ký tự tiếng Lào giảm: 33,2% → 24,4% (sửa lỗi trên) → 21,3% (thêm beam 5).
  - Tiếng Việt 4,33% → 4,09%.
  - Đoạn Lào ngắn 1,5–3 s nhận đúng 78,7% → 90,0%, nhờ giải mã cả hai bên khi bộ dò không chắc. Đổi lại, mảnh Việt 1–3 chữ giảm 3–5 điểm; tắt bằng `LANG_PICK_DEFAULT`.
- **Tận dụng GPU:** beam 5 trên cuda (CPU giữ 1). Đoạn âm tối thiểu 3 s trên GPU.
- **Phản hồi nhanh hơn:** `pma follow` mặc định lô 15 s (trước 60 s; đo 30/10: ASR chỉ trễ ~0,3 s, chậm nằm ở lô và chờ đủ đoạn).
- **Hai phiên theo dõi:** dịch thô (Haiku, effort low, `--batch 15 --as dich --no-notes`) và tổng hợp (Sonnet, `--batch 60`).
  - Mỗi người theo dõi có con trỏ và heartbeat riêng.
  - Stop hook giữ đúng từng phiên.
  - Skill `hop` mở phiên dịch thô ngay sau LISTENING.
- **Micro "Tôi" không phụ thuộc nền tảng (A1/B4):**
  - Bỏ đọc nút mute Zoom của 0.9.0.
  - Micro luôn mở; lấy micro mà ứng dụng họp (Zoom, trình duyệt, Teams…) đang giữ, không có thì micro mặc định Windows. Kiểm lại mỗi 30 s (`tools/mic_in_use.ps1`).
  - Tiếng loa lọt vào vẫn bị bỏ. Lời nói khi đang tắt mic trên Zoom/Meet cũng vào "Tôi".
- **Google Meet:** `--link https://meet.google.com/…` mở trình duyệt; báo cáo ghi "Google Meet <mã>".
- **Tạm dừng giữ mô hình (A9):** `pma pause` → `pma listen` có chữ ngay.
- **Số đo nạp mô hình (A4):** 1.273 s ở buổi 30/10 là thời gian chờ họp bị tính nhầm. Nay tách `modelLoadSeconds` và `waitedForSourceSeconds`.
- **Lưu âm thanh (B3, opt-in):** `pma listen --save-audio [--keep-days 7]`; WAV từng kênh trên máy, tự xoá; `pma audio [list|purge]`.
- **Lọc chữ (A5, A6):**
  - Câu bịa "video hấp dẫn", "nhấn chuông"…
  - "Cảm ơn." đứng một mình chỉ bị lọc khi đoạn gần như im lặng.
  - Vòng lặp 2–4 chữ gộp `cụm [×N]`, cả với dữ liệu cũ.
- **Giờ họp (A10):** `pma at HH:MM` sửa giờ họp theo lịch sau khi mở phiên.
- **Dịch Lào→Việt (B1):** Claude dịch trong phiên; `pma translate` lưu, RAW in `→ (Claude dịch) …`. Màn hình chung `/live` đã làm rồi bỏ theo owner (U21: họp trên session, không qua web).
- **Phát lại bản ghi Zoom 11,9 phút ở tốc độ thật (GPU, 0.10):**
  - Nạp model 13,3 s.
  - ASR trễ p50 0,4 s / p90 0,7 s / max 3,6 s.
  - Đoạn dài p50 8,4 s, p90 15,5 s.
  - 3/180 đoạn cắt cưỡng bức.
  - VRAM đỉnh 4,4 GB / 6 GB.
  - 3/180 mảnh Việt ~3 s bị gắn `lo` (có cờ ngôn ngữ không chắc).
- **Test:** 45 Node, 33 Python.

## 0.9.0 —30/10/2026

- Owner (U19): micro “Tôi” **bật mặc định** và chỉ lấy tiếng khi **nút micro Zoom đang bật**. `tools/zoom_mic_state.ps1` đọc tên nút micro trong cửa sổ họp qua Windows UI Automation và micro Zoom đang dùng qua Core Audio (chỉ đọc). Tắt mic, chưa vào họp hoặc không đọc được đều tính là tắt. Micro chọn theo micro Zoom đang dùng, không có thì micro mặc định Windows. `pma listen --no-mic` để tắt cho một buổi; `select-mic` không cần `--consent` nữa.
- Sửa theo buổi họp thật 30/10:
  - `pma follow` in mỗi đoạn một dòng; đoạn dài nối dòng `↳`, vì Monitor cắt dòng dài khoảng 500 ký tự.
  - Bảng tên từ chối biến thể quá ngắn, là từ thông dụng, hoặc đã thuộc tên khác; thêm `--force` và `pma glossary help`.
  - `start` báo lần trước nạp mô hình mất bao lâu; `listen` chờ tới 5 phút.
  - `start --at HH:MM` để RAW/SUMMARY/TASKS ghi **độ phủ** (nghe được từ–đến, lỡ bao nhiêu phút đầu).
  - `start --me "Tên"`, nhớ cho lần sau: RAW ghi `Tôi — Tên (micro)`, TASKS.md có mục **Việc của tôi**.
  - Câu “Chào mừng” đứng một mình được coi là câu ảo.
  - Skill `hop`: nhắc bật lại Monitor sau 30 phút.
- Chưa làm, để vào issue chờ thêm dữ liệu họp: phân biệt người nói, từ nghiệp vụ nghe sai, thời gian nạp mô hình lúc dài lúc ngắn, kiểm micro Zoom trên buổi họp thật.
- Test: 32 Node, 18 Python.

## 0.8.0 —29/10/2026

- Sửa theo audit 2 buổi họp 29/10 (`docs/AUDIT_HOP_20261029.md`): nạp sẵn mô hình, cắt đoạn ở chỗ yên nhất (tối đa 20 s), báo độ trễ, câu ảo xuống phụ lục, gộp đoạn lặp, bảng tên, kênh micro “Tôi”, nhắc ghi chú.

## 0.7.0 —28/10/2026

- Owner: “Nâng tiếng Việt GPU”. Model chính trên GPU là **Whisper large-v3-turbo** (MIT, tự chuyển từ bản gốc `41f01f3` bằng `tools/convert_whisper_model.py`): nhận diện vi/lo và nhận dạng tiếng Việt. Tiếng Lào vẫn qua BuzzASR/lao. Không có GPU thì về small trên CPU.
- Chọn model bằng `.local/models/asr-profile.json` (mẫu `config/asr-profile.example.json`): `main`, `lo`, và tùy chọn `vi` cho model chỉ-tiếng-Việt. Bộ thu, phát lại và nhận dạng video dùng chung.
- Đo FLEURS tiếng Việt (40 clip, toàn luồng GPU): small 9,9% → turbo **4,8%**; turbo + PhoWhisper-large 3,9%; turbo + PhoWhisper-medium 5,9%. Nhận diện ngôn ngữ với turbo: Việt 40/40, Lào 39/40; CER Lào 36,4%.
- Không chọn PhoWhisper mặc định: trên họp thật nó viết toàn chữ thường, đọc số thành chữ ("một trăm năm mươi"), sai tên viết tắt ("enancy" cho NNC), chậm hơn 1,6 lần và cần 5,4 GB VRAM (turbo: 3,6 GB).
- Video họp 28/10 (44 phút): câu ảo 35 → 18, tên "Sơn" nhận được 6 → 41 lần, "NNC" 3 → 8; xử lý 4,3 phút. Test: 25 Node, 9 Python.

## 0.6.0 —28/10/2026

- Owner: “Làm tiếng Lào GPU”. ASR chạy CUDA trên RTX 3050 (cuBLAS/cuDNN từ wheel NVIDIA, `requirements-gpu.lock.txt`); không có GPU thì tự về CPU như trước.
- Tiếng Lào: đoạn được Whisper small nhận là `lo` (gồm cả `th`) chuyển sang **BuzzASR/lao** (MIT, Whisper large-v3 fine-tune, revision `14f66e2`), chuyển sang CTranslate2 bằng `tools/convert_lao_model.py`. Sửa tokenizer: bộ từ vựng thay thế giữ tên token đặc biệt ở id thấp, model dùng id 51865+; thiếu `lang_ids` làm faster-whisper coi là model tiếng Anh và ra rỗng.
- Đo trên FLEURS (40 clip mỗi ngôn ngữ, `tools/eval_asr.py`): nhận diện ngôn ngữ 100%/100%; CER Lào 36,3% (trước: 100,2%, toàn chữ Thái), chữ Lào 3.570 / chữ Thái 0; CER Việt 9,9%; tốc độ 0,12 (Lào) và 0,06 (Việt) so với thời gian thực. FLEURS là giọng đọc, chưa phải họp.
- Phát lại file trộn công khai Việt→Lào→Lào qua `pma replay` trên GPU: đoạn Việt ra chữ Việt, đoạn Lào ra chữ Lào.
- `tools/setup_lao_gpu.sh` cài toàn bộ (thư viện CUDA, model, dữ liệu chấm điểm, môi trường chuyển đổi riêng). Test: 25 Node, 8 Python.

## 0.5.0 —28/10/2026

- Audit MCP (`docs/AUDIT_MCP_20261028.md`) theo yêu cầu owner: MCP không hợp làm lõi. Chuyển sang **dịch vụ nghe chạy nền một bản mỗi máy** (`src/daemon.ts`), **CLI `pma`** (`src/cli.ts`, `./pma`, `pma.cmd`), **skill `/hop`** (`.claude/skills/hop/SKILL.md`) và **Monitor trên `pma follow`**. MCP (`src/server.ts`) còn là lớp mỏng chuyển tiếp, không giữ trạng thái hay cổng.
- Dịch vụ được tạo qua WMI trên Windows: không kế thừa đường ống/job của lệnh gọi, sống qua khởi động lại Claude; tự thoát sau 30 phút không có phiên. RPC loopback có token trong `daemon.json`; trình duyệt bị từ chối.
- `pma follow` in text theo lô (mặc định 60 s) và gửi heartbeat; Stop hook cho phép kết thúc lượt khi có Monitor theo dõi, chặn khi không ai theo dõi; hook dùng `node:http` (fetch làm Node crash lúc thoát trên Windows, khiến quyết định chặn bị bỏ qua) và vẫn đọc được server cũ qua `panel.json`.
- `pma replay`: phát lại file ghi hình qua đúng worker, cắt đoạn và ASR; thử trên clip FLEURS tiếng Việt: 2 đoạn `vi`, báo hết phát lại, RAW đúng.
- Kiểm chứng: 25 test Node (runtime + dịch vụ/CLI/hook), 4 test Python, probe MCP qua lớp mỏng PASS. Chưa chạy trọn một cuộc họp thật với Monitor.

## 0.4.0 —28/10/2026

- Owner (U16–U17): host Claude Code; chỉ Claude là AI, công cụ âm thanh/ASR/dịch mã nguồn mở chạy trên máy; theo dõi đến khi người dùng kết thúc; mọi thao tác qua Claude. Ghi OWN-013..016, ENG-14..16; backlog `docs/V0_4_BACKLOG.md`.
- T01: Stop hook giữ lượt khi đang họp (`tools/meeting_stop_hook.mjs`), cài cục bộ ở `.claude/settings.local.json`.
- T02: tool `source_select` + `source_list.suggested`; không cần mở trình duyệt để cấp quyền nguồn loa.
- T04/T05: quá tải ASR ghi khoảng trống thay vì dừng; câu ảo khi im lặng, lặp từ và tiếng Lào chữ Thái được gắn cờ (dùng chung cho bộ thu và `tools/transcribe_recording.py`).
- T06: `session_status`/`hearing_pause`/`session_finish` trả bản gọn (< 4 KB); phiên bị bỏ dở do crash kết thúc ở thời điểm có nguồn cuối cùng.
- Thêm `tools/transcribe_recording.py`: nhận dạng lại file ghi hình họp trên máy thành một RAW.md.
- Kiểm chứng: 20 contract test, 4 test Python, probe 17 tools, hook thử với phiên không liên quan (cho dừng) và phiên đang họp (chặn). Chưa đo hook trong cả một cuộc họp thật.

## 0.3.0 —28/10/2026

- Owner (U12–U14): nghe họp từ link Zoom + nội dung, sau họp có RAW + Summary + Task; bộ công cụ dùng được cho host không phải Claude. Ghi OWN-009..011; OWN-009 thay phần “không tự mở link/Join” của OWN-007.
- Lần chạy thật đầu tiên 28/10 qua Claude Code: G243FW không nhận khung âm nào vì Zoom phát ra loa mặc định Realtek. Thêm đo mức âm từng nguồn loa (không mở microphone), chọn sẵn nguồn có tiếng trên bảng, phát im lặng giữ khung âm loopback, cảnh báo nguồn im lặng quá 30 giây, bỏ dừng phiên khi tràn bộ đệm và không đưa đoạn hoàn toàn im lặng vào ASR.
- Tools mới: `meeting_open`, `report_raw`, `report_save_summary`, `report_save_tasks`; `session_prepare` nhận agenda; `history_read` đọc 100 đoạn/trang. `session_finish` tự ghi RAW.md. Agenda đã lưu của ngày khác không còn được dùng làm context.
- Bảng: bỏ chữ Claude cố định, thêm Tải RAW/Summary/Task và lời giao việc mới. Thêm `handoff/MEETING_START.vi.txt` và `tools/mcp_config.py` in cấu hình cho Claude Code, Claude Desktop, Codex, Antigravity.
- Owner (U15): nghe lẫn Việt–Lào (OWN-012). Mỗi đoạn được chọn vi/lo, có nhãn ngôn ngữ trên bảng/RAW/tools; `session_prepare(languages)` mặc định `[vi, lo]`. Đo trên clip tiếng Việt công khai: vẫn chọn vi, ~5,3s cho 11,3s âm (chỉ vi ~3,4s; máy đang chạy song song một phiên ASR khác). Ép tiếng Lào với whisper small ra chữ Thái: gắn cờ, nội dung tiếng Lào chưa dùng được. Gộp sửa nóng của phiên họp 28/10: điểm Thái tính vào Lào, đoạn tối thiểu 6 giây khi nghe hai thứ tiếng, `max_new_tokens=160` chống lặp.
- Kiểm chứng: 17 contract test, protocol probe 16 tools, kiểm tra keepalive trên G243FW im lặng, bảng chọn đúng nguồn có tiếng. Chưa có phiên họp đầy đủ chạy bản 0.3.0, chưa thử Codex/Antigravity thật.

## 0.2.0 —26/10/2026

- Owner bổ sung pilot chiều nay: chỉ tiếng Việt, không phiên dịch; nguồn G243FW, chủ động tự restart Claude sau. Không thực hiện restart/capture test thay người dùng.
- Dựng local MCP tools, SQLite text/history/export, panel loopback và WASAPI/faster-whisper worker. Agent đọc nguồn/context và ghi chú có nguồn khi được yêu cầu.
- Pin dependencies/model; PyAV 16.0.1 sửa lỗi tương thích decode quan sát ở 19.0.2. Audio cuộc họp chỉ RAM, scope/capture hữu hạn, giữ sở hữu recorder qua STOP và có parent watchdog.
- Kiểm tra offline contracts, SDK protocol/HTTP, browser UI, resampling/watchdog và một file tiếng Việt công khai. Chưa actual Claude/device/continuous-agent/Human UAT.
- Lần chỉnh MCP config có backup/readback bị app đang chạy ghi đè; thêm installer chỉ apply khi Claude đã thoát, cùng runbook/prompt. Owner sẽ tự thoát, hoàn tất cài và mở lại. Snapshot v0.2.0 phản ánh phạm vi/evidence hiện tại; giữ tag baseline v0.1.0.

## 0.1.0 —26/10/2026

- Khóa 7 quyết định người dùng: dự án riêng, thay host được, Claude Desktop trước, bảng dịch V1, lưu text/audio tạm, agent làm chủ workflow và hỗ trợ cuộc họp đã mở.
- Điều chỉnh khung ban đầu thành bộ tools quanh agent; bỏ hỏi đáp khỏi V1, bổ sung cách dùng và vòng đời phiên/dữ liệu.
- Lập baseline kỹ thuật local MCP, TypeScript/Node, panel cá nhân, source/revision/STOP và giới hạn tài nguyên; các lựa chọn kỹ thuật mang nhãn ENGINEERING_BASELINE.
- Ghi nguồn công khai và kế hoạch kiểm chứng Claude Desktop, đặc biệt vòng tools qua turn boundary và nguồn audio/ASR.
- Thêm ma trận nghiệm thu, quy tắc đổi baseline và kiểm tra snapshot SHA-256. Chưa có runtime hoặc thử tích hợp/live.

## Khởi tạo —26/10/2026

Commit `1f4270b`: tạo repository và tài liệu nền độc lập. Bản đó là lịch sử; v0.1.0 hiện hành thay thế các mô tả phạm vi/kiến trúc ban đầu có khác biệt.
