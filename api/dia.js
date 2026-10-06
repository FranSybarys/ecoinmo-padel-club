// Informe diario: relacion de reservas y ventas de un dia concreto,
// con el detalle de cada una. Lo consume el panel inicial.
import { getSql } from '../lib/db.mjs';

export default async function handler(req, res) {
  try {
    const sql = getSql();

    // Por defecto el dia de hoy en hora de Madrid, no en UTC: a las 00:30
    // de Madrid en UTC todavia es el dia anterior.
    const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.fecha || '') ? req.query.fecha : hoy;

    const [reservas, ventas, resumen] = await Promise.all([
      sql.query(`
        SELECT
          booking_id,
          to_char(start_at AT TIME ZONE 'Europe/Madrid', 'HH24:MI') AS hora,
          to_char(end_at   AT TIME ZONE 'Europe/Madrid', 'HH24:MI') AS hora_fin,
          resource_name   AS pista,
          booking_type    AS tipo,
          origin          AS origen,
          duration_min,
          price_amount::float8 AS importe,
          payment_status  AS estado_pago,
          is_canceled,
          participants,
          -- Nombre de quien figura como titular. Sin email: el panel lo ven
          -- varias personas y para identificar al cliente basta el nombre.
          (SELECT p->>'name'
             FROM jsonb_array_elements(raw->'participant_info'->'participants') p
            WHERE p->>'participant_id' = raw->'participant_info'->>'owner_id'
            LIMIT 1) AS titular
        FROM bookings
        WHERE (start_at AT TIME ZONE 'Europe/Madrid')::date = $1::date
        ORDER BY start_at, resource_name`, [fecha]),

      sql.query(`
        SELECT
          to_char(payment_date AT TIME ZONE 'Europe/Madrid', 'HH24:MI') AS hora,
          item_name     AS articulo,
          item_code     AS codigo,
          unidades,
          total::float8 AS importe,
          metodo
        FROM payments
        WHERE status = 'PAID' AND item_name IS NOT NULL
          AND (payment_date AT TIME ZONE 'Europe/Madrid')::date = $1::date
        ORDER BY payment_date`, [fecha]),

      sql.query(`
        SELECT
          COUNT(*) FILTER (WHERE NOT is_canceled)::int AS reservas,
          COUNT(*) FILTER (WHERE is_canceled)::int     AS canceladas,
          COALESCE(SUM(price_amount) FILTER (WHERE NOT is_canceled
            AND payment_status IN ('PAID','PARTIAL_PAID','PENDING','UNPAID')), 0)::float8 AS importe,
          COALESCE(SUM(duration_min) FILTER (WHERE NOT is_canceled), 0)::float8 / 60 AS horas
        FROM bookings
        WHERE (start_at AT TIME ZONE 'Europe/Madrid')::date = $1::date`, [fecha]),
    ]);

    const tienda = ventas.reduce((a, v) => a + (v.importe ?? 0), 0);

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    return res.status(200).json({
      fecha,
      resumen: { ...resumen[0], tienda, total: (resumen[0]?.importe ?? 0) + tienda },
      reservas,
      ventas,
    });
  } catch (err) {
    console.error('dia falló:', err);
    return res.status(500).json({ error: String(err.message) });
  }
}
