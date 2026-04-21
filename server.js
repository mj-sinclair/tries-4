/**
 * PropManager KE — Backend Server
 * Integrates: Supabase DB + Safaricom Daraja M-Pesa + Africa's Talking SMS
 *
 * Setup:
 *   npm install express axios @supabase/supabase-js africastalking dotenv node-cron
 *   cp .env.example .env   (fill in your credentials)
 *   node server.js
 */

require('dotenv').config();

const express        = require('express');
const axios          = require('axios');
const cron           = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const AfricasTalking = require('africastalking');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// SUPABASE CLIENT
// ============================================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ============================================================
// AFRICA'S TALKING SMS CLIENT
// ============================================================
const AT  = AfricasTalking({ apiKey: process.env.AT_API_KEY, username: process.env.AT_USERNAME });
const sms = AT.SMS;

// ============================================================
// HELPERS
// ============================================================
function getMonthLabel(date = new Date()) {
  return date.toLocaleString('en-KE', { month: 'long', year: 'numeric' });
}

function formatKES(amount) {
  return `KES ${Number(amount).toLocaleString()}`;
}

function generateReceiptId() {
  const now  = new Date();
  const yymm = now.toISOString().substring(2, 7).replace('-', '');
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `RCP-${yymm}-${rand}`;
}

function generateInvoiceId(unit) {
  const now  = new Date();
  const yymm = now.toISOString().substring(2, 7).replace('-', '');
  const rand = Math.floor(Math.random() * 900) + 100;
  return `INV-${yymm}-${rand}`;
}

// ============================================================
// SMS FUNCTIONS
// ============================================================

/**
 * Send monthly invoice SMS to a single tenant
 */
async function sendInvoiceSMS(tenant) {
  const message =
    `Dear ${tenant.name}, your rent of ${formatKES(tenant.rent_amount)} ` +
    `for ${getMonthLabel()} is due on the ${tenant.due_day}. ` +
    `Pay via M-Pesa Paybill: ${process.env.MPESA_PAYBILL}, Account: ${tenant.unit}. ` +
    `Thank you. - PropManager KE`;

  try {
    const result = await sms.send({ to: [tenant.phone], message, from: process.env.AT_SENDER_ID });
    console.log(`[SMS] Invoice sent to ${tenant.name} (${tenant.phone}):`, result.SMSMessageData.Recipients[0].status);
  } catch (err) {
    console.error(`[SMS] Failed to send invoice to ${tenant.name}:`, err.message);
  }
}

/**
 * Send receipt SMS after confirmed M-Pesa payment
 */
async function sendReceiptSMS({ phone, tenantName, mpesaCode, amount, unit, receiptId }) {
  const message =
    `Payment confirmed! ${formatKES(amount)} received for Unit ${unit}. ` +
    `M-Pesa Ref: ${mpesaCode}. Receipt: ${receiptId}. ` +
    `Thank you, ${tenantName}! - PropManager KE`;

  try {
    const result = await sms.send({ to: [phone], message, from: process.env.AT_SENDER_ID });
    console.log(`[SMS] Receipt sent to ${tenantName} (${phone}):`, result.SMSMessageData.Recipients[0].status);
  } catch (err) {
    console.error(`[SMS] Failed to send receipt to ${tenantName}:`, err.message);
  }
}

/**
 * Send monthly invoices to ALL active tenants
 */
async function sendMonthlyInvoices() {
  console.log('[CRON] Sending monthly invoices...');
  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('*')
    .neq('status', 'inactive');

  if (error) { console.error('[CRON] Failed to fetch tenants:', error); return; }

  for (const tenant of tenants) {
    // Create invoice record
    const invoiceId = generateInvoiceId(tenant.unit);
    const dueDate   = new Date();
    dueDate.setDate(tenant.due_day || 1);

    await supabase.from('invoices').insert({
      id:         invoiceId,
      tenant_id:  tenant.id,
      amount:     tenant.rent_amount,
      month:      getMonthLabel(),
      due_date:   dueDate.toISOString().split('T')[0],
      status:     'pending',
      sent_date:  new Date().toISOString().split('T')[0],
    });

    await sendInvoiceSMS(tenant);
    await new Promise(r => setTimeout(r, 200)); // 5 SMS/sec rate limit
  }

  console.log(`[CRON] Done. Invoices sent to ${tenants.length} tenants.`);
}

// ============================================================
// DARAJA M-PESA AUTH
// ============================================================
async function getMpesaToken() {
  const base = process.env.NODE_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

  const auth = Buffer.from(`${process.env.DARAJA_KEY}:${process.env.DARAJA_SECRET}`).toString('base64');
  const res  = await axios.get(
    `${base}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return res.data.access_token;
}

// ============================================================
// ROUTES — DARAJA M-PESA
// ============================================================

/**
 * POST /register-urls
 * Register Daraja C2B callback URLs with Safaricom.
 * Call this ONCE after deployment to activate your Paybill callbacks.
 */
app.post('/register-urls', async (req, res) => {
  try {
    const base  = process.env.NODE_ENV === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke';
    const token = await getMpesaToken();

    await axios.post(
      `${base}/mpesa/c2b/v1/registerurl`,
      {
        ShortCode:       process.env.MPESA_PAYBILL,
        ResponseType:    'Completed',
        ConfirmationURL: `${process.env.SERVER_URL}/mpesa/confirm`,
        ValidationURL:   `${process.env.SERVER_URL}/mpesa/validate`,
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.json({ success: true, message: 'Daraja URLs registered successfully.' });
  } catch (err) {
    console.error('[DARAJA] URL registration failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /mpesa/validate
 * Safaricom calls this before processing payment. Return 0 to accept.
 */
app.post('/mpesa/validate', (req, res) => {
  console.log('[DARAJA] Validation request:', req.body);
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

/**
 * POST /mpesa/confirm
 * Safaricom calls this when payment is fully confirmed.
 * This is the main handler — updates DB, generates receipt, sends SMS.
 */
app.post('/mpesa/confirm', async (req, res) => {
  const {
    TransID,         // M-Pesa transaction code e.g. "QAB7X2K9P1"
    MSISDN,          // Tenant phone number e.g. "254712345678"
    TransAmount,     // Amount paid e.g. "35000.00"
    BillRefNumber,   // Account number = unit number e.g. "A-101"
    FirstName,
    MiddleName,
    LastName,
    TransTime,
  } = req.body;

  console.log(`[DARAJA] Payment confirmed: ${TransID} | ${formatKES(TransAmount)} | Unit: ${BillRefNumber}`);

  try {
    // 1. Find tenant by unit number
    const { data: tenant, error: tenantErr } = await supabase
      .from('tenants')
      .select('*')
      .eq('unit', BillRefNumber)
      .single();

    if (tenantErr || !tenant) {
      console.error('[DARAJA] Tenant not found for unit:', BillRefNumber);
      return res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); // still accept
    }

    // 2. Find open invoice for this tenant
    const { data: openInvoice } = await supabase
      .from('invoices')
      .select('id')
      .eq('tenant_id', tenant.id)
      .in('status', ['pending', 'overdue'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const invoiceId = openInvoice?.id || generateInvoiceId(BillRefNumber);

    // 3. Save payment record
    const { data: payment } = await supabase
      .from('payments')
      .insert({
        tenant_id:    tenant.id,
        invoice_id:   invoiceId,
        amount:       Math.round(parseFloat(TransAmount)),
        mpesa_code:   TransID,
        payment_date: new Date().toISOString().split('T')[0],
        status:       'confirmed',
      })
      .select()
      .single();

    // 4. Update invoice status
    await supabase
      .from('invoices')
      .update({ status: 'paid', mpesa_code: TransID })
      .eq('id', invoiceId);

    // 5. Update tenant balance & status
    const newBalance = Math.max(0, (tenant.balance || 0) - Math.round(parseFloat(TransAmount)));
    await supabase
      .from('tenants')
      .update({ balance: newBalance, status: newBalance === 0 ? 'paid' : 'pending' })
      .eq('id', tenant.id);

    // 6. Generate receipt record
    const receiptId = generateReceiptId();
    await supabase.from('receipts').insert({
      id:           receiptId,
      invoice_id:   invoiceId,
      payment_id:   payment?.id,
      amount:       Math.round(parseFloat(TransAmount)),
      mpesa_code:   TransID,
      receipt_date: new Date().toISOString().split('T')[0],
      sent_to:      MSISDN,
    });

    // 7. Send receipt SMS
    await sendReceiptSMS({
      phone:       tenant.phone || `+${MSISDN}`,
      tenantName:  tenant.name,
      mpesaCode:   TransID,
      amount:      Math.round(parseFloat(TransAmount)),
      unit:        BillRefNumber,
      receiptId,
    });

    console.log(`[DARAJA] Receipt ${receiptId} generated for ${tenant.name}`);
    res.json({ ResultCode: 0, ResultDesc: 'Success' });

  } catch (err) {
    console.error('[DARAJA] Confirm handler error:', err);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); // always respond 0 to Safaricom
  }
});

// ============================================================
// ROUTES — TENANT & INVOICE API (used by frontend)
// ============================================================

app.get('/api/tenants', async (req, res) => {
  const { data, error } = await supabase
    .from('tenants')
    .select('*, properties(name, location)')
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/tenants', async (req, res) => {
  const { data, error } = await supabase.from('tenants').insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.get('/api/invoices', async (req, res) => {
  const { data, error } = await supabase
    .from('invoices')
    .select('*, tenants(name, phone, unit)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/receipts', async (req, res) => {
  const { data, error } = await supabase
    .from('receipts')
    .select('*, tenants(name, phone, unit), payments(mpesa_code)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/properties', async (req, res) => {
  const { data, error } = await supabase.from('properties').select('*').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/send-invoices', async (req, res) => {
  try {
    await sendMonthlyInvoices();
    res.json({ success: true, message: 'Monthly invoices sent.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CRON JOB — Send invoices on 28th of every month at 08:00 AM
// ============================================================
cron.schedule('0 8 28 * *', () => {
  console.log('[CRON] 28th of month — dispatching monthly invoices');
  sendMonthlyInvoices();
}, { timezone: 'Africa/Nairobi' });

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.json({ status: 'PropManager KE server running', timestamp: new Date().toISOString() });
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PropManager KE server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
