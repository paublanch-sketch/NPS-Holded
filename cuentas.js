// Cuentas del portal (28/10/2026): el portal es privado. Cada cliente Premium (y cada asesoría
// partner) entra con su correo y contraseña y ve las incidencias de su empresa desde cualquier
// dispositivo. Las cuentas las damos de alta nosotros desde el panel (Asesorías o la ficha del
// cliente): al cliente le llega un correo para poner su contraseña. También puede pedir otra
// si la olvida. Un ticket de un cliente con cuenta solo se abre entrando con esa cuenta.
const crypto = require('crypto');
const { cuentas, tickets: almacen } = require('./store');

const COOKIE = 'sh_cliente';
const DIAS_SESION = 60;
const DIAS_INVITACION = 7;
const HORAS_RECUPERAR = 2;
const SECRETO = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const URL_PUBLICA = () => (process.env.PUBLIC_URL || '').replace(/\/$/, '');

const normal = e => String(e || '').trim().toLowerCase();
const correoValido = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const firmar = s => crypto.createHmac('sha256', SECRETO).update(s).digest('base64url');

// Contraseñas con scrypt y sal propia; se comparan en tiempo constante.
function hashClave(clave) {
  const sal = crypto.randomBytes(16);
  return `${sal.toString('hex')}:${crypto.scryptSync(clave, sal, 32).toString('hex')}`;
}
function claveBuena(clave, guardado) {
  const [sal, hash] = String(guardado || '').split(':');
  if (!sal || !hash) return false;
  const otra = crypto.scryptSync(String(clave), Buffer.from(sal, 'hex'), 32);
  return crypto.timingSafeEqual(otra, Buffer.from(hash, 'hex'));
}

// Sesión: id de la cuenta y su «versión» (sube al cambiar la contraseña o quitar el acceso,
// y así se cierran las sesiones abiertas en otros dispositivos).
function ponerCookie(req, res, valor, maxAge) {
  const segura = req.headers['x-forwarded-proto'] === 'https' || /^https:/.test(process.env.PUBLIC_URL || '');
  const previas = [].concat(res.getHeader('Set-Cookie') || []);
  res.setHeader('Set-Cookie', [...previas, `${COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${segura ? '; Secure' : ''}`]);
}
function abrirSesion(req, res, c) {
  const datos = Buffer.from(JSON.stringify({ id: c.id, v: c.version || 1, exp: Date.now() + DIAS_SESION * 864e5 })).toString('base64url');
  ponerCookie(req, res, `${datos}.${firmar(datos)}`, DIAS_SESION * 86400);
}
async function cuentaDe(req) {
  const c = (req.headers.cookie || '').split(/;\s*/).find(x => x.startsWith(COOKIE + '='));
  if (!c) return null;
  const [datos, firma] = c.slice(COOKIE.length + 1).split('.');
  if (!datos || !firma || firmar(datos) !== firma) return null;
  try {
    const s = JSON.parse(Buffer.from(datos, 'base64url').toString());
    if (s.exp < Date.now()) return null;
    const cuenta = await cuentas.uno(s.id);
    return cuenta && cuenta.activa !== false && cuenta.hash && (cuenta.version || 1) === s.v ? cuenta : null;
  } catch { return null; }
}

// Un ticket se puede abrir si su cliente no tiene cuentas (enlaces de antes y canales sin
// login, como WhatsApp o el correo de clientes sin portal) o con una cuenta de ese cliente.
async function puedeVer(req, t) {
  const delCliente = (await cuentas.todos()).filter(c => c.cliente === t.cliente && c.activa !== false);
  if (!delCliente.length) return true;
  const c = await cuentaDe(req);
  if (c && c.cliente === t.cliente) return true;
  // El equipo también lo abre, desde «Ver como cliente» del panel.
  return !!(await require('./auth').usuarioDe(req));
}

// Enlace de un solo uso para poner la contraseña (alta) o cambiarla (olvido).
function nuevoEnlace(c, tipo) {
  const token = crypto.randomBytes(24).toString('hex');
  c.enlace = { hash: sha(token), tipo, caduca: Date.now() + (tipo === 'alta' ? DIAS_INVITACION * 864e5 : HORAS_RECUPERAR * 36e5) };
  return `${URL_PUBLICA()}/?clave=${token}`;
}
async function enviarEnlace(c, url) {
  const correo = require('./correo');
  if (!correo.hayCorreo()) return false;
  const alta = c.enlace.tipo === 'alta';
  const titulo = alta ? 'Tu acceso al Soporte Holded' : 'Cambia tu contraseña del Soporte Holded';
  const texto = alta
    ? `Hola${c.nombre ? ' ' + c.nombre.split(' ')[0] : ''}:\n\nYa tienes acceso al Soporte Holded de Interactivos. Desde allí abres tus incidencias y ves cómo van, desde cualquier dispositivo.\n\nPon tu contraseña con el botón (el enlace vale ${DIAS_INVITACION} días).`
    : `Hola${c.nombre ? ' ' + c.nombre.split(' ')[0] : ''}:\n\nHas pedido cambiar la contraseña del Soporte Holded. Ponla con el botón (el enlace vale ${HORAS_RECUPERAR} horas).\n\nSi no lo has pedido tú, no hagas nada: tu contraseña sigue igual.`;
  return correo.enviarSinEsperar({
    to: c.email, subject: titulo,
    text: `${texto}\n\n${alta ? 'Poner mi contraseña' : 'Cambiar la contraseña'}: ${url}`,
    html: correo.plantilla({ titulo, cuerpo: correo.parrafos(texto), boton: { texto: alta ? 'Poner mi contraseña' : 'Cambiar la contraseña', url }, pie: 'Correo enviado desde el Soporte Holded de Interactivos.' }),
  });
}

// Alta de una cuenta (o nueva invitación si ya existe) desde el panel.
async function darAcceso({ cliente, email, nombre }) {
  email = normal(email);
  if (!cliente) throw Object.assign(new Error('Falta el cliente'), { status: 400 });
  if (!correoValido(email)) throw Object.assign(new Error('Pon un correo válido'), { status: 400 });
  const todas = await cuentas.todos();
  const otra = todas.find(c => c.email === email && c.cliente !== cliente && c.activa !== false);
  if (otra) throw Object.assign(new Error(`Ese correo ya tiene acceso como ${otra.cliente}`), { status: 409 });
  const antes = todas.find(x => x.email === email && x.cliente === cliente);
  const c = antes || { email, cliente, creada: new Date().toISOString(), version: 1 };
  // Para que el panel diga qué ha pasado: acceso nuevo, ya tenía cuenta o ya estaba invitado.
  const nueva = !antes || antes.activa === false;
  Object.assign(c, { nombre: String(nombre || c.nombre || '').trim().slice(0, 120), activa: true });
  const url = nuevoEnlace(c, 'alta');
  await cuentas.guardar(c);
  let enviado = false;
  try { enviado = await enviarEnlace(c, url); } catch (e) { console.error('Cuentas (invitación):', e.message); }
  // Si el correo no sale, el panel enseña el enlace para pasarlo a mano.
  return { id: c.id, email, nueva, conClave: !nueva && !!c.hash, enviado, enlace: enviado ? null : url, correoCaido: !enviado && require('./correo').envioCaido() };
}

// Primera vez que entra (tiene acceso pero aún no contraseña): un código de 6 cifras al correo para
// ponerla. Sin él, cualquiera que supiera el correo de un cliente podría quedarse con su cuenta.
const MIN_CODIGO = 15;
async function enviarCodigo(c) {
  // Si se pide otra vez antes de un minuto, vale el que acaba de salir.
  if (c.codigo?.enviado && Date.now() - c.codigo.creado < 60000) return { enviado: true };
  const codigo = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  c.codigo = { hash: sha(codigo), creado: Date.now(), caduca: Date.now() + MIN_CODIGO * 60000, intentos: 0, enviado: false };
  await cuentas.guardar(c);
  const correo = require('./correo');
  if (!correo.hayCorreo()) return { enviado: false };
  const texto = `Hola${c.nombre ? ' ' + c.nombre.split(' ')[0] : ''}:\n\nTu código para entrar por primera vez en el Soporte Holded es ${codigo}. Escríbelo en la página y elige tu contraseña. Vale ${MIN_CODIGO} minutos.\n\nSi no lo has pedido tú, no hagas nada.`;
  try {
    c.codigo.enviado = await correo.enviarSinEsperar({ to: c.email, subject: `${codigo} es tu código del Soporte Holded`, text: texto,
      html: correo.plantilla({ titulo: `Tu código: ${codigo}`, cuerpo: correo.parrafos(texto), pie: 'Correo enviado desde el Soporte Holded de Interactivos.' }) });
  } catch (e) { console.error('Cuentas (código):', e.message); }
  await cuentas.guardar(c);
  return { enviado: c.codigo.enviado };
}

const reciente = new Map();
const ipDe = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
function frenar(req, clave, max, minutos) {
  const k = `${clave}:${ipDe(req)}`, ahora = Date.now();
  const l = (reciente.get(k) || []).filter(x => ahora - x < minutos * 60000);
  reciente.set(k, [...l, ahora]);
  return l.length >= max;
}

const estadoCliente = t => t.estado === 'Cerrado' ? 'Resuelta' : t.estado === 'Pendiente cliente' ? 'Esperando tu respuesta' : t.estado === 'Nuevo' ? 'Recibida' : 'En curso';
const tituloDe = t => t.asunto || t.tipo_incidencia || 'Tu incidencia';

// Rutas del portal (públicas: cada una mira la sesión).
async function rutas(req, res, ruta, { json, leerCuerpo }) {
  if (!ruta.startsWith('/api/cuenta')) return false;
  if (req.method === 'GET' && ruta === '/api/cuenta') {
    const c = await cuentaDe(req);
    return c ? json(res, { email: c.email, nombre: c.nombre, cliente: c.cliente }) : json(res, { error: 'Sin sesión' }, 401), true;
  }
  if (req.method === 'POST' && ruta === '/api/cuenta/entrar') {
    const b = await leerCuerpo(req);
    const email = normal(b.email);
    if (frenar(req, 'entrar:' + email, 8, 15)) return json(res, { error: 'Demasiados intentos. Prueba dentro de un rato.' }, 429), true;
    const c = (await cuentas.todos()).find(x => x.email === email && x.activa !== false && x.hash);
    if (!c || !claveBuena(String(b.clave || ''), c.hash)) return json(res, { error: 'El correo o la contraseña no son correctos.' }, 401), true;
    c.ultimoAcceso = new Date().toISOString();
    await cuentas.guardar(c);
    abrirSesion(req, res, c);
    return json(res, { email: c.email, nombre: c.nombre, cliente: c.cliente }), true;
  }
  // Entrar en dos pasos (29/10/2026): primero solo el correo. Si ya tiene contraseña, se le pide;
  // si es la primera vez, le llega el código para ponerla (también para pedir otro).
  if (req.method === 'POST' && ruta === '/api/cuenta/inicio') {
    const email = normal((await leerCuerpo(req)).email);
    if (frenar(req, 'inicio', 20, 15)) return json(res, { error: 'Demasiados intentos. Prueba dentro de un rato.' }, 429), true;
    const c = (await cuentas.todos()).find(x => x.email === email && x.activa !== false);
    if (!c) return json(res, { error: 'Este correo no tiene acceso al portal. Pídeselo a tu técnico de Interactivos.' }, 404), true;
    if (c.hash) return json(res, { paso: 'clave', nombre: c.nombre || '' }), true;
    if (frenar(req, 'codigo:' + email, 5, 15)) return json(res, { error: 'Ya te hemos enviado varios códigos. Prueba dentro de un rato.' }, 429), true;
    return json(res, { paso: 'codigo', nombre: c.nombre || '', minutos: MIN_CODIGO, ...(await enviarCodigo(c)) }), true;
  }
  if (req.method === 'POST' && ruta === '/api/cuenta/primera') {
    const b = await leerCuerpo(req);
    const email = normal(b.email), codigo = String(b.codigo || '').replace(/\D/g, ''), clave = String(b.clave || '');
    if (frenar(req, 'primera:' + email, 10, 15)) return json(res, { error: 'Demasiados intentos. Prueba dentro de un rato.' }, 429), true;
    if (clave.length < 8) return json(res, { error: 'La contraseña tiene que tener 8 caracteres o más.' }, 400), true;
    const c = (await cuentas.todos()).find(x => x.email === email && x.activa !== false && !x.hash);
    if (!c?.codigo || c.codigo.caduca < Date.now() || c.codigo.intentos >= 5) return json(res, { error: 'El código ha caducado. Pide otro.' }, 400), true;
    if (sha(codigo) !== c.codigo.hash) {
      c.codigo.intentos++;
      await cuentas.guardar(c);
      return json(res, { error: 'El código no es correcto. Revisa el último correo que te hemos enviado.' }, 400), true;
    }
    Object.assign(c, { hash: hashClave(clave), codigo: null, enlace: null, version: (c.version || 1) + 1, ultimoAcceso: new Date().toISOString() });
    await cuentas.guardar(c);
    abrirSesion(req, res, c);
    return json(res, { email: c.email, nombre: c.nombre, cliente: c.cliente }), true;
  }
  if (req.method === 'POST' && ruta === '/api/cuenta/salir') {
    ponerCookie(req, res, '', 0);
    return json(res, { ok: true }), true;
  }
  // «¿Has olvidado tu contraseña?»: responde siempre igual, exista o no la cuenta.
  if (req.method === 'POST' && ruta === '/api/cuenta/olvido') {
    const email = normal((await leerCuerpo(req)).email);
    if (frenar(req, 'olvido', 5, 60)) return json(res, { error: 'Demasiadas peticiones. Prueba dentro de un rato.' }, 429), true;
    const c = (await cuentas.todos()).find(x => x.email === email && x.activa !== false);
    if (c) {
      const url = nuevoEnlace(c, c.hash ? 'clave' : 'alta');
      await cuentas.guardar(c);
      enviarEnlace(c, url).catch(e => console.error('Cuentas (olvido):', e.message));
    }
    return json(res, { ok: true }), true;
  }
  // Poner la contraseña con el enlace del correo (alta u olvido). Deja la sesión abierta.
  if (req.method === 'POST' && ruta === '/api/cuenta/clave') {
    const b = await leerCuerpo(req);
    const clave = String(b.clave || '');
    if (clave.length < 8) return json(res, { error: 'La contraseña tiene que tener 8 caracteres o más.' }, 400), true;
    const h = sha(String(b.token || ''));
    const c = (await cuentas.todos()).find(x => x.enlace?.hash === h && x.activa !== false);
    if (!c || c.enlace.caduca < Date.now()) return json(res, { error: 'El enlace ya no vale: caduca a los pocos días o ya se ha usado. Pide uno nuevo.' }, 400), true;
    Object.assign(c, { hash: hashClave(clave), enlace: null, version: (c.version || 1) + 1, ultimoAcceso: new Date().toISOString() });
    await cuentas.guardar(c);
    abrirSesion(req, res, c);
    return json(res, { email: c.email, nombre: c.nombre, cliente: c.cliente }), true;
  }
  const c = await cuentaDe(req);
  if (!c) return json(res, { error: 'Entra con tu cuenta', login: true }, 401), true;
  // Las incidencias de la empresa: abiertas primero; luego las cerradas, de la más reciente a la más antigua.
  if (req.method === 'GET' && ruta === '/api/cuenta/tickets') {
    const l = (await almacen.todos()).filter(t => t.cliente === c.cliente && !t.archivado).map(t => ({
      token: t.token, titulo: tituloDe(t), estado: estadoCliente(t), abierta: t.estado !== 'Cerrado', esperando: t.estado === 'Pendiente cliente',
      fecha: t.entrada, actualizado: t.mensajes.at(-1)?.fecha || t.entrada, cierre: t.cierre || '',
    })).sort((a, b) => (b.abierta - a.abierta) || (b.abierta ? b.actualizado.localeCompare(a.actualizado) : (b.cierre || b.fecha).localeCompare(a.cierre || a.fecha)));
    return json(res, l), true;
  }
  // Nueva incidencia con los datos de la cuenta: ya no se piden empresa, nombre ni correo.
  if (req.method === 'POST' && ruta === '/api/cuenta/ticket') {
    const b = await leerCuerpo(req);
    const t = await require('./tickets').abrirDesdePortal({ empresa: c.cliente, contacto: c.nombre, email: c.email, tipo: b.tipo, descripcion: b.descripcion });
    return json(res, { token: t.token }, 201), true;
  }
  return false;
}

// Rutas del panel (ya autenticadas): quién tiene acceso a qué cliente.
async function rutasPanel(req, res, ruta, { json, leerCuerpo }) {
  if (!ruta.startsWith('/api/accesos')) return false;
  const vista = c => ({ id: c.id, email: c.email, nombre: c.nombre, cliente: c.cliente, estado: c.hash ? 'Activa' : 'Invitada', invitacionCaducada: !c.hash && c.enlace?.caduca < Date.now(), ultimoAcceso: c.ultimoAcceso || null, creada: c.creada });
  if (req.method === 'GET' && ruta === '/api/accesos') {
    return json(res, (await cuentas.todos()).filter(c => c.activa !== false).map(vista)), true;
  }
  if (req.method === 'POST' && ruta === '/api/accesos') {
    return json(res, await darAcceso(await leerCuerpo(req))), true;
  }
  if (req.method === 'POST' && ruta === '/api/accesos/quitar') {
    const c = await cuentas.uno((await leerCuerpo(req)).id);
    if (!c) return json(res, { error: 'No existe' }, 404), true;
    // Fuera también la contraseña: si se le vuelve a dar acceso, pondrá una nueva.
    Object.assign(c, { activa: false, hash: null, enlace: null, version: (c.version || 1) + 1 });
    await cuentas.guardar(c);
    return json(res, { ok: true }), true;
  }
  return false;
}

module.exports = { rutas, rutasPanel, puedeVer, cuentaDe, darAcceso, hashClave, claveBuena };
