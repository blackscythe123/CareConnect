#include <WiFi.h>
#include <WebSocketsClient.h>
#include <WiFiClientSecure.h>

// WiFi Credentials - UPDATE THESE FOR YOUR NETWORK
const char* ssid = "AndroidAP";          // <-- set your SSID here
const char* password = "123456789";      // <-- set your WiFi password here

// Render Server Details (Do NOT include "https://" or "wss://")
// UPDATE THIS after deploying to Render - it should match your Render service URL
// Example: "careconnect-dashboard.onrender.com"
const char* serverHost = "project123-0xep.onrender.com"; // <-- replace with your Render domain
const uint16_t serverPort = 443;  // Always 443 for Render (HTTPS/WSS)

WebSocketsClient webSocket;

unsigned long lastSend = 0;
const unsigned long sendInterval = 2000; // 2s heartbeat / device data send

// Reconnection/backoff
unsigned long lastReconnectAttempt = 0;
unsigned long reconnectInterval = 5000; // start 5s
const unsigned long maxReconnectInterval = 60000; // cap at 60s

// Helper: initialize or re-init websocket connection
void initWebSocket(){
    Serial.printf("[WSS] Initializing connection to %s:%u...\n", serverHost, serverPort);
    webSocket.beginSSL(serverHost, serverPort, "/ws");
    // Use setInsecure() by default to avoid frequent cert issues on Render.
    // Remove or change this for a production-pinned setup.
    webSocket.setInsecure();
    webSocket.onEvent(webSocketEvent);
}

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
    switch(type) {
        case WStype_DISCONNECTED:
            Serial.println("[WSS] Disconnected!");
            // schedule reconnect
            lastReconnectAttempt = millis();
            break;
        case WStype_CONNECTED:
            Serial.printf("[WSS] Connected\n");
            // reset backoff
            reconnectInterval = 5000;
            // Identify as device upon connection
            webSocket.sendTXT("{\"type\":\"auth\",\"role\":\"device\"}");
            break;
        case WStype_TEXT:
            Serial.printf("[WSS] Received: %s\n", payload);
            // handle incoming JSON messages here if needed
            break;
        case WStype_ERROR:
            Serial.println("[WSS] Error occurred!");
            break;
        case WStype_PING:
            Serial.println("[WSS] Ping received");
            break;
        case WStype_PONG:
            Serial.println("[WSS] Pong received");
            break;
    }
}

void setup() {
    Serial.begin(115200);

    WiFi.begin(ssid, password);
    Serial.print("[WIFI] Connecting");
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\n[WIFI] Connected");

    initWebSocket();
}

void sendDeviceData(){
    if(webSocket.isConnected()){
        // example payload; replace with your sensor readings
        String msg = "{\"type\":\"device-data\",\"ecg\":123,\"ax\":1.5}";
        webSocket.sendTXT(msg);
        Serial.println("[WSS] Data Sent");
    } else {
        Serial.println("[WSS] Not connected, skipping send");
    }
}

void loop() {
    webSocket.loop();

    // Reconnect logic with exponential backoff
    if(!webSocket.isConnected() && (millis() - lastReconnectAttempt > reconnectInterval)){
        Serial.printf("[WSS] Attempting reconnect (interval %lums)...\n", reconnectInterval);
        initWebSocket();
        lastReconnectAttempt = millis();
        reconnectInterval = min(maxReconnectInterval, reconnectInterval * 2);
    }

    // Periodic device heartbeat / data send
    if(millis() - lastSend > sendInterval){
        lastSend = millis();
        sendDeviceData();
    }
}

