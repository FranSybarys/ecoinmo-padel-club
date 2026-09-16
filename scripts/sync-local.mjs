#!/usr/bin/env node
// Ejecuta una sincronizacion desde local, sin pasar por la funcion.
// Uso: node --env-file=.env.local scripts/sync-local.mjs [dias]
import { runSync } from '../lib/sync.mjs';

const days = Number(process.argv[2] ?? 35);

if (!process.env.PLAYTOMIC_CLIENT_ID || !process.env.PLAYTOMIC_CLIENT_SECRET) {
  console.error('Faltan PLAYTOMIC_CLIENT_ID / PLAYTOMIC_CLIENT_SECRET en .env.local');
  process.exit(1);
}

console.log(`Sincronizando ultimos ${days} dias...`);
const r = await runSync({ days });
console.log(`OK. Descargadas ${r.fetched}, guardadas ${r.upserted}`);
