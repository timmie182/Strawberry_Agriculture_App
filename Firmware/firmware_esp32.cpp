/*
 * FIRMWARE ESP32 - GIÁM SÁT & ĐIỀU KHIỂN VƯỜN DÂU (bản có Captive Portal)
 * Dùng WiFiManager để nhập WiFi + mã ghép nối (device_code) qua giao diện web,
 * không cần hardcode, không cần nạp lại firmware khi đổi thiết bị.
 *
 * Thư viện cần cài (Library Manager):
 * - WiFiManager (by tzapu)   <-- MỚI
 * - DHT sensor library (Adafruit)
 * - ArduinoJson
 * - Preferences (có sẵn trong ESP32 core)
 *
 * CẬP NHẬT: Nút RESET (BOOT) giờ có thể giữ BẤT CỨ LÚC NÀO trong lúc thiết bị
 * đang chạy bình thường, không chỉ lúc mới khởi động. checkFactoryReset() được
 * gọi ở đầu mỗi vòng loop() và tự thoát ngay nếu nút không được giữ.
 */

#include <vector>
#include <WiFi.h>
#include <WiFiManager.h>   // https://github.com/tzapu/WiFiManager
#include <esp_task_wdt.h>  // Watchdog phần cứng - tự khởi động lại nếu firmware bị treo
#include <Preferences.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <WebServer.h>   // MỚI: server HTTP nội bộ cho trang cập nhật firmware qua WiFi
#include <Update.h>      // MỚI: ghi firmware mới vào flash (OTA)

// ------------------- CẤU HÌNH SUPABASE (vẫn hardcode, vì cố định cho cả app) -------------------
const char* SUPABASE_URL      = "Your_URL_here";
const char* SUPABASE_ANON_KEY = " Your_key_here";

// ------------------- CHÂN CẢM BIẾN & RELAY -------------------
#define DHTPIN 4
#define DHTTYPE DHT11
#define SOIL_PIN 34
#define RELAY_LIGHT 27
#define RELAY_FAN   26
#define RESET_BUTTON_PIN 0   // Nút BOOT có sẵn trên hầu hết board ESP32 dev kit
#define STATUS_LED_PIN 2     // LED xanh có sẵn trên hầu hết board ESP32 dev kit (đổi nếu board khác)

#define RELAY_LOW_TRIGGER false

// Ngưỡng thời gian giữ nút RESET (mili-giây)
#define RESET_HOLD_WIFI_MS     3000   // giữ 3-6s: chỉ xóa WiFi, GIỮ mã ghép nối -> mở lại captive portal
#define RESET_HOLD_FACTORY_MS  6000   // giữ >6s: xóa TẤT CẢ (WiFi + mã ghép nối) -> reset toàn bộ

// ------------------- WATCHDOG PHẦN CỨNG -------------------
// Nếu firmware bị treo (ví dụ HTTP client kẹt, thư viện lỗi, deadlock lạ...) quá thời gian này
// mà không "cho ăn" (esp_task_wdt_reset), ESP32 sẽ TỰ KHỞI ĐỘNG LẠI thay vì đứng im vĩnh viễn.
// Đây là lớp bảo hiểm bắt buộc cho thiết bị bán ra thị trường, vì không ai đứng cạnh để bấm reset tay.
// LƯU Ý: chỉ bật watchdog SAU khi đã xong bước cấu hình WiFi/mã ghép nối, để không làm gián đoạn
// cổng cấu hình (vốn có thể "rảnh tay" chờ người dùng nhập liệu lâu hơn thời gian watchdog cho phép).
#define WDT_TIMEOUT_SECONDS 30

void initWatchdog() {
  // ESP32 Arduino core 3.x trở lên: esp_task_wdt_init() nhận một struct cấu hình,
  // không còn nhận trực tiếp (timeout, panic) như core 2.x nữa.
  esp_task_wdt_config_t wdtConfig = {
    .timeout_ms = WDT_TIMEOUT_SECONDS * 1000,
    .idle_core_mask = 0,     // không theo dõi idle task của lõi nào
    .trigger_panic = true    // true = cho phép reset khi hết giờ
  };
  esp_task_wdt_init(&wdtConfig);
  esp_task_wdt_add(NULL); // đăng ký task hiện tại (loop/setup) vào watchdog
  Serial.printf("Đã bật watchdog phần cứng (%ds).\n", WDT_TIMEOUT_SECONDS);
}

// ------------------- TRẠNG THÁI ĐÈN LED (phản hồi trực quan cho người dùng) -------------------
void ledOff()  { digitalWrite(STATUS_LED_PIN, LOW); }
void ledOn()   { digitalWrite(STATUS_LED_PIN, HIGH); }

// Nháy LED n lần, dùng để báo hiệu các bước quan trọng (đang cấu hình, đã lưu, lỗi...)
void ledBlink(int times, int onMs = 150, int offMs = 150) {
  for (int i = 0; i < times; i++) {
    ledOn();
    delay(onMs);
    ledOff();
    delay(offMs);
  }
}

DHT dht(DHTPIN, DHTTYPE);
Preferences prefs;

// Biến lưu mã ghép nối - đọc từ bộ nhớ hoặc từ captive portal
String deviceCode = "";
String deviceId = "";

// ------------------- NGƯỠNG AUTO MODE -------------------
const float TEMP_ON_FAN    = 30.0;
const float TEMP_OFF_FAN   = 28.0;
const int   SOIL_DRY_LIGHT = 60;

bool currentFanState = false;
bool currentLightState = false;

unsigned long lastSensorPush = 0;
unsigned long lastControlPoll = 0;
unsigned long lastHeartbeat = 0;
const unsigned long SENSOR_PUSH_INTERVAL  = 10000;
const unsigned long CONTROL_POLL_INTERVAL = 3000;
const unsigned long HEARTBEAT_INTERVAL    = 15000;

float lastTemp = 0;
int lastSoilPercent = 0;

// Đánh dấu đã cấu hình chân nút/LED hay chưa, để tránh gọi pinMode() lặp lại
// mỗi vòng loop() một cách không cần thiết (pinMode gọi lại vẫn an toàn, nhưng
// tách ra cho gọn và rõ ràng hơn).
bool resetPinsInitialized = false;

// ------------------- CẬP NHẬT FIRMWARE QUA WIFI (OTA qua trình duyệt) -------------------
// Đổi mật khẩu này trước khi bán thiết bị ra thị trường, tránh người lạ trong cùng mạng
// WiFi tự ý tải firmware lạ lên thiết bị.
const char* OTA_UPDATE_PASSWORD = "vuondau123";
WebServer otaServer(80);

const char OTA_UPDATE_PAGE[] PROGMEM = R"rawliteral(
<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cập nhật Firmware</title></head>
<body style="font-family:'Segoe UI',Arial,sans-serif;max-width:380px;margin:40px auto;text-align:center;padding:0 16px;">
<div style="font-size:36px;">🍓</div>
<h2 style="color:#1b7a43;">Cập nhật Firmware</h2>
<p style="color:#666;font-size:13px;">Chọn file firmware (.bin) và nhập mật khẩu cập nhật</p>
<form method="POST" action="/do-update" enctype="multipart/form-data" onsubmit="document.getElementById('s').innerText='Đang tải lên, vui lòng không tắt nguồn thiết bị...';">
  <input type="password" name="password" placeholder="Mật khẩu cập nhật" required
    style="padding:10px;width:90%;margin-bottom:12px;border-radius:8px;border:1px solid #cfe8d8;"><br>
  <input type="file" name="firmware" accept=".bin" required><br><br>
  <input type="submit" value="Tải lên &amp; Cập nhật"
    style="padding:10px 20px;background:#1b7a43;color:#fff;border:none;border-radius:8px;font-weight:600;">
</form>
<p id="s" style="color:#c0392b;font-size:13px;margin-top:14px;"></p>
</body></html>
)rawliteral";

// Đặt ở phạm vi file để chia sẻ trạng thái giữa 2 callback (upload handler chạy nhiều lần
// liên tiếp khi file được truyền theo từng đoạn nhỏ).
bool otaPasswordOk = false;

void setupOtaWebServer() {
  otaServer.on("/update", HTTP_GET, []() {
    otaServer.send_P(200, "text/html", OTA_UPDATE_PAGE);
  });

  // Route xử lý việc tải file lên: handler thứ nhất chạy SAU KHI toàn bộ file đã nhận xong
  // (để trả kết quả về trình duyệt); handler thứ hai (upload callback) chạy NHIỀU LẦN
  // trong lúc file đang được truyền từng đoạn.
  otaServer.on("/do-update", HTTP_POST, []() {
    bool ok = otaPasswordOk && !Update.hasError();
    otaServer.sendHeader("Connection", "close");
    otaServer.send(200, "text/plain",
      ok ? "Cập nhật thành công! Thiết bị đang khởi động lại..."
         : "Cập nhật THẤT BẠI (sai mật khẩu hoặc file lỗi). Vui lòng thử lại.");
    if (ok) {
      delay(1000);
      ESP.restart();
    }
  }, []() {
    HTTPUpload& upload = otaServer.upload();

    if (upload.status == UPLOAD_FILE_START) {
      otaPasswordOk = (otaServer.arg("password") == OTA_UPDATE_PASSWORD);
      if (!otaPasswordOk) {
        Serial.println("[OTA] Sai mật khẩu, từ chối cập nhật.");
        return;
      }
      Serial.printf("[OTA] Bắt đầu nhận firmware: %s\n", upload.filename.c_str());
      esp_task_wdt_delete(NULL); // gỡ watchdog trong lúc ghi flash để tránh bị reset giữa chừng
      ledOn();
      if (!Update.begin(UPDATE_SIZE_UNKNOWN)) {
        Update.printError(Serial);
      }

    } else if (upload.status == UPLOAD_FILE_WRITE) {
      if (!otaPasswordOk) return;
      if (Update.write(upload.buf, upload.currentSize) != upload.currentSize) {
        Update.printError(Serial);
      }

    } else if (upload.status == UPLOAD_FILE_END) {
      ledOff();
      if (!otaPasswordOk) return;
      if (Update.end(true)) {
        Serial.printf("[OTA] Cập nhật thành công, %u bytes. Đang khởi động lại...\n", upload.totalSize);
      } else {
        Update.printError(Serial);
      }
      esp_task_wdt_add(NULL); // đăng ký lại watchdog (nếu update lỗi và thiết bị không restart)
    }
  });

  otaServer.begin();
  Serial.println("[OTA] Trang cập nhật firmware sẵn sàng tại: http://" + WiFi.localIP().toString() + "/update");
}

// ========================================================
// CAPTIVE PORTAL - CẤU HÌNH WIFI + MÃ GHÉP NỐI
// ========================================================

// CSS + logo tùy chỉnh cho trang cấu hình, theo chủ đề "Vườn dâu thông minh"
const char CUSTOM_HEAD[] PROGMEM = R"rawliteral(
<style>
  body {
    background: linear-gradient(180deg, #eafaf1 0%, #ffffff 100%) !important;
    font-family: 'Segoe UI', Arial, sans-serif !important;
  }
  .wrap {
    max-width: 400px !important;
    margin: 30px auto !important;
    background: #ffffff;
    border-radius: 16px !important;
    box-shadow: 0 4px 24px rgba(0,0,0,0.08) !important;
    padding: 24px !important;
  }
  h1, h2, h3 { color: #1b7a43 !important; text-align: center; }
  button, input[type='submit'] {
    background: #1b7a43 !important;
    border-radius: 8px !important;
    border: none !important;
    color: #fff !important;
    padding: 10px 16px !important;
    font-weight: 600 !important;
  }
  button:hover { background: #145c33 !important; }
  input[type='text'], input[type='password'] {
    border-radius: 8px !important;
    border: 1px solid #cfe8d8 !important;
    padding: 10px !important;
  }
  .msg { border-radius: 10px !important; }
  a { color: #1b7a43 !important; }
  .info-box {
    background: #f2fbf6 !important;
    border: 1px solid #cfe8d8 !important;
    border-radius: 10px !important;
    padding: 12px 14px !important;
    margin: 12px 0 18px 0 !important;
    font-size: 13px !important;
    color: #2a2a2a !important;
    text-align: left !important;
    line-height: 1.5 !important;
  }
  .info-box b { color: #1b7a43 !important; }
  #backHomeFloatBtn {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    background: #1b7a43 !important;
    color: #fff !important;
    border-radius: 20px !important;
    padding: 10px 20px !important;
    text-decoration: none !important;
    font-weight: 600 !important;
    font-size: 14px !important;
    box-shadow: 0 2px 10px rgba(0,0,0,0.2) !important;
    z-index: 9999;
  }
  .wrap { padding-bottom: 70px !important; }
</style>
<script>
  // Chèn nút "Quay lại trang chủ" nổi ở mọi trang của captive portal (kể cả trang con
  // Configure WiFi / Param), vì thư viện WiFiManager không có sẵn nút back rõ ràng trên
  // các trang này. Đoạn <head> này (CUSTOM_HEAD) được chèn vào MỌI trang portal nên
  // script chạy được ở bất kỳ đâu, trừ khi đang ở đúng trang chủ "/" thì không cần hiện.
  window.addEventListener('DOMContentLoaded', function () {
    if (window.location.pathname === '/' || window.location.pathname === '') return;
    var btn = document.createElement('a');
    btn.id = 'backHomeFloatBtn';
    btn.href = '/';
    btn.innerHTML = '&larr; Quay lại trang chủ';
    document.body.appendChild(btn);
  });
</script>
<div style="text-align:center; padding-top:10px;">
  <div style="font-size:40px;">🍓</div>
  <h2 style="margin:4px 0;">Vườn Dâu Thông Minh</h2>
  <p style="color:#666; font-size:13px; margin-top:0;">Cấu hình kết nối thiết bị</p>
  <div class="info-box">
    <b>Hướng dẫn nhanh:</b><br>
    1️⃣ Chọn mạng WiFi nhà bạn ở mục "Configure WiFi"<br>
    2️⃣ Nhập mật khẩu WiFi<br>
    3️⃣ Nhập <b>Mã ghép nối thiết bị</b> (xem trong app di động)<br>
    4️⃣ Nhấn <b>Save</b> và chờ vài giây để thiết bị kết nối
  </div>
</div>
)rawliteral";

// Callback: chạy khi ESP32 mở AP cấu hình -> báo hiệu bằng LED nháy chậm liên tục
void onConfigPortalStart(WiFiManager *wmInstance) {
  Serial.println("Đã mở cổng cấu hình. Hãy kết nối WiFi 'ESP32-VuonDau-Setup' để cài đặt.");
  ledBlink(2, 400, 200); // 2 nháy dài = báo hiệu đang chờ người dùng cấu hình
}

// Callback: chạy ngay khi người dùng bấm Save trên trang web -> báo hiệu đã nhận cấu hình
void onConfigSaved() {
  Serial.println("Đã nhận cấu hình mới, đang thử kết nối...");
  ledBlink(3, 100, 100); // 3 nháy nhanh = đã lưu, đang áp dụng
}

void setupWiFiAndPairing() {
  WiFiManager wm;

  // Chèn CSS + logo tùy chỉnh vào phần <head> của trang captive portal
  wm.setCustomHeadElement(CUSTOM_HEAD);

  // Đổi tiêu đề trang trình duyệt
  wm.setTitle("Vườn Dâu Thông Minh - Cấu hình");

  // Rút gọn menu cổng cấu hình cho dễ dùng: WiFi, tham số (mã ghép nối), thông tin thiết bị,
  // và nút "Erase" để người dùng có thể tự xóa cấu hình ngay trên web (không cần bấm nút vật lý)
  // QUAN TRỌNG: theo tài liệu chính thức của thư viện WiFiManager, nếu "param" có mặt
  // trong menu thì các tham số tùy chỉnh (mã ghép nối) sẽ KHÔNG hiện trên trang "Configure
  // WiFi" nữa, mà chỉ hiện ở trang "Param" riêng. Vì ta MUỐN mã ghép nối hiện CHUNG với
  // WiFi (để bắt buộc nhập 1 lần cùng lúc), nên phải bỏ "param" ra khỏi menu.
  std::vector<const char*> menu = {"wifi", "info", "sep", "erase", "restart", "exit"};
  wm.setMenu(menu);
  wm.setShowInfoErase(true);      // hiện nút xóa cấu hình trong trang "info"
  wm.setShowInfoUpdate(false);    // ẩn phần "Update" (cập nhật firmware OTA) trong trang "info"

  // false (mặc định của thư viện): nếu sai mật khẩu / không kết nối được, WiFiManager sẽ
  // TỰ QUAY LẠI trang cấu hình và hiện thông báo lỗi ngay trên web (ví dụ "Could not connect"),
  // cho người dùng nhập lại ngay tại chỗ mà KHÔNG cần khởi động lại thiết bị.
  // (Trước đây để true khiến portal thoát âm thầm dù sai mật khẩu, thiết bị tự restart mà
  // người dùng không biết lý do là do gõ sai mật khẩu.)
  wm.setBreakAfterConfig(false);
  wm.setConfigPortalBlocking(true);

  // Gắn callback để phản hồi LED khi mở cổng cấu hình / khi lưu cấu hình
  wm.setAPCallback(onConfigPortalStart);
  wm.setSaveConfigCallback(onConfigSaved);

  // Đọc mã ghép nối đã lưu trước đó (nếu có) để hiện sẵn trong form
  prefs.begin("device", true);
  String savedCode = prefs.getString("device_code", "");
  prefs.end();

  // Thêm 1 ô nhập tùy chỉnh "Mã ghép nối" vào trang cấu hình WiFi
  // required + placeholder: trình duyệt sẽ CHẶN không cho bấm Save nếu ô này còn trống.
  // Điều này bắt buộc vì sau khi WiFi kết nối thành công, ESP32 tắt AP portal ngay lập tức,
  // người dùng sẽ MẤT kết nối tới trang cấu hình và không còn cách nào quay lại nhập bổ sung
  // mã ghép nối được nữa - nên phải chặn ngay từ bước submit, không được để trống.
  WiFiManagerParameter customDeviceCode(
    "device_code",
    "<b>Mã ghép nối thiết bị</b><br><small style='color:#888'>Xem mã này trong app di động - BẮT BUỘC phải nhập trước khi Save</small>",
    savedCode.c_str(), 20,
    "required placeholder='Nhập mã ghép nối tại đây'"
  );
  wm.addParameter(&customDeviceCode);

  // Đặt tên WiFi mà ESP32 sẽ phát ra khi chưa cấu hình + mật khẩu để tránh người lạ vào nhầm
  // Rút ngắn thời gian chờ thử kết nối WiFi đã lưu từ ~60s (mặc định) xuống 15s.
  // Lý do: trong lúc đang chờ kết nối (wm.autoConnect() bị BLOCKING), nút RESET (BOOT)
  // KHÔNG có tác dụng gì vì checkFactoryReset() chưa được gọi lại. Rút ngắn xuống 15s giúp
  // thiết bị tự động mở lại captive portal nhanh hơn nhiều khi mang đến nơi không có WiFi cũ,
  // đồng thời giúp nút BOOT phản hồi được sớm hơn nếu người dùng vẫn muốn bấm.
  wm.setConnectTimeout(15);

  wm.setConfigPortalTimeout(180); // tự thoát sau 3 phút nếu không ai cấu hình

  bool connected;
  bool forcedPortal = (savedCode.length() == 0);
  if (forcedPortal) {
    // CHƯA có mã ghép nối -> LUÔN mở cổng cấu hình để bắt buộc nhập mã,
    // kể cả khi ESP32 đã nhớ sẵn WiFi từ trước (autoConnect() sẽ bỏ qua portal trong trường hợp đó).
    Serial.println("Chưa có mã ghép nối đã lưu -> bắt buộc mở cổng cấu hình.");
    connected = wm.startConfigPortal("ESP32-VuonDau-Setup", "vuondau123");
  } else {
    // Đã có mã ghép nối rồi -> dùng autoConnect bình thường (chỉ mở portal nếu WiFi chưa có/không vào được)
    connected = wm.autoConnect("ESP32-VuonDau-Setup", "vuondau123");
  }

  if (!connected) {
    Serial.println("Hết thời gian chờ hoặc không kết nối được WiFi, khởi động lại...");
    ledBlink(5, 100, 100); // 5 nháy nhanh = báo lỗi kết nối
    delay(500);
    ESP.restart();
  }

  // Kết nối WiFi thành công -> báo hiệu bằng LED sáng ổn định 1 giây
  ledOn();
  delay(1000);
  ledOff();

  // Lấy giá trị mã ghép nối người dùng vừa nhập (hoặc giá trị cũ nếu không đổi)
  String enteredCode = String(customDeviceCode.getValue());
  enteredCode.trim();

  if (enteredCode.length() > 0) {
    deviceCode = enteredCode;
    prefs.begin("device", false);
    prefs.putString("device_code", deviceCode);
    prefs.end();
    Serial.println("Đã lưu mã ghép nối: " + deviceCode);
  } else {
    deviceCode = savedCode;
  }

  if (deviceCode.length() == 0) {
    // Khách hàng đã lưu form nhưng để trống ô mã ghép nối -> KHÔNG được để lọt xuống dưới,
    // vì họ sẽ không có Serial Monitor để biết cách sửa. Báo lỗi bằng LED rồi mở lại cổng ngay.
    Serial.println("Mã ghép nối bị để trống! Mở lại cổng cấu hình để nhập lại...");
    ledBlink(5, 80, 80); // báo lỗi rõ ràng bằng LED
    delay(1000);
    setupWiFiAndPairing(); // gọi đệ quy: mở lại portal cho tới khi có mã hợp lệ
    return;
  }
}

// Giữ nút BOOT (bất cứ lúc nào - lúc khởi động HOẶC trong lúc thiết bị đang chạy) để reset
// thiết bị. Có 2 mức, phân biệt bằng thời gian giữ, và LED sẽ nháy nhanh dần để người dùng
// biết mình đang giữ tới mức nào:
//   - Giữ 3-6 giây : chỉ xóa WiFi đã lưu, GIỮ NGUYÊN mã ghép nối -> mở lại captive portal
//                     (dùng khi đổi router / đổi mật khẩu WiFi)
//   - Giữ trên 6 giây : xóa TẤT CẢ (WiFi + mã ghép nối) -> reset về trạng thái xuất xưởng
//                     (dùng khi đổi chủ thiết bị / ghép nối lại từ đầu)
// Nếu nhả nút trước 3 giây thì không có gì xảy ra, thiết bị khởi động/chạy bình thường.
//
// Hàm này được gọi cả trong setup() (để bắt trường hợp giữ nút lúc cấp nguồn) VÀ ở đầu
// mỗi vòng loop() (để bắt trường hợp giữ nút bất cứ lúc nào trong lúc thiết bị đang chạy).
// Nếu nút không được giữ, hàm thoát ngay lập tức ở dòng đầu tiên nên gọi liên tục trong
// loop() không tốn chi phí đáng kể.
void checkFactoryReset() {
  if (!resetPinsInitialized) {
    pinMode(RESET_BUTTON_PIN, INPUT_PULLUP);
    pinMode(STATUS_LED_PIN, OUTPUT);
    ledOff();
    resetPinsInitialized = true;
  }

  if (digitalRead(RESET_BUTTON_PIN) != LOW) return; // không giữ nút -> bỏ qua, thoát ngay

  Serial.println("Đang giữ nút RESET... (3s = xóa WiFi, 6s = xóa toàn bộ)");
  unsigned long start = millis();
  bool wifiStageAnnounced = false;
  bool factoryStageAnnounced = false;

  while (digitalRead(RESET_BUTTON_PIN) == LOW) {
    unsigned long held = millis() - start;

    if (held >= RESET_HOLD_WIFI_MS && !wifiStageAnnounced) {
      wifiStageAnnounced = true;
      Serial.println("-> Đã đủ 3s: thả nút ngay để CHỈ reset WiFi (giữ mã ghép nối).");
      ledBlink(2, 120, 120); // báo mốc 1 đạt được
    }
    if (held >= RESET_HOLD_FACTORY_MS && !factoryStageAnnounced) {
      factoryStageAnnounced = true;
      Serial.println("-> Đã đủ 6s: thả nút ngay để RESET TOÀN BỘ thiết bị.");
      ledBlink(4, 80, 80); // báo mốc 2 đạt được (nháy nhanh hơn, nhiều hơn)
    }

    // Cho ăn watchdog trong lúc giữ nút, phòng khi watchdog đã được bật (gọi từ loop())
    // và người dùng giữ nút lâu hơn WDT_TIMEOUT_SECONDS.
    esp_task_wdt_reset();

    // Trong lúc giữ, LED sáng liên tục để người dùng biết nút đang được nhận
    digitalWrite(STATUS_LED_PIN, HIGH);
    delay(10);
  }
  ledOff();

  unsigned long totalHeld = millis() - start;

  if (totalHeld >= RESET_HOLD_FACTORY_MS) {
    // RESET TOÀN BỘ: xóa WiFi + mã ghép nối
    Serial.println("== RESET TOÀN BỘ THIẾT BỊ ==");
    ledBlink(6, 100, 100);
    WiFiManager wm;
    wm.resetSettings();
    prefs.begin("device", false);
    prefs.clear();
    prefs.end();
    delay(300);
    ESP.restart();

  } else if (totalHeld >= RESET_HOLD_WIFI_MS) {
    // RESET WIFI: chỉ xóa thông tin WiFi, giữ nguyên mã ghép nối đã lưu
    Serial.println("== RESET WIFI (giữ mã ghép nối) ==");
    ledBlink(3, 150, 150);
    WiFiManager wm;
    wm.resetSettings();
    delay(300);
    ESP.restart();

  } else {
    // Giữ chưa đủ 3 giây -> bỏ qua, chạy tiếp bình thường
    Serial.println("Thả nút quá sớm, bỏ qua reset. Tiếp tục khởi động/chạy bình thường.");
  }
}

// ========================================================
// HÀM PHỤ (giống bản trước)
// ========================================================

void setRelay(int pin, bool turnOn) {
  bool level = RELAY_LOW_TRIGGER ? !turnOn : turnOn;
  digitalWrite(pin, level ? HIGH : LOW);
}

void addAuthHeaders(HTTPClient &http) {
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  http.addHeader("Content-Type", "application/json");
}

bool lastFetchCodeInvalid = false; // true = mã ghép nối không tồn tại trong Supabase (khác với lỗi mạng)

bool fetchDeviceId() {
  lastFetchCodeInvalid = false;
  String url = String(SUPABASE_URL) + "/rest/v1/devices?device_code=eq." +
               deviceCode + "&select=id";
  HTTPClient http;
  http.begin(url);
  addAuthHeaders(http);

  int httpCode = http.GET();
  bool ok = false;
  if (httpCode == 200) {
    String response = http.getString();
    StaticJsonDocument<256> doc;
    deserializeJson(doc, response);
    if (doc.is<JsonArray>() && doc.size() > 0) {
      deviceId = doc[0]["id"].as<String>();
      Serial.println("Đã tìm thấy device_id: " + deviceId);
      ok = true;
    } else {
      Serial.println("Mã ghép nối không tồn tại trong Supabase!");
      lastFetchCodeInvalid = true;
    }
  } else {
    Serial.printf("Lỗi tra cứu device: HTTP %d\n", httpCode);
  }
  http.end();
  return ok;
}

void sendHeartbeat() {
  String url = String(SUPABASE_URL) + "/rest/v1/devices?id=eq." + deviceId;
  HTTPClient http;
  http.begin(url);
  addAuthHeaders(http);
  http.addHeader("Prefer", "return=minimal");
  StaticJsonDocument<64> doc;
  doc["is_online"] = true;
  String payload;
  serializeJson(doc, payload);
  int httpCode = http.sendRequest("PATCH", payload);
  Serial.printf("[Heartbeat] HTTP %d\n", httpCode);
  http.end();
}

void pushSensorData(float temp, float humidity, int soilPercent) {
  String url = String(SUPABASE_URL) + "/rest/v1/sensor_readings";
  HTTPClient http;
  http.begin(url);
  addAuthHeaders(http);
  http.addHeader("Prefer", "return=minimal");
  StaticJsonDocument<256> doc;
  doc["device_id"] = deviceId;
  doc["temperature"] = temp;
  doc["humidity"] = humidity;
  doc["soil_moisture"] = soilPercent;
  String payload;
  serializeJson(doc, payload);
  int httpCode = http.POST(payload);
  Serial.printf("[sensor_readings] HTTP %d\n", httpCode);
  http.end();
}

void insertControlLog(String actuator, String action, String mode) {
  String url = String(SUPABASE_URL) + "/rest/v1/control_logs";
  HTTPClient http;
  http.begin(url);
  addAuthHeaders(http);
  http.addHeader("Prefer", "return=minimal");
  StaticJsonDocument<256> doc;
  doc["device_id"] = deviceId;
  doc["actuator"] = actuator;
  doc["action"] = action;
  doc["mode"] = mode;
  String payload;
  serializeJson(doc, payload);
  int httpCode = http.POST(payload);
  Serial.printf("[control_logs] %s %s (%s) - HTTP %d\n",
                actuator.c_str(), action.c_str(), mode.c_str(), httpCode);
  http.end();
}

void updateActuatorStates(bool fanOn, bool lightOn) {
  String url = String(SUPABASE_URL) + "/rest/v1/actuator_states?device_id=eq." + deviceId;
  HTTPClient http;
  http.begin(url);
  addAuthHeaders(http);
  http.addHeader("Prefer", "return=minimal");
  StaticJsonDocument<128> doc;
  doc["fan_state"] = fanOn;
  doc["light_state"] = lightOn;
  String payload;
  serializeJson(doc, payload);
  int httpCode = http.sendRequest("PATCH", payload);
  Serial.printf("[actuator_states] cập nhật - HTTP %d\n", httpCode);
  http.end();
}

void pollActuatorStates(float temp, int soilPercent) {
  String url = String(SUPABASE_URL) + "/rest/v1/actuator_states?device_id=eq." +
               deviceId + "&select=fan_state,light_state,mode";
  HTTPClient http;
  http.begin(url);
  addAuthHeaders(http);

  int httpCode = http.GET();
  if (httpCode == 200) {
    String response = http.getString();
    StaticJsonDocument<256> doc;
    deserializeJson(doc, response);

    if (doc.is<JsonArray>() && doc.size() > 0) {
      bool dbFan = doc[0]["fan_state"];
      bool dbLight = doc[0]["light_state"];
      String mode = doc[0]["mode"].as<String>();

      if (mode == "manual") {
        setRelay(RELAY_FAN, dbFan);
        setRelay(RELAY_LIGHT, dbLight);
        currentFanState = dbFan;
        currentLightState = dbLight;

      } else if (mode == "auto") {
        bool newFanState = currentFanState;
        if (temp > TEMP_ON_FAN) newFanState = true;
        else if (temp < TEMP_OFF_FAN) newFanState = false;

        bool newLightState = (soilPercent < SOIL_DRY_LIGHT);

        setRelay(RELAY_FAN, newFanState);
        setRelay(RELAY_LIGHT, newLightState);

        if (newFanState != currentFanState) insertControlLog("fan", newFanState ? "on" : "off", "auto");
        if (newLightState != currentLightState) insertControlLog("light", newLightState ? "on" : "off", "auto");
        if (newFanState != currentFanState || newLightState != currentLightState)
          updateActuatorStates(newFanState, newLightState);

        currentFanState = newFanState;
        currentLightState = newLightState;
      }

      Serial.printf("[Mode: %s] Quạt: %s | Đèn: %s\n",
                    mode.c_str(),
                    currentFanState ? "BẬT" : "TẮT",
                    currentLightState ? "BẬT" : "TẮT");
    }
  } else {
    Serial.printf("[actuator_states] Lỗi đọc: HTTP %d\n", httpCode);
  }
  http.end();
}

// ========================================================
// SETUP & LOOP
// ========================================================

void setup() {
  Serial.begin(115200);
  dht.begin();

  pinMode(RELAY_FAN, OUTPUT);
  pinMode(RELAY_LIGHT, OUTPUT);
  setRelay(RELAY_FAN, false);
  setRelay(RELAY_LIGHT, false);

  checkFactoryReset();
  setupWiFiAndPairing();

  // MỚI: mở trang cập nhật firmware qua WiFi ngay sau khi có WiFi, để có thể cập nhật
  // bất cứ lúc nào thiết bị đang chạy, không cần đợi lấy xong device_id.
  setupOtaWebServer();

  // Bật watchdog SAU KHI xong cấu hình WiFi/mã ghép nối (xem giải thích ở WDT_TIMEOUT_SECONDS).
  initWatchdog();

  int invalidCodeAttempts = 0;
  const int MAX_INVALID_CODE_ATTEMPTS = 3; // sau 3 lần mã sai liên tiếp -> tự mở lại cổng cấu hình

  while (true) {
    esp_task_wdt_reset(); // "cho ăn" watchdog mỗi vòng lặp để tránh reset oan khi vẫn đang hoạt động bình thường

    if (deviceCode.length() == 0) {
      Serial.println("LỖI: Mã ghép nối đang trống! Khởi động lại và nhập mã trong cổng cấu hình (mã trống -> cổng sẽ tự mở).");
    } else if (fetchDeviceId()) {
      break; // Đã lấy được device_id thành công, thoát vòng lặp
    } else if (lastFetchCodeInvalid) {
      // Mã ghép nối không tồn tại trong hệ thống (khách gõ sai) -> đếm số lần thử
      invalidCodeAttempts++;
      Serial.printf("Mã ghép nối không đúng (lần %d/%d)\n", invalidCodeAttempts, MAX_INVALID_CODE_ATTEMPTS);
      ledBlink(4, 100, 100); // báo hiệu mã sai cho khách hàng biết có vấn đề

      if (invalidCodeAttempts >= MAX_INVALID_CODE_ATTEMPTS) {
        Serial.println("Sai mã quá nhiều lần -> tự động mở lại cổng cấu hình để nhập lại mã.");
        ledBlink(6, 120, 120);
        prefs.begin("device", false);
        prefs.remove("device_code"); // chỉ xóa mã, giữ nguyên WiFi đã lưu cho đỡ phải nhập lại
        prefs.end();
        deviceCode = "";
        invalidCodeAttempts = 0;
        esp_task_wdt_delete(NULL); // gỡ watchdog trước khi vào lại cổng cấu hình (có thể chờ lâu)
        setupWiFiAndPairing();     // sẽ tự ép mở cổng vì mã đã bị xóa
        esp_task_wdt_add(NULL);    // đăng ký lại watchdog sau khi cấu hình xong
        continue;
      }
    }
    // Lỗi mạng/server (không phải do mã sai) -> chỉ cần thử lại, không cần mở cổng
    Serial.println("Thử lại sau 5 giây...");
    delay(5000);
  }
}

void loop() {
  esp_task_wdt_reset(); // cho ăn watchdog đầu mỗi vòng lặp - nếu loop() bị treo quá WDT_TIMEOUT_SECONDS, ESP32 sẽ tự khởi động lại

  // Cho phép giữ nút RESET bất cứ lúc nào trong lúc thiết bị đang chạy bình thường,
  // không chỉ lúc mới khởi động. checkFactoryReset() tự thoát ngay lập tức nếu nút
  // không được giữ, nên gọi mỗi vòng loop() gần như không tốn chi phí gì.
  checkFactoryReset();

  otaServer.handleClient(); // xử lý request tới trang /update (nếu có ai đang cập nhật firmware)

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Mất WiFi, đang thử kết nối lại...");
    WiFi.reconnect();
    delay(3000);
    return;
  }

  unsigned long now = millis();

  if (now - lastSensorPush >= SENSOR_PUSH_INTERVAL) {
    lastSensorPush = now;
    float temp = dht.readTemperature();
    float humidity = dht.readHumidity();
    int soilRaw = analogRead(SOIL_PIN);
    int soilPercent = map(soilRaw, 4095, 0, 0, 100);

    if (!isnan(temp) && !isnan(humidity)) {
      lastTemp = temp;
      lastSoilPercent = soilPercent;
      Serial.printf("Nhiệt độ: %.1f°C - Độ ẩm KK: %.1f%% - Độ ẩm đất: %d%%\n",
                    temp, humidity, soilPercent);
      pushSensorData(temp, humidity, soilPercent);
    } else {
      Serial.println("Lỗi đọc DHT11!");
    }
  }

  if (now - lastControlPoll >= CONTROL_POLL_INTERVAL) {
    lastControlPoll = now;
    pollActuatorStates(lastTemp, lastSoilPercent);
  }

  if (now - lastHeartbeat >= HEARTBEAT_INTERVAL) {
    lastHeartbeat = now;
    sendHeartbeat();
  }
}
