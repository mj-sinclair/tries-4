/**
 * PropManager KE — SQLite Backend (fully self-contained)
 * Stack: Express + SQLite3 (file-based DB) + Africa's Talking SMS + Daraja M-Pesa
 *
 * Install: npm install
 * Run:     node server.js
 * Data:    Stored in ./propmanager.db (auto-created on first run)
 * Deploy:  Any VPS, Railway, Render — DB file persists on disk
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const cron       = require('node-cron');
const Database   = require('better-sqlite3');
const AfricasTalking = require('africastalking');
const path       = require('path');
const fs         = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── SQLite init ───────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'propmanager.db');
const db      = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // better concurrent performance
db.pragma('foreign_keys = ON');

// ── Create tables ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS properties (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    location     TEXT,
    type         TEXT DEFAULT 'Apartment',
    units        INTEGER DEFAULT 0,
    occupied     INTEGER DEFAULT 0,
    monthly_rent INTEGER DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tenants (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    phone        TEXT,
    email        TEXT,
    national_id  TEXT,
    unit         TEXT,
    property_id  INTEGER REFERENCES properties(id) ON DELETE SET NULL,
    rent_amount  INTEGER DEFAULT 0,
    due_day      INTEGER DEFAULT 1,
    balance      INTEGER DEFAULT 0,
    status       TEXT DEFAULT 'pending',
    lease_start  TEXT,
    lease_end    TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id           TEXT PRIMARY KEY,
    tenant_id    INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
    amount       INTEGER,
    month        TEXT,
    due_date     TEXT,
    status       TEXT DEFAULT 'pending',
    mpesa_code   TEXT,
    sent_date    TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id    INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
    invoice_id   TEXT REFERENCES invoices(id) ON DELETE SET NULL,
    amount       INTEGER,
    mpesa_code   TEXT UNIQUE,
    payment_date TEXT,
    status       TEXT DEFAULT 'confirmed',
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS receipts (
    id           TEXT PRIMARY KEY,
    invoice_id   TEXT REFERENCES invoices(id) ON DELETE SET NULL,
    payment_id   INTEGER REFERENCES payments(id) ON DELETE SET NULL,
    amount       INTEGER,
    mpesa_code   TEXT,
    receipt_date TEXT,
    sent_to      TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tenants_unit     ON tenants(unit);
  CREATE INDEX IF NOT EXISTS idx_tenants_prop     ON tenants(property_id);
  CREATE INDEX IF NOT EXISTS idx_invoices_tenant  ON invoices(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_payments_tenant  ON payments(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_payments_mpesa   ON payments(mpesa_code);
`);

// ── Seed sample data if empty ────────────────────────────────
const propCount = db.prepare('SELECT COUNT(*) as c FROM properties').get();
if (propCount.c === 0) {
  db.prepare(`INSERT INTO properties (name,location,type,units,occupied,monthly_rent) VALUES (?,?,?,?,?,?)`).run('Westlands Heights','Westlands, Nairobi','Apartment',12,10,35000);
  db.prepare(`INSERT INTO properties (name,location,type,units,occupied,monthly_rent) VALUES (?,?,?,?,?,?)`).run('Kilimani Court','Kilimani, Nairobi','Apartment',8,8,42000);
  db.prepare(`INSERT INTO properties (name,location,type,units,occupied,monthly_rent) VALUES (?,?,?,?,?,?)`).run('Karen Villa','Karen, Nairobi','Townhouse',4,3,85000);
  console.log('[DB] Sample properties seeded.');
}

// ── Africa's Talking ─────────────────────────────────────────
const AT  = AfricasTalking({ apiKey: process.env.AT_API_KEY||'sandbox', username: process.env.AT_USERNAME||'sandbox' });
const sms = AT.SMS;

// ── Helpers ──────────────────────────────────────────────────
const fmt        = n => 'KES ' + Number(n||0).toLocaleString();
const today      = () => new Date().toISOString().split('T')[0];
const monthLabel = (d=new Date()) => d.toLocaleString('en-KE',{month:'long',year:'numeric'});
const genId      = p => `${p}-${new Date().toISOString().substring(2,7).replace('-','')}-${Math.floor(Math.random()*9000)+1000}`;

async function sendSMS(to, message) {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[SMS MOCK] To: ${to}\n${message}\n`); return;
  }
  try { await sms.send({ to:[to], message, from: process.env.AT_SENDER_ID||'PROPMANAGER' }); }
  catch(e) { console.error('[SMS] Failed:', e.message); }
}

// ── Join helpers (SQLite doesn't do nested JSON) ─────────────
function withProperty(tenant) {
  if (!tenant) return tenant;
  const prop = tenant.property_id
    ? db.prepare('SELECT name,location FROM properties WHERE id=?').get(tenant.property_id)
    : null;
  return { ...tenant, properties: prop };
}

function withTenant(row) {
  if (!row) return row;
  const t = row.tenant_id
    ? db.prepare('SELECT name,phone,unit FROM tenants WHERE id=?').get(row.tenant_id)
    : null;
  return { ...row, tenants: t };
}

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
app.get('/api/properties', (req, res) => {
  res.json(db.prepare('SELECT * FROM properties ORDER BY name').all());
});

app.post('/api/properties', (req, res) => {
  const { name,location,type,units,occupied,monthly_rent } = req.body;
  const info = db.prepare('INSERT INTO properties (name,location,type,units,occupied,monthly_rent) VALUES (?,?,?,?,?,?)')
    .run(name,location||'',type||'Apartment',units||0,occupied||0,monthly_rent||0);
  res.json(db.prepare('SELECT * FROM properties WHERE id=?').get(info.lastInsertRowid));
});

app.patch('/api/properties/:id', (req, res) => {
  const fields = Object.keys(req.body).map(k=>`${k}=?`).join(',');
  db.prepare(`UPDATE properties SET ${fields} WHERE id=?`).run(...Object.values(req.body), req.params.id);
  res.json(db.prepare('SELECT * FROM properties WHERE id=?').get(req.params.id));
});

app.delete('/api/properties/:id', (req, res) => {
  db.prepare('DELETE FROM properties WHERE id=?').run(req.params.id);
  res.json({ success:true });
});

// ════════════════════════════════════════════════════════════
// ROUTES — Tenants
// ════════════════════════════════════════════════════════════
app.get('/api/tenants', (req, res) => {
  const tenants = db.prepare('SELECT * FROM tenants ORDER BY name').all();
  res.json(tenants.map(withProperty));
});

app.post('/api/tenants', async (req, res) => {
  const { name,phone,email,national_id,unit,property_id,rent_amount,due_day,lease_start,lease_end } = req.body;
  const info = db.prepare('INSERT INTO tenants (name,phone,email,national_id,unit,property_id,rent_amount,due_day,balance,status,lease_start,lease_end) VALUES (?,?,?,?,?,?,?,?,0,"pending",?,?)')
    .run(name,phone||'',email||'',national_id||'',unit||'',property_id||null,rent_amount||0,due_day||1,lease_start||'',lease_end||'');
  const tenant = db.prepare('SELECT * FROM tenants WHERE id=?').get(info.lastInsertRowid);
  await sendSMS(phone, `Welcome ${name}! Unit: ${unit}. Rent: ${fmt(rent_amount)} due day ${due_day}. Paybill: ${process.env.MPESA_PAYBILL||'XXXXXX'}, Account: ${unit}. - PropManager KE`);
  res.json(withProperty(tenant));
});

app.patch('/api/tenants/:id', (req, res) => {
  const fields = Object.keys(req.body).map(k=>`${k}=?`).join(',');
  db.prepare(`UPDATE tenants SET ${fields} WHERE id=?`).run(...Object.values(req.body), req.params.id);
  res.json(withProperty(db.prepare('SELECT * FROM tenants WHERE id=?').get(req.params.id)));
});

app.delete('/api/tenants/:id', (req, res) => {
  db.prepare('DELETE FROM tenants WHERE id=?').run(req.params.id);
  res.json({ success:true });
});

// ════════════════════════════════════════════════════════════
// ROUTES — Invoices
// ════════════════════════════════════════════════════════════
app.get('/api/invoices', (req, res) => {
  res.json(db.prepare('SELECT * FROM invoices ORDER BY created_at DESC').all().map(withTenant));
});

app.post('/api/invoices/generate', async (req, res) => {
  const tenants = db.prepare("SELECT * FROM tenants WHERE status != 'inactive'").all();
  const created = [];
  const insert  = db.prepare('INSERT INTO invoices (id,tenant_id,amount,month,due_date,status,sent_date) VALUES (?,?,?,?,?,?,?)');
  for (const t of tenants) {
    const id  = genId('INV');
    const d   = new Date(); d.setDate(t.due_day||1);
    insert.run(id, t.id, t.rent_amount, monthLabel(), d.toISOString().split('T')[0], 'pending', today());
    created.push({ id, tenant_id:t.id, amount:t.rent_amount });
  }
  res.json({ created:created.length, invoices:created });
});

// ════════════════════════════════════════════════════════════
// ROUTES — Payments
// ════════════════════════════════════════════════════════════
app.get('/api/payments', (req, res) => {
  res.json(db.prepare('SELECT * FROM payments ORDER BY created_at DESC').all().map(withTenant));
});

app.post('/api/payments', async (req, res) => {
  const { tenant_id, amount, mpesa_code, payment_date } = req.body;
  const tenant    = db.prepare('SELECT * FROM tenants WHERE id=?').get(tenant_id);
  if (!tenant) return res.status(404).json({ error:'Tenant not found' });

  const invoiceId = genId('INV');
  const receiptId = genId('RCP');
  const pDate     = payment_date || today();

  db.prepare('INSERT INTO invoices (id,tenant_id,amount,month,due_date,status,mpesa_code,sent_date) VALUES (?,?,?,?,?,?,?,?)')
    .run(invoiceId,tenant_id,amount,monthLabel(),pDate,'paid',mpesa_code,today());

  const payInfo = db.prepare('INSERT INTO payments (tenant_id,invoice_id,amount,mpesa_code,payment_date,status) VALUES (?,?,?,?,?,?)')
    .run(tenant_id,invoiceId,amount,mpesa_code,pDate,'confirmed');

  db.prepare('INSERT INTO receipts (id,invoice_id,payment_id,amount,mpesa_code,receipt_date,sent_to) VALUES (?,?,?,?,?,?,?)')
    .run(receiptId,invoiceId,payInfo.lastInsertRowid,amount,mpesa_code,pDate,tenant.phone);

  const newBalance = Math.max(0,(tenant.balance||0)-amount);
  db.prepare('UPDATE tenants SET balance=?,status=? WHERE id=?')
    .run(newBalance, newBalance===0?'paid':'pending', tenant_id);

  await sendSMS(tenant.phone, `Payment confirmed! ${fmt(amount)} for Unit ${tenant.unit}. M-Pesa: ${mpesa_code}. Receipt: ${receiptId}. Thank you! - PropManager KE`);
  res.json({ success:true, receiptId, invoiceId, paymentId:payInfo.lastInsertRowid });
});

// ════════════════════════════════════════════════════════════
// ROUTES — Receipts
// ════════════════════════════════════════════════════════════
app.get('/api/receipts', (req, res) => {
  const receipts = db.prepare('SELECT r.*, p.mpesa_code as payment_mpesa FROM receipts r LEFT JOIN payments p ON p.id=r.payment_id ORDER BY r.created_at DESC').all();
  res.json(receipts.map(r => ({
    ...r,
    tenants: r.sent_to ? db.prepare('SELECT name,phone,unit FROM tenants WHERE phone=?').get(r.sent_to) : null,
    payments: { mpesa_code: r.payment_mpesa || r.mpesa_code }
  })));
});

// ════════════════════════════════════════════════════════════
// ROUTES — SMS + Daraja
// ════════════════════════════════════════════════════════════
app.post('/api/send-invoices', async (req, res) => {
  const tenants = db.prepare("SELECT * FROM tenants WHERE status != 'inactive'").all();
  let sent = 0;
  for (const t of tenants) {
    await sendSMS(t.phone, `Dear ${t.name}, rent of ${fmt(t.rent_amount)} for ${monthLabel()} due on day ${t.due_day}. Paybill: ${process.env.MPESA_PAYBILL||'XXXXXX'}, Account: ${t.unit}. - PropManager KE`);
    sent++; await new Promise(r=>setTimeout(r,200));
  }
  res.json({ success:true, sent, message:`Invoices sent to ${sent} tenants` });
});

app.post('/register-urls', async (req, res) => {
  try {
    const base  = process.env.NODE_ENV==='production'?'https://api.safaricom.co.ke':'https://sandbox.safaricom.co.ke';
    const token = await getMpesaToken();
    await axios.post(`${base}/mpesa/c2b/v1/registerurl`,
      { ShortCode:process.env.MPESA_PAYBILL, ResponseType:'Completed', ConfirmationURL:`${process.env.SERVER_URL}/mpesa/confirm`, ValidationURL:`${process.env.SERVER_URL}/mpesa/validate` },
      { headers:{ Authorization:`Bearer ${token}` } });
    res.json({ success:true, message:'Daraja URLs registered.' });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/mpesa/validate', (req, res) => res.json({ ResultCode:0, ResultDesc:'Accepted' }));

app.post('/mpesa/confirm', async (req, res) => {
  const { TransID, MSISDN, TransAmount, BillRefNumber } = req.body;
  console.log(`[M-PESA] ${TransID} | KES ${TransAmount} | Unit: ${BillRefNumber}`);
  try {
    const tenant    = db.prepare('SELECT * FROM tenants WHERE unit=?').get(BillRefNumber);
    if (!tenant) { console.warn('[M-PESA] No tenant for unit:', BillRefNumber); return res.json({ ResultCode:0, ResultDesc:'Accepted' }); }
    const amount    = Math.round(parseFloat(TransAmount));
    const invoiceId = genId('INV');
    const receiptId = genId('RCP');
    db.prepare('INSERT INTO invoices (id,tenant_id,amount,month,due_date,status,mpesa_code,sent_date) VALUES (?,?,?,?,?,?,?,?)').run(invoiceId,tenant.id,amount,monthLabel(),today(),'paid',TransID,today());
    const pi = db.prepare('INSERT INTO payments (tenant_id,invoice_id,amount,mpesa_code,payment_date,status) VALUES (?,?,?,?,?,?)').run(tenant.id,invoiceId,amount,TransID,today(),'confirmed');
    db.prepare('INSERT INTO receipts (id,invoice_id,payment_id,amount,mpesa_code,receipt_date,sent_to) VALUES (?,?,?,?,?,?,?)').run(receiptId,invoiceId,pi.lastInsertRowid,amount,TransID,today(),MSISDN);
    const newBalance = Math.max(0,(tenant.balance||0)-amount);
    db.prepare('UPDATE tenants SET balance=?,status=? WHERE id=?').run(newBalance,newBalance===0?'paid':'pending',tenant.id);
    await sendSMS(tenant.phone, `Payment confirmed! ${fmt(amount)} for Unit ${BillRefNumber}. M-Pesa: ${TransID}. Receipt: ${receiptId}. - PropManager KE`);
    console.log(`[M-PESA] Receipt ${receiptId} issued to ${tenant.name}`);
  } catch(e) { console.error('[M-PESA] Error:', e.message); }
  res.json({ ResultCode:0, ResultDesc:'Success' });
});

// ── DB backup endpoint ────────────────────────────────────────
app.get('/api/backup', (req, res) => {
  if (req.headers['x-backup-key'] !== process.env.BACKUP_KEY) return res.status(403).json({ error:'Forbidden' });
  res.download(DB_PATH, 'propmanager-backup.db');
});

cron.schedule('0 8 28 * *', async () => {
  const tenants = db.prepare("SELECT * FROM tenants WHERE status != 'inactive'").all();
  for (const t of tenants) {
    await sendSMS(t.phone, `Dear ${t.name}, rent of ${fmt(t.rent_amount)} for ${monthLabel()} due on day ${t.due_day}. Paybill: ${process.env.MPESA_PAYBILL||'XXXXXX'}, Account: ${t.unit}. - PropManager KE`);
    await new Promise(r=>setTimeout(r,200));
  }
  console.log(`[CRON] Monthly invoices sent — ${tenants.length} tenants.`);
}, { timezone:'Africa/Nairobi' });

app.get('/', (req, res) => res.json({ status:'ok', backend:'sqlite', db: DB_PATH, time:new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PropManager KE [SQLite] running on port ${PORT} | DB: ${DB_PATH}`));
