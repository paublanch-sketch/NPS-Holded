// WhatsApp (Cloud API de Meta). El correo está en correo.js.
// Los datos de Meta van en las variables de Render (WA_…) o se ponen en el panel → Canales.
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
// Lo que enseña Canales: de dónde vienen los datos, el número y lo último que ha pasado.
const waEstado = { origen: waActivo() ? 'render' : null, info: null, publico: '', error: null, recibido: null, enviado: null, fallo: null };

async function llamarMeta(cuerpo) {
  const r = await fetch(`${WA.base}/${WA.telefonoId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...cuerpo }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(d.error?.error_data?.details || d.error?.message || `Meta respondió ${r.status}`);
    waEstado.fallo = { cuando: new Date().toISOString(), error: e.message };
    throw e;
  }
  waEstado.enviado = new Date().toISOString();
}

// ---------- WhatsApp desde el panel (29/10/2026) ----------
// Sin tocar Render: en Canales se pegan el token, el identificador del número y la clave secreta de
// la app de Meta; se guardan en «ajustes» con el token y la clave cifrados, como las contraseñas de
// los buzones. El token de verificación del webhook se crea solo, para darlo de alta en Meta.
async function cargarWa() {
  const { ajustes } = require('./store');
  let d = (await ajustes.donde('clave', 'whatsapp'))[0];
  if (!d && !env.WA_VERIFY_TOKEN) d = await ajustes.guardar({ clave: 'whatsapp', verificar: crypto.randomBytes(16).toString('hex') });
  if (!env.WA_VERIFY_TOKEN && d?.verificar) WA.verificar = d.verificar;
  Object.assign(waEstado, { publico: d?.publico || '', app: d?.app || null, coexistencia: !!d?.coexistencia });
  if (waEstado.origen === 'render' || !d?.cifrado) return;
  try {
    const { token, secreto } = JSON.parse(correo.descifrar(d.cifrado));
    Object.assign(WA, { token: token || '', telefonoId: d.telefonoId || '', secreto: env.WA_APP_SECRET || secreto });
    Object.assign(waEstado, { origen: token ? 'panel' : null, info: d.info || null, error: null });
  } catch { waEstado.error = 'No se puede descifrar el token de WhatsApp (¿ha cambiado SESSION_SECRET?): vuelve a conectarlo.'; }
}

// Comprueba con Meta el token y el número antes de guardarlos.
async function infoNumero(token, telefonoId) {
  const r = await fetch(`${WA.base}/${telefonoId}?fields=display_phone_number,verified_name,quality_rating`, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `Meta respondió ${r.status}`);
  return { numero: d.display_phone_number || '', nombre: d.verified_name || '', calidad: d.quality_rating || '' };
}

const numeroPublico = () => String(env.WA_NUMERO_PUBLICO || waEstado.publico || '').replace(/\D/g, '');
const estadoWa = () => ({
  activo: !!waActivo(), origen: waEstado.origen, numero: waEstado.info?.numero || '', nombre: waEstado.info?.nombre || '', publico: numeroPublico(),
  webhook: `${URL_PUBLICA}/whatsapp/webhook`, verificar: WA.verificar || '', conSecreto: !!WA.secreto,
  appId: waEstado.app?.id || '', configId: waEstado.app?.config || '', coexistencia: !!waEstado.coexistencia,
  recibido: waEstado.recibido, enviado: waEstado.enviado, fallo: waEstado.fallo,
  error: waEstado.error || (waActivo() && !WA.secreto ? 'Falta la clave secreta de la app de Meta (WA_APP_SECRET en Render): por seguridad, los mensajes que llegan se rechazan.' : null),
});

async function rutasPanel(req, res, ruta, { json, leerCuerpo }) {
  if (req.method !== 'POST' || !ruta.startsWith('/api/canales/whatsapp')) return false;
  const { ajustes } = require('./store');
  const d = (await ajustes.donde('clave', 'whatsapp'))[0] || { clave: 'whatsapp', verificar: WA.verificar || crypto.randomBytes(16).toString('hex') };
  if (waEstado.origen === 'render') return json(res, { error: 'WhatsApp está en las variables de Render' }, 400), true;
  if (ruta === '/api/canales/whatsapp/quitar') {
    for (const k of ['cifrado', 'telefonoId', 'wabaId', 'info', 'publico', 'coexistencia']) delete d[k];
    await ajustes.guardar(d);
    Object.assign(WA, { token: '', telefonoId: '', secreto: env.WA_APP_SECRET || '' });
    Object.assign(waEstado, { origen: null, info: null, publico: '', coexistencia: false });
    return json(res, correo.resumen()), true;
  }
  // ---- Coexistencia (30/10/2026): el mismo número en la app WhatsApp Business del móvil y aquí ----
  // Meta solo la deja a los Tech Providers, con su «Embedded Signup»: el panel abre la ventana de Meta, se
  // elige el número de la app y se confirma con el QR desde el móvil. Aquí se guardan los datos de la app de
  // Meta (identificador, configuración y clave secreta) y luego se completa el alta con lo que devuelve Meta.
  if (ruta === '/api/canales/whatsapp/app') {
    if (!env.SESSION_SECRET) return json(res, { error: 'Falta SESSION_SECRET en Render para guardar la clave' }, 400), true;
    const b = await leerCuerpo(req);
    const id = String(b.appId || '').replace(/\D/g, ''), config = String(b.configId || '').replace(/\D/g, '');
    let antes = {};
    try { if (d.cifrado) antes = JSON.parse(correo.descifrar(d.cifrado)); } catch {}
    const secreto = String(b.secreto || '').trim() || antes.secreto;
    if (!id || !config) return json(res, { error: 'Faltan el identificador de la app y el de la configuración' }, 400), true;
    if (!secreto) return json(res, { error: 'Falta la clave secreta de la app (Configuración → Básica)' }, 400), true;
    Object.assign(d, { app: { id, config }, cifrado: correo.cifrar(JSON.stringify({ token: antes.token || '', secreto })), actualizado: new Date().toISOString() });
    await ajustes.guardar(d);
    await cargarWa();
    return json(res, correo.resumen()), true;
  }
  if (ruta === '/api/canales/whatsapp/coexistencia') {
    const b = await leerCuerpo(req);
    let antes = {};
    try { if (d.cifrado) antes = JSON.parse(correo.descifrar(d.cifrado)); } catch {}
    const telefonoId = String(b.telefonoId || '').replace(/\D/g, ''), wabaId = String(b.wabaId || '').replace(/\D/g, '');
    if (!d.app?.id || !antes.secreto) return json(res, { error: 'Guarda antes los datos de la app de Meta' }, 400), true;
    if (!b.code || !telefonoId || !wabaId) return json(res, { error: 'Meta no ha devuelto el número: vuelve a intentarlo y termina todos los pasos de la ventana' }, 400), true;
    let token, info;
    try {
      // El código de la ventana de Meta se cambia por el token de la empresa…
      const r = await fetch(`${WA.base}/oauth/access_token?${new URLSearchParams({ client_id: d.app.id, client_secret: antes.secreto, code: String(b.code) })}`);
      const t = await r.json().catch(() => ({}));
      if (!r.ok || !t.access_token) throw new Error(t.error?.message || `Meta respondió ${r.status}`);
      token = t.access_token;
      // …se suscribe la app a su cuenta de WhatsApp Business (para que lleguen los mensajes al webhook)…
      const s = await fetch(`${WA.base}/${wabaId}/subscribed_apps`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (!s.ok) throw new Error((await s.json().catch(() => ({}))).error?.message || `Meta respondió ${s.status} al suscribir la app`);
      // …y se comprueba el número.
      info = await infoNumero(token, telefonoId);
    } catch (e) { return json(res, { error: 'Meta no ha completado el alta: ' + e.message }, 400), true; }
    Object.assign(d, { cifrado: correo.cifrar(JSON.stringify({ token, secreto: antes.secreto })), telefonoId, wabaId, info, coexistencia: true,
      publico: String(b.publico || '').replace(/\D/g, '') || d.publico || info.numero.replace(/\D/g, ''), actualizado: new Date().toISOString() });
    await ajustes.guardar(d);
    await cargarWa();
    return json(res, correo.resumen()), true;
  }
  if (ruta !== '/api/canales/whatsapp') return false;
  if (!env.SESSION_SECRET) return json(res, { error: 'Falta SESSION_SECRET en Render para guardar el token' }, 400), true;
  const b = await leerCuerpo(req);
  let antes = {};
  try { if (d.cifrado) antes = JSON.parse(correo.descifrar(d.cifrado)); } catch {}
  // Al editar, lo que se deja vacío se queda como estaba.
  const token = String(b.token || '').trim() || antes.token, secreto = String(b.secreto || '').trim() || antes.secreto || env.WA_APP_SECRET;
  const telefonoId = String(b.telefonoId || '').replace(/\D/g, '') || d.telefonoId;
  if (!token || !telefonoId) return json(res, { error: 'Faltan el token y el identificador del número' }, 400), true;
  // Sin la clave secreta cualquiera podría mandar mensajes falsos al webhook.
  if (!secreto) return json(res, { error: 'Falta la clave secreta de la app (Configuración → Básica en developers.facebook.com)' }, 400), true;
  let info;
  try { info = await infoNumero(token, telefonoId); } catch (e) { return json(res, { error: 'Meta no acepta esos datos: ' + e.message }, 400), true; }
  Object.assign(d, { cifrado: correo.cifrar(JSON.stringify({ token, secreto })), telefonoId, info, coexistencia: false,
    publico: String(b.publico || '').replace(/\D/g, '') || info.numero.replace(/\D/g, ''), actualizado: new Date().toISOString() });
  await ajustes.guardar(d);
  await cargarWa();
  return json(res, correo.resumen()), true;
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
  { nombre: 'soporte_incidencia_nueva', cuerpo: 'Hemos registrado tu incidencia «{{1}}» en el Soporte Holded de Interactivos. Un técnico te contestará por este chat.', ejemplo: ['No me deja cerrar el ejercicio'] },
  { nombre: 'soporte_respuesta', cuerpo: 'Tienes una respuesta nueva en tu incidencia «{{1}}» del Soporte Holded:\n\n{{2}}\n\nPuedes contestar por aquí mismo.', ejemplo: ['No me deja cerrar el ejercicio', 'Blanch: Ya está corregida la serie de facturas, prueba ahora.'] },
  { nombre: 'soporte_videollamada', cuerpo: 'Te invitamos a una videollamada de Google Meet por tu incidencia «{{1}}», con {{2}}.\n\nEnlace: {{3}}\n\nSe abre en el navegador o en la app de Meet.', ejemplo: ['No me deja cerrar el ejercicio', 'Blanch', 'https://meet.google.com/abc-defg-hij'] },
  { nombre: 'soporte_cita', cuerpo: 'Tu videollamada de Google Meet por la incidencia «{{1}}» queda agendada para el {{2}}.\n\nEnlace: {{3}}\n\nSi no puedes asistir, escríbenos por aquí.', ejemplo: ['No me deja cerrar el ejercicio', 'martes 28 de octubre a las 10:00', 'https://meet.google.com/abc-defg-hij'] },
  { nombre: 'soporte_cita_anulada', cuerpo: 'Hemos anulado la videollamada prevista por tu incidencia «{{1}}». Si necesitas otra, escríbenos por aquí.', ejemplo: ['No me deja cerrar el ejercicio'] },
  { nombre: 'soporte_cierre', cuerpo: 'Hemos cerrado tu incidencia «{{1}}». ¿Cómo valoras el último servicio que te hemos ofrecido? Responde con un número del 1 (muy insatisfecho) al 5 (muy satisfecho).', ejemplo: ['No me deja cerrar el ejercicio'] },
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
      ? libre(`Hola${t.contacto ? ' ' + t.contacto : ''}, hemos recibido tu incidencia «${tickets.tituloCliente(t)}». Un técnico te contestará por aquí.${URL_PUBLICA ? `\nTambién puedes seguirla en ${enlace(t)}` : ''}`)
      : plantilla('soporte_incidencia_nueva', tickets.tituloCliente(t));
    case 'mensaje': {
      if (b.nota) return null;
      const texto = `${b.tecnico || 'Soporte'}: ${b.texto}`;
      if (ventana) return libre(texto);
      const resumido = variable(texto, 600);
      return plantilla('soporte_respuesta', tickets.tituloCliente(t), resumido.endsWith('…') && URL_PUBLICA ? `${resumido.slice(0, -1)}… (mensaje completo en ${enlace(t)})` : resumido);
    }
    case 'video': return ventana
      ? libre(`${b.tecnico || 'El técnico'} te invita a una videollamada de Google Meet:\n${t.video}`)
      : plantilla('soporte_videollamada', tickets.tituloCliente(t), b.tecnico || 'el técnico', t.video);
    case 'cita': case 'confirmarCita': return ventana
      ? libre(`Videollamada de Google Meet agendada para el ${tickets.cuando(b.cita.inicio)}.\nEnlace: ${b.cita.enlace}`)
      : plantilla('soporte_cita', tickets.tituloCliente(t), tickets.cuando(b.cita.inicio), b.cita.enlace);
    case 'anularCita': return ventana
      ? libre('Hemos anulado la videollamada prevista. Si necesitas otra, escríbenos por aquí.')
      : plantilla('soporte_cita_anulada', tickets.tituloCliente(t));
    case 'cerrar': return ventana
      ? libre(`Hemos cerrado tu incidencia «${tickets.tituloCliente(t)}». ¿Cómo valoras el último servicio que te hemos ofrecido? Responde con un número del 1 (muy insatisfecho) al 5 (muy satisfecho).`)
      : plantilla('soporte_cierre', tickets.tituloCliente(t));
    // Sin plantilla aprobada: solo si aún está abierta la ventana de 24 h.
    case 'cierreAuto': return ventana ? libre(`Hemos cerrado tu incidencia «${tickets.tituloCliente(t)}» porque llevaba ${b.dias} días esperando tu respuesta. Si aún lo necesitas, escríbenos por aquí y la volvemos a abrir.`) : null;
    // Pantalla compartida y AnyDesk (30/10/2026): sin plantilla aprobada, solo dentro de la ventana de 24 h.
    case 'pantalla': return b.paso === 'abrir' && ventana && URL_PUBLICA ? libre(`${b.tecnico || 'El técnico'} te enseña su pantalla para resolver tu incidencia. Ábrela aquí y pulsa «Ver su pantalla» (sin instalar nada):\n${enlace(t)}`) : null;
    case 'anydesk': return b.paso === 'pedir' && ventana ? libre(`Para ayudarte desde tu ordenador nos conectaremos con AnyDesk:\n1. Descárgalo en https://anydesk.com/es/downloads y ábrelo.\n2. Mándanos por aquí el número que sale en «Tu dirección»${URL_PUBLICA ? ` (o escríbelo en ${enlace(t)})` : ''}.\n3. Cuando te conectemos, pulsa «Aceptar».`) : null;
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
// 29/10/2026: sin la clave secreta de la app no se acepta nada (antes entraba todo sin comprobar).
function firmaValida(crudo, cabecera) {
  if (!WA.secreto) return false;
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
  if (!firmaValida(crudo, req.headers['x-hub-signature-256'])) {
    if (!WA.secreto) console.error('WhatsApp: mensaje rechazado porque falta WA_APP_SECRET');
    return tickets.json(res, { error: 'Firma no válida' }, 401), true;
  }
  let cuerpo;
  try { cuerpo = JSON.parse(crudo); } catch { return tickets.json(res, { error: 'JSON no válido' }, 400), true; }
  for (const entry of cuerpo.entry || []) {
    for (const { value = {} } of entry.changes || []) {
      const nombres = Object.fromEntries((value.contacts || []).map(c => [c.wa_id, c.profile?.name]));
      for (const m of value.messages || []) {
        waEstado.recibido = new Date().toISOString();
        const texto = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title
          ?? `[El cliente ha enviado ${TIPOS_SIN_TEXTO[m.type] || 'un mensaje'}${m[m.type]?.caption ? ': ' + m[m.type].caption : ''}. Ábrelo en WhatsApp.]`;
        await tickets.recibir({ canal: 'WhatsApp', telefono: m.from, nombre: nombres[m.from], texto, idExterno: 'wa:' + m.id });
      }
      // Coexistencia: lo que el equipo escribe desde la app del móvil (webhook smb_message_echoes) entra en
      // el chat del ticket como respuesta del técnico.
      for (const m of value.message_echoes || []) {
        const texto = m.text?.body ?? `[Enviado desde el móvil: ${TIPOS_SIN_TEXTO[m.type] || 'un mensaje'}${m[m.type]?.caption ? ': ' + m[m.type].caption : ''}]`;
        await tickets.desdeMovil({ telefono: m.to, texto, idExterno: 'wa:' + m.id });
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
  cargarWa().then(() => waActivo() && console.log(`WhatsApp: activo (${waEstado.origen})`)).catch(e => console.error('WhatsApp:', e.message));
}

module.exports = { PLANTILLAS_WA, mensajeWhatsApp, rutasWhatsApp, rutasPanel, estadoWa, numeroPublico, iniciar, revisarCorreo: correo.revisarCorreo, sinCita: correo.sinCita, correo };
