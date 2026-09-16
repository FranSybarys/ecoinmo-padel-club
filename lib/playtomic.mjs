// Cliente de la Playtomic Third Party API.
// Docs: https://third-party.playtomic.io/endpoints/bookings/
// Credenciales: Playtomic Manager -> Settings -> Developer tools

const BASE = 'https://thirdparty.playtomic.io/api/v1';

// La API limita a ~1 llamada por minuto. El cron es diario, asi que
// paginamos despacio en lugar de arriesgar un 429.
const PAGE_PAUSE_MS = Number(process.env.PLAYTOMIC_PAGE_PAUSE_MS ?? 61_000);
const MAX_SIZE = 200;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function assertEnv() {
  const clientId = process.env.PLAYTOMIC_CLIENT_ID;
  const secret   = process.env.PLAYTOMIC_CLIENT_SECRET;
  const tenant   = process.env.PLAYTOMIC_TENANT_ID;
  if (!clientId) throw new Error('Falta PLAYTOMIC_CLIENT_ID');
  if (!secret)   throw new Error('Falta PLAYTOMIC_CLIENT_SECRET');
  if (!tenant)   throw new Error('Falta PLAYTOMIC_TENANT_ID');
  return { clientId, secret, tenant };
}

// El access_token se cachea en memoria mientras dure la instancia de la
// funcion. Se renueva con 60s de margen antes de caducar.
let _token = null;
let _tokenExp = 0;

async function getAccessToken() {
  const { clientId, secret } = assertEnv();
  if (_token && Date.now() < _tokenExp) return _token;

  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, secret }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Autenticación Playtomic ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  const token = json.access_token ?? json.accessToken ?? json.token;
  if (!token) throw new Error('La respuesta de oauth/token no trae access_token');

  const ttl = Number(json.expires_in ?? 3600);
  _token = token;
  _tokenExp = Date.now() + Math.max(ttl - 60, 60) * 1000;
  return _token;
}

/** "25 EUR" -> { amount: 25, currency: 'EUR' } */
export function parsePrice(price) {
  if (!price || typeof price !== 'string') return { amount: null, currency: null };
  const m = price.trim().match(/^([\d.,]+)\s*([A-Z]{3})$/);
  if (!m) return { amount: null, currency: null };
  // Formato de la API: punto decimal, sin separador de millares.
  const amount = Number(m[1].replace(',', '.'));
  return { amount: Number.isFinite(amount) ? amount : null, currency: m[2] };
}

/**
 * La duracion viene en MILISEGUNDOS, pese a que la documentacion dice
 * microsegundos. Verificado contra booking_end_date - booking_start_date:
 * 3600000 -> 60 min. Se calcula desde las fechas y solo se usa el campo
 * como respaldo, que es lo unico que no puede mentir.
 */
export function durationToMinutes(duration, start, end) {
  if (start && end) {
    const min = (new Date(end) - new Date(start)) / 60000;
    if (Number.isFinite(min) && min > 0) return Math.round(min);
  }
  if (typeof duration !== 'number' || !Number.isFinite(duration)) return null;
  return Math.round(duration / 1000 / 60);
}

const fmt = (d) => d.toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS

/**
 * Descarga las reservas de un rango. Pagina hasta agotar resultados.
 * @returns {Promise<Array<object>>} reservas en crudo
 */
export async function fetchBookings({ from, to, onPage } = {}) {
  const { tenant } = assertEnv();
  await getAccessToken(); // falla pronto si las credenciales no son validas

  const all = [];
  let page = 0;

  for (;;) {
    const qs = new URLSearchParams({
      tenant_id: tenant,
      start_booking_date: fmt(from),
      end_booking_date: fmt(to),
      page: String(page),
      size: String(MAX_SIZE),
    });

    const res = await fetch(`${BASE}/bookings?${qs}`, {
      headers: {
        Authorization: `Bearer ${await getAccessToken()}`,
        'Content-Type': 'application/json',
      },
    });

    if (res.status === 429) {
      // Limite alcanzado: esperar y reintentar la misma pagina.
      await sleep(PAGE_PAUSE_MS);
      continue;
    }
    if (res.status === 401) {
      // Token caducado a mitad de paginacion: renovar y reintentar.
      _token = null;
      _tokenExp = 0;
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Playtomic ${res.status}: ${body.slice(0, 300)}`);
    }

    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    all.push(...batch);
    if (onPage) onPage(page, batch.length, all.length);

    if (batch.length < MAX_SIZE) break;
    page += 1;
    await sleep(PAGE_PAUSE_MS);
  }

  return all;
}

/** Aplana una reserva de la API al shape de la tabla bookings. */
export function toRow(b) {
  const { amount, currency } = parsePrice(b.price);
  const participants = b.participant_info?.participants?.length ?? null;
  return {
    booking_id: b.booking_id,
    tenant_id: b.tenant_id,
    resource_id: b.resource_id ?? null,
    resource_name: b.resource_name?.trim() || null, // llegan con tabuladores sueltos
    sport_id: b.sport_id ?? null,
    booking_type: b.booking_type ?? null,
    origin: b.origin ?? null,
    start_at: b.booking_start_date,
    end_at: b.booking_end_date,
    duration_min: durationToMinutes(b.duration, b.booking_start_date, b.booking_end_date),
    price_amount: amount,
    price_currency: currency,
    payment_status: b.payment_status ?? null,
    status: b.status ?? null,
    is_canceled: Boolean(b.is_canceled),
    participants,
    owner_id: b.participant_info?.owner_id ?? null,
    raw: b,
  };
}

/* ---------------- Pagos ----------------
   Endpoint asincrono: la primera llamada responde 202 PROCESSING y
   activa la generacion. A partir de ahi devuelve 200 con datos.
   Pagina con cursor, no con numero de pagina.                        */

const importe = (s) => {
  if (!s || typeof s !== 'string') return { n: null, moneda: null };
  const m = s.trim().match(/^([\d.,-]+)\s*([A-Z]{3})$/);
  if (!m) return { n: null, moneda: null };
  const n = Number(m[1].replace(',', '.'));
  return { n: Number.isFinite(n) ? n : null, moneda: m[2] };
};

export async function fetchPayments({ from, to, onPage } = {}) {
  const { tenant } = assertEnv();
  const fmtf = (d) => d.toISOString().slice(0, 19);

  const all = [];
  let cursor = null, vueltas = 0;

  for (;;) {
    const qs = new URLSearchParams({
      tenant_id: tenant,
      start_booking_date: fmtf(from),
      end_booking_date: fmtf(to),
      size: '200',
    });
    if (cursor) qs.set('cursor_id', cursor);

    const res = await fetch(`${BASE}/payments?${qs}`, {
      headers: { Authorization: `Bearer ${await getAccessToken()}`,
                 'Content-Type': 'application/json' },
    });

    if (res.status === 202) {           // aun generandose
      await sleep(30_000);
      continue;
    }
    if (res.status === 429) { await sleep(PAGE_PAUSE_MS); continue; }
    if (res.status === 401) { _token = null; _tokenExp = 0; continue; }
    if (!res.ok) {
      const b = await res.text().catch(() => '');
      throw new Error(`Playtomic payments ${res.status}: ${b.slice(0, 300)}`);
    }

    const j = await res.json();
    const lote = j.data ?? [];
    all.push(...lote);
    if (onPage) onPage(++vueltas, lote.length, all.length);

    if (!j.has_more || !j.next_cursor_id || vueltas > 200) break;
    cursor = j.next_cursor_id;
  }
  return all;
}

/** Aplana un cobro al shape de la tabla payments. */
export function toPaymentRow(p) {
  const pi = p.payment_info ?? {};
  const pr = p.product_info ?? {};
  const st = pr.store_product_info ?? null;
  const com = pi.b2b_commission_info ?? null;

  const total = importe(pi.total);
  return {
    club_payment_id: p.club_payment_id,
    payment_id: p.payment_id ?? null,
    refund_id: p.refund_id ?? null,
    status: pi.status ?? null,
    payment_date: pi.payment_date ?? null,
    service_date: pr.service_date ?? null,
    metodo: pi.payment_method_type ?? null,
    product_sku: pr.product_sku ?? null,
    categoria: pr.category_name ?? null,
    sport_id: pr.sport_id ?? null,
    item_code: st?.product_code ?? null,
    item_name: st?.item_name ?? null,
    unidades: st?.units ?? null,
    total: total.n,
    subtotal: importe(pi.subtotal).n,
    taxes: importe(pi.taxes).n,
    comision: com ? importe(com.amount).n : null,
    comision_rate: com?.rate ?? null,
    comision_iva: com ? importe(com.tax_amount).n : null,
    neto_transferido: importe(pi.net_transfer_amount).n,
    moneda: total.moneda,
    raw: p,
  };
}
