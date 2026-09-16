// Valida el token del enlace y abre sesion.
import { getSql } from '../../lib/db.mjs';
import { sha256, firmarSesion, cookieSesion } from '../../lib/auth.mjs';

const fallo = (res, motivo) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(400).send(`<!doctype html><meta charset="utf-8">
<title>Enlace no válido</title>
<div style="font-family:system-ui,sans-serif;background:#0b0b0c;color:#f5f4f2;
     min-height:100vh;display:flex;flex-direction:column;align-items:center;
     justify-content:center;gap:18px;text-align:center;padding:24px;">
  <h1 style="font-size:22px;margin:0;">Este enlace ya no sirve</h1>
  <p style="color:#948f96;max-width:420px;margin:0;">${motivo}</p>
  <a href="/" style="background:#22b581;color:#06120d;text-decoration:none;
     font-weight:700;padding:12px 24px;border-radius:10px;">Pedir uno nuevo</a>
</div>`);
};

export default async function handler(req, res) {
  const token = req.query?.token;
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return fallo(res, 'El enlace está incompleto o mal copiado.');

  try {
    const sql = getSql();
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null;

    // Marcar como usado y devolver la fila en una sola sentencia: si dos
    // peticiones llegan a la vez, solo una se lleva el token.
    const filas = await sql.query(
      `UPDATE auth_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING email`, [await sha256(token)]);

    if (!filas.length) {
      await sql.query(`INSERT INTO auth_log (accion, detalle, ip) VALUES ('rechazo','token usado o caducado',$1)`, [ip]);
      return fallo(res, 'Los enlaces caducan a los 15 minutos y solo pueden usarse una vez.');
    }

    const email = filas[0].email;
    const secret = process.env.AUTH_SECRET;
    if (!secret) throw new Error('falta AUTH_SECRET');

    await sql.query(`INSERT INTO auth_log (email, accion, ip) VALUES ($1,'entrada',$2)`, [email, ip]);

    res.setHeader('Set-Cookie', cookieSesion(await firmarSesion(email, secret)));
    res.setHeader('Location', '/');
    return res.status(302).end();
  } catch (err) {
    console.error('entrar falló:', err);
    return fallo(res, 'Ha ocurrido un error al validar el acceso.');
  }
}
