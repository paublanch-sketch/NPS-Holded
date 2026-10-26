// Almacén de tickets. Con DATABASE_URL usa Postgres (una fila JSONB por ticket);
// sin ella, un fichero JSON local para desarrollo. Render borra el disco en cada
// despliegue, así que en producción hace falta Postgres.
const fs = require('fs');
const path = require('path');

const FICHERO = path.join(__dirname, 'data', 'tickets.json');

function almacenFichero() {
  const leer = () => { try { return JSON.parse(fs.readFileSync(FICHERO, 'utf8')); } catch { return []; } };
  const escribir = l => fs.writeFileSync(FICHERO, JSON.stringify(l, null, 1));
  return {
    async todos() { return leer(); },
    async guardar(t) {
      const l = leer();
      if (!t.id) t.id = l.reduce((m, x) => Math.max(m, x.id), 0) + 1;
      const i = l.findIndex(x => x.id === t.id);
      i >= 0 ? (l[i] = t) : l.push(t);
      escribir(l);
      return t;
    },
  };
}

function almacenPostgres(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: url.includes('localhost') ? false : { rejectUnauthorized: false } });
  const listo = pool.query('CREATE TABLE IF NOT EXISTS tickets (id SERIAL PRIMARY KEY, doc JSONB NOT NULL)');
  return {
    async todos() {
      await listo;
      const { rows } = await pool.query('SELECT id, doc FROM tickets ORDER BY id');
      return rows.map(r => ({ ...r.doc, id: r.id }));
    },
    async guardar(t) {
      await listo;
      if (t.id) await pool.query('UPDATE tickets SET doc = $2 WHERE id = $1', [t.id, t]);
      else t.id = (await pool.query('INSERT INTO tickets (doc) VALUES ($1) RETURNING id', [t])).rows[0].id;
      return t;
    },
  };
}

module.exports = process.env.DATABASE_URL ? almacenPostgres(process.env.DATABASE_URL) : almacenFichero();
