// Almacén por colecciones (tickets y clientes). Con DATABASE_URL usa Postgres,
// una tabla por colección con una fila JSONB por documento; sin ella, ficheros JSON en
// data/ para desarrollo. Render borra el disco en cada despliegue: en producción, Postgres.
const fs = require('fs');
const path = require('path');

function coleccionFichero(nombre) {
  const fichero = path.join(__dirname, 'data', `${nombre}.json`);
  const leer = () => { try { return JSON.parse(fs.readFileSync(fichero, 'utf8')); } catch { return []; } };
  const escribir = l => fs.writeFileSync(fichero, JSON.stringify(l, null, 1));
  return {
    async todos() { return leer(); },
    async guardar(d) {
      const l = leer();
      if (!d.id) d.id = l.reduce((m, x) => Math.max(m, x.id), 0) + 1;
      const i = l.findIndex(x => x.id === d.id);
      i >= 0 ? (l[i] = d) : l.push(d);
      escribir(l);
      return d;
    },
    async borrar(id) { escribir(leer().filter(x => x.id !== id)); },
  };
}

let pool = null;
function coleccionPostgres(url, nombre) {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: url, ssl: url.includes('localhost') ? false : { rejectUnauthorized: false } });
    pool.on('error', e => console.error('Postgres (conexión):', e.message));
  }
  // Si Postgres falla al arrancar, se dice en el log y la siguiente consulta lo reintenta.
  let creada = null;
  const preparar = () => creada ||= pool.query(`CREATE TABLE IF NOT EXISTS ${nombre} (id SERIAL PRIMARY KEY, doc JSONB NOT NULL)`)
    .catch(e => { creada = null; console.error('Postgres:', e.message); throw e; });
  preparar().catch(() => {});
  return {
    async todos() {
      await preparar();
      const { rows } = await pool.query(`SELECT id, doc FROM ${nombre} ORDER BY id`);
      return rows.map(r => ({ ...r.doc, id: r.id }));
    },
    async guardar(d) {
      await preparar();
      if (d.id) await pool.query(`UPDATE ${nombre} SET doc = $2 WHERE id = $1`, [d.id, d]);
      else d.id = (await pool.query(`INSERT INTO ${nombre} (doc) VALUES ($1) RETURNING id`, [d])).rows[0].id;
      return d;
    },
    async borrar(id) {
      await preparar();
      await pool.query(`DELETE FROM ${nombre} WHERE id = $1`, [id]);
    },
  };
}

const crear = nombre => process.env.DATABASE_URL ? coleccionPostgres(process.env.DATABASE_URL, nombre) : coleccionFichero(nombre);

module.exports = { tickets: crear('tickets'), clientes: crear('clientes') };
