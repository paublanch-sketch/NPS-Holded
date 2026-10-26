// Servicio Holded: portal de soporte, consola del técnico y dashboard (Node 18+).
// Fuentes: tickets de la app, histórico del Google Sheet (CSV, opcional) y comercial (API de Holded).
const http = require('http');
const fs = require('fs');
const path = require('path');
const tickets = require('./tickets');

const PORT = process.env.PORT || 3000;
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || '';
const HOLDED_API_KEY = process.env.HOLDED_API_KEY || '';
const DASH_USER = process.env.DASH_USER || '';
const DASH_PASS = process.env.DASH_PASS || '';
const TECNICOS = (process.env.TECNICOS || 'Blanch,David,Pablo,Pako').split(',').map(s => s.trim()).filter(Boolean);

const SLA_MIN = 60;           // primera respuesta en menos de 1h
const RESPUESTA_CLIENTE = 15; // días máximos para que el cliente firme/pague

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

// Tickets de la app más el histórico del Sheet, si se ha publicado su CSV.
async function cargarTickets() {
  const historico = SHEET_CSV_URL
    ? parseCSV(await (await fetch(SHEET_CSV_URL)).text()).map(normalizar).filter(esHolded)
    : [];
  return [...historico, ...(await tickets.paraDashboard())];
}

// "13/01/2026 18:05:46" o "2/02/2026" → ISO local "2026-01-13T18:05"
function fecha(s) {
  const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return '';
  const p = n => String(n).padStart(2, '0');
  return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${p(m[2])}-${p(m[1])}T${p(m[4] || 0)}:${p(m[5] || 0)}`;
}

// Columnas del Google Form de incidencias. Servicio, tipo de cliente, canal y
// primera respuesta aún no existen en el Sheet: se usan si algún día se añaden.
function normalizar(r) {
  const g = (...k) => k.map(x => r[x]).find(v => v != null && v !== '') || '';
  const nps = g('Puntuación', 'nps');
  return {
    cliente: g('Nombre de la empresa / autónomo', 'cliente'),
    tipo_incidencia: g('Tipo de Incidencia', 'tipo_incidencia'),
    descripcion: g('Describe la incidencia técnica'),
    tecnico: g('Técnico', 'tecnico'),
    estado: g('Estado', 'estado') || 'Nuevo',
    entrada: fecha(g('Marca temporal')) || g('entrada'),
    cierre: fecha(g('Cierre')) || g('cierre'),
    primera_respuesta: g('Primera respuesta', 'primera_respuesta'),
    horas: parseFloat(g('T', 'horas').replace(',', '.')) || 0,
    nps: nps === '' ? null : Number(nps),
    mejora: g('Mejora', 'mejora'),
    servicio: g('Servicio', 'servicio') || 'Soporte Holded',
    tipo_cliente: g('Tipo de cliente', 'tipo_cliente') || 'Sin clasificar',
    canal: g('Canal', 'canal') || 'Formulario',
  };
}

// Solo lo de Holded: tipo Holded, o cualquier ticket de Blanch (todos los suyos son Holded).
const esHolded = t => t.cliente && (/holded/i.test(t.tipo_incidencia) || /blanch/i.test(t.tecnico));

// Presupuestos de Holded. En teoría status 1 = aceptado; el cobro sale de la factura enlazada.
async function cargarComercial() {
  if (!HOLDED_API_KEY) {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'comercial-ejemplo.json'), 'utf8'));
  }
  const h = { key: HOLDED_API_KEY };
  const base = 'https://api.holded.com/api/invoicing/v1/documents/';
  const [estimates, invoices] = await Promise.all([
    fetch(base + 'estimate', { headers: h }).then(r => r.json()),
    fetch(base + 'invoice', { headers: h }).then(r => r.json()),
  ]);
  const pagada = new Map(invoices.map(f => [f.id, f.paymentsPending === 0]));
  return estimates.map(e => {
    let estado = 'Enviado';
    if (e.status === 1) estado = pagada.get(e.invoiceId) ? 'Pagado' : 'Firmado, pendiente de pago';
    if (e.status === 2) estado = 'Rechazado';
    return {
      cliente: e.contactName, documento: e.docNumber, tipo: e.tags?.includes('licencia') ? 'Licencia' : 'Presupuesto',
      importe: e.total, fecha: new Date(e.date * 1000).toISOString().slice(0, 10), estado,
    };
  });
}

const minutos = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);

function resumen(tickets, comercial, ahora = new Date()) {
  const bloque = (lista) => {
    const abiertas = lista.filter(t => t.estado !== 'Cerrado');
    const excedido = abiertas.reduce((s, t) => {
      const espera = minutos(t.entrada, t.primera_respuesta || ahora);
      return s + Math.max(0, espera - SLA_MIN);
    }, 0);
    const fueraSla = lista.filter(t => minutos(t.entrada, t.primera_respuesta || ahora) > SLA_MIN).length;
    const notas = lista.map(t => t.nps).filter(n => n != null);
    const mes = ahora.toISOString().slice(0, 7);
    const cerrados = lista.filter(t => t.estado === 'Cerrado' && t.cierre && t.entrada);
    const dias = cerrados.map(t => minutos(t.entrada, t.cierre) / 1440).filter(d => d >= 0);
    return {
      total: lista.length,
      cerradosMes: cerrados.filter(t => t.cierre.startsWith(mes)).length,
      diasCierre: dias.length ? +(dias.reduce((a, b) => a + b, 0) / dias.length).toFixed(1) : null,
      abiertas: abiertas.length,
      fueraSla,
      excedidoMin: excedido,
      horasMes: +lista.filter(t => (t.entrada || '').startsWith(mes)).reduce((s, t) => s + t.horas, 0).toFixed(1),
      horasTotal: +lista.reduce((s, t) => s + t.horas, 0).toFixed(1),
      valoracion: notas.length ? +(notas.reduce((a, b) => a + b, 0) / notas.length / 2).toFixed(1) : null, // NPS 0–10 → /5
      casos: abiertas.map(t => ({
        cliente: t.cliente, origen: t.tipo_cliente, canal: t.canal, tipo: t.tipo_incidencia, tecnico: t.tecnico, estado: t.estado,
        entrada: t.entrada, esperaMin: minutos(t.entrada, t.primera_respuesta || ahora),
        respondido: !!t.primera_respuesta, horas: t.horas,
      })),
    };
  };
  const agrupar = clave => Object.entries(tickets.reduce((m, t) => ((m[clave(t)] ||= []).push(t), m), {}));
  const horasPor = clave => agrupar(clave)
    .map(([nombre, l]) => ({ nombre, tickets: l.length, horas: +l.reduce((s, t) => s + t.horas, 0).toFixed(1) }))
    .sort((a, b) => b.horas - a.horas);
  return {
    actualizado: ahora.toISOString(),
    sla: SLA_MIN,
    servicios: agrupar(t => t.servicio).map(([nombre, l]) => ({ nombre, ...bloque(l) })),
    porTipo: Object.fromEntries(agrupar(t => `${t.servicio} · ${t.tipo_cliente}`).map(([n, l]) => [n, bloque(l)])),
    horasPorCliente: horasPor(t => t.cliente),
    horasPorTecnico: horasPor(t => t.tecnico || 'Sin asignar'),
    mejoras: tickets.filter(t => t.mejora).map(t => ({ cliente: t.cliente, nps: t.nps, mejora: t.mejora })),
    comercial: comercial.map(c => ({ ...c, dias: Math.floor((ahora - new Date(c.fecha)) / 86400000) })),
    diasRespuesta: RESPUESTA_CLIENTE,
  };
}

function autorizado(req) {
  if (!DASH_USER) return true;
  const [tipo, val] = (req.headers.authorization || '').split(' ');
  return tipo === 'Basic' && Buffer.from(val || '', 'base64').toString() === `${DASH_USER}:${DASH_PASS}`;
}

const pagina = (res, nombre) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(path.join(__dirname, 'public', nombre)).pipe(res);
};

http.createServer(async (req, res) => {
  const ruta = req.url.split('?')[0];
  try {
    // Público: el portal del cliente y su API por token.
    if (ruta === '/salud') { res.writeHead(200); return res.end('ok'); }
    if (ruta === '/soporte') return pagina(res, 'soporte.html');
    if (await tickets.rutasPublicas(req, res, ruta)) return;

    if (!autorizado(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Servicio Holded"' });
      return res.end('Acceso restringido');
    }
    if (ruta === '/api/resumen') {
      const [t, c] = await Promise.all([cargarTickets(), cargarComercial()]);
      return tickets.json(res, resumen(t, c));
    }
    if (ruta === '/api/config') return tickets.json(res, { tecnicos: TECNICOS });
    if (await tickets.rutasConsola(req, res, ruta)) return;
    if (ruta === '/consola') return pagina(res, 'consola.html');
    pagina(res, 'index.html');
  } catch (e) {
    console.error(e);
    tickets.json(res, { error: e.message }, e.status || 500);
  }
}).listen(PORT, () => console.log(`Dashboard en http://localhost:${PORT}`));
