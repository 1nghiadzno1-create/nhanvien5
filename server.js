const express = require("express");
const cors = require("cors");
const PayOS = require("@payos/node");

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// CẤU HÌNH THÔNG TIN KẾT NỐI PAYOS CỦA BẠN
// Lấy từ: my.payos.vn -> Thiết lập -> Mã kết nối
// ==========================================
const PAYOS_CLIENT_ID = "7ca4fc7f-bad2-471f-b1e2-36410e72d034";
const PAYOS_API_KEY = "3dfb8e70-6e8c-4d9b-8ae1-72598b0c74e4";
const PAYOS_CHECKSUM_KEY = "685977fdc74fb574aac19cbf28a76b4791f663449248deb4bb4fbea7f43a58ea";

let payosInstance = null;
try {
    if (PAYOS_CLIENT_ID !== "YOUR_CLIENT_ID_HERE") {
        payosInstance = new PayOS(PAYOS_CLIENT_ID, PAYOS_API_KEY, PAYOS_CHECKSUM_KEY);
        console.log("Đã khởi tạo kết nối PayOS thành công!");
    } else {
        console.warn("⚠️ Cảnh báo: Chưa điền thông tin kết nối PayOS (Client ID, API Key, Checksum Key). Vui lòng điền vào server.js để chạy.");
    }
} catch (e) {
    console.error("Lỗi khởi tạo PayOS:", e.message);
}

// API Tạo link thanh toán đơn hàng
app.post("/create-payment-link", async (req, res) => {
    if (!payosInstance) {
        return res.status(400).json({
            error: 1,
            message: "Chưa cấu hình API Key của PayOS trên Server. Vui lòng mở server.js và điền thông tin."
        });
    }

    try {
        const { orderCode, amount, description } = req.body;

        // Tạo cấu hình đơn thanh toán PayOS
        const paymentData = {
            orderCode: Number(orderCode),
            amount: Number(amount),
            description: description.substring(0, 25), // PayOS quy định độ dài miêu tả max 25 ký tự không dấu
            cancelUrl: "http://localhost:3000/cancel",
            returnUrl: "http://localhost:3000/success"
        };

        const response = await payosInstance.createPaymentLink(paymentData);
        res.json({
            error: 0,
            message: "Success",
            data: response
        });
    } catch (error) {
        console.error("Lỗi khi tạo link thanh toán PayOS:", error);
        res.status(500).json({
            error: 2,
            message: error.message
        });
    }
});

// API Kiểm tra trạng thái giao dịch (dành cho client-side polling)
app.get("/check-payment-status/:orderId", async (req, res) => {
    if (!payosInstance) {
        return res.status(400).json({
            error: 1,
            message: "Chưa cấu hình API Key của PayOS."
        });
    }

    try {
        const orderId = req.params.orderId;
        const response = await payosInstance.getPaymentLinkInformation(orderId);
        res.json({
            error: 0,
            message: "Success",
            data: {
                status: response.status // Trạng thái: "PAID", "PENDING", "CANCELLED", etc.
            }
        });
    } catch (error) {
        console.error("Lỗi khi lấy thông tin thanh toán:", error);
        res.status(500).json({
            error: 3,
            message: error.message
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("=========================================");
    console.log(`🚀 Server PayOS POS đang chạy tại: http://localhost:${PORT}`);
    console.log("=========================================");
});
