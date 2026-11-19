// Sectorizador nocturno · interfaz
import { leer, sectorizar, filasDesdeLibro, generarCSV, nombreSalida, norm, FRANJAS, ErrorUsuario } from './sectorizador.js';
import { Mapa, coloresZonas, PALETA_ZONAS } from './mapa.js';

const $ = id => document.getElementById(id);
const MSG_ILEGIBLE = 'No pudimos leer este archivo. Sube el Excel de pedidos del día.';
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const fmt = n => Number(n).toLocaleString('en-US');           // 2,594 · 0.3

const estado = { bolsas: null, filas: null, archivo: '', resultado: null };

// ---------------- datos fijos ----------------
const cargaBolsas = fetch('datos/bolsas.json')
  .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then(b => { estado.bolsas = b; return b; });
const cargaConexion = fetch('datos/conexion_bolsas.json')      // qué pares de bolsas se conectan por tierra
  .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then(c => { estado.conexion = c; return c; });

// ---------------- pantallas ----------------
function mostrar(nombre) {
  for (const p of ['cargar', 'sectorizar', 'resultado']) $('pantalla-' + p).hidden = p !== nombre;
  window.scrollTo(0, 0);
}

// ---------------- 1. cargar ----------------
function limpiarCarga() {
  estado.filas = null; estado.archivo = '';
  $('confirmacion').hidden = true;
  $('error-carga').hidden = true;
  $('boton-sectorizar').disabled = true;
  $('entrada-archivo').value = '';
}

function mostrarError(msg) {
  $('error-carga').textContent = msg;
  $('error-carga').hidden = false;
  $('confirmacion').hidden = true;
  $('boton-sectorizar').disabled = true;
  estado.filas = null;
}

async function leerArchivo(archivo) {
  limpiarCarga();
  if (!archivo) return;
  if (!/\.(xlsx|xls|csv)$/i.test(archivo.name)) return mostrarError(MSG_ILEGIBLE);
  if (typeof XLSX === 'undefined') return mostrarError('No se cargó el lector de Excel. Revisa la conexión a internet y recarga la página.');
  let filas;
  try {
    const buf = await archivo.arrayBuffer();
    let wb;
    if (/\.csv$/i.test(archivo.name)) {
      const texto = new TextDecoder('utf-8').decode(buf).replace(/^﻿/, '');
      wb = XLSX.read(texto, { type: 'string', cellDates: true });
    } else {
      // un Excel de verdad empieza con "PK" (.xlsx) o D0 CF 11 E0 (.xls antiguo); también se aceptan .xls en XML/HTML
      const b = new Uint8Array(buf.slice(0, 8));
      const zip = b[0] === 0x50 && b[1] === 0x4b, ole = b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
      const xml = /\.xls$/i.test(archivo.name) && /^\s*</.test(new TextDecoder().decode(b));
      if (!zip && !ole && !xml) throw new ErrorUsuario(MSG_ILEGIBLE);
      wb = XLSX.read(buf, { type: 'array', cellDates: true });
    }
    filas = filasDesdeLibro(XLSX, wb);
  } catch (e) {
    console.warn(e);
    return mostrarError(e instanceof ErrorUsuario ? e.message : MSG_ILEGIBLE);
  }
  let bolsas;
  try { bolsas = await cargaBolsas; await cargaConexion; }
  catch (e) { return mostrarError('No se pudo cargar el mapa de bolsas. Revisa la conexión y recarga la página.'); }
  try {
    const D = leer(filas, bolsas);         // valida y cuenta olas
    const olas = [1, 2, 3].map(k => D.ola.filter(o => o === k).length);
    const partes = [];
    if (D.fechaEntrega) partes.push(`${D.fechaEntrega.getDate()} de ${MESES[D.fechaEntrega.getMonth()]}`);
    partes.push(`${fmt(D.n)} pedidos`, `14:00: ${fmt(olas[0])}`, `19:00: ${fmt(olas[1])}`, `02:30: ${fmt(olas[2])}`);
    $('archivo-nombre').textContent = archivo.name;
    $('archivo-resumen').textContent = partes.join(' · ');
    $('confirmacion').hidden = false;
    estado.filas = filas; estado.archivo = archivo.name;
    $('boton-sectorizar').disabled = false;
    $('boton-sectorizar').focus();
  } catch (e) {
    if (!(e instanceof ErrorUsuario)) console.warn(e);
    mostrarError(e instanceof ErrorUsuario ? e.message : MSG_ILEGIBLE);
  }
}

const zona = $('zona-archivo');
$('entrada-archivo').addEventListener('change', e => leerArchivo(e.target.files[0]));
zona.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('entrada-archivo').click(); } });
for (const ev of ['dragenter', 'dragover']) zona.addEventListener(ev, e => { e.preventDefault(); zona.classList.add('encima'); });
for (const ev of ['dragleave', 'drop']) zona.addEventListener(ev, e => { e.preventDefault(); zona.classList.remove('encima'); });
zona.addEventListener('drop', e => leerArchivo(e.dataTransfer.files[0]));
// que soltar un archivo fuera de la zona no abra el archivo en el navegador
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

// ---------------- 2. sectorizar ----------------
const espera = ms => new Promise(r => setTimeout(r, ms));
// espera a que la pantalla se dibuje; si Chrome no dibuja (ventana minimizada), sigue igual a los 150 ms
const pintado = () => new Promise(r => { requestAnimationFrame(() => setTimeout(r, 0)); setTimeout(r, 150); });

$('boton-sectorizar').addEventListener('click', async () => {
  if (!estado.filas) return;
  const etapas = [...$('etapas').children];
  etapas.forEach(li => li.classList.remove('hecha'));
  $('cronometro').textContent = '…';
  mostrar('sectorizar');
  await pintado();                              // que la pantalla se dibuje antes de calcular

  let R;
  try {
    R = sectorizar(estado.filas, estado.bolsas, estado.archivo, estado.conexion);
  } catch (e) {
    if (!(e instanceof ErrorUsuario)) console.error(e);
    mostrar('cargar');
    return mostrarError(e instanceof ErrorUsuario ? e.message : 'Algo falló al sectorizar este archivo. Prueba con otro archivo de pedidos.');
  }
  estado.resultado = R;
  $('cronometro').textContent = R.segundos.toFixed(R.segundos < 10 ? 2 : 1) + ' s';   // tiempo medido de verdad
  for (const li of etapas) { await espera(230); li.classList.add('hecha'); }           // animación: menos de 1.2 s en total
  await espera(200);
  mostrarResultado(R);
});

// ---------------- 3. resultado ----------------
let mapa = null;
const vista = { modo: 'propuesta', turno: 1, pestana: 'ubicaciones', comparar: false };
const nombreDistrito = new Map();     // clave de los pedidos (SANTIAGODESURCO) → "Santiago de Surco"
const cargaDistritos = fetch('datos/mapas/distritos_simplificado.geojson')
  .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then(gj => { for (const f of gj.features) nombreDistrito.set(f.properties.clave, f.properties.nombre); return gj; })
  .catch(e => { console.warn('Sin límites distritales', e); return null; });
const nombreBonito = d => nombreDistrito.get(norm(d)) || String(d ?? '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function mostrarResultado(R) {
  const r = R.resumen, D = R.datos;
  const fecha = D.fechaEntrega ? `${D.fechaEntrega.getDate()} de ${MESES[D.fechaEntrega.getMonth()]}` : 'Pedidos del día';
  $('titulo-dia').textContent = `${fecha} · ${fmt(r.pedidos)} pedidos`;
  $('tiempo-algoritmo').innerHTML = `Sectorizado en <strong>${R.segundos.toFixed(2)} s</strong> · ${r.zonas} zonas de la noche`;
  vista.comparar = false; $('comparar').checked = false; $('selector-regla').hidden = true;   // cada archivo nuevo parte solo con la propuesta
  pintarMetricas(r);
  pintarUbicaciones(R);
  estado.seleccion = null;
  pintarEtiqueta();
  $('nombre-descarga').textContent = nombreSalida(R);
  cambiarPestana('ubicaciones');
  mostrar('resultado');
  if (!mapa) mapa = new Mapa($('mapa'), await cargaDistritos);
  mapa.alClicPedido = seleccionar;
  mapa.alClicVacio = () => seleccionar(null);
  mapa.ajustar();
  mapa.cargar(R);
  mapa.vista();
  vista.modo = 'propuesta'; vista.turno = 1;
  actualizarMapa();
}

// diferencias "propuesta − regla actual", con signo menos tipográfico
const conSigno = n => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n));
const aMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return (h < 12 ? h + 24 : h) * 60 + m; };   // 02:50 → 26:50
function difHora(actual, prop) {
  const d = aMin(actual) - aMin(prop);
  if (d === 0) return 'igual';
  const a = Math.abs(d), txt = (a >= 60 ? Math.floor(a / 60) + ' h ' : '') + (a % 60 ? (a % 60) + ' min' : '');
  return txt.trim() + (d > 0 ? ' antes' : ' después');
}

/** Métricas: por defecto solo la propuesta; con "Comparar con la regla actual", las dos y la diferencia. */
function pintarMetricas(r) {
  const A = r.regla_actual, P = r.propuesta, comparar = vista.comparar;
  const reparto = m => `<span class="nota reparto">${fmt(m.ruta1)} · ${fmt(m.ruta2)} · ${fmt(m.ruta3)}</span>`;
  const pctKm = A.km ? `<span class="nota">${conSigno(Math.round((P.km - A.km) / A.km * 100))} %</span>` : '';
  const filas = [
    ['Rutas<span class="nota">Ruta 1 · Ruta 2 · Ruta 3</span>', fmt(A.rutas) + reparto(A), fmt(P.rutas) + reparto(P), conSigno(P.rutas - A.rutas)],
    ['Paradas por ruta', A.paradas_prom.toFixed(1), P.paradas_prom.toFixed(1), ''],
    ['Rutas desparejas<span class="nota">menos de 40 o más de 55</span>', A.desparejas_pct + ' %', P.desparejas_pct + ' %', ''],
    ['Km recorridos<span class="nota">en línea recta</span>', fmt(A.km), fmt(P.km), conSigno(P.km - A.km) + pctKm],
    ['Direcciones con dos motos', fmt(A.direcciones_con_2_motos), fmt(P.direcciones_con_2_motos), conSigno(P.direcciones_con_2_motos - A.direcciones_con_2_motos)],
    ['Ruta 1 clasificada<span class="nota">estimado a 700 pedidos por hora</span>', r.ruta1_lista_regla_actual + '<span class="nota">estimado</span>', r.ruta1_lista_propuesta, difHora(r.ruta1_lista_regla_actual, r.ruta1_lista_propuesta)],
  ];
  document.querySelector('.metricas').classList.toggle('solo-propuesta', !comparar);
  document.querySelector('.metricas').classList.toggle('comparando', comparar);
  $('cabecera-metricas').innerHTML = comparar
    ? '<tr><th></th><th>Regla actual</th><th class="prop">Propuesta</th><th>Diferencia</th></tr>'
    : '<tr><th></th><th class="prop">Propuesta</th></tr>';
  $('tabla-metricas').innerHTML = filas.map(([n, a, p, d]) => comparar
    ? `<tr><td>${n}</td><td>${a}</td><td class="prop">${p}</td><td class="dif">${d}</td></tr>`
    : `<tr><td>${n}</td><td class="prop">${p}</td></tr>`).join('');
}

function pintarUbicaciones(R) {
  const r = R.resumen;
  $('resumen-r1').textContent = `Ruta 1: ${fmt(r.ruta1_pedidos)} pedidos · ${r.ruta1_ya_en_hub_pct} % ya está en el hub antes de la ola de las 02:30`;
  const U = R.malla.U, nb = U.length;
  // por bolsa y turno: lo que ya está en el hub (olas 1 y 2) y lo que falta (ola 3)
  const hub = [1, 2, 3].map(() => new Array(nb).fill(0)), falta = [1, 2, 3].map(() => new Array(nb).fill(0));
  for (const ru of R.rutasPropuesta) for (const i of ru.idx) {
    const b = R.us[i], t = ru.turno - 1;
    if (R.datos.ola[i] === 3) falta[t][b]++; else hub[t][b]++;
  }
  const maxT = Math.max(1, ...[0, 1, 2].flatMap(t => U.map((_, b) => hub[t][b] + falta[t][b])));
  const { col, zonaDeBolsa } = coloresZonas(R);
  // primero las ubicaciones con pedidos hoy (por número de ubicación); al final las vacías, atenuadas
  const totalDe = b => [0, 1, 2].reduce((s, t) => s + hub[t][b] + falta[t][b], 0);
  const porUbic = U.map(u => u.id).sort((a, b) => U[a].ubicacion - U[b].ubicacion);
  const conPedidos = porUbic.filter(b => totalDe(b) > 0), vacias = porUbic.filter(b => totalDe(b) === 0);
  const orden = [...conPedidos, ...vacias];
  $('conteo-ubicaciones').textContent = `${fmt(U.length)} ubicaciones · ${fmt(conPedidos.length)} con pedidos hoy` + (vacias.length ? ` · ${fmt(vacias.length)} vacías al final` : '');
  const barra = (t, b) => `<div class="barra-r1" title="Ruta ${t + 1}"><span class="hub" style="width:${hub[t][b] / maxT * 100}%"></span><span class="falta" style="width:${falta[t][b] / maxT * 100}%"></span></div>`;
  $('ubicaciones').innerHTML = orden.map(b => {
    const u = U[b], zi = zonaDeBolsa.get(b);
    const total = [0, 1, 2].reduce((s, t) => s + hub[t][b] + falta[t][b], 0);
    const color = zi === undefined ? '#c9d1da' : PALETA_ZONAS[col[zi]];
    const cab = `<div class="cab"><span class="cod">${esc(u.code)}</span><span class="num">Ubicación ${u.ubicacion}</span></div>`;
    if (total === 0) return `<div class="ubic vacia" data-bolsa="${b}" style="--zona:${color}">${cab}<span class="r2">Sin pedidos hoy</span></div>`;
    return `<div class="ubic" data-bolsa="${b}" style="--zona:${color}">
      ${cab}
      ${barra(0, b)}
      <span class="r1">R1: <b>${hub[0][b]}</b> en el hub · <b>${falta[0][b]}</b> por llegar</span>
      ${barra(1, b)}
      <span class="r2">R2: <b>${hub[1][b]}</b> en el hub · <b>${falta[1][b]}</b> por llegar</span>
      ${barra(2, b)}
      <span class="r2">R3: <b>${hub[2][b]}</b> en el hub · <b>${falta[2][b]}</b> por llegar</span>
    </div>`;
  }).join('');
}

$('ubicaciones').addEventListener('mouseover', e => {
  const c = e.target.closest('.ubic'); if (c && mapa) mapa.resaltarBolsa(+c.dataset.bolsa);
});
$('ubicaciones').addEventListener('mouseleave', () => mapa && mapa.resaltarBolsa(null));

function pintarEtiqueta() {
  const R = estado.resultado, i = estado.seleccion;
  if (i === null || i === undefined || !R) {
    $('etiqueta').innerHTML = '<p class="etiqueta-vacia">Haz clic en un pedido del mapa para ver su etiqueta.</p>';
    return;
  }
  const D = R.datos, P = R.pedido, u = R.malla.U[R.us[i]], t = Math.trunc(P.turno[i]);
  const franja = FRANJAS[t] ? `Llega entre ${FRANJAS[t].replace(' a ', ' y ')}` : '';
  $('etiqueta').innerHTML = `
    <div class="etiqueta-hub">
      <span class="bolsa">${esc(u.code)}</span>
      <div class="fila"><span class="ubicacion">Ubicación ${u.ubicacion}</span><span class="turno">R${t}</span></div>
      <span class="distrito">${esc(nombreBonito(D.distrito[i]))}</span>
      <span class="oc">Pedido ${esc(D.oc ? D.oc[i] : i + 1)}</span>
    </div>
    ${franja ? `<p class="franja">${franja}</p>` : ''}
    ${P.aviso[i] ? `<p class="aviso-carga">${esc(P.aviso[i])}</p>` : ''}`;
}

function seleccionar(i) {
  estado.seleccion = i;
  pintarEtiqueta();
  if (i !== null) {
    cambiarPestana('etiqueta');
    const panel = document.querySelector('.panel'), tabs = document.querySelector('.pestanas');
    if (panel.scrollHeight > panel.clientHeight) panel.scrollTo({ top: tabs.offsetTop - panel.offsetTop - 8, behavior: 'smooth' });  }
  resaltarSeleccion();
}

function resaltarSeleccion() {
  if (!mapa) return;
  const R = estado.resultado, i = estado.seleccion;
  if (i === null || i === undefined) return mapa.resaltarRuta(null);
  const k = vista.modo === 'propuesta' ? (R.pedido.ruta[i] === null ? null : R.pedido.ruta[i] - 1) : R.pedido.rutaHoy[i];
  mapa.resaltarRuta(k);
}

function actualizarMapa() {
  document.querySelectorAll('[data-modo]').forEach(b => b.classList.toggle('activo', b.dataset.modo === vista.modo));
  document.querySelectorAll('[data-turno]').forEach(b => b.classList.toggle('activo', +b.dataset.turno === vista.turno));
  mapa.mostrar(vista.modo, vista.turno);
  resaltarSeleccion();
  $('leyenda').innerHTML = vista.modo === 'propuesta'
    ? `<span class="fila"><span class="linea-nucleo"></span>Núcleo (N1 a N9)</span>
       <span class="fila"><span class="linea-satelite"></span>Satélite</span>
       <span class="fila"><span class="punto"></span>Pedido, del color de su ruta</span>
       <span>Relleno: zona de la noche</span>
       <span class="nota-simulados">Pedidos simulados (mock de Falabella, octubre 2026)</span>`
    : `<span><b>Regla actual</b> (para comparar)</span>
       <span class="fila"><span class="punto"></span>Pedido, del color de su ruta</span>
       <span>Primeros 50 pedidos de cada distrito</span>
       <span class="nota-simulados">Pedidos simulados (mock de Falabella, octubre 2026)</span>`;
}

document.querySelectorAll('[data-modo]').forEach(b => b.addEventListener('click', () => { vista.modo = b.dataset.modo; actualizarMapa(); }));

// "Comparar con la regla actual": apagado por defecto. Al activarlo, el mapa muestra la regla actual
// (con el selector para volver a la propuesta) y las métricas agregan la regla actual y la diferencia.
$('comparar').addEventListener('change', e => {
  vista.comparar = e.target.checked;
  $('selector-regla').hidden = !vista.comparar;
  vista.modo = vista.comparar ? 'actual' : 'propuesta';
  if (estado.resultado) { pintarMetricas(estado.resultado.resumen); actualizarMapa(); }
});
document.querySelectorAll('[data-turno]').forEach(b => b.addEventListener('click', () => { vista.turno = +b.dataset.turno; actualizarMapa(); }));

function cambiarPestana(p) {
  vista.pestana = p;
  document.querySelectorAll('[data-pestana]').forEach(b => { const on = b.dataset.pestana === p; b.classList.toggle('activo', on); b.setAttribute('aria-selected', on); });
  for (const n of ['ubicaciones', 'etiqueta', 'descargar']) $('pestana-' + n).hidden = n !== p;
}
document.querySelectorAll('[data-pestana]').forEach(b => b.addEventListener('click', () => cambiarPestana(b.dataset.pestana)));

$('boton-descargar').addEventListener('click', () => {
  const R = estado.resultado; if (!R) return;
  const blob = new Blob(['﻿' + generarCSV(R)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = nombreSalida(R);
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

$('boton-otro').addEventListener('click', () => {
  limpiarCarga(); estado.resultado = null; estado.seleccion = null;
  if (mapa) mapa.resaltarBolsa(null);
  mostrar('cargar');
});
