#!/usr/bin/env node
// Carga reservas simuladas para ver el dashboard funcionando antes de
// tener las credenciales de Playtomic. Se borran con --clean.
// Uso: node --env-file=.env.local scripts/seed-demo.mjs [--clean]
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

if (process.argv.includes('--clean')) {
  await sql.query(`DELETE FROM bookings WHERE booking_id LIKE 'demo-%'`);
  // Las pistas reales llevan UUID; las simuladas, un slug. Si no se
  // borran, inflan el denominador de la ocupacion.
  await sql.query(
    `DELETE FROM courts WHERE resource_id !~ '^[0-9a-f-]{36}$'`);
  console.log('Datos de demostración borrados (reservas y pistas).');
  process.exit(0);
}

const PISTAS = ['Pista 1','Pista 2','Pista 3','Pista 4','Pista 5','Pista 6'];

// Slots reales de 90 min encadenados, en hora local de Granada.
// Se pasan como texto y Postgres los interpreta con AT TIME ZONE,
// asi el cambio de hora de octubre se resuelve solo.
const SLOTS = ['09:00','10:30','12:00','13:30','16:00','17:30','19:00','20:30','22:00'];

// Probabilidad de que el slot se venda, y precio. Valle barato y vacio,
// punta caro y lleno: es el patron real de un club de padel.
const LLENADO = {'09:00':.22,'10:30':.30,'12:00':.34,'13:30':.28,'16:00':.40,
                 '17:30':.58,'19:00':.88,'20:30':.92,'22:00':.55};
const PRECIO  = {'09:00':16,'10:30':16,'12:00':16,'13:30':16,'16:00':20,
                 '17:30':24,'19:00':32,'20:30':32,'22:00':22};

// Generador determinista: el seed es reproducible.
let semilla = 42;
const rnd = () => (semilla = (semilla * 1103515245 + 12345) % 2147483648) / 2147483648;

const filas = [];
for (const [y, m, dias] of [[2026, 9, 30], [2026, 10, 31]]) {
  for (let d = 1; d <= dias; d++) {
    const fecha = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const finde = [0,6].includes(new Date(`${fecha}T12:00:00Z`).getUTCDay());
    for (const slot of SLOTS) {
      for (const pista of PISTAS) {
        // El fin de semana se llenan mas las horas centrales.
        const ajuste = finde && ['10:30','12:00','13:30'].includes(slot) ? 1.7 : 1;
        if (rnd() > Math.min(LLENADO[slot] * ajuste, 0.97)) continue;
        filas.push({
          id: `demo-${fecha}-${slot.replace(':','')}-${pista.replace(/\s/g,'')}`,
          pista,
          inicio: `${fecha} ${slot}:00`,
          precio: PRECIO[slot],
          origin: rnd() < 0.42 ? 'ANEMONE' : 'PLAYTOMIC_MANAGER',
          cancelada: rnd() < 0.04,
        });
      }
    }
  }
}

console.log(`Insertando ${filas.length} reservas simuladas...`);

// Inserta en lotes: una consulta por reserva son 2.000 viajes de red.
const LOTE = 100;
for (let i = 0; i < filas.length; i += LOTE) {
  const trozo = filas.slice(i, i + LOTE);
  const vals = [];
  const params = [];
  trozo.forEach((r, j) => {
    const b = j * 8;
    vals.push(`($${b+1},'demo-tenant',$${b+2},$${b+3},'PADEL','REGULAR_BOOKING',$${b+4},
      ($${b+5}::timestamp AT TIME ZONE 'Europe/Madrid'),
      ($${b+5}::timestamp AT TIME ZONE 'Europe/Madrid') + INTERVAL '90 minutes',
      90,$${b+6},'EUR',$${b+7},'FINISHED',$${b+8},4,'{}'::jsonb)`);
    params.push(r.id, r.pista.replace(/\s/g,'').toLowerCase(), r.pista, r.origin,
                r.inicio, r.precio, r.cancelada ? 'REFUNDED' : 'PAID', r.cancelada);
  });
  await sql.query(
    `INSERT INTO bookings (booking_id, tenant_id, resource_id, resource_name, sport_id,
       booking_type, origin, start_at, end_at, duration_min, price_amount, price_currency,
       payment_status, status, is_canceled, participants, raw)
     VALUES ${vals.join(',')}
     ON CONFLICT (booking_id) DO NOTHING`, params);
}

await sql.query(
  `INSERT INTO courts (resource_id, resource_name)
   SELECT DISTINCT ON (resource_id) resource_id, resource_name FROM bookings
   WHERE resource_id IS NOT NULL ORDER BY resource_id, start_at DESC
   ON CONFLICT (resource_id) DO UPDATE SET resource_name = EXCLUDED.resource_name`
);

console.log('\n=== Facturación mensual ===');
console.table(await sql.query(
  `SELECT month::text AS mes, total::float8 AS total, directa::float8 AS directa,
          marketplace::float8 AS marketplace, reservas FROM monthly_revenue ORDER BY month`));
console.log('=== Ocupación septiembre ===');
console.table(await sql.query(
  `SELECT hora, horas_vendidas::float8 AS horas, horas_disponibles,
          ocupacion_pct::float8 AS pct
   FROM occupancy_by_slot WHERE month::text='2026-09-01' ORDER BY hora`));
