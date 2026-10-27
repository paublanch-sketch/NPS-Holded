// Servicio Holded (Node 18+).
//   /            portal público: cualquiera abre una incidencia y la sigue en /t/<token>
//   /admin       panel interno con un único acceso de admin: bandeja, métricas y clientes
// Datos: tickets de la app (con el histórico del Sheet importado con importar.js) y
// fichas de clientes.
require('./entorno');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tickets = require('./tickets');
const canales = require('./canales');
const auth = require('./auth');
const clientes = require('./clientes');
const metricas = require('./metricas');
const ejemplo = require('./ejemplo');
const google = require('./google');

const PORT = process.env.PORT || 3000;
const { json, leerCuerpo } = tickets;

// Tickets con el servicio y el origen de la ficha de su cliente.
async function ticketsClasificados() {
  const [l, mapa] = await Promise.all([tickets.paraDashboard(), clientes.fichas()]);
  return l.map(t => ({ ...t, ...clientes.clasificar(t, mapa) }));
}

function filtros(url) {
  const hoy = new Date();
  const f = d => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const p = k => url.searchParams.get(k) || '';
  const valida = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
  return {
    desde: valida(p('desde')) ? p('desde') : f(new Date(hoy.getFullYear(), hoy.getMonth(), 1)),
    hasta: valida(p('hasta')) ? p('hasta') : f(hoy),
    tecnico: p('tecnico'),
  };
}

const pagina = (res, nombre) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  fs.createReadStream(path.join(__dirname, 'public', nombre)).pipe(res);
};
const redirigir = (res, a) => { res.writeHead(302, { Location: a }); res.end(); };

// Logos del portal y del panel (public/img).
const IMAGENES = { '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
function imagen(res, nombre) {
  const fichero = path.join(__dirname, 'public', 'img', nombre);
  if (!fs.existsSync(fichero)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': IMAGENES[path.extname(nombre)], 'Cache-Control': 'public, max-age=86400' });
  fs.createReadStream(fichero).pipe(res);
}

// «Continuar con Google», con un estado de un solo uso en cookie y una misma vuelta:
//   /admin/google/entrar    desde el login: entra al panel; si el calendario aún no está
//                           conectado, pide también sus permisos y lo deja conectado.
//   /admin/google/conectar  desde Canales (con sesión): conecta o cambia la cuenta del calendario.
const base = req => (process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`).replace(/\/+$/, '');
async function rutasGoogle(req, res, ruta, url, yo) {
  const vuelta = `${base(req)}/admin/google/vuelta`;
  const cookie = v => `g_estado=${v}; Path=/admin/google; HttpOnly; SameSite=Lax; Max-Age=${v ? 600 : 0}${vuelta.startsWith('https:') ? '; Secure' : ''}`;
  const alPanel = (motivo, hash = '#/canales') => redirigir(res, `/admin?google=${encodeURIComponent(motivo)}${hash}`);
  const alLogin = motivo => redirigir(res, `/admin/login?google=${encodeURIComponent(motivo)}`);
  if (ruta !== '/admin/google/vuelta') {
    const entrar = ruta === '/admin/google/entrar';
    if (!entrar && !yo) return redirigir(res, '/admin/login');
    if (!google.modoOAuth()) return entrar ? alLogin('sin-configurar') : alPanel('sin-configurar');
    const estado = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', cookie(`${estado}.${entrar ? 'e' : 'c'}`));
    return redirigir(res, google.urlConectar(vuelta, estado, { soloEntrar: entrar && google.activo(), hd: entrar ? auth.dominioGoogle() : '' }));
  }
  res.setHeader('Set-Cookie', cookie(''));
  const [, esperado, modo] = (req.headers.cookie || '').match(/(?:^|;\s*)g_estado=([a-f0-9]{32})\.([ec])/) || [];
  const volver = modo === 'c' ? alPanel : alLogin;
  const p = k => url.searchParams.get(k) || '';
  if (p('error')) return volver(p('error') === 'access_denied' ? 'cancelado' : p('error'));
  if (!esperado || p('state') !== esperado) return (yo ? alPanel : alLogin)('caducado');
  if (modo === 'c') {
    if (!yo) return redirigir(res, '/admin/login');
    try { await google.completarConexion(p('code'), vuelta); }
    catch (e) { return alPanel(e.message); }
    // Se comprueba ya, para que Canales diga «Conectado» o el error de verdad (p. ej., la API apagada).
    try { await google.probar(); return alPanel('ok'); }
    catch (e) { return alPanel(`Cuenta conectada, pero Google da este error: ${e.message}`); }
  }
  let r;
  try { r = await google.intercambiar(p('code'), vuelta); }
  catch (e) { return alLogin(e.message); }
  if (!auth.permitidoGoogle(r.email, r.hd)) return alLogin(`Con Google solo pueden entrar las cuentas de ${auth.textoGoogle()} (${r.email} no lo es). Si no tienes una, entra con el usuario y la contraseña.`);
  auth.abrirSesion(req, res);
  if (!google.conPermisoCalendario(r.d)) return alPanel('entrado', '');
  try { await google.guardarConexion(r.email, r.d); await google.probar(); return alPanel('entrado-calendario', ''); }
  catch (e) { return alPanel(`Has entrado, pero el calendario no ha quedado conectado: ${e.message}`); }
}

// Formularios del panel desde otra web: fuera (la cookie ya es SameSite=Lax; esto es el cinturón).
const otroOrigen = req => {
  const o = req.headers.origin;
  if (!o || req.method === 'GET') return false;
  try { return new URL(o).host !== req.headers.host; } catch { return true; }
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ruta = url.pathname.replace(/\/+$/, '') || '/';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    // ---- Público ----
    // Con la versión desplegada (Render pone RENDER_GIT_COMMIT), para saber si ya está lo último.
    if (ruta === '/salud') { res.writeHead(200); return res.end(`ok ${(process.env.RENDER_GIT_COMMIT || '').slice(0, 7)}`.trim()); }
    if (/^\/img\/[a-z0-9-]+\.(png|svg|webp)$/.test(ruta)) return imagen(res, ruta.slice(5));
    if (ruta === '/' || /^\/t\/[a-f0-9]{32}$/.test(ruta)) return pagina(res, 'portal.html');
    if (ruta === '/soporte') return redirigir(res, /^[a-f0-9]{32}$/.test(url.searchParams.get('t') || '') ? `/t/${url.searchParams.get('t')}` : '/');
    if (ruta === '/api/portal') {
      const c = canales.correo.resumen().correo;
      return json(res, {
        whatsapp: (process.env.WA_NUMERO_PUBLICO || '').replace(/\D/g, ''),
        email: process.env.SOPORTE_EMAIL || process.env.MAIL_USER || '',
        telefono: process.env.SOPORTE_TELEFONO || '',
        google: process.env.GOOGLE_RESENA_URL || '',
        horario: process.env.HORARIO_LABORAL || '09:00-18:00',
        avisosCorreo: !!(c.configurado && c.smtp),
      });
    }
    if (await canales.rutasWhatsApp(req, res, ruta, url)) return;
    if (await tickets.rutasPublicas(req, res, ruta)) return;

    // ---- Panel interno ----
    if (ruta === '/consola' || ruta === '/dashboard') return redirigir(res, '/admin');
    if (ruta === '/admin/login') return (await auth.usuarioDe(req)) ? redirigir(res, '/admin') : pagina(res, 'admin-login.html');
    if (otroOrigen(req)) return json(res, { error: 'Origen no permitido' }, 403);
    if (await auth.rutas(req, res, ruta, { json, leerCuerpo })) return;

    const yo = await auth.usuarioDe(req);
    if (['/admin/google/entrar', '/admin/google/conectar', '/admin/google/vuelta'].includes(ruta)) return rutasGoogle(req, res, ruta, url, yo);
    if (ruta === '/admin' || ruta.startsWith('/admin/')) return yo ? pagina(res, 'admin.html') : redirigir(res, '/admin/login');
    if (!ruta.startsWith('/api/')) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    if (!yo) return json(res, { error: 'Sesión caducada' }, 401);
    if (ruta === '/api/equipo') return json(res, auth.TECNICOS);

    if (ruta === '/api/resumen' || ruta === '/api/horas.csv') {
      const f = filtros(url);
      const todos = await ticketsClasificados();
      const r = metricas.resumen(todos, f);
      if (ruta === '/api/resumen') {
        // Clientes del Kit Digital activos (la lista importada) y cuántos no han abierto nunca incidencia.
        const conTickets = new Set(todos.filter(t => !t.interno).map(t => t.cliente));
        const kit = [...(await clientes.fichas()).values()].filter(c => c.kitDigital && !c.ejemplo);
        r.kitDigital = { activos: kit.length, sinTickets: kit.filter(c => !conTickets.has(c.nombre)).length };
        return json(res, r);
      }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="horas-${f.desde}-${f.hasta}.csv"` });
      return res.end(metricas.csvHoras(r));
    }
    if (await clientes.rutas(req, res, ruta, { json, leerCuerpo })) return;
    if (await ejemplo.rutas(req, res, ruta, { json, leerCuerpo })) return;
    if (await canales.correo.rutas(req, res, ruta, { json, leerCuerpo })) return;
    if (req.method === 'POST' && ruta === '/api/google/probar') {
      try { return json(res, { ...(await google.probar()), google: google.resumen() }); }
      catch (e) { return json(res, { error: e.message, google: google.resumen() }, 502); }
    }
    if (req.method === 'POST' && ruta === '/api/google/desconectar') {
      await google.desconectar();
      return json(res, { google: google.resumen() });
    }
    if (await tickets.rutasConsola(req, res, ruta, auth.TECNICOS)) return;
    json(res, { error: 'No encontrado' }, 404);
  } catch (e) {
    if (!e.status) console.error(e);
    json(res, { error: e.status ? e.message : 'Error interno' }, e.status || 500);
  }
}).listen(PORT, () => {
  console.log(`Servicio Holded en http://localhost:${PORT}`);
  canales.iniciar();
  clientes.aplicarUnaVez().catch(e => console.error('Fichas:', e.message)).then(() => ejemplo.vigilar());
  google.cargar().then(() => { tickets.iniciarReuniones(); google.vigilar(); });
});
