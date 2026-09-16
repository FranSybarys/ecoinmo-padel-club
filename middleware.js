// Corta toda peticion antes de servir nada. Es lo que convierte el
// acceso en real: sin esto, index.html y /api quedan publicos aunque
// la pagina pida contrasena por JavaScript.
import { verificarSesion, leerCookie } from './lib/auth.mjs';

// Rutas que tienen que seguir abiertas.
const LIBRES = [
  '/acceso.html',          // pantalla donde se pide el enlace
  '/api/auth/solicitar',
  '/api/auth/entrar',
  '/api/auth/salir',
  '/api/sync',             // lo protege CRON_SECRET
  '/api/informe-mensual',  // idem
  '/favicon.ico',
];

export const config = {
  matcher: '/((?!_next|_vercel|.*\\.(?:png|jpg|jpeg|svg|ico|webp|woff2?)$).*)',
};

export default async function middleware(req) {
  const url = new URL(req.url);
  const ruta = url.pathname;

  if (LIBRES.some(r => ruta === r || ruta.startsWith(r + '/'))) return;

  const sesion = await verificarSesion(
    leerCookie(req.headers.get('cookie')), process.env.AUTH_SECRET);

  if (sesion) return;   // adelante

  // Al API se le responde con 401 en JSON; a una pagina se la redirige.
  if (ruta.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'no autenticado' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }
  return Response.redirect(new URL('/acceso.html', url), 307);
}
