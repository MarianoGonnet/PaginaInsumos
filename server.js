require('dotenv').config();

// ── Validación de variables de entorno al arrancar ────────────────────────────
const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SESSION_SECRET', 'DATABASE_URL', 'CRON_SECRET'];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        console.error(`FATAL: La variable de entorno "${key}" no está definida. El servidor no puede iniciar.`);
        process.exit(1);
    }
}

const path       = require('path');
const express    = require('express');
const session    = require('express-session');
const pgSession  = require('connect-pg-simple')(session);
const { Pool }   = require('pg');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const bcrypt     = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const SALT_ROUNDS = 12;

// ── Cliente Supabase con service_role (bypass RLS, solo en backend) ───────────
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── Pool PostgreSQL para sesiones (connect-pg-simple) ─────────────────────────
// Usa el Transaction Pooler de Supabase (puerto 6543) — obligatorio en serverless.
const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
});

const app = express();

// Necesario para que Express lea la IP real del cliente detrás del reverse proxy
// de Railway/Render/etc. Sin esto el rate limiter ve siempre la IP del proxy.
app.set('trust proxy', 1);

// ── Headers de seguridad HTTP (helmet) ───────────────────────────────────────
// CSP personalizado: el frontend usa scripts inline y Chart.js desde CDN.
// 'unsafe-inline' en script-src y style-src es necesario porque los HTML
// tienen bloques <script> y atributos style="..." que no podemos modificar.
// Todos los demás protocolos de helmet (HSTS, X-Frame-Options, etc.) quedan activos.
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc:    ["'self'"],
            scriptSrc:     ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
            // scriptSrcAttr controla onclick=, onchange=, etc. Helmet lo pone en 'none' por
            // defecto; necesita 'unsafe-inline' porque el frontend usa event handlers inline.
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc:      ["'self'", "'unsafe-inline'"],
            imgSrc:        ["'self'", "data:"],
            connectSrc:    ["'self'"],
            fontSrc:       ["'self'"],
            objectSrc:     ["'none'"],
            frameSrc:      ["'none'"],
        },
    },
}));

// ── Rate limiting: máx. 10 intentos de login por IP cada 15 minutos ──────────
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { message: 'Demasiados intentos de acceso. Intente nuevamente en 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Sesiones persistentes en Supabase (PostgreSQL) ───────────────────────────
const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE_MS) || 8 * 60 * 60 * 1000;
app.use(session({
    store: new pgSession({
        pool:                  pgPool,
        tableName:             'session',
        createTableIfMissing:  false,
        pruneSessionInterval:  60 * 15, // limpia sesiones expiradas cada 15 min
    }),
    secret:            process.env.SESSION_SECRET,
    resave:            false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge:   SESSION_MAX_AGE,
    },
}));

// ── Middlewares de autenticación ──────────────────────────────────────────────

function requireAuth(req, res, next) {
    if (req.session.userId) return next();
    res.status(401).json({ message: 'No autorizado. Por favor inicie sesión.' });
}

function requireAdmin(req, res, next) {
    if (req.session.userId && req.session.isAdmin) return next();
    res.status(403).json({ message: 'Acceso denegado.' });
}

// ── Helper: errores internos (nunca exponer stack traces al cliente) ──────────
function internalError(res, err) {
    console.error('[ERROR INTERNO]', err?.message || err);
    res.status(500).json({ message: 'Error interno del servidor.' });
}

// ── Helper: formato de fecha Argentina ───────────────────────────────────────
function formatFecha(isoString) {
    return new Date(isoString).toLocaleString('es-AR');
}

// ── RUTAS ─────────────────────────────────────────────────────────────────────

// El browser pide favicon.ico automáticamente; evitar el 404 en los logs
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.get('/', (_req, res) => res.redirect('/login.html'));

// POST /login
app.post('/login', loginLimiter, async (req, res) => {
    try {
        const usuario  = String(req.body.usuario  || '').trim().toLowerCase();
        const password = String(req.body.password || '').trim();

        if (!usuario || !password) {
            return res.status(400).json({ message: 'Usuario y contraseña son requeridos.' });
        }

        const { data: rows, error } = await supabase
            .from('usuarios')
            .select('id, password_hash, nombre, bloqueado, es_admin')
            .eq('usuario', usuario)
            .limit(1);

        if (error) return internalError(res, error);

        const user = rows?.[0];

        // Respuesta genérica para no revelar si el usuario existe (previene enumeración)
        const passwordValida = user && await bcrypt.compare(password, user.password_hash);
        if (!passwordValida) {
            return res.status(401).json({ message: 'Usuario o contraseña incorrectos.' });
        }

        if (user.bloqueado) {
            return res.status(403).json({ message: 'Su usuario ha sido bloqueado. Contacte a administración.' });
        }

        req.session.userId  = user.id;
        req.session.nombre  = user.nombre;
        req.session.isAdmin = user.es_admin;

        res.json({ message: 'Login exitoso', isAdmin: user.es_admin });
    } catch (err) {
        internalError(res, err);
    }
});

// GET /logout
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login.html'));
});

// GET /api/datos-usuario
app.get('/api/datos-usuario', requireAuth, async (req, res) => {
    try {
        const { data: user, error } = await supabase
            .from('usuarios')
            .select('id, nombre, insumos_blancos')
            .eq('id', req.session.userId)
            .single();

        if (error || !user) return res.status(404).json({ message: 'Usuario no encontrado.' });
        res.json(user);
    } catch (err) {
        internalError(res, err);
    }
});

// POST /api/recibir-insumos
app.post('/api/recibir-insumos', requireAuth, async (req, res) => {
    try {
        const cajasNum = parseInt(req.body.cajas);
        const CANTIDAD_POR_CAJA = 750;

        if (isNaN(cajasNum) || cajasNum < 1 || cajasNum > 10) {
            return res.status(400).json({ message: 'Cantidad de cajas inválida (debe ser entre 1 y 10).' });
        }

        const { data: user, error: fetchErr } = await supabase
            .from('usuarios')
            .select('insumos_blancos, nombre')
            .eq('id', req.session.userId)
            .eq('es_admin', false)
            .single();

        if (fetchErr || !user) return res.status(404).json({ message: 'Usuario no encontrado.' });

        const nuevoStock = user.insumos_blancos + cajasNum * CANTIDAD_POR_CAJA;

        const { error: updateErr } = await supabase
            .from('usuarios')
            .update({ insumos_blancos: nuevoStock })
            .eq('id', req.session.userId);

        if (updateErr) return internalError(res, updateErr);

        console.log(`[RECEPCIÓN] ${user.nombre}: +${cajasNum * CANTIDAD_POR_CAJA}. Nuevo total: ${nuevoStock}`);
        res.json({ message: 'Recepción registrada.', nuevo_total: nuevoStock });
    } catch (err) {
        internalError(res, err);
    }
});

// GET /api/admin/stock
app.get('/api/admin/stock', requireAdmin, async (_req, res) => {
    try {
        const { data, error } = await supabase
            .from('usuarios')
            .select('id, nombre, usuario, insumos_blancos, bloqueado, consumo_estimado_diario')
            .eq('es_admin', false)
            .order('nombre');

        if (error) return internalError(res, error);

        res.json(data.map(u => ({
            id:                      u.id,
            nombre:                  u.nombre,
            usuario:                 u.usuario,
            stock:                   u.insumos_blancos,
            bloqueado:               u.bloqueado,
            consumo_estimado_diario: u.consumo_estimado_diario,
        })));
    } catch (err) {
        internalError(res, err);
    }
});

// POST /api/admin/crear-usuario
app.post('/api/admin/crear-usuario', requireAdmin, async (req, res) => {
    try {
        const nombre       = String(req.body.nombre       || '').trim();
        const usuario      = String(req.body.usuario      || '').trim().toLowerCase();
        const stockRaw     = req.body.stock;
        const consumoRaw   = req.body.consumoDiario;

        if (!nombre || !usuario) {
            return res.status(400).json({ message: 'Faltan datos obligatorios.' });
        }

        const soloLetrasEspacios = /^[a-zA-ZáéíóúÁÉÍÓÚüÜñÑ\s.]+$/;
        const soloLetras         = /^[a-zA-Z]+$/;

        if (!soloLetrasEspacios.test(nombre)) {
            return res.status(400).json({ message: 'El nombre del municipio solo puede contener letras y espacios.' });
        }
        if (!soloLetras.test(usuario)) {
            return res.status(400).json({ message: 'El nombre de usuario solo puede contener letras.' });
        }

        // Verificar usuario duplicado
        const { data: usuarioDupe, error: e1 } = await supabase
            .from('usuarios')
            .select('id')
            .eq('usuario', usuario)
            .limit(1);

        if (e1) return internalError(res, e1);
        if (usuarioDupe?.length > 0) {
            return res.status(400).json({ message: 'El nombre de usuario ya existe.' });
        }

        // Verificar nombre de municipio duplicado (case-insensitive)
        const { data: nombreDupe, error: e2 } = await supabase
            .from('usuarios')
            .select('id')
            .ilike('nombre', nombre)
            .limit(1);

        if (e2) return internalError(res, e2);
        if (nombreDupe?.length > 0) {
            return res.status(400).json({ message: 'El nombre del municipio ya existe.' });
        }

        const insumos      = Math.max(0, parseInt(stockRaw)  || 0);
        const consumoDiario = parseInt(consumoRaw) || 0;

        if (consumoDiario < 0) {
            return res.status(400).json({ message: 'El consumo diario no puede ser negativo.' });
        }

        const nombreSanitizado = nombre.replace(/[^a-zA-Z]/g, '');
        const passwordPlain    = `${usuario}${nombreSanitizado.substring(0, 5)}`.toLowerCase();
        const passwordHash     = await bcrypt.hash(passwordPlain, SALT_ROUNDS);

        const { error: insertErr } = await supabase
            .from('usuarios')
            .insert({
                usuario,
                password_hash:           passwordHash,
                nombre,
                insumos_blancos:         insumos,
                bloqueado:               false,
                consumo_estimado_diario: consumoDiario,
                es_admin:                false,
            });

        if (insertErr) return internalError(res, insertErr);

        console.log(`[ADMIN] Usuario creado: ${usuario}`);
        res.json({ message: `Usuario creado exitosamente. Contraseña: ${passwordPlain}` });
    } catch (err) {
        internalError(res, err);
    }
});

// POST /api/admin/usuario/:id/toggle-bloqueo
app.post('/api/admin/usuario/:id/toggle-bloqueo', requireAdmin, async (req, res) => {
    try {
        const targetId = parseInt(req.params.id);
        if (isNaN(targetId)) return res.status(400).json({ message: 'ID inválido.' });

        const { data: user, error: fetchErr } = await supabase
            .from('usuarios')
            .select('bloqueado, usuario, es_admin')
            .eq('id', targetId)
            .single();

        if (fetchErr || !user) return res.status(404).json({ message: 'Usuario no encontrado.' });
        if (user.es_admin) return res.status(400).json({ message: 'No se puede bloquear al administrador.' });

        const nuevoBloqueado = !user.bloqueado;

        const { error: updateErr } = await supabase
            .from('usuarios')
            .update({ bloqueado: nuevoBloqueado })
            .eq('id', targetId);

        if (updateErr) return internalError(res, updateErr);

        const estado = nuevoBloqueado ? 'BLOQUEADO' : 'ACTIVADO';
        console.log(`[ADMIN] Usuario ${user.usuario} ahora está ${estado}`);
        res.json({ message: `Usuario ${estado}.`, bloqueado: nuevoBloqueado });
    } catch (err) {
        internalError(res, err);
    }
});

// DELETE /api/admin/usuario/:id
app.delete('/api/admin/usuario/:id', requireAdmin, async (req, res) => {
    try {
        const targetId = parseInt(req.params.id);
        if (isNaN(targetId)) return res.status(400).json({ message: 'ID inválido.' });

        const { data: user, error: fetchErr } = await supabase
            .from('usuarios')
            .select('usuario, es_admin')
            .eq('id', targetId)
            .single();

        if (fetchErr || !user) return res.status(404).json({ message: 'Usuario no encontrado.' });
        if (user.es_admin) return res.status(400).json({ message: 'No se puede eliminar al administrador.' });

        const { error: deleteErr } = await supabase
            .from('usuarios')
            .delete()
            .eq('id', targetId);

        if (deleteErr) return internalError(res, deleteErr);

        console.log(`[ADMIN] Usuario eliminado: ${user.usuario}`);
        res.json({ message: 'Usuario eliminado correctamente.' });
    } catch (err) {
        internalError(res, err);
    }
});

// POST /api/admin/usuario/:id/actualizar-stock
app.post('/api/admin/usuario/:id/actualizar-stock', requireAdmin, async (req, res) => {
    try {
        const targetId = parseInt(req.params.id);
        const stockNum = parseInt(req.body.nuevoStock);

        if (isNaN(targetId)) return res.status(400).json({ message: 'ID inválido.' });
        if (isNaN(stockNum) || stockNum < 0) return res.status(400).json({ message: 'Stock inválido.' });

        const { data: user, error: fetchErr } = await supabase
            .from('usuarios')
            .select('usuario')
            .eq('id', targetId)
            .single();

        if (fetchErr || !user) return res.status(404).json({ message: 'Usuario no encontrado.' });

        const { error: updateErr } = await supabase
            .from('usuarios')
            .update({ insumos_blancos: stockNum })
            .eq('id', targetId);

        if (updateErr) return internalError(res, updateErr);

        console.log(`[ADMIN] Stock de ${user.usuario} actualizado a: ${stockNum}`);
        res.json({ message: 'Stock actualizado correctamente.', nuevo_stock: stockNum });
    } catch (err) {
        internalError(res, err);
    }
});

// POST /api/admin/usuario/:id/cambiar-password
app.post('/api/admin/usuario/:id/cambiar-password', requireAdmin, async (req, res) => {
    try {
        const targetId       = parseInt(req.params.id);
        const nuevaPassword  = String(req.body.nuevaPassword || '').trim();

        if (isNaN(targetId))              return res.status(400).json({ message: 'ID inválido.' });
        if (!nuevaPassword)               return res.status(400).json({ message: 'La contraseña no puede estar vacía.' });
        if (nuevaPassword.length < 6)     return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres.' });

        const { data: user, error: fetchErr } = await supabase
            .from('usuarios')
            .select('usuario')
            .eq('id', targetId)
            .single();

        if (fetchErr || !user) return res.status(404).json({ message: 'Usuario no encontrado.' });

        const passwordHash = await bcrypt.hash(nuevaPassword, SALT_ROUNDS);

        const { error: updateErr } = await supabase
            .from('usuarios')
            .update({ password_hash: passwordHash })
            .eq('id', targetId);

        if (updateErr) return internalError(res, updateErr);

        console.log(`[ADMIN] Contraseña de ${user.usuario} actualizada.`);
        res.json({ message: 'Contraseña actualizada correctamente.' });
    } catch (err) {
        internalError(res, err);
    }
});

// POST /api/admin/usuario/:id/editar
app.post('/api/admin/usuario/:id/editar', requireAdmin, async (req, res) => {
    try {
        const targetId    = parseInt(req.params.id);
        const nuevoNombre = String(req.body.nuevoNombre || '').trim();
        const nuevoConsumo = parseInt(req.body.nuevoConsumo);

        if (isNaN(targetId))                      return res.status(400).json({ message: 'ID inválido.' });
        if (!nuevoNombre)                          return res.status(400).json({ message: 'El nombre no puede estar vacío.' });
        if (isNaN(nuevoConsumo) || nuevoConsumo < 0) {
            return res.status(400).json({ message: 'El consumo diario debe ser un número válido y no negativo.' });
        }

        // Verificar nombre duplicado excluyendo el propio usuario
        const { data: dupe, error: checkErr } = await supabase
            .from('usuarios')
            .select('id')
            .ilike('nombre', nuevoNombre)
            .neq('id', targetId)
            .limit(1);

        if (checkErr) return internalError(res, checkErr);
        if (dupe?.length > 0) return res.status(400).json({ message: 'El nombre del municipio ya existe.' });

        const { data: user, error: fetchErr } = await supabase
            .from('usuarios')
            .select('usuario')
            .eq('id', targetId)
            .single();

        if (fetchErr || !user) return res.status(404).json({ message: 'Usuario no encontrado.' });

        const { error: updateErr } = await supabase
            .from('usuarios')
            .update({ nombre: nuevoNombre, consumo_estimado_diario: nuevoConsumo })
            .eq('id', targetId);

        if (updateErr) return internalError(res, updateErr);

        console.log(`[ADMIN] Datos de ${user.usuario} actualizados.`);
        res.json({ message: 'Datos del municipio actualizados correctamente.' });
    } catch (err) {
        internalError(res, err);
    }
});

// POST /api/admin/ejecutar-descuento-semanal
app.post('/api/admin/ejecutar-descuento-semanal', requireAdmin, async (_req, res) => {
    try {
        await descontarConsumoSemanal();
        res.json({ message: 'Proceso de consumo semanal ejecutado con éxito.' });
    } catch (err) {
        internalError(res, err);
    }
});

// ── RUTAS DE MENSAJERÍA ───────────────────────────────────────────────────────

// GET /api/usuarios/lista
app.get('/api/usuarios/lista', requireAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('usuarios')
            .select('id, nombre')
            .eq('es_admin', false)
            .neq('id', req.session.userId)
            .order('nombre');

        if (error) return internalError(res, error);
        res.json(data);
    } catch (err) {
        internalError(res, err);
    }
});

// POST /api/mensajes/enviar
app.post('/api/mensajes/enviar', requireAuth, async (req, res) => {
    try {
        const destinatarioId = parseInt(req.body.destinatarioId);
        const contenido      = String(req.body.contenido || '').trim();

        if (isNaN(destinatarioId) || !contenido) {
            return res.status(400).json({ message: 'Faltan datos (destinatario o contenido).' });
        }
        if (contenido.length > 2000) {
            return res.status(400).json({ message: 'El mensaje no puede superar los 2000 caracteres.' });
        }
        if (destinatarioId === req.session.userId) {
            return res.status(400).json({ message: 'No podés enviarte un mensaje a vos mismo.' });
        }

        // Verificar que el destinatario exista y no sea admin
        const { data: dest, error: destErr } = await supabase
            .from('usuarios')
            .select('id, es_admin')
            .eq('id', destinatarioId)
            .single();

        if (destErr || !dest) return res.status(404).json({ message: 'Destinatario no encontrado.' });
        if (dest.es_admin) return res.status(400).json({ message: 'No se pueden enviar mensajes al administrador.' });

        const { error: insertErr } = await supabase
            .from('mensajes')
            .insert({
                remitente_id:     req.session.userId,
                remitente_nombre: req.session.nombre,
                destinatario_id:  destinatarioId,
                contenido,
            });

        if (insertErr) return internalError(res, insertErr);
        res.json({ message: 'Mensaje enviado correctamente.' });
    } catch (err) {
        internalError(res, err);
    }
});

// GET /api/mensajes/recibidos
app.get('/api/mensajes/recibidos', requireAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('mensajes')
            .select('id, remitente_id, remitente_nombre, destinatario_id, contenido, leido, created_at')
            .eq('destinatario_id', req.session.userId)
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) return internalError(res, error);

        res.json(data.map(m => ({
            id:              m.id,
            remitenteId:     m.remitente_id,
            remitenteNombre: m.remitente_nombre,
            destinatarioId:  m.destinatario_id,
            contenido:       m.contenido,
            leido:           m.leido,
            fecha:           formatFecha(m.created_at),
        })));
    } catch (err) {
        internalError(res, err);
    }
});

// GET /api/mensajes/no-leidos/contador
// IMPORTANTE: esta ruta debe ir ANTES de /api/mensajes/:id/toggle-leido
app.get('/api/mensajes/no-leidos/contador', requireAuth, async (req, res) => {
    try {
        const { count, error } = await supabase
            .from('mensajes')
            .select('*', { count: 'exact', head: true })
            .eq('destinatario_id', req.session.userId)
            .eq('leido', false);

        if (error) return internalError(res, error);
        res.json({ contador: count || 0 });
    } catch (err) {
        internalError(res, err);
    }
});

// GET /api/mensajes/historial
app.get('/api/mensajes/historial', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;

        const { data, error } = await supabase
            .from('mensajes')
            .select(`
                id,
                remitente_id,
                remitente_nombre,
                destinatario_id,
                contenido,
                leido,
                created_at,
                destinatario:destinatario_id (nombre)
            `)
            .or(`destinatario_id.eq.${userId},remitente_id.eq.${userId}`)
            .order('created_at', { ascending: false })
            .limit(200);

        if (error) return internalError(res, error);

        res.json(data.map(m => ({
            id:                m.id,
            remitenteId:       m.remitente_id,
            remitenteNombre:   m.remitente_nombre,
            destinatarioId:    m.destinatario_id,
            destinatarioNombre: m.destinatario?.nombre || 'Desconocido',
            contenido:         m.contenido,
            leido:             m.leido,
            fecha:             formatFecha(m.created_at),
        })));
    } catch (err) {
        internalError(res, err);
    }
});

// GET /api/admin/mensajes
app.get('/api/admin/mensajes', requireAdmin, async (_req, res) => {
    try {
        const { data, error } = await supabase
            .from('mensajes')
            .select(`
                id,
                remitente_nombre,
                contenido,
                created_at,
                destinatario:destinatario_id (nombre)
            `)
            .order('created_at', { ascending: false })
            .limit(300);

        if (error) return internalError(res, error);

        res.json(data.map(m => ({
            id:                m.id,
            remitenteNombre:   m.remitente_nombre,
            destinatarioNombre: m.destinatario?.nombre || 'Desconocido',
            contenido:         m.contenido,
            fecha:             formatFecha(m.created_at),
        })));
    } catch (err) {
        internalError(res, err);
    }
});

// POST /api/mensajes/:id/toggle-leido
app.post('/api/mensajes/:id/toggle-leido', requireAuth, async (req, res) => {
    try {
        const mensajeId = parseInt(req.params.id);
        if (isNaN(mensajeId)) return res.status(400).json({ message: 'ID de mensaje inválido.' });

        const { data: mensaje, error: fetchErr } = await supabase
            .from('mensajes')
            .select('leido, destinatario_id')
            .eq('id', mensajeId)
            .single();

        if (fetchErr || !mensaje) return res.status(404).json({ message: 'Mensaje no encontrado.' });

        // Solo el destinatario puede marcar su propio mensaje
        if (mensaje.destinatario_id !== req.session.userId) {
            return res.status(403).json({ message: 'Acción no permitida.' });
        }

        const { error: updateErr } = await supabase
            .from('mensajes')
            .update({ leido: !mensaje.leido })
            .eq('id', mensajeId);

        if (updateErr) return internalError(res, updateErr);
        res.json({ message: 'Estado del mensaje actualizado.' });
    } catch (err) {
        internalError(res, err);
    }
});

// ── PROCESO AUTOMÁTICO DE CONSUMO SEMANAL ────────────────────────────────────

async function descontarConsumoSemanal() {
    console.log(`[PROCESO AUTOMÁTICO] Descuento semanal iniciado: ${new Date().toLocaleString('es-AR')}`);

    const { data: municipios, error } = await supabase
        .from('usuarios')
        .select('id, nombre, insumos_blancos, consumo_estimado_diario')
        .eq('es_admin', false)
        .gt('consumo_estimado_diario', 0);

    if (error) {
        console.error('[PROCESO AUTOMÁTICO] Error al obtener municipios:', error.message);
        return;
    }

    // Todas las actualizaciones en paralelo (una sola ronda de red en vez de N secuenciales)
    await Promise.all(municipios.map(async (user) => {
        const consumoSemanal = user.consumo_estimado_diario * 5;
        const nuevoStock     = Math.max(0, user.insumos_blancos - consumoSemanal);

        const { error: updateErr } = await supabase
            .from('usuarios')
            .update({ insumos_blancos: nuevoStock })
            .eq('id', user.id);

        if (updateErr) {
            console.error(`[PROCESO AUTOMÁTICO] Error en ${user.nombre}:`, updateErr.message);
        } else {
            console.log(`[CONSUMO] ${user.nombre}: ${user.insumos_blancos} → ${nuevoStock} (-${consumoSemanal})`);
        }
    }));
}

// ── Endpoint para Vercel Cron (descuento semanal automático) ─────────────────
// Configurado en vercel.json para correr los lunes a las 6:00 AM UTC.
// Vercel envía automáticamente Authorization: Bearer ${CRON_SECRET}.
app.post('/api/cron/descuento-semanal', async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ message: 'No autorizado.' });
    }
    try {
        await descontarConsumoSemanal();
        res.json({ message: 'Descuento semanal ejecutado.' });
    } catch (err) {
        internalError(res, err);
    }
});

// En desarrollo local se mantiene el interval; en producción lo maneja Vercel Cron.
if (process.env.NODE_ENV !== 'production') {
    const UNA_SEMANA_EN_MS = 7 * 24 * 60 * 60 * 1000;
    setInterval(descontarConsumoSemanal, UNA_SEMANA_EN_MS);
}

// Export requerido para que Vercel importe el app como serverless function.
module.exports = app;

// En desarrollo local se levanta el servidor normalmente.
if (require.main === module) {
    const PORT = parseInt(process.env.PORT) || 3000;
    app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));
}
