-- ============================================================
--  SCHEMA – Sistema de Insumos Municipales
--  Ejecutar en: Supabase Dashboard → SQL Editor
-- ============================================================

-- ── Tabla de usuarios ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuarios (
    id                      BIGSERIAL   PRIMARY KEY,
    usuario                 TEXT        UNIQUE NOT NULL,
    password_hash           TEXT        NOT NULL,
    nombre                  TEXT        UNIQUE NOT NULL,
    insumos_blancos         INTEGER     NOT NULL DEFAULT 0,
    bloqueado               BOOLEAN     NOT NULL DEFAULT FALSE,
    consumo_estimado_diario INTEGER     NOT NULL DEFAULT 0,
    es_admin                BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Tabla de mensajes ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mensajes (
    id               BIGSERIAL   PRIMARY KEY,
    remitente_id     BIGINT      NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    remitente_nombre TEXT        NOT NULL,
    destinatario_id  BIGINT      NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    contenido        TEXT        NOT NULL,
    leido            BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Índices ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_mensajes_destinatario ON mensajes(destinatario_id);
CREATE INDEX IF NOT EXISTS idx_mensajes_remitente    ON mensajes(remitente_id);
CREATE INDEX IF NOT EXISTS idx_usuarios_usuario      ON usuarios(usuario);

-- ── Row Level Security ───────────────────────────────────────
-- El backend usa service_role (bypass RLS automático).
-- RLS activado como defensa en profundidad: bloquea acceso directo
-- via anon key o authenticated (si alguien consiguiera las credenciales del frontend).
ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE mensajes ENABLE ROW LEVEL SECURITY;

-- Sin políticas para anon/authenticated → acceso denegado por defecto.
-- service_role bypass RLS y tiene acceso total desde el backend.

-- ── Tabla de sesiones (connect-pg-simple) ────────────────────
-- Ejecutar DESPUÉS de crear las tablas anteriores.
-- No activar RLS: esta tabla es accedida via conexión directa PostgreSQL,
-- no via el cliente Supabase.
CREATE TABLE IF NOT EXISTS session (
    sid    VARCHAR      NOT NULL,
    sess   JSON         NOT NULL,
    expire TIMESTAMP(6) NOT NULL,
    CONSTRAINT session_pkey PRIMARY KEY (sid)
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON session (expire);
