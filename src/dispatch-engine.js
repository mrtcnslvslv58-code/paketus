'use strict';

const EARTH_RADIUS_KM = 6371;
const ROAD_FACTOR = 1.28;
const MAX_SHOP_CLUSTER_KM = 0.8;
const MAX_CORRIDOR_ANGLE_DEG = 38;
const MAX_DEST_PROXIMITY_KM = 1.6;
const DEFAULT_MAX_BATCH_SIZE = 3;

function round2(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

function isValidCoord(lat, lng) {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return false;
  if (lat === '' || lng === '') return false;
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return false;
  if (nLat === 0 && nLng === 0) return false;
  return Math.abs(nLat) <= 90 && Math.abs(nLng) <= 180;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * İki GPS noktası arasındaki kuş uçuşu Haversine mesafesini (km) hesaplar.
 * Koordinatlardan biri eksikse 0 döndürür (şehir merkezini varsaymaz).
 */
function haversineKm(lat1, lng1, lat2, lng2) {
  if (!isValidCoord(lat1, lng1) || !isValidCoord(lat2, lng2)) {
    return 0;
  }
  const nLat1 = Number(lat1);
  const nLng1 = Number(lng1);
  const nLat2 = Number(lat2);
  const nLng2 = Number(lng2);

  const dLat = toRad(nLat2 - nLat1);
  const dLng = toRad(nLng2 - nLng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(nLat1)) * Math.cos(toRad(nLat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return EARTH_RADIUS_KM * c;
}

/**
 * Tahmini şehir içi karayolu mesafesi: round2(haversineKm * 1.28).
 * Dükkan veya hedef pini yoksa 0 döndürür.
 */
function estimateRoadKm(lat1, lng1, lat2, lng2) {
  const straight = haversineKm(lat1, lng1, lat2, lng2);
  if (straight <= 0) return 0;
  return round2(straight * ROAD_FACTOR);
}

/**
 * İki nokta arasındaki yön açısını (0..360 derece) hesaplar.
 */
function computeBearingDeg(lat1, lng1, lat2, lng2) {
  if (!isValidCoord(lat1, lng1) || !isValidCoord(lat2, lng2)) return null;
  const phi1 = toRad(Number(lat1));
  const phi2 = toRad(Number(lat2));
  const dLambda = toRad(Number(lng2) - Number(lng1));

  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12) return 0;
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDiffDeg(b1, b2) {
  if (b1 === null || b2 === null || !Number.isFinite(b1) || !Number.isFinite(b2)) {
    return Infinity;
  }
  const diff = Math.abs(b1 - b2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Dinamik Fiyat & Hakediş Motoru
 * Hem tek nesne ({ shop, zones, courier, distanceKm, orderAmount, orderType })
 * hem de konumsal (orderOrOpts, shop, zones, courier) çağrıyı destekler.
 */
function calculateOrderPricing(input = {}, shopArg = null, zonesArg = null, courierArg = null) {
  const opts = input && typeof input === 'object' ? input : {};
  const shop = shopArg || opts.shop || null;
  const zones = Array.isArray(zonesArg) ? zonesArg : Array.isArray(opts.zones) ? opts.zones : [];
  const courier = courierArg || opts.courier || null;

  const orderType = opts.orderType || opts.order_type || 'delivery';
  if (orderType === 'takeaway' || orderType === 'dine_in') {
    return {
      distanceKm: 0,
      distance_km: 0,
      deliveryFee: 0,
      delivery_fee: 0,
      courierEarning: 0,
      courier_earning: 0,
      zoneName: null,
      tariffMode: shop?.tariff_mode || shop?.tariffMode || 'km',
    };
  }

  let distanceKm = Number(opts.distanceKm ?? opts.distance_km ?? 0);
  if (!Number.isFinite(distanceKm) || distanceKm < 0) distanceKm = 0;

  if (distanceKm <= 0) {
    const sLat = shop?.lat ?? opts.shopLat ?? opts.shop_lat;
    const sLng = shop?.lng ?? opts.shopLng ?? opts.shop_lng;
    const dLat = opts.destLat ?? opts.dest_lat;
    const dLng = opts.destLng ?? opts.dest_lng;
    if (isValidCoord(sLat, sLng) && isValidCoord(dLat, dLng)) {
      distanceKm = estimateRoadKm(sLat, sLng, dLat, dLng);
    }
  }
  distanceKm = round2(distanceKm);

  const orderAmount = Math.max(0, Number(opts.orderAmount ?? opts.order_amount ?? opts.amount ?? 0) || 0);
  const tariffMode = shop?.tariff_mode || shop?.tariffMode || 'km';
  const baseFee = Number(shop?.base_fee ?? shop?.baseFee ?? 45);
  const perKmFee = Number(shop?.per_km_fee ?? shop?.perKmFee ?? 10);
  const commissionPct = Number(shop?.commission_pct ?? shop?.commissionPct ?? 12);

  let matchedZone = null;
  if (zones.length > 0) {
    const sortedZones = [...zones].sort(
      (a, b) => Number(a.min_km ?? a.minKm ?? 0) - Number(b.min_km ?? b.minKm ?? 0)
    );
    matchedZone =
      sortedZones.find((z) => {
        const minKm = Number(z.min_km ?? z.minKm ?? 0);
        const maxKm = Number(z.max_km ?? z.maxKm ?? Infinity);
        return distanceKm >= minKm && distanceKm <= maxKm;
      }) || sortedZones[sortedZones.length - 1];
  }

  const includedKm = 2.0;
  const extraKm = Math.max(0, distanceKm - includedKm);

  let deliveryFee = 0;
  if (tariffMode === 'percent') {
    const pctFee = (orderAmount * commissionPct) / 100;
    deliveryFee = round2(Math.max(baseFee, pctFee));
  } else if (tariffMode === 'zone' && matchedZone) {
    deliveryFee = round2(Number(matchedZone.shop_fee ?? matchedZone.shopFee ?? baseFee));
  } else if (shop) {
    deliveryFee = round2(baseFee + extraKm * perKmFee);
  } else if (matchedZone) {
    deliveryFee = round2(Number(matchedZone.shop_fee ?? matchedZone.shopFee ?? 45));
  } else {
    deliveryFee = round2(45 + extraKm * 10);
  }

  const perPackageFee = Number(
    courier?.per_package_fee ??
      courier?.perPackageFee ??
      (matchedZone ? matchedZone.courier_fee ?? matchedZone.courierFee : null) ??
      35
  );
  const perKmBonus = Number(courier?.per_km_bonus ?? courier?.perKmBonus ?? 6);

  let courierEarning = 0;
  if (tariffMode === 'zone' && !courier && matchedZone) {
    courierEarning = round2(Number(matchedZone.courier_fee ?? matchedZone.courierFee ?? 35));
  } else {
    courierEarning = round2(perPackageFee + Math.max(0, distanceKm - 1.5) * perKmBonus);
  }

  return {
    distanceKm,
    distance_km: distanceKm,
    deliveryFee,
    delivery_fee: deliveryFee,
    courierEarning,
    courier_earning: courierEarning,
    zoneName: matchedZone?.name || null,
    tariffMode,
  };
}

function getStopPoint(stop) {
  if (!stop || typeof stop !== 'object') return null;
  const lat = stop.dest_lat ?? stop.destLat ?? stop.lat;
  const lng = stop.dest_lng ?? stop.destLng ?? stop.lng;
  if (!isValidCoord(lat, lng)) return null;
  return { lat: Number(lat), lng: Number(lng) };
}

function getOriginPoint(origin, fallbackStop) {
  if (origin && isValidCoord(origin.lat ?? origin.originLat, origin.lng ?? origin.originLng)) {
    return {
      lat: Number(origin.lat ?? origin.originLat),
      lng: Number(origin.lng ?? origin.originLng),
    };
  }
  if (fallbackStop) {
    const sLat = fallbackStop.shop_lat ?? fallbackStop.shopLat ?? fallbackStop.shop?.lat;
    const sLng = fallbackStop.shop_lng ?? fallbackStop.shopLng ?? fallbackStop.shop?.lng;
    if (isValidCoord(sLat, sLng)) {
      return { lat: Number(sLat), lng: Number(sLng) };
    }
  }
  return null;
}

function computeTourLengthKm(startPoint, orderedPoints) {
  if (orderedPoints.length === 0) return 0;
  let total = 0;
  let prev = startPoint || orderedPoints[0];
  const startIdx = startPoint ? 0 : 1;
  for (let i = startIdx; i < orderedPoints.length; i += 1) {
    total += haversineKm(prev.lat, prev.lng, orderedPoints[i].lat, orderedPoints[i].lng);
    prev = orderedPoints[i];
  }
  return total;
}

/**
 * Nearest-Neighbor + 2-opt en kısa teslimat sırası optimizasyonu.
 * optimizeStopSequence(origin, stops) veya optimizeStopSequence(stops) olarak çağrılabilir.
 */
function optimizeStopSequence(originOrStops, maybeStops) {
  let origin = null;
  let stops = [];
  if (Array.isArray(originOrStops)) {
    stops = originOrStops;
  } else {
    origin = originOrStops;
    stops = Array.isArray(maybeStops) ? maybeStops : [];
  }

  if (stops.length === 0) return [];
  if (stops.length === 1) {
    return [{ ...stops[0], route_seq: 1, routeSequence: 1 }];
  }

  const startPoint = getOriginPoint(origin, stops[0]);
  const withCoords = [];
  const withoutCoords = [];

  for (const stop of stops) {
    const pt = getStopPoint(stop);
    if (pt) {
      withCoords.push({ stop, pt });
    } else {
      withoutCoords.push(stop);
    }
  }

  if (withCoords.length <= 1) {
    return [...withCoords.map((x) => x.stop), ...withoutCoords].map((s, idx) => ({
      ...s,
      route_seq: idx + 1,
      routeSequence: idx + 1,
    }));
  }

  // 1. Nearest-Neighbor başlangıç dizilimi
  const remaining = [...withCoords];
  const tour = [];
  let cursor = startPoint || remaining[0].pt;

  if (!startPoint) {
    tour.push(remaining.shift());
    cursor = tour[0].pt;
  }

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const d = haversineKm(cursor.lat, cursor.lng, remaining[i].pt.lat, remaining[i].pt.lng);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const chosen = remaining.splice(bestIdx, 1)[0];
    tour.push(chosen);
    cursor = chosen.pt;
  }

  // 2. 2-opt yerel iyileştirme (açık rota)
  let improved = true;
  let guard = 0;
  while (improved && guard < 50) {
    improved = false;
    guard += 1;
    const currentCost = computeTourLengthKm(
      startPoint,
      tour.map((t) => t.pt)
    );

    for (let i = 0; i < tour.length - 1; i += 1) {
      for (let j = i + 1; j < tour.length; j += 1) {
        const candidate = [
          ...tour.slice(0, i),
          ...tour.slice(i, j + 1).reverse(),
          ...tour.slice(j + 1),
        ];
        const candCost = computeTourLengthKm(
          startPoint,
          candidate.map((t) => t.pt)
        );
        if (candCost + 1e-9 < currentCost) {
          tour.splice(0, tour.length, ...candidate);
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }

  const ordered = [...tour.map((t) => t.stop), ...withoutCoords];
  return ordered.map((stop, idx) => ({
    ...stop,
    route_seq: idx + 1,
    routeSequence: idx + 1,
  }));
}

function buildShopMap(shopsOrOptions) {
  const map = new Map();
  if (!shopsOrOptions) return map;
  if (shopsOrOptions instanceof Map) return shopsOrOptions;
  const list = Array.isArray(shopsOrOptions)
    ? shopsOrOptions
    : Array.isArray(shopsOrOptions.shops)
      ? shopsOrOptions.shops
      : [];
  for (const s of list) {
    if (s && s.id !== undefined) {
      map.set(Number(s.id), s);
    }
  }
  return map;
}

function resolveOrderShopCoords(order, shopMap) {
  const shopId = order.shop_id ?? order.shopId;
  const shopObj = order.shop || (shopId !== undefined ? shopMap.get(Number(shopId)) : null);
  const lat = order.shop_lat ?? order.shopLat ?? shopObj?.lat;
  const lng = order.shop_lng ?? order.shopLng ?? shopObj?.lng;
  if (isValidCoord(lat, lng)) {
    return { lat: Number(lat), lng: Number(lng), shopId: shopId !== undefined ? Number(shopId) : null };
  }
  return { lat: null, lng: null, shopId: shopId !== undefined ? Number(shopId) : null };
}

function areOrdersBatchCompatible(existingMetaList, candidateMeta) {
  for (const member of existingMetaList) {
    // 1. Dükkan yakınlığı: aynı dükkan VEYA <= 0.8 km
    const sameShop =
      member.shopId !== null &&
      candidateMeta.shopId !== null &&
      member.shopId === candidateMeta.shopId;

    let shopClose = sameShop;
    if (!shopClose && member.hasShopCoord && candidateMeta.hasShopCoord) {
      const shopDist = haversineKm(
        member.shopCoords.lat,
        member.shopCoords.lng,
        candidateMeta.shopCoords.lat,
        candidateMeta.shopCoords.lng
      );
      shopClose = shopDist <= MAX_SHOP_CLUSTER_KM;
    }
    if (!shopClose) return false;

    // 2. Yön koridoru (bearing farkı <= 38°) VEYA hedef yakınlığı (<= 1.6 km)
    if (member.hasDestCoord && candidateMeta.hasDestCoord) {
      const destDist = haversineKm(
        member.destPoint.lat,
        member.destPoint.lng,
        candidateMeta.destPoint.lat,
        candidateMeta.destPoint.lng
      );
      const bearingDiff = angleDiffDeg(member.bearing, candidateMeta.bearing);
      if (bearingDiff > MAX_CORRIDOR_ANGLE_DEG && destDist > MAX_DEST_PROXIMITY_KM) {
        return false;
      }
    } else {
      // Koordinatsız siparişlerde yalnızca aynı dükkan ve aynı dolu mahalle ise birleştir
      const n1 = String(member.order.neighborhood || '').trim().toLocaleLowerCase('tr-TR');
      const n2 = String(candidateMeta.order.neighborhood || '').trim().toLocaleLowerCase('tr-TR');
      if (!sameShop || !n1 || n1 !== n2) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Pagate Tarzı Otomatik Paket Birleştirme & Rota Optimizasyonu
 * Uygun 'pending' / 'ready' paketleri en fazla 3'lü akıllı rota gruplarına ayırır.
 */
function buildSmartBatches(orders = [], shopsOrOptions = null) {
  if (!Array.isArray(orders) || orders.length === 0) return [];

  const shopMap = buildShopMap(shopsOrOptions);
  const maxBatchSize = Number(shopsOrOptions?.maxBatchSize) || DEFAULT_MAX_BATCH_SIZE;

  const eligible = orders.filter((o) => {
    if (!o || typeof o !== 'object') return false;
    const status = o.status || 'pending';
    if (status !== 'pending' && status !== 'ready') return false;
    const orderType = o.order_type || o.orderType || 'delivery';
    return orderType === 'delivery';
  });

  const sorted = [...eligible].sort((a, b) => {
    const tA = a.created_at || a.createdAt || '';
    const tB = b.created_at || b.createdAt || '';
    if (tA && tB && tA !== tB) return tA < tB ? -1 : 1;
    return Number(a.id || 0) - Number(b.id || 0);
  });

  const metas = sorted.map((order) => {
    const shopCoords = resolveOrderShopCoords(order, shopMap);
    const destPoint = getStopPoint(order);
    const hasShopCoord = isValidCoord(shopCoords.lat, shopCoords.lng);
    const hasDestCoord = Boolean(destPoint);
    const bearing =
      hasShopCoord && hasDestCoord
        ? computeBearingDeg(shopCoords.lat, shopCoords.lng, destPoint.lat, destPoint.lng)
        : null;
    return {
      order,
      shopId: shopCoords.shopId,
      shopCoords,
      hasShopCoord,
      destPoint,
      hasDestCoord,
      bearing,
    };
  });

  const usedIdx = new Set();
  const rawClusters = [];

  for (let i = 0; i < metas.length; i += 1) {
    if (usedIdx.has(i)) continue;
    usedIdx.add(i);
    const groupMetas = [metas[i]];

    for (let j = i + 1; j < metas.length && groupMetas.length < maxBatchSize; j += 1) {
      if (usedIdx.has(j)) continue;
      if (areOrdersBatchCompatible(groupMetas, metas[j])) {
        groupMetas.push(metas[j]);
        usedIdx.add(j);
      }
    }

    rawClusters.push(groupMetas);
  }

  const batches = rawClusters.map((cluster, idx) => {
    const firstWithShop = cluster.find((m) => m.hasShopCoord) || cluster[0];
    const origin = firstWithShop.hasShopCoord
      ? { lat: firstWithShop.shopCoords.lat, lng: firstWithShop.shopCoords.lng }
      : null;

    const optimizedOrders = optimizeStopSequence(
      origin,
      cluster.map((m) => m.order)
    );

    const stopPoints = optimizedOrders.map(getStopPoint).filter(Boolean);
    const roadKm = round2(computeTourLengthKm(origin, stopPoints) * ROAD_FACTOR);
    const requiresPos = optimizedOrders.some(
      (o) => (o.payment_method || o.paymentMethod) === 'card_on_delivery'
    );
    const shopIds = [
      ...new Set(
        optimizedOrders
          .map((o) => o.shop_id ?? o.shopId)
          .filter((v) => v !== null && v !== undefined)
          .map(Number)
      ),
    ];

    const idPart = optimizedOrders.map((o) => o.id || idx + 1).join('-');
    const batchId = `BATCH-${idPart}`;

    return {
      batchId,
      batch_id: batchId,
      size: optimizedOrders.length,
      orderCount: optimizedOrders.length,
      isCombined: optimizedOrders.length > 1,
      requiresPos,
      requires_pos: requiresPos,
      shopIds,
      originLat: origin ? origin.lat : null,
      originLng: origin ? origin.lng : null,
      estimatedTotalKm: roadKm,
      estimated_total_km: roadKm,
      orders: optimizedOrders,
      orderIds: optimizedOrders.map((o) => o.id),
    };
  });

  // Birleştirilmiş çoklu paket gruplarını önce döndür, ardından tekil paketleri FIFO koru
  batches.sort((a, b) => {
    if (a.isCombined !== b.isCombined) return a.isCombined ? -1 : 1;
    return 0;
  });

  return batches;
}

/**
 * POS Cihazı, Çevrimiçi/Mola Kilidi, Kapasite, Mesafe ve Batarya Skoruna Göre En Uygun Kurye Seçimi
 */
function chooseBestCourierForBatch(batchOrOrders, couriers = [], activeLoadByCourier = null) {
  if (!Array.isArray(couriers) || couriers.length === 0 || !batchOrOrders) {
    return null;
  }

  const orders = Array.isArray(batchOrOrders)
    ? batchOrOrders
    : Array.isArray(batchOrOrders.orders)
      ? batchOrOrders.orders
      : [batchOrOrders];

  if (orders.length === 0) return null;

  const batchSize = orders.length;
  const requiresPos =
    Boolean(batchOrOrders.requiresPos || batchOrOrders.requires_pos) ||
    orders.some((o) => (o?.payment_method || o?.paymentMethod) === 'card_on_delivery');

  let originLat = batchOrOrders.originLat ?? batchOrOrders.origin_lat ?? null;
  let originLng = batchOrOrders.originLng ?? batchOrOrders.origin_lng ?? null;
  if (!isValidCoord(originLat, originLng)) {
    const firstOrder = orders[0] || {};
    originLat = firstOrder.shop_lat ?? firstOrder.shopLat ?? firstOrder.shop?.lat ?? null;
    originLng = firstOrder.shop_lng ?? firstOrder.shopLng ?? firstOrder.shop?.lng ?? null;
  }
  const hasOrigin = isValidCoord(originLat, originLng);

  const candidates = [];

  for (const courier of couriers) {
    if (!courier || typeof courier !== 'object') continue;

    const isOnlineRaw = courier.is_online ?? courier.isOnline ?? 0;
    const onBreakRaw = courier.on_break ?? courier.onBreak ?? 0;
    const hasPosRaw = courier.has_pos ?? courier.hasPos ?? 0;

    const isOnline = isOnlineRaw === true || Number(isOnlineRaw) === 1;
    const onBreak = onBreakRaw === true || Number(onBreakRaw) === 1;
    const hasPos = hasPosRaw === true || Number(hasPosRaw) === 1;

    // 1. Yalnızca çevrimiçi ve molada olmayan kuryeler
    if (!isOnline || onBreak) continue;

    // 2. KRİTİK POS KURALI: Grupta kapıda kart varsa YALNIZCA POS cihazlı kurye seçilebilir
    if (requiresPos && !hasPos) continue;

    // 3. Kapasite kontrolü
    const maxBatch = Number(courier.max_batch ?? courier.maxBatch ?? 4);
    let activeCount = 0;
    if (activeLoadByCourier && typeof activeLoadByCourier === 'object') {
      if (activeLoadByCourier instanceof Map) {
        activeCount = Number(activeLoadByCourier.get(courier.id) || 0);
      } else if (activeLoadByCourier[courier.id] !== undefined) {
        activeCount = Number(activeLoadByCourier[courier.id] || 0);
      }
    } else {
      activeCount = Number(
        courier.active_orders_count ??
          courier.activeOrdersCount ??
          courier.active_count ??
          courier.activeCount ??
          courier.activeLoad ??
          0
      );
    }

    if (activeCount + batchSize > maxBatch) continue;

    const cLat = courier.lat;
    const cLng = courier.lng;
    const pickupDistanceKm =
      hasOrigin && isValidCoord(cLat, cLng)
        ? estimateRoadKm(cLat, cLng, originLat, originLng)
        : 2.0;

    const batteryPct = Number(
      courier.battery_pct ?? courier.batteryPct ?? courier.battery ?? 100
    );
    const batteryPenalty = batteryPct < 15 ? -25 : 0;

    const score = round2(
      100 - pickupDistanceKm * 12 - activeCount * 15 + batteryPct * 0.2 + batteryPenalty
    );

    candidates.push({
      courier,
      score,
      pickupDistanceKm,
      activeCount,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return Number(a.courier.id || 0) - Number(b.courier.id || 0);
  });

  const best = candidates[0];
  return {
    ...best.courier,
    dispatchScore: best.score,
    pickupDistanceKm: best.pickupDistanceKm,
  };
}

module.exports = {
  haversineKm,
  estimateRoadKm,
  calculateOrderPricing,
  buildSmartBatches,
  chooseBestCourierForBatch,
  optimizeStopSequence,
};
