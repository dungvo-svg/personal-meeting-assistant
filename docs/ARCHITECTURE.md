# Kiến trúc agent và tools

Đặc tả hiện hành: [TECHNICAL_BASELINE.md](TECHNICAL_BASELINE.md). Quyền quyết định sản phẩm: [PRODUCT_BASELINE.md](PRODUCT_BASELINE.md).

```text
Người dùng giao mục tiêu -> AI agent trong Claude Desktop
                              | chọn và gọi tools
                              v
                     Bộ tools cá nhân trên máy
                     /          |           \
                  Tai        Context      Bảng dịch + text store
```

Agent chủ động chuẩn bị phiên, kích hoạt tai, nhận nguồn/context, dịch và công bố bản dịch. Bộ tools quản lý nguồn và tài nguyên, kiểm tra scope, lưu text và thực hiện STOP độc lập khi agent bận.

Local MCP/stdio và TypeScript/Node là đường triển khai đầu tiên theo ENG-01/ENG-02; runtime pilot tiếng Việt đã dựng, host/device proof còn chờ. Khả năng agent tiếp tục vòng tools trong Claude Desktop phải được chứng minh theo FP-02/FP-03 trước khi tuyên bố dịch trực tiếp.

Trong pilot hôm nay, bộ tai chạy ASR tiếng Việt cục bộ và bảng hiện transcript trực tiếp; Claude đọc nguồn/context và công bố hỗ trợ khi được yêu cầu. Không thực hiện phiên dịch. Đây là scope mới OWN-008; xem [runbook](PILOT_RUNTIME_20261026.md).

Không có shared translation core/runtime/event package/queue/database hoặc dịch vụ AIOS. Các host khác có thể dùng cùng hợp đồng tool của dự án cá nhân qua integration phù hợp, sau khi được chọn và kiểm chứng.
