#!/usr/bin/env node
// Sincroniza cobros desde local.
// Uso: node --env-file=.env.local scripts/sync-pagos.mjs [dias]
import { runSyncPayments } from '../lib/sync.mjs';
const days = Number(process.argv[2] ?? 35);
console.log(`Descargando cobros de los últimos ${days} días...`);
const r = await runSyncPayments({ days });
console.log(`OK. ${r.descargados} descargados, ${r.guardados} guardados.`);
