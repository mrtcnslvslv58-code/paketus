# PAKETÜS — Master Mimari Sözleşme (`ARCHITECTURE.md`)

**PAKETÜS**, Paketmatik, Pagate, Vigo, Adisyo ve SepetTakip sistemlerinin en güçlü özelliklerini tek çatı altında birleştiren kurumsal, çok kiracılı (multi-tenant) kurye, akıllı rota/paket birleştirme, POS/pazaryeri entegrasyonu, Caller ID, bas-konuş saha telsizi ve süresiz kontör otomasyonudur.

## 0. Kırmızı Çizgiler
1. **Tam İzolasyon:** `airclass`, `kurye-merkezi` ve `kod-asistani` klasörlerine, GitHub repolarına veya Render servislerine **kesinlikle dokunulmayacak**.
2. **Sıfır Ücretli Dış Servis:** Yalnızca yerleşik Node.js (`node:sqlite`, `node:crypto`, `node:test`) ve ücretsiz `express` + açık kaynak Leaflet/OpenStreetMap + Google Maps & Yandex dış navigasyon bağlantıları kullanılır.
3. **Dosya Sahipliği (Çakışma Yasağı):**
   - `cekirdek-motor`: `.node-version`, `.gitignore`, `package.json`, `npm install`, `src/db.js`, `src/dispatch-engine.js`, `server.js`
   - `arayuz-pwa`: `public/index.html`, `public/styles.css`, `public/app.js`
   - `entegrasyon-pos`: `src/receipt-parser.js`, `src/integrations-router.js`, `public/scripts/pos-yazici-ajan.ps1`
   - `marka-dokuman`: `public/favicon.svg`, `public/brand/logo.svg`, `public/brand/icon-192.svg`, `public/brand/icon-512.svg`, `public/sw.js`, `README.md`
   - `kalite-yayin`: `tests/paketus.test.js` + Yerel/Canlı Chrome CDP doğrulama + GitHub (`mrtcnslvslv58-code/paketus`) & Render (`paketus`) canlı dağıtım.

---

## 1. Hazır Demo Operasyon & Giriş Bilgileri (Seed Verisi)
Uygulama ilk açıldığında `merkez` (`tenant_slug: "merkez"`, Ad: `"Ege Hızlı Kurye & Lojistik"`, Şehir: `"Edremit, Balıkesir"`, Merkez: `[39.5961, 27.0244]`, Başlangıç Kontör: `2500`, `credits_enabled: 1`) operasyonu zengin gerçekçi verilerle hazır gelir. Ayrıca yeni şirketler `/api/public/register-tenant` ile 30 saniyede kendi izole operasyonunu açabilir!

### Demo Giriş Hesapları (`tenant_slug: "merkez"` veya numara ile otomatik eşleşme):
- **Yönetici (Operasyon Merkezi):** Telefon: `05551001010` | Şifre: `1234` (`role: "admin"`, Ad: `"Murat Yönetici"`)
- **Çoklu Marka Grup İşletme (Pagate/Paketmatik Grup Hesabı):** Telefon: `05552002020` | Şifre: `1234` (`role: "merchant"`, Grup: `"Lezzet Grup Restoranları"` -> 3 alt marka/şube: `Hatay Dönercisi` `#1`, `Burger İstasyonu` `#2`, `Gece Kumrucusu` `#3`)
- **Tekil İşletme:** Telefon: `05552002021` | Şifre: `1234` (`role: "merchant"`, Şube: `Körfez Pide & Lahmacun` `#4`)
- **Kuryeler (`role: "courier"`):**
  1. `05553003031` | Şifre: `1234` — **Ahmet Yılmaz** (Motosiklet, `is_online: 1`, `on_break: 0`, `has_pos: 1`, `battery: 92`, `max_batch: 4`, Konum: `[39.5968, 27.0252]`)
  2. `05553003032` | Şifre: `1234` — **Burak Demir** (Motosiklet, `is_online: 1`, `on_break: 0`, `has_pos: 0`, `battery: 78`, `max_batch: 3`, Konum: `[39.5942, 27.0210]`)
  3. `05553003033` | Şifre: `1234` — **Can Kaya** (Araçlı Kurye, `is_online: 0`, `on_break: 0`, `has_pos: 1`, `battery: 100`, `max_batch: 6`, Konum: `[39.5910, 27.0305]`)

**KRİTİK KURAL (Kurye Çevrimiçi Kilidi):** Kuryeler GPS sinyali veya sayfa yenilemesiyle ASLA kendiliğinden `is_online: 1` olmaz! Yalnızca kuryenin kendi Çevrimiçi/Mesai düğmesi (`POST /api/courier/status`) veya yöneticinin müdahalesi (`PATCH /api/admin/couriers/:id`) durumu değiştirebilir.

**KRİTİK KURAL (Kurye GPS Gizliliği):** İşletme (`role: "merchant"`) API yanıtlarında ve SSE yayınlarında kuryelerin `lat` / `lng` GPS koordinatları **ASLA gönderilmez** (`null` maskelenir). Yalnızca yönetici tam harita konumunu görür!

---

## 2. İç Modül Arayüzleri (`src/`)

### A. `src/receipt-parser.js` (`entegrasyon-pos` sahibi)
```js
// module.exports = { parseReceiptText, renderThermalReceiptHtml }
```
- `parseReceiptText(rawText)`: ESC/POS kontrol karakterlerini temizler; Türkçe fiş metninden `{ customerName, customerPhone, address, neighborhood, amount, paymentMethod, orderType, itemsSummary, notes }` döndürür.
  - `paymentMethod` değerleri: `'cash'` (Nakit), `'card_on_delivery'` (Kapıda Kredi Kartı / POS), `'online_paid'` (Online Ödenmiş).
  - `orderType` değerleri: `'delivery'` (Paket Servis), `'takeaway'` (Gel-Al), `'dine_in'` (Salon/Masa).
  - Türkçe tutar okuma: `1.250,50 TL`, `₺480,00`, `TOPLAM: 325,5` -> `number` (`1250.5`, `480`, `325.5`).
- `renderThermalReceiptHtml(order, shop, tenant)`: 80mm termal yazıcı uyumlu tam HTML dizesi döndürür (barkod/takip kodu, ürünler, ödeme tipi, kapıda POS uyarısı, adres, QR/takip kodu).

### B. `src/integrations-router.js` (`entegrasyon-pos` sahibi)
```js
// module.exports = { createIntegrationsRouter, SUPPORTED_PLATFORMS }
```
- `SUPPORTED_PLATFORMS`: `['yemeksepeti', 'getiryemek', 'trendyolgo', 'migrosyemek', 'tiklagelsin', 'adisyo', 'sambapos', 'sepettakip', 'whatsapp', 'pos_agent']`
- `createIntegrationsRouter({ ingestExternalOrder, lookupCallerId, getReceiptOrder, logWebhook })` bir `express.Router()` döndürür ve `/api/integrations` altına bağlanır:
  - `GET /api/integrations/platforms` -> Desteklenen 10 kanalın listesi, durum bilgisi ve örnek webhook şablonları.
  - `POST /api/integrations/webhook/:platform` -> Dış platform/POS siparişini normalize edip `ingestExternalOrder(normalizedPayload)` çağırır (`externalId` ile mükerrer/idempotent koruma sağlar).
  - `POST /api/integrations/parse-receipt` -> `{ rawText }` alıp `parseReceiptText(rawText)` sonucunu döndürür.
  - `POST /api/integrations/simulate/:platform` -> Tek tıkla canlı test/simülasyon için gerçekçi bir Türkiye siparişi üretip `ingestExternalOrder` ile havuza düşürür (`{ tenantId, shopId }` opsiyonel).
  - `GET /api/integrations/receipt/:orderId/html` -> `getReceiptOrder(orderId)` ile siparişi alıp 80mm `renderThermalReceiptHtml` döndürür.

### C. `src/dispatch-engine.js` (`cekirdek-motor` sahibi)
```js
// module.exports = { haversineKm, estimateRoadKm, calculateOrderPricing, buildSmartBatches, chooseBestCourierForBatch, optimizeStopSequence }
```
1. **Mesafe & Bölge Motoru:** `estimateRoadKm(lat1, lng1, lat2, lng2)` = `round2(haversineKm * 1.28)`. Dükkan pini yoksa şehir merkezini varsaymaz (`distance_km: 0` bırakır, sonradan pin/adres çözülünce doldurur).
2. **Dinamik Fiyat & Hakediş (`calculateOrderPricing`):**
   - Bölge (Zone) taban ücreti + İşletme anlaşması (`fixed_fee + per_km_fee * extra_km` veya `% komisyon`) -> `delivery_fee` (işletmeden kesilen kurye ücreti) ve `courier_earning` (kurye hakedişi: paket başı + km primi).
3. **Pagate Tarzı Otomatik Paket Birleştirme & Rota Optimizasyonu (`buildSmartBatches` & `optimizeStopSequence`):**
   - Havuzdaki (`status: 'pending'` veya `'ready'`) paketleri inceler.
   - Aynı dükkândan veya birbirine `<= 0.8 km` yakın dükkânlardan çıkan, aynı yön koridoruna (`bearing` farkı `<= 38°` veya teslimat noktaları arası `<= 1.6 km`) giden en fazla `3` paketi tek bir **Akıllı Rota Grubu (`batch`)** altında birleştirir!
   - Teslimat sırasını en kısa toplam yol (`nearest-neighbor + 2-opt`) ile sıralar (`route_sequence: 1, 2, 3`).
4. **POS Cihazı & Kapasite Eşleştirme (`chooseBestCourierForBatch`):**
   - Yalnızca `is_online === 1` ve `on_break === 0` olan kuryeleri aday alır.
   - **Kritik POS Kuralı:** Gruptaki herhangi bir paketin `payment_method === 'card_on_delivery'` ise **YALNIZCA `has_pos === 1`** olan kuryeler seçilebilir!
   - Aktif paket sayısı + yeni grup boyutu `<= max_batch` olanlar arasından dükkan başlangıcına mesafe + aktif yük + batarya puanına göre en yüksek skorlu kuryeyi seçer.

### D. `src/db.js` (`cekirdek-motor` sahibi)
- Yerleşik `const { DatabaseSync } = require('node:sqlite')` kullanır (`process.env.DB_PATH || path.join(__dirname, '..', 'data', 'paketus.sqlite')`, testlerde `:memory:` destekler).
- `node:sqlite` uyumluluğu için tüm parametrelerde `undefined -> null`, `boolean -> 1/0` ve `BigInt -> Number` dönüşümü yapan temiz yardımcı sarmalayıcı (`run`, `get`, `all`, `tx`) içerir.
- Tablolar:
  - `tenants` (`id`, `slug` UNIQUE, `name`, `city`, `center_lat`, `center_lng`, `credits_balance`, `credits_enabled`, `created_at`)
  - `users` (`id`, `tenant_id`, `phone`, `password_hash`, `role` [`admin`|`merchant`|`courier`], `display_name`, `merchant_group_id`, `shop_id`, `courier_id`, `must_change_password`)
  - `merchant_groups` (`id`, `tenant_id`, `name`, `created_at`)
  - `shops` (`id`, `tenant_id`, `group_id`, `name`, `brand_tag`, `phone`, `address`, `lat`, `lng`, `tariff_mode` [`km`|`zone`|`percent`], `base_fee`, `per_km_fee`, `commission_pct`, `auto_print`, `created_at`)
  - `zones` (`id`, `tenant_id`, `name`, `min_km`, `max_km`, `shop_fee`, `courier_fee`)
  - `couriers` (`id`, `tenant_id`, `name`, `phone`, `vehicle_type`, `is_online`, `on_break`, `has_pos`, `battery_pct`, `max_batch`, `lat`, `lng`, `per_package_fee`, `per_km_bonus`, `updated_at`)
  - `courier_shifts` (`id`, `tenant_id`, `courier_id`, `action` [`shift_start`|`shift_end`|`break_start`|`break_end`], `created_at`)
  - `customers` (`id`, `tenant_id`, `phone`, `name`, `last_address`, `neighborhood`, `lat`, `lng`, `preferred_payment`, `order_count`, `updated_at`) — **Caller ID** için!
  - `orders` (`id`, `tenant_id`, `shop_id`, `courier_id`, `batch_id`, `route_seq`, `tracking_code` UNIQUE, `external_source`, `external_id`, `order_type` [`delivery`|`takeaway`|`dine_in`], `status` [`pending_credit`|`pending`|`assigned`|`picked_up`|`delivered`|`cancelled`|`returned`], `customer_name`, `customer_phone`, `customer_address`, `neighborhood`, `dest_lat`, `dest_lng`, `distance_km`, `order_amount`, `delivery_fee`, `courier_earning`, `payment_method` [`cash`|`card_on_delivery`|`online_paid`], `items_summary`, `notes`, `delivery_pin`, `credit_consumed`, `credit_refunded`, `created_at`, `assigned_at`, `picked_up_at`, `delivered_at`)
  - `order_messages` (`id`, `tenant_id`, `order_id`, `sender_role`, `sender_name`, `body`, `created_at`) — **Paket Bazlı Sohbet!**
  - `radio_transmissions` (`id`, `tenant_id`, `channel`, `sender_role`, `sender_name`, `text_note`, `audio_data_url`, `duration_sec`, `created_at`) — **Bas-Konuş Telsiz!**
  - `credit_ledger` (`id`, `tenant_id`, `delta`, `balance_after`, `reason`, `order_id`, `note`, `idempotency_key` UNIQUE, `created_at`) — **Süresiz Kontör Cüzdanı!**
  - `print_jobs` (`id`, `tenant_id`, `shop_id`, `order_id`, `status` [`queued`|`printed`], `created_at`, `printed_at`)
  - `webhook_logs` (`id`, `tenant_id`, `platform`, `external_id`, `status`, `summary`, `created_at`)

---

## 3. HTTP REST & SSE API Sözleşmesi (`server.js`)

Tüm korumalı uç noktalar `Authorization: Bearer <token>` (veya SSE için `?token=<token>`) kabul eder.

### Açık / Vitrin Uç Noktaları
- `GET /health` -> `200 { ok: true, app: "PAKETÜS", version: "1.0.0", tenants: <number>, ts: <ms> }`
- `GET /api/config` -> `{ appName: "PAKETÜS", tagline: "Yeni Nesil Çok Kiracılı Kurye, POS & Akıllı Rota Otomasyonu", defaultCenter: [39.5961, 27.0244], creditPackages: [{ credits: 500, unitPrice: 1.5, total: 750 }, { credits: 2000, unitPrice: 1.2, total: 2400 }, { credits: 10000, unitPrice: 0.95, total: 9500 }] }`
- `GET /api/manifest.json?role=...` -> Rol bazlı dinamik PWA manifest JSON.
- `POST /api/auth/login` -> `{ phone, password, tenantSlug? }` -> `{ ok: true, token, user: { id, role, displayName, phone, tenantId, tenantSlug, tenantName, shopId, merchantGroupId, courierId }, shops?: [...] }`
- `GET /api/auth/demo-accounts` -> Vitrin ve hızlı test ekranında tek tıkla giriş için demo hesapların listesini (şifresiz özet + tek tık demo login anahtarı veya açık demo bilgisi) döndürür.
- `POST /api/public/register-tenant` -> `{ companyName, city, adminName, adminPhone, password }` -> Yeni izole `tenant` + `admin` + örnek 1 dükkan + 1 kurye + `100` hoş geldin kontörü açar ve `{ ok: true, token, user }` döndürür!
- `GET /api/public/track/:code` -> Müşteri takip ekranı için `{ ok: true, order: { trackingCode, shopName, status, orderType, paymentMethod, orderAmount, createdAt, assignedAt, pickedUpAt, deliveredAt, estimatedMinutesLeft, courierFirstName, vehicleType, deliveryPinHint } }` (Tam kurye GPS'i ve tam müşteri telefonu sızdırılmaz!).

### Canlı Yayın (SSE)
- `GET /api/stream?token=...` -> `event: snapshot` ve `event: update` yayınlar (`role === 'merchant'` ise kurye `lat`/`lng` kesinlikle çıkarılır!).

### Ortak & Rol Bazlı Operasyon Uç Noktaları
- `GET /api/bootstrap` -> Oturum açan role göre tam başlangıç verisi:
  - `admin`: `{ tenant, stats, shops, merchantGroups, zones, couriers, orders, batchesPreview, radioTransmissions, creditLedger, webhookLogs, printJobs }`
  - `merchant`: `{ tenant: { name, city }, shops (kendi tekil veya grup şubeleri), activeShopId, orders (kendi şubelerinin siparişleri), couriersSummary (GPS'siz genel müsait kurye sayısı), printJobs }`
  - `courier`: `{ tenant: { name, city, centerLat, centerLng }, courier (kendi profili, online/mola, POS, batarya, hakediş özeti, avgDeliveryMinutes — "14.2 dk" için sayı), activeOrders (rota sırasına göre sıralı + dükkan konumu + müşteri konumu), recentDelivered, radioTransmissions }`
- **Sipariş Oluşturma & Yaşam Döngüsü:**
  - `POST /api/orders` (`admin` veya `merchant`) -> `{ shopId, customerName, customerPhone, customerAddress, neighborhood, destLat?, destLng?, distanceKm?, orderAmount, paymentMethod, orderType, itemsSummary, notes }`
    - Müşteriyi `customers` tablosuna (Caller ID hafızasına) otomatik kaydeder/günceller.
    - `credits_enabled === 1` ve `credits_balance <= 0` ise siparişi silmez, `status: 'pending_credit'` olarak güvenli beklemeye alır! Kontör varsa `1` kontör düşer ve `status: 'pending'` olarak havuza alır + `auto_print` açıksa `print_jobs` kuyruğuna ekler.
  - `GET /api/caller-id?phone=...` (`admin` veya `merchant`) -> Telefon numarasına göre kayıtlı müşteri adı, son adresi, mahallesi, tercih ettiği ödeme yöntemi ve önceki sipariş sayısını milisaniyede döndürür!
  - `POST /api/admin/dispatch/preview-batches` -> Havuzdaki bekleyen siparişler için `buildSmartBatches` çalıştırıp birleştirilecek paket gruplarını, rota sırasını ve önerilen kuryeleri önizletir.
  - `POST /api/admin/dispatch/auto-assign` -> Tüm uygun akıllı paket gruplarını ve tekil siparişleri kurallara göre (POS uyumu + mesafe + kapasite) tek tıkla kuryelere atar!
  - `POST /api/admin/orders/:id/assign` -> `{ courierId }` manuel kurye atama (POS uyumsuzsa uyarı veya `force: true` seçeneği).
  - `PATCH /api/orders/:id/status` -> `{ status }` (`assigned` -> `picked_up` -> `delivered` | `cancelled` | `returned`). İptalde (`cancelled`) daha önce kontör düşüldüyse **yalnızca 1 kez** kontörü otomatik iade eder!
  - `PATCH /api/admin/orders/:id/financials` (`admin` özel) -> Teslim edilmiş dahil herhangi bir paketin `{ orderAmount, paymentMethod, deliveryFee, courierEarning }` alanlarını güvenli şekilde günceller!
- **Paket Bazlı Sohbet (Pagate Özelliği):**
  - `GET /api/orders/:id/messages` -> O pakete ait mesajlar (`admin`, ilgili `merchant` veya atanmış `courier`).
  - `POST /api/orders/:id/messages` -> `{ body }` yeni paket mesajı gönderir ve SSE ile anlık bildirir.
- **Canlı Bas-Konuş Telsiz (Push-to-Talk Radio):**
  - `GET /api/radio` -> Son 25 telsiz anonsu.
  - `POST /api/radio` (`admin`, `courier`, `merchant`) -> `{ channel, textNote, audioDataUrl?, durationSec? }` (`audioDataUrl` max ~250KB kısa WebM/WAV ses kaydı veya sesli okunacak anons metni) kaydeder ve SSE `event: radio` ile tüm açık ekranlarda anlık çalar!
- **Yönetici Filo, İşletme, Harita, Kontör & Mutabakat:**
  - `POST /api/admin/shops` & `PATCH /api/admin/shops/:id` (Dükkan ekleme, manuel harita pini `lat`/`lng` kaydetme, özel anlaşma fiyatı ve çoklu marka grubu tanımlama).
  - `POST /api/admin/couriers` & `PATCH /api/admin/couriers/:id` (Kurye ekleme, çevrimiçi/mola/POS/ücret güncelleme).
  - `POST /api/courier/status` (`courier` özel) -> `{ isOnline?, onBreak?, batteryPct?, lat?, lng? }` (**Dikkat:** Sadece `lat`/`lng`/`batteryPct` gönderildiğinde `is_online` ASLA değişmez!).
  - `POST /api/admin/credits/topup` -> `{ amount, note, idempotencyKey }` kontör yükler; ayrıca `POST /api/admin/credits/toggle` -> `{ enabled }` kontör modunu açar/kapatır ve `POST /api/admin/orders/:id/release-credit` kontör bekleyen siparişi onaylayıp havuza alır!
  - `GET /api/admin/reconciliation?date=YYYY-MM-DD` -> Gün sonu kurye nakit/POS tahsilat özeti, işletme cari borç/alacak tablosu ve net operasyon kârı!

---

## 4. Modern Web & UI Kalite Standartları (`arayuz-pwa`)
1. Tüm modallarda yerel `<dialog aria-labelledby="...">` ve `.showModal()` kullan (`role="dialog"` veya `aria-modal` ekleme; `html`/`body` üzerine `overflow: hidden` yazma; bunun yerine `dialog:modal { overscroll-behavior: contain; }` ve `dialog::backdrop { overflow: hidden; overscroll-behavior: contain; }` uygula).
2. Veri tablolarında `.table-wrapper` (`tabindex="0"`, `role="region"`, `aria-label`, `container-type: inline-size`) ile masaüstünde yapışkan başlık (`thead { position: sticky; inset-block-start: 0; }`), dar ekranda `@container (width < 600px)` ile kart görünümü uygula.
3. Sekmelerde `<button type="button">` kullan, seçili sekmeyi `[aria-selected="true"]::after` alt çizgisiyle göster (sadece renkle değil) ve taşan sekmelerde tek satır yatay kaydırma kullan.
4. Haritada:
   - Merkezde **Leaflet (OpenStreetMap)** canlı pin haritası: Dükkan isimleri haritayı boğmaz, **yalnızca pine tıklandığında** popup ile açılır! Kurye pinleri hız/batarya/POS rozetiyle görünür.
   - Yanında ve her sipariş/kurye kartında **hem Google Maps hem Yandex Harita** tek tık arama ve yol tarifi düğmeleri aynı anda bulunur (eski ve yeni sokak/numara uyumu için!).
5. Mobil PWA'da sayfa genelinde bozulmayı önleyen ölçek kilidi korunurken **fiş/görsel inceleme penceresinde yakınlaştırma (zoom) kontrolü** açık olur; saldırgan "Uygulamayı Yükle" popup'ı çıkarılmaz.
