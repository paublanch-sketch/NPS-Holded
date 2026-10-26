// Adjuntos de los tickets: capturas, PDF y documentos que sube el cliente desde el portal
// o que llegan con un correo. Se guardan en la base de datos (base64 dentro del JSONB).
const { adjuntos } = require('./store');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_POR_TICKET = 15;
// Solo tipos que no se ejecutan en el navegador (nada de HTML ni SVG).
const PERMITIDOS = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  zip: 'application/zip', eml: 'message/rfc822',
};
const extension = nombre => String(nombre || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1] || '';

function validar(nombre, bytes) {
  const tipo = PERMITIDOS[extension(nombre)];
  if (!tipo) return { error: 'Tipo de archivo no admitido. Sube imágenes, PDF, Excel, Word, texto o ZIP.' };
  if (!bytes) return { error: 'El archivo está vacío.' };
  if (bytes > MAX_BYTES) return { error: 'El archivo pasa de 8 MB.' };
  return { tipo };
}

const limpiarNombre = n => String(n || 'archivo').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(-120);

// Guarda un adjunto y devuelve sus datos sin el contenido.
async function guardar({ ticket, nombre, buffer, origen }) {
  nombre = limpiarNombre(nombre);
  const v = validar(nombre, buffer.length);
  if (v.error) throw Object.assign(new Error(v.error), { status: 400 });
  if ((await adjuntos.donde('ticket', ticket)).length >= MAX_POR_TICKET)
    throw Object.assign(new Error(`Máximo ${MAX_POR_TICKET} archivos por incidencia.`), { status: 400 });
  const a = await adjuntos.guardar({ ticket, nombre, tipo: v.tipo, tamano: buffer.length, origen, fecha: new Date().toISOString(), datos: buffer.toString('base64') });
  return { id: a.id, nombre, tipo: v.tipo, tamano: buffer.length };
}

// Imágenes y PDF se ven en el navegador; el resto se descarga.
function servir(res, a) {
  const enLinea = /^image\/(png|jpeg|gif|webp)$|^application\/pdf$/.test(a.tipo);
  res.writeHead(200, {
    'Content-Type': a.tipo,
    'Content-Length': Buffer.byteLength(a.datos, 'base64'),
    'Content-Disposition': `${enLinea ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.nombre)}`,
    'Cache-Control': 'private, max-age=3600',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
  });
  res.end(Buffer.from(a.datos, 'base64'));
}

function leerCrudo(req, limite = MAX_BYTES) {
  return new Promise((ok, ko) => {
    const partes = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limite) { ko(Object.assign(new Error('El archivo pasa de 8 MB.'), { status: 413 })); req.destroy(); }
      else partes.push(c);
    });
    req.on('end', () => ok(Buffer.concat(partes)));
    req.on('error', ko);
  });
}

module.exports = { guardar, servir, leerCrudo, adjuntos, validar, MAX_BYTES };
