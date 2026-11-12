'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const {
  createDatabase,
  normalizePhone,
  hashPassword,
  verifyPassword,
} = require('./src/db');
const {
  estimateRoadKm,
  calculateOrderPricing,
  buildSmartBatches,
  chooseBestCourierForBatch,
} = require('./src/dispatch-engine');

const PUBLIC_DIR = path.join(__dirname, 'public');
const TOKEN_SECRET =
  process.env.PAKETUS_SECRET || 'paketus-kurumsal-hmac-key-2026-edremit-v1';

const TURKISH_CITY_CENTERS = {
  edremit: [39.5961, 27.0244],
  ayvalik: [39.3191, 26.6961],
  balikesir: [39.6484, 27.8826],
  izmir: [38.4237, 27.1428],
  istanbul: [41.0082, 28.9784],
  ankara: [39.9334, 32.8597],
  bursa: [40.1885, 29.0610],
  antalya: [36.8969, 30.7133],
  canakkale: [40.1553, 26.4142],
  manisa: [38.6191, 27.4289],
  aydin: [37.8380, 27.8456],
  mugla: [37.2153, 28.3636],
  adana: [37.0000, 35.3213],
  konya: [37.8746, 32.4932],
  gaziantep: [37.0662, 37.3833],
};

function slugifyTurkish(input) {
  const map = {
    ç: 'c',
    Ç: 'c',
    ğ: 'g',
    Ğ: 'g',
    ı: 'i',
    İ: 'i',
    I: 'i',
    ö: 'o',
    Ö: 'o',
    ş: 's',
    Ş: 's',
    ü: 'u',
    Ü: 'u',
  };
  return String(input || '')
    .replace(/[çÇğĞıİIöÖşŞüÜ]/g, (ch) => map[ch] || ch)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function resolveCityCoordinates(cityText) {
  const slug = slugifyTurkish(cityText || '');
  for (const [key, coords] of Object.entries(TURKISH_CITY_CENTERS)) {
    if (slug.includes(key)) return coords;
  }
  return [39.5961, 27.0244];
}

function round2(n) {
  const val = Number(n);
  if (!Number.isFinite(val)) return 0;
  return Math.round(val * 100) / 100;
}

function signAuthToken(payload) {
  const data = {
    ...payload,
    iat: Date.now(),
  };
  const encoded = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expected = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(encoded)
    .digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function extractRequestToken(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req.query?.token && typeof req.query.token === 'string') {
    return req.query.token.trim();
  }
  return '';
}

function serializeTenant(row) {
  if (!row) return null;
  return {
    ...row,
    centerLat: row.center_lat,
    centerLng: row.center_lng,
    creditsBalance: row.credits_balance,
    creditsEnabled: Boolean(row.credits_enabled),
    createdAt: row.created_at,
  };
}

function serializeShop(row, groupNameMap = null) {
  if (!row) return null;
  const groupName =
    row.group_name ?? (row.group_id && groupNameMap ? groupNameMap.get(row.group_id) || null : null);
  return {
    ...row,
    tenantId: row.tenant_id,
    groupId: row.group_id,
    groupName,
    group_name: groupName,
    brandTag: row.brand_tag,
    tariffMode: row.tariff_mode,
    baseFee: row.base_fee,
    perKmFee: row.per_km_fee,
    commissionPct: row.commission_pct,
    autoPrint: Boolean(row.auto_print),
    createdAt: row.created_at,
  };
}

function serializeZone(row) {
  if (!row) return null;
  return {
    ...row,
    tenantId: row.tenant_id,
    minKm: row.min_km,
    maxKm: row.max_km,
    shopFee: row.shop_fee,
    courierFee: row.courier_fee,
  };
}

/**
 * KRİTİK GÜVENLİK: maskGps === true (merchant) olduğunda lat ve lng KESİNLİKLE null döner!
 */
function serializeCourier(row, { maskGps = false, activeCount = 0, extraStats = null } = {}) {
  if (!row) return null;
  const safeLat = maskGps ? null : row.lat ?? null;
  const safeLng = maskGps ? null : row.lng ?? null;

  const out = {
    ...row,
    lat: safeLat,
    lng: safeLng,
    tenantId: row.tenant_id,
    vehicleType: row.vehicle_type,
    isOnline: Number(row.is_online) === 1,
    onBreak: Number(row.on_break) === 1,
    hasPos: Number(row.has_pos) === 1,
    batteryPct: row.battery_pct,
    battery: row.battery_pct,
    maxBatch: row.max_batch,
    perPackageFee: row.per_package_fee,
    perKmBonus: row.per_km_bonus,
    active_orders_count: activeCount,
    activeOrdersCount: activeCount,
    active_count: activeCount,
    updatedAt: row.updated_at,
  };

  if (extraStats && typeof extraStats === 'object') {
    Object.assign(out, extraStats);
  }

  return out;
}

function serializeOrder(row, { shopMap = null, courierMap = null, maskCourierGps = false } = {}) {
  if (!row) return null;
  const shop = row.shop_id && shopMap ? shopMap.get(row.shop_id) : null;
  const courier = row.courier_id && courierMap ? courierMap.get(row.courier_id) : null;

  const shopName = row.shop_name ?? shop?.name ?? '';
  const shopBrandTag = row.shop_brand_tag ?? shop?.brand_tag ?? '';
  const shopAddress = row.shop_address ?? shop?.address ?? '';
  const shopPhone = row.shop_phone ?? shop?.phone ?? '';
  const shopLat = row.shop_lat ?? shop?.lat ?? null;
  const shopLng = row.shop_lng ?? shop?.lng ?? null;

  const courierName = row.courier_name ?? courier?.name ?? null;
  const courierPhone = row.courier_phone ?? courier?.phone ?? null;
  const courierVehicle = row.courier_vehicle ?? courier?.vehicle_type ?? null;
  const courierHasPos = courier ? Number(courier.has_pos) : null;

  const out = {
    ...row,
    tenantId: row.tenant_id,
    shopId: row.shop_id,
    courierId: row.courier_id,
    batchId: row.batch_id,
    routeSeq: row.route_seq,
    trackingCode: row.tracking_code,
    externalSource: row.external_source,
    externalId: row.external_id,
    orderType: row.order_type,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerAddress: row.customer_address,
    destLat: row.dest_lat,
    destLng: row.dest_lng,
    distanceKm: row.distance_km,
    orderAmount: row.order_amount,
    amount: row.order_amount,
    deliveryFee: row.delivery_fee,
    courierEarning: row.courier_earning,
    paymentMethod: row.payment_method,
    itemsSummary: row.items_summary,
    deliveryPin: row.delivery_pin,
    creditConsumed: row.credit_consumed,
    creditRefunded: row.credit_refunded,
    createdAt: row.created_at,
    assignedAt: row.assigned_at,
    pickedUpAt: row.picked_up_at,
    deliveredAt: row.delivered_at,
    shop_name: shopName,
    shopName,
    shop_brand_tag: shopBrandTag,
    shopBrandTag,
    shop_address: shopAddress,
    shopAddress,
    shop_phone: shopPhone,
    shopPhone,
    shop_lat: shopLat,
    shopLat,
    shop_lng: shopLng,
    shopLng,
    courier_name: courierName,
    courierName,
    courier_phone: maskCourierGps ? null : courierPhone,
    courierPhone: maskCourierGps ? null : courierPhone,
    courier_vehicle: courierVehicle,
    courierVehicle,
    courier_has_pos: courierHasPos,
    courierHasPos,
  };

  if (maskCourierGps) {
    out.courier_lat = null;
    out.courier_lng = null;
    out.courierLat = null;
    out.courierLng = null;
  } else {
    out.courier_lat = courier?.lat ?? null;
    out.courier_lng = courier?.lng ?? null;
    out.courierLat = courier?.lat ?? null;
    out.courierLng = courier?.lng ?? null;
  }

  return out;
}

function serializeCustomer(row) {
  if (!row) return null;
  return {
    ...row,
    tenantId: row.tenant_id,
    lastAddress: row.last_address,
    preferredPayment: row.preferred_payment,
    orderCount: row.order_count,
    updatedAt: row.updated_at,
  };
}

function serializeRadio(row) {
  if (!row) return null;
  return {
    ...row,
    tenantId: row.tenant_id,
    senderRole: row.sender_role,
    senderName: row.sender_name,
    textNote: row.text_note,
    audioDataUrl: row.audio_data_url,
    durationSec: row.duration_sec,
    createdAt: row.created_at,
  };
}

function serializeOrderMessage(row) {
  if (!row) return null;
  return {
    ...row,
    tenantId: row.tenant_id,
    orderId: row.order_id,
    senderRole: row.sender_role,
    senderName: row.sender_name,
    createdAt: row.created_at,
  };
}

function serializeCreditEntry(row) {
  if (!row) return null;
  return {
    ...row,
    tenantId: row.tenant_id,
    balanceAfter: row.balance_after,
    orderId: row.order_id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

function serializePrintJob(row) {
  if (!row) return null;
  return {
    ...row,
    tenantId: row.tenant_id,
    shopId: row.shop_id,
    orderId: row.order_id,
    createdAt: row.created_at,
    printedAt: row.printed_at,
  };
}

function serializeWebhookLog(row) {
  if (!row) return null;
  return {
    ...row,
    tenantId: row.tenant_id,
    externalId: row.external_id,
    createdAt: row.created_at,
  };
}

function computeAvgDeliveryMinutes(deliveredOrders) {
  if (!Array.isArray(deliveredOrders) || deliveredOrders.length === 0) {
    return 14.2;
  }
  const durations = [];
  for (const o of deliveredOrders) {
    if (o.created_at && o.delivered_at) {
      const ms = Date.parse(o.delivered_at) - Date.parse(o.created_at);
      if (Number.isFinite(ms) && ms > 0 && ms < 180 * 60 * 1000) {
        durations.push(ms / 60000);
      }
    }
  }
  if (durations.length === 0) return 14.2;
  const avg = durations.reduce((acc, v) => acc + v, 0) / durations.length;
  return Math.round(avg * 10) / 10;
}

function generateTrackingCode(tenantSlug) {
  const prefix = String(tenantSlug || 'PKT')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 4) || 'PKT';
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `PKT-${prefix}-${rand}`;
}

function generateDeliveryPin() {
  return String(1000 + crypto.randomInt(9000));
}

function createApp(options = {}) {
  const db =
    options.db ||
    createDatabase(options.dbPath || process.env.DB_PATH || null, {
      seedDemo: options.seedDemo !== false,
    });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '512kb' }));

  // Tenant bazlı SSE istemci havuzu
  const sseClients = new Set();

  const keepAliveTimer = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.res.write(': keepalive\n\n');
      } catch (_) {
        sseClients.delete(client);
      }
    }
  }, 20000);
  if (typeof keepAliveTimer.unref === 'function') {
    keepAliveTimer.unref();
  }

  function resolveUserContextFromToken(token) {
    const decoded = verifyAuthToken(token);
    if (!decoded || !decoded.userId || !decoded.tenantId) return null;

    const userRow = db.get(
      'SELECT * FROM users WHERE id = ? AND tenant_id = ?',
      decoded.userId,
      decoded.tenantId
    );
    if (!userRow) return null;

    const tenantRow = db.get('SELECT * FROM tenants WHERE id = ?', userRow.tenant_id);
    if (!tenantRow) return null;

    return {
      id: userRow.id,
      userId: userRow.id,
      role: userRow.role,
      phone: userRow.phone,
      displayName: userRow.display_name,
      display_name: userRow.display_name,
      tenantId: tenantRow.id,
      tenant_id: tenantRow.id,
      tenantSlug: tenantRow.slug,
      tenant_slug: tenantRow.slug,
      tenantName: tenantRow.name,
      tenant_name: tenantRow.name,
      merchantGroupId: userRow.merchant_group_id,
      merchant_group_id: userRow.merchant_group_id,
      shopId: userRow.shop_id,
      shop_id: userRow.shop_id,
      courierId: userRow.courier_id,
      courier_id: userRow.courier_id,
      mustChangePassword: Boolean(userRow.must_change_password),
    };
  }

  function getMerchantAllowedShopIds(userCtx) {
    if (!userCtx || userCtx.role !== 'merchant') return [];
    if (userCtx.merchantGroupId) {
      const rows = db.all(
        'SELECT id FROM shops WHERE tenant_id = ? AND group_id = ? ORDER BY id ASC',
        userCtx.tenantId,
        userCtx.merchantGroupId
      );
      if (rows.length > 0) return rows.map((r) => r.id);
    }
    if (userCtx.shopId) {
      return [userCtx.shopId];
    }
    return [];
  }

  function getActiveLoadByCourierMap(tenantId) {
    const rows = db.all(
      `SELECT courier_id, COUNT(*) AS cnt
       FROM orders
       WHERE tenant_id = ? AND courier_id IS NOT NULL AND status IN ('assigned', 'picked_up')
       GROUP BY courier_id`,
      tenantId
    );
    const map = new Map();
    for (const r of rows) {
      map.set(r.courier_id, Number(r.cnt || 0));
    }
    return map;
  }

  function buildBatchesPreviewForTenant(tenantId, rawShops = null, rawCouriers = null) {
    const shops = rawShops || db.all('SELECT * FROM shops WHERE tenant_id = ? ORDER BY id ASC', tenantId);
    const shopMap = new Map(shops.map((s) => [s.id, s]));
    const couriers =
      rawCouriers || db.all('SELECT * FROM couriers WHERE tenant_id = ? ORDER BY id ASC', tenantId);
    const activeLoadMap = getActiveLoadByCourierMap(tenantId);

    const pendingRows = db.all(
      `SELECT * FROM orders
       WHERE tenant_id = ? AND status = 'pending' AND order_type = 'delivery'
       ORDER BY created_at ASC, id ASC`,
      tenantId
    );
    const enrichedPending = pendingRows.map((o) =>
      serializeOrder(o, { shopMap, maskCourierGps: false })
    );

    const batches = buildSmartBatches(enrichedPending, shops);
    const simulatedLoad = new Map(activeLoadMap);

    return batches.map((batch) => {
      const recommended = chooseBestCourierForBatch(batch, couriers, simulatedLoad);
      if (recommended) {
        simulatedLoad.set(
          recommended.id,
          (simulatedLoad.get(recommended.id) || 0) + batch.orders.length
        );
      }
      return {
        ...batch,
        recommendedCourier: recommended
          ? {
              id: recommended.id,
              name: recommended.name,
              vehicleType: recommended.vehicle_type,
              hasPos: Number(recommended.has_pos) === 1,
              batteryPct: recommended.battery_pct,
              dispatchScore: recommended.dispatchScore,
              pickupDistanceKm: recommended.pickupDistanceKm,
            }
          : null,
      };
    });
  }

  function buildBootstrapPayload(userCtx) {
    const tenantRow = db.get('SELECT * FROM tenants WHERE id = ?', userCtx.tenantId);
    const tenant = serializeTenant(tenantRow);

    const groupRows = db.all(
      'SELECT * FROM merchant_groups WHERE tenant_id = ? ORDER BY id ASC',
      userCtx.tenantId
    );
    const groupNameMap = new Map(groupRows.map((g) => [g.id, g.name]));

    const allShopRows = db.all(
      'SELECT * FROM shops WHERE tenant_id = ? ORDER BY id ASC',
      userCtx.tenantId
    );
    const shopMap = new Map(allShopRows.map((s) => [s.id, s]));

    const allCourierRows = db.all(
      'SELECT * FROM couriers WHERE tenant_id = ? ORDER BY id ASC',
      userCtx.tenantId
    );
    const courierMap = new Map(allCourierRows.map((c) => [c.id, c]));
    const activeLoadMap = getActiveLoadByCourierMap(userCtx.tenantId);

    const radioRows = db.all(
      'SELECT * FROM radio_transmissions WHERE tenant_id = ? ORDER BY id DESC LIMIT 25',
      userCtx.tenantId
    );
    const radioTransmissions = radioRows.map(serializeRadio);

    if (userCtx.role === 'admin') {
      const zoneRows = db.all(
        'SELECT * FROM zones WHERE tenant_id = ? ORDER BY min_km ASC, id ASC',
        userCtx.tenantId
      );
      const orderRows = db.all(
        'SELECT * FROM orders WHERE tenant_id = ? ORDER BY id DESC LIMIT 250',
        userCtx.tenantId
      );
      const ledgerRows = db.all(
        'SELECT * FROM credit_ledger WHERE tenant_id = ? ORDER BY id DESC LIMIT 60',
        userCtx.tenantId
      );
      const webhookRows = db.all(
        'SELECT * FROM webhook_logs WHERE tenant_id = ? ORDER BY id DESC LIMIT 40',
        userCtx.tenantId
      );
      const printRows = db.all(
        'SELECT * FROM print_jobs WHERE tenant_id = ? ORDER BY id DESC LIMIT 40',
        userCtx.tenantId
      );

      const shops = allShopRows.map((s) => serializeShop(s, groupNameMap));
      const couriers = allCourierRows.map((c) =>
        serializeCourier(c, {
          maskGps: false,
          activeCount: activeLoadMap.get(c.id) || 0,
        })
      );
      const orders = orderRows.map((o) =>
        serializeOrder(o, { shopMap, courierMap, maskCourierGps: false })
      );

      const pendingPoolCount = orderRows.filter((o) => o.status === 'pending').length;
      const pendingCreditCount = orderRows.filter((o) => o.status === 'pending_credit').length;
      const activeOrders = orderRows.filter((o) =>
        ['assigned', 'picked_up'].includes(o.status)
      );
      const deliveredOrders = orderRows.filter((o) => o.status === 'delivered');
      const activeBatchSet = new Set(
        activeOrders.map((o) => o.batch_id || `single-${o.id}`)
      );

      const nonCancelled = orderRows.filter((o) => o.status !== 'cancelled');
      const dailyGrossVolume = round2(
        nonCancelled.reduce((sum, o) => sum + Number(o.order_amount || 0), 0)
      );
      const dailyDeliveryRevenue = round2(
        deliveredOrders.reduce((sum, o) => sum + Number(o.delivery_fee || 0), 0)
      );
      const dailyCourierPayout = round2(
        deliveredOrders.reduce((sum, o) => sum + Number(o.courier_earning || 0), 0)
      );
      const dailyNetProfit = round2(dailyDeliveryRevenue - dailyCourierPayout);

      const onlineCouriersCount = allCourierRows.filter(
        (c) => Number(c.is_online) === 1 && Number(c.on_break) === 0
      ).length;
      const posOnlineCouriersCount = allCourierRows.filter(
        (c) =>
          Number(c.is_online) === 1 &&
          Number(c.on_break) === 0 &&
          Number(c.has_pos) === 1
      ).length;

      const batchesPreview = buildBatchesPreviewForTenant(
        userCtx.tenantId,
        allShopRows,
        allCourierRows
      );

      return {
        ok: true,
        role: 'admin',
        user: userCtx,
        tenant,
        stats: {
          pendingPoolCount,
          pendingCount: pendingPoolCount,
          pendingCreditCount,
          activeOrdersCount: activeOrders.length,
          activeBatchesCount: activeBatchSet.size,
          deliveredTodayCount: deliveredOrders.length,
          onlineCouriersCount,
          posOnlineCouriersCount,
          totalCouriersCount: allCourierRows.length,
          creditsBalance: tenant.credits_balance,
          dailyGrossVolume,
          dailyDeliveryRevenue,
          dailyCourierPayout,
          dailyNetProfit,
          avgDeliveryMinutes: computeAvgDeliveryMinutes(deliveredOrders),
        },
        shops,
        merchantGroups: groupRows,
        zones: zoneRows.map(serializeZone),
        couriers,
        orders,
        batchesPreview,
        radioTransmissions,
        creditLedger: ledgerRows.map(serializeCreditEntry),
        webhookLogs: webhookRows.map(serializeWebhookLog),
        printJobs: printRows.map(serializePrintJob),
      };
    }

    if (userCtx.role === 'merchant') {
      const allowedShopIds = getMerchantAllowedShopIds(userCtx);
      const merchantShops = allShopRows
        .filter((s) => allowedShopIds.includes(s.id))
        .map((s) => serializeShop(s, groupNameMap));

      let merchantOrderRows = [];
      let printRows = [];
      if (allowedShopIds.length > 0) {
        const placeholders = allowedShopIds.map(() => '?').join(', ');
        merchantOrderRows = db.all(
          `SELECT * FROM orders
           WHERE tenant_id = ? AND shop_id IN (${placeholders})
           ORDER BY id DESC LIMIT 150`,
          userCtx.tenantId,
          ...allowedShopIds
        );
        printRows = db.all(
          `SELECT * FROM print_jobs
           WHERE tenant_id = ? AND shop_id IN (${placeholders})
           ORDER BY id DESC LIMIT 40`,
          userCtx.tenantId,
          ...allowedShopIds
        );
      }

      // KRİTİK KURAL: Merchant yanıtlarında kurye GPS koordinatları ASLA gönderilmez (null maskelenir)!
      const maskedCouriers = allCourierRows.map((c) =>
        serializeCourier(c, {
          maskGps: true,
          activeCount: activeLoadMap.get(c.id) || 0,
        })
      );

      const onlineCount = allCourierRows.filter(
        (c) => Number(c.is_online) === 1 && Number(c.on_break) === 0
      ).length;
      const onBreakCount = allCourierRows.filter(
        (c) => Number(c.is_online) === 1 && Number(c.on_break) === 1
      ).length;
      const posAvailableCount = allCourierRows.filter(
        (c) =>
          Number(c.is_online) === 1 &&
          Number(c.on_break) === 0 &&
          Number(c.has_pos) === 1
      ).length;

      return {
        ok: true,
        role: 'merchant',
        user: userCtx,
        tenant: {
          id: tenant.id,
          slug: tenant.slug,
          name: tenant.name,
          city: tenant.city,
          credits_enabled: tenant.credits_enabled,
          creditsEnabled: tenant.creditsEnabled,
          credits_balance: tenant.credits_balance,
          creditsBalance: tenant.creditsBalance,
        },
        shops: merchantShops,
        activeShopId: merchantShops[0]?.id || userCtx.shopId || null,
        orders: merchantOrderRows.map((o) =>
          serializeOrder(o, { shopMap, courierMap, maskCourierGps: true })
        ),
        couriersSummary: {
          totalCount: allCourierRows.length,
          onlineCount,
          availableCount: onlineCount,
          onBreakCount,
          posAvailableCount,
        },
        couriers: maskedCouriers,
        radioTransmissions,
        printJobs: printRows.map(serializePrintJob),
      };
    }

    // role === 'courier'
    const courierRow = db.get(
      'SELECT * FROM couriers WHERE id = ? AND tenant_id = ?',
      userCtx.courierId,
      userCtx.tenantId
    );
    const activeRows = db.all(
      `SELECT * FROM orders
       WHERE tenant_id = ? AND courier_id = ? AND status IN ('assigned', 'picked_up')
       ORDER BY route_seq ASC, id ASC`,
      userCtx.tenantId,
      userCtx.courierId
    );
    const deliveredRows = db.all(
      `SELECT * FROM orders
       WHERE tenant_id = ? AND courier_id = ? AND status = 'delivered'
       ORDER BY delivered_at DESC, id DESC LIMIT 30`,
      userCtx.tenantId,
      userCtx.courierId
    );

    const earningsToday = round2(
      deliveredRows.reduce((sum, o) => sum + Number(o.courier_earning || 0), 0)
    );
    const cashCollectedToday = round2(
      deliveredRows
        .filter((o) => o.payment_method === 'cash')
        .reduce((sum, o) => sum + Number(o.order_amount || 0), 0)
    );
    const posCollectedToday = round2(
      deliveredRows
        .filter((o) => o.payment_method === 'card_on_delivery')
        .reduce((sum, o) => sum + Number(o.order_amount || 0), 0)
    );
    const avgDeliveryMinutes = computeAvgDeliveryMinutes(deliveredRows);

    const serializedCourier = serializeCourier(courierRow, {
      maskGps: false,
      activeCount: activeRows.length,
      extraStats: {
        earningsToday,
        earnings_today: earningsToday,
        deliveredTodayCount: deliveredRows.length,
        delivered_today_count: deliveredRows.length,
        cashCollectedToday,
        posCollectedToday,
        avgDeliveryMinutes,
        avg_delivery_minutes: avgDeliveryMinutes,
      },
    });

    return {
      ok: true,
      role: 'courier',
      user: userCtx,
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        city: tenant.city,
        center_lat: tenant.center_lat,
        center_lng: tenant.center_lng,
        centerLat: tenant.centerLat,
        centerLng: tenant.centerLng,
      },
      courier: serializedCourier,
      activeOrders: activeRows.map((o) =>
        serializeOrder(o, { shopMap, courierMap, maskCourierGps: false })
      ),
      recentDelivered: deliveredRows.map((o) =>
        serializeOrder(o, { shopMap, courierMap, maskCourierGps: false })
      ),
      radioTransmissions,
    };
  }

  function broadcastTenantUpdate(tenantId, reason = 'state_changed', customEvent = null) {
    for (const client of sseClients) {
      if (client.userCtx.tenantId !== tenantId) continue;
      try {
        if (customEvent) {
          client.res.write(
            `event: ${customEvent.event}\ndata: ${JSON.stringify(customEvent.data)}\n\n`
          );
        }
        const snapshot = buildBootstrapPayload(client.userCtx);
        snapshot.reason = reason;
        snapshot.ts = Date.now();
        client.res.write(`event: update\ndata: ${JSON.stringify(snapshot)}\n\n`);
      } catch (_) {
        sseClients.delete(client);
      }
    }
  }

  function requireAuth(allowedRoles = null) {
    return (req, res, next) => {
      const token = extractRequestToken(req);
      if (!token) {
        return res.status(401).json({ ok: false, error: 'Oturum açmanız gerekiyor.' });
      }
      const userCtx = resolveUserContextFromToken(token);
      if (!userCtx) {
        return res.status(401).json({ ok: false, error: 'Geçersiz veya süresi dolmuş oturum.' });
      }
      if (Array.isArray(allowedRoles) && !allowedRoles.includes(userCtx.role)) {
        return res.status(403).json({ ok: false, error: 'Bu işlem için yetkiniz bulunmuyor.' });
      }
      req.user = userCtx;
      return next();
    };
  }

  function attachOptionalAuth(req, _res, next) {
    const token = extractRequestToken(req);
    if (token) {
      const userCtx = resolveUserContextFromToken(token);
      if (userCtx) req.user = userCtx;
    }
    next();
  }

  /**
   * İç Sipariş Oluşturma Çekirdeği (Hem POST /api/orders hem de /api/integrations için)
   */
  function createOrderInternal(payload = {}, actorUser = null) {
    return db.tx(() => {
      const requestedTenantId = Number(
        actorUser?.tenantId || payload.tenantId || payload.tenant_id || 1
      );
      const tenant = db.get('SELECT * FROM tenants WHERE id = ?', requestedTenantId);
      if (!tenant) {
        const err = new Error('Operasyon kiracısı (tenant) bulunamadı.');
        err.statusCode = 404;
        throw err;
      }

      let shopId = Number(payload.shopId ?? payload.shop_id ?? actorUser?.shopId ?? 0);
      if (actorUser && actorUser.role === 'merchant') {
        const allowedShopIds = getMerchantAllowedShopIds(actorUser);
        if (!shopId && allowedShopIds.length > 0) {
          shopId = allowedShopIds[0];
        }
        if (!allowedShopIds.includes(shopId)) {
          const err = new Error('Seçilen şube bu işletme hesabına ait değil.');
          err.statusCode = 403;
          throw err;
        }
      }

      let shop = shopId
        ? db.get('SELECT * FROM shops WHERE id = ? AND tenant_id = ?', shopId, tenant.id)
        : null;
      if (!shop) {
        shop = db.get('SELECT * FROM shops WHERE tenant_id = ? ORDER BY id ASC LIMIT 1', tenant.id);
      }
      if (!shop) {
        const err = new Error('Sipariş açılacak aktif işletme/şube bulunamadı.');
        err.statusCode = 400;
        throw err;
      }

      const externalSource = String(
        payload.externalSource || payload.external_source || payload.platform || 'manual'
      ).trim();
      const externalId =
        payload.externalId || payload.external_id
          ? String(payload.externalId || payload.external_id).trim()
          : null;

      // Harici sipariş idempotency kontrolü
      if (externalId && externalSource !== 'manual') {
        const existingOrder = db.get(
          `SELECT * FROM orders
           WHERE tenant_id = ? AND external_source = ? AND external_id = ?`,
          tenant.id,
          externalSource,
          externalId
        );
        if (existingOrder) {
          const shopMap = new Map([[shop.id, shop]]);
          return {
            duplicate: true,
            order: serializeOrder(existingOrder, {
              shopMap,
              maskCourierGps: actorUser?.role === 'merchant',
            }),
          };
        }
      }

      const customerName = String(
        payload.customerName || payload.customer_name || 'Misafir Müşteri'
      ).trim();
      const customerPhone = normalizePhone(payload.customerPhone || payload.customer_phone || '');
      const customerAddress = String(
        payload.customerAddress || payload.customer_address || payload.address || ''
      ).trim();
      const neighborhood = String(payload.neighborhood || '').trim();

      const rawDestLat = payload.destLat ?? payload.dest_lat;
      const rawDestLng = payload.destLng ?? payload.dest_lng;
      const destLat =
        rawDestLat !== null && rawDestLat !== undefined && rawDestLat !== ''
          ? Number(rawDestLat)
          : null;
      const destLng =
        rawDestLng !== null && rawDestLng !== undefined && rawDestLng !== ''
          ? Number(rawDestLng)
          : null;

      let orderType = String(payload.orderType || payload.order_type || 'delivery').trim();
      if (!['delivery', 'takeaway', 'dine_in'].includes(orderType)) {
        orderType = 'delivery';
      }

      let paymentMethod = String(
        payload.paymentMethod || payload.payment_method || 'cash'
      ).trim();
      if (!['cash', 'card_on_delivery', 'online_paid'].includes(paymentMethod)) {
        paymentMethod = 'cash';
      }

      const orderAmount = Math.max(
        0,
        round2(Number(payload.orderAmount ?? payload.order_amount ?? payload.amount ?? 0))
      );
      const itemsSummary = String(payload.itemsSummary || payload.items_summary || '').trim();
      const notes = String(payload.notes || '').trim();

      let distanceKm = Number(payload.distanceKm ?? payload.distance_km ?? 0);
      if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
        distanceKm = estimateRoadKm(shop.lat, shop.lng, destLat, destLng);
      }

      const zones = db.all('SELECT * FROM zones WHERE tenant_id = ?', tenant.id);
      const pricing = calculateOrderPricing({
        shop,
        zones,
        distanceKm,
        orderAmount,
        orderType,
      });

      const nowIso = new Date().toISOString();

      // Caller ID müşteri hafızası kaydı/güncellemesi
      if (customerPhone) {
        const existingCustomer = db.get(
          'SELECT * FROM customers WHERE tenant_id = ? AND phone = ?',
          tenant.id,
          customerPhone
        );
        if (existingCustomer) {
          db.run(
            `UPDATE customers
             SET name = ?,
                 last_address = CASE WHEN ? != '' THEN ? ELSE last_address END,
                 neighborhood = CASE WHEN ? != '' THEN ? ELSE neighborhood END,
                 lat = COALESCE(?, lat),
                 lng = COALESCE(?, lng),
                 preferred_payment = ?,
                 order_count = order_count + 1,
                 updated_at = ?
             WHERE id = ?`,
            customerName || existingCustomer.name,
            customerAddress,
            customerAddress,
            neighborhood,
            neighborhood,
            destLat,
            destLng,
            paymentMethod,
            nowIso,
            existingCustomer.id
          );
        } else {
          db.run(
            `INSERT INTO customers (tenant_id, phone, name, last_address, neighborhood, lat, lng, preferred_payment, order_count, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            tenant.id,
            customerPhone,
            customerName,
            customerAddress,
            neighborhood,
            destLat,
            destLng,
            paymentMethod,
            nowIso
          );
        }
      }

      // Süresiz Kontör Kontrolü: Bakiye <= 0 ise siparişi SİLME, pending_credit olarak koru!
      let status = 'pending';
      let creditConsumed = 0;
      const creditsEnabled = Number(tenant.credits_enabled) === 1;

      if (creditsEnabled) {
        if (Number(tenant.credits_balance) <= 0) {
          status = 'pending_credit';
          creditConsumed = 0;
        } else {
          status = 'pending';
          creditConsumed = 1;
        }
      }

      let trackingCode = generateTrackingCode(tenant.slug);
      while (db.get('SELECT id FROM orders WHERE tracking_code = ?', trackingCode)) {
        trackingCode = generateTrackingCode(tenant.slug);
      }

      const deliveryPin = generateDeliveryPin();

      const insertRes = db.run(
        `INSERT INTO orders (
          tenant_id, shop_id, courier_id, batch_id, route_seq, tracking_code,
          external_source, external_id, order_type, status,
          customer_name, customer_phone, customer_address, neighborhood,
          dest_lat, dest_lng, distance_km, order_amount, delivery_fee, courier_earning,
          payment_method, items_summary, notes, delivery_pin,
          credit_consumed, credit_refunded, created_at
        ) VALUES (?, ?, NULL, NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        tenant.id,
        shop.id,
        trackingCode,
        externalSource,
        externalId,
        orderType,
        status,
        customerName,
        customerPhone,
        customerAddress,
        neighborhood,
        destLat,
        destLng,
        pricing.distanceKm,
        orderAmount,
        pricing.deliveryFee,
        pricing.courierEarning,
        paymentMethod,
        itemsSummary,
        notes,
        deliveryPin,
        creditConsumed,
        nowIso
      );

      const orderId = insertRes.lastInsertRowid;

      if (creditConsumed === 1) {
        const nextBalance = Number(tenant.credits_balance) - 1;
        db.run('UPDATE tenants SET credits_balance = ? WHERE id = ?', nextBalance, tenant.id);
        db.run(
          `INSERT INTO credit_ledger (tenant_id, delta, balance_after, reason, order_id, note, idempotency_key, created_at)
           VALUES (?, -1, ?, 'order_consume', ?, ?, ?, ?)`,
          tenant.id,
          nextBalance,
          orderId,
          `Sipariş #${orderId} (${trackingCode}) kontör düşümü`,
          `consume-order-${orderId}`,
          nowIso
        );
      }

      if (status === 'pending' && Number(shop.auto_print) === 1) {
        db.run(
          `INSERT INTO print_jobs (tenant_id, shop_id, order_id, status, created_at)
           VALUES (?, ?, ?, 'queued', ?)`,
          tenant.id,
          shop.id,
          orderId,
          nowIso
        );
      }

      const createdRow = db.get('SELECT * FROM orders WHERE id = ?', orderId);
      const shopMap = new Map([[shop.id, shop]]);

      setImmediate(() => broadcastTenantUpdate(tenant.id, 'order_created'));

      return {
        duplicate: false,
        order: serializeOrder(createdRow, {
          shopMap,
          maskCourierGps: actorUser?.role === 'merchant',
        }),
      };
    });
  }

  // ============================================================================
  // AÇIK / VİTRİN UÇ NOKTALARI
  // ============================================================================

  app.get('/health', (_req, res) => {
    const row = db.get('SELECT COUNT(*) AS cnt FROM tenants');
    res.json({
      ok: true,
      app: 'PAKETÜS',
      version: '1.0.0',
      tenants: Number(row?.cnt || 0),
      ts: Date.now(),
    });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      ok: true,
      appName: 'PAKETÜS',
      tagline: 'Yeni Nesil Çok Kiracılı Kurye, POS & Akıllı Rota Otomasyonu',
      defaultCenter: [39.5961, 27.0244],
      creditPackages: [
        { id: 'paket-500', name: 'Başlangıç', credits: 500, unitPrice: 1.5, total: 750 },
        { id: 'paket-2000', name: 'Büyüme', credits: 2000, unitPrice: 1.2, total: 2400 },
        { id: 'paket-10000', name: 'Kurumsal Filo', credits: 10000, unitPrice: 0.95, total: 9500 },
      ],
    });
  });

  function handleManifestRequest(req, res) {
    const role = String(req.query.role || 'default').toLowerCase();
    const roleMeta = {
      admin: {
        name: 'PAKETÜS — Operasyon Merkezi',
        short_name: 'PAKETÜS Panel',
        start_url: '/panel',
      },
      merchant: {
        name: 'PAKETÜS — İşletme & Mutfak',
        short_name: 'PAKETÜS Mutfak',
        start_url: '/isletme',
      },
      courier: {
        name: 'PAKETÜS — Kurye Saha Uygulaması',
        short_name: 'PAKETÜS Kurye',
        start_url: '/kurye',
      },
      default: {
        name: 'PAKETÜS — Akıllı Kurye & POS Otomasyonu',
        short_name: 'PAKETÜS',
        start_url: '/',
      },
    };
    const chosen = roleMeta[role] || roleMeta.default;
    res.json({
      name: chosen.name,
      short_name: chosen.short_name,
      description:
        'Çok kiracılı kurye dağıtım, akıllı paket birleştirme, POS entegrasyonu ve saha telsiz otomasyonu',
      start_url: chosen.start_url,
      display: 'standalone',
      background_color: '#0b1220',
      theme_color: '#0b1220',
      lang: 'tr',
      icons: [
        {
          src: '/brand/icon-192.svg',
          sizes: '192x192',
          type: 'image/svg+xml',
          purpose: 'any maskable',
        },
        {
          src: '/brand/icon-512.svg',
          sizes: '512x512',
          type: 'image/svg+xml',
          purpose: 'any maskable',
        },
      ],
    });
  }

  app.get('/api/manifest.json', handleManifestRequest);
  app.get('/manifest.json', handleManifestRequest);

  const DEMO_KEY_MAP = {
    demo_admin_merkez: '05551001010',
    admin: '05551001010',
    demo_merchant_group_merkez: '05552002020',
    merchant_group: '05552002020',
    merchant: '05552002020',
    demo_merchant_single_merkez: '05552002021',
    merchant_single: '05552002021',
    demo_courier_1_merkez: '05553003031',
    courier_pos: '05553003031',
    courier: '05553003031',
    demo_courier_2_merkez: '05553003032',
    courier_nopos: '05553003032',
    demo_courier_3_merkez: '05553003033',
    courier_offline: '05553003033',
  };

  app.get('/api/auth/demo-accounts', (_req, res) => {
    const merkez = db.get('SELECT id FROM tenants WHERE slug = ?', 'merkez');
    let sampleTracking = 'PKT-MRKZ-104';
    if (merkez) {
      const sampleOrder =
        db.get(
          `SELECT tracking_code FROM orders
           WHERE tenant_id = ? AND status IN ('picked_up', 'assigned', 'pending')
           ORDER BY CASE status WHEN 'picked_up' THEN 0 WHEN 'assigned' THEN 1 ELSE 2 END, id ASC LIMIT 1`,
          merkez.id
        ) || db.get('SELECT tracking_code FROM orders WHERE tenant_id = ? LIMIT 1', merkez.id);
      if (sampleOrder?.tracking_code) sampleTracking = sampleOrder.tracking_code;
    }

    res.json({
      ok: true,
      tenantSlug: 'merkez',
      tenantName: 'Ege Hızlı Kurye & Lojistik',
      sampleTrackingCode: sampleTracking,
      trackingDemo: {
        trackingCode: sampleTracking,
        targetPath: `/takip/${sampleTracking}`,
      },
      accounts: [
        {
          key: 'admin',
          demoKey: 'demo_admin_merkez',
          role: 'admin',
          title: 'Operasyon Merkezi (Yönetici)',
          displayName: 'Murat Yönetici',
          phone: '05551001010',
          tenantSlug: 'merkez',
          targetPath: '/panel',
          badge: 'Canlı Harita • Akıllı Paket Birleştirme • Telsiz',
        },
        {
          key: 'merchant_group',
          demoKey: 'demo_merchant_group_merkez',
          role: 'merchant',
          title: 'Çoklu Marka Grup İşletme (3 Şube)',
          displayName: 'Lezzet Grup Restoranları',
          phone: '05552002020',
          tenantSlug: 'merkez',
          targetPath: '/isletme',
          badge: 'Hatay Dönercisi • Burger İstasyonu • Gece Kumrucusu',
        },
        {
          key: 'merchant_single',
          demoKey: 'demo_merchant_single_merkez',
          role: 'merchant',
          title: 'Tekil Restoran / Mutfak',
          displayName: 'Körfez Pide & Lahmacun',
          phone: '05552002021',
          tenantSlug: 'merkez',
          targetPath: '/isletme',
          badge: 'Caller ID Hafızası • 80mm Termal Fiş',
        },
        {
          key: 'courier_pos',
          demoKey: 'demo_courier_1_merkez',
          role: 'courier',
          title: 'Kurye Mobil Saha (POS Cihazlı)',
          displayName: 'Ahmet Yılmaz',
          phone: '05553003031',
          tenantSlug: 'merkez',
          targetPath: '/kurye',
          badge: 'Motosiklet • Mobil POS Var • %92 Şarj',
        },
        {
          key: 'courier_nopos',
          demoKey: 'demo_courier_2_merkez',
          role: 'courier',
          title: 'Kurye Mobil Saha (Nakit/Online)',
          displayName: 'Burak Demir',
          phone: '05553003032',
          tenantSlug: 'merkez',
          targetPath: '/kurye',
          badge: 'Motosiklet • POS Yok • %78 Şarj',
        },
        {
          key: 'courier_offline',
          demoKey: 'demo_courier_3_merkez',
          role: 'courier',
          title: 'Araçlı Kurye (Mesai Dışı)',
          displayName: 'Can Kaya',
          phone: '05553003033',
          tenantSlug: 'merkez',
          targetPath: '/kurye',
          badge: 'Araçlı Kurye • Mobil POS Var • Çevrimdışı',
        },
      ],
    });
  });

  function handleLogin(req, res) {
    const body = req.body || {};
    const demoKey = body.demoKey || body.key || '';

    let userRow = null;
    let tenantRow = null;

    if (demoKey && DEMO_KEY_MAP[demoKey]) {
      const targetPhone = DEMO_KEY_MAP[demoKey];
      tenantRow = db.get('SELECT * FROM tenants WHERE slug = ?', 'merkez');
      if (tenantRow) {
        userRow = db.get(
          'SELECT * FROM users WHERE tenant_id = ? AND phone = ?',
          tenantRow.id,
          targetPhone
        );
      }
    } else {
      const phone = normalizePhone(body.phone || body.username || '');
      const password = String(body.password ?? '');
      const tenantSlug = body.tenantSlug || body.tenant_slug || '';

      if (!phone || !password) {
        return res.status(400).json({
          ok: false,
          error: 'Telefon numarası ve şifre zorunludur.',
        });
      }

      if (tenantSlug) {
        tenantRow = db.get(
          'SELECT * FROM tenants WHERE slug = ?',
          String(tenantSlug).trim().toLowerCase()
        );
        if (!tenantRow) {
          return res.status(404).json({ ok: false, error: 'Belirtilen operasyon bulunamadı.' });
        }
        const cand = db.get(
          'SELECT * FROM users WHERE tenant_id = ? AND phone = ?',
          tenantRow.id,
          phone
        );
        if (cand && verifyPassword(password, cand.password_hash)) {
          userRow = cand;
        }
      } else {
        const candidates = db.all('SELECT * FROM users WHERE phone = ? ORDER BY id DESC', phone);
        for (const cand of candidates) {
          if (verifyPassword(password, cand.password_hash)) {
            userRow = cand;
            tenantRow = db.get('SELECT * FROM tenants WHERE id = ?', cand.tenant_id);
            break;
          }
        }
      }
    }

    if (!userRow || !tenantRow) {
      return res.status(401).json({
        ok: false,
        error: 'Telefon numarası veya şifre hatalı.',
      });
    }

    const token = signAuthToken({
      userId: userRow.id,
      tenantId: tenantRow.id,
      role: userRow.role,
    });

    const userCtx = resolveUserContextFromToken(token);
    let shops = [];
    if (userCtx.role === 'merchant') {
      const allowedIds = getMerchantAllowedShopIds(userCtx);
      if (allowedIds.length > 0) {
        const ph = allowedIds.map(() => '?').join(', ');
        shops = db
          .all(`SELECT * FROM shops WHERE tenant_id = ? AND id IN (${ph})`, tenantRow.id, ...allowedIds)
          .map((s) => serializeShop(s));
      }
    } else if (userCtx.role === 'admin') {
      shops = db
        .all('SELECT * FROM shops WHERE tenant_id = ? ORDER BY id ASC', tenantRow.id)
        .map((s) => serializeShop(s));
    }

    return res.json({
      ok: true,
      token,
      user: userCtx,
      shops,
    });
  }

  app.post('/api/auth/login', handleLogin);
  app.post('/api/auth/demo-login', handleLogin);

  app.get('/api/auth/me', requireAuth(), (req, res) => {
    res.json({ ok: true, user: req.user });
  });

  app.post('/api/public/register-tenant', (req, res) => {
    try {
      const body = req.body || {};
      const companyName = String(body.companyName || body.name || '').trim();
      const city = String(body.city || 'Edremit, Balıkesir').trim();
      const adminName = String(body.adminName || body.displayName || 'Operasyon Yöneticisi').trim();
      const adminPhone = normalizePhone(body.adminPhone || body.phone || '');
      const password = String(body.password || '').trim();

      if (!companyName || !adminPhone || !password) {
        return res.status(400).json({
          ok: false,
          error: 'Şirket adı, yönetici telefonu ve şifre alanları zorunludur.',
        });
      }

      const [centerLat, centerLng] = resolveCityCoordinates(city);
      let baseSlug = slugifyTurkish(companyName) || 'operasyon';
      let slug = baseSlug;
      let suffix = 2;
      while (db.get('SELECT id FROM tenants WHERE slug = ?', slug)) {
        slug = `${baseSlug}-${suffix}`;
        suffix += 1;
      }

      const result = db.tx(() => {
        const nowIso = new Date().toISOString();
        const passHash = hashPassword(password);

        const tRes = db.run(
          `INSERT INTO tenants (slug, name, city, center_lat, center_lng, credits_balance, credits_enabled, created_at)
           VALUES (?, ?, ?, ?, ?, 100, 1, ?)`,
          slug,
          companyName,
          city,
          centerLat,
          centerLng,
          nowIso
        );
        const tenantId = tRes.lastInsertRowid;

        db.run(
          `INSERT INTO credit_ledger (tenant_id, delta, balance_after, reason, order_id, note, idempotency_key, created_at)
           VALUES (?, 100, 100, 'welcome_bonus', NULL, 'Hoş Geldin Süresiz 100 Kontör Hediyesi', ?, ?)`,
          tenantId,
          `welcome-tenant-${tenantId}`,
          nowIso
        );

        // Varsayılan 3 mesafe bölgesi
        db.run(
          `INSERT INTO zones (tenant_id, name, min_km, max_km, shop_fee, courier_fee) VALUES (?, 'Yakın Bölge (0-2 km)', 0, 2, 45, 34)`,
          tenantId
        );
        db.run(
          `INSERT INTO zones (tenant_id, name, min_km, max_km, shop_fee, courier_fee) VALUES (?, 'Orta Bölge (2-5 km)', 2, 5, 65, 48)`,
          tenantId
        );
        db.run(
          `INSERT INTO zones (tenant_id, name, min_km, max_km, shop_fee, courier_fee) VALUES (?, 'Uzak Bölge (5-12 km)', 5, 12, 95, 72)`,
          tenantId
        );

        // Örnek 1 dükkan
        const sRes = db.run(
          `INSERT INTO shops (tenant_id, group_id, name, brand_tag, phone, address, lat, lng, tariff_mode, base_fee, per_km_fee, commission_pct, auto_print, created_at)
           VALUES (?, NULL, ?, 'Merkez Şube', ?, ?, ?, ?, 'km', 45, 10, 12, 1, ?)`,
          tenantId,
          `${companyName} Örnek Restoran`,
          adminPhone,
          `${city} Merkez Cad. No:1`,
          centerLat,
          centerLng,
          nowIso
        );

        // Örnek 1 kurye
        const cRes = db.run(
          `INSERT INTO couriers (tenant_id, name, phone, vehicle_type, is_online, on_break, has_pos, battery_pct, max_batch, lat, lng, per_package_fee, per_km_bonus, updated_at)
           VALUES (?, 'Örnek Saha Kuryesi', ?, 'Motosiklet', 1, 0, 1, 100, 4, ?, ?, 35, 6, ?)`,
          tenantId,
          `0555000${String(tenantId).padStart(4, '0')}`,
          centerLat + 0.0008,
          centerLng + 0.0008,
          nowIso
        );

        // Yönetici kullanıcı
        const uRes = db.run(
          `INSERT INTO users (tenant_id, phone, password_hash, role, display_name, merchant_group_id, shop_id, courier_id, must_change_password)
           VALUES (?, ?, ?, 'admin', ?, NULL, NULL, NULL, 0)`,
          tenantId,
          adminPhone,
          passHash,
          adminName
        );

        return {
          tenantId,
          adminUserId: uRes.lastInsertRowid,
          shopId: sRes.lastInsertRowid,
          courierId: cRes.lastInsertRowid,
        };
      });

      const token = signAuthToken({
        userId: result.adminUserId,
        tenantId: result.tenantId,
        role: 'admin',
      });
      const userCtx = resolveUserContextFromToken(token);
      const tenant = serializeTenant(db.get('SELECT * FROM tenants WHERE id = ?', result.tenantId));
      const shops = db
        .all('SELECT * FROM shops WHERE tenant_id = ?', result.tenantId)
        .map((s) => serializeShop(s));

      return res.status(200).json({
        ok: true,
        token,
        tenant,
        user: userCtx,
        shops,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err.message || 'Yeni operasyon kaydı sırasında hata oluştu.',
      });
    }
  });

  app.get('/api/public/track/:code', (req, res) => {
    const code = String(req.params.code || '').trim();
    if (!code) {
      return res.status(400).json({ ok: false, error: 'Takip kodu gerekli.' });
    }

    const orderRow = db.get(
      'SELECT * FROM orders WHERE UPPER(tracking_code) = UPPER(?)',
      code
    );
    if (!orderRow) {
      return res.status(404).json({ ok: false, error: 'Takip koduna ait sipariş bulunamadı.' });
    }

    const shop = db.get('SELECT name, brand_tag FROM shops WHERE id = ?', orderRow.shop_id);
    const courier = orderRow.courier_id
      ? db.get('SELECT name, vehicle_type FROM couriers WHERE id = ?', orderRow.courier_id)
      : null;

    let estimatedMinutesLeft = 0;
    const dist = Number(orderRow.distance_km || 2);
    if (orderRow.status === 'picked_up') {
      estimatedMinutesLeft = Math.max(4, Math.round(dist * 3 + 4));
    } else if (orderRow.status === 'assigned') {
      estimatedMinutesLeft = Math.max(9, Math.round(dist * 3.5 + 8));
    } else if (orderRow.status === 'pending' || orderRow.status === 'pending_credit') {
      estimatedMinutesLeft = Math.max(14, Math.round(dist * 4 + 12));
    }

    const courierFirstName = courier?.name ? String(courier.name).trim().split(/\s+/)[0] : null;
    const pinStr = String(orderRow.delivery_pin || '');
    const deliveryPinHint = pinStr.length >= 2 ? `**${pinStr.slice(-2)}` : null;

    // KRİTİK MAHREMİYET: Tam kurye GPS'i ve tam müşteri telefonu ASLA döndürülmez!
    return res.json({
      ok: true,
      order: {
        trackingCode: orderRow.tracking_code,
        tracking_code: orderRow.tracking_code,
        shopName: shop?.name || 'Restoran',
        shop_name: shop?.name || 'Restoran',
        brandTag: shop?.brand_tag || '',
        status: orderRow.status,
        orderType: orderRow.order_type,
        order_type: orderRow.order_type,
        paymentMethod: orderRow.payment_method,
        payment_method: orderRow.payment_method,
        orderAmount: orderRow.order_amount,
        order_amount: orderRow.order_amount,
        neighborhood: orderRow.neighborhood,
        itemsSummary: orderRow.items_summary,
        createdAt: orderRow.created_at,
        assignedAt: orderRow.assigned_at,
        pickedUpAt: orderRow.picked_up_at,
        deliveredAt: orderRow.delivered_at,
        estimatedMinutesLeft,
        estimated_minutes_left: estimatedMinutesLeft,
        courierFirstName,
        courier_first_name: courierFirstName,
        vehicleType: courier?.vehicle_type || null,
        vehicle_type: courier?.vehicle_type || null,
        deliveryPinHint,
        delivery_pin_hint: deliveryPinHint,
      },
    });
  });

  // ============================================================================
  // PAZARYERİ, POS & TERMAL FİŞ ENTEGRASYON YÖNLENDİRİCİSİ (/api/integrations)
  // ============================================================================

  let cachedIntegrationsRouter = null;

  function resolveIntegrationsRouter() {
    if (cachedIntegrationsRouter) return cachedIntegrationsRouter;
    try {
      const mod = require('./src/integrations-router');
      if (mod && typeof mod.createIntegrationsRouter === 'function') {
        cachedIntegrationsRouter = mod.createIntegrationsRouter({
          ingestExternalOrder: async (normalizedPayload, req) =>
            createOrderInternal(normalizedPayload, req?.user || null),
          lookupCallerId: async (phone, tenantId) => {
            const norm = normalizePhone(phone);
            if (!norm) return null;
            const row = db.get(
              'SELECT * FROM customers WHERE tenant_id = ? AND phone = ?',
              Number(tenantId || 1),
              norm
            );
            return serializeCustomer(row);
          },
          getReceiptOrder: async (orderIdOrCode, req) => {
            const rawParam = String(orderIdOrCode || '').trim();
            let orderRow = null;
            if (/^\d+$/.test(rawParam)) {
              orderRow = db.get('SELECT * FROM orders WHERE id = ?', Number(rawParam));
            } else {
              orderRow = db.get(
                'SELECT * FROM orders WHERE UPPER(tracking_code) = UPPER(?)',
                rawParam
              );
            }
            if (!orderRow) return null;
            if (req?.user && req.user.tenantId !== orderRow.tenant_id) {
              return null;
            }
            const shop = db.get('SELECT * FROM shops WHERE id = ?', orderRow.shop_id);
            const tenant = db.get('SELECT * FROM tenants WHERE id = ?', orderRow.tenant_id);
            return {
              order: serializeOrder(orderRow, {
                shopMap: shop ? new Map([[shop.id, shop]]) : null,
                maskCourierGps: true,
              }),
              shop: serializeShop(shop),
              tenant: serializeTenant(tenant),
            };
          },
          logWebhook: async ({ tenantId, platform, externalId, status, summary }) => {
            const tId = Number(tenantId || 1);
            db.run(
              `INSERT INTO webhook_logs (tenant_id, platform, external_id, status, summary, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              tId,
              String(platform || 'unknown'),
              externalId ? String(externalId) : null,
              String(status || 'ingested'),
              String(summary || ''),
              new Date().toISOString()
            );
            setImmediate(() => broadcastTenantUpdate(tId, 'webhook_logged'));
          },
        });
      }
    } catch (_) {
      cachedIntegrationsRouter = null;
    }
    return cachedIntegrationsRouter;
  }

  // Sunucu açılışında hazırsa bağla, değilse istek geldiğinde gecikmeli yükle
  resolveIntegrationsRouter();
  app.use('/api/integrations', attachOptionalAuth, (req, res, next) => {
    const router = resolveIntegrationsRouter();
    if (!router) {
      return res.status(503).json({
        ok: false,
        error: 'Entegrasyon modülü henüz hazır değil.',
      });
    }
    return router(req, res, next);
  });

  // ============================================================================
  // CANLI YAYIN (SSE — /api/stream)
  // ============================================================================

  app.get('/api/stream', requireAuth(), (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    const clientEntry = {
      userCtx: req.user,
      res,
    };
    sseClients.add(clientEntry);

    const initialPayload = buildBootstrapPayload(req.user);
    initialPayload.ts = Date.now();
    res.write(`event: snapshot\ndata: ${JSON.stringify(initialPayload)}\n\n`);

    req.on('close', () => {
      sseClients.delete(clientEntry);
    });
  });

  // ============================================================================
  // ORTAK & ROL BAZLI OPERASYON UÇ NOKTALARI
  // ============================================================================

  app.get('/api/bootstrap', requireAuth(), (req, res) => {
    const payload = buildBootstrapPayload(req.user);
    return res.json(payload);
  });

  app.get('/api/caller-id', requireAuth(['admin', 'merchant']), (req, res) => {
    const rawPhone = String(req.query.phone || '').trim();
    const normPhone = normalizePhone(rawPhone);
    if (!normPhone) {
      return res.json({ ok: true, found: false, customer: null, recentOrders: [] });
    }

    let customerRow = db.get(
      'SELECT * FROM customers WHERE tenant_id = ? AND phone = ?',
      req.user.tenantId,
      normPhone
    );
    if (!customerRow && normPhone.length >= 7) {
      customerRow = db.get(
        'SELECT * FROM customers WHERE tenant_id = ? AND phone LIKE ? ORDER BY updated_at DESC LIMIT 1',
        req.user.tenantId,
        `%${normPhone.slice(-10)}`
      );
    }

    let recentOrders = [];
    if (customerRow) {
      recentOrders = db.all(
        `SELECT id, tracking_code, order_amount, payment_method, items_summary, customer_address, neighborhood, created_at
         FROM orders
         WHERE tenant_id = ? AND customer_phone = ?
         ORDER BY id DESC LIMIT 5`,
        req.user.tenantId,
        customerRow.phone
      );
    }

    return res.json({
      ok: true,
      found: Boolean(customerRow),
      customer: serializeCustomer(customerRow),
      recentOrders,
    });
  });

  app.get('/api/orders', requireAuth(), (req, res) => {
    const payload = buildBootstrapPayload(req.user);
    const orders =
      req.user.role === 'courier'
        ? [...(payload.activeOrders || []), ...(payload.recentDelivered || [])]
        : payload.orders || [];
    return res.json({ ok: true, orders });
  });

  app.post('/api/orders', requireAuth(['admin', 'merchant']), (req, res) => {
    try {
      const result = createOrderInternal(req.body || {}, req.user);
      return res.status(201).json({
        ok: true,
        order: result.order,
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        ok: false,
        error: err.message || 'Sipariş oluşturulamadı.',
      });
    }
  });

  app.post('/api/admin/dispatch/preview-batches', requireAuth(['admin']), (req, res) => {
    const batches = buildBatchesPreviewForTenant(req.user.tenantId);
    return res.json({
      ok: true,
      batches,
      totalBatches: batches.length,
      combinedBatchesCount: batches.filter((b) => b.isCombined).length,
    });
  });

  app.post('/api/admin/dispatch/auto-assign', requireAuth(['admin']), (req, res) => {
    const outcome = db.tx(() => {
      const shops = db.all(
        'SELECT * FROM shops WHERE tenant_id = ? ORDER BY id ASC',
        req.user.tenantId
      );
      const shopMap = new Map(shops.map((s) => [s.id, s]));
      const zones = db.all('SELECT * FROM zones WHERE tenant_id = ?', req.user.tenantId);
      const couriers = db.all(
        'SELECT * FROM couriers WHERE tenant_id = ? ORDER BY id ASC',
        req.user.tenantId
      );
      const activeLoadMap = getActiveLoadByCourierMap(req.user.tenantId);

      const pendingRows = db.all(
        `SELECT * FROM orders
         WHERE tenant_id = ? AND status = 'pending' AND order_type = 'delivery'
         ORDER BY created_at ASC, id ASC`,
        req.user.tenantId
      );

      const enrichedPending = pendingRows.map((o) =>
        serializeOrder(o, { shopMap, maskCourierGps: false })
      );
      const batches = buildSmartBatches(enrichedPending, shops);

      const nowIso = new Date().toISOString();
      const assignedBatches = [];
      const unassignedBatches = [];
      let assignedOrderCount = 0;

      for (const batch of batches) {
        const chosen = chooseBestCourierForBatch(batch, couriers, activeLoadMap);
        if (!chosen) {
          unassignedBatches.push({
            batchId: batch.batchId,
            orderIds: batch.orderIds,
            requiresPos: batch.requiresPos,
            reason: batch.requiresPos
              ? 'Müsait POS cihazlı çevrimiçi kurye bulunamadı veya kapasite dolu.'
              : 'Müsait çevrimiçi kurye bulunamadı veya kapasite dolu.',
          });
          continue;
        }

        const batchCode = `BATCH-${Date.now().toString(36).toUpperCase()}-${chosen.id}-${assignedBatches.length + 1}`;

        for (let idx = 0; idx < batch.orders.length; idx += 1) {
          const ord = batch.orders[idx];
          const seq = ord.route_seq || idx + 1;
          const shop = shopMap.get(ord.shop_id) || null;
          const pricing = calculateOrderPricing({
            shop,
            zones,
            courier: chosen,
            distanceKm: ord.distance_km,
            orderAmount: ord.order_amount,
            orderType: ord.order_type,
          });

          db.run(
            `UPDATE orders
             SET status = 'assigned',
                 courier_id = ?,
                 batch_id = ?,
                 route_seq = ?,
                 courier_earning = ?,
                 assigned_at = ?
             WHERE id = ? AND tenant_id = ?`,
            chosen.id,
            batchCode,
            seq,
            pricing.courierEarning,
            nowIso,
            ord.id,
            req.user.tenantId
          );
          assignedOrderCount += 1;
        }

        activeLoadMap.set(
          chosen.id,
          (activeLoadMap.get(chosen.id) || 0) + batch.orders.length
        );

        assignedBatches.push({
          batchId: batchCode,
          courierId: chosen.id,
          courierName: chosen.name,
          hasPos: Number(chosen.has_pos) === 1,
          orderIds: batch.orders.map((o) => o.id),
          size: batch.orders.length,
          estimatedTotalKm: batch.estimatedTotalKm,
        });
      }

      return {
        assignedBatches,
        unassignedBatches,
        assignedOrderCount,
      };
    });

    broadcastTenantUpdate(req.user.tenantId, 'auto_assigned');
    return res.json({
      ok: true,
      ...outcome,
    });
  });

  app.post('/api/admin/orders/:id/assign', requireAuth(['admin']), (req, res) => {
    const orderId = Number(req.params.id);
    const courierId = Number(req.body?.courierId ?? req.body?.courier_id);
    const force = Boolean(req.body?.force);

    if (!orderId || !courierId) {
      return res.status(400).json({ ok: false, error: 'Sipariş ve kurye seçimi zorunludur.' });
    }

    const orderRow = db.get(
      'SELECT * FROM orders WHERE id = ? AND tenant_id = ?',
      orderId,
      req.user.tenantId
    );
    if (!orderRow) {
      return res.status(404).json({ ok: false, error: 'Sipariş bulunamadı.' });
    }

    const courierRow = db.get(
      'SELECT * FROM couriers WHERE id = ? AND tenant_id = ?',
      courierId,
      req.user.tenantId
    );
    if (!courierRow) {
      return res.status(404).json({ ok: false, error: 'Kurye bulunamadı.' });
    }

    if (orderRow.payment_method === 'card_on_delivery' && Number(courierRow.has_pos) !== 1 && !force) {
      return res.status(400).json({
        ok: false,
        code: 'POS_REQUIRED',
        error: 'Kapıda kredi kartı ödemeli sipariş POS cihazı olmayan kuryeye atanamaz!',
      });
    }

    const shop = db.get('SELECT * FROM shops WHERE id = ?', orderRow.shop_id);
    const zones = db.all('SELECT * FROM zones WHERE tenant_id = ?', req.user.tenantId);
    const pricing = calculateOrderPricing({
      shop,
      zones,
      courier: courierRow,
      distanceKm: orderRow.distance_km,
      orderAmount: orderRow.order_amount,
      orderType: orderRow.order_type,
    });

    const nowIso = new Date().toISOString();
    const nextStatus = orderRow.status === 'picked_up' ? 'picked_up' : 'assigned';

    db.run(
      `UPDATE orders
       SET courier_id = ?,
           status = ?,
           batch_id = COALESCE(batch_id, ?),
           courier_earning = ?,
           assigned_at = COALESCE(assigned_at, ?)
       WHERE id = ? AND tenant_id = ?`,
      courierRow.id,
      nextStatus,
      `MANUAL-${orderRow.id}`,
      pricing.courierEarning,
      nowIso,
      orderRow.id,
      req.user.tenantId
    );

    const updated = db.get('SELECT * FROM orders WHERE id = ?', orderRow.id);
    broadcastTenantUpdate(req.user.tenantId, 'order_assigned');

    return res.json({
      ok: true,
      order: serializeOrder(updated, {
        shopMap: shop ? new Map([[shop.id, shop]]) : null,
        courierMap: new Map([[courierRow.id, courierRow]]),
        maskCourierGps: false,
      }),
    });
  });

  app.patch('/api/orders/:id/status', requireAuth(), (req, res) => {
    const orderId = Number(req.params.id);
    const nextStatus = String(req.body?.status || '').trim();
    const validStatuses = [
      'pending_credit',
      'pending',
      'assigned',
      'picked_up',
      'delivered',
      'cancelled',
      'returned',
    ];

    if (!orderId || !validStatuses.includes(nextStatus)) {
      return res.status(400).json({ ok: false, error: 'Geçersiz sipariş durumu.' });
    }

    try {
      const updatedOrder = db.tx(() => {
        const orderRow = db.get(
          'SELECT * FROM orders WHERE id = ? AND tenant_id = ?',
          orderId,
          req.user.tenantId
        );
        if (!orderRow) {
          const err = new Error('Sipariş bulunamadı.');
          err.statusCode = 404;
          throw err;
        }

        if (req.user.role === 'merchant') {
          const allowedShopIds = getMerchantAllowedShopIds(req.user);
          if (!allowedShopIds.includes(orderRow.shop_id)) {
            const err = new Error('Bu siparişi güncelleme yetkiniz yok.');
            err.statusCode = 403;
            throw err;
          }
        } else if (req.user.role === 'courier') {
          if (orderRow.courier_id !== req.user.courierId) {
            const err = new Error('Bu sipariş size atanmamış.');
            err.statusCode = 403;
            throw err;
          }
        }

        const nowIso = new Date().toISOString();
        const assignedAt =
          nextStatus === 'assigned' ? orderRow.assigned_at || nowIso : orderRow.assigned_at;
        const pickedUpAt =
          nextStatus === 'picked_up' ? orderRow.picked_up_at || nowIso : orderRow.picked_up_at;
        const deliveredAt =
          nextStatus === 'delivered' ? orderRow.delivered_at || nowIso : orderRow.delivered_at;

        // KRİTİK KONTÖR İADE KURALI: İptalde kontör YALNIZCA 1 KEZ iade edilir!
        let creditRefunded = Number(orderRow.credit_refunded || 0);
        if (
          nextStatus === 'cancelled' &&
          Number(orderRow.credit_consumed) === 1 &&
          creditRefunded === 0
        ) {
          creditRefunded = 1;
          const tenantRow = db.get('SELECT * FROM tenants WHERE id = ?', req.user.tenantId);
          const nextBalance = Number(tenantRow.credits_balance) + 1;
          db.run(
            'UPDATE tenants SET credits_balance = ? WHERE id = ?',
            nextBalance,
            req.user.tenantId
          );
          db.run(
            `INSERT INTO credit_ledger (tenant_id, delta, balance_after, reason, order_id, note, idempotency_key, created_at)
             VALUES (?, 1, ?, 'order_cancel_refund', ?, ?, ?, ?)`,
            req.user.tenantId,
            nextBalance,
            orderRow.id,
            `İptal edilen sipariş #${orderRow.id} (${orderRow.tracking_code}) kontör iadesi`,
            `refund-order-${orderRow.id}`,
            nowIso
          );
        }

        db.run(
          `UPDATE orders
           SET status = ?,
               assigned_at = ?,
               picked_up_at = ?,
               delivered_at = ?,
               credit_refunded = ?
           WHERE id = ? AND tenant_id = ?`,
          nextStatus,
          assignedAt,
          pickedUpAt,
          deliveredAt,
          creditRefunded,
          orderRow.id,
          req.user.tenantId
        );

        return db.get('SELECT * FROM orders WHERE id = ?', orderRow.id);
      });

      const shop = db.get('SELECT * FROM shops WHERE id = ?', updatedOrder.shop_id);
      const courier = updatedOrder.courier_id
        ? db.get('SELECT * FROM couriers WHERE id = ?', updatedOrder.courier_id)
        : null;

      broadcastTenantUpdate(req.user.tenantId, `order_status_${nextStatus}`);

      return res.json({
        ok: true,
        order: serializeOrder(updatedOrder, {
          shopMap: shop ? new Map([[shop.id, shop]]) : null,
          courierMap: courier ? new Map([[courier.id, courier]]) : null,
          maskCourierGps: req.user.role === 'merchant',
        }),
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        ok: false,
        error: err.message || 'Sipariş durumu güncellenemedi.',
      });
    }
  });

  app.patch('/api/admin/orders/:id/financials', requireAuth(['admin']), (req, res) => {
    const orderId = Number(req.params.id);
    const orderRow = db.get(
      'SELECT * FROM orders WHERE id = ? AND tenant_id = ?',
      orderId,
      req.user.tenantId
    );
    if (!orderRow) {
      return res.status(404).json({ ok: false, error: 'Sipariş bulunamadı.' });
    }

    const body = req.body || {};
    const nextAmount =
      body.orderAmount !== undefined || body.order_amount !== undefined
        ? round2(Number(body.orderAmount ?? body.order_amount))
        : orderRow.order_amount;

    let nextPayment =
      body.paymentMethod !== undefined || body.payment_method !== undefined
        ? String(body.paymentMethod ?? body.payment_method).trim()
        : orderRow.payment_method;
    if (!['cash', 'card_on_delivery', 'online_paid'].includes(nextPayment)) {
      return res.status(400).json({ ok: false, error: 'Geçersiz ödeme yöntemi.' });
    }

    const nextDeliveryFee =
      body.deliveryFee !== undefined || body.delivery_fee !== undefined
        ? round2(Number(body.deliveryFee ?? body.delivery_fee))
        : orderRow.delivery_fee;

    const nextCourierEarning =
      body.courierEarning !== undefined || body.courier_earning !== undefined
        ? round2(Number(body.courierEarning ?? body.courier_earning))
        : orderRow.courier_earning;

    const nextNotes = body.notes !== undefined ? String(body.notes) : orderRow.notes;

    db.run(
      `UPDATE orders
       SET order_amount = ?,
           payment_method = ?,
           delivery_fee = ?,
           courier_earning = ?,
           notes = ?
       WHERE id = ? AND tenant_id = ?`,
      nextAmount,
      nextPayment,
      nextDeliveryFee,
      nextCourierEarning,
      nextNotes,
      orderRow.id,
      req.user.tenantId
    );

    const updated = db.get('SELECT * FROM orders WHERE id = ?', orderRow.id);
    const shop = db.get('SELECT * FROM shops WHERE id = ?', updated.shop_id);
    const courier = updated.courier_id
      ? db.get('SELECT * FROM couriers WHERE id = ?', updated.courier_id)
      : null;

    broadcastTenantUpdate(req.user.tenantId, 'order_financials_updated');

    return res.json({
      ok: true,
      order: serializeOrder(updated, {
        shopMap: shop ? new Map([[shop.id, shop]]) : null,
        courierMap: courier ? new Map([[courier.id, courier]]) : null,
        maskCourierGps: false,
      }),
    });
  });

  // ============================================================================
  // PAKET BAZLI SOHBET (/api/orders/:id/messages)
  // ============================================================================

  function verifyOrderChatAccess(userCtx, orderRow) {
    if (!orderRow || orderRow.tenant_id !== userCtx.tenantId) return false;
    if (userCtx.role === 'admin') return true;
    if (userCtx.role === 'merchant') {
      const allowedShopIds = getMerchantAllowedShopIds(userCtx);
      return allowedShopIds.includes(orderRow.shop_id);
    }
    if (userCtx.role === 'courier') {
      return orderRow.courier_id === userCtx.courierId;
    }
    return false;
  }

  app.get('/api/orders/:id/messages', requireAuth(), (req, res) => {
    const orderId = Number(req.params.id);
    const orderRow = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (!verifyOrderChatAccess(req.user, orderRow)) {
      return res.status(404).json({ ok: false, error: 'Sipariş bulunamadı veya erişim yetkiniz yok.' });
    }

    const rows = db.all(
      'SELECT * FROM order_messages WHERE tenant_id = ? AND order_id = ? ORDER BY id ASC',
      req.user.tenantId,
      orderId
    );
    return res.json({
      ok: true,
      orderId,
      messages: rows.map(serializeOrderMessage),
    });
  });

  app.post('/api/orders/:id/messages', requireAuth(), (req, res) => {
    const orderId = Number(req.params.id);
    const orderRow = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (!verifyOrderChatAccess(req.user, orderRow)) {
      return res.status(404).json({ ok: false, error: 'Sipariş bulunamadı veya erişim yetkiniz yok.' });
    }

    const text = String(req.body?.body ?? req.body?.message ?? req.body?.text ?? '').trim();
    if (!text) {
      return res.status(400).json({ ok: false, error: 'Mesaj metni boş olamaz.' });
    }

    const nowIso = new Date().toISOString();
    const ins = db.run(
      `INSERT INTO order_messages (tenant_id, order_id, sender_role, sender_name, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      req.user.tenantId,
      orderId,
      req.user.role,
      req.user.displayName,
      text.slice(0, 1000),
      nowIso
    );

    const created = serializeOrderMessage(
      db.get('SELECT * FROM order_messages WHERE id = ?', ins.lastInsertRowid)
    );
    const allMessages = db
      .all(
        'SELECT * FROM order_messages WHERE tenant_id = ? AND order_id = ? ORDER BY id ASC',
        req.user.tenantId,
        orderId
      )
      .map(serializeOrderMessage);

    broadcastTenantUpdate(req.user.tenantId, 'order_message', {
      event: 'order_message',
      data: created,
    });

    return res.status(201).json({
      ok: true,
      message: created,
      messages: allMessages,
    });
  });

  // ============================================================================
  // CANLI BAS-KONUŞ TELSİZ (/api/radio)
  // ============================================================================

  app.get('/api/radio', requireAuth(), (req, res) => {
    const rows = db.all(
      'SELECT * FROM radio_transmissions WHERE tenant_id = ? ORDER BY id DESC LIMIT 25',
      req.user.tenantId
    );
    const list = rows.map(serializeRadio);
    return res.json({
      ok: true,
      transmissions: list,
      radioTransmissions: list,
    });
  });

  app.post('/api/radio', requireAuth(), (req, res) => {
    const body = req.body || {};
    const channel = String(body.channel || 'genel').trim().slice(0, 40) || 'genel';
    const textNote = String(body.textNote ?? body.text_note ?? body.text ?? '').trim().slice(0, 500);
    const audioDataUrl =
      body.audioDataUrl || body.audio_data_url ? String(body.audioDataUrl || body.audio_data_url) : null;
    const durationSec = Math.max(
      0,
      round2(Number(body.durationSec ?? body.duration_sec ?? 0))
    );

    if (!textNote && !audioDataUrl) {
      return res.status(400).json({ ok: false, error: 'Telsiz anonsu için ses veya metin gerekli.' });
    }
    if (audioDataUrl && audioDataUrl.length > 450000) {
      return res.status(413).json({ ok: false, error: 'Telsiz ses kaydı boyutu sınırı aşıldı (maks 250KB).' });
    }

    const nowIso = new Date().toISOString();
    const ins = db.run(
      `INSERT INTO radio_transmissions (tenant_id, channel, sender_role, sender_name, text_note, audio_data_url, duration_sec, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      req.user.tenantId,
      channel,
      req.user.role,
      req.user.displayName,
      textNote,
      audioDataUrl,
      durationSec,
      nowIso
    );

    const transmission = serializeRadio(
      db.get('SELECT * FROM radio_transmissions WHERE id = ?', ins.lastInsertRowid)
    );

    broadcastTenantUpdate(req.user.tenantId, 'radio_transmission', {
      event: 'radio',
      data: transmission,
    });

    return res.status(201).json({
      ok: true,
      transmission,
    });
  });

  // ============================================================================
  // YÖNETİCİ İŞLETMELER, ÇOKLU MARKA GRUPLARI, BÖLGELER & KURYE FİLO YÖNETİMİ
  // ============================================================================

  app.post('/api/admin/merchant-groups', requireAuth(['admin']), (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ ok: false, error: 'Grup adı zorunludur.' });
    }
    const nowIso = new Date().toISOString();
    const ins = db.run(
      'INSERT INTO merchant_groups (tenant_id, name, created_at) VALUES (?, ?, ?)',
      req.user.tenantId,
      name,
      nowIso
    );
    const group = db.get('SELECT * FROM merchant_groups WHERE id = ?', ins.lastInsertRowid);
    broadcastTenantUpdate(req.user.tenantId, 'merchant_group_created');
    return res.status(201).json({ ok: true, group });
  });

  app.post('/api/admin/shops', requireAuth(['admin']), (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
      return res.status(400).json({ ok: false, error: 'İşletme/şube adı zorunludur.' });
    }

    const groupId = b.groupId ?? b.group_id ? Number(b.groupId ?? b.group_id) : null;
    const brandTag = String(b.brandTag ?? b.brand_tag ?? '').trim();
    const phone = normalizePhone(b.phone || '');
    const address = String(b.address || '').trim();
    const lat = b.lat !== undefined && b.lat !== null && b.lat !== '' ? Number(b.lat) : null;
    const lng = b.lng !== undefined && b.lng !== null && b.lng !== '' ? Number(b.lng) : null;
    const tariffMode = ['km', 'zone', 'percent'].includes(b.tariffMode || b.tariff_mode)
      ? b.tariffMode || b.tariff_mode
      : 'km';
    const baseFee = round2(Number(b.baseFee ?? b.base_fee ?? 45));
    const perKmFee = round2(Number(b.perKmFee ?? b.per_km_fee ?? 10));
    const commissionPct = round2(Number(b.commissionPct ?? b.commission_pct ?? 12));
    const autoPrint = b.autoPrint ?? b.auto_print ?? true ? 1 : 0;

    const shopRow = db.tx(() => {
      const nowIso = new Date().toISOString();
      const ins = db.run(
        `INSERT INTO shops (tenant_id, group_id, name, brand_tag, phone, address, lat, lng, tariff_mode, base_fee, per_km_fee, commission_pct, auto_print, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        req.user.tenantId,
        groupId,
        name,
        brandTag,
        phone,
        address,
        lat,
        lng,
        tariffMode,
        baseFee,
        perKmFee,
        commissionPct,
        autoPrint,
        nowIso
      );
      const shopId = ins.lastInsertRowid;

      if (phone) {
        const existingUser = db.get(
          'SELECT id FROM users WHERE tenant_id = ? AND phone = ?',
          req.user.tenantId,
          phone
        );
        if (!existingUser) {
          db.run(
            `INSERT INTO users (tenant_id, phone, password_hash, role, display_name, merchant_group_id, shop_id, courier_id, must_change_password)
             VALUES (?, ?, ?, 'merchant', ?, ?, ?, NULL, 0)`,
            req.user.tenantId,
            phone,
            hashPassword(String(b.password || '1234')),
            name,
            groupId,
            shopId
          );
        }
      }

      return db.get('SELECT * FROM shops WHERE id = ?', shopId);
    });

    broadcastTenantUpdate(req.user.tenantId, 'shop_created');
    return res.status(201).json({ ok: true, shop: serializeShop(shopRow) });
  });

  app.patch('/api/admin/shops/:id', requireAuth(['admin']), (req, res) => {
    const shopId = Number(req.params.id);
    const existing = db.get(
      'SELECT * FROM shops WHERE id = ? AND tenant_id = ?',
      shopId,
      req.user.tenantId
    );
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'İşletme/şube bulunamadı.' });
    }

    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : existing.name;
    const groupId =
      b.groupId !== undefined || b.group_id !== undefined
        ? (b.groupId ?? b.group_id) ? Number(b.groupId ?? b.group_id) : null
        : existing.group_id;
    const brandTag =
      b.brandTag !== undefined || b.brand_tag !== undefined
        ? String(b.brandTag ?? b.brand_tag).trim()
        : existing.brand_tag;
    const phone = b.phone !== undefined ? normalizePhone(b.phone) : existing.phone;
    const address = b.address !== undefined ? String(b.address).trim() : existing.address;
    const lat =
      b.lat !== undefined ? (b.lat === null || b.lat === '' ? null : Number(b.lat)) : existing.lat;
    const lng =
      b.lng !== undefined ? (b.lng === null || b.lng === '' ? null : Number(b.lng)) : existing.lng;
    const rawTariff = b.tariffMode ?? b.tariff_mode;
    const tariffMode =
      rawTariff && ['km', 'zone', 'percent'].includes(rawTariff) ? rawTariff : existing.tariff_mode;
    const baseFee =
      b.baseFee !== undefined || b.base_fee !== undefined
        ? round2(Number(b.baseFee ?? b.base_fee))
        : existing.base_fee;
    const perKmFee =
      b.perKmFee !== undefined || b.per_km_fee !== undefined
        ? round2(Number(b.perKmFee ?? b.per_km_fee))
        : existing.per_km_fee;
    const commissionPct =
      b.commissionPct !== undefined || b.commission_pct !== undefined
        ? round2(Number(b.commissionPct ?? b.commission_pct))
        : existing.commission_pct;
    const autoPrint =
      b.autoPrint !== undefined || b.auto_print !== undefined
        ? Boolean(b.autoPrint ?? b.auto_print)
          ? 1
          : 0
        : existing.auto_print;

    db.run(
      `UPDATE shops
       SET group_id = ?, name = ?, brand_tag = ?, phone = ?, address = ?, lat = ?, lng = ?,
           tariff_mode = ?, base_fee = ?, per_km_fee = ?, commission_pct = ?, auto_print = ?
       WHERE id = ? AND tenant_id = ?`,
      groupId,
      name,
      brandTag,
      phone,
      address,
      lat,
      lng,
      tariffMode,
      baseFee,
      perKmFee,
      commissionPct,
      autoPrint,
      shopId,
      req.user.tenantId
    );

    const updated = db.get('SELECT * FROM shops WHERE id = ?', shopId);
    broadcastTenantUpdate(req.user.tenantId, 'shop_updated');
    return res.json({ ok: true, shop: serializeShop(updated) });
  });

  app.post('/api/admin/zones', requireAuth(['admin']), (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Bölge adı zorunludur.' });

    const ins = db.run(
      `INSERT INTO zones (tenant_id, name, min_km, max_km, shop_fee, courier_fee)
       VALUES (?, ?, ?, ?, ?, ?)`,
      req.user.tenantId,
      name,
      round2(Number(b.minKm ?? b.min_km ?? 0)),
      round2(Number(b.maxKm ?? b.max_km ?? 5)),
      round2(Number(b.shopFee ?? b.shop_fee ?? 50)),
      round2(Number(b.courierFee ?? b.courier_fee ?? 38))
    );
    const zone = serializeZone(db.get('SELECT * FROM zones WHERE id = ?', ins.lastInsertRowid));
    broadcastTenantUpdate(req.user.tenantId, 'zone_created');
    return res.status(201).json({ ok: true, zone });
  });

  app.patch('/api/admin/zones/:id', requireAuth(['admin']), (req, res) => {
    const zoneId = Number(req.params.id);
    const existing = db.get(
      'SELECT * FROM zones WHERE id = ? AND tenant_id = ?',
      zoneId,
      req.user.tenantId
    );
    if (!existing) return res.status(404).json({ ok: false, error: 'Bölge bulunamadı.' });

    const b = req.body || {};
    db.run(
      `UPDATE zones
       SET name = ?, min_km = ?, max_km = ?, shop_fee = ?, courier_fee = ?
       WHERE id = ? AND tenant_id = ?`,
      b.name !== undefined ? String(b.name).trim() : existing.name,
      b.minKm !== undefined || b.min_km !== undefined
        ? round2(Number(b.minKm ?? b.min_km))
        : existing.min_km,
      b.maxKm !== undefined || b.max_km !== undefined
        ? round2(Number(b.maxKm ?? b.max_km))
        : existing.max_km,
      b.shopFee !== undefined || b.shop_fee !== undefined
        ? round2(Number(b.shopFee ?? b.shop_fee))
        : existing.shop_fee,
      b.courierFee !== undefined || b.courier_fee !== undefined
        ? round2(Number(b.courierFee ?? b.courier_fee))
        : existing.courier_fee,
      zoneId,
      req.user.tenantId
    );
    const updated = serializeZone(db.get('SELECT * FROM zones WHERE id = ?', zoneId));
    broadcastTenantUpdate(req.user.tenantId, 'zone_updated');
    return res.json({ ok: true, zone: updated });
  });

  app.post('/api/admin/couriers', requireAuth(['admin']), (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const phone = normalizePhone(b.phone || '');
    if (!name || !phone) {
      return res.status(400).json({ ok: false, error: 'Kurye adı ve telefon numarası zorunludur.' });
    }

    const tenant = db.get('SELECT * FROM tenants WHERE id = ?', req.user.tenantId);
    const vehicleType = String(b.vehicleType ?? b.vehicle_type ?? 'Motosiklet').trim();
    const hasPos = b.hasPos ?? b.has_pos ? 1 : 0;
    const isOnline = b.isOnline ?? b.is_online ? 1 : 0;
    const maxBatch = Math.max(1, Number(b.maxBatch ?? b.max_batch ?? 4));
    const perPackageFee = round2(Number(b.perPackageFee ?? b.per_package_fee ?? 35));
    const perKmBonus = round2(Number(b.perKmBonus ?? b.per_km_bonus ?? 6));
    const lat = b.lat !== undefined && b.lat !== null && b.lat !== '' ? Number(b.lat) : tenant.center_lat;
    const lng = b.lng !== undefined && b.lng !== null && b.lng !== '' ? Number(b.lng) : tenant.center_lng;

    const courierRow = db.tx(() => {
      const nowIso = new Date().toISOString();
      const ins = db.run(
        `INSERT INTO couriers (tenant_id, name, phone, vehicle_type, is_online, on_break, has_pos, battery_pct, max_batch, lat, lng, per_package_fee, per_km_bonus, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, 100, ?, ?, ?, ?, ?, ?)`,
        req.user.tenantId,
        name,
        phone,
        vehicleType,
        isOnline,
        hasPos,
        maxBatch,
        lat,
        lng,
        perPackageFee,
        perKmBonus,
        nowIso
      );
      const courierId = ins.lastInsertRowid;

      const existingUser = db.get(
        'SELECT id FROM users WHERE tenant_id = ? AND phone = ?',
        req.user.tenantId,
        phone
      );
      if (!existingUser) {
        db.run(
          `INSERT INTO users (tenant_id, phone, password_hash, role, display_name, merchant_group_id, shop_id, courier_id, must_change_password)
           VALUES (?, ?, ?, 'courier', ?, NULL, NULL, ?, 0)`,
          req.user.tenantId,
          phone,
          hashPassword(String(b.password || '1234')),
          name,
          courierId
        );
      }

      return db.get('SELECT * FROM couriers WHERE id = ?', courierId);
    });

    broadcastTenantUpdate(req.user.tenantId, 'courier_created');
    return res.status(201).json({
      ok: true,
      courier: serializeCourier(courierRow, { maskGps: false, activeCount: 0 }),
    });
  });

  app.patch('/api/admin/couriers/:id', requireAuth(['admin']), (req, res) => {
    const courierId = Number(req.params.id);
    const existing = db.get(
      'SELECT * FROM couriers WHERE id = ? AND tenant_id = ?',
      courierId,
      req.user.tenantId
    );
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'Kurye bulunamadı.' });
    }

    const b = req.body || {};
    const hasOnline = b.isOnline !== undefined || b.is_online !== undefined;
    const hasBreak = b.onBreak !== undefined || b.on_break !== undefined;
    const hasPosField = b.hasPos !== undefined || b.has_pos !== undefined;

    const nextOnline = hasOnline
      ? Boolean(b.isOnline ?? b.is_online) && Number(b.isOnline ?? b.is_online) !== 0
        ? 1
        : 0
      : existing.is_online;
    const nextBreak = hasBreak
      ? Boolean(b.onBreak ?? b.on_break) && Number(b.onBreak ?? b.on_break) !== 0
        ? 1
        : 0
      : existing.on_break;
    const nextHasPos = hasPosField
      ? Boolean(b.hasPos ?? b.has_pos) && Number(b.hasPos ?? b.has_pos) !== 0
        ? 1
        : 0
      : existing.has_pos;

    const nowIso = new Date().toISOString();
    db.run(
      `UPDATE couriers
       SET name = ?,
           phone = ?,
           vehicle_type = ?,
           is_online = ?,
           on_break = ?,
           has_pos = ?,
           battery_pct = ?,
           max_batch = ?,
           lat = ?,
           lng = ?,
           per_package_fee = ?,
           per_km_bonus = ?,
           updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
      b.name !== undefined ? String(b.name).trim() : existing.name,
      b.phone !== undefined ? normalizePhone(b.phone) : existing.phone,
      b.vehicleType !== undefined || b.vehicle_type !== undefined
        ? String(b.vehicleType ?? b.vehicle_type).trim()
        : existing.vehicle_type,
      nextOnline,
      nextBreak,
      nextHasPos,
      b.batteryPct !== undefined || b.battery_pct !== undefined
        ? Math.max(0, Math.min(100, Math.round(Number(b.batteryPct ?? b.battery_pct))))
        : existing.battery_pct,
      b.maxBatch !== undefined || b.max_batch !== undefined
        ? Math.max(1, Math.round(Number(b.maxBatch ?? b.max_batch)))
        : existing.max_batch,
      b.lat !== undefined ? (b.lat === null ? null : Number(b.lat)) : existing.lat,
      b.lng !== undefined ? (b.lng === null ? null : Number(b.lng)) : existing.lng,
      b.perPackageFee !== undefined || b.per_package_fee !== undefined
        ? round2(Number(b.perPackageFee ?? b.per_package_fee))
        : existing.per_package_fee,
      b.perKmBonus !== undefined || b.per_km_bonus !== undefined
        ? round2(Number(b.perKmBonus ?? b.per_km_bonus))
        : existing.per_km_bonus,
      nowIso,
      courierId,
      req.user.tenantId
    );

    if (nextOnline !== existing.is_online) {
      db.run(
        'INSERT INTO courier_shifts (tenant_id, courier_id, action, created_at) VALUES (?, ?, ?, ?)',
        req.user.tenantId,
        courierId,
        nextOnline === 1 ? 'shift_start' : 'shift_end',
        nowIso
      );
    }

    const updated = db.get('SELECT * FROM couriers WHERE id = ?', courierId);
    const activeLoadMap = getActiveLoadByCourierMap(req.user.tenantId);
    broadcastTenantUpdate(req.user.tenantId, 'courier_updated');

    return res.json({
      ok: true,
      courier: serializeCourier(updated, {
        maskGps: false,
        activeCount: activeLoadMap.get(courierId) || 0,
      }),
    });
  });

  /**
   * KRİTİK KURAL (Kurye Çevrimiçi Kilidi):
   * Kurye yalnızca lat/lng/batteryPct gönderdiğinde is_online ASLA kendiliğinden 1 olmaz!
   */
  app.post('/api/courier/status', requireAuth(['courier']), (req, res) => {
    const courierRow = db.get(
      'SELECT * FROM couriers WHERE id = ? AND tenant_id = ?',
      req.user.courierId,
      req.user.tenantId
    );
    if (!courierRow) {
      return res.status(404).json({ ok: false, error: 'Kurye kaydı bulunamadı.' });
    }

    const b = req.body || {};
    const hasExplicitOnline = Object.prototype.hasOwnProperty.call(b, 'isOnline') ||
      Object.prototype.hasOwnProperty.call(b, 'is_online');
    const hasExplicitBreak = Object.prototype.hasOwnProperty.call(b, 'onBreak') ||
      Object.prototype.hasOwnProperty.call(b, 'on_break');

    let nextOnline = courierRow.is_online;
    if (hasExplicitOnline) {
      const raw = b.isOnline ?? b.is_online;
      nextOnline = raw === true || Number(raw) === 1 ? 1 : 0;
    }

    let nextBreak = courierRow.on_break;
    if (hasExplicitBreak) {
      const raw = b.onBreak ?? b.on_break;
      nextBreak = raw === true || Number(raw) === 1 ? 1 : 0;
    }

    const nextBattery =
      b.batteryPct !== undefined || b.battery_pct !== undefined || b.battery !== undefined
        ? Math.max(0, Math.min(100, Math.round(Number(b.batteryPct ?? b.battery_pct ?? b.battery))))
        : courierRow.battery_pct;

    const nextLat =
      b.lat !== undefined && b.lat !== null && b.lat !== '' ? Number(b.lat) : courierRow.lat;
    const nextLng =
      b.lng !== undefined && b.lng !== null && b.lng !== '' ? Number(b.lng) : courierRow.lng;

    const nowIso = new Date().toISOString();
    db.run(
      `UPDATE couriers
       SET is_online = ?,
           on_break = ?,
           battery_pct = ?,
           lat = ?,
           lng = ?,
           updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
      nextOnline,
      nextBreak,
      nextBattery,
      nextLat,
      nextLng,
      nowIso,
      courierRow.id,
      req.user.tenantId
    );

    if (hasExplicitOnline && nextOnline !== courierRow.is_online) {
      db.run(
        'INSERT INTO courier_shifts (tenant_id, courier_id, action, created_at) VALUES (?, ?, ?, ?)',
        req.user.tenantId,
        courierRow.id,
        nextOnline === 1 ? 'shift_start' : 'shift_end',
        nowIso
      );
    } else if (hasExplicitBreak && nextBreak !== courierRow.on_break) {
      db.run(
        'INSERT INTO courier_shifts (tenant_id, courier_id, action, created_at) VALUES (?, ?, ?, ?)',
        req.user.tenantId,
        courierRow.id,
        nextBreak === 1 ? 'break_start' : 'break_end',
        nowIso
      );
    }

    const updated = db.get('SELECT * FROM couriers WHERE id = ?', courierRow.id);
    const activeLoadMap = getActiveLoadByCourierMap(req.user.tenantId);
    broadcastTenantUpdate(req.user.tenantId, 'courier_status');

    return res.json({
      ok: true,
      courier: serializeCourier(updated, {
        maskGps: false,
        activeCount: activeLoadMap.get(courierRow.id) || 0,
      }),
    });
  });

  // ============================================================================
  // SÜRESİZ KONTÖR CÜZDANI, BEKLEYEN SİPARİŞ ONAYI & YAZDIRMA KUYRUĞU
  // ============================================================================

  app.post('/api/admin/credits/topup', requireAuth(['admin']), (req, res) => {
    const b = req.body || {};
    const delta = Math.trunc(Number(b.amount ?? b.credits ?? b.delta ?? 0));
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ ok: false, error: 'Geçerli bir kontör miktarı giriniz.' });
    }
    const note = String(b.note || 'Kontör Yükleme').trim();
    const idempotencyKey = b.idempotencyKey || b.idempotency_key
      ? String(b.idempotencyKey || b.idempotency_key).trim()
      : `topup-${req.user.tenantId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

    const result = db.tx(() => {
      const existingEntry = db.get(
        'SELECT * FROM credit_ledger WHERE idempotency_key = ?',
        idempotencyKey
      );
      if (existingEntry) {
        const currentTenant = db.get('SELECT * FROM tenants WHERE id = ?', req.user.tenantId);
        return {
          duplicate: true,
          tenant: serializeTenant(currentTenant),
          entry: serializeCreditEntry(existingEntry),
        };
      }

      const tenantRow = db.get('SELECT * FROM tenants WHERE id = ?', req.user.tenantId);
      const nextBalance = Math.max(0, Number(tenantRow.credits_balance) + delta);
      const actualDelta = nextBalance - Number(tenantRow.credits_balance);
      const nowIso = new Date().toISOString();

      db.run(
        'UPDATE tenants SET credits_balance = ? WHERE id = ?',
        nextBalance,
        req.user.tenantId
      );
      const ins = db.run(
        `INSERT INTO credit_ledger (tenant_id, delta, balance_after, reason, order_id, note, idempotency_key, created_at)
         VALUES (?, ?, ?, 'topup', NULL, ?, ?, ?)`,
        req.user.tenantId,
        actualDelta,
        nextBalance,
        note,
        idempotencyKey,
        nowIso
      );

      return {
        duplicate: false,
        tenant: serializeTenant(db.get('SELECT * FROM tenants WHERE id = ?', req.user.tenantId)),
        entry: serializeCreditEntry(
          db.get('SELECT * FROM credit_ledger WHERE id = ?', ins.lastInsertRowid)
        ),
      };
    });

    broadcastTenantUpdate(req.user.tenantId, 'credits_topup');
    return res.json({ ok: true, ...result });
  });

  app.post('/api/admin/credits/toggle', requireAuth(['admin']), (req, res) => {
    const raw = req.body?.enabled ?? req.body?.creditsEnabled;
    const enabled = raw === true || Number(raw) === 1 ? 1 : 0;
    db.run('UPDATE tenants SET credits_enabled = ? WHERE id = ?', enabled, req.user.tenantId);
    const tenant = serializeTenant(db.get('SELECT * FROM tenants WHERE id = ?', req.user.tenantId));
    broadcastTenantUpdate(req.user.tenantId, 'credits_toggled');
    return res.json({ ok: true, tenant });
  });

  app.post('/api/admin/orders/:id/release-credit', requireAuth(['admin']), (req, res) => {
    const orderId = Number(req.params.id);
    try {
      const outcome = db.tx(() => {
        const orderRow = db.get(
          'SELECT * FROM orders WHERE id = ? AND tenant_id = ?',
          orderId,
          req.user.tenantId
        );
        if (!orderRow) {
          const err = new Error('Sipariş bulunamadı.');
          err.statusCode = 404;
          throw err;
        }
        if (orderRow.status !== 'pending_credit') {
          return {
            order: orderRow,
            tenant: db.get('SELECT * FROM tenants WHERE id = ?', req.user.tenantId),
          };
        }

        const tenantRow = db.get('SELECT * FROM tenants WHERE id = ?', req.user.tenantId);
        const creditsEnabled = Number(tenantRow.credits_enabled) === 1;
        if (creditsEnabled && Number(tenantRow.credits_balance) <= 0) {
          const err = new Error('Siparişi havuza almak için yeterli kontör bakiyesi yok.');
          err.statusCode = 400;
          throw err;
        }

        const nowIso = new Date().toISOString();
        let creditConsumed = orderRow.credit_consumed;
        if (creditsEnabled && Number(orderRow.credit_consumed) === 0) {
          const nextBalance = Number(tenantRow.credits_balance) - 1;
          db.run(
            'UPDATE tenants SET credits_balance = ? WHERE id = ?',
            nextBalance,
            req.user.tenantId
          );
          db.run(
            `INSERT INTO credit_ledger (tenant_id, delta, balance_after, reason, order_id, note, idempotency_key, created_at)
             VALUES (?, -1, ?, 'order_release_consume', ?, ?, ?, ?)`,
            req.user.tenantId,
            nextBalance,
            orderRow.id,
            `Bekleyen sipariş #${orderRow.id} havuza alındı`,
            `release-order-${orderRow.id}`,
            nowIso
          );
          creditConsumed = 1;
        }

        db.run(
          `UPDATE orders SET status = 'pending', credit_consumed = ? WHERE id = ? AND tenant_id = ?`,
          creditConsumed,
          orderRow.id,
          req.user.tenantId
        );

        const shop = db.get('SELECT * FROM shops WHERE id = ?', orderRow.shop_id);
        if (shop && Number(shop.auto_print) === 1) {
          db.run(
            `INSERT INTO print_jobs (tenant_id, shop_id, order_id, status, created_at)
             VALUES (?, ?, ?, 'queued', ?)`,
            req.user.tenantId,
            shop.id,
            orderRow.id,
            nowIso
          );
        }

        return {
          order: db.get('SELECT * FROM orders WHERE id = ?', orderRow.id),
          tenant: db.get('SELECT * FROM tenants WHERE id = ?', req.user.tenantId),
        };
      });

      const shop = db.get('SELECT * FROM shops WHERE id = ?', outcome.order.shop_id);
      broadcastTenantUpdate(req.user.tenantId, 'order_credit_released');

      return res.json({
        ok: true,
        order: serializeOrder(outcome.order, {
          shopMap: shop ? new Map([[shop.id, shop]]) : null,
          maskCourierGps: false,
        }),
        tenant: serializeTenant(outcome.tenant),
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({
        ok: false,
        error: err.message || 'Sipariş serbest bırakılamadı.',
      });
    }
  });

  app.post('/api/print-jobs/:id/printed', requireAuth(['admin', 'merchant']), (req, res) => {
    const jobId = Number(req.params.id);
    const job = db.get(
      'SELECT * FROM print_jobs WHERE id = ? AND tenant_id = ?',
      jobId,
      req.user.tenantId
    );
    if (!job) return res.status(404).json({ ok: false, error: 'Yazdırma işi bulunamadı.' });
    const nowIso = new Date().toISOString();
    db.run(
      `UPDATE print_jobs SET status = 'printed', printed_at = ? WHERE id = ?`,
      nowIso,
      jobId
    );
    broadcastTenantUpdate(req.user.tenantId, 'print_job_completed');
    return res.json({
      ok: true,
      printJob: serializePrintJob(db.get('SELECT * FROM print_jobs WHERE id = ?', jobId)),
    });
  });

  // ============================================================================
  // GÜN SONU KASA & CARİ MUTABAKAT (/api/admin/reconciliation)
  // ============================================================================

  app.get('/api/admin/reconciliation', requireAuth(['admin']), (req, res) => {
    const requestedDate = req.query.date ? String(req.query.date).trim() : null;
    const allOrders = db.all(
      'SELECT * FROM orders WHERE tenant_id = ? ORDER BY id DESC',
      req.user.tenantId
    );

    const filteredOrders = requestedDate
      ? allOrders.filter((o) => {
          const cDate = String(o.created_at || '').slice(0, 10);
          const dDate = String(o.delivered_at || '').slice(0, 10);
          return cDate === requestedDate || dDate === requestedDate;
        })
      : allOrders;

    const shops = db.all('SELECT * FROM shops WHERE tenant_id = ? ORDER BY id ASC', req.user.tenantId);
    const groups = db.all(
      'SELECT * FROM merchant_groups WHERE tenant_id = ?',
      req.user.tenantId
    );
    const groupMap = new Map(groups.map((g) => [g.id, g.name]));
    const couriers = db.all(
      'SELECT * FROM couriers WHERE tenant_id = ? ORDER BY id ASC',
      req.user.tenantId
    );

    const deliveredOrders = filteredOrders.filter((o) => o.status === 'delivered');
    const cancelledOrders = filteredOrders.filter((o) => o.status === 'cancelled');
    const activeOrders = filteredOrders.filter((o) =>
      ['pending', 'assigned', 'picked_up', 'pending_credit'].includes(o.status)
    );

    const courierReports = couriers.map((c) => {
      const cDelivered = deliveredOrders.filter((o) => o.courier_id === c.id);
      const cashCollected = round2(
        cDelivered
          .filter((o) => o.payment_method === 'cash')
          .reduce((sum, o) => sum + Number(o.order_amount || 0), 0)
      );
      const posCollected = round2(
        cDelivered
          .filter((o) => o.payment_method === 'card_on_delivery')
          .reduce((sum, o) => sum + Number(o.order_amount || 0), 0)
      );
      const onlineVolume = round2(
        cDelivered
          .filter((o) => o.payment_method === 'online_paid')
          .reduce((sum, o) => sum + Number(o.order_amount || 0), 0)
      );
      const totalEarning = round2(
        cDelivered.reduce((sum, o) => sum + Number(o.courier_earning || 0), 0)
      );
      const netCashHandover = round2(cashCollected - totalEarning);

      return {
        courierId: c.id,
        id: c.id,
        name: c.name,
        phone: c.phone,
        vehicleType: c.vehicle_type,
        hasPos: Number(c.has_pos) === 1,
        deliveredCount: cDelivered.length,
        cashCollected,
        posCollected,
        onlineVolume,
        totalEarning,
        netCashHandover,
      };
    });

    const shopReports = shops.map((s) => {
      const sDelivered = deliveredOrders.filter((o) => o.shop_id === s.id);
      const sAll = filteredOrders.filter((o) => o.shop_id === s.id && o.status !== 'cancelled');
      const grossSales = round2(
        sDelivered.reduce((sum, o) => sum + Number(o.order_amount || 0), 0)
      );
      const cashSales = round2(
        sDelivered
          .filter((o) => o.payment_method === 'cash')
          .reduce((sum, o) => sum + Number(o.order_amount || 0), 0)
      );
      const posSales = round2(
        sDelivered
          .filter((o) => o.payment_method === 'card_on_delivery')
          .reduce((sum, o) => sum + Number(o.order_amount || 0), 0)
      );
      const onlineSales = round2(
        sDelivered
          .filter((o) => o.payment_method === 'online_paid')
          .reduce((sum, o) => sum + Number(o.order_amount || 0), 0)
      );
      const totalDeliveryFee = round2(
        sDelivered.reduce((sum, o) => sum + Number(o.delivery_fee || 0), 0)
      );
      const collectedByCouriers = round2(cashSales + posSales);
      const netPayableToShop = round2(collectedByCouriers - totalDeliveryFee);

      return {
        shopId: s.id,
        id: s.id,
        name: s.name,
        brandTag: s.brand_tag,
        groupId: s.group_id,
        groupName: s.group_id ? groupMap.get(s.group_id) || null : null,
        totalOrderCount: sAll.length,
        deliveredCount: sDelivered.length,
        grossSales,
        cashSales,
        posSales,
        onlineSales,
        totalDeliveryFee,
        collectedByCouriers,
        netPayableToShop,
      };
    });

    const cashCollected = round2(
      deliveredOrders
        .filter((o) => o.payment_method === 'cash')
        .reduce((sum, o) => sum + Number(o.order_amount || 0), 0)
    );
    const posCollected = round2(
      deliveredOrders
        .filter((o) => o.payment_method === 'card_on_delivery')
        .reduce((sum, o) => sum + Number(o.order_amount || 0), 0)
    );
    const onlineVolume = round2(
      deliveredOrders
        .filter((o) => o.payment_method === 'online_paid')
        .reduce((sum, o) => sum + Number(o.order_amount || 0), 0)
    );
    const totalOrderVolume = round2(cashCollected + posCollected + onlineVolume);
    const totalDeliveryFees = round2(
      deliveredOrders.reduce((sum, o) => sum + Number(o.delivery_fee || 0), 0)
    );
    const totalCourierEarnings = round2(
      deliveredOrders.reduce((sum, o) => sum + Number(o.courier_earning || 0), 0)
    );
    const netOperationProfit = round2(totalDeliveryFees - totalCourierEarnings);

    return res.json({
      ok: true,
      date: requestedDate || new Date().toISOString().slice(0, 10),
      summary: {
        totalOrders: filteredOrders.length,
        deliveredCount: deliveredOrders.length,
        cancelledCount: cancelledOrders.length,
        activeCount: activeOrders.length,
        cashCollected,
        posCollected,
        onlineVolume,
        totalOrderVolume,
        totalDeliveryFees,
        totalCourierEarnings,
        netOperationProfit,
      },
      couriers: courierReports,
      shops: shopReports,
      orders: deliveredOrders.map((o) =>
        serializeOrder(o, {
          shopMap: new Map(shops.map((s) => [s.id, s])),
          courierMap: new Map(couriers.map((c) => [c.id, c])),
          maskCourierGps: false,
        })
      ),
    });
  });

  // Bilinmeyen /api/* isteklerine temiz JSON 404 döndür
  app.use('/api', (_req, res) => {
    res.status(404).json({
      ok: false,
      error: 'İstenen API uç noktası bulunamadı.',
    });
  });

  // Statik dosyalar ve SPA yönlendirmeleri
  app.use(express.static(PUBLIC_DIR));

  const spaRoutes = [
    '/',
    '/vitrin',
    '/panel',
    '/panel/*',
    '/isletme',
    '/isletme/*',
    '/kurye',
    '/kurye/*',
    '/takip/:code',
    '/takip/*',
  ];

  app.get(spaRoutes, (_req, res) => {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res
      .status(200)
      .send('<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8"><title>PAKETÜS</title></head><body><h1>PAKETÜS Hazırlanıyor...</h1></body></html>');
  });

  app.locals.db = db;
  return app;
}

let defaultAppInstance = null;
function getDefaultApp() {
  if (!defaultAppInstance) {
    defaultAppInstance = createApp();
  }
  return defaultAppInstance;
}

function startServer(port = process.env.PORT || 3000, options = {}) {
  const targetApp = options.app || (options.dbPath || options.db ? createApp(options) : getDefaultApp());
  return new Promise((resolve, reject) => {
    const srv = http.createServer(targetApp);
    srv.listen(Number(port), (err) => {
      if (err) return reject(err);
      resolve(srv);
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  startServer(port)
    .then((srv) => {
      const addr = srv.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      console.log(`[PAKETÜS] Kurumsal Kurye & Akıllı Rota Sunucusu aktif -> http://localhost:${actualPort}`);
    })
    .catch((err) => {
      console.error('[PAKETÜS] Sunucu başlatma hatası:', err);
      process.exit(1);
    });
}

const exported = {
  createApp,
  startServer,
};

Object.defineProperty(exported, 'app', {
  enumerable: true,
  get() {
    return getDefaultApp();
  },
});

module.exports = exported;
