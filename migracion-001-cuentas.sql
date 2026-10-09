-- Migración 001 · cuentas de cliente, envíos y recogida en tienda
-- Ejecútala UNA sola vez en Cloudflare → D1 → tienda-demo → Console (pega y pulsa Execute).
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, pass_iter INTEGER NOT NULL, marketing INTEGER NOT NULL DEFAULT 0, marketing_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE resets (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE auth_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX idx_attempts ON auth_attempts(k, ts);
ALTER TABLE orders ADD COLUMN user_id INTEGER;
ALTER TABLE orders ADD COLUMN fulfillment TEXT NOT NULL DEFAULT 'ship';
ALTER TABLE orders ADD COLUMN carrier TEXT;
ALTER TABLE orders ADD COLUMN tracking TEXT;
ALTER TABLE orders ADD COLUMN shipped_at TEXT;
CREATE INDEX idx_orders_user ON orders(user_id);
