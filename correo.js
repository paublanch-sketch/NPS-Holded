// Buzones de soporte: IMAP para leer lo que entra y SMTP para responder.
// Uno puede venir de Render (MAIL_USER y MAIL_PASS) y el resto se añaden desde Canales, con la
// contraseña de aplicación cifrada en «ajustes». Con Google Workspace los servidores se deducen
// del registro MX del dominio. Cada buzón lee su carpeta o etiqueta de Gmail (por defecto, la
// bandeja de entrada) y cada ticket guarda en qué buzón entró.
// Con etiqueta, solo abre incidencia lo que se pone en ella; de la bandeja de entrada entran
// únicamente las respuestas a incidencias que ya existen y las del equipo.
const crypto = require('crypto');
const dns = require('dns').promises;
const tickets = require('./tickets');
const { ajustes } = require('./store');

const env = process.env;
const URL_PUBLICA = (env.PUBLIC_URL || '').replace(/\/$/, '');
const enlace = t => `${URL_PUBLICA}/t/${t.token}`;
const INTERVALO = Number(env.IMAP_INTERVALO_S || 60);

const buzones = [];
const estadoVacio = () => ({
  imap: { ok: null, ultimo: null, error: null, procesados: 0, historial: null },
  smtp: { ok: null, ultimo: null, error: null, enviados: 0 },
  deteccion: null,
});
function buzonDe(c, origen) {
  const usuario = String(c.usuario || '').trim().toLowerCase();
  return {
    usuario, clave: String(c.clave || '').replace(/\s+/g, ''),
    imap: c.imap || null, smtp: c.smtp || null,
    imapPuerto: Number(c.imapPuerto || 993), smtpPuerto: Number(c.smtpPuerto || 465),
    carpeta: String(c.carpeta || '').trim() || 'INBOX',
    remitente: c.remitente || `Soporte Holded · Interactivos <${usuario}>`,
    historialDesde: c.historialDesde || null,
    origen, estado: estadoVacio(), transporte: null, revisando: false,
  };
}
const dominioDe = u => String(u || 'soporte.local').split('@')[1] || 'soporte.local';
const listo = b => !!(b && b.usuario && b.clave);

// Contraseñas de los buzones del panel: cifradas con una clave derivada de SESSION_SECRET.
const claveCifrado = () => crypto.createHash('sha256').update('soporte-buzon:' + (env.SESSION_SECRET || '')).digest();
function cifrar(texto) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', claveCifrado(), iv);
  const datos = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), datos].map(b => b.toString('base64')).join('.');
}
function descifrar(s) {
  const [iv, tag, datos] = String(s).split('.').map(b => Buffer.from(b, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', claveCifrado(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(datos), d.final()]).toString('utf8');
}

// Si faltan los servidores y el dominio está en Google, usa los de Gmail.
async function detectarServidores(b) {
  if (!listo(b) || (b.imap && b.smtp)) return;
  try {
    const mx = (await dns.resolveMx(dominioDe(b.usuario))).map(r => r.exchange.toLowerCase());
    if (mx.some(h => /google(mail)?\.com$/.test(h))) {
      b.imap ||= 'imap.gmail.com';
      b.smtp ||= 'smtp.gmail.com';
      b.estado.deteccion = 'Google Workspace (por el registro MX)';
    } else b.estado.deteccion = `Correo en ${mx[0] || 'desconocido'}: pon IMAP_HOST y SMTP_HOST`;
  } catch (e) { b.estado.deteccion = 'No se pudo consultar el MX: ' + e.message; }
}

async function cargarBuzones() {
  buzones.length = 0;
  if (env.MAIL_USER && env.MAIL_PASS) {
    // La etiqueta del buzón de Render se cambia desde Canales (ajuste «buzon-render»).
    const usuario = env.MAIL_USER.trim().toLowerCase();
    let aj = (await ajustes.donde('clave', 'buzon-render')).find(x => x.usuario === usuario);
    // 29/10/2026: el usuario creó en Gmail la etiqueta «Tickets Soporte»: solo entra lo que ponga ahí.
    if (!aj && !env.IMAP_CARPETA) aj = await ajustes.guardar({ clave: 'buzon-render', usuario, carpeta: 'Tickets Soporte', actualizado: new Date().toISOString() });
    buzones.push(buzonDe({
      usuario, clave: env.MAIL_PASS, imap: env.IMAP_HOST, smtp: env.SMTP_HOST,
      imapPuerto: env.IMAP_PORT, smtpPuerto: env.SMTP_PORT, carpeta: aj?.carpeta || env.IMAP_CARPETA, remitente: env.MAIL_FROM,
    }, 'render'));
  }
  for (const d of await ajustes.donde('clave', 'buzon')) {
    if (buzones.some(b => b.usuario === d.usuario)) continue;
    try { buzones.push(Object.assign(buzonDe({ ...d, clave: descifrar(d.cifrada) }, 'panel'), { id: d.id })); }
    catch (e) { console.error(`Correo: no se puede descifrar la contraseña de ${d.usuario} (¿ha cambiado SESSION_SECRET?)`); }
  }
  for (const b of buzones) await detectarServidores(b);
}

function smtp(b) {
  if (!listo(b) || !b.smtp) return null;
  if (!b.transporte) {
    const nodemailer = require('nodemailer');
    b.transporte = nodemailer.createTransport({ host: b.smtp, port: b.smtpPuerto, secure: b.smtpPuerto === 465, auth: { user: b.usuario, pass: b.clave } });
  }
  return b.transporte;
}
// Se responde desde el buzón donde entró el ticket; si no, desde el primero que pueda enviar.
const principal = () => buzones.find(b => smtp(b)) || null;
const buzonPara = t => buzones.find(b => b.usuario === t?.buzon && smtp(b)) || principal();

async function enviar(opciones, b = principal()) {
  const s = smtp(b);
  if (!s) throw new Error('El correo saliente no está configurado');
  try {
    const r = await s.sendMail({ from: b.remitente, replyTo: b.usuario, ...opciones });
    Object.assign(b.estado.smtp, { ok: true, ultimo: new Date().toISOString(), error: null });
    b.estado.smtp.enviados++;
    return r;
  } catch (e) {
    Object.assign(b.estado.smtp, { ok: false, ultimo: new Date().toISOString(), error: e.message });
    throw e;
  }
}

// ---------- Plantilla con la marca (estilos en línea, que es lo que respetan los gestores de correo) ----------
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parrafos = texto => String(texto || '').split(/\n{2,}/).map(p => `<p style="margin:0 0 14px;line-height:1.6">${h(p).replace(/\n/g, '<br>')}</p>`).join('');

function plantilla({ titulo, cuerpo, boton, extra = '', pie }) {
  return `<!doctype html><html lang="es"><body style="margin:0;padding:0;background:#F9F9F8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F9F9F8;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e6e5e1;border-radius:14px;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#1C1C1C;font-size:15px">
<tr><td style="padding:20px 28px;border-bottom:1px solid #e6e5e1;font-weight:800;letter-spacing:3px;font-size:13px">INTERACTIVOS<span style="color:#C81D25">.</span> <span style="font-weight:500;letter-spacing:0;color:#5B616A;margin-left:8px">Soporte Holded</span></td></tr>
<tr><td style="padding:26px 28px 8px">
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${h(titulo)}</h1>
${cuerpo}
${boton ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px"><tr><td style="background:#C81D25;border-radius:10px"><a href="${h(boton.url)}" style="display:inline-block;padding:12px 20px;color:#ffffff;text-decoration:none;font-weight:600">${h(boton.texto)}</a></td></tr></table>` : ''}
${extra}
</td></tr>
<tr><td style="padding:16px 28px 22px;border-top:1px solid #e6e5e1;color:#5B616A;font-size:12px;line-height:1.5">${pie || 'Puedes responder a este correo para añadir información a tu incidencia.'}<br>Interactivos · Holded Solution Partner Platinum</td></tr>
</table></td></tr></table></body></html>`;
}

// Escala del 0 al 10 con enlaces: abre la incidencia con la nota ya marcada (no la guarda
// al abrir el enlace, porque los antivirus del correo visitan los enlaces solos).
function escalaNps(t) {
  if (!URL_PUBLICA) return '';
  const celdas = Array.from({ length: 11 }, (_, n) => `<td style="padding:2px"><a href="${h(enlace(t))}?nps=${n}" style="display:block;width:34px;line-height:34px;text-align:center;border:1px solid #d9d8d3;border-radius:8px;color:#1C1C1C;text-decoration:none;font-weight:600">${n}</a></td>`).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 6px"><tr>${celdas}</tr></table>
<table role="presentation" width="100%" style="font-size:12px;color:#5B616A;margin-bottom:16px"><tr><td>Nada probable</td><td align="right">Muy probable</td></tr></table>`;
}

// Sin número de ticket: las respuestas del cliente se enlazan por el Message-ID (In-Reply-To).
const asuntoDe = t => `${tickets.tituloCliente(t)} · Soporte Holded`;
const tituloDe = t => `«${tickets.tituloCliente(t)}»`;

// Cabeceras para que todo quede en el mismo hilo en el correo del cliente y para reconocer
// sus respuestas aunque cambie el asunto: el Message-ID lleva el número de incidencia.
function hilo(t) {
  const delCliente = [...(t.mensajes || [])].reverse().find(m => String(m.idExterno || '').startsWith('mail:<'))?.idExterno.slice(5);
  const cab = { messageId: `<soporte-${t.id}.${crypto.randomBytes(6).toString('hex')}@${dominioDe(buzonPara(t)?.usuario)}>` };
  if (delCliente) { cab.inReplyTo = delCliente; cab.references = [delCliente]; }
  return cab;
}

function correoPara(t, evento, b) {
  const nombre = t.contacto ? ' ' + t.contacto.split(' ')[0] : '';
  const ver = URL_PUBLICA ? { texto: 'Ver mi incidencia', url: enlace(t) } : null;
  switch (evento) {
    case 'nuevo': return {
      titulo: `Hemos recibido tu incidencia ${tituloDe(t)}`,
      texto: `Hola${nombre}:\n\nHemos recibido tu incidencia y un técnico de Holded te contestará en menos de 1 hora laborable (lunes a viernes de 9:00 a 18:00).\n\nPuedes responder a este correo para añadir información o capturas.`,
      boton: ver,
    };
    case 'mensaje': return b.nota ? null : {
      titulo: `${b.tecnico || 'Soporte'} ha respondido a tu incidencia ${tituloDe(t)}`,
      texto: b.texto, boton: ver,
    };
    case 'video': return {
      titulo: 'Te invitamos a una videollamada',
      texto: `Hola${nombre}:\n\n${b.tecnico || 'El técnico'} te espera en una videollamada de Google Meet para resolver tu incidencia. Se abre en el navegador o en la app de Meet.`,
      boton: { texto: 'Unirme a la videollamada', url: t.video },
    };
    case 'cerrar': return {
      titulo: `Hemos resuelto tu incidencia ${tituloDe(t)}`,
      texto: `Hola${nombre}:\n\nDamos por resuelta tu incidencia. Si vuelve a pasar, responde a este correo y la retomamos.\n\n¿Nos ayudas con 10 segundos? Del 0 al 10, ¿qué probabilidad hay de que nos recomiendes?${URL_PUBLICA ? '' : ' Responde a este correo solo con el número.'}`,
      extra: escalaNps(t),
    };
    case 'cita': case 'confirmarCita': return {
      titulo: 'Videollamada agendada',
      texto: `Hola${nombre}:\n\nTienes una videollamada de Google Meet el ${tickets.cuando(b.cita.inicio)} para tu incidencia ${tituloDe(t)}.${t.email && b.cita.eventoId ? ' También te llega la invitación de Google Calendar.' : ''}`,
      boton: { texto: 'Unirme a la videollamada', url: b.cita.enlace },
    };
    case 'anularCita': return { titulo: 'Videollamada anulada', texto: `Hola${nombre}:\n\nHemos anulado la videollamada prevista para tu incidencia ${tituloDe(t)}. Si necesitas otra, responde a este correo.`, boton: ver };
    case 'cierreAuto': return {
      titulo: `Hemos cerrado tu incidencia ${tituloDe(t)}`,
      texto: `Hola${nombre}:\n\nCerramos tu incidencia porque llevaba ${b.dias} días esperando tu respuesta. Si aún lo necesitas, responde a este correo y la volvemos a abrir.`,
      boton: ver,
    };
    case 'pideMejora': return { titulo: '¡Gracias por tu valoración!', texto: '¿Qué mejorarías? Puedes responder a este correo con lo que quieras contarnos.' };
  }
  return null;
}

// Correo para todo ticket con dirección, salvo los de WhatsApp, que se avisan por allí.
tickets.avisos.push(async (t, evento, b) => {
  const buzon = buzonPara(t);
  if (!buzon || !t.email || t.canal === 'WhatsApp' || t.historico) return;
  const c = correoPara(t, evento, b);
  if (!c) return;
  const texto = c.texto + (c.boton ? `\n\n${c.boton.texto}: ${c.boton.url}` : '');
  await enviar({
    to: t.email, subject: (evento === 'nuevo' ? '' : 'Re: ') + asuntoDe(t),
    text: texto, html: plantilla({ titulo: c.titulo, cuerpo: parrafos(c.texto), boton: c.boton, extra: c.extra }),
    headers: { 'X-Soporte-Aviso': 'cliente' }, ...hilo(t),
  }, buzon);
});

// ---------- El chat también por correo para el equipo (28/10/2026, «como Holded») ----------
// Lo que el cliente escribe en el portal o por WhatsApp, y lo que se le responde desde el panel,
// llega al correo del equipo (AVISOS_EQUIPO; si no está, al propio buzón de soporte), todo en el
// mismo hilo por incidencia. Respondiendo a uno de esos correos, la respuesta entra en el chat y le
// llega al cliente. El Message-ID lleva una firma por incidencia: sin ella no se acepta como
// respuesta del equipo (no basta con poner un remitente @interactivos.net).
const firmaHilo = id => crypto.createHmac('sha256', env.SESSION_SECRET || 'soporte-holded').update(`equipo:${id}`).digest('hex').slice(0, 12);
const equipoDe = t => String(env.AVISOS_EQUIPO || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean).concat(env.AVISOS_EQUIPO ? [] : [buzonPara(t)?.usuario]).filter(Boolean);
tickets.avisosEquipo.push(async (t, evento, b) => {
  const buzon = buzonPara(t), para = equipoDe(t);
  if (!buzon || !para.length || t.historico) return;
  const quien = t.contacto || t.cliente;
  const titulo = evento === 'nuevo' ? `Nueva incidencia de ${t.cliente}` : evento === 'respuesta' ? `${b.tecnico || 'Soporte'} ha respondido a ${t.cliente}` : `${quien} ha escrito`;
  const origen = evento === 'respuesta' ? '' : `${quien}${t.contacto ? ` (${t.cliente})` : ''} · por ${t.canal === 'WhatsApp' ? 'WhatsApp' : 'el portal'}`;
  const panel = URL_PUBLICA ? `${URL_PUBLICA}/admin#/bandeja/${t.id}` : '';
  const pie = 'Responde a este correo y tu respuesta le llega al cliente en el chat (y por correo o WhatsApp). Escribe solo la respuesta: lo citado de debajo no se envía.';
  const dom = dominioDe(buzon.usuario), firma = firmaHilo(t.id), raiz = `<soporte-${t.id}.eq${firma}.hilo@${dom}>`;
  await enviar({
    to: para.join(', '), replyTo: buzon.usuario, subject: `Re: [Soporte] ${t.cliente} · ${tickets.tituloCliente(t)}`,
    text: `${titulo}${origen ? `\n${origen}` : ''}\n\n${b.texto || ''}${panel ? `\n\nAbrir en el panel: ${panel}` : ''}\n\n${pie}`,
    html: plantilla({ titulo, cuerpo: (origen ? `<p style="margin:0 0 12px;color:#5B616A;font-size:13px">${h(origen)}</p>` : '') + parrafos(b.texto), boton: panel ? { texto: 'Abrir en el panel', url: panel } : null, pie }),
    messageId: `<soporte-${t.id}.eq${firma}.${crypto.randomBytes(6).toString('hex')}@${dom}>`, inReplyTo: raiz, references: [raiz],
    headers: { 'X-Soporte-Aviso': 'equipo' },
  }, buzon);
});

// ¿Es la respuesta de alguien del equipo a un aviso de una incidencia? Devuelve su número.
function respuestaDelEquipo(p, de) {
  const refs = [p.inReplyTo, ...(Array.isArray(p.references) ? p.references : [p.references])].filter(Boolean).join(' ');
  const m = refs.match(/<soporte-(\d+)\.eq([a-f0-9]{12})\./);
  if (!m || m[2] !== firmaHilo(Number(m[1]))) return null;
  const email = String(de.address || '').toLowerCase();
  const delEquipo = buzones.some(x => x.usuario === email) || String(env.AVISOS_EQUIPO || '').toLowerCase().split(',').map(x => x.trim()).includes(email)
    || require('./auth').permitidoGoogle(email, email.split('@')[1] || '');
  return delEquipo ? Number(m[1]) : null;
}

// Quita la cita del correo anterior ("El lun, ... escribió:", "On ... wrote:", líneas con ">").
function sinCita(texto) {
  const lineas = String(texto || '').replace(/\r/g, '').split('\n');
  const corte = lineas.findIndex(l => /^\s*>/.test(l) || /^(El|On) .+(escribió|wrote):\s*$/i.test(l) || /^-{2,}\s*(Mensaje original|Original Message)/i.test(l) || /^De: .+/.test(l) || /^From: .+/.test(l));
  return (corte >= 0 ? lineas.slice(0, corte) : lineas).join('\n').trim();
}

// Lo que no es una incidencia: boletines, avisos de plataformas y respuestas automáticas.
// Los envíos masivos llevan List-Unsubscribe, List-Id o Feedback-ID; los avisos, remitentes
// como no-reply@, notifications@ o wordpress@.
const automatico = p => {
  const v = k => String(p.headers.get(k) || '').toLowerCase();
  const de = String(p.from?.value?.[0]?.address || '').toLowerCase();
  const local = de.split('@')[0];
  return (v('auto-submitted') && v('auto-submitted') !== 'no') || /bulk|list|junk/.test(v('precedence'))
    || ['list-unsubscribe', 'list-id', 'list-post', 'feedback-id', 'x-campaign', 'x-campaignid', 'x-autoreply', 'x-autorespond', 'x-auto-response-suppress'].some(k => p.headers.has(k))
    || /^(mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|system|wordpress|news(letter)?|marketing|mailer|updates?)([+._-].*)?$/.test(local)
    || /no-?reply|do-?not-?reply/.test(local);
};

// Número de incidencia del asunto o de las cabeceras de respuesta.
function ticketDe(p) {
  const delAsunto = Number((p.subject || '').match(/\[Incidencia #(\d+)\]/)?.[1]);
  if (delAsunto) return delAsunto;
  const refs = [p.inReplyTo, ...(Array.isArray(p.references) ? p.references : [p.references])].filter(Boolean).join(' ');
  return Number(refs.match(/<soporte-(\d+)\./)?.[1]) || null;
}

// Fecha local «AAAA-MM-DDTHH:MM» de un correo, como las del resto de tickets.
const fechaLocal = d => { const x = new Date(d || Date.now()); return new Date(x - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

// Lo que hay que convertir en ticket de un correo ya parseado (o null si no es una incidencia).
function aTicket(b, p, uid) {
  const de = p.from?.value?.[0] || {};
  // Nuestros propios avisos (al cliente o al equipo) que vuelvan a entrar en el buzón: fuera.
  if (!de.address || p.headers.has('x-soporte-aviso') || automatico(p)) return null;
  // Adjuntos de verdad (no los logos pequeños incrustados en las firmas).
  const archivos = (p.attachments || [])
    .filter(a => a.filename && !(a.contentDisposition === 'inline' && a.size < 30000))
    .map(a => ({ nombre: a.filename, buffer: a.content }));
  const idExterno = 'mail:' + (p.messageId || `${b.usuario}:${uid}`);
  const delEquipo = respuestaDelEquipo(p, de);
  if (delEquipo) return { equipo: true, ticketId: delEquipo, texto: sinCita(p.text), email: de.address.toLowerCase(), idExterno, adjuntos: archivos };
  const propio = buzones.some(x => x.usuario === String(de.address || '').toLowerCase());
  if (propio) return null;
  const id = ticketDe(p);
  const cuerpo = sinCita(p.text) || p.subject || '';
  return {
    canal: 'Correo', email: de.address.toLowerCase(), nombre: de.name, ticketId: id, buzon: b.usuario,
    asunto: (p.subject || '').replace(/^(re|fw|fwd|rv)\s*:\s*/i, '').trim(),
    texto: id ? cuerpo : `${p.subject ? p.subject + '\n\n' : ''}${cuerpo}`,
    idExterno, adjuntos: archivos, fecha: fechaLocal(p.date),
  };
}

// La etiqueta tal como está en Gmail, aunque se haya escrito con otras mayúsculas o espacios.
async function carpetaReal(c, nombre) {
  if (/^inbox$/i.test(nombre)) return 'INBOX';
  const norma = s => String(s).normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  const l = await c.list();
  return l.find(x => x.path === nombre)?.path || l.find(x => norma(x.path) === norma(nombre))?.path || null;
}

// ¿Responde a una incidencia que ya existe? Por su número (asunto o Message-ID nuestro) o porque
// cita un correo que ya está en una. Si es así, deja puesto r.ticketId.
async function deUnaIncidencia(p, r) {
  const todos = (await require('./store').tickets.todos()).filter(t => !t.archivado);
  if (r.ticketId && todos.some(t => t.id === r.ticketId)) return true;
  const citados = new Set([p.inReplyTo, ...(Array.isArray(p.references) ? p.references : [p.references])].filter(Boolean).flatMap(x => String(x).match(/<[^>]+>/g) || []).map(x => 'mail:' + x));
  const t = citados.size && todos.find(x => (x.mensajes || []).some(m => citados.has(m.idExterno)));
  if (t) r.ticketId = t.id;
  return !!t;
}

// Revisa un buzón. Solo entra lo nuevo: se apunta el último UID visto de cada carpeta y la primera
// vez se empieza por el final. No se marca nada como leído ni se mueve nada.
// Con etiqueta, primero se mira la bandeja de entrada (solo respuestas: el cliente responde al
// correo y su respuesta no lleva la etiqueta) y luego la etiqueta, que abre las incidencias.
async function revisar(b) {
  if (!listo(b) || !b.imap || b.revisando) return b.estado.imap;
  b.revisando = true;
  const { ImapFlow } = require('imapflow');
  const c = new ImapFlow({ host: b.imap, port: b.imapPuerto, secure: true, auth: { user: b.usuario, pass: b.clave }, logger: false });
  let n = 0, falta = null;
  try {
    await c.connect();
    const carpeta = await carpetaReal(c, b.carpeta);
    if (carpeta !== 'INBOX') n += await leerCarpeta(b, c, 'INBOX', true);
    if (carpeta) n += await leerCarpeta(b, c, carpeta, false);
    else falta = `No existe la etiqueta «${b.carpeta}» en ${b.usuario}: créala en Gmail o cámbiala aquí. Mientras, solo entran las respuestas a incidencias abiertas.`;
    await c.logout();
    Object.assign(b.estado.imap, { ok: !falta, ultimo: new Date().toISOString(), error: falta });
    b.estado.imap.procesados += n;
  } catch (e) {
    console.error(`IMAP ${b.usuario}:`, e.message);
    Object.assign(b.estado.imap, { ok: false, ultimo: new Date().toISOString(), error: e.responseText || e.message });
    try { await c.logout(); } catch {}
  } finally { b.revisando = false; }
  return b.estado.imap;
}

// Lee lo nuevo de una carpeta. Si se pidió el historial, los correos desde esa fecha entran una vez
// como tickets cerrados «del historial»: sin avisos al cliente y fuera de las métricas.
async function leerCarpeta(b, c, carpeta, soloRespuestas) {
  const { simpleParser } = require('mailparser');
  let n = 0;
  const lock = await c.getMailboxLock(carpeta);
  try {
    const uidNext = Number(c.mailbox.uidNext) || Number((await c.status(carpeta, { uidNext: true })).uidNext);
    if (!uidNext) throw new Error('El servidor de correo no da el UIDNEXT de la carpeta');
    const validez = String(c.mailbox.uidValidity), ultimo = uidNext - 1;
    // El buzón de Render conserva la marca de antes («correo-uid»); las respuestas llevan la suya.
    const base = b.origen === 'render' ? 'correo-uid' : `correo-uid:${b.usuario}`;
    const claveMarca = soloRespuestas ? base + ':respuestas' : base;
    let marca = (await ajustes.donde('clave', claveMarca))[0], previos = [];
    if (!marca || marca.validez !== validez || (marca.carpeta || 'INBOX') !== carpeta) {
      // Al pasar de la bandeja de entrada a una etiqueta, las respuestas siguen desde donde se iba.
      const antes = soloRespuestas && (await ajustes.donde('clave', base))[0];
      const desde = antes && antes.carpeta === 'INBOX' && antes.validez === validez ? antes.uid : ultimo;
      marca = { ...(marca || { clave: claveMarca }), validez, carpeta, uid: desde, desde: new Date().toISOString(), historial: null };
      // Lo que ya se ha puesto esta semana en la etiqueta también entra: estar ahí es ser un ticket.
      if (!soloRespuestas && carpeta !== 'INBOX') previos = (await c.search({ since: new Date(Date.now() - 7 * 864e5) }, { uid: true })) || [];
      await ajustes.guardar(marca);
      console.log(`Correo ${b.usuario}: ${soloRespuestas ? 'respuestas de' : 'se leen'} los correos nuevos de «${carpeta}» (desde el UID ${desde})${previos.length ? ` y ${previos.length} que ya estaban en la etiqueta` : ''}.`);
    }

    // Historial pedido y todavía no leído (o pedido desde otra fecha).
    if (!soloRespuestas && b.historialDesde && marca.historial !== b.historialDesde) {
      const uids = (await c.search({ since: new Date(b.historialDesde) }, { uid: true })).filter(u => u <= marca.uid).slice(-3000);
      const ids = new Set();
      for (let i = 0; i < uids.length; i += 50) {
        for await (const m of c.fetch(uids.slice(i, i + 50).join(','), { uid: true, source: true }, { uid: true })) {
          try {
            const r = aTicket(b, await simpleParser(m.source), m.uid);
            const t = r && !r.equipo && await tickets.importarHistorico(r);
            if (t) ids.add(t.id);
          } catch (e) { console.error(`Correo ${b.usuario} historial UID ${m.uid}:`, e.message); }
        }
      }
      marca.historial = b.historialDesde;
      await ajustes.guardar(marca);
      b.estado.imap.historial = { desde: b.historialDesde, correos: uids.length, tickets: ids.size, cuando: new Date().toISOString() };
      console.log(`Correo ${b.usuario}: historial desde ${b.historialDesde}, ${uids.length} correos revisados y ${ids.size} incidencias.`);
    }

    const nuevos = [];
    const pendientes = previos.filter(u => u <= marca.uid);
    if (pendientes.length) for await (const m of c.fetch(pendientes.join(','), { uid: true, source: true }, { uid: true })) nuevos.push(m);
    if (ultimo > marca.uid) for await (const m of c.fetch(`${marca.uid + 1}:*`, { uid: true, source: true }, { uid: true })) if (m.uid > marca.uid) nuevos.push(m);
    for (const m of nuevos) {
      // Un correo que falla no bloquea los demás: se apunta en el log y se sigue.
      try {
        const p = await simpleParser(m.source);
        const r = aTicket(b, p, m.uid);
        if (r && (!soloRespuestas || r.equipo || await deUnaIncidencia(p, r))) { await (r.equipo ? tickets.respuestaEquipo(r) : tickets.recibir(r)); n++; }
      } catch (e) { console.error(`Correo ${b.usuario} UID ${m.uid}:`, e.message); }
      if (m.uid > marca.uid) { marca.uid = m.uid; await ajustes.guardar(marca); }
    }
  } finally { lock.release(); }
  return n;
}
async function revisarCorreo() {
  for (const b of buzones) await revisar(b);
}

// Comprueba usuario, contraseña y carpeta antes de guardar un buzón. Si la etiqueta no existe en
// Gmail, la crea (se ha pedido así al guardar) y se queda con el nombre exacto que tiene allí.
async function probarBuzon(b) {
  await detectarServidores(b);
  if (!b.imap) throw new Error(b.estado.deteccion || 'No se encuentra el servidor IMAP');
  const { ImapFlow } = require('imapflow');
  const c = new ImapFlow({ host: b.imap, port: b.imapPuerto, secure: true, auth: { user: b.usuario, pass: b.clave }, logger: false });
  try {
    await c.connect();
    let carpeta = await carpetaReal(c, b.carpeta);
    if (!carpeta) {
      await c.mailboxCreate(b.carpeta).catch(e => { throw new Error(`No existe la etiqueta «${b.carpeta}» en ${b.usuario} y no se ha podido crear: ${e.responseText || e.message}`); });
      carpeta = b.carpeta; b.creada = true;
    }
    b.carpeta = carpeta;
    const lock = await c.getMailboxLock(carpeta);
    lock.release();
  } catch (e) { throw new Error(e.responseText || e.message); }
  finally { try { await c.logout(); } catch {} }
}

// Etiquetas de Gmail del buzón, para elegirla en Canales (sin las del sistema: Enviados, Spam…).
async function carpetasDe(b) {
  const { ImapFlow } = require('imapflow');
  const c = new ImapFlow({ host: b.imap, port: b.imapPuerto, secure: true, auth: { user: b.usuario, pass: b.clave }, logger: false });
  try {
    await c.connect();
    return (await c.list()).filter(x => x.path !== 'INBOX' && !x.specialUse && !x.flags?.has('\\Noselect') && !/^\[Gmail\]/.test(x.path)).map(x => x.path).sort((x, y) => x.localeCompare(y, 'es'));
  } finally { try { await c.logout(); } catch {} }
}

// Rutas del panel: estado de los buzones, añadir y quitar, revisar ahora y correo de prueba.
async function rutas(req, res, ruta, { json, leerCuerpo }) {
  if (req.method === 'GET' && ruta === '/api/canales') return json(res, resumen()), true;
  if (req.method === 'POST' && ruta === '/api/canales/revisar') {
    await revisarCorreo();
    return json(res, resumen()), true;
  }
  if (req.method === 'POST' && ruta === '/api/canales/buzon') {
    const d = await leerCuerpo(req);
    if (!env.SESSION_SECRET) return json(res, { error: 'Falta SESSION_SECRET en Render para guardar contraseñas' }, 400), true;
    const usuario = String(d.usuario || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(usuario)) return json(res, { error: 'Pon un correo válido' }, 400), true;
    const existente = buzones.find(b => b.usuario === usuario);
    // Del buzón de Render solo se cambia la etiqueta: la contraseña sigue en Render.
    if (existente?.origen === 'render') {
      const b = buzonDe({ ...existente, carpeta: d.carpeta }, 'render');
      try { await probarBuzon(b); } catch (e) { return json(res, { error: 'No se pudo conectar: ' + e.message }, 400), true; }
      const doc = (await ajustes.donde('clave', 'buzon-render')).find(x => x.usuario === usuario) || { clave: 'buzon-render', usuario };
      await ajustes.guardar(Object.assign(doc, { carpeta: b.carpeta, actualizado: new Date().toISOString() }));
      await cargarBuzones();
      revisar(buzones.find(x => x.usuario === usuario)).catch(() => {});
      return json(res, { ...resumen(), creada: b.creada ? b.carpeta : null }), true;
    }
    const clave = String(d.clave || '').replace(/\s+/g, '') || existente?.clave;
    if (!clave) return json(res, { error: 'Falta la contraseña de aplicación' }, 400), true;
    const historialDesde = /^\d{4}-\d{2}-\d{2}$/.test(d.historialDesde || '') ? d.historialDesde : null;
    const b = buzonDe({ usuario, clave, carpeta: d.carpeta, historialDesde }, 'panel');
    try { await probarBuzon(b); } catch (e) { return json(res, { error: 'No se pudo conectar: ' + e.message }, 400), true; }
    const doc = (await ajustes.donde('clave', 'buzon')).find(x => x.usuario === usuario) || { clave: 'buzon', usuario };
    Object.assign(doc, { cifrada: cifrar(clave), carpeta: b.carpeta, historialDesde, actualizado: new Date().toISOString() });
    await ajustes.guardar(doc);
    await cargarBuzones();
    revisar(buzones.find(x => x.usuario === usuario)).catch(() => {});
    return json(res, { ...resumen(), creada: b.creada ? b.carpeta : null }), true;
  }
  if (req.method === 'POST' && ruta === '/api/canales/carpetas') {
    const usuario = String((await leerCuerpo(req)).usuario || '').trim().toLowerCase();
    const b = buzones.find(x => x.usuario === usuario);
    if (!b || !listo(b) || !b.imap) return json(res, { carpetas: [] }), true;
    try { return json(res, { carpetas: await carpetasDe(b) }), true; }
    catch (e) { return json(res, { carpetas: [], error: e.responseText || e.message }), true; }
  }
  if (req.method === 'POST' && ruta === '/api/canales/buzon/quitar') {
    const usuario = String((await leerCuerpo(req)).usuario || '').trim().toLowerCase();
    const doc = (await ajustes.donde('clave', 'buzon')).find(x => x.usuario === usuario);
    if (!doc) return json(res, { error: 'Ese buzón no se añadió desde el panel' }, 400), true;
    await ajustes.borrar(doc.id);
    await cargarBuzones();
    return json(res, resumen()), true;
  }
  if (req.method === 'POST' && ruta === '/api/canales/prueba') {
    const d = await leerCuerpo(req);
    const b = buzones.find(x => x.usuario === d.buzon && smtp(x)) || principal();
    const para = String(d.para || b?.usuario || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(para)) return json(res, { error: 'Pon un correo válido' }, 400), true;
    try {
      await enviar({
        to: para, subject: 'Prueba del buzón de soporte',
        text: 'Si lees esto, el correo saliente del soporte funciona.',
        html: plantilla({ titulo: 'El correo de soporte funciona', cuerpo: parrafos('Si lees esto, los avisos a los clientes (acuse, respuestas y valoración) saldrán bien desde este buzón.'), pie: 'Correo de prueba enviado desde el panel de soporte.' }),
      }, b);
    } catch (e) { return json(res, { error: 'No se pudo enviar: ' + e.message, ...resumen() }, 502), true; }
    return json(res, resumen()), true;
  }
  return false;
}

function resumen() {
  const lista = buzones.map(b => ({
    usuario: b.usuario, origen: b.origen, carpeta: b.carpeta, imap: b.imap, smtp: b.smtp,
    historialDesde: b.historialDesde, deteccion: b.estado.deteccion, lectura: b.estado.imap, envio: b.estado.smtp,
  }));
  const p = principal();
  return {
    correo: {
      configurado: buzones.some(listo), smtp: p?.smtp || null, usuario: p?.usuario || null, intervalo: INTERVALO,
      lectura: { ok: lista.length ? lista.every(x => x.lectura.ok !== false) && (lista.some(x => x.lectura.ok) || null) : null },
      envio: { ok: lista.length ? lista.every(x => x.envio.ok !== false) && (lista.some(x => x.envio.ok) || null) : null },
      buzones: lista,
    },
    publica: URL_PUBLICA || null,
    despierto: !!despierto,
    whatsapp: !!(env.WA_TOKEN && env.WA_PHONE_ID),
    plantillasWa: require('./canales').PLANTILLAS_WA.map(({ nombre, cuerpo }) => ({ nombre, cuerpo })),
    idiomaWa: env.WA_PLANTILLA_IDIOMA || 'es',
    google: require('./google').resumen(),
  };
}

// En el plan gratuito, Render duerme el servicio sin visitas y deja de leer el correo.
// Mientras está despierto se visita a sí mismo cada 10 minutos para no dormirse.
let despierto = null;
async function iniciar() {
  await cargarBuzones();
  for (const b of buzones) {
    if (b.imap) console.log(`Correo: revisando ${b.usuario} («${b.carpeta}» en ${b.imap}) cada ${INTERVALO} s`);
    else console.log(`Correo: ${b.usuario} sin servidor IMAP.`, b.estado.deteccion || '');
  }
  revisarCorreo();
  setInterval(revisarCorreo, INTERVALO * 1000);
  if (URL_PUBLICA && env.MANTENER_DESPIERTO !== '0') {
    despierto = setInterval(() => fetch(URL_PUBLICA + '/salud').catch(() => {}), 10 * 60000);
  }
}

// Para los correos de las cuentas del portal (cuentas.js).
const hayCorreo = () => !!principal();

module.exports = { respuestaDelEquipo, firmaHilo, iniciar, rutas, revisarCorreo, sinCita, resumen, plantilla, parrafos, enviar, hayCorreo, automatico, aTicket };
