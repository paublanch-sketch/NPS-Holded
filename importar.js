// Importa el histórico del Google Form de incidencias como tickets cerrados.
//   node importar.js data/historico-sheet.csv            → solo muestra lo que haría
//   node importar.js data/historico-sheet.csv --guardar  → importa
// Con DATABASE_URL escribe en Postgres; sin ella, en data/tickets.json.
// Los nombres de cliente se corrigen con data/alias-clientes.json. Volver a ejecutarlo
// no duplica: cada fila se identifica por su marca temporal y su nombre original.
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

(async () => {
  const filas = parseCSV(fs.readFileSync(fichero, 'utf8')).map(normalizar).filter(esHolded);
  const existentes = new Set((await store.todos()).filter(t => t.origen === 'Sheet').map(t => t.clave_sheet));
  let nuevas = 0, horas = 0;
  const nombres = new Set();
  const fueraKit = new Set();
  for (const f of filas) {
    const original = f.cliente.trim();
    const cliente = alias[original] || original;
    const clave = `${f.entrada}|${original}`;
    nombres.add(cliente);
    if (/no es kit ?digital|fuera del kit ?digital|no est[aá] dentro del kit|contratar premium/i.test(f.descripcion + ' ' + f.comentario)) fueraKit.add(cliente);
    horas += f.horas;
    if (existentes.has(clave)) continue;
    nuevas++;
    if (modo !== '--guardar') continue;
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
  if (modo === '--guardar') for (const nombre of sinFicha)
    await clientes.guardar({ nombre, servicio: fueraKit.has(nombre) ? 'Sin clasificar' : 'Kit Digital', tipo_cliente: 'Sin clasificar' });
  console.log(`${filas.length} filas de Holded o Blanch · ${nombres.size} clientes · ${+horas.toFixed(2)} h`);
  console.log(`Fichas de cliente ${modo === '--guardar' ? 'creadas' : 'por crear'}: ${sinFicha.length} (fuera del Kit Digital, por clasificar: ${[...fueraKit].join(', ') || 'ninguno'})`);
  console.log(modo === '--guardar' ? `Importadas ${nuevas} (las demás ya estaban).` : `Se importarían ${nuevas}. Añade --guardar para hacerlo.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
