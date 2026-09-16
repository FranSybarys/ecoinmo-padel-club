// Agregados para un rango de fechas arbitrario: mes, trimestre,
// semestre o año. El dashboard de detalle se alimenta de aqui.
import { getSql } from '../lib/db.mjs';

const TZ = 'Europe/Madrid';

// Minutos del hueco cancelado que otra reserva viva llega a cubrir.
// El CASE es imprescindible: LEAST/GREATEST ignoran los NULL del LEFT
// JOIN, y sin el una cancelada sin sustituta sale cubierta al 100%.
const CANC_CTE = `
  WITH cob AS (
    SELECT c.booking_id, c.duration_min, c.price_amount, c.payment_status,
           c.booking_type, c.origin, c.start_at, c.resource_id,
           EXTRACT(hour FROM c.start_at AT TIME ZONE '${TZ}')::int AS hora,
           COALESCE(SUM(CASE WHEN v.booking_id IS NULL THEN 0 ELSE
             EXTRACT(epoch FROM (LEAST(v.end_at, c.end_at)
               - GREATEST(v.start_at, c.start_at))) / 60.0 END), 0) AS min_cub,
           COALESCE(BOOL_OR(v.start_at = c.start_at AND v.end_at = c.end_at), false) AS gemela
    FROM bookings c
    LEFT JOIN bookings v
      ON v.resource_id = c.resource_id AND NOT v.is_canceled
     AND v.start_at < c.end_at AND v.end_at > c.start_at
    WHERE c.is_canceled AND c.start_at >= $1 AND c.start_at < $2
    GROUP BY 1,2,3,4,5,6,7,8),
  clas AS (
    SELECT *, CASE
      WHEN gemela THEN 'sustituida'
      WHEN min_cub >= COALESCE(duration_min,0) * 0.9 AND min_cub > 0 THEN 'recuperada'
      WHEN min_cub > 0 THEN 'parcial'
      ELSE 'vacia' END AS estado,
      GREATEST(COALESCE(duration_min,0) - min_cub, 0) AS min_perdidos
    FROM cob)
`;

export default async function handler(req, res) {
  try {
    const { from, to } = req.query ?? {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
      return res.status(400).json({ error: 'from y to deben ser YYYY-MM-DD' });
    }

    const sql = getSql();
    const dias = Math.round((new Date(to) - new Date(from)) / 86400000);
    // Hasta ~2 meses el detalle diario se lee bien; mas alla, por mes.
    const grano = dias <= 62 ? 'day' : 'month';

    const [kpi, serie, ocupacion, origen, canc, cancHora, cancTipo, pistas, tipos,
           comision, extras, objetivo] =
      await Promise.all([
        sql.query(`
          SELECT COALESCE(SUM(price_amount),0)::float8 AS facturacion,
                 COUNT(*)::int AS reservas,
                 COUNT(DISTINCT owner_id)::int AS jugadores,
                 COALESCE(SUM(duration_min),0)::float8 / 60 AS horas_jugadas
          FROM bookings
          WHERE NOT is_canceled AND start_at >= $1 AND start_at < $2
            AND payment_status IN ('PAID','PARTIAL_PAID','PENDING','UNPAID')`, [from, to]),

        sql.query(`
          SELECT date_trunc('${grano}', start_at AT TIME ZONE '${TZ}')::date::text AS punto,
                 COALESCE(SUM(price_amount),0)::float8 AS facturacion,
                 COUNT(*)::int AS reservas
          FROM bookings
          WHERE NOT is_canceled AND start_at >= $1 AND start_at < $2
            AND payment_status IN ('PAID','PARTIAL_PAID','PENDING','UNPAID')
          GROUP BY 1 ORDER BY 1`, [from, to]),

        sql.query(`
          WITH franjas AS (
            SELECT gs AS franja,
              EXTRACT(epoch FROM (LEAST(b.end_at, gs + INTERVAL '1 hour')
                - GREATEST(b.start_at, gs))) / 60.0 AS minutos
            FROM bookings b
            CROSS JOIN LATERAL generate_series(date_trunc('hour', b.start_at),
              b.end_at - INTERVAL '1 microsecond', INTERVAL '1 hour') AS gs
            WHERE NOT b.is_canceled AND b.start_at >= $1 AND b.start_at < $2),
          dias AS (
            SELECT COUNT(DISTINCT (start_at AT TIME ZONE '${TZ}')::date) AS n
            FROM bookings WHERE NOT is_canceled AND start_at >= $1 AND start_at < $2)
          SELECT EXTRACT(hour FROM franja AT TIME ZONE '${TZ}')::int AS hora,
                 ROUND((SUM(minutos)/60.0)::numeric, 1)::float8 AS horas,
                 ROUND((100.0 * SUM(minutos)/60.0
                   / NULLIF((SELECT COUNT(*) FROM courts WHERE active)
                     * (SELECT n FROM dias), 0))::numeric, 1)::float8 AS pct
          FROM franjas GROUP BY 1 ORDER BY 1`, [from, to]),

        // Detalle por canal y grupo. Tres grupos, no dos: las importadas
        // vienen de otro sistema y no las hizo ni el club ni el cliente.
        sql.query(`
          SELECT origin AS canal,
                 CASE
                   WHEN origin IN ('MANAGER','PLAYTOMIC_MANAGER') THEN 'manual'
                   WHEN origin IN ('APP_IOS','APP_ANDROID','WEB_MOBILE','WEB_DESKTOP') THEN 'cliente'
                   ELSE 'otro' END AS grupo,
                 COALESCE(SUM(price_amount),0)::float8 AS euros,
                 COUNT(*)::int AS reservas,
                 COALESCE(SUM(duration_min),0)::float8 / 60 AS horas,
                 COUNT(DISTINCT owner_id)::int AS jugadores
          FROM bookings
          WHERE NOT is_canceled AND start_at >= $1 AND start_at < $2
            AND payment_status IN ('PAID','PARTIAL_PAID','PENDING','UNPAID')
          GROUP BY 1, 2 ORDER BY euros DESC`, [from, to]),

        sql.query(CANC_CTE + `
          SELECT estado, COUNT(*)::int AS n,
                 ROUND((SUM(min_perdidos)/60.0)::numeric)::float8 AS horas_perdidas,
                 COALESCE(ROUND(SUM(price_amount) FILTER (WHERE payment_status='REFUNDED')),0)::float8 AS eur_devuelto
          FROM clas GROUP BY 1`, [from, to]),

        sql.query(CANC_CTE + `
          SELECT hora, COUNT(*)::int AS canc,
                 COUNT(*) FILTER (WHERE estado='vacia')::int AS vacias,
                 ROUND((SUM(min_perdidos)/60.0)::numeric)::float8 AS horas_perdidas
          FROM clas GROUP BY 1 ORDER BY 1`, [from, to]),

        sql.query(CANC_CTE + `
          SELECT booking_type AS tipo, COUNT(*)::int AS canc,
                 COUNT(*) FILTER (WHERE estado='vacia')::int AS vacias,
                 ROUND((SUM(min_perdidos)/60.0)::numeric)::float8 AS horas_perdidas
          FROM clas GROUP BY 1 ORDER BY canc DESC`, [from, to]),

        sql.query(`
          SELECT co.resource_name AS pista,
                 COUNT(*) FILTER (WHERE NOT b.is_canceled)::int AS reservas,
                 COALESCE(SUM(b.price_amount) FILTER (WHERE NOT b.is_canceled),0)::float8 AS euros,
                 COALESCE(SUM(b.duration_min) FILTER (WHERE NOT b.is_canceled),0)::float8 / 60 AS horas
          FROM bookings b JOIN courts co ON co.resource_id = b.resource_id
          WHERE b.start_at >= $1 AND b.start_at < $2
          GROUP BY 1 ORDER BY euros DESC`, [from, to]),

        sql.query(`
          SELECT booking_type AS tipo,
                 COUNT(*)::int AS reservas,
                 COALESCE(SUM(price_amount),0)::float8 AS euros,
                 COALESCE(SUM(duration_min),0)::float8 / 60 AS horas
          FROM bookings
          WHERE NOT is_canceled AND start_at >= $1 AND start_at < $2
            AND payment_status IN ('PAID','PARTIAL_PAID','PENDING','UNPAID')
          GROUP BY 1 ORDER BY euros DESC`, [from, to]),

        // Comisiones de Playtomic. Solo los cobros por su pasarela la
        // generan; lo cobrado en el club no paga nada.
        sql.query(`
          SELECT metodo,
                 COUNT(*)::int AS pagos,
                 COALESCE(SUM(total),0)::float8 AS bruto,
                 COALESCE(SUM(comision),0)::float8 AS comision,
                 COALESCE(SUM(comision_iva),0)::float8 AS comision_iva,
                 MAX(comision_rate)::float8 AS tarifa
          FROM payments
          WHERE status = 'PAID' AND payment_date >= $1 AND payment_date < $2
          GROUP BY 1 ORDER BY bruto DESC`, [from, to]),

        sql.query(`
          SELECT item_code, item_name,
                 SUM(COALESCE(unidades,1))::int AS unidades,
                 COALESCE(SUM(total),0)::float8 AS euros,
                 COUNT(*)::int AS ventas
          FROM payments
          WHERE status = 'PAID' AND item_name IS NOT NULL
            AND payment_date >= $1 AND payment_date < $2
          GROUP BY 1,2 ORDER BY euros DESC`, [from, to]),

        sql.query(`SELECT COALESCE(SUM(target),0)::float8 AS objetivo
                   FROM targets WHERE month >= $1 AND month < $2`, [from, to]),
      ]);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
      rango: { from, to, dias, grano },
      kpi: { ...kpi[0], objetivo: objetivo[0]?.objetivo ?? 0 },
      serie, ocupacion, origen, tipos, comision, extras,
      cancelaciones: { total: canc, por_hora: cancHora, por_tipo: cancTipo },
      pistas,
    });
  } catch (err) {
    console.error('periodo falló:', err);
    return res.status(500).json({ error: String(err.message) });
  }
}
