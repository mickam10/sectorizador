// Sectorizador nocturno: el algoritmo.
// Traducción fiel de referencia/sectorizador_referencia.py (mismo orden, mismas reglas de desempate).
// Módulo ES puro: no usa el DOM, corre igual en el navegador y en Node (pruebas).

// ---------------- parámetros ----------------
export const CAP_HOY = 50;
export const MIN_P = 40, MAX_P = 55;
export const PAR_NUCLEO = 100;
export const TOPE_ZONA = 108;
export const META_ZONA = 100;
export const RADIO_KM = 4.0;
export const ALCANCE_AJUSTE_KM = 3.0;
export const DMAX_ZONA_KM = 10.0;
export const SALTO_VACIO_KM = 3.0;   // una bolsa sin pedidos hoy no corta la vecindad: se atraviesa hasta 3 km
export const CUOTA_OLAS = [0.15, 0.25, 0.60];
export const VEL_HUB = 700;
export const FRANJAS = { 1: '06:00 a 11:00', 2: '12:00 a 17:00', 3: '18:00 a 21:00' };

/** Error con un mensaje pensado para mostrarse tal cual al usuario. */
export class ErrorUsuario extends Error {
  constructor(msg) { super(msg); this.name = 'ErrorUsuario'; }
}

// ---------------- utilidades que imitan a Python / numpy ----------------

/** round() de Python: redondeo al par en los empates exactos. */
export function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** round(num/den, dec) de Python para num y den enteros, exacto (sin errores de coma flotante). */
function roundRatio(num, den, dec) {
  const esc = 10 ** dec;
  const n = num * esc;                 // enteros pequeños: exacto
  let q = Math.floor(n / den);
  const r = n - q * den;
  if (2 * r > den || (2 * r === den && q % 2 !== 0)) q += 1;
  return q / esc;
}

const hyp = Math.hypot;

/** Índices 0..n-1 ordenados de forma estable por clave(i). */
function argsortEstable(n, clave) {
  const o = Array.from({ length: n }, (_, i) => i);
  o.sort((a, b) => { const ka = clave(a), kb = clave(b); return ka < kb ? -1 : ka > kb ? 1 : a - b; });
  return o;
}

/** unicodedata NFD sin tildes, mayúsculas y sin espacios (norm() de la referencia). */
export function norm(s) {
  return strPy(s).normalize('NFD').replace(/\p{Mn}/gu, '').toUpperCase().replace(/ /g, '');
}

/** str() de Python para valores de celda. */
function strPy(v) {
  if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) return 'nan';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function vacio(v) {
  return v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v)) || (typeof v === 'string' && v.trim() === '');
}

/** pd.to_numeric(errors='coerce') */
function aNumero(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return NaN;
    const n = Number(s.replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** pd.to_datetime(errors='coerce') → milisegundos o NaN. */
function aFecha(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return NaN;
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/); // dd/mm/aaaa
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
    const t = Date.parse(s.length === 10 ? s + 'T00:00:00' : s);
    return Number.isFinite(t) ? t : NaN;
  }
  return NaN;
}

/** Hora (0-23) de HORA_ENTREGA, con el formato %H:%M:%S; NaN si no se puede leer. */
function aHora(v) {
  if (v instanceof Date) return v.getHours();
  if (typeof v === 'number' && v >= 0 && v < 1) return Math.floor(roundHalfEven(v * 86400) / 3600); // fracción de día de Excel
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
    if (m && +m[1] < 24 && +m[2] < 60 && +m[3] < 60) return +m[1];
  }
  return NaN;
}

// ---------------- mapa de bolsas ----------------
const cacheMalla = new WeakMap();

/** Prepara las estructuras del mapa de bolsas (se calcula una vez por objeto bolsas). */
export function prepararMalla(B) {
  if (cacheMalla.has(B)) return cacheMalla.get(B);
  const KX = B.proyeccion.kx, KY = B.proyeccion.ky, LADO = B.malla.lado_km;
  const U = B.bolsas;
  const esNucleo = U.map(u => u.tipo === 'nucleo');
  const pareja = U.map(u => (u.pareja === null || u.pareja === undefined) ? null : u.pareja);
  const hex2bolsa = new Map();
  const hexKeys = [];
  for (const [q, r, b] of B.hexagonos) {
    const k = q + ',' + r;
    if (!hex2bolsa.has(k)) hexKeys.push([q, r]);
    hex2bolsa.set(k, b);
  }
  const hexC = hexKeys.map(([q, r]) => [LADO * Math.sqrt(3) * (q + r / 2), LADO * 1.5 * r]);
  // vecindad fija: dos bolsas son vecinas si algún hexágono de una toca a uno de la otra (lista en orden de id)
  const vec = U.map(() => new Set());
  for (const [q, r] of hexKeys) {
    const b = hex2bolsa.get(q + ',' + r);
    for (const [dq, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]]) {
      const c = hex2bolsa.get((q + dq) + ',' + (r + dr));
      if (c !== undefined && c !== b) vec[b].add(c);
    }
  }
  const vecinas = vec.map(s => [...s].sort((a, b) => a - b));
  // centro fijo de cada bolsa (promedio de sus hexágonos): sirve para cruzar bolsas vacías
  const cen0 = U.map(() => [0, 0]), nh = U.map(() => 0);
  hexKeys.forEach(([q, r], k) => { const b = hex2bolsa.get(q + ',' + r); cen0[b][0] += hexC[k][0]; cen0[b][1] += hexC[k][1]; nh[b]++; });
  cen0.forEach((c, b) => { const n = Math.max(nh[b], 1); c[0] /= n; c[1] /= n; });
  const M = { B, KX, KY, LADO, U, esNucleo, pareja, hex2bolsa, hexKeys, hexC, vecinas, cen0 };
  cacheMalla.set(B, M);
  return M;
}

function hexid(M, x, y) {
  const q = (Math.sqrt(3) / 3 * x - y / 3) / M.LADO, r = (2 / 3 * y) / M.LADO;
  const xx = q, zz = r, yy = -xx - zz;
  let rx = roundHalfEven(xx), ry = roundHalfEven(yy), rz = roundHalfEven(zz);
  const dx = Math.abs(rx - xx), dy = Math.abs(ry - yy), dz = Math.abs(rz - zz);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return [rx, rz];
}

/** Proyección inversa: km → [lat, lon]. */
export function latlonDeXY(M, x, y) { return [y / M.KY - 12, x / M.KX - 77]; }

/** Vértices [lat, lon] de un hexágono (q, r) para dibujarlo. */
export function verticesHex(M, q, r) {
  const cx = M.LADO * Math.sqrt(3) * (q + r / 2), cy = M.LADO * 1.5 * r;
  const v = [];
  for (let i = 0; i < 6; i++) {
    const a = (30 + 60 * i) * Math.PI / 180;
    v.push(latlonDeXY(M, cx + M.LADO * Math.cos(a), cy + M.LADO * Math.sin(a)));
  }
  return v;
}

// ---------------- 0. del libro de Excel a filas ----------------

/** Convierte un libro leído con SheetJS (XLSX.read(..., {cellDates:true})) en filas. */
export function filasDesdeLibro(XLSX, wb) {
  if (!wb || !wb.SheetNames || !wb.SheetNames.length) throw new ErrorUsuario('No pudimos leer este archivo. Sube el Excel de pedidos del día.');
  const nombre = wb.SheetNames.find(n => n.trim().toLowerCase() === 'pedidos') || wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[nombre], { defval: null, raw: true });
}

// ---------------- 1. lectura y validación ----------------
const OBLIGATORIAS = ['DISTRITO', 'LATITUD', 'LONGITUD'];
const CONOCIDAS = [...OBLIGATORIAS, 'FECHA_LISTO', 'FECHA_ENTREGA', 'TURNO_ACTUAL', 'HORA_ENTREGA', 'OLA', 'OC', 'DIRECCION', 'FLUJO', 'TAMANO', 'FECHA_PACTADA'];

/**
 * leer() de la referencia. Recibe filas (objetos {columna: valor}) y devuelve los pedidos del día
 * en arreglos por columna. Lanza ErrorUsuario con un mensaje claro si el archivo no sirve.
 */
export function leer(filas, B) {
  if (!Array.isArray(filas)) throw new ErrorUsuario('No pudimos leer este archivo. Sube el Excel de pedidos del día.');
  // nombres de columna sin importar mayúsculas ni espacios alrededor
  const mapa = new Map();
  for (const f of filas) for (const k of Object.keys(f)) {
    const c = String(k).trim().toUpperCase();
    if (!mapa.has(c)) mapa.set(c, k);
  }
  const cols = [...mapa.keys()];
  if (filas.length === 0) throw new ErrorUsuario('Este archivo tiene muy pocos pedidos para sectorizar.');
  if (!cols.some(c => CONOCIDAS.includes(c))) throw new ErrorUsuario('No pudimos leer este archivo. Sube el Excel de pedidos del día.');
  const faltan = OBLIGATORIAS.filter(c => !mapa.has(c));
  if (faltan.length) throw new ErrorUsuario('Este archivo no tiene la columna ' + faltan.join(', '));
  const col = c => mapa.has(c) ? filas.map(f => { const v = f[mapa.get(c)]; return v === undefined ? null : v; }) : null;

  // varias fechas de entrega: se usa la última
  let fechaEntrega = null;
  let filasUsar = filas.map((_, i) => i);
  const fe = col('FECHA_ENTREGA');
  if (fe) {
    const crudos = new Set(fe.filter(v => !vacio(v)).map(v => v instanceof Date ? 'd' + v.getTime() : typeof v + ':' + v));
    const ms = fe.map(aFecha);
    let ultima = -Infinity;
    for (const t of ms) if (Number.isFinite(t) && t > ultima) ultima = t;
    if (Number.isFinite(ultima)) fechaEntrega = new Date(ultima);
    if (crudos.size > 1) filasUsar = filasUsar.filter(i => ms[i] === ultima);
  }
  const n = filasUsar.length;
  if (n < 10) throw new ErrorUsuario('Este archivo tiene muy pocos pedidos para sectorizar.');
  const tomar = c => { const v = col(c); return v ? filasUsar.map(i => v[i]) : null; };

  const distrito = tomar('DISTRITO');
  // turno en el que salió hoy
  let turno = null;
  const ta = tomar('TURNO_ACTUAL'), he = tomar('HORA_ENTREGA');
  if (ta) turno = ta.map(v => { const x = aNumero(v); return Number.isNaN(x) ? 1 : Math.trunc(x); });
  else if (he) turno = he.map(v => { const h = aHora(v); return h < 12 ? 1 : h < 18 ? 2 : 3; });

  // orden de llegada al hub: rank(method='first'); fechas vacías → n
  const fl = tomar('FECHA_LISTO');
  const orden = new Array(n);
  if (fl) {
    const t = fl.map(aFecha);
    const validos = [];
    for (let i = 0; i < n; i++) { if (Number.isFinite(t[i])) validos.push(i); else orden[i] = n; }
    validos.sort((a, b) => (t[a] - t[b]) || (a - b));
    validos.forEach((i, k) => { orden[i] = k + 1; });
  } else {
    for (let i = 0; i < n; i++) orden[i] = i + 1;
  }
  if (!turno) turno = orden.map(o => o <= n / 2 ? 1 : 2);

  // ola
  let ola;
  const oc = tomar('OLA');
  if (oc) ola = oc.map(v => { const x = aNumero(v); return Number.isNaN(x) ? 3 : Math.trunc(x); });
  else ola = orden.map(o => { const p = o / n; return p <= CUOTA_OLAS[0] ? 1 : p <= CUOTA_OLAS[0] + CUOTA_OLAS[1] ? 2 : 3; });

  // coordenadas: protección invisible
  const latC = tomar('LATITUD'), lonC = tomar('LONGITUD');
  const lat = new Array(n), lon = new Array(n), ajustada = new Array(n);
  const cen = B.centro_distrito;
  for (let i = 0; i < n; i++) {
    const a = aNumero(latC[i]), o = aNumero(lonC[i]);
    const ok = a >= -12.55 && a <= -11.55 && o >= -77.25 && o <= -76.60;
    if (ok) { lat[i] = a; lon[i] = o; ajustada[i] = ''; }
    else {
      const c = cen[norm(distrito[i])] || [-12.08, -77.03];
      lat[i] = c[0]; lon[i] = c[1]; ajustada[i] = 'si';
    }
  }
  return {
    n, distrito, lat, lon, ajustada, turno, ola, orden, fechaEntrega,
    oc: tomar('OC'), direccion: tomar('DIRECCION'),
  };
}

// ---------------- 2. hexágono y bolsa ----------------
function bolsasDe(M, D) {
  const n = D.n, X = new Array(n), us = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (D.lon[i] + 77) * M.KX, y = (D.lat[i] + 12) * M.KY;
    X[i] = [x, y];
    const h = hexid(M, x, y), k = h[0] + ',' + h[1];
    if (M.hex2bolsa.has(k)) us[i] = M.hex2bolsa.get(k);
    else {
      let best = Infinity, bj = 0;
      for (let j = 0; j < M.hexC.length; j++) {
        const d = hyp(M.hexC[j][0] - x, M.hexC[j][1] - y);
        if (d < best) { best = d; bj = j; }
      }
      const [q, r] = M.hexKeys[bj];
      us[i] = M.hex2bolsa.get(q + ',' + r);
    }
  }
  return { X, us };
}

// ---------------- utilidades geométricas ----------------
function extEje(pts) {
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for (const p of pts) {
    if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0];
    if (p[1] < mny) mny = p[1]; if (p[1] > mxy) mxy = p[1];
  }
  return (mxx - mnx) >= (mxy - mny) ? 0 : 1;
}

/** Bisección balanceada por peso. ids: índices en cen/w. */
function wbis(ids, cen, w, k) {
  if (k <= 1 || ids.length <= 1) return [ids];
  const k1 = Math.floor(k / 2);
  const ax = extEje(ids.map(i => cen[i]));
  const o = argsortEstable(ids.length, j => cen[ids[j]][ax]).map(j => ids[j]);
  const cw = []; let s = 0;
  for (const i of o) { s += w[i]; cw.push(s); }
  const obj = cw[cw.length - 1] * k1 / k;
  let best = Infinity, bj = 0;
  for (let j = 0; j < cw.length; j++) { const d = Math.abs(cw[j] - obj); if (d < best) { best = d; bj = j; } }
  const cut = Math.max(1, Math.min(o.length - 1, bj + 1));
  return [...wbis(o.slice(0, cut), cen, w, k1), ...wbis(o.slice(cut), cen, w, k - k1)];
}

/** Corta los pedidos de una visita en k rutas por cortes geográficos parejos. */
function splitGeo(idx, X, k) {
  if (k <= 1) return [idx];
  const ax = extEje(idx.map(i => X[i]));
  const o = argsortEstable(idx.length, j => X[idx[j]][ax]).map(j => idx[j]);
  const k1 = Math.floor(k / 2);
  const cut = roundHalfEven(o.length * k1 / k);
  return [...splitGeo(o.slice(0, cut), X, k1), ...splitGeo(o.slice(cut), X, k - k1)];
}

/** Recorrido cerrado en línea recta: vecino más cercano + 2-opt. Devuelve {km, orden}. */
export function recorrido(P) {
  const n = P.length;
  if (n <= 1) return { km: 0, orden: n ? [0] : [] };
  const D = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) D[i * n + j] = hyp(P[i][0] - P[j][0], P[i][1] - P[j][1]);
  const unv = new Uint8Array(n).fill(1);
  const t = new Int32Array(n); t[0] = 0; unv[0] = 0;
  for (let s = 1; s < n; s++) {
    const fila = t[s - 1] * n; let best = Infinity, bj = -1;
    for (let j = 0; j < n; j++) if (unv[j] && D[fila + j] < best) { best = D[fila + j]; bj = j; }
    if (bj < 0) for (let j = 0; j < n; j++) if (unv[j]) { bj = j; break; }
    t[s] = bj; unv[bj] = 0;
  }
  let imp = true, it = 0;
  while (imp && it < 30) {
    imp = false; it++;
    for (let i = 1; i < n - 1; i++) {
      const a = t[i - 1], b = t[i];
      let best = Infinity, bj = -1;
      for (let j = i + 1; j < n; j++) {
        const c = t[j], d = t[(j + 1) % n];
        const delta = D[a * n + c] + D[b * n + d] - D[a * n + b] - D[c * n + d];
        if (delta < best) { best = delta; bj = j; }
      }
      if (best < -1e-9) {
        for (let lo = i, hi = bj; lo < hi; lo++, hi--) { const tmp = t[lo]; t[lo] = t[hi]; t[hi] = tmp; }
        imp = true;
      }
    }
  }
  let km = 0;
  for (let i = 0; i < n; i++) km += D[t[i] * n + t[(i + 1) % n]];
  return { km, orden: Array.from(t) };
}

export function desvio(T) {
  let best = 1e9;
  for (let k = Math.max(1, Math.floor(T / MAX_P)); k < Math.floor(T / MIN_P) + 2; k++) {
    const a = T / k; best = Math.min(best, k * Math.max(0, a - MAX_P, MIN_P - a));
  }
  return best;
}

export function kRutas(T) {
  let b0 = 1e9, b1 = 1e9, bk = 1;
  for (let k = Math.max(1, Math.floor(T / MAX_P)); k < Math.floor(T / MIN_P) + 2; k++) {
    const a = T / k, v0 = k * Math.max(0, a - MAX_P, MIN_P - a), v1 = Math.abs(a - 50);
    if (v0 < b0 || (v0 === b0 && v1 < b1)) { b0 = v0; b1 = v1; bk = k; }
  }
  return bk;
}

function media(pts) {
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p[0]; sy += p[1]; }
  return [sx / pts.length, sy / pts.length];
}

// ---------------- 5a. zonas de la noche ----------------
/** Distancia máxima entre los centroides de un grupo de bolsas (km). */
function diametro(ids, cen) {
  let d = 0;
  for (let a = 0; a < ids.length; a++) for (let b = 0; b < ids.length; b++) {
    const p = cen.get(ids[a]), q = cen.get(ids[b]);
    const v = hyp(p[0] - q[0], p[1] - q[1]);
    if (v > d) d = v;
  }
  return d;
}

/** Vecinas con pedidos hoy: recorrido en anchura por la vecindad fija; las bolsas vacías se cruzan hasta 3 km. */
function vecinasHoy(M, cnt) {
  const V = new Map();
  for (const b of cnt.keys()) {
    const out = new Set(), vis = new Set([b]), cola = [b];
    let ini = 0;                                 // cola: se saca siempre del inicio
    while (ini < cola.length) {
      const u = cola[ini++];
      for (const v of M.vecinas[u]) {            // vecinas en orden de id
        if (vis.has(v)) continue;
        vis.add(v);
        if (cnt.has(v)) out.add(v);
        else if (hyp(M.cen0[v][0] - M.cen0[b][0], M.cen0[v][1] - M.cen0[b][1]) <= SALTO_VACIO_KM) cola.push(v);
      }
    }
    V.set(b, out);
  }
  return V;
}

/** ¿Las bolsas de z quedan conectadas por vecinas de hoy? */
function continua(z, V) {
  const zz = new Set(z);
  if (zz.size <= 1) return true;
  const ini = Math.min(...zz), vis = new Set([ini]), pila = [ini];
  while (pila.length) {
    const u = pila.pop();
    for (const v of V.get(u)) if (zz.has(v) && !vis.has(v)) { vis.add(v); pila.push(v); }
  }
  return vis.size === zz.size;
}

/** Compara tuplas de números elemento por elemento (como Python). */
function menorTupla(a, b) {
  for (let k = 0; k < a.length; k++) { if (a[k] < b[k]) return true; if (a[k] > b[k]) return false; }
  return false;
}

function zonas(M, us, X) {
  const cnt = new Map(), suma = new Map();
  for (let i = 0; i < us.length; i++) {
    const b = us[i];
    if (!cnt.has(b)) { cnt.set(b, 0); suma.set(b, []); }
    cnt.set(b, cnt.get(b) + 1); suma.get(b).push(X[i]);
  }
  const ub = [...cnt.keys()].sort((a, b) => a - b);
  const cntOrd = new Map(ub.map(b => [b, cnt.get(b)]));   // mismo orden que el dict de Python
  const cen = new Map(ub.map(b => [b, media(suma.get(b))]));
  const C = b => cnt.get(b);
  const dist = (p, c) => hyp(p[0] - c[0], p[1] - c[1]);
  const V = vecinasHoy(M, cntOrd);
  const zs = []; const hecho = new Set();
  for (const b of ub) {                        // 1) núcleos: sus dos mitades juntas si suman <= 100
    if (M.esNucleo[b] && !hecho.has(b)) {
      const p = M.pareja[b]; hecho.add(b); hecho.add(p);
      if (cnt.has(p) && C(b) + C(p) <= PAR_NUCLEO) zs.push([b, p]);
      else { zs.push([b]); if (cnt.has(p)) zs.push([p]); }
    }
  }
  const zonaDe = new Map();
  zs.forEach((z, i) => z.forEach(u => zonaDe.set(u, i)));
  const carga = zs.map(z => z.reduce((s, u) => s + C(u), 0));
  const cz = zs.map(z => media(z.map(u => cen.get(u))));      // centro fijo: no se recalcula al crecer
  // 2) los núcleos crecen hacia sus satélites VECINOS: entra la menor tupla (distancia, i, s)
  for (;;) {
    let mejor = null;
    for (let i = 0; i < zs.length; i++) {
      for (const u of zs[i]) {
        for (const s of V.get(u)) {
          if (zonaDe.has(s) || M.esNucleo[s]) continue;
          const d = dist(cen.get(s), cz[i]);
          if (d <= RADIO_KM && carga[i] + C(s) <= TOPE_ZONA && (mejor === null || menorTupla([d, i, s], mejor))) mejor = [d, i, s];
        }
      }
    }
    if (mejor === null) break;
    const [, i, s] = mejor;
    zs[i].push(s); zonaDe.set(s, i); carga[i] += C(s);
  }
  // 3) satélites que no alcanzó ningún núcleo: zonas que crecen desde la bolsa con más pedidos
  let resto = ub.filter(b => !zonaDe.has(b));
  while (resto.length) {
    let semilla = resto[0];
    for (const b of resto) if (C(b) > C(semilla) || (C(b) === C(semilla) && b < semilla)) semilla = b;
    const z = [semilla]; let c = C(semilla); const c0 = cen.get(semilla);
    zonaDe.set(semilla, zs.length);
    while (c < META_ZONA) {
      const set = new Set();
      for (const u of z) for (const s of V.get(u)) if (!zonaDe.has(s)) set.add(s);
      const cand = [...set]
        .map(s => [dist(cen.get(s), c0), s])
        .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
        .map(a => a[1])
        .filter(s => c + C(s) <= TOPE_ZONA && diametro([...z, s], cen) <= DMAX_ZONA_KM);
      if (!cand.length) break;
      const s = cand[0];
      z.push(s); zonaDe.set(s, zs.length); c += C(s);
    }
    zs.push(z);
    resto = resto.filter(b => !zonaDe.has(b));
  }
  // 4) ajuste de borde: un satélite pasa a una zona VECINA si eso acerca ambas a rutas de 40 a 55
  //    y la zona de origen sigue siendo continua
  for (let vuelta = 0; vuelta < 300; vuelta++) {
    const T = zs.map(z => z.reduce((s, u) => s + C(u), 0));
    let mejor = null;
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i];
      for (const s of z) {
        if (M.esNucleo[s] || z.length === 1) continue;
        const js = [...new Set([...V.get(s)].map(v => zonaDe.get(v)))].filter(j => j !== i).sort((a, b) => a - b);
        for (const j of js) {
          const z2 = zs[j];
          if (!z2.some(u => M.esNucleo[u]) && diametro([...z2, s], cen) > DMAX_ZONA_KM) continue;
          const g = desvio(T[i]) + desvio(T[j]) - desvio(T[i] - C(s)) - desvio(T[j] + C(s));
          if (g > 0.5 && (mejor === null || g > mejor[0]) && continua(z.filter(u => u !== s), V)) mejor = [g, i, j, s];
        }
      }
    }
    if (mejor === null) break;
    const [, i, j, s] = mejor;
    zs[i].splice(zs[i].indexOf(s), 1); zs[j].push(s); zonaDe.set(s, j);
  }
  return zs.filter(z => z.length);
}

// ---------------- 5b. rutas por territorio y reparto entre los 3 turnos ----------------
/** Cada zona se corta en k rutas compactas; a la Ruta 1 van las que tienen más pedidos ya en el hub. */
function propuesta(M, D, X, us) {
  const idx = Array.from({ length: D.n }, (_, i) => i);
  const ola = D.ola;
  const zs = zonas(M, us, X);
  const rutas = []; let rot = 0;
  zs.forEach((z, zi) => {
    const zset = new Set(z);
    const miembros = idx.filter(i => zset.has(us[i]));     // en orden de índice del archivo
    const T = miembros.length;
    if (T === 0) return;
    const k = kRutas(T), base = [Math.floor(k / 3), Math.floor(k / 3), Math.floor(k / 3)];
    for (let e = 0; e < k % 3; e++) base[(rot + e) % 3]++;
    rot += k % 3;                              // contador global entre zonas
    const trozos = splitGeo(miembros, X, k);
    // −fracción de pedidos de las olas 1 y 2 (más pedidos ya en el hub primero); empate: posición
    const temprano = trozos.map(r => -(r.filter(i => ola[i] < 3).length / r.length));
    const orden = trozos.map((_, n) => n).sort((a, b) => (temprano[a] - temprano[b]) || (a - b));
    const turnoDe = [...Array(base[0]).fill(1), ...Array(base[1]).fill(2), ...Array(base[2]).fill(3)];
    orden.forEach((n, pos) => rutas.push({ turno: turnoDe[pos], zona: zi, idx: trozos[n] }));
  });
  return { zs, rutas };
}

function reglaActual(D) {
  const rutas = [];
  for (const turno of [1, 2, 3]) {
    const grupos = new Map();
    for (let i = 0; i < D.n; i++) {
      if (D.turno[i] !== turno) continue;
      const d = D.distrito[i];
      if (d === null || d === undefined || (typeof d === 'number' && Number.isNaN(d))) continue; // groupby descarta vacíos
      const key = String(d);
      if (!grupos.has(key)) grupos.set(key, []);
      grupos.get(key).push(i);
    }
    const claves = [...grupos.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (const d of claves) {
      const g = grupos.get(d);
      const o = argsortEstable(g.length, j => D.orden[g[j]]).map(j => g[j]);
      for (let k = 0; k < o.length; k += CAP_HOY) rutas.push({ turno, distrito: d, idx: o.slice(k, k + CAP_HOY) });
    }
  }
  return rutas;
}

// ---------------- 6. métricas ----------------
function metricas(rutas, X, D) {
  for (const r of rutas) {
    if (!r.orden) { const rec = recorrido(r.idx.map(i => X[i])); r.km = rec.km; r.orden = rec.orden; }
  }
  const tam = rutas.map(r => r.idx.length);
  let km = 0; for (const r of rutas) km += r.km;
  let dobles = 0;
  if (D.direccion) {
    const clave = D.direccion.map((v, i) => strPy(v).trim().toUpperCase() + '|' + strPy(D.distrito[i]));
    const rutaDe = new Map();
    rutas.forEach((r, ri) => {
      for (const i of r.idx) {
        const k = r.turno + '\u0000' + clave[i];
        if (!rutaDe.has(k)) rutaDe.set(k, new Set());
        rutaDe.get(k).add(ri);
      }
    });
    for (const v of rutaDe.values()) if (v.size > 1) dobles++;
  }
  if (!tam.length) return { rutas: 0, ruta1: 0, ruta2: 0, ruta3: 0, paradas_prom: 0, min: 0, max: 0, desparejas_pct: 0, km: 0, direcciones_con_2_motos: dobles };
  const total = tam.reduce((a, b) => a + b, 0);
  const desp = tam.filter(t => t < MIN_P || t > MAX_P).length;
  return {
    rutas: rutas.length,
    ruta1: rutas.filter(r => r.turno === 1).length,
    ruta2: rutas.filter(r => r.turno === 2).length,
    ruta3: rutas.filter(r => r.turno === 3).length,
    paradas_prom: roundRatio(total, tam.length, 1),
    min: Math.min(...tam), max: Math.max(...tam),
    desparejas_pct: roundHalfEven(desp / tam.length * 100),
    km: roundHalfEven(km),
    direcciones_con_2_motos: dobles,
  };
}

export function hora(minDesde0230) {
  const m = 150 + minDesde0230;
  const h = Math.trunc(Math.floor(m / 60)) % 24, mm = Math.trunc(m % 60);
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

const ahora = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Corrida completa de la noche. filas: arreglo de objetos (una fila por pedido). B: datos/bolsas.json.
 * Devuelve { resumen (mismas claves que resultados_esperados.json), y el detalle para dibujar }.
 */
export function sectorizar(filas, B, archivo = '') {
  const t0 = ahora();
  const M = prepararMalla(B);
  const D = leer(filas, B);
  const { X, us } = bolsasDe(M, D);
  const hoy = reglaActual(D);
  const { zs, rutas: prop } = propuesta(M, D, X, us);
  const mHoy = metricas(hoy, X, D), mProp = metricas(prop, X, D);
  const segundos = (ahora() - t0) / 1000;

  const ola = D.ola;
  let r1Ola3 = 0, r1Total = 0;
  for (const r of prop) if (r.turno === 1) { r1Total += r.idx.length; for (const i of r.idx) if (ola[i] === 3) r1Ola3++; }
  let ola3 = 0; for (const o of ola) if (o === 3) ola3++;
  const resumen = {
    archivo, pedidos: D.n,
    pedidos_turno3_hoy: D.turno.filter(t => t === 3).length,
    olas: [1, 2, 3].map(k => ola.filter(o => o === k).length),
    zonas: zs.length,
    regla_actual: mHoy, propuesta: mProp,
    ruta1_lista_propuesta: hora(r1Ola3 / VEL_HUB * 60),
    ruta1_lista_regla_actual: hora(ola3 / VEL_HUB * 60),
    pedidos_ola3_que_espera_ruta1: r1Ola3,
    ruta1_pedidos: r1Total,
    ruta1_ya_en_hub_pct: r1Total ? roundHalfEven((r1Total - r1Ola3) / r1Total * 100) : 0,
    segundos_algoritmo: Math.round(segundos * 100) / 100,
  };

  // asignación por pedido (propuesta)
  const zona = new Array(D.n).fill(null), turno = D.turno.slice(), ruta = new Array(D.n).fill(null), pos = new Array(D.n).fill(null);
  prop.forEach((r, k) => {
    r.orden.forEach((j, p) => { const i = r.idx[j]; zona[i] = r.zona + 1; turno[i] = r.turno; ruta[i] = k + 1; pos[i] = p + 1; });
  });
  const aviso = turno.map((t, i) => (ola[i] < 3 && Math.trunc(t) > 1 && zona[i] !== null) ? 'Queda para la Ruta ' + Math.trunc(t) : '');
  // ruta de cada pedido en la regla actual
  const rutaHoy = new Array(D.n).fill(null);
  hoy.forEach((r, k) => { for (const i of r.idx) rutaHoy[i] = k; });

  return {
    resumen, segundos, malla: M, datos: D, X, us, zonas: zs,
    rutasPropuesta: prop, rutasReglaActual: hoy,
    pedido: { zona, turno, ruta, orden: pos, aviso, rutaHoy },
  };
}

// ---------------- salida descargable ----------------
function celdaCSV(v) {
  if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) return '';
  let s;
  if (v instanceof Date) s = v.toISOString();
  else s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const flotante = x => Number.isInteger(x) ? x.toFixed(1) : String(x);

/** CSV de la sección 5 (texto; agregar BOM al descargar). */
export function generarCSV(R) {
  const D = R.datos, U = R.malla.U, P = R.pedido;
  const cab = [];
  if (D.oc) cab.push('OC');
  if (D.direccion) cab.push('DIRECCION');
  cab.push('DISTRITO', 'LAT', 'LON', 'OLA', 'BOLSA', 'UBICACION', 'ZONA', 'TURNO', 'FRANJA', 'RUTA', 'ORDEN_EN_RUTA', 'AVISO_CARGA', 'COORD_AJUSTADA');
  const lineas = [cab.join(',')];
  for (let i = 0; i < D.n; i++) {
    const b = U[R.us[i]], t = Math.trunc(P.turno[i]);
    const fila = [];
    if (D.oc) fila.push(D.oc[i]);
    if (D.direccion) fila.push(D.direccion[i]);
    fila.push(D.distrito[i], flotante(D.lat[i]), flotante(D.lon[i]), D.ola[i], b.code, b.ubicacion,
      P.zona[i], t, FRANJAS[t] || '', P.ruta[i], P.orden[i], P.aviso[i], D.ajustada[i]);
    lineas.push(fila.map(celdaCSV).join(','));
  }
  return lineas.join('\n') + '\n';
}

/** Nombre del archivo de salida: sectorizacion_AAAA-MM-DD.csv */
export function nombreSalida(R) {
  const f = R.datos.fechaEntrega;
  if (!f) return 'sectorizacion.csv';
  const p = x => String(x).padStart(2, '0');
  return `sectorizacion_${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}.csv`;
}
