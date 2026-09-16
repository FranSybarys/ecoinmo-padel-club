#!/usr/bin/env node
// Crea el esquema y carga los objetivos del ejercicio 2026-2027.
// Uso: node --env-file=.env.local scripts/init-db.mjs
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

const TARGETS = [
  ['2026-09-01', 13100],   ['2026-10-01', 14500],
  ['2026-11-01', 13850],   ['2026-12-01', 5600],
  ['2027-01-01', 19487],   ['2027-02-01', 14316],
  ['2027-03-01', 13467],   ['2027-04-01', 15876],
  ['2027-05-01', 18578],   ['2027-06-01', 15243],
  ['2027-07-01', 12345],   ['2027-08-01', 7331.75],
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
