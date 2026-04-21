/**
 * PropManager KE — Supabase Backend
 * Stack: Express + Supabase (PostgreSQL) + Africa's Talking SMS + Daraja M-Pesa
 *
 * Install: npm install
 * Run:     node server.js
 * Deploy:  Push to GitHub → connect to Railway.app → add env vars
 */

require('dotenv').config();
const express        = require('express');
const cors           = require('cors');
const axios          = require('axios');
const cron           = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const AfricasTalking = require('africastalking');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Supabase client ──────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY   // use service key (bypasses RLS) on server
);

// ── Africa's Talking ─────────────────────────────────────────
const AT  = AfricasTalking({ apiKey: process.env.AT_API_KEY, username: process.env.AT_USERNAME });
const sms = AT.SMS;

// ── Helpers ──────────────────────────────────────────────────
const fmt          = n => 'KES ' + Number(n||0).toLocaleString();
const today        = () => new Date().toISOString().split('T')[0];
const monthLabel   = (d = new Date()) => d.toLocaleString('en-KE', { month:'long', year:'numeric' });
const genId        = (prefix) => `${prefix}-${new Date().toISOString().substring(2,7).replace('-','')}-${Math.floor(Math.random()*9000)+1000}`;

async function sendSMS(to, message) {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[SMS MOCK] To: ${to}\n${message}\n`);
    return;
  }
  try {
    await sms.send({ to: [to], message, from: process.env.AT_SENDER_ID || 'PROPMANAGER' });
  } catch (e) {
    console.error('[SMS] Failed:', e.message);
  }
}

// ── M-Pesa Token ─────────────────────────────────────────────
async function getMpesaToken() {
  const base = process.env.NODE_ENV === 'production'
    ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  const auth = Buffer.from(`${process.env.DARAJA_KEY}:${process.env.DARAJA_SECRET}`).toString('base64');
  const { data } = await axios.get(`${base}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } });
  return data.access_token;
}

// ════════════════════════════════════════════════════════════
// ROUTES — Properties
// ════════════════════════════════════════════════════════════
app.get('/api/properties', async (req, res) => {
  const { data, error } = await supabase.from('properties').select('*').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/properties', async (req, res) => {
  const { data, error } = await supabase.from('properties').insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.patch('/api/properties/:id', async (req, res) => {
  const { data, error } = await supabase.from('properties').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete('/api/properties/:id', async (req, res) => {
  const { error } = await supabase.from('properties').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════
// ROUTES — Tenants
// ════════════════════════════════════════════════════════════
app.get('/api/tenants', async (req, res) => {
  const { data, error } = await supabase
    .from('tenants').select('*, properties(name,location)').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/tenants', async (req, res) => {
  const { data, error } = await supabase.from('tenants').insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  // Send welcome SMS
  await sendSMS(data.phone,
    `Welcome to ${req.body.property_name||'the property'}, ${data.name}! ` +
    `Your unit is ${data.unit}. Monthly rent: ${fmt(data.rent_amount)} due on day ${data.due_day}. ` +
    `Pay via M-Pesa Paybill: ${process.env.MPESA_PAYBILL}, Account: ${data.unit}. - PropManager KE`
  );
  res.json(data);
});

app.patch('/api/tenants/:id', async (req, res) => {
  const { data, error } = await supabase.from('tenants').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete('/api/tenants/:id', async (req, res) => {
  const { error } = await supabase.from('tenants').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════
// ROUTES — Invoices
// ════════════════════════════════════════════════════════════
app.get('/api/invoices', async (req, res) => {
  const { data, error } = await supabase
    .from('invoices').select('*, tenants(name,phone,unit)').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/invoices/generate', async (req, res) => {
  // Generate invoices for all active tenants for next month
  const { data: tenants } = await supabase.from('tenants').select('*').neq('status','inactive');
  const invoices = tenants.map(t => ({
    id:         genId('INV'),
    tenant_id:  t.id,
    amount:     t.rent_amount,
    month:      monthLabel(),
    due_date:   (() => { const d = new Date(); d.setDate(t.due_day||1); return d.toISOString().split('T')[0]; })(),
    status:     'pending',
    sent_date:  today(),
  }));
  const { data, error } = await supabase.from('invoices').insert(invoices).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ created: data.length, invoices: data });
});

// ════════════════════════════════════════════════════════════
// ROUTES — Payments
// ════════════════════════════════════════════════════════════
app.get('/api/payments', async (req, res) => {
  const { data, error } = await supabase
    .from('payments').select('*, tenants(name,unit,phone)').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/payments', async (req, res) => {
  const { tenant_id, amount, mpesa_code, payment_date } = req.body;
  const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenant_id).single();
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const invoiceId = genId('INV');
  const receiptId = genId('RCP');

  // Insert invoice
  await supabase.from('invoices').insert({
    id: invoiceId, tenant_id, amount, month: monthLabel(),
    due_date: payment_date||today(), status:'paid', mpesa_code, sent_date: today()
  });

  // Insert payment
  const { data: payment } = await supabase.from('payments')
    .insert({ tenant_id, invoice_id: invoiceId, amount, mpesa_code, payment_date: payment_date||today(), status:'confirmed' })
    .select().single();

  // Insert receipt
  await supabase.from('receipts').insert({
    id: receiptId, invoice_id: invoiceId, payment_id: payment.id,
    amount, mpesa_code, receipt_date: payment_date||today(), sent_to: tenant.phone
  });

  // Update tenant balance
  const newBalance = Math.max(0, (tenant.balance||0) - amount);
  await supabase.from('tenants').update({ balance: newBalance, status: newBalance===0?'paid':'pending' }).eq('id', tenant_id);

  // Send receipt SMS
  await sendSMS(tenant.phone,
    `Payment confirmed! ${fmt(amount)} received for Unit ${tenant.unit}. ` +
    `M-Pesa Ref: ${mpesa_code}. Receipt: ${receiptId}. Thank you! - PropManager KE`
  );

  res.json({ success: true, payment, receiptId, invoiceId });
});

// ════════════════════════════════════════════════════════════
// ROUTES — Receipts
// ════════════════════════════════════════════════════════════
app.get('/api/receipts', async (req, res) => {
  const { data, error } = await supabase
    .from('receipts').select('*, tenants(name,phone,unit), payments(mpesa_code)').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ════════════════════════════════════════════════════════════
// ROUTES — SMS
// ════════════════════════════════════════════════════════════
app.post('/api/send-invoices', async (req, res) => {
  const { data: tenants } = await supabase.from('tenants').select('*').neq('status','inactive');
  let sent = 0;
  for (const t of tenants) {
    await sendSMS(t.phone,
      `Dear ${t.name}, your rent of ${fmt(t.rent_amount)} for ${monthLabel()} is due on day ${t.due_day}. ` +
      `Pay via M-Pesa Paybill: ${process.env.MPESA_PAYBILL}, Account: ${t.unit}. - PropManager KE`
    );
    sent++;
    await new Promise(r => setTimeout(r, 200));
  }
  res.json({ success: true, sent, message: `Invoices sent to ${sent} tenants` });
});

// ════════════════════════════════════════════════════════════
// ROUTES — Daraja M-Pesa
// ════════════════════════════════════════════════════════════
app.post('/register-urls', async (req, res) => {
  try {
    const base  = process.env.NODE_ENV==='production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
    const token = await getMpesaToken();
    await axios.post(`${base}/mpesa/c2b/v1/registerurl`, {
      ShortCode:       process.env.MPESA_PAYBILL,
      ResponseType:    'Completed',
      ConfirmationURL: `${process.env.SERVER_URL}/mpesa/confirm`,
      ValidationURL:   `${process.env.SERVER_URL}/mpesa/validate`,
    }, { headers: { Authorization: `Bearer ${token}` } });
    res.json({ success: true, message: 'Daraja URLs registered with Safaricom.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/mpesa/validate', (req, res) => res.json({ ResultCode:0, ResultDesc:'Accepted' }));

app.post('/mpesa/confirm', async (req, res) => {
  const { TransID, MSISDN, TransAmount, BillRefNumber } = req.body;
  console.log(`[M-PESA] ${TransID} | KES ${TransAmount} | Unit: ${BillRefNumber}`);
  try {
    const { data: tenant } = await supabase.from('tenants').select('*').eq('unit', BillRefNumber).single();
    if (!tenant) { console.warn('[M-PESA] No tenant for unit:', BillRefNumber); return res.json({ ResultCode:0, ResultDesc:'Accepted' }); }

    const amount    = Math.round(parseFloat(TransAmount));
    const invoiceId = genId('INV');
    const receiptId = genId('RCP');

    await supabase.from('invoices').insert({ id:invoiceId, tenant_id:tenant.id, amount, month:monthLabel(), due_date:today(), status:'paid', mpesa_code:TransID, sent_date:today() });
    const { data: payment } = await supabase.from('payments').insert({ tenant_id:tenant.id, invoice_id:invoiceId, amount, mpesa_code:TransID, payment_date:today(), status:'confirmed' }).select().single();
    await supabase.from('receipts').insert({ id:receiptId, invoice_id:invoiceId, payment_id:payment.id, amount, mpesa_code:TransID, receipt_date:today(), sent_to:MSISDN });
    const newBalance = Math.max(0, (tenant.balance||0) - amount);
    await supabase.from('tenants').update({ balance:newBalance, status:newBalance===0?'paid':'pending' }).eq('id', tenant.id);
    await sendSMS(tenant.phone, `Payment confirmed! ${fmt(amount)} for Unit ${BillRefNumber}. M-Pesa: ${TransID}. Receipt: ${receiptId}. - PropManager KE`);
    console.log(`[M-PESA] Receipt ${receiptId} issued to ${tenant.name}`);
  } catch (e) { console.error('[M-PESA] Error:', e.message); }
  res.json({ ResultCode:0, ResultDesc:'Success' });
});

// ════════════════════════════════════════════════════════════
// CRON — send invoices on 28th at 08:00 Nairobi time
// ════════════════════════════════════════════════════════════
cron.schedule('0 8 28 * *', async () => {
  console.log('[CRON] Sending monthly invoices...');
  const { data: tenants } = await supabase.from('tenants').select('*').neq('status','inactive');
  for (const t of tenants) {
    await sendSMS(t.phone, `Dear ${t.name}, rent of ${fmt(t.rent_amount)} for ${monthLabel()} due on day ${t.due_day}. Paybill: ${process.env.MPESA_PAYBILL}, Account: ${t.unit}. - PropManager KE`);
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`[CRON] Done — ${tenants.length} invoices sent.`);
}, { timezone: 'Africa/Nairobi' });

// ── Health check ─────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status:'ok', backend:'supabase', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PropManager KE [Supabase] running on port ${PORT}`));
