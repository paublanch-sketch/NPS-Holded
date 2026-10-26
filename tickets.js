// Tickets de soporte Holded: portal del cliente (público, por token) y consola del técnico.
const crypto = require('crypto');
const store = require('./store');

// Hora local sin zona, el mismo formato que las fechas del Sheet ("2026-10-26T15:04:05").
const ahora = () => {
  const d = new Date();
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
};

// Horas sumando las sesiones del cronómetro; la que sigue abierta cuenta hasta ahora.
const horas = t => +((t.sesiones || []).reduce((s, x) => s + (new Date(x.fin || ahora()) - new Date(x.inicio)), 0) / 3600000).toFixed(2);

const activa = t => (t.sesiones || []).find(s => !s.fin);

function pararSesion(t) {
  const s = activa(t);
  if (s) s.fin = ahora();
}

// Lo que ve el cliente: nada de horas, notas internas ni datos de otros.
const vistaCliente = t => ({
  id: t.id, empresa: t.cliente, estado: t.estado, tecnico: t.tecnico, entrada: t.entrada,
  mensajes: t.mensajes.filter(m => m.de !== 'nota'),
  pideValoracion: t.estado === 'Cerrado' && t.nps == null,
  nps: t.nps,
  video: activa(t)?.tipo === 'video' ? t.video : null,
});

const vistaTecnico = t => ({ ...t, horas: horas(t), activa: activa(t) || null });

async function porToken(token) {
  return (await store.todos()).find(t => t.token === token);
}

async function porId(id) {
  return (await store.todos()).find(t => t.id === Number(id));
}

const CANALES = ['Portal', 'WhatsApp', 'Correo', 'Teléfono'];
const ENTRADA_KEY = process.env.ENTRADA_KEY || '';

async function crear(b) {
  const texto = String(b.descripcion || '').trim();
  if (!b.empresa || !(b.email || b.telefono) || !texto) throw Object.assign(new Error('Faltan la empresa, el correo o la descripción'), { status: 400 });
  const entrada = ahora();
  return store.guardar({
    token: crypto.randomBytes(16).toString('hex'),
    origen: 'App',
    cliente: String(b.empresa).trim().slice(0, 200),
    contacto: String(b.contacto || '').trim().slice(0, 200),
    email: String(b.email || '').trim().slice(0, 200),
    telefono: String(b.telefono || '').trim().slice(0, 40),
    tipo_incidencia: String(b.tipo || 'Duda de uso').slice(0, 80),
    descripcion: texto.slice(0, 5000),
    servicio: 'Sin clasificar',
    tipo_cliente: 'Sin clasificar',
    canal: CANALES.includes(b.canal) ? b.canal : 'Portal',
    estado: 'Nuevo',
    tecnico: '',
    entrada,
    primera_respuesta: '',
    cierre: '',
    sesiones: [],
    mensajes: [{ de: 'cliente', texto: texto.slice(0, 5000), fecha: entrada }],
    nps: null,
    mejora: '',
  });
}

const ACCIONES = {
  mensaje(t, b) {
    const texto = String(b.texto || '').trim();
    if (!texto) return;
    const nota = b.nota === true;
    t.mensajes.push({ de: nota ? 'nota' : 'tecnico', autor: b.tecnico, texto: texto.slice(0, 5000), fecha: ahora() });
    if (!nota && !t.primera_respuesta) t.primera_respuesta = ahora();
    if (!t.tecnico) t.tecnico = b.tecnico || '';
    if (!nota && t.estado === 'Nuevo') t.estado = 'En curso';
  },
  asignar(t, b) { t.tecnico = String(b.tecnico || ''); },
  datos(t, b) {
    for (const k of ['servicio', 'tipo_cliente', 'tipo_incidencia']) if (b[k]) t[k] = String(b[k]).slice(0, 80);
  },
  iniciar(t, b) {
    pararSesion(t);
    t.sesiones.push({ tipo: 'trabajo', tecnico: b.tecnico, inicio: ahora(), fin: null });
    if (!t.tecnico) t.tecnico = b.tecnico || '';
    if (t.estado === 'Nuevo' || t.estado === 'Pendiente cliente') t.estado = 'En curso';
  },
  parar(t) { pararSesion(t); },
  video(t, b) {
    pararSesion(t);
    t.video = `https://meet.jit.si/SoporteHolded-${t.token.slice(0, 10)}`;
    t.sesiones.push({ tipo: 'video', tecnico: b.tecnico, inicio: ahora(), fin: null });
    t.mensajes.push({ de: 'sistema', texto: `${b.tecnico || 'El técnico'} te invita a una videollamada.`, enlace: t.video, fecha: ahora() });
    if (!t.primera_respuesta) t.primera_respuesta = ahora();
    if (!t.tecnico) t.tecnico = b.tecnico || '';
    t.estado = 'En curso';
  },
  pendiente(t) { pararSesion(t); t.estado = 'Pendiente cliente'; },
  cerrar(t, b) {
    ACCIONES.datos(t, b);
    pararSesion(t);
    t.estado = 'Cerrado';
    t.cierre = ahora();
    t.mensajes.push({ de: 'sistema', texto: 'Hemos cerrado tu incidencia. ¿Nos ayudas con una valoración de 10 segundos?', fecha: ahora() });
  },
  reabrir(t) { t.estado = 'En curso'; t.cierre = ''; },
};

function leerCuerpo(req) {
  return new Promise((ok, ko) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e6) { ko(new Error('Demasiado grande')); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { ko(Object.assign(new Error('JSON no válido'), { status: 400 })); } });
  });
}

const json = (res, data, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

// Rutas públicas del portal. Devuelve true si ha atendido la petición.
async function rutasPublicas(req, res, ruta) {
  if (req.method === 'POST' && ruta === '/api/soporte') {
    const b = await leerCuerpo(req);
    const t = await crear({ ...b, canal: 'Portal' });
    return json(res, { token: t.token }, 201), true;
  }
  // Entrada automática para WhatsApp o correo (Make, Zapier, webhook de Meta...) con clave compartida.
  if (req.method === 'POST' && ruta === '/api/entrada') {
    if (!ENTRADA_KEY || req.headers['x-entrada-key'] !== ENTRADA_KEY) return json(res, { error: 'Clave no válida' }, 401), true;
    const t = await crear(await leerCuerpo(req));
    return json(res, { id: t.id, enlace: `/soporte?t=${t.token}` }, 201), true;
  }
  const m = ruta.match(/^\/api\/soporte\/([a-f0-9]{32})(\/mensaje|\/nps)?$/);
  if (!m) return false;
  const t = await porToken(m[1]);
  if (!t) return json(res, { error: 'Ticket no encontrado' }, 404), true;
  if (req.method === 'GET' && !m[2]) return json(res, vistaCliente(t)), true;
  const b = await leerCuerpo(req);
  if (m[2] === '/mensaje') {
    const texto = String(b.texto || '').trim();
    if (texto) {
      t.mensajes.push({ de: 'cliente', texto: texto.slice(0, 5000), fecha: ahora() });
      if (t.estado === 'Pendiente cliente') t.estado = 'En curso';
      if (t.estado === 'Cerrado') ACCIONES.reabrir(t);
      await store.guardar(t);
    }
  }
  if (m[2] === '/nps' && t.estado === 'Cerrado') {
    const n = Number(b.nps);
    if (Number.isInteger(n) && n >= 0 && n <= 10) t.nps = n;
    t.mejora = String(b.mejora || '').trim().slice(0, 2000);
    await store.guardar(t);
  }
  return json(res, vistaCliente(t)), true;
}

// Rutas de la consola (ya autenticadas).
async function rutasConsola(req, res, ruta) {
  if (req.method === 'GET' && ruta === '/api/tickets') {
    const l = (await store.todos()).map(vistaTecnico).sort((a, b) => b.entrada.localeCompare(a.entrada));
    return json(res, l), true;
  }
  // Alta manual desde la consola: llamadas, WhatsApp o correos que llegan fuera del portal.
  if (req.method === 'POST' && ruta === '/api/tickets') {
    const b = await leerCuerpo(req);
    const t = await crear(b);
    if (b.tecnico) ACCIONES.asignar(t, b);
    await store.guardar(t);
    return json(res, vistaTecnico(t), 201), true;
  }
  const m = ruta.match(/^\/api\/tickets\/(\d+)\/(\w+)$/);
  if (!m || req.method !== 'POST') return false;
  const t = await porId(m[1]);
  if (!t) return json(res, { error: 'Ticket no encontrado' }, 404), true;
  if (!ACCIONES[m[2]]) return json(res, { error: 'Acción desconocida' }, 400), true;
  ACCIONES[m[2]](t, await leerCuerpo(req));
  await store.guardar(t);
  return json(res, vistaTecnico(t)), true;
}

// Para el dashboard: mismos campos que las filas del Sheet.
async function paraDashboard() {
  return (await store.todos()).map(t => ({
    cliente: t.cliente, tipo_incidencia: t.tipo_incidencia, tecnico: t.tecnico, estado: t.estado,
    entrada: t.entrada, cierre: t.cierre, primera_respuesta: t.primera_respuesta, horas: horas(t),
    nps: t.nps, mejora: t.mejora, servicio: t.servicio, tipo_cliente: t.tipo_cliente, canal: t.canal,
  }));
}

module.exports = { rutasPublicas, rutasConsola, paraDashboard, json };
