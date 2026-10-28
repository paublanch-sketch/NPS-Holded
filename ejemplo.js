// Datos de ejemplo (20 clientes y cerca de 100 tickets, generados siempre igual) para que el panel enseñe colores y números mientras no hay clientes
// Premium ni de Implementación de verdad. Están SIEMPRE puestos: el servidor los crea al
// arrancar y cada día los rehace con fechas de esa semana, para que caigan en el periodo
// actual. Todo lo inventado lleva «ejemplo: true» (tickets y fichas de cliente) y se quita
// de golpe sin tocar nada real, con el botón de Canales → Datos de ejemplo o con
//   node ejemplo.js --quitar   (y «node ejemplo.js» para volver a ponerlos)
// Una vez quitados no vuelven solos: lo recuerda el ajuste «ejemplo».
// Los correos son @example.com y los de WhatsApp no llevan teléfono: un aviso no sale a nadie.
// Desde la línea de órdenes, el .env antes que store.js (que decide si usa Postgres).
if (require.main === module) require('./entorno');
const crypto = require('crypto');
const store = require('./store');

const CLIENTES = [
  // Premium · asesorías partner (las propias asesorías, con Premium gratis)
  ['Assessoria Montseny', 'Premium', 'Asesoría', 'Jordi Vidal'],
  ['Assessors Penedès', 'Premium', 'Asesoría', 'Núria Sala'],
  ['Assessoria Lleida Centre', 'Premium', 'Asesoría', 'Carme Bosch'],
  ['Assessoria Maresme', 'Premium', 'Asesoría', 'Albert Roig'],
  // Premium · clientes que nos ha traído una asesoría
  ['Perruqueria Nàiade', 'Premium', 'Referenciado por asesoría', 'Marta Albiol'],
  ['Construccions Vall SL', 'Premium', 'Referenciado por asesoría', 'Marc Puig'],
  ['Taller Mecànic Vic', 'Premium', 'Referenciado por asesoría', 'Eva Soler'],
  // Premium · directos
  ['Fusteria Roca SL', 'Premium', 'Directo', 'Pere Roca'],
  ['Clínica Dental Mar', 'Premium', 'Antiguo cliente AKIRA', 'Laura Mas'],
  ['Òptica Llum SL', 'Premium', 'Directo', 'Anna Riera'],
  ['Celler Mas Pujol', 'Premium', 'Directo', 'Joan Pujol'],
  // Implementación · referenciados por asesoría
  ['Talleres Ebre SL', 'Implementación', 'Referenciado por asesoría', 'Toni Ferré'],
  ['Café Nòmada', 'Implementación', 'Referenciado por asesoría', 'Irene Soler'],
  ['Bodega Can Rovira', 'Implementación', 'Referenciado por asesoría', 'Quim Rovira'],
  ['Forn Sant Jordi', 'Implementación', 'Referenciado por asesoría', 'Jordi Mir'],
  ['Hotel Cala Blava', 'Implementación', 'Referenciado por asesoría', 'Elena Font'],
  ['Pastisseria Oller', 'Implementación', 'Referenciado por asesoría', 'Rosa Oller'],
  // Implementación · directos
  ['Distribucions Garraf SL', 'Implementación', 'Directo', 'Sergi Pons'],
  ['Estudi Vela Arquitectes', 'Implementación', 'Directo', 'Clara Vela'],
  ['Logística Delta SL', 'Implementación', 'Directo', 'Pau Serra'],
  ['Tallers Nàutics Port', 'Implementación', 'Directo', 'Oriol Camps'],
];

// Lo que se pide por categoría, para que los textos cuadren con el tipo de incidencia.
const TEXTOS = {
  'Facturación y Verifactu': ['Una factura sale «Rechazada por Verifactu» con el código 1103.', 'Cambiar la serie de facturas rectificativas.', 'Añadir el IBAN al pie de las facturas.', 'El ticket de la tienda no lleva el QR de Verifactu.', 'Facturas recapitulativas mensuales por cliente.', 'Factura de anticipo de un proyecto.', 'Activar Verifactu en tres empresas de su cartera.'],
  'Contabilidad e impuestos': ['¿Cómo saco el modelo 303 del trimestre?', 'Cuadrar el IVA soportado del trimestre con el libro.', 'No me deja cerrar el ejercicio: dice que hay asientos descuadrados.', 'Asientos de amortización automáticos.', 'Exportar el libro de IVA para el modelo 390.', 'Plan de cuentas para las reservas y los anticipos.'],
  'Bancos y conciliación': ['El banco no sincroniza desde el viernes.', 'Conciliar los cobros con tarjeta del TPV.', 'Importar el extracto de La Caixa en Norma 43.', 'Duplicados al importar el extracto del Sabadell.', 'Reglas para los cobros por transferencia.', 'Conectar la cuenta de la pasarela de pago.'],
  'Acceso y usuarios': ['Dar de alta a una nueva administrativa con permisos de solo lectura.', 'La asesoría externa no puede entrar a la cuenta.', 'La recepcionista no puede ver las citas.', 'Usuario para la enóloga con acceso a inventario.'],
  'Equipo y fichajes': ['Los fichajes de ayer no aparecen en el informe.', 'Configurar los turnos de la vendimia.', 'Los conductores fichan desde el móvil y no se guarda la ubicación.'],
  'Formación': ['Formación de remesas y vencimientos para el equipo.', 'Sesión para montar los proyectos y las horas.', 'Formación de inventario y escandallos.', 'Formación de almacenes y pedidos de compra.', 'Sesión sobre cierres trimestrales en Holded.'],
};
const TIPOS = Object.keys(TEXTOS);
const CANALES = ['Portal', 'Correo', 'WhatsApp', 'Teléfono', 'Portal'];
const TECNICOS = ['Blanch', 'David', 'Pablo', 'Pako'];

// Cuántos casos tiene cada grupo. «tarde» = respondidos pasada la hora (fuera de SLA);
// «sinResponder» abren tiempo excedido. Las notas (NPS 0–10) dan la valoración media.
const GRUPOS = [
  { origenes: ['Asesoría'], servicio: 'Premium', abiertos: 3, abiertosTarde: 0, sinResponder: 0, cerrados: 14, cerradosTarde: 1, notas: [10, 10, 9, 10, 10, 9, 10, 8, 10, 10] },
  { origenes: ['Referenciado por asesoría'], servicio: 'Premium', abiertos: 3, abiertosTarde: 0, sinResponder: 0, cerrados: 12, cerradosTarde: 0, notas: [9, 10, 10, 9, 8, 10] },
  { origenes: ['Directo', 'Antiguo cliente AKIRA'], servicio: 'Premium', abiertos: 4, abiertosTarde: 0, sinResponder: 0, cerrados: 15, cerradosTarde: 0, notas: [9, 8, 10, 7, 9, 8, 9, 10] },
  // El único indicador en rojo: los casos fuera de SLA de los referenciados por asesoría.
  { origenes: ['Referenciado por asesoría'], servicio: 'Implementación', abiertos: 5, abiertosTarde: 1, sinResponder: 0, cerrados: 18, cerradosTarde: 1, notas: [9, 8, 9, 7, 9, 8, 9, 8] },
  { origenes: ['Directo'], servicio: 'Implementación', abiertos: 4, abiertosTarde: 0, sinResponder: 0, cerrados: 13, cerradosTarde: 1, notas: [9, 10, 8, 9, 10, 9, 8] },
];

// Aleatorio con semilla: los mismos datos cada vez que se generan.
function azar(semilla) {
  return () => { semilla = (semilla + 0x6D2B79F5) | 0; let t = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// [cliente, categoría, canal, estado, días laborables atrás, hora de entrada, minutos hasta la
//  primera respuesta (null: sin responder), días atrás del cierre, horas, NPS 0–10, técnico, texto]
function generar() {
  const r = azar(2026), de = l => l[Math.floor(r() * l.length)], entre = (a, b) => a + Math.floor(r() * (b - a + 1));
  const hora = (h0, h1) => { const m = entre(h0 * 4, h1 * 4) * 15; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  const l = [];
  let n = 0;
  for (const g of GRUPOS) {
    const clientes = CLIENTES.filter(c => c[1] === g.servicio && g.origenes.includes(c[2])).map(c => c[0]);
    const caso = (i, extra) => {
      const tipo = TIPOS[(n + i) % TIPOS.length], tec = TECNICOS[n % TECNICOS.length];
      n++;
      return [clientes[i % clientes.length], tipo, CANALES[n % CANALES.length], ...extra(tec), de(TEXTOS[tipo])];
    };
    // Sin responder: uno de esta mañana y otro de ayer por la tarde.
    for (let i = 0; i < g.sinResponder; i++) l.push(caso(i, tec => ['Nuevo', i, i ? '15:00' : '09:15', null, null, 0, null, tec]));
    for (let i = 0; i < g.abiertos - g.sinResponder; i++) {
      const tarde = i < g.abiertosTarde, dias = entre(0, 6);
      l.push(caso(i + 1, tec => [i % 3 === 2 ? 'Pendiente cliente' : 'En curso', dias, dias ? hora(9, 15) : hora(9, 9.5), tarde ? entre(70, 150) : entre(10, 50), null, Math.round(entre(1, 6)) / 2, null, tec]));
    }
    for (let i = 0; i < g.cerrados; i++) {
      const tarde = i < g.cerradosTarde, dias = entre(2, 18);
      l.push(caso(i + 2, tec => ['Cerrado', dias, hora(9, 15), tarde ? entre(70, 180) : entre(8, 55), Math.max(0, dias - entre(0, 2)), Math.round(entre(1, 10)) / 2, g.notas[i % g.notas.length], tec]));
    }
  }
  return l;
}
const TICKETS = generar();

const RESPUESTAS = ['Hola, lo miro ahora mismo y te digo algo.', 'Recibido. ¿Me pasas una captura del error?', 'Ya lo tengo localizado, dame unos minutos.', 'Hola, te llamo en un momento para verlo juntos.'];

const pad = n => String(n).padStart(2, '0');
const local = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const laborable = d => d.getDay() !== 0 && d.getDay() !== 6;

// Día laborable «n» hacia atrás. Antes de las 12 o en fin de semana, «hoy» es el último laborable
// anterior: así ninguna entrada ni respuesta queda en el futuro.
function diaAtras(n, ahora) {
  const d = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  if (!laborable(d) || ahora.getHours() < 12) do d.setDate(d.getDate() - 1); while (!laborable(d));
  for (let i = 0; i < n; i++) do d.setDate(d.getDate() - 1); while (!laborable(d));
  return d;
}
const a = (dia, hora) => { const [h, m] = hora.split(':').map(Number); const d = new Date(dia); d.setHours(h, m, 0, 0); return d; };
const mas = (d, min) => new Date(d.getTime() + min * 60000);

function ticket([cliente, tipo, canal, estado, dias, hora, resp, diasCierre, horas, nps, tecnico, texto], i, ahora) {
  const ficha = CLIENTES.find(c => c[0] === cliente);
  const entrada = a(diaAtras(dias, ahora), hora);
  const respuesta = resp == null ? null : mas(entrada, resp);
  const cierre = diasCierre == null ? null : a(diaAtras(diasCierre, ahora), '17:30');
  const mensajes = [{ de: 'cliente', texto, fecha: local(entrada) }];
  if (respuesta) mensajes.push({ de: 'tecnico', autor: tecnico, texto: RESPUESTAS[i % RESPUESTAS.length], fecha: local(respuesta) });
  if (estado === 'Pendiente cliente') mensajes.push({ de: 'tecnico', autor: tecnico, texto: 'Cuando lo pruebes, dime si ya te funciona.', fecha: local(mas(respuesta, 60)) });
  if (cierre) mensajes.push({ de: 'tecnico', autor: tecnico, texto: 'Solucionado. Cierro la incidencia; si vuelve a pasar, escríbenos.', fecha: local(cierre) });
  return {
    ejemplo: true,
    token: crypto.randomBytes(16).toString('hex'),
    origen: 'Ejemplo',
    interno: false,
    cliente,
    contacto: ficha[3],
    email: ficha[3].split(' ')[0].toLowerCase().normalize('NFD').replace(/[^a-z]/g, '') + '@example.com',
    telefono: '',
    tipo_incidencia: tipo,
    asunto: texto.slice(0, 60),
    descripcion: texto,
    servicio: ficha[1],
    tipo_cliente: ficha[2],
    canal,
    estado,
    tecnico,
    entrada: local(entrada),
    primera_respuesta: respuesta ? local(respuesta) : '',
    cierre: cierre ? local(cierre) : '',
    horas_previas: horas,
    sesiones: [],
    mensajes,
    nps,
    mejora: nps != null && nps < 9 ? 'Que la respuesta llegue un poco antes.' : '',
  };
}

const hoy = (d = new Date()) => local(d).slice(0, 10);
// Al cambiar los datos de ejemplo se sube: así se rehacen aunque sean del mismo día.
const VERSION = 2;

async function contar() {
  const [t, c] = await Promise.all([store.tickets.todos(), store.clientes.todos()]);
  return { tickets: t.filter(x => x.ejemplo).length, clientes: c.filter(x => x.ejemplo).length };
}

// El ajuste «ejemplo» guarda si se han quitado a propósito.
async function ajuste() { return (await store.ajustes.donde('clave', 'ejemplo'))[0] || { clave: 'ejemplo', quitados: false }; }
async function recordar(quitados) { await store.ajustes.guardar({ ...(await ajuste()), quitados, cuando: new Date().toISOString() }); }

async function borrar() {
  for (const t of await store.tickets.todos()) if (t.ejemplo) await store.tickets.borrar(t.id);
  for (const c of await store.clientes.todos()) if (c.ejemplo) await store.clientes.borrar(c.id);
}

async function crear(ahora) {
  const fichas = await store.clientes.todos();
  for (const [nombre, servicio, tipo_cliente] of CLIENTES) {
    if (fichas.some(f => f.nombre === nombre)) continue;
    await store.clientes.guardar({ nombre, servicio, tipo_cliente, notas: 'Cliente de ejemplo: se quita en Canales → Datos de ejemplo.', ejemplo: true });
  }
  for (const [i, t] of TICKETS.entries()) await store.tickets.guardar({ ...ticket(t, i, ahora), ejemplo_dia: hoy(ahora), ejemplo_version: VERSION });
}

async function poner(ahora = new Date()) {
  await borrar();
  await crear(ahora);
  await recordar(false);
  return contar();
}

async function quitar() {
  const antes = await contar();
  await borrar();
  await recordar(true);
  return { quitados: antes };
}

// Al arrancar y cada hora: si no se han quitado a propósito, que estén y con fechas de hoy.
let enMarcha = null;
function mantener(ahora = new Date()) {
  return enMarcha ||= (async () => {
    if ((await ajuste()).quitados) return;
    const t = (await store.tickets.todos()).filter(x => x.ejemplo);
    if (t.length === TICKETS.length && t.every(x => x.ejemplo_dia === hoy(ahora) && x.ejemplo_version === VERSION)) return;
    await borrar();
    await crear(ahora);
    console.log(`Datos de ejemplo puestos (${TICKETS.length} tickets, fechas del ${hoy(ahora)}).`);
  })().catch(e => console.error('Datos de ejemplo:', e.message)).finally(() => { enMarcha = null; });
}
function vigilar() { mantener(); setInterval(mantener, 3600e3).unref(); }

async function rutas(req, res, ruta, { json, leerCuerpo }) {
  if (ruta !== '/api/ejemplo') return false;
  if (req.method === 'GET') return json(res, await contar()), true;
  if (req.method === 'POST') {
    const b = await leerCuerpo(req);
    if (b.accion === 'poner') return json(res, await poner()), true;
    if (b.accion === 'quitar') return json(res, await quitar()), true;
    return json(res, { error: 'Acción desconocida' }, 400), true;
  }
  return false;
}

module.exports = { rutas, poner, quitar, contar, mantener, vigilar };

if (require.main === module) {
  (process.argv.includes('--quitar') ? quitar() : poner())
    .then(r => { console.log(r); process.exit(0); })
    .catch(e => { console.error(e.message); process.exit(1); });
}
