# Campus Pádel Club — Dashboard de objetivos y ocupación

Dashboard de Objetivos y Retribución Variable de Campus PADEL en DP1, PTS de Granada.
Propiedad de ECOINMO Investments.

## Estructura

```
index.html            Dashboard (estático, protegido por contraseña)
api/
  metrics.js          Agregados para el dashboard (GET)
  sync.js             Objetivo del cron: descarga de Playtomic (GET, protegido)
  override.js         Registro manual de facturación (POST/DELETE)
lib/
  db.mjs              Cliente Neon con inicialización perezosa
  playtomic.mjs       Cliente de la Playtomic Third Party API (OAuth)
  sync.mjs            Descarga + upsert en Postgres
scripts/
  schema.sql          Esquema y vistas de agregación
  init-db.mjs         Crea el esquema y carga los objetivos
  seed-demo.mjs       Datos simulados para probar sin credenciales
  sync-local.mjs      Sincronización manual desde local
```

## Local

```bash
npm install
npx serve . -l 4173          # solo el dashboard estático
npm run dev:api              # dashboard + funciones (vercel dev, puerto 4174)
```

## Base de datos

Neon Postgres, provisionado vía Vercel Marketplace (plan Free).

```bash
vercel env pull .env.local --yes
node --env-file=.env.local scripts/init-db.mjs      # esquema + objetivos
node --env-file=.env.local scripts/seed-demo.mjs    # datos de prueba
node --env-file=.env.local scripts/seed-demo.mjs --clean
```

## Playtomic

Requiere credenciales de la Third Party API (Client ID + Secret), que se
solicitan desde Playtomic Manager → Ajustes → Developer tools. Si la opción
no aparece, hay que pedirlas al gestor de cuenta: requiere plan Champion o
Master, y las cadenas pasan por soporte.

Variables de entorno (en Vercel, nunca en el repositorio):

| Variable | Para qué |
|---|---|
| `PLAYTOMIC_CLIENT_ID` | credencial de la API |
| `PLAYTOMIC_CLIENT_SECRET` | credencial de la API |
| `PLAYTOMIC_TENANT_ID` | identificador del club |
| `CRON_SECRET` | protege `/api/sync` |
| `DATABASE_URL` | la pone Neon automáticamente |

Playtomic **solo conserva 3 meses de histórico**: la tabla `bookings` es el
archivo real del ejercicio. El cron corre a diario (04:00) y hace upsert de
los últimos 35 días, para recoger cancelaciones y cambios de estado de pago.

## Acceso

El dashboard tiene una pantalla previa con contraseña. Para cambiarla,
genera el hash y sustituye `PASS_HASH` en `index.html`:

```bash
printf '%s' 'NUEVA_CLAVE' | shasum -a 256
```

Es una barrera de cliente: disuade accesos casuales, no protege frente a
quien inspeccione el código fuente.
