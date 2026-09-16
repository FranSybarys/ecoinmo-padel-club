import { cookieBorrar, leerCookie, verificarSesion } from '../../lib/auth.mjs';
import { getSql } from '../../lib/db.mjs';

export default async function handler(req, res) {
  try {
    const s = await verificarSesion(leerCookie(req.headers.cookie), process.env.AUTH_SECRET);
    if (s) await getSql().query(
      `INSERT INTO auth_log (email, accion) VALUES ($1,'salida')`, [s.email]);
  } catch {}
  res.setHeader('Set-Cookie', cookieBorrar());
  res.setHeader('Location', '/');
  return res.status(302).end();
}
