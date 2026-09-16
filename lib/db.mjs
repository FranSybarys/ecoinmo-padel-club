import { neon } from '@neondatabase/serverless';

// Inicializacion perezosa: neon() lanza si DATABASE_URL no esta definida,
// y no queremos que eso reviente en tiempo de build.
let _sql = null;

export function getSql() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Falta DATABASE_URL');
    _sql = neon(url);
  }
  return _sql;
}
