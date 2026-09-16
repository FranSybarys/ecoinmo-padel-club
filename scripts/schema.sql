-- ---------------------------------------------------------------
-- Campus Padel Club - esquema de seguimiento comercial
-- Fuente: Playtomic Third Party API (thirdparty.playtomic.io)
-- ---------------------------------------------------------------

-- Reserva a reserva. Es la tabla que permite calcular ocupacion.
-- Playtomic solo conserva 3 meses, asi que esta tabla ES el historico.
CREATE TABLE IF NOT EXISTS bookings (
  booking_id        TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  resource_id       TEXT,
  resource_name     TEXT,             -- nombre de la pista
  sport_id          TEXT,
  booking_type      TEXT,             -- REGULAR_BOOKING, OPEN_MATCH, CLASS...
  origin            TEXT,             -- PLAYTOMIC_MANAGER = directa; resto = marketplace
  start_at          TIMESTAMPTZ NOT NULL,
  end_at            TIMESTAMPTZ NOT NULL,
  duration_min      INTEGER,
  price_amount      NUMERIC(10,2),    -- "25 EUR" se parte en importe...
  price_currency    TEXT,             -- ...y divisa
  payment_status    TEXT,             -- PAID, UNPAID, REFUNDED...
  status            TEXT,             -- PENDING, IN_PROGRESS, FINISHED, CANCELED
  is_canceled       BOOLEAN DEFAULT FALSE,
  participants      INTEGER,
  owner_id          TEXT,
  raw               JSONB,            -- respuesta original, por si cambia el esquema
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bookings_start    ON bookings (start_at);
CREATE INDEX IF NOT EXISTS idx_bookings_resource ON bookings (resource_name);
CREATE INDEX IF NOT EXISTS idx_bookings_origin   ON bookings (origin);

-- Objetivos del ejercicio. Se cargan una vez y no los toca el cron.
CREATE TABLE IF NOT EXISTS targets (
  month       DATE PRIMARY KEY,       -- siempre dia 1
  target      NUMERIC(10,2) NOT NULL
);

-- Ajuste manual por mes: prevalece sobre lo calculado desde Playtomic.
-- Es el puente con el registro manual que ya existe en el dashboard.
CREATE TABLE IF NOT EXISTS manual_overrides (
  month        DATE PRIMARY KEY,
  amount       NUMERIC(10,2) NOT NULL,
  note         TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Capacidad instalada, para el denominador de la ocupacion.
CREATE TABLE IF NOT EXISTS courts (
  resource_id   TEXT PRIMARY KEY,
  resource_name TEXT,
  open_from     TIME NOT NULL DEFAULT '08:00',
  open_to       TIME NOT NULL DEFAULT '24:00',
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

-- Trazabilidad de cada ejecucion del cron.
CREATE TABLE IF NOT EXISTS sync_log (
  id          BIGSERIAL PRIMARY KEY,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  from_date   DATE,
  to_date     DATE,
  fetched     INTEGER DEFAULT 0,
  upserted    INTEGER DEFAULT 0,
  ok          BOOLEAN,
  error       TEXT
);

-- ---------------------------------------------------------------
-- Vistas de agregacion
-- ---------------------------------------------------------------

-- Facturacion mensual, separando directa de marketplace.
-- Se excluyen canceladas y no cobradas.
-- Canales por los que entra una reserva. Verificado contra datos reales
-- del club: el origen no es un binario manager/marketplace.
--   MANAGER, PLAYTOMIC_MANAGER -> la crea el club (mostrador, telefono)
--   APP_IOS, APP_ANDROID, WEB_* -> la crea el jugador desde Playtomic
CREATE OR REPLACE VIEW monthly_revenue AS
SELECT
  -- La zona se fija explicitamente: si no, el mes dependeria del
  -- TimeZone de la conexion y una reserva de las 00:30 podria caer
  -- en el mes anterior.
  date_trunc('month', start_at AT TIME ZONE 'Europe/Madrid')::date AS month,
  SUM(price_amount)                                           AS total,
  SUM(price_amount) FILTER (WHERE origin IN ('MANAGER','PLAYTOMIC_MANAGER'))     AS directa,
  SUM(price_amount) FILTER (WHERE origin NOT IN ('MANAGER','PLAYTOMIC_MANAGER')) AS marketplace,
  COUNT(*)                                                    AS reservas,
  COUNT(DISTINCT owner_id)                                    AS jugadores,
  -- Cobrado de verdad frente a lo solo comprometido.
  SUM(price_amount) FILTER (WHERE payment_status = 'PAID')    AS cobrado,
  SUM(price_amount) FILTER (WHERE payment_status IN ('PENDING','UNPAID')) AS pendiente_cobro
FROM bookings
WHERE NOT is_canceled
  -- VOID son reservas anuladas sin cargo: no son facturacion.
  AND payment_status IN ('PAID', 'PARTIAL_PAID', 'PENDING', 'UNPAID')
GROUP BY 1;

-- Ocupacion por mes y franja horaria.
-- Una reserva de 90 min reparte sus minutos entre las franjas que toca:
-- 21:00-22:30 son 60 min en la franja de 21 y 30 min en la de 22.
CREATE OR REPLACE VIEW occupancy_by_slot AS
WITH franjas AS (
  SELECT
    gs AS franja,
    EXTRACT(epoch FROM (
      LEAST(b.end_at, gs + INTERVAL '1 hour') - GREATEST(b.start_at, gs)
    )) / 60.0 AS minutos
  FROM bookings b
  CROSS JOIN LATERAL generate_series(
    date_trunc('hour', b.start_at),
    b.end_at - INTERVAL '1 microsecond',
    INTERVAL '1 hour'
  ) AS gs
  WHERE NOT b.is_canceled
),
vendidas AS (
  SELECT
    date_trunc('month', franja AT TIME ZONE 'Europe/Madrid')::date AS month,
    EXTRACT(hour FROM franja AT TIME ZONE 'Europe/Madrid')::int    AS hora,
    SUM(minutos) / 60.0                                            AS horas
  FROM franjas
  GROUP BY 1, 2
),
-- Dias con actividad en cada mes: sirve de denominador y aguanta
-- meses incompletos y dias de cierre sin falsear la ocupacion.
dias_abiertos AS (
  SELECT
    date_trunc('month', start_at AT TIME ZONE 'Europe/Madrid')::date AS month,
    COUNT(DISTINCT (start_at AT TIME ZONE 'Europe/Madrid')::date)    AS dias
  FROM bookings
  WHERE NOT is_canceled
  GROUP BY 1
),
capacidad AS (
  SELECT COUNT(*)::int AS pistas FROM courts WHERE active
)
SELECT
  v.month,
  v.hora,
  ROUND(v.horas, 1)                                AS horas_vendidas,
  (c.pistas * d.dias)                              AS horas_disponibles,
  ROUND(100.0 * v.horas / NULLIF(c.pistas * d.dias, 0), 1) AS ocupacion_pct
FROM vendidas v
JOIN dias_abiertos d ON d.month = v.month
CROSS JOIN capacidad c;
