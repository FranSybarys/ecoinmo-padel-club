// Cron mensual: genera el informe del mes cerrado y lo envia a los socios.
// Se dispara el dia 2 de cada mes, cuando el mes anterior ya esta completo.
import { datosMes, generarHTML } from '../lib/informe.mjs';

const DESTINATARIOS = ['fran@ecoinmo.com', 'jesus@ecoinmo.com', 'maria@ecoinmo.com'];
const FROM = 'Campus Pádel Club <tech.reporting@ecoinmo.com>';
const REPLY_TO = 'fran@ecoinmo.com';

const MES = ['','enero','febrero','marzo','abril','mayo','junio','julio',
             'agosto','septiembre','octubre','noviembre','diciembre'];

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    if ((req.headers.authorization || '') !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'no autorizado' });
    }
  }

  const key = process.env.RESEND_ECOINMO_API_KEY;
  if (!key) {
    return res.status(503).json({ error: 'falta RESEND_ECOINMO_API_KEY' });
  }

  try {
    // Por defecto, el mes anterior al actual. ?mes=YYYY-MM-01 lo fuerza.
    let from = req.query?.mes;
    if (!from) {
      const hoy = new Date();
      from = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 1, 1))
        .toISOString().slice(0, 10);
    }
    if (!/^\d{4}-\d{2}-01$/.test(from)) {
      return res.status(400).json({ error: 'mes debe ser YYYY-MM-01' });
    }
    const f = new Date(from + 'T00:00:00Z');
    const to = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 1))
      .toISOString().slice(0, 10);

    const datos = await datosMes(from, to);

    // Sin actividad no se manda nada: un informe vacio es ruido.
    if (!datos.kpi.reservas) {
      return res.status(200).json({ enviado: false, motivo: 'sin reservas', mes: from });
    }

    const html = generarHTML(datos, from);
    const asunto = `Informe de ${MES[f.getUTCMonth()+1]} ${f.getUTCFullYear()} · Campus Pádel Club`;

    const dest = req.query?.solo ? [req.query.solo] : DESTINATARIOS;

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: dest, reply_to: REPLY_TO, subject: asunto, html }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.message || JSON.stringify(body));

    return res.status(200).json({
      enviado: true, mes: from, destinatarios: dest,
      facturacion: datos.kpi.facturacion, reservas: datos.kpi.reservas, id: body.id,
    });
  } catch (err) {
    console.error('informe-mensual falló:', err);
    return res.status(500).json({ error: String(err.message) });
  }
}
