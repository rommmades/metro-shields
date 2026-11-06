// Кадр прогресса для постов: тёмная карта-схема линии, трассы щитов, плашки с цифрами, выгрузка в PNG.
// Параметры: ?line=Красносельско (какие щиты брать по названию линии), ?size=1600x1000, #cam=lng,lat,zoom,bearing,pitch
(function () {
  'use strict';
  const qs = new URLSearchParams(location.search);
  const $ = id => document.getElementById(id);
  const fmt = n => Math.round(n).toLocaleString('ru-RU');
  const C = { bg: '#141a1c', water: '#0f2129', green: '#172019', bld: '#1f272a', road: '#2b3538', major: '#3a4649', rail: '#262e31', label: '#6f7b80', ink: '#e8ecec', muted: '#93a1a6' };
  const STYLE = qs.has('offline') ? { version: 8, sources: {}, glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf', layers: [{ id: 'bg', type: 'background', paint: { 'background-color': C.bg } }] }
    : 'https://tiles.openfreemap.org/styles/positron';

  let W = 1600, H = 1000;
  const sz = (qs.get('size') || '').match(/^(\d+)x(\d+)$/); if (sz) { W = +sz[1]; H = +sz[2]; }
  $('size').value = W + 'x' + H;
  const frame = $('frame'); frame.style.width = W + 'px'; frame.style.height = H + 'px';

  const map = new maplibregl.Map({ container: 'map', style: STYLE, center: [30.335, 59.903], zoom: 13, attributionControl: false, preserveDrawingBuffer: true, maxPitch: 70 });

  // Мышь как на основном сайте: левая кнопка вращает и наклоняет, правая сдвигает
  (() => {
    const cv = map.getCanvas(); let drag = null;
    cv.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); drag = { pan: e.button !== 0 || e.shiftKey, x: e.clientX, y: e.clientY }; });
    addEventListener('mousemove', e => {
      if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) map.panBy([-dx, -dy], { animate: false });
      else map.jumpTo({ bearing: map.getBearing() - dx * 0.35, pitch: Math.max(0, Math.min(70, map.getPitch() - dy * 0.3)) });
    });
    addEventListener('mouseup', () => drag = null);
    cv.addEventListener('contextmenu', e => e.preventDefault());
  })();

  let DATA, group = [];
  Promise.all([fetch('data/shields.json', { cache: 'no-cache' }).then(r => r.json()), new Promise(r => map.on('load', r)), document.fonts.ready])
    .then(([d]) => {
      DATA = d;
      const key = qs.get('line') || 'Красносельско';
      group = DATA.shields.filter(s => (s.line || '').includes(key));
      if (!group.length) group = [DATA.shields[0]];
      darken(); addData(); applyCam() || fit(false);
      map.on('render', drawOverlay); drawOverlay();
    });

  // --- Тёмная перекраска стандартного стиля Positron ---
  function darken() {
    const set = (id, p, v) => { try { map.setPaintProperty(id, p, v); } catch (e) {} };
    for (const l of map.getStyle().layers) {
      const id = l.id;
      if (l.type === 'background') set(id, 'background-color', C.bg);
      else if (l.type === 'fill') set(id, 'fill-color', /water/.test(id) ? C.water : /park|wood|grass|landcover|green/.test(id) ? C.green : /building/.test(id) ? C.bld : C.bg);
      else if (l.type === 'fill-extrusion') map.setLayoutProperty(id, 'visibility', 'none');
      else if (l.type === 'line') {
        if (/boundary|admin/.test(id)) { map.setLayoutProperty(id, 'visibility', 'none'); continue; }
        set(id, 'line-color', /water|river|canal/.test(id) ? C.water : /rail|transit/.test(id) ? C.rail : /motorway|trunk|primary/.test(id) ? C.major : C.road);
      } else if (l.type === 'symbol') {
        if (/poi|housenum|transit|station|aeroway|airport|shield/.test(id)) { map.setLayoutProperty(id, 'visibility', 'none'); continue; }
        set(id, 'text-color', C.label); set(id, 'text-halo-color', C.bg); set(id, 'icon-opacity', 0);
      }
    }
  }

  // --- Геометрия трасс: ломаная, длина по дуге, кольцо → доля пути ---
  const DEG = { x: 55800, y: 111300 };
  function arc(path) { const c = [0]; for (let i = 1; i < path.length; i++) c.push(c[i - 1] + Math.hypot((path[i][0] - path[i - 1][0]) * DEG.x, (path[i][1] - path[i - 1][1]) * DEG.y)); return c; }
  function tOfRing(sh, r) { const k = sh.ringKnots; for (let i = 0; i < k.length - 1; i++) if (r <= k[i + 1][0]) { const a = k[i], b = k[i + 1]; return a[1] + (b[1] - a[1]) * (r - a[0]) / (b[0] - a[0]); } return k[k.length - 1][1]; }
  function at(sh, t) {
    t = Math.max(0, Math.min(1, t)); const c = sh._c || (sh._c = arc(sh.path)), L = c[c.length - 1] * t;
    for (let i = 1; i < c.length; i++) if (L <= c[i]) { const f = (L - c[i - 1]) / (c[i] - c[i - 1] || 1), a = sh.path[i - 1], b = sh.path[i]; return { i, p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] }; }
    return { i: sh.path.length - 1, p: sh.path[sh.path.length - 1] };
  }
  function slice(sh, t0, t1) { const a = at(sh, t0), b = at(sh, t1); return [a.p, ...sh.path.slice(a.i, b.i), b.p]; }

  function addData() {
    const F = [], P = [];
    const seenSt = new Set();
    group.forEach((sh, n) => {
      const t = tOfRing(sh, sh.ring);
      F.push({ type: 'Feature', properties: { k: 'all', c: sh.lineColor || '#8a5a36', o: (n - (group.length - 1) / 2) * 7 }, geometry: { type: 'LineString', coordinates: sh.path } });
      if (t > 0.002) F.push({ type: 'Feature', properties: { k: 'done', c: sh.color || '#e3a21a', o: (n - (group.length - 1) / 2) * 7 }, geometry: { type: 'LineString', coordinates: slice(sh, 0, t) } });
      P.push({ type: 'Feature', properties: { k: 'shield', c: sh.color || '#e3a21a', name: '«' + sh.name + '»' }, geometry: { type: 'Point', coordinates: at(sh, t).p } });
      sh.stations.forEach(s => {
        if (seenSt.has(s.name)) return; seenSt.add(s.name);
        const ll = s.vestibule && s.vestibule.lnglat ? s.vestibule.lnglat : at(sh, tOfRing(sh, (s.from + s.to) / 2)).p;
        P.push({ type: 'Feature', properties: { k: 'station', name: s.name }, geometry: { type: 'Point', coordinates: ll } });
      });
      if (n === 0) (sh.shafts || []).forEach(v => v.lnglat && P.push({ type: 'Feature', properties: { k: 'shaft', name: (v.name || '').replace('Шахта ', '') }, geometry: { type: 'Point', coordinates: v.lnglat } }));
      if (n === 0) (sh.existing || []).forEach(e => P.push({ type: 'Feature', properties: { k: 'ex', name: e.name + ' ' + e.line }, geometry: { type: 'Point', coordinates: e.lnglat } }));
    });
    map.addSource('lines', { type: 'geojson', data: { type: 'FeatureCollection', features: F } });
    map.addSource('pts', { type: 'geojson', data: { type: 'FeatureCollection', features: P } });
    map.addSource('txt', { type: 'geojson', data: { type: 'FeatureCollection', features: P } }); // подписи отдельно: без шрифтов точки всё равно видны
    const font = ['Noto Sans Regular'], bold = ['Noto Sans Bold'];
    map.addLayer({ id: 'l-all', type: 'line', source: 'lines', filter: ['==', 'k', 'all'], layout: { 'line-cap': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': 4, 'line-offset': ['get', 'o'], 'line-opacity': 0.75, 'line-dasharray': [1.4, 1.2] } });
    map.addLayer({ id: 'l-glow', type: 'line', source: 'lines', filter: ['==', 'k', 'done'], paint: { 'line-color': ['get', 'c'], 'line-width': 16, 'line-offset': ['get', 'o'], 'line-opacity': 0.18, 'line-blur': 6 } });
    map.addLayer({ id: 'l-done', type: 'line', source: 'lines', filter: ['==', 'k', 'done'], layout: { 'line-cap': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': 5, 'line-offset': ['get', 'o'] } });
    map.addLayer({ id: 'p-shaft', type: 'circle', source: 'pts', filter: ['==', 'k', 'shaft'], paint: { 'circle-radius': 3.5, 'circle-color': C.bg, 'circle-stroke-color': C.muted, 'circle-stroke-width': 1.5 } });
    map.addLayer({ id: 'p-ex', type: 'circle', source: 'pts', filter: ['==', 'k', 'ex'], paint: { 'circle-radius': 4, 'circle-color': '#56636a' } });
    map.addLayer({ id: 'p-st', type: 'circle', source: 'pts', filter: ['==', 'k', 'station'], paint: { 'circle-radius': 8, 'circle-color': C.bg, 'circle-stroke-color': C.ink, 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'p-sh-halo', type: 'circle', source: 'pts', filter: ['==', 'k', 'shield'], paint: { 'circle-radius': 20, 'circle-color': ['get', 'c'], 'circle-opacity': 0.22, 'circle-blur': 0.4 } });
    map.addLayer({ id: 'p-sh', type: 'circle', source: 'pts', filter: ['==', 'k', 'shield'], paint: { 'circle-radius': 8, 'circle-color': ['get', 'c'], 'circle-stroke-color': '#111', 'circle-stroke-width': 2 } });
    map.addLayer({ id: 't-ex', type: 'symbol', source: 'txt', filter: ['==', 'k', 'ex'], layout: { 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 13, 'text-offset': [0, 1.1], 'text-anchor': 'top' }, paint: { 'text-color': '#7f8c91', 'text-halo-color': C.bg, 'text-halo-width': 2 } });
    map.addLayer({ id: 't-shaft', type: 'symbol', source: 'txt', filter: ['==', 'k', 'shaft'], minzoom: 13.5, layout: { 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 11, 'text-offset': [0.8, 0], 'text-anchor': 'left' }, paint: { 'text-color': C.muted, 'text-halo-color': C.bg, 'text-halo-width': 2 } });
    map.addLayer({ id: 't-st', type: 'symbol', source: 'txt', filter: ['==', 'k', 'station'], layout: { 'text-field': ['get', 'name'], 'text-font': bold, 'text-size': 19, 'text-offset': [0, -1.3], 'text-anchor': 'bottom' }, paint: { 'text-color': C.ink, 'text-halo-color': C.bg, 'text-halo-width': 3 } });
    map.addLayer({ id: 't-sh', type: 'symbol', source: 'txt', filter: ['==', 'k', 'shield'], layout: { 'text-field': ['get', 'name'], 'text-font': bold, 'text-size': 15, 'text-offset': [1.4, 0], 'text-anchor': 'left' }, paint: { 'text-color': ['get', 'c'], 'text-halo-color': C.bg, 'text-halo-width': 3 } });
  }

  function fit(animate = true) {
    const b = new maplibregl.LngLatBounds(); group.forEach(s => s.path.forEach(p => b.extend(p)));
    map.fitBounds(b, { padding: { top: H * 0.2, bottom: H * 0.28, left: W * 0.08, right: W * 0.08 }, bearing: map.getBearing(), animate });
  }
  function applyCam() {
    const m = location.hash.match(/cam=([-\d.,]+)/); if (!m) return false;
    const [lng, lat, zoom, bearing, pitch] = m[1].split(',').map(Number);
    map.jumpTo({ center: [lng, lat], zoom, bearing, pitch }); return true;
  }

  // --- Подписи поверх карты: заголовок, плашки щитов, источник. Рисуются в canvas, поэтому попадают в PNG ---
  function progress(sh) {
    const M = sh.unit === 'm', u = M ? ' м' : ' колец', r = sh.ring;
    const st = sh.stations.filter(s => s.to > 0), inside = st.find(s => r >= s.from && r <= s.to), next = st.find(s => s.from > r);
    const big = fmt(r) + (M ? ' м' : ' колец');
    const sub = r >= sh.total ? 'проходка завершена' : inside ? 'проходит станцию «' + inside.name + '»' : next ? 'до станции «' + next.name + '» ' + fmt(next.from - r) + u : 'до финиша ' + fmt(sh.total - r) + u;
    return { big, sub, frac: Math.min(1, r / sh.total) };
  }
  function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function paint(ctx, w, h) {
    const k = Math.min(w / 1600, h / 1000) * 1.25, pad = 40 * k;
    // мягкое затемнение сверху и снизу, чтобы текст читался
    let g = ctx.createLinearGradient(0, 0, 0, h * 0.3); g.addColorStop(0, 'rgba(15,20,22,.9)'); g.addColorStop(1, 'rgba(15,20,22,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h * 0.3);
    g = ctx.createLinearGradient(0, h * 0.62, 0, h); g.addColorStop(0, 'rgba(15,20,22,0)'); g.addColorStop(1, 'rgba(15,20,22,.92)'); ctx.fillStyle = g; ctx.fillRect(0, h * 0.62, w, h * 0.38);
    ctx.textBaseline = 'alphabetic';
    const line = (group[0].line || '').split(',').slice(0, 2).join(' ·').replace(/\s*\(.*?\)/, '');
    ctx.fillStyle = '#c98a55'; ctx.font = `600 ${15 * k}px "IBM Plex Mono", monospace`;
    ctx.fillText(line.toUpperCase(), pad, pad + 14 * k);
    ctx.fillStyle = C.ink; ctx.font = `700 ${40 * k}px Unbounded, sans-serif`;
    ctx.fillText('Где сейчас щиты', pad, pad + 64 * k);
    ctx.fillStyle = C.muted; ctx.font = `400 ${17 * k}px "Golos Text", sans-serif`;
    ctx.fillText('на ' + new Date(DATA.updated).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }), pad, pad + 94 * k);
    // плашки щитов
    const cw = Math.min(380 * k, (w - pad * 2 - 16 * k * (group.length - 1)) / group.length), ch = 118 * k;
    group.forEach((sh, i) => {
      const x = pad + i * (cw + 16 * k), y = h - pad - ch - 18 * k, p = progress(sh);
      ctx.fillStyle = 'rgba(30,36,39,.92)'; rr(ctx, x, y, cw, ch, 12 * k); ctx.fill();
      ctx.fillStyle = sh.color || '#e3a21a'; ctx.beginPath(); ctx.arc(x + 22 * k, y + 28 * k, 7 * k, 0, 7); ctx.fill();
      ctx.fillStyle = C.ink; ctx.font = `600 ${17 * k}px "Golos Text", sans-serif`; ctx.fillText('Щит «' + sh.name + '»', x + 38 * k, y + 34 * k);
      ctx.font = `600 ${30 * k}px "IBM Plex Mono", monospace`; ctx.fillText(p.big, x + 18 * k, y + 74 * k);
      ctx.fillStyle = C.muted; ctx.font = `400 ${15 * k}px "Golos Text", sans-serif`; ctx.fillText(p.sub, x + 18 * k, y + 98 * k);
      ctx.fillStyle = '#2f383b'; rr(ctx, x + 18 * k, y + ch - 12 * k, cw - 36 * k, 5 * k, 2.5 * k); ctx.fill();
      ctx.fillStyle = sh.color || '#e3a21a'; rr(ctx, x + 18 * k, y + ch - 12 * k, Math.max(5 * k, (cw - 36 * k) * p.frac), 5 * k, 2.5 * k); ctx.fill();
    });
    ctx.fillStyle = '#6f7b80'; ctx.font = `400 ${12.5 * k}px "Golos Text", sans-serif`; ctx.textAlign = 'right';
    ctx.fillText('t.me/podzemnik_spb · карта © OpenStreetMap, OpenFreeMap · положение щитов примерное', w - pad, h - pad * 0.5);
    ctx.textAlign = 'left';
  }
  function drawOverlay() {
    const cv = $('ov'), dpr = devicePixelRatio || 1;
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px'; }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H); paint(ctx, W, H);
  }

  $('b-png').onclick = () => {
    map.once('render', () => {
      const mc = map.getCanvas(), out = document.createElement('canvas'), s = mc.width / W;
      out.width = mc.width; out.height = mc.height;
      const ctx = out.getContext('2d'); ctx.drawImage(mc, 0, 0); ctx.setTransform(s, 0, 0, s, 0, 0); paint(ctx, W, H);
      const a = document.createElement('a'); a.download = 'shchity-' + (DATA.updated || 'kadr') + '.png'; a.href = out.toDataURL('image/png'); a.click();
    });
    map.triggerRepaint();
  };
  $('b-fit').onclick = () => fit(true);
  $('size').onchange = () => { const u = new URL(location.href); u.searchParams.set('size', $('size').value); location.href = u.href; };
  $('b-link').onclick = () => {
    const c = map.getCenter(), f = n => +n.toFixed(5);
    const u = new URL(location.href); u.hash = 'cam=' + [f(c.lng), f(c.lat), f(map.getZoom()), +map.getBearing().toFixed(1), +map.getPitch().toFixed(1)].join(',');
    history.replaceState(null, '', u.pathname + u.search + u.hash);
    navigator.clipboard.writeText(u.href).then(() => { $('b-link').textContent = 'Скопировано'; setTimeout(() => $('b-link').textContent = 'Ссылка на этот кадр', 1500); });
  };
})();
