// Sirve al dashboard los agregados ya calculados.
// Nunca expone el token de Playtomic ni datos personales de jugadores.
import { getSql } from '../lib/db.mjs';

export default async function handler(req, res) {
  try {
    const sql = getSql();

    const [meses, ocupacion, pistas, ultimaSync] = await Promise.all([
      // Objetivo + facturacion + ajuste manual, mes a mes.
      sql.query(`
        SELECT
          t.month::text                                      AS month,
          t.target::float8                                   AS objetivo,
          COALESCE(o.amount, r.total)::float8                AS real,
          r.total::float8                                    AS playtomic,
          r.directa::float8                                  AS directa,
          r.marketplace::float8                              AS marketplace,
          r.reservas::int                                    AS reservas,
          r.jugadores::int                                   AS jugadores,
          (o.amount IS NOT NULL)                             AS es_manual,
          o.note                                             AS nota
        FROM targets t
        LEFT JOIN monthly_revenue  r ON r.month = t.month
        LEFT JOIN manual_overrides o ON o.month = t.month
        ORDER BY t.month
      `),
      sql.query(`
        SELECT month::text AS month, hora,
               horas_vendidas::float8    AS horas_vendidas,
               horas_disponibles::int    AS horas_disponibles,
               ocupacion_pct::float8     AS ocupacion_pct
        FROM occupancy_by_slot ORDER BY month, hora
      `),
      sql.query(`SELECT resource_id, resource_name, active FROM courts ORDER BY resource_name`),
      sql.query(`
        SELECT started_at, finished_at, fetched, upserted, ok, error
        FROM sync_log ORDER BY id DESC LIMIT 1
      `),
    ]);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
      meses,
      ocupacion,
      pistas,
      ultima_sync: ultimaSync[0] ?? null,
    });
  } catch (err) {
    console.error('metrics falló:', err);
    return res.status(500).json({ error: String(err.message) });
  }
}
