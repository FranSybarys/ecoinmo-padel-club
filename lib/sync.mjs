import { getSql } from './db.mjs';
import { fetchBookings, toRow, fetchPayments, toPaymentRow } from './playtomic.mjs';

/**
 * Descarga de Playtomic y persiste en Postgres.
 * Playtomic solo guarda 3 meses: esta tabla es el historico real,
 * asi que nunca se borra nada, solo se hace upsert.
 */
export async function runSync({ days = 35, dryRun = false } = {}) {
  const sql = getSql();

  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  const [log] = await sql.query(
    `INSERT INTO sync_log (from_date, to_date) VALUES ($1, $2) RETURNING id`,
    [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]
  );

  try {
    const raw = await fetchBookings({ from, to });
    const rows = raw.map(toRow);

    let upserted = 0;
    if (!dryRun) {
      for (const r of rows) {
        await sql.query(
          `INSERT INTO bookings (
             booking_id, tenant_id, resource_id, resource_name, sport_id,
             booking_type, origin, start_at, end_at, duration_min,
             price_amount, price_currency, payment_status, status,
             is_canceled, participants, owner_id, raw, synced_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
           ON CONFLICT (booking_id) DO UPDATE SET
             payment_status = EXCLUDED.payment_status,
             status         = EXCLUDED.status,
             is_canceled    = EXCLUDED.is_canceled,
             price_amount   = EXCLUDED.price_amount,
             participants   = EXCLUDED.participants,
             raw            = EXCLUDED.raw,
             synced_at      = now()`,
          [r.booking_id, r.tenant_id, r.resource_id, r.resource_name, r.sport_id,
           r.booking_type, r.origin, r.start_at, r.end_at, r.duration_min,
           r.price_amount, r.price_currency, r.payment_status, r.status,
           r.is_canceled, r.participants, r.owner_id, JSON.stringify(r.raw)]
        );
        upserted += 1;
      }

      // Alimenta el catalogo de pistas con lo que aparezca en las reservas.
      // Las pistas se renombran (patrocinadores), asi que un mismo
      // resource_id arrastra varios nombres historicos. DISTINCT ON se
      // queda con el de la reserva mas reciente: sin el, ON CONFLICT
      // intentaria tocar la misma fila dos veces y aborta.
      await sql.query(
        `INSERT INTO courts (resource_id, resource_name)
         SELECT DISTINCT ON (resource_id) resource_id, resource_name
         FROM bookings
         WHERE resource_id IS NOT NULL
         ORDER BY resource_id, start_at DESC
         ON CONFLICT (resource_id) DO UPDATE SET resource_name = EXCLUDED.resource_name`
      );
    }

    await sql.query(
      `UPDATE sync_log SET finished_at = now(), fetched = $1, upserted = $2, ok = true WHERE id = $3`,
      [rows.length, upserted, log.id]
    );

    return { ok: true, fetched: rows.length, upserted, from, to };
  } catch (err) {
    await sql.query(
      `UPDATE sync_log SET finished_at = now(), ok = false, error = $1 WHERE id = $2`,
      [String(err.message).slice(0, 500), log.id]
    );
    throw err;
  }
}

/**
 * Descarga los cobros y los persiste. Van aparte de las reservas
 * porque el endpoint es asincrono y tiene su propia paginacion.
 */
export async function runSyncPayments({ days = 35 } = {}) {
  const sql = getSql();
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  const raw = await fetchPayments({ from, to });
  const filas = raw.map(toPaymentRow).filter(r => r.club_payment_id);

  let n = 0;
  for (const r of filas) {
    await sql.query(
      `INSERT INTO payments (
         club_payment_id, payment_id, refund_id, status, payment_date, service_date,
         metodo, product_sku, categoria, sport_id, item_code, item_name, unidades,
         total, subtotal, taxes, comision, comision_rate, comision_iva,
         neto_transferido, moneda, raw, synced_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now())
       ON CONFLICT (club_payment_id) DO UPDATE SET
         status = EXCLUDED.status, refund_id = EXCLUDED.refund_id,
         total = EXCLUDED.total, comision = EXCLUDED.comision,
         comision_iva = EXCLUDED.comision_iva,
         neto_transferido = EXCLUDED.neto_transferido,
         raw = EXCLUDED.raw, synced_at = now()`,
      [r.club_payment_id, r.payment_id, r.refund_id, r.status, r.payment_date, r.service_date,
       r.metodo, r.product_sku, r.categoria, r.sport_id, r.item_code, r.item_name, r.unidades,
       r.total, r.subtotal, r.taxes, r.comision, r.comision_rate, r.comision_iva,
       r.neto_transferido, r.moneda, JSON.stringify(r.raw)]);
    n++;
  }
  return { ok: true, descargados: filas.length, guardados: n, from, to };
}
