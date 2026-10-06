#!/usr/bin/env node
// Crea el esquema y carga los objetivos del ejercicio 2026-2027.
// Uso: node --env-file=.env.local scripts/init-db.mjs
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

// Objetivos del ejercicio. Revisados el 6 de octubre de 2026.
// Si se vuelven a cambiar, este es el unico sitio donde tocarlos: el panel
// los lee de /api/metrics, no los lleva escritos.
const TARGETS = [
  ['2026-09-01', 13100],   ['2026-10-01', 14500],
  ['2026-11-01', 13950],   ['2026-12-01', 6950],
  ['2027-01-01', 19487],   ['2027-02-01', 14916],
  ['2027-03-01', 13985],   ['2027-04-01', 16976],
  ['2027-05-01', 20345],   ['2027-06-01', 15856],
  ['2027-07-01', 13845],   ['2027-08-01', 8331],
];

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

// neon() no admite varias sentencias por llamada: se parten por ';' de fin de linea.
const statements = schema
  .split(/;\s*$/m)
  .map(s => s.trim())
  .filter(s => s && !s.split('\n').every(l => l.trim().startsWith('--')));

console.log(`Aplicando ${statements.length} sentencias...`);
for (const st of statements) {
  await sql.query(st);
}

for (const [month, target] of TARGETS) {
  await sql.query(
    `INSERT INTO targets (month, target) VALUES ($1, $2)
     ON CONFLICT (month) DO UPDATE SET target = EXCLUDED.target`,
    [month, target]
  );
}

const [{ count }] = await sql.query('SELECT COUNT(*)::int AS count FROM targets');
console.log(`OK. Objetivos cargados: ${count}`);

const tables = await sql.query(
  `SELECT table_name FROM information_schema.tables
   WHERE table_schema='public' ORDER BY table_name`
);
console.log('Tablas y vistas:', tables.map(t => t.table_name).join(', '));
