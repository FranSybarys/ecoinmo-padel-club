// Objetivo del cron diario. Descarga de Playtomic y persiste en Postgres.
// Protegido con CRON_SECRET: Vercel Cron manda ese bearer automaticamente.
import { runSync } from '../lib/sync.mjs';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'no autorizado' });
    }
  }

  if (!process.env.PLAYTOMIC_CLIENT_ID || !process.env.PLAYTOMIC_CLIENT_SECRET) {
    return res.status(503).json({
      error: 'sin credenciales',
      detalle: 'Faltan PLAYTOMIC_CLIENT_ID / PLAYTOMIC_CLIENT_SECRET. ' +
               'Se solicitan en Playtomic Manager -> Ajustes -> Developer tools ' +
               '(o al gestor de cuenta si la opción no aparece).',
    });
  }

  try {
    // 35 dias cubre el mes en curso y el anterior, para recoger
    // cambios de estado de pago y cancelaciones tardias.
    const days = Number(req.query?.days ?? 35);
    const result = await runSync({ days });
    return res.status(200).json(result);
  } catch (err) {
    console.error('sync falló:', err);
    return res.status(500).json({ error: String(err.message) });
  }
}
