# Sistema de Gestión de Insumos Municipales

## Descripción general

Web app de **gestión de insumos y mensajería interna entre municipios**, con un rol administrador centralizado. Desarrollada con Node.js + Express y persistencia en **Supabase (PostgreSQL)**. Deployada en **Vercel** (serverless).

---

## Tecnologías

| Capa | Tecnología |
|---|---|
| Runtime | Node.js |
| Framework | Express |
| Base de datos | Supabase (PostgreSQL) |
| Cliente DB | @supabase/supabase-js |
| Sesiones | express-session + connect-pg-simple (PostgreSQL) |
| Hashing | bcryptjs (salt rounds: 12) |
| Seguridad HTTP | helmet |
| Rate limiting | express-rate-limit |
| Deploy | Vercel (serverless) |
| Cron jobs | Vercel Cron Jobs |
| Frontend | HTML / CSS / JS vanilla (sin frameworks) |

---

## Estructura del proyecto

```
PAGINA-INSUMOS/
│
├─ public/
│   ├─ login.html        # Login de usuarios
│   ├─ panel.html        # Panel de municipios
│   ├─ admin.html        # Panel administrador
│   └─ styles.css        # Estilos generales
│
├─ scripts/
│   └─ seed.js           # Script de datos iniciales (ejecutar una sola vez)
│
├─ .env                  # Variables de entorno (no commitear — ver .env.example)
├─ .gitignore
├─ schema.sql            # Schema SQL para ejecutar en Supabase
├─ vercel.json           # Configuración de Vercel (builds, rutas, cron)
├─ server.js             # Backend principal
└─ package.json
```

---

## Configuración e instalación local

### 1. Instalar dependencias

```bash
npm install
```

### 2. Completar el archivo `.env`

```env
# Supabase — Dashboard → Settings → API
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=sb_secret_...       # Secret key (NO la publishable)

# Base de datos para sesiones — Transaction Pooler (puerto 6543)
# Supabase → Connect → Direct → Transaction pooler → URI
DATABASE_URL=postgresql://postgres.xxxx:[PASSWORD]@aws-x-xx-east-1.pooler.supabase.com:6543/postgres

# Sesiones — generar con: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
SESSION_SECRET=string_aleatorio_largo

# Cron — generar con: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CRON_SECRET=string_aleatorio

# Entorno
NODE_ENV=development     # Cambiar a "production" en producción
PORT=3000
SESSION_MAX_AGE_MS=28800000   # 8 horas en milisegundos
```

> **Importante:** Usar el **Transaction Pooler** (puerto 6543) para `DATABASE_URL`, no la conexión directa (5432). Vercel es serverless y no soporta conexiones persistentes.

### 3. Crear las tablas en Supabase

Ejecutar el contenido de `schema.sql` en el SQL Editor de Supabase (Dashboard → SQL Editor).

Esto crea las tablas `usuarios`, `mensajes` y `session`, activa RLS y crea los índices necesarios.

### 4. Cargar los datos iniciales

```bash
node scripts/seed.js
```

Inserta los usuarios iniciales con contraseñas hasheadas. Es idempotente: si un usuario ya existe, lo omite.

### 5. Iniciar el servidor

```bash
npm start
```

La app corre en `http://localhost:3000`.

---

## Deploy en Vercel

### Requisitos previos
- Repositorio en GitHub
- Proyecto en Supabase con las tablas creadas y el seed ejecutado

### Pasos

1. Importar el repositorio en [vercel.com](https://vercel.com) → New Project → Import Git Repository
2. Cargar todas las variables de entorno del `.env` en Vercel → Settings → Environment Variables
   - `NODE_ENV` debe ser `production`
   - `DATABASE_URL` debe usar el **Transaction Pooler** (puerto 6543) con la contraseña real
3. Deploy

Cada `git push` a `main` redeploya automáticamente.

### Cron job semanal

El descuento de consumo semanal se ejecuta automáticamente cada lunes a las 6:00 AM UTC via Vercel Cron Jobs (configurado en `vercel.json`). Vercel envía el header `Authorization: Bearer ${CRON_SECRET}` al endpoint `/api/cron/descuento-semanal`.

---

## Roles del sistema

### Administrador

* Crear municipios (usuario + contraseña autogenerada)
* Cambiar contraseña de cualquier usuario
* Editar nombre y consumo diario de municipios
* Actualizar stock manualmente
* Bloquear / desbloquear municipios
* Ver stock global con gráfico
* Ver todos los mensajes del sistema
* Ejecutar manualmente el descuento de consumo semanal

### Municipio (usuario)

* Login con usuario y contraseña
* Ver su stock actual
* Registrar recepción de insumos (por cajas de 750 unidades)
* Enviar mensajes a otros municipios
* Bandeja de entrada con contador de no leídos
* Historial completo de mensajes enviados y recibidos
* Marcar mensajes como leídos / no leídos

---

## Modelo de datos

### Tabla `usuarios`

| Columna | Tipo | Descripción |
|---|---|---|
| id | BIGSERIAL PK | ID numérico autoincremental |
| usuario | TEXT UNIQUE | Nombre de usuario (login) |
| password_hash | TEXT | Contraseña hasheada con bcrypt |
| nombre | TEXT UNIQUE | Nombre del municipio |
| insumos_blancos | INTEGER | Stock actual |
| bloqueado | BOOLEAN | Si el acceso está bloqueado |
| consumo_estimado_diario | INTEGER | Unidades que consume por día hábil |
| es_admin | BOOLEAN | Distingue admin de municipio |
| created_at | TIMESTAMPTZ | Fecha de creación |

### Tabla `mensajes`

| Columna | Tipo | Descripción |
|---|---|---|
| id | BIGSERIAL PK | ID numérico autoincremental |
| remitente_id | BIGINT FK | ID del usuario que envía |
| remitente_nombre | TEXT | Nombre del remitente (desnormalizado) |
| destinatario_id | BIGINT FK | ID del usuario que recibe |
| contenido | TEXT | Cuerpo del mensaje (máx. 2000 caracteres) |
| leido | BOOLEAN | Estado de lectura |
| created_at | TIMESTAMPTZ | Fecha de envío |

### Tabla `session`

Gestionada automáticamente por `connect-pg-simple`. Almacena las sesiones activas de Express en PostgreSQL para sobrevivir reinicios del servidor (crítico en entornos serverless).

---

## Seguridad

* Contraseñas hasheadas con **bcryptjs** (salt rounds 12) — nunca se almacenan en texto plano
* **Row Level Security (RLS)** activado en Supabase — bloquea acceso directo vía anon/publishable key
* El backend usa exclusivamente la **secret key** de Supabase (nunca la publishable)
* **helmet** activo con CSP personalizado (HSTS, X-Frame-Options, X-Content-Type-Options, etc.)
* **Rate limiting** en `/login`: máx. 10 intentos por IP cada 15 minutos
* Sesiones con `httpOnly: true`, `sameSite: strict`, `secure: true` en producción
* Respuesta genérica en login — no revela si el usuario existe o no
* Errores internos logueados en servidor; el cliente recibe solo mensajes genéricos
* `.env` excluido del repositorio vía `.gitignore`
* El admin no puede ser bloqueado ni eliminado desde la interfaz
* Endpoint de cron protegido con `CRON_SECRET`

---

## Proceso automático de consumo semanal

Cada lunes a las 6:00 AM UTC, Vercel Cron ejecuta `/api/cron/descuento-semanal`, que descuenta `consumo_estimado_diario × 5` del stock de cada municipio (equivalente a 5 días hábiles). El stock nunca baja de 0. También puede ejecutarse manualmente desde el panel de administración.

En desarrollo local el descuento corre via `setInterval` cada 7 días.

---

## Estado del proyecto

* Frontend: ✅ completo
* Backend con persistencia en Supabase: ✅
* Sesiones persistentes en PostgreSQL: ✅
* Seguridad del backend: ✅
* Deploy en Vercel: ✅ funcionando en `pagina-insumos.vercel.app`
* Cron job semanal: ✅ configurado en Vercel
