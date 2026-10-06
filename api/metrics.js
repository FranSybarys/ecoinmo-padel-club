// Sirve al dashboard los agregados ya calculados.
// Nunca expone el token de Playtomic ni datos personales de jugadores.
import { getSql } from '../lib/db.mjs';

export default async function handler(req, res) {
  try {
    const sql = getSql();

    const [meses, ocupacion, pistas, cobros, cancelaciones, ultimaSync, ultimaOk,
           ventas, formasPago, monedero, tiendaPago] = await Promise.all([
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
          r.cobrado::float8                                  AS cobrado,
          r.pendiente_cobro::float8                          AS pendiente,
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
      // Cobros por mes. El endpoint de pagos de Playtomic guarda mucho
      // mas historico que el de reservas, asi que hay meses con bruto
      // cobrado pero sin ningun detalle de reservas.
      sql.query(`
        SELECT c.month::text AS month,
               c.bruto::float8, c.comision::float8, c.comision_iva::float8,
               c.pct_sobre_bruto::float8, c.pagos,
               EXISTS (SELECT 1 FROM bookings b
                 WHERE b.start_at >= c.month
                   AND b.start_at < (c.month + INTERVAL '1 month')) AS hay_reservas
        FROM monthly_commission c ORDER BY c.month`),
      // Cancelaciones separando al jugador del propio club: mezclarlas
      // da un 33% que no significa nada.
      sql.query(`
        SELECT
          date_trunc('month', start_at AT TIME ZONE 'Europe/Madrid')::date::text AS month,
          COUNT(*) FILTER (WHERE origin NOT IN ('MANAGER','PLAYTOMIC_MANAGER','IMPORTED'))::int AS jugador_total,
          COUNT(*) FILTER (WHERE origin NOT IN ('MANAGER','PLAYTOMIC_MANAGER','IMPORTED') AND is_canceled)::int AS jugador_canc,
          COUNT(*) FILTER (WHERE origin IN ('MANAGER','PLAYTOMIC_MANAGER','IMPORTED'))::int AS club_total,
          COUNT(*) FILTER (WHERE origin IN ('MANAGER','PLAYTOMIC_MANAGER','IMPORTED') AND is_canceled)::int AS club_canc
        FROM bookings GROUP BY 1 ORDER BY 1
      `),
      sql.query(`
        SELECT started_at, finished_at, fetched, upserted, ok, error
        FROM sync_log ORDER BY id DESC LIMIT 1
      `),
      // La ultima que de verdad termino bien. Si el ultimo intento se quedo
      // a medias (la funcion muere por timeout sin poder marcar el error),
      // esta es la fecha real de los datos que se estan mirando.
      sql.query(`
        SELECT finished_at, upserted
        FROM sync_log WHERE ok = true ORDER BY id DESC LIMIT 1
      `),
      // Ingresos por tipo de reserva. Suma exactamente lo mismo que la
      // facturacion de la tabla principal, por eso sale de bookings.
      sql.query(`
        SELECT month::text AS month, booking_type, reservas,
               euros::float8, horas::float8
        FROM monthly_sales_mix ORDER BY month, euros DESC`),
      // Formas de cobro. 'club' agrupa efectivo y TPV: Playtomic no los separa.
      sql.query(`
        SELECT month::text AS month, canal, metodo, pagos, euros::float8
        FROM monthly_payment_methods ORDER BY month, euros DESC`),
      sql.query(`
        SELECT month::text AS month, recargado::float8, n_recargas,
               consumido::float8, n_consumos
        FROM monthly_wallet ORDER BY month`),
      sql.query(`
        SELECT month::text AS month, metodo, unidades, euros::float8, ventas
        FROM monthly_extras_payment ORDER BY month, euros DESC`),
    ]);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
      meses,
      ocupacion,
      pistas,
      cobros,
      cancelaciones,
      ultima_sync: ultimaSync[0] ?? null,
      ultima_sync_ok: ultimaOk[0] ?? null,
      ventas,
      formas_pago: formasPago,
      monedero,
      tienda_pago: tiendaPago,
    });
  } catch (err) {
    console.error('metrics falló:', err);
    return res.status(500).json({ error: String(err.message) });
  }
}
