// Tickets de soporte Holded: portal del cliente (público, por token) y consola del técnico.
const crypto = require('crypto');
const { tickets: store } = require('./store');
const adjuntos = require('./adjuntos');
const google = require('./google');

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
// Lo que ve el cliente. El número de ticket es interno: no sale ni en el portal, ni en los
// correos, ni en WhatsApp, ni en el Meet (28/10/2026). Se le enseña el título de su incidencia.
const tituloCliente = t => t.asunto || t.tipo_incidencia || 'Tu incidencia';
const vistaCliente = t => ({
  titulo: tituloCliente(t), empresa: t.cliente, contacto: t.contacto || '', estado: t.estado, tecnico: t.tecnico, entrada: t.entrada,
  mensajes: t.mensajes.filter(m => m.de !== 'nota'),
  pideValoracion: t.estado === 'Cerrado' && t.nps == null && !t.cierreAuto,
  nps: t.nps,
  video: activa(t)?.tipo === 'video' ? t.video : null,
  citas: (t.citas || []).filter(c => c.estado === 'prevista' && c.origen !== 'ahora' && c.fin > ahora()).map(c => ({ inicio: c.inicio, fin: c.fin, enlace: c.enlace })),
  reservar: google.disponible() && t.estado !== 'Cerrado',
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

const cuando = iso => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })} a las ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
};

const NPS_DIAS = 7; // un número 0–10 hasta una semana después del cierre se toma como valoración

// Mensaje entrante de WhatsApp o correo: lo añade al ticket abierto de ese contacto,
// recoge la valoración si el ticket acaba de cerrarse, o abre uno nuevo.
async function recibir(r) {
  const todos = await store.todos();
  if (r.idExterno && todos.some(t => t.mensajes.some(m => m.idExterno === r.idExterno))) return null;
  const mismo = t => r.canal === 'WhatsApp'
    ? t.telefono && telefonoWa(t.telefono) === telefonoWa(r.telefono)
    : t.email && t.email.toLowerCase() === String(r.email).toLowerCase();
  const recientes = todos.filter(t => !t.archivado && mismo(t)).sort((a, b) => b.entrada.localeCompare(a.entrada));
  const texto = String(r.texto || '').trim().slice(0, 5000) || '(mensaje sin texto)';
  const msg = { de: 'cliente', texto, fecha: ahora(), idExterno: r.idExterno };

  const citado = r.ticketId && recientes.find(x => x.id === r.ticketId);
  let t = citado && citado.estado !== 'Cerrado' ? citado : recientes.find(x => x.estado !== 'Cerrado');
  // Los importados del Sheet nunca pidieron valoración: un número suyo no es un NPS.
  const recienCerrado = x => x && x.origen !== 'Sheet' && !x.historico && x.estado === 'Cerrado' && (new Date() - new Date(x.cierre)) / 864e5 < NPS_DIAS;
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
    if (r.buzon && !t.buzon) t.buzon = r.buzon;
    t.mensajes.push(msg);
    await adjuntar(t, r.adjuntos);
    return store.guardar(t);
  }
  t = await crear({
    canal: r.canal, empresa: r.nombre || r.email || r.telefono, contacto: r.nombre,
    email: r.email, telefono: r.telefono, tipo: 'Sin clasificar', descripcion: texto, asunto: r.asunto,
  });
  t.mensajes[0].idExterno = r.idExterno;
  // En qué buzón entró, para saber de dónde viene y responder desde ahí.
  if (r.buzon) t.buzon = r.buzon;
  await adjuntar(t, r.adjuntos);
  await store.guardar(t);
  avisar(t, 'nuevo');
  return t;
}

// Correos antiguos de un buzón («leer el historial»): tickets cerrados marcados «historico»,
// sin avisos al cliente y fuera de las métricas. Los del mismo remitente y asunto van juntos.
async function importarHistorico(r) {
  const todos = await store.todos();
  if (todos.some(t => t.mensajes.some(m => m.idExterno === r.idExterno))) return null;
  const tema = s => String(s || '').replace(/^((re|fw|fwd|rv)\s*:\s*)+/i, '').trim().toLowerCase();
  const texto = String(r.texto || '').trim().slice(0, 5000) || '(mensaje sin texto)';
  const fecha = r.fecha || ahora();
  const msg = { de: 'cliente', texto, fecha, idExterno: r.idExterno };
  let t = todos.find(x => x.historico && x.email === r.email && tema(x.asunto) === tema(r.asunto));
  if (t) {
    t.mensajes.push(msg);
    t.mensajes.sort((a, b) => a.fecha.localeCompare(b.fecha));
    if (fecha < t.entrada) t.entrada = t.primera_respuesta = fecha;
    if (fecha > t.cierre) t.cierre = fecha;
    await adjuntar(t, r.adjuntos);
    return store.guardar(t);
  }
  t = await crear({ canal: 'Correo', empresa: r.nombre || r.email, contacto: r.nombre, email: r.email, tipo: 'Sin clasificar', descripcion: texto, asunto: r.asunto });
  Object.assign(t, { historico: true, buzon: r.buzon, estado: 'Cerrado', entrada: fecha, cierre: fecha, primera_respuesta: fecha, mensajes: [msg] });
  await adjuntar(t, r.adjuntos);
  return store.guardar(t);
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
    t.video = b.enlace;
    t.sesiones.push({ tipo: 'video', tecnico: b.tecnico, inicio: ahora(), fin: null, codigo: b.codigo || null });
    // También como cita, para que Meet diga después cuánto duró de verdad.
    if (b.codigo) (t.citas ||= []).push({ id: Date.now(), inicio: ahora(), fin: ahora(), enlace: b.enlace, codigo: b.codigo, eventoId: b.eventoId || null, tecnico: b.tecnico, origen: 'ahora', estado: 'prevista' });
    t.mensajes.push({ de: 'sistema', texto: `${b.tecnico || 'El técnico'} te invita a una videollamada de Google Meet.`, enlace: t.video, fecha: ahora() });
    if (!t.primera_respuesta) t.primera_respuesta = ahora();
    if (!t.tecnico) t.tecnico = b.tecnico || '';
    t.estado = 'En curso';
  },
  cita(t, b) {
    (t.citas ||= []).push(b.cita);
    const quien = b.cita.origen === 'cliente' ? 'Has reservado' : `${b.tecnico || 'El técnico'} te ha agendado`;
    t.mensajes.push({ de: 'sistema', texto: `${quien} una videollamada de Google Meet para el ${cuando(b.cita.inicio)}.`, enlace: b.cita.enlace, fecha: ahora() });
    if (b.cita.origen !== 'cliente' && !t.primera_respuesta) t.primera_respuesta = ahora();
    if (b.cita.origen !== 'cliente' && !t.tecnico) t.tecnico = b.tecnico || '';
    if (t.estado === 'Nuevo' && b.cita.origen !== 'cliente') t.estado = 'En curso';
  },
  anularCita(t, b) {
    const c = (t.citas || []).find(x => x.id === Number(b.cita));
    if (!c || c.estado !== 'prevista') throw Object.assign(new Error('Esa videollamada ya no está prevista'), { status: 400 });
    c.estado = 'anulada';
    t.mensajes.push({ de: 'sistema', texto: `Se ha anulado la videollamada del ${cuando(c.inicio)}.`, fecha: ahora() });
  },
  pendiente(t) { pararSesion(t); t.estado = 'Pendiente cliente'; },
  // El stand-by también se quita a mano: vuelve a En curso.
  reanudar(t) { if (t.estado === 'Pendiente cliente') t.estado = 'En curso'; },
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
  reabrir(t) { t.estado = 'En curso'; t.cierre = ''; delete t.cierreAuto; },
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
// Alta desde el portal, con los datos de la cuenta que ha entrado (cuentas.js).
async function abrirDesdePortal(b) {
  const t = await crear({ ...b, canal: 'Portal' });
  avisar(t, 'nuevo');
  return t;
}

async function rutasPublicas(req, res, ruta) {
  // Desde el 28/10/2026 el portal va con login: sin cuenta no se abren incidencias desde la web.
  if (req.method === 'POST' && ruta === '/api/soporte') return json(res, { error: 'Entra con tu cuenta para abrir una incidencia.', login: true }, 401), true;
  // Entrada automática desde otros sistemas (Make, Zapier...) con clave compartida.
  if (req.method === 'POST' && ruta === '/api/entrada') {
    if (!ENTRADA_KEY || req.headers['x-entrada-key'] !== ENTRADA_KEY) return json(res, { error: 'Clave no válida' }, 401), true;
    const t = await crear(await leerCuerpo(req));
    avisar(t, 'nuevo');
    return json(res, { id: t.id, enlace: `/t/${t.token}` }, 201), true;
  }
  const m = ruta.match(/^\/api\/soporte\/([a-f0-9]{32})(\/mensaje|\/nps|\/huecos|\/reservar|\/adjunto(?:\/(\d+))?)?$/);
  if (!m) return false;
  const t = await porToken(m[1]);
  if (!t) return json(res, { error: 'Ticket no encontrado' }, 404), true;
  // Si su empresa tiene cuenta en el portal, el enlace solo no basta: hay que entrar.
  if (!(await require('./cuentas').puedeVer(req, t))) return json(res, { error: 'Entra con tu cuenta para ver esta incidencia.', login: true }, 401), true;
  if (req.method === 'GET' && !m[2]) return json(res, vistaCliente(t)), true;

  // Videollamada: huecos libres del calendario de soporte y reserva de uno.
  if (m[2] === '/huecos' && req.method === 'GET') {
    if (!google.disponible() || t.estado === 'Cerrado') return json(res, { activo: false, huecos: [] }), true;
    // Si Google falla, al cliente solo se le dice que ahora no hay agenda; el detalle va a Canales.
    try { return json(res, { activo: true, minutos: google.resumen().minutosCita, huecos: await google.huecos() }), true; }
    catch (e) { console.error('Google (huecos):', e.message); return json(res, { error: 'Ahora no podemos mostrar la agenda.' }, 502), true; }
  }
  if (m[2] === '/reservar' && req.method === 'POST') {
    if (!google.disponible() || t.estado === 'Cerrado') return json(res, { error: 'Ahora no se pueden reservar videollamadas.' }, 400), true;
    const prevista = (t.citas || []).find(c => c.estado === 'prevista' && c.origen !== 'ahora' && c.fin > ahora());
    if (prevista) return json(res, { error: `Ya tienes una videollamada el ${cuando(prevista.inicio)}.` }, 409), true;
    const { inicio } = await leerCuerpo(req);
    const libre = (await google.huecos()).find(h => h.inicio === inicio);
    if (!libre) return json(res, { error: 'Ese hueco ya no está libre. Elige otro.' }, 409), true;
    const cita = await nuevaCita(t, { inicio: libre.inicio, minutos: google.resumen().minutosCita, tecnico: t.tecnico, origen: 'cliente' });
    ACCIONES.cita(t, { cita });
    t.mensajes.push({ de: 'nota', autor: 'Sistema', texto: `El cliente ha reservado una videollamada para el ${cuando(cita.inicio)}.`, fecha: ahora() });
    await store.guardar(t);
    avisar(t, 'cita', { cita });
    return json(res, vistaCliente(t), 201), true;
  }

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

// ---------- Google Meet ----------
const codigoMeet = url => (String(url).match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/) || [])[1] || null;
const errorUso = m => Object.assign(new Error(m), { status: 400 });
const tituloReunion = t => `Soporte Holded · ${t.cliente} · ${tituloCliente(t)}`;
const descReunion = t => `Incidencia: ${tituloCliente(t)}${process.env.PUBLIC_URL ? '\n' + process.env.PUBLIC_URL.replace(/\/$/, '') + '/t/' + t.token : ''}`;
const sumar = (isoLocal, min) => google.local(new Date(new Date(isoLocal).getTime() + min * 60000));

async function nuevaCita(t, { inicio, minutos, tecnico, origen }) {
  const r = await google.crearReunion({ titulo: tituloReunion(t), descripcion: descReunion(t), inicio, fin: sumar(inicio, minutos), invitado: t.email || null });
  return { id: Date.now(), inicio: r.inicio, fin: r.fin, enlace: r.enlace, codigo: r.codigo, eventoId: r.eventoId, tecnico, origen, estado: 'prevista' };
}

// Lo que necesita Google antes de tocar el ticket.
const PREVIOS = {
  async video(t, b) {
    const pegado = String(b.enlace || '').trim();
    if (pegado) {
      if (!/^https:\/\/meet\.google\.com\/[a-z0-9-]+/i.test(pegado)) throw errorUso('Pega un enlace de Google Meet (https://meet.google.com/…).');
      b.enlace = pegado;
      b.codigo = codigoMeet(pegado);
      return;
    }
    if (!google.activo()) throw errorUso('Google no está conectado: crea la reunión en meet.new y pega aquí el enlace.');
    const ahoraLocal = ahora();
    const r = await google.crearReunion({ titulo: tituloReunion(t), descripcion: descReunion(t), inicio: ahoraLocal, fin: sumar(ahoraLocal, 60), invitado: null });
    Object.assign(b, { enlace: r.enlace, codigo: r.codigo, eventoId: r.eventoId });
  },
  async cita(t, b) {
    if (!google.activo()) throw errorUso('Para agendar hace falta conectar Google (panel → Canales).');
    const inicio = String(b.inicio || '');
    const minutos = Math.round(Number(b.minutos) || 30);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(inicio) || new Date(inicio) < new Date()) throw errorUso('Elige una fecha y hora futuras.');
    if (minutos < 15 || minutos > 240) throw errorUso('La duración tiene que estar entre 15 y 240 minutos.');
    b.cita = await nuevaCita(t, { inicio: inicio.slice(0, 16) + ':00', minutos, tecnico: b.tecnico, origen: 'tecnico' });
  },
  async anularCita(t, b) {
    const c = (t.citas || []).find(x => x.id === Number(b.cita));
    if (c?.eventoId && google.activo()) await google.anularReunion(c.eventoId).catch(e => { if (e.status !== 404) throw e; });
  },
};

// Cada 10 minutos: a las reuniones de Meet ya pasadas se les apunta la duración real.
let contando = false;
async function contabilizarReuniones() {
  if (!google.activo() || contando) return;
  contando = true;
  try {
    const ahoraMs = Date.now();
    for (const t of await store.todos()) {
      let cambio = false;
      for (const c of (t.citas || []).filter(x => x.estado === 'prevista' && x.codigo)) {
        // Las agendadas, a partir de su hora de fin; las de «ahora», cuando se ha parado el cronómetro.
        const sesion = (t.sesiones || []).find(x => x.codigo === c.codigo && !x.real);
        const listo = c.origen === 'ahora' ? sesion && sesion.fin : new Date(c.fin).getTime() + 10 * 60000 < ahoraMs;
        if (!listo) continue;
        let r = null;
        try { r = await google.duracionReal(c.codigo, c.inicio); } catch (e) { console.error('Meet:', e.message); continue; }
        if (r) {
          if (sesion) Object.assign(sesion, { inicio: r.inicio, fin: r.fin, real: true });
          else t.sesiones.push({ tipo: 'video', tecnico: c.tecnico || t.tecnico, inicio: r.inicio, fin: r.fin, codigo: c.codigo, real: true });
          Object.assign(c, { estado: 'hecha', minutosReales: r.minutos });
          t.mensajes.push({ de: 'nota', autor: 'Meet', texto: `Videollamada registrada por Google Meet: ${r.minutos} min (de ${r.inicio.slice(11, 16)} a ${r.fin.slice(11, 16)}).`, fecha: ahora() });
          cambio = true;
        } else if (ahoraMs - new Date(c.origen === 'ahora' && sesion ? sesion.fin : c.fin).getTime() > 24 * 3600000) {
          c.estado = 'sin_datos';
          t.mensajes.push({ de: 'nota', autor: 'Meet', texto: `Google Meet no tiene registro de la videollamada del ${cuando(c.inicio)}. Se queda el tiempo del cronómetro; si no lo hubo, apúntalo a mano.`, fecha: ahora() });
          cambio = true;
        }
      }
      if (cambio) await store.guardar(t);
    }
  } finally { contando = false; }
}
// Stand-by (28/10/2026): una incidencia que espera al cliente se cierra sola a los 14 días sin
// noticias, con la etiqueta «Cierre automático por inactividad» y sin pedir valoración. Si el
// cliente vuelve a escribir, se reabre y la etiqueta se quita.
const DIAS_INACTIVIDAD = 14;
const ultimaActividad = t => [...t.mensajes].reverse().find(m => m.de !== 'nota')?.fecha || t.entrada;
async function cerrarInactivos() {
  const d = new Date(Date.now() - DIAS_INACTIVIDAD * 864e5);
  const limite = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  for (const t of await store.todos()) {
    if (t.estado !== 'Pendiente cliente' || t.archivado || t.ejemplo || t.historico || ultimaActividad(t) > limite) continue;
    pararSesion(t);
    Object.assign(t, { estado: 'Cerrado', cierre: ahora(), cierreAuto: true });
    t.mensajes.push({ de: 'sistema', texto: `Hemos cerrado tu incidencia porque llevaba ${DIAS_INACTIVIDAD} días esperando tu respuesta. Si aún lo necesitas, escríbenos aquí y la volvemos a abrir.`, fecha: ahora() });
    t.mensajes.push({ de: 'nota', autor: 'Sistema', texto: `Cierre automático por inactividad: ${DIAS_INACTIVIDAD} días en stand-by sin respuesta del cliente.`, fecha: ahora() });
    await store.guardar(t);
    avisar(t, 'cierreAuto', { dias: DIAS_INACTIVIDAD });
  }
}
function iniciarCierreAuto() {
  const vez = () => cerrarInactivos().catch(e => console.error('Cierre automático:', e.message));
  setTimeout(vez, 60000);
  setInterval(vez, 3600000);
}

function iniciarReuniones() {
  if (!google.activo()) return;
  setInterval(() => contabilizarReuniones().catch(e => console.error('Meet:', e.message)), 10 * 60000);
  console.log(`Google Meet: activo (organiza ${google.organizador()})`);
}

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
    // Con el servicio y el origen de la ficha del cliente: la bandeja ordena Premium primero.
    const cli = require('./clientes'), mapa = await cli.fichas();
    const l = (await store.todos()).filter(t => !t.archivado).map(t => ({ ...vistaTecnico(t), ...cli.clasificar(t, mapa) })).sort((a, b) => b.entrada.localeCompare(a.entrada));
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
  if (PREVIOS[m[2]]) await PREVIOS[m[2]](t, b);
  ACCIONES[m[2]](t, b);
  await store.guardar(t);
  avisar(t, m[2], b);
  return json(res, vistaTecnico(t)), true;
}

// Para las métricas: lo justo de cada ticket, sin mensajes.
async function paraDashboard() {
  // Ni archivados ni el historial de los buzones cuentan en las métricas.
  return (await store.todos()).filter(t => !t.archivado && !t.historico).map(t => ({
    id: t.id, origen: t.origen, cliente: t.cliente, tipo_incidencia: t.tipo_incidencia, tecnico: t.tecnico, estado: t.estado,
    entrada: t.entrada, cierre: t.cierre, primera_respuesta: t.primera_respuesta, horas: horas(t), trabajo: trabajo(t),
    nps: t.nps, mejora: t.mejora, servicio: t.servicio, tipo_cliente: t.tipo_cliente, canal: t.canal,
    interno: !!t.interno, contacto: t.contacto, titulo: tituloCliente(t),
  }));
}

module.exports = { tituloCliente, abrirDesdePortal, iniciarCierreAuto, cerrarInactivos, DIAS_INACTIVIDAD, importarHistorico, cuando, iniciarReuniones, contabilizarReuniones, porId, rutasPublicas, rutasConsola, paraDashboard, json, leerCuerpo, recibir, avisos, telefonoWa, ahora };
