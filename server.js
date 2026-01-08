/**
 * Cloud Server for ESP32 + Dashboard (Supabase Version)
 */

import "dotenv/config";
import express from "express";
import http from "http";
import path from "path";
import cors from "cors";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

// Fix __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const app = express();
const server = http.createServer(app);

// ---------- SUPABASE ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY   // backend key
);

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- EMAIL CONFIG ----------
let emailConfig = { email: "", password: "" };

async function loadEmailConfig() {
  const { data, error } = await supabase
    .from("email_config")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (!error && data) {
    emailConfig.email = data.email;
    emailConfig.password = data.password;
  }
}
loadEmailConfig();

async function sendEmail(subject, text) {
  if (!emailConfig.email || !emailConfig.password) {
    console.log("⚠ Email not set");
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: emailConfig.email,
        pass: emailConfig.password,
      },
    });

    await transporter.sendMail({
      from: emailConfig.email,
      to: emailConfig.email,
      subject,
      text,
    });

    console.log("📧 Email sent");
  } catch (err) {
    console.log("Email error:", err);
  }
}

// ---------- REST API ----------

// Email config
app.post("/api/email-config", async (req, res) => {
  const { email, password } = req.body;

  const { error } = await supabase
    .from("email_config")
    .upsert({ id: 1, email, password });

  if (error) return res.status(500).json({ error: error.message });

  emailConfig.email = email;
  emailConfig.password = password;
  res.json({ success: true });
});

app.get("/api/email-config", (_, res) => {
  res.json({ email: emailConfig.email });
});

// Medicines
app.get("/api/medicines", async (_, res) => {
  const { data, error } = await supabase
    .from("medicines")
    .select("*")
    .order("name");

  error ? res.status(500).json({ error: error.message }) : res.json(data);
});

app.post("/api/medicines", async (req, res) => {
  const { name, count, expiry_date } = req.body;

  const { data, error } = await supabase
    .from("medicines")
    .insert([{ name, count, expiry_date }])
    .select()
    .single();

  error ? res.status(500).json({ error: error.message }) : res.json(data);
});

app.delete("/api/medicines/:id", async (req, res) => {
  const { error, count } = await supabase
    .from("medicines")
    .delete()
    .eq("id", req.params.id);

  error ? res.status(500).json({ error: error.message }) : res.json({ deleted: count });
});

app.post("/api/medicines/:id/consume", async (req, res) => {
  const id = req.params.id;

  const { data: med } = await supabase
    .from("medicines")
    .select("*")
    .eq("id", id)
    .single();

  if (!med) return res.status(404).json({ error: "Not found" });
  if (med.count <= 0) return res.status(400).json({ error: "Out of stock" });

  const newCount = med.count - 1;
  await supabase.from("medicines").update({ count: newCount }).eq("id", id);
  await supabase.from("consumption_logs").insert([{ medicine_id: id, medicine_name: med.name }]);

  if (newCount === 0) await sendEmail(`🚨 ${med.name} OUT`, `Stock empty for ${med.name}`);

  res.json({ success: true, newCount });
});

// Reminders
app.get("/api/reminders", async (_, res) => {
  const { data, error } = await supabase
    .from("reminders")
    .select("*")
    .order("id", { ascending: false });

  error ? res.status(500).json({ error: error.message }) : res.json(data);
});

app.post("/api/reminders", async (req, res) => {
  const { title, details, iso_date, repeats, medicine_id } = req.body;

  const { data, error } = await supabase
    .from("reminders")
    .insert([{ title, details, iso_date, repeats, medicine_id }])
    .select()
    .single();

  error ? res.status(500).json({ error: error.message }) : res.json(data);
});

app.delete("/api/reminders/:id", async (req, res) => {
  const { error } = await supabase
    .from("reminders")
    .delete()
    .eq("id", req.params.id);

  error ? res.status(500).json({ error: error.message }) : res.json({ success: true });
});

// Logs
app.get("/api/consumption-logs", async (_, res) => {
  const { data, error } = await supabase
    .from("consumption_logs")
    .select("*")
    .order("consumed_at", { ascending: false });

  error ? res.status(500).json({ error: error.message }) : res.json(data);
});

// Emergency
let clients = new Set();
function broadcast(msg) {
  clients.forEach(ws => ws.readyState === 1 && ws.send(msg));
}

app.post("/api/emergency", async (_, res) => {
  broadcast(JSON.stringify({ type: "emergency", time: new Date().toISOString() }));
  await sendEmail("🚨 EMERGENCY ALERT", "Button pressed!");
  res.json({ ok: true });
});

// ---------- WEBSOCKETS ----------
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      broadcast(JSON.stringify({ type: "device-data", data }));
    } catch (_) {}
  });
});

// ---------- SPA ----------
app.get("*", (_, res) =>
  res.sendFile(path.join(__dirname, "public/index.html"))
);

// ---------- START ----------
server.listen(PORT, () =>
  console.log(`🚀 Running on port ${PORT}`)
);
