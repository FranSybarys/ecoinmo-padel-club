// Valida el token del enlace y abre sesion.
//
// Dos pasos a proposito. Los escaneres de correo (Microsoft Safe Links
// entre ellos) abren los enlaces entrantes para analizarlos, y con un
// token de un solo uso lo gastaban antes de que la persona pulsara:
// se veian entradas desde 104.47.x.x (Exchange Online Protection) doce
// segundos despues de enviar el correo.
//   GET  -> pagina de confirmacion, no toca el token
//   POST -> consume el token y abre sesion
// Los escaneres siguen enlaces, pero no envian formularios.
import { getSql } from '../../lib/db.mjs';
import { sha256, firmarSesion, cookieSesion } from '../../lib/auth.mjs';

const pagina = (cuerpo) => `<!doctype html><html lang="es"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Acceso · Campus Pádel Club</title>
<style>
  body{margin:0;background:#0b0b0c;color:#f5f4f2;min-height:100vh;
       font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
       display:flex;flex-direction:column;align-items:center;justify-content:center;
       gap:26px;text-align:center;padding:24px;}
  h1{font-size:clamp(20px,5vw,30px);margin:0;letter-spacing:.04em;}
  p{color:#948f96;max-width:440px;margin:0;line-height:1.6;font-size:14.5px;}
  .btn{background:#22b581;color:#06120d;border:none;text-decoration:none;
       font-size:16px;font-weight:700;padding:16px 34px;border-radius:12px;
       cursor:pointer;display:inline-block;}
  .btn:hover{background:#2ecc8f;}
  .marca{font-size:11px;color:#615d63;letter-spacing:1.5px;text-transform:uppercase;}
</style>
<div class="marca">Campus Pádel Club</div>
${cuerpo}`;

const fallo = (res, motivo) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(400).send(pagina(`
    <h1>Este enlace ya no sirve</h1>
    <p>${motivo}</p>
    <a class="btn" href="/acceso.html">Pedir uno nuevo</a>`));
};

export default async function handler(req, res) {
  const token = req.method === 'POST' ? req.body?.token : req.query?.token;
  if (!token || !/^[0-9a-f]{64}$/.test(token)) {
    return fallo(res, 'El enlace está incompleto o mal copiado.');
  }

  // Paso 1: solo confirmar. No se consulta ni se toca el token.
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(pagina(`
      <h1>Confirma tu acceso</h1>
      <p>Pulsa el botón para entrar al dashboard.
         Este paso existe para que los filtros de correo no consuman tu enlace.</p>
      <form method="POST" action="/api/auth/entrar">
        <input type="hidden" name="token" value="${token.replace(/[^0-9a-f]/g,'')}">
        <button class="btn" type="submit">Entrar al dashboard</button>
      </form>`));
  }

  // Paso 2: aqui si se consume.
  try {
    const sql = getSql();
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || null;

    // Marcar usado y devolver la fila en una sola sentencia: si llegan
    // dos peticiones a la vez, solo una se lleva el token.
    const filas = await sql.query(
      `UPDATE auth_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING email`, [await sha256(token)]);

    if (!filas.length) {
      await sql.query(
        `INSERT INTO auth_log (accion, detalle, ip) VALUES ('rechazo','token usado o caducado',$1)`, [ip]);
      return fallo(res, 'Los enlaces caducan a los 15 minutos y solo pueden usarse una vez.');
    }

    const email = filas[0].email;
    const secret = process.env.AUTH_SECRET;
    if (!secret) throw new Error('falta AUTH_SECRET');

    await sql.query(`INSERT INTO auth_log (email, accion, ip) VALUES ($1,'entrada',$2)`, [email, ip]);

    res.setHeader('Set-Cookie', cookieSesion(await firmarSesion(email, secret)));
    res.setHeader('Location', '/');
    return res.status(303).end();
  } catch (err) {
    console.error('entrar falló:', err);
    return fallo(res, 'Ha ocurrido un error al validar el acceso.');
  }
}
