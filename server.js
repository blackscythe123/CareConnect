/**
 * server.js - Render-ready with Supabase + WebSocket
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const bodyParser = require('body-parser');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const ort = require('onnxruntime-node');




// -------- Environment --------
const PORT = process.env.PORT || 8080;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// HAR / ONNX settings
const HAR_MODEL_PATH = process.env.HAR_MODEL_PATH || path.join(__dirname, 'har_xgboost_model.onnx');
// Size of sliding window used for HAR model; adjust to match training
const HAR_WINDOW_SIZE = parseInt(process.env.HAR_WINDOW_SIZE || '10', 10);
const HAR_MIN_INTERVAL_MS = parseInt(process.env.HAR_MIN_INTERVAL_MS || '2000', 10);


if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();
const server = http.createServer(app);

// -------- Middlewares --------
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400 && 'body' in err))) {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  next(err);
});

// -------- WebSocket --------
let clients = new Set();
let latestDeviceData = null;
let harWindow = [];
let lastHarSentAt = 0;
let harSession = null;

// Load ONNX HAR model once at startup (if present)
(async () => {
  try {
    if (!fs.existsSync(HAR_MODEL_PATH)) {
      console.warn('[HAR] ONNX model not found at', HAR_MODEL_PATH);
      return;
    }
    harSession = await ort.InferenceSession.create(HAR_MODEL_PATH);
    console.log('[HAR] ONNX model loaded from', HAR_MODEL_PATH);
  } catch (e) {
    console.error('[HAR] Failed to load ONNX model:', e);
  }
})();

// Extract features from a window of samples (same as Python training)
function extractHarFeatures(windowArr) {
  const cols = ['ax', 'ay', 'az', 'gx', 'gy', 'gz'];
  const features = [];

  for (const col of cols) {
    const data = windowArr.map(s => s[col]);
    const n = data.length || 1;

    const mean = data.reduce((a, b) => a + b, 0) / n;

    const variance = data.reduce((a, b) => {
      const d = b - mean;
      return a + d * d;
    }, 0) / n;

    const std = Math.sqrt(variance);
    const min = Math.min(...data);
    const max = Math.max(...data);

    const sorted = [...data].sort((a, b) => a - b);
    const mid = Math.floor(n / 2);
    const median = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

    features.push(mean, std, min, max, median, variance);
  }

  return new Float32Array(features);
}

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on('connection', ws => {
  clients.add(ws);
  console.log('[WS] Client connected. Total:', clients.size);

  // Send latest data immediately to new client
  if (latestDeviceData) {
    ws.send(JSON.stringify({ type: 'device-data', data: latestDeviceData }));
  }

  ws.on('message', msg => {
    try {
      const parsed = JSON.parse(msg.toString());
      
      // Handle device authentication
      if (parsed.type === 'auth' && parsed.role === 'device') {
        console.log('[WS] Arduino device authenticated');
        return;
      }
      
      // Handle device data - Arduino sends: {type:"device-data", ecg:..., ax:..., etc}
      if (parsed.type === 'device-data') {
        // Extract the sensor data (everything except 'type')
        const { type, ...sensorData } = parsed;
        latestDeviceData = sensorData;
        
        // Broadcast to all clients with consistent format
        const broadcastMsg = JSON.stringify({ type: 'device-data', data: sensorData });
        for (const c of clients) {
          if (c.readyState === 1) c.send(broadcastMsg);
        }

        // ---- HAR window + ONNX prediction ----
        const sample = {
          ax: Number(sensorData.ax),
          ay: Number(sensorData.ay),
          az: Number(sensorData.az),
          gx: Number(sensorData.gx),
          gy: Number(sensorData.gy),
          gz: Number(sensorData.gz)
        };

        if (harSession && Object.values(sample).every(v => Number.isFinite(v))) {
          harWindow.push(sample);
          if (harWindow.length > HAR_WINDOW_SIZE) {
            harWindow.shift();
          }

          if (harWindow.length === HAR_WINDOW_SIZE) {
            const now = Date.now();
            if (now - lastHarSentAt >= HAR_MIN_INTERVAL_MS) {
              lastHarSentAt = now;

              (async () => {
                try {
                  const features = extractHarFeatures(harWindow); // Float32Array length 36
                  const tensor = new ort.Tensor('float32', features, [1, 36]);

                  const results = await harSession.run({ float_input: tensor });
                  const outputNames = Object.keys(results);

                  // Adjust these names if your ONNX export uses different output names
                  const probsTensor =
                    results.output_probability ||
                    results.probabilities ||
                    results[outputNames[1]];
                  const labelTensor =
                    results.output_label ||
                    results.predicted_class ||
                    results[outputNames[0]];

                  const probs = Array.from(probsTensor.data);
                  const predictedClass = Number(labelTensor.data[0]);

                  const confidence = Math.max(...probs);
                  const activity_map = {
                    0: "Falling",
                    1: "Lying",
                    2: "Running",
                    3: "Sitting",
                    4: "Standing",
                    5: "Walking"
                  };

                  const probability_map = {};
                  probs.forEach((p, i) => {
                    if (activity_map[i] !== undefined) {
                      probability_map[activity_map[i]] = p;
                    }
                  });

                  const predictionPayload = {
                    predicted_class: predictedClass,
                    predicted_activity: activity_map[predictedClass] || 'Unknown',
                    confidence,
                    probabilities: probability_map
                  };

                  console.log('[HAR] Prediction:', {
                    activity: predictionPayload.predicted_activity,
                    confidence: predictionPayload.confidence,
                    class: predictionPayload.predicted_class
                  });

                  const activityMsg = JSON.stringify({ type: 'activity', data: predictionPayload });
                  for (const c of clients) {
                    if (c.readyState === 1) c.send(activityMsg);
                  }
                } catch (e) {
                  console.warn('[HAR] ONNX inference error:', e.message);
                }
              })();
            }
          }
        }
      }
    } catch (e) {
      console.warn('[WS] Parse error:', e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('[WS] Client disconnected. Total:', clients.size);
  });
});

// -------- Helpers --------
let emailConfig = { email:'', password:'' };
async function sendEmail(subject, text){
  if(!emailConfig.email || !emailConfig.password) return;
  try{
    const transporter = nodemailer.createTransport({
      service:"gmail",
      auth: { user: emailConfig.email, pass: emailConfig.password }
    });
    await transporter.sendMail({ from: emailConfig.email, to: emailConfig.email, subject, text });
    console.log("Email sent:", subject);
  }catch(err){ console.log("Email error:", err); }
}

// -------- Health Check --------
app.get('/health', (_, res) => {
  res.json({ status:'healthy', timestamp:new Date().toISOString(), websocketClients: clients.size });
});

// -------- REST API --------

// Email Config
app.get('/api/email-config', async (_, res) => {
  const { data } = await supabase.from('email_config').select('*').eq('id',1).single();
  res.json(data || {});
});

app.post('/api/email-config', async (req, res) => {
  const { email, password } = req.body;
  emailConfig = { email, password };
  await supabase.from('email_config').upsert({ id:1, email, password });
  res.json({ ok:true });
});

// Medicines CRUD
app.get('/api/medicines', async (_, res) => {
  const { data, error } = await supabase.from('medicines').select('*').order('name');
  error ? res.status(500).json({ error }) : res.json(data);
});

app.post('/api/medicines', async (req, res) => {
  const { name, count, expiry_date } = req.body;
  const { data, error } = await supabase.from('medicines').insert([{ name, count, expiry_date }]).select().single();
  error ? res.status(500).json({ error }) : res.json(data);
});

app.delete('/api/medicines/:id', async (req,res)=>{
  const { data, error } = await supabase.from('medicines').delete().eq('id', req.params.id).select();
  error ? res.status(500).json({ error }) : res.json({ deleted:data.length });
});

app.post('/api/medicines/:id/consume', async (req,res)=>{
  const id=req.params.id;
  const { data: medData, error: medError } = await supabase.from('medicines').select('*').eq('id',id).single();
  if(medError||!medData) return res.status(404).json({ error:'Medicine not found' });
  if(medData.count<=0) return res.status(400).json({ error:'Out of stock' });
  const newCount=medData.count-1;
  await supabase.from('medicines').update({ count:newCount }).eq('id',id);
  await supabase.from('consumption_logs').insert([{ medicine_id:id, medicine_name:medData.name }]);
  if(newCount===0) sendEmail(`🚨 ${medData.name} is OUT`, `Stock empty for ${medData.name}`);
  res.json({ success:true, newCount });
});

// Reminders
app.get('/api/reminders', async (_,res)=>{
  const { data,error } = await supabase.from('reminders').select('*').order('id',{ascending:false});
  error ? res.status(500).json({ error }) : res.json(data);
});
app.post('/api/reminders', async (req,res)=>{
  const { title, details, iso_date, repeats, medicine_id } = req.body;
  const { data,error } = await supabase.from('reminders').insert([{ title, details, iso_date, repeats, medicine_id }]).select().single();
  error ? res.status(500).json({ error }) : res.status(201).json(data);
});
app.delete('/api/reminders/:id', async (req,res)=>{
  const { data,error } = await supabase.from('reminders').delete().eq('id',req.params.id).select();
  error ? res.status(500).json({ error }) : res.json({ deleted:data.length });
});

// Consumption logs
app.get('/api/consumption-logs', async (req,res)=>{
  let query = supabase.from('consumption_logs').select('*').order('consumed_at',{ascending:false});
  if(req.query.medicine_id) query = query.eq('medicine_id', req.query.medicine_id);
  const { data,error } = await query;
  error ? res.status(500).json({ error }) : res.json(data);
});

// Emergency
app.post('/api/emergency', async (req,res)=>{
  const payload = { type:'emergency', time:new Date().toISOString(), details:req.body.details||'' };
  for(const ws of clients) if(ws.readyState===1) ws.send(JSON.stringify(payload));
  await sendEmail("🚨 EMERGENCY ALERT", payload.details || "Button pressed!");
  res.json({ ok:true });
});

// -------- Serve SPA --------
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// -------- Start Server --------
server.listen(PORT, ()=>console.log(`Server running on port ${PORT}`));


// GET /api/medicines/low-stock
app.get('/api/medicines/low-stock', async (req, res) => {
  const { data, error } = await supabase
    .from('medicines')
    .select('*')
    .lte('count', 5);   // <= 5 means low stock
 console.log("LOW STOCK:", data);

  if (error) return res.status(500).json({ error });
  res.json(data || []);
});



