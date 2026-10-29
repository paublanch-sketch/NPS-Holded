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
// 29/10/2026: la videollamada nace «esperando» y no cuenta hasta que están los dos dentro.
const duracionMs = x => x.esperando ? 0 : new Date(x.fin || ahora()) - new Date(x.inicio);
const horas = t => +((t.horas_previas || 0) + (t.sesiones || []).reduce((s, x) => s + duracionMs(x), 0) / 3600000).toFixed(2);

const activa = t => (t.sesiones || []).find(s => !s.fin);

function pararSesion(t) {
  const s = activa(t);
  if (!s) return;
  s.fin = ahora();
  // Videollamada en la que nunca estuvieron los dos: cero. Si Meet dice después que sí, contabilizarReuniones pone el rato real.
  if (s.esperando) { s.inicio = s.fin; delete s.esperando; }
}
// Ya están los dos en la videollamada: el tiempo cuenta desde «desde».
function juntar(s, desde) {
  Object.assign(s, { inicio: desde, juntos: true });
  delete s.esperando;
}

// Lo que ve el cliente: nada de horas, notas internas ni datos de otros.
// Lo que ve el cliente. El número de ticket es interno: no sale ni en el portal, ni en los
// correos, ni en WhatsApp, ni en el Meet (28/10/2026). Se le enseña el título de su incidencia.
const tituloCliente = t => t.asunto || t.tipo_incidencia || 'Tu incidencia';
const vistaCliente = t => ({
  titulo: tituloCliente(t), tipo: t.tipo_incidencia || '', empresa: t.cliente, contacto: t.contacto || '', estado: t.estado, tecnico: t.tecnico || require('./auth').TECNICO, entrada: t.entrada,
  mensajes: t.mensajes.filter(m => m.de !== 'nota'),
  pideValoracion: t.estado === 'Cerrado' && t.nps == null && !t.cierreAuto && !t.llamada,
  nps: t.nps,
  video: activa(t)?.tipo === 'video' ? t.video : null,
  citas: (t.citas || []).filter(c => ['prevista', 'pedida'].includes(c.estado) && c.origen !== 'ahora' && c.fin > ahora())
    .map(c => ({ inicio: c.inicio, fin: c.fin, enlace: c.enlace || null, pedida: c.estado === 'pedida' })),
  // Siempre se puede pedir videollamada: sin Google queda pedida y el equipo la confirma (28/10/2026).
  reservar: t.estado !== 'Cerrado',
});

const vistaTecnico = t => ({ ...t, horas: horas(t), activa: activa(t) || null });
// Para el panel tras una acción: con el servicio y el origen de la ficha, como en la lista.
const vistaPanel = async t => { const cli = require('./clientes'); return { ...vistaTecnico(t), ...cli.clasificar(t, await cli.fichas()) }; };

// Horas por día de trabajo, para repartirlas por periodo en las métricas: cada sesión del
// cronómetro en su fecha y las horas del Sheet en la fecha de cierre (o de entrada).
const trabajo = t => [
  ...(t.horas_previas ? [{ fecha: (t.cierre || t.entrada).slice(0, 10), horas: t.horas_previas, tecnico: t.tecnico }] : []),
  ...(t.sesiones || []).map(x => ({ fecha: x.inicio.slice(0, 10), horas: duracionMs(x) / 3600000, tecnico: x.tecnico || t.tecnico })),
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

// Avisos al equipo por correo (28/10/2026, «como Holded»): lo que el cliente escribe en el portal o
// por WhatsApp y lo que se le responde desde el panel llega también al correo del equipo, y
// respondiendo a ese correo la respuesta entra en el chat (correo.js). Un fallo solo va al log.
const avisosEquipo = [];
function avisarEquipo(t, evento, datos = {}) {
  for (const f of avisosEquipo) Promise.resolve().then(() => f(t, evento, datos)).catch(e => console.error(`Aviso al equipo ${evento} #${t.id}:`, e.message));
}

// "600 11 12 22" o "+34600111222" → "34600111222", el formato de WhatsApp.
const telefonoWa = s => {
  const d = String(s || '').replace(/\D/g, '');
  return /^[6-9]\d{8}$/.test(d) ? '34' + d : d;
};

// Guarda los archivos que vienen con un mensaje (correo) y los deja en el hilo del ticket.
async function adjuntar(t, lista = [], origen = 'correo', de = 'cliente') {
  for (const f of lista.slice(0, 5)) {
    try {
      const a = await adjuntos.guardar({ ticket: t.id, nombre: f.nombre, buffer: f.buffer, origen });
      t.mensajes.push({ de, texto: `Ha adjuntado «${a.nombre}»`, adjunto: a, fecha: ahora() });
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
// 29/10/2026: tras la nota, solo lo que llega en las 24 h siguientes es «qué mejorarías» (antes, los
// 7 días): pasado ese rato, lo que escribe el cliente es una consulta y va a una incidencia.
const MEJORA_H = 24;
const esperandoMejora = t => !!t.esperaMejora && (new Date() - new Date(t.esperaMejora)) / 36e5 < MEJORA_H;
const REABRIR_DIAS = 30; // la respuesta al correo de una incidencia cerrada la reabre hasta 30 días después

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
  const cerradaDeApp = x => x && x.origen !== 'Sheet' && !x.historico && x.estado === 'Cerrado';
  const diasCerrada = x => (new Date() - new Date(x.cierre)) / 864e5;
  const recienCerrado = x => cerradaDeApp(x) && diasCerrada(x) < NPS_DIAS;
  // 29/10/2026: lo que responde al correo de una incidencia cerrada, o lo que llega por WhatsApp (sin
  // hilos) tras una recién cerrada, es de esa incidencia y la reabre, como prometen los avisos de cierre.
  // Antes abría otra nueva.
  const respondida = cerradaDeApp(citado) && diasCerrada(citado) < REABRIR_DIAS ? citado : null;
  const cerrado = !t && (respondida || recientes.find(recienCerrado));
  if (cerrado && esperandoMejora(cerrado)) {
    cerrado.mejora = texto;
    cerrado.esperaMejora = false;
    cerrado.mensajes.push(msg);
    await store.guardar(cerrado);
    avisar(cerrado, 'gracias');
    return cerrado;
  }
  // Un número solo es la nota si se le pidió: no tras un cierre automático ni una llamada apuntada.
  if (cerrado && recienCerrado(cerrado) && cerrado.nps == null && !cerrado.cierreAuto && !cerrado.llamada && /^\s*(10|[0-9])\s*$/.test(texto)) {
    cerrado.nps = Number(texto);
    cerrado.esperaMejora = ahora(); // desde cuándo: vale MEJORA_H horas
    cerrado.mensajes.push(msg);
    await store.guardar(cerrado);
    avisar(cerrado, 'pideMejora');
    return cerrado;
  }
  if (!t && cerrado && (cerrado === respondida || r.canal === 'WhatsApp')) t = cerrado;
  if (t) {
    if (t.estado === 'Cerrado') {
      ACCIONES.reabrir(t);
      t.mensajes.push({ de: 'nota', autor: 'Sistema', texto: 'Reabierta: el cliente ha vuelto a escribir.', fecha: ahora() });
    }
    if (t.estado === 'Pendiente cliente') t.estado = 'En curso';
    if (r.buzon && !t.buzon) t.buzon = r.buzon;
    t.mensajes.push(msg);
    await adjuntar(t, r.adjuntos);
    await store.guardar(t);
    // Lo que entra por correo ya está en el buzón; lo de WhatsApp se le reenvía al equipo.
    if (r.canal !== 'Correo') avisarEquipo(t, 'mensaje', { texto });
    return t;
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
  if (r.canal !== 'Correo') avisarEquipo(t, 'nuevo', { texto });
  return t;
}

// Respuesta del equipo desde su correo a un aviso «[Soporte] …» (correo.js ya ha comprobado que es
// del equipo y de qué incidencia): entra en el chat como del técnico y le llega al cliente igual
// que una respuesta escrita en el panel.
async function respuestaEquipo(r) {
  const t = await porId(r.ticketId);
  if (!t || (r.idExterno && t.mensajes.some(m => m.idExterno === r.idExterno))) return null;
  const texto = String(r.texto || '').trim();
  if (!texto && !r.adjuntos?.length) return null;
  const tecnico = require('./auth').TECNICO;
  if (texto) {
    ACCIONES.mensaje(t, { texto, tecnico });
    Object.assign(t.mensajes.at(-1), { idExterno: r.idExterno, porCorreo: true });
  }
  await adjuntar(t, r.adjuntos, 'correo', 'tecnico');
  await store.guardar(t);
  if (texto) avisar(t, 'mensaje', { texto, tecnico });
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
// Limpieza de la bandeja (correo.js): archiva sin avisar a nadie, con el motivo, y lo deshace.
async function archivar(ids, motivo) {
  const hechos = [], todos = new Map((await store.todos()).map(t => [t.id, t]));
  for (const id of ids) {
    const t = todos.get(Number(id));
    if (!t || t.archivado) continue;
    pararSesion(t);
    t.archivado = `${motivo} (${ahora()})`;
    await store.guardar(t);
    hechos.push(t.id);
  }
  return hechos;
}
async function desarchivar(ids, motivo) {
  const hechos = [], todos = new Map((await store.todos()).map(t => [t.id, t]));
  for (const id of ids) {
    const t = todos.get(Number(id));
    if (!t || !String(t.archivado || '').startsWith(motivo)) continue;
    delete t.archivado;
    await store.guardar(t);
    hechos.push(t.id);
  }
  return hechos;
}
const ENTRADA_KEY = process.env.ENTRADA_KEY || '';

async function crear(b) {
  const texto = String(b.descripcion || '').trim();
  if (!b.empresa || !(b.email || b.telefono || b.llamada) || !texto) throw Object.assign(new Error('Faltan la empresa, el correo o la descripción'), { status: 400 });
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
  // Llamada de teléfono (28/10/2026): lo que ha durado y de qué se ha hablado. Cuenta como tiempo
  // dedicado y queda como nota interna del ticket.
  llamada(t, b) {
    const min = Math.round(Number(b.minutos));
    const texto = String(b.texto || '').trim().slice(0, 3000);
    if (!(min > 0 && min <= 600)) throw Object.assign(new Error('La llamada tiene que durar entre 1 y 600 minutos'), { status: 400 });
    if (!texto) throw Object.assign(new Error('Apunta de qué habéis hablado'), { status: 400 });
    const fin = new Date(), inicio = new Date(fin - min * 60000);
    const local = d => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    t.sesiones.push({ tipo: 'llamada', tecnico: b.tecnico, inicio: local(inicio), fin: local(fin) });
    t.mensajes.push({ de: 'nota', autor: b.tecnico, llamada: min, texto: `Llamada de ${min} min: ${texto}`, fecha: ahora() });
    if (!t.primera_respuesta) t.primera_respuesta = ahora();
    if (!t.tecnico) t.tecnico = b.tecnico || '';
    if (t.estado === 'Nuevo' || t.estado === 'Pendiente cliente') t.estado = 'En curso';
  },
  iniciar(t, b) {
    pararSesion(t);
    t.sesiones.push({ tipo: 'trabajo', tecnico: b.tecnico, inicio: ahora(), fin: null });
    if (!t.tecnico) t.tecnico = b.tecnico || '';
    if (t.estado === 'Nuevo' || t.estado === 'Pendiente cliente') t.estado = 'En curso';
  },
  parar(t) { pararSesion(t); },
  // «Ya estamos los dos»: cuando Meet no puede decir quién hay en la sala, el técnico pone en marcha el tiempo.
  juntos(t) {
    const s = activa(t);
    if (s?.tipo === 'video' && s.esperando) juntar(s, ahora());
  },
  video(t, b) {
    pararSesion(t);
    t.video = b.enlace;
    t.sesiones.push({ tipo: 'video', tecnico: b.tecnico, inicio: ahora(), fin: null, codigo: b.codigo || null, esperando: true });
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
  // La videollamada que pidió el cliente sin Google: ya tiene enlace de Meet y se le envía.
  confirmarCita(t, b) {
    // La de este ticket: PREVIOS la buscó en la lectura de antes de llamar a Google.
    b.cita = (t.citas || []).find(x => x.id === b.cita.id) || b.cita;
    Object.assign(b.cita, { estado: 'prevista' }, b.reunion);
    t.mensajes.push({ de: 'sistema', texto: `Videollamada de Google Meet confirmada para el ${cuando(b.cita.inicio)}.`, enlace: b.cita.enlace, fecha: ahora() });
    if (!t.primera_respuesta) t.primera_respuesta = ahora();
    if (!t.tecnico) t.tecnico = b.tecnico || '';
    if (t.estado === 'Nuevo') t.estado = 'En curso';
  },
  anularCita(t, b) {
    const c = (t.citas || []).find(x => x.id === Number(b.cita));
    if (!c || !['prevista', 'pedida'].includes(c.estado)) throw Object.assign(new Error('Esa videollamada ya no está prevista'), { status: 400 });
    c.estado = 'anulada';
    t.mensajes.push({ de: 'sistema', texto: `Se ha anulado la videollamada del ${cuando(c.inicio)}.`, fecha: ahora() });
  },
  pendiente(t) { pararSesion(t); t.estado = 'Pendiente cliente'; t.pendienteDesde = ahora(); },
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
  // Boletines o avisos que entraron por el correo: fuera de la bandeja, de clientes y de las
  // métricas, sin avisar a nadie. Se archiva, no se borra.
  descartar(t, b) { pararSesion(t); t.archivado = `No es una incidencia (${b.tecnico || 'panel'}, ${ahora()})`; },
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
  avisarEquipo(t, 'nuevo', { texto: t.descripcion });
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

  // Videollamada: el cliente elige día y hora. Con Google, del calendario de soporte y con su enlace
  // al momento; sin Google (o si falla), del horario laboral y queda pedida: el equipo la confirma.
  if (m[2] === '/huecos' && req.method === 'GET') {
    if (t.estado === 'Cerrado') return json(res, { activo: false, huecos: [] }), true;
    return json(res, { activo: true, minutos: google.resumen().minutosCita, huecos: (await huecosPara()).huecos }), true;
  }
  if (m[2] === '/reservar' && req.method === 'POST') {
    if (t.estado === 'Cerrado') return json(res, { error: 'Esta incidencia ya está cerrada.' }, 400), true;
    const prevista = (t.citas || []).find(c => ['prevista', 'pedida'].includes(c.estado) && c.origen !== 'ahora' && c.fin > ahora());
    if (prevista) return json(res, { error: `Ya tienes una videollamada el ${cuando(prevista.inicio)}.` }, 409), true;
    const { inicio } = await leerCuerpo(req);
    const { huecos, conAgenda } = await huecosPara();
    const libre = huecos.find(h => h.inicio === inicio);
    if (!libre) return json(res, { error: 'Ese hueco ya no está libre. Elige otro.' }, 409), true;
    let cita = null;
    if (conAgenda) {
      try { cita = await nuevaCita(t, { inicio: libre.inicio, minutos: google.resumen().minutosCita, tecnico: t.tecnico, origen: 'cliente' }); }
      catch (e) { console.error('Google (reservar):', e.message); }
    }
    // Google tarda: se vuelve a leer el ticket para no pisar lo que se haya escrito mientras.
    const f = await porId(t.id) || t;
    if (cita) {
      ACCIONES.cita(f, { cita });
      f.mensajes.push({ de: 'nota', autor: 'Sistema', texto: `El cliente ha reservado una videollamada para el ${cuando(cita.inicio)}.`, fecha: ahora() });
      await store.guardar(f);
      avisar(f, 'cita', { cita });
    } else {
      (f.citas ||= []).push({ id: Date.now(), inicio: libre.inicio, fin: libre.fin, estado: 'pedida', origen: 'cliente', tecnico: f.tecnico });
      f.mensajes.push({ de: 'sistema', texto: `Has pedido una videollamada para el ${cuando(libre.inicio)}. Te enviaremos el enlace de Google Meet en cuanto la confirmemos.`, fecha: ahora() });
      f.mensajes.push({ de: 'nota', autor: 'Sistema', texto: `El cliente pide una videollamada para el ${cuando(libre.inicio)}. Confírmala con el enlace de Meet.`, fecha: ahora() });
      await store.guardar(f);
    }
    return json(res, vistaCliente(f), 201), true;
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
    avisarEquipo(t, 'mensaje', { texto: `Ha adjuntado «${a.nombre}» (se ve en el panel).` });
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
      avisarEquipo(t, 'mensaje', { texto: texto.slice(0, 5000) });
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

// Citas que ya tenemos (de cualquier ticket), para no dar el mismo hueco dos veces.
async function citasOcupadas() {
  return (await store.todos()).flatMap(t => (t.citas || []).filter(c => ['prevista', 'pedida'].includes(c.estado) && c.fin > ahora()).map(c => [c.inicio, c.fin]));
}
async function huecosPara() {
  const ocupadoExtra = await citasOcupadas();
  if (google.disponible()) {
    try { return { huecos: await google.huecos({ ocupadoExtra }), conAgenda: true }; }
    catch (e) { console.error('Google (huecos):', e.message); }
  }
  return { huecos: await google.huecos({ sinCalendario: true, ocupadoExtra }), conAgenda: false };
}

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
  async confirmarCita(t, b) {
    const c = (t.citas || []).find(x => x.id === Number(b.cita) && x.estado === 'pedida');
    if (!c) throw errorUso('Esa videollamada ya no está pendiente de confirmar.');
    const pegado = String(b.enlace || '').trim();
    if (pegado) {
      if (!/^https:\/\/meet\.google\.com\/[a-z0-9-]+/i.test(pegado)) throw errorUso('Pega un enlace de Google Meet (https://meet.google.com/…).');
      b.reunion = { enlace: pegado, codigo: codigoMeet(pegado), eventoId: null };
    } else {
      if (!google.activo()) throw errorUso('Google no está conectado: crea la reunión en meet.new y pega aquí el enlace.');
      const r = await google.crearReunion({ titulo: tituloReunion(t), descripcion: descReunion(t), inicio: c.inicio, fin: c.fin, invitado: t.email || null });
      b.reunion = { enlace: r.enlace, codigo: r.codigo, eventoId: r.eventoId };
    }
    b.cita = c;
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
    for (const viejo of await store.todos()) {
      // Primero se pregunta a Meet (tarda) y luego se apunta en el ticket recién leído: así no se pisa
      // lo que haya entrado mientras (29/10/2026).
      const respuestas = [];
      for (const c of (viejo.citas || []).filter(x => x.estado === 'prevista' && x.codigo)) {
        // Las agendadas, a partir de su hora de fin; las de «ahora», cuando se ha parado el cronómetro.
        const sesion = (viejo.sesiones || []).find(x => x.codigo === c.codigo && !x.real);
        const listo = c.origen === 'ahora' ? sesion && sesion.fin : new Date(c.fin).getTime() + 10 * 60000 < ahoraMs;
        if (!listo) continue;
        try { respuestas.push({ id: c.id, r: await google.duracionReal(c.codigo, c.inicio) }); } catch (e) { console.error('Meet:', e.message); }
      }
      if (!respuestas.length) continue;
      const t = await porId(viejo.id);
      if (!t) continue;
      let cambio = false;
      for (const { id, r } of respuestas) {
        const c = (t.citas || []).find(x => x.id === id && x.estado === 'prevista');
        if (!c) continue;
        const sesion = (t.sesiones || []).find(x => x.codigo === c.codigo && !x.real);
        if (r) {
          if (sesion) Object.assign(sesion, { inicio: r.inicio, fin: r.fin, real: true });
          else if (r.minutos) t.sesiones.push({ tipo: 'video', tecnico: c.tecnico || t.tecnico, inicio: r.inicio, fin: r.fin, codigo: c.codigo, real: true });
          Object.assign(c, { estado: 'hecha', minutosReales: r.minutos });
          t.mensajes.push({ de: 'nota', autor: 'Meet', texto: r.minutos
            ? `Videollamada registrada por Google Meet: ${r.minutos} min con el cliente dentro (desde las ${r.inicio.slice(11, 16)}).`
            : `Google Meet dice que el cliente no entró en la videollamada del ${cuando(c.inicio)}: no cuenta tiempo.`, fecha: ahora() });
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
// 29/10/2026: los días cuentan desde que se puso en espera (pendienteDesde) o desde lo último que se
// escribió, lo que sea más tarde. Antes contaban solo desde el último mensaje, y un ticket viejo
// puesto hoy en espera se cerraba en la hora siguiente.
const ultimaActividad = t => [[...t.mensajes].reverse().find(m => m.de !== 'nota')?.fecha || t.entrada, t.pendienteDesde || ''].sort().pop();
async function cerrarInactivos() {
  const d = new Date(Date.now() - DIAS_INACTIVIDAD * 864e5);
  const limite = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  const enEspera = t => t && t.estado === 'Pendiente cliente' && !t.archivado && !t.ejemplo && !t.historico;
  for (const { id } of (await store.todos()).filter(enEspera)) {
    // Se vuelve a leer justo antes de tocarlo, por si el cliente acaba de escribir.
    const t = await porId(id);
    if (!enEspera(t)) continue;
    // En espera desde antes de apuntar la fecha: los días empiezan a contar ahora.
    if (!t.pendienteDesde) { t.pendienteDesde = ahora(); await store.guardar(t); continue; }
    if (ultimaActividad(t) > limite) continue;
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
    return json(res, await vistaPanel(t), 201), true;
  }
  // Videollamadas que piden los clientes sin Google: el panel avisa hasta que se confirman.
  if (req.method === 'GET' && ruta === '/api/citas/pedidas') {
    const l = (await store.todos()).filter(t => !t.archivado && t.estado !== 'Cerrado')
      .flatMap(t => (t.citas || []).filter(c => c.estado === 'pedida' && c.fin > ahora()).map(c => ({ id: c.id, ticket: t.id, cliente: t.cliente, titulo: tituloCliente(t), inicio: c.inicio })));
    return json(res, l.sort((a, b) => a.inicio.localeCompare(b.inicio))), true;
  }
  // Llamada apuntada desde la ficha del cliente sin incidencia abierta: se guarda como incidencia por
  // teléfono, resuelta en la llamada (o abierta, si queda algo pendiente), sin avisos al cliente.
  if (req.method === 'POST' && ruta === '/api/llamadas') {
    const b = quien(await leerCuerpo(req));
    const t = await crear({ ...b, canal: 'Teléfono', descripcion: b.texto, asunto: 'Llamada de teléfono', llamada: true });
    t.llamada = true;
    ACCIONES.llamada(t, b);
    if (!b.abierta) Object.assign(t, { estado: 'Cerrado', cierre: ahora() });
    await store.guardar(t);
    return json(res, await vistaPanel(t), 201), true;
  }
  const m = ruta.match(/^\/api\/tickets\/(\d+)\/(\w+)$/);
  // Videollamada en marcha: el cronómetro empieza cuando están los dos en la sala (28/10/2026; desde el
// 29/10 no cuenta nada hasta entonces, ni aunque el panel no esté mirando).
  if (m && req.method === 'GET' && m[2] === 'sala') {
    const t = await porId(m[1]);
    const s = t && activa(t);
    if (!s || s.tipo !== 'video' || !s.codigo || !google.activo()) return json(res, { personas: null }), true;
    let r;
    try { r = await google.sala(s.codigo); } catch (e) { return json(res, { personas: null, error: e.message }), true; }
    let f = t;
    // Hasta que Meet ve a los dos dentro, el tiempo no cuenta; desde entonces, cuenta desde que entró el segundo.
    if (s.esperando && r.juntosDesde) {
      // Se vuelve a leer: mientras Meet contestaba ha podido entrar un mensaje del cliente.
      f = await porId(m[1]) || t;
      const s2 = activa(f);
      if (s2?.codigo === s.codigo && s2.esperando) {
        juntar(s2, r.juntosDesde);
        await store.guardar(f);
      }
    }
    return json(res, { personas: r.personas, juntos: !!activa(f)?.juntos, ticket: await vistaPanel(f) }), true;
  }
  if (!m || req.method !== 'POST') return false;
  let t = await porId(m[1]);
  if (!t) return json(res, { error: 'Ticket no encontrado' }, 404), true;
  if (!ACCIONES[m[2]]) return json(res, { error: 'Acción desconocida' }, 400), true;
  const b = quien(await leerCuerpo(req));
  if (PREVIOS[m[2]]) {
    await PREVIOS[m[2]](t, b);
    // Google tarda: se vuelve a leer el ticket para no pisar lo que haya entrado mientras.
    t = await porId(m[1]) || t;
  }
  ACCIONES[m[2]](t, b);
  await store.guardar(t);
  avisar(t, m[2], b);
  // La respuesta del panel también va al correo del equipo, para tener ahí toda la conversación.
  if (m[2] === 'mensaje' && b.nota !== true && String(b.texto || '').trim()) avisarEquipo(t, 'respuesta', { texto: String(b.texto).trim(), tecnico: b.tecnico });
  return json(res, await vistaPanel(t)), true;
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

module.exports = { archivar, desarchivar, avisosEquipo, respuestaEquipo, tituloCliente, abrirDesdePortal, iniciarCierreAuto, cerrarInactivos, DIAS_INACTIVIDAD, importarHistorico, cuando, iniciarReuniones, contabilizarReuniones, porId, rutasPublicas, rutasConsola, paraDashboard, json, leerCuerpo, recibir, avisos, telefonoWa, ahora };
