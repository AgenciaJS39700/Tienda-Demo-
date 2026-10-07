-- Esquema de la base de datos (Cloudflare D1 / SQLite)
CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, category TEXT NOT NULL, kind TEXT NOT NULL, size_kind TEXT NOT NULL, description TEXT, price_cents INTEGER NOT NULL CHECK (price_cents > 0), compare_at_cents INTEGER, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE variants (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id), sku TEXT NOT NULL UNIQUE, color_name TEXT NOT NULL, color_hex TEXT NOT NULL, size TEXT NOT NULL, stock INTEGER NOT NULL CHECK (stock >= 0));
CREATE INDEX idx_variants_product ON variants(product_id);
CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, stripe_session_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'pending', total_cents INTEGER NOT NULL, shipping_cents INTEGER NOT NULL DEFAULT 0, email TEXT, name TEXT, shipping_address TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT);
CREATE INDEX idx_orders_status ON orders(status, created_at);
CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id), variant_id INTEGER NOT NULL REFERENCES variants(id), qty INTEGER NOT NULL CHECK (qty > 0), unit_cents INTEGER NOT NULL, name TEXT NOT NULL);
CREATE INDEX idx_items_order ON order_items(order_id);
