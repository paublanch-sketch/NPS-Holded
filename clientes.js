// Clientes: su servicio y su origen se guardan una vez por cliente y todos sus tickets
// lo heredan. También permite fusionar dos nombres que son el mismo cliente.
const { tickets, clientes, ajustes } = require('./store');

const SERVICIOS = ['Implementación', 'Premium', 'Kit Digital', 'Sin clasificar'];
const ORIGENES = ['Gestoría / asesoría', 'Referido por gestoría', 'Directo', 'Antiguo cliente AKIRA', 'Sin clasificar'];

// nombre de cliente → { servicio, tipo_cliente } de su ficha.
async function fichas() {
  return new Map((await clientes.todos()).map(c => [c.nombre, c]));
}

// Servicio y origen efectivos de un ticket: los de la ficha del cliente si existe.
function clasificar(t, mapa) {
  const c = mapa.get(t.cliente);
  return {
    servicio: c?.servicio || (SERVICIOS.includes(t.servicio) ? t.servicio : 'Sin clasificar'),
    tipo_cliente: c?.tipo_cliente || (ORIGENES.includes(t.tipo_cliente) ? t.tipo_cliente : 'Sin clasificar'),
  };
}

async function guardarFicha(nombre, cambios) {
  const l = await clientes.todos();
  const c = l.find(x => x.nombre === nombre) || { nombre, servicio: 'Sin clasificar', tipo_cliente: 'Sin clasificar' };
  if (SERVICIOS.includes(cambios.servicio)) c.servicio = cambios.servicio;
  if (ORIGENES.includes(cambios.tipo_cliente)) c.tipo_cliente = cambios.tipo_cliente;
  if (typeof cambios.notas === 'string') c.notas = cambios.notas.slice(0, 2000);
  // Contacto de la ficha, para los clientes dados de alta a mano (los demás lo sacan de sus tickets).
  if (typeof cambios.email === 'string') c.email = cambios.email.trim().toLowerCase().slice(0, 200);
  if (typeof cambios.telefono === 'string') c.telefono = cambios.telefono.trim().slice(0, 40);
  // Razón social en la lista de clientes del Kit Digital activos.
  if (typeof cambios.kitDigital === 'string' && cambios.kitDigital.trim()) c.kitDigital = cambios.kitDigital.trim();
  return clientes.guardar(c);
}

// Cambios de ficha pedidos una sola vez: se aplican al arrancar y se apuntan en «ajustes»,
// para no pisar lo que se cambie después desde Clientes.
// 27/10/2026: SHEILOR SLU es Premium, la única Premium real.
// 27/10/2026: todos los demás clientes reales son Kit Digital y antiguos clientes de AKIRA.
const UNA_VEZ = [
  ['sheilor-premium', () => guardarFicha('SHEILOR SLU', { servicio: 'Premium' })],
  ['todos-kit-digital-akira', async () => {
    const nombres = new Set((await tickets.todos()).filter(t => !t.interno && !t.ejemplo).map(t => t.cliente));
    for (const f of await clientes.todos()) if (!f.ejemplo) nombres.add(f.nombre);
    nombres.delete('SHEILOR SLU');
    for (const n of nombres) if (n) await guardarFicha(n, { servicio: 'Kit Digital', tipo_cliente: 'Antiguo cliente AKIRA' });
  }],
  // 27/10/2026: lista de clientes del Kit Digital activos (kit-digital-activos.txt, una razón
  // social por línea) y las uniones que no salían solas, comprobadas por correo y en internet.
  ['kit-digital-activos-1', async () => {
    const lista = require('fs').readFileSync(require('path').join(__dirname, 'kit-digital-activos.txt'), 'utf8')
      .split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const r = await importarKitDigital(lista);
    console.log(`Kit Digital: ${r.unidos.length} unidos, ${r.nuevos} nuevos, ${r.yaEstaban} ya estaban.`);
    const conTickets = new Set((await tickets.todos()).map(t => t.cliente));
    for (const [de, a] of [['Casa Alfaro', 'ALPARGATAS ALFARO S.L.'], ['AINHOA MARTÍN QUIROGA', 'AQ MODEL AGENCY SL']]) {
      if (conTickets.has(a) && (await clientes.todos()).some(f => f.nombre === de)) await fusionar(de, a);
    }
  }],
];
async function aplicarUnaVez() {
  for (const [clave, f] of UNA_VEZ) {
    if ((await ajustes.donde('clave', clave)).length) continue;
    await f();
    await ajustes.guardar({ clave, cuando: new Date().toISOString() });
    console.log(`Ficha: aplicado «${clave}».`);
  }
}

// ---- Clientes del Kit Digital activos ----
// Se pega la lista de razones sociales. Si una ya es cliente con incidencias (aunque esté
// escrita distinto: «SHEILOR 545 SLU» y «SHEILOR SLU»), se une a su ficha; si no, se crea
// una ficha Kit Digital sin incidencias. Los parecidos que no son seguros se crean aparte y
// se devuelven para que alguien diga si son el mismo (y se unan con Fusionar).
// Formas jurídicas y palabras vacías que no distinguen a un cliente de otro.
const VACIAS = new Set(['SL', 'SLU', 'SA', 'SAU', 'SLL', 'SLP', 'SCP', 'SLV', 'SC', 'CB', 'SOCIEDAD', 'LIMITADA', 'LIM', 'COOP',
  'S', 'L', 'U', 'P', 'A', 'V', 'C', 'Y', 'I', 'D', 'DE', 'DEL', 'LA', 'EL', 'LES', 'LOS', 'LAS']);
const palabras = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
  .replace(/[^A-Z0-9]+/g, ' ').trim().split(' ')
  .filter(w => w && !VACIAS.has(w))
  .map(w => w.length > 4 ? w.replace(/S$/, '') : w); // «SOPORTES METÁLICOS» = «SOPORTE METÁLICO»

// 'seguro', 'dudoso' o null, y cuántas palabras comparten.
function parecido(a, b, rara = () => false) {
  const pa = palabras(a), pb = palabras(b);
  if (!pa.length || !pb.length) return null;
  const ja = pa.join(''), jb = pb.join('');
  const comunes = pa.filter(w => pb.includes(w));
  const [menor, mayor] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
  const contenido = menor.every(w => mayor.includes(w));
  if (ja === jb) return { nivel: 'seguro', comunes: comunes.length + 1 };
  if (contenido && (menor.length >= 2 || menor[0].length >= 6)) return { nivel: 'seguro', comunes: comunes.length };
  if (Math.min(ja.length, jb.length) >= 7 && (ja.includes(jb) || jb.includes(ja))) return { nivel: 'seguro', comunes: comunes.length };
  // Dudoso solo si comparten una palabra poco común (no «JUAN», «GARCÍA» ni «TALLERES»).
  const raras = comunes.filter(w => w.length >= 5 && rara(w));
  if (raras.length && (comunes.length >= 2 || raras.some(w => w.length >= 6))) return { nivel: 'dudoso', comunes: comunes.length };
  return null;
}

async function importarKitDigital(lista) {
  const fs = await clientes.todos();
  const conTickets = new Set((await tickets.todos()).filter(t => !t.interno && !t.ejemplo).map(t => t.cliente));
  // Clientes a los que se puede unir: los que tienen incidencias (los demás ya son de la lista).
  const candidatos = [...conTickets].filter(Boolean);
  const clave = x => palabras(x).join(' ');
  // Ya importados (por su razón social) y fichas que se llaman igual que un nombre de la lista.
  const yaEn = new Set(fs.map(f => f.kitDigital).filter(Boolean).map(clave));
  const fichaIgual = new Map(fs.filter(f => !f.ejemplo).map(f => [clave(f.nombre), f]));
  // Una palabra es «rara» si sale en un solo nombre: un apellido común no basta para sospechar.
  const cuenta = new Map();
  for (const n of [...candidatos, ...lista]) for (const w of new Set(palabras(n))) cuenta.set(w, (cuenta.get(w) || 0) + 1);
  const rara = w => (cuenta.get(w) || 0) <= 2;

  const r = { unidos: [], nuevos: 0, dudosos: [], yaEstaban: 0 };
  const usados = new Set(fs.filter(f => f.kitDigital).map(f => f.nombre));
  for (const oficial of [...new Set(lista)]) {
    if (yaEn.has(clave(oficial))) { r.yaEstaban++; continue; }
    const igual = fichaIgual.get(clave(oficial));
    if (igual && !igual.kitDigital) {
      await guardarFicha(igual.nombre, { kitDigital: oficial });
      igual.kitDigital = oficial;
      usados.add(igual.nombre);
      r.unidos.push({ oficial, cliente: igual.nombre });
      yaEn.add(clave(oficial));
      continue;
    }
    const opciones = candidatos.map(c => ({ c, p: parecido(oficial, c, rara) })).filter(x => x.p)
      .sort((x, y) => (x.p.nivel === 'seguro' ? 0 : 1) - (y.p.nivel === 'seguro' ? 0 : 1) || y.p.comunes - x.p.comunes);
    const seguros = opciones.filter(x => x.p.nivel === 'seguro');
    const mejor = seguros.length === 1 || (seguros.length > 1 && seguros[0].p.comunes > seguros[1].p.comunes) ? seguros[0] : null;
    if (mejor && !usados.has(mejor.c)) {
      await guardarFicha(mejor.c, { kitDigital: oficial });
      usados.add(mejor.c);
      r.unidos.push({ oficial, cliente: mejor.c });
    } else {
      await clientes.guardar({ nombre: oficial, servicio: 'Kit Digital', tipo_cliente: 'Antiguo cliente AKIRA', kitDigital: oficial });
      r.nuevos++;
      if (opciones.length) r.dudosos.push({ oficial, cliente: opciones[0].c });
    }
    yaEn.add(clave(oficial));
  }
  return r;
}

// Fusionar: todos los tickets de «de» pasan a «a»; el nombre viejo queda como contacto.
async function fusionar(de, a) {
  let n = 0;
  for (const t of await tickets.todos()) {
    if (t.cliente !== de) continue;
    if (!t.contacto) t.contacto = de;
    t.cliente = a;
    await tickets.guardar(t);
    n++;
  }
  const l = await clientes.todos();
  const fa = l.find(x => x.nombre === a), fd = l.find(x => x.nombre === de);
  if (fd) {
    if (!fa) await guardarFicha(a, fd);
    else await guardarFicha(a, { servicio: fa.servicio === 'Sin clasificar' ? fd.servicio : undefined, tipo_cliente: fa.tipo_cliente === 'Sin clasificar' ? fd.tipo_cliente : undefined, kitDigital: fa.kitDigital ? undefined : fd.kitDigital });
    await clientes.borrar(fd.id);
  }
  return n;
}

async function rutas(req, res, ruta, { json, leerCuerpo }) {
  if (!ruta.startsWith('/api/clientes')) return false;

  if (req.method === 'GET' && ruta === '/api/clientes') {
    const mapa = await fichas();
    const por = new Map();
    const nuevo = nombre => ({ nombre, tickets: 0, abiertos: 0, horas: 0, ultimo: '', emails: new Set(), telefonos: new Set() });
    const ahora = Date.now();
    for (const t of await tickets.todos()) {
      if (t.interno) continue;
      const c = por.get(t.cliente) || nuevo(t.cliente);
      c.tickets++;
      if (t.estado !== 'Cerrado') c.abiertos++;
      // Horas: las del Sheet más las sesiones del cronómetro.
      c.horas += (t.horas_previas || 0) + (t.sesiones || []).reduce((h, x) => h + ((x.fin ? new Date(x.fin) : ahora) - new Date(x.inicio)) / 36e5, 0);
      // Último contacto: el mensaje más reciente, con el cliente o del equipo.
      for (const f of [t.entrada, ...(t.mensajes || []).filter(m => m.de !== 'sistema').map(m => m.fecha)]) if (f > c.ultimo) c.ultimo = f;
      if (t.email) c.emails.add(t.email.toLowerCase());
      if (t.telefono) c.telefonos.add(t.telefono);
      por.set(t.cliente, c);
    }
    for (const f of mapa.values()) {
      if (!por.has(f.nombre)) por.set(f.nombre, nuevo(f.nombre));
      if (f.email) por.get(f.nombre).emails.add(f.email);
      if (f.telefono) por.get(f.nombre).telefonos.add(f.telefono);
    }
    const l = [...por.values()].map(c => ({
      ...c, horas: Math.round(c.horas * 10) / 10, emails: [...c.emails], telefonos: [...c.telefonos],
      ...clasificar({ cliente: c.nombre }, mapa), notas: mapa.get(c.nombre)?.notas || '', kitDigital: mapa.get(c.nombre)?.kitDigital || null,
      codigo: mapa.get(c.nombre)?.id ? 'CL-' + String(mapa.get(c.nombre).id).padStart(4, '0') : '',
    })).sort((a, b) => b.ultimo.localeCompare(a.ultimo));
    return json(res, { clientes: l, servicios: SERVICIOS, origenes: ORIGENES }), true;
  }
  if (req.method === 'POST' && ruta === '/api/clientes') {
    const b = await leerCuerpo(req);
    if (!String(b.nombre || '').trim()) return json(res, { error: 'Falta el nombre' }, 400), true;
    // «Nuevo cliente»: no pisar uno que ya existe con ese nombre.
    if (b.nuevo && (await clientes.todos()).some(f => f.nombre.toLowerCase() === String(b.nombre).trim().toLowerCase()))
      return json(res, { error: 'Ya hay un cliente con ese nombre' }, 409), true;
    return json(res, await guardarFicha(String(b.nombre).trim(), b)), true;
  }
  if (req.method === 'POST' && ruta === '/api/clientes/kit-digital') {
    const b = await leerCuerpo(req);
    const lista = String(b.lista || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (!lista.length) return json(res, { error: 'Pega la lista, un cliente por línea' }, 400), true;
    return json(res, await importarKitDigital(lista)), true;
  }
  if (req.method === 'POST' && ruta === '/api/clientes/fusionar') {
    const b = await leerCuerpo(req);
    const de = String(b.de || '').trim(), a = String(b.a || '').trim();
    if (!de || !a || de === a) return json(res, { error: 'Elige dos clientes distintos' }, 400), true;
    return json(res, { movidos: await fusionar(de, a) }), true;
  }
  return false;
}

module.exports = { rutas, fichas, clasificar, guardarFicha, fusionar, aplicarUnaVez, importarKitDigital, parecido, SERVICIOS, ORIGENES };
