// Acceso al panel interno: un único usuario de administración (ADMIN_USUARIO y
// ADMIN_CLAVE) y una cookie de sesión firmada. Los clientes no tienen login: abren y
// siguen sus incidencias desde el portal con su enlace privado.
const crypto = require('crypto');

const COOKIE = 'sh_sesion';
const DURACION_DIAS = 30;
const USUARIO = String(process.env.ADMIN_USUARIO || 'admin').trim().toLowerCase();
const CLAVE = process.env.ADMIN_CLAVE || '';
const TECNICOS = (process.env.TECNICOS || 'Blanch,David,Pablo,Pako').split(',').map(s => s.trim()).filter(Boolean);

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
  res.setHeader('Set-Cookie', `${COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${segura ? '; Secure' : ''}`);
}

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
    const datos = Buffer.from(JSON.stringify({ h: HUELLA, exp: Date.now() + DURACION_DIAS * 864e5 })).toString('base64url');
    ponerCookie(req, res, `${datos}.${firmar(datos)}`, DURACION_DIAS * 86400);
    return json(res, { usuario: USUARIO }), true;
  }
  if (req.method === 'POST' && ruta === '/api/logout') {
    ponerCookie(req, res, '', 0);
    return json(res, { ok: true }), true;
  }
  return false;
}

module.exports = { usuarioDe, rutas, TECNICOS };
