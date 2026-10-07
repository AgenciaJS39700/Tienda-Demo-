// worker.js · API de la tienda demo (Cloudflare Workers + D1 + Stripe Checkout)
// Rutas:  GET /api/products · POST /api/checkout · POST /api/webhook · GET /api/order · POST /api/cancel · /api/admin/*
// Secretos necesarios (Cloudflare → Worker → Settings → Variables and Secrets):
//   STRIPE_SECRET_KEY  (sk_test_...)   STRIPE_WEBHOOK_SECRET  (whsec_...)   ADMIN_TOKEN  (una contraseña para /admin)

const STRIPE_API = "https://api.stripe.com/v1";
const HOLD_MINUTES = 30;          // Stripe exige entre 30 minutos y 24 horas
const SHIPPING_CENTS = 495;       // envío estándar
const FREE_SHIPPING_FROM = 6000;  // envío gratis desde 60 €
const MAX_QTY = 10;
const COUNTRIES = ["ES", "PT", "FR", "DE", "IT"];
const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{10,}$/;
const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/products" && request.method === "GET") return await products(env);
      if (path === "/api/checkout" && request.method === "POST") return await checkout(request, env, url);
      if (path === "/api/webhook" && request.method === "POST") return await webhook(request, env);
      if (path === "/api/order" && request.method === "GET") return await order(url, env);
      if (path === "/api/cancel" && request.method === "POST") return await cancel(request, env);
      if (path.startsWith("/api/admin/")) return await admin(request, env, url);
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

async function markPaid(env, s) {
  const d = s.customer_details || {};
  const ship = s.shipping_details || (s.collected_information && s.collected_information.shipping_details) || null;
  const address = ship && ship.address ? JSON.stringify({ name: ship.name || d.name || "", ...ship.address }) : null;
  const r = await env.DB.prepare(
    "UPDATE orders SET status = 'paid', email = ?1, name = ?2, shipping_address = ?3, paid_at = datetime('now') WHERE stripe_session_id = ?4 AND status = 'pending'"
  ).bind(d.email || null, d.name || null, address, s.id).run();
  return r.meta.changes > 0;
}

/* ------------------------------------------------------------------ catálogo */
async function products(env) {
  await releaseExpired(env);
  const { results: ps } = await env.DB.prepare(
    "SELECT id, slug, name, category, kind, description, price_cents, compare_at_cents FROM products WHERE active = 1 ORDER BY id"
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
    products: ps.map((p) => ({ ...p, variants: byProduct[p.id] || [] })),
    shipping: { cents: SHIPPING_CENTS, freeFrom: FREE_SHIPPING_FROM },
    maxQty: MAX_QTY,
  });
}

/* ------------------------------------------------------------------ checkout */
async function checkout(request, env, url) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Falta configurar Stripe en el servidor." }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Petición no válida." }, 400); }

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
  const shipping = subtotal >= FREE_SHIPPING_FROM ? 0 : SHIPPING_CENTS;

  // 2) Crear el pedido y reservar el stock en una sola transacción
  const created = await env.DB.prepare(
    "INSERT INTO orders (status, total_cents, shipping_cents) VALUES ('pending', ?1, ?2)"
  ).bind(subtotal + shipping, shipping).run();
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
  COUNTRIES.forEach((c, i) => p.set(`shipping_address_collection[allowed_countries][${i}]`, c));
  rows.forEach((r, i) => {
    p.set(`line_items[${i}][quantity]`, String(quantities.get(r.id)));
    p.set(`line_items[${i}][price_data][currency]`, "eur");
    p.set(`line_items[${i}][price_data][unit_amount]`, String(r.price_cents));
    p.set(`line_items[${i}][price_data][product_data][name]`, r.name);
    p.set(`line_items[${i}][price_data][product_data][description]`, `${r.color_name} · talla ${r.size}`);
  });
  p.set("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
  p.set("shipping_options[0][shipping_rate_data][display_name]", shipping === 0 ? "Envío gratuito" : "Envío estándar");
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
async function webhook(request, env) {
  const raw = await request.text();
  const valid = await verifyStripeSignature(raw, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response("Firma no válida", { status: 400 });

  let event;
  try { event = JSON.parse(raw); } catch { return new Response("JSON no válido", { status: 400 }); }
  const s = event.data && event.data.object;
  if (!s) return new Response("ok", { status: 200 });

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    if (s.payment_status === "paid") await markPaid(env, s);
  } else if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
    const o = await env.DB.prepare("SELECT id FROM orders WHERE stripe_session_id = ?1").bind(s.id).first();
    if (o) await releaseOrder(env, o.id, "expired");
  }
  return new Response("ok", { status: 200 });
}

/* ------------------------------------------------------------------ pedido y cancelación */
async function order(url, env) {
  const sid = url.searchParams.get("session_id") || "";
  if (!SESSION_RE.test(sid)) return json({ error: "Sesión no válida." }, 400);
  const o = await env.DB.prepare(
    "SELECT id, status, total_cents, shipping_cents FROM orders WHERE stripe_session_id = ?1"
  ).bind(sid).first();
  if (!o) return json({ error: "Pedido no encontrado." }, 404);

  // Si el aviso de Stripe aún no ha llegado, lo consultamos directamente
  if (o.status === "pending" && env.STRIPE_SECRET_KEY) {
    const r = await stripeRequest(env, "GET", `/checkout/sessions/${sid}`);
    if (r.ok && r.data.payment_status === "paid") {
      await markPaid(env, r.data);
      o.status = "paid";
    }
  }
  const { results } = await env.DB.prepare("SELECT name, qty, unit_cents FROM order_items WHERE order_id = ?1").bind(o.id).all();
  return json({ number: o.id, status: o.status, total_cents: o.total_cents, shipping_cents: o.shipping_cents, items: results });
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
async function admin(request, env, url) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!env.ADMIN_TOKEN || !token || !safeEqual(token, env.ADMIN_TOKEN)) return json({ error: "No autorizado" }, 401);

  if (url.pathname === "/api/admin/summary" && request.method === "GET") {
    const { results: orders } = await env.DB.prepare(
      "SELECT id, status, total_cents, email, name, created_at, paid_at FROM orders ORDER BY id DESC LIMIT 30"
    ).all();
    const { results: items } = await env.DB.prepare(
      "SELECT order_id, name, qty FROM order_items WHERE order_id IN (SELECT id FROM orders ORDER BY id DESC LIMIT 30)"
    ).all();
    const { results: variants } = await env.DB.prepare(
      "SELECT v.id, p.name AS product, v.color_name, v.size, v.stock FROM variants v JOIN products p ON p.id = v.product_id ORDER BY p.id, v.id"
    ).all();
    const stats = await env.DB.prepare(
      "SELECT COUNT(*) AS paid_orders, COALESCE(SUM(total_cents), 0) AS paid_cents FROM orders WHERE status = 'paid'"
    ).first();
    return json({ stats, orders: orders.map((o) => ({ ...o, items: items.filter((i) => i.order_id === o.id) })), variants });
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
