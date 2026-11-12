'use strict';

/**
 * PAKETÜS — ESC/POS Termal Fiş Ayrıştırıcı & 80mm Fiş HTML Üretici
 * Sahibi: entegrasyon-pos
 */

const PAYMENT_LABELS_TR = {
  cash: 'KAPIDA NAKİT TAHSİLAT',
  card_on_delivery: 'KAPIDA KREDİ KARTI (POS CİHAZI GEREKLİ!)',
  online_paid: 'ONLINE ÖDENDİ (TAHSİLAT ALINMAYACAK)'
};

const ORDER_TYPE_LABELS_TR = {
  delivery: 'PAKET SERVİS (KURYE)',
  takeaway: 'GEL-AL (MÜŞTERİ ALACAK)',
  dine_in: 'SALON / MASA SERVİSİ'
};

/**
 * ESC/POS ikili kontrol dizilerini ve yazdırılamayan karakterleri temizler.
 * @param {string|Buffer} input
 * @returns {string}
 */
function stripEscPosBytes(input) {
  if (input == null) return '';
  const raw = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);

  return raw
    // ESC (@, !, a, E, d, t, -, 2, 3, M, G, J, p, vb.) komut dizileri
    .replace(/\x1b[@0-9A-Za-z!\-?]/g, '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    // GS (V, !, B, h, w, k, vb.) barkod/kesme komutları
    .replace(/\x1d[@0-9A-Za-z!\-?]/g, '')
    // FS komutları
    .replace(/\x1c[@0-9A-Za-z!\-?]/g, '')
    // Satır sonu dışındaki kontrol karakterleri (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/**
 * Türkiye telefon numarasını 05xxxxxxxxx (veya 0xxx...) formatına normalize eder.
 * @param {string} raw
 * @returns {string}
 */
function normalizeTurkishPhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D+/g, '');
  if (!digits) return '';

  if (digits.length === 12 && digits.startsWith('905')) {
    return '0' + digits.slice(2);
  }
  if (digits.length === 13 && digits.startsWith('00905')) {
    return '0' + digits.slice(4);
  }
  if (digits.length === 10 && digits.startsWith('5')) {
    return '0' + digits;
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    return digits;
  }
  if (digits.length >= 10) {
    const match5 = digits.match(/5\d{9}/);
    if (match5) return '0' + match5[0];
  }
  return digits;
}

/**
 * Türkçe para birimi metinlerini (ör: "1.250,50 TL", "₺480,00", "TOPLAM: 325,5") sayıya çevirir.
 * @param {string|number} raw
 * @returns {number}
 */
function parseTurkishCurrency(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.round(raw * 100) / 100 : 0;
  }
  if (!raw) return 0;
  const str = String(raw).trim();

  // Sayı adaylarını yakala: 1.250,50 | 12.345,00 | 325,50 | 325,5 | 1.250 | 480.50 | 480
  const matches = str.match(/\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})|\d+(?:\.\d{1,2})?/g);
  if (!matches || matches.length === 0) return 0;

  // Son eşleşen tutarı al (genelde "TOPLAM: 2 Adet ... 325,50 TL" gibi satırlarda tutar sondadır)
  const token = matches[matches.length - 1];

  let normalized = token;
  if (token.includes('.') && token.includes(',')) {
    // 1.250,50 -> 1250.50
    normalized = token.replace(/\./g, '').replace(',', '.');
  } else if (token.includes(',')) {
    // 325,50 -> 325.50
    normalized = token.replace(',', '.');
  } else if (token.includes('.')) {
    // 1.250 (binlik ayraç) vs 325.50 (ondalık)
    if (/^\d{1,3}(\.\d{3})+$/.test(token)) {
      normalized = token.replace(/\./g, '');
    }
  }

  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

/**
 * Fiş metninden ödeme yöntemini tespit eder.
 * @param {string} text
 * @returns {'cash' | 'card_on_delivery' | 'online_paid'}
 */
function detectPaymentMethod(text) {
  const lower = String(text || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c');

  // Önce açıkça online ödenmiş ifadeleri kontrol et
  if (
    /online\s*(odendi|odeme|kredi|kart|pesin)/.test(lower) ||
    /(odendi|odeme\s*alindi)\s*\(?\s*online/.test(lower) ||
    /(yemeksepeti|getir|trendyol|migros)\s*online/.test(lower) ||
    /online[\s_-]*paid/.test(lower) ||
    /tahsilat\s*yapilmayacak/.test(lower) ||
    /odeme\s*tipi\s*[:\-]?\s*online/.test(lower)
  ) {
    return 'online_paid';
  }

  // Kapıda kredi kartı / POS / yemek kartları
  if (
    /kapida\s*(kredi|kart|pos|banka)/.test(lower) ||
    /kredi\s*karti/.test(lower) ||
    /banka\s*karti/.test(lower) ||
    /\bpos\b/.test(lower) ||
    /card_on_delivery/.test(lower) ||
    /\b(multinet|sodexo|pluxee|ticket|edenred|setcard|metropol)\b/.test(lower)
  ) {
    return 'card_on_delivery';
  }

  // Nakit
  if (/nakit|kapida\s*nakit|pesin|\bcash\b/.test(lower)) {
    return 'cash';
  }

  return 'cash';
}

/**
 * Fiş metninden sipariş tipini tespit eder.
 * @param {string} text
 * @returns {'delivery' | 'takeaway' | 'dine_in'}
 */
function detectOrderType(text) {
  const lower = String(text || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c');

  if (/\b(gel[\s\-]*al|takeaway|musteri\s*alacak)\b/.test(lower)) {
    return 'takeaway';
  }
  if (/\b(salon\s*servis|masa\s*no|masa\s*:\s*\d+|dine[\s_\-]*in)\b/.test(lower)) {
    return 'dine_in';
  }
  return 'delivery';
}

/**
 * Açık adres veya fiş metni içerisinden mahalle adını çıkarır.
 * @param {string} text
 * @returns {string}
 */
function extractNeighborhood(text) {
  if (!text) return '';
  // Örn: "Cumhuriyet Mah.", "Akçay Mahallesi", "Cennetayağı Mh."
  const mahMatch = String(text).match(
    /([A-ZÇĞİÖŞÜa-zçğıöşü0-9]+(?:\s+[A-ZÇĞİÖŞÜa-zçğıöşü0-9]+){0,2})\s+(?:Mahallesi|Mah\.?|Mh\.?)/i
  );
  if (mahMatch) {
    const rawName = mahMatch[1]
      .replace(/^(Adres|Açık Adres|Teslimat|Semt|Bölge|Bolge)\s*[:\-]?\s*/i, '')
      .trim();
    if (rawName) {
      return `${rawName} Mah.`;
    }
  }
  return '';
}

/**
 * ESC/POS veya düz metin Türkçe fişi ayrıştırıp yapılandırılmış sipariş nesnesi döndürür.
 * @param {string|Buffer} rawText
 * @returns {{
 *   customerName: string,
 *   customerPhone: string,
 *   address: string,
 *   neighborhood: string,
 *   amount: number,
 *   paymentMethod: 'cash' | 'card_on_delivery' | 'online_paid',
 *   orderType: 'delivery' | 'takeaway' | 'dine_in',
 *   itemsSummary: string,
 *   notes: string
 * }}
 */
function parseReceiptText(rawText) {
  const cleaned = stripEscPosBytes(rawText);
  const lines = cleaned
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0 && !/^[-=_*#]{3,}$/.test(line));

  let customerName = '';
  let customerPhone = '';
  let address = '';
  let neighborhood = '';
  let amount = 0;
  let notes = '';
  const itemLines = [];
  let inItemsSection = false;
  let inAddressContinuation = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1. Müşteri Adı
    const nameMatch = line.match(
      /^(?:M[üu]şteri(?:\s*Ad[ıi])?|Ad[ıi]?\s*Soyad[ıi]?|[İI]sim|Al[ıi]c[ıi])\s*[:\-]\s*(.+)$/i
    );
    if (nameMatch && !customerName) {
      customerName = nameMatch[1].trim();
      inAddressContinuation = false;
      continue;
    }

    // 2. Telefon
    const phoneLabelMatch = line.match(
      /^(?:Tel(?:efon)?|Cep|Gsm|M[üu]şteri\s*Tel|İletişim)\s*[:\-]\s*(.+)$/i
    );
    if (phoneLabelMatch && !customerPhone) {
      customerPhone = normalizeTurkishPhone(phoneLabelMatch[1]);
      inAddressContinuation = false;
      continue;
    }
    if (!customerPhone) {
      const inlinePhone = line.match(/(?:\+?90\s*)?0?\s*5\d{2}[\s\-)]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/);
      if (inlinePhone) {
        customerPhone = normalizeTurkishPhone(inlinePhone[0]);
      }
    }

    // 3. Mahalle (etiketli)
    const neighMatch = line.match(/^(?:Mahalle|Semt|B[öo]lge)\s*[:\-]\s*(.+)$/i);
    if (neighMatch && !neighborhood) {
      const val = neighMatch[1].trim();
      neighborhood = /mah/i.test(val) ? val : `${val} Mah.`;
      inAddressContinuation = false;
      continue;
    }

    // 4. Adres (etiketli)
    const addrMatch = line.match(
      /^(?:A[çc][ıi]k\s*Adres|Teslimat\s*Adresi|Adres)\s*[:\-]\s*(.+)$/i
    );
    if (addrMatch) {
      address = addrMatch[1].trim();
      inAddressContinuation = true;
      inItemsSection = false;
      continue;
    }

    // 5. Sipariş Notu
    const noteMatch = line.match(
      /^(?:Sipari[şs]\s*Notu|M[üu]şteri\s*Notu|Kurye\s*Notu|Not(?:lar)?|A[çc][ıi]klama)\s*[:\-]\s*(.+)$/i
    );
    if (noteMatch) {
      notes = notes ? `${notes} | ${noteMatch[1].trim()}` : noteMatch[1].trim();
      inAddressContinuation = false;
      inItemsSection = false;
      continue;
    }

    // 6. Tutar / Toplam satırı
    const totalMatch = line.match(
      /^(?:GENEL\s*TOPLAM|TOPLAM\s*TUTAR|[ÖO]DENECEK(?:\s*TUTAR)?|ARA\s*TOPLAM|TOPLAM|TUTAR)\s*[:\-]?\s*(.+)$/i
    );
    if (totalMatch) {
      const parsedTotal = parseTurkishCurrency(totalMatch[1]);
      if (parsedTotal > 0) {
        amount = parsedTotal;
      }
      inAddressContinuation = false;
      inItemsSection = false;
      continue;
    }

    // 7. Ürünler başlığı
    if (/^(?:[ÜU]R[ÜU]NLER|S[İI]PAR[İI][ŞS]\s*DETAYI|[İI][ÇC]ER[İI]K|MEN[ÜU])\s*[:\-]?$/i.test(line)) {
      inItemsSection = true;
      inAddressContinuation = false;
      continue;
    }

    const inlineItemsMatch = line.match(
      /^(?:[ÜU]r[üu]n(?:ler)?|Sipari[şs]\s*Özeti|[İI]çerik)\s*[:\-]\s*(.+)$/i
    );
    if (inlineItemsMatch) {
      itemLines.push(inlineItemsMatch[1].trim());
      inAddressContinuation = false;
      continue;
    }

    // Adres devam satırı kontrolü (Sokak, Cadde, No, Kat, Daire)
    if (
      inAddressContinuation &&
      /(?:Mah\.|Mahallesi|Sok\.|Sokak|Sk\.|Cad\.|Caddesi|Bulvar|Blv\.|No\s*:|Kat\s*:|Daire\s*:|Apt\.|Sitesi)/i.test(line) &&
      !/^(?:Ödeme|Odeme|Toplam|Tutar|Not)/i.test(line)
    ) {
      address = `${address}, ${line}`;
      continue;
    }
    inAddressContinuation = false;

    // 8. Adetli ürün satırları (ör: "2x Hatay Dürüm", "1 Adet Ayran", "- 1 Porsiyon İskender")
    if (
      /^(?:\d+\s*[xX*]\s+|\d+\s*Adet\s+|[-•*]\s*\d*)/i.test(line) &&
      !/^(?:Toplam|Genel|Tutar|Kurye|Ödeme|Odeme)/i.test(line)
    ) {
      const cleanItem = line.replace(/\s+\d+(?:[.,]\d{1,2})?\s*(?:TL|₺)?$/i, '').trim();
      itemLines.push(cleanItem);
      continue;
    }

    if (inItemsSection && !/^(?:Ödeme|Odeme|Toplam|Tutar|Not|Kurye|Adres|Tel)/i.test(line)) {
      const cleanItem = line.replace(/\s+\d+(?:[.,]\d{1,2})?\s*(?:TL|₺)?$/i, '').trim();
      if (cleanItem) itemLines.push(cleanItem);
    }
  }

  // Eğer etiketli adres bulunamadıysa mahalle/sokak/no geçen satırı yakala
  if (!address) {
    const addrLine = lines.find((l) =>
      /(?:Mahallesi|Mah\.|Mh\.|Sokak|Sok\.|Sk\.|Cadde|Cad\.|No\s*:\s*\d+|Kat\s*:\s*\d+|Daire\s*:\s*\d+)/i.test(l)
    );
    if (addrLine) {
      address = addrLine;
    }
  }

  // Mahalle hala boşsa adres veya tüm metinden çıkar
  if (!neighborhood) {
    neighborhood = extractNeighborhood(address) || extractNeighborhood(cleaned);
  }

  // Tutar hala 0 ise TL / ₺ içeren son satırdan veya doğrudan metinden oku
  if (amount <= 0) {
    const currencyLines = lines.filter((l) => /(?:₺|\bTL\b|TRY)/i.test(l));
    if (currencyLines.length > 0) {
      amount = parseTurkishCurrency(currencyLines[currencyLines.length - 1]);
    } else if (lines.length === 1) {
      amount = parseTurkishCurrency(lines[0]);
    }
  }

  // Müşteri adı hala boşsa varsayılan ata
  if (!customerName) {
    customerName = 'Misafir Müşteri';
  }

  const paymentMethod = detectPaymentMethod(cleaned);
  const orderType = detectOrderType(cleaned);
  const itemsSummary = itemLines.join(', ');

  return {
    customerName,
    customerPhone,
    address,
    neighborhood,
    amount,
    paymentMethod,
    orderType,
    itemsSummary,
    notes
  };
}

/**
 * HTML özel karakterlerini güvenli hale getirir.
 * @param {any} val
 * @returns {string}
 */
function escapeHtml(val) {
  if (val == null) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sayıyı Türkçe para birimi formatına (1.250,50 ₺) dönüştürür.
 * @param {number|string} amount
 * @returns {string}
 */
function formatTry(amount) {
  const num = Number(amount) || 0;
  return (
    num.toLocaleString('tr-TR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }) + ' ₺'
  );
}

/**
 * 80mm termal yazıcılar için tam uyumlu Türkçe kurye & mutfak fişi HTML'i üretir.
 * @param {object} order
 * @param {object} [shop]
 * @param {object} [tenant]
 * @returns {string}
 */
function renderThermalReceiptHtml(order = {}, shop = {}, tenant = {}) {
  const trackingCode =
    order.tracking_code || order.trackingCode || `PKT-${order.id || '1001'}`;
  const shopName =
    shop?.name || order.shop_name || order.shopName || 'PAKETÜS İŞLETME';
  const tenantName =
    tenant?.name || order.tenant_name || order.tenantName || 'Ege Hızlı Kurye & Lojistik';
  const tenantCity = tenant?.city || 'Edremit, Balıkesir';
  const externalSource = (
    order.external_source ||
    order.externalSource ||
    'MANUEL'
  ).toUpperCase();

  const customerName =
    order.customer_name || order.customerName || 'Misafir Müşteri';
  const customerPhone =
    order.customer_phone || order.customerPhone || '-';
  const neighborhood =
    order.neighborhood || '';
  const customerAddress =
    order.customer_address || order.customerAddress || order.address || '-';
  const itemsSummary =
    order.items_summary || order.itemsSummary || '1x Paket Sipariş';
  const notes = order.notes || '';
  const deliveryPin = order.delivery_pin || order.deliveryPin || '';

  const orderAmount =
    order.order_amount ?? order.orderAmount ?? order.amount ?? 0;
  const deliveryFee =
    order.delivery_fee ?? order.deliveryFee ?? 0;
  const paymentMethod =
    order.payment_method || order.paymentMethod || 'cash';
  const orderType =
    order.order_type || order.orderType || 'delivery';

  const paymentLabel =
    PAYMENT_LABELS_TR[paymentMethod] || PAYMENT_LABELS_TR.cash;
  const orderTypeLabel =
    ORDER_TYPE_LABELS_TR[orderType] || ORDER_TYPE_LABELS_TR.delivery;

  const createdAtRaw = order.created_at || order.createdAt || new Date().toISOString();
  let formattedDate = String(createdAtRaw);
  try {
    const d = new Date(createdAtRaw);
    if (!Number.isNaN(d.getTime())) {
      formattedDate = d.toLocaleString('tr-TR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    }
  } catch (_) {
    // keep raw string
  }

  const isPosRequired = paymentMethod === 'card_on_delivery';

  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <title>PAKETÜS Termal Fiş — ${escapeHtml(trackingCode)}</title>
  <style>
    @page { size: 80mm auto; margin: 0; }
    * { box-sizing: border-box; }
    body {
      width: 76mm;
      margin: 0 auto;
      padding: 3mm 2mm;
      font-family: 'Courier New', Courier, monospace;
      font-size: 12px;
      line-height: 1.35;
      color: #000;
      background: #fff;
    }
    .header {
      text-align: center;
      border-bottom: 2px dashed #000;
      padding-bottom: 6px;
      margin-bottom: 6px;
    }
    .brand {
      font-size: 16px;
      font-weight: 900;
      letter-spacing: 0.5px;
    }
    .shop-title {
      font-size: 14px;
      font-weight: 700;
      margin-top: 2px;
    }
    .meta {
      font-size: 11px;
      margin-top: 2px;
    }
    .badge-row {
      display: flex;
      justify-content: space-between;
      font-weight: 700;
      border-bottom: 1px dashed #000;
      padding: 4px 0;
      margin-bottom: 6px;
    }
    .section {
      border-bottom: 1px dashed #000;
      padding-bottom: 6px;
      margin-bottom: 6px;
    }
    .section-title {
      font-weight: 800;
      text-decoration: underline;
      margin-bottom: 3px;
    }
    .address-box {
      font-size: 13px;
      font-weight: 700;
      margin-top: 3px;
    }
    .payment-banner {
      border: 2px solid #000;
      padding: 6px 4px;
      text-align: center;
      font-size: 13px;
      font-weight: 900;
      margin: 6px 0;
    }
    .pos-alert {
      background: #000;
      color: #fff;
    }
    .total-row {
      display: flex;
      justify-content: space-between;
      font-size: 15px;
      font-weight: 900;
      padding: 4px 0;
    }
    .sub-row {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
    }
    .pin-box {
      text-align: center;
      border: 1px solid #000;
      padding: 4px;
      font-weight: 700;
      margin-top: 4px;
    }
    .footer {
      text-align: center;
      font-size: 10px;
      margin-top: 8px;
    }
    .barcode {
      font-family: monospace;
      font-size: 14px;
      font-weight: 900;
      letter-spacing: 2px;
      margin: 4px 0;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">PAKETÜS KURYE OTOMASYONU</div>
    <div class="shop-title">${escapeHtml(shopName)}</div>
    <div class="meta">${escapeHtml(tenantName)} (${escapeHtml(tenantCity)})</div>
    <div class="meta">Tarih: ${escapeHtml(formattedDate)}</div>
  </div>

  <div class="badge-row">
    <span>KOD: ${escapeHtml(trackingCode)}</span>
    <span>KANAL: ${escapeHtml(externalSource)}</span>
  </div>

  <div class="section">
    <div><strong>TİP:</strong> ${escapeHtml(orderTypeLabel)}</div>
    <div><strong>MÜŞTERİ:</strong> ${escapeHtml(customerName)}</div>
    <div><strong>TELEFON:</strong> ${escapeHtml(customerPhone)}</div>
    ${neighborhood ? `<div><strong>MAHALLE:</strong> ${escapeHtml(neighborhood)}</div>` : ''}
    <div class="address-box">ADRES: ${escapeHtml(customerAddress)}</div>
  </div>

  <div class="section">
    <div class="section-title">SİPARİŞ İÇERİĞİ</div>
    <div>${escapeHtml(itemsSummary)}</div>
    ${notes ? `<div style="margin-top:4px;"><strong>NOT:</strong> ${escapeHtml(notes)}</div>` : ''}
  </div>

  <div class="payment-banner ${isPosRequired ? 'pos-alert' : ''}">
    ${escapeHtml(paymentLabel)}
  </div>

  <div class="section">
    <div class="total-row">
      <span>SİPARİŞ TUTARI:</span>
      <span>${escapeHtml(formatTry(orderAmount))}</span>
    </div>
    ${deliveryFee > 0 ? `<div class="sub-row"><span>Kurye Hizmet Bedeli:</span><span>${escapeHtml(formatTry(deliveryFee))}</span></div>` : ''}
  </div>

  ${deliveryPin ? `<div class="pin-box">TESLİMAT DOĞRULAMA KODU (PIN): ${escapeHtml(deliveryPin)}</div>` : ''}

  <div class="footer">
    <div class="barcode">||| ${escapeHtml(trackingCode)} |||</div>
    <div>Canlı Takip: /takip/${escapeHtml(trackingCode)}</div>
    <div>PAKETÜS — 80mm Termal Kurye Fişi</div>
  </div>
</body>
</html>`;
}

module.exports = {
  parseReceiptText,
  renderThermalReceiptHtml,
  stripEscPosBytes,
  normalizeTurkishPhone,
  parseTurkishCurrency
};
