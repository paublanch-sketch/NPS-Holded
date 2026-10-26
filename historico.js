// Lectura del CSV del antiguo Google Form de incidencias (el Sheet que se deja de usar).

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter(r => r.some(Boolean))
    .map(r => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] || '').trim()])));
}

// "13/01/2026 18:05:46" o "2/02/2026" → ISO local "2026-01-13T18:05"
function fecha(s) {
  const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return '';
  const p = n => String(n).padStart(2, '0');
  return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${p(m[2])}-${p(m[1])}T${p(m[4] || 0)}:${p(m[5] || 0)}`;
}

// Columnas del Google Form de incidencias. Las horas («T») llegan con coma o punto.
function normalizar(r) {
  const g = (...k) => k.map(x => r[x]).find(v => v != null && v !== '') || '';
  const nps = g('Puntuación', 'nps');
  return {
    cliente: g('Nombre de la empresa / autónomo', 'cliente'),
    email: g('Correo electrónico de contacto').toLowerCase(),
    tipo_incidencia: g('Tipo de Incidencia', 'tipo_incidencia'),
    descripcion: g('Describe la incidencia técnica'),
    comentario: g('Comentarios internos'),
    tecnico: g('Técnico', 'tecnico'),
    estado: g('Estado', 'estado') || 'Nuevo',
    entrada: fecha(g('Marca temporal')) || g('entrada'),
    cierre: fecha(g('Cierre')) || g('cierre'),
    horas: parseFloat(g('T', 'horas').replace(',', '.')) || 0,
    nps: nps === '' ? null : Number(nps),
  };
}

// Solo lo de Holded: tipo Holded, o cualquier ticket de Blanch (todos los suyos son Holded).
const esHolded = t => t.cliente && (/holded/i.test(t.tipo_incidencia) || /blanch/i.test(t.tecnico));

module.exports = { parseCSV, normalizar, esHolded };
