/**
 * PropManager KE — Firebase Firestore Backend
 * Stack: Express + Firebase Admin (Firestore) + Africa's Talking SMS + Daraja M-Pesa
 *
 * Install: npm install
 * Run:     node server.js
 * Deploy:  Push to GitHub → Railway.app or Google Cloud Run
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const cron       = require('node-cron');
const admin      = require('firebase-admin');
const AfricasTalking = require('africastalking');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Firebase Admin init ──────────────────────────────────────
// Download serviceAccountKey.json from Firebase Console →
// Project Settings → Service Accounts → Generate New Private Key
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : require('./serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Africa's Talking ─────────────────────────────────────────
const AT  = AfricasTalking({ apiKey: process.env.AT_API_KEY, username: process.env.AT_USERNAME });
const sms = AT.SMS;

// ── Helpers ──────────────────────────────────────────────────
const fmt        = n => 'KES ' + Number(n||0).toLocaleString();
const today      = () => new Date().toISOString().split('T')[0];
const monthLabel = (d=new Date()) => d.toLocaleString('en-KE',{month:'long',year:'numeric'});
const genId      = prefix => `${prefix}-${new Date().toISOString().substring(2,7).replace('-','')}-${Math.floor(Math.random()*9000)+1000}`;

async function sendSMS(to, message) {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[SMS MOCK] To: ${to}\n${message}\n`); return;
  }
  try { await sms.send({ to:[to], message, from: process.env.AT_SENDER_ID||'PROPMANAGER' }); }
  catch(e) { console.error('[SMS] Failed:', e.message); }
}

// ── Firestore helpers ────────────────────────────────────────
const col   = name => db.collection(name);
const docId = snap => ({ id: snap.id, ...snap.data() });
const allDocs = async (name, ...orderBy) => {
  let q = col(name);
  if (orderBy.length) q = q.orderBy(...orderBy);
  const snap = await q.get();
  return snap.docs.map(docId);
};

// ── M-Pesa Token ─────────────────────────────────────────────
async function getMpesaToken() {
  const base = process.env.NODE_ENV==='production'
    ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  const auth = Buffer.from(`${process.env.DARAJA_KEY}:${process.env.DARAJA_SECRET}`).toString('base64');
  const { data } = await axios.get(`${base}/oauth/v1/generate?grant_type=client_credentials`,
    { headers:{ Authorization:`Basic ${auth}` } });
  return data.access_token;
}

// ════════════════════════════════════════════════════════════
// ROUTES — Properties
// ════════════════════════════════════════════════════════════
app.get('/api/properties', async (req, res) => {
  try { res.json(await allDocs('properties','name')); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/properties', async (req, res) => {
  try {
    const ref = await col('properties').add({ ...req.body, created_at: new Date().toISOString() });
    const doc = await ref.get();
    res.json(docId(doc));
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/properties/:id', async (req, res) => {
  try {
    await col('properties').doc(req.params.id).update(req.body);
    const doc = await col('properties').doc(req.params.id).get();
    res.json(docId(doc));
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/properties/:id', async (req, res) => {
  try { await col('properties').doc(req.params.id).delete(); res.json({ success:true }); }
  catch(e) { res.status(400).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// ROUTES — Tenants
// ════════════════════════════════════════════════════════════
app.get('/api/tenants', async (req, res) => {
  try {
    const tenants = await allDocs('tenants','name');
    // Attach property name
    const properties = await allDocs('properties');
    const propMap = Object.fromEntries(properties.map(p=>[p.id,p]));
    const result = tenants.map(t => ({
      ...t,
      properties: propMap[t.property_id] ? { name: propMap[t.property_id].name, location: propMap[t.property_id].location } : null
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tenants', async (req, res) => {
  try {
    const ref = await col('tenants').add({ ...req.body, balance:0, status:'pending', created_at: new Date().toISOString() });
    const doc = await ref.get();
    const tenant = docId(doc);
    await sendSMS(tenant.phone,
      `Welcome ${tenant.name}! Unit: ${tenant.unit}. Rent: ${fmt(tenant.rent_amount)} due day ${tenant.due_day}. Paybill: ${process.env.MPESA_PAYBILL}, Account: ${tenant.unit}. - PropManager KE`
    );
    res.json(tenant);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/tenants/:id', async (req, res) => {
  try {
    await col('tenants').doc(req.params.id).update(req.body);
    const doc = await col('tenants').doc(req.params.id).get();
    res.json(docId(doc));
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/tenants/:id', async (req, res) => {
  try { await col('tenants').doc(req.params.id).delete(); res.json({ success:true }); }
  catch(e) { res.status(400).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// ROUTES — Invoices
// ════════════════════════════════════════════════════════════
app.get('/api/invoices', async (req, res) => {
  try {
    const invoices = await allDocs('invoices','created_at');
    const tenants  = await allDocs('tenants');
    const tenantMap = Object.fromEntries(tenants.map(t=>[t.id,t]));
    res.json(invoices.map(inv => ({ ...inv, tenants: tenantMap[inv.tenant_id]||null })).reverse());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/invoices/generate', async (req, res) => {
  try {
    const tenants = await allDocs('tenants');
    const batch   = db.batch();
    const created = [];
    for (const t of tenants) {
      if (t.status === 'inactive') continue;
      const id  = genId('INV');
      const ref = col('invoices').doc(id);
      const inv = { id, tenant_id:t.id, amount:t.rent_amount, month:monthLabel(), due_date: (() => { const d=new Date(); d.setDate(t.due_day||1); return d.toISOString().split('T')[0]; })(), status:'pending', sent_date:today(), created_at:new Date().toISOString() };
      batch.set(ref, inv);
      created.push(inv);
    }
    await batch.commit();
    res.json({ created: created.length, invoices: created });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// ROUTES — Payments
// ════════════════════════════════════════════════════════════
app.get('/api/payments', async (req, res) => {
  try {
    const payments = await allDocs('payments','created_at');
    const tenants  = await allDocs('tenants');
    const tenantMap = Object.fromEntries(tenants.map(t=>[t.id,t]));
    res.json(payments.map(p => ({ ...p, tenants: tenantMap[p.tenant_id]||null })).reverse());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/payments', async (req, res) => {
  try {
    const { tenant_id, amount, mpesa_code, payment_date } = req.body;
    const tenantDoc = await col('tenants').doc(String(tenant_id)).get();
    if (!tenantDoc.exists) return res.status(404).json({ error:'Tenant not found' });
    const tenant    = docId(tenantDoc);
    const invoiceId = genId('INV');
    const receiptId = genId('RCP');
    const pDate     = payment_date || today();

    await col('invoices').doc(invoiceId).set({ id:invoiceId, tenant_id, amount, month:monthLabel(), due_date:pDate, status:'paid', mpesa_code, sent_date:today(), created_at:new Date().toISOString() });
    const payRef = await col('payments').add({ tenant_id, invoice_id:invoiceId, amount, mpesa_code, payment_date:pDate, status:'confirmed', created_at:new Date().toISOString() });
    await col('receipts').doc(receiptId).set({ id:receiptId, invoice_id:invoiceId, payment_id:payRef.id, amount, mpesa_code, receipt_date:pDate, sent_to:tenant.phone, created_at:new Date().toISOString() });
    const newBalance = Math.max(0, (tenant.balance||0) - amount);
    await col('tenants').doc(String(tenant_id)).update({ balance:newBalance, status:newBalance===0?'paid':'pending' });
    await sendSMS(tenant.phone, `Payment confirmed! ${fmt(amount)} for Unit ${tenant.unit}. M-Pesa: ${mpesa_code}. Receipt: ${receiptId}. - PropManager KE`);
    res.json({ success:true, receiptId, invoiceId });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// ROUTES — Receipts
// ════════════════════════════════════════════════════════════
app.get('/api/receipts', async (req, res) => {
  try {
    const receipts = await allDocs('receipts','created_at');
    const tenants  = await allDocs('tenants');
    const tenantMap = Object.fromEntries(tenants.map(t=>[t.id,t]));
    res.json(receipts.map(r => ({ ...r, tenants: tenantMap[r.tenant_id]||null })).reverse());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
// ROUTES — SMS + Daraja
// ════════════════════════════════════════════════════════════
app.post('/api/send-invoices', async (req, res) => {
  const tenants = await allDocs('tenants');
  let sent = 0;
  for (const t of tenants) {
    if (t.status==='inactive') continue;
    await sendSMS(t.phone, `Dear ${t.name}, rent of ${fmt(t.rent_amount)} for ${monthLabel()} due on day ${t.due_day}. Paybill: ${process.env.MPESA_PAYBILL}, Account: ${t.unit}. - PropManager KE`);
    sent++; await new Promise(r=>setTimeout(r,200));
  }
  res.json({ success:true, sent, message:`Invoices sent to ${sent} tenants` });
});

app.post('/register-urls', async (req, res) => {
  try {
    const base = process.env.NODE_ENV==='production'?'https://api.safaricom.co.ke':'https://sandbox.safaricom.co.ke';
    const token = await getMpesaToken();
    await axios.post(`${base}/mpesa/c2b/v1/registerurl`,
      { ShortCode:process.env.MPESA_PAYBILL, ResponseType:'Completed', ConfirmationURL:`${process.env.SERVER_URL}/mpesa/confirm`, ValidationURL:`${process.env.SERVER_URL}/mpesa/validate` },
      { headers:{ Authorization:`Bearer ${token}` } });
    res.json({ success:true, message:'Daraja URLs registered.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/mpesa/validate', (req, res) => res.json({ ResultCode:0, ResultDesc:'Accepted' }));

app.post('/mpesa/confirm', async (req, res) => {
  const { TransID, MSISDN, TransAmount, BillRefNumber } = req.body;
  try {
    const snap = await col('tenants').where('unit','==',BillRefNumber).limit(1).get();
    if (snap.empty) { console.warn('[M-PESA] No tenant for unit:', BillRefNumber); return res.json({ ResultCode:0, ResultDesc:'Accepted' }); }
    const tenant    = docId(snap.docs[0]);
    const amount    = Math.round(parseFloat(TransAmount));
    const invoiceId = genId('INV');
    const receiptId = genId('RCP');
    await col('invoices').doc(invoiceId).set({ id:invoiceId, tenant_id:tenant.id, amount, month:monthLabel(), due_date:today(), status:'paid', mpesa_code:TransID, sent_date:today(), created_at:new Date().toISOString() });
    const payRef = await col('payments').add({ tenant_id:tenant.id, invoice_id:invoiceId, amount, mpesa_code:TransID, payment_date:today(), status:'confirmed', created_at:new Date().toISOString() });
    await col('receipts').doc(receiptId).set({ id:receiptId, invoice_id:invoiceId, payment_id:payRef.id, amount, mpesa_code:TransID, receipt_date:today(), sent_to:MSISDN, created_at:new Date().toISOString() });
    const newBalance = Math.max(0,(tenant.balance||0)-amount);
    await col('tenants').doc(tenant.id).update({ balance:newBalance, status:newBalance===0?'paid':'pending' });
    await sendSMS(tenant.phone, `Payment confirmed! ${fmt(amount)} for Unit ${BillRefNumber}. M-Pesa: ${TransID}. Receipt: ${receiptId}. - PropManager KE`);
  } catch(e) { console.error('[M-PESA] Error:', e.message); }
  res.json({ ResultCode:0, ResultDesc:'Success' });
});

cron.schedule('0 8 28 * *', async () => {
  const tenants = await allDocs('tenants');
  for (const t of tenants) {
    await sendSMS(t.phone, `Dear ${t.name}, rent of ${fmt(t.rent_amount)} for ${monthLabel()} due on day ${t.due_day}. Paybill: ${process.env.MPESA_PAYBILL}, Account: ${t.unit}. - PropManager KE`);
    await new Promise(r=>setTimeout(r,200));
  }
}, { timezone:'Africa/Nairobi' });

app.get('/', (req, res) => res.json({ status:'ok', backend:'firebase', time:new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PropManager KE [Firebase] running on port ${PORT}`));
