// Acceso por enlace magico. Solo correos del dominio autorizado.
//
// La cookie de sesion va firmada con HMAC y se verifica sin tocar la
// base de datos: el middleware corre en cada peticion y una consulta
// por request seria caro. Para revocar todas las sesiones de golpe,
// basta rotar AUTH_SECRET.

const DOMINIO = 'ecoinmo.com';
export const COOKIE = 'cpc_sesion';
export const DIAS_SESION = 30;
const MIN_TOKEN = 15;   // validez del enlace, en minutos

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

export function emailValido(email) {
  if (typeof email !== 'string') return null;
  const e = email.trim().toLowerCase();
  // Deliberadamente estricto: sin subdominios ni etiquetas +algo.
  if (!/^[a-z0-9._%-]+@[a-z0-9.-]+$/.test(e)) return null;
  return e.endsWith('@' + DOMINIO) ? e : null;
}

async function hmac(secret, mensaje) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(mensaje)));
}

export async function sha256(txt) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(txt));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

/** Cookie de sesion: <email>.<caducidad>.<firma> */
export async function firmarSesion(email, secret, dias = DIAS_SESION) {
  const exp = Date.now() + dias * 86400_000;
  const cuerpo = `${b64url(enc.encode(email))}.${exp}`;
  return `${cuerpo}.${await hmac(secret, cuerpo)}`;
}

export async function verificarSesion(valor, secret) {
  if (!valor || typeof valor !== 'string') return null;
  const p = valor.split('.');
  if (p.length !== 3) return null;
  const [e64, exp, firma] = p;
  const cuerpo = `${e64}.${exp}`;

  const esperada = await hmac(secret, cuerpo);
  // Comparacion en tiempo constante: no filtrar cuanto coincide.
  if (firma.length !== esperada.length) return null;
  let dif = 0;
  for (let i = 0; i < firma.length; i++) dif |= firma.charCodeAt(i) ^ esperada.charCodeAt(i);
  if (dif !== 0) return null;

  if (!Number(exp) || Date.now() > Number(exp)) return null;

  try {
    const email = new TextDecoder().decode(
      Uint8Array.from(atob(e64.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0)));
    return emailValido(email) ? { email, exp: Number(exp) } : null;
  } catch { return null; }
}

export function nuevoToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b).map(x => x.toString(16).padStart(2,'0')).join('');
}

export const caducidadToken = () => new Date(Date.now() + MIN_TOKEN * 60_000);
export const minutosToken = MIN_TOKEN;

export function cookieSesion(valor, dias = DIAS_SESION) {
  return `${COOKIE}=${valor}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${dias*86400}`;
}
export const cookieBorrar = () =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function leerCookie(cabecera, nombre = COOKIE) {
  if (!cabecera) return null;
  for (const p of cabecera.split(';')) {
    const [k, ...v] = p.trim().split('=');
    if (k === nombre) return v.join('=');
  }
  return null;
}
