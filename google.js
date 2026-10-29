// Google Calendar y Meet: crea reuniones de Meet en el calendario del organizador, busca huecos
// libres para que el cliente reserve y, al terminar, pregunta a Meet cuánto duró la reunión.
// Dos formas de dar permiso:
//   - «Continuar con Google» (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET): una persona conecta su
//     cuenta desde Canales y se usa su calendario. No necesita administrador de Workspace.
//   - Cuenta de servicio con delegación de dominio (GOOGLE_SA_JSON + GOOGLE_ORGANIZADOR).
// Si hay cliente OAuth, manda él. Sin ninguna de las dos, el panel pide pegar un enlace de Meet.
const crypto = require('crypto');
const store = require('./store');

const env = process.env;
const TZ = 'Europe/Madrid';
// Para las pruebas se pueden apuntar las direcciones a un servidor simulado.
const URLS = {
  token: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  auth: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  revocar: env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
  calendar: (env.GOOGLE_CALENDAR_URL || 'https://www.googleapis.com/calendar/v3').replace(/\/$/, ''),
  meet: (env.GOOGLE_MEET_URL || 'https://meet.googleapis.com/v2').replace(/\/$/, ''),
};
const ALCANCES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/meetings.space.readonly',
].join(' ');

// La clave de la cuenta de servicio: el JSON tal cual o en base64 (más cómodo en Render).
function cuenta() {
  const raw = (env.GOOGLE_SA_JSON || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')); }
  catch { return { error: 'GOOGLE_SA_JSON no es un JSON válido' }; }
}
// «Continuar con Google»: el permiso (refresh token) se guarda cifrado en la base de datos,
// en la colección «ajustes», y se carga en memoria al arrancar.
const clienteId = () => (env.GOOGLE_CLIENT_ID || '').trim();
const clienteSecreto = () => (env.GOOGLE_CLIENT_SECRET || '').trim();
const modoOAuth = () => !!(clienteId() && clienteSecreto());
let conexion = null; // { email, refresh, conectado, alcances }

const claveCifrado = () => crypto.createHash('sha256').update('soporte-google:' + clienteSecreto()).digest();
function cifrar(texto) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', claveCifrado(), iv);
  const datos = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), datos].map(b => b.toString('base64')).join('.');
}
function descifrar(s) {
  const [iv, tag, datos] = s.split('.').map(b => Buffer.from(b, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', claveCifrado(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(datos), d.final()]).toString('utf8');
}

const organizador = () => modoOAuth() ? (conexion?.email || '') : (env.GOOGLE_ORGANIZADOR || env.MAIL_USER || '').trim().toLowerCase();
const activo = () => {
  if (modoOAuth()) return !!conexion;
  const c = cuenta();
  return !!(c && !c.error && c.client_email && c.private_key && organizador());
};

const estado = { ok: null, ultimo: null, error: null, meet: null };
const marcar = (ok, error) => Object.assign(estado, { ok, error: error || null, ultimo: new Date().toISOString() });
// Para el cliente: solo se ofrece reservar si Google está puesto y la última llamada no falló.
const disponible = () => activo() && estado.ok !== false;
// ¿Puede Meet decir quién hay en la sala? Con «Continuar con Google», si se dio el permiso de Meet.
const veSala = () => activo() && (!modoOAuth() || !!conexion?.alcances?.some(a => a.includes('meetings')));

// Comprobación al arrancar y cada 10 minutos, para que un fallo no deje al cliente
// con un «Reservar» que no funciona, y para que se vea en Canales.
function vigilar() {
  const mirar = () => { if (activo()) probar().catch(e => console.error('Google:', e.message)); };
  mirar();
  setInterval(mirar, 10 * 60000).unref();
}

let token = { valor: null, hasta: 0 };
async function accessToken() {
  if (token.valor && token.hasta > Date.now() + 60000) return token.valor;
  if (modoOAuth()) return tokenConexion();
  const c = cuenta();
  if (!c || c.error) throw new Error(c?.error || 'Google no está configurado');
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const ahora = Math.floor(Date.now() / 1000);
  const cuerpo = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: c.client_email, sub: organizador(), scope: ALCANCES, aud: c.token_uri || URLS.token, iat: ahora, exp: ahora + 3600 })}`;
  const firma = crypto.createSign('RSA-SHA256').update(cuerpo).sign(c.private_key, 'base64url');
  const r = await fetch(URLS.token, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${cuerpo}.${firma}` }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = d.error_description || d.error || `Google respondió ${r.status}`;
    marcar(false, /unauthorized_client/.test(d.error) ? 'Falta autorizar la cuenta de servicio en la delegación de dominio de Workspace (admin.google.com)' : e);
    throw new Error(estado.error);
  }
  token = { valor: d.access_token, hasta: Date.now() + (d.expires_in || 3600) * 1000 };
  return token.valor;
}

// ---- «Continuar con Google» ----
async function pedirToken(campos) {
  const r = await fetch(URLS.token, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clienteId(), client_secret: clienteSecreto(), ...campos }),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, d };
}

async function tokenConexion() {
  if (!conexion) throw new Error('Google no está conectado: pulsa «Continuar con Google» en Canales');
  const { ok, d } = await pedirToken({ grant_type: 'refresh_token', refresh_token: conexion.refresh });
  if (!ok) {
    // invalid_grant: la persona quitó el acceso, cambió la contraseña o el permiso caducó.
    marcar(false, d.error === 'invalid_grant' ? `Google ha retirado el permiso de ${conexion.email}: vuelve a conectar la cuenta` : d.error_description || d.error || 'Google no ha dado el token');
    throw new Error(estado.error);
  }
  token = { valor: d.access_token, hasta: Date.now() + (d.expires_in || 3600) * 1000 };
  return token.valor;
}

// Dirección de Google donde la persona elige su cuenta. Para entrar al panel basta la identidad;
// para el calendario se piden además los permisos de Calendar y Meet, con permiso permanente.
function urlConectar(vuelta, estadoOAuth, { soloEntrar = false, hd = '' } = {}) {
  const p = { client_id: clienteId(), redirect_uri: vuelta, response_type: 'code', state: estadoOAuth, ...(hd ? { hd } : {}) };
  Object.assign(p, soloEntrar
    ? { scope: 'openid email', prompt: 'select_account' }
    : { scope: `openid email ${ALCANCES}`, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' });
  return `${URLS.auth}?${new URLSearchParams(p)}`;
}

// Vuelta de Google: cambia el código por los tokens y dice qué cuenta es.
async function intercambiar(codigo, vuelta) {
  if (!modoOAuth()) throw new Error('Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Render');
  if (!codigo) throw new Error('Google no ha devuelto el código');
  const { ok, d } = await pedirToken({ grant_type: 'authorization_code', code: codigo, redirect_uri: vuelta });
  if (!ok) throw new Error(d.error_description || d.error || 'Google no ha aceptado el código');
  // El id_token llega directo de Google por HTTPS con nuestro secreto: basta con leerlo.
  let id = {};
  try { id = JSON.parse(Buffer.from(d.id_token.split('.')[1], 'base64url')); } catch {}
  if (!id.email || id.email_verified === false) throw new Error('Google no ha dicho qué cuenta se ha conectado');
  return { email: id.email.toLowerCase(), hd: id.hd || '', d };
}

const conPermisoCalendario = d => (d.scope || '').split(' ').includes('https://www.googleapis.com/auth/calendar.events');

// Guarda el permiso del calendario de esa cuenta.
async function guardarConexion(email, d) {
  const dados = (d.scope || '').split(' ');
  const falta = ALCANCES.split(' ').filter(a => !a.includes('meetings') && !dados.includes(a));
  if (falta.length) throw new Error('Hay que marcar los permisos de Google Calendar: vuelve a conectar y acéptalos todos');
  if (!d.refresh_token) throw new Error('Google no ha dado un permiso permanente: vuelve a conectar');
  const viejo = (await store.ajustes.donde('clave', 'google'))[0];
  const doc = { ...(viejo || {}), clave: 'google', email, refresh: cifrar(d.refresh_token), conectado: new Date().toISOString(), alcances: dados };
  await store.ajustes.guardar(doc);
  conexion = { email: doc.email, refresh: d.refresh_token, conectado: doc.conectado, alcances: dados };
  token = { valor: d.access_token, hasta: Date.now() + (d.expires_in || 3600) * 1000 };
  Object.assign(estado, { ok: null, error: null, meet: null });
  return doc.email;
}

async function completarConexion(codigo, vuelta) {
  const { email, d } = await intercambiar(codigo, vuelta);
  return guardarConexion(email, d);
}

async function desconectar() {
  const viejo = (await store.ajustes.donde('clave', 'google'))[0];
  if (conexion) await fetch(`${URLS.revocar}?token=${encodeURIComponent(conexion.refresh)}`, { method: 'POST' }).catch(() => {});
  if (viejo) await store.ajustes.borrar(viejo.id);
  conexion = null;
  token = { valor: null, hasta: 0 };
  Object.assign(estado, { ok: null, error: null, meet: null });
}

// Al arrancar: recupera la cuenta conectada (si el secreto cambió, hay que volver a conectar).
async function cargar() {
  if (!modoOAuth()) return;
  try {
    const doc = (await store.ajustes.donde('clave', 'google'))[0];
    if (!doc) return;
    conexion = { email: doc.email, refresh: descifrar(doc.refresh), conectado: doc.conectado, alcances: doc.alcances || [] };
    console.log(`Google Meet: conectado con ${doc.email}`);
  } catch (e) {
    marcar(false, 'No se ha podido leer el permiso guardado de Google: vuelve a conectar la cuenta');
    console.error('Google Meet:', e.message);
  }
}

// «tipo» es 'calendario' o 'meet'. 29/10/2026: que algo no exista (404) no es que Google falle, y lo de Meet
// (un permiso opcional) no tumba el calendario. Antes, cualquiera de los dos dejaba al cliente diez minutos
// sin reservas con enlace.
async function api(url, opciones = {}, tipo = 'calendario') {
  const r = await fetch(url, { ...opciones, headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...(opciones.headers || {}) } });
  if (r.status === 204) return {};
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = d.error?.message || `Google respondió ${r.status}`;
    if (tipo === 'meet') Object.assign(estado, { meet: false, errorMeet: e });
    else if (r.status !== 404) marcar(false, e);
    throw Object.assign(new Error(e), { status: [403, 404].includes(r.status) ? r.status : 502 });
  }
  if (tipo === 'meet') Object.assign(estado, { meet: true, errorMeet: null });
  else marcar(true);
  return d;
}

// Hora local de Madrid sin zona ("2026-10-27T10:00:00"), como el resto de fechas de la app.
const local = d => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);

// Crea un evento con su reunión de Meet. Google invita al cliente si hay correo.
async function crearReunion({ titulo, descripcion, inicio, fin, invitado }) {
  const cal = `${URLS.calendar}/calendars/primary/events`;
  let ev = await api(`${cal}?conferenceDataVersion=1&sendUpdates=${invitado ? 'all' : 'none'}`, {
    method: 'POST',
    body: JSON.stringify({
      summary: titulo, description: descripcion,
      start: { dateTime: inicio, timeZone: TZ }, end: { dateTime: fin, timeZone: TZ },
      attendees: invitado ? [{ email: invitado }] : [],
      conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      reminders: { useDefault: true },
    }),
  });
  // A veces la sala de Meet tarda un momento en crearse: se vuelve a pedir el evento.
  for (let i = 0; i < 4 && !ev.hangoutLink; i++) {
    await new Promise(r => setTimeout(r, 700));
    ev = await api(`${cal}/${encodeURIComponent(ev.id)}`);
  }
  if (!ev.hangoutLink) throw new Error('Google no ha devuelto el enlace de Meet');
  return { eventoId: ev.id, enlace: ev.hangoutLink, codigo: ev.conferenceData?.conferenceId || ev.hangoutLink.split('/').pop(), inicio, fin };
}

async function anularReunion(eventoId) {
  await api(`${URLS.calendar}/calendars/primary/events/${encodeURIComponent(eventoId)}?sendUpdates=all`, { method: 'DELETE' });
}

// Huecos libres en horario laboral, para que el cliente reserve. Con Google, los del calendario del
// organizador; sin él (o si falla), los del horario laboral (28/10/2026: el cliente nunca ve un error).
// «ocupadoExtra» son las citas que ya tenemos (inicio y fin en hora local), para no dar dos a la vez.
async function huecos({ dias = 7, minutos = Number(env.CITA_MIN || 30), antelacionH = 2, sinCalendario = false, ocupadoExtra = [] } = {}) {
  const [hIni, hFin] = (env.HORARIO_LABORAL || '09:00-18:00').split('-').map(h => { const [a, b] = h.split(':').map(Number); return a * 60 + (b || 0); });
  const ahora = new Date();
  const desde = new Date(ahora.getTime() + antelacionH * 3600000);
  // Primero los días laborables, y el calendario se mira hasta el último (29/10/2026: contando viernes o
  // sábado se quedaba un día corto y ese día salían huecos sin mirar el calendario).
  const laborables = [];
  for (const d = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()); laborables.length < dias; d.setDate(d.getDate() + 1)) if (d.getDay() % 6) laborables.push(new Date(d));
  if (!laborables.length) return [];
  const hasta = new Date(laborables.at(-1));
  hasta.setDate(hasta.getDate() + 1);
  const fb = sinCalendario ? {} : await api(`${URLS.calendar}/freeBusy`, {
    method: 'POST', body: JSON.stringify({ timeMin: desde.toISOString(), timeMax: hasta.toISOString(), timeZone: TZ, items: [{ id: 'primary' }] }),
  });
  const ocupado = (Object.values(fb.calendars || {})[0]?.busy || []).map(b => [new Date(b.start), new Date(b.end)])
    .concat(ocupadoExtra.map(([a, b]) => [new Date(a), new Date(b)]));
  const lista = [];
  for (const d of laborables) {
    if (lista.length >= 200) break;
    for (let m = hIni; m + minutos <= hFin; m += minutos) {
      const i = new Date(d.getTime() + m * 60000), f = new Date(i.getTime() + minutos * 60000);
      if (i < desde) continue;
      if (ocupado.some(([a, b]) => i < b && f > a)) continue;
      lista.push({ inicio: local(i), fin: local(f) });
    }
  }
  return lista;
}

// Todas las páginas de una lista de la API de Meet.
async function todas(url, campo) {
  const l = [];
  let pagina = '';
  do {
    const d = await api(`${url}?pageSize=250${pagina ? '&pageToken=' + encodeURIComponent(pagina) : ''}`, {}, 'meet');
    l.push(...(d[campo] || []));
    pagina = d.nextPageToken;
  } while (pagina);
  return l;
}

// Los ratos en que cada persona estuvo en una conferencia: [[inicio, fin] en ms, …] por persona.
async function sesionesDe(conferencia) {
  const personas = await todas(`${URLS.meet}/${conferencia}/participants`, 'participants');
  return Promise.all(personas.map(async p => (await todas(`${URLS.meet}/${p.name}/participantSessions`, 'participantSessions'))
    .map(s => [new Date(s.startTime).getTime(), new Date(s.endTime || Date.now()).getTime()])));
}

// Tramos con dos personas o más dentro (28/10/2026): el técnico solo en la sala no cuenta.
function tramosJuntos(personas) {
  const marcas = [];
  personas.forEach((ses, i) => ses.forEach(([a, b]) => { if (b > a) marcas.push([a, 1, i], [b, -1, i]); }));
  marcas.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const dentro = new Map(), tramos = [];
  let n = 0, desde = null;
  for (const [ms, paso, i] of marcas) {
    const antes = dentro.get(i) || 0, luego = antes + paso;
    dentro.set(i, luego);
    if (!antes && luego) n++;
    if (antes && !luego) n--;
    if (n >= 2 && desde === null) desde = ms;
    if (n < 2 && desde !== null) { if (ms > desde) tramos.push([desde, ms]); desde = null; }
  }
  return tramos;
}

// Duración real según Meet: el rato en que técnico y cliente estuvieron juntos en las conferencias
// terminadas con ese código desde el inicio previsto. 0 minutos si nadie más entró.
async function duracionReal(codigo, desdeLocal) {
  const filtro = encodeURIComponent(`space.meeting_code = "${codigo}"`);
  const d = await api(`${URLS.meet}/conferenceRecords?filter=${filtro}`, {}, 'meet');
  const desde = new Date(desdeLocal).getTime() - 6 * 3600000;
  const terminadas = (d.conferenceRecords || []).filter(c => c.endTime && new Date(c.startTime).getTime() >= desde);
  if (!terminadas.length) return null;
  const tramos = [];
  for (const c of terminadas) tramos.push(...tramosJuntos(await sesionesDe(c.name)));
  const minutos = Math.round(tramos.reduce((s, [a, b]) => s + b - a, 0) / 60000);
  const ini = new Date(tramos.length ? Math.min(...tramos.map(x => x[0])) : new Date(terminadas[0].startTime).getTime());
  return { inicio: local(ini), fin: local(new Date(ini.getTime() + minutos * 60000)), minutos };
}

// Quién está ahora en la sala, para que el cronómetro no corra mientras el técnico espera solo.
async function sala(codigo) {
  const d = await api(`${URLS.meet}/conferenceRecords?filter=${encodeURIComponent(`space.meeting_code = "${codigo}"`)}`, {}, 'meet');
  const abierta = (d.conferenceRecords || []).find(c => !c.endTime);
  if (!abierta) return { personas: 0, juntosDesde: null };
  const dentro = (await todas(`${URLS.meet}/${abierta.name}/participants`, 'participants')).filter(p => !p.latestEndTime);
  const entradas = dentro.map(p => new Date(p.earliestStartTime).getTime()).sort((a, b) => a - b);
  return { personas: dentro.length, juntosDesde: dentro.length >= 2 ? local(new Date(entradas[1])) : null };
}

// Comprobación desde el panel: pide un token y mira el calendario de mañana.
async function probar() {
  token = { valor: null, hasta: 0 };
  const h = await huecos({ dias: 1, antelacionH: 0 });
  return { ok: true, huecosManana: h.length };
}

// Qué falta en las variables, para que Canales lo diga en vez de un «sin configurar» a secas.
const falta = () => {
  if (modoOAuth()) return conexion ? [] : ['conectar una cuenta con «Continuar con Google»'];
  const c = cuenta(), l = [];
  if (!c) l.push('GOOGLE_SA_JSON');
  else if (c.error) l.push('GOOGLE_SA_JSON válida');
  else if (!c.client_email || !c.private_key) l.push('GOOGLE_SA_JSON completa (sin client_email o private_key)');
  if (!organizador()) l.push('GOOGLE_ORGANIZADOR');
  return l;
};

const resumen = () => {
  const oauth = modoOAuth(), c = oauth ? null : cuenta();
  return {
    modo: oauth ? 'oauth' : c ? 'cuenta' : null,
    falta: falta(),
    activo: activo(), organizador: organizador() || null,
    conectado: oauth && conexion ? conexion.conectado : null,
    permisoMeet: oauth && conexion ? conexion.alcances.some(a => a.includes('meetings')) : null,
    cuentaServicio: c && !c.error ? c.client_email : null, errorClave: c?.error || null,
    ok: estado.ok, ultimo: estado.ultimo, error: estado.error, meet: estado.meet,
    minutosCita: Number(env.CITA_MIN || 30),
  };
};

module.exports = {
  activo, disponible, veSala, vigilar, crearReunion, anularReunion, huecos, duracionReal, sala, tramosJuntos, probar, resumen, local, organizador,
  modoOAuth, urlConectar, intercambiar, conPermisoCalendario, guardarConexion, completarConexion, desconectar, cargar,
};
