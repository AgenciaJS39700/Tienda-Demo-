# Checklist: tienda nueva para un cliente

## 1. Datos del cliente (antes de empezar)
- Nombre comercial, razón social, NIF, dirección, correo y teléfono (van a los textos legales).
- Su cuenta de Stripe (con su IBAN) y su dominio.
- Catálogo en Excel (ver plantilla en el panel → Importar) y fotos de producto.
- Zonas y tarifas de envío, e importe de envío gratis. Si ofrece recogida en tienda.

## 2. Montaje (lo hace Claude)
1. Copiar este repositorio a uno nuevo del cliente.
2. Crear su base de datos D1 y ejecutar `schema.sql`.
3. Crear su bucket R2 para fotos (requiere R2 activado en la cuenta de Cloudflare).
4. Editar `wrangler.jsonc`: `name`, `database_id`, bucket R2 y variables `STORE_NAME`, `MAIL_FROM`, `OWNER_EMAIL`, `BREVO_LIST_ID`, `SHOP_LEGAL_NAME`, `SHOP_NIF`, `SHOP_ADDRESS`, `SHOP_EMAIL`, `SHOP_PHONE`.
5. Ajustar tarifas en `RATES` (arriba de `worker.js`), colores y textos de `index.html` y el nombre en `admin.html`.
6. Crear el Worker conectado al repositorio en Cloudflare y añadir los secretos: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ADMIN_TOKEN`, `BREVO_API_KEY`.
7. En Stripe: crear el webhook hacia `https://dominio/api/webhook` con los eventos `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded` y `checkout.session.async_payment_failed`.
8. Conectar el dominio del cliente y verificarlo en Brevo (SPF/DKIM/DMARC) para que los correos no caigan en spam.

## 3. Pruebas antes de entregar
- Registro, correo de bienvenida, compra con tarjeta `4242 4242 4242 4242`, correo de pedido, aviso al dueño, envío/recogida desde el panel.
- Revisar `/legal.html`: sin textos "[pendiente de completar]". Los textos son una plantilla: que los revise un profesional.
- Cambiar Stripe a modo real (claves y webhook live) solo cuando todo esté probado.

## 4. Entrega
- Formación de 15 minutos: stock, pedidos, enviar, productos nuevos.
- Dejar al cliente su contraseña de admin (cada tienda tiene la suya en `ADMIN_TOKEN`).
