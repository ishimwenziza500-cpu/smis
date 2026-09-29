-- SMIS schema. Apply with: psql "$DATABASE_URL" -f db/schema.sql
-- No demo or student records are seeded here.

CREATE SEQUENCE IF NOT EXISTS students_id_seq;
CREATE SEQUENCE IF NOT EXISTS parents_id_seq;
CREATE SEQUENCE IF NOT EXISTS staff_id_seq;
CREATE SEQUENCE IF NOT EXISTS items_id_seq;
CREATE SEQUENCE IF NOT EXISTS distributions_id_seq;
CREATE SEQUENCE IF NOT EXISTS payments_id_seq;
CREATE SEQUENCE IF NOT EXISTS transport_id_seq;

CREATE TABLE IF NOT EXISTS students (
    id TEXT PRIMARY KEY DEFAULT ('ST-' || lpad(nextval('students_id_seq')::text, 4, '0')),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    grade TEXT NOT NULL CHECK (length(trim(grade)) > 0),
    guardian TEXT NOT NULL CHECK (length(trim(guardian)) > 0),
    phone TEXT NOT NULL CHECK (length(trim(phone)) > 0),
    area TEXT,
    status TEXT NOT NULL CHECK (status IN ('Active', 'Pending'))
);

CREATE TABLE IF NOT EXISTS parents (
    id TEXT PRIMARY KEY DEFAULT ('PA-' || lpad(nextval('parents_id_seq')::text, 4, '0')),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    student_id TEXT NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    relationship TEXT NOT NULL CHECK (length(trim(relationship)) > 0),
    phone TEXT NOT NULL CHECK (length(trim(phone)) > 0),
    email TEXT
);

CREATE TABLE IF NOT EXISTS staff (
    id TEXT PRIMARY KEY DEFAULT ('SF-' || lpad(nextval('staff_id_seq')::text, 3, '0')),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    role TEXT NOT NULL CHECK (length(trim(role)) > 0),
    phone TEXT NOT NULL CHECK (length(trim(phone)) > 0),
    email TEXT NOT NULL CHECK (length(trim(email)) > 0)
);

CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY DEFAULT ('IT-' || lpad(nextval('items_id_seq')::text, 3, '0')),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    category TEXT NOT NULL CHECK (length(trim(category)) > 0),
    price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
    required TEXT NOT NULL CHECK (required IN ('Required', 'Optional')),
    stock INTEGER NOT NULL CHECK (stock >= 0)
);

CREATE TABLE IF NOT EXISTS distributions (
    id TEXT PRIMARY KEY DEFAULT ('DI-' || lpad(nextval('distributions_id_seq')::text, 3, '0')),
    student_id TEXT NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    issued DATE NOT NULL,
    returned INTEGER NOT NULL DEFAULT 0 CHECK (returned >= 0 AND returned <= quantity),
    status TEXT NOT NULL CHECK (status IN ('Collected', 'Partially returned', 'Returned'))
);

CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY DEFAULT ('RC-' || lpad(nextval('payments_id_seq')::text, 4, '0')),
    student_id TEXT NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    purpose TEXT NOT NULL CHECK (length(trim(purpose)) > 0),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    method TEXT NOT NULL CHECK (method IN ('Cash', 'Mobile money', 'Bank transfer', 'Card')),
    date DATE NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('Paid', 'Pending'))
);

CREATE TABLE IF NOT EXISTS transport (
    id TEXT PRIMARY KEY DEFAULT ('TR-' || lpad(nextval('transport_id_seq')::text, 2, '0')),
    area TEXT NOT NULL CHECK (length(trim(area)) > 0),
    fee NUMERIC(12, 2) NOT NULL CHECK (fee >= 0),
    capacity INTEGER NOT NULL CHECK (capacity >= 0),
    driver TEXT NOT NULL DEFAULT 'Unassigned',
    status TEXT NOT NULL CHECK (status IN ('Available', 'Full', 'Inactive'))
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE CHECK (length(trim(email)) > 3),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    role TEXT NOT NULL CHECK (role IN ('admin', 'registrar', 'inventory', 'viewer')),
    password_hash TEXT NOT NULL,
    disabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS parents_student_id_idx ON parents(student_id);
CREATE INDEX IF NOT EXISTS distributions_student_id_idx ON distributions(student_id);
CREATE INDEX IF NOT EXISTS distributions_item_id_idx ON distributions(item_id);
CREATE INDEX IF NOT EXISTS payments_student_id_idx ON payments(student_id);
CREATE INDEX IF NOT EXISTS students_area_idx ON students(area);
