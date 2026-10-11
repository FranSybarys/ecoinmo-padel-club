#!/usr/bin/env node
// Envia un informe HTML por correo usando Resend.
//
// Uso:  node scripts/enviar-informe.mjs <fichero.html> "<asunto>" [destinatario ...]
// Sin destinatarios, usa los tres socios.
//
// Requiere RESEND_ECOINMO_API_KEY (cuenta de Resend donde esta
// verificado ecoinmo.com; NO es la misma que RESEND_API_KEY).
import { readFileSync } from 'node:fs';

const FROM = 'Campus Pádel Club <tech.reporting@ecoinmo.com>';

// El buzon reporting@ solo sirve para enviar: el MX de ecoinmo.com
// apunta a Microsoft 365 y si esa direccion no existe alli, cualquier
// respuesta rebota. Reply-To la desvia a un buzon que si existe.
const REPLY_TO = 'fran@ecoinmo.com';

const SOCIOS = [
  'fran@ecoinmo.com', 'jesus@ecoinmo.com',
  'maria@ecoinmo.com', 'paloma@ecoinmo.com',
];

const [fichero, asunto, ...dest] = process.argv.slice(2);

if (!fichero || !asunto) {
  console.error('Uso: node scripts/enviar-informe.mjs <fichero.html> "<asunto>" [destinatario ...]');
  process.exit(1);
}

const key = process.env.RESEND_ECOINMO_API_KEY;
if (!key) {
  console.error('Falta RESEND_ECOINMO_API_KEY. Hacer `source ~/.zshrc` antes.');
  process.exit(1);
}

const to = dest.length ? dest : SOCIOS;
const html = readFileSync(fichero, 'utf8');

// Alternativa en texto a partir del propio HTML. Basta con que exista:
// un correo sin parte de texto puntua peor en los filtros de spam.
const texto = html
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();

const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ from: FROM, to, reply_to: REPLY_TO, subject: asunto, html, text: texto }),
});

const body = await res.json();

if (!res.ok) {
  console.error(`Error ${res.status}:`, body.message || JSON.stringify(body));
  process.exit(1);
}

console.log(`Enviado a ${to.join(', ')}`);
console.log(`  asunto:   ${asunto}`);
console.log(`  responder a: ${REPLY_TO}`);
console.log(`  id:       ${body.id}`);
