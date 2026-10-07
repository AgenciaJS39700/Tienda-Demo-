-- Datos de demostración: 12 productos y sus variantes (color x talla) con stock aleatorio
INSERT INTO products (slug, name, category, kind, size_kind, description, price_cents, compare_at_cents) VALUES
('camiseta-basica','Camiseta Básica de Algodón','Camisetas','tee','top','Un básico suave y cómodo para todos los días. Corte regular.',1990,NULL),
('camiseta-oversize','Camiseta Oversize','Camisetas','tee','top','Caída amplia y relajada, perfecta para looks urbanos.',2490,NULL),
('camiseta-lino','Camiseta de Lino','Camisetas','tee','top','Tejido fresco y ligero para los días de calor.',2990,NULL),
('sudadera-capucha','Sudadera con Capucha','Sudaderas','hoodie','top','Capucha con cordones y bolsillo canguro. Abrigo y estilo.',4490,5990),
('sudadera-clasica','Sudadera Cuello Redondo','Sudaderas','sweat','top','La sudadera de siempre, con un acabado cuidado.',3990,NULL),
('vaquero-slim','Vaquero Slim','Pantalones','jeans','bottom','Corte slim y tejido con un toque elástico.',5490,NULL),
('chino-clasico','Pantalón Chino','Pantalones','jeans','bottom','Elegante y versátil: para la oficina o para el fin de semana.',4990,NULL),
('chaqueta-vaquera','Chaqueta Vaquera','Chaquetas','jacket','top','Un clásico atemporal que combina con todo.',6990,NULL),
('bomber','Cazadora Bomber','Chaquetas','jacket','top','Ligera, con cremallera y puños elásticos.',7990,9990),
('vestido-midi','Vestido Midi','Vestidos','dress','top','Largo midi con caída fluida. Ideal para cualquier ocasión.',5990,NULL),
('gorra-clasica','Gorra Clásica','Accesorios','cap','one','Visera curva y cierre ajustable.',1790,NULL),
('tote-algodon','Tote Bag de Algodón','Accesorios','bag','one','Resistente y espaciosa para el día a día.',1290,NULL);
WITH pc(slug,cname,hex) AS (VALUES
('camiseta-basica','Blanco','#F5F5F4'),('camiseta-basica','Negro','#1C1C1E'),('camiseta-basica','Verde salvia','#8FA58B'),
('camiseta-oversize','Crudo','#E8DFD0'),('camiseta-oversize','Azul marino','#1F2A44'),
('camiseta-lino','Arena','#D9C7A5'),('camiseta-lino','Terracota','#B7573A'),
('sudadera-capucha','Gris','#8E8E93'),('sudadera-capucha','Negro','#1C1C1E'),('sudadera-capucha','Burdeos','#6D1F2E'),
('sudadera-clasica','Gris jaspeado','#B8B8BD'),('sudadera-clasica','Azul marino','#1F2A44'),
('vaquero-slim','Azul denim','#3E5C86'),('vaquero-slim','Negro','#222226'),
('chino-clasico','Beige','#CBB994'),('chino-clasico','Verde oliva','#6B6F4B'),
('chaqueta-vaquera','Denim claro','#5B7FA8'),('chaqueta-vaquera','Negro','#222226'),
('bomber','Verde militar','#4B5320'),('bomber','Negro','#222226'),
('vestido-midi','Rojo','#B3261E'),('vestido-midi','Negro','#1C1C1E'),('vestido-midi','Azul noche','#1B2A49'),
('gorra-clasica','Negro','#1C1C1E'),('gorra-clasica','Beige','#CBB994'),('gorra-clasica','Azul marino','#1F2A44'),
('tote-algodon','Crudo','#E8DFD0'),('tote-algodon','Negro','#1C1C1E')),
sz(kind,size) AS (VALUES ('top','XS'),('top','S'),('top','M'),('top','L'),('top','XL'),('bottom','38'),('bottom','40'),('bottom','42'),('bottom','44'),('bottom','46'),('one','Única'))
INSERT INTO variants (product_id, sku, color_name, color_hex, size, stock)
SELECT p.id, p.slug || '-' || lower(replace(pc.cname,' ','-')) || '-' || sz.size, pc.cname, pc.hex, sz.size,
CASE WHEN abs(random()) % 7 = 0 THEN 0 ELSE abs(random()) % 13 END
FROM pc JOIN products p ON p.slug = pc.slug JOIN sz ON sz.kind = p.size_kind;
