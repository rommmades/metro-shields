// Щиты метро СПб в 3D: карта MapLibre (OpenFreeMap) + тоннель на three.js под ней.
// Данные лежат в data/shields.json: чтобы обновить положение щита, поменяйте там "ring".
(function () {
  'use strict';
  const qs = new URLSearchParams(location.search);
  const STYLE = qs.has('offline')
    ? { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#f3f1ec' } }] }
    : 'https://tiles.openfreemap.org/styles/liberty';
  const VEX = 1.6;       // вертикальное преувеличение глубины, чтобы тоннель было видно
  const R = 7;           // радиус тоннеля в сцене, м (реальный ≈2,8 м, увеличен для читаемости)
  const $ = id => document.getElementById(id);
  const fmt = n => Math.round(n).toLocaleString('ru-RU');

  const map = new maplibregl.Map({
    container: 'map', style: STYLE, center: [30.335, 59.903], zoom: 13.6, pitch: 55, bearing: -20,
    maxPitch: 75, antialias: true, attributionControl: false
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

  let DATA, shield, origin, S, layer, markers = [];

  Promise.all([fetch('data/shields.json').then(r => r.json()), new Promise(res => map.on('load', res))])
    .then(([d]) => { DATA = d; tuneStyle(); setupPicker(); pick(qs.get('shield') || DATA.shields[0].id); })
    .catch(e => { console.error(e); $('p-next').textContent = 'Не удалось загрузить данные.'; });

  // --- Стиль карты: убираем лишние значки, делаем дома спокойными и полупрозрачными ---
  function tuneStyle() {
    for (const l of map.getStyle().layers) {
      if (l.type === 'symbol' && /poi|aerialway|ferry/.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
    }
    if (map.getLayer('building-3d')) {
      map.setPaintProperty('building-3d', 'fill-extrusion-color', '#e4e0d8');
      map.setPaintProperty('building-3d', 'fill-extrusion-opacity', 0.72);
    }
    map.setLight({ anchor: 'map', position: [1.3, 200, 40], intensity: 0.35 });
  }

  // --- Координаты: локальные метры вокруг начала трассы (x — восток, y — юг, z — вверх) ---
  function toLocal(ll) { const m = maplibregl.MercatorCoordinate.fromLngLat(ll); return [(m.x - origin.x) / S, (m.y - origin.y) / S]; }
  function toLngLat(x, y) { return new maplibregl.MercatorCoordinate(origin.x + x * S, origin.y + y * S, 0).toLngLat(); }

  function setupPicker() {
    const sel = $('p-pick');
    if (DATA.shields.length < 2) return;
    sel.hidden = false;
    sel.innerHTML = DATA.shields.map(s => `<option value="${s.id}">«${s.name}»</option>`).join('');
    sel.onchange = () => pick(sel.value);
  }

  function pick(id) {
    shield = DATA.shields.find(s => s.id === id) || DATA.shields[0];
    $('p-pick').value = shield.id;
    origin = maplibregl.MercatorCoordinate.fromLngLat(shield.path[0], 0);
    S = origin.meterInMercatorCoordinateUnits();
    document.documentElement.style.setProperty('--accent', shield.color || '#e3a21a');
    $('p-line').textContent = shield.line;
    $('p-name').textContent = 'Щит «' + shield.name + '»';
    const M = shield.unit === 'm';
    $('p-of').textContent = (M ? 'м из ~' : 'колец из ~') + fmt(shield.total);
    $('ring').step = M ? 20 : 10;
    $('p-note').textContent = [shield.note, 'Обновлено ' + new Date(DATA.updated).toLocaleDateString('ru-RU')].filter(Boolean).join('. ') + '.';
    const r = $('ring'); r.max = shield.total; r.value = shield.ring;
    buildScene();
    setRing(shield.ring);
    overview(false);
  }

  // --- 3D-слой под картой ---
  function buildScene() {
    if (map.getLayer('tunnel')) map.removeLayer('tunnel');
    markers.forEach(m => m.remove()); markers = [];
    const D = shield.depth * VEX;
    const pts = shield.path.map(ll => { const [x, y] = toLocal(ll); return new THREE.Vector3(x, y, -D); });
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const sun = new THREE.DirectionalLight(0xffffff, 0.55); sun.position.set(-0.5, -1, 2); scene.add(sun);
    const mat = (color, opacity) => new THREE.MeshLambertMaterial({ color, transparent: opacity < 1, opacity, side: THREE.DoubleSide, depthWrite: opacity >= 1 });
    const accent = new THREE.Color(shield.color || '#e3a21a');

    // Весь будущий тоннель — полупрозрачная труба
    scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 500, R, 16, false), mat(0x8fa3b0, 0.35)));
    // Срез грунта: вертикальная полупрозрачная «стенка» от поверхности до тоннеля
    const wall = [], N = 240;
    for (let i = 0; i < N; i++) {
      const a = curve.getPointAt(i / N), b = curve.getPointAt((i + 1) / N), z0 = -D - 25;
      wall.push(a.x, a.y, 0, a.x, a.y, z0, b.x, b.y, 0, a.x, a.y, z0, b.x, b.y, z0, b.x, b.y, 0);
    }
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wall, 3));
    scene.add(new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ color: 0x9fb1bd, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })));

    // Станции: объём на глубине + ствол к поверхности + подпись
    const ringT = r => tOfRing(r);
    shield.stations.forEach(s => {
      const t1 = Math.max(0, ringT(s.from)), t2 = Math.min(1, ringT(s.to));
      const sub = new THREE.CatmullRomCurve3(Array.from({ length: 10 }, (_, i) => curve.getPointAt(t1 + (t2 - t1) * i / 9)));
      scene.add(new THREE.Mesh(new THREE.TubeGeometry(sub, 24, R * 2.2, 6, false), s.pilot ? mat(accent, 0.4) : mat(0xffffff, 0.92)));
      const mid = curve.getPointAt((t1 + t2) / 2);
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, D, 10), mat(0xffffff, 0.55));
      shaft.rotation.x = Math.PI / 2; shaft.position.set(mid.x, mid.y, -D / 2); scene.add(shaft);
      markers.push(label(s.name, toLngLat(mid.x, mid.y), 'new'));
    });
    (shield.existing || DATA.existing || []).forEach(e => markers.push(label(`${e.name} <small>${e.line}</small>`, e.lnglat, 'ex')));

    // Пройденная часть и щит
    const doneMat = mat(0x39474f, 1);
    let doneMesh = null;
    const sh = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.3, R * 1.3, 26, 24), new THREE.MeshLambertMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.4 }));
    sh.add(body);
    const head = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.4, R * 1.4, 3, 24), mat(0x39474f, 1)); head.position.y = 14; sh.add(head);
    scene.add(sh);
    const beacon = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, D, 6), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.7 }));
    beacon.rotation.x = Math.PI / 2; scene.add(beacon);
    const shLabel = label('', shield.path[0], 'sh');
    markers.push(shLabel);

    const Y = new THREE.Vector3(0, 1, 0);
    layer = {
      id: 'tunnel', type: 'custom', renderingMode: '3d',
      curve, D,
      setT(t) {
        const p = curve.getPointAt(t), tan = curve.getTangentAt(t);
        sh.position.copy(p); sh.quaternion.setFromUnitVectors(Y, tan);
        beacon.position.set(p.x, p.y, -D / 2);
        if (doneMesh) { scene.remove(doneMesh); doneMesh.geometry.dispose(); doneMesh = null; }
        if (t > 0.002) {
          const dp = Array.from({ length: 80 }, (_, i) => curve.getPointAt(t * i / 79));
          doneMesh = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(dp), 160, R * 1.03, 16, false), doneMat);
          scene.add(doneMesh);
        }
        const ll = toLngLat(p.x, p.y);
        shLabel.setLngLat(ll);
        this.shieldLL = ll;
        map.triggerRepaint();
      },
      onAdd(m, gl) {
        this.camera = new THREE.Camera();
        this.renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
        this.renderer.autoClear = false;
      },
      render(gl, matrix) {
        const l = new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z).scale(new THREE.Vector3(S, S, S));
        this.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(l);
        this.renderer.resetState();
        this.renderer.render(scene, this.camera);
      },
      shLabel
    };
    map.addLayer(layer, map.getLayer('building-3d') ? 'building-3d' : undefined);

    // Трасса на поверхности: пунктир будущего хода и сплошная линия пройденного
    const line = Array.from({ length: 200 }, (_, i) => { const p = curve.getPointAt(i / 199); const ll = toLngLat(p.x, p.y); return [ll.lng, ll.lat]; });
    const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { k: 'all' }, geometry: { type: 'LineString', coordinates: line } }] };
    if (map.getSource('route')) map.getSource('route').setData(fc);
    else {
      map.addSource('route', { type: 'geojson', data: fc });
      map.addLayer({ id: 'route-all', type: 'line', source: 'route', filter: ['==', 'k', 'all'], paint: { 'line-color': '#39474f', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.6 } }, 'tunnel');
      map.addLayer({ id: 'route-done', type: 'line', source: 'route', filter: ['==', 'k', 'done'], paint: { 'line-color': '#39474f', 'line-width': 4 } }, 'tunnel');
    }
    layer.line = line;
  }

  function label(html, ll, cls) {
    const el = document.createElement('div'); el.className = 'lbl ' + cls; el.innerHTML = html;
    return new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -6] }).setLngLat(ll).addTo(map);
  }

  function tOfRing(r) {
    const k = shield.ringKnots;
    for (let i = 0; i < k.length - 1; i++) if (r <= k[i + 1][0]) { const a = k[i], b = k[i + 1]; return a[1] + (b[1] - a[1]) * (r - a[0]) / (b[0] - a[0]); }
    return k[k.length - 1][1];
  }

  function setRing(r) {
    r = +r;
    const t = Math.min(1, Math.max(0, tOfRing(r)));
    layer.setT(t);
    layer.shLabel.getElement().innerHTML = '«' + shield.name + '» · <span class="mono">' + (r >= shield.total ? 'финиш' : unitTxt(r)) + '</span>';
    const n = Math.max(2, Math.round(t * 199));
    const fc = { type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { k: 'all' }, geometry: { type: 'LineString', coordinates: layer.line } },
      { type: 'Feature', properties: { k: 'done' }, geometry: { type: 'LineString', coordinates: layer.line.slice(0, n) } }] };
    map.getSource('route').setData(fc);
    $('p-ring').textContent = fmt(r);
    $('p-bar').style.width = Math.min(100, r / shield.total * 100) + '%';
    $('ring-out').textContent = unitTxt(r);
    const st = shield.stations.filter(s => s.to > 0);
    const inside = st.find(s => r >= s.from && r <= s.to);
    const next = st.find(s => s.from > r);
    let txt;
    if (r >= shield.total) txt = 'Проходка участка завершена';
    else if (inside) txt = 'Щит проходит «' + inside.name + '»';
    else if (next && next.from < shield.total) txt = 'До «' + next.name + '» ' + fmt(next.from - r) + (shield.unit === 'm' ? ' м' : ' колец');
    else if (r < shield.total) txt = 'До финиша ' + fmt(shield.total - r) + (shield.unit === 'm' ? ' м' : ' колец');
    else txt = 'Проходка участка завершена';
    $('p-next').textContent = txt;
  }

  function unitTxt(r) { return shield.unit === 'm' ? fmt(r) + ' м' : 'кольцо ' + fmt(r); }

  function overview(animate = true) {
    const b = new maplibregl.LngLatBounds();
    shield.path.forEach(p => b.extend(p));
    const small = innerWidth < 640;
    const cam = map.cameraForBounds(b, { padding: small ? { top: 170, bottom: 150, left: 20, right: 20 } : { top: 60, bottom: 140, left: 380, right: 60 }, bearing: -20 });
    const o = { center: cam.center, zoom: cam.zoom + (small ? 0.2 : 0.8), bearing: -20, pitch: 55 };
    animate ? map.easeTo({ ...o, duration: 1200 }) : map.jumpTo(o);
  }
  function follow() { map.easeTo({ center: layer.shieldLL, zoom: 15.8, pitch: 65, duration: 1200 }); }

  $('ring').addEventListener('input', e => setRing(e.target.value));
  $('b-now').onclick = () => { $('ring').value = shield.ring; setRing(shield.ring); follow(); };
  $('b-follow').onclick = follow;
  $('b-all').onclick = () => overview(true);
})();
