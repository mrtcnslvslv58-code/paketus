/**
 * PAKETÜS — Baş Arayüz & Mobil PWA İstemci Motoru (SPA)
 * 5 Ekran: Vitrin (/), Operasyon Merkezi (/panel), İşletme (/isletme),
 *          Kurye Mobil (/kurye), Müşteri Canlı Takip (/takip/:code)
 */
(() => {
  'use strict';

  const STORAGE_TOKEN_KEY = 'paketus_auth_token_v1';
  const STORAGE_USER_KEY = 'paketus_auth_user_v1';

  const DEFAULT_CREDIT_PACKAGES = [
    { credits: 500, unitPrice: 1.5, total: 750 },
    { credits: 2000, unitPrice: 1.2, total: 2400 },
    { credits: 10000, unitPrice: 0.95, total: 9500 }
  ];

  const DEMO_CREDENTIALS = {
    admin: { phone: '05551001010', password: '1234', tenantSlug: 'merkez', route: '/panel' },
    merchant_group: { phone: '05552002020', password: '1234', tenantSlug: 'merkez', route: '/isletme' },
    merchant_single: { phone: '05552002021', password: '1234', tenantSlug: 'merkez', route: '/isletme' },
    courier_1: { phone: '05553003031', password: '1234', tenantSlug: 'merkez', route: '/kurye' },
    courier_2: { phone: '05553003032', password: '1234', tenantSlug: 'merkez', route: '/kurye' },
    courier_3: { phone: '05553003033', password: '1234', tenantSlug: 'merkez', route: '/kurye' }
  };

  const DEFAULT_PLATFORMS = [
    { id: 'yemeksepeti', name: 'Yemeksepeti', description: 'Restoran Vale & Joker sipariş kancası' },
    { id: 'getiryemek', name: 'GetirYemek', description: 'Restoran Getirsin otomatik paket akışı' },
    { id: 'trendyolgo', name: 'Trendyol GO', description: 'Trendyol Yemek anlık kurye çağrısı' },
    { id: 'migrosyemek', name: 'Migros Yemek', description: 'Migros Yemek şube kurye bildirimi' },
    { id: 'tiklagelsin', name: 'Tıkla Gelsin', description: 'Tıkla Gelsin zincir ve şube siparişi' },
    { id: 'adisyo', name: 'Adisyo POS', description: 'Bulut adisyon ve mutfak fiş kancası' },
    { id: 'sambapos', name: 'SambaPOS', description: 'Yerel kasa, Caller ID ve 80mm fiş köprüsü' },
    { id: 'sepettakip', name: 'SepetTakip', description: 'Çoklu pazaryeri toplayıcı entegrasyonu' },
    { id: 'whatsapp', name: 'WhatsApp Sipariş', description: 'WhatsApp konum ve mesaj siparişi' },
    { id: 'pos_agent', name: 'Windows POS Ajanı', description: 'Yerel ESC/POS termal fiş yakalayıcı' }
  ];

  const state = {
    config: {
      appName: 'PAKETÜS',
      tagline: 'Yeni Nesil Çok Kiracılı Kurye, POS & Akıllı Rota Otomasyonu',
      defaultCenter: [39.5961, 27.0244],
      creditPackages: DEFAULT_CREDIT_PACKAGES
    },
    demoAccounts: null,
    sampleTrackingCode: '',
    token: localStorage.getItem(STORAGE_TOKEN_KEY) || '',
    user: safeJsonParse(localStorage.getItem(STORAGE_USER_KEY), null),
    currentRoute: '/',
    adminTab: 'havuz',
    adminOrderFilter: 'all',
    adminOrderSearch: '',
    merchantBrandFilter: 'all',
    merchantStatusFilter: 'all',
    selectedCalcTierIndex: 1,
    bootstrap: null,
    reconciliation: null,
    platforms: DEFAULT_PLATFORMS,
    lastParsedReceipt: null,
    activeChatOrderId: null,
    receiptZoom: 100,
    radioMuted: false,
    lastRadioId: 0,
    knownCourierOrderIds: new Set(),
    courierInitialLoaded: false,
    sse: null,
    sseReconnectTimer: null,
    trackPollTimer: null,
    mediaRecorder: null,
    audioChunks: [],
    recordingStartTs: 0,
    recordingStopTimer: null,
    leafletMap: null,
    leafletLayerGroup: null,
    pinPickShopId: null
  };

  function safeJsonParse(str, fallback) {
    if (!str) return fallback;
    try {
      return JSON.parse(str);
    } catch (_) {
      return fallback;
    }
  }

  const $ = (id) => document.getElementById(id);

  function esc(val) {
    return String(val ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTL(val) {
    const n = Number(val ?? 0);
    const safe = Number.isFinite(n) ? n : 0;
    return safe.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₺';
  }

  function formatInt(val) {
    const n = Number(val ?? 0);
    return (Number.isFinite(n) ? Math.round(n) : 0).toLocaleString('tr-TR');
  }

  function formatTimeShort(isoOrTs) {
    if (!isoOrTs) return '—';
    try {
      const d = new Date(isoOrTs);
      if (Number.isNaN(d.getTime())) return String(isoOrTs);
      return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return String(isoOrTs);
    }
  }

  function todayIsoDate() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function toast(message, level = 'info') {
    const stack = $('toast-stack');
    if (!stack) return;
    const item = document.createElement('div');
    item.className = `toast-item ${level}`;
    item.textContent = message;
    stack.appendChild(item);
    setTimeout(() => {
      if (item.parentNode) item.parentNode.removeChild(item);
    }, 3800);
  }

  /* =========================================================
     VERİ NORMALİZASYON YARDIMCILARI (snake_case & camelCase uyumlu)
     ========================================================= */
  function normOrder(o = {}) {
    return {
      raw: o,
      id: o.id,
      shopId: o.shop_id ?? o.shopId ?? null,
      shopName: o.shop_name ?? o.shopName ?? '',
      shopAddress: o.shop_address ?? o.shopAddress ?? '',
      shopLat: o.shop_lat ?? o.shopLat ?? null,
      shopLng: o.shop_lng ?? o.shopLng ?? null,
      courierId: o.courier_id ?? o.courierId ?? null,
      courierName: o.courier_name ?? o.courierName ?? '',
      batchId: o.batch_id ?? o.batchId ?? '',
      routeSeq: o.route_seq ?? o.routeSeq ?? o.routeSequence ?? null,
      trackingCode: o.tracking_code ?? o.trackingCode ?? `PKT-${o.id || ''}`,
      externalSource: o.external_source ?? o.externalSource ?? 'manual',
      orderType: o.order_type ?? o.orderType ?? 'delivery',
      status: o.status || 'pending',
      customerName: o.customer_name ?? o.customerName ?? 'Müşteri',
      customerPhone: o.customer_phone ?? o.customerPhone ?? '',
      customerAddress: o.customer_address ?? o.customerAddress ?? '',
      neighborhood: o.neighborhood ?? '',
      destLat: o.dest_lat ?? o.destLat ?? null,
      destLng: o.dest_lng ?? o.destLng ?? null,
      distanceKm: Number(o.distance_km ?? o.distanceKm ?? 0) || 0,
      orderAmount: Number(o.order_amount ?? o.orderAmount ?? 0) || 0,
      deliveryFee: Number(o.delivery_fee ?? o.deliveryFee ?? 0) || 0,
      courierEarning: Number(o.courier_earning ?? o.courierEarning ?? 0) || 0,
      paymentMethod: o.payment_method ?? o.paymentMethod ?? 'cash',
      itemsSummary: o.items_summary ?? o.itemsSummary ?? '',
      notes: o.notes ?? '',
      deliveryPin: o.delivery_pin ?? o.deliveryPin ?? '',
      createdAt: o.created_at ?? o.createdAt ?? ''
    };
  }

  function normShop(s = {}) {
    return {
      raw: s,
      id: s.id,
      groupId: s.group_id ?? s.groupId ?? null,
      groupName: s.group_name ?? s.groupName ?? '',
      name: s.name || 'İşletme',
      brandTag: s.brand_tag ?? s.brandTag ?? '',
      phone: s.phone || '',
      address: s.address || '',
      lat: s.lat !== null && s.lat !== undefined && s.lat !== '' ? Number(s.lat) : null,
      lng: s.lng !== null && s.lng !== undefined && s.lng !== '' ? Number(s.lng) : null,
      tariffMode: s.tariff_mode ?? s.tariffMode ?? 'km',
      baseFee: Number(s.base_fee ?? s.baseFee ?? 45) || 0,
      perKmFee: Number(s.per_km_fee ?? s.perKmFee ?? 8) || 0,
      commissionPct: Number(s.commission_pct ?? s.commissionPct ?? 12) || 0,
      autoPrint: Boolean(Number(s.auto_print ?? s.autoPrint ?? 1))
    };
  }

  function normCourier(c = {}) {
    return {
      raw: c,
      id: c.id,
      name: c.name || 'Kurye',
      phone: c.phone || '',
      vehicleType: c.vehicle_type ?? c.vehicleType ?? 'motorcycle',
      isOnline: Boolean(Number(c.is_online ?? c.isOnline ?? 0)),
      onBreak: Boolean(Number(c.on_break ?? c.onBreak ?? 0)),
      hasPos: Boolean(Number(c.has_pos ?? c.hasPos ?? 0)),
      batteryPct: Number(c.battery_pct ?? c.batteryPct ?? c.battery ?? 100) || 0,
      maxBatch: Number(c.max_batch ?? c.maxBatch ?? 4) || 4,
      lat: c.lat !== null && c.lat !== undefined && c.lat !== '' ? Number(c.lat) : null,
      lng: c.lng !== null && c.lng !== undefined && c.lng !== '' ? Number(c.lng) : null,
      perPackageFee: Number(c.per_package_fee ?? c.perPackageFee ?? 30) || 0,
      perKmBonus: Number(c.per_km_bonus ?? c.perKmBonus ?? 5) || 0,
      todayEarnings: Number(c.today_earnings ?? c.todayEarnings ?? c.earningsToday ?? 0) || 0,
      avgDeliveryMinutes: Number(c.avg_delivery_minutes ?? c.avgDeliveryMinutes ?? 14.2) || 14.2,
      activeCount: Number(c.active_count ?? c.activeCount ?? 0) || 0
    };
  }

  function paymentBadgeHtml(method) {
    if (method === 'card_on_delivery') {
      return '<span class="badge badge-amber">💳 Kapıda POS</span>';
    }
    if (method === 'online_paid') {
      return '<span class="badge badge-emerald">✅ Online Ödendi</span>';
    }
    return '<span class="badge badge-sky">💵 Kapıda Nakit</span>';
  }

  function statusBadgeHtml(status) {
    const map = {
      pending_credit: ['⏳ Kontör Bekliyor', 'badge-amber'],
      pending: ['📥 Havuzda Bekliyor', 'badge-sky'],
      ready: ['🍳 Hazır / Havuzda', 'badge-sky'],
      assigned: ['🛵 Kurye Atandı', 'badge-amber'],
      picked_up: ['🚀 Yolda (Teslim Alındı)', 'badge-emerald'],
      delivered: ['✅ Teslim Edildi', 'badge-emerald'],
      cancelled: ['✕ İptal Edildi', 'badge-danger'],
      returned: ['↩ İade', 'badge-danger']
    };
    const [label, cls] = map[status] || [status, 'badge-slate'];
    return `<span class="badge ${cls}">${esc(label)}</span>`;
  }

  function orderTypeLabel(orderType) {
    if (orderType === 'takeaway') return '🛍️ Gel-Al';
    if (orderType === 'dine_in') return '🍽️ Salon';
    return '🛵 Paket';
  }

  /* =========================================================
     ÇİFT HARİTA BAĞLANTILARI (GOOGLE MAPS + YANDEX HARİTA YAN YANA)
     ========================================================= */
  function buildDualNavLinksHtml({ lat, lng, address, city = '' }) {
    const hasCoord = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && lat !== null && lng !== null;
    const fullQuery = [address, city].filter(Boolean).join(', ').trim();

    let gmapsUrl = 'https://www.google.com/maps';
    let yandexUrl = 'https://yandex.com.tr/harita/';

    if (hasCoord) {
      const cLat = Number(lat).toFixed(6);
      const cLng = Number(lng).toFixed(6);
      gmapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${cLat},${cLng}`;
      yandexUrl = `https://yandex.com.tr/harita/?rtext=~${cLat},${cLng}&rtt=auto`;
    } else if (fullQuery) {
      const q = encodeURIComponent(fullQuery);
      gmapsUrl = `https://www.google.com/maps/search/?api=1&query=${q}`;
      yandexUrl = `https://yandex.com.tr/harita/?text=${q}`;
    }

    return `
      <div class="nav-dual-btns">
        <a href="${esc(gmapsUrl)}" target="_blank" rel="noopener noreferrer" class="map-link-btn gmaps" title="Google Maps ile Aç">🗺️ Google Maps</a>
        <a href="${esc(yandexUrl)}" target="_blank" rel="noopener noreferrer" class="map-link-btn yandex" title="Yandex Harita ile Aç">🧭 Yandex</a>
      </div>
    `;
  }

  /* =========================================================
     YEREL <dialog> YARDIMCILARI (.showModal() / .close())
     ========================================================= */
  function openDialog(id) {
    const dlg = $(id);
    if (!dlg) return;
    if (typeof dlg.showModal === 'function') {
      if (!dlg.open) {
        try {
          dlg.showModal();
        } catch (_) {
          dlg.setAttribute('open', '');
        }
      }
    } else {
      dlg.setAttribute('open', '');
    }
  }

  function closeDialog(id) {
    const dlg = $(id);
    if (!dlg) return;
    if (typeof dlg.close === 'function' && dlg.open) {
      dlg.close();
    } else {
      dlg.removeAttribute('open');
    }
  }

  /* =========================================================
     HTTP İSTEK YARDIMCISI (SIFIR YAKALANMAMIŞ HATA)
     ========================================================= */
  async function apiFetch(pathname, { method = 'GET', body = undefined, token = state.token, expectText = false } = {}) {
    const headers = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(pathname, { method, headers, body: payload });
    const ct = res.headers.get('content-type') || '';
    const data = expectText || !ct.includes('application/json') ? await res.text() : await res.json();
    if (!res.ok) {
      const msg = (data && typeof data === 'object' && (data.error || data.message)) || `İstek başarısız (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* =========================================================
     SESLİ UYARI (WEB AUDIO API) & BAS-KONUŞ TELSİZ MOTORU
     ========================================================= */
  function playAlertTone(kind = 'order') {
    if (state.radioMuted) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      const notes = kind === 'radio' ? [587.33, 880] : [659.25, 880, 1046.5];
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + i * 0.11);
        gain.gain.setValueAtTime(0.001, now + i * 0.11);
        gain.gain.exponentialRampToValueAtTime(0.14, now + i * 0.11 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.11 + 0.16);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.11);
        osc.stop(now + i * 0.11 + 0.17);
      });
      setTimeout(() => {
        if (ctx.state !== 'closed' && typeof ctx.close === 'function') {
          ctx.close().catch(() => {});
        }
      }, 900);
    } catch (_) {
      // Autoplay kilidi varsa sessiz geç
    }
  }

  function playIncomingRadio(tx) {
    if (!tx || state.radioMuted) return;
    playAlertTone('radio');
    const audioUrl = tx.audio_data_url || tx.audioDataUrl;
    const textNote = tx.text_note || tx.textNote || '';
    const sender = tx.sender_name || tx.senderName || 'Saha';

    if (audioUrl && typeof audioUrl === 'string' && audioUrl.startsWith('data:audio')) {
      try {
        const audio = new Audio(audioUrl);
        audio.play().catch(() => {});
        return;
      } catch (_) {}
    }

    if (textNote && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(`${sender}: ${textNote}`);
        utter.lang = 'tr-TR';
        utter.rate = 1.04;
        window.speechSynthesis.speak(utter);
      } catch (_) {}
    }
  }

  async function togglePushToTalk(btnEl, channel = 'genel') {
    if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
      state.mediaRecorder.stop();
      return;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function' || typeof window.MediaRecorder === 'undefined') {
      toast('Bu cihazda mikrofon kaydı desteklenmiyor; yan kutudan hızlı sesli anons gönderebilirsiniz.', 'warn');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : '';
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 16000 })
        : new MediaRecorder(stream);

      state.mediaRecorder = recorder;
      state.audioChunks = [];
      state.recordingStartTs = Date.now();
      if (btnEl) {
        btnEl.classList.add('recording');
        btnEl.textContent = '⏹️ Kaydı Gönder';
      }

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) state.audioChunks.push(ev.data);
      };

      recorder.onstop = async () => {
        clearTimeout(state.recordingStopTimer);
        stream.getTracks().forEach((t) => t.stop());
        if (btnEl) {
          btnEl.classList.remove('recording');
          btnEl.textContent = btnEl.id === 'btn-courier-ptt' ? '🎙️ BAS-KONUŞ TELSİZ' : '🎙️ Bas-Konuş Kaydet';
        }
        const durationSec = Math.max(0.8, Math.round((Date.now() - state.recordingStartTs) / 100) / 10);
        const blob = new Blob(state.audioChunks, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size > 240000) {
          toast('Ses kaydı çok uzun oldu; lütfen kısa telsiz anonsu gönderin.', 'warn');
          return;
        }
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(String(reader.result || ''));
          reader.readAsDataURL(blob);
        });
        await sendRadioTransmission({
          channel,
          textNote: `Sesli Telsiz Anonsu (${durationSec} sn)`,
          audioDataUrl: dataUrl,
          durationSec
        });
      };

      recorder.start();
      state.recordingStopTimer = setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, 7000);
    } catch (_) {
      toast('Mikrofon izni kapalı; metin kutusundan sesli okunan telsiz anonsu gönderebilirsiniz.', 'warn');
    }
  }

  async function sendRadioTransmission({ channel = 'genel', textNote = '', audioDataUrl = undefined, durationSec = 2.5 }) {
    if (!textNote && !audioDataUrl) return;
    try {
      await apiFetch('/api/radio', {
        method: 'POST',
        body: { channel, textNote, audioDataUrl, durationSec }
      });
      toast('📻 Telsiz anonsu tüm ekibe yayınlandı.');
      await refreshBootstrapSilent();
    } catch (err) {
      toast(err.message || 'Telsiz gönderilemedi.', 'error');
    }
  }

  function renderRadioBars(transmissions = []) {
    const list = Array.isArray(transmissions) ? transmissions : [];
    const latest = list[0];
    if (latest && latest.id && latest.id !== state.lastRadioId) {
      const wasInitialized = state.lastRadioId !== 0;
      state.lastRadioId = latest.id;
      if (wasInitialized) {
        playIncomingRadio(latest);
      }
    }
    const summaryText = latest
      ? `📻 [${esc(latest.channel || 'genel')}] ${esc(latest.sender_name || latest.senderName || 'Merkez')}: ${esc(latest.text_note || latest.textNote || 'Sesli Anons')} (${formatTimeShort(latest.created_at || latest.createdAt)})`
      : '📻 Telsiz kanalı hazır — Henüz anons yok.';

    const adminLast = $('admin-radio-last');
    if (adminLast) adminLast.innerHTML = summaryText;
    const courierLast = $('courier-radio-last');
    if (courierLast) courierLast.innerHTML = summaryText;

    const historyBox = $('radio-history-list');
    if (historyBox) {
      if (!list.length) {
        historyBox.innerHTML = '<p class="text-muted">Henüz telsiz kaydı bulunmuyor.</p>';
      } else {
        historyBox.innerHTML = list.map((r) => {
          const audio = r.audio_data_url || r.audioDataUrl;
          return `
            <div class="compact-item-card">
              <div class="card-head-between">
                <strong>${esc(r.sender_name || r.senderName || 'Ekip')} <span class="badge badge-slate">${esc(r.channel || 'genel')}</span></strong>
                <span class="text-muted">${formatTimeShort(r.created_at || r.createdAt)}</span>
              </div>
              <div>${esc(r.text_note || r.textNote || 'Sesli Telsiz Kaydı')}</div>
              ${audio ? `<audio controls src="${esc(audio)}" style="width:100%;margin-top:6px;height:32px;"></audio>` : ''}
            </div>
          `;
        }).join('');
      }
    }
  }

  /* =========================================================
     ÇİFT MOTORLU HARİTA (LEAFLET + YEDEK VEKTÖR HARİTA)
     KRİTİK KURAL: Dükkan isimleri haritada sürekli açık kalmaz,
                   YALNIZCA pine tıklandığında popup ile açılır!
     ========================================================= */
  function renderAdminMap() {
    if (!state.bootstrap || state.currentRoute !== '/panel' || state.adminTab !== 'harita') return;

    const tenant = state.bootstrap.tenant || {};
    const centerLat = Number(tenant.center_lat ?? tenant.centerLat ?? state.config.defaultCenter[0]) || 39.5961;
    const centerLng = Number(tenant.center_lng ?? tenant.centerLng ?? state.config.defaultCenter[1]) || 27.0244;

    const shops = (state.bootstrap.shops || []).map(normShop);
    const couriers = (state.bootstrap.couriers || []).map(normCourier);
    const orders = (state.bootstrap.orders || []).map(normOrder);

    // Pin seçim listesi
    const pinSelect = $('map-pin-shop-select');
    if (pinSelect) {
      const currentVal = state.pinPickShopId ? String(state.pinPickShopId) : '';
      pinSelect.innerHTML = `<option value="">📌 Haritadan Dükkan Pini Düzenle (Kapalı)</option>` +
        shops.map((s) => `<option value="${s.id}" ${String(s.id) === currentVal ? 'selected' : ''}>📌 Pin Seç: ${esc(s.name)}</option>`).join('');
    }
    const pinBanner = $('map-pin-mode-banner');
    if (pinBanner) pinBanner.hidden = !state.pinPickShopId;

    // Sağ rehber listeleri (Her adreste Google Maps + Yandex yan yana!)
    const couriersSide = $('map-couriers-list');
    if (couriersSide) {
      couriersSide.innerHTML = couriers.length
        ? couriers.map((c) => `
          <div class="compact-item-card">
            <div class="card-head-between">
              <strong>${c.vehicleType === 'car' ? '🚗' : '🛵'} ${esc(c.name)}</strong>
              <span class="badge ${c.isOnline ? (c.onBreak ? 'badge-amber' : 'badge-emerald') : 'badge-slate'}">
                ${c.isOnline ? (c.onBreak ? 'Molada' : 'Çevrimiçi') : 'Çevrimdışı'}
              </span>
            </div>
            <div class="text-muted">
              🔋 %${c.batteryPct} • ${c.hasPos ? '💳 POS Var' : 'POS Yok'} • Aktif Paket: ${c.activeCount}
            </div>
            ${c.lat && c.lng ? buildDualNavLinksHtml({ lat: c.lat, lng: c.lng, address: c.name }) : ''}
          </div>
        `).join('')
        : '<p class="text-muted">Kayıtlı kurye yok.</p>';
    }

    const shopsSide = $('map-shops-list');
    if (shopsSide) {
      shopsSide.innerHTML = shops.length
        ? shops.map((s) => `
          <div class="compact-item-card">
            <div class="card-head-between">
              <strong>🏪 ${esc(s.name)}</strong>
              <span class="badge ${s.lat && s.lng ? 'badge-emerald' : 'badge-amber'}">
                ${s.lat && s.lng ? 'Pin Hazır' : 'Pin Eksik'}
              </span>
            </div>
            <div class="text-muted">${esc(s.address || tenant.city || '')}</div>
            <div class="card-head-between" style="margin-top:4px;">
              ${buildDualNavLinksHtml({ lat: s.lat, lng: s.lng, address: s.address || s.name, city: tenant.city })}
              <button type="button" class="btn btn-ghost-sm" data-pick-shop-pin="${s.id}">📌 Pin Seç</button>
            </div>
          </div>
        `).join('')
        : '<p class="text-muted">Kayıtlı işletme yok.</p>';
    }

    const leafletEl = $('admin-leaflet-map');
    const fallbackEl = $('admin-fallback-map');
    if (!leafletEl || !fallbackEl) return;

    if (typeof window.L !== 'undefined') {
      leafletEl.hidden = false;
      fallbackEl.hidden = true;

      if (!state.leafletMap) {
        state.leafletMap = window.L.map(leafletEl, { zoomControl: true }).setView([centerLat, centerLng], 14);
        const tiles = window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap'
        });
        tiles.on('tileerror', () => {});
        tiles.addTo(state.leafletMap);
        state.leafletLayerGroup = window.L.layerGroup().addTo(state.leafletMap);

        state.leafletMap.on('click', (ev) => {
          if (!state.pinPickShopId) return;
          savePickedShopPin(state.pinPickShopId, ev.latlng.lat, ev.latlng.lng);
        });
      }

      setTimeout(() => {
        if (state.leafletMap) state.leafletMap.invalidateSize();
      }, 60);

      state.leafletLayerGroup.clearLayers();

      // 1. Dükkan Pinleri: İsimler haritada AÇIK DEĞİL; YALNIZCA tıklanınca popup ile açılır!
      shops.forEach((s) => {
        if (s.lat === null || s.lng === null) return;
        const icon = window.L.divIcon({
          className: '',
          html: `<div class="pkt-div-pin pkt-pin-shop" title="İşletme Detayı İçin Tıklayın">🏪</div>`,
          iconSize: [34, 34],
          iconAnchor: [17, 17]
        });
        const popupHtml = `
          <div style="min-width:190px;color:#0f172a;">
            <strong style="font-size:14px;">🏪 ${esc(s.name)}</strong>
            ${s.brandTag ? `<div><small>Marka: ${esc(s.brandTag)}</small></div>` : ''}
            <div style="font-size:12px;margin:4px 0;">${esc(s.address || '')}</div>
            <div style="margin-top:6px;">
              <a href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}" target="_blank" rel="noopener">Google Maps</a>
              &nbsp;|&nbsp;
              <a href="https://yandex.com.tr/harita/?rtext=~${s.lat},${s.lng}&rtt=auto" target="_blank" rel="noopener">Yandex Harita</a>
            </div>
          </div>
        `;
        window.L.marker([s.lat, s.lng], { icon }).bindPopup(popupHtml).addTo(state.leafletLayerGroup);
      });

      // 2. Kurye Canlı GPS Pinleri (Batarya %, POS Rozeti, Aktif Paket Sayısı)
      couriers.forEach((c) => {
        if (c.lat === null || c.lng === null) return;
        const cls = !c.isOnline ? 'offline' : c.hasPos ? '' : 'nopos';
        const icon = window.L.divIcon({
          className: '',
          html: `<div class="pkt-div-pin pkt-pin-courier ${cls}">${c.vehicleType === 'car' ? '🚗' : '🛵'} ${c.hasPos ? '💳' : ''} %${c.batteryPct} (${c.activeCount})</div>`,
          iconSize: [108, 28],
          iconAnchor: [54, 14]
        });
        const popupHtml = `
          <div style="min-width:185px;color:#0f172a;">
            <strong>${esc(c.name)}</strong><br>
            Durum: ${c.isOnline ? (c.onBreak ? 'Molada' : 'Çevrimiçi') : 'Çevrimdışı'}<br>
            POS Cihazı: ${c.hasPos ? 'Var (Zimmetli)' : 'Yok'}<br>
            Batarya: %${c.batteryPct} • Aktif Paket: ${c.activeCount}
          </div>
        `;
        window.L.marker([c.lat, c.lng], { icon }).bindPopup(popupHtml).addTo(state.leafletLayerGroup);
      });

      // 3. Aktif Sipariş Hedef Pinleri
      orders
        .filter((o) => ['pending', 'assigned', 'picked_up'].includes(o.status) && o.destLat && o.destLng)
        .forEach((o) => {
          const seqLabel = o.routeSeq ? o.routeSeq : '•';
          const icon = window.L.divIcon({
            className: '',
            html: `<div class="pkt-div-pin pkt-pin-order">${esc(seqLabel)}</div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14]
          });
          const popupHtml = `
            <div style="min-width:190px;color:#0f172a;">
              <strong>📦 ${esc(o.trackingCode)}</strong> — ${esc(o.customerName)}<br>
              <small>${esc(o.customerAddress)}</small><br>
              Tutar: ${formatTL(o.orderAmount)} (${o.paymentMethod === 'card_on_delivery' ? 'Kapıda POS' : o.paymentMethod === 'online_paid' ? 'Online' : 'Nakit'})
            </div>
          `;
          window.L.marker([Number(o.destLat), Number(o.destLng)], { icon }).bindPopup(popupHtml).addTo(state.leafletLayerGroup);
        });
    } else {
      // YEDEK ETKİLEŞİMLİ VEKTÖR HARİTA (CDN erişilemezse bile 0 konsol hatası!)
      leafletEl.hidden = true;
      fallbackEl.hidden = false;
      renderFallbackSvgMap(fallbackEl, { centerLat, centerLng, shops, couriers, orders });
    }
  }

  function renderFallbackSvgMap(container, { centerLat, centerLng, shops, couriers, orders }) {
    const span = 0.035;
    const toXY = (lat, lng) => {
      const x = Math.min(95, Math.max(5, 50 + ((Number(lng) - centerLng) / span) * 80));
      const y = Math.min(92, Math.max(8, 50 - ((Number(lat) - centerLat) / span) * 80));
      return { x, y };
    };

    const shopNodes = shops
      .filter((s) => s.lat !== null && s.lng !== null)
      .map((s) => {
        const { x, y } = toXY(s.lat, s.lng);
        return `<button type="button" class="pkt-div-pin pkt-pin-shop" style="position:absolute;left:${x}%;top:${y}%;transform:translate(-50%,-50%);cursor:pointer;" data-fallback-popup="🏪 ${esc(s.name)} — ${esc(s.address || '')}">🏪</button>`;
      }).join('');

    const courierNodes = couriers
      .filter((c) => c.lat !== null && c.lng !== null)
      .map((c) => {
        const { x, y } = toXY(c.lat, c.lng);
        return `<button type="button" class="pkt-div-pin pkt-pin-courier ${c.hasPos ? '' : 'nopos'}" style="position:absolute;left:${x}%;top:${y}%;transform:translate(-50%,-50%);cursor:pointer;" data-fallback-popup="🛵 ${esc(c.name)} • Batarya %${c.batteryPct} • ${c.hasPos ? 'POS Var' : 'POS Yok'}">🛵 %${c.batteryPct}</button>`;
      }).join('');

    const orderNodes = orders
      .filter((o) => ['pending', 'assigned', 'picked_up'].includes(o.status) && o.destLat && o.destLng)
      .map((o) => {
        const { x, y } = toXY(o.destLat, o.destLng);
        return `<button type="button" class="pkt-div-pin pkt-pin-order" style="position:absolute;left:${x}%;top:${y}%;transform:translate(-50%,-50%);cursor:pointer;" data-fallback-popup="📦 ${esc(o.trackingCode)} • ${esc(o.customerName)}">${esc(o.routeSeq || '•')}</button>`;
      }).join('');

    container.innerHTML = `
      <div id="fallback-canvas" style="position:relative;width:100%;height:100%;background:radial-gradient(circle,#152648 0%,#0b152b 100%);overflow:hidden;">
        <div style="position:absolute;inset:12px;border:1px dashed rgba(148,163,184,0.2);border-radius:10px;pointer-events:none;"></div>
        <div id="fallback-popup-banner" style="position:absolute;top:12px;left:12px;z-index:5;background:rgba(15,23,42,0.92);padding:6px 12px;border-radius:8px;font-size:12px;border:1px solid rgba(52,211,153,0.4);">
          Harita Hazır — İşletme ismini görmek için 🏪 pinine tıklayın.
        </div>
        ${shopNodes}
        ${courierNodes}
        ${orderNodes}
      </div>
    `;

    const canvas = container.querySelector('#fallback-canvas');
    if (canvas) {
      canvas.addEventListener('click', (ev) => {
        const popBtn = ev.target.closest('[data-fallback-popup]');
        if (popBtn) {
          const banner = container.querySelector('#fallback-popup-banner');
          if (banner) banner.textContent = popBtn.getAttribute('data-fallback-popup');
          return;
        }
        if (state.pinPickShopId) {
          const rect = canvas.getBoundingClientRect();
          const relX = (ev.clientX - rect.left) / rect.width;
          const relY = (ev.clientY - rect.top) / rect.height;
          const pickedLng = centerLng + ((relX * 100 - 50) / 80) * span;
          const pickedLat = centerLat - ((relY * 100 - 50) / 80) * span;
          savePickedShopPin(state.pinPickShopId, pickedLat, pickedLng);
        }
      });
    }
  }

  async function savePickedShopPin(shopId, lat, lng) {
    try {
      await apiFetch(`/api/admin/shops/${shopId}`, {
        method: 'PATCH',
        body: { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) }
      });
      toast(`📌 İşletme kapı pini kaydedildi (${lat.toFixed(5)}, ${lng.toFixed(5)})`);
      state.pinPickShopId = null;
      await refreshBootstrapSilent();
    } catch (err) {
      toast(err.message || 'Pin kaydedilemedi.', 'error');
    }
  }

  /* =========================================================
     1. VİTRİN, KONTÖR HESAPLAYICI & MÜŞTERİ CANLI TAKİP EKRANI
     ========================================================= */
  function renderCreditCalculator() {
    const slider = $('calc-daily-slider');
    const dailyLabel = $('calc-daily-val');
    const tiersEl = $('calc-package-tiers');
    const monthlyOrdersEl = $('calc-monthly-orders');
    const unitPriceEl = $('calc-unit-price');
    const monthlyCostEl = $('calc-monthly-cost');
    if (!slider || !tiersEl) return;

    const packs = Array.isArray(state.config.creditPackages) && state.config.creditPackages.length
      ? state.config.creditPackages
      : DEFAULT_CREDIT_PACKAGES;

    if (state.selectedCalcTierIndex >= packs.length) state.selectedCalcTierIndex = 0;

    tiersEl.innerHTML = packs.map((p, idx) => {
      const unit = Number(p.unitPrice ?? (p.total / p.credits) ?? 1.2);
      const total = Number(p.total ?? p.credits * unit);
      return `
        <button type="button" class="calc-tier-btn ${idx === state.selectedCalcTierIndex ? 'active' : ''}" data-calc-tier="${idx}">
          <strong>${formatInt(p.credits)} Kontör</strong>
          <span>${unit.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} ₺ / paket</span>
          <small>Toplam: ${formatInt(total)} ₺ • Süresiz</small>
        </button>
      `;
    }).join('');

    const daily = Number(slider.value) || 120;
    const monthly = daily * 30;
    const chosen = packs[state.selectedCalcTierIndex] || packs[0];
    const unitPrice = Number(chosen.unitPrice ?? 1.2);
    const estMonthlyCost = monthly * unitPrice;

    if (dailyLabel) dailyLabel.textContent = `${formatInt(daily)} Paket / Gün`;
    if (monthlyOrdersEl) monthlyOrdersEl.textContent = `${formatInt(monthly)} Paket`;
    if (unitPriceEl) unitPriceEl.textContent = `${unitPrice.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} ₺ / Paket`;
    if (monthlyCostEl) monthlyCostEl.textContent = formatTL(estMonthlyCost);
  }

  async function loadPublicConfigAndDemos() {
    try {
      const [cfg, health, demos] = await Promise.all([
        apiFetch('/api/config').catch(() => null),
        apiFetch('/health').catch(() => null),
        apiFetch('/api/auth/demo-accounts').catch(() => null)
      ]);
      if (cfg && typeof cfg === 'object') {
        state.config = { ...state.config, ...cfg };
        const taglineEl = $('vitrin-tagline');
        if (taglineEl && cfg.tagline) {
          // Alt başlığı zengin tutarken sistem adını doğrula
        }
      }
      if (health && health.ok) {
        const pill = $('vitrin-health-pill');
        if (pill) pill.textContent = `Canlı Motor Aktif • ${health.tenants || 1}+ Operasyon`;
      }
      if (demos) {
        state.demoAccounts = demos;
        const sampleCode =
          demos.sampleTrackingCode ||
          demos.trackingCode ||
          (Array.isArray(demos.accounts) && demos.accounts.find((a) => a.sampleTrackingCode)?.sampleTrackingCode) ||
          '';
        if (sampleCode) state.sampleTrackingCode = sampleCode;
      }
    } catch (_) {}
    renderCreditCalculator();
  }

  async function renderTrackScreen(codeFromUrl) {
    clearInterval(state.trackPollTimer);
    const input = $('input-track-code');
    const box = $('track-result-box');
    if (!box) return;

    let code = (codeFromUrl || '').trim();
    if (!code || code.toLowerCase() === 'demo') {
      code = state.sampleTrackingCode || '';
      if (!code) {
        // Demo hesaptan örnek bir aktif takip kodu çöz
        try {
          const demoLogin = await apiFetch('/api/auth/login', {
            method: 'POST',
            body: DEMO_CREDENTIALS.admin
          });
          if (demoLogin && demoLogin.token) {
            const boot = await apiFetch('/api/bootstrap', { token: demoLogin.token });
            const firstOrder = (boot.orders || []).find((o) => !['cancelled'].includes(o.status)) || (boot.orders || [])[0];
            if (firstOrder) {
              code = firstOrder.tracking_code || firstOrder.trackingCode || '';
              state.sampleTrackingCode = code;
            }
          }
        } catch (_) {}
      }
    }

    if (input && code) input.value = code;

    if (!code) {
      box.innerHTML = `<p class="text-muted">Sipariş durumunuzu canlı izlemek için yukarıdaki kutuya <strong>PKT-...</strong> takip kodunuzu girin.</p>`;
      return;
    }

    const fetchAndPaint = async () => {
      try {
        const res = await apiFetch(`/api/public/track/${encodeURIComponent(code)}`, { token: '' });
        const o = res.order || res;
        const st = o.status || 'pending';
        const rankMap = { pending_credit: 1, pending: 1, ready: 1, assigned: 2, picked_up: 3, delivered: 4 };
        const rank = rankMap[st] || 1;
        const eta = o.estimatedMinutesLeft ?? o.estimated_minutes_left;
        const courierFirst = o.courierFirstName ?? o.courier_first_name ?? '';
        const vehicle = o.vehicleType ?? o.vehicle_type ?? 'motorcycle';
        const pinHint = o.deliveryPinHint ?? o.delivery_pin_hint ?? o.deliveryPin ?? '****';

        box.innerHTML = `
          <div class="card-head-between">
            <div>
              <span class="badge badge-emerald">CANLI SİPARİŞ TAKİBİ</span>
              <h2 style="margin:6px 0 2px;">${esc(o.shopName || o.shop_name || 'Restoran Siparişi')}</h2>
              <span class="text-muted">Takip Kodu: <code>${esc(o.trackingCode || o.tracking_code || code)}</code></span>
            </div>
            <div style="text-align:right;">
              ${statusBadgeHtml(st)}
              <div style="margin-top:6px;font-weight:800;font-size:1.1rem;" class="text-emerald">
                ${st === 'delivered' ? 'Teslimat Tamamlandı' : eta ? `Tahmini Varış: ~${esc(eta)} dk` : 'Hazırlanıyor'}
              </div>
            </div>
          </div>

          <div class="track-steps">
            <div class="track-step ${rank > 1 ? 'done' : rank === 1 ? 'current' : ''}">
              <strong>1. Alındı</strong>
              <div>Mutfakta hazırlanıyor</div>
            </div>
            <div class="track-step ${rank > 2 ? 'done' : rank === 2 ? 'current' : ''}">
              <strong>2. Kurye Atandı</strong>
              <div>${courierFirst ? `${esc(courierFirst)} yönlendirildi` : 'Saha planlamasında'}</div>
            </div>
            <div class="track-step ${rank > 3 ? 'done' : rank === 3 ? 'current' : ''}">
              <strong>3. Yolda</strong>
              <div>${vehicle === 'car' ? '🚗 Araçlı kurye yolda' : '🛵 Motorlu kurye yolda'}</div>
            </div>
            <div class="track-step ${rank === 4 ? 'current' : ''}">
              <strong>4. Teslim Edildi</strong>
              <div>Afiyet olsun!</div>
            </div>
          </div>

          <div class="form-row-2">
            <div class="compact-item-card">
              <span class="text-muted">Sipariş Tutarı &amp; Ödeme</span>
              <div><strong>${formatTL(o.orderAmount ?? o.order_amount ?? 0)}</strong> • ${paymentBadgeHtml(o.paymentMethod || o.payment_method)}</div>
            </div>
            <div class="compact-item-card">
              <span class="text-muted">Saha Kurye Bilgisi (Gizlilik Korumalı)</span>
              <div><strong>${courierFirst ? `${esc(courierFirst)} (${vehicle === 'car' ? 'Araç' : 'Motosiklet'})` : 'Kurye atanmak üzere'}</strong></div>
            </div>
          </div>

          <div class="track-pin-highlight">
            <div>
              <strong>🔐 Teslimat Doğrulama Kodu</strong>
              <div class="text-muted">Paketinizi teslim alırken kuryeye bu kodu söyleyebilirsiniz.</div>
            </div>
            <div class="track-pin-code">${esc(pinHint)}</div>
          </div>
        `;
      } catch (err) {
        box.innerHTML = `<p class="text-danger"><strong>${esc(code)}</strong> kodlu sipariş bulunamadı. Lütfen takip kodunuzu kontrol edin.</p>`;
      }
    };

    await fetchAndPaint();
    state.trackPollTimer = setInterval(() => {
      if (state.currentRoute.startsWith('/takip')) fetchAndPaint();
    }, 12000);
  }

  /* =========================================================
     2. OPERASYON MERKEZİ / YÖNETİCİ PANELİ (/panel) RENDER & AKSİYONLAR
     ========================================================= */
  function renderAdminWorkspace() {
    const boot = state.bootstrap;
    if (!boot) return;

    const tenant = boot.tenant || {};
    const shops = (boot.shops || []).map(normShop);
    const groups = boot.merchantGroups || boot.merchant_groups || [];
    const zones = boot.zones || [];
    const couriers = (boot.couriers || []).map(normCourier);
    const orders = (boot.orders || []).map(normOrder);
    const ledger = boot.creditLedger || boot.credit_ledger || [];
    const webhooks = boot.webhookLogs || boot.webhook_logs || [];
    const radios = boot.radioTransmissions || boot.radio_transmissions || [];

    const shopMap = new Map(shops.map((s) => [Number(s.id), s]));
    const courierMap = new Map(couriers.map((c) => [Number(c.id), c]));

    // Aktif paket sayılarını kuryelere işle
    const activeByCourier = new Map();
    orders.forEach((o) => {
      if (['assigned', 'picked_up'].includes(o.status) && o.courierId) {
        activeByCourier.set(Number(o.courierId), (activeByCourier.get(Number(o.courierId)) || 0) + 1);
      }
    });
    couriers.forEach((c) => {
      if (!c.activeCount) c.activeCount = activeByCourier.get(Number(c.id)) || 0;
    });

    if ($('admin-tenant-name')) $('admin-tenant-name').textContent = tenant.name || 'Operasyon Merkezi';
    if ($('admin-tenant-meta')) {
      $('admin-tenant-meta').textContent = `${tenant.city || 'Türkiye'} • ${state.user?.displayName || 'Yönetici'}`;
    }

    renderRadioBars(radios);

    // KPI Şeridi Hesaplamaları
    const pendingCount = orders.filter((o) => o.status === 'pending' || o.status === 'ready').length;
    const pendingCreditCount = orders.filter((o) => o.status === 'pending_credit').length;
    const activeOrders = orders.filter((o) => ['assigned', 'picked_up'].includes(o.status));
    const uniqueBatches = new Set(activeOrders.map((o) => o.batchId || `S-${o.id}`)).size;
    const onlineCouriers = couriers.filter((c) => c.isOnline && !c.onBreak);
    const posOnlineCount = onlineCouriers.filter((c) => c.hasPos).length;
    const creditsBalance = Number(tenant.credits_balance ?? tenant.creditsBalance ?? 0);
    const creditsEnabled = Boolean(Number(tenant.credits_enabled ?? tenant.creditsEnabled ?? 1));

    const deliveredOrders = orders.filter((o) => o.status === 'delivered');
    const dailyTurnover = deliveredOrders.reduce((s, o) => s + o.orderAmount, 0);
    const serviceRevenue = deliveredOrders.reduce((s, o) => s + o.deliveryFee, 0);
    const courierPayout = deliveredOrders.reduce((s, o) => s + o.courierEarning, 0);
    const netProfit = serviceRevenue - courierPayout;

    if ($('kpi-pending')) $('kpi-pending').textContent = String(pendingCount);
    if ($('kpi-pending-sub')) {
      $('kpi-pending-sub').textContent = pendingCreditCount > 0
        ? `+${pendingCreditCount} kontör bekleyen`
        : 'Dağıtıma hazır paket';
    }
    if ($('kpi-active-batches')) $('kpi-active-batches').textContent = `${uniqueBatches} Grup (${activeOrders.length})`;
    if ($('kpi-online-couriers')) $('kpi-online-couriers').textContent = `${onlineCouriers.length} / ${couriers.length}`;
    if ($('kpi-pos-sub')) $('kpi-pos-sub').textContent = `${posOnlineCount} POS cihazlı aktif kurye`;
    if ($('kpi-credits')) $('kpi-credits').textContent = formatInt(creditsBalance);
    if ($('kpi-credits-sub')) $('kpi-credits-sub').textContent = creditsEnabled ? 'Kontör modu açık • Yanmaz' : 'Kontör düşümü pasif';
    if ($('kpi-turnover')) $('kpi-turnover').textContent = formatTL(dailyTurnover);
    if ($('kpi-delivered-sub')) $('kpi-delivered-sub').textContent = `${deliveredOrders.length} teslimat tamamlandı`;
    if ($('kpi-net-profit')) $('kpi-net-profit').textContent = formatTL(netProfit);
    if ($('kpi-revenue-sub')) $('kpi-revenue-sub').textContent = `Gelir ${formatTL(serviceRevenue)} • Hakediş ${formatTL(courierPayout)}`;

    // Sekme 1: Sipariş Havuzu Tablosu
    if (Array.isArray(boot.batchesPreview) && $('smart-batches-box') && !$('smart-batches-box').dataset.manualLoaded) {
      renderSmartBatchesCards(boot.batchesPreview, shopMap, courierMap);
    }
    renderAdminOrdersTable(orders, shops, couriers, shopMap, courierMap, tenant.city || '');

    // Sekme 2: Canlı Harita
    renderAdminMap();

    // Sekme 3: İşletmeler, Gruplar & Bölgeler
    renderAdminShopsAndZones(shops, groups, zones, tenant.city || '');

    // Sekme 4: Kurye Filo
    renderAdminCouriersTable(couriers);

    // Sekme 5: Kontör Cüzdanı & Bekleyen Siparişler
    renderAdminCreditsTab(creditsBalance, creditsEnabled, orders, ledger, shopMap);

    // Sekme 6: Mutabakat & Finansal Düzeltme
    renderAdminReconciliationTab(orders, shops, couriers, shopMap);

    // Sekme 7: Entegrasyonlar & Webhook Logları
    renderAdminIntegrationsTab(shops, webhooks);
  }

  function renderSmartBatchesCards(batches, shopMap, courierMap) {
    const box = $('smart-batches-box');
    if (!box) return;
    if (!Array.isArray(batches) || !batches.length) {
      box.innerHTML = '';
      return;
    }

    box.innerHTML = batches.map((b, i) => {
      const bOrders = (b.orders || b.items || []).map(normOrder);
      const reqPos = Boolean(b.requiresPos ?? b.requires_pos ?? bOrders.some((o) => o.paymentMethod === 'card_on_delivery'));
      const totalKm = Number(b.estimatedTotalKm ?? b.estimated_total_km ?? 0);
      const suggested = b.suggestedCourier || b.recommendedCourier || (b.suggestedCourierId ? courierMap.get(Number(b.suggestedCourierId)) : null);

      return `
        <div class="batch-card">
          <div class="batch-card-head">
            <strong>${bOrders.length > 1 ? `🔗 Akıllı Birleşik Rota (${bOrders.length} Paket)` : `📦 Tekil Rota Grubu`}</strong>
            ${reqPos ? '<span class="badge badge-amber">💳 POS Zorunlu</span>' : '<span class="badge badge-emerald">Standart</span>'}
          </div>
          <div class="text-muted">
            Tahmini Toplam Yol: <strong>${totalKm.toFixed(2)} km</strong>
            ${suggested ? ` • Önerilen: <strong>${esc(suggested.name)}</strong>` : ''}
          </div>
          <ul class="batch-stops-list">
            ${bOrders.map((o, idx) => {
              const sName = o.shopName || shopMap.get(Number(o.shopId))?.name || `Şube #${o.shopId}`;
              return `
                <li>
                  <span><strong>${o.routeSeq || idx + 1}. Durak:</strong> ${esc(sName)} → ${esc(o.customerName)} (${esc(o.neighborhood || 'Merkez')})</span>
                  <span>${formatTL(o.orderAmount)}</span>
                </li>
              `;
            }).join('')}
          </ul>
        </div>
      `;
    }).join('');
  }

  function renderAdminOrdersTable(orders, shops, couriers, shopMap, courierMap, city) {
    const tbody = $('admin-orders-tbody');
    if (!tbody) return;

    const q = state.adminOrderSearch.trim().toLocaleLowerCase('tr-TR');
    const filtered = orders.filter((o) => {
      if (state.adminOrderFilter === 'pending' && !['pending', 'ready'].includes(o.status)) return false;
      if (state.adminOrderFilter === 'pending_credit' && o.status !== 'pending_credit') return false;
      if (state.adminOrderFilter === 'active' && !['assigned', 'picked_up'].includes(o.status)) return false;
      if (state.adminOrderFilter === 'delivered' && o.status !== 'delivered') return false;
      if (state.adminOrderFilter === 'cancelled' && !['cancelled', 'returned'].includes(o.status)) return false;

      if (q) {
        const sName = o.shopName || shopMap.get(Number(o.shopId))?.name || '';
        const hay = `${o.trackingCode} ${o.customerName} ${o.customerPhone} ${o.neighborhood} ${o.customerAddress} ${sName}`.toLocaleLowerCase('tr-TR');
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="6" data-label="Bilgi" class="text-muted">Seçili filtreye uygun sipariş bulunamadı.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map((o) => {
      const shop = shopMap.get(Number(o.shopId));
      const shopLabel = o.shopName || shop?.name || `İşletme #${o.shopId || '-'}`;
      const assignedCourier = o.courierId ? courierMap.get(Number(o.courierId)) : null;

      const courierOptions = couriers
        .map((c) => {
          const posWarn = o.paymentMethod === 'card_on_delivery' && !c.hasPos ? ' [POS YOK!]' : c.hasPos ? ' [POS]' : '';
          const stLabel = c.isOnline ? (c.onBreak ? ' (Mola)' : '') : ' (Çevrimdışı)';
          return `<option value="${c.id}" ${Number(o.courierId) === Number(c.id) ? 'selected' : ''}>${esc(c.name)}${posWarn}${stLabel}</option>`;
        }).join('');

      return `
        <tr>
          <td data-label="Paket / Kaynak">
            <div><strong><code>${esc(o.trackingCode)}</code></strong></div>
            <div class="text-muted">${orderTypeLabel(o.orderType)} • <span class="badge badge-slate">${esc(o.externalSource)}</span></div>
          </td>
          <td data-label="İşletme & Müşteri">
            <div><strong>🏪 ${esc(shopLabel)}</strong></div>
            <div>👤 ${esc(o.customerName)} ${o.customerPhone ? `<small class="text-muted">(${esc(o.customerPhone)})</small>` : ''}</div>
          </td>
          <td data-label="Adres & Navigasyon">
            <div>${esc(o.neighborhood ? o.neighborhood + ' — ' : '')}${esc(o.customerAddress || 'Gel-Al / Salon')}</div>
            <div class="text-muted">${o.distanceKm > 0 ? `${o.distanceKm.toFixed(2)} km` : ''}</div>
            ${buildDualNavLinksHtml({ lat: o.destLat, lng: o.destLng, address: o.customerAddress, city })}
          </td>
          <td data-label="Ödeme & Tutar">
            <div><strong>${formatTL(o.orderAmount)}</strong></div>
            <div>${paymentBadgeHtml(o.paymentMethod)}</div>
            <small class="text-muted">Servis: ${formatTL(o.deliveryFee)} | Kurye: ${formatTL(o.courierEarning)}</small>
          </td>
          <td data-label="Grup & Kurye">
            ${o.batchId ? `<div style="margin-bottom:4px;"><span class="badge badge-emerald">🔗 ${esc(o.batchId)} • Sıra ${esc(o.routeSeq || 1)}</span></div>` : ''}
            ${['delivered', 'cancelled'].includes(o.status)
              ? `<div>${assignedCourier ? `🛵 ${esc(assignedCourier.name)}` : '—'}</div>`
              : `
                <div class="inline-assign-group">
                  <select class="input-compact" id="assign-sel-${o.id}" aria-label="Kurye Seç">
                    <option value="">Kurye Seç...</option>
                    ${courierOptions}
                  </select>
                  <button type="button" class="btn btn-emerald btn-xs" data-manual-assign="${o.id}">Ata</button>
                </div>
              `}
          </td>
          <td data-label="Durum & İşlemler">
            <div style="margin-bottom:6px;">${statusBadgeHtml(o.status)}</div>
            <div class="action-btn-cluster">
              ${o.status === 'pending_credit' ? `<button type="button" class="btn btn-amber btn-xs" data-release-credit="${o.id}">✅ Kontör Onayla</button>` : ''}
              ${o.status === 'assigned' ? `<button type="button" class="btn btn-outline-emerald btn-xs" data-order-status="${o.id}" data-next-status="picked_up">Yola Çıkar</button>` : ''}
              ${o.status === 'picked_up' ? `<button type="button" class="btn btn-emerald btn-xs" data-order-status="${o.id}" data-next-status="delivered">Teslim Et</button>` : ''}
              <button type="button" class="btn btn-ghost-sm" data-open-chat="${o.id}" title="Paket Sohbeti">💬 Sohbet</button>
              <button type="button" class="btn btn-ghost-sm" data-open-receipt="${o.id}" title="80mm Termal Fiş">🧾 Fiş</button>
              <button type="button" class="btn btn-ghost-sm" data-open-financials="${o.id}" title="Tutar ve Ödeme Tipi Düzelt">✏️ Finans</button>
              ${!['delivered', 'cancelled'].includes(o.status) ? `<button type="button" class="btn btn-ghost-danger btn-xs" data-order-status="${o.id}" data-next-status="cancelled">İptal</button>` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  function renderAdminShopsAndZones(shops, groups, zones, city) {
    const groupsStrip = $('merchant-groups-strip');
    if (groupsStrip) {
      groupsStrip.innerHTML = groups.length
        ? groups.map((g) => {
            const subCount = shops.filter((s) => Number(s.groupId) === Number(g.id)).length;
            return `
              <div class="group-chip-card">
                <strong>🏢 ${esc(g.name)}</strong>
                <span class="badge badge-amber" style="margin-left:6px;">${subCount} Alt Marka / Şube</span>
              </div>
            `;
          }).join('')
        : '<span class="text-muted">Tanımlı çoklu marka grubu yok.</span>';
    }

    const groupMap = new Map((groups || []).map((g) => [Number(g.id), g.name]));
    const shopsTbody = $('admin-shops-tbody');
    if (shopsTbody) {
      shopsTbody.innerHTML = shops.map((s) => {
        const gName = s.groupName || (s.groupId ? groupMap.get(Number(s.groupId)) : '');
        const tariffDesc = s.tariffMode === 'percent'
          ? `%${s.commissionPct} Komisyon (Min ${formatTL(s.baseFee)})`
          : s.tariffMode === 'zone'
            ? `Bölge (Zone) Tablosu`
            : `${formatTL(s.baseFee)} + ${formatTL(s.perKmFee)}/km`;

        return `
          <tr>
            <td data-label="İşletme & Grup">
              <strong>🏪 ${esc(s.name)}</strong>
              ${gName ? `<div><span class="badge badge-amber">🏢 ${esc(gName)}</span></div>` : '<div><span class="badge badge-slate">Tekil İşletme</span></div>'}
            </td>
            <td data-label="Telefon & Adres">
              <div><code>${esc(s.phone || '—')}</code></div>
              <small class="text-muted">${esc(s.address || '')}</small>
            </td>
            <td data-label="Pin & Navigasyon">
              <div>${s.lat !== null && s.lng !== null ? `<span class="badge badge-emerald">📌 ${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}</span>` : '<span class="badge badge-amber">Pin Eksik</span>'}</div>
              ${buildDualNavLinksHtml({ lat: s.lat, lng: s.lng, address: s.address || s.name, city })}
            </td>
            <td data-label="Tarife Modeli">
              <strong>${esc(tariffDesc)}</strong>
            </td>
            <td data-label="Oto-Fiş">
              ${s.autoPrint ? '<span class="badge badge-emerald">Açık (80mm)</span>' : '<span class="badge badge-slate">Kapalı</span>'}
            </td>
            <td data-label="İşlem">
              <div class="action-btn-cluster">
                <button type="button" class="btn btn-outline-light btn-xs" data-edit-shop="${s.id}">⚙️ Düzenle</button>
                <button type="button" class="btn btn-ghost-sm" data-jump-pin-shop="${s.id}">📌 Haritada Pinle</button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }

    const zonesTbody = $('admin-zones-tbody');
    if (zonesTbody) {
      zonesTbody.innerHTML = (zones || []).length
        ? zones.map((z) => `
          <tr>
            <td data-label="Bölge Adı"><strong>${esc(z.name)}</strong></td>
            <td data-label="Mesafe Aralığı">${Number(z.min_km ?? z.minKm ?? 0)} – ${Number(z.max_km ?? z.maxKm ?? 0)} km</td>
            <td data-label="İşletme Servis Ücreti">${formatTL(z.shop_fee ?? z.shopFee ?? 0)}</td>
            <td data-label="Kurye Baz Hakedişi">${formatTL(z.courier_fee ?? z.courierFee ?? 0)}</td>
          </tr>
        `).join('')
        : `<tr><td colspan="4" data-label="Bilgi" class="text-muted">Bölge tanımı bulunmuyor.</td></tr>`;
    }

    // Yeni sipariş ve simülasyon şube açılır listelerini senkronize et
    const shopOptionsHtml = shops.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    if ($('admin-order-shop')) $('admin-order-shop').innerHTML = shopOptionsHtml;
    if ($('sim-shop-select')) $('sim-shop-select').innerHTML = shopOptionsHtml;
    if ($('shop-form-group')) {
      $('shop-form-group').innerHTML = `<option value="">Tekil İşletme (Grup Yok)</option>` +
        (groups || []).map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
    }
  }

  function renderAdminCouriersTable(couriers) {
    const tbody = $('admin-couriers-tbody');
    if (!tbody) return;

    tbody.innerHTML = couriers.map((c) => `
      <tr>
        <td data-label="Kurye & Araç">
          <strong>${c.vehicleType === 'car' ? '🚗' : '🛵'} ${esc(c.name)}</strong>
          <div class="text-muted"><code>${esc(c.phone)}</code></div>
        </td>
        <td data-label="Vardiya Durumu">
          <div class="action-btn-cluster" style="justify-content:flex-start;">
            <button type="button" class="btn ${c.isOnline ? 'btn-emerald' : 'btn-outline-light'} btn-xs" data-admin-toggle-courier="${c.id}" data-field="isOnline" data-val="${!c.isOnline}">
              ${c.isOnline ? '● Çevrimiçi' : '○ Çevrimdışı'}
            </button>
            <button type="button" class="btn ${c.onBreak ? 'btn-amber' : 'btn-ghost-sm'} btn-xs" data-admin-toggle-courier="${c.id}" data-field="onBreak" data-val="${!c.onBreak}">
              ${c.onBreak ? '☕ Molada' : 'Mola Ver'}
            </button>
          </div>
        </td>
        <td data-label="POS Cihazı">
          <button type="button" class="btn ${c.hasPos ? 'btn-amber' : 'btn-outline-light'} btn-xs" data-admin-toggle-courier="${c.id}" data-field="hasPos" data-val="${!c.hasPos}">
            ${c.hasPos ? '💳 POS Zimmetli' : 'POS Yok'}
          </button>
        </td>
        <td data-label="Batarya & Kapasite">
          🔋 %${c.batteryPct} • Yük: <strong>${c.activeCount} / ${c.maxBatch}</strong>
        </td>
        <td data-label="Hakediş">
          ${formatTL(c.perPackageFee)} / pkt + ${formatTL(c.perKmBonus)} / km
        </td>
        <td data-label="Konum & İşlem">
          <div class="action-btn-cluster">
            ${c.lat && c.lng ? buildDualNavLinksHtml({ lat: c.lat, lng: c.lng, address: c.name }) : ''}
            <button type="button" class="btn btn-outline-light btn-xs" data-edit-courier="${c.id}">⚙️ Düzenle</button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  function renderAdminCreditsTab(balance, enabled, orders, ledger, shopMap) {
    if ($('wallet-balance-num')) $('wallet-balance-num').textContent = `${formatInt(balance)} Kontör`;
    const toggleBtn = $('btn-toggle-credits-mode');
    if (toggleBtn) {
      toggleBtn.textContent = enabled ? 'Kontör Modu: AÇIK (Kapat)' : 'Kontör Modu: KAPALI (Aç)';
      toggleBtn.dataset.enabled = enabled ? '1' : '0';
    }

    const pendingCreditOrders = orders.filter((o) => o.status === 'pending_credit');
    const pendingBox = $('pending-credit-orders-box');
    const pendingList = $('pending-credit-list');
    if (pendingBox && pendingList) {
      pendingBox.hidden = pendingCreditOrders.length === 0;
      pendingList.innerHTML = pendingCreditOrders.map((o) => `
        <div class="compact-item-card card-head-between">
          <div>
            <strong><code>${esc(o.trackingCode)}</code></strong> — ${esc(shopMap.get(Number(o.shopId))?.name || '')} → ${esc(o.customerName)} (${formatTL(o.orderAmount)})
          </div>
          <button type="button" class="btn btn-amber btn-xs" data-release-credit="${o.id}">✅ Kontör Düş &amp; Havuza Al</button>
        </div>
      `).join('');
    }

    const ledgerTbody = $('admin-ledger-tbody');
    if (ledgerTbody) {
      ledgerTbody.innerHTML = (ledger || []).length
        ? ledger.map((l) => {
            const delta = Number(l.delta || 0);
            return `
              <tr>
                <td data-label="Tarih / Saat">${formatTimeShort(l.created_at || l.createdAt)}</td>
                <td data-label="İşlem Nedeni"><span class="badge badge-slate">${esc(l.reason || 'işlem')}</span></td>
                <td data-label="Değişim"><strong class="${delta >= 0 ? 'text-emerald' : 'text-amber'}">${delta > 0 ? `+${delta}` : delta}</strong></td>
                <td data-label="Kalan Bakiye"><strong>${formatInt(l.balance_after ?? l.balanceAfter ?? 0)}</strong></td>
                <td data-label="Sipariş / Not">${l.order_id ? `#${esc(l.order_id)} ` : ''}${esc(l.note || '')}</td>
              </tr>
            `;
          }).join('')
        : `<tr><td colspan="5" data-label="Bilgi" class="text-muted">Kontör hareketi bulunmuyor.</td></tr>`;
    }
  }

  function renderAdminReconciliationTab(orders, shops, couriers, shopMap) {
    const rec = state.reconciliation;
    const delivered = orders.filter((o) => o.status === 'delivered');

    const cashTotal = rec?.summary?.cashTotal ?? delivered.filter((o) => o.paymentMethod === 'cash').reduce((s, o) => s + o.orderAmount, 0);
    const posTotal = rec?.summary?.posTotal ?? rec?.summary?.cardTotal ?? delivered.filter((o) => o.paymentMethod === 'card_on_delivery').reduce((s, o) => s + o.orderAmount, 0);
    const onlineTotal = rec?.summary?.onlineTotal ?? delivered.filter((o) => o.paymentMethod === 'online_paid').reduce((s, o) => s + o.orderAmount, 0);
    const feeTotal = rec?.summary?.deliveryFeeTotal ?? delivered.reduce((s, o) => s + o.deliveryFee, 0);
    const courierTotal = rec?.summary?.courierEarningTotal ?? delivered.reduce((s, o) => s + o.courierEarning, 0);
    const netOpProfit = rec?.summary?.netProfit ?? (feeTotal - courierTotal);

    const summaryEl = $('reconcile-summary-cards');
    if (summaryEl) {
      summaryEl.innerHTML = `
        <div class="kpi-card"><span class="kpi-label">Nakit Tahsilat</span><strong class="kpi-value">${formatTL(cashTotal)}</strong></div>
        <div class="kpi-card"><span class="kpi-label">Kapıda POS Tahsilat</span><strong class="kpi-value text-amber">${formatTL(posTotal)}</strong></div>
        <div class="kpi-card"><span class="kpi-label">Online Ödenmiş</span><strong class="kpi-value">${formatTL(onlineTotal)}</strong></div>
        <div class="kpi-card"><span class="kpi-label">Net Operasyon Kârı</span><strong class="kpi-value text-emerald">${formatTL(netOpProfit)}</strong></div>
      `;
    }

    const cRows = Array.isArray(rec?.couriers) && rec.couriers.length
      ? rec.couriers
      : couriers.map((c) => {
          const mine = delivered.filter((o) => Number(o.courierId) === Number(c.id));
          return {
            name: c.name,
            deliveredCount: mine.length,
            cashCollected: mine.filter((o) => o.paymentMethod === 'cash').reduce((s, o) => s + o.orderAmount, 0),
            posCollected: mine.filter((o) => o.paymentMethod === 'card_on_delivery').reduce((s, o) => s + o.orderAmount, 0),
            earnings: mine.reduce((s, o) => s + o.courierEarning, 0)
          };
        });

    if ($('reconcile-couriers-tbody')) {
      $('reconcile-couriers-tbody').innerHTML = cRows.map((r) => `
        <tr>
          <td data-label="Kurye"><strong>${esc(r.name || r.courierName)}</strong></td>
          <td data-label="Teslimat">${r.deliveredCount ?? r.delivered_count ?? r.count ?? 0}</td>
          <td data-label="Nakit Tahsilat">${formatTL(r.cashCollected ?? r.cash_total ?? r.cashTotal ?? 0)}</td>
          <td data-label="Kapıda POS">${formatTL(r.posCollected ?? r.pos_total ?? r.cardTotal ?? 0)}</td>
          <td data-label="Hakediş"><strong class="text-emerald">${formatTL(r.earnings ?? r.courier_earning ?? r.earningTotal ?? 0)}</strong></td>
        </tr>
      `).join('');
    }

    const sRows = Array.isArray(rec?.shops) && rec.shops.length
      ? rec.shops
      : shops.map((s) => {
          const mine = delivered.filter((o) => Number(o.shopId) === Number(s.id));
          return {
            name: s.name,
            orderCount: mine.length,
            turnover: mine.reduce((sum, o) => sum + o.orderAmount, 0),
            serviceDebt: mine.reduce((sum, o) => sum + o.deliveryFee, 0)
          };
        });

    if ($('reconcile-shops-tbody')) {
      $('reconcile-shops-tbody').innerHTML = sRows.map((r) => `
        <tr>
          <td data-label="İşletme"><strong>${esc(r.name || r.shopName)}</strong></td>
          <td data-label="Paket">${r.orderCount ?? r.delivered_count ?? r.count ?? 0}</td>
          <td data-label="Paket Cirosu">${formatTL(r.turnover ?? r.order_total ?? r.totalAmount ?? 0)}</td>
          <td data-label="Kurye Servis Borcu"><strong class="text-amber">${formatTL(r.serviceDebt ?? r.delivery_fee_total ?? r.deliveryFeeTotal ?? 0)}</strong></td>
        </tr>
      `).join('');
    }

    if ($('reconcile-orders-tbody')) {
      $('reconcile-orders-tbody').innerHTML = orders.slice(0, 30).map((o) => `
        <tr>
          <td data-label="Takip & Durum"><code>${esc(o.trackingCode)}</code> ${statusBadgeHtml(o.status)}</td>
          <td data-label="İşletme & Müşteri">${esc(o.shopName || shopMap.get(Number(o.shopId))?.name || '')} → ${esc(o.customerName)}</td>
          <td data-label="Ödeme Yöntemi">${paymentBadgeHtml(o.paymentMethod)}</td>
          <td data-label="Sipariş Tutarı"><strong>${formatTL(o.orderAmount)}</strong></td>
          <td data-label="Servis / Hakediş">${formatTL(o.deliveryFee)} / ${formatTL(o.courierEarning)}</td>
          <td data-label="Düzelt">
            <button type="button" class="btn btn-amber btn-xs" data-open-financials="${o.id}">✏️ Tutar/Ödeme Düzelt</button>
          </td>
        </tr>
      `).join('');
    }
  }

  function renderAdminIntegrationsTab(shops, webhooks) {
    const grid = $('integrations-platforms-grid');
    if (grid) {
      grid.innerHTML = state.platforms.map((p) => `
        <div class="platform-sim-card">
          <div>
            <strong>🔌 ${esc(p.name || p.id)}</strong>
            <p class="text-muted" style="margin:4px 0 0;font-size:0.78rem;">${esc(p.description || 'Canlı webhook ve otomatik sipariş kanalı')}</p>
          </div>
          <button type="button" class="btn btn-outline-emerald btn-sm btn-block" data-simulate-platform="${esc(p.id)}">
            🚀 Test Siparişi Düşür
          </button>
        </div>
      `).join('');
    }

    const whTbody = $('admin-webhooks-tbody');
    if (whTbody) {
      whTbody.innerHTML = (webhooks || []).length
        ? webhooks.slice(0, 15).map((w) => `
          <tr>
            <td data-label="Kanal"><span class="badge badge-emerald">${esc(w.platform)}</span></td>
            <td data-label="Dış No"><code>${esc(w.external_id || w.externalId || '—')}</code></td>
            <td data-label="Durum">${esc(w.status || 'ok')}</td>
            <td data-label="Özet">${esc(w.summary || '')}</td>
          </tr>
        `).join('')
        : `<tr><td colspan="4" data-label="Bilgi" class="text-muted">Henüz dış kanal simülasyonu çalıştırılmadı.</td></tr>`;
    }
  }

  /* =========================================================
     3. İŞLETME / RESTORAN & MUTFAK PANELİ (/isletme)
     KRİTİK GÜVENLİK: Kurye GPS haritası veya koordinatı ASLA gösterilmez!
     ========================================================= */
  function renderMerchantWorkspace() {
    const boot = state.bootstrap;
    if (!boot) return;

    const tenant = boot.tenant || {};
    const shops = (boot.shops || []).map(normShop);
    const orders = (boot.orders || []).map(normOrder);
    const summary = boot.couriersSummary || boot.couriers_summary || {};
    const availableCouriers = summary.available ?? summary.online ?? summary.onlineCount ??
      (Array.isArray(boot.couriers) ? boot.couriers.filter((c) => Number(c.is_online ?? c.isOnline) === 1).length : 0);

    if ($('merchant-header-title')) {
      $('merchant-header-title').textContent = shops.length > 1
        ? `${state.user?.displayName || 'Çoklu Marka Grubu'} (${shops.length} Şube)`
        : (shops[0]?.name || state.user?.displayName || 'İşletme Paneli');
    }
    if ($('merchant-header-sub')) {
      $('merchant-header-sub').textContent = `${tenant.name || 'PAKETÜS'} • ${tenant.city || ''}`;
    }
    if ($('merchant-courier-availability')) {
      $('merchant-courier-availability').textContent = `🛵 Sahada Müsait Kurye: ${availableCouriers}`;
    }

    // Çoklu Marka / Şube Seçici Bar
    const brandBar = $('merchant-brand-bar');
    const brandPills = $('merchant-brand-pills');
    if (brandBar && brandPills) {
      if (shops.length > 1) {
        brandBar.hidden = false;
        brandPills.innerHTML = `
          <button type="button" class="chip-btn ${state.merchantBrandFilter === 'all' ? 'active' : ''}" data-merch-brand="all">
            Tüm Şubeler (${shops.length})
          </button>
          ${shops.map((s) => `
            <button type="button" class="chip-btn ${String(state.merchantBrandFilter) === String(s.id) ? 'active' : ''}" data-merch-brand="${s.id}">
              🏪 ${esc(s.name)}
            </button>
          `).join('')}
        `;
      } else {
        brandBar.hidden = true;
      }
    }

    const merchSelect = $('merch-shop-select');
    if (merchSelect) {
      const prevVal = merchSelect.value;
      merchSelect.innerHTML = shops.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
      if (state.merchantBrandFilter !== 'all') {
        merchSelect.value = String(state.merchantBrandFilter);
      } else if (prevVal && shops.some((s) => String(s.id) === String(prevVal))) {
        merchSelect.value = prevVal;
      }
    }

    const shopMap = new Map(shops.map((s) => [Number(s.id), s]));
    const filtered = orders.filter((o) => {
      if (state.merchantBrandFilter !== 'all' && String(o.shopId) !== String(state.merchantBrandFilter)) return false;
      if (state.merchantStatusFilter === 'pending' && !['pending', 'ready', 'pending_credit'].includes(o.status)) return false;
      if (state.merchantStatusFilter === 'active' && !['assigned', 'picked_up'].includes(o.status)) return false;
      if (state.merchantStatusFilter === 'delivered' && o.status !== 'delivered') return false;
      return true;
    });

    const statsEl = $('merchant-mini-stats');
    if (statsEl) {
      const activeCnt = orders.filter((o) => ['pending', 'assigned', 'picked_up'].includes(o.status)).length;
      const doneCnt = orders.filter((o) => o.status === 'delivered').length;
      statsEl.innerHTML = `<span class="badge badge-amber">Aktif: ${activeCnt}</span> <span class="badge badge-emerald">Teslim: ${doneCnt}</span>`;
    }

    const tbody = $('merchant-orders-tbody');
    if (tbody) {
      if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="5" data-label="Bilgi" class="text-muted">Seçili kriterde sipariş bulunmuyor.</td></tr>`;
      } else {
        tbody.innerHTML = filtered.map((o) => {
          const sName = o.shopName || shopMap.get(Number(o.shopId))?.name || '';
          return `
            <tr>
              <td data-label="Takip & Şube">
                <strong><code>${esc(o.trackingCode)}</code></strong>
                <div class="text-muted">🏪 ${esc(sName)}</div>
              </td>
              <td data-label="Müşteri & Tip">
                <div><strong>${esc(o.customerName)}</strong> • ${orderTypeLabel(o.orderType)}</div>
                <small class="text-muted">${esc(o.neighborhood ? o.neighborhood + ' - ' : '')}${esc(o.customerAddress || 'Gel-Al / Salon')}</small>
                ${o.orderType === 'delivery' ? buildDualNavLinksHtml({ lat: o.destLat, lng: o.destLng, address: o.customerAddress, city: tenant.city }) : ''}
              </td>
              <td data-label="Tutar & Ödeme">
                <div><strong>${formatTL(o.orderAmount)}</strong></div>
                <div>${paymentBadgeHtml(o.paymentMethod)}</div>
              </td>
              <td data-label="Kurye Durumu">
                ${statusBadgeHtml(o.status)}
                ${o.courierName ? `<div class="text-muted">🛵 ${esc(o.courierName)}</div>` : ''}
              </td>
              <td data-label="Fiş & Sohbet">
                <div class="action-btn-cluster">
                  <button type="button" class="btn btn-amber btn-xs" data-open-receipt="${o.id}">🧾 80mm Fiş</button>
                  <button type="button" class="btn btn-outline-light btn-xs" data-open-chat="${o.id}">💬 Paket Sohbeti</button>
                  <a href="/takip/${encodeURIComponent(o.trackingCode)}" target="_blank" class="btn btn-ghost-sm">Takip Linki</a>
                </div>
              </td>
            </tr>
          `;
        }).join('');
      }
    }
  }

  /* =========================================================
     4. KURYE MOBİL SAHA UYGULAMASI (/kurye)
     KRİTİK KURAL: Kurye çevrimiçi durumu sayfa yenilemesi veya GPS ile
                   ASLA kendiliğinden değişmez; yalnızca butona basınca değişir!
     ========================================================= */
  function renderCourierWorkspace() {
    const boot = state.bootstrap;
    if (!boot) return;

    const tenant = boot.tenant || {};
    const c = normCourier(boot.courier || {});
    const activeOrders = (boot.activeOrders || boot.orders || [])
      .map(normOrder)
      .filter((o) => ['assigned', 'picked_up'].includes(o.status))
      .sort((a, b) => (Number(a.routeSeq) || 99) - (Number(b.routeSeq) || 99));

    const recentDelivered = (boot.recentDelivered || (boot.orders || []).filter((o) => o.status === 'delivered'))
      .map(normOrder);

    // Yeni paket geldiğinde sesli uyarı çal!
    const currentIds = new Set(activeOrders.map((o) => o.id));
    if (state.courierInitialLoaded) {
      let hasNewAssigned = false;
      currentIds.forEach((id) => {
        if (!state.knownCourierOrderIds.has(id)) hasNewAssigned = true;
      });
      if (hasNewAssigned) {
        playAlertTone('order');
        toast('🔔 Yeni paket rotanıza eklendi!', 'info');
      }
    }
    state.knownCourierOrderIds = currentIds;
    state.courierInitialLoaded = true;

    if ($('courier-name-title')) {
      $('courier-name-title').textContent = `${c.name} (${c.vehicleType === 'car' ? 'Araçlı' : 'Motorlu'})`;
    }
    if ($('courier-pos-badge')) {
      $('courier-pos-badge').textContent = c.hasPos ? '💳 POS Zimmetli' : 'POS Yok';
      $('courier-pos-badge').className = `badge ${c.hasPos ? 'badge-amber' : 'badge-slate'}`;
    }
    if ($('courier-battery-badge')) {
      $('courier-battery-badge').textContent = `🔋 %${c.batteryPct}`;
    }

    const calcEarning = c.todayEarnings > 0
      ? c.todayEarnings
      : recentDelivered.reduce((s, o) => s + o.courierEarning, 0);
    if ($('courier-earning-val')) $('courier-earning-val').textContent = formatTL(calcEarning);
    if ($('courier-avg-min')) $('courier-avg-min').textContent = `${Number(c.avgDeliveryMinutes || 14.2).toFixed(1)} dk`;
    if ($('courier-load-val')) $('courier-load-val').textContent = `${activeOrders.length} / ${c.maxBatch} Paket`;

    const onlineBtn = $('btn-courier-online-toggle');
    if (onlineBtn) {
      onlineBtn.textContent = c.isOnline ? '● Çevrimiçi (Mesai Açık)' : '○ Çevrimdışı (Mesai Başlat)';
      onlineBtn.className = `btn btn-shift-toggle ${c.isOnline ? '' : 'offline'}`;
      onlineBtn.dataset.online = c.isOnline ? '1' : '0';
    }

    const breakBtn = $('btn-courier-break-toggle');
    if (breakBtn) {
      breakBtn.textContent = c.onBreak ? '☕ Molada (Bitir)' : '☕ Mola';
      breakBtn.className = `btn ${c.onBreak ? 'btn-amber' : 'btn-outline-light'}`;
      breakBtn.dataset.onbreak = c.onBreak ? '1' : '0';
    }

    renderRadioBars(boot.radioTransmissions || boot.radio_transmissions || []);

    const stack = $('courier-active-orders');
    if (stack) {
      if (!activeOrders.length) {
        stack.innerHTML = `
          <div class="surface-card" style="text-align:center;padding:1.6rem;">
            <strong style="font-size:1.05rem;">Şu an üzerinizde aktif paket bulunmuyor</strong>
            <p class="text-muted">Yeni paket atandığında sesli bildirim çalacak ve rota sırasına göre burada belirecektir.</p>
          </div>
        `;
      } else {
        stack.innerHTML = activeOrders.map((o, idx) => {
          const stopNo = o.routeSeq || idx + 1;
          const isPos = o.paymentMethod === 'card_on_delivery';
          const destLat = o.destLat;
          const destLng = o.destLng;
          const gmapsDir = destLat && destLng
            ? `https://www.google.com/maps/dir/?api=1&destination=${Number(destLat).toFixed(6)},${Number(destLng).toFixed(6)}`
            : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([o.customerAddress, tenant.city].filter(Boolean).join(', '))}`;
          const yandexDir = destLat && destLng
            ? `https://yandex.com.tr/harita/?rtext=~${Number(destLat).toFixed(6)},${Number(destLng).toFixed(6)}&rtt=auto`
            : `https://yandex.com.tr/harita/?text=${encodeURIComponent([o.customerAddress, tenant.city].filter(Boolean).join(', '))}`;

          return `
            <article class="courier-task-card">
              ${isPos ? `
                <div class="pos-mandatory-alert">
                  💳 MOBİL POS CİHAZINI YANINA AL — KAPIDA KART ÇEKİLECEK (${formatTL(o.orderAmount)})
                </div>
              ` : ''}

              <div class="courier-task-head">
                <div>
                  <span class="stop-seq-pill">${stopNo}. DURAK</span>
                  ${o.batchId ? `<span class="badge badge-slate" style="margin-left:4px;">${esc(o.batchId)}</span>` : ''}
                </div>
                <div>
                  <code>${esc(o.trackingCode)}</code> ${statusBadgeHtml(o.status)}
                </div>
              </div>

              <div class="courier-route-block">
                <div style="margin-bottom:6px;">
                  <strong>🏪 Çıkış: ${esc(o.shopName || `İşletme #${o.shopId}`)}</strong>
                  ${o.shopAddress ? `<div class="text-muted">${esc(o.shopAddress)}</div>` : ''}
                </div>
                <div style="border-top:1px dashed rgba(148,163,184,0.2);padding-top:6px;">
                  <strong>📍 Teslimat: ${esc(o.customerName)}</strong>
                  ${o.customerPhone ? ` • <a href="tel:${esc(o.customerPhone)}" class="text-emerald">📞 ${esc(o.customerPhone)}</a>` : ''}
                  <div>${esc(o.neighborhood ? o.neighborhood + ' — ' : '')}${esc(o.customerAddress)}</div>
                  ${o.itemsSummary ? `<div class="text-muted">🍔 ${esc(o.itemsSummary)}</div>` : ''}
                  ${o.notes ? `<div class="text-amber">📝 Not: ${esc(o.notes)}</div>` : ''}
                </div>
                <div class="card-head-between" style="margin-top:8px;">
                  <span>Tahsilat: <strong>${formatTL(o.orderAmount)}</strong> ${paymentBadgeHtml(o.paymentMethod)}</span>
                  <span class="text-emerald">Hakediş: <strong>+${formatTL(o.courierEarning)}</strong></span>
                </div>
              </div>

              <div class="courier-nav-grid">
                <a href="${esc(gmapsDir)}" target="_blank" rel="noopener noreferrer" class="btn btn-outline-light">🗺️ Google Maps</a>
                <a href="${esc(yandexDir)}" target="_blank" rel="noopener noreferrer" class="btn btn-outline-light">🧭 Yandex Yol Tarifi</a>
              </div>

              <div class="courier-action-grid">
                ${o.status === 'assigned'
                  ? `<button type="button" class="btn btn-amber" data-order-status="${o.id}" data-next-status="picked_up">📦 Teslim Al</button>`
                  : `<button type="button" class="btn btn-emerald" data-order-status="${o.id}" data-next-status="delivered">✅ Teslim Et</button>`
                }
                <button type="button" class="btn btn-outline-light" data-open-chat="${o.id}">💬 Sohbet</button>
                <button type="button" class="btn btn-ghost-light" data-open-receipt="${o.id}">🧾 Fiş</button>
              </div>
            </article>
          `;
        }).join('');
      }
    }

    const delivTbody = $('courier-delivered-tbody');
    if (delivTbody) {
      delivTbody.innerHTML = recentDelivered.length
        ? recentDelivered.slice(0, 10).map((o) => `
          <tr>
            <td data-label="Kod"><code>${esc(o.trackingCode)}</code></td>
            <td data-label="İşletme & Müşteri">${esc(o.shopName || '')} → ${esc(o.customerName)}</td>
            <td data-label="Ödeme">${paymentBadgeHtml(o.paymentMethod)}</td>
            <td data-label="Hakediş"><strong class="text-emerald">+${formatTL(o.courierEarning)}</strong></td>
          </tr>
        `).join('')
        : `<tr><td colspan="4" data-label="Bilgi" class="text-muted">Bugün tamamlanan teslimat yok.</td></tr>`;
    }
  }

  /* =========================================================
     MODALLAR: PAKET SOHBETİ, ZOOMLU 80MM FİŞ, FİNANS, DÜKKAN & KURYE
     ========================================================= */
  async function openOrderChatModal(orderId) {
    state.activeChatOrderId = Number(orderId);
    if ($('chat-order-id')) $('chat-order-id').value = String(orderId);

    const allOrders = [
      ...(state.bootstrap?.orders || []),
      ...(state.bootstrap?.activeOrders || []),
      ...(state.bootstrap?.recentDelivered || [])
    ].map(normOrder);
    const ord = allOrders.find((o) => Number(o.id) === Number(orderId));
    if ($('chat-order-summary')) {
      $('chat-order-summary').innerHTML = ord
        ? `<strong><code>${esc(ord.trackingCode)}</code></strong> • ${esc(ord.customerName)} (${formatTL(ord.orderAmount)})`
        : `Sipariş #${esc(orderId)}`;
    }

    openDialog('modal-order-chat');
    await loadOrderMessages(orderId);
  }

  async function loadOrderMessages(orderId) {
    const listEl = $('chat-messages-list');
    if (!listEl) return;
    try {
      const res = await apiFetch(`/api/orders/${orderId}/messages`);
      const messages = res.messages || res || [];
      if (!Array.isArray(messages) || !messages.length) {
        listEl.innerHTML = '<p class="text-muted" style="text-align:center;margin-top:2rem;">Bu paket için henüz mesaj yok. İşletme, kurye ve merkez buradan anlık yazışabilir.</p>';
        return;
      }
      listEl.innerHTML = messages.map((m) => {
        const senderRole = m.sender_role || m.senderRole || '';
        const isMine = state.user && senderRole === state.user.role;
        return `
          <div class="chat-bubble ${isMine ? 'mine' : ''}">
            <div class="chat-bubble-meta">
              <strong>${esc(m.sender_name || m.senderName || senderRole)}</strong> • ${formatTimeShort(m.created_at || m.createdAt)}
            </div>
            <div>${esc(m.body)}</div>
          </div>
        `;
      }).join('');
      listEl.scrollTop = listEl.scrollHeight;
    } catch (err) {
      listEl.innerHTML = `<p class="text-danger">${esc(err.message)}</p>`;
    }
  }

  function applyReceiptZoom(val) {
    const z = Math.min(200, Math.max(60, Number(val) || 100));
    state.receiptZoom = z;
    if ($('receipt-zoom-range')) $('receipt-zoom-range').value = String(z);
    if ($('receipt-zoom-label')) $('receipt-zoom-label').textContent = `%${z}`;
    const stage = $('receipt-scale-stage');
    if (stage) {
      stage.style.transform = `scale(${(z / 100).toFixed(2)})`;
    }
  }

  async function openReceiptModal(orderId) {
    openDialog('modal-receipt');
    applyReceiptZoom(100);
    const iframe = $('receipt-iframe');
    if (!iframe) return;

    try {
      const html = await apiFetch(`/api/integrations/receipt/${orderId}/html`, { expectText: true });
      iframe.srcdoc = html;
    } catch (_) {
      const allOrders = [
        ...(state.bootstrap?.orders || []),
        ...(state.bootstrap?.activeOrders || [])
      ].map(normOrder);
      const o = allOrders.find((x) => Number(x.id) === Number(orderId));
      iframe.srcdoc = `<!DOCTYPE html><html lang="tr"><body style="font-family:monospace;padding:16px;width:280px;">
        <h3 style="margin:0 0 8px;">PAKETÜS 80mm TERMAL FİŞ</h3>
        <div>Kod: ${esc(o?.trackingCode || orderId)}</div>
        <div>Müşteri: ${esc(o?.customerName || '')}</div>
        <div>Adres: ${esc(o?.customerAddress || '')}</div>
        <hr>
        <div><strong>TOPLAM: ${formatTL(o?.orderAmount || 0)}</strong></div>
        <div>Ödeme: ${esc(o?.paymentMethod === 'card_on_delivery' ? 'KAPIDA KREDİ KARTI (POS)' : o?.paymentMethod || '')}</div>
      </body></html>`;
    }
  }

  function openFinancialsModal(orderId) {
    const orders = (state.bootstrap?.orders || []).map(normOrder);
    const o = orders.find((x) => Number(x.id) === Number(orderId));
    if (!o) return;

    if ($('fin-order-id')) $('fin-order-id').value = String(o.id);
    if ($('fin-order-info')) {
      $('fin-order-info').textContent = `${o.trackingCode} — ${o.customerName} (Mevcut durum: ${o.status})`;
    }
    if ($('fin-payment-method')) $('fin-payment-method').value = o.paymentMethod || 'cash';
    if ($('fin-order-amount')) $('fin-order-amount').value = String(o.orderAmount);
    if ($('fin-delivery-fee')) $('fin-delivery-fee').value = String(o.deliveryFee);
    if ($('fin-courier-earning')) $('fin-courier-earning').value = String(o.courierEarning);

    openDialog('modal-financials');
  }

  function openShopFormModal(shopId = null) {
    const shops = (state.bootstrap?.shops || []).map(normShop);
    const s = shopId ? shops.find((x) => Number(x.id) === Number(shopId)) : null;

    if ($('shop-form-id')) $('shop-form-id').value = s ? String(s.id) : '';
    if ($('shop-form-name')) $('shop-form-name').value = s ? s.name : '';
    if ($('shop-form-brand')) $('shop-form-brand').value = s ? s.brandTag : '';
    if ($('shop-form-group')) $('shop-form-group').value = s && s.groupId ? String(s.groupId) : '';
    if ($('shop-form-phone')) $('shop-form-phone').value = s ? s.phone : '';
    if ($('shop-form-address')) $('shop-form-address').value = s ? s.address : '';
    if ($('shop-form-lat')) $('shop-form-lat').value = s && s.lat !== null ? String(s.lat) : '';
    if ($('shop-form-lng')) $('shop-form-lng').value = s && s.lng !== null ? String(s.lng) : '';
    if ($('shop-form-tariff')) $('shop-form-tariff').value = s ? s.tariffMode : 'km';
    if ($('shop-form-base-fee')) $('shop-form-base-fee').value = s ? String(s.baseFee) : '45';
    if ($('shop-form-km-fee')) $('shop-form-km-fee').value = s ? String(s.perKmFee) : '8';
    if ($('shop-form-comm')) $('shop-form-comm').value = s ? String(s.commissionPct) : '12';
    if ($('shop-form-autoprint')) $('shop-form-autoprint').checked = s ? s.autoPrint : true;

    openDialog('modal-shop-form');
  }

  function openCourierFormModal(courierId = null) {
    const couriers = (state.bootstrap?.couriers || []).map(normCourier);
    const c = courierId ? couriers.find((x) => Number(x.id) === Number(courierId)) : null;

    if ($('courier-form-id')) $('courier-form-id').value = c ? String(c.id) : '';
    if ($('courier-form-name')) $('courier-form-name').value = c ? c.name : '';
    if ($('courier-form-phone')) $('courier-form-phone').value = c ? c.phone : '';
    if ($('courier-form-vehicle')) $('courier-form-vehicle').value = c ? c.vehicleType : 'motorcycle';
    if ($('courier-form-max-batch')) $('courier-form-max-batch').value = c ? String(c.maxBatch) : '4';
    if ($('courier-form-pkg-fee')) $('courier-form-pkg-fee').value = c ? String(c.perPackageFee) : '32';
    if ($('courier-form-km-bonus')) $('courier-form-km-bonus').value = c ? String(c.perKmBonus) : '5';
    if ($('courier-form-has-pos')) $('courier-form-has-pos').checked = c ? c.hasPos : true;

    openDialog('modal-courier-form');
  }

  /* =========================================================
     CALLER ID OTOMATİK MÜŞTERİ TANIMA
     ========================================================= */
  let callerIdTimer = null;
  function bindCallerIdAutoFill(phoneInputId, targets) {
    const input = $(phoneInputId);
    if (!input) return;
    input.addEventListener('input', () => {
      clearTimeout(callerIdTimer);
      const digits = input.value.replace(/\D/g, '');
      if (digits.length < 10) return;
      callerIdTimer = setTimeout(async () => {
        try {
          const res = await apiFetch(`/api/caller-id?phone=${encodeURIComponent(input.value.trim())}`);
          const cust = res.customer || (res.found ? res : null) || (res.name ? res : null);
          if (cust && cust.name) {
            if ($(targets.name)) $(targets.name).value = cust.name;
            if ($(targets.address) && (cust.last_address || cust.lastAddress || cust.address)) {
              $(targets.address).value = cust.last_address || cust.lastAddress || cust.address;
            }
            if ($(targets.neighborhood) && cust.neighborhood) {
              $(targets.neighborhood).value = cust.neighborhood;
            }
            if ($(targets.payment) && (cust.preferred_payment || cust.preferredPayment)) {
              $(targets.payment).value = cust.preferred_payment || cust.preferredPayment;
            }
            const count = Number(cust.order_count ?? cust.orderCount ?? 1);
            if ($(targets.badge)) {
              $(targets.badge).textContent = `✅ Kayıtlı Müşteri (${count}. Sipariş)`;
              $(targets.badge).className = 'badge badge-emerald';
            }
            if ($(targets.hint)) {
              $(targets.hint).textContent = `Caller ID Eşleşti: ${cust.name} — Son adresi ve ödeme tercihi otomatik dolduruldu!`;
            }
          } else {
            if ($(targets.badge)) {
              $(targets.badge).textContent = 'Yeni Müşteri';
              $(targets.badge).className = 'badge badge-sky';
            }
            if ($(targets.hint)) {
              $(targets.hint).textContent = 'Yeni numara — ilk siparişte Caller ID hafızasına otomatik kaydedilecek.';
            }
          }
        } catch (_) {}
      }, 200);
    });
  }

  /* =========================================================
     OTURUM, SSE CANLI YAYIN & SPA ROUTER
     ========================================================= */
  function saveSession(token, user) {
    state.token = token || '';
    state.user = user || null;
    state.courierInitialLoaded = false;
    state.knownCourierOrderIds = new Set();
    if (state.token) {
      localStorage.setItem(STORAGE_TOKEN_KEY, state.token);
      localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(state.user || {}));
    } else {
      localStorage.removeItem(STORAGE_TOKEN_KEY);
      localStorage.removeItem(STORAGE_USER_KEY);
    }
  }

  function disconnectSse() {
    clearTimeout(state.sseReconnectTimer);
    if (state.sse) {
      try {
        state.sse.close();
      } catch (_) {}
      state.sse = null;
    }
  }

  function connectSse() {
    disconnectSse();
    if (!state.token || typeof window.EventSource === 'undefined') return;

    try {
      const es = new EventSource(`/api/stream?token=${encodeURIComponent(state.token)}`);
      state.sse = es;

      const setPill = (online) => {
        const pill = $('admin-sse-badge');
        if (!pill) return;
        pill.className = `sse-pill ${online ? 'online' : 'offline'}`;
        pill.innerHTML = online ? '<span class="live-dot"></span> Canlı Akış' : 'Yeniden Bağlanıyor...';
      };

      es.onopen = () => setPill(true);

      const handlePayload = (ev) => {
        const data = safeJsonParse(ev.data, null);
        if (!data) return;
        if (data.orders || data.tenant || data.courier || data.activeOrders) {
          state.bootstrap = { ...(state.bootstrap || {}), ...data };
          renderActiveRoleWorkspace();
        } else {
          refreshBootstrapSilent();
        }
      };

      es.addEventListener('snapshot', handlePayload);
      es.addEventListener('update', handlePayload);
      es.addEventListener('order_message', (ev) => {
        const msg = safeJsonParse(ev.data, null);
        if (state.activeChatOrderId && (!msg || !msg.orderId || Number(msg.orderId) === Number(state.activeChatOrderId))) {
          loadOrderMessages(state.activeChatOrderId);
        }
      });
      es.addEventListener('radio', (ev) => {
        const tx = safeJsonParse(ev.data, null);
        if (tx) playIncomingRadio(tx);
        refreshBootstrapSilent();
      });

      es.onerror = () => {
        setPill(false);
        disconnectSse();
        if (state.token) {
          state.sseReconnectTimer = setTimeout(() => connectSse(), 4500);
        }
      };
    } catch (_) {}
  }

  function renderActiveRoleWorkspace() {
    if (state.currentRoute === '/panel') renderAdminWorkspace();
    else if (state.currentRoute === '/isletme') renderMerchantWorkspace();
    else if (state.currentRoute === '/kurye') renderCourierWorkspace();
  }

  async function refreshBootstrapSilent() {
    if (!state.token) return false;
    try {
      const boot = await apiFetch('/api/bootstrap');
      state.bootstrap = boot;
      if (state.user?.role === 'admin' && !state.reconciliation) {
        apiFetch(`/api/admin/reconciliation?date=${encodeURIComponent($('reconcile-date')?.value || todayIsoDate())}`)
          .then((r) => {
            state.reconciliation = r;
            if (state.currentRoute === '/panel' && state.adminTab === 'mutabakat') renderAdminWorkspace();
          })
          .catch(() => {});

        apiFetch('/api/integrations/platforms')
          .then((p) => {
            const list = p.platforms || p;
            if (Array.isArray(list) && list.length) {
              state.platforms = list;
              if (state.currentRoute === '/panel' && state.adminTab === 'entegrasyon') renderAdminWorkspace();
            }
          })
          .catch(() => {});
      }
      renderActiveRoleWorkspace();
      return true;
    } catch (err) {
      if (err.status === 401) {
        saveSession('', null);
        disconnectSse();
      }
      return false;
    }
  }

  async function performLogin({ phone, password, tenantSlug = '' }, targetRoute = '') {
    const body = { phone: String(phone || '').trim(), password: String(password || '').trim() };
    if (tenantSlug) body.tenantSlug = String(tenantSlug).trim();

    const res = await apiFetch('/api/auth/login', { method: 'POST', body, token: '' });
    saveSession(res.token, res.user);
    closeDialog('modal-login');

    const roleRoute =
      targetRoute ||
      (res.user?.role === 'admin' ? '/panel' : res.user?.role === 'merchant' ? '/isletme' : '/kurye');
    await navigateTo(roleRoute);
    toast(`Hoş geldiniz, ${res.user?.displayName || 'Operasyon Ekibi'}!`);
  }

  async function performDemoLogin(demoKey) {
    if (demoKey === 'track') {
      await navigateTo(`/takip/${encodeURIComponent(state.sampleTrackingCode || 'demo')}`);
      return;
    }
    const preset = DEMO_CREDENTIALS[demoKey] || DEMO_CREDENTIALS.admin;
    try {
      await performLogin(
        { phone: preset.phone, password: preset.password, tenantSlug: preset.tenantSlug },
        preset.route
      );
    } catch (err) {
      toast(err.message || 'Demo girişi yapılamadı.', 'error');
    }
  }

  function logout() {
    disconnectSse();
    saveSession('', null);
    state.bootstrap = null;
    state.reconciliation = null;
    navigateTo('/');
    toast('Oturum güvenli şekilde kapatıldı.');
  }

  function updateManifestForRole(roleName) {
    const link = $('pwa-manifest');
    if (link) {
      link.setAttribute('href', `/api/manifest.json?role=${encodeURIComponent(roleName || 'vitrin')}`);
    }
  }

  function showOnlyView(viewId) {
    ['view-vitrin', 'view-auth-gate', 'view-admin', 'view-merchant', 'view-courier', 'view-track'].forEach((id) => {
      const el = $(id);
      if (el) el.hidden = id !== viewId;
    });
  }

  function configureAuthGateForRoute(pathname) {
    const map = {
      '/panel': {
        badge: 'YÖNETİCİ KAPISI',
        title: 'Operasyon Merkezine Giriş',
        sub: 'Yönetici numara ve şifrenizle giriş yapın veya sağdan tek tık demo yöneticisini açın.'
      },
      '/isletme': {
        badge: 'İŞLETME & MUTFAK KAPISI',
        title: 'Restoran & Çoklu Marka Paneline Giriş',
        sub: 'İşletme telefon numarası ve şifrenizle giriş yapın veya Grup/Tekil demo işletmeyi tek tıkla deneyin.'
      },
      '/kurye': {
        badge: 'SAHA KURYE PWA KAPISI',
        title: 'Kurye Mobil Uygulamasına Giriş',
        sub: 'Saha kurye numaranızla giriş yapın veya POS cihazlı / POS cihazsız demo kuryeyi tek tıkla açın.'
      }
    };
    const cfg = map[pathname] || map['/panel'];
    if ($('gate-role-badge')) $('gate-role-badge').textContent = cfg.badge;
    if ($('gate-title')) $('gate-title').textContent = cfg.title;
    if ($('gate-subtitle')) $('gate-subtitle').textContent = cfg.sub;
  }

  async function navigateTo(urlPath, { replace = false } = {}) {
    const urlObj = new URL(urlPath, window.location.origin);
    const pathname = urlObj.pathname === '/vitrin' ? '/' : urlObj.pathname;
    if (replace) {
      window.history.replaceState({}, '', urlObj.pathname + urlObj.search);
    } else if (window.location.pathname + window.location.search !== urlObj.pathname + urlObj.search) {
      window.history.pushState({}, '', urlObj.pathname + urlObj.search);
    }
    await renderRoute(pathname, urlObj.searchParams);
  }

  async function renderRoute(pathname, searchParams) {
    clearInterval(state.trackPollTimer);

    if (pathname.startsWith('/takip')) {
      state.currentRoute = '/takip';
      updateManifestForRole('track');
      showOnlyView('view-track');
      const parts = pathname.split('/').filter(Boolean);
      const code = parts[1] ? decodeURIComponent(parts[1]) : (searchParams.get('code') || 'demo');
      await renderTrackScreen(code);
      return;
    }

    if (pathname === '/' || pathname === '/vitrin') {
      state.currentRoute = '/';
      updateManifestForRole('vitrin');
      showOnlyView('view-vitrin');
      renderCreditCalculator();
      return;
    }

    // ?demo=1 veya ?demo=... parametresiyle doğrudan tek tık giriş desteği
    const demoParam = searchParams.get('demo');
    if (demoParam) {
      const targetDemoKey =
        pathname === '/isletme'
          ? (demoParam === 'single' ? 'merchant_single' : 'merchant_group')
          : pathname === '/kurye'
            ? (demoParam === '2' ? 'courier_2' : 'courier_1')
            : 'admin';
      const preset = DEMO_CREDENTIALS[targetDemoKey];
      const expectedRole = pathname === '/panel' ? 'admin' : pathname === '/isletme' ? 'merchant' : 'courier';
      if (!state.token || state.user?.role !== expectedRole) {
        try {
          const res = await apiFetch('/api/auth/login', {
            method: 'POST',
            body: { phone: preset.phone, password: preset.password, tenantSlug: preset.tenantSlug },
            token: ''
          });
          saveSession(res.token, res.user);
        } catch (_) {}
      }
    }

    const requiredRoleMap = {
      '/panel': 'admin',
      '/isletme': 'merchant',
      '/kurye': 'courier'
    };
    const requiredRole = requiredRoleMap[pathname];

    if (!requiredRole) {
      state.currentRoute = '/';
      showOnlyView('view-vitrin');
      return;
    }

    state.currentRoute = pathname;
    updateManifestForRole(requiredRole);

    if (!state.token || (state.user?.role && state.user.role !== requiredRole)) {
      configureAuthGateForRoute(pathname);
      showOnlyView('view-auth-gate');
      return;
    }

    const ok = await refreshBootstrapSilent();
    if (!ok) {
      configureAuthGateForRoute(pathname);
      showOnlyView('view-auth-gate');
      return;
    }

    if (pathname === '/panel') {
      showOnlyView('view-admin');
      const tabParam = searchParams.get('tab');
      if (tabParam && ['havuz', 'harita', 'isletmeler', 'filo', 'kontor', 'mutabakat', 'entegrasyon'].includes(tabParam)) {
        activateAdminTab(tabParam);
      }
      renderAdminWorkspace();
    } else if (pathname === '/isletme') {
      showOnlyView('view-merchant');
      renderMerchantWorkspace();
    } else if (pathname === '/kurye') {
      showOnlyView('view-courier');
      renderCourierWorkspace();
    }

    connectSse();
  }

  /* =========================================================
     ETKİLEŞİMLER VE OLAY DİNLEYİCİLERİ
     ========================================================= */
  function activateAdminTab(tabKey) {
    state.adminTab = tabKey;
    document.querySelectorAll('[data-admin-tab]').forEach((btn) => {
      const selected = btn.getAttribute('data-admin-tab') === tabKey;
      btn.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    ['havuz', 'harita', 'isletmeler', 'filo', 'kontor', 'mutabakat', 'entegrasyon'].forEach((k) => {
      const panel = $(`panel-${k}`);
      if (panel) panel.hidden = k !== tabKey;
    });
    if (tabKey === 'harita') {
      renderAdminMap();
    }
  }

  function bindEvents() {
    window.addEventListener('popstate', () => {
      const u = new URL(window.location.href);
      renderRoute(u.pathname === '/vitrin' ? '/' : u.pathname, u.searchParams);
    });

    // Tüm <dialog> pencerelerinde backdrop tıklamasıyla kapatma
    document.querySelectorAll('dialog.paketus-dialog').forEach((dlg) => {
      dlg.addEventListener('click', (ev) => {
        if (ev.target === dlg) dlg.close();
      });
    });

    // Global Tıklama Delegasyonu
    document.addEventListener('click', async (ev) => {
      const navLink = ev.target.closest('[data-nav]');
      if (navLink) {
        ev.preventDefault();
        navigateTo(navLink.getAttribute('data-nav'));
        return;
      }

      const closeBtn = ev.target.closest('[data-close-dialog]');
      if (closeBtn) {
        closeDialog(closeBtn.getAttribute('data-close-dialog'));
        return;
      }

      const demoBtn = ev.target.closest('[data-demo-login]');
      if (demoBtn) {
        performDemoLogin(demoBtn.getAttribute('data-demo-login'));
        return;
      }

      const calcTierBtn = ev.target.closest('[data-calc-tier]');
      if (calcTierBtn) {
        state.selectedCalcTierIndex = Number(calcTierBtn.getAttribute('data-calc-tier')) || 0;
        renderCreditCalculator();
        return;
      }

      const tabBtn = ev.target.closest('[data-admin-tab]');
      if (tabBtn) {
        activateAdminTab(tabBtn.getAttribute('data-admin-tab'));
        return;
      }

      const ordFilterBtn = ev.target.closest('[data-order-filter]');
      if (ordFilterBtn) {
        state.adminOrderFilter = ordFilterBtn.getAttribute('data-order-filter');
        document.querySelectorAll('[data-order-filter]').forEach((b) => b.classList.toggle('active', b === ordFilterBtn));
        renderAdminWorkspace();
        return;
      }

      const merchBrandBtn = ev.target.closest('[data-merch-brand]');
      if (merchBrandBtn) {
        state.merchantBrandFilter = merchBrandBtn.getAttribute('data-merch-brand');
        renderMerchantWorkspace();
        return;
      }

      const merchFilterBtn = ev.target.closest('[data-merch-filter]');
      if (merchFilterBtn) {
        state.merchantStatusFilter = merchFilterBtn.getAttribute('data-merch-filter');
        document.querySelectorAll('[data-merch-filter]').forEach((b) => b.classList.toggle('active', b === merchFilterBtn));
        renderMerchantWorkspace();
        return;
      }

      const orderTypeSeg = ev.target.closest('[data-order-type]');
      if (orderTypeSeg) {
        const val = orderTypeSeg.getAttribute('data-order-type');
        if ($('merch-order-type')) $('merch-order-type').value = val;
        document.querySelectorAll('#merch-order-type-group .seg-btn').forEach((b) => b.classList.toggle('active', b === orderTypeSeg));
        const addrInput = $('merch-customer-address');
        if (addrInput) {
          addrInput.required = val === 'delivery';
          if (val !== 'delivery' && !addrInput.value) {
            addrInput.value = val === 'takeaway' ? 'Gel-Al Müşteri' : 'Salon Servisi';
          }
        }
        return;
      }

      // Manuel kurye atama
      const manualAssignBtn = ev.target.closest('[data-manual-assign]');
      if (manualAssignBtn) {
        const orderId = manualAssignBtn.getAttribute('data-manual-assign');
        const sel = $(`assign-sel-${orderId}`);
        const courierId = sel ? Number(sel.value) : 0;
        if (!courierId) {
          toast('Lütfen önce listeden bir kurye seçin.', 'warn');
          return;
        }
        try {
          await apiFetch(`/api/admin/orders/${orderId}/assign`, {
            method: 'POST',
            body: { courierId }
          });
          toast('🛵 Kurye ataması tamamlandı.');
          await refreshBootstrapSilent();
        } catch (err) {
          toast(err.message || 'Atama yapılamadı (POS uyumunu kontrol edin).', 'error');
        }
        return;
      }

      // Sipariş durumu değiştirme
      const statusBtn = ev.target.closest('[data-order-status]');
      if (statusBtn) {
        const orderId = statusBtn.getAttribute('data-order-status');
        const nextStatus = statusBtn.getAttribute('data-next-status');
        try {
          await apiFetch(`/api/orders/${orderId}/status`, {
            method: 'PATCH',
            body: { status: nextStatus }
          });
          toast(`Sipariş durumu güncellendi: ${nextStatus}`);
          await refreshBootstrapSilent();
        } catch (err) {
          toast(err.message || 'Durum güncellenemedi.', 'error');
        }
        return;
      }

      // Kontör bekleyen siparişi onaylama
      const releaseBtn = ev.target.closest('[data-release-credit]');
      if (releaseBtn) {
        const orderId = releaseBtn.getAttribute('data-release-credit');
        try {
          await apiFetch(`/api/admin/orders/${orderId}/release-credit`, { method: 'POST' });
          toast('✅ Kontör onaylandı ve sipariş havuza alındı!');
          await refreshBootstrapSilent();
        } catch (err) {
          toast(err.message || 'Kontör yetersiz, önce bakiye yükleyin.', 'error');
        }
        return;
      }

      const chatBtn = ev.target.closest('[data-open-chat]');
      if (chatBtn) {
        openOrderChatModal(chatBtn.getAttribute('data-open-chat'));
        return;
      }

      const quickChatBtn = ev.target.closest('[data-quick-chat]');
      if (quickChatBtn && $('chat-message-input')) {
        $('chat-message-input').value = quickChatBtn.getAttribute('data-quick-chat');
        $('form-order-chat')?.requestSubmit();
        return;
      }

      const receiptBtn = ev.target.closest('[data-open-receipt]');
      if (receiptBtn) {
        openReceiptModal(receiptBtn.getAttribute('data-open-receipt'));
        return;
      }

      const finBtn = ev.target.closest('[data-open-financials]');
      if (finBtn) {
        openFinancialsModal(finBtn.getAttribute('data-open-financials'));
        return;
      }

      const editShopBtn = ev.target.closest('[data-edit-shop]');
      if (editShopBtn) {
        openShopFormModal(editShopBtn.getAttribute('data-edit-shop'));
        return;
      }

      const jumpPinBtn = ev.target.closest('[data-jump-pin-shop]');
      if (jumpPinBtn) {
        state.pinPickShopId = Number(jumpPinBtn.getAttribute('data-jump-pin-shop'));
        activateAdminTab('harita');
        toast('📌 Harita üzerinde işletmenin kapı noktasını tıklayın.');
        return;
      }

      const pickPinBtn = ev.target.closest('[data-pick-shop-pin]');
      if (pickPinBtn) {
        state.pinPickShopId = Number(pickPinBtn.getAttribute('data-pick-shop-pin'));
        renderAdminMap();
        toast('📌 Haritaya tıklayarak işletme pinini kaydedin.');
        return;
      }

      const editCourierBtn = ev.target.closest('[data-edit-courier]');
      if (editCourierBtn) {
        openCourierFormModal(editCourierBtn.getAttribute('data-edit-courier'));
        return;
      }

      const toggleCourierBtn = ev.target.closest('[data-admin-toggle-courier]');
      if (toggleCourierBtn) {
        const id = toggleCourierBtn.getAttribute('data-admin-toggle-courier');
        const field = toggleCourierBtn.getAttribute('data-field');
        const val = toggleCourierBtn.getAttribute('data-val') === 'true';
        try {
          await apiFetch(`/api/admin/couriers/${id}`, {
            method: 'PATCH',
            body: { [field]: val }
          });
          toast('Kurye durumu güncellendi.');
          await refreshBootstrapSilent();
        } catch (err) {
          toast(err.message || 'Güncellenemedi.', 'error');
        }
        return;
      }

      const topupPackBtn = ev.target.closest('[data-quick-topup]');
      if (topupPackBtn) {
        const amount = Number(topupPackBtn.getAttribute('data-quick-topup'));
        try {
          await apiFetch('/api/admin/credits/topup', {
            method: 'POST',
            body: {
              amount,
              note: `Hızlı Paket Yükleme (+${amount} Kontör)`,
              idempotencyKey: `ui-pack-${amount}-${Date.now()}`
            }
          });
          toast(`💎 +${formatInt(amount)} süresiz kontör cüzdanınıza eklendi!`);
          await refreshBootstrapSilent();
        } catch (err) {
          toast(err.message || 'Kontör yüklenemedi.', 'error');
        }
        return;
      }

      const simPlatformBtn = ev.target.closest('[data-simulate-platform]');
      if (simPlatformBtn) {
        const platform = simPlatformBtn.getAttribute('data-simulate-platform');
        const shopId = Number($('sim-shop-select')?.value || 1);
        try {
          const res = await apiFetch(`/api/integrations/simulate/${encodeURIComponent(platform)}`, {
            method: 'POST',
            body: { shopId }
          });
          const ord = normOrder(res.order || res);
          toast(`🚀 ${platform.toUpperCase()} test siparişi havuza düştü (${ord.trackingCode})!`);
          await refreshBootstrapSilent();
        } catch (err) {
          toast(err.message || 'Simülasyon hatası.', 'error');
        }
        return;
      }

      const sampleCallerBtn = ev.target.closest('[data-sample-caller]');
      if (sampleCallerBtn && $('input-admin-caller-phone')) {
        $('input-admin-caller-phone').value = sampleCallerBtn.getAttribute('data-sample-caller');
        $('form-admin-caller-test')?.requestSubmit();
        return;
      }

      const courierQuickRadioBtn = ev.target.closest('[data-courier-quick-radio]');
      if (courierQuickRadioBtn) {
        sendRadioTransmission({
          channel: 'genel',
          textNote: courierQuickRadioBtn.getAttribute('data-courier-quick-radio'),
          durationSec: 2.2
        });
      }
    });

    // Üst ve sabit düğmeler
    $('calc-daily-slider')?.addEventListener('input', renderCreditCalculator);
    $('btn-vitrin-login')?.addEventListener('click', () => openDialog('modal-login'));
    $('btn-vitrin-register')?.addEventListener('click', () => openDialog('modal-register-tenant'));
    $('btn-hero-register')?.addEventListener('click', () => openDialog('modal-register-tenant'));
    $('btn-calc-register')?.addEventListener('click', () => openDialog('modal-register-tenant'));

    $('btn-admin-logout')?.addEventListener('click', logout);
    $('btn-merchant-logout')?.addEventListener('click', logout);
    $('btn-courier-logout')?.addEventListener('click', logout);

    $('btn-admin-refresh')?.addEventListener('click', () => refreshBootstrapSilent());
    $('btn-merchant-refresh')?.addEventListener('click', () => refreshBootstrapSilent());
    $('btn-courier-refresh')?.addEventListener('click', () => refreshBootstrapSilent());
    $('btn-track-refresh')?.addEventListener('click', () => renderTrackScreen($('input-track-code')?.value));

    $('btn-admin-new-order')?.addEventListener('click', () => openDialog('modal-new-order'));
    $('btn-havuz-new-order')?.addEventListener('click', () => openDialog('modal-new-order'));
    $('btn-add-shop')?.addEventListener('click', () => openShopFormModal(null));
    $('btn-add-courier')?.addEventListener('click', () => openCourierFormModal(null));

    $('admin-order-search')?.addEventListener('input', (ev) => {
      state.adminOrderSearch = ev.target.value || '';
      renderAdminWorkspace();
    });

    // Akıllı Paket Birleştirme Önizleme & Otomatik Dağıtım
    $('btn-preview-batches')?.addEventListener('click', async () => {
      try {
        const res = await apiFetch('/api/admin/dispatch/preview-batches', { method: 'POST' });
        const batches = res.batches || [];
        const shops = (state.bootstrap?.shops || []).map(normShop);
        const couriers = (state.bootstrap?.couriers || []).map(normCourier);
        if ($('smart-batches-box')) $('smart-batches-box').dataset.manualLoaded = '1';
        renderSmartBatchesCards(
          batches,
          new Map(shops.map((s) => [Number(s.id), s])),
          new Map(couriers.map((c) => [Number(c.id), c]))
        );
        toast(batches.length ? `🧠 ${batches.length} akıllı rota grubu hesaplandı.` : 'Havuzda birleştirilecek bekleyen paket yok.');
      } catch (err) {
        toast(err.message || 'Rota önizlemesi alınamadı.', 'error');
      }
    });

    $('btn-auto-assign')?.addEventListener('click', async () => {
      try {
        const res = await apiFetch('/api/admin/dispatch/auto-assign', { method: 'POST' });
        const assignedCnt = res.assignedCount ?? res.assigned_count ?? (res.assigned || []).length ?? 0;
        if ($('smart-batches-box')) delete $('smart-batches-box').dataset.manualLoaded;
        toast(`⚡ Otomatik dağıtım tamamlandı (${assignedCnt} paket/grup yönlendirildi).`);
        await refreshBootstrapSilent();
      } catch (err) {
        toast(err.message || 'Otomatik atama başarısız.', 'error');
      }
    });

    // Harita pin seçimi ve odaklama
    $('map-pin-shop-select')?.addEventListener('change', (ev) => {
      state.pinPickShopId = ev.target.value ? Number(ev.target.value) : null;
      renderAdminMap();
    });
    $('btn-map-fit')?.addEventListener('click', () => {
      if (state.leafletMap && state.bootstrap?.tenant) {
        const t = state.bootstrap.tenant;
        state.leafletMap.setView([Number(t.center_lat ?? t.centerLat ?? 39.5961), Number(t.center_lng ?? t.centerLng ?? 27.0244)], 14);
      }
    });

    // Kontör şalteri
    $('btn-toggle-credits-mode')?.addEventListener('click', async (ev) => {
      const currentlyEnabled = ev.currentTarget.dataset.enabled === '1';
      try {
        await apiFetch('/api/admin/credits/toggle', {
          method: 'POST',
          body: { enabled: !currentlyEnabled }
        });
        toast(`Kontör modu ${!currentlyEnabled ? 'açıldı' : 'kapatıldı'}.`);
        await refreshBootstrapSilent();
      } catch (err) {
        toast(err.message || 'Kontör modu değiştirilemedi.', 'error');
      }
    });

    // Gün sonu mutabakat tarih filtresi
    if ($('reconcile-date')) $('reconcile-date').value = todayIsoDate();
    $('btn-load-reconcile')?.addEventListener('click', async () => {
      const dt = $('reconcile-date')?.value || todayIsoDate();
      try {
        state.reconciliation = await apiFetch(`/api/admin/reconciliation?date=${encodeURIComponent(dt)}`);
        renderAdminWorkspace();
        toast(`${dt} mutabakat raporu yüklendi.`);
      } catch (err) {
        toast(err.message || 'Mutabakat raporu alınamadı.', 'error');
      }
    });

    // Fiş ayrıştırıcı test düğmeleri
    $('btn-sample-receipt-pos')?.addEventListener('click', () => {
      if ($('textarea-raw-receipt')) {
        $('textarea-raw-receipt').value = [
          'HATAY DÖNERCİSİ - EDREMİT',
          'Sipariş Tipi: PAKET SERVİS',
          'Müşteri: Kemalettin Öztürk',
          'Tel: 0 (532) 444 55 66',
          'Adres: Akçay Mah. Kordon Boyu Cad. No: 18 Daire: 4 Edremit',
          '3x Antakya Soslu Dürüm   950,00 TL',
          '2x Büyük Ayran           300,50 TL',
          'GENEL TOPLAM: 1.250,50 TL',
          'Ödeme: KAPIDA KREDİ KARTI (POS CİHAZI GETİRİNİZ)',
          'Not: Acı sos bol olsun lütfen'
        ].join('\n');
      }
    });

    $('btn-sample-receipt-cash')?.addEventListener('click', () => {
      if ($('textarea-raw-receipt')) {
        $('textarea-raw-receipt').value = [
          'KÖRFEZ PİDE & LAHMACUN',
          'Müşteri: Ayşe Kaya',
          'Telefon: 0542 123 45 67',
          'Adres: Cennetayağı Mah. Lale Sok. No:5 Kat:2',
          '2x Kıymalı Pide + 4x Lahmacun',
          'TOPLAM: 480,00 TL',
          'Ödeme: KAPIDA NAKİT'
        ].join('\n');
      }
    });

    $('btn-parse-receipt')?.addEventListener('click', async () => {
      const rawText = $('textarea-raw-receipt')?.value || '';
      if (!rawText.trim()) {
        toast('Lütfen önce örnek bir fiş yükleyin veya fiş metni yapıştırın.', 'warn');
        return;
      }
      try {
        const res = await apiFetch('/api/integrations/parse-receipt', {
          method: 'POST',
          body: { rawText }
        });
        const p = res.parsed || res;
        state.lastParsedReceipt = p;
        const box = $('parsed-receipt-result');
        if (box) {
          box.hidden = false;
          box.innerHTML = `
            <div><strong>👤 Müşteri:</strong> ${esc(p.customerName || '—')} • <code>${esc(p.customerPhone || '—')}</code></div>
            <div><strong>📍 Adres:</strong> ${esc(p.neighborhood ? p.neighborhood + ' / ' : '')}${esc(p.address || p.customerAddress || '—')}</div>
            <div><strong>💰 Tutar &amp; Ödeme:</strong> ${formatTL(p.amount || 0)} • ${paymentBadgeHtml(p.paymentMethod)} (${orderTypeLabel(p.orderType)})</div>
            <div><strong>🍔 Ürünler:</strong> ${esc(p.itemsSummary || '—')}</div>
          `;
        }
        if ($('btn-create-from-receipt')) $('btn-create-from-receipt').disabled = false;
        toast('🧾 Fiş başarıyla ayrıştırıldı!');
      } catch (err) {
        toast(err.message || 'Fiş ayrıştırılamadı.', 'error');
      }
    });

    $('btn-create-from-receipt')?.addEventListener('click', async () => {
      const p = state.lastParsedReceipt;
      if (!p) return;
      const shopId = Number($('sim-shop-select')?.value || 1);
      try {
        await apiFetch('/api/orders', {
          method: 'POST',
          body: {
            shopId,
            customerName: p.customerName || 'Fiş Müşterisi',
            customerPhone: p.customerPhone || '05550000000',
            customerAddress: p.address || p.customerAddress || 'Merkez',
            neighborhood: p.neighborhood || '',
            orderAmount: Number(p.amount || 0),
            paymentMethod: p.paymentMethod || 'cash',
            orderType: p.orderType || 'delivery',
            itemsSummary: p.itemsSummary || 'Termal Fiş Siparişi',
            notes: p.notes || ''
          }
        });
        toast('🚀 Ayrıştırılan fiş siparişe dönüştürülüp havuza alındı!');
        await refreshBootstrapSilent();
      } catch (err) {
        toast(err.message || 'Sipariş oluşturulamadı.', 'error');
      }
    });

    // Telsiz kontrolleri
    $('btn-admin-ptt')?.addEventListener('click', (ev) => {
      togglePushToTalk(ev.currentTarget, $('admin-radio-channel')?.value || 'genel');
    });
    $('btn-courier-ptt')?.addEventListener('click', (ev) => {
      togglePushToTalk(ev.currentTarget, 'genel');
    });
    $('btn-admin-radio-mute')?.addEventListener('click', (ev) => {
      state.radioMuted = !state.radioMuted;
      ev.currentTarget.textContent = state.radioMuted ? '🔇 Sessiz' : '🔊 Ses Açık';
    });
    $('btn-admin-radio-history')?.addEventListener('click', () => openDialog('modal-radio-history'));

    $('btn-merchant-radio-ping')?.addEventListener('click', () => {
      sendRadioTransmission({
        channel: 'mutfak',
        textNote: `${state.user?.displayName || 'İşletme'}: Tezgahta hazır paketimiz var, yakın kurye yönlendirilebilir mi?`
      });
    });

    // Kurye vardiya / mola / GPS kilidi düğmeleri
    $('btn-courier-online-toggle')?.addEventListener('click', async (ev) => {
      const currentlyOnline = ev.currentTarget.dataset.online === '1';
      try {
        await apiFetch('/api/courier/status', {
          method: 'POST',
          body: { isOnline: !currentlyOnline }
        });
        toast(!currentlyOnline ? '🟢 Çevrimiçi oldunuz, paket alımına hazırsınız.' : '⚪ Çevrimdışı moda geçtiniz.');
        await refreshBootstrapSilent();
      } catch (err) {
        toast(err.message || 'Mesai durumu güncellenemedi.', 'error');
      }
    });

    $('btn-courier-break-toggle')?.addEventListener('click', async (ev) => {
      const currentlyBreak = ev.currentTarget.dataset.onbreak === '1';
      try {
        await apiFetch('/api/courier/status', {
          method: 'POST',
          body: { onBreak: !currentlyBreak }
        });
        toast(!currentlyBreak ? '☕ Mola başlatıldı.' : '🛵 Moladan dönüldü.');
        await refreshBootstrapSilent();
      } catch (err) {
        toast(err.message || 'Mola durumu güncellenemedi.', 'error');
      }
    });

    // KRİTİK KURAL: GPS bildirimi YALNIZCA { lat, lng, batteryPct } gönderir; isOnline ASLA göndermez!
    $('btn-courier-gps-ping')?.addEventListener('click', async () => {
      const t = state.bootstrap?.tenant || {};
      const c = normCourier(state.bootstrap?.courier || {});
      const baseLat = c.lat ?? Number(t.center_lat ?? t.centerLat ?? 39.5961);
      const baseLng = c.lng ?? Number(t.center_lng ?? t.centerLng ?? 27.0244);

      const sendPing = async (lat, lng) => {
        try {
          await apiFetch('/api/courier/status', {
            method: 'POST',
            body: { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), batteryPct: c.batteryPct || 90 }
          });
          toast('📍 Konumunuz merkeze iletildi (Mesai durumunuz değiştirilmedi).');
          await refreshBootstrapSilent();
        } catch (err) {
          toast(err.message || 'Konum iletilemedi.', 'error');
        }
      };

      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => sendPing(pos.coords.latitude, pos.coords.longitude),
          () => sendPing(baseLat, baseLng),
          { timeout: 3000 }
        );
      } else {
        await sendPing(baseLat, baseLng);
      }
    });

    $('btn-courier-sound-test')?.addEventListener('click', () => {
      state.radioMuted = false;
      playAlertTone('order');
      toast('🔔 Saha sesli bildirim tonu aktif.');
    });

    // 80mm Fiş Yakınlaştırma (Zoom) Kontrolleri
    $('receipt-zoom-range')?.addEventListener('input', (ev) => applyReceiptZoom(ev.target.value));
    $('btn-receipt-zoom-in')?.addEventListener('click', () => applyReceiptZoom(state.receiptZoom + 20));
    $('btn-receipt-zoom-out')?.addEventListener('click', () => applyReceiptZoom(state.receiptZoom - 20));
    $('btn-receipt-zoom-reset')?.addEventListener('click', () => applyReceiptZoom(100));
    $('btn-receipt-print')?.addEventListener('click', () => {
      const iframe = $('receipt-iframe');
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      }
    });

    // İşletme örnek kayıtlı Caller ID numarası doldurma
    $('btn-merch-fill-sample-caller')?.addEventListener('click', () => {
      const inp = $('merch-customer-phone');
      if (inp) {
        inp.value = '05321112233';
        inp.dispatchEvent(new Event('input'));
      }
    });

    bindCallerIdAutoFill('merch-customer-phone', {
      name: 'merch-customer-name',
      address: 'merch-customer-address',
      neighborhood: 'merch-neighborhood',
      payment: 'merch-payment-method',
      badge: 'merchant-caller-badge',
      hint: 'merch-caller-hint'
    });

    bindCallerIdAutoFill('admin-order-phone', {
      name: 'admin-order-name',
      address: 'admin-order-address',
      neighborhood: 'admin-order-neighborhood',
      payment: 'admin-order-payment',
      hint: 'admin-modal-caller-status'
    });

    // FORMLAR
    $('form-vitrin-track')?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const code = ($('input-vitrin-track')?.value || 'demo').trim();
      navigateTo(`/takip/${encodeURIComponent(code || 'demo')}`);
    });

    $('form-track-lookup')?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const code = ($('input-track-code')?.value || 'demo').trim();
      navigateTo(`/takip/${encodeURIComponent(code || 'demo')}`);
    });

    $('form-modal-login')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        await performLogin({
          phone: $('login-phone')?.value,
          password: $('login-password')?.value,
          tenantSlug: $('login-tenant')?.value
        });
      } catch (err) {
        toast(err.message || 'Giriş başarısız.', 'error');
      }
    });

    $('form-gate-login')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        await performLogin(
          {
            phone: $('gate-phone')?.value,
            password: $('gate-password')?.value,
            tenantSlug: $('gate-tenant')?.value
          },
          state.currentRoute
        );
      } catch (err) {
        toast(err.message || 'Telefon numarası veya şifre hatalı.', 'error');
      }
    });

    $('form-register-tenant')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const res = await apiFetch('/api/public/register-tenant', {
          method: 'POST',
          token: '',
          body: {
            companyName: $('reg-company')?.value,
            city: $('reg-city')?.value,
            adminName: $('reg-admin-name')?.value,
            adminPhone: $('reg-admin-phone')?.value,
            password: $('reg-password')?.value
          }
        });
        saveSession(res.token, res.user);
        closeDialog('modal-register-tenant');
        toast('🎉 Kurye operasyonunuz kuruldu ve 100 hoş geldin kontörü tanımlandı!');
        await navigateTo('/panel');
      } catch (err) {
        toast(err.message || 'Kayıt oluşturulamadı.', 'error');
      }
    });

    $('form-admin-new-order')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const res = await apiFetch('/api/orders', {
          method: 'POST',
          body: {
            shopId: Number($('admin-order-shop')?.value),
            orderType: $('admin-order-type')?.value || 'delivery',
            customerPhone: $('admin-order-phone')?.value,
            customerName: $('admin-order-name')?.value,
            neighborhood: $('admin-order-neighborhood')?.value,
            paymentMethod: $('admin-order-payment')?.value || 'cash',
            customerAddress: $('admin-order-address')?.value,
            orderAmount: Number($('admin-order-amount')?.value || 0),
            itemsSummary: $('admin-order-items')?.value,
            notes: $('admin-order-notes')?.value
          }
        });
        closeDialog('modal-new-order');
        ev.target.reset();
        const st = res.order?.status;
        toast(
          st === 'pending_credit'
            ? '⏳ Bakiye sıfır olduğu için sipariş silinmedi; Kontör Bekleyen korumasına alındı!'
            : '✅ Yeni sipariş havuza eklendi!'
        );
        await refreshBootstrapSilent();
      } catch (err) {
        toast(err.message || 'Sipariş açılamadı.', 'error');
      }
    });

    $('form-merchant-order')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const res = await apiFetch('/api/orders', {
          method: 'POST',
          body: {
            shopId: Number($('merch-shop-select')?.value),
            orderType: $('merch-order-type')?.value || 'delivery',
            customerPhone: $('merch-customer-phone')?.value,
            customerName: $('merch-customer-name')?.value,
            neighborhood: $('merch-neighborhood')?.value,
            customerAddress: $('merch-customer-address')?.value,
            orderAmount: Number($('merch-order-amount')?.value || 0),
            paymentMethod: $('merch-payment-method')?.value || 'cash',
            itemsSummary: $('merch-items-summary')?.value,
            notes: $('merch-notes')?.value
          }
        });
        const ord = normOrder(res.order || res);
        toast(`🚀 Sipariş oluşturuldu (${ord.trackingCode})!`);
        $('merch-customer-phone').value = '';
        $('merch-customer-name').value = '';
        $('merch-customer-address').value = '';
        $('merch-order-amount').value = '';
        $('merch-items-summary').value = '';
        $('merch-notes').value = '';
        await refreshBootstrapSilent();
      } catch (err) {
        toast(err.message || 'Sipariş kaydedilemedi.', 'error');
      }
    });

    $('form-order-chat')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const orderId = $('chat-order-id')?.value;
      const body = ($('chat-message-input')?.value || '').trim();
      if (!orderId || !body) return;
      try {
        await apiFetch(`/api/orders/${orderId}/messages`, {
          method: 'POST',
          body: { body }
        });
        $('chat-message-input').value = '';
        await loadOrderMessages(orderId);
      } catch (err) {
        toast(err.message || 'Mesaj gönderilemedi.', 'error');
      }
    });

    $('form-edit-financials')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const id = $('fin-order-id')?.value;
      if (!id) return;
      try {
        await apiFetch(`/api/admin/orders/${id}/financials`, {
          method: 'PATCH',
          body: {
            paymentMethod: $('fin-payment-method')?.value,
            orderAmount: Number($('fin-order-amount')?.value || 0),
            deliveryFee: Number($('fin-delivery-fee')?.value || 0),
            courierEarning: Number($('fin-courier-earning')?.value || 0)
          }
        });
        closeDialog('modal-financials');
        toast('✅ Sipariş finansal bilgileri ve tahsilat tipi güncellendi!');
        await refreshBootstrapSilent();
      } catch (err) {
        toast(err.message || 'Finansal kayıt güncellenemedi.', 'error');
      }
    });

    $('form-shop-save')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const id = $('shop-form-id')?.value;
      const latRaw = $('shop-form-lat')?.value;
      const lngRaw = $('shop-form-lng')?.value;
      const payload = {
        name: $('shop-form-name')?.value,
        brandTag: $('shop-form-brand')?.value,
        groupId: $('shop-form-group')?.value ? Number($('shop-form-group').value) : null,
        phone: $('shop-form-phone')?.value,
        address: $('shop-form-address')?.value,
        lat: latRaw !== '' ? Number(latRaw) : null,
        lng: lngRaw !== '' ? Number(lngRaw) : null,
        tariffMode: $('shop-form-tariff')?.value || 'km',
        baseFee: Number($('shop-form-base-fee')?.value || 45),
        perKmFee: Number($('shop-form-km-fee')?.value || 8),
        commissionPct: Number($('shop-form-comm')?.value || 12),
        autoPrint: Boolean($('shop-form-autoprint')?.checked)
      };
      try {
        if (id) {
          await apiFetch(`/api/admin/shops/${id}`, { method: 'PATCH', body: payload });
        } else {
          await apiFetch('/api/admin/shops', { method: 'POST', body: payload });
        }
        closeDialog('modal-shop-form');
        toast('🏪 İşletme ve tarife ayarları kaydedildi.');
        await refreshBootstrapSilent();
      } catch (err) {
        toast(err.message || 'İşletme kaydedilemedi.', 'error');
      }
    });

    $('form-courier-save')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const id = $('courier-form-id')?.value;
      const payload = {
        name: $('courier-form-name')?.value,
        phone: $('courier-form-phone')?.value,
        vehicleType: $('courier-form-vehicle')?.value || 'motorcycle',
        maxBatch: Number($('courier-form-max-batch')?.value || 4),
        perPackageFee: Number($('courier-form-pkg-fee')?.value || 32),
        perKmBonus: Number($('courier-form-km-bonus')?.value || 5),
        hasPos: Boolean($('courier-form-has-pos')?.checked)
      };
      try {
        if (id) {
          await apiFetch(`/api/admin/couriers/${id}`, { method: 'PATCH', body: payload });
        } else {
          await apiFetch('/api/admin/couriers', { method: 'POST', body: payload });
        }
        closeDialog('modal-courier-form');
        toast('🛵 Kurye profili kaydedildi.');
        await refreshBootstrapSilent();
      } catch (err) {
        toast(err.message || 'Kurye kaydedilemedi.', 'error');
      }
    });

    $('form-custom-topup')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const amount = Number($('input-topup-amount')?.value || 0);
      const note = $('input-topup-note')?.value || 'Manuel Kontör Yükleme';
      if (!amount) return;
      try {
        await apiFetch('/api/admin/credits/topup', {
          method: 'POST',
          body: { amount, note, idempotencyKey: `ui-custom-${Date.now()}` }
        });
        toast(`💎 Kontör işlemi uygulandı (${amount > 0 ? '+' : ''}${amount}).`);
        await refreshBootstrapSilent();
      } catch (err) {
        toast(err.message || 'Kontör işlemi başarısız.', 'error');
      }
    });

    $('form-admin-radio')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const inp = $('input-admin-radio-text');
      const text = (inp?.value || '').trim();
      if (!text) return;
      inp.value = '';
      await sendRadioTransmission({
        channel: $('admin-radio-channel')?.value || 'genel',
        textNote: text,
        durationSec: 3.0
      });
    });

    $('form-courier-radio')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const inp = $('input-courier-radio');
      const text = (inp?.value || '').trim();
      if (!text) return;
      inp.value = '';
      await sendRadioTransmission({ channel: 'genel', textNote: text, durationSec: 2.5 });
    });

    $('form-admin-caller-test')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const phone = ($('input-admin-caller-phone')?.value || '').trim();
      if (!phone) return;
      const box = $('admin-caller-result');
      try {
        const res = await apiFetch(`/api/caller-id?phone=${encodeURIComponent(phone)}`);
        const c = res.customer || (res.name ? res : null);
        if (box) {
          box.hidden = false;
          box.innerHTML = c && c.name
            ? `<div><strong>✅ Kayıtlı Müşteri Bulundu:</strong> ${esc(c.name)} (${Number(c.order_count ?? c.orderCount ?? 1)}. sipariş)</div>
               <div><strong>Son Adres:</strong> ${esc(c.neighborhood ? c.neighborhood + ' — ' : '')}${esc(c.last_address || c.lastAddress || '')}</div>
               <div><strong>Ödeme Tercihi:</strong> ${paymentBadgeHtml(c.preferred_payment || c.preferredPayment || 'cash')}</div>`
            : `<div>🆕 <strong>${esc(phone)}</strong> numarası ilk kez arıyor — Sipariş açıldığında otomatik kaydedilecek.</div>`;
        }
      } catch (err) {
        toast(err.message || 'Caller ID sorgulanamadı.', 'error');
      }
    });
  }

  /* =========================================================
     BAŞLATMA & SESSİZ PWA SERVICE WORKER KAYDI
     (Saldırgan PWA yükleme bildirimi kesinlikle çıkarılmaz!)
     ========================================================= */
  async function init() {
    bindEvents();
    await loadPublicConfigAndDemos();

    const u = new URL(window.location.href);
    const initialPath = u.pathname === '/vitrin' ? '/' : u.pathname;
    await renderRoute(initialPath, u.searchParams);

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      });
    }
  }

  init().catch(() => {});
})();
