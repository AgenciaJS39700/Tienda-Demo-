# Tienda demo · plantilla para clientes

Una tienda online completa sobre Cloudflare (Worker + D1 + R2) con Stripe y Brevo.
Ver `NUEVO-CLIENTE.md` para convertirla en la tienda de un cliente.

## Qué incluye
- Catálogo con fotos, stock en tiempo real, carrito, envío por país o recogida en tienda.
- Cuentas de cliente (registro, login, recuperar contraseña, ver pedidos, baja de novedades, borrar cuenta).
- Pagos con Stripe Checkout y reserva de stock durante 30 minutos.
- Correos con Brevo: bienvenida, restablecer contraseña, pedido confirmado, enviado, listo para recoger, y aviso al dueño por cada pedido.
- Panel `/admin.html`: pedidos y envíos, inventario, crear/editar productos con foto, importar desde Excel/CSV.
- Textos legales configurables en `/legal.html` (aviso legal, privacidad, cookies, condiciones, desistimiento).

## Archivos
`worker.js` (servidor) · `index.html` (tienda) · `admin.html` (panel) · `legal.html` · `wrangler.jsonc` (configuración) · `schema.sql` (base de datos nueva) · `migracion-00X-*.sql` (cambios sobre una base ya creada).
