# 🍓 Strawberry App – Nông trại dâu thông minh

Ứng dụng di động (React Native + Expo) giám sát và điều khiển nông trại trồng dâu thông minh. Ứng dụng nhận dữ liệu cảm biến theo thời gian thực từ **ESP32** thông qua **Supabase**, cho phép điều khiển thiết bị từ xa, quản lý thông tin cây trồng và (định hướng) chẩn đoán bệnh trên lá bằng AI.

## ✨ Tính năng

### 🏠 Trang chủ
- Hiển thị realtime **nhiệt độ**, **độ ẩm không khí**, **độ ẩm đất** (Supabase Realtime).
- Biểu đồ môi trường 24 giờ gần nhất.
- Thống kê theo khoảng thời gian: 7 ngày / 30 ngày / 3 tháng.
- Lịch sử cảnh báo của thiết bị.
- Kéo để làm mới dữ liệu.

### ⚙️ Điều khiển
- Bật/tắt **quạt** và **đèn** từ xa, trạng thái đồng bộ realtime giữa các thiết bị.
- Lịch sử điều khiển (ai bấm, lúc nào, chế độ thủ công/tự động).

### 🌱 Cây trồng
- Thêm cây mới: tên, mã cây (tự sinh ngẫu nhiên dạng `DAU-XXXXXX`), ngày trồng, thuốc trừ sâu, loại phân bón.
- Chụp ảnh cây bằng camera, ảnh được tải lên **Cloudinary**.
- Tìm kiếm cây theo ID và khoảng ngày trồng.

### 👥 Nhiều người dùng chung một thiết bị
- Không cần màn hình đăng nhập: ứng dụng dùng **Supabase Anonymous Auth**.
- Khi mở app, người dùng tự động tham gia (hoặc tạo mới) thiết bị theo `DEVICE_CODE`.
- Phân quyền `owner` / `member` qua bảng `device_members` và Row Level Security (RLS).

### 🧠 Đang phát triển / kế hoạch
- Chẩn đoán bệnh lá bằng mô hình **MobileNetV3-Large** (TFLite/ONNX, 7 lớp theo dataset Kaggle), tích hợp vào tab Cây trồng.
- Hẹn giờ bật/tắt quạt, đèn và thêm thiết bị **máy bơm** tưới nước trong tab Điều khiển.

## 🧱 Công nghệ sử dụng

| Thành phần | Công nghệ |
|---|---|
| Ứng dụng | React Native, Expo, TypeScript |
| Backend / CSDL | Supabase (PostgreSQL, Auth, Realtime, RLS) |
| Phần cứng | ESP32 (cảm biến + quạt/đèn) |
| Lưu ảnh | Cloudinary (unsigned upload) |
| Biểu đồ | `react-native-chart-kit` |
| AI (dự kiến) | MobileNetV3-Large (TFLite / ONNX) |

## 🗂️ Cấu trúc thư mục

```
StrawberryApp/
├─ App.tsx                 # Thanh tab điều hướng (Trang chủ / Điều khiển / Cây trồng)
├─ app.json                # Cấu hình Expo
├─ tsconfig.json
├─ hooks/
│  └─ useDevice.ts         # Hook lấy deviceId (join/tạo device tự động)
├─ lib/
│  ├─ supabase.ts          # Khởi tạo Supabase client
│  ├─ session.ts           # Anonymous Auth + DEVICE_CODE + join_or_create_device
│  ├─ types.ts             # Kiểu dữ liệu dùng chung (SensorReading, ActuatorState, Plant, ...)
│  └─ utils.ts             # Hàm tiện ích (lấy mẫu dữ liệu, format thời gian, sinh mã cây)
├─ screens/
│  ├─ HomeScreen.tsx
│  ├─ ControlScreen.tsx
│  └─ PlantsScreen.tsx
└─ database.sql            # Schema Supabase + RLS + seed dữ liệu
```

## 🗄️ Cơ sở dữ liệu

Schema nằm trong `database.sql`, gồm các bảng chính:

- `profiles`, `devices`, `device_members` – người dùng, thiết bị và phân quyền.
- `sensor_readings` – dữ liệu cảm biến theo thời gian.
- `actuator_states`, `control_logs` – trạng thái hiện tại và lịch sử điều khiển.
- `plants`, `plant_photos` – thông tin cây và ảnh.
- `diseases`, `disease_diagnoses` – danh mục bệnh và kết quả chẩn đoán AI.
- `alerts` – cảnh báo.

Hàm RPC `join_or_create_device(p_device_code, p_device_name)` giúp ứng dụng tự tham gia hoặc tạo thiết bị. Realtime được bật cho `sensor_readings`, `actuator_states`, `alerts`.

## 🚀 Cài đặt & chạy

### Yêu cầu
- Node.js 18+
- Tài khoản [Supabase](https://supabase.com) và [Cloudinary](https://cloudinary.com)
- Điện thoại Android hoặc máy ảo Android

### Các bước

1. **Clone repo và cài thư viện**
   ```bash
   git clone https://github.com/timmie182/Strawberry_Agriculture_App.git
   cd Strawberry_Agriculture_App
   npm install
   ```

2. **Thiết lập Supabase**
   - Tạo project mới trên Supabase.
   - Vào *SQL Editor* và chạy toàn bộ `database.sql`.
   - Vào *Authentication → Sign In / Providers* và bật **Allow anonymous sign-ins**.
   - Vào *Storage* và tạo bucket `plant-photos` nếu cần dùng Supabase Storage.

3. **Cấu hình ứng dụng**
   - `lib/supabase.ts`: điền `SUPABASE_URL` và `SUPABASE_ANON_KEY` (*Project Settings → API*).
   - `lib/session.ts`: đặt `DEVICE_CODE` **trùng** với mã mà firmware ESP32 dùng khi ghi dữ liệu (ví dụ `ESP32-001`).
   - `screens/PlantsScreen.tsx`: điền `CLOUDINARY_CLOUD_NAME` và `CLOUDINARY_UPLOAD_PRESET` (preset dạng *Unsigned*).

4. **Chạy ứng dụng**
   ```bash
   npx expo start
   ```

### Build file APK (EAS)

```bash
npm install -g eas-cli
eas login
eas build -p android --profile preview
```

> Đảm bảo profile `preview` trong `eas.json` đặt `"buildType": "apk"` để nhận được file APK cài trực tiếp.

## 🔌 Kết nối ESP32

Firmware ESP32 cần:

- Ghi dữ liệu vào bảng `sensor_readings` (`device_id`, `temperature`, `humidity`, `soil_moisture`) bằng **service_role key** (bypass RLS).
- Đọc bảng `actuator_states` (`fan_state`, `light_state`) để đóng/ngắt quạt và đèn.
- Dùng `device_code` trùng với `DEVICE_CODE` trong ứng dụng.
