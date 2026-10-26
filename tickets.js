// Tickets de soporte Holded: portal del cliente (público, por token) y consola del técnico.
const crypto = require('crypto');
const { tickets: store } = require('./store');
const adjuntos = require('./adjuntos');

// Hora local sin zona, el mismo formato que las fechas del Sheet ("2026-10-26T15:04:05").
const ahora = () => {
  const d = new Date();
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
};

// Horas sumando las sesiones del cronómetro (la abierta cuenta hasta ahora) más las
// apuntadas a mano en el Sheet para los tickets importados.
const horas = t => +((t.horas_previas || 0) + (t.sesiones || []).reduce((s, x) => s + (new Date(x.fin || ahora()) - new Date(x.inicio)), 0) / 3600000).toFixed(2);

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

// Horas por día de trabajo, para repartirlas por periodo en las métricas: cada sesión del
// cronómetro en su fecha y las horas del Sheet en la fecha de cierre (o de entrada).
const trabajo = t => [
  ...(t.horas_previas ? [{ fecha: (t.cierre || t.entrada).slice(0, 10), horas: t.horas_previas, tecnico: t.tecnico }] : []),
  ...(t.sesiones || []).map(x => ({ fecha: x.inicio.slice(0, 10), horas: (new Date(x.fin || ahora()) - new Date(x.inicio)) / 3600000, tecnico: x.tecnico || t.tecnico })),
];

async function porToken(token) {
  return (await store.todos()).find(t => t.token === token);
}

async function porId(id) {
  return (await store.todos()).find(t => t.id === Number(id));
}

const CANALES = ['Portal', 'WhatsApp', 'Correo', 'Teléfono'];

// Funciones (ticket, evento, datos) que avisan al cliente por su canal; las registra canales.js.
// Un fallo de envío no tumba la petición: queda como nota interna en el ticket.
const avisos = [];
function avisar(t, evento, datos = {}) {
  for (const f of avisos) {
    Promise.resolve().then(() => f(t, evento, datos)).catch(async e => {
      console.error(`Aviso ${evento} #${t.id}:`, e.message);
      const actual = await porId(t.id);
      if (!actual) return;
      actual.mensajes.push({ de: 'nota', autor: 'Sistema', texto: `No se pudo avisar al cliente (${evento}): ${e.message}`, fecha: ahora() });
      await store.guardar(actual);
    });
  }
}

// "600 11 12 22" o "+34600111222" → "34600111222", el formato de WhatsApp.
const telefonoWa = s => {
  const d = String(s || '').replace(/\D/g, '');
  return /^[6-9]\d{8}$/.test(d) ? '34' + d : d;
};

// Guarda los archivos que vienen con un mensaje (correo) y los deja en el hilo del ticket.
async function adjuntar(t, lista = [], origen = 'correo') {
  for (const f of lista.slice(0, 5)) {
    try {
      const a = await adjuntos.guardar({ ticket: t.id, nombre: f.nombre, buffer: f.buffer, origen });
      t.mensajes.push({ de: 'cliente', texto: `Ha adjuntado «${a.nombre}»`, adjunto: a, fecha: ahora() });
    } catch (e) {
      t.mensajes.push({ de: 'nota', autor: 'Sistema', texto: `No se ha guardado el adjunto «${f.nombre}»: ${e.message}`, fecha: ahora() });
    }
  }
}

const NPS_DIAS = 7; // un número 0–10 hasta una semana después del cierre se toma como valoración

// Mensaje entrante de WhatsApp o correo: lo añade al ticket abierto de ese contacto,
// recoge la valoración si el ticket acaba de cerrarse, o abre uno nuevo.
async function recibir(r) {
  const todos = await store.todos();
  if (r.idExterno && todos.some(t => t.mensajes.some(m => m.idExterno === r.idExterno))) return null;
  const mismo = t => r.canal === 'WhatsApp'
    ? t.telefono && telefonoWa(t.telefono) === telefonoWa(r.telefono)
    : t.email && t.email.toLowerCase() === String(r.email).toLowerCase();
  const recientes = todos.filter(mismo).sort((a, b) => b.entrada.localeCompare(a.entrada));
  const texto = String(r.texto || '').trim().slice(0, 5000) || '(mensaje sin texto)';
  const msg = { de: 'cliente', texto, fecha: ahora(), idExterno: r.idExterno };

  const citado = r.ticketId && recientes.find(x => x.id === r.ticketId);
  let t = citado && citado.estado !== 'Cerrado' ? citado : recientes.find(x => x.estado !== 'Cerrado');
  // Los importados del Sheet nunca pidieron valoración: un número suyo no es un NPS.
  const recienCerrado = x => x && x.origen !== 'Sheet' && x.estado === 'Cerrado' && (new Date() - new Date(x.cierre)) / 864e5 < NPS_DIAS;
  const cerrado = !t && (recienCerrado(citado) ? citado : recientes.find(recienCerrado));
  if (cerrado && cerrado.esperaMejora) {
    cerrado.mejora = texto;
    cerrado.esperaMejora = false;
    cerrado.mensajes.push(msg);
    await store.guardar(cerrado);
    avisar(cerrado, 'gracias');
    return cerrado;
  }
  if (cerrado && cerrado.nps == null && /^\s*(10|[0-9])\s*$/.test(texto)) {
    cerrado.nps = Number(texto);
    cerrado.esperaMejora = true;
    cerrado.mensajes.push(msg);
    await store.guardar(cerrado);
    avisar(cerrado, 'pideMejora');
    return cerrado;
  }
  if (t) {
    if (t.estado === 'Cerrado') ACCIONES.reabrir(t);
    if (t.estado === 'Pendiente cliente') t.estado = 'En curso';
    t.mensajes.push(msg);
    await adjuntar(t, r.adjuntos);
    return store.guardar(t);
  }
  t = await crear({
    canal: r.canal, empresa: r.nombre || r.email || r.telefono, contacto: r.nombre,
    email: r.email, telefono: r.telefono, tipo: 'Sin clasificar', descripcion: texto, asunto: r.asunto,
  });
  t.mensajes[0].idExterno = r.idExterno;
  await adjuntar(t, r.adjuntos);
  await store.guardar(t);
  avisar(t, 'nuevo');
  return t;
}
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
    asunto: String(b.asunto || b.tipo || texto.split(/\r?\n/)[0]).trim().slice(0, 120),
    descripcion: texto.slice(0, 5000),
    servicio: 'Sin clasificar',
    tipo_cliente: 'Sin clasificar',
    canal: CANALES.includes(b.canal) ? b.canal : 'Portal',
    urgente: b.urgente === true,
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
  asignar(t, b) {
    t.tecnico = String(b.asignado ?? '').slice(0, 60);
    t.mensajes.push({ de: 'nota', autor: b.tecnico, texto: t.tecnico ? `Asignado a ${t.tecnico}` : 'Sin asignar', fecha: ahora() });
  },
  datos(t, b) {
    if (b.tipo_incidencia) t.tipo_incidencia = String(b.tipo_incidencia).slice(0, 80);
  },
  // Tiempo trabajado fuera del cronómetro (una llamada, un correo largo...).
  tiempo(t, b) {
    const min = Math.round(Number(b.minutos));
    if (!(min > 0 && min <= 600)) throw Object.assign(new Error('Entre 1 y 600 minutos'), { status: 400 });
    const fin = new Date();
    const inicio = new Date(fin - min * 60000);
    const local = d => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    t.sesiones.push({ tipo: 'manual', tecnico: b.tecnico, inicio: local(inicio), fin: local(fin) });
    t.mensajes.push({ de: 'nota', autor: b.tecnico, texto: `+${min} min apuntados a mano${b.motivo ? ': ' + String(b.motivo).slice(0, 200) : ''}`, fecha: ahora() });
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
  // Marca o quita la urgencia (el cliente la marca al abrir; el técnico puede corregirla).
  urgencia(t, b) { t.urgente = b.urgente === true; },
  pendiente(t) { pararSesion(t); t.estado = 'Pendiente cliente'; },
  cerrar(t, b) {
    ACCIONES.datos(t, b);
    pararSesion(t);
    if (Number(b.minutos) > 0) ACCIONES.tiempo(t, { tecnico: b.tecnico, minutos: b.minutos, motivo: 'al cerrar' });
    if (String(b.solucion || '').trim()) t.mensajes.push({ de: 'nota', autor: b.tecnico, texto: 'Solución: ' + String(b.solucion).trim().slice(0, 3000), fecha: ahora() });
    if (!t.tecnico) t.tecnico = b.tecnico || '';
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
// Estado que ve el cliente en «Tus incidencias».
const estadoCliente = e => ({ 'Nuevo': 'Abierta', 'En curso': 'En curso', 'Pendiente cliente': 'Te esperamos', 'Cerrado': 'Resuelta' }[e] || e);
const recuperaciones = new Map(); // IP → intentos de «envíame mis incidencias» en la última hora
const ipDe = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();

async function rutasPublicas(req, res, ruta) {
  if (req.method === 'POST' && ruta === '/api/soporte') {
    const b = await leerCuerpo(req);
    const t = await crear({ ...b, canal: 'Portal' });
    avisar(t, 'nuevo');
    return json(res, { token: t.token, id: t.id }, 201), true;
  }
  // Entrada automática desde otros sistemas (Make, Zapier...) con clave compartida.
  if (req.method === 'POST' && ruta === '/api/entrada') {
    if (!ENTRADA_KEY || req.headers['x-entrada-key'] !== ENTRADA_KEY) return json(res, { error: 'Clave no válida' }, 401), true;
    const t = await crear(await leerCuerpo(req));
    avisar(t, 'nuevo');
    return json(res, { id: t.id, enlace: `/t/${t.token}` }, 201), true;
  }
  // Estado de las incidencias que el navegador del cliente recuerda (solo las de sus enlaces).
  if (req.method === 'POST' && ruta === '/api/soporte/estado') {
    const pedidos = new Set((await leerCuerpo(req)).tokens?.filter(x => /^[a-f0-9]{32}$/.test(x)).slice(0, 40));
    const l = (await store.todos()).filter(t => pedidos.has(t.token)).map(t => ({
      token: t.token, id: t.id, titulo: t.asunto || t.tipo_incidencia, estado: estadoCliente(t.estado),
      fecha: t.entrada, actualizado: t.mensajes.at(-1)?.fecha || t.entrada,
    })).sort((a, b) => b.fecha.localeCompare(a.fecha));
    return json(res, l), true;
  }
  // «Envíame mis incidencias»: siempre responde lo mismo, haya o no tickets con ese correo.
  if (req.method === 'POST' && ruta === '/api/soporte/recuperar') {
    const ip = ipDe(req), ahoraMs = Date.now();
    const r = (recuperaciones.get(ip) || []).filter(x => ahoraMs - x < 3600000);
    if (r.length >= 5) return json(res, { error: 'Demasiadas peticiones. Prueba dentro de un rato.' }, 429), true;
    recuperaciones.set(ip, [...r, ahoraMs]);
    const email = String((await leerCuerpo(req)).email || '').trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && alRecuperar.fn) {
      const l = (await store.todos()).filter(t => t.email?.toLowerCase() === email && t.origen !== 'Sheet')
        .sort((a, b) => b.entrada.localeCompare(a.entrada)).slice(0, 15);
      if (l.length) alRecuperar.fn(email, l).catch(e => console.error('Recuperar:', e.message));
    }
    return json(res, { ok: true, correo: !!alRecuperar.fn }), true;
  }

  const m = ruta.match(/^\/api\/soporte\/([a-f0-9]{32})(\/mensaje|\/nps|\/adjunto(?:\/(\d+))?)?$/);
  if (!m) return false;
  const t = await porToken(m[1]);
  if (!t) return json(res, { error: 'Ticket no encontrado' }, 404), true;
  if (req.method === 'GET' && !m[2]) return json(res, vistaCliente(t)), true;

  // Adjuntos: el cliente sube archivos a su incidencia y puede volver a abrirlos.
  if (m[2]?.startsWith('/adjunto')) {
    if (req.method === 'GET' && m[3]) {
      const a = await adjuntos.adjuntos.uno(m[3]);
      if (!a || a.ticket !== t.id) return json(res, { error: 'No encontrado' }, 404), true;
      return adjuntos.servir(res, a), true;
    }
    if (req.method !== 'POST' || m[3]) return false;
    const nombre = decodeURIComponent(String(req.headers['x-nombre'] || 'archivo'));
    const a = await adjuntos.guardar({ ticket: t.id, nombre, buffer: await adjuntos.leerCrudo(req), origen: 'portal' });
    t.mensajes.push({ de: 'cliente', texto: `Ha adjuntado «${a.nombre}»`, adjunto: a, fecha: ahora() });
    if (t.estado === 'Pendiente cliente') t.estado = 'En curso';
    await store.guardar(t);
    return json(res, a, 201), true;
  }

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
    t.esperaMejora = false;
    await store.guardar(t);
  }
  return json(res, vistaCliente(t)), true;
}

// La pone canales.js si hay correo: envía al cliente los enlaces de sus incidencias.
const alRecuperar = { fn: null };

// Rutas de la consola (ya autenticadas).
async function rutasConsola(req, res, ruta, equipo) {
  // Con un solo acceso de admin, el técnico lo elige el panel; solo vale si es del equipo.
  const quien = b => ({ ...b, tecnico: equipo.includes(b.tecnico) ? b.tecnico : '', asignado: equipo.includes(b.asignado) ? b.asignado : '' });
  const ma = ruta.match(/^\/api\/adjuntos\/(\d+)$/);
  if (req.method === 'GET' && ma) {
    const a = await adjuntos.adjuntos.uno(ma[1]);
    if (!a) return json(res, { error: 'No encontrado' }, 404), true;
    return adjuntos.servir(res, a), true;
  }
  if (req.method === 'GET' && ruta === '/api/tickets') {
    const l = (await store.todos()).map(vistaTecnico).sort((a, b) => b.entrada.localeCompare(a.entrada));
    return json(res, l), true;
  }
  // Alta manual desde la consola: llamadas, WhatsApp o correos que llegan fuera del portal.
  if (req.method === 'POST' && ruta === '/api/tickets') {
    const b = quien(await leerCuerpo(req));
    const t = await crear(b);
    t.tecnico = b.tecnico || '';
    await store.guardar(t);
    avisar(t, 'nuevo');
    return json(res, vistaTecnico(t), 201), true;
  }
  const m = ruta.match(/^\/api\/tickets\/(\d+)\/(\w+)$/);
  if (!m || req.method !== 'POST') return false;
  const t = await porId(m[1]);
  if (!t) return json(res, { error: 'Ticket no encontrado' }, 404), true;
  if (!ACCIONES[m[2]]) return json(res, { error: 'Acción desconocida' }, 400), true;
  const b = quien(await leerCuerpo(req));
  ACCIONES[m[2]](t, b);
  await store.guardar(t);
  avisar(t, m[2], b);
  return json(res, vistaTecnico(t)), true;
}

// Para las métricas: lo justo de cada ticket, sin mensajes.
async function paraDashboard() {
  return (await store.todos()).map(t => ({
    id: t.id, origen: t.origen, cliente: t.cliente, tipo_incidencia: t.tipo_incidencia, tecnico: t.tecnico, estado: t.estado,
    entrada: t.entrada, cierre: t.cierre, primera_respuesta: t.primera_respuesta, horas: horas(t), trabajo: trabajo(t),
    nps: t.nps, mejora: t.mejora, servicio: t.servicio, tipo_cliente: t.tipo_cliente, canal: t.canal,
    interno: !!t.interno,
  }));
}

module.exports = { alRecuperar, porId, rutasPublicas, rutasConsola, paraDashboard, json, leerCuerpo, recibir, avisos, telefonoWa, ahora };
