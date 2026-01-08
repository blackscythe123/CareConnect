/**
 * server.js - Updated with Medicine Management
 * - Serves dashboard on port 8080
 * - Connects to ESP32 WebSocket on port 81
 * - Forwards live ECG & MPU data to all connected dashboard clients
 * - Medicine cabinet with CRUD operations
 * - Consumption logs tracking
 * - Email notifications for low stock and emergencies
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { WebSocketServer } = require('ws');
const bodyParser = require('body-parser');
const cors = require('cors');
const WebSocket = require('ws');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 8080;
const ESP32_IP = process.env.ESP32_IP || '172.21.102.235';
const ESP32_WS_PORT = process.env.ESP32_WS_PORT || 81;
const DB_FILE = process.env.DB_FILE || './data/reminders.db';

const app = express();
const server = http.createServer(app);

// ---------------- Middlewares ----------------
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- Email Configuration Storage ----------------
let emailConfig = {
  email: '',
  password: ''
};

// ---------------- SQLite DB ----------------
const dbDir = path.dirname(DB_FILE);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new sqlite3.Database(DB_FILE);

db.serialize(() => {
  // Reminders table
  db.run(`CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    details TEXT,
    iso_date TEXT,
    repeats TEXT,
    medicine_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    active INTEGER DEFAULT 1,
    FOREIGN KEY (medicine_id) REFERENCES medicines(id)
  )`);

  // Medicines table
  db.run(`CREATE TABLE IF NOT EXISTS medicines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    count INTEGER NOT NULL DEFAULT 0,
    expiry_date TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Consumption logs table
  db.run(`CREATE TABLE IF NOT EXISTS consumption_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    medicine_id INTEGER NOT NULL,
    medicine_name TEXT NOT NULL,
    consumed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (medicine_id) REFERENCES medicines(id)
  )`);

  // Email config table
  db.run(`CREATE TABLE IF NOT EXISTS email_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    email TEXT NOT NULL,
    password TEXT NOT NULL
  )`);

  // Load email config
  db.get('SELECT * FROM email_config WHERE id = 1', [], (err, row) => {
    if (!err && row) {
      emailConfig.email = row.email;
      emailConfig.password = row.password;
    }
  });
});

// ------------- Email Helper Function -----------
async function sendEmail(subject, text) {
  if (!emailConfig.email || !emailConfig.password) {
    console.log('Email config not set. Skipping email notification.');
    return { success: false, message: 'Email not configured' };
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: emailConfig.email,
        pass: emailConfig.password
      }
    });

    await transporter.sendMail({
      from: emailConfig.email,
      to: emailConfig.email,
      subject: subject,
      text: text
    });

    console.log('Email sent successfully');
    return { success: true };
  } catch (error) {
    console.error('Error sending email:', error);
    return { success: false, message: error.message };
  }
}

// ------------- Email Config Endpoints -----------
app.post('/api/email-config', (req, res) => {
  const { email, password } = req.body;
  
  db.run(`INSERT OR REPLACE INTO email_config (id, email, password) VALUES (1, ?, ?)`,
    [email, password],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      emailConfig.email = email;
      emailConfig.password = password;
      res.json({ success: true });
    }
  );
});

app.post("/data", (req, res) => {
  console.log("Data received:", req.body);
  res.send("OK");
});

app.get('/api/email-config', (req, res) => {
  db.get('SELECT email FROM email_config WHERE id = 1', [], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ email: row ? row.email : '' });
  });
});

// ------------- Medicine CRUD Endpoints -----------
app.get('/api/medicines', (req, res) => {
  db.all('SELECT * FROM medicines ORDER BY name ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/medicines', (req, res) => {
  const { name, count, expiry_date } = req.body;
  const stmt = db.prepare('INSERT INTO medicines (name, count, expiry_date) VALUES (?, ?, ?)');
  stmt.run(name, count, expiry_date, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID });
  });
});

app.delete('/api/medicines/:id', (req, res) => {
  const id = req.params.id;
  db.run('DELETE FROM medicines WHERE id=?', [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ deleted: this.changes });
  });
});

app.post('/api/medicines/:id/consume', (req, res) => {
  const id = req.params.id;
  
  // Get medicine details
  db.get('SELECT * FROM medicines WHERE id=?', [id], async (err, medicine) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!medicine) return res.status(404).json({ error: 'Medicine not found' });
    
    if (medicine.count <= 0) {
      return res.status(400).json({ error: 'Medicine out of stock' });
    }

    // Decrease count
    db.run('UPDATE medicines SET count = count - 1 WHERE id=?', [id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      const newCount = medicine.count - 1;

      // Log consumption
      db.run('INSERT INTO consumption_logs (medicine_id, medicine_name) VALUES (?, ?)',
        [id, medicine.name],
        function(err) {
          if (err) console.error('Error logging consumption:', err);
        }
      );

      // Send email if count reaches zero
      if (newCount === 0) {
        sendEmail(
          `🚨 Medicine Out of Stock: ${medicine.name}`,
          `The medicine "${medicine.name}" has run out of stock. Please restock immediately.`
        );
      }

      res.json({ success: true, newCount });
    });
  });
});

// ------------- Consumption Logs Endpoint -----------
app.get('/api/consumption-logs', (req, res) => {
  const { medicine_id } = req.query;
  let query = 'SELECT * FROM consumption_logs';
  let params = [];

  if (medicine_id) {
    query += ' WHERE medicine_id = ?';
    params.push(medicine_id);
  }

  query += ' ORDER BY consumed_at DESC';

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ------------- CRUD for Reminders -----------
app.get('/api/reminders', (req, res) => {
  db.all('SELECT * FROM reminders ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/reminders', (req, res) => {
  const { title, details, iso_date, repeats, medicine_id } = req.body;
  const stmt = db.prepare('INSERT INTO reminders (title, details, iso_date, repeats, medicine_id) VALUES (?, ?, ?, ?, ?)');
  stmt.run(title, details || '', iso_date || '', repeats || 'none', medicine_id || null, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID });
  });
});

app.delete('/api/reminders/:id', (req, res) => {
  const id = req.params.id;
  db.run('DELETE FROM reminders WHERE id=?', [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ deleted: this.changes });
  });
});

// ------------- Emergency Endpoint ------------
let clients = new Set();
function broadcastToClients(msg) {
  for (const c of clients) {
    if (c.readyState === 1) {
      try { c.send(msg); } catch (e) { }
    }
  }
}

app.post('/api/emergency', async (req, res) => {
  const details = req.body.details || 'Emergency button pressed';
  const payload = { 
    type: 'emergency', 
    time: new Date().toISOString(), 
    details 
  };
  
  broadcastToClients(JSON.stringify(payload));

  // Send emergency email
  await sendEmail(
    '🚨 EMERGENCY ALERT - CareConnect',
    `Emergency alert received at ${new Date().toLocaleString()}\n\nDetails: ${details}`
  );

  res.json({ ok: true });
});

// --------- ESP32 WebSocket Client -----------
let latestDeviceData = null;
const espWS = new WebSocket(`ws://${ESP32_IP}:${ESP32_WS_PORT}/`);

espWS.on('open', () => console.log('Connected to ESP32 WebSocket'));
espWS.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    latestDeviceData = msg;

    const payload = JSON.stringify({ type: 'device-data', time: new Date().toISOString(), data: msg });
    broadcastToClients(payload);
  } catch (e) { console.log('Invalid ESP32 data', data.toString()); }
});
espWS.on('close', () => console.log('ESP32 WebSocket disconnected'));
espWS.on('error', (err) => console.log('ESP32 WebSocket error:', err));

// ---------- Dashboard WebSocket Server -------
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  clients.add(ws);
  // Send latest data immediately if available
  if (latestDeviceData) {
    ws.send(JSON.stringify({ type: 'device-data', time: new Date().toISOString(), data: latestDeviceData }));
  }

  ws.on('close', () => { clients.delete(ws); });
  ws.on('error', () => { clients.delete(ws); });
});

// ---------- Serve SPA HTML ------------------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/api/latest', (req, res) => res.json({ latest: latestDeviceData }));

// ---------- Start Server --------------------
server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});