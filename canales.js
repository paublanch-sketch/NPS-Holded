// WhatsApp (Cloud API de Meta) y correo (IMAP para entrar, SMTP para responder).
// Cada canal solo se activa si tiene sus variables de entorno.
const crypto = require('crypto');
const tickets = require('./tickets');

const env = process.env;
const URL_PUBLICA = (env.PUBLIC_URL || '').replace(/\/$/, '');
const enlace = t => `${URL_PUBLICA}/soporte?t=${t.token}`;

// ---------- WhatsApp ----------
const WA = {
  token: env.WA_TOKEN, telefonoId: env.WA_PHONE_ID,
  verificar: env.WA_VERIFY_TOKEN, secreto: env.WA_APP_SECRET,
  base: (env.WA_GRAPH_BASE || 'https://graph.facebook.com/v21.0').replace(/\/$/, ''),
};
const waActivo = () => WA.token && WA.telefonoId;

// Solo texto libre: vale dentro de las 24 h desde el último mensaje del cliente.
// Fuera de esa ventana Meta lo rechaza y el error queda como nota en el ticket.
async function enviarWhatsApp(telefono, texto) {
  const r = await fetch(`${WA.base}/${WA.telefonoId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: tickets.telefonoWa(telefono), type: 'text', text: { body: texto, preview_url: true } }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `Meta respondió ${r.status}`);
}

function textoWhatsApp(t, evento, b) {
  switch (evento) {
    case 'nuevo': return `Hola${t.contacto ? ' ' + t.contacto : ''}, hemos recibido tu incidencia #${t.id}. Un técnico te contestará por aquí.${URL_PUBLICA ? `\nTambién puedes seguirla en ${enlace(t)}` : ''}`;
    case 'mensaje': return b.nota ? null : `${b.tecnico || 'Soporte'}: ${b.texto}`;
    case 'video': return `${b.tecnico || 'El técnico'} te invita a una videollamada. Se abre en el navegador:\n${t.video}`;
    case 'cerrar': return `Hemos cerrado tu incidencia #${t.id}. Del 0 al 10, ¿qué probabilidad hay de que nos recomiendes? Responde solo con el número.`;
    case 'pideMejora': return '¡Gracias! ¿Qué mejorarías? Puedes responder aquí mismo.';
    case 'gracias': return 'Gracias por tu opinión, nos ayuda mucho.';
  }
  return null;
}

tickets.avisos.push(async (t, evento, b) => {
  if (!waActivo() || t.canal !== 'WhatsApp' || !t.telefono) return;
  const texto = textoWhatsApp(t, evento, b);
  if (texto) await enviarWhatsApp(t.telefono, texto);
});

// Firma X-Hub-Signature-256 de Meta: sin ella cualquiera podría crear tickets.
function firmaValida(crudo, cabecera) {
  if (!WA.secreto) return true;
  const esperada = 'sha256=' + crypto.createHmac('sha256', WA.secreto).update(crudo).digest('hex');
  return cabecera && cabecera.length === esperada.length && crypto.timingSafeEqual(Buffer.from(cabecera), Buffer.from(esperada));
}

const TIPOS_SIN_TEXTO = { image: 'una imagen', audio: 'un audio', video: 'un vídeo', document: 'un documento', sticker: 'un sticker', location: 'una ubicación' };

function leerCrudo(req) {
  return new Promise((ok, ko) => {
    const partes = [];
    let n = 0;
    req.on('data', c => { n += c.length; if (n > 1e6) { ko(new Error('Demasiado grande')); req.destroy(); } else partes.push(c); });
    req.on('end', () => ok(Buffer.concat(partes)));
  });
}

async function rutasWhatsApp(req, res, ruta, url) {
  if (ruta !== '/whatsapp/webhook') return false;
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && WA.verificar && url.searchParams.get('hub.verify_token') === WA.verificar;
    res.writeHead(ok ? 200 : 403);
    return res.end(ok ? url.searchParams.get('hub.challenge') : 'Token no válido'), true;
  }
  const crudo = await leerCrudo(req);
  if (!firmaValida(crudo, req.headers['x-hub-signature-256'])) return tickets.json(res, { error: 'Firma no válida' }, 401), true;
  let cuerpo;
  try { cuerpo = JSON.parse(crudo); } catch { return tickets.json(res, { error: 'JSON no válido' }, 400), true; }
  for (const entry of cuerpo.entry || []) {
    for (const { value = {} } of entry.changes || []) {
      const nombres = Object.fromEntries((value.contacts || []).map(c => [c.wa_id, c.profile?.name]));
      for (const m of value.messages || []) {
        const texto = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title
          ?? `[El cliente ha enviado ${TIPOS_SIN_TEXTO[m.type] || 'un mensaje'}${m[m.type]?.caption ? ': ' + m[m.type].caption : ''}. Ábrelo en WhatsApp.]`;
        await tickets.recibir({ canal: 'WhatsApp', telefono: m.from, nombre: nombres[m.from], texto, idExterno: 'wa:' + m.id });
      }
    }
  }
  // Meta reintenta si no recibe 200; los duplicados se descartan por idExterno.
  return tickets.json(res, { ok: true }), true;
}

// ---------- Correo ----------
const MAIL = {
  usuario: env.MAIL_USER, clave: env.MAIL_PASS,
  imap: env.IMAP_HOST, imapPuerto: Number(env.IMAP_PORT || 993),
  smtp: env.SMTP_HOST, smtpPuerto: Number(env.SMTP_PORT || 465),
  remitente: env.MAIL_FROM || (env.MAIL_USER ? `Soporte Holded <${env.MAIL_USER}>` : ''),
  // Con un buzón personal no se lee la bandeja: solo la carpeta donde una regla del correo
  // (o tú a mano) deja lo que debe ser ticket. Lo procesado pasa a la subcarpeta Procesados.
  carpeta: env.IMAP_CARPETA || 'INBOX',
};

let transporte = null;
function smtp() {
  if (!MAIL.smtp || !MAIL.usuario) return null;
  if (!transporte) {
    const nodemailer = require('nodemailer');
    transporte = nodemailer.createTransport({ host: MAIL.smtp, port: MAIL.smtpPuerto, secure: MAIL.smtpPuerto === 465, auth: { user: MAIL.usuario, pass: MAIL.clave } });
  }
  return transporte;
}

// El asunto lleva [Incidencia #id] para casar la respuesta del cliente con su ticket.
function correoPara(t, evento, b) {
  const asunto = `[Incidencia #${t.id}] ${t.tipo_incidencia}`;
  const pie = URL_PUBLICA ? `\n\nPuedes seguir la incidencia y responder aquí: ${enlace(t)}` : '';
  const hola = `Hola${t.contacto ? ' ' + t.contacto : ''},\n\n`;
  switch (evento) {
    case 'nuevo': return [asunto, `${hola}Hemos recibido tu incidencia #${t.id}. Un técnico te contestará en breve; puedes responder a este correo para añadir información.${pie}`];
    case 'mensaje': return b.nota ? null : [`Re: ${asunto}`, `${b.texto}\n\n${b.tecnico || 'Soporte Holded'}${pie}`];
    case 'video': return [`Re: ${asunto}`, `${hola}${b.tecnico || 'El técnico'} te invita a una videollamada. Se abre en el navegador, sin instalar nada:\n${t.video}`];
    case 'cerrar': return [`Re: ${asunto}`, `${hola}Hemos cerrado tu incidencia. ¿Nos dices del 0 al 10 qué probabilidad hay de que nos recomiendes? Puedes responder a este correo solo con el número${URL_PUBLICA ? ' o valorarlo aquí: ' + enlace(t) : ''}.\n\nGracias.`];
    case 'pideMejora': return [`Re: ${asunto}`, '¡Gracias! ¿Qué mejorarías? Puedes responder a este correo.'];
  }
  return null;
}

// Correo para todo ticket con dirección salvo los de WhatsApp, que ya se avisan por allí.
tickets.avisos.push(async (t, evento, b) => {
  const s = smtp();
  if (!s || !t.email || t.canal === 'WhatsApp') return;
  // Al cliente del portal solo se le avisa de lo que pasa fuera del chat que ya está viendo.
  if (t.canal === 'Portal' && evento === 'mensaje' && !URL_PUBLICA) return;
  const c = correoPara(t, evento, b);
  if (c) await s.sendMail({ from: MAIL.remitente, replyTo: MAIL.usuario, to: t.email, subject: c[0], text: c[1] });
});

// Quita la cita del correo anterior ("El lun, ... escribió:", "On ... wrote:", líneas con ">").
function sinCita(texto) {
  const lineas = String(texto || '').replace(/\r/g, '').split('\n');
  const corte = lineas.findIndex(l => /^\s*>/.test(l) || /^(El|On) .+(escribió|wrote):\s*$/i.test(l) || /^-{2,}\s*(Mensaje original|Original Message)/i.test(l) || /^De: .+/.test(l));
  return (corte >= 0 ? lineas.slice(0, corte) : lineas).join('\n').trim();
}

let revisando = false;
async function revisarCorreo() {
  if (revisando) return;
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
    try {
      const nuevos = [];
      // En la carpeta dedicada vale todo lo que haya, aunque ya lo hayas leído al moverlo.
      if (c.mailbox?.exists !== 0) for await (const m of c.fetch(dedicada ? '1:*' : { seen: false }, { uid: true, source: true })) nuevos.push(m);
      for (const m of nuevos) {
        const p = await simpleParser(m.source);
        const de = p.from?.value?.[0] || {};
        const automatico = p.headers.get('auto-submitted') && p.headers.get('auto-submitted') !== 'no';
        const propio = String(de.address || '').toLowerCase() === String(MAIL.usuario).toLowerCase();
        if (de.address && !automatico && !propio) {
          const id = Number((p.subject || '').match(/\[Incidencia #(\d+)\]/)?.[1]) || null;
          const cuerpo = sinCita(p.text) || p.subject || '';
          await tickets.recibir({
            canal: 'Correo', email: de.address, nombre: de.name, ticketId: id,
            texto: id ? cuerpo : `${p.subject ? p.subject + '\n\n' : ''}${cuerpo}`,
            idExterno: 'mail:' + (p.messageId || m.uid),
          });
        }
        if (dedicada) await c.messageMove({ uid: m.uid }, procesados, { uid: true });
        else await c.messageFlagsAdd({ uid: m.uid }, ['\\Seen'], { uid: true });
      }
    } finally { lock.release(); }
    await c.logout();
  } catch (e) {
    console.error('IMAP:', e.message);
    try { await c.logout(); } catch {}
  } finally { revisando = false; }
}

function iniciar() {
  if (MAIL.imap && MAIL.usuario) {
    revisarCorreo();
    setInterval(revisarCorreo, Number(env.IMAP_INTERVALO_S || 60) * 1000);
    console.log(`Correo: revisando ${MAIL.usuario} (${MAIL.carpeta}) cada ${env.IMAP_INTERVALO_S || 60} s`);
  }
  if (waActivo()) console.log('WhatsApp: activo');
}

module.exports = { rutasWhatsApp, iniciar, revisarCorreo, sinCita };
