// Sectorizador nocturno · mapa (Leaflet 1.9.4, global L)
import { latlonDeXY } from './sectorizador.js';

export const MARINO = '#14324f';
// 8 colores de zona (sin rojo)
export const PALETA_ZONAS = ['#4e79a7', '#f28e2b', '#59a14f', '#b07aa1', '#76b7b2', '#edc948', '#9c755f', '#e7a1c6'];
// colores de ruta (oscuros, para puntos y líneas; sin rojo)
const PALETA_RUTAS = ['#2f6fbf', '#c45a00', '#1b7837', '#7b3fa8', '#00838f', '#8a6d00', '#6d4c41', '#b0306e', '#4b5563', '#5b8c00'];
const GRIS_SIN_ZONA = '#c9d1da';
const VISTA_INICIAL = [[-12.21, -77.12], [-11.96, -76.90]];
const VECINOS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

// ---------------- geometría fija de las bolsas ----------------
const cacheGeo = new WeakMap();

function geometria(M) {
  if (cacheGeo.has(M)) return cacheGeo.get(M);
  const L = M.LADO, s3 = Math.sqrt(3);
  const nb = M.U.length;
  const hexes = Array.from({ length: nb }, () => []);
  for (const [q, r] of M.hexKeys) hexes[M.hex2bolsa.get(q + ',' + r)].push([q, r]);
  const centroHex = (q, r) => [L * s3 * (q + r / 2), L * 1.5 * r];
  const vertKm = (q, r) => {
    const [cx, cy] = centroHex(q, r);
    return Array.from({ length: 6 }, (_, i) => { const a = (30 + 60 * i) * Math.PI / 180; return [cx + L * Math.cos(a), cy + L * Math.sin(a)]; });
  };
  const aLL = ([x, y]) => latlonDeXY(M, x, y);
  // polígonos (lat/lon) por bolsa
  const poligonos = hexes.map(hs => hs.map(([q, r]) => vertKm(q, r).map(aLL)));
  // centro de cada bolsa
  const centro = hexes.map(hs => {
    let sx = 0, sy = 0; for (const [q, r] of hs) { const c = centroHex(q, r); sx += c[0]; sy += c[1]; }
    return [sx / (hs.length || 1), sy / (hs.length || 1)];
  });
  // bolsas vecinas (comparten un lado)
  const vecinas = Array.from({ length: nb }, () => new Set());
  for (const [q, r] of M.hexKeys) {
    const b = M.hex2bolsa.get(q + ',' + r);
    for (const [dq, dr] of VECINOS) {
      const o = M.hex2bolsa.get((q + dq) + ',' + (r + dr));
      if (o !== undefined && o !== b) { vecinas[b].add(o); vecinas[o].add(b); }
    }
  }
  const G = { hexes, poligonos, centro, vecinas, vertKm, aLL };
  G.bordeBolsa = hexes.map(hs => borde(G, hs));
  cacheGeo.set(M, G);
  return G;
}

/** Contorno (lista de polilíneas lat/lon) de un conjunto de hexágonos. */
function borde(G, hs) {
  const key = ([x, y]) => Math.round(x * 1e4) + ':' + Math.round(y * 1e4);
  const lados = new Map();
  for (const [q, r] of hs) {
    const v = G.vertKm(q, r);
    for (let i = 0; i < 6; i++) {
      const a = v[i], b = v[(i + 1) % 6], ka = key(a), kb = key(b);
      const k = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      if (lados.has(k)) lados.get(k).n++; else lados.set(k, { n: 1, a, b, ka, kb });
    }
  }
  // unir los lados exteriores en cadenas
  const ext = [...lados.values()].filter(l => l.n === 1);
  const porVert = new Map();
  ext.forEach((l, i) => { for (const k of [l.ka, l.kb]) { if (!porVert.has(k)) porVert.set(k, []); porVert.get(k).push(i); } });
  const usado = new Uint8Array(ext.length), cadenas = [];
  for (let s = 0; s < ext.length; s++) {
    if (usado[s]) continue;
    usado[s] = 1;
    const cad = [ext[s].a, ext[s].b]; let fin = ext[s].kb;
    for (;;) {
      const sig = (porVert.get(fin) || []).find(i => !usado[i]);
      if (sig === undefined) break;
      usado[sig] = 1;
      const l = ext[sig];
      if (l.ka === fin) { cad.push(l.b); fin = l.kb; } else { cad.push(l.a); fin = l.ka; }
    }
    cadenas.push(cad.map(G.aLL));
  }
  return cadenas;
}

// ---------------- colores ----------------
const cacheColorNucleo = new WeakMap();

/** Color fijo de cada mitad de núcleo (igual todas las noches); mitades vecinas o cercanas, distinto color. */
function coloresNucleo(M, G) {
  if (cacheColorNucleo.has(M)) return cacheColorNucleo.get(M);
  const col = new Map();
  const nucleos = M.U.filter(u => u.tipo === 'nucleo').map(u => u.id);
  for (const b of nucleos) {
    const usados = new Set();
    for (const o of nucleos) {
      if (!col.has(o)) continue;
      const d = Math.hypot(G.centro[b][0] - G.centro[o][0], G.centro[b][1] - G.centro[o][1]);
      if (d < 7 || G.vecinas[b].has(o)) usados.add(col.get(o));
    }
    let c = 0; while (usados.has(c) && c < PALETA_ZONAS.length - 1) c++;
    col.set(b, c);
  }
  cacheColorNucleo.set(M, col);
  return col;
}

/** Color (índice de paleta) de cada zona de la noche: zonas vecinas nunca del mismo color. */
export function coloresZonas(R) {
  const M = R.malla, G = geometria(M), fijo = coloresNucleo(M, G);
  const zonaDeBolsa = new Map();
  R.zonas.forEach((z, zi) => z.forEach(b => zonaDeBolsa.set(b, zi)));
  const vecZ = R.zonas.map(z => {
    const s = new Set();
    for (const b of z) for (const o of G.vecinas[b]) { const zo = zonaDeBolsa.get(o); if (zo !== undefined) s.add(zo); }
    return s;
  });
  const col = new Array(R.zonas.length).fill(null);
  R.zonas.forEach((z, zi) => { const n = z.find(b => M.esNucleo[b]); if (n !== undefined) col[zi] = fijo.get(n); });
  R.zonas.forEach((z, zi) => {
    if (col[zi] !== null) return;
    const usados = new Map();
    for (const o of vecZ[zi]) if (col[o] !== null) usados.set(col[o], (usados.get(col[o]) || 0) + 1);
    let c = PALETA_ZONAS.findIndex((_, k) => !usados.has(k));
    if (c < 0) c = [...usados.entries()].sort((a, b) => a[1] - b[1])[0][0];
    col[zi] = c;
  });
  return { col, zonaDeBolsa };
}

/** Colores de ruta: rutas cercanas, distinto color. */
function coloresRutas(rutas, X) {
  const cen = rutas.map(r => {
    let sx = 0, sy = 0; for (const i of r.idx) { sx += X[i][0]; sy += X[i][1]; }
    return [sx / r.idx.length, sy / r.idx.length];
  });
  // cada ruta evita los colores de sus 9 rutas ya pintadas más cercanas; entre los libres, el menos usado
  const col = [], usos = new Array(PALETA_RUTAS.length).fill(0);
  rutas.forEach((r, k) => {
    const cerca = [];
    for (let j = 0; j < k; j++) cerca.push([Math.hypot(cen[k][0] - cen[j][0], cen[k][1] - cen[j][1]), col[j]]);
    cerca.sort((a, b) => a[0] - b[0]);
    const prohibidos = new Set(cerca.slice(0, PALETA_RUTAS.length - 1).map(c => c[1]));
    let c = -1;
    for (let p = 0; p < PALETA_RUTAS.length; p++) if (!prohibidos.has(p) && (c < 0 || usos[p] < usos[c])) c = p;
    if (c < 0) c = 0;
    usos[c]++; col.push(c);
  });
  return col.map(c => PALETA_RUTAS[c]);
}

// ---------------- el mapa ----------------
export class Mapa {
  constructor(contenedor, distritos) {
    this.map = L.map(contenedor, { preferCanvas: false, zoomSnap: 0.5, minZoom: 9, maxZoom: 18 });
    this.lienzo = L.canvas({ padding: 0.3 });
    // CARTO "light" ahora pide clave (sus teselas salen con "API KEY REQUIRED"); se usa OpenStreetMap
    // con un filtro gris claro (css: .fondo-calles). Si no carga, el mapa sigue con los distritos.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors', maxZoom: 19, className: 'fondo-calles',
    }).addTo(this.map);
    this.map.createPane('hexes').style.zIndex = 350;
    this.map.createPane('distritos').style.zIndex = 380;
    this.map.createPane('bordes').style.zIndex = 390;
    this.map.createPane('resalte').style.zIndex = 395;
    this.map.createPane('etiquetas').style.zIndex = 640;
    this.capaHex = L.layerGroup().addTo(this.map);
    this.capaRutas = L.featureGroup().addTo(this.map);
    this.capaRutas.on('click', e => {           // un solo detector de clics para todos los pedidos
      const i = e.layer && e.layer.options.pedido;
      if (i === undefined) return;
      L.DomEvent.stopPropagation(e);
      if (this.alClicPedido) this.alClicPedido(i);
    });
    this.capaResalte = L.layerGroup().addTo(this.map);
    this.capaNucleos = L.layerGroup().addTo(this.map);
    this.vista();
    if (distritos) this.dibujarDistritos(distritos);
    this.map.on('click', () => this.alClicVacio && this.alClicVacio());
  }

  vista() { this.map.fitBounds(VISTA_INICIAL); }

  dibujarDistritos(gj) {
    L.geoJSON(gj, { pane: 'distritos', interactive: false, style: { color: '#4a5a6a', weight: 1.3, opacity: 0.75, fill: false } }).addTo(this.map);
    this.etiquetasDistrito = gj.features.map(f => {
      const p = f.properties, a = p.area_km2;
      const zoomMin = a >= 30 ? 10.5 : a >= 8 ? 11.5 : a >= 3 ? 12.5 : 13.5;
      const m = L.marker(p.centro, {
        pane: 'etiquetas', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'etiqueta-distrito', html: `<span>${p.nombre}</span>`, iconSize: null }),
      });
      return { m, zoomMin };
    });
    const actualizar = () => {
      const z = this.map.getZoom();
      for (const e of this.etiquetasDistrito) {
        const ver = z >= e.zoomMin;
        if (ver && !this.map.hasLayer(e.m)) e.m.addTo(this.map);
        else if (!ver && this.map.hasLayer(e.m)) e.m.remove();
      }
    };
    this.map.on('zoomend', actualizar);
    actualizar();
  }

  /** Carga un resultado nuevo del algoritmo. */
  cargar(R) {
    this.R = R;
    this.G = geometria(R.malla);
    this.colZ = coloresZonas(R);
    this.cacheColRutas = new Map();
    this.seleccion = null;
    this.capaHex.clearLayers(); this.capaNucleos.clearLayers();
    const M = R.malla, G = this.G;
    // hexágonos con el color de su zona
    for (let b = 0; b < M.U.length; b++) {
      const zi = this.colZ.zonaDeBolsa.get(b);
      const color = zi === undefined ? GRIS_SIN_ZONA : PALETA_ZONAS[this.colZ.col[zi]];
      L.polygon(G.poligonos[b], { pane: 'hexes', stroke: false, fillColor: color, fillOpacity: zi === undefined ? 0.25 : 0.42, interactive: false }).addTo(this.capaHex);
    }
    // bordes: grueso azul marino en núcleos; fino punteado en satélites
    for (let b = 0; b < M.U.length; b++) {
      const nuc = M.esNucleo[b];
      L.polyline(G.bordeBolsa[b], nuc
        ? { pane: 'bordes', color: MARINO, weight: 3.5, opacity: 0.95, interactive: false }
        : { pane: 'bordes', color: MARINO, weight: 1.2, opacity: 0.7, dashArray: '3 5', interactive: false }).addTo(this.capaHex);
    }
    // etiqueta N1 a N9
    const porNucleo = new Map();
    for (const u of M.U) if (u.tipo === 'nucleo') { if (!porNucleo.has(u.nucleo)) porNucleo.set(u.nucleo, []); porNucleo.get(u.nucleo).push(u.id); }
    for (const [n, bs] of porNucleo) {
      let sx = 0, sy = 0, k = 0;
      for (const b of bs) for (const [q, r] of G.hexes[b]) { sx += M.LADO * Math.sqrt(3) * (q + r / 2); sy += M.LADO * 1.5 * r; k++; }
      L.marker(latlonDeXY(M, sx / k, sy / k), {
        pane: 'etiquetas', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'etiqueta-nucleo', html: `<span>N${n}</span>`, iconSize: null }),
      }).addTo(this.capaNucleos);
    }
  }

  /** modo: 'propuesta' | 'actual'; turno: 1 | 2 */
  mostrar(modo, turno) {
    this.modo = modo; this.turno = turno;
    const R = this.R, X = R.X;
    const verHex = modo === 'propuesta';
    for (const c of [this.capaHex, this.capaNucleos]) {
      if (verHex && !this.map.hasLayer(c)) c.addTo(this.map);
      if (!verHex && this.map.hasLayer(c)) c.remove();
    }
    this.capaRutas.clearLayers();
    this.resaltado = false;
    const todas = modo === 'propuesta' ? R.rutasPropuesta : R.rutasReglaActual;
    const rutas = todas.map((r, k) => ({ r, k })).filter(o => o.r.turno === turno);
    const clave = modo + turno;
    if (!this.cacheColRutas.has(clave)) this.cacheColRutas.set(clave, coloresRutas(rutas.map(o => o.r), X));
    const colores = this.cacheColRutas.get(clave);
    this.dibujadas = new Map();
    rutas.forEach(({ r, k }, j) => {
      const color = colores[j];
      const pts = r.orden.map(o => [R.datos.lat[r.idx[o]], R.datos.lon[r.idx[o]]]);
      const linea = L.polyline(pts, { renderer: this.lienzo, color, weight: 2.5, opacity: 0.85, interactive: false }).addTo(this.capaRutas);
      const puntos = r.idx.map(i =>
        L.circleMarker([R.datos.lat[i], R.datos.lon[i]], { renderer: this.lienzo, radius: 4.5, color: '#ffffff', weight: 1, fillColor: color, fillOpacity: 1, pedido: i }).addTo(this.capaRutas));
      this.dibujadas.set(k, { linea, puntos, color });
    });
    this.aplicarSeleccion();
  }

  /** Resalta la ruta (índice en la lista del modo actual) o quita el resalte con null. */
  resaltarRuta(k) { this.seleccion = k; this.aplicarSeleccion(); }

  aplicarSeleccion() {
    if (!this.dibujadas) return;
    const k = this.seleccion, hay = k !== null && k !== undefined && this.dibujadas.has(k);
    if (!hay && !this.resaltado) return;      // nada resaltado antes ni ahora: no hay que repintar
    this.resaltado = hay;
    for (const [kk, d] of this.dibujadas) {
      const on = !hay || kk === k;
      d.linea.setStyle({ opacity: on ? 0.9 : 0.12, weight: hay && kk === k ? 5 : 2.5 });
      for (const p of d.puntos) p.setStyle({ fillOpacity: on ? 1 : 0.15, opacity: on ? 1 : 0.15, radius: hay && kk === k ? 6 : 4.5 });
    }
    if (hay) { const d = this.dibujadas.get(k); d.linea.bringToFront(); for (const p of d.puntos) p.bringToFront(); }
  }

  /** Resalta una bolsa y su zona (al pasar el cursor por una ubicación). */
  resaltarBolsa(b) {
    this.capaResalte.clearLayers();
    if (b === null || b === undefined) return;
    const G = this.G, zi = this.colZ.zonaDeBolsa.get(b);
    if (zi !== undefined) {
      const hs = this.R.zonas[zi].flatMap(o => G.hexes[o]);
      L.polyline(borde(G, hs), { pane: 'resalte', color: '#ffffff', weight: 8, opacity: 0.9, interactive: false }).addTo(this.capaResalte);
      L.polyline(borde(G, hs), { pane: 'resalte', color: MARINO, weight: 4, opacity: 1, interactive: false }).addTo(this.capaResalte);
    }
    L.polygon(G.poligonos[b], { pane: 'resalte', stroke: false, fillColor: MARINO, fillOpacity: 0.55, interactive: false }).addTo(this.capaResalte);
  }

  ajustar() { this.map.invalidateSize(); }
}
