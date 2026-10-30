// Preguntar a la IA (30/10/2026): desde el panel se pregunta en lenguaje normal y Gemini responde con
// los datos del soporte: cada incidencia en una línea (sin conversaciones ni correos) con el servicio
// y el origen de la ficha de su cliente. Los mismos tickets que cuentan en Métricas.
// Clave: GEMINI_API_KEY (Render o .env) o la que se pega en el propio panel (ajuste «gemini», cifrada).
const tickets = require('./tickets');
const clientes = require('./clientes');
const { ajustes } = require('./store');

// Los que respondían el 30/10/2026; si uno está saturado o tarda, se prueba el siguiente.
// [modelo, tiempo máximo]: el lite es el que responde con Google saturado (tarda 10-30 s con todos los datos).
const MODELOS = [['gemini-flash-lite-latest', 45000], ['gemini-3.8-flash', 20000], ['gemini-flash-latest', 25000]];
let guardada = null;
async function clave() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  if (guardada === null) {
    const a = (await ajustes.donde('clave', 'gemini'))[0];
    guardada = a ? require('./correo').descifrar(a.cifrada) : '';
  }
  return guardada;
}

const hoy = () => new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
async function contexto() {
  const [l, mapa] = await Promise.all([tickets.paraDashboard(), clientes.fichas()]);
  const filas = l.filter(t => !t.interno).sort((a, b) => b.entrada.localeCompare(a.entrada)).slice(0, 400).map(t => {
    const c = clientes.clasificar(t, mapa);
    return [t.id, t.entrada?.slice(0, 16), t.cliente, c.servicio, c.tipo_cliente, t.tipo_incidencia, t.estado, t.canal,
      t.primera_respuesta?.slice(0, 16) || '', t.cierre?.slice(0, 16) || '', t.horas ?? '', t.nps ?? '', String(t.titulo || '').replace(/\s+/g, ' ').slice(0, 80)].join(' | ');
  });
  // Recuentos ya hechos: los modelos rápidos cuentan mal en una lista larga.
  const vivos = l.filter(t => !t.interno), abiertas = vivos.filter(t => t.estado !== 'Cerrado');
  const contar = (lista, f) => Object.entries(lista.reduce((m, t) => (m[f(t)] = (m[f(t)] || 0) + 1, m), {})).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`).join('; ');
  const resumen = `Resumen calculado (fiable, úsalo para contar):
- Total incidencias: ${vivos.length}; abiertas (no cerradas): ${abiertas.length}.
- Por estado: ${contar(vivos, t => t.estado)}.
- Incidencias por cliente (todas, las 30 primeras): ${contar(vivos, t => t.cliente).split('; ').slice(0, 30).join('; ')}.
- Abiertas por cliente: ${contar(abiertas, t => t.cliente)}.
- Abiertas por servicio: ${contar(abiertas, t => clientes.clasificar(t, mapa).servicio)}.
- Por tipo de incidencia: ${contar(vivos, t => t.tipo_incidencia || 'Sin tipo')}.`;
  return `Hoy es ${hoy()}.
${resumen}
Normas del servicio: la primera respuesta debe llegar en 1 hora laborable (L-V de 9 a 18); fuera de eso, «fuera de SLA».
Soporte Premium: 42 €/mes por cliente; las asesorías partner lo tienen gratis. Servicios: Premium, Implementación, Kit Digital 1.
Estados: Nuevo, En curso, Pendiente cliente (stand-by), Cerrado. NPS de 0 a 10. Horas = tiempo de soporte dedicado.

Incidencias (${filas.length}), una por línea:
id | entrada | cliente | servicio | origen del cliente | tipo | estado | canal | primera respuesta | cierre | horas | nps | título
${filas.join('\n')}`;
}

const SISTEMA = `Eres el asistente del equipo de soporte de Holded de Interactivos. Respondes en castellano, claro y breve,
con cifras concretas sacadas SOLO de los datos que te pasan. Para contar usa el «Resumen calculado»; no enseñes
cálculos ni te corrijas: da directamente la respuesta final. Si algo no está en los datos, dilo.
Usa listas cortas con guiones y **negrita** para lo importante. Nunca hables de «gestorías»: son «asesorías».`;

async function preguntar(pregunta, historial = []) {
  const k = await clave();
  if (!k) throw Object.assign(new Error('Falta la clave de Gemini'), { status: 400 });
  const cuerpo = JSON.stringify({
    systemInstruction: { parts: [{ text: SISTEMA }] },
    // Los datos van primero; luego, los últimos mensajes del chat, para poder seguir la conversación.
    contents: [
      { role: 'user', parts: [{ text: await contexto() }] },
      { role: 'model', parts: [{ text: 'Entendido, tengo los datos del soporte.' }] },
      ...historial.slice(-6).map(h => ({ role: h.de === 'yo' ? 'user' : 'model', parts: [{ text: String(h.texto || '').slice(0, 4000) }] })),
      { role: 'user', parts: [{ text: pregunta }] },
    ],
    generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
  });
  let ultimo = 'Gemini no responde';
  for (const [modelo, espera] of MODELOS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k }, body: cuerpo, signal: AbortSignal.timeout(espera),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        ultimo = [429, 503].includes(r.status) ? 'Google está saturado ahora mismo: vuelve a preguntar en un momento' : j.error?.message || `Gemini respondió ${r.status}`;
        // Clave mala o sin permiso: no sirve probar otro modelo.
        if ([400, 401, 403].includes(r.status)) throw Object.assign(new Error(ultimo), { status: 502, final: true });
        continue;
      }
      const texto = (j.candidates?.[0]?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
      if (texto) return { respuesta: texto, modelo };
      ultimo = 'Gemini no ha dado respuesta';
    } catch (e) {
      if (e.final) throw e;
      ultimo = e.name === 'TimeoutError' ? 'Google tarda demasiado en responder: vuelve a preguntar en un momento' : e.message;
    }
  }
  throw Object.assign(new Error(ultimo), { status: 502 });
}

async function rutas(req, res, ruta, { json, leerCuerpo }) {
  if (req.method === 'GET' && ruta === '/api/ia') return json(res, { configurada: !!(await clave()) }), true;
  if (req.method === 'POST' && ruta === '/api/ia/clave') {
    const k = String((await leerCuerpo(req)).clave || '').trim();
    if (k.length < 20) return json(res, { error: 'Pega la clave de API de Gemini' }, 400), true;
    const doc = (await ajustes.donde('clave', 'gemini'))[0] || { clave: 'gemini' };
    await ajustes.guardar(Object.assign(doc, { cifrada: require('./correo').cifrar(k), actualizado: new Date().toISOString() }));
    guardada = k;
    return json(res, { configurada: true }), true;
  }
  if (req.method === 'POST' && ruta === '/api/ia') {
    const d = await leerCuerpo(req);
    const pregunta = String(d.pregunta || '').trim().slice(0, 1000);
    if (!pregunta) return json(res, { error: 'Escribe la pregunta' }, 400), true;
    const historial = (Array.isArray(d.historial) ? d.historial : []).filter(h => h && (h.de === 'yo' || h.de === 'ia') && h.texto);
    try { return json(res, await preguntar(pregunta, historial)), true; }
    catch (e) { return json(res, { error: e.message }, e.status || 502), true; }
  }
  return false;
}

module.exports = { rutas, preguntar };
