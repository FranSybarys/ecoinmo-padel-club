// Registro manual de facturacion: el boton del dashboard escribe aqui.
// Prevalece sobre lo calculado desde Playtomic.
import { getSql } from '../lib/db.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'método no permitido' });
  }

  try {
    const sql = getSql();
    const { month, amount, note } = req.body ?? {};
    if (!month || !/^\d{4}-\d{2}-01$/.test(month)) {
      return res.status(400).json({ error: 'month debe ser YYYY-MM-01' });
    }

    if (req.method === 'DELETE') {
      await sql.query(`DELETE FROM manual_overrides WHERE month = $1`, [month]);
      return res.status(200).json({ ok: true, borrado: month });
    }

    const num = Number(amount);
    if (!Number.isFinite(num) || num < 0) {
      return res.status(400).json({ error: 'amount inválido' });
    }

    await sql.query(
      `INSERT INTO manual_overrides (month, amount, note, registered_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (month) DO UPDATE SET
         amount = EXCLUDED.amount, note = EXCLUDED.note, registered_at = now()`,
      [month, num, note ?? null]
    );
    return res.status(200).json({ ok: true, month, amount: num });
  } catch (err) {
    console.error('override falló:', err);
    return res.status(500).json({ error: String(err.message) });
  }
}
