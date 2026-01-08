/**
 * server.js - ESP32 Client → Cloud Dashboard (Render + Local)
 * - Uses Supabase as DB
 * - Serves dashboard
 * - Accepts WebSocket connection FROM ESP32
 * - Broadcasts ECG + MPU data to UI clients
 * - Full CRUD for medicines & reminders
 * - Logs consumption
 * - Sends notification emails
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { WebSocketServer } = require('ws');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 8080;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY); // server key
console.log(SUPABASE_URL)
const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// -------- Email Helper --------
let emailConfig = { email: "", password: "" };

async function loadEmailConfig() {
  const { data, error } = await supabase.from('email_config').select('*').eq('id', 1).single();
  if (!error && data) emailConfig = { email: data.email, password: data.password };
}
loadEmailConfig();

async function sendEmail(subject, text) {
  if (!emailConfig.email || !emailConfig.password) return;
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: emailConfig.email, pass: emailConfig.password }
    });
    await transporter.sendMail({ from: emailConfig.email, to: emailConfig.email, subject, text });
    console.log("Email sent");
  } catch (err) {
    console.log("Email error:", err);
  }
}

// -------- API Routes --------

// Email config
app.post('/api/email-config', async (req, res) => {
  const { email, password } = req.body;
  const { error } = await supabase.from('email_config').upsert({ id: 1, email, password });
  if (error) return res.status(500).json({ error: error.message });
  emailConfig = { email, password };
  res.json({ success: true });
});

app.get('/api/email-config', async (req, res) => {
  await loadEmailConfig();
  res.json({ email: emailConfig.email || "" });
});

// Medicines
app.get('/api/medicines', async (req, res) => {
  const { data, error } = await supabase.from('medicines').select('*').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/medicines', async (req, res) => {
  const { name, count, expiry_date } = req.body;
  const { data, error } = await supabase.from('medicines').insert([{ name, count, expiry_date }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/medicines/:id', async (req, res) => {
  const { data, error } = await supabase.from('medicines').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: data.length });
});

app.post('/api/medicines/:id/consume', async (req, res) => {
  const { id } = req.params;
  const { data: medicine, error } = await supabase.from('medicines').select('*').eq('id', id).single();
  if (error || !medicine) return res.status(404).json({ error: "Not found" });
  if (medicine.count <= 0) return res.status(400).json({ error: "Out of stock" });

  const newCount = medicine.count - 1;
  await supabase.from('medicines').update({ count: newCount }).eq('id', id);
  await supabase.from('consumption_logs').insert([{ medicine_id: id, medicine_name: medicine.name }]);

  if (newCount === 0) sendEmail(`🚨 ${medicine.name} is OUT`, `Stock empty for ${medicine.name}`);
  res.json({ success: true, newCount });
});

// Reminders
app.get('/api/reminders', async (req, res) => {
  const { data, error } = await supabase.from('reminders').select('*').order('id', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/reminders', async (req, res) => {
  const { title, details, iso_date, repeats, medicine_id } = req.body;
  const { data, error } = await supabase.from('reminders').insert([{ title, details, iso_date, repeats, medicine_id }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/reminders/:id', async (req, res) => {
  const { data, error } = await supabase.from('reminders').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: data.length });
});

// Consumption logs
app.get('/api/consumption-logs', async (req, res) => {
  const { data, error } = await supabase.from('consumption_logs').select('*').order('consumed_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Emergency
let clients = new Set();
function broadcast(msg) { for (const ws of clients) if (ws.readyState === 1) ws.send(msg); }

app.post('/api/emergency', async (req, res) => {
  const payload = { type: "emergency", time: new Date().toISOString(), details: req.body.details || "Button pressed" };
  broadcast(JSON.stringify(payload));
  await sendEmail("🚨 EMERGENCY ALERT", JSON.stringify(payload));
  res.json({ ok: true });
});

// -------- WebSocket --------
const wss = new WebSocketServer({ server, path: "/ws" });
let latestDeviceData = null;

wss.on("connection", (ws) => {
  clients.add(ws);
  if (latestDeviceData) ws.send(JSON.stringify({ type: "device-data", data: latestDeviceData }));
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      latestDeviceData = data;
      broadcast(JSON.stringify({ type: "device-data", data }));
    } catch (_) {}
  });
  ws.on("close", () => clients.delete(ws));
});

// Serve SPA
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// -------- Start Server --------
server.listen(PORT, () => console.log(`🌍 Server running on http://localhost:${PORT}`));
