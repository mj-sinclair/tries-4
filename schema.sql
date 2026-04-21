-- ============================================================
-- PropManager KE — Supabase PostgreSQL Schema
-- Run this in Supabase SQL Editor (supabase.com → SQL Editor)
-- ============================================================

-- Properties
CREATE TABLE IF NOT EXISTS properties (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  location      TEXT,
  type          TEXT DEFAULT 'Apartment',
  units         INT  DEFAULT 0,
  occupied      INT  DEFAULT 0,
  monthly_rent  BIGINT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Tenants
CREATE TABLE IF NOT EXISTS tenants (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT,
  email         TEXT,
  national_id   TEXT,
  unit          TEXT,
  property_id   BIGINT REFERENCES properties(id) ON DELETE SET NULL,
  rent_amount   BIGINT DEFAULT 0,
  due_day       INT    DEFAULT 1,
  balance       BIGINT DEFAULT 0,
  status        TEXT   DEFAULT 'pending',
  lease_start   DATE,
  lease_end     DATE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Invoices
CREATE TABLE IF NOT EXISTS invoices (
  id            TEXT PRIMARY KEY,
  tenant_id     BIGINT REFERENCES tenants(id) ON DELETE CASCADE,
  amount        BIGINT,
  month         TEXT,
  due_date      DATE,
  status        TEXT DEFAULT 'pending',
  mpesa_code    TEXT,
  sent_date     DATE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Payments
CREATE TABLE IF NOT EXISTS payments (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id    TEXT  REFERENCES invoices(id) ON DELETE SET NULL,
  amount        BIGINT,
  mpesa_code    TEXT UNIQUE,
  payment_date  DATE,
  status        TEXT DEFAULT 'confirmed',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Receipts
CREATE TABLE IF NOT EXISTS receipts (
  id            TEXT PRIMARY KEY,
  invoice_id    TEXT   REFERENCES invoices(id) ON DELETE SET NULL,
  payment_id    BIGINT REFERENCES payments(id) ON DELETE SET NULL,
  amount        BIGINT,
  mpesa_code    TEXT,
  receipt_date  DATE,
  sent_to       TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes for fast lookups ────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tenants_unit        ON tenants(unit);
CREATE INDEX IF NOT EXISTS idx_tenants_property    ON tenants(property_id);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant     ON invoices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_tenant     ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_mpesa      ON payments(mpesa_code);
CREATE INDEX IF NOT EXISTS idx_receipts_invoice    ON receipts(invoice_id);

-- ── Row Level Security (enable in production) ───────────────
-- ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE tenants    ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE invoices   ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE payments   ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE receipts   ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "authenticated only" ON properties FOR ALL USING (auth.role() = 'authenticated');
-- (repeat for each table)

-- ── Sample seed data (optional) ────────────────────────────
INSERT INTO properties (name, location, type, units, occupied, monthly_rent) VALUES
  ('Westlands Heights', 'Westlands, Nairobi', 'Apartment',  12, 10, 35000),
  ('Kilimani Court',    'Kilimani, Nairobi',  'Apartment',   8,  8, 42000),
  ('Karen Villa',       'Karen, Nairobi',     'Townhouse',   4,  3, 85000)
ON CONFLICT DO NOTHING;
