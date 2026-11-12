'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Configure in-memory SQLite before loading app modules
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { parseReceiptText, renderThermalReceiptHtml } = require('../src/receipt-parser');
const {
  haversineKm,
  estimateRoadKm,
  calculateOrderPricing,
  buildSmartBatches,
  chooseBestCourierForBatch,
  optimizeStopSequence
} = require('../src/dispatch-engine');
const serverModule = require('../server');

let server;
let baseUrl = '';

const tokens = {
  admin: '',
  groupMerchant: '',
  singleMerchant: '',
  courierPosOnline: '',    // Ahmet Yılmaz (05553003031, is_online: 1, has_pos: 1)
  courierNoPosOnline: '',  // Burak Demir  (05553003032, is_online: 1, has_pos: 0)
  courierPosOffline: ''    // Can Kaya     (05553003033, is_online: 0, has_pos: 1)
};

async function api(pathname, { method = 'GET', token = '', body = undefined, headers = {} } = {}) {
  const reqHeaders = { ...headers };
  if (token) reqHeaders.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    reqHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: reqHeaders,
    body: payload
  });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, headers: res.headers, data };
}

test.before(async () => {
  const app = typeof serverModule.createApp === 'function'
    ? serverModule.createApp({ dbPath: ':memory:' })
    : (serverModule.app || serverModule);

  await new Promise((resolve, reject) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test('1. Health, Public Config ve Dinamik PWA Manifest uç noktaları çalışır', async () => {
  const health = await api('/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  assert.equal(health.data.app, 'PAKETÜS');

  const cfg = await api('/api/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.data.appName, 'PAKETÜS');
  assert.ok(Array.isArray(cfg.data.creditPackages));
  assert.ok(cfg.data.creditPackages.length >= 3);

  const manifest = await api('/api/manifest.json?role=courier');
  assert.equal(manifest.status, 200);
  assert.ok(manifest.data.name || manifest.data.short_name);
});

test('2. Demo hesap listesi ve tüm rollerin (Admin, Grup İşletme, Tekil İşletme, Kuryeler) girişi çalışır', async () => {
  const demos = await api('/api/auth/demo-accounts');
  assert.equal(demos.status, 200);

  const loginAdmin = await api('/api/auth/login', {
    method: 'POST',
    body: { phone: '05551001010', password: '1234', tenantSlug: 'merkez' }
  });
  assert.equal(loginAdmin.status, 200);
  assert.equal(loginAdmin.data.ok, true);
  assert.equal(loginAdmin.data.user.role, 'admin');
  tokens.admin = loginAdmin.data.token;

  const loginGroup = await api('/api/auth/login', {
    method: 'POST',
    body: { phone: '05552002020', password: '1234', tenantSlug: 'merkez' }
  });
  assert.equal(loginGroup.status, 200);
  assert.equal(loginGroup.data.user.role, 'merchant');
  tokens.groupMerchant = loginGroup.data.token;

  const loginSingle = await api('/api/auth/login', {
    method: 'POST',
    body: { phone: '05552002021', password: '1234', tenantSlug: 'merkez' }
  });
  assert.equal(loginSingle.status, 200);
  assert.equal(loginSingle.data.user.role, 'merchant');
  tokens.singleMerchant = loginSingle.data.token;

  const loginC1 = await api('/api/auth/login', {
    method: 'POST',
    body: { phone: '05553003031', password: '1234', tenantSlug: 'merkez' }
  });
  assert.equal(loginC1.status, 200);
  assert.equal(loginC1.data.user.role, 'courier');
  tokens.courierPosOnline = loginC1.data.token;

  const loginC2 = await api('/api/auth/login', {
    method: 'POST',
    body: { phone: '05553003032', password: '1234', tenantSlug: 'merkez' }
  });
  assert.equal(loginC2.status, 200);
  tokens.courierNoPosOnline = loginC2.data.token;

  const loginC3 = await api('/api/auth/login', {
    method: 'POST',
    body: { phone: '05553003033', password: '1234', tenantSlug: 'merkez' }
  });
  assert.equal(loginC3.status, 200);
  tokens.courierPosOffline = loginC3.data.token;
});

test('3. Çok kiracılı (Multi-Tenant) yeni şirket kaydı ve tam veri izolasyonu çalışır', async () => {
  const reg = await api('/api/public/register-tenant', {
    method: 'POST',
    body: {
      companyName: 'Kuzey Ege Ekspres Kurye',
      city: 'Ayvalık, Balıkesir',
      adminName: 'Selim Kaya',
      adminPhone: '05559998877',
      password: '4321'
    }
  });
  assert.equal(reg.status, 200);
  assert.equal(reg.data.ok, true);
  assert.ok(reg.data.token);
  const newTenantToken = reg.data.token;

  const bootNew = await api('/api/bootstrap', { token: newTenantToken });
  assert.equal(bootNew.status, 200);
  const creditsBalance = bootNew.data.tenant.credits_balance ?? bootNew.data.tenant.creditsBalance;
  assert.equal(creditsBalance, 100);

  // Merkez tenant orders should not leak into new tenant
  const bootMerkez = await api('/api/bootstrap', { token: tokens.admin });
  const merkezOrderIds = new Set((bootMerkez.data.orders || []).map((o) => o.id));
  for (const o of bootNew.data.orders || []) {
    assert.equal(merkezOrderIds.has(o.id), false, 'Farklı kiracıların siparişleri birbirine sızmamalı');
  }
});

test('4. Mesafe (Haversine + Yol Çarpanı) ve Dinamik Fiyat/Hakediş motoru doğru hesaplar', () => {
  const d = haversineKm(39.5961, 27.0244, 39.6050, 27.0350);
  assert.ok(d > 1.0 && d < 2.0);
  const road = estimateRoadKm(39.5961, 27.0244, 39.6050, 27.0350);
  assert.ok(road > d);

  // Missing shop pin should not assume city center (returns 0)
  const zeroRoad = estimateRoadKm(null, null, 39.6050, 27.0350);
  assert.equal(zeroRoad, 0);

  const pricing = calculateOrderPricing({
    distanceKm: 2.5,
    orderAmount: 600,
    shop: { tariff_mode: 'km', base_fee: 45, per_km_fee: 10, commission_pct: 12 },
    zones: [{ min_km: 0, max_km: 5, shop_fee: 50, courier_fee: 35 }],
    courier: { per_package_fee: 30, per_km_bonus: 5 }
  });
  assert.ok(Number(pricing.deliveryFee ?? pricing.delivery_fee) > 0);
  assert.ok(Number(pricing.courierEarning ?? pricing.courier_earning) > 0);
});

test('5. Pagate tarzı otomatik paket birleştirme (buildSmartBatches) aynı koridordaki en fazla 3 paketi gruplar', () => {
  const sampleOrders = [
    {
      id: 101,
      status: 'pending',
      shop_id: 1,
      shop_lat: 39.5961,
      shop_lng: 27.0244,
      dest_lat: 39.6020,
      dest_lng: 27.0310,
      payment_method: 'cash',
      order_amount: 350
    },
    {
      id: 102,
      status: 'pending',
      shop_id: 1,
      shop_lat: 39.5961,
      shop_lng: 27.0244,
      dest_lat: 39.6045,
      dest_lng: 27.0335,
      payment_method: 'online_paid',
      order_amount: 420
    },
    {
      id: 103,
      status: 'pending',
      shop_id: 2,
      shop_lat: 39.5965,
      shop_lng: 27.0249,
      dest_lat: 39.5800,
      dest_lng: 26.9900, // Ters yön ve uzak
      payment_method: 'cash',
      order_amount: 290
    }
  ];

  const batches = buildSmartBatches(sampleOrders);
  assert.ok(Array.isArray(batches));
  assert.equal(batches.length, 2, 'Yakın aynı yön 2 sipariş birleşmeli, ters yöndeki 3. sipariş ayrı grupta kalmalı');
  const multiBatch = batches.find((b) => (b.orders || b.items || []).length === 2);
  assert.ok(multiBatch, 'İkili akıllı paket grubu oluşturulmalı');
});

test('6. 2-opt rota sıralaması (optimizeStopSequence) teslimat duraklarını en kısa yol sırasına dizer', () => {
  const origin = { lat: 39.5961, lng: 27.0244 };
  const stops = [
    { id: 'uzak', dest_lat: 39.6150, dest_lng: 27.0480 },
    { id: 'yakin', dest_lat: 39.5985, dest_lng: 27.0270 },
    { id: 'orta', dest_lat: 39.6050, dest_lng: 27.0350 }
  ];
  const ordered = optimizeStopSequence(origin, stops);
  assert.equal(ordered.length, 3);
  assert.equal(ordered[0].id, 'yakin');
  assert.equal(ordered[1].id, 'orta');
  assert.equal(ordered[2].id, 'uzak');
});

test('7. Kapıda Kredi Kartı (card_on_delivery) paketleri YALNIZCA POS cihazı olan (has_pos === 1) çevrimiçi kuryeye atanır', () => {
  const posBatch = {
    requiresPos: true,
    payment_method: 'card_on_delivery',
    orders: [{ id: 501, payment_method: 'card_on_delivery', shop_lat: 39.5961, shop_lng: 27.0244, dest_lat: 39.601, dest_lng: 27.029 }]
  };

  const candidateCouriers = [
    // Daha yakın ama POS cihazı YOK (Burak Demir)
    { id: 2, name: 'Burak Demir', is_online: 1, on_break: 0, has_pos: 0, battery_pct: 95, max_batch: 4, active_count: 0, lat: 39.5962, lng: 27.0245 },
    // Çevrimdışı ama POS cihazı var (Can Kaya)
    { id: 3, name: 'Can Kaya', is_online: 0, on_break: 0, has_pos: 1, battery_pct: 100, max_batch: 6, active_count: 0, lat: 39.5961, lng: 27.0244 },
    // Çevrimiçi ve POS cihazı VAR (Ahmet Yılmaz)
    { id: 1, name: 'Ahmet Yılmaz', is_online: 1, on_break: 0, has_pos: 1, battery_pct: 90, max_batch: 4, active_count: 0, lat: 39.5990, lng: 27.0280 }
  ];

  const chosen = chooseBestCourierForBatch(posBatch, candidateCouriers);
  assert.ok(chosen, 'Uygun POS cihazlı kurye bulunmalı');
  assert.equal(chosen.id, 1, 'POS cihazı olmayan veya çevrimdışı olan kurye ASLA seçilmemeli');
});

test('8. Kurye GPS ve batarya güncellemesi gönderdiğinde kendiliğinden is_online: 1 OLMAZ (Kurye Çevrimiçi Kilidi)', async () => {
  // Can Kaya (05553003033) başlangıçta is_online: 0
  const gpsUpdate = await api('/api/courier/status', {
    method: 'POST',
    token: tokens.courierPosOffline,
    body: { lat: 39.5925, lng: 27.0295, batteryPct: 88 }
  });
  assert.equal(gpsUpdate.status, 200);

  const bootCourier = await api('/api/bootstrap', { token: tokens.courierPosOffline });
  assert.equal(bootCourier.status, 200);
  const courierState = bootCourier.data.courier;
  const isOnlineAfterGps = Number(courierState.is_online ?? courierState.isOnline);
  assert.equal(isOnlineAfterGps, 0, 'GPS güncellemesi çevrimdışı kuryeyi ASLA çevrimiçi yapmamalı!');

  // Açıkça isOnline: true gönderildiğinde çevrimiçi olmalı, sonra tekrar kapatılabilmeli
  const goOnline = await api('/api/courier/status', {
    method: 'POST',
    token: tokens.courierPosOffline,
    body: { isOnline: true }
  });
  assert.equal(goOnline.status, 200);
  const onlineVal = Number((goOnline.data.courier || goOnline.data).is_online ?? (goOnline.data.courier || goOnline.data).isOnline);
  assert.equal(onlineVal, 1);

  await api('/api/courier/status', {
    method: 'POST',
    token: tokens.courierPosOffline,
    body: { isOnline: false }
  });
});

test('9. İşletme (merchant) API ve SSE çıktılarında kurye GPS (lat/lng) koordinatları ASLA sızdırılmaz', async () => {
  const merchBoot = await api('/api/bootstrap', { token: tokens.groupMerchant });
  assert.equal(merchBoot.status, 200);

  // Çoklu marka grup işletmenin 3 şubesi görünmeli
  assert.ok(Array.isArray(merchBoot.data.shops));
  assert.ok(merchBoot.data.shops.length >= 3, 'Grup işletme altında en az 3 alt marka/şube gelmeli');

  // Eğer couriers dizisi varsa hiçbirinde lat/lng olmamalı
  if (Array.isArray(merchBoot.data.couriers)) {
    for (const c of merchBoot.data.couriers) {
      assert.equal(c.lat ?? null, null, 'İşletme kurye lat koordinatını göremez');
      assert.equal(c.lng ?? null, null, 'İşletme kurye lng koordinatını göremez');
    }
  }

  // SSE stream ilk snapshot kontrolü
  const sseText = await new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/api/stream?token=${encodeURIComponent(tokens.groupMerchant)}`, (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.includes('\n\n')) {
          req.destroy();
          resolve(buf);
        }
      });
      res.on('error', () => resolve(buf));
    });
    req.on('error', reject);
  });

  assert.ok(sseText.includes('event: snapshot'), 'SSE ilk açılışta snapshot olayı göndermeli');
  const dataLine = sseText.split('\n').find((l) => l.startsWith('data: '));
  if (dataLine) {
    const parsed = JSON.parse(dataLine.slice(6));
    if (Array.isArray(parsed.couriers)) {
      for (const c of parsed.couriers) {
        assert.equal(c.lat ?? null, null, 'SSE işletme yayınında kurye lat null olmalı');
        assert.equal(c.lng ?? null, null, 'SSE işletme yayınında kurye lng null olmalı');
      }
    }
  }
});

test('10. Müşteri canlı takip uç noktası (/api/public/track/:code) mahremiyeti koruyarak durum döndürür', async () => {
  const adminBoot = await api('/api/bootstrap', { token: tokens.admin });
  const sampleOrder = adminBoot.data.orders[0];
  assert.ok(sampleOrder && (sampleOrder.tracking_code || sampleOrder.trackingCode));
  const code = sampleOrder.tracking_code || sampleOrder.trackingCode;

  const trackRes = await api(`/api/public/track/${encodeURIComponent(code)}`);
  assert.equal(trackRes.status, 200);
  assert.equal(trackRes.data.ok, true);
  assert.equal(trackRes.data.order.trackingCode || trackRes.data.order.tracking_code, code);
  assert.equal(trackRes.data.order.courierLat, undefined, 'Takip ekranında kurye ham GPS koordinatı sızdırılmamalı');
});

test('11. Yeni sipariş oluşturulduğunda süresiz kontör düşümü ve Caller ID müşteri kaydı çalışır', async () => {
  const beforeBoot = await api('/api/bootstrap', { token: tokens.admin });
  const startCredits = Number(beforeBoot.data.tenant.credits_balance ?? beforeBoot.data.tenant.creditsBalance);

  const createRes = await api('/api/orders', {
    method: 'POST',
    token: tokens.groupMerchant,
    body: {
      shopId: 1,
      customerName: 'Zeynep Aksoy',
      customerPhone: '05327776655',
      customerAddress: 'Cumhuriyet Mah. İnönü Cad. No:42 D:5',
      neighborhood: 'Cumhuriyet Mah.',
      destLat: 39.6012,
      destLng: 27.0288,
      orderAmount: 540,
      paymentMethod: 'card_on_delivery',
      orderType: 'delivery',
      itemsSummary: '2x Zurna Dürüm Menü, 1x Künefe',
      notes: 'Zile basmayın, kapıda POS lütfen'
    }
  });
  assert.ok(createRes.status === 200 || createRes.status === 201);
  assert.equal(createRes.data.ok, true);
  const createdOrder = createRes.data.order;
  assert.equal(createdOrder.status, 'pending');

  const afterBoot = await api('/api/bootstrap', { token: tokens.admin });
  const endCredits = Number(afterBoot.data.tenant.credits_balance ?? afterBoot.data.tenant.creditsBalance);
  assert.equal(endCredits, startCredits - 1, 'Sipariş açıldığında tam 1 kontör düşülmeli');

  // Caller ID kontrolü
  const callerRes = await api('/api/caller-id?phone=05327776655', { token: tokens.groupMerchant });
  assert.equal(callerRes.status, 200);
  const customer = callerRes.data.customer || callerRes.data;
  assert.ok(customer);
  assert.equal(customer.name, 'Zeynep Aksoy');
  assert.ok(Number(customer.order_count ?? customer.orderCount) >= 1);
});

test('12. Sipariş iptalinde (cancelled) kontör tam 1 kez iade edilir, mükerrer iptalde ikinci kez iade edilmez', async () => {
  const createRes = await api('/api/orders', {
    method: 'POST',
    token: tokens.admin,
    body: {
      shopId: 1,
      customerName: 'İptal Test Müşteri',
      customerPhone: '05331112233',
      customerAddress: 'Soğanyemez Mah. Çarşı Sok. No:9',
      neighborhood: 'Soğanyemez Mah.',
      orderAmount: 310,
      paymentMethod: 'cash',
      orderType: 'delivery',
      itemsSummary: '1x Lahmacun Menü'
    }
  });
  const orderId = createRes.data.order.id;

  const midBoot = await api('/api/bootstrap', { token: tokens.admin });
  const creditsAfterCreate = Number(midBoot.data.tenant.credits_balance ?? midBoot.data.tenant.creditsBalance);

  // İlk iptal -> +1 kontör iade edilmeli
  const cancel1 = await api(`/api/orders/${orderId}/status`, {
    method: 'PATCH',
    token: tokens.admin,
    body: { status: 'cancelled' }
  });
  assert.equal(cancel1.status, 200);

  const afterCancel1 = await api('/api/bootstrap', { token: tokens.admin });
  const creditsAfterCancel1 = Number(afterCancel1.data.tenant.credits_balance ?? afterCancel1.data.tenant.creditsBalance);
  assert.equal(creditsAfterCancel1, creditsAfterCreate + 1, 'İptal edilen siparişin kontörü iade edilmeli');

  // İkinci kez iptal isteği -> kontör tekrar artmamalı!
  await api(`/api/orders/${orderId}/status`, {
    method: 'PATCH',
    token: tokens.admin,
    body: { status: 'cancelled' }
  });
  const afterCancel2 = await api('/api/bootstrap', { token: tokens.admin });
  const creditsAfterCancel2 = Number(afterCancel2.data.tenant.credits_balance ?? afterCancel2.data.tenant.creditsBalance);
  assert.equal(creditsAfterCancel2, creditsAfterCancel1, 'Mükerrer iptal çağrısında ikinci kez kontör iadesi yapılmamalı');
});

test('13. Sıfır kontör bakiyesinde yeni sipariş silinmez, pending_credit korumasına alınır ve kontör yüklenince serbest bırakılır', async () => {
  // Yeni bir kiracı açıp 100 kontörünü sıfırlayacak veya negatif topup / test siparişiyle kontrol edelim
  const reg = await api('/api/public/register-tenant', {
    method: 'POST',
    body: {
      companyName: 'Kontör Koruma Test Lojistik',
      city: 'Edremit',
      adminName: 'Test Admin',
      adminPhone: '05558887766',
      password: '1234'
    }
  });
  const tToken = reg.data.token;
  const boot0 = await api('/api/bootstrap', { token: tToken });
  const shopId = boot0.data.shops[0].id;
  const currentBalance = Number(boot0.data.tenant.credits_balance ?? boot0.data.tenant.creditsBalance);

  // Bakiyeyi sıfırlamak için negatif düzeltme veya topup(-currentBalance)
  await api('/api/admin/credits/topup', {
    method: 'POST',
    token: tToken,
    body: { amount: -currentBalance, note: 'Test sıfırlama', idempotencyKey: 'zero-out-test-1' }
  });

  const orderAtZero = await api('/api/orders', {
    method: 'POST',
    token: tToken,
    body: {
      shopId,
      customerName: 'Bakiye Bekleyen Müşteri',
      customerPhone: '05442223344',
      customerAddress: 'Camivasat Mah. No:12',
      neighborhood: 'Camivasat Mah.',
      orderAmount: 450,
      paymentMethod: 'cash',
      orderType: 'delivery',
      itemsSummary: '2x Burger Menü'
    }
  });
  assert.ok(orderAtZero.status === 200 || orderAtZero.status === 201);
  assert.equal(orderAtZero.data.order.status, 'pending_credit', 'Sıfır bakiyede sipariş silinmeyip pending_credit olmalı');

  // Kontör yükle ve siparişi serbest bırak
  const topupRes = await api('/api/admin/credits/topup', {
    method: 'POST',
    token: tToken,
    body: { amount: 50, note: 'Yeni Paket', idempotencyKey: 'topup-50-key' }
  });
  assert.equal(topupRes.status, 200);

  const releaseRes = await api(`/api/admin/orders/${orderAtZero.data.order.id}/release-credit`, {
    method: 'POST',
    token: tToken
  });
  assert.equal(releaseRes.status, 200);
  assert.equal(releaseRes.data.order.status, 'pending', 'Kontör yüklendikten sonra sipariş havuza (pending) alınmalı');
});

test('14. Teslim edilmiş paketin ödeme yöntemi ve tutarı yönetici tarafından sonradan güncellenebilir (PATCH /api/admin/orders/:id/financials)', async () => {
  const adminBoot = await api('/api/bootstrap', { token: tokens.admin });
  const deliveredOrder = adminBoot.data.orders.find((o) => o.status === 'delivered') || adminBoot.data.orders[0];
  assert.ok(deliveredOrder);

  // İşletme rolü güncelleyememeli (403)
  const forbiddenRes = await api(`/api/admin/orders/${deliveredOrder.id}/financials`, {
    method: 'PATCH',
    token: tokens.groupMerchant,
    body: { orderAmount: 999, paymentMethod: 'cash' }
  });
  assert.ok(forbiddenRes.status === 401 || forbiddenRes.status === 403);

  // Yönetici güncelleyebilmeli
  const finRes = await api(`/api/admin/orders/${deliveredOrder.id}/financials`, {
    method: 'PATCH',
    token: tokens.admin,
    body: {
      orderAmount: 875.5,
      paymentMethod: 'card_on_delivery',
      deliveryFee: 65,
      courierEarning: 48
    }
  });
  assert.equal(finRes.status, 200);
  assert.equal(finRes.data.ok, true);
  const updated = finRes.data.order;
  assert.equal(Number(updated.order_amount ?? updated.orderAmount), 875.5);
  assert.equal(updated.payment_method ?? updated.paymentMethod, 'card_on_delivery');
});

test('15. Akıllı paket önizleme ve otomatik kurye atama (/api/admin/dispatch/preview-batches & auto-assign) POS kurallarına uyar', async () => {
  const preview = await api('/api/admin/dispatch/preview-batches', {
    method: 'POST',
    token: tokens.admin
  });
  assert.equal(preview.status, 200);
  assert.ok(Array.isArray(preview.data.batches));

  const autoAssign = await api('/api/admin/dispatch/auto-assign', {
    method: 'POST',
    token: tokens.admin
  });
  assert.equal(autoAssign.status, 200);
  assert.equal(autoAssign.data.ok, true);

  // Atanan siparişlerde card_on_delivery olan hiçbir sipariş has_pos === 0 olan kuryeye (Burak Demir, id: 2) atanmış olmamalı!
  const afterBoot = await api('/api/bootstrap', { token: tokens.admin });
  const couriersById = new Map(afterBoot.data.couriers.map((c) => [c.id, c]));
  for (const o of afterBoot.data.orders) {
    if ((o.payment_method || o.paymentMethod) === 'card_on_delivery' && (o.courier_id || o.courierId)) {
      const c = couriersById.get(o.courier_id || o.courierId);
      assert.equal(Number(c.has_pos ?? c.hasPos), 1, `Kapıda kredi kartlı sipariş #${o.id} yalnızca POS cihazlı kuryeye atanabilir`);
    }
  }
});

test('16. Türkçe Termal Fiş Ayrıştırıcı (parseReceiptText & renderThermalReceiptHtml) 1.250,50 TL ve kapıda POS bilgilerini doğru ayrıştırır', () => {
  const rawEscPosReceipt = [
    '\x1B\x40\x1B\x61\x01HATAY DÖNERCİSİ - EDREMİT',
    'Sipariş Tipi: PAKET SERVİS',
    'Müşteri: Kemalettin Öztürk',
    'Tel: 0 (532) 444 55 66',
    'Adres: Akçay Mah. Kordon Boyu Cad. No: 18 Daire: 4 Edremit',
    '--------------------------------',
    '3x Antakya Soslu Dürüm   950,00 TL',
    '2x Büyük Ayran           300,50 TL',
    'GENEL TOPLAM: 1.250,50 TL',
    'Ödeme: KAPIDA KREDİ KARTI (POS CİHAZI GETİRİNİZ)',
    'Not: Acı sos bol olsun lütfen'
  ].join('\n');

  const parsed = parseReceiptText(rawEscPosReceipt);
  assert.equal(parsed.amount, 1250.5);
  assert.equal(parsed.paymentMethod, 'card_on_delivery');
  assert.equal(parsed.orderType, 'delivery');
  assert.ok(parsed.customerPhone.includes('5324445566'));
  assert.ok(parsed.customerName.includes('Kemalettin'));
  assert.ok(parsed.address.includes('Kordon Boyu'));

  const html = renderThermalReceiptHtml(
    {
      tracking_code: 'PKT-9988',
      customer_name: parsed.customerName,
      customer_phone: parsed.customerPhone,
      customer_address: parsed.customerAddress || parsed.address,
      order_amount: parsed.amount,
      payment_method: parsed.paymentMethod,
      items_summary: parsed.itemsSummary,
      notes: parsed.notes
    },
    { name: 'Hatay Dönercisi', phone: '02663730000' },
    { name: 'Ege Hızlı Kurye & Lojistik' }
  );
  assert.ok(html.includes('80mm'));
  assert.ok(html.includes('PKT-9988'));
  assert.ok(html.includes('POS') || html.includes('KREDİ KARTI') || html.includes('Kart'));
});

test('17. Pazaryeri & POS Entegrasyon uç noktaları (/api/integrations/*) webhook, idempotency ve tek tık simülasyonu çalıştırır', async () => {
  const platforms = await api('/api/integrations/platforms', { token: tokens.admin });
  assert.equal(platforms.status, 200);
  assert.ok(Array.isArray(platforms.data.platforms || platforms.data));

  const parseApi = await api('/api/integrations/parse-receipt', {
    method: 'POST',
    token: tokens.admin,
    body: { rawText: 'Müşteri: Ayşe Kaya\nTel: 0542 123 45 67\nAdres: Cennetayağı Mah. Lale Sok. No:5\nTOPLAM: 480,00 TL\nÖdeme: NAKİT' }
  });
  assert.equal(parseApi.status, 200);
  const parsedObj = parseApi.data.parsed || parseApi.data;
  assert.equal(parsedObj.amount, 480);
  assert.equal(parsedObj.paymentMethod, 'cash');

  // Webhook idempotency testi
  const webhookPayload = {
    externalId: 'YS-EXT-2026-001',
    shopId: 1,
    customerName: 'Mehmet Can',
    customerPhone: '05356667788',
    customerAddress: 'Gazicelal Mah. Uzun Sok. No:11',
    neighborhood: 'Gazicelal Mah.',
    orderAmount: 620,
    paymentMethod: 'online_paid',
    itemsSummary: '2x İskender Kebap'
  };
  const wh1 = await api('/api/integrations/webhook/yemeksepeti', {
    method: 'POST',
    body: webhookPayload
  });
  assert.ok(wh1.status === 200 || wh1.status === 201);
  const firstOrderId = (wh1.data.order || wh1.data).id;

  const wh2 = await api('/api/integrations/webhook/yemeksepeti', {
    method: 'POST',
    body: webhookPayload
  });
  assert.equal(wh2.status, 200);
  const secondOrderId = (wh2.data.order || wh2.data).id;
  assert.equal(secondOrderId, firstOrderId, 'Aynı externalId ile gelen webhook mükerrer sipariş açmamalı');

  // Tek tık pazaryeri simülasyonu
  const sim = await api('/api/integrations/simulate/trendyolgo', {
    method: 'POST',
    token: tokens.admin,
    body: { shopId: 1 }
  });
  assert.ok(sim.status === 200 || sim.status === 201);
  assert.ok(sim.data.order || sim.data.id);

  // Termal fiş HTML uç noktası
  const receiptHtml = await api(`/api/integrations/receipt/${firstOrderId}/html`, { token: tokens.admin });
  assert.equal(receiptHtml.status, 200);
  assert.ok(typeof receiptHtml.data === 'string' && receiptHtml.data.includes('<html'));
});

test('18. Paket Bazlı Sohbet (/api/orders/:id/messages) işletme, kurye ve operasyon merkezi arasında çalışır', async () => {
  const boot = await api('/api/bootstrap', { token: tokens.admin });
  const targetOrder = boot.data.orders[0];

  const postMsg = await api(`/api/orders/${targetOrder.id}/messages`, {
    method: 'POST',
    token: tokens.groupMerchant,
    body: { body: 'Paketin yanında ekstra sarımsaklı sos poşeti var, dikkat edelim.' }
  });
  assert.ok(postMsg.status === 200 || postMsg.status === 201);

  const listMsgs = await api(`/api/orders/${targetOrder.id}/messages`, {
    token: tokens.admin
  });
  assert.equal(listMsgs.status, 200);
  const messages = listMsgs.data.messages || listMsgs.data;
  assert.ok(Array.isArray(messages));
  assert.ok(messages.some((m) => m.body.includes('sarımsaklı sos')));
});

test('19. Canlı Bas-Konuş Saha Telsizi (/api/radio) sesli/metin anonslarını kaydeder ve listeler', async () => {
  const sendRadio = await api('/api/radio', {
    method: 'POST',
    token: tokens.admin,
    body: {
      channel: 'genel',
      textNote: 'Merkezden tüm kuryelere: Akçay kordon yolunda trafik yoğunluğu var, alternatif sokakları kullanın.',
      durationSec: 4.2
    }
  });
  assert.ok(sendRadio.status === 200 || sendRadio.status === 201);

  const getRadio = await api('/api/radio', { token: tokens.courierPosOnline });
  assert.equal(getRadio.status, 200);
  const list = getRadio.data.transmissions || getRadio.data.radioTransmissions || getRadio.data;
  assert.ok(Array.isArray(list));
  assert.ok(list.some((r) => (r.text_note || r.textNote || '').includes('Akçay kordon')));
});

test('20. Gün sonu kasa & kurye/işletme mutabakat raporu (/api/admin/reconciliation) doğru özet üretir', async () => {
  const rec = await api('/api/admin/reconciliation', { token: tokens.admin });
  assert.equal(rec.status, 200);
  assert.equal(rec.data.ok ?? true, true);
  assert.ok(rec.data.couriers || rec.data.shops || rec.data.summary);
});
