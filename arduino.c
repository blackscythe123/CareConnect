#include <WiFi.h>
#include <WebSocketsClient.h>
#include <Wire.h>
#include <MPU6050.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>
#include <Adafruit_MLX90614.h>
#include "esp_bt.h"

// ===================== WiFi =====================
const char* ssid = "AndroidAP";
const char* password = "123456789";

// ============== Render WebSocket ===============
const char* serverHost = "project123-0xep.onrender.com";
const uint16_t serverPort = 443;
const char* serverPath = "/ws";

WebSocketsClient webSocket;

// ================= Sensors =====================
const int ecgPin = 2;
MPU6050 mpu;
Adafruit_MLX90614 mlx = Adafruit_MLX90614();

// ================= BLE =========================
const char TARGET_MAC[] = "ED:FA:8D:D9:69:F9";

BLEScan* pBLEScan;
volatile unsigned long lastRoomSeen = 0;

const unsigned long ROOM_HOLD_MS = 5000;
const unsigned long BLE_SCAN_DURATION = 2;
const unsigned long BLE_RESTART_MS = 3000;
unsigned long lastBLEStart = 0;

// ================= ECG =========================
const unsigned long SAMPLE_INTERVAL_US = 5000; // 200Hz
unsigned long lastSampleTime = 0;

// ================= BLE Callback ================
class MyAdvertisedDeviceCallbacks : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice device) {

    String mac = device.getAddress().toString();
    mac.toUpperCase();

    if (mac.equals(TARGET_MAC)) {
      lastRoomSeen = millis();
    }
  }
};

// ================= WebSocket ===================
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  if (type == WStype_CONNECTED) {
    Serial.println("[WSS] Connected to Render");
    webSocket.sendTXT("{\"type\":\"auth\",\"role\":\"device\"}");
  }
  else if (type == WStype_DISCONNECTED) {
    Serial.println("[WSS] Disconnected");
  }
}

// ================= Setup =======================
void setup() {
  Serial.begin(115200);

  // Free classic BT memory
  esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT);

  pinMode(ecgPin, INPUT);

  // WiFi
  WiFi.begin(ssid, password);
  Serial.print("[WIFI] Connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println("\n[WIFI] Connected");

  // I2C
  Wire.begin();

  // MPU6050
  mpu.initialize();
  if (!mpu.testConnection()) Serial.println("MPU6050 FAILED");

  // MLX90614
  if (!mlx.begin()) Serial.println("MLX90614 FAILED");

  // WebSocket
  webSocket.beginSSL(serverHost, serverPort, serverPath, "");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);

  // BLE
  BLEDevice::init("");
  pBLEScan = BLEDevice::getScan();
  pBLEScan->setAdvertisedDeviceCallbacks(new MyAdvertisedDeviceCallbacks());
  pBLEScan->setActiveScan(false);
  pBLEScan->setInterval(160);
  pBLEScan->setWindow(80);

  lastBLEStart = millis();
  pBLEScan->start(BLE_SCAN_DURATION, false);

  Serial.println("System ready");
}

// ================= Send Data ===================
void sendSensorData() {
  if (!webSocket.isConnected()) return;

  int ecgValue = analogRead(ecgPin);

  int16_t ax, ay, az, gx, gy, gz;
  mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);

  float ambient = mlx.readAmbientTempC();
  float object  = mlx.readObjectTempC();

  int room = (millis() - lastRoomSeen < ROOM_HOLD_MS) ? 1 : 0;

  char msg[256];

  snprintf(msg, sizeof(msg),
    "{\"type\":\"device-data\",\"ecg\":%d,\"ax\":%d,\"ay\":%d,\"az\":%d,"
    "\"gx\":%d,\"gy\":%d,\"gz\":%d,\"ambient\":%.2f,\"object\":%.2f,\"room\":%d}",
    ecgValue, ax, ay, az, gx, gy, gz, ambient, object, room
  );

  webSocket.sendTXT(msg);
}

// ================= Loop ========================
void loop() {
  webSocket.loop();

  // Restart BLE scan
  if (millis() - lastBLEStart > BLE_RESTART_MS) {
    lastBLEStart = millis();
    pBLEScan->stop();
    pBLEScan->start(BLE_SCAN_DURATION, false);
  }

  // ECG + sensors
  unsigned long nowUs = micros();
  if (nowUs - lastSampleTime >= SAMPLE_INTERVAL_US) {
    lastSampleTime = nowUs;
    sendSensorData();
  }
}