// Importa el histórico del Google Form de incidencias como tickets cerrados.
//   node importar.js data/historico-sheet.csv               → solo muestra lo que haría
//   node importar.js data/historico-sheet.csv --guardar     → importa las filas nuevas
//   node importar.js data/historico-sheet.csv --actualizar  → además, pone en las ya importadas
//                                                             la descripción, el comentario y el técnico del Sheet
// Con DATABASE_URL escribe en Postgres; sin ella, en data/tickets.json.
// Los nombres de cliente se corrigen con data/alias-clientes.json; un alias null deja la fila
// fuera. Su clave «_tecnicos» une nombres de técnico (p. ej. «Pau» → «Blanch»), después de
// elegir las filas de Holded: los tickets de otros tipos de «Pau» no entran. Volver a ejecutarlo no duplica: cada fila se reconoce por su marca temporal y su nombre
// original, aunque cambien acentos, comillas o puntuación, o por su correo.
// Cada cliente nuevo recibe ficha de Kit Digital (el soporte del Sheet era el del año de
// servicio del Kit Digital), salvo los que el propio Sheet dice que van fuera del Kit.
require('./entorno');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tickets: store, clientes } = require('./store');
const { parseCSV, normalizar, esHolded } = require('./historico');

const [fichero, modo] = process.argv.slice(2);
if (!fichero) { console.error('Uso: node importar.js <csv> [--guardar]'); process.exit(1); }

const aliasFichero = path.join(__dirname, 'data', 'alias-clientes.json');
const alias = fs.existsSync(aliasFichero) ? JSON.parse(fs.readFileSync(aliasFichero, 'utf8')) : {};
const tecnicos = alias._tecnicos || {};

const norma = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9@.]+/g, ' ').replace(/\.(?=\s|$)/g, '').trim();

(async () => {
  const guardar = modo === '--guardar' || modo === '--actualizar';
  const filas = parseCSV(fs.readFileSync(fichero, 'utf8')).map(normalizar).filter(esHolded)
    .map(f => ({ ...f, tecnico: tecnicos[f.tecnico] || f.tecnico }));
  const delSheet = (await store.todos()).filter(t => t.origen === 'Sheet');
  const porEntrada = new Map();
  for (const t of delSheet) porEntrada.set(t.entrada, [...(porEntrada.get(t.entrada) || []), t]);
  const usados = new Set();
  // El ticket ya importado de esta fila: misma hora de entrada y mismo nombre original
  // (sin contar acentos ni puntuación) o mismo correo.
  const buscar = (f, original) => (porEntrada.get(f.entrada) || []).find(t => !usados.has(t.id) && (
    t.clave_sheet === `${f.entrada}|${original}` || norma(t.clave_sheet.slice(f.entrada.length + 1)) === norma(original)
    || (f.email.includes('@') && t.email === f.email)));
  let nuevas = 0, horas = 0, fuera = 0, textos = 0;
  const nombres = new Set();
  const fueraKit = new Set();
  for (const f of filas) {
    const original = f.cliente.trim();
    if (alias[original] === null) { fuera++; continue; }
    const clave = `${f.entrada}|${original}`;
    const ya = buscar(f, original);
    // Si ya estaba, manda el cliente con el que se importó (puede haberse corregido a mano).
    const cliente = ya ? ya.cliente : alias[original] || original;
    nombres.add(cliente);
    if (/no es kit ?digital|fuera del kit ?digital|no est[aá] dentro del kit|contratar premium/i.test(f.descripcion + ' ' + f.comentario)) fueraKit.add(cliente);
    horas += f.horas;
    if (ya) {
      usados.add(ya.id);
      // Del Sheet tal cual: la descripción (también en el primer mensaje), el comentario interno y el técnico.
      const msj = ya.mensajes || [];
      const primero = msj.find(m => m.de === 'cliente'), nota = msj.find(m => m.de === 'nota' && m.autor === ya.tecnico);
      const descripcion = f.descripcion || '(sin descripción)';
      const cambia = ya.descripcion !== f.descripcion || (primero && primero.texto !== descripcion) || (f.comentario && (!nota || nota.texto !== f.comentario))
        || ya.clave_sheet !== clave || ya.tecnico !== f.tecnico;
      if (!cambia) continue;
      textos++;
      if (modo !== '--actualizar') continue;
      ya.descripcion = f.descripcion;
      if (primero) primero.texto = descripcion;
      if (f.comentario) nota ? (nota.texto = f.comentario) : msj.push({ de: 'nota', autor: f.tecnico, texto: f.comentario, fecha: f.cierre || f.entrada });
      // Las notas del técnico de antes pasan al nombre unificado.
      if (ya.tecnico !== f.tecnico) { msj.forEach(m => { if (m.de === 'nota' && m.autor === ya.tecnico) m.autor = f.tecnico; }); ya.tecnico = f.tecnico; }
      ya.mensajes = msj;
      ya.clave_sheet = clave;
      await store.guardar(ya);
      continue;
    }
    nuevas++;
    if (!guardar) continue;
    const mensajes = [{ de: 'cliente', texto: f.descripcion || '(sin descripción)', fecha: f.entrada }];
    if (f.comentario) mensajes.push({ de: 'nota', autor: f.tecnico, texto: f.comentario, fecha: f.cierre || f.entrada });
    await store.guardar({
      token: crypto.randomBytes(16).toString('hex'),
      origen: 'Sheet', clave_sheet: clave,
      interno: /\(interno\)/.test(cliente),
      cliente, contacto: cliente !== original ? original : '', email: f.email, telefono: '',
      tipo_incidencia: f.tipo_incidencia, descripcion: f.descripcion,
      servicio: 'Sin clasificar', tipo_cliente: 'Sin clasificar', canal: 'Formulario',
      estado: f.estado, tecnico: f.tecnico,
      entrada: f.entrada, primera_respuesta: '', cierre: f.cierre,
      horas_previas: f.horas, sesiones: [], mensajes,
      nps: f.nps, mejora: '',
    });
  }
  const conFicha = new Set((await clientes.todos()).map(c => c.nombre));
  const sinFicha = [...nombres].filter(n => !conFicha.has(n) && !n.includes('(interno)'));
  if (guardar) for (const nombre of sinFicha)
    await clientes.guardar({ nombre, servicio: fueraKit.has(nombre) ? 'Sin clasificar' : 'Kit Digital', tipo_cliente: 'Sin clasificar' });
  console.log(`${filas.length} filas de Holded o Blanch (${fuera} fuera por alias null) · ${nombres.size} clientes · ${+horas.toFixed(2)} h`);
  console.log(`Fichas de cliente ${guardar ? 'creadas' : 'por crear'}: ${sinFicha.length} (fuera del Kit Digital, por clasificar: ${[...fueraKit].join(', ') || 'ninguno'})`);
  console.log(guardar ? `Importadas ${nuevas} (las demás ya estaban).` : `Se importarían ${nuevas}. Añade --guardar para hacerlo.`);
  console.log(`Ya importadas con textos o técnico distintos del Sheet: ${textos}${modo === '--actualizar' ? ' (actualizadas)' : '. Añade --actualizar para ponerles los del Sheet.'}`);
  const sinFila = delSheet.filter(t => !usados.has(t.id));
  if (sinFila.length) console.log(`Importadas que no están en este CSV (no se tocan): ${sinFila.map(t => `${t.entrada} ${t.cliente}`).join(' · ')}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
