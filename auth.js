// Acceso al panel interno: un único usuario de administración (ADMIN_USUARIO y
// ADMIN_CLAVE) o «Continuar con Google» con una cuenta de ADMIN_GOOGLE (correos o
// dominios; por defecto, interactivos.net), y una cookie de sesión firmada. Los clientes
// entran al portal con su propia cuenta (cuentas.js).
const crypto = require('crypto');

const COOKIE = 'sh_sesion';
const DURACION_DIAS = 30;
const USUARIO = String(process.env.ADMIN_USUARIO || 'admin').trim().toLowerCase();
const CLAVE = process.env.ADMIN_CLAVE || '';
// 28/10/2026: hay un solo técnico; ya no se elige quién trabaja. Los tickets del antiguo formulario
// (Kit Digital 1) conservan el técnico que tenían.
const TECNICO = String(process.env.TECNICO || 'Pau Blanch').trim();
const TECNICOS = [TECNICO];

let SECRETO = process.env.SESSION_SECRET;
if (!SECRETO) {
  SECRETO = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET no definido: las sesiones se pierden en cada reinicio.');
}
if (!CLAVE) console.warn('ADMIN_CLAVE no definida: nadie puede entrar en /admin.');

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const iguales = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
// Huella de la contraseña dentro de la cookie: al cambiarla en Render, las sesiones caducan.
const HUELLA = sha(SECRETO + CLAVE).toString('hex').slice(0, 12);
const firmar = s => crypto.createHmac('sha256', SECRETO).update(s).digest('base64url');

function sesionValida(req) {
  const c = (req.headers.cookie || '').split(/;\s*/).find(x => x.startsWith(COOKIE + '='));
  if (!c || !CLAVE) return false;
  const [datos, firma] = c.slice(COOKIE.length + 1).split('.');
  if (!datos || !firma || firmar(datos) !== firma) return false;
  try {
    const s = JSON.parse(Buffer.from(datos, 'base64url').toString());
    return s.exp > Date.now() && s.h === HUELLA;
  } catch { return false; }
}

function ponerCookie(req, res, valor, maxAge) {
  const segura = req.headers['x-forwarded-proto'] === 'https' || /^https:/.test(process.env.PUBLIC_URL || '');
  // Se añade a las que ya lleve la respuesta (la vuelta de Google también borra la suya).
  const previas = [].concat(res.getHeader('Set-Cookie') || []);
  res.setHeader('Set-Cookie', [...previas, `${COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${segura ? '; Secure' : ''}`]);
}

function abrirSesion(req, res) {
  const datos = Buffer.from(JSON.stringify({ h: HUELLA, exp: Date.now() + DURACION_DIAS * 864e5 })).toString('base64url');
  ponerCookie(req, res, `${datos}.${firmar(datos)}`, DURACION_DIAS * 86400);
}

// Cuentas de Google que pueden entrar: correos exactos o dominios enteros. Para un dominio,
// la cuenta tiene que ser de su Google Workspace (Google lo dice en «hd»): una cuenta personal
// de Google creada con un correo @interactivos.net no vale.
const GOOGLE = (process.env.ADMIN_GOOGLE || 'interactivos.net').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const permitidoGoogle = (email, hd = '') => GOOGLE.some(p => p.includes('@') ? email === p : email.endsWith('@' + p) && hd.toLowerCase() === p);
// Si solo se admite un dominio, se le pide a Google que enseñe solo cuentas de ese dominio.
const dominioGoogle = () => { const d = GOOGLE.filter(p => !p.includes('@')); return d.length === 1 && d.length === GOOGLE.length ? d[0] : ''; };
const textoGoogle = () => GOOGLE.map(p => p.includes('@') ? p : '@' + p).join(', ');

// El panel no distingue personas: devuelve el admin si la sesión es buena.
async function usuarioDe(req) {
  return sesionValida(req) ? { usuario: USUARIO } : null;
}

// Límite de intentos de login por IP: 8 cada 15 minutos.
const intentos = new Map();
function limitar(ip) {
  const ahora = Date.now();
  const r = intentos.get(ip) || { n: 0, desde: ahora };
  if (ahora - r.desde > 15 * 60000) { r.n = 0; r.desde = ahora; }
  r.n++;
  intentos.set(ip, r);
  return r.n > 8;
}

async function rutas(req, res, ruta, { json, leerCuerpo }) {
  if (req.method === 'POST' && ruta === '/api/login') {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
    if (limitar(ip)) return json(res, { error: 'Demasiados intentos. Prueba de nuevo en unos minutos.' }, 429), true;
    const b = await leerCuerpo(req);
    const ok = CLAVE && iguales(String(b.usuario || '').trim().toLowerCase(), USUARIO) & iguales(b.clave || '', CLAVE);
    if (!ok) return json(res, { error: 'Usuario o contraseña incorrectos.' }, 401), true;
    intentos.delete(ip);
    abrirSesion(req, res);
    return json(res, { usuario: USUARIO }), true;
  }
  if (req.method === 'POST' && ruta === '/api/logout') {
    ponerCookie(req, res, '', 0);
    return json(res, { ok: true }), true;
  }
  return false;
}

module.exports = { usuarioDe, rutas, abrirSesion, permitidoGoogle, dominioGoogle, textoGoogle, TECNICO, TECNICOS };
