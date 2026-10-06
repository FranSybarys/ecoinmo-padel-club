// Detalle de cancelaciones: quien cancela y que cliente es.
//
// Importante sobre "quien cancela": Playtomic no dice que empleado ejecuto
// la cancelacion. Lo unico que consta es el origen de la reserva, que
// distingue si se hizo desde el manager del club o desde la app del
// jugador. Eso es lo que se muestra, y no se presenta como mas de lo que es.
import { getSql } from '../lib/db.mjs';

const CLUB = ['MANAGER', 'PLAYTOMIC_MANAGER', 'IMPORTED'];

export default async function handler(req, res) {
  try {
    const sql = getSql();
    const mes = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.mes || '') ? req.query.mes : null;

    const filas = await sql.query(`
      SELECT
        booking_id,
        to_char(start_at AT TIME ZONE 'Europe/Madrid', 'DD/MM/YYYY HH24:MI') AS cuando,
        (start_at AT TIME ZONE 'Europe/Madrid')::date::text AS dia,
        resource_name  AS pista,
        booking_type   AS tipo,
        origin         AS origen,
        CASE WHEN origin = ANY($2) THEN 'club' ELSE 'jugador' END AS cancela,
        price_amount::float8 AS importe,
        payment_status AS estado_pago,
        (SELECT p->>'name'
           FROM jsonb_array_elements(raw->'participant_info'->'participants') p
          WHERE p->>'participant_id' = raw->'participant_info'->>'owner_id'
          LIMIT 1) AS cliente
      FROM bookings
      WHERE is_canceled
        AND ($1::date IS NULL OR
             date_trunc('month', start_at AT TIME ZONE 'Europe/Madrid')::date = $1::date)
      ORDER BY start_at DESC
      LIMIT 500`, [mes, CLUB]);

    // Reincidentes: a quien se le repiten las cancelaciones. Es el dato por
    // el que se suele pedir este panel.
    const porCliente = await sql.query(`
      SELECT cliente, COUNT(*)::int AS cancelaciones,
             COALESCE(SUM(importe), 0)::float8 AS importe
      FROM (
        SELECT (SELECT p->>'name'
                  FROM jsonb_array_elements(raw->'participant_info'->'participants') p
                 WHERE p->>'participant_id' = raw->'participant_info'->>'owner_id'
                 LIMIT 1) AS cliente,
               price_amount AS importe
        FROM bookings
        WHERE is_canceled AND NOT (origin = ANY($2))
          AND ($1::date IS NULL OR
               date_trunc('month', start_at AT TIME ZONE 'Europe/Madrid')::date = $1::date)
      ) t
      WHERE cliente IS NOT NULL
      GROUP BY cliente HAVING COUNT(*) > 1
      ORDER BY cancelaciones DESC, importe DESC
      LIMIT 25`, [mes, CLUB]);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ mes, filas, reincidentes: porCliente });
  } catch (err) {
    console.error('cancelaciones falló:', err);
    return res.status(500).json({ error: String(err.message) });
  }
}
