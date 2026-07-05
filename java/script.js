import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getDatabase, ref, set, update, get, onValue } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyD-oPRRgeGfR3WrbjR7pUTpnbjNpU20Wa0",
    authDomain: "posmini-701b0.firebaseapp.com",
    databaseURL: "https://posmini-701b0-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "posmini-701b0",
    storageBucket: "posmini-701b0.appspot.com",
    messagingSenderId: "1066807592145",
    appId: "1:1066807592145:web:a3583ca77c288d82f431f0"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

let cart = {};
let currentOrderId = 1;
let pointsRules = [];

const barcodeInput = document.getElementById("barcodeInput");
const cartItemsEl = document.getElementById("cartItems");
const orderIdEl = document.getElementById("orderId");
const noteEl = document.getElementById("note") || { value: "" };

let selectedPaymentMethod = null;
const paymentModal = document.getElementById("paymentModal");
const btnCloseModal = document.getElementById("btnCloseModal");
const btnStaffPayCash = document.getElementById("btnStaffPayCash");
const btnStaffPayQr = document.getElementById("btnStaffPayQr");
const paymentActions = document.getElementById("paymentActions");
const paymentStatusText = document.getElementById("paymentStatusText");
const btnConfirmPayment = document.getElementById("btnConfirmPayment");

// --- PAYOS AUTOMATIC PAYMENT DETECTION CONFIG ---
let payosPollingInterval = null;
const PAYOS_SERVER_URL = "https://oder-0ami.onrender.com"; // Thay link Render của bạn vào đây sau khi deploy (vd: https://payos-pos-server.onrender.com)

// --- FACE RECOGNITION VARIABLES ---
let labeledFaceDescriptors = [];
let faceMatcher = null;
let currentCustomer = null;
let isCameraRunning = false;
let isCameraDisabledForSession = false;
let faceDetectionTimeout = null;
let firstFaceDetectedTime = null;
const FACE_MATCH_THRESHOLD = 0.30; // Ngưỡng nhận diện (khoảng cách sai lệch tối đa = 0.30, tương đương độ khớp tối thiểu 70% để nhận diện khách hàng)



async function loadModels() {
    let modelPath = '../models';
    try {
        console.log("Attempting to load models from: " + modelPath);
        await faceapi.nets.tinyFaceDetector.loadFromUri(modelPath);
        await faceapi.nets.faceLandmark68Net.loadFromUri(modelPath);
        await faceapi.nets.faceRecognitionNet.loadFromUri(modelPath);
        console.log("Models loaded successfully from: " + modelPath);
    } catch (e) {
        console.warn("Failed to load models from " + modelPath + ", falling back to './models'...");
        modelPath = './models';
        try {
            await faceapi.nets.tinyFaceDetector.loadFromUri(modelPath);
            await faceapi.nets.faceLandmark68Net.loadFromUri(modelPath);
            await faceapi.nets.faceRecognitionNet.loadFromUri(modelPath);
            console.log("Models loaded successfully from fallback: " + modelPath);
        } catch (err) {
            console.error("Critical error: Could not load face-api models from any path!", err);
        }
    }
}

async function fetchCustomers() {
    try {
        const snap = await get(ref(db, "customers"));
        if (snap.exists()) {
            const data = snap.val();
            labeledFaceDescriptors = [];
            for (let id in data) {
                if (data[id] && data[id].descriptor) {
                    const rawDesc = data[id].descriptor;
                    // Chuyển đổi an toàn từ Array hoặc Object có key số từ Firebase sang Float32Array
                    const descArray = new Float32Array(
                        Array.isArray(rawDesc) 
                        ? rawDesc 
                        : Object.keys(rawDesc).sort((a, b) => Number(a) - Number(b)).map(k => Number(rawDesc[k]))
                    );
                    
                    if (descArray.length === 128) {
                        labeledFaceDescriptors.push(new faceapi.LabeledFaceDescriptors(id, [descArray]));
                    } else {
                        console.warn(`Bỏ qua khách hàng ${id} do độ dài vector descriptor không hợp lệ (${descArray.length} chiều, yêu cầu 128 chiều).`);
                    }
                }
            }
            if (labeledFaceDescriptors.length > 0) {
                faceMatcher = new faceapi.FaceMatcher(labeledFaceDescriptors, FACE_MATCH_THRESHOLD);
                console.log(`Đã tải thành công ${labeledFaceDescriptors.length} khách hàng từ Firebase.`);
            } else {
                faceMatcher = null;
                console.log("Không có khách hàng hợp lệ nào được tải để khởi tạo FaceMatcher.");
            }
        } else {
            faceMatcher = null;
            console.log("Cơ sở dữ liệu khách hàng trống.");
        }
    } catch (e) {
        console.error("Lỗi nghiêm trọng khi tải danh sách khách hàng từ Firebase:", e);
    }
}

// --- MASK DETECTION UTILITIES ---
const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d');

function getAverageColor(ctx, centerX, centerY, size) {
    const x = Math.round(centerX);
    const y = Math.round(centerY);
    const half = Math.floor(size / 2);
    const imgData = ctx.getImageData(Math.max(0, x - half), Math.max(0, y - half), size, size);
    const data = imgData.data;
    let r = 0, g = 0, b = 0, count = 0;
    for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count++;
    }
    return {
        r: Math.round(r / count),
        g: Math.round(g / count),
        b: Math.round(b / count)
    };
}

function getPixelVariance(ctx, centerX, centerY, size) {
    const x = Math.round(centerX);
    const y = Math.round(centerY);
    const half = Math.floor(size / 2);
    const imgData = ctx.getImageData(Math.max(0, x - half), Math.max(0, y - half), size, size);
    const data = imgData.data;
    let grayValues = [];
    for (let i = 0; i < data.length; i += 4) {
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        grayValues.push(gray);
    }
    const mean = grayValues.reduce((a, b) => a + b, 0) / grayValues.length;
    const sqDiffSum = grayValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0);
    return Math.sqrt(sqDiffSum / grayValues.length);
}

function checkIsWearingMask(video, landmarks) {
    // Đã vô hiệu hóa tính năng nhận diện khẩu trang theo yêu cầu của người dùng
    return false;
}
// --- END MASK DETECTION UTILITIES ---

async function startCameraAndRecognize() {
    if (isCameraDisabledForSession) return;
    if (isCameraRunning) return;
    isCameraRunning = true;
    document.getElementById('camera-container').classList.remove('hidden');
    document.getElementById('customerPanel').classList.remove('hidden');

    const video = document.getElementById('videoElement');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;
        await video.play(); // Yêu cầu video phát lập tức để tránh trình duyệt trì hoãn (autoplay delay)
    } catch (e) {
        console.error("Camera error:", e);
        document.getElementById('cameraStatus').innerText = "Lỗi Camera!";
        return;
    }

    const startDetection = () => {
        const canvas = document.getElementById('overlayCanvas');

        // Đảm bảo video đã có kích thước thực tế để không bị chia tỷ lệ 0x0
        if (video.videoWidth === 0 || video.videoHeight === 0) {
            setTimeout(startDetection, 50);
            return;
        }

        const displaySize = { width: video.videoWidth, height: video.videoHeight };
        faceapi.matchDimensions(canvas, displaySize);

        async function detectFrame() {
            if (!isCameraRunning || currentCustomer) return;

            try {
                // Nhận diện cực nhanh bằng cách giảm kích thước đầu vào tinyFaceDetector (mặc định 416, giảm còn 224)
                const detections = await faceapi.detectSingleFace(
                    video,
                    new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 })
                ).withFaceLandmarks().withFaceDescriptor();

                if (!isCameraRunning || currentCustomer) return;

                if (detections) {
                    const resizedDetections = faceapi.resizeResults(detections, displaySize);

                    // --- MASK DETECTION CHECK ---
                    const isWearingMask = checkIsWearingMask(video, detections.landmarks);
                    if (isWearingMask) {
                        document.getElementById('cameraStatus').innerText = "⚠️ Phát hiện đeo khẩu trang! Vui lòng bỏ khẩu trang để tích điểm.";

                        // Vẽ khung màu đỏ báo lỗi đeo khẩu trang
                        const drawBox = new faceapi.draw.DrawBox(resizedDetections.detection.box, {
                            label: "Đeo khẩu trang / Mask",
                            boxColor: '#ff3366',
                            drawLabelOptions: {
                                fontSize: 13,
                                fontColor: '#ffffff',
                                boxColor: 'rgba(255, 51, 102, 0.9)',
                                padding: 4
                            }
                        });
                        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
                        drawBox.draw(canvas);

                        firstFaceDetectedTime = null; // Reset bộ đếm đăng ký khách mới

                        // Tiếp tục vòng quét sau 100ms
                        if (isCameraRunning && !currentCustomer) {
                            faceDetectionTimeout = setTimeout(detectFrame, 100);
                        }
                        return;
                    }
                    // --- END MASK DETECTION CHECK ---

                    let matchLabel = "unknown";
                    let matchDistance = 1.0;
                    if (faceMatcher) {
                        const bestMatch = faceMatcher.findBestMatch(detections.descriptor);
                        matchDistance = bestMatch.distance;
                        if (bestMatch.distance < FACE_MATCH_THRESHOLD) {
                            matchLabel = bestMatch.label;
                        }
                    }

                    const confidence = Math.round((1 - matchDistance) * 100);
                    const labelText = matchLabel !== "unknown" ? `${matchLabel} (${confidence}%)` : `Chưa rõ (${confidence}%)`;

                    // Vẽ khung màu vàng hổ phách và hiển thị tên cùng tỷ lệ % giống nhau
                    const drawBox = new faceapi.draw.DrawBox(resizedDetections.detection.box, {
                        label: labelText,
                        boxColor: '#ffb300',
                        drawLabelOptions: {
                            fontSize: 13,
                            fontColor: '#ffffff',
                            boxColor: 'rgba(22, 24, 33, 0.9)',
                            padding: 4
                        }
                    });
                    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
                    drawBox.draw(canvas);

                    if (matchLabel !== "unknown") {
                        // Khách cũ: nhận diện được ngay lập tức
                        const custSnap = await get(ref(db, `customers/${matchLabel}`));
                        if (custSnap.exists()) {
                            const cData = custSnap.val();

                            // Di chuyển dữ liệu cũ thành vouchers thực tế (nếu chưa di chuyển)
                            await migrateCustomerVouchers(matchLabel, cData, pointsRules);

                            // Tải danh sách voucher khả dụng từ DB
                            const availableVouchers = await getAvailableVouchers(matchLabel);

                            currentCustomer = {
                                id: matchLabel,
                                totalSpent: cData.totalSpent || 0,
                                vouchersUsed: cData.vouchersUsed || 0,
                                availableVouchers: availableVouchers
                            };
                            document.getElementById('customerName').innerText = matchLabel;
                            document.getElementById('cameraStatus').innerText = `Nhận diện: ${matchLabel} (Khớp ${confidence}%)`;

                            renderCart();
                            firstFaceDetectedTime = null; // Reset bộ đếm
                        }
                    } else {
                        // Chưa nhận dạng được (unknown)
                        if (firstFaceDetectedTime === null) {
                            firstFaceDetectedTime = Date.now();
                        }

                        const elapsedSeconds = (Date.now() - firstFaceDetectedTime) / 1000;
                        if (elapsedSeconds >= 3) {
                            // Đã quét 3 giây mà không khớp -> Đăng ký là khách hàng mới
                            const newId = "Khach_" + Math.floor(Math.random() * 9000 + 1000);
                            document.getElementById('cameraStatus').innerText = `Đã lưu khách mới: ${newId}`;
                            document.getElementById('customerName').innerText = newId;

                            const descArray = Array.from(detections.descriptor);
                            currentCustomer = { id: newId, totalSpent: 0, vouchersUsed: 0, availableVouchers: [], isNew: true };
                            await set(ref(db, `customers/${newId}`), {
                                descriptor: descArray,
                                totalSpent: 0,
                                vouchersUsed: 0
                            });
                            renderCart();

                            labeledFaceDescriptors.push(new faceapi.LabeledFaceDescriptors(newId, [detections.descriptor]));
                            faceMatcher = new faceapi.FaceMatcher(labeledFaceDescriptors, FACE_MATCH_THRESHOLD);
                            firstFaceDetectedTime = null; // Reset bộ đếm
                        } else {
                            // Đang trong thời gian chờ nhận diện (dưới 3 giây)
                            const remaining = Math.ceil(3 - elapsedSeconds);
                            document.getElementById('cameraStatus').innerText = `Đang quét khuôn mặt... (Độ khớp: ${confidence}%) (Lưu mới trong ${remaining}s)`;
                        }
                    }
                } else {
                    // Không phát hiện khuôn mặt -> Reset bộ đếm thời gian và xóa box vẽ cũ
                    firstFaceDetectedTime = null;
                    document.getElementById('cameraStatus').innerText = "Đang quét khuôn mặt...";
                    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
                }
            } catch (err) {
                console.error("Lỗi nhận diện khuôn mặt:", err);
            }

            // Tiếp tục vòng quét sau 100ms
            if (isCameraRunning && !currentCustomer) {
                faceDetectionTimeout = setTimeout(detectFrame, 100);
            }
        }

        detectFrame();
    };

    // Kiểm tra xem video đã sẵn sàng hay chưa, nếu rồi chạy luôn, không thì lắng nghe sự kiện 'playing'
    if (video.readyState >= 2 && video.videoWidth > 0) {
        startDetection();
    } else {
        video.addEventListener('playing', startDetection);
    }
}



function stopCamera() {
    if (!isCameraRunning) return;
    isCameraRunning = false;
    if (faceDetectionTimeout) clearTimeout(faceDetectionTimeout);
    const video = document.getElementById('videoElement');
    if (video.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
    }
    document.getElementById('camera-container').classList.add('hidden');
    document.getElementById('customerPanel').classList.add('hidden');
    document.getElementById('customerName').innerText = "Đang nhận diện...";

    // Clear canvas
    const canvas = document.getElementById('overlayCanvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    currentCustomer = null;
    firstFaceDetectedTime = null;
}

async function warmUpModel() {
    try {
        console.log("Warming up face-api models...");
        const dummyCanvas = document.createElement('canvas');
        dummyCanvas.width = 32;
        dummyCanvas.height = 32;
        // Chạy một lượt dự đoán rỗng để biên dịch shader (WebGL) và khởi tạo TensorFlow.js
        await faceapi.detectSingleFace(dummyCanvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 224 })).withFaceLandmarks().withFaceDescriptor();
        console.log("Face-api models warmed up successfully!");
    } catch (e) {
        console.warn("Failed to warm up models:", e);
    }
}
// --- END FACE RECOGNITION ---

async function init() {
    try {
        const rulesSnap = await get(ref(db, "settings/points_rules"));
        if (rulesSnap.exists()) {
            const val = rulesSnap.val();
            pointsRules = Object.keys(val).map(key => ({ id: key, ...val[key] }));
        } else {
            pointsRules = [];
        }
        if (pointsRules.length === 0) {
            const pointsSnap = await get(ref(db, "settings/points"));
            if (pointsSnap.exists()) {
                const oldConfig = pointsSnap.val();
                if (oldConfig && oldConfig.threshold && oldConfig.value) {
                    pointsRules.push({
                        id: "default_old",
                        threshold: Number(oldConfig.threshold),
                        value: Number(oldConfig.value)
                    });
                }
            }
            if (pointsRules.length === 0) {
                pointsRules.push({
                    id: "default",
                    threshold: 100000,
                    value: 10000
                });
            }
        }
    } catch (e) {
        console.error("Lỗi khi tải cấu hình tích điểm:", e);
    }

    const chkUseVoucher = document.getElementById("chkUseVoucher");
    if (chkUseVoucher) {
        chkUseVoucher.addEventListener("change", () => {
            renderCart();
        });
    }

    const selVoucher = document.getElementById("selVoucher");
    if (selVoucher) {
        selVoucher.addEventListener("change", () => {
            renderCart();
        });
    }

    const btnResetCustomer = document.getElementById("btnResetCustomer");
    if (btnResetCustomer) {
        btnResetCustomer.addEventListener("click", async () => {
            currentCustomer = null;
            isCameraDisabledForSession = false;
            await update(ref(db, "current_order"), {
                customerId: null,
                isNewCustomer: false,
                saveInfo: null
            });
            stopCamera();
            startCameraAndRecognize();
            renderCart();
        });
    }

    const snap = await get(ref(db, "currentOrderId"));
    currentOrderId = snap.exists() ? snap.val() : 1;
    orderIdEl.innerText = currentOrderId;

    const orderSnap = await get(ref(db, `orders/${currentOrderId}`));
    if (orderSnap.exists() && orderSnap.val().items) {
        cart = orderSnap.val().items;
        renderCart();
    }
    barcodeInput.focus();

    await loadModels();
    await warmUpModel(); // Khởi động nóng model ngay khi load xong để khi bật camera chạy được ngay lập tức
    await fetchCustomers();
}

window.addItem = async (id, name, price, stock) => {
    if (!isCameraRunning && !isCameraDisabledForSession) {
        startCameraAndRecognize();
    }

    let currentQtyInCart = cart[id] ? cart[id].qty : 0;

    if (currentQtyInCart + 1 > stock) {
        alert(`❌ Không thể thêm! Sản phẩm "${name}" chỉ còn ${stock} món trong kho.`);
        return;
    }

    if (!cart[id]) {
        cart[id] = { name: name, price: price, qty: 1 };
    } else {
        cart[id].qty++;
    }
    renderCart();
    await set(ref(db, `orders/${currentOrderId}/items`), cart);
};

window.changeQty = async (id, d) => {
    if (d > 0) {
        const pSnap = await get(ref(db, `products/${id}`));
        if (pSnap.exists()) {
            const stock = pSnap.val().stock || 0;
            if (cart[id].qty + 1 > stock) {
                alert(`❌ Trong kho chỉ còn ${stock} sản phẩm!`);
                return;
            }
        }
    }

    cart[id].qty += d;
    if (cart[id].qty <= 0) delete cart[id];
    renderCart();
    if (Object.keys(cart).length === 0) {
        await set(ref(db, `orders/${currentOrderId}/items`), null);
    } else {
        await set(ref(db, `orders/${currentOrderId}/items`), cart);
    }
};

// --- SYNC TO CUSTOMER SCREEN ---
// Hàm di chuyển dữ liệu điểm cũ thành các thực thể voucher trong DB
async function migrateCustomerVouchers(customerId, cData, pointsRules) {
    if (!cData || cData.vouchersMigrated || !pointsRules || pointsRules.length === 0) {
        return;
    }

    try {
        const totalSpent = cData.totalSpent || 0;
        const prevVouchersUsed = cData.vouchersUsed || 0;

        // Lấy tất cả voucher hiện có của customer trong DB
        const vouchersSnap = await get(ref(db, "vouchers"));
        let customerVouchers = [];
        if (vouchersSnap.exists()) {
            const allVouchers = vouchersSnap.val();
            for (let vid in allVouchers) {
                if (allVouchers[vid].customerId === customerId) {
                    customerVouchers.push({ id: vid, ...allVouchers[vid] });
                }
            }
        }

        // Đồng bộ/Cập nhật ruleId cho các voucher cũ (nếu thiếu ruleId)
        for (let ev of customerVouchers) {
            if (!ev.ruleId) {
                const matchingRule = pointsRules.find(r => r.value === ev.value);
                if (matchingRule) {
                    ev.ruleId = matchingRule.id;
                    await update(ref(db, `vouchers/${ev.id}`), { ruleId: matchingRule.id });
                }
            }
        }

        const dbUsedCount = customerVouchers.filter(v => v.status === "used").length;
        let remainingUsedToCreate = Math.max(0, prevVouchersUsed - dbUsedCount);

        for (let rule of pointsRules) {
            const earnedCount = Math.floor(totalSpent / rule.threshold);
            const ruleVouchers = customerVouchers.filter(v => v.ruleId === rule.id);
            const existingCount = ruleVouchers.length;
            const needed = earnedCount - existingCount;

            if (needed > 0) {
                for (let i = 0; i < needed; i++) {
                    const voucherId = "Voucher_" + Date.now() + "_" + Math.floor(Math.random() * 1000) + "_" + rule.id + "_" + i;
                    const voucherCode = "V_" + Math.random().toString(36).substr(2, 6).toUpperCase();

                    let status = "available";
                    if (remainingUsedToCreate > 0) {
                        status = "used";
                        remainingUsedToCreate--;
                    }

                    await set(ref(db, `vouchers/${voucherId}`), {
                        code: voucherCode,
                        customerId: customerId,
                        value: rule.value,
                        status: status,
                        ruleId: rule.id,
                        createdAt: new Date().toLocaleString()
                    });
                }
            }
        }

        await update(ref(db, `customers/${customerId}`), { vouchersMigrated: true });
        console.log(`Đã di chuyển thành công voucher cho khách hàng: ${customerId}`);
    } catch (e) {
        console.error("Lỗi khi di chuyển voucher:", e);
    }
}

// Hàm lấy danh sách voucher khả dụng từ DB
async function getAvailableVouchers(customerId) {
    let availableVouchers = [];
    try {
        const vouchersSnap = await get(ref(db, "vouchers"));
        if (vouchersSnap.exists()) {
            const allVouchers = vouchersSnap.val();
            for (let vid in allVouchers) {
                if (allVouchers[vid].customerId === customerId && allVouchers[vid].status === "available") {
                    availableVouchers.push({ id: vid, ...allVouchers[vid] });
                }
            }
        }
    } catch (e) {
        console.error("Lỗi lấy danh sách voucher:", e);
    }
    return availableVouchers;
}

function updateVoucherDisplay() {
    const customerPanelEl = document.getElementById("customerPanel");
    const customerNameEl = document.getElementById("customerName");
    const customerVouchersEl = document.getElementById("customerVouchers");
    const voucherApplyContainer = document.getElementById("voucherApplyContainer");
    const selVoucher = document.getElementById("selVoucher");
    const chkUseVoucher = document.getElementById("chkUseVoucher");

    if (currentCustomer) {
        if (customerPanelEl) {
            customerPanelEl.classList.remove("hidden");
        }
        if (customerNameEl) {
            customerNameEl.innerText = currentCustomer.id;
        }

        const availableVouchers = currentCustomer.availableVouchers || [];
        const availableCount = availableVouchers.length;

        if (customerVouchersEl) {
            customerVouchersEl.innerText = `Có ${availableCount} voucher`;
            customerVouchersEl.classList.remove("hidden");
        }

        if (availableCount > 0) {
            if (voucherApplyContainer) voucherApplyContainer.classList.remove("hidden");
            if (selVoucher) {
                selVoucher.innerHTML = availableVouchers.map(v =>
                    `<option value="${v.id}" data-value="${v.value}">${v.code} (Giảm ${v.value.toLocaleString()}đ)</option>`
                ).join("");
            }
        } else {
            if (voucherApplyContainer) voucherApplyContainer.classList.add("hidden");
            if (chkUseVoucher) chkUseVoucher.checked = false;
            if (selVoucher) selVoucher.innerHTML = "";
        }
    } else {
        if (customerPanelEl) {
            customerPanelEl.classList.add("hidden");
        }
        if (customerNameEl) {
            customerNameEl.innerText = "Đang nhận diện...";
        }
        if (customerVouchersEl) {
            customerVouchersEl.classList.add("hidden");
        }
        if (voucherApplyContainer) voucherApplyContainer.classList.add("hidden");
        if (chkUseVoucher) chkUseVoucher.checked = false;
        if (selVoucher) selVoucher.innerHTML = "";
    }
}

async function syncToCustomer(statusOverride = null) {
    let total = 0;
    for (let id in cart) {
        total += (Number(cart[id].price) || 0) * (Number(cart[id].qty) || 0);
    }

    let discountAmount = 0;
    const chkUseVoucher = document.getElementById("chkUseVoucher");
    const selVoucher = document.getElementById("selVoucher");
    if (currentCustomer && chkUseVoucher && chkUseVoucher.checked && selVoucher && selVoucher.value) {
        const selectedOption = selVoucher.options[selVoucher.selectedIndex];
        if (selectedOption) {
            discountAmount = Number(selectedOption.getAttribute("data-value")) || 0;
        }
    }

    let finalTotal = Math.max(0, total - discountAmount);

    let status = "ordering";
    if (statusOverride) {
        status = statusOverride;
    } else if (currentCustomer && currentCustomer.isNew) {
        status = "ask_save_info";
    }

    await set(ref(db, "current_order"), {
        orderId: currentOrderId,
        items: cart,
        total: finalTotal,
        discount: discountAmount,
        status: status,
        customerId: currentCustomer ? currentCustomer.id : null,
        isNewCustomer: (currentCustomer && currentCustomer.isNew) ? true : false
    });
}

// Lắng nghe phản hồi lưu thông tin khách hàng từ màn hình khách
onValue(ref(db, "current_order"), async (snapshot) => {
    const data = snapshot.val();
    if (!data) return;

    // Khách chọn "KHÔNG CẦN" lưu thông tin
    if (data.saveInfo === false && currentCustomer && currentCustomer.isNew) {
        const tempCustId = currentCustomer.id;

        // 1. Xóa thông tin khách hàng vừa lưu trong database
        await set(ref(db, `customers/${tempCustId}`), null);

        // 2. Loại bỏ khuôn mặt trong danh sách nhận diện local
        labeledFaceDescriptors = labeledFaceDescriptors.filter(d => d.label !== tempCustId);
        if (labeledFaceDescriptors.length > 0) {
            faceMatcher = new faceapi.FaceMatcher(labeledFaceDescriptors, FACE_MATCH_THRESHOLD);
        } else {
            faceMatcher = null;
        }

        // 3. Reset khách hàng hiện tại
        currentCustomer = null;

        // 4. Cập nhật UI bán hàng
        document.getElementById('customerName').innerText = "Đang nhận diện...";
        document.getElementById('cameraStatus').innerText = "Đang quét khuôn mặt...";

        // 5. Cập nhật Firebase để xóa cờ và đồng bộ lại màn hình khách hàng
        await update(ref(db, "current_order"), {
            saveInfo: null,
            customerId: null,
            isNewCustomer: false
        });

        // 6. Cập nhật và sync lại giỏ hàng
        renderCart();
    }

    // Khách chọn "CÓ, TÍCH ĐIỂM" lưu thông tin
    if (data.saveInfo === true && currentCustomer && currentCustomer.isNew) {
        // Hủy trạng thái khách mới
        currentCustomer.isNew = false;
        currentCustomer.availableVouchers = [];

        // Cập nhật Firebase để xóa cờ tạm
        await update(ref(db, "current_order"), {
            saveInfo: null,
            isNewCustomer: false
        });

        // Vẽ lại và sync giỏ hàng
        renderCart();
    }
});

function renderCart() {
    console.log("Đang render giỏ hàng:", cart);
    let html = "";
    let total = 0;

    for (let id in cart) {
        let item = cart[id];
        let lineTotal = (Number(item.price) || 0) * (Number(item.qty) || 0);
        total += lineTotal;
        html += `
            <div class="cart-item">
                <div>
                    <div style="font-weight:bold">${item.name || "Sản phẩm"}</div>
                    <div style="color:#ffcc00">${lineTotal.toLocaleString()}đ</div>
                </div>
                <div class="qty-controls">
                    <button onclick="changeQty('${id}',-1)">-</button>
                    <span style="margin:0 15px">${item.qty}</span>
                    <button onclick="changeQty('${id}',1)">+</button>
                </div>
            </div>`;
    }

    cartItemsEl.innerHTML = html;

    updateVoucherDisplay();

    let discountAmount = 0;
    const chkUseVoucher = document.getElementById("chkUseVoucher");
    const selVoucher = document.getElementById("selVoucher");
    if (currentCustomer && chkUseVoucher && chkUseVoucher.checked && selVoucher && selVoucher.value) {
        const selectedOption = selVoucher.options[selVoucher.selectedIndex];
        if (selectedOption) {
            discountAmount = Number(selectedOption.getAttribute("data-value")) || 0;
        }
    }

    let finalTotal = Math.max(0, total - discountAmount);
    let discountHtml = "";

    if (discountAmount > 0) {
        discountHtml = `
            <div class="discount-row" style="margin-bottom: 5px;">
                <span>Giảm giá Voucher:</span>
                <span>-${discountAmount.toLocaleString()}đ</span>
            </div>
        `;
    }

    const totalContainer = document.querySelector('.total');
    if (totalContainer) {
        totalContainer.innerHTML = `
            <div style="width: 100%;">
                <div style="display:flex; justify-content:space-between; margin-bottom:5px;">
                    <span>Tổng hóa đơn:</span>
                    <span>${total.toLocaleString()}đ</span>
                </div>
                ${discountHtml}
                <div style="display:flex; justify-content:space-between; margin-top:10px; font-size:28px; color:#fff;">
                    <span>Thanh toán:</span>
                    <span style="color:#ffcc00">${finalTotal.toLocaleString()}đ</span>
                </div>
            </div>
        `;
    }
    syncToCustomer();
}

window.disableCameraForSession = () => {
    isCameraDisabledForSession = true;
    stopCamera();
    renderCart();
};

barcodeInput.addEventListener("keypress", async (e) => {
    if (e.key === "Enter") {
        const val = barcodeInput.value.trim();
        if (!val) return;

        if (val === "000") {
            console.log("Mã vạch 000: Khách không cần tích điểm / Đeo khẩu trang. Tắt Camera.");
            window.disableCameraForSession();
            barcodeInput.value = "";
            return;
        }

        try {
            const productSnap = await get(ref(db, 'products/' + val));
            if (productSnap.exists()) {
                const product = productSnap.val();
                window.addItem(val, product.name, product.price, product.stock || 0);
            } else {
                alert("Sản phẩm không tồn tại!");
            }
        } catch (error) {
            console.error(error);
        }
        barcodeInput.value = "";
    }
});

window.checkout = async () => {
    if (Object.keys(cart).length === 0) return;

    let total = 0;
    for (let id in cart) {
        total += (Number(cart[id].price) || 0) * (Number(cart[id].qty) || 0);
    }
    let discountAmount = 0;
    const chkUseVoucher = document.getElementById("chkUseVoucher");
    const selVoucher = document.getElementById("selVoucher");
    if (currentCustomer && chkUseVoucher && chkUseVoucher.checked && selVoucher && selVoucher.value) {
        const selectedOption = selVoucher.options[selVoucher.selectedIndex];
        if (selectedOption) {
            discountAmount = Number(selectedOption.getAttribute("data-value")) || 0;
        }
    }
    let finalTotal = Math.max(0, total - discountAmount);

    // Đổi trạng thái khách sang màn hình thanh toán
    await update(ref(db, "current_order"), {
        status: "select_payment_method",
        total: finalTotal,
        discount: discountAmount,
        paymentMethod: null
    });

    // Mở modal chọn phương thức thanh toán
    selectedPaymentMethod = null;
    btnStaffPayCash.classList.remove("selected");
    btnStaffPayQr.classList.remove("selected");
    paymentActions.classList.add("hidden");
    paymentModal.classList.remove("hidden");
};

window.closePaymentModal = async () => {
    paymentModal.classList.add("hidden");
    selectedPaymentMethod = null;
    btnStaffPayCash.classList.remove("selected");
    btnStaffPayQr.classList.remove("selected");
    paymentActions.classList.add("hidden");

    stopPayOSPolling();

    // Reset status on Firebase back to ordering
    if (Object.keys(cart).length > 0) {
        await syncToCustomer();
    }
};

window.selectStaffPaymentMethod = async (method) => {
    selectedPaymentMethod = method;
    let total = 0;
    for (let id in cart) {
        total += (Number(cart[id].price) || 0) * (Number(cart[id].qty) || 0);
    }
    let discountAmount = 0;
    const chkUseVoucher = document.getElementById("chkUseVoucher");
    const selVoucher = document.getElementById("selVoucher");
    if (currentCustomer && chkUseVoucher && chkUseVoucher.checked && selVoucher && selVoucher.value) {
        const selectedOption = selVoucher.options[selVoucher.selectedIndex];
        if (selectedOption) {
            discountAmount = Number(selectedOption.getAttribute("data-value")) || 0;
        }
    }
    let finalTotal = Math.max(0, total - discountAmount);

    if (method === "cash") {
        btnStaffPayCash.classList.add("selected");
        btnStaffPayQr.classList.remove("selected");
        paymentStatusText.innerHTML = "Khách hàng thanh toán: <strong>Tiền mặt tại quầy</strong>.<br>Nhấp nút bên dưới sau khi nhận đủ tiền mặt để in bill.";
        stopPayOSPolling();

        await update(ref(db, "current_order"), {
            paymentMethod: method,
            status: "select_payment_method",
            total: finalTotal,
            discount: discountAmount,
            payOSQrCode: null,
            payOSCheckoutUrl: null
        });
    } else {
        btnStaffPayCash.classList.remove("selected");
        btnStaffPayQr.classList.add("selected");
        paymentStatusText.innerHTML = "Đang kết nối PayOS để tạo link thanh toán...";

        try {
            // Sử dụng timestamp làm mã giao dịch duy nhất cho PayOS tránh trùng đơn hàng
            const payOSOrderCode = Date.now();

            // Gọi server để tạo link thanh toán PayOS
            const res = await fetch(`${PAYOS_SERVER_URL}/create-payment-link`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    orderCode: payOSOrderCode,
                    amount: finalTotal,
                    description: `Thanh toan DH ${currentOrderId}`
                })
            });

            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.message || "Không thể kết nối Server PayOS local");
            }

            const result = await res.json();
            if (result.error === 0) {
                paymentStatusText.innerHTML = "Đang hiển thị mã <strong>QR PayOS</strong> trên màn hình khách hàng.<br>Hệ thống đang quét trạng thái thanh toán tự động...";

                // Cập nhật Firebase với thông tin PayOS thực tế
                await update(ref(db, "current_order"), {
                    paymentMethod: method,
                    status: "select_payment_method",
                    total: finalTotal,
                    discount: discountAmount,
                    payOSQrCode: result.data.qrCode,
                    payOSCheckoutUrl: result.data.checkoutUrl
                });

                // Bắt đầu quét trạng thái thanh toán từ PayOS với mã đơn hàng duy nhất này
                startPayOSPolling(payOSOrderCode);
            } else {
                throw new Error(result.message);
            }
        } catch (err) {
            console.error("Lỗi khởi tạo PayOS:", err);
            paymentStatusText.innerHTML = `<span style="color:#ff3366; font-weight:bold;">❌ Lỗi PayOS: ${err.message}.<br>Vui lòng kiểm tra xem server local cổng 3000 đã chạy chưa.</span>`;
        }
    }
    paymentActions.classList.remove("hidden");
};

function stopPayOSPolling() {
    if (payosPollingInterval) {
        clearInterval(payosPollingInterval);
        payosPollingInterval = null;
        console.log("PayOS polling stopped.");
    }
}

function startPayOSPolling(orderId) {
    stopPayOSPolling(); // Clean duplicate loops
    console.log("PayOS polling started checking for order ID: " + orderId);

    payosPollingInterval = setInterval(async () => {
        try {
            const response = await fetch(`${PAYOS_SERVER_URL}/check-payment-status/${orderId}`);
            if (!response.ok) {
                console.error("Local server PayOS status check error:", response.status);
                return;
            }

            const resData = await response.json();
            if (resData.error !== 0) {
                console.error("PayOS status check error message:", resData.message);
                return;
            }

            const status = resData.data.status;
            if (status === "PAID") {
                console.log("Tìm thấy giao dịch thanh toán thành công trên PayOS!");
                stopPayOSPolling();

                paymentStatusText.innerHTML = `<span style="color:#00ffcc; font-weight:bold;">✅ Hệ thống PayOS báo nhận thành công! Đang tự động in hóa đơn...</span>`;

                setTimeout(() => {
                    finalizeCheckout();
                }, 1000);
            }
        } catch (err) {
            console.error("Lỗi kết nối PayOS check status:", err);
        }
    }, 3000);
}

async function finalizeCheckout() {
    if (Object.keys(cart).length === 0 || !selectedPaymentMethod) return;

    stopPayOSPolling();

    // Mở cửa sổ in ngay lập tức để không bị trình duyệt chặn (popup blocker)
    const printWindow = window.open('', '_blank', 'width=400,height=600');
    if (printWindow) {
        printWindow.document.write('<html><body style="font-family:monospace; padding:20px;"><h3>Đang xử lý đơn hàng...</h3></body></html>');
    }

    try {
        let newlyEarnedVouchers = [];
        let rawTotalNum = 0;
        for (let id in cart) {
            rawTotalNum += (cart[id].price * cart[id].qty);
        }

        let discountAmount = 0;
        let usedVoucherCode = null;
        const selVoucher = document.getElementById("selVoucher");
        if (currentCustomer && chkUseVoucher && chkUseVoucher.checked && selVoucher && selVoucher.value) {
            const selectedVoucherId = selVoucher.value;
            const targetVoucher = currentCustomer.availableVouchers.find(v => v.id === selectedVoucherId);
            if (targetVoucher) {
                discountAmount = targetVoucher.value || 0;
                usedVoucherCode = targetVoucher.code;
                try {
                    await update(ref(db, `vouchers/${targetVoucher.id}`), {
                        status: "used",
                        usedAt: new Date().toLocaleString(),
                        orderId: currentOrderId
                    });
                } catch (e) {
                    console.error("Lỗi cập nhật voucher dùng:", e);
                }
            }
        }

        let finalTotal = Math.max(0, rawTotalNum - discountAmount);
        let campaignMessageToPrint = "";

        try {
            // 1. Kiểm tra danh sách chiến dịch chốt sale mới
            const campaignsSnap = await get(ref(db, "settings/campaigns"));
            if (campaignsSnap.exists()) {
                const campaigns = campaignsSnap.val();
                for (let id in campaigns) {
                    const campaign = campaigns[id];
                    const productIdsStr = campaign.productIds || "";
                    const campaignMsg = campaign.message || "";

                    if (productIdsStr && campaignMsg) {
                        const campaignProductIds = productIdsStr.split(",").map(pid => pid.trim());
                        const hasCampaignItem = Object.keys(cart).some(pid => campaignProductIds.includes(pid));
                        if (hasCampaignItem) {
                            if (campaignMessageToPrint) {
                                campaignMessageToPrint += "\n" + campaignMsg;
                            } else {
                                campaignMessageToPrint = campaignMsg;
                            }
                        }
                    }
                }
            }

            // 2. Tương thích ngược với chiến dịch đơn cũ
            if (!campaignMessageToPrint) {
                const campaignSnap = await get(ref(db, "settings/campaign"));
                if (campaignSnap.exists()) {
                    const campaign = campaignSnap.val();
                    const productIdsStr = campaign.productIds || "";
                    const campaignMsg = campaign.message || "";

                    if (productIdsStr && campaignMsg) {
                        const campaignProductIds = productIdsStr.split(",").map(id => id.trim());
                        const hasCampaignItem = Object.keys(cart).some(id => campaignProductIds.includes(id));
                        if (hasCampaignItem) {
                            campaignMessageToPrint = campaignMsg;
                        }
                    }
                }
            }
        } catch (e) {
            console.error("Lỗi đọc cấu hình chiến dịch:", e);
        }

        const today = new Date();
        const dateStr = today.getFullYear() + '-' +
            String(today.getMonth() + 1).padStart(2, '0') + '-' +
            String(today.getDate()).padStart(2, '0');

        // 1. Lưu đơn hàng
        await update(ref(db, `orders/${currentOrderId}`), {
            status: "da_nhan_tien",
            paidAt: new Date().toLocaleString(),
            date: dateStr,
            note: noteEl.value,
            customerId: currentCustomer ? currentCustomer.id : null,
            discountAmount: discountAmount,
            voucherCode: usedVoucherCode,
            rawTotal: rawTotalNum,
            total: finalTotal,
            paymentMethod: selectedPaymentMethod
        });

        // Cập nhật điểm tích lũy (tổng tiền chi tiêu) cho khách hàng
        if (currentCustomer) {
            const cSnap = await get(ref(db, `customers/${currentCustomer.id}`));
            let totalSpent = 0;
            let vouchersUsed = 0;
            if (cSnap.exists()) {
                totalSpent = cSnap.val().totalSpent || 0;
                vouchersUsed = cSnap.val().vouchersUsed || 0;
            }

            // Tích điểm cộng tất cả tiền mua sản phẩm (rawTotalNum)
            let newTotalSpent = totalSpent + rawTotalNum;
            let newVouchersUsed = vouchersUsed + (discountAmount > 0 ? 1 : 0);

            // Tự động sinh voucher mới nếu chi tiêu tích lũy tăng vượt mốc đối với từng quy tắc
            if (pointsRules && pointsRules.length > 0) {
                for (let rule of pointsRules) {
                    const threshold = rule.threshold;
                    const oldVouchersCount = Math.floor(totalSpent / threshold);
                    const newVouchersCount = Math.floor(newTotalSpent / threshold);
                    const newEarned = newVouchersCount - oldVouchersCount;
                    for (let i = 0; i < newEarned; i++) {
                        const newVoucherId = "Voucher_" + Date.now() + "_" + Math.floor(Math.random() * 1000) + "_" + rule.id + "_" + i;
                        const newVoucherCode = "V_" + Math.random().toString(36).substr(2, 6).toUpperCase();
                        await set(ref(db, `vouchers/${newVoucherId}`), {
                            code: newVoucherCode,
                            customerId: currentCustomer.id,
                            value: rule.value,
                            status: "available",
                            ruleId: rule.id,
                            createdAt: new Date().toLocaleString()
                        });
                        newlyEarnedVouchers.push({
                            code: newVoucherCode,
                            value: rule.value
                        });
                    }
                }
            }

            await update(ref(db, `customers/${currentCustomer.id}`), {
                totalSpent: newTotalSpent,
                vouchersUsed: newVouchersUsed
            });

            currentCustomer.totalSpent = newTotalSpent;
            currentCustomer.vouchersUsed = newVouchersUsed;
        }

        // 2. Trừ tồn kho
        for (let id in cart) {
            const itemQty = cart[id].qty;
            const productRef = ref(db, `products/${id}`);
            const pSnap = await get(productRef);
            if (pSnap.exists()) {
                let currentStock = pSnap.val().stock || 0;
                let newStock = Math.max(0, currentStock - itemQty);
                await update(productRef, { stock: newStock });
            }
        }

        if (printWindow) {
            printBillIntoWindow(printWindow, rawTotalNum, discountAmount, finalTotal, campaignMessageToPrint, usedVoucherCode, newlyEarnedVouchers);
        }

        // Ẩn modal và reset trạng thái
        paymentModal.classList.add("hidden");
        selectedPaymentMethod = null;
        btnStaffPayCash.classList.remove("selected");
        btnStaffPayQr.classList.remove("selected");
        paymentActions.classList.add("hidden");

        if (chkUseVoucher) chkUseVoucher.checked = false;

        stopCamera();
        isCameraDisabledForSession = false;

        currentOrderId++;
        await set(ref(db, "currentOrderId"), currentOrderId);
        cart = {};
        noteEl.value = "";

        // Reset current_order trên Firebase để đồng bộ lại màn hình khách hàng
        await set(ref(db, "current_order"), null);

        renderCart();
        orderIdEl.innerText = currentOrderId;
        barcodeInput.focus();

    } catch (error) {
        console.error("Lỗi khi thanh toán:", error);
        if (printWindow) {
            printWindow.document.write('<h3 style="color:red">Lỗi trong quá trình thanh toán. Vui lòng kiểm tra console.</h3>');
        }
        alert("Có lỗi xảy ra khi thanh toán! Đã ghi log ra console.");
    }
}

function printBillIntoWindow(printWindow, rawTotal, discountAmount, finalTotal, campaignMessage, usedVoucherCode, newlyEarnedVouchers = []) {
    let billHTML = `
    <html>
    <body style="font-family:monospace; width:300px;">
        <h2 style="text-align:center">MINI STORE</h2>
        <hr>
        <p>Hóa đơn: #${currentOrderId}</p>
        <p>Ngày: ${new Date().toLocaleString()}</p>
        ${currentCustomer ? `<p>Khách hàng: ${currentCustomer.id}</p>` : ''}
        <hr>
    `;

    for (let id in cart) {
        let item = cart[id];
        billHTML += `<p>${item.name} x${item.qty}: ${(item.price * item.qty).toLocaleString()}đ</p>`;
    }

    billHTML += `
        <hr>
        <p>Tổng tiền hàng: ${rawTotal.toLocaleString()}đ</p>
    `;

    if (discountAmount > 0) {
        billHTML += `<p>Giảm giá voucher ${usedVoucherCode ? `(${usedVoucherCode})` : ''}: -${discountAmount.toLocaleString()}đ</p>`;
    }

    billHTML += `
        <h3>THANH TOÁN: ${finalTotal.toLocaleString()}đ</h3>
        <hr>
    `;

    if (newlyEarnedVouchers && newlyEarnedVouchers.length > 0) {
        billHTML += `
        <div style="border: 1px dashed #000; padding: 10px; margin-bottom: 10px; text-align: center;">
            <p style="font-weight: bold; margin: 0 0 5px 0; font-size: 13px;">🎉 CHÚC MỪNG QUÝ KHÁCH! 🎉</p>
            <p style="margin: 0 0 5px 0; font-size: 11px;">Bạn đã đủ điểm tích lũy nhận Voucher mới:</p>
        `;
        newlyEarnedVouchers.forEach(v => {
            billHTML += `
            <p style="font-weight: bold; margin: 3px 0; font-size: 12px; color: #ff3366;">Mã: ${v.code} (-${v.value.toLocaleString()}đ)</p>
            `;
        });
        billHTML += `
        </div>
        <hr>
        `;
    }

    billHTML += `
        <p style="text-align:center">Cảm ơn quý khách!</p>
        <p style="text-align:center; font-size:11px; margin-top:10px; line-height: 1.4;">Vào website: <strong>1nghiadzno1-create.github.io/chamsoc/</strong> nhập 4 số cuối mã khách hàng để xem thông báo và kiểm tra tích điểm nhé</p>
    `;

    if (campaignMessage) {
        billHTML += `
        <div style="border-top:1px dashed #000; padding-top:15px; margin-top:15px; text-align:center; font-weight:bold; font-size:14px; color:#000;">
            🎁 ${campaignMessage}
        </div>`;
    }

    billHTML += `
    </body>
    </html>`;

    printWindow.document.open();
    printWindow.document.write(billHTML);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 250);
}

// Đăng ký sự kiện cho các nút trong modal thanh toán
if (btnCloseModal) {
    btnCloseModal.addEventListener("click", () => {
        window.closePaymentModal();
    });
}
if (btnStaffPayCash) {
    btnStaffPayCash.addEventListener("click", () => {
        window.selectStaffPaymentMethod("cash");
    });
}
if (btnStaffPayQr) {
    btnStaffPayQr.addEventListener("click", () => {
        window.selectStaffPaymentMethod("qr");
    });
}
if (btnConfirmPayment) {
    btnConfirmPayment.addEventListener("click", () => {
        finalizeCheckout();
    });
}

// Click ra ngoài modal để đóng
window.addEventListener("click", (e) => {
    if (e.target === paymentModal) {
        window.closePaymentModal();
    }
});

document.addEventListener("keydown", (e) => {
    if (e.key === "F9") {
        e.preventDefault();
        window.checkout();
    }
});

init();