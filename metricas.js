// Métricas del servicio Holded según el mockup de Sunamis: bloques por servicio con su
// semáforo, KPI por tipo de cliente, horas, NPS y comercial, filtrables por periodo.
const { SERVICIOS } = require('./clientes');

const SLA_MIN = 60;           // primera respuesta en menos de 1 h laborable
const RESPUESTA_CLIENTE = 15; // días que el cliente tiene para firmar o pagar
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
const mediana = l => {
  if (!l.length) return null;
  const s = [...l].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function nps(lista) {
  const n = lista.map(t => t.nps).filter(x => x != null);
  if (!n.length) return { respuestas: 0, score: null, media5: null, promotores: 0, pasivos: 0, detractores: 0 };
  const p = n.filter(x => x >= 9).length, d = n.filter(x => x <= 6).length;
  return {
    respuestas: n.length, score: Math.round((p - d) / n.length * 100), media5: r1(media(n) / 2),
    promotores: p, pasivos: n.length - p - d, detractores: d,
  };
}

// Primeros días de cada semana (lunes) o mes entre dos fechas, para las series.
function cortes(desde, hasta) {
  const dias = (new Date(hasta) - new Date(desde)) / 864e5;
  const porMes = dias > 190;
  const l = [];
  const d = new Date(desde + 'T00:00');
  if (porMes) d.setDate(1); else d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  while (dia(fechaLocal(d)) <= hasta) {
    l.push(dia(fechaLocal(d)));
    porMes ? d.setMonth(d.getMonth() + 1) : d.setDate(d.getDate() + 7);
  }
  return { porMes, l };
}
const fechaLocal = d => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);

function resumen(todos, { desde, hasta, servicio, tecnico, tipo_cliente }, comercial, ahora = new Date()) {
  const ahoraLocal = fechaLocal(ahora);
  const filtrados = todos.filter(t => !t.interno
    && (!servicio || t.servicio === servicio)
    && (!tipo_cliente || t.tipo_cliente === tipo_cliente)
    && (!tecnico || t.tecnico === tecnico));
  const enPeriodo = t => dia(t.entrada) >= desde && dia(t.entrada) <= hasta;
  const cerradoEnPeriodo = t => t.estado === 'Cerrado' && dia(t.cierre) >= desde && dia(t.cierre) <= hasta;
  const delPeriodo = filtrados.filter(enPeriodo);

  // Espera hasta la primera respuesta, en minutos laborables (hasta ahora si aún no hay).
  const espera = t => minutosLaborables(t.entrada, t.primera_respuesta || ahoraLocal);
  // El SLA solo se mide en tickets de la app: el Sheet no guardaba la primera respuesta.
  const conSla = t => t.origen !== 'Sheet';
  // Juzgable: ya tiene respuesta, o lleva más de la hora sin ella (un ticket de hace 5 minutos aún no cuenta).
  const juzgable = t => conSla(t) && (t.primera_respuesta || espera(t) > SLA_MIN);

  const horasDe = lista => r1(lista.reduce((s, t) => s + t.trabajo
    .filter(w => w.fecha >= desde && w.fecha <= hasta && (!tecnico || w.tecnico === tecnico))
    .reduce((a, w) => a + w.horas, 0), 0));

  const bloque = (lista, nombre) => {
    const abiertas = lista.filter(t => t.estado !== 'Cerrado');
    const periodo = lista.filter(enPeriodo);
    const medibles = periodo.filter(juzgable);
    const fuera = medibles.filter(t => espera(t) > SLA_MIN).length;
    const excedido = abiertas.filter(t => conSla(t) && !t.primera_respuesta).reduce((s, t) => s + Math.max(0, espera(t) - SLA_MIN), 0);
    const cerradasPeriodo = lista.filter(cerradoEnPeriodo);
    const val = nps(cerradasPeriodo);
    const dias = cerradasPeriodo.map(t => (new Date(t.cierre) - new Date(t.entrada)) / 864e5).filter(d => d >= 0);
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
      slaMedibles: medibles.length,
      excedidoMin: excedido,
      valoracion: val.media5,
      respuestasNps: val.respuestas,
      // Lo del periodo elegido (los indicadores de arriba son de ahora mismo).
      tickets: periodo.length,
      horas: horasDe(lista),
      clientes: new Set(periodo.map(t => t.cliente)).size,
      diasResolucion: dias.length ? r1(media(dias)) : null,
      // Del antiguo formulario: no guardaba la primera respuesta ni la valoración.
      historico: periodo.filter(t => !conSla(t)).length,
      casos: abiertas.sort((a, b) => a.entrada.localeCompare(b.entrada)).map(t => ({
        id: t.id, cliente: t.cliente, origen: t.tipo_cliente, canal: t.canal, tipo: t.tipo_incidencia,
        tecnico: t.tecnico, estado: t.estado, entrada: t.entrada, respondido: !!t.primera_respuesta,
        esperaMin: conSla(t) ? espera(t) : null,
      })),
    };
  };

  const agrupar = (lista, clave) => {
    const m = new Map();
    for (const t of lista) { const k = clave(t); (m.get(k) || m.set(k, []).get(k)).push(t); }
    return m;
  };

  // Series por semana (o por mes si el periodo es largo).
  const { porMes, l: inicios } = cortes(desde, hasta);
  const tramo = f => { let i = inicios.length - 1; while (i > 0 && f < inicios[i]) i--; return i; };
  const serie = inicios.map(f => ({ desde: f, tickets: 0, horas: 0 }));
  for (const t of delPeriodo) serie[tramo(dia(t.entrada))].tickets++;
  for (const t of filtrados) for (const w of t.trabajo)
    if (w.fecha >= desde && w.fecha <= hasta && (!tecnico || w.tecnico === tecnico)) serie[tramo(w.fecha)].horas += w.horas;
  serie.forEach(p => { p.horas = r1(p.horas); });

  // Horas por cliente y por técnico en el periodo.
  const porCliente = [...agrupar(filtrados, t => t.cliente)].map(([nombre, l]) => ({
    nombre, servicio: l[0].servicio, origen: l[0].tipo_cliente,
    tickets: l.filter(enPeriodo).length, horas: horasDe(l),
  })).filter(c => c.tickets || c.horas).sort((a, b) => b.horas - a.horas || b.tickets - a.tickets);

  const tecnicos = new Map();
  for (const t of filtrados) {
    if (enPeriodo(t)) { const x = tecnicos.get(t.tecnico || 'Sin asignar') || { nombre: t.tecnico || 'Sin asignar', tickets: 0, horas: 0 }; x.tickets++; tecnicos.set(x.nombre, x); }
    for (const w of t.trabajo) if (w.fecha >= desde && w.fecha <= hasta && (!tecnico || w.tecnico === tecnico)) {
      const n = w.tecnico || 'Sin asignar';
      const x = tecnicos.get(n) || { nombre: n, tickets: 0, horas: 0 };
      x.horas += w.horas; tecnicos.set(n, x);
    }
  }

  const cerrados = filtrados.filter(cerradoEnPeriodo);
  const resolucion = cerrados.map(t => (new Date(t.cierre) - new Date(t.entrada)) / 864e5).filter(d => d >= 0);
  const primeras = delPeriodo.filter(t => conSla(t) && t.primera_respuesta).map(espera);
  const medibles = delPeriodo.filter(juzgable);
  const valoracion = nps(cerrados);
  const satisfechos = new Set(cerrados.filter(t => t.nps >= 9).map(t => t.cliente));
  const clientesPeriodo = agrupar(delPeriodo, t => t.cliente);
  const porOrigen = [...agrupar([...clientesPeriodo.values()].map(l => l[0]).filter(t => t.servicio === 'Implementación' || t.servicio === 'Premium'), t => t.tipo_cliente)]
    .map(([nombre, l]) => ({ nombre, clientes: l.length })).sort((a, b) => b.clientes - a.clientes);

  return {
    actualizado: ahora.toISOString(),
    periodo: { desde, hasta, porMes },
    sla: SLA_MIN,
    horario: process.env.HORARIO_LABORAL || '09:00-18:00',
    resumen: {
      abiertas: filtrados.filter(t => t.estado !== 'Cerrado').length,
      sinAsignar: filtrados.filter(t => t.estado !== 'Cerrado' && !t.tecnico).length,
      entrados: delPeriodo.length,
      cerrados: cerrados.length,
      horas: horasDe(filtrados),
      primeraRespuestaMediana: primeras.length ? Math.round(mediana(primeras)) : null,
      slaCumplido: medibles.length ? Math.round(medibles.filter(t => espera(t) <= SLA_MIN).length / medibles.length * 100) : null,
      slaMedibles: medibles.length,
      diasResolucion: resolucion.length ? r1(media(resolucion)) : null,
      clientes: clientesPeriodo.size,
      satisfechos: satisfechos.size,
    },
    nps: valoracion,
    servicios: SERVICIOS.filter(s => s !== 'Sin clasificar' || filtrados.some(t => t.servicio === s))
      .filter(s => !servicio || s === servicio)
      .map(s => bloque(filtrados.filter(t => t.servicio === s), s)),
    // Los grupos de la página 2 del mockup. Los clientes sin origen no entran en ninguno.
    porTipo: [
      { servicio: 'Premium', grupos: [
        { nombre: 'Gestoría / Asesoría', origenes: ['Gestoría / asesoría'] },
        { nombre: 'Cliente directo', precio: '499 €', origenes: ['Directo', 'Antiguo cliente AKIRA', 'Referido por gestoría'] },
      ] },
      { servicio: 'Implementación', grupos: [
        { nombre: 'Referenciado por gestoría', origenes: ['Referido por gestoría', 'Gestoría / asesoría'] },
        { nombre: 'Cliente directo', origenes: ['Directo', 'Antiguo cliente AKIRA'] },
      ] },
    ].map(s => {
      const del = filtrados.filter(t => t.servicio === s.servicio);
      return {
        servicio: s.servicio,
        sinOrigen: new Set(del.filter(t => t.tipo_cliente === 'Sin clasificar').map(t => t.cliente)).size,
        grupos: s.grupos.map(g => ({ ...bloque(del.filter(t => g.origenes.includes(t.tipo_cliente)), g.nombre), precio: g.precio || null })),
      };
    }),
    serie,
    porTipoIncidencia: [...agrupar(delPeriodo, t => t.tipo_incidencia || 'Sin tipo')].map(([nombre, l]) => ({ nombre, tickets: l.length })).sort((a, b) => b.tickets - a.tickets),
    porCanal: [...agrupar(delPeriodo, t => t.canal || 'Formulario')].map(([nombre, l]) => ({ nombre, tickets: l.length })).sort((a, b) => b.tickets - a.tickets),
    porTecnico: [...tecnicos.values()].map(x => ({ ...x, horas: r1(x.horas) })).sort((a, b) => b.horas - a.horas),
    porCliente,
    porOrigen,
    mejoras: cerrados.filter(t => t.mejora || t.nps != null).sort((a, b) => b.cierre.localeCompare(a.cierre))
      .map(t => ({ id: t.id, cliente: t.cliente, nps: t.nps, mejora: t.mejora, fecha: dia(t.cierre) })),
    comercial: comercial.datos.map(c => ({ ...c, dias: Math.floor((ahora - new Date(c.fecha)) / 864e5) })),
    comercialEjemplo: comercial.ejemplo,
    diasRespuesta: RESPUESTA_CLIENTE,
  };
}

// Horas por cliente en CSV para Excel (punto y coma, coma decimal y BOM).
function csvHoras(r) {
  const fila = c => [c.nombre, c.servicio, c.origen, c.tickets, String(c.horas).replace('.', ',')]
    .map(v => `"${String(v).replace(/"/g, '""')}"`).join(';');
  return '﻿' + ['Cliente;Servicio;Origen;Tickets;Horas', ...r.porCliente.map(fila)].join('\r\n');
}

module.exports = { resumen, csvHoras, minutosLaborables };
