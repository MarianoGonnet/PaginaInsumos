/**
 * Script de datos iniciales.
 * Ejecutar UNA SOLA VEZ después de crear las tablas:
 *   node scripts/seed.js
 *
 * Requiere que .env esté completo con SUPABASE_URL y SUPABASE_SERVICE_KEY.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const SALT_ROUNDS = 12;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('ERROR: Completá SUPABASE_URL y SUPABASE_SERVICE_KEY en el archivo .env');
    process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Usuarios iniciales (mismos que estaban hardcodeados en el código original)
// CAMBIÁ las contraseñas antes de ejecutar si es necesario.
const USUARIOS_INICIALES = [
    { usuario: 'admin',  password: 'admin26', nombre: 'La Plata (Central)',  insumos_blancos: 10000, consumo_estimado_diario: 0,  es_admin: true  },
    { usuario: 'juan',   password: '123',     nombre: 'Laprida',             insumos_blancos: 200,   consumo_estimado_diario: 10, es_admin: false },
    { usuario: 'maria',  password: '456',     nombre: 'Olavarría',           insumos_blancos: 500,   consumo_estimado_diario: 25, es_admin: false },
    { usuario: 'jazmin', password: '789',     nombre: 'Cap.Sarmiento',       insumos_blancos: 200,   consumo_estimado_diario: 15, es_admin: false },
];

async function seed() {
    console.log('Iniciando seed...\n');

    for (const u of USUARIOS_INICIALES) {
        process.stdout.write(`Procesando "${u.usuario}"... `);
        const password_hash = await bcrypt.hash(u.password, SALT_ROUNDS);

        const { error } = await supabase.from('usuarios').insert({
            usuario: u.usuario,
            password_hash,
            nombre: u.nombre,
            insumos_blancos: u.insumos_blancos,
            bloqueado: false,
            consumo_estimado_diario: u.consumo_estimado_diario,
            es_admin: u.es_admin,
        });

        if (error) {
            if (error.code === '23505') {
                console.log('ya existe, omitido.');
            } else {
                console.error('ERROR:', error.message);
            }
        } else {
            console.log('OK');
        }
    }

    console.log('\nSeed completado.');
}

seed().catch(err => {
    console.error('Error fatal:', err.message);
    process.exit(1);
});
