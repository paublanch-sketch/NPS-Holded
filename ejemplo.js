// Datos de ejemplo (15 clientes y 42 tickets) para que el panel enseñe colores y números mientras no hay clientes
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
  // Premium
  ['Gestoría Albiol & Puig', 'Premium', 'Gestoría / asesoría', 'Marta Albiol'],
  ['Assessoria Montseny', 'Premium', 'Gestoría / asesoría', 'Jordi Vidal'],
  ['Fusteria Roca SL', 'Premium', 'Directo', 'Pere Roca'],
  ['Clínica Dental Mar', 'Premium', 'Antiguo cliente AKIRA', 'Laura Mas'],
  ['Assessors Penedès', 'Premium', 'Gestoría / asesoría', 'Núria Sala'],
  ['Gestoria Vallès Nord', 'Premium', 'Gestoría / asesoría', 'Marc Puig'],
  ['Òptica Llum SL', 'Premium', 'Directo', 'Anna Riera'],
  // Implementación
  ['Talleres Ebre SL', 'Implementación', 'Referido por gestoría', 'Toni Ferré'],
  ['Café Nòmada', 'Implementación', 'Referido por gestoría', 'Irene Soler'],
  ['Bodega Can Rovira', 'Implementación', 'Referido por gestoría', 'Quim Rovira'],
  ['Distribucions Garraf SL', 'Implementación', 'Directo', 'Sergi Pons'],
  ['Estudi Vela Arquitectes', 'Implementación', 'Directo', 'Clara Vela'],
  ['Forn Sant Jordi', 'Implementación', 'Referido por gestoría', 'Jordi Mir'],
  ['Hotel Cala Blava', 'Implementación', 'Referido por gestoría', 'Elena Font'],
  ['Logística Delta SL', 'Implementación', 'Directo', 'Pau Serra'],
];

// [cliente, categoría, canal, estado, días laborables atrás, hora de entrada, minutos hasta la
//  primera respuesta (null: sin responder), días atrás del cierre, horas, NPS 0–10, técnico, texto]
const TICKETS = [
  // Premium: todo respondido a tiempo y buena nota (las gestorías 4,9; los directos 4,3).
  ['Gestoría Albiol & Puig', 'Facturación y Verifactu', 'Portal', 'En curso', 0, '09:20', 25, null, 0.5, null, 'Blanch', 'Una factura sale «Rechazada por Verifactu» con el código 1103.'],
  ['Assessoria Montseny', 'Bancos y conciliación', 'Correo', 'Pendiente cliente', 2, '11:00', 40, null, 0.5, null, 'David', 'El banco no sincroniza desde el viernes.'],
  ['Fusteria Roca SL', 'Contabilidad e impuestos', 'WhatsApp', 'En curso', 1, '16:30', 15, null, 0, null, 'Pako', '¿Cómo saco el modelo 303 del trimestre?'],
  ['Gestoría Albiol & Puig', 'Acceso y usuarios', 'Portal', 'Cerrado', 3, '10:00', 20, 3, 1.5, 10, 'Blanch', 'Dar de alta a una nueva administrativa con permisos de solo lectura.'],
  ['Gestoría Albiol & Puig', 'Formación', 'Teléfono', 'Cerrado', 8, '12:00', 30, 7, 3, 10, 'Pablo', 'Formación de remesas y vencimientos para el equipo.'],
  ['Assessoria Montseny', 'Facturación y Verifactu', 'Portal', 'Cerrado', 5, '09:45', 35, 4, 1, 9, 'David', 'Cambiar la serie de facturas rectificativas.'],
  ['Assessoria Montseny', 'Contabilidad e impuestos', 'Correo', 'Cerrado', 11, '15:10', 45, 10, 2, 10, 'Blanch', 'Cuadrar el IVA soportado del trimestre con el libro.'],
  ['Gestoría Albiol & Puig', 'Equipo y fichajes', 'Portal', 'Cerrado', 14, '10:30', 20, 13, 0.5, 10, 'Pako', 'Los fichajes de ayer no aparecen en el informe.'],
  ['Fusteria Roca SL', 'Facturación y Verifactu', 'WhatsApp', 'Cerrado', 6, '13:00', 50, 5, 1, 8, 'Pablo', 'Añadir el IBAN al pie de las facturas.'],
  ['Clínica Dental Mar', 'Bancos y conciliación', 'Teléfono', 'Cerrado', 9, '11:15', 30, 8, 2.5, 9, 'David', 'Conciliar los cobros con tarjeta del TPV.'],
  // Implementación: dos sin responder, tres fuera de SLA y nota de 4,0.
  ['Talleres Ebre SL', 'Contabilidad e impuestos', 'Portal', 'Nuevo', 1, '15:00', null, null, 0, null, 'Blanch', 'No me deja cerrar el ejercicio: dice que hay asientos descuadrados.'],
  ['Café Nòmada', 'Facturación y Verifactu', 'WhatsApp', 'Nuevo', 0, '09:10', null, null, 0, null, 'Pako', 'El TPV no manda los tickets a Holded.'],
  ['Distribucions Garraf SL', 'Bancos y conciliación', 'Correo', 'En curso', 2, '10:00', 95, null, 1, null, 'David', 'Importar el extracto de La Caixa en Norma 43.'],
  ['Estudi Vela Arquitectes', 'Formación', 'Portal', 'Pendiente cliente', 4, '12:00', 30, null, 1.5, null, 'Pablo', 'Sesión para montar los proyectos y las horas.'],
  ['Bodega Can Rovira', 'Equipo y fichajes', 'Teléfono', 'En curso', 1, '09:30', 20, null, 0.5, null, 'Pako', 'Configurar los turnos de la vendimia.'],
  ['Talleres Ebre SL', 'Facturación y Verifactu', 'Portal', 'En curso', 3, '15:00', 130, null, 2, null, 'Blanch', 'Migrar las facturas de 2025 desde el programa anterior.'],
  ['Distribucions Garraf SL', 'Acceso y usuarios', 'Portal', 'Pendiente cliente', 6, '10:30', 45, null, 0.5, null, 'David', 'El gestor externo no puede entrar a la cuenta.'],
  ['Estudi Vela Arquitectes', 'Contabilidad e impuestos', 'Correo', 'Cerrado', 7, '10:00', 25, 6, 4, 9, 'Blanch', 'Plan contable a medida para las obras.'],
  ['Café Nòmada', 'Formación', 'Teléfono', 'Cerrado', 10, '09:30', 80, 8, 3, 6, 'Pablo', 'Formación de inventario y escandallos.'],
  ['Bodega Can Rovira', 'Facturación y Verifactu', 'Portal', 'Cerrado', 12, '11:00', 35, 11, 1.5, 8, 'Pako', 'Plantilla de factura con los lotes del vino.'],
  ['Talleres Ebre SL', 'Bancos y conciliación', 'Correo', 'Cerrado', 15, '12:30', 55, 12, 5, 7, 'Blanch', 'Alta de tres cuentas bancarias y reglas de conciliación.'],
  ['Distribucions Garraf SL', 'Contabilidad e impuestos', 'Portal', 'Cerrado', 9, '16:00', 30, 7, 2, 10, 'David', 'Asientos de amortización automáticos.'],
  // Segunda tanda: cada técnico tiene casos abiertos y cerrados en los cuatro grupos, para que
  // el panel enseñe números y colores también filtrando por una sola persona.
  // Premium · gestorías
  ['Assessors Penedès', 'Facturación y Verifactu', 'Portal', 'En curso', 0, '10:15', 20, null, 0.5, null, 'David', 'Las facturas de un cliente suyo salen sin el recargo de equivalencia.'],
  ['Assessors Penedès', 'Contabilidad e impuestos', 'Correo', 'Cerrado', 4, '09:30', 15, 3, 1.5, 10, 'Pablo', 'Exportar el libro de IVA para el modelo 390.'],
  ['Gestoria Vallès Nord', 'Bancos y conciliación', 'Portal', 'Pendiente cliente', 1, '12:30', 35, null, 1, null, 'Pako', 'Duplicados al importar el extracto del Sabadell.'],
  ['Gestoria Vallès Nord', 'Facturación y Verifactu', 'Portal', 'En curso', 2, '15:30', 75, null, 1, null, 'Pablo', 'Activar Verifactu en tres empresas de su cartera.'],
  ['Gestoria Vallès Nord', 'Acceso y usuarios', 'Teléfono', 'Cerrado', 7, '11:00', 25, 6, 0.5, 9, 'Blanch', 'Permisos de solo lectura para un cliente final.'],
  ['Gestoría Albiol & Puig', 'Formación', 'Teléfono', 'Cerrado', 12, '10:00', 30, 11, 2, 10, 'Pablo', 'Sesión sobre cierres trimestrales en Holded.'],
  // Premium · directos
  ['Òptica Llum SL', 'Facturación y Verifactu', 'WhatsApp', 'En curso', 1, '10:00', 20, null, 0.5, null, 'Pablo', 'El ticket de la tienda no lleva el QR de Verifactu.'],
  ['Òptica Llum SL', 'Contabilidad e impuestos', 'Portal', 'Cerrado', 6, '16:00', 40, 5, 1, 9, 'David', 'Amortizar el equipo nuevo de optometría.'],
  ['Clínica Dental Mar', 'Acceso y usuarios', 'Portal', 'Pendiente cliente', 3, '10:30', 30, null, 0.5, null, 'Blanch', 'La recepcionista no puede ver las citas.'],
  ['Fusteria Roca SL', 'Bancos y conciliación', 'Teléfono', 'Cerrado', 13, '10:00', 25, 12, 1.5, 7, 'Pako', 'Conciliar los pagos a proveedores por remesa.'],
  // Implementación · referidos por gestoría
  ['Forn Sant Jordi', 'Facturación y Verifactu', 'WhatsApp', 'En curso', 1, '11:20', 45, null, 1, null, 'Pablo', 'Dar de alta los productos del obrador con su IVA.'],
  ['Forn Sant Jordi', 'Formación', 'Teléfono', 'Cerrado', 8, '10:00', 30, 7, 3, 9, 'David', 'Formación de facturación para las dos tiendas.'],
  ['Hotel Cala Blava', 'Bancos y conciliación', 'Correo', 'Pendiente cliente', 2, '13:00', 110, null, 1.5, null, 'Blanch', 'Conectar la cuenta de la pasarela de pago.'],
  ['Hotel Cala Blava', 'Contabilidad e impuestos', 'Portal', 'Cerrado', 11, '09:30', 40, 9, 2.5, 8, 'Pablo', 'Plan de cuentas para las reservas y los anticipos.'],
  ['Bodega Can Rovira', 'Acceso y usuarios', 'Portal', 'Cerrado', 5, '10:15', 20, 4, 0.5, 10, 'David', 'Usuario para la enóloga con acceso a inventario.'],
  // Implementación · directos
  ['Logística Delta SL', 'Equipo y fichajes', 'Portal', 'En curso', 1, '09:15', 50, null, 1, null, 'Pablo', 'Los conductores fichan desde el móvil y no se guarda la ubicación.'],
  ['Logística Delta SL', 'Facturación y Verifactu', 'Correo', 'Cerrado', 6, '12:00', 35, 5, 2, 7, 'Pako', 'Facturas recapitulativas mensuales por cliente.'],
  ['Estudi Vela Arquitectes', 'Bancos y conciliación', 'Portal', 'Cerrado', 14, '11:00', 25, 13, 1, 8, 'David', 'Reglas para los cobros por transferencia.'],
  ['Distribucions Garraf SL', 'Formación', 'Teléfono', 'Cerrado', 4, '15:00', 70, 3, 2, 6, 'Pablo', 'Formación de almacenes y pedidos de compra.'],
  ['Estudi Vela Arquitectes', 'Facturación y Verifactu', 'WhatsApp', 'Pendiente cliente', 0, '09:30', 15, null, 0.5, null, 'Pako', 'Factura de anticipo de un proyecto.'],
];

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
    urgente: estado === 'Nuevo',
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
  for (const [i, t] of TICKETS.entries()) await store.tickets.guardar({ ...ticket(t, i, ahora), ejemplo_dia: hoy(ahora) });
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
    if (t.length === TICKETS.length && t.every(x => x.ejemplo_dia === hoy(ahora))) return;
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
