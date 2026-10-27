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
  idioma: env.WA_PLANTILLA_IDIOMA || 'es',
};
const waActivo = () => WA.token && WA.telefonoId;

async function llamarMeta(cuerpo) {
  const r = await fetch(`${WA.base}/${WA.telefonoId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...cuerpo }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.error_data?.details || d.error?.message || `Meta respondió ${r.status}`);
}

// Meta solo deja escribir texto libre en las 24 h desde el último mensaje que el
// cliente mandó por WhatsApp. Pasado ese plazo hay que usar una plantilla aprobada
// en WhatsApp Manager, con el nombre, el idioma y las variables de PLANTILLAS_WA.
const VENTANA_MS = 24 * 3600e3 - 10 * 60e3; // diez minutos de margen
const enVentana = t => {
  const ultimo = t.mensajes.filter(m => m.de === 'cliente' && String(m.idExterno || '').startsWith('wa:')).map(m => m.fecha).sort().pop();
  return !!ultimo && Date.now() - new Date(ultimo) < VENTANA_MS;
};

// Categoría «Utilidad», idioma WA_PLANTILLA_IDIOMA (por defecto «es»). El cuerpo se
// copia tal cual en Meta; {{1}}, {{2}}… son las variables, en ese orden. Meta rechaza
// las plantillas que empiezan o acaban con una variable.
const PLANTILLAS_WA = [
  { nombre: 'soporte_incidencia_nueva', cuerpo: 'Hemos registrado tu incidencia #{{1}} en el Soporte Holded de Interactivos. Un técnico te contestará por este chat.', ejemplo: ['231'] },
  { nombre: 'soporte_respuesta', cuerpo: 'Tienes una respuesta nueva en tu incidencia #{{1}} del Soporte Holded:\n\n{{2}}\n\nPuedes contestar por aquí mismo.', ejemplo: ['231', 'Blanch: Ya está corregida la serie de facturas, prueba ahora.'] },
  { nombre: 'soporte_videollamada', cuerpo: 'Te invitamos a una videollamada de Google Meet por tu incidencia #{{1}}, con {{2}}.\n\nEnlace: {{3}}\n\nSe abre en el navegador o en la app de Meet.', ejemplo: ['231', 'Blanch', 'https://meet.google.com/abc-defg-hij'] },
  { nombre: 'soporte_cita', cuerpo: 'Tu videollamada de Google Meet por la incidencia #{{1}} queda agendada para el {{2}}.\n\nEnlace: {{3}}\n\nSi no puedes asistir, escríbenos por aquí.', ejemplo: ['231', 'martes 28 de octubre a las 10:00', 'https://meet.google.com/abc-defg-hij'] },
  { nombre: 'soporte_cita_anulada', cuerpo: 'Hemos anulado la videollamada prevista por tu incidencia #{{1}}. Si necesitas otra, escríbenos por aquí.', ejemplo: ['231'] },
  { nombre: 'soporte_cierre', cuerpo: 'Hemos cerrado tu incidencia #{{1}}. Del 0 al 10, ¿qué probabilidad hay de que nos recomiendes? Responde solo con el número.', ejemplo: ['231'] },
];

// Meta no admite saltos de línea, tabuladores ni más de cuatro espacios seguidos
// en una variable, ni variables vacías; y el cuerpo entero no puede pasar de 1024.
const variable = (v, max = 700) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim() || '-';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
};

// Texto libre dentro de la ventana; fuera, la plantilla del evento (si la tiene).
function mensajeWhatsApp(t, evento, b, ventana) {
  const libre = texto => texto && { type: 'text', text: { body: texto, preview_url: true } };
  const plantilla = (nombre, ...vars) => ({ type: 'template', template: { name: nombre, language: { code: WA.idioma }, components: [{ type: 'body', parameters: vars.map(v => ({ type: 'text', text: variable(v) })) }] } });
  switch (evento) {
    case 'nuevo': return ventana
      ? libre(`Hola${t.contacto ? ' ' + t.contacto : ''}, hemos recibido tu incidencia #${t.id}. Un técnico te contestará por aquí.${URL_PUBLICA ? `\nTambién puedes seguirla en ${enlace(t)}` : ''}`)
      : plantilla('soporte_incidencia_nueva', t.id);
    case 'mensaje': {
      if (b.nota) return null;
      const texto = `${b.tecnico || 'Soporte'}: ${b.texto}`;
      if (ventana) return libre(texto);
      const resumido = variable(texto, 600);
      return plantilla('soporte_respuesta', t.id, resumido.endsWith('…') && URL_PUBLICA ? `${resumido.slice(0, -1)}… (mensaje completo en ${enlace(t)})` : resumido);
    }
    case 'video': return ventana
      ? libre(`${b.tecnico || 'El técnico'} te invita a una videollamada de Google Meet:\n${t.video}`)
      : plantilla('soporte_videollamada', t.id, b.tecnico || 'el técnico', t.video);
    case 'cita': return ventana
      ? libre(`Videollamada de Google Meet agendada para el ${tickets.cuando(b.cita.inicio)}.\nEnlace: ${b.cita.enlace}`)
      : plantilla('soporte_cita', t.id, tickets.cuando(b.cita.inicio), b.cita.enlace);
    case 'anularCita': return ventana
      ? libre('Hemos anulado la videollamada prevista. Si necesitas otra, escríbenos por aquí.')
      : plantilla('soporte_cita_anulada', t.id);
    case 'cerrar': return ventana
      ? libre(`Hemos cerrado tu incidencia #${t.id}. Del 0 al 10, ¿qué probabilidad hay de que nos recomiendes? Responde solo con el número.`)
      : plantilla('soporte_cierre', t.id);
    // Solo salen justo después de un mensaje del cliente: siempre dentro de la ventana.
    case 'pideMejora': return libre('¡Gracias! ¿Qué mejorarías? Puedes responder aquí mismo.');
    case 'gracias': return libre('Gracias por tu opinión, nos ayuda mucho.');
  }
  return null;
}

tickets.avisos.push(async (t, evento, b) => {
  if (!waActivo() || t.canal !== 'WhatsApp' || !t.telefono) return;
  const m = mensajeWhatsApp(t, evento, b, enVentana(t));
  if (m) await llamarMeta({ to: tickets.telefonoWa(t.telefono), ...m });
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

module.exports = { PLANTILLAS_WA, mensajeWhatsApp, rutasWhatsApp, iniciar, revisarCorreo: correo.revisarCorreo, sinCita: correo.sinCita, correo };
