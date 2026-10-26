// Servicio Holded (Node 18+).
//   /            portal público: cualquiera abre una incidencia y la sigue en /t/<token>
//   /admin       panel interno con un único acceso de admin: bandeja, métricas y clientes
// Datos: tickets de la app (con el histórico del Sheet importado con importar.js),
// fichas de clientes y, para la parte comercial, la API de Holded.
require('./entorno');
const http = require('http');
const fs = require('fs');
const path = require('path');
const tickets = require('./tickets');
const canales = require('./canales');
const auth = require('./auth');
const clientes = require('./clientes');
const metricas = require('./metricas');

const PORT = process.env.PORT || 3000;
const HOLDED_API_KEY = process.env.HOLDED_API_KEY || '';
const { json, leerCuerpo } = tickets;

// Presupuestos de Holded. En teoría status 1 = aceptado; el cobro sale de la factura enlazada.
// Se guardan 10 minutos para no gastar llamadas de la API en cada refresco del panel.
let cacheComercial = { hasta: 0, datos: null };
async function cargarComercial() {
  if (!HOLDED_API_KEY) {
    return { ejemplo: true, datos: JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'comercial-ejemplo.json'), 'utf8')) };
  }
  if (cacheComercial.hasta > Date.now()) return { ejemplo: false, datos: cacheComercial.datos };
  const h = { key: HOLDED_API_KEY };
  const base = 'https://api.holded.com/api/invoicing/v1/documents/';
  const [estimates, invoices] = await Promise.all([
    fetch(base + 'estimate', { headers: h }).then(r => r.json()),
    fetch(base + 'invoice', { headers: h }).then(r => r.json()),
  ]);
  const pagada = new Map(invoices.map(f => [f.id, f.paymentsPending === 0]));
  const datos = estimates.map(e => {
    let estado = 'Enviado';
    if (e.status === 1) estado = pagada.get(e.invoiceId) ? 'Pagado' : 'Firmado, pendiente de pago';
    if (e.status === 2) estado = 'Rechazado';
    return {
      cliente: e.contactName, documento: e.docNumber, tipo: e.tags?.includes('licencia') ? 'Licencia' : 'Presupuesto',
      importe: e.total, fecha: new Date(e.date * 1000).toISOString().slice(0, 10), estado,
    };
  });
  cacheComercial = { hasta: Date.now() + 10 * 60000, datos };
  return { ejemplo: false, datos };
}

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
    servicio: p('servicio'), tecnico: p('tecnico'), tipo_cliente: p('tipo_cliente'),
  };
}

const pagina = (res, nombre) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  fs.createReadStream(path.join(__dirname, 'public', nombre)).pipe(res);
};
const redirigir = (res, a) => { res.writeHead(302, { Location: a }); res.end(); };

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
    if (ruta === '/salud') { res.writeHead(200); return res.end('ok'); }
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
    if (ruta === '/admin' || ruta.startsWith('/admin/')) return yo ? pagina(res, 'admin.html') : redirigir(res, '/admin/login');
    if (!ruta.startsWith('/api/')) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    if (!yo) return json(res, { error: 'Sesión caducada' }, 401);
    if (ruta === '/api/equipo') return json(res, auth.TECNICOS);

    if (ruta === '/api/resumen' || ruta === '/api/horas.csv') {
      const f = filtros(url);
      const [t, c] = await Promise.all([ticketsClasificados(), cargarComercial()]);
      const r = metricas.resumen(t, f, c);
      if (ruta === '/api/resumen') return json(res, r);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="horas-${f.desde}-${f.hasta}.csv"` });
      return res.end(metricas.csvHoras(r));
    }
    if (await clientes.rutas(req, res, ruta, { json, leerCuerpo })) return;
    if (await canales.correo.rutas(req, res, ruta, { json, leerCuerpo })) return;
    if (await tickets.rutasConsola(req, res, ruta, auth.TECNICOS)) return;
    json(res, { error: 'No encontrado' }, 404);
  } catch (e) {
    if (!e.status) console.error(e);
    json(res, { error: e.status ? e.message : 'Error interno' }, e.status || 500);
  }
}).listen(PORT, () => {
  console.log(`Servicio Holded en http://localhost:${PORT}`);
  canales.iniciar();
});
