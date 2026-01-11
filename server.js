/**
 * server.js - Render-ready with Supabase + WebSocket
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const bodyParser = require('body-parser');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

// -------- Environment --------
const PORT = process.env.PORT || 8080;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on('connection', ws => {
  clients.add(ws);

  // Send latest data immediately
  if (latestDeviceData) ws.send(JSON.stringify({ type: 'device-data', data: latestDeviceData }));

  ws.on('message', msg => {
    try {
      const data = JSON.parse(msg.toString());
      latestDeviceData = data;
      // Broadcast to all clients
      for (const c of clients) if (c.readyState === 1) c.send(JSON.stringify({ type: 'device-data', data }));
    } catch (_) {}
  });

  ws.on('close', () => clients.delete(ws));
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
