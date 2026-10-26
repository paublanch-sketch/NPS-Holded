// Dashboard Servicio Holded — servidor sin dependencias (Node 18+).
// Fuentes: tickets (Google Sheet publicado como CSV) y comercial (API de Holded).
// Sin variables de entorno usa los datos de ejemplo de data/.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || '';
const HOLDED_API_KEY = process.env.HOLDED_API_KEY || '';
const DASH_USER = process.env.DASH_USER || '';
const DASH_PASS = process.env.DASH_PASS || '';

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

async function cargarTickets() {
  const csv = SHEET_CSV_URL
    ? await (await fetch(SHEET_CSV_URL)).text()
    : fs.readFileSync(path.join(__dirname, 'data', 'tickets-ejemplo.csv'), 'utf8');
  return parseCSV(csv).map(t => ({
    ...t,
    horas: parseFloat(String(t.horas || '0').replace(',', '.')) || 0,
    nps: t.nps === '' || t.nps == null ? null : Number(t.nps),
  }));
}

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
    return {
      abiertas: abiertas.length,
      fueraSla,
      excedidoMin: excedido,
      horasMes: +lista.filter(t => (t.entrada || '').startsWith(mes)).reduce((s, t) => s + t.horas, 0).toFixed(1),
      horasTotal: +lista.reduce((s, t) => s + t.horas, 0).toFixed(1),
      valoracion: notas.length ? +(notas.reduce((a, b) => a + b, 0) / notas.length / 2).toFixed(1) : null, // NPS 0–10 → /5
      casos: abiertas.map(t => ({
        cliente: t.cliente, origen: t.tipo_cliente, canal: t.canal, tipo: t.tipo_incidencia,
        entrada: t.entrada, esperaMin: minutos(t.entrada, t.primera_respuesta || ahora),
        respondido: !!t.primera_respuesta, horas: t.horas,
      })),
    };
  };
  const por = (srv, tipo) => tickets.filter(t => t.servicio === srv && (!tipo || t.tipo_cliente === tipo));
  return {
    actualizado: ahora.toISOString(),
    sla: SLA_MIN,
    implementacion: bloque(por('Implementación')),
    premium: bloque(por('Premium')),
    porTipo: {
      'Premium · Gestoría / Asesoría': bloque(por('Premium', 'Gestoría')),
      'Premium · Cliente directo': bloque(por('Premium', 'Directo')),
      'Implementación · Referenciado por gestoría': bloque(por('Implementación', 'Gestoría')),
      'Implementación · Cliente directo': bloque(por('Implementación', 'Directo')),
    },
    horasPorCliente: Object.entries(tickets.reduce((m, t) => (m[t.cliente] = (m[t.cliente] || 0) + t.horas, m), {}))
      .map(([cliente, horas]) => ({ cliente, horas: +horas.toFixed(1) })).sort((a, b) => b.horas - a.horas),
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

http.createServer(async (req, res) => {
  if (!autorizado(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Servicio Holded"' });
    return res.end('Acceso restringido');
  }
  try {
    if (req.url.startsWith('/api/resumen')) {
      const [t, c] = await Promise.all([cargarTickets(), cargarComercial()]);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(resumen(t, c)));
    }
    if (req.url === '/salud') { res.writeHead(200); return res.end('ok'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, () => console.log(`Dashboard en http://localhost:${PORT}`));
