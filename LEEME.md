# Tienda demo v2 · cuentas, correos y envíos

## Qué incluye
- Registro / inicio de sesión con correo y contraseña, recuperar contraseña, ver pedidos, baja de novedades y borrar cuenta.
- Correos con Brevo: bienvenida, restablecer contraseña, confirmación de pedido, "enviado" (con seguimiento) y "listo para recoger".
- Publicidad con consentimiento (casilla sin marcar): los clientes que aceptan pasan a una lista de Brevo.
- Envíos: tarifa por país (ES, PT, FR, DE, IT), gratis desde un importe y recogida en tienda. Cambia precios en `RATES` (arriba de `worker.js`).
- Admin (`/admin.html`): botón "Marcar enviado y avisar" (con transportista y seguimiento) o "Listo para recoger".

## Pasos para activarlo (en este orden)
1. **Base de datos**: Cloudflare → D1 → tienda-demo → Console → pega todo `migracion-001-cuentas.sql` → Execute. (Una sola vez. No uses `schema.sql`, es solo para instalaciones nuevas.)
2. **Brevo** (brevo.com, plan gratis): crea cuenta → Contacts → crea una lista y apunta su número (ID) → SMTP & API → API Keys → crea una clave. Senders → añade y verifica el remitente.
3. **Cloudflare → Worker tienda-demo → Settings → Variables and Secrets**:
   - Secreto `BREVO_API_KEY` = tu clave de Brevo
   - Texto `MAIL_FROM` = el remitente verificado en Brevo
   - Texto `MAIL_FROM_NAME` = nombre que verá el cliente (ej. Horizonte)
   - Texto `BREVO_LIST_ID` = número de la lista
   - Texto `STORE_NAME` = Horizonte
   - (Opcional) `SITE_URL` = https://tu-dominio (enlaces de los correos)
4. **GitHub**: sube `worker.js`, `index.html`, `admin.html`, `schema.sql` (sustituyen a los actuales). Cloudflare publica solo.

Si no pones `BREVO_API_KEY` todo funciona igual, solo que no se envían correos.

## Importante
- **Dominio propio**: con un remitente @gmail los correos acaban en spam. Para clientes reales usa un dominio con SPF/DKIM/DMARC (Brevo te da los registros).
- **Contraseñas**: PBKDF2-SHA256 (100.000 vueltas). Si en el plan gratis de Workers el login da error por límite de CPU, añade la variable `PBKDF2_ITER` = 50000 (o pasa al plan de pago, 5 $/mes).
- **Islas**: Stripe restringe por país, no por región. "España" incluye Baleares, Canarias, Ceuta y Melilla con la misma tarifa; si el cliente tiene islas, avisa de recargo o limita.
- **RGPD**: la casilla de publicidad va sin marcar y se guarda la fecha. Las campañas se envían desde Brevo, que añade el enlace de baja. Revisa política de privacidad con el cliente real.
