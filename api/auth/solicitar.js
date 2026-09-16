// Recibe un correo y, si es del dominio autorizado, manda el enlace.
import { getSql } from '../../lib/db.mjs';
import { emailValido, nuevoToken, sha256, caducidadToken, minutosToken } from '../../lib/auth.mjs';

const FROM = 'Campus Pádel Club <tech.reporting@ecoinmo.com>';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'método no permitido' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null;
  const email = emailValido(req.body?.email);
  const sql = getSql();

  // Respuesta identica en todos los casos: no revelamos que correos
  // existen ni cuales pertenecen al dominio.
  const ok = () => res.status(200).json({ ok: true });

  if (!email) {
    try { await sql.query(
      `INSERT INTO auth_log (email, accion, detalle, ip) VALUES ($1,'rechazo','fuera de dominio',$2)`,
      [String(req.body?.email ?? '').slice(0,120), ip]); } catch {}
    return ok();
  }

  try {
    const token = nuevoToken();
    await sql.query(
      `INSERT INTO auth_tokens (token_hash, email, expires_at) VALUES ($1,$2,$3)`,
      [await sha256(token), email, caducidadToken().toISOString()]);
    await sql.query(
      `INSERT INTO auth_log (email, accion, ip) VALUES ($1,'solicitud',$2)`, [email, ip]);

    // Limpieza oportunista de tokens caducados.
    await sql.query(`DELETE FROM auth_tokens WHERE expires_at < now() - INTERVAL '1 day'`);

    const base = `https://${req.headers.host}`;
    const enlace = `${base}/api/auth/entrar?token=${token}`;

    const key = process.env.RESEND_ECOINMO_API_KEY;
    if (!key) throw new Error('falta RESEND_ECOINMO_API_KEY');

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM, to: [email],
        subject: 'Tu acceso a Campus Pádel Club',
        html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;line-height:1.6;">
<div style="border-bottom:3px solid #e6007e;padding-bottom:14px;margin-bottom:24px;">
  <div style="font-size:11px;color:#888;letter-spacing:1.5px;text-transform:uppercase;">Campus Pádel Club</div>
  <h1 style="margin:6px 0 0 0;font-size:20px;">Tu enlace de acceso</h1></div>
<p>Pulsa el botón para entrar al dashboard. No hace falta contraseña.</p>
<p style="margin:26px 0;"><a href="${enlace}"
  style="background:#22b581;color:#06120d;text-decoration:none;font-weight:700;
         padding:14px 28px;border-radius:10px;display:inline-block;font-size:15px;">Entrar al dashboard</a></p>
<p style="font-size:13px;color:#666;">El enlace caduca en ${minutosToken} minutos y solo sirve una vez.
Si no lo has pedido tú, ignora este correo: sin pulsarlo no se concede ningún acceso.</p>
<div style="margin-top:26px;padding-top:14px;border-top:1px solid #ddd;font-size:11.5px;color:#999;word-break:break-all;">
Si el botón no funciona, copia esta dirección:<br>${enlace}</div></div>`,
      }),
    });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(b.message || `Resend ${r.status}`);
    }
    return ok();
  } catch (err) {
    console.error('solicitar falló:', err);
    // Tambien respuesta neutra: el usuario no debe deducir nada del fallo.
    return ok();
  }
}
