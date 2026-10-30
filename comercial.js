// Parte comercial (reunión con Pablo y Operaciones, 28/10/2026): solo Holded, y aparte del soporte.
//   · Licencias de Holded de cada cliente (plan, alta, renovación e importe): renovaciones de los
//     próximos 30 y 60 días, bajas con su motivo y churn. Se apuntan en la ficha de cada cliente
//     (29/10/2026: fuera el botón de importar el Excel de licencias).
//   · ARR: licencias de Holded + Soporte Premium (42 €/mes; las asesorías partner, gratis) + Super Gemas.
//   · Seguimiento comercial de cada cliente: notas sin minutos (llamadas, correos, reuniones), que
//     ve todo el equipo. Las llamadas de soporte siguen en el ticket, con sus minutos.
//   · Asesorías partner: embudo, convenio enviado y firmado en línea (con aviso a Operaciones para
//     hacer el onboarding) y los clientes que referencia cada una.
//   · Super Gemas: las cuentas se traen de su base de datos (SUPERGEMAS_URL + SUPERGEMAS_CLAVE) y
//     aquí se marca si pagan o son gratis, que Super Gemas no lo sabe.
// Hosting, dominios y marketing quedan fuera hasta que Operaciones dé el visto bueno.
const crypto = require('crypto');
const { clientes, ajustes, tickets, cuentas } = require('./store');
const adj = require('./adjuntos');
const cli = require('./clientes');

const PREMIUM_EUROS_MES = 42; // 29/10/2026: eran 40
const ETAPAS = ['Por contactar', 'Contactada', 'En negociación', 'Convenio enviado', 'Convenio firmado', 'Partner activa', 'Descartada'];
const FIRMADAS = ['Convenio firmado', 'Partner activa'];
const MOTIVOS_BAJA = ['Precio', 'No lo usa o no lo necesita', 'Le resulta difícil', 'Se va a otro programa', 'Cierra o vende el negocio', 'Lo decide su asesoría', 'No contesta', 'Otro'];
const TIPOS_NOTA = ['Llamada', 'Correo', 'Reunión', 'WhatsApp', 'Nota'];
const DIAS_FIRMA = 30;

const error = (msg, status = 400) => Object.assign(new Error(msg), { status });
const pad = n => String(n).padStart(2, '0');
const dia = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const diasHasta = f => Math.round((new Date(f + 'T12:00') - new Date(dia() + 'T12:00')) / 864e5);
const masAnio = f => { const d = new Date(f + 'T12:00'); d.setFullYear(d.getFullYear() + 1); return dia(d); };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const texto = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const URL_PUBLICA = req => (process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`).replace(/\/+$/, '');

// ---- Fechas e importes que se escriben en el panel ----
function valida(a, m, d) {
  const x = new Date(a, m - 1, d);
  return x.getFullYear() === a && x.getMonth() === m - 1 && x.getDate() === d ? dia(x) : null;
}
// 2026-10-28, 28/10/2026, 28-10-26 o el número de serie de Excel. '' si está vacía; null si no se entiende.
function leerFecha(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valida(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) return valida(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 864e5);
    return valida(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  return null;
}
// «1.234,56 €», «1234.56», «99 €/mes». null si no hay número.
function leerImporte(v) {
  let s = String(v ?? '').replace(/[^\d,.-]/g, '');
  if (!/\d/.test(s)) return null;
  const c = s.lastIndexOf(','), p = s.lastIndexOf('.');
  if (c >= 0 && p >= 0) s = c > p ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (c >= 0) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}
const cifNormal = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const planNormal = s => { const t = texto(s, 60).replace(/\s+/g, ' '); return t ? t[0].toUpperCase() + t.slice(1) : ''; };

// ---- Ajustes de la parte comercial: ingreso anual por plan, correos de Asesorías y Operaciones y convenio ----
async function config() {
  const a = (await ajustes.donde('clave', 'comercial'))[0] || { clave: 'comercial' };
  return { precios: {}, operaciones: '', asesorias: '', convenio: null, ...a };
}
async function guardarConfig(cambios) { return ajustes.guardar({ ...(await config()), ...cambios }); }
// 29/10/2026: las asesorías (embudo e invitaciones al convenio) las lleva Pablo; con el convenio
// firmado entra Operaciones para el onboarding.
const correoAsesorias = c => c.asesorias || process.env.ASESORIAS_EMAIL || 'pablo@interactivos.net';
const correoOperaciones = c => c.operaciones || process.env.OPERACIONES_EMAIL || 'operaciones@interactivos.net';

// Lo que deja al año la licencia: su importe si lo tiene; si no, el del plan.
const anualDe = (h, precios) => h.importe != null ? h.importe : (precios[h.plan] ?? null);
const etapaDe = f => f.partner?.etapa || (f.tipo_cliente === 'Asesoría' ? 'Partner activa' : null);
const enPeriodo = (f, desde, hasta) => f && f >= desde && f <= hasta;

// ---- El resumen de la pantalla Comercial ----
function resumen(fs, { desde, hasta }, conf) {
  const precios = conf.precios || {};
  const lic = fs.filter(f => f.holded);
  const activas = lic.filter(f => f.holded.estado !== 'Baja');
  const suma = l => Math.round(l.reduce((s, x) => s + (x || 0), 0) * 100) / 100;
  const fila = f => ({ cliente: f.nombre, plan: f.holded.plan || 'Sin plan', renovacion: f.holded.renovacion || '', dias: f.holded.renovacion ? diasHasta(f.holded.renovacion) : null,
    anual: anualDe(f.holded, precios), ultimaNota: (f.seguimiento || []).at(-1) || null, ejemplo: !!f.ejemplo });

  const porPlan = new Map();
  for (const f of activas) {
    const p = f.holded.plan || 'Sin plan', x = porPlan.get(p) || { plan: p, n: 0, anual: 0, sinImporte: 0 };
    x.n++;
    const a = anualDe(f.holded, precios);
    if (a == null) x.sinImporte++; else x.anual += a;
    porPlan.set(p, x);
  }
  // Renovaciones: lo que vence en 30 días, de 31 a 60, y lo vencido que nadie ha marcado.
  const conFecha = activas.filter(f => f.holded.renovacion).map(fila).sort((a, b) => a.dias - b.dias);
  // Churn del periodo: bajas del periodo sobre las que estaban activas al empezar.
  const bajas = lic.filter(f => f.holded.estado === 'Baja' && enPeriodo(f.holded.baja?.fecha, desde, hasta));
  const alInicio = lic.filter(f => (!f.holded.alta || f.holded.alta < desde) && !(f.holded.estado === 'Baja' && f.holded.baja?.fecha && f.holded.baja.fecha < desde));
  const motivos = new Map();
  for (const f of bajas) {
    const m = f.holded.baja?.motivo || 'Sin indicar', x = motivos.get(m) || { motivo: m, n: 0, clientes: [] };
    x.n++; x.clientes.push({ cliente: f.nombre, fecha: f.holded.baja.fecha, detalle: f.holded.baja.detalle || '', plan: f.holded.plan || '' });
    motivos.set(m, x);
  }

  const premium = fs.filter(f => f.servicio === 'Premium');
  const premiumPago = premium.filter(f => f.tipo_cliente !== 'Asesoría');
  const gemas = fs.filter(f => f.gemas && f.gemas.activa !== false);
  const gemasPago = gemas.filter(f => f.gemas.pago === 'pago');

  const asesorias = fs.filter(etapaDe);
  const porEtapa = Object.fromEntries(ETAPAS.map(e => [e, asesorias.filter(f => etapaDe(f) === e).length]));
  const referidos = fs.filter(f => f.asesoria);

  const arr = { holded: suma(activas.map(f => anualDe(f.holded, precios))), premium: premiumPago.length * PREMIUM_EUROS_MES * 12, gemas: suma(gemasPago.map(f => (f.gemas.eurosMes || 0) * 12)) };
  arr.total = suma([arr.holded, arr.premium, arr.gemas]);
  return {
    desde, hasta, arr,
    licencias: { activas: activas.length, bajas: lic.length - activas.length, sinImporte: activas.filter(f => anualDe(f.holded, precios) == null).length,
      porPlan: [...porPlan.values()].sort((a, b) => b.n - a.n) },
    renovar: { vencidas: conFecha.filter(x => x.dias < 0), d30: conFecha.filter(x => x.dias >= 0 && x.dias <= 30), d60: conFecha.filter(x => x.dias > 30 && x.dias <= 60) },
    churn: { bajas: bajas.length, alInicio: alInicio.length, tasa: alInicio.length ? Math.round(bajas.length / alInicio.length * 1000) / 10 : null, motivos: [...motivos.values()].sort((a, b) => b.n - a.n) },
    premium: { clientes: premium.length, pago: premiumPago.length, asesorias: premium.length - premiumPago.length, eurosMes: PREMIUM_EUROS_MES },
    gemas: { activas: gemas.length, pago: gemasPago.length, gratis: gemas.filter(f => f.gemas.pago === 'gratis').length, sinDecir: gemas.filter(f => !f.gemas.pago).length,
      eurosMes: suma(gemasPago.map(f => f.gemas.eurosMes || 0)), sincronizado: conf.supergemas?.cuando || null, sinUnir: (conf.supergemas?.cuentas || []).filter(c => !c.cliente).length },
    activos: { holded: activas.length, premium: premium.length, gemas: gemas.length, kitDigital1: fs.filter(f => f.servicio === 'Kit Digital 1').length, implementacion: fs.filter(f => f.servicio === 'Implementación').length },
    asesorias: { total: asesorias.filter(f => etapaDe(f) !== 'Descartada').length, porEtapa, partners: asesorias.filter(f => FIRMADAS.includes(etapaDe(f))).length,
      pendientesOnboarding: asesorias.filter(f => etapaDe(f) === 'Convenio firmado').map(f => ({ cliente: f.nombre, firmado: f.partner?.convenio?.firmado?.fecha || null })),
      referidos: referidos.length },
    ejemplo: fs.some(f => f.ejemplo && (f.holded || f.gemas || f.partner)),
  };
}

// ---- Fichas: buscar, cambiar y anotar ----
async function ficha(nombre) {
  const f = (await clientes.todos()).find(x => x.nombre === nombre);
  if (!f) throw error('Ese cliente no existe', 404);
  return f;
}
const nota = (f, tipo, txt, autor) => {
  f.seguimiento = [...(f.seguimiento || []), { id: crypto.randomBytes(6).toString('hex'), fecha: new Date().toISOString(), tipo: TIPOS_NOTA.includes(tipo) ? tipo : 'Nota', texto: texto(txt, 2000), autor: texto(autor, 60) }];
};

// Lo que viaja al panel de cada ficha: sin el enlace secreto del convenio ni la imagen de la firma.
function vistaFicha(f) {
  const p = f.partner;
  return {
    holded: f.holded || null, gemas: f.gemas || null, asesoria: f.asesoria || '', seguimiento: f.seguimiento || [],
    partner: etapaDe(f) ? { etapa: etapaDe(f), onboarding: p?.onboarding || null, contacto: p?.contacto || '', cambios: p?.cambios || [],
      convenio: p?.convenio ? { enviado: p.convenio.enviado, email: p.convenio.email, nombre: p.convenio.nombre, caduca: p.convenio.caduca,
        documento: p.convenio.documentoNombre || '', firmado: p.convenio.firmado ? { nombre: p.convenio.firmado.nombre, nif: p.convenio.firmado.nif, cargo: p.convenio.firmado.cargo, fecha: p.convenio.firmado.fecha } : null } : null } : null,
  };
}

function cambiarEtapa(f, etapa, autor = '') {
  if (!ETAPAS.includes(etapa)) throw error('Etapa desconocida');
  const antes = etapaDe(f);
  f.partner = { ...(f.partner || {}), etapa, cambios: [...(f.partner?.cambios || []), { fecha: new Date().toISOString(), etapa }] };
  f.tipo_cliente = 'Asesoría';
  // Con el convenio firmado es partner: soporte Premium gratis.
  // Con cli.ponerServicio, para que lo de antes del cambio siga en el servicio de antes (30/10/2026).
  if (FIRMADAS.includes(etapa)) cli.ponerServicio(f, 'Premium');
  // Si vuelve atrás (o se descarta), deja de serlo: su Premium era el gratis del convenio (29/10/2026).
  else if (FIRMADAS.includes(antes) && f.servicio === 'Premium') cli.ponerServicio(f, 'Sin clasificar');
  if (etapa === 'Partner activa' && !f.partner.onboarding) f.partner.onboarding = new Date().toISOString();
  if (etapa !== 'Partner activa' && antes === 'Partner activa') f.partner.onboarding = null;
  if (antes !== etapa) nota(f, 'Nota', `Etapa: ${antes || 'nueva'} → ${etapa}`, autor || 'Panel');
}

// ---- Convenio de partner: documento, envío y firma ----
async function documentoConvenio(id) {
  const a = id ? await adj.adjuntos.uno(id) : null;
  if (!a || a.ticket !== 'convenio') throw error('No hay convenio subido', 404);
  return a;
}
async function enviarConvenio(req, { cliente, email, nombre, autor }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw error('Pon el correo de quien tiene que firmar');
  const conf = await config();
  if (!conf.convenio?.id) throw error('Sube primero el convenio en PDF (Asesorías → Convenio de partner)');
  const doc = await documentoConvenio(conf.convenio.id);
  const f = await ficha(cliente);
  if (f.partner?.convenio?.firmado) throw error('Esta asesoría ya ha firmado el convenio', 409);
  const token = crypto.randomBytes(24).toString('hex');
  f.partner = { ...(f.partner || {}) };
  f.partner.convenio = { token: sha(token), enviado: new Date().toISOString(), caduca: Date.now() + DIAS_FIRMA * 864e5, email, nombre: texto(nombre, 120),
    documento: doc.id, documentoNombre: doc.nombre, hashDoc: sha(Buffer.from(doc.datos, 'base64')) };
  if (!['Convenio firmado', 'Partner activa'].includes(etapaDe(f))) cambiarEtapa(f, 'Convenio enviado', autor);
  nota(f, 'Correo', `Convenio enviado a ${email} para firmar.`, autor || 'Panel');
  await clientes.guardar(f);
  const url = `${URL_PUBLICA(req)}/firma/${token}`;
  const correo = require('./correo');
  let enviado = false;
  if (correo.hayCorreo()) {
    const saludo = `Hola${nombre ? ' ' + texto(nombre).split(' ')[0] : ''}:`;
    const cuerpo = `${saludo}\n\nTe enviamos el convenio de asesoría partner de Interactivos para ${f.nombre}. Puedes leerlo y firmarlo en línea con el botón, desde el ordenador o el móvil.\n\nEl enlace vale ${DIAS_FIRMA} días. Si tienes cualquier duda, responde a este correo.`;
    const ases = correoAsesorias(await config());
    try {
      enviado = await correo.enviarSinEsperar({ to: email, bcc: ases, replyTo: ases, subject: `Convenio de asesoría partner · ${f.nombre}`, text: `${cuerpo}\n\nLeer y firmar: ${url}`,
        html: correo.plantilla({ titulo: 'Convenio de asesoría partner', cuerpo: correo.parrafos(cuerpo), boton: { texto: 'Leer y firmar el convenio', url }, pie: 'Correo enviado por Interactivos.' }) });
    } catch (e) { console.error('Convenio (envío):', e.message); }
  }
  return { enviado, enlace: enviado ? null : url, correoCaido: !enviado && correo.envioCaido() };
}

async function porToken(token) {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const h = sha(token);
  return (await clientes.todos()).find(f => f.partner?.convenio?.token === h) || null;
}
// La IP como en el login (auth.ipDe); en el justificante va también la cadena X-Forwarded-For entera.
const ipDe = req => require('./auth').ipDe(req);

async function firmar(req, f, b) {
  const c = f.partner.convenio;
  if (c.firmado) throw error('Este convenio ya está firmado', 409);
  if (c.caduca < Date.now()) throw error('El enlace ha caducado. Pide que te lo envíen de nuevo.', 410);
  const nombre = texto(b.nombre, 120), nif = cifNormal(b.nif).slice(0, 12), cargo = texto(b.cargo, 80);
  if (nombre.length < 3) throw error('Pon tu nombre y apellidos');
  if (!/^[A-Z0-9]{8,10}$/.test(nif)) throw error('Pon tu DNI o NIE');
  if (b.acepto !== true) throw error('Marca que has leído y aceptas el convenio');
  const firma = String(b.firma || '');
  const png = firma.startsWith('data:image/png;base64,') ? Buffer.from(firma.slice(22), 'base64') : null;
  if (!png || png.length < 200 || png.length > 300000 || png.toString('latin1', 1, 4) !== 'PNG') throw error('Firma en el recuadro antes de enviar');
  c.firmado = { nombre, nif, cargo, fecha: new Date().toISOString(), ip: ipDe(req), reenvios: texto(req.headers['x-forwarded-for'], 300), navegador: texto(req.headers['user-agent'], 300), firma };
  cambiarEtapa(f, 'Convenio firmado', nombre);
  nota(f, 'Nota', `Convenio firmado en línea por ${nombre}${cargo ? ` (${cargo})` : ''}. Toca hacer el onboarding.`, nombre);
  await clientes.guardar(f);
  // Aviso a Operaciones para el onboarding y copia a quien firma.
  const correo = require('./correo');
  if (correo.hayCorreo()) {
    const conf = await config(), ops = correoOperaciones(conf), ases = correoAsesorias(conf);
    const panel = `${URL_PUBLICA(req)}/admin#/clientes/${encodeURIComponent(f.nombre)}`;
    if (ops) {
      const t = `${f.nombre} ha firmado el convenio de asesoría partner.\n\nFirma: ${nombre}${cargo ? `, ${cargo}` : ''} (${nif}), el ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}.\n\nToca hacer el onboarding. Cuando esté hecho, márcalo en su ficha del panel.`;
      correo.enviar({ to: ops, cc: ases !== ops ? ases : undefined, subject: `Convenio firmado: ${f.nombre} · toca el onboarding`, text: `${t}\n\n${panel}`,
        html: correo.plantilla({ titulo: 'Convenio firmado', cuerpo: correo.parrafos(t), boton: { texto: 'Abrir su ficha', url: panel }, pie: 'Aviso del panel de Soporte Holded.' }) })
        .catch(e => console.error('Convenio (aviso a Operaciones):', e.message));
    }
    const t2 = `Hola ${nombre.split(' ')[0]}:\n\nHas firmado el convenio de asesoría partner de Interactivos en nombre de ${f.nombre}. Gracias por confiar en nosotros.\n\nEn unos días te escribiremos para empezar. Desde el enlace puedes volver a ver el convenio y el justificante de la firma.`;
    correo.enviar({ to: c.email, replyTo: ops || ases, subject: `Convenio firmado · ${f.nombre}`, text: t2,
      html: correo.plantilla({ titulo: 'Convenio firmado', cuerpo: correo.parrafos(t2), pie: 'Correo enviado por Interactivos.' }) })
      .catch(e => console.error('Convenio (copia):', e.message));
  }
  return f;
}

// Justificante de la firma: quién, cuándo, desde dónde y qué documento (su huella SHA-256).
function justificante(f) {
  const c = f.partner?.convenio, x = c?.firmado;
  if (!x) throw error('Esta asesoría aún no ha firmado', 404);
  const h = s => String(s ?? '').replace(/[&<>"']/g, k => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[k]));
  const fila = (k, v) => `<tr><th>${k}</th><td>${h(v)}</td></tr>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Justificante de firma · ${h(f.nombre)}</title>
<style>body{font:14px/1.5 Inter,system-ui,sans-serif;color:#1c2230;max-width:720px;margin:32px auto;padding:0 16px}h1{font-size:20px;margin:0 0 4px}p{color:#5b6472;margin:0 0 20px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e6e8ec;vertical-align:top}th{width:200px;color:#5b6472;font-weight:600}
td{overflow-wrap:anywhere}.firma{margin-top:20px;border:1px solid #e6e8ec;border-radius:10px;padding:10px;display:inline-block}.firma img{max-width:100%;height:auto;display:block}
button{margin-top:24px;font:inherit;padding:8px 14px;border-radius:9px;border:1px solid #d8dce3;background:#fff;cursor:pointer}@media print{button{display:none}}</style></head><body>
<h1>Justificante de firma del convenio de asesoría partner</h1><p>Firma electrónica hecha en línea desde el enlace que se envió a ${h(c.email)}.</p>
<table>${fila('Asesoría', f.nombre)}${fila('Firmado por', x.nombre)}${fila('DNI / NIE', x.nif)}${x.cargo ? fila('Cargo', x.cargo) : ''}
${fila('Fecha y hora', new Date(x.fecha).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'long', timeStyle: 'medium' }))}
${fila('Dirección IP', x.ip)}${x.reenvios && x.reenvios !== x.ip ? fila('Cadena de proxies (X-Forwarded-For)', x.reenvios) : ''}${fila('Navegador', x.navegador)}${fila('Documento', c.documentoNombre || 'Convenio')}${fila('Huella del documento (SHA-256)', c.hashDoc || '')}
${fila('Enviado a firmar', new Date(c.enviado).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'long', timeStyle: 'short' }))}</table>
<div class="firma"><img src="${h(x.firma)}" alt="Firma de ${h(x.nombre)}"></div>
<div><button type="button" onclick="print()">Imprimir o guardar en PDF</button></div></body></html>`;
}
function servirHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
  res.end(html);
}

// ---- Super Gemas ----
// El endpoint de Super Gemas (api/soporte_cuentas.php) da sus cuentas con la cron_clave. Cada cuenta
// se une a su cliente por correo o por el nombre de la empresa; las que no, quedan para unirlas a mano.
async function traerGemas() {
  const url = process.env.SUPERGEMAS_URL || 'https://supergemas.interactivos.net/api/soporte_cuentas.php';
  const clave = process.env.SUPERGEMAS_CLAVE;
  if (!clave) throw error('Falta SUPERGEMAS_CLAVE en Render: es la cron_clave del config.local.php de Super Gemas.', 503);
  let d;
  try {
    const r = await fetch(url, { headers: { 'X-Clave-Cron': clave, Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error(r.status === 404 ? 'falta subir api/soporte_cuentas.php a Super Gemas' : r.status === 403 ? 'la clave no es la cron_clave de Super Gemas' : `responde ${r.status}`);
    d = await r.json();
  } catch (e) { throw error(`Super Gemas: ${e.message}`, 502); }
  return unirGemas((d.cuentas || []).filter(c => !c.demo));
}
async function unirGemas(lista) {
  const fs = (await clientes.todos()).filter(f => !f.ejemplo);
  const suyos = (await tickets.todos()).filter(t => !t.ejemplo);
  const correos = new Map();
  for (const t of suyos) if (t.email) correos.set(t.email.toLowerCase(), t.cliente);
  for (const c of await cuentas.todos()) correos.set(c.email, c.cliente);
  for (const f of fs) { if (f.email) correos.set(f.email.toLowerCase(), f.nombre); if (f.gemas?.cuenta) correos.set(f.gemas.cuenta, f.nombre); }
  const conf = await config();
  const antes = new Map((conf.supergemas?.cuentas || []).map(c => [c.email, c.cliente]));
  // 29/10/2026: un nombre que ya no existe (un cliente fusionado) no vale, y uno que solo tiene
  // incidencias recibe su ficha. Antes, los dos paraban la lectura con «Ese cliente no existe».
  const conFicha = new Set(fs.map(f => f.nombre)), ticketDe = new Map(suyos.map(t => [t.cliente, t]));
  const r = { unidas: 0, sinUnir: 0 };
  const guardadas = [];
  for (const c of lista) {
    const email = String(c.email || '').toLowerCase();
    let cliente = [antes.get(email), correos.get(email)].find(n => n && (conFicha.has(n) || ticketDe.has(n))) || null;
    if (!cliente && c.organizacion) {
      const seguros = fs.map(f => f.nombre).filter(n => n.toLowerCase() === String(c.organizacion).toLowerCase() || cli.parecido(c.organizacion, n)?.nivel === 'seguro');
      if (seguros.length === 1) cliente = seguros[0];
    }
    const cuenta = { id: c.id, email, nombre: texto(c.nombre, 120), organizacion: texto(c.organizacion, 160), alta: String(c.alta || '').slice(0, 10), baja: !!c.baja,
      holded: !!c.holded, ultimoUso: c.ultimo_uso || null, asesoria: texto(c.asesoria, 160), cliente };
    guardadas.push(cuenta);
    if (!cliente) { r.sinUnir++; continue; }
    if (!conFicha.has(cliente)) {
      await clientes.guardar({ nombre: cliente, ...cli.clasificar(ticketDe.get(cliente), new Map()) });
      conFicha.add(cliente);
    }
    await ponerGemas(cliente, cuenta);
    r.unidas++;
  }
  await guardarConfig({ supergemas: { cuando: new Date().toISOString(), cuentas: guardadas } });
  return r;
}
async function ponerGemas(cliente, c) {
  const f = await ficha(cliente);
  f.gemas = { ...(f.gemas || {}), cuenta: c.email, idSG: c.id, alta: c.alta || f.gemas?.alta || '', activa: !c.baja, holded: c.holded, ultimoUso: c.ultimoUso, sincronizado: new Date().toISOString() };
  await clientes.guardar(f);
}

// ---- Rutas del panel ----
async function rutas(req, res, ruta, { json, leerCuerpo }) {
  if (!ruta.startsWith('/api/comercial') && !ruta.startsWith('/api/asesorias')) return false;
  const url = new URL(req.url, 'http://x');
  const b = req.method === 'POST' && !['/api/asesorias/convenio'].includes(ruta) ? await leerCuerpo(req) : {};
  const ok = async f => { await clientes.guardar(f); return json(res, { ok: true, ...vistaFicha(f), servicio: f.servicio, tipo_cliente: f.tipo_cliente }), true; };

  if (req.method === 'GET' && ruta === '/api/comercial') {
    const p = k => /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get(k) || '') ? url.searchParams.get(k) : null;
    const hoy = new Date();
    const desde = p('desde') || dia(new Date(hoy.getFullYear(), hoy.getMonth(), 1)), hasta = p('hasta') || dia(hoy);
    return json(res, resumen(await clientes.todos(), { desde, hasta }, await config())), true;
  }
  if (req.method === 'GET' && ruta === '/api/comercial/ajustes') {
    const c = await config();
    return json(res, { precios: c.precios, operaciones: correoOperaciones(c), asesorias: correoAsesorias(c), convenio: c.convenio, etapas: ETAPAS, motivos: MOTIVOS_BAJA, tiposNota: TIPOS_NOTA,
      supergemas: { configurado: !!process.env.SUPERGEMAS_CLAVE, cuando: c.supergemas?.cuando || null, sinUnir: (c.supergemas?.cuentas || []).filter(x => !x.cliente) } }), true;
  }
  if (req.method === 'POST' && ruta === '/api/comercial/ajustes') {
    const cambios = {};
    if (b.precios && typeof b.precios === 'object') {
      cambios.precios = {};
      for (const [k, v] of Object.entries(b.precios).slice(0, 50)) { const n = leerImporte(v); if (texto(k) && n != null) cambios.precios[planNormal(k)] = n; }
    }
    for (const [k, quien] of [['operaciones', 'Operaciones'], ['asesorias', 'Asesorías']]) {
      if (typeof b[k] !== 'string') continue;
      const e = b[k].trim().toLowerCase();
      if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return json(res, { error: `Pon un correo válido para ${quien}` }, 400), true;
      cambios[k] = e;
    }
    await guardarConfig(cambios);
    return json(res, { ok: true }), true;
  }
  if (req.method === 'POST' && ruta === '/api/comercial/licencia') {
    const f = await ficha(b.cliente);
    const alta = leerFecha(b.alta), renovacion = leerFecha(b.renovacion);
    if (alta === null || renovacion === null) return json(res, { error: 'Revisa las fechas' }, 400), true;
    if (b.quitar) { delete f.holded; return ok(f); }
    const importe = b.importe === '' || b.importe == null ? null : leerImporte(b.importe);
    f.holded = { ...(f.holded || { estado: 'Activa' }), plan: planNormal(b.plan), alta, renovacion, importe, cif: texto(b.cif, 20) };
    return ok(f);
  }
  if (req.method === 'POST' && ruta === '/api/comercial/renovada') {
    const f = await ficha(b.cliente);
    if (!f.holded) return json(res, { error: 'Este cliente no tiene licencia de Holded' }, 400), true;
    const hasta = leerFecha(b.hasta) || (f.holded.renovacion ? masAnio(f.holded.renovacion) : masAnio(dia()));
    f.holded = { ...f.holded, estado: 'Activa', renovacion: hasta, renovaciones: [...(f.holded.renovaciones || []), { fecha: dia(), hasta }] };
    delete f.holded.baja;
    nota(f, 'Nota', `Licencia renovada hasta el ${hasta.split('-').reverse().join('/')}.`, b.autor);
    return ok(f);
  }
  if (req.method === 'POST' && ruta === '/api/comercial/baja') {
    const f = await ficha(b.cliente);
    if (!f.holded) return json(res, { error: 'Este cliente no tiene licencia de Holded' }, 400), true;
    if (!MOTIVOS_BAJA.includes(b.motivo)) return json(res, { error: 'Elige el motivo de la baja' }, 400), true;
    const fecha = leerFecha(b.fecha) || dia();
    f.holded = { ...f.holded, estado: 'Baja', baja: { fecha, motivo: b.motivo, detalle: texto(b.detalle, 500) } };
    nota(f, 'Nota', `Baja de Holded: ${b.motivo}${b.detalle ? ` — ${texto(b.detalle, 500)}` : ''}.`, b.autor);
    return ok(f);
  }
  if (req.method === 'POST' && ruta === '/api/comercial/reactivar') {
    const f = await ficha(b.cliente);
    if (!f.holded) return json(res, { error: 'Este cliente no tiene licencia de Holded' }, 400), true;
    f.holded = { ...f.holded, estado: 'Activa' };
    delete f.holded.baja;
    nota(f, 'Nota', 'Licencia de Holded activa otra vez.', b.autor);
    return ok(f);
  }
  if (req.method === 'POST' && ruta === '/api/comercial/gemas') {
    if (b.cuenta && b.unir) {
      const c = ((await config()).supergemas?.cuentas || []).find(x => x.email === b.cuenta);
      if (!c) return json(res, { error: 'Esa cuenta de Super Gemas no está en la última lectura' }, 404), true;
      if (b.crear && !(await clientes.todos()).some(f => f.nombre === b.cliente)) await clientes.guardar({ nombre: texto(b.cliente, 160), servicio: 'Sin clasificar', tipo_cliente: 'Sin clasificar', email: c.email });
      await ponerGemas(b.cliente, c);
      const conf = await config();
      await guardarConfig({ supergemas: { ...conf.supergemas, cuentas: conf.supergemas.cuentas.map(x => x.email === b.cuenta ? { ...x, cliente: b.cliente } : x) } });
      return json(res, { ok: true }), true;
    }
    const f = await ficha(b.cliente);
    if (b.quitar) { delete f.gemas; return ok(f); }
    const euros = b.eurosMes === '' || b.eurosMes == null ? null : leerImporte(b.eurosMes);
    f.gemas = { ...(f.gemas || {}), cuenta: texto(b.cuenta ?? f.gemas?.cuenta, 200).toLowerCase(), activa: b.activa !== false, pago: ['pago', 'gratis'].includes(b.pago) ? b.pago : '', eurosMes: b.pago === 'pago' ? euros : null };
    return ok(f);
  }
  if (req.method === 'POST' && ruta === '/api/comercial/gemas/traer') return json(res, await traerGemas()), true;
  if (req.method === 'POST' && ruta === '/api/comercial/nota') {
    const f = await ficha(b.cliente);
    if (!texto(b.texto)) return json(res, { error: 'Escribe la nota' }, 400), true;
    nota(f, b.tipo, b.texto, b.autor);
    return ok(f);
  }
  if (req.method === 'POST' && ruta === '/api/comercial/nota/borrar') {
    const f = await ficha(b.cliente);
    f.seguimiento = (f.seguimiento || []).filter(n => n.id !== b.id);
    return ok(f);
  }
  // Cliente que nos trae una asesoría partner: queda vinculado a ella y su origen pasa a «Referenciado por asesoría».
  if (req.method === 'POST' && ruta === '/api/comercial/asesoria') {
    const f = await ficha(b.cliente);
    const nombre = texto(b.asesoria, 160);
    if (nombre) {
      const a = await ficha(nombre);
      if (!etapaDe(a)) return json(res, { error: 'Esa no es una asesoría' }, 400), true;
      if (a.nombre === f.nombre) return json(res, { error: 'Una asesoría no se referencia a sí misma' }, 400), true;
      f.asesoria = a.nombre;
      if (f.tipo_cliente !== 'Asesoría') f.tipo_cliente = 'Referenciado por asesoría';
    } else delete f.asesoria;
    return ok(f);
  }

  // ---- Asesorías ----
  if (req.method === 'POST' && ruta === '/api/asesorias/nueva') {
    const nombre = texto(b.nombre, 160);
    if (!nombre) return json(res, { error: 'Falta el nombre' }, 400), true;
    if ((await clientes.todos()).some(f => f.nombre.toLowerCase() === nombre.toLowerCase())) return json(res, { error: 'Ya hay un cliente con ese nombre' }, 409), true;
    const f = { nombre, servicio: 'Sin clasificar', tipo_cliente: 'Asesoría', email: texto(b.email, 200).toLowerCase(), telefono: texto(b.telefono, 40), notas: texto(b.notas, 2000) };
    f.partner = { contacto: texto(b.contacto, 120) };
    cambiarEtapa(f, ETAPAS.includes(b.etapa) ? b.etapa : 'Por contactar', b.autor);
    await clientes.guardar(f);
    return json(res, { ok: true, nombre, servicio: f.servicio }), true;
  }
  if (req.method === 'POST' && ruta === '/api/asesorias/etapa') {
    const f = await ficha(b.cliente);
    if (b.etapa === 'Convenio firmado' && !f.partner?.convenio?.firmado && !b.aMano) return json(res, { error: 'El convenio aún no está firmado' }, 400), true;
    cambiarEtapa(f, b.etapa, b.autor);
    if (b.contacto != null) f.partner.contacto = texto(b.contacto, 120);
    return ok(f);
  }
  if (req.method === 'POST' && ruta === '/api/asesorias/onboarding') {
    const f = await ficha(b.cliente);
    cambiarEtapa(f, b.hecho === false ? 'Convenio firmado' : 'Partner activa', b.autor);
    return ok(f);
  }
  if (req.method === 'POST' && ruta === '/api/asesorias/enviar') return json(res, await enviarConvenio(req, b)), true;
  if (req.method === 'POST' && ruta === '/api/asesorias/anular') {
    const f = await ficha(b.cliente);
    if (f.partner?.convenio?.firmado) return json(res, { error: 'Ya está firmado: no se puede anular' }, 409), true;
    if (f.partner) delete f.partner.convenio;
    if (etapaDe(f) === 'Convenio enviado') cambiarEtapa(f, 'En negociación', b.autor);
    return ok(f);
  }
  // El convenio en PDF: se sube el cuerpo tal cual (8 MB como mucho) y queda como el que se envía.
  if (req.method === 'POST' && ruta === '/api/asesorias/convenio') {
    const nombre = decodeURIComponent(String(req.headers['x-nombre'] || 'convenio.pdf'));
    if (!/\.pdf$/i.test(nombre)) return json(res, { error: 'El convenio tiene que ser un PDF' }, 400), true;
    const buffer = await adj.leerCrudo(req);
    if (buffer.toString('latin1', 0, 5) !== '%PDF-') return json(res, { error: 'Ese archivo no es un PDF' }, 400), true;
    const a = await adj.adjuntos.guardar({ ticket: 'convenio', nombre: nombre.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(-120), tipo: 'application/pdf', tamano: buffer.length, origen: 'panel', fecha: new Date().toISOString(), datos: buffer.toString('base64') });
    const convenio = { id: a.id, nombre: a.nombre, fecha: a.fecha, tamano: a.tamano };
    await guardarConfig({ convenio });
    return json(res, { convenio }), true;
  }
  if (req.method === 'GET' && ruta === '/api/asesorias/convenio') return adj.servir(res, await documentoConvenio((await config()).convenio?.id)), true;
  if (req.method === 'GET' && ruta === '/api/asesorias/justificante') return servirHtml(res, justificante(await ficha(url.searchParams.get('cliente') || ''))), true;
  // Para el aviso del panel: asesorías que han firmado y esperan el onboarding.
  if (req.method === 'GET' && ruta === '/api/asesorias/pendientes') {
    return json(res, (await clientes.todos()).filter(f => etapaDe(f) === 'Convenio firmado').map(f => ({ cliente: f.nombre, firmado: f.partner?.convenio?.firmado?.fecha || null }))), true;
  }
  return false;
}

// ---- Rutas públicas de la firma: /firma/<token> (la página) y /api/firma/<token>… ----
async function rutasFirma(req, res, ruta, { json, leerCuerpo, pagina }) {
  let m = ruta.match(/^\/firma\/([a-f0-9]{48})$/);
  if (m) return pagina(res, 'firma.html'), true;
  m = ruta.match(/^\/api\/firma\/([a-f0-9]{48})(\/convenio\.pdf|\/justificante)?$/);
  if (!m) return false;
  const f = await porToken(m[1]);
  const c = f?.partner?.convenio;
  // Firmado, el enlace sirve para volver a ver el convenio y el justificante tres meses.
  const vale = c && (c.firmado ? Date.now() - new Date(c.firmado.fecha) < 90 * 864e5 : c.caduca > Date.now());
  if (!vale) return json(res, { error: c ? 'El enlace ha caducado. Pide que te lo envíen de nuevo.' : 'Este enlace no existe' }, c ? 410 : 404), true;
  if (req.method === 'GET' && m[2] === '/convenio.pdf') {
    const a = await documentoConvenio(c.documento);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    return adj.servir(res, a), true;
  }
  if (req.method === 'GET' && m[2] === '/justificante') return servirHtml(res, justificante(f)), true;
  if (req.method === 'GET') {
    return json(res, { asesoria: f.nombre, nombre: c.nombre, email: c.email, documento: c.documentoNombre || 'Convenio', caduca: c.caduca,
      firmado: c.firmado ? { nombre: c.firmado.nombre, cargo: c.firmado.cargo, fecha: c.firmado.fecha } : null }), true;
  }
  if (req.method === 'POST' && !m[2]) {
    await firmar(req, f, await leerCuerpo(req));
    return json(res, { ok: true }), true;
  }
  return false;
}

module.exports = { rutas, rutasFirma, vistaFicha, resumen, leerFecha, leerImporte, etapaDe, unirGemas, PREMIUM_EUROS_MES, ETAPAS };
