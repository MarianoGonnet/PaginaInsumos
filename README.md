# Sistema de Gestión de Insumos Municipales

## Descripción general

Web app de **gestión de insumos y mensajería interna entre municipios**, con un rol administrador centralizado. Desarrollada con Node.js + Express y persistencia en **Supabase (PostgreSQL)**.

---

## Tecnologías

| Capa | Tecnología |
|---|---|
| Runtime | Node.js |
| Framework | Express |
| Base de datos | Supabase (PostgreSQL) |
| ORM / cliente DB | @supabase/supabase-js |
| Autenticación | express-session |
| Hashing | bcryptjs (salt rounds: 12) |
| Seguridad HTTP | helmet |
| Rate limiting | express-rate-limit |
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
├─ .env                  # Variables de entorno (no commitear)
├─ .gitignore
├─ schema.sql            # Schema SQL para ejecutar en Supabase
├─ server.js             # Backend principal
├─ package.json
└─ node_modules/
```

---

## Configuración e instalación

### 1. Instalar dependencias

```bash
npm install
```

### 2. Completar el archivo `.env`

```env
SUPABASE_URL=          # Dashboard → Settings → API → Project URL
SUPABASE_SERVICE_KEY=  # Dashboard → Settings → API → service_role key
SESSION_SECRET=        # String aleatorio largo (mínimo 32 caracteres)
NODE_ENV=development   # Cambiar a "production" en producción
PORT=3000
SESSION_MAX_AGE_MS=28800000  # Duración de sesión en ms (default: 8 horas)
```

Para generar un `SESSION_SECRET` seguro:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 3. Crear las tablas en Supabase

Ejecutar el contenido de `schema.sql` en el SQL Editor de Supabase.

### 4. Cargar los datos iniciales

```bash
node scripts/seed.js
```

Este script inserta los usuarios iniciales con contraseñas hasheadas. Es idempotente: si un usuario ya existe, lo omite.

### 5. Iniciar el servidor

```bash
npm start
```

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
| contenido | TEXT | Cuerpo del mensaje |
| leido | BOOLEAN | Estado de lectura |
| created_at | TIMESTAMPTZ | Fecha de envío |

---

## Seguridad

* Contraseñas hasheadas con **bcryptjs** (salt rounds 12) — nunca se almacenan en texto plano
* **Row Level Security (RLS)** activado en Supabase — bloquea acceso directo vía anon key
* El backend usa exclusivamente la **service_role key** (nunca la anon key)
* **helmet** activo con CSP personalizado (HSTS, X-Frame-Options, X-Content-Type-Options, etc.)
* **Rate limiting** en `/login`: máx. 10 intentos por IP cada 15 minutos
* Sesiones con `httpOnly: true`, `sameSite: strict`, `secure: true` en producción
* Respuesta genérica en login — no revela si el usuario existe o no
* Errores internos logueados en servidor; el cliente recibe solo mensajes genéricos
* `.env` excluido del repositorio vía `.gitignore`
* El admin no puede ser bloqueado ni eliminado desde la interfaz

---

## Proceso automático de consumo semanal

Cada 7 días el servidor descuenta automáticamente `consumo_estimado_diario × 5` del stock de cada municipio (lunes a viernes). También puede ejecutarse manualmente desde el panel de administración. El stock nunca baja de 0.

---

## Estado del proyecto

* Frontend: ✅ completo
* Backend con persistencia en Supabase: ✅
* Seguridad del backend: ✅
* Deploy: ⏳ pendiente
