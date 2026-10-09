// worker.js · API de la tienda demo (Cloudflare Workers + D1 + Stripe Checkout)
// Rutas:  GET /api/products · POST /api/checkout · POST /api/webhook · GET /api/order · POST /api/cancel · /api/admin/*
//         /api/auth/{register,login,logout,me,forgot,reset,marketing,delete} · GET /api/shop · GET /img/*
// Secretos (Cloudflare → Worker → Settings → Variables and Secrets):
//   STRIPE_SECRET_KEY · STRIPE_WEBHOOK_SECRET · ADMIN_TOKEN
//   BREVO_API_KEY (opcional: sin ella la tienda funciona pero no envía correos)
// Variables (texto): MAIL_FROM · MAIL_FROM_NAME · BREVO_LIST_ID · STORE_NAME · SITE_URL (opcional) · PBKDF2_ITER (opcional)
//   OWNER_EMAIL (aviso de pedidos) · SHOP_LEGAL_NAME · SHOP_NIF · SHOP_ADDRESS · SHOP_EMAIL · SHOP_PHONE (textos legales)
// Binding R2: IMAGES (fotos de producto)

const STRIPE_API = "https://api.stripe.com/v1";
const HOLD_MINUTES = 30;          // Stripe exige entre 30 minutos y 24 horas
// Tarifas por país (céntimos). Gratis a partir de "freeFrom". "PICKUP" = recogida en tienda, siempre gratis.
const RATES = {
  ES: { label: "España", cents: 495, freeFrom: 6000 },
  PT: { label: "Portugal", cents: 695, freeFrom: 9000 },
  FR: { label: "Francia", cents: 795, freeFrom: 9000 },
  DE: { label: "Alemania", cents: 795, freeFrom: 9000 },
  IT: { label: "Italia", cents: 795, freeFrom: 9000 },
};
const KINDS = ["tee", "sweat", "hoodie", "jeans", "jacket", "dress", "bag", "cap"]; // dibujo de respaldo si no hay foto
const SIZE_SETS = { top: ["XS", "S", "M", "L", "XL"], bottom: ["38", "40", "42", "44", "46"], one: ["Única"] };
const MAX_IMG = 700 * 1024;
const IMG_RE = /^p\/[0-9]+-[0-9a-f]{10}\.(webp|jpg|png)$/;
const SESSION_DAYS = 30;
const MAX_ATTEMPTS = 8;           // intentos por ventana
const ATTEMPT_WINDOW_MIN = 15;
const MAX_QTY = 10;
const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{10,}$/;
const enc = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path.startsWith("/api/auth/")) return await auth(request, env, url, ctx);
      if (path === "/api/shop" && request.method === "GET") return json(shopInfo(env));
      if (path.startsWith("/img/") && request.method === "GET") return await image(env, path.slice(5));
      if (path === "/api/products" && request.method === "GET") return await products(env);
      if (path === "/api/checkout" && request.method === "POST") return await checkout(request, env, url);
      if (path === "/api/webhook" && request.method === "POST") return await webhook(request, env, ctx);
      if (path === "/api/order" && request.method === "GET") return await order(url, env, ctx);
      if (path === "/api/cancel" && request.method === "POST") return await cancel(request, env);
      if (path.startsWith("/api/admin/")) return await admin(request, env, url, ctx);
      if (path.startsWith("/api/")) return json({ error: "No encontrado" }, 404);
      return new Response("No encontrado", { status: 404 });
    } catch (err) {
      console.error("Error no controlado:", err && err.message);
      return json({ error: "Error interno" }, 500);
    }
  },
};

/* ------------------------------------------------------------------ utilidades */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function safeEqual(a, b) {
  const x = String(a), y = String(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

async function stripeRequest(env, method, path, params, idempotencyKey) {
  const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  let body;
  if (params) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = params.toString();
  }
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${STRIPE_API}${path}`, { method, headers, body });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

async function verifyStripeSignature(payload, header, secret) {
  if (!header || !secret) return false;
  let t = null;
  const sigs = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i), v = part.slice(i + 1);
    if (k === "t") t = v;
    if (k === "v1") sigs.push(v);
  }
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // tolerancia de 5 minutos
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => safeEqual(s, expected));
}

/* ------------------------------------------------------------------ stock reservado */
// Devuelve el stock de un pedido pendiente y cambia su estado. Es atómico e idempotente:
// si el pedido ya no está pendiente, no hace nada.
async function releaseOrder(env, orderId, newStatus) {
  const [, upd] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE variants SET stock = stock + (SELECT COALESCE(SUM(qty),0) FROM order_items oi WHERE oi.order_id = ?1 AND oi.variant_id = variants.id)
       WHERE id IN (SELECT variant_id FROM order_items WHERE order_id = ?1)
       AND EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND status = 'pending')`
    ).bind(orderId),
    env.DB.prepare("UPDATE orders SET status = ?2 WHERE id = ?1 AND status = 'pending'").bind(orderId, newStatus),
  ]);
  return upd.meta.changes > 0;
}

// Copia de seguridad: libera pedidos pendientes que ya deberían haber caducado.
async function releaseExpired(env) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM orders WHERE status = 'pending' AND created_at < datetime('now', ?1)"
  ).bind(`-${HOLD_MINUTES + 10} minutes`).all();
  for (const o of results) await releaseOrder(env, o.id, "expired");
}

async function markPaid(env, s, ctx, origin) {
  const d = s.customer_details || {};
  const ship = s.shipping_details || (s.collected_information && s.collected_information.shipping_details) || null;
  const address = ship && ship.address ? JSON.stringify({ name: ship.name || d.name || "", ...ship.address }) : null;
  const r = await env.DB.prepare(
    "UPDATE orders SET status = 'paid', email = ?1, name = ?2, shipping_address = ?3, paid_at = datetime('now') WHERE stripe_session_id = ?4 AND status = 'pending'"
  ).bind(d.email || null, d.name || null, address, s.id).run();
  const changed = r.meta.changes > 0;
  // Solo el primer aviso (webhook o consulta directa) cambia el estado, así que el correo se envía una única vez
  if (changed && ctx) ctx.waitUntil(mailOrderPaid(env, s.id, origin).catch((e) => console.error("mail", e && e.message)));
  return changed;
}

/* ------------------------------------------------------------------ catálogo */
async function products(env) {
  await releaseExpired(env);
  const { results: ps } = await env.DB.prepare(
    "SELECT id, slug, name, category, kind, description, price_cents, compare_at_cents, image_key FROM products WHERE active = 1 ORDER BY id"
  ).all();
  const { results: vs } = await env.DB.prepare(
    "SELECT id, product_id, color_name, color_hex, size, stock FROM variants WHERE product_id IN (SELECT id FROM products WHERE active = 1) ORDER BY id"
  ).all();
  const byProduct = {};
  for (const v of vs) {
    (byProduct[v.product_id] = byProduct[v.product_id] || []).push({
      id: v.id, color: v.color_name, hex: v.color_hex, size: v.size, stock: v.stock,
    });
  }
  return json({
    products: ps.map(({ image_key, ...p }) => ({ ...p, image: image_key ? `/img/${image_key}` : null, variants: byProduct[p.id] || [] })),
    shipping: RATES,
    maxQty: MAX_QTY,
  });
}

/* ------------------------------------------------------------------ checkout */
async function checkout(request, env, url) {
  const user = await currentUser(request, env);
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Falta configurar Stripe en el servidor." }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Petición no válida." }, 400); }

  if (body.terms !== true) return json({ error: "Acepta las condiciones de venta y la política de privacidad para continuar." }, 400);
  const quantities = new Map();
  const items = Array.isArray(body.items) ? body.items.slice(0, 30) : [];
  for (const it of items) {
    const id = Number(it && it.variantId), qty = Number(it && it.qty);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      return json({ error: "Carrito no válido." }, 400);
    }
    quantities.set(id, (quantities.get(id) || 0) + qty);
  }
  if (!quantities.size) return json({ error: "El carrito está vacío." }, 400);
  for (const q of quantities.values()) if (q > MAX_QTY) return json({ error: "Cantidad no válida." }, 400);

  await releaseExpired(env);

  // 1) Precios y stock SIEMPRE desde la base de datos (nunca desde el navegador)
  const ids = [...quantities.keys()];
  const marks = ids.map((_, i) => `?${i + 1}`).join(",");
  const { results: rows } = await env.DB.prepare(
    `SELECT v.id, v.color_name, v.size, v.stock, p.name, p.price_cents
     FROM variants v JOIN products p ON p.id = v.product_id
     WHERE p.active = 1 AND v.id IN (${marks})`
  ).bind(...ids).all();
  if (rows.length !== ids.length) return json({ error: "Algún producto ya no está disponible." }, 409);

  let subtotal = 0;
  for (const r of rows) {
    const q = quantities.get(r.id);
    if (r.stock < q) {
      return json({ error: `No queda stock suficiente de «${r.name}» (${r.color_name}, talla ${r.size}).`, variantId: r.id }, 409);
    }
    subtotal += q * r.price_cents;
  }
  // Método de entrega: recogida en tienda o envío a un país con tarifa
  const method = String(body.ship || "ES");
  const pickup = method === "PICKUP";
  if (!pickup && !RATES[method]) return json({ error: "País de envío no válido." }, 400);
  const rate = pickup ? null : RATES[method];
  const shipping = pickup || subtotal >= rate.freeFrom ? 0 : rate.cents;

  // 2) Crear el pedido y reservar el stock en una sola transacción
  const created = await env.DB.prepare(
    "INSERT INTO orders (status, total_cents, shipping_cents, user_id, fulfillment, terms_at) VALUES ('pending', ?1, ?2, ?3, ?4, datetime('now'))"
  ).bind(subtotal + shipping, shipping, user ? user.id : null, pickup ? "pickup" : "ship").run();
  const orderId = created.meta.last_row_id;
  try {
    await env.DB.batch(rows.flatMap((r) => [
      env.DB.prepare("INSERT INTO order_items (order_id, variant_id, qty, unit_cents, name) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(orderId, r.id, quantities.get(r.id), r.price_cents, `${r.name} · ${r.color_name} · ${r.size}`),
      // La restricción CHECK (stock >= 0) hace fallar y deshacer todo si alguien compró antes
      env.DB.prepare("UPDATE variants SET stock = stock - ?1 WHERE id = ?2").bind(quantities.get(r.id), r.id),
    ]));
  } catch (err) {
    await env.DB.prepare("DELETE FROM order_items WHERE order_id = ?1").bind(orderId).run();
    await env.DB.prepare("DELETE FROM orders WHERE id = ?1").bind(orderId).run();
    return json({ error: "El stock ha cambiado mientras comprabas. Revisa tu carrito." }, 409);
  }

  // 3) Crear la sesión de pago de Stripe (la página de pago es de Stripe: nunca tocamos datos de tarjeta)
  const origin = url.origin;
  const p = new URLSearchParams();
  p.set("mode", "payment");
  p.set("locale", "es");
  p.set("success_url", `${origin}/?pago=ok&session_id={CHECKOUT_SESSION_ID}`);
  p.set("cancel_url", `${origin}/?pago=cancelado&session_id={CHECKOUT_SESSION_ID}`);
  p.set("client_reference_id", String(orderId));
  p.set("metadata[order_id]", String(orderId));
  p.set("expires_at", String(Math.floor(Date.now() / 1000) + HOLD_MINUTES * 60));
  if (!pickup) p.set("shipping_address_collection[allowed_countries][0]", method);
  if (user) p.set("customer_email", user.email);
  rows.forEach((r, i) => {
    p.set(`line_items[${i}][quantity]`, String(quantities.get(r.id)));
    p.set(`line_items[${i}][price_data][currency]`, "eur");
    p.set(`line_items[${i}][price_data][unit_amount]`, String(r.price_cents));
    p.set(`line_items[${i}][price_data][product_data][name]`, r.name);
    p.set(`line_items[${i}][price_data][product_data][description]`, `${r.color_name} · talla ${r.size}`);
  });
  p.set("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
  p.set("shipping_options[0][shipping_rate_data][display_name]", pickup ? "Recogida en tienda" : shipping === 0 ? "Envío gratuito" : `Envío estándar · ${rate.label}`);
  p.set("shipping_options[0][shipping_rate_data][fixed_amount][amount]", String(shipping));
  p.set("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "eur");

  const res = await stripeRequest(env, "POST", "/checkout/sessions", p, `demo-order-${orderId}`);
  if (!res.ok || !res.data.url) {
    console.error("Stripe rechazó la sesión:", res.data && res.data.error && res.data.error.message);
    await releaseOrder(env, orderId, "failed");
    return json({ error: "No se pudo iniciar el pago. Inténtalo de nuevo." }, 502);
  }
  await env.DB.prepare("UPDATE orders SET stripe_session_id = ?1 WHERE id = ?2").bind(res.data.id, orderId).run();
  return json({ url: res.data.url });
}

/* ------------------------------------------------------------------ webhook de Stripe */
async function webhook(request, env, ctx) {
  const raw = await request.text();
  const valid = await verifyStripeSignature(raw, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response("Firma no válida", { status: 400 });

  let event;
  try { event = JSON.parse(raw); } catch { return new Response("JSON no válido", { status: 400 }); }
  const s = event.data && event.data.object;
  if (!s) return new Response("ok", { status: 200 });

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    if (s.payment_status === "paid") await markPaid(env, s, ctx, publicOrigin(env, request));
  } else if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
    const o = await env.DB.prepare("SELECT id FROM orders WHERE stripe_session_id = ?1").bind(s.id).first();
    if (o) await releaseOrder(env, o.id, "expired");
  }
  return new Response("ok", { status: 200 });
}

/* ------------------------------------------------------------------ pedido y cancelación */
async function order(url, env, ctx) {
  const sid = url.searchParams.get("session_id") || "";
  if (!SESSION_RE.test(sid)) return json({ error: "Sesión no válida." }, 400);
  const o = await env.DB.prepare(
    "SELECT id, status, total_cents, shipping_cents, fulfillment FROM orders WHERE stripe_session_id = ?1"
  ).bind(sid).first();
  if (!o) return json({ error: "Pedido no encontrado." }, 404);

  // Si el aviso de Stripe aún no ha llegado, lo consultamos directamente
  if (o.status === "pending" && env.STRIPE_SECRET_KEY) {
    const r = await stripeRequest(env, "GET", `/checkout/sessions/${sid}`);
    if (r.ok && r.data.payment_status === "paid") {
      await markPaid(env, r.data, ctx, env.SITE_URL || url.origin);
      o.status = "paid";
    }
  }
  const { results } = await env.DB.prepare("SELECT name, qty, unit_cents FROM order_items WHERE order_id = ?1").bind(o.id).all();
  return json({ number: o.id, status: o.status, fulfillment: o.fulfillment, total_cents: o.total_cents, shipping_cents: o.shipping_cents, items: results });
}

async function cancel(request, env) {
  let body = {};
  try { body = await request.json(); } catch { /* sin cuerpo */ }
  const sid = String(body.session_id || "");
  if (!SESSION_RE.test(sid)) return json({ error: "Sesión no válida." }, 400);
  const o = await env.DB.prepare("SELECT id FROM orders WHERE stripe_session_id = ?1 AND status = 'pending'").bind(sid).first();
  if (!o || !env.STRIPE_SECRET_KEY) return json({ ok: true });
  // Solo devolvemos el stock si Stripe confirma que la sesión se ha cerrado sin cobro
  const r = await stripeRequest(env, "POST", `/checkout/sessions/${sid}/expire`, new URLSearchParams());
  if (r.ok) await releaseOrder(env, o.id, "cancelled");
  return json({ ok: true });
}

/* ------------------------------------------------------------------ administración (inventario y pedidos) */
async function admin(request, env, url, ctx) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  if (await tooMany(env, [`adm:ip:${ip}`])) return TOO_MANY();
  if (!env.ADMIN_TOKEN || !token || !safeEqual(token, env.ADMIN_TOKEN)) {
    await hit(env, [`adm:ip:${ip}`]);
    return json({ error: "No autorizado" }, 401);
  }

  if (url.pathname === "/api/admin/summary" && request.method === "GET") {
    const { results: orders } = await env.DB.prepare(
      "SELECT id, status, total_cents, email, name, shipping_address, fulfillment, carrier, tracking, created_at, paid_at, shipped_at FROM orders ORDER BY id DESC LIMIT 30"
    ).all();
    const { results: items } = await env.DB.prepare(
      "SELECT order_id, name, qty FROM order_items WHERE order_id IN (SELECT id FROM orders ORDER BY id DESC LIMIT 30)"
    ).all();
    const { results: variants } = await env.DB.prepare(
      "SELECT v.id, p.name AS product, v.color_name, v.size, v.stock FROM variants v JOIN products p ON p.id = v.product_id ORDER BY p.id, v.id"
    ).all();
    const stats = await env.DB.prepare(
      "SELECT COUNT(*) AS paid_orders, COALESCE(SUM(total_cents), 0) AS paid_cents FROM orders WHERE status IN ('paid','shipped','ready')"
    ).first();
    return json({ stats, orders: orders.map((o) => ({ ...o, items: items.filter((i) => i.order_id === o.id) })), variants });
  }

  if (url.pathname === "/api/admin/fulfill" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Petición no válida" }, 400); }
    const id = Number(body.orderId);
    const carrier = String(body.carrier || "").trim().slice(0, 60);
    const tracking = String(body.tracking || "").trim().slice(0, 80);
    if (!Number.isInteger(id) || id <= 0) return json({ error: "Datos no válidos" }, 400);
    const o = await env.DB.prepare("SELECT id, status, fulfillment, email, name FROM orders WHERE id = ?1").bind(id).first();
    if (!o || !["paid", "shipped", "ready"].includes(o.status)) return json({ error: "El pedido no está pagado." }, 409);
    const next = o.fulfillment === "pickup" ? "ready" : "shipped";
    if (next === "shipped" && !carrier) return json({ error: "Indica el transportista." }, 400);
    const first = o.status === "paid";
    await env.DB.prepare("UPDATE orders SET status = ?1, carrier = ?2, tracking = ?3, shipped_at = COALESCE(shipped_at, datetime('now')) WHERE id = ?4")
      .bind(next, carrier || null, tracking || null, id).run();
    // Solo avisamos al cliente la primera vez (corregir el seguimiento no reenvía el correo)
    if (first && o.email) ctx.waitUntil(mailFulfilled(env, o, next, carrier, tracking, env.SITE_URL || url.origin).catch((e) => console.error("mail", e && e.message)));
    return json({ ok: true, status: next, emailed: first && !!o.email });
  }

  if (url.pathname === "/api/admin/products" && request.method === "GET") {
    const { results: ps } = await env.DB.prepare(
      "SELECT id, slug, name, category, kind, size_kind, description, price_cents, compare_at_cents, active, image_key FROM products ORDER BY id"
    ).all();
    const { results: vs } = await env.DB.prepare("SELECT id, product_id, color_name, color_hex, size, stock FROM variants ORDER BY id").all();
    return json({
      products: ps.map(({ image_key, ...p }) => ({ ...p, image: image_key ? `/img/${image_key}` : null, variants: vs.filter((v) => v.product_id === p.id) })),
      kinds: KINDS, sizeSets: SIZE_SETS,
    });
  }

  if (url.pathname === "/api/admin/product" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Petición no válida" }, 400); }
    const r = await saveProduct(env, body);
    return json(r.error ? { error: r.error } : r, r.error ? (r.status || 400) : 200);
  }

  if (url.pathname === "/api/admin/active" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Petición no válida" }, 400); }
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return json({ error: "Datos no válidos" }, 400);
    const r = await env.DB.prepare("UPDATE products SET active = ?1 WHERE id = ?2").bind(body.active ? 1 : 0, id).run();
    return json({ ok: r.meta.changes > 0 });
  }

  if (url.pathname === "/api/admin/import" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Petición no válida" }, 400); }
    const r = await importRows(env, body.rows);
    return json(r.error ? { error: r.error } : r, r.error ? 400 : 200);
  }

  if (url.pathname === "/api/admin/image" && request.method === "POST") return await uploadImage(request, env, url);

  if (url.pathname === "/api/admin/image-delete" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Petición no válida" }, 400); }
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return json({ error: "Datos no válidos" }, 400);
    const p = await env.DB.prepare("SELECT image_key FROM products WHERE id = ?1").bind(id).first();
    if (!p) return json({ error: "Producto no encontrado" }, 404);
    await env.DB.prepare("UPDATE products SET image_key = NULL WHERE id = ?1").bind(id).run();
    if (p.image_key && env.IMAGES) await env.IMAGES.delete(p.image_key);
    return json({ ok: true });
  }

  if (url.pathname === "/api/admin/stock" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Petición no válida" }, 400); }
    const id = Number(body.variantId), stock = Number(body.stock);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(stock) || stock < 0 || stock > 10000) {
      return json({ error: "Datos no válidos" }, 400);
    }
    const r = await env.DB.prepare("UPDATE variants SET stock = ?1 WHERE id = ?2").bind(stock, id).run();
    return json({ ok: r.meta.changes > 0 });
  }
  return json({ error: "No encontrado" }, 404);
}


/* ================================================================== CUENTAS DE CLIENTE */
const te = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
async function sha256(text) { return hex(await crypto.subtle.digest("SHA-256", te.encode(text))); }

async function hashPassword(password, saltHex, iter) {
  const key = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations: iter }, key, 256);
  return hex(bits);
}
// Workers admite como máximo 100000 iteraciones de PBKDF2
const iterations = (env) => Math.min(100000, Math.max(1000, Number(env.PBKDF2_ITER) || 100000));

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const cleanEmail = (v) => String(v || "").trim().toLowerCase().slice(0, 254);
const cleanName = (v) => String(v || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 60);
const publicOrigin = (env, request) => env.SITE_URL || new URL(request.url).origin;

function getCookie(request, name) {
  const h = request.headers.get("cookie") || "";
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
const sessionCookie = (value, maxAge) => `sid=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

async function currentUser(request, env) {
  const tok = getCookie(request, "sid");
  if (!/^[0-9a-f]{64}$/.test(tok)) return null;
  const u = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.marketing FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?1 AND s.expires_at > datetime('now')`
  ).bind(await sha256(tok)).first();
  return u || null;
}

async function startSession(env, userId) {
  const tok = randomHex(32);
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, datetime('now', ?3))")
    .bind(await sha256(tok), userId, `+${SESSION_DAYS} days`).run();
  return tok;
}

/* Límite de intentos (por IP y por correo) guardado en D1 */
async function tooMany(env, keys) {
  const since = Math.floor(Date.now() / 1000) - ATTEMPT_WINDOW_MIN * 60;
  for (const k of keys) {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE k = ?1 AND ts > ?2").bind(k, since).first();
    if (r && r.n >= MAX_ATTEMPTS) return true;
  }
  return false;
}
async function hit(env, keys) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch(keys.map((k) => env.DB.prepare("INSERT INTO auth_attempts (k, ts) VALUES (?1, ?2)").bind(k, now)));
  if (Math.random() < 0.05) await env.DB.prepare("DELETE FROM auth_attempts WHERE ts < ?1").bind(now - 86400).run();
}

const TOO_MANY = () => json({ error: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo." }, 429);

async function auth(request, env, url, ctx) {
  const route = url.pathname.slice("/api/auth/".length);
  const post = request.method === "POST";
  if (route === "me" && request.method === "GET") return await me(request, env);
  if (!post) return json({ error: "No encontrado" }, 404);
  // Defensa CSRF: las peticiones que cambian algo deben venir de nuestra propia web
  if (request.headers.get("origin") !== url.origin) return json({ error: "Origen no permitido." }, 403);

  let body = {};
  try { body = await request.json(); } catch { /* sin cuerpo */ }
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const origin = publicOrigin(env, request);

  if (route === "register") {
    const email = cleanEmail(body.email), name = cleanName(body.name), password = String(body.password || "");
    if (!EMAIL_RE.test(email)) return json({ error: "Escribe un correo válido." }, 400);
    if (!name) return json({ error: "Escribe tu nombre." }, 400);
    if (password.length < 8 || password.length > 128) return json({ error: "La contraseña debe tener entre 8 y 128 caracteres." }, 400);
    if (body.terms !== true) return json({ error: "Debes aceptar la política de privacidad." }, 400);
    const keys = [`reg:ip:${ip}`];
    if (await tooMany(env, keys)) return TOO_MANY();
    await hit(env, keys);
    const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first();
    if (exists) return json({ error: "Ese correo ya tiene cuenta. Prueba a iniciar sesión." }, 409);
    const salt = randomHex(16), iter = iterations(env);
    const marketing = body.marketing === true ? 1 : 0; // casilla sin marcar por defecto (RGPD): solo si el cliente la marca
    const hash = await hashPassword(password, salt, iter);
    const r = await env.DB.prepare(
      "INSERT INTO users (email, name, pass_hash, pass_salt, pass_iter, marketing, marketing_at, terms_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, CASE WHEN ?6 = 1 THEN datetime('now') END, datetime('now'))"
    ).bind(email, name, hash, salt, iter, marketing).run();
    const uid = r.meta.last_row_id;
    ctx.waitUntil(Promise.all([
      mailWelcome(env, email, name, marketing === 1, origin),
      marketing ? brevoSubscribe(env, email, name, true) : Promise.resolve(),
    ]).catch((e) => console.error("mail", e && e.message)));
    const tok = await startSession(env, uid);
    const res = json({ user: { email, name, marketing: !!marketing } }, 201);
    res.headers.append("set-cookie", sessionCookie(tok, SESSION_DAYS * 86400));
    return res;
  }

  if (route === "login") {
    const email = cleanEmail(body.email), password = String(body.password || "");
    const keys = [`login:ip:${ip}`, `login:em:${email}`];
    if (await tooMany(env, keys)) return TOO_MANY();
    const u = await env.DB.prepare("SELECT id, name, email, marketing, pass_hash, pass_salt, pass_iter FROM users WHERE email = ?1").bind(email).first();
    // Si el usuario no existe también calculamos un hash para no delatarlo por el tiempo de respuesta
    const calc = await hashPassword(password.slice(0, 128), u ? u.pass_salt : "00".repeat(16), u ? u.pass_iter : iterations(env));
    if (!u || !safeEqual(calc, u.pass_hash)) {
      await hit(env, keys);
      return json({ error: "Correo o contraseña incorrectos." }, 401);
    }
    const tok = await startSession(env, u.id);
    const res = json({ user: { email: u.email, name: u.name, marketing: !!u.marketing } });
    res.headers.append("set-cookie", sessionCookie(tok, SESSION_DAYS * 86400));
    return res;
  }

  if (route === "logout") {
    const tok = getCookie(request, "sid");
    if (/^[0-9a-f]{64}$/.test(tok)) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await sha256(tok)).run();
    const res = json({ ok: true });
    res.headers.append("set-cookie", sessionCookie("", 0));
    return res;
  }

  if (route === "forgot") {
    const email = cleanEmail(body.email);
    const keys = [`forgot:ip:${ip}`, `forgot:em:${email}`];
    if (await tooMany(env, keys)) return TOO_MANY();
    await hit(env, keys);
    const u = EMAIL_RE.test(email) ? await env.DB.prepare("SELECT id, name, email FROM users WHERE email = ?1").bind(email).first() : null;
    if (u) {
      const tok = randomHex(32);
      await env.DB.prepare("INSERT INTO resets (token_hash, user_id, expires_at) VALUES (?1, ?2, datetime('now', '+1 hour'))").bind(await sha256(tok), u.id).run();
      ctx.waitUntil(mailReset(env, u.email, u.name, `${origin}/?reset=${tok}`).catch((e) => console.error("mail", e && e.message)));
    }
    // Misma respuesta exista o no la cuenta: no revelamos qué correos están registrados
    return json({ ok: true });
  }

  if (route === "reset") {
    const tok = String(body.token || ""), password = String(body.password || "");
    if (!/^[0-9a-f]{64}$/.test(tok)) return json({ error: "El enlace no es válido o ha caducado." }, 400);
    if (password.length < 8 || password.length > 128) return json({ error: "La contraseña debe tener entre 8 y 128 caracteres." }, 400);
    if (await tooMany(env, [`reset:ip:${ip}`])) return TOO_MANY();
    const th = await sha256(tok);
    const r = await env.DB.prepare("SELECT user_id FROM resets WHERE token_hash = ?1 AND used = 0 AND expires_at > datetime('now')").bind(th).first();
    if (!r) { await hit(env, [`reset:ip:${ip}`]); return json({ error: "El enlace no es válido o ha caducado." }, 400); }
    const salt = randomHex(16), iter = iterations(env);
    const hash = await hashPassword(password, salt, iter);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET pass_hash = ?1, pass_salt = ?2, pass_iter = ?3 WHERE id = ?4").bind(hash, salt, iter, r.user_id),
      env.DB.prepare("UPDATE resets SET used = 1 WHERE token_hash = ?1").bind(th),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(r.user_id), // cierra todas las sesiones abiertas
    ]);
    return json({ ok: true });
  }

  // A partir de aquí hace falta sesión iniciada
  const user = await currentUser(request, env);
  if (!user) return json({ error: "Inicia sesión para continuar." }, 401);

  if (route === "marketing") {
    const on = body.marketing === true ? 1 : 0;
    await env.DB.prepare("UPDATE users SET marketing = ?1, marketing_at = datetime('now') WHERE id = ?2").bind(on, user.id).run();
    ctx.waitUntil(brevoSubscribe(env, user.email, user.name, !!on).catch((e) => console.error("brevo", e && e.message)));
    return json({ ok: true, marketing: !!on });
  }

  if (route === "delete") {
    const u = await env.DB.prepare("SELECT pass_hash, pass_salt, pass_iter FROM users WHERE id = ?1").bind(user.id).first();
    if (await tooMany(env, [`del:u:${user.id}`])) return TOO_MANY();
    const calc = await hashPassword(String(body.password || "").slice(0, 128), u.pass_salt, u.pass_iter);
    if (!safeEqual(calc, u.pass_hash)) { await hit(env, [`del:u:${user.id}`]); return json({ error: "Contraseña incorrecta." }, 401); }
    // Los pedidos se conservan (obligación contable) pero desvinculados de la cuenta
    await env.DB.batch([
      env.DB.prepare("UPDATE orders SET user_id = NULL WHERE user_id = ?1").bind(user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(user.id),
      env.DB.prepare("DELETE FROM resets WHERE user_id = ?1").bind(user.id),
      env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(user.id),
    ]);
    ctx.waitUntil(brevoSubscribe(env, user.email, user.name, false).catch((e) => console.error("brevo", e && e.message)));
    const res = json({ ok: true });
    res.headers.append("set-cookie", sessionCookie("", 0));
    return res;
  }
  return json({ error: "No encontrado" }, 404);
}

async function me(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ user: null });
  const { results: orders } = await env.DB.prepare(
    `SELECT id, status, total_cents, fulfillment, carrier, tracking, created_at FROM orders
     WHERE user_id = ?1 AND status IN ('paid','shipped','ready') ORDER BY id DESC LIMIT 20`
  ).bind(user.id).all();
  const { results: items } = orders.length
    ? await env.DB.prepare(`SELECT order_id, name, qty FROM order_items WHERE order_id IN (${orders.map((_, i) => `?${i + 1}`).join(",")})`).bind(...orders.map((o) => o.id)).all()
    : { results: [] };
  return json({
    user: { email: user.email, name: user.name, marketing: !!user.marketing },
    orders: orders.map((o) => ({ ...o, items: items.filter((i) => i.order_id === o.id) })),
  });
}

/* ================================================================== CORREO (Brevo) */
const escHtml = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const eur = (c) => (c / 100).toFixed(2).replace(".", ",") + " €";
const storeName = (env) => env.STORE_NAME || "Horizonte";

async function sendMail(env, to, toName, subject, html) {
  if (!env.BREVO_API_KEY || !env.MAIL_FROM) { console.log("Correo no enviado (falta BREVO_API_KEY o MAIL_FROM):", subject); return false; }
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { name: env.MAIL_FROM_NAME || storeName(env), email: env.MAIL_FROM },
      to: [{ email: to, name: toName || undefined }],
      subject,
      htmlContent: html,
    }),
  });
  if (!res.ok) console.error("Brevo rechazó el correo:", res.status, (await res.text().catch(() => "")).slice(0, 200));
  return res.ok;
}

function layout(env, title, inner, button) {
  const btn = button
    ? `<p style="margin:24px 0"><a href="${escHtml(button.url)}" style="background:#141414;color:#fff;text-decoration:none;font-weight:700;padding:14px 26px;border-radius:999px;display:inline-block">${escHtml(button.text)}</a></p>`
    : "";
  return `<!doctype html><html lang="es"><body style="margin:0;background:#f1eee8;font-family:Arial,Helvetica,sans-serif;color:#141414">
<div style="max-width:560px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border-radius:16px;padding:28px">
<p style="font-size:18px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;margin:0 0 18px">${escHtml(storeName(env))}</p>
<h1 style="font-size:22px;margin:0 0 12px">${escHtml(title)}</h1>${inner}${btn}
</div><p style="font-size:12px;color:#6b6a66;text-align:center;margin:14px 0 0">Tienda de demostración · ${escHtml(storeName(env))}</p></div></body></html>`;
}

function mailWelcome(env, email, name, marketing, origin) {
  const extra = marketing
    ? `<p style="font-size:14px;color:#6b6a66">Has aceptado recibir novedades y ofertas. Puedes cambiarlo cuando quieras desde tu cuenta o con el enlace de baja de cada correo.</p>`
    : "";
  return sendMail(env, email, name, `Bienvenido/a a ${storeName(env)}`,
    layout(env, `¡Hola, ${name}!`, `<p style="font-size:15px;line-height:1.5">Tu cuenta está creada. Desde ella puedes seguir tus pedidos y comprar más rápido.</p>${extra}`, { text: "Ir a la tienda", url: origin }));
}

function mailReset(env, email, name, link) {
  return sendMail(env, email, name, "Restablece tu contraseña",
    layout(env, "Restablece tu contraseña", `<p style="font-size:15px;line-height:1.5">Hola ${escHtml(name)}, pulsa el botón para elegir una contraseña nueva. El enlace funciona una sola vez y caduca en 1 hora.</p><p style="font-size:13px;color:#6b6a66">Si no lo has pedido tú, ignora este correo: tu contraseña no cambiará.</p>`, { text: "Elegir nueva contraseña", url: link }));
}

async function mailOrderPaid(env, sessionId, origin) {
  const o = await env.DB.prepare("SELECT id, email, name, total_cents, shipping_cents, fulfillment, shipping_address FROM orders WHERE stripe_session_id = ?1").bind(sessionId).first();
  if (!o) return;
  const { results: items } = await env.DB.prepare("SELECT name, qty, unit_cents FROM order_items WHERE order_id = ?1").bind(o.id).all();
  const pick = o.fulfillment === "pickup";
  let addr = "";
  if (!pick) {
    let a = null;
    try { a = o.shipping_address ? JSON.parse(o.shipping_address) : null; } catch { /* dirección ilegible */ }
    addr = a ? [a.name, a.line1, a.line2, `${a.postal_code || ""} ${a.city || ""}`.trim(), a.country].filter(Boolean).map(escHtml).join("<br>") : "";
  }
  const where = pick
    ? '<p style="font-size:14px"><strong>Recogida en tienda.</strong> Te avisaremos por correo en cuanto tu pedido esté listo.</p>'
    : `<p style="font-size:14px"><strong>Envío a:</strong><br>${addr}</p>`;
  const rows = items.map((i) => `<tr><td style="padding:6px 0;font-size:14px">${i.qty} × ${escHtml(i.name)}</td><td style="padding:6px 0;font-size:14px;text-align:right">${eur(i.qty * i.unit_cents)}</td></tr>`).join("");
  const table = `<table style="width:100%;border-collapse:collapse;border-top:1px solid #e6e3dd">${rows}
<tr><td style="padding:6px 0;font-size:14px;color:#6b6a66">Envío</td><td style="text-align:right;font-size:14px">${o.shipping_cents ? eur(o.shipping_cents) : "Gratis"}</td></tr>
<tr><td style="padding:10px 0;font-weight:800;border-top:1px solid #e6e3dd">Total</td><td style="text-align:right;font-weight:800;border-top:1px solid #e6e3dd">${eur(o.total_cents)}</td></tr></table>`;
  if (o.email) {
    await sendMail(env, o.email, o.name, `Pedido nº ${o.id} confirmado`,
      layout(env, "¡Gracias por tu compra!", `<p style="font-size:15px">Hemos recibido tu pago. Este es el resumen del pedido <strong>nº ${o.id}</strong>:</p>${table}${where}`, { text: "Ir a la tienda", url: origin }));
  }
  // Aviso al dueño de la tienda
  const owner = env.OWNER_EMAIL || env.MAIL_FROM;
  if (owner) {
    const who = `<p style="font-size:14px"><strong>Cliente:</strong> ${escHtml(o.name || "—")} · ${escHtml(o.email || "sin correo")}</p>`;
    await sendMail(env, owner, storeName(env), `Nuevo pedido nº ${o.id} · ${eur(o.total_cents)}`,
      layout(env, "Tienes un pedido nuevo", `${who}${table}${where}`, { text: "Abrir el panel", url: `${origin}/admin.html` }));
  }
}

/* ================================================================== TIENDA: datos legales, fotos, productos */
function shopInfo(env) {
  return {
    name: storeName(env),
    legalName: env.SHOP_LEGAL_NAME || "",
    nif: env.SHOP_NIF || "",
    address: env.SHOP_ADDRESS || "",
    email: env.SHOP_EMAIL || env.MAIL_FROM || "",
    phone: env.SHOP_PHONE || "",
    registry: env.SHOP_REGISTRY || "",
    returnAddress: env.SHOP_RETURN_ADDRESS || env.SHOP_ADDRESS || "",
  };
}

const slugify = (v) => String(v || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

// "19,90", "19.90", "1.234,50", "19,90 €" → céntimos (o null si no es válido)
function parseEuros(v) {
  let t = String(v == null ? "" : v).replace(/[€\s]/g, "");
  if (!t) return null;
  if (t.includes(",") && t.includes(".")) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(",", ".");
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n > 10000) return null;
  return Math.round(n * 100);
}

async function image(env, key) {
  if (!env.IMAGES || !IMG_RE.test(key)) return new Response("No encontrado", { status: 404 });
  const obj = await env.IMAGES.get(key);
  if (!obj) return new Response("No encontrado", { status: 404 });
  const type = key.endsWith(".webp") ? "image/webp" : key.endsWith(".png") ? "image/png" : "image/jpeg";
  // La clave cambia en cada subida, así que la foto puede cachearse un año
  return new Response(obj.body, { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
}

function sniffImage(b) {
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  return null;
}

async function uploadImage(request, env, url) {
  if (!env.IMAGES) return json({ error: "Falta configurar el almacén de fotos (R2) en el servidor." }, 501);
  const id = Number(url.searchParams.get("product"));
  if (!Number.isInteger(id) || id <= 0) return json({ error: "Producto no válido." }, 400);
  const p = await env.DB.prepare("SELECT id, image_key FROM products WHERE id = ?1").bind(id).first();
  if (!p) return json({ error: "Producto no encontrado." }, 404);
  const buf = new Uint8Array(await request.arrayBuffer());
  if (!buf.length || buf.length > MAX_IMG) return json({ error: "La foto es demasiado grande (máximo 700 KB). Se reduce sola al subirla desde el panel." }, 413);
  const ext = sniffImage(buf);
  if (!ext) return json({ error: "Formato de foto no válido (usa JPG, PNG o WebP)." }, 415);
  const key = `p/${id}-${randomHex(5)}.${ext}`;
  await env.IMAGES.put(key, buf, { httpMetadata: { contentType: ext === "webp" ? "image/webp" : ext === "png" ? "image/png" : "image/jpeg" } });
  await env.DB.prepare("UPDATE products SET image_key = ?1 WHERE id = ?2").bind(key, id).run();
  if (p.image_key) await env.IMAGES.delete(p.image_key);
  return json({ ok: true, image: `/img/${key}` });
}

function cleanProduct(b) {
  const name = String(b.name || "").trim().slice(0, 120);
  const category = String(b.category || "").trim().slice(0, 40);
  const description = String(b.description || "").trim().slice(0, 600);
  const price = Number(b.price_cents);
  const compare = b.compare_at_cents == null || b.compare_at_cents === "" ? null : Number(b.compare_at_cents);
  if (!name || !category) return { error: "Falta el nombre o la categoría." };
  if (!Number.isInteger(price) || price < 1 || price > 1000000) return { error: "El precio no es válido." };
  if (compare !== null && (!Number.isInteger(compare) || compare <= price || compare > 1000000)) return { error: "El precio anterior debe ser mayor que el precio actual." };
  return { v: { name, category, description, price, compare, kind: KINDS.includes(b.kind) ? b.kind : "tee", size_kind: SIZE_SETS[b.size_kind] ? b.size_kind : "top" } };
}

function cleanVariants(list) {
  if (!Array.isArray(list) || list.length > 120) return { error: "Lista de variantes no válida." };
  const seen = new Set(), out = [];
  for (const x of list) {
    const color_name = String(x && x.color_name || "").trim().slice(0, 30);
    const color_hex = String(x && x.color_hex || "");
    const size = String(x && x.size || "").trim().slice(0, 12);
    const stock = Number(x && x.stock), id = x && x.id ? Number(x.id) : 0;
    if (!color_name || !size) return { error: "Cada variante necesita color y talla." };
    if (!/^#[0-9a-fA-F]{6}$/.test(color_hex)) return { error: `El color «${color_name}» no es válido.` };
    if (!Number.isInteger(stock) || stock < 0 || stock > 10000) return { error: "El stock debe estar entre 0 y 10000." };
    const k = `${color_name.toLowerCase()}|${size.toLowerCase()}`;
    if (seen.has(k)) return { error: `Variante repetida: ${color_name} · ${size}.` };
    seen.add(k);
    out.push({ id: Number.isInteger(id) && id > 0 ? id : 0, color_name, color_hex, size, stock });
  }
  return { list: out };
}

async function saveProduct(env, b) {
  const c = cleanProduct(b || {});
  if (c.error) return c;
  const vr = cleanVariants((b || {}).variants);
  if (vr.error) return vr;
  const v = c.v;
  let id = Number(b.id) || 0, slug;
  if (id) {
    const ex = await env.DB.prepare("SELECT id, slug FROM products WHERE id = ?1").bind(id).first();
    if (!ex) return { error: "Producto no encontrado.", status: 404 };
    slug = ex.slug;
    await env.DB.prepare("UPDATE products SET name=?1, category=?2, kind=?3, size_kind=?4, description=?5, price_cents=?6, compare_at_cents=?7 WHERE id=?8")
      .bind(v.name, v.category, v.kind, v.size_kind, v.description, v.price, v.compare, id).run();
  } else {
    const base = slugify(v.name) || "producto";
    slug = base;
    for (let n = 2; await env.DB.prepare("SELECT 1 AS x FROM products WHERE slug = ?1").bind(slug).first(); n++) slug = `${base}-${n}`;
    const r = await env.DB.prepare("INSERT INTO products (slug, name, category, kind, size_kind, description, price_cents, compare_at_cents) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)")
      .bind(slug, v.name, v.category, v.kind, v.size_kind, v.description, v.price, v.compare).run();
    id = r.meta.last_row_id;
  }
  if (typeof b.active === "boolean") await env.DB.prepare("UPDATE products SET active = ?1 WHERE id = ?2").bind(b.active ? 1 : 0, id).run();

  const { results: cur } = await env.DB.prepare("SELECT id FROM variants WHERE product_id = ?1").bind(id).all();
  const own = new Set(cur.map((x) => x.id));
  for (const x of vr.list) if (x.id && !own.has(x.id)) return { error: "Variante no válida." };
  const keep = new Set(vr.list.filter((x) => x.id).map((x) => x.id));
  const stmts = [];
  for (const x of vr.list) {
    stmts.push(x.id
      ? env.DB.prepare("UPDATE variants SET color_name=?1, color_hex=?2, size=?3, stock=?4 WHERE id=?5 AND product_id=?6").bind(x.color_name, x.color_hex, x.size, x.stock, x.id, id)
      : env.DB.prepare("INSERT INTO variants (product_id, sku, color_name, color_hex, size, stock) VALUES (?1,?2,?3,?4,?5,?6)").bind(id, `${slug}-${randomHex(4)}`, x.color_name, x.color_hex, x.size, x.stock));
  }
  for (const old of cur) {
    if (keep.has(old.id)) continue;
    // Si ya hay pedidos con esa variante no se puede borrar: se deja sin stock
    stmts.push(env.DB.prepare("DELETE FROM variants WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM order_items WHERE variant_id = ?1)").bind(old.id));
    stmts.push(env.DB.prepare("UPDATE variants SET stock = 0 WHERE id = ?1").bind(old.id));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true, id };
}

// Importación desde CSV/Excel: una fila por variante (producto + color + talla). Se puede repetir sin duplicar.
async function importRows(env, rows) {
  if (!Array.isArray(rows) || !rows.length) return { error: "El archivo no tiene filas." };
  if (rows.length > 400) return { error: "Máximo 400 filas por importación." };
  const errors = [], products = new Map(), variants = [];
  rows.forEach((r, i) => {
    const line = i + 2, name = String(r.name || "").trim().slice(0, 120), slug = slugify(name);
    if (!slug) { errors.push({ line, msg: "Falta el nombre del producto." }); return; }
    const price = parseEuros(r.price);
    if (price === null) { errors.push({ line, msg: `Precio no válido en «${name}».` }); return; }
    let compare = r.compare_at ? parseEuros(r.compare_at) : null;
    if (compare !== null && compare <= price) compare = null;
    const size = String(r.size || "Única").trim().slice(0, 12) || "Única";
    const color = String(r.color || "Único").trim().slice(0, 30) || "Único";
    const hex = /^#[0-9a-fA-F]{6}$/.test(String(r.hex || "").trim()) ? String(r.hex).trim() : "#C8C4BC";
    const stock = Math.max(0, Math.min(10000, parseInt(r.stock, 10) || 0));
    if (!products.has(slug)) {
      products.set(slug, {
        slug, name, price, compare,
        category: String(r.category || "General").trim().slice(0, 40) || "General",
        description: String(r.description || "").trim().slice(0, 600),
        kind: KINDS.includes(String(r.kind || "").trim()) ? String(r.kind).trim() : "tee",
        size_kind: /^\d+$/.test(size) ? "bottom" : size.toLowerCase() === "única" || size.toLowerCase() === "unica" ? "one" : "top",
      });
    }
    variants.push({ slug, sku: `${slug}-${slugify(color)}-${slugify(size)}`, color, hex, size, stock });
  });
  if (errors.length) return { error: `Hay ${errors.length} fila(s) con errores. Primera: línea ${errors[0].line}, ${errors[0].msg}`, errors };
  const stmts = [];
  for (const p of products.values()) {
    stmts.push(env.DB.prepare(
      `INSERT INTO products (slug, name, category, kind, size_kind, description, price_cents, compare_at_cents) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
       ON CONFLICT(slug) DO UPDATE SET name=excluded.name, category=excluded.category, kind=excluded.kind, description=excluded.description, price_cents=excluded.price_cents, compare_at_cents=excluded.compare_at_cents, active=1`
    ).bind(p.slug, p.name, p.category, p.kind, p.size_kind, p.description, p.price, p.compare));
  }
  for (const x of variants) {
    stmts.push(env.DB.prepare(
      `INSERT INTO variants (product_id, sku, color_name, color_hex, size, stock) VALUES ((SELECT id FROM products WHERE slug = ?1), ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(sku) DO UPDATE SET color_name=excluded.color_name, color_hex=excluded.color_hex, size=excluded.size, stock=excluded.stock`
    ).bind(x.slug, x.sku, x.color, x.hex, x.size, x.stock));
  }
  for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
  return { ok: true, products: products.size, variants: variants.length };
}
function mailFulfilled(env, o, state, carrier, tracking, origin) {
  if (state === "ready") {
    return sendMail(env, o.email, o.name, `Tu pedido nº ${o.id} está listo para recoger`,
      layout(env, "¡Tu pedido está listo!", `<p style="font-size:15px;line-height:1.5">Ya puedes pasar a recoger el pedido <strong>nº ${o.id}</strong> en la tienda. Lleva este correo o tu número de pedido.</p>`, { text: "Ver la tienda", url: origin }));
  }
  const tr = tracking ? `<p style="font-size:14px">Número de seguimiento: <strong>${escHtml(tracking)}</strong></p>` : "";
  return sendMail(env, o.email, o.name, `Tu pedido nº ${o.id} ha salido`,
    layout(env, "¡Tu pedido va de camino!", `<p style="font-size:15px;line-height:1.5">El pedido <strong>nº ${o.id}</strong> ha salido con <strong>${escHtml(carrier)}</strong>.</p>${tr}`, { text: "Ver la tienda", url: origin }));
}

/* Sincroniza el consentimiento de publicidad con la lista de contactos de Brevo */
async function brevoSubscribe(env, email, name, subscribe) {
  if (!env.BREVO_API_KEY) return;
  const h = { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" };
  if (subscribe) {
    const body = { email, attributes: { FIRSTNAME: name }, updateEnabled: true, emailBlacklisted: false };
    if (env.BREVO_LIST_ID) body.listIds = [Number(env.BREVO_LIST_ID)];
    const r = await fetch("https://api.brevo.com/v3/contacts", { method: "POST", headers: h, body: JSON.stringify(body) });
    if (!r.ok) console.error("Brevo contacto:", r.status);
  } else {
    // Baja: lo marcamos como "no enviar" (404 = no estaba en Brevo, no pasa nada)
    const r = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, { method: "PUT", headers: h, body: JSON.stringify({ emailBlacklisted: true }) });
    if (!r.ok && r.status !== 404) console.error("Brevo baja:", r.status);
  }
}
