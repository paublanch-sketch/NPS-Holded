// Google Calendar y Meet con una cuenta de servicio con delegación de dominio de Workspace:
// crea reuniones de Meet en el calendario del organizador, busca huecos libres para que el
// cliente reserve y, al terminar, pregunta a Meet cuánto duró de verdad la reunión.
// Sin GOOGLE_SA_JSON la app sigue con Jitsi y nada de esto se activa.
const crypto = require('crypto');

const env = process.env;
const TZ = 'Europe/Madrid';
// Para las pruebas se pueden apuntar las tres direcciones a un servidor simulado.
const URLS = {
  token: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
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
const organizador = () => (env.GOOGLE_ORGANIZADOR || env.MAIL_USER || '').trim().toLowerCase();
const activo = () => { const c = cuenta(); return !!(c && !c.error && c.client_email && c.private_key && organizador()); };

const estado = { ok: null, ultimo: null, error: null, meet: null };
const marcar = (ok, error) => Object.assign(estado, { ok, error: error || null, ultimo: new Date().toISOString() });

let token = { valor: null, hasta: 0 };
async function accessToken() {
  if (token.valor && token.hasta > Date.now() + 60000) return token.valor;
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

async function api(url, opciones = {}) {
  const r = await fetch(url, { ...opciones, headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...(opciones.headers || {}) } });
  if (r.status === 204) return {};
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = d.error?.message || `Google respondió ${r.status}`; marcar(false, e); throw Object.assign(new Error(e), { status: r.status === 404 ? 404 : 502 }); }
  marcar(true);
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

// Huecos libres del organizador en horario laboral, para que el cliente reserve.
async function huecos({ dias = 7, minutos = Number(env.CITA_MIN || 30), antelacionH = 2 } = {}) {
  const [hIni, hFin] = (env.HORARIO_LABORAL || '09:00-18:00').split('-').map(h => { const [a, b] = h.split(':').map(Number); return a * 60 + (b || 0); });
  const ahora = new Date();
  const desde = new Date(ahora.getTime() + antelacionH * 3600000);
  const hasta = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + dias + 3);
  const fb = await api(`${URLS.calendar}/freeBusy`, {
    method: 'POST', body: JSON.stringify({ timeMin: desde.toISOString(), timeMax: hasta.toISOString(), timeZone: TZ, items: [{ id: 'primary' }] }),
  });
  const ocupado = (Object.values(fb.calendars || {})[0]?.busy || []).map(b => [new Date(b.start), new Date(b.end)]);
  const lista = [];
  const d = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  let laborables = 0;
  while (laborables < dias && lista.length < 200) {
    if (d.getDay() % 6) {
      laborables++;
      for (let m = hIni; m + minutos <= hFin; m += minutos) {
        const i = new Date(d.getTime() + m * 60000), f = new Date(i.getTime() + minutos * 60000);
        if (i < desde) continue;
        if (ocupado.some(([a, b]) => i < b && f > a)) continue;
        lista.push({ inicio: local(i), fin: local(f) });
      }
    }
    d.setDate(d.getDate() + 1);
  }
  return lista;
}

// Duración real según Meet: suma de las conferencias terminadas con ese código desde el inicio previsto.
async function duracionReal(codigo, desdeLocal) {
  const filtro = encodeURIComponent(`space.meeting_code = "${codigo}"`);
  const d = await api(`${URLS.meet}/conferenceRecords?filter=${filtro}`);
  estado.meet = true;
  const desde = new Date(desdeLocal).getTime() - 6 * 3600000;
  const terminadas = (d.conferenceRecords || []).filter(c => c.endTime && new Date(c.startTime).getTime() >= desde);
  if (!terminadas.length) return null;
  const ini = new Date(Math.min(...terminadas.map(c => new Date(c.startTime))));
  const fin = new Date(Math.max(...terminadas.map(c => new Date(c.endTime))));
  const minutos = Math.round(terminadas.reduce((s, c) => s + (new Date(c.endTime) - new Date(c.startTime)), 0) / 60000);
  return { inicio: local(ini), fin: local(fin), minutos };
}

// Comprobación desde el panel: pide un token y mira el calendario de mañana.
async function probar() {
  token = { valor: null, hasta: 0 };
  const h = await huecos({ dias: 1, antelacionH: 0 });
  return { ok: true, huecosManana: h.length };
}

const resumen = () => {
  const c = cuenta();
  return {
    activo: activo(), organizador: organizador() || null,
    cuentaServicio: c && !c.error ? c.client_email : null, errorClave: c?.error || null,
    ok: estado.ok, ultimo: estado.ultimo, error: estado.error, meet: estado.meet,
    minutosCita: Number(env.CITA_MIN || 30),
  };
};

module.exports = { activo, crearReunion, anularReunion, huecos, duracionReal, probar, resumen, local, organizador };
