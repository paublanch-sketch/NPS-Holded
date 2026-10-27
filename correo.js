// Buzón de soporte: IMAP para leer lo que entra y SMTP para responder.
// Con Google Workspace basta MAIL_USER y MAIL_PASS (contraseña de aplicación): los
// servidores se deducen del registro MX del dominio.
const crypto = require('crypto');
const dns = require('dns').promises;
const tickets = require('./tickets');

const env = process.env;
const URL_PUBLICA = (env.PUBLIC_URL || '').replace(/\/$/, '');
const enlace = t => `${URL_PUBLICA}/t/${t.token}`;

const MAIL = {
  usuario: env.MAIL_USER, clave: (env.MAIL_PASS || '').replace(/\s+/g, ''),
  imap: env.IMAP_HOST, imapPuerto: Number(env.IMAP_PORT || 993),
  smtp: env.SMTP_HOST, smtpPuerto: Number(env.SMTP_PORT || 465),
  remitente: env.MAIL_FROM || (env.MAIL_USER ? `Soporte Holded · Interactivos <${env.MAIL_USER}>` : ''),
  // Con un buzón compartido no se lee la bandeja: solo la carpeta donde una regla deja
  // lo que debe ser ticket. Lo procesado pasa a la subcarpeta Procesados.
  carpeta: env.IMAP_CARPETA || 'INBOX',
  intervalo: Number(env.IMAP_INTERVALO_S || 60),
};
const dominio = () => String(MAIL.usuario || 'soporte.local').split('@')[1] || 'soporte.local';
const configurado = () => !!(MAIL.usuario && MAIL.clave);

// Lo que ve el panel en «Canales».
const estado = {
  imap: { ok: null, ultimo: null, error: null, procesados: 0 },
  smtp: { ok: null, ultimo: null, error: null, enviados: 0 },
  deteccion: null,
};

// Si faltan los servidores y el dominio está en Google, usa los de Gmail.
async function detectarServidores() {
  if (!configurado() || (MAIL.imap && MAIL.smtp)) return;
  try {
    const mx = (await dns.resolveMx(dominio())).map(r => r.exchange.toLowerCase());
    if (mx.some(h => /google(mail)?\.com$/.test(h))) {
      MAIL.imap ||= 'imap.gmail.com';
      MAIL.smtp ||= 'smtp.gmail.com';
      estado.deteccion = 'Google Workspace (por el registro MX)';
    } else estado.deteccion = `Correo en ${mx[0] || 'desconocido'}: pon IMAP_HOST y SMTP_HOST`;
  } catch (e) { estado.deteccion = 'No se pudo consultar el MX: ' + e.message; }
}

let transporte = null;
function smtp() {
  if (!configurado() || !MAIL.smtp) return null;
  if (!transporte) {
    const nodemailer = require('nodemailer');
    transporte = nodemailer.createTransport({ host: MAIL.smtp, port: MAIL.smtpPuerto, secure: MAIL.smtpPuerto === 465, auth: { user: MAIL.usuario, pass: MAIL.clave } });
  }
  return transporte;
}

async function enviar(opciones) {
  const s = smtp();
  if (!s) throw new Error('El correo saliente no está configurado');
  try {
    const r = await s.sendMail({ from: MAIL.remitente, replyTo: MAIL.usuario, ...opciones });
    Object.assign(estado.smtp, { ok: true, ultimo: new Date().toISOString(), error: null });
    estado.smtp.enviados++;
    return r;
  } catch (e) {
    Object.assign(estado.smtp, { ok: false, ultimo: new Date().toISOString(), error: e.message });
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

const asuntoDe = t => `[Incidencia #${t.id}] ${t.asunto || t.tipo_incidencia}`;

// Cabeceras para que todo quede en el mismo hilo en el correo del cliente y para reconocer
// sus respuestas aunque cambie el asunto: el Message-ID lleva el número de incidencia.
function hilo(t) {
  const delCliente = [...(t.mensajes || [])].reverse().find(m => String(m.idExterno || '').startsWith('mail:<'))?.idExterno.slice(5);
  const cab = { messageId: `<soporte-${t.id}.${crypto.randomBytes(6).toString('hex')}@${dominio()}>` };
  if (delCliente) { cab.inReplyTo = delCliente; cab.references = [delCliente]; }
  return cab;
}

function correoPara(t, evento, b) {
  const nombre = t.contacto ? ' ' + t.contacto.split(' ')[0] : '';
  const ver = URL_PUBLICA ? { texto: 'Ver mi incidencia', url: enlace(t) } : null;
  switch (evento) {
    case 'nuevo': return {
      titulo: `Hemos recibido tu incidencia #${t.id}`,
      texto: `Hola${nombre}:\n\nHemos recibido tu incidencia y un técnico de Holded te contestará en menos de 1 hora laborable (lunes a viernes de 9:00 a 18:00).\n\nPuedes responder a este correo para añadir información o capturas.`,
      boton: ver,
    };
    case 'mensaje': return b.nota ? null : {
      titulo: `${b.tecnico || 'Soporte'} ha respondido a tu incidencia #${t.id}`,
      texto: b.texto, boton: ver,
    };
    case 'video': return {
      titulo: 'Te invitamos a una videollamada',
      texto: `Hola${nombre}:\n\n${b.tecnico || 'El técnico'} te espera en una videollamada de Google Meet para resolver tu incidencia. Se abre en el navegador o en la app de Meet.`,
      boton: { texto: 'Unirme a la videollamada', url: t.video },
    };
    case 'cerrar': return {
      titulo: `Hemos resuelto tu incidencia #${t.id}`,
      texto: `Hola${nombre}:\n\nDamos por resuelta tu incidencia. Si vuelve a pasar, responde a este correo y la retomamos.\n\n¿Nos ayudas con 10 segundos? Del 0 al 10, ¿qué probabilidad hay de que nos recomiendes?${URL_PUBLICA ? '' : ' Responde a este correo solo con el número.'}`,
      extra: escalaNps(t),
    };
    case 'cita': return {
      titulo: 'Videollamada agendada',
      texto: `Hola${nombre}:\n\nTienes una videollamada de Google Meet el ${tickets.cuando(b.cita.inicio)} para tu incidencia #${t.id}.${t.email ? ' También te llega la invitación de Google Calendar.' : ''}`,
      boton: { texto: 'Unirme a la videollamada', url: b.cita.enlace },
    };
    case 'anularCita': return { titulo: 'Videollamada anulada', texto: `Hola${nombre}:\n\nHemos anulado la videollamada prevista para tu incidencia #${t.id}. Si necesitas otra, responde a este correo.`, boton: ver };
    case 'pideMejora': return { titulo: '¡Gracias por tu valoración!', texto: '¿Qué mejorarías? Puedes responder a este correo con lo que quieras contarnos.' };
  }
  return null;
}

// Correo para todo ticket con dirección, salvo los de WhatsApp, que se avisan por allí.
tickets.avisos.push(async (t, evento, b) => {
  if (!smtp() || !t.email || t.canal === 'WhatsApp') return;
  const c = correoPara(t, evento, b);
  if (!c) return;
  const texto = c.texto + (c.boton ? `\n\n${c.boton.texto}: ${c.boton.url}` : '');
  await enviar({
    to: t.email, subject: (evento === 'nuevo' ? '' : 'Re: ') + asuntoDe(t),
    text: texto, html: plantilla({ titulo: c.titulo, cuerpo: parrafos(c.texto), boton: c.boton, extra: c.extra }),
    ...hilo(t),
  });
});

// «Envíame mis incidencias» desde el portal.
tickets.alRecuperar.fn = async (email, lista) => {
  if (!smtp() || !URL_PUBLICA) return;
  const filas = lista.map(t => `<tr><td style="padding:8px 0;border-top:1px solid #e6e5e1"><a href="${h(enlace(t))}" style="color:#1C1C1C;font-weight:600;text-decoration:none">#${t.id} · ${h(t.asunto || t.tipo_incidencia)}</a><br><span style="color:#5B616A;font-size:13px">${h(t.entrada.slice(0, 10))} · ${h(t.estado === 'Cerrado' ? 'Resuelta' : t.estado === 'Nuevo' ? 'Abierta' : t.estado)}</span></td></tr>`).join('');
  await enviar({
    to: email, subject: 'Tus incidencias de soporte Holded',
    text: 'Estas son tus incidencias:\n\n' + lista.map(t => `#${t.id} ${t.asunto || t.tipo_incidencia}: ${enlace(t)}`).join('\n'),
    html: plantilla({ titulo: 'Tus incidencias', cuerpo: parrafos('Has pedido los enlaces de tus incidencias. Ábrelas desde aquí:') + `<table role="presentation" width="100%">${filas}</table>`, pie: 'Si no lo has pedido tú, puedes ignorar este correo.' }),
  });
};

// Quita la cita del correo anterior ("El lun, ... escribió:", "On ... wrote:", líneas con ">").
function sinCita(texto) {
  const lineas = String(texto || '').replace(/\r/g, '').split('\n');
  const corte = lineas.findIndex(l => /^\s*>/.test(l) || /^(El|On) .+(escribió|wrote):\s*$/i.test(l) || /^-{2,}\s*(Mensaje original|Original Message)/i.test(l) || /^De: .+/.test(l) || /^From: .+/.test(l));
  return (corte >= 0 ? lineas.slice(0, corte) : lineas).join('\n').trim();
}

const automatico = p => {
  const v = k => String(p.headers.get(k) || '').toLowerCase();
  const de = String(p.from?.value?.[0]?.address || '').toLowerCase();
  return (v('auto-submitted') && v('auto-submitted') !== 'no') || /bulk|list|junk/.test(v('precedence'))
    || /^(mailer-daemon|postmaster|no-?reply|noreply)@/.test(de) || p.headers.has('x-autoreply') || p.headers.has('x-autorespond');
};

// Número de incidencia del asunto o de las cabeceras de respuesta.
function ticketDe(p) {
  const delAsunto = Number((p.subject || '').match(/\[Incidencia #(\d+)\]/)?.[1]);
  if (delAsunto) return delAsunto;
  const refs = [p.inReplyTo, ...(Array.isArray(p.references) ? p.references : [p.references])].filter(Boolean).join(' ');
  return Number(refs.match(/<soporte-(\d+)\./)?.[1]) || null;
}

let revisando = false;
async function revisarCorreo() {
  if (!configurado() || !MAIL.imap || revisando) return estado.imap;
  revisando = true;
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const c = new ImapFlow({ host: MAIL.imap, port: MAIL.imapPuerto, secure: true, auth: { user: MAIL.usuario, pass: MAIL.clave }, logger: false });
  try {
    await c.connect();
    const dedicada = MAIL.carpeta !== 'INBOX';
    let procesados = null;
    if (dedicada) {
      procesados = (await c.list()).find(b => b.path === MAIL.carpeta)?.delimiter;
      procesados = `${MAIL.carpeta}${procesados || '/'}Procesados`;
      await c.mailboxCreate(procesados).catch(() => {}); // ya existe
    }
    const lock = await c.getMailboxLock(MAIL.carpeta);
    let n = 0;
    try {
      const nuevos = [];
      // En la carpeta dedicada vale todo lo que haya, aunque ya se haya leído.
      if (c.mailbox?.exists !== 0) for await (const m of c.fetch(dedicada ? '1:*' : { seen: false }, { uid: true, source: true })) nuevos.push(m);
      for (const m of nuevos) {
        const p = await simpleParser(m.source);
        const de = p.from?.value?.[0] || {};
        const propio = String(de.address || '').toLowerCase() === String(MAIL.usuario).toLowerCase();
        if (de.address && !automatico(p) && !propio) {
          const id = ticketDe(p);
          const cuerpo = sinCita(p.text) || p.subject || '';
          // Adjuntos de verdad (no los logos pequeños incrustados en las firmas).
          const archivos = (p.attachments || [])
            .filter(a => a.filename && !(a.contentDisposition === 'inline' && a.size < 30000))
            .map(a => ({ nombre: a.filename, buffer: a.content }));
          await tickets.recibir({
            canal: 'Correo', email: de.address.toLowerCase(), nombre: de.name, ticketId: id,
            asunto: (p.subject || '').replace(/^(re|fw|fwd|rv)\s*:\s*/i, '').trim(),
            texto: id ? cuerpo : `${p.subject ? p.subject + '\n\n' : ''}${cuerpo}`,
            idExterno: 'mail:' + (p.messageId || m.uid), adjuntos: archivos,
          });
          n++;
        }
        if (dedicada) await c.messageMove({ uid: m.uid }, procesados, { uid: true });
        else await c.messageFlagsAdd({ uid: m.uid }, ['\\Seen'], { uid: true });
      }
    } finally { lock.release(); }
    await c.logout();
    Object.assign(estado.imap, { ok: true, ultimo: new Date().toISOString(), error: null });
    estado.imap.procesados += n;
  } catch (e) {
    console.error('IMAP:', e.message);
    Object.assign(estado.imap, { ok: false, ultimo: new Date().toISOString(), error: e.responseText || e.message });
    try { await c.logout(); } catch {}
  } finally { revisando = false; }
  return estado.imap;
}

// Rutas del panel: estado del buzón, revisar ahora y correo de prueba.
async function rutas(req, res, ruta, { json, leerCuerpo }) {
  if (req.method === 'GET' && ruta === '/api/canales') return json(res, resumen()), true;
  if (req.method === 'POST' && ruta === '/api/canales/revisar') {
    await revisarCorreo();
    return json(res, resumen()), true;
  }
  if (req.method === 'POST' && ruta === '/api/canales/prueba') {
    const para = String((await leerCuerpo(req)).para || MAIL.usuario || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(para)) return json(res, { error: 'Pon un correo válido' }, 400), true;
    try {
      await enviar({
        to: para, subject: 'Prueba del buzón de soporte',
        text: 'Si lees esto, el correo saliente del soporte funciona.',
        html: plantilla({ titulo: 'El correo de soporte funciona', cuerpo: parrafos('Si lees esto, los avisos a los clientes (acuse, respuestas y valoración) saldrán bien desde este buzón.'), pie: 'Correo de prueba enviado desde el panel de soporte.' }),
      });
    } catch (e) { return json(res, { error: 'No se pudo enviar: ' + e.message, ...resumen() }, 502), true; }
    return json(res, resumen()), true;
  }
  return false;
}

function resumen() {
  return {
    correo: {
      configurado: configurado(), usuario: MAIL.usuario || null, imap: MAIL.imap || null, smtp: MAIL.smtp || null,
      carpeta: MAIL.carpeta, intervalo: MAIL.intervalo, deteccion: estado.deteccion,
      lectura: estado.imap, envio: estado.smtp,
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
  await detectarServidores();
  if (configurado() && MAIL.imap) {
    revisarCorreo();
    setInterval(revisarCorreo, MAIL.intervalo * 1000);
    console.log(`Correo: revisando ${MAIL.usuario} (${MAIL.carpeta} en ${MAIL.imap}) cada ${MAIL.intervalo} s`);
  } else if (MAIL.usuario) console.log('Correo: falta MAIL_PASS o el servidor IMAP.', estado.deteccion || '');
  if (configurado() && URL_PUBLICA && env.MANTENER_DESPIERTO !== '0') {
    despierto = setInterval(() => fetch(URL_PUBLICA + '/salud').catch(() => {}), 10 * 60000);
  }
}

module.exports = { iniciar, rutas, revisarCorreo, sinCita, resumen, plantilla };
