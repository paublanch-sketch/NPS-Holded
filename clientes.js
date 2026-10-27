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
  return clientes.guardar(c);
}

// Cambios de ficha pedidos una sola vez: se aplican al arrancar y se apuntan en «ajustes»,
// para no pisar lo que se cambie después desde Clientes.
// 27/10/2026: SHEILOR SLU es Premium, la única Premium real.
const UNA_VEZ = [['sheilor-premium', () => guardarFicha('SHEILOR SLU', { servicio: 'Premium' })]];
async function aplicarUnaVez() {
  for (const [clave, f] of UNA_VEZ) {
    if ((await ajustes.donde('clave', clave)).length) continue;
    await f();
    await ajustes.guardar({ clave, cuando: new Date().toISOString() });
    console.log(`Ficha: aplicado «${clave}».`);
  }
}

async function rutas(req, res, ruta, { json, leerCuerpo }) {
  if (!ruta.startsWith('/api/clientes')) return false;

  if (req.method === 'GET' && ruta === '/api/clientes') {
    const mapa = await fichas();
    const por = new Map();
    for (const t of await tickets.todos()) {
      if (t.interno) continue;
      const c = por.get(t.cliente) || { nombre: t.cliente, tickets: 0, abiertos: 0, ultimo: '', emails: new Set(), telefonos: new Set() };
      c.tickets++;
      if (t.estado !== 'Cerrado') c.abiertos++;
      if (t.entrada > c.ultimo) c.ultimo = t.entrada;
      if (t.email) c.emails.add(t.email.toLowerCase());
      if (t.telefono) c.telefonos.add(t.telefono);
      por.set(t.cliente, c);
    }
    for (const f of mapa.values()) if (!por.has(f.nombre)) por.set(f.nombre, { nombre: f.nombre, tickets: 0, abiertos: 0, ultimo: '', emails: new Set(), telefonos: new Set() });
    const l = [...por.values()].map(c => ({
      ...c, emails: [...c.emails], telefonos: [...c.telefonos],
      ...clasificar({ cliente: c.nombre }, mapa), notas: mapa.get(c.nombre)?.notas || '',
    })).sort((a, b) => b.ultimo.localeCompare(a.ultimo));
    return json(res, { clientes: l, servicios: SERVICIOS, origenes: ORIGENES }), true;
  }
  if (req.method === 'POST' && ruta === '/api/clientes') {
    const b = await leerCuerpo(req);
    if (!String(b.nombre || '').trim()) return json(res, { error: 'Falta el nombre' }, 400), true;
    return json(res, await guardarFicha(String(b.nombre).trim(), b)), true;
  }
  // Fusionar: todos los tickets de «de» pasan a «a»; el nombre viejo queda como contacto.
  if (req.method === 'POST' && ruta === '/api/clientes/fusionar') {
    const b = await leerCuerpo(req);
    const de = String(b.de || '').trim(), a = String(b.a || '').trim();
    if (!de || !a || de === a) return json(res, { error: 'Elige dos clientes distintos' }, 400), true;
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
      else await guardarFicha(a, { servicio: fa.servicio === 'Sin clasificar' ? fd.servicio : undefined, tipo_cliente: fa.tipo_cliente === 'Sin clasificar' ? fd.tipo_cliente : undefined });
      await clientes.borrar(fd.id);
    }
    return json(res, { movidos: n }), true;
  }
  return false;
}

module.exports = { rutas, fichas, clasificar, guardarFicha, aplicarUnaVez, SERVICIOS, ORIGENES };
