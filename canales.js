// WhatsApp (Cloud API de Meta). El correo está en correo.js.
// Cada canal solo se activa si tiene sus variables de entorno.
const crypto = require('crypto');
const tickets = require('./tickets');

const env = process.env;
const URL_PUBLICA = (env.PUBLIC_URL || '').replace(/\/$/, '');
const enlace = t => `${URL_PUBLICA}/t/${t.token}`;

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
// Vive en correo.js; aquí solo se arranca junto con WhatsApp.
const correo = require('./correo');

function iniciar() {
  correo.iniciar().catch(e => console.error('Correo:', e.message));
  if (waActivo()) console.log('WhatsApp: activo');
}

module.exports = { rutasWhatsApp, iniciar, revisarCorreo: correo.revisarCorreo, sinCita: correo.sinCita, correo };
