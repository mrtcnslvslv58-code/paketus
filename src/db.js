'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { estimateRoadKm, calculateOrderPricing } = require('./dispatch-engine');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'paketus.sqlite');

function normalizePhone(raw) {
  if (raw === null || raw === undefined) return '';
  const digits = String(raw).replace(/\D+/g, '');
  if (!digits) return String(raw).trim();
  if (digits.length === 12 && digits.startsWith('90')) {
    return '0' + digits.slice(2);
  }
  if (digits.length === 10 && !digits.startsWith('0')) {
    return '0' + digits;
  }
  return digits;
}

function hashPassword(password) {
  const plain = String(password ?? '');
  const salt = crypto.randomBytes(12).toString('hex');
  const derived = crypto.scryptSync(plain, salt, 32, { N: 1024, r: 8, p: 1 }).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const plain = String(password ?? '');
  if (!storedHash.startsWith('scrypt$')) {
    return plain === storedHash;
  }
  const parts = storedHash.split('$');
  if (parts.length !== 3) return false;
  const [, salt, hexDigest] = parts;
  const derived = crypto.scryptSync(plain, salt, 32, { N: 1024, r: 8, p: 1 });
  const expected = Buffer.from(hexDigest, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function sanitizeParam(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    return JSON.stringify(value);
  }
  return value;
}

function normalizeParams(args) {
  if (args.length === 0) return [];
  if (args.length === 1 && Array.isArray(args[0])) {
    return args[0].map(sanitizeParam);
  }
  if (
    args.length === 1 &&
    args[0] !== null &&
    typeof args[0] === 'object' &&
    !Buffer.isBuffer(args[0]) &&
    !(args[0] instanceof Uint8Array) &&
    !(args[0] instanceof Date)
  ) {
    const named = {};
    for (const [k, v] of Object.entries(args[0])) {
      named[k] = sanitizeParam(v);
    }
    return [named];
  }
  return args.map(sanitizeParam);
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return out;
}

function initSchema(rawDb) {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT '',
      center_lat REAL NOT NULL DEFAULT 39.5961,
      center_lng REAL NOT NULL DEFAULT 27.0244,
      credits_balance INTEGER NOT NULL DEFAULT 0,
      credits_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS merchant_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      group_id INTEGER,
      name TEXT NOT NULL,
      brand_tag TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      lat REAL,
      lng REAL,
      tariff_mode TEXT NOT NULL DEFAULT 'km',
      base_fee REAL NOT NULL DEFAULT 45,
      per_km_fee REAL NOT NULL DEFAULT 10,
      commission_pct REAL NOT NULL DEFAULT 12,
      auto_print INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      min_km REAL NOT NULL DEFAULT 0,
      max_km REAL NOT NULL DEFAULT 3,
      shop_fee REAL NOT NULL DEFAULT 50,
      courier_fee REAL NOT NULL DEFAULT 38
    );

    CREATE TABLE IF NOT EXISTS couriers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      vehicle_type TEXT NOT NULL DEFAULT 'Motosiklet',
      is_online INTEGER NOT NULL DEFAULT 0,
      on_break INTEGER NOT NULL DEFAULT 0,
      has_pos INTEGER NOT NULL DEFAULT 0,
      battery_pct INTEGER NOT NULL DEFAULT 100,
      max_batch INTEGER NOT NULL DEFAULT 4,
      lat REAL,
      lng REAL,
      per_package_fee REAL NOT NULL DEFAULT 35,
      per_km_bonus REAL NOT NULL DEFAULT 6,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      phone TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      display_name TEXT NOT NULL,
      merchant_group_id INTEGER,
      shop_id INTEGER,
      courier_id INTEGER,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      UNIQUE(tenant_id, phone)
    );

    CREATE TABLE IF NOT EXISTS courier_shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      courier_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      phone TEXT NOT NULL,
      name TEXT NOT NULL,
      last_address TEXT DEFAULT '',
      neighborhood TEXT DEFAULT '',
      lat REAL,
      lng REAL,
      preferred_payment TEXT DEFAULT 'cash',
      order_count INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      UNIQUE(tenant_id, phone)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      shop_id INTEGER NOT NULL,
      courier_id INTEGER,
      batch_id TEXT,
      route_seq INTEGER DEFAULT 1,
      tracking_code TEXT NOT NULL UNIQUE,
      external_source TEXT DEFAULT 'manual',
      external_id TEXT,
      order_type TEXT NOT NULL DEFAULT 'delivery',
      status TEXT NOT NULL DEFAULT 'pending',
      customer_name TEXT NOT NULL,
      customer_phone TEXT DEFAULT '',
      customer_address TEXT DEFAULT '',
      neighborhood TEXT DEFAULT '',
      dest_lat REAL,
      dest_lng REAL,
      distance_km REAL NOT NULL DEFAULT 0,
      order_amount REAL NOT NULL DEFAULT 0,
      delivery_fee REAL NOT NULL DEFAULT 0,
      courier_earning REAL NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'cash',
      items_summary TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      delivery_pin TEXT DEFAULT '',
      credit_consumed INTEGER NOT NULL DEFAULT 0,
      credit_refunded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      assigned_at TEXT,
      picked_up_at TEXT,
      delivered_at TEXT
    );

    CREATE TABLE IF NOT EXISTS order_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      sender_role TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS radio_transmissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      channel TEXT NOT NULL DEFAULT 'genel',
      sender_role TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      text_note TEXT DEFAULT '',
      audio_data_url TEXT,
      duration_sec REAL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS credit_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reason TEXT NOT NULL,
      order_id INTEGER,
      note TEXT DEFAULT '',
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS print_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      shop_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL,
      printed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS webhook_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      external_id TEXT,
      status TEXT NOT NULL,
      summary TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_tenant_status ON orders(tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_orders_tenant_shop ON orders(tenant_id, shop_id);
    CREATE INDEX IF NOT EXISTS idx_orders_tenant_courier ON orders(tenant_id, courier_id);
    CREATE INDEX IF NOT EXISTS idx_orders_external ON orders(tenant_id, external_source, external_id);
    CREATE INDEX IF NOT EXISTS idx_customers_lookup ON customers(tenant_id, phone);
    CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
  `);
}

function isoMinutesAgo(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

function seedMerkezDemo(db) {
  const existing = db.get('SELECT id FROM tenants WHERE slug = ?', 'merkez');
  if (existing) return existing.id;

  return db.tx(() => {
    const nowIso = new Date().toISOString();
    const demoPassHash = hashPassword('1234');

    // 1. Tenant: merkez (Ege Hızlı Kurye & Lojistik — Edremit, Balıkesir)
    const tenantRes = db.run(
      `INSERT INTO tenants (slug, name, city, center_lat, center_lng, credits_balance, credits_enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'merkez',
      'Ege Hızlı Kurye & Lojistik',
      'Edremit, Balıkesir',
      39.5961,
      27.0244,
      2500,
      1,
      isoMinutesAgo(720)
    );
    const tenantId = tenantRes.lastInsertRowid;

    // 2. Çoklu Marka Grubu: Lezzet Grup Restoranları
    const grpRes = db.run(
      `INSERT INTO merchant_groups (tenant_id, name, created_at) VALUES (?, ?, ?)`,
      tenantId,
      'Lezzet Grup Restoranları',
      isoMinutesAgo(700)
    );
    const groupId = grpRes.lastInsertRowid;

    // 3. Dükkanlar (#1, #2, #3 Lezzet Grup altında; #4 Tekil İşletme)
    const shopsSeed = [
      {
        group_id: groupId,
        name: 'Hatay Dönercisi',
        brand_tag: 'Hatay Usulü Döner',
        phone: '02663731001',
        address: 'Cumhuriyet Mah. Atatürk Bulvarı No:18 Edremit',
        lat: 39.5964,
        lng: 27.0248,
        tariff_mode: 'km',
        base_fee: 45,
        per_km_fee: 10,
        commission_pct: 12,
        auto_print: 1,
      },
      {
        group_id: groupId,
        name: 'Burger İstasyonu',
        brand_tag: 'Gurme Smash Burger',
        phone: '02663731002',
        address: 'Cumhuriyet Mah. İnönü Cad. No:24 Edremit',
        lat: 39.5969,
        lng: 27.0256,
        tariff_mode: 'km',
        base_fee: 48,
        per_km_fee: 10,
        commission_pct: 12,
        auto_print: 1,
      },
      {
        group_id: groupId,
        name: 'Gece Kumrucusu',
        brand_tag: 'Çeşme Kumru & Ayvalık Tost',
        phone: '02663731003',
        address: 'Soğanyemez Mah. Yılmaz Akpınar Blv. No:42 Edremit',
        lat: 39.5955,
        lng: 27.0235,
        tariff_mode: 'zone',
        base_fee: 45,
        per_km_fee: 9,
        commission_pct: 12,
        auto_print: 1,
      },
      {
        group_id: null,
        name: 'Körfez Pide & Lahmacun',
        brand_tag: 'Taş Fırın Pide',
        phone: '05552002021',
        address: 'Camivasat Mah. Menderes Bulvarı No:65 Edremit',
        lat: 39.5938,
        lng: 27.0218,
        tariff_mode: 'km',
        base_fee: 50,
        per_km_fee: 11,
        commission_pct: 10,
        auto_print: 1,
      },
    ];

    const shopIds = [];
    for (const s of shopsSeed) {
      const r = db.run(
        `INSERT INTO shops (tenant_id, group_id, name, brand_tag, phone, address, lat, lng, tariff_mode, base_fee, per_km_fee, commission_pct, auto_print, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        tenantId,
        s.group_id,
        s.name,
        s.brand_tag,
        s.phone,
        s.address,
        s.lat,
        s.lng,
        s.tariff_mode,
        s.base_fee,
        s.per_km_fee,
        s.commission_pct,
        s.auto_print,
        isoMinutesAgo(680)
      );
      shopIds.push(r.lastInsertRowid);
    }

    // 4. Mesafe Bölgeleri (Zones)
    const zonesSeed = [
      { name: 'Bölge 1 — Merkez Çarşı (0 - 2 km)', min_km: 0, max_km: 2.0, shop_fee: 45, courier_fee: 34 },
      { name: 'Bölge 2 — Yakın Mahalleler (2 - 4.5 km)', min_km: 2.0, max_km: 4.5, shop_fee: 65, courier_fee: 48 },
      { name: 'Bölge 3 — Akçay / Kadıköy Hattı (4.5 - 12 km)', min_km: 4.5, max_km: 12.0, shop_fee: 95, courier_fee: 72 },
    ];
    for (const z of zonesSeed) {
      db.run(
        `INSERT INTO zones (tenant_id, name, min_km, max_km, shop_fee, courier_fee)
         VALUES (?, ?, ?, ?, ?, ?)`,
        tenantId,
        z.name,
        z.min_km,
        z.max_km,
        z.shop_fee,
        z.courier_fee
      );
    }

    // 5. Kuryeler
    const couriersSeed = [
      {
        name: 'Ahmet Yılmaz',
        phone: '05553003031',
        vehicle_type: 'Motosiklet',
        is_online: 1,
        on_break: 0,
        has_pos: 1,
        battery_pct: 92,
        max_batch: 4,
        lat: 39.5968,
        lng: 27.0252,
        per_package_fee: 35,
        per_km_bonus: 6,
      },
      {
        name: 'Burak Demir',
        phone: '05553003032',
        vehicle_type: 'Motosiklet',
        is_online: 1,
        on_break: 0,
        has_pos: 0,
        battery_pct: 78,
        max_batch: 3,
        lat: 39.5942,
        lng: 27.0210,
        per_package_fee: 34,
        per_km_bonus: 6,
      },
      {
        name: 'Can Kaya',
        phone: '05553003033',
        vehicle_type: 'Araçlı Kurye',
        is_online: 0,
        on_break: 0,
        has_pos: 1,
        battery_pct: 100,
        max_batch: 6,
        lat: 39.5910,
        lng: 27.0305,
        per_package_fee: 42,
        per_km_bonus: 7.5,
      },
    ];

    const courierIds = [];
    for (const c of couriersSeed) {
      const r = db.run(
        `INSERT INTO couriers (tenant_id, name, phone, vehicle_type, is_online, on_break, has_pos, battery_pct, max_batch, lat, lng, per_package_fee, per_km_bonus, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        tenantId,
        c.name,
        c.phone,
        c.vehicle_type,
        c.is_online,
        c.on_break,
        c.has_pos,
        c.battery_pct,
        c.max_batch,
        c.lat,
        c.lng,
        c.per_package_fee,
        c.per_km_bonus,
        nowIso
      );
      courierIds.push(r.lastInsertRowid);
      if (c.is_online === 1) {
        db.run(
          `INSERT INTO courier_shifts (tenant_id, courier_id, action, created_at) VALUES (?, ?, ?, ?)`,
          tenantId,
          r.lastInsertRowid,
          'shift_start',
          isoMinutesAgo(180)
        );
      }
    }

    // 6. Kullanıcılar (Yönetici, Grup İşletme, Tekil İşletme, 3 Kurye)
    db.run(
      `INSERT INTO users (tenant_id, phone, password_hash, role, display_name, merchant_group_id, shop_id, courier_id, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      tenantId,
      '05551001010',
      demoPassHash,
      'admin',
      'Murat Yönetici',
      null,
      null,
      null
    );
    db.run(
      `INSERT INTO users (tenant_id, phone, password_hash, role, display_name, merchant_group_id, shop_id, courier_id, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      tenantId,
      '05552002020',
      demoPassHash,
      'merchant',
      'Lezzet Grup Restoranları',
      groupId,
      shopIds[0],
      null
    );
    db.run(
      `INSERT INTO users (tenant_id, phone, password_hash, role, display_name, merchant_group_id, shop_id, courier_id, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      tenantId,
      '05552002021',
      demoPassHash,
      'merchant',
      'Körfez Pide & Lahmacun',
      null,
      shopIds[3],
      null
    );
    for (let i = 0; i < couriersSeed.length; i += 1) {
      db.run(
        `INSERT INTO users (tenant_id, phone, password_hash, role, display_name, merchant_group_id, shop_id, courier_id, must_change_password)
         VALUES (?, ?, ?, 'courier', ?, NULL, NULL, ?, 0)`,
        tenantId,
        couriersSeed[i].phone,
        demoPassHash,
        couriersSeed[i].name,
        courierIds[i]
      );
    }

    // 7. Caller ID Müşteri Hafızası
    const customersSeed = [
      {
        phone: '05324441010',
        name: 'Ayşe Karaca',
        last_address: 'Cennetayağı Mah. İstasyon Cad. No:34 Daire:5 Edremit',
        neighborhood: 'Cennetayağı Mah.',
        lat: 39.5892,
        lng: 27.0125,
        preferred_payment: 'card_on_delivery',
        order_count: 14,
      },
      {
        phone: '05335552020',
        name: 'Mehmet Özkan',
        last_address: 'Cennetayağı Mah. Çamlık Sok. No:12 Kat:2 Edremit',
        neighborhood: 'Cennetayağı Mah.',
        lat: 39.5865,
        lng: 27.0092,
        preferred_payment: 'online_paid',
        order_count: 9,
      },
      {
        phone: '05426663030',
        name: 'Zeynep Aydın',
        last_address: 'Gazicelal Mah. Okul Sok. No:8 D:3 Edremit',
        neighborhood: 'Gazicelal Mah.',
        lat: 39.6035,
        lng: 27.0315,
        preferred_payment: 'cash',
        order_count: 6,
      },
      {
        phone: '05057774040',
        name: 'Emre Çelik',
        last_address: 'Tuzcumurat Mah. Çayiçi Cad. No:21 Kat:4 Edremit',
        neighborhood: 'Tuzcumurat Mah.',
        lat: 39.5985,
        lng: 27.0205,
        preferred_payment: 'card_on_delivery',
        order_count: 21,
      },
      {
        phone: '05448885050',
        name: 'Selin Yalçın',
        last_address: 'Hamidiye Mah. Park Cad. No:9 D:1 Edremit',
        neighborhood: 'Hamidiye Mah.',
        lat: 39.5998,
        lng: 27.0182,
        preferred_payment: 'cash',
        order_count: 4,
      },
    ];

    for (const cust of customersSeed) {
      db.run(
        `INSERT INTO customers (tenant_id, phone, name, last_address, neighborhood, lat, lng, preferred_payment, order_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        tenantId,
        cust.phone,
        cust.name,
        cust.last_address,
        cust.neighborhood,
        cust.lat,
        cust.lng,
        cust.preferred_payment,
        cust.order_count,
        nowIso
      );
    }

    // 8. Zengin Örnek Siparişler (3 Teslim Edilmiş + 2 Aktif Sahada + 3 Bekleyen Birleştirilebilir Havuz)
    const allShops = db.all('SELECT * FROM shops WHERE tenant_id = ?', tenantId);
    const allZones = db.all('SELECT * FROM zones WHERE tenant_id = ?', tenantId);
    const allCouriers = db.all('SELECT * FROM couriers WHERE tenant_id = ?', tenantId);

    const ordersSeed = [
      // Teslim edilmiş (Gün sonu mutabakat + 14.2 dk ortalama süre için)
      {
        shopIdx: 3,
        courierIdx: 1,
        batch_id: 'BATCH-HIST-01',
        route_seq: 1,
        tracking_code: 'PKT-MRKZ-098',
        external_source: 'manual',
        external_id: null,
        order_type: 'delivery',
        status: 'delivered',
        customer_name: 'Kadir Yıldırım',
        customer_phone: '05373334455',
        customer_address: 'Camivasat Mah. Eski Garaj Sok. No:11 Edremit',
        neighborhood: 'Camivasat Mah.',
        dest_lat: 39.5918,
        dest_lng: 27.0185,
        order_amount: 310,
        payment_method: 'cash',
        items_summary: '1x Kıymalı Kaşarlı Pide, 2x Lahmacun, 1L Ayran',
        notes: 'Acılı ezme eklensin',
        delivery_pin: '8219',
        created_at: isoMinutesAgo(95),
        assigned_at: isoMinutesAgo(92),
        picked_up_at: isoMinutesAgo(88),
        delivered_at: isoMinutesAgo(80), // 15.0 dk
      },
      {
        shopIdx: 0,
        courierIdx: 0,
        batch_id: 'BATCH-HIST-02',
        route_seq: 1,
        tracking_code: 'PKT-MRKZ-099',
        external_source: 'yemeksepeti',
        external_id: 'YS-90098',
        order_type: 'delivery',
        status: 'delivered',
        customer_name: 'Hakan Kılıç',
        customer_phone: '05351112233',
        customer_address: 'İbrahimce Mah. Çınar Cad. No:15 D:2 Edremit',
        neighborhood: 'İbrahimce Mah.',
        dest_lat: 39.5930,
        dest_lng: 27.0285,
        order_amount: 520,
        payment_method: 'card_on_delivery',
        items_summary: '2x Zurna Tavuk Dürüm, 2x Ayran, 1x Künefe',
        notes: 'Zile basmayın, telefonla arayın',
        delivery_pin: '3108',
        created_at: isoMinutesAgo(70),
        assigned_at: isoMinutesAgo(67),
        picked_up_at: isoMinutesAgo(63),
        delivered_at: isoMinutesAgo(56.2), // 13.8 dk
      },
      {
        shopIdx: 1,
        courierIdx: 0,
        batch_id: 'BATCH-HIST-03',
        route_seq: 1,
        tracking_code: 'PKT-MRKZ-100',
        external_source: 'trendyolgo',
        external_id: 'TY-90099',
        order_type: 'delivery',
        status: 'delivered',
        customer_name: 'Deniz Arslan',
        customer_phone: '05362223344',
        customer_address: 'Cumhuriyet Mah. Lise Cad. No:7 D:6 Edremit',
        neighborhood: 'Cumhuriyet Mah.',
        dest_lat: 39.5988,
        dest_lng: 27.0268,
        order_amount: 440,
        payment_method: 'online_paid',
        items_summary: '1x Double Truffle Burger Menü, 1x Soğan Halkası',
        notes: 'Ketçap bol olsun',
        delivery_pin: '6542',
        created_at: isoMinutesAgo(50),
        assigned_at: isoMinutesAgo(47),
        picked_up_at: isoMinutesAgo(43),
        delivered_at: isoMinutesAgo(35.4), // 14.6 dk -> Ahmet ortalama (13.8+14.6)/2 = 14.2 dk!
      },
      // Aktif sahada (Ahmet Yılmaz üzerinde 2'li rota grubu)
      {
        shopIdx: 0,
        courierIdx: 0,
        batch_id: 'BATCH-DEMO-01',
        route_seq: 1,
        tracking_code: 'PKT-MRKZ-104',
        external_source: 'getiryemek',
        external_id: 'GY-10400',
        order_type: 'delivery',
        status: 'picked_up',
        customer_name: 'Emre Çelik',
        customer_phone: '05057774040',
        customer_address: 'Tuzcumurat Mah. Çayiçi Cad. No:21 Kat:4 Edremit',
        neighborhood: 'Tuzcumurat Mah.',
        dest_lat: 39.5985,
        dest_lng: 27.0205,
        order_amount: 385,
        payment_method: 'card_on_delivery',
        items_summary: '1x İskender Kebap, 1x Mercimek Çorbası, 1x Şalgam',
        notes: 'Kapıda temassız kredi kartı ile ödenecek — POS cihazı gerekli',
        delivery_pin: '4821',
        created_at: isoMinutesAgo(16),
        assigned_at: isoMinutesAgo(13),
        picked_up_at: isoMinutesAgo(6),
        delivered_at: null,
      },
      {
        shopIdx: 2,
        courierIdx: 0,
        batch_id: 'BATCH-DEMO-01',
        route_seq: 2,
        tracking_code: 'PKT-MRKZ-105',
        external_source: 'adisyo',
        external_id: 'AD-10500',
        order_type: 'delivery',
        status: 'assigned',
        customer_name: 'Selin Yalçın',
        customer_phone: '05448885050',
        customer_address: 'Hamidiye Mah. Park Cad. No:9 D:1 Edremit',
        neighborhood: 'Hamidiye Mah.',
        dest_lat: 39.5998,
        dest_lng: 27.0182,
        order_amount: 260,
        payment_method: 'cash',
        items_summary: '2x Süper Karışık Kumru, 2x Kutu Kola',
        notes: 'Turşu ayrı pakette olsun',
        delivery_pin: '7390',
        created_at: isoMinutesAgo(14),
        assigned_at: isoMinutesAgo(12),
        picked_up_at: null,
        delivered_at: null,
      },
      // Bekleyen Akıllı Havuz (Pagate tarzı birleştirilmeye hazır 2 yakın dükkan + 1 farklı yön)
      {
        shopIdx: 3,
        courierIdx: null,
        batch_id: null,
        route_seq: 1,
        tracking_code: 'PKT-MRKZ-103',
        external_source: 'manual',
        external_id: null,
        order_type: 'delivery',
        status: 'pending',
        customer_name: 'Zeynep Aydın',
        customer_phone: '05426663030',
        customer_address: 'Gazicelal Mah. Okul Sok. No:8 D:3 Edremit',
        neighborhood: 'Gazicelal Mah.',
        dest_lat: 39.6035,
        dest_lng: 27.0315,
        order_amount: 290,
        payment_method: 'cash',
        items_summary: '1x Kuşbaşılı Kaşarlı Pide, 1x Künefe',
        notes: '500 TL nakit verilecek, para üstü rica ederim',
        delivery_pin: '9063',
        created_at: isoMinutesAgo(9),
        assigned_at: null,
        picked_up_at: null,
        delivered_at: null,
      },
      {
        shopIdx: 1,
        courierIdx: null,
        batch_id: null,
        route_seq: 1,
        tracking_code: 'PKT-MRKZ-102',
        external_source: 'migrosyemek',
        external_id: 'MY-10200',
        order_type: 'delivery',
        status: 'pending',
        customer_name: 'Mehmet Özkan',
        customer_phone: '05335552020',
        customer_address: 'Cennetayağı Mah. Çamlık Sok. No:12 Kat:2 Edremit',
        neighborhood: 'Cennetayağı Mah.',
        dest_lat: 39.5865,
        dest_lng: 27.0092,
        order_amount: 465,
        payment_method: 'online_paid',
        items_summary: '1x Smokehouse Burger Menü, 1x Çıtır Tavuk Parçaları',
        notes: 'Online ödendi, kapıya bırakabilirsiniz',
        delivery_pin: '2947',
        created_at: isoMinutesAgo(6),
        assigned_at: null,
        picked_up_at: null,
        delivered_at: null,
      },
      {
        shopIdx: 0,
        courierIdx: null,
        batch_id: null,
        route_seq: 1,
        tracking_code: 'PKT-MRKZ-101',
        external_source: 'yemeksepeti',
        external_id: 'YS-10100',
        order_type: 'delivery',
        status: 'pending',
        customer_name: 'Ayşe Karaca',
        customer_phone: '05324441010',
        customer_address: 'Cennetayağı Mah. İstasyon Cad. No:34 Daire:5 Edremit',
        neighborhood: 'Cennetayağı Mah.',
        dest_lat: 39.5892,
        dest_lng: 27.0125,
        order_amount: 340,
        payment_method: 'card_on_delivery',
        items_summary: '2x Hatay Soslu Tavuk Dürüm, 1x Büyük Patates, 2x Ayran',
        notes: 'Kapıda POS cihazı gelsin lütfen',
        delivery_pin: '5194',
        created_at: isoMinutesAgo(4),
        assigned_at: null,
        picked_up_at: null,
        delivered_at: null,
      },
    ];

    const insertedOrderIds = {};
    for (const o of ordersSeed) {
      const shop = allShops[o.shopIdx];
      const courier = o.courierIdx !== null ? allCouriers[o.courierIdx] : null;
      const distKm = estimateRoadKm(shop.lat, shop.lng, o.dest_lat, o.dest_lng);
      const pricing = calculateOrderPricing({
        shop,
        zones: allZones,
        courier,
        distanceKm: distKm,
        orderAmount: o.order_amount,
        orderType: o.order_type,
      });

      const res = db.run(
        `INSERT INTO orders (
          tenant_id, shop_id, courier_id, batch_id, route_seq, tracking_code,
          external_source, external_id, order_type, status,
          customer_name, customer_phone, customer_address, neighborhood,
          dest_lat, dest_lng, distance_km, order_amount, delivery_fee, courier_earning,
          payment_method, items_summary, notes, delivery_pin,
          credit_consumed, credit_refunded, created_at, assigned_at, picked_up_at, delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)`,
        tenantId,
        shop.id,
        courier ? courier.id : null,
        o.batch_id,
        o.route_seq,
        o.tracking_code,
        o.external_source,
        o.external_id,
        o.order_type,
        o.status,
        o.customer_name,
        o.customer_phone,
        o.customer_address,
        o.neighborhood,
        o.dest_lat,
        o.dest_lng,
        pricing.distanceKm,
        o.order_amount,
        pricing.deliveryFee,
        pricing.courierEarning,
        o.payment_method,
        o.items_summary,
        o.notes,
        o.delivery_pin,
        o.created_at,
        o.assigned_at,
        o.picked_up_at,
        o.delivered_at
      );
      insertedOrderIds[o.tracking_code] = res.lastInsertRowid;

      db.run(
        `INSERT INTO print_jobs (tenant_id, shop_id, order_id, status, created_at, printed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        tenantId,
        shop.id,
        res.lastInsertRowid,
        o.status === 'pending' ? 'queued' : 'printed',
        o.created_at,
        o.status === 'pending' ? null : o.created_at
      );
    }

    // 9. Paket Bazlı Sohbet Örnekleri
    const activeOrderId = insertedOrderIds['PKT-MRKZ-104'];
    if (activeOrderId) {
      db.run(
        `INSERT INTO order_messages (tenant_id, order_id, sender_role, sender_name, body, created_at)
         VALUES (?, ?, 'merchant', 'Hatay Dönercisi', 'Ahmet usta, müşterimiz temassız POS istedi, cihaz açık mı?', ?)`,
        tenantId,
        activeOrderId,
        isoMinutesAgo(11)
      );
      db.run(
        `INSERT INTO order_messages (tenant_id, order_id, sender_role, sender_name, body, created_at)
         VALUES (?, ?, 'courier', 'Ahmet Yılmaz', 'POS yanımda ve şarjı %92 usta, paketi aldım Çayiçi Caddesine geçiyorum.', ?)`,
        tenantId,
        activeOrderId,
        isoMinutesAgo(6)
      );
    }

    // 10. Canlı Telsiz (Push-to-Talk) Örnek Anonsları
    db.run(
      `INSERT INTO radio_transmissions (tenant_id, channel, sender_role, sender_name, text_note, audio_data_url, duration_sec, created_at)
       VALUES (?, 'genel', 'admin', 'Murat Yönetici', 'Merkezden tüm saha ekibine: Atatürk Bulvarı açık, akşam servisi başladı. Kapıda kartlı paketlerde POS kontrolünü unutmayalım.', NULL, 4.2, ?)`,
      tenantId,
      isoMinutesAgo(25)
    );
    db.run(
      `INSERT INTO radio_transmissions (tenant_id, channel, sender_role, sender_name, text_note, audio_data_url, duration_sec, created_at)
       VALUES (?, 'genel', 'courier', 'Ahmet Yılmaz', 'Anlaşıldı merkez, Tuzcumurat ve Hamidiye rotası akıcı, 10 dakikaya havuza dönüyorum.', NULL, 3.5, ?)`,
      tenantId,
      isoMinutesAgo(9)
    );

    // 11. Süresiz Kontör Cüzdan Hareketleri (Net Bakiye: 2500)
    db.run(
      `INSERT INTO credit_ledger (tenant_id, delta, balance_after, reason, order_id, note, idempotency_key, created_at)
       VALUES (?, 2508, 2508, 'topup', NULL, 'Kurumsal Başlangıç Paketi (Süresiz Kontör)', 'seed-topup-merkez-1', ?)`,
      tenantId,
      isoMinutesAgo(715)
    );
    db.run(
      `INSERT INTO credit_ledger (tenant_id, delta, balance_after, reason, order_id, note, idempotency_key, created_at)
       VALUES (?, -8, 2500, 'order_consume_batch', ?, '8 adet aktif/tamamlanan operasyon siparişi kontör düşümü', 'seed-consume-merkez-8', ?)`,
      tenantId,
      insertedOrderIds['PKT-MRKZ-103'],
      isoMinutesAgo(4)
    );

    // 12. Örnek Pazaryeri Webhook Kayıtları
    db.run(
      `INSERT INTO webhook_logs (tenant_id, platform, external_id, status, summary, created_at)
       VALUES (?, 'yemeksepeti', 'YS-10100', 'ingested', 'Hatay Dönercisi -> Ayşe Karaca (340 TL • Kapıda POS)', ?)`,
      tenantId,
      isoMinutesAgo(8)
    );
    db.run(
      `INSERT INTO webhook_logs (tenant_id, platform, external_id, status, summary, created_at)
       VALUES (?, 'migrosyemek', 'MY-10200', 'ingested', 'Burger İstasyonu -> Mehmet Özkan (465 TL • Online Ödendi)', ?)`,
      tenantId,
      isoMinutesAgo(6)
    );

    return tenantId;
  });
}

function createDatabase(customPath = null, options = {}) {
  const targetPath = customPath || process.env.DB_PATH || DEFAULT_DB_PATH;
  const isMemory = targetPath === ':memory:';

  if (!isMemory) {
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  const raw = new DatabaseSync(targetPath);
  if (!isMemory) {
    raw.exec('PRAGMA journal_mode = WAL;');
    raw.exec('PRAGMA busy_timeout = 5000;');
  }
  raw.exec('PRAGMA foreign_keys = ON;');

  initSchema(raw);

  let txDepth = 0;

  function run(sql, ...args) {
    const stmt = raw.prepare(sql);
    const params = normalizeParams(args);
    const res = stmt.run(...params);
    return {
      changes: Number(res.changes ?? 0),
      lastInsertRowid: Number(res.lastInsertRowid ?? 0),
    };
  }

  function get(sql, ...args) {
    const stmt = raw.prepare(sql);
    const params = normalizeParams(args);
    const row = stmt.get(...params);
    return normalizeRow(row);
  }

  function all(sql, ...args) {
    const stmt = raw.prepare(sql);
    const params = normalizeParams(args);
    const rows = stmt.all(...params);
    return Array.isArray(rows) ? rows.map(normalizeRow) : [];
  }

  function exec(sql) {
    return raw.exec(sql);
  }

  function tx(fn) {
    const depth = txDepth;
    const spName = `sp_${depth}`;
    txDepth += 1;
    if (depth === 0) {
      raw.exec('BEGIN IMMEDIATE');
    } else {
      raw.exec(`SAVEPOINT ${spName}`);
    }
    try {
      const result = fn();
      if (depth === 0) {
        raw.exec('COMMIT');
      } else {
        raw.exec(`RELEASE SAVEPOINT ${spName}`);
      }
      txDepth -= 1;
      return result;
    } catch (err) {
      txDepth -= 1;
      try {
        if (depth === 0) {
          raw.exec('ROLLBACK');
        } else {
          raw.exec(`ROLLBACK TO SAVEPOINT ${spName}`);
          raw.exec(`RELEASE SAVEPOINT ${spName}`);
        }
      } catch (_) {
        // ignore rollback error
      }
      throw err;
    }
  }

  function close() {
    try {
      raw.close();
    } catch (_) {
      // ignore close error
    }
  }

  const dbApi = {
    raw,
    dbPath: targetPath,
    isMemory,
    run,
    get,
    all,
    exec,
    tx,
    close,
    normalizePhone,
    hashPassword,
    verifyPassword,
  };

  if (options.seedDemo !== false) {
    const countRow = get('SELECT COUNT(*) AS cnt FROM tenants');
    if (!countRow || countRow.cnt === 0) {
      seedMerkezDemo(dbApi);
    }
  }

  dbApi.seedMerkezDemo = () => seedMerkezDemo(dbApi);

  return dbApi;
}

let defaultInstance = null;
function getDefaultDb() {
  if (!defaultInstance) {
    defaultInstance = createDatabase();
  }
  return defaultInstance;
}

module.exports = {
  DEFAULT_DB_PATH,
  createDatabase,
  getDefaultDb,
  normalizePhone,
  hashPassword,
  verifyPassword,
  seedMerkezDemo,
};
