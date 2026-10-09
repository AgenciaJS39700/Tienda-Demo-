-- Migración 002 · fotos de producto y registro de aceptación de condiciones
-- Ejecútala UNA sola vez en Cloudflare → D1 → tu base de datos → Console.
ALTER TABLE products ADD COLUMN image_key TEXT;
ALTER TABLE users ADD COLUMN terms_at TEXT;
ALTER TABLE orders ADD COLUMN terms_at TEXT;
