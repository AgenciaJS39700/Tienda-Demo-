-- Esquema de la base de datos (Cloudflare D1 / SQLite)
CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, category TEXT NOT NULL, kind TEXT NOT NULL, size_kind TEXT NOT NULL, description TEXT, price_cents INTEGER NOT NULL CHECK (price_cents > 0), compare_at_cents INTEGER, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE variants (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id), sku TEXT NOT NULL UNIQUE, color_name TEXT NOT NULL, color_hex TEXT NOT NULL, size TEXT NOT NULL, stock INTEGER NOT NULL CHECK (stock >= 0));
CREATE INDEX idx_variants_product ON variants(product_id);
CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, stripe_session_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'pending', total_cents INTEGER NOT NULL, shipping_cents INTEGER NOT NULL DEFAULT 0, email TEXT, name TEXT, shipping_address TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT, user_id INTEGER, fulfillment TEXT NOT NULL DEFAULT 'ship', carrier TEXT, tracking TEXT, shipped_at TEXT);
CREATE INDEX idx_orders_status ON orders(status, created_at);
CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id), variant_id INTEGER NOT NULL REFERENCES variants(id), qty INTEGER NOT NULL CHECK (qty > 0), unit_cents INTEGER NOT NULL, name TEXT NOT NULL);
CREATE INDEX idx_items_order ON order_items(order_id);
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, pass_iter INTEGER NOT NULL, marketing INTEGER NOT NULL DEFAULT 0, marketing_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE resets (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE auth_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX idx_attempts ON auth_attempts(k, ts);
CREATE INDEX idx_orders_user ON orders(user_id);
