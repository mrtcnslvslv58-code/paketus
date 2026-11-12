'use strict';

/**
 * PAKETÜS — Pazaryeri Webhook, POS & Termal Fiş Entegrasyon Yönlendiricisi
 * Sahibi: entegrasyon-pos
 */

const express = require('express');
const crypto = require('node:crypto');
const {
  parseReceiptText,
  renderThermalReceiptHtml,
  normalizeTurkishPhone,
  parseTurkishCurrency
} = require('./receipt-parser');

const SUPPORTED_PLATFORMS = [
  'yemeksepeti',
  'getiryemek',
  'trendyolgo',
  'migrosyemek',
  'tiklagelsin',
  'adisyo',
  'sambapos',
  'sepettakip',
  'whatsapp',
  'pos_agent'
];

const PLATFORM_METADATA = {
  yemeksepeti: {
    id: 'yemeksepeti',
    name: 'Yemeksepeti',
    category: 'marketplace',
    badgeColor: '#e11d48',
    description: 'Yemeksepeti Restoran Vale & Kendi Kuryen (Joker/Online/Kapıda POS) webhook entegrasyonu'
  },
  getiryemek: {
    id: 'getiryemek',
    name: 'GetirYemek',
    category: 'marketplace',
    badgeColor: '#5b21b6',
    description: 'GetirYemek Restoran Getirsin sipariş düşürme ve durum senkronizasyonu'
  },
  trendyolgo: {
    id: 'trendyolgo',
    name: 'Trendyol GO',
    category: 'marketplace',
    badgeColor: '#f97316',
    description: 'Trendyol Yemek / GO hızlı restoran kurye sipariş entegrasyonu'
  },
  migrosyemek: {
    id: 'migrosyemek',
    name: 'Migros Yemek',
    category: 'marketplace',
    badgeColor: '#ea580c',
    description: 'Migros Yemek mağaza/restoran kurye bildirim entegrasyonu'
  },
  tiklagelsin: {
    id: 'tiklagelsin',
    name: 'Tıkla Gelsin',
    category: 'marketplace',
    badgeColor: '#dc2626',
    description: 'Tıkla Gelsin zincir ve yerel şube sipariş entegrasyonu'
  },
  adisyo: {
    id: 'adisyo',
    name: 'Adisyo POS',
    category: 'pos',
    badgeColor: '#0284c7',
    description: 'Adisyo bulut adisyon & mutfak fişi otomatik kurye çağrı entegrasyonu'
  },
  sambapos: {
    id: 'sambapos',
    name: 'SambaPOS',
    category: 'pos',
    badgeColor: '#059669',
    description: 'SambaPOS yerel adisyon, Caller ID ve 80mm termal fiş kancası'
  },
  sepettakip: {
    id: 'sepettakip',
    name: 'SepetTakip',
    category: 'aggregator',
    badgeColor: '#0d9488',
    description: 'Çoklu pazaryeri sipariş toplayıcı ve otomatik kurye atama köprüsü'
  },
  whatsapp: {
    id: 'whatsapp',
    name: 'WhatsApp Sipariş Hattı',
    category: 'messaging',
    badgeColor: '#16a34a',
    description: 'WhatsApp konum ve mesajdan tek tıkla kurye paketi oluşturma'
  },
  pos_agent: {
    id: 'pos_agent',
    name: 'PAKETÜS Yerel Yazıcı & POS Ajanı',
    category: 'hardware',
    badgeColor: '#4f46e5',
    description: 'Windows 7/8/10/11 yerel ESC/POS fiş yakalayıcı ve sessiz 80mm termal yazıcı ajanı'
  }
};

const EDREMIT_SIMULATION_SPOTS = [
  {
    neighborhood: 'Cumhuriyet Mah.',
    address: 'Cumhuriyet Mah. Atatürk Bulvarı No: 42 Kat: 2 Daire: 5, Edremit',
    lat: 39.5974,
    lng: 27.0261
  },
  {
    neighborhood: 'Cennetayağı Mah.',
    address: 'Cennetayağı Mah. İstasyon Cad. Mimoza Apt. No: 18 D: 4, Edremit',
    lat: 39.5921,
    lng: 27.0189
  },
  {
    neighborhood: 'Gazicelal Mah.',
    address: 'Gazicelal Mah. 412. Sokak Zeytin Sitesi B Blok Daire: 7, Edremit',
    lat: 39.5992,
    lng: 27.0218
  },
  {
    neighborhood: 'Soğanyemez Mah.',
    address: 'Soğanyemez Mah. Yılmaz Akpınar Blv. No: 64 Kat: 3 D: 9, Edremit',
    lat: 39.5948,
    lng: 27.0235
  },
  {
    neighborhood: 'İbrahimce Mah.',
    address: 'İbrahimce Mah. Çayiçi Cad. No: 27 Kat: 1, Edremit',
    lat: 39.5985,
    lng: 27.0312
  },
  {
    neighborhood: 'Tuzcumurat Mah.',
    address: 'Tuzcumurat Mah. Menderes Bulvarı No: 85 Daire: 2, Edremit',
    lat: 39.5936,
    lng: 27.0278
  },
  {
    neighborhood: 'Camivasat Mah.',
    address: 'Camivasat Mah. Kurşunlu Cad. No: 11 Kat: 2, Edremit',
    lat: 39.5959,
    lng: 27.0294
  },
  {
    neighborhood: 'Akçay Sarıkız Mah.',
    address: 'Akçay Sarıkız Mah. Kordon Boyu Cad. No: 54 D: 3, Edremit',
    lat: 39.5868,
    lng: 26.9355
  }
];

const SIMULATED_CUSTOMERS = [
  { name: 'Zeynep Kaya', phone: '05324102030' },
  { name: 'Mehmet Özkan', phone: '05446128890' },
  { name: 'Elif Demirci', phone: '05057894411' },
  { name: 'Serkan Çelik', phone: '05339015522' },
  { name: 'Ayşe Aydın', phone: '05423346677' },
  { name: 'Emre Yıldırım', phone: '05358871234' },
  { name: 'Selin Arslan', phone: '05542198070' },
  { name: 'Onur Şahin', phone: '05364559182' }
];

const SIMULATED_MENUS = [
  { items: '2x Zurna Hatay Dürüm, 1x Büyük Patates, 2x Yayık Ayran', amount: 420, notes: 'Sosu bol olsun, zile basmayın lütfen.' },
  { items: '1x Double Smash Burger Menü, 1x Soğan Halkası (8\'li), 1x Cola Zero', amount: 485, notes: 'Kapıda temassız POS cihazı rica ediyorum.' },
  { items: '2x Karışık İzmir Kumru, 1x Sıcak Çıtır Tavuk, 2x Şalgam', amount: 390, notes: 'Turşu ekstra olsun.' },
  { items: '1.5 Porsiyon Kıymalı Kaşarlı Pide, 3x Fındık Lahmacun, 1x Künefe', amount: 560, notes: 'Sıcak gelirse çok sevinirim.' },
  { items: '3x Antakya Usulü Tavuk Döner Dürüm, 3x Ayran, 1x Sütlaç', amount: 495, notes: 'Apartman giriş şifresi #1453' },
  { items: '2x 치즈/Cheddarlı Burger Menü, 1x Trüflü Patates, 2x İce Tea Şeftali', amount: 610, notes: 'Ketçap ve mayonez unutulmasın.' }
];

let simulationCounter = 1;

/**
 * Tek tık simülasyon için gerçekçi Türkiye/Edremit siparişi üretir.
 */
function buildSimulatedOrder(platform, overrides = {}) {
  const seq = simulationCounter++;
  const spot = EDREMIT_SIMULATION_SPOTS[(seq - 1) % EDREMIT_SIMULATION_SPOTS.length];
  const customer = SIMULATED_CUSTOMERS[(seq - 1) % SIMULATED_CUSTOMERS.length];
  const menu = SIMULATED_MENUS[(seq - 1) % SIMULATED_MENUS.length];

  // Gerçekçi ufak GPS sapması (yakın rota birleştirme testlerine uygun)
  const jitterLat = ((seq % 5) - 2) * 0.0006;
  const jitterLng = ((seq % 7) - 3) * 0.0006;
  const destLat = Number((spot.lat + jitterLat).toFixed(6));
  const destLng = Number((spot.lng + jitterLng).toFixed(6));

  const paymentRotation = ['card_on_delivery', 'online_paid', 'cash'];
  const defaultPayment =
    platform === 'yemeksepeti' || platform === 'getiryemek' || platform === 'trendyolgo'
      ? paymentRotation[seq % 3]
      : seq % 2 === 0
        ? 'card_on_delivery'
        : 'cash';

  const paymentMethod = overrides.paymentMethod || overrides.payment_method || defaultPayment;
  const externalId =
    overrides.externalId ||
    overrides.external_id ||
    `${platform.toUpperCase().slice(0, 3)}-${Date.now().toString().slice(-6)}-${seq}`;

  const customerName = overrides.customerName || overrides.customer_name || customer.name;
  const customerPhone = normalizeTurkishPhone(
    overrides.customerPhone || overrides.customer_phone || customer.phone
  );
  const customerAddress = overrides.customerAddress || overrides.customer_address || spot.address;
  const neighborhood = overrides.neighborhood || spot.neighborhood;
  const orderAmount = Number(overrides.orderAmount ?? overrides.order_amount ?? menu.amount);
  const itemsSummary = overrides.itemsSummary || overrides.items_summary || menu.items;
  const notes = overrides.notes ?? menu.notes;

  return {
    tenantId: overrides.tenantId || overrides.tenant_id || 1,
    tenant_id: overrides.tenantId || overrides.tenant_id || 1,
    shopId: overrides.shopId || overrides.shop_id || ((seq - 1) % 4) + 1,
    shop_id: overrides.shopId || overrides.shop_id || ((seq - 1) % 4) + 1,
    platform,
    externalSource: platform,
    external_source: platform,
    externalId,
    external_id: externalId,
    orderType: overrides.orderType || overrides.order_type || 'delivery',
    order_type: overrides.orderType || overrides.order_type || 'delivery',
    customerName,
    customer_name: customerName,
    customerPhone,
    customer_phone: customerPhone,
    customerAddress,
    customer_address: customerAddress,
    address: customerAddress,
    neighborhood,
    destLat,
    dest_lat: destLat,
    destLng,
    dest_lng: destLng,
    orderAmount,
    order_amount: orderAmount,
    amount: orderAmount,
    paymentMethod,
    payment_method: paymentMethod,
    itemsSummary,
    items_summary: itemsSummary,
    notes
  };
}

/**
 * Dış pazaryeri veya POS webhook verisini ortak PAKETÜS sipariş şemasına dönüştürür.
 */
function normalizeWebhookPayload(platform, body = {}, reqUser = null) {
  // Eğer ham fiş metni gönderildiyse önce ayrıştır
  const rawReceipt = body.rawText || body.receiptText || body.raw_receipt || '';
  const parsedReceipt = rawReceipt ? parseReceiptText(rawReceipt) : null;

  const tenantId = Number(body.tenantId || body.tenant_id || reqUser?.tenantId || 1);
  const shopId = Number(body.shopId || body.shop_id || reqUser?.shopId || 1);

  const externalId = String(
    body.externalId ||
      body.external_id ||
      body.orderId ||
      body.order_id ||
      body.platformOrderId ||
      body.code ||
      `${platform.toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
  );

  const customerObj = body.customer || body.client || body.deliveryAddress || {};
  const customerName =
    body.customerName ||
    body.customer_name ||
    customerObj.name ||
    customerObj.fullName ||
    parsedReceipt?.customerName ||
    'Pazaryeri Müşterisi';

  const customerPhone = normalizeTurkishPhone(
    body.customerPhone ||
      body.customer_phone ||
      customerObj.phone ||
      customerObj.phoneNumber ||
      body.phone ||
      parsedReceipt?.customerPhone ||
      '05320000000'
  );

  const customerAddress =
    body.customerAddress ||
    body.customer_address ||
    body.address ||
    customerObj.address ||
    customerObj.fullAddress ||
    parsedReceipt?.address ||
    'Cumhuriyet Mah. Atatürk Blv. No:10 Edremit';

  const neighborhood =
    body.neighborhood ||
    customerObj.neighborhood ||
    customerObj.district ||
    parsedReceipt?.neighborhood ||
    'Cumhuriyet Mah.';

  const rawLat = body.destLat ?? body.dest_lat ?? body.lat ?? customerObj.lat ?? customerObj.latitude;
  const rawLng = body.destLng ?? body.dest_lng ?? body.lng ?? customerObj.lng ?? customerObj.longitude;
  const destLat = rawLat != null && rawLat !== '' ? Number(rawLat) : 39.5965;
  const destLng = rawLng != null && rawLng !== '' ? Number(rawLng) : 27.0250;

  let orderAmount = 0;
  const rawAmount =
    body.orderAmount ??
    body.order_amount ??
    body.amount ??
    body.totalAmount ??
    body.totalPrice ??
    body.total;
  if (rawAmount != null && rawAmount !== '') {
    orderAmount = parseTurkishCurrency(rawAmount);
  } else if (parsedReceipt?.amount) {
    orderAmount = parsedReceipt.amount;
  } else {
    orderAmount = 350;
  }

  // Ödeme yöntemi normalizasyonu
  let paymentMethod =
    body.paymentMethod || body.payment_method || body.paymentType || parsedReceipt?.paymentMethod || 'cash';
  const pmLower = String(paymentMethod).toLowerCase();
  if (
    pmLower === 'card_on_delivery' ||
    pmLower.includes('pos') ||
    pmLower.includes('kapida_kart') ||
    pmLower.includes('credit_card_on_delivery') ||
    pmLower === 'card'
  ) {
    paymentMethod = 'card_on_delivery';
  } else if (
    pmLower === 'online_paid' ||
    pmLower === 'online' ||
    pmLower.includes('prepaid')
  ) {
    paymentMethod = 'online_paid';
  } else if (pmLower === 'cash' || pmLower.includes('nakit')) {
    paymentMethod = 'cash';
  } else {
    paymentMethod = parsedReceipt?.paymentMethod || 'cash';
  }

  // Sipariş tipi normalizasyonu
  let orderType = body.orderType || body.order_type || parsedReceipt?.orderType || 'delivery';
  if (!['delivery', 'takeaway', 'dine_in'].includes(orderType)) {
    orderType = 'delivery';
  }

  // Ürün özeti
  let itemsSummary = body.itemsSummary || body.items_summary || '';
  if (!itemsSummary && Array.isArray(body.items)) {
    itemsSummary = body.items
      .map((item) => {
        if (typeof item === 'string') return item;
        const qty = item.quantity || item.qty || 1;
        const name = item.name || item.title || 'Ürün';
        return `${qty}x ${name}`;
      })
      .join(', ');
  }
  if (!itemsSummary) {
    itemsSummary = parsedReceipt?.itemsSummary || '1x Pazaryeri Paket Siparişi';
  }

  const notes = body.notes || body.note || body.customerNote || parsedReceipt?.notes || '';

  return {
    tenantId,
    tenant_id: tenantId,
    shopId,
    shop_id: shopId,
    platform,
    externalSource: platform,
    external_source: platform,
    externalId,
    external_id: externalId,
    orderType,
    order_type: orderType,
    customerName,
    customer_name: customerName,
    customerPhone,
    customer_phone: customerPhone,
    customerAddress,
    customer_address: customerAddress,
    address: customerAddress,
    neighborhood,
    destLat,
    dest_lat: destLat,
    destLng,
    dest_lng: destLng,
    orderAmount,
    order_amount: orderAmount,
    amount: orderAmount,
    paymentMethod,
    payment_method: paymentMethod,
    itemsSummary,
    items_summary: itemsSummary,
    notes
  };
}

/**
 * Pazaryeri, POS, Termal Fiş ve Simülasyon yönlendiricisini oluşturur.
 * @param {{
 *   ingestExternalOrder?: Function,
 *   lookupCallerId?: Function,
 *   getReceiptOrder?: Function,
 *   logWebhook?: Function
 * }} deps
 */
function createIntegrationsRouter(deps = {}) {
  const router = express.Router();
  const seenExternalOrders = new Map();

  const ingestExternalOrder =
    typeof deps.ingestExternalOrder === 'function' ? deps.ingestExternalOrder : null;
  const lookupCallerId =
    typeof deps.lookupCallerId === 'function' ? deps.lookupCallerId : null;
  const getReceiptOrder =
    typeof deps.getReceiptOrder === 'function' ? deps.getReceiptOrder : null;
  const logWebhook =
    typeof deps.logWebhook === 'function' ? deps.logWebhook : null;

  // 1. GET /api/integrations/platforms
  router.get('/platforms', (_req, res) => {
    const platforms = SUPPORTED_PLATFORMS.map((key) => {
      const meta = PLATFORM_METADATA[key] || {
        id: key,
        name: key.toUpperCase(),
        category: 'other',
        badgeColor: '#0f172a',
        description: `${key} entegrasyon kanalı`
      };
      return {
        ...meta,
        key,
        status: 'active',
        webhookEndpoint: `/api/integrations/webhook/${key}`,
        simulateEndpoint: `/api/integrations/simulate/${key}`,
        samplePayload: {
          externalId: `${key.toUpperCase().slice(0, 3)}-9001`,
          shopId: 1,
          customerName: 'Ahmet Kaya',
          customerPhone: '05321002030',
          customerAddress: 'Cumhuriyet Mah. Atatürk Blv. No: 42 D: 5 Edremit',
          neighborhood: 'Cumhuriyet Mah.',
          orderAmount: 450.0,
          paymentMethod: 'card_on_delivery',
          itemsSummary: '2x Hatay Dürüm, 2x Ayran',
          notes: 'Kapıda POS cihazı gelsin lütfen.'
        }
      };
    });

    res.json({
      ok: true,
      supportedPlatforms: SUPPORTED_PLATFORMS,
      platforms
    });
  });

  // 2. POST /api/integrations/parse-receipt
  router.post('/parse-receipt', async (req, res) => {
    try {
      const rawText =
        req.body?.rawText ?? req.body?.text ?? req.body?.receipt ?? '';
      if (!rawText || typeof rawText !== 'string') {
        return res.status(400).json({
          ok: false,
          error: 'Ayrıştırılacak fiş metni (rawText) gönderilmedi.'
        });
      }

      const parsed = parseReceiptText(rawText);
      let callerMatch = null;
      if (lookupCallerId && parsed.customerPhone) {
        try {
          callerMatch = await lookupCallerId(
            parsed.customerPhone,
            req.user?.tenantId || req.body?.tenantId || 1
          );
        } catch (_) {
          callerMatch = null;
        }
      }

      return res.json({
        ok: true,
        parsed,
        ...parsed,
        callerMatch
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err.message || 'Fiş ayrıştırma hatası.'
      });
    }
  });

  // 3. POST /api/integrations/webhook/:platform
  router.post('/webhook/:platform', async (req, res) => {
    try {
      const platform = String(req.params.platform || '')
        .trim()
        .toLowerCase();

      if (!SUPPORTED_PLATFORMS.includes(platform)) {
        return res.status(400).json({
          ok: false,
          error: `Desteklenmeyen entegrasyon platformu: ${platform}`,
          supportedPlatforms: SUPPORTED_PLATFORMS
        });
      }

      const normalized = normalizeWebhookPayload(platform, req.body || {}, req.user);
      const dedupKey = `${normalized.tenantId}:${platform}:${normalized.externalId}`;

      if (seenExternalOrders.has(dedupKey)) {
        const existingOrder = seenExternalOrders.get(dedupKey);
        return res.status(200).json({
          ok: true,
          duplicate: true,
          platform,
          externalId: normalized.externalId,
          order: existingOrder
        });
      }

      let result = null;
      if (ingestExternalOrder) {
        result = await ingestExternalOrder(normalized, req);
      } else {
        result = {
          id: Date.now(),
          tracking_code: `PKT-${Date.now().toString().slice(-6)}`,
          status: 'pending',
          ...normalized
        };
      }

      const orderObj = result?.order || result;
      const isDuplicate = Boolean(result?.duplicate);
      if (orderObj && normalized.externalId) {
        seenExternalOrders.set(dedupKey, orderObj);
      }

      if (logWebhook) {
        try {
          await logWebhook({
            tenantId: normalized.tenantId,
            platform,
            externalId: normalized.externalId,
            status: isDuplicate ? 'duplicate' : 'ingested',
            summary: `${normalized.customerName} - ${normalized.neighborhood} (${normalized.orderAmount} TL)`
          });
        } catch (_) {
          // webhook log hatası ana akışı durdurmaz
        }
      }

      return res.status(isDuplicate ? 200 : 201).json({
        ok: true,
        duplicate: isDuplicate,
        platform,
        externalId: normalized.externalId,
        order: orderObj
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err.message || 'Webhook işleme hatası.'
      });
    }
  });

  // 4. POST /api/integrations/simulate/:platform
  router.post('/simulate/:platform', async (req, res) => {
    try {
      const platform = String(req.params.platform || '')
        .trim()
        .toLowerCase();

      if (!SUPPORTED_PLATFORMS.includes(platform)) {
        return res.status(400).json({
          ok: false,
          error: `Desteklenmeyen simülasyon kanalı: ${platform}`,
          supportedPlatforms: SUPPORTED_PLATFORMS
        });
      }

      const overrides = {
        ...(req.body || {}),
        tenantId: req.body?.tenantId || req.body?.tenant_id || req.user?.tenantId || 1,
        shopId: req.body?.shopId || req.body?.shop_id || req.user?.shopId || undefined
      };

      const simulatedPayload = buildSimulatedOrder(platform, overrides);

      let result = null;
      if (ingestExternalOrder) {
        result = await ingestExternalOrder(simulatedPayload, req);
      } else {
        result = {
          id: Date.now(),
          tracking_code: `PKT-${Date.now().toString().slice(-6)}`,
          status: 'pending',
          ...simulatedPayload
        };
      }

      const orderObj = result?.order || result;

      if (logWebhook) {
        try {
          await logWebhook({
            tenantId: simulatedPayload.tenantId,
            platform,
            externalId: simulatedPayload.externalId,
            status: 'simulated',
            summary: `[SİMÜLASYON] ${simulatedPayload.customerName} - ${simulatedPayload.neighborhood} (${simulatedPayload.orderAmount} TL)`
          });
        } catch (_) {
          // ignore logging error
        }
      }

      return res.status(201).json({
        ok: true,
        simulated: true,
        platform,
        externalId: simulatedPayload.externalId,
        order: orderObj,
        payload: simulatedPayload
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err.message || 'Simülasyon siparişi oluşturulamadı.'
      });
    }
  });

  // 5. GET /api/integrations/receipt/:orderId/html
  router.get('/receipt/:orderId/html', async (req, res) => {
    try {
      const orderId = req.params.orderId;
      let receiptData = null;

      if (getReceiptOrder) {
        receiptData = await getReceiptOrder(orderId, req);
      }

      if (!receiptData) {
        return res.status(404).send(
          '<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><title>Fiş Bulunamadı</title></head><body><h3>Sipariş fişi bulunamadı.</h3></body></html>'
        );
      }

      const order = receiptData.order || receiptData;
      const shop = receiptData.shop || order.shop || {};
      const tenant = receiptData.tenant || order.tenant || {};

      const html = renderThermalReceiptHtml(order, shop, tenant);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    } catch (err) {
      return res.status(500).send(
        `<!DOCTYPE html><html lang="tr"><body><h3>Fiş oluşturma hatası: ${String(err.message || err)}</h3></body></html>`
      );
    }
  });

  return router;
}

module.exports = {
  createIntegrationsRouter,
  SUPPORTED_PLATFORMS,
  PLATFORM_METADATA,
  normalizeWebhookPayload,
  buildSimulatedOrder
};
