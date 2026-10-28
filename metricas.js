// Métricas del servicio Holded tal como el mockup de Sunamis (el PDF): un bloque por servicio
// (Implementación y Premium) con su semáforo y los casos abiertos, y los KPI por tipo de cliente.
// Aparte, las horas por cliente del periodo para el CSV.

const SLA_MIN = 60;           // primera respuesta en menos de 1 h laborable
const KIT_DIGITAL_2 = process.env.KIT_DIGITAL_2 === '1';  // su línea, oculta hasta que abra
const [H_INI, H_FIN] = (process.env.HORARIO_LABORAL || '09:00-18:00').split('-').map(h => {
  const [hh, mm] = h.split(':').map(Number);
  return hh * 60 + (mm || 0);
});

// Minutos laborables (lunes a viernes, dentro del horario) entre dos fechas locales.
function minutosLaborables(a, b) {
  let ini = new Date(a), fin = new Date(b);
  if (!(fin > ini)) return 0;
  let total = 0;
  const d = new Date(ini.getFullYear(), ini.getMonth(), ini.getDate());
  while (d <= fin) {
    const dia = d.getDay();
    if (dia !== 0 && dia !== 6) {
      const desde = new Date(d.getTime() + H_INI * 60000), hasta = new Date(d.getTime() + H_FIN * 60000);
      const s = Math.max(desde, ini), e = Math.min(hasta, fin);
      if (e > s) total += (e - s) / 60000;
    }
    d.setDate(d.getDate() + 1);
  }
  return Math.round(total);
}

// Umbrales del mockup: OK, Atención o Crítico.
const nivel = {
  abiertas: n => n <= 5 ? 'ok' : n <= 10 ? 'atencion' : 'critico',
  fueraSla: n => n === 0 ? 'ok' : n === 1 ? 'atencion' : 'critico',
  excedido: m => m === 0 ? 'ok' : m <= 30 ? 'atencion' : 'critico',
  valoracion: v => v == null ? null : v >= 4.5 ? 'ok' : v >= 4 ? 'atencion' : 'critico',
};
const peor = (...l) => l.includes('critico') ? 'critico' : l.includes('atencion') ? 'atencion' : 'ok';

const dia = s => String(s || '').slice(0, 10);
const r1 = n => Math.round(n * 10) / 10;
const media = l => l.length ? l.reduce((a, b) => a + b, 0) / l.length : null;
const fechaLocal = d => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);

// Valoración media sobre 5 a partir del NPS (0–10) de los tickets cerrados.
function valoracion(lista) {
  const n = lista.map(t => t.nps).filter(x => x != null);
  return { respuestas: n.length, media5: n.length ? r1(media(n) / 2) : null };
}

function resumen(todos, { desde, hasta, tecnico }, ahora = new Date()) {
  const ahoraLocal = fechaLocal(ahora);
  const filtrados = todos.filter(t => !t.interno && (!tecnico || t.tecnico === tecnico));
  const enPeriodo = t => dia(t.entrada) >= desde && dia(t.entrada) <= hasta;
  const cerradoEnPeriodo = t => t.estado === 'Cerrado' && dia(t.cierre) >= desde && dia(t.cierre) <= hasta;

  // Espera hasta la primera respuesta, en minutos laborables (hasta ahora si aún no hay).
  const espera = t => minutosLaborables(t.entrada, t.primera_respuesta || ahoraLocal);
  // El SLA solo se mide en tickets de la app: el Sheet no guardaba la primera respuesta.
  const conSla = t => t.origen !== 'Sheet';
  // Juzgable: ya tiene respuesta, o lleva más de la hora sin ella (un ticket de hace 5 minutos aún no cuenta).
  const juzgable = t => conSla(t) && (t.primera_respuesta || espera(t) > SLA_MIN);

  const horasDe = lista => r1(lista.reduce((s, t) => s + t.trabajo
    .filter(w => w.fecha >= desde && w.fecha <= hasta && (!tecnico || w.tecnico === tecnico))
    .reduce((a, w) => a + w.horas, 0), 0));

  // Indicadores de ahora (abiertas, tiempo excedido) y del periodo (fuera de SLA, valoración).
  const bloque = (lista, nombre) => {
    const abiertas = lista.filter(t => t.estado !== 'Cerrado');
    const medibles = lista.filter(enPeriodo).filter(juzgable);
    const fuera = medibles.filter(t => espera(t) > SLA_MIN).length;
    const excedido = abiertas.filter(t => conSla(t) && !t.primera_respuesta).reduce((s, t) => s + Math.max(0, espera(t) - SLA_MIN), 0);
    const val = valoracion(lista.filter(cerradoEnPeriodo));
    // Sin ninguna incidencia no hay nada que juzgar: «Sin datos», no «OK».
    const vacio = !lista.length;
    const niveles = vacio ? { abiertas: null, fueraSla: null, excedido: null, valoracion: null }
      : { abiertas: nivel.abiertas(abiertas.length), fueraSla: medibles.length || abiertas.length ? nivel.fueraSla(fuera) : null, excedido: nivel.excedido(excedido), valoracion: nivel.valoracion(val.media5) };
    return {
      nombre,
      vacio,
      estado: vacio ? null : peor(...Object.values(niveles).filter(Boolean)),
      niveles,
      abiertas: abiertas.length,
      fueraSla: fuera,
      excedidoMin: excedido,
      valoracion: val.media5,
      respuestasNps: val.respuestas,
      // Horas dedicadas en el periodo (cronómetro y horas del Sheet).
      horas: horasDe(lista),
      // Qué hay detrás de cada indicador, para el «Por qué» del panel: quién, qué y cuánto.
      detalle: {
        fueraSla: medibles.filter(t => espera(t) > SLA_MIN).sort((a, b) => espera(b) - espera(a)).map(t => ({
          id: t.id, cliente: t.cliente, titulo: t.titulo, entrada: t.entrada, esperaMin: espera(t), respondido: !!t.primera_respuesta,
        })),
        excedido: abiertas.filter(t => conSla(t) && !t.primera_respuesta && espera(t) > SLA_MIN).sort((a, b) => espera(b) - espera(a)).map(t => ({
          id: t.id, cliente: t.cliente, titulo: t.titulo, entrada: t.entrada, excesoMin: espera(t) - SLA_MIN,
        })),
        // Las valoraciones más bajas primero: son las que bajan la media.
        valoracion: lista.filter(cerradoEnPeriodo).filter(t => t.nps != null).sort((a, b) => a.nps - b.nps || b.cierre.localeCompare(a.cierre)).map(t => ({
          id: t.id, cliente: t.cliente, contacto: t.contacto || '', titulo: t.titulo, nps: t.nps, cierre: t.cierre, mejora: t.mejora || '',
        })),
      },
      // Cada KPI por cliente, para su detalle en el panel (como en Super Gemas): dentro del periodo,
      // salvo abiertas y tiempo excedido, que son de ahora.
      detalleClientes: [...new Set(lista.map(t => t.cliente))].map(cliente => {
        const l = lista.filter(t => t.cliente === cliente);
        const ab = l.filter(t => t.estado !== 'Cerrado');
        const ex = ab.filter(t => conSla(t) && !t.primera_respuesta && espera(t) > SLA_MIN);
        const fu = l.filter(enPeriodo).filter(juzgable).filter(t => espera(t) > SLA_MIN);
        return {
          cliente, origen: l[0].tipo_cliente, tickets: l.filter(enPeriodo).length, horas: horasDe(l),
          abiertas: ab.map(t => ({ id: t.id, titulo: t.titulo })),
          excedidoMin: ex.reduce((s, t) => s + espera(t) - SLA_MIN, 0),
          excedidos: ex.map(t => ({ id: t.id, titulo: t.titulo, excesoMin: espera(t) - SLA_MIN })),
          fueraSla: fu.map(t => ({ id: t.id, titulo: t.titulo, esperaMin: espera(t) })),
          valoraciones: l.filter(cerradoEnPeriodo).filter(t => t.nps != null).map(t => ({ id: t.id, titulo: t.titulo, contacto: t.contacto || '', nps: t.nps, mejora: t.mejora || '' })),
        };
      }),
      casos: abiertas.sort((a, b) => a.entrada.localeCompare(b.entrada)).map(t => ({
        id: t.id, cliente: t.cliente, titulo: t.titulo, origen: t.tipo_cliente, canal: t.canal, tipo: t.tipo_incidencia,
        tecnico: t.tecnico, estado: t.estado, entrada: t.entrada, respondido: !!t.primera_respuesta,
        esperaMin: conSla(t) ? espera(t) : null,
      })),
    };
  };

  const porCliente = new Map();
  for (const t of filtrados) (porCliente.get(t.cliente) || porCliente.set(t.cliente, []).get(t.cliente)).push(t);

  return {
    actualizado: ahora.toISOString(),
    periodo: { desde, hasta },
    // Soporte Premium primero e Implementación después (28/10/2026): cada uno con todo sumado.
    servicios: ['Premium', 'Implementación', ...(KIT_DIGITAL_2 ? ['Kit Digital 2'] : [])].map(s => bloque(filtrados.filter(t => t.servicio === s), s)),
    // Los clientes antiguos (Kit Digital) no están en el mockup, y el antiguo formulario no medía
    // ni la primera respuesta ni la valoración: de ellos se enseña lo que pidieron en el periodo.
    antiguos: (() => {
      const l = filtrados.filter(t => t.servicio === 'Kit Digital 1'), periodo = l.filter(enPeriodo);
      // Horas de todo el histórico, además de las del periodo: casi todo es del antiguo formulario.
      const horasTotales = r1(l.reduce((s, t) => s + t.trabajo.filter(w => !tecnico || w.tecnico === tecnico).reduce((a, w) => a + w.horas, 0), 0));
      return { ...bloque(l, 'Kit Digital 1'), tickets: periodo.length, horas: horasDe(l), horasTotales, ticketsTotales: l.length, clientes: new Set(periodo.map(t => t.cliente)).size };
    })(),
    // Los grupos de la página 2 del mockup. Los clientes sin origen no entran en ninguno.
    porTipo: [
      { servicio: 'Premium', grupos: [
        { nombre: 'Asesoría partner', origenes: ['Asesoría'] },
        { nombre: 'Referenciado por asesoría', origenes: ['Referenciado por asesoría'] },
        { nombre: 'Cliente directo', origenes: ['Directo', 'Antiguo cliente AKIRA'] },
      ] },
      { servicio: 'Implementación', grupos: [
        { nombre: 'Referenciado por asesoría', origenes: ['Referenciado por asesoría', 'Asesoría'] },
        { nombre: 'Cliente directo', origenes: ['Directo', 'Antiguo cliente AKIRA'] },
      ] },
      // Kit Digital 2: casi seguro que todos serán directos; si no, se añade aquí su grupo.
      ...(KIT_DIGITAL_2 ? [{ servicio: 'Kit Digital 2', grupos: [
        { nombre: 'Cliente directo', origenes: ['Directo', 'Antiguo cliente AKIRA', 'Sin clasificar'] },
      ] }] : []),
    ].map(s => {
      const del = filtrados.filter(t => t.servicio === s.servicio);
      return {
        servicio: s.servicio,
        sinOrigen: new Set(del.filter(t => !s.grupos.some(g => g.origenes.includes(t.tipo_cliente))).map(t => t.cliente)).size,
        grupos: s.grupos.map(g => bloque(del.filter(t => g.origenes.includes(t.tipo_cliente)), g.nombre)),
      };
    }),
    // Para el CSV: horas por cliente en el periodo, de todos los servicios.
    porCliente: [...porCliente].map(([nombre, l]) => ({
      nombre, servicio: l[0].servicio, origen: l[0].tipo_cliente,
      tickets: l.filter(enPeriodo).length, horas: horasDe(l),
    })).filter(c => c.tickets || c.horas).sort((a, b) => b.horas - a.horas || b.tickets - a.tickets),
  };
}

// Horas por cliente en CSV para Excel (punto y coma, coma decimal y BOM).
function csvHoras(r) {
  const fila = c => [c.nombre, c.servicio, c.origen, c.tickets, String(c.horas).replace('.', ',')]
    .map(v => `"${String(v).replace(/"/g, '""')}"`).join(';');
  return '﻿' + ['Cliente;Servicio;Origen;Tickets;Horas', ...r.porCliente.map(fila)].join('\r\n');
}

module.exports = { resumen, csvHoras, minutosLaborables };
