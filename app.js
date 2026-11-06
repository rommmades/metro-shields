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
  const ESC_ANGLE = 30;  // наклон эскалаторного хода, градусы
  const $ = id => document.getElementById(id);
  const fmt = n => Math.round(n).toLocaleString('ru-RU');
  const EDIT = qs.has('edit');
  if (EDIT) document.body.classList.add('edit');

  const map = new maplibregl.Map({
    container: 'map', style: STYLE, center: [30.335, 59.903], zoom: 13.6, pitch: 55, bearing: -20,
    maxPitch: 85, antialias: true, attributionControl: false
  });

  // Мышью — как под землёй: левая кнопка вращает и наклоняет, правая (или Shift) сдвигает карту.
  // Касания остаются за MapLibre: одним пальцем сдвиг, двумя — поворот, наклон и масштаб.
  (() => {
    const cv = map.getCanvas(); let drag = null, lastTouch = 0;
    cv.addEventListener('touchstart', () => lastTouch = Date.now(), { passive: true });
    cv.addEventListener('mousedown', e => {
      if (Date.now() - lastTouch < 800) return;
      e.stopPropagation(); e.preventDefault();
      drag = { pan: e.button !== 0 || e.shiftKey, x: e.clientX, y: e.clientY };
      cv.style.cursor = 'grabbing';
    });
    addEventListener('mousemove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) map.panBy([-dx, -dy], { animate: false });
      else map.jumpTo({ bearing: map.getBearing() - dx * 0.35, pitch: Math.max(0, Math.min(85, map.getPitch() - dy * 0.3)) });
    });
    addEventListener('mouseup', () => { if (drag) { drag = null; cv.style.cursor = ''; } });
    cv.addEventListener('contextmenu', e => e.preventDefault());
  })();
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

  let DATA, shield, origin, S, layer, markers = [];
  let scene, ugGroup, ugLabels = [];

  Promise.all([fetch('data/shields.json', { cache: 'no-cache' }).then(r => r.json()), new Promise(res => map.on('load', res))])
    .then(([d]) => { DATA = d; tuneStyle(); setupPicker(); pick(qs.get('shield') || DATA.shields[0].id); setupEdit(); applyCam(); if (qs.has('under')) openUnder(); })
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
    document.documentElement.style.setProperty('--lc', shield.lineColor || '#39474f');
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
    if (UG.open) UG.rebuildSurface();
  }

  const mat = (color, opacity) => new THREE.MeshLambertMaterial({ color, transparent: opacity < 1, opacity, side: THREE.DoubleSide, depthWrite: opacity >= 1 });

  // --- 3D-сцена: тоннель, станции с эскалаторами, вентшахты, щит ---
  function buildScene() {
    if (map.getLayer('tunnel')) map.removeLayer('tunnel');
    markers.forEach(m => m.remove()); markers = [];
    ugLabels = [];
    const D = shield.depth * VEX;
    const pts = shield.path.map(ll => { const [x, y] = toLocal(ll); return new THREE.Vector3(x, y, -D); });
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const sun = new THREE.DirectionalLight(0xffffff, 0.55); sun.position.set(-0.5, -1, 2); scene.add(sun);
    const accent = new THREE.Color(shield.color || '#e3a21a');
    const lineCol = new THREE.Color(shield.lineColor || '#8fa3b0');
    const lineDark = lineCol.clone().multiplyScalar(0.55);

    // Весь будущий тоннель — полупрозрачная труба в цвете линии
    scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 500, R, 16, false), mat(lineCol, 0.38)));
    // Срез грунта: вертикальная полупрозрачная «стенка» от поверхности до тоннеля
    const wall = [], N = 240;
    for (let i = 0; i < N; i++) {
      const a = curve.getPointAt(i / N), b = curve.getPointAt((i + 1) / N), z0 = -D - 25;
      wall.push(a.x, a.y, 0, a.x, a.y, z0, b.x, b.y, 0, a.x, a.y, z0, b.x, b.y, z0, b.x, b.y, 0);
    }
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wall, 3));
    scene.add(new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ color: 0x9fb1bd, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false })));

    // Станционные комплексы: зал на глубине, наклонный эскалаторный ход, наземный вестибюль
    const Z = new THREE.Vector3(0, 0, 1);
    const UPY = new THREE.Vector3(0, 1, 0);
    const M = {
      esc: mat(0xf4efe6, 0.5), lane: mat(0x6f6760, 1), cham: mat(0xe6dfd2, 0.95),
      shaft: mat(0xb9c3c8, 0.6), gal: mat(0xa9b4ba, 0.95), kiosk: mat(0x7d878c, 1), grille: mat(0x3d4549, 1), vest: mat(lineCol, 0.95)
    };
    // Цилиндр между двумя точками (тоннели из тюбингов круглые)
    function rod(a, b, r, m, seg = 20) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, a.distanceTo(b), seg), m);
      c.position.copy(a).add(b).multiplyScalar(0.5);
      c.quaternion.setFromUnitVectors(UPY, b.clone().sub(a).normalize()); scene.add(c); return c;
    }
    // Камера/выработка-коробка, повёрнутая по направлению (dx, dy)
    function box(cx, cy, cz, len, w, h, dx, dy, m) {
      const g = new THREE.Mesh(new THREE.BoxGeometry(len, w, h), m);
      g.position.set(cx, cy, cz); g.rotation.z = Math.atan2(dy, dx); scene.add(g); return g;
    }
    // Эскалаторный комплекс глубокой станции: переход из торца зала → нижняя натяжная камера →
    // наклонный ход под 30° с тремя эскалаторами → верхняя камера (машинный зал) → наземный вестибюль
    function escalatorComplex(base, vx, vy) {
      const d = new THREE.Vector2(vx - base.x, vy - base.y), dist = d.length(); d.normalize();
      const zb = base.z, zt = -6;
      const real = shield.depth / Math.tan(ESC_ANGLE * Math.PI / 180); // горизонтальный вынос хода при реальной глубине
      const run = Math.max(30, Math.min(real, dist - 20));
      const T = new THREE.Vector3(vx - d.x * 14, vy - d.y * 14, zt);       // верхняя камера под вестибюлем
      const B = new THREE.Vector3(T.x - d.x * run, T.y - d.y * run, zb);    // низ наклона, на уровне зала
      // переход от торца зала к нижней камере (может идти назад, если вестибюль рядом со станцией)
      const pa = new THREE.Vector3(base.x, base.y, zb), pl = Math.hypot(B.x - pa.x, B.y - pa.y);
      if (pl > 2) box((pa.x + B.x) / 2, (pa.y + B.y) / 2, zb, pl + 8, 12, 10, B.x - pa.x, B.y - pa.y, M.cham);
      box(B.x, B.y, zb + 1, 20, 18, 14, d.x, d.y, M.cham);                  // нижняя натяжная камера
      box(T.x, T.y, zt, 22, 18, 12, d.x, d.y, M.cham);                      // верхняя камера, машинное помещение
      const a = B.clone().add(new THREE.Vector3(d.x * 8, d.y * 8, 3)), b = T.clone().add(new THREE.Vector3(-d.x * 9, -d.y * 9, -2));
      rod(a, b, 6.5, M.esc, 24);                                             // наклонный ход Ø ≈ 10 м
      const side = new THREE.Vector3(-d.y, d.x, 0);
      [-3, 0, 3].forEach(k => { const o = side.clone().multiplyScalar(k).add(new THREE.Vector3(0, 0, -2.2)); rod(a.clone().add(o), b.clone().add(o), 0.7, M.lane, 6); });
      box(vx, vy, 4.5, 42, 26, 9, d.x, d.y, M.vest);                        // наземный вестибюль
    }
    // Вентиляционная шахта: ствол из тюбингов → вентиляционная камера внизу → сбойка к перегонным тоннелям,
    // наверху оголовок и вентиляционный киоск с решётками
    function shaftComplex(p, top, off) {
      const z0 = p.z, u = off.clone().normalize();
      rod(new THREE.Vector3(top.x, top.y, z0 + 4), new THREE.Vector3(top.x, top.y, 0.5), 4.5, M.shaft, 20);
      box(top.x, top.y, z0, 18, 16, 14, u.x, u.y, M.cham);                   // вентиляционная камера
      const far = new THREE.Vector3(p.x - u.x * 22, p.y - u.y * 22, z0);      // сбойка проходит через тоннель к соседнему
      box((top.x + far.x) / 2, (top.y + far.y) / 2, z0, Math.hypot(top.x - far.x, top.y - far.y), 6.5, 7.5, u.x, u.y, M.gal);
      rod(new THREE.Vector3(top.x, top.y, -1), new THREE.Vector3(top.x, top.y, 1.5), 6, M.kiosk, 20); // оголовок
      box(top.x, top.y, 4, 16, 10, 5, u.x, u.y, M.kiosk);                    // киоск
      box(top.x, top.y, 6.6, 14, 8, 0.4, u.x, u.y, M.grille);                // решётка
    }
    shield.stations.forEach(s => {
      const t1 = Math.max(0, tOfRing(s.from)), t2 = Math.min(1, tOfRing(s.to));
      if (t2 <= t1) return;
      const sub = new THREE.CatmullRomCurve3(Array.from({ length: 10 }, (_, i) => curve.getPointAt(t1 + (t2 - t1) * i / 9)));
      scene.add(new THREE.Mesh(new THREE.TubeGeometry(sub, 24, R * 2.2, 8, false), s.pilot ? mat(accent, 0.45) : mat(0xffffff, 0.92)));
      const mid = curve.getPointAt((t1 + t2) / 2);
      let labelAt = [mid.x, mid.y];
      if (s.vestibule && s.vestibule.lnglat) {
        // Вестибюль по реальному адресу: эскалаторный комплекс от ближнего торца станции к нему
        const [vx, vy] = toLocal(s.vestibule.lnglat);
        const e1 = curve.getPointAt(t1), e2 = curve.getPointAt(t2);
        const base = Math.hypot(e1.x - vx, e1.y - vy) < Math.hypot(e2.x - vx, e2.y - vy) ? e1 : e2;
        escalatorComplex(base, vx, vy);
        labelAt = [vx, vy];
      } else if (s.escalator) {
        // Адреса нет: наклонный ход продолжает ось станции за её торцом
        const atEnd = s.escalator === 'to';
        const tEnd = atEnd ? t2 : t1;
        const base = curve.getPointAt(tEnd);
        const dir = curve.getTangentAt(tEnd).setZ(0).normalize().multiplyScalar(atEnd ? 1 : -1);
        const run = shield.depth / Math.tan(ESC_ANGLE * Math.PI / 180) + 40;
        const vx = base.x + dir.x * run, vy = base.y + dir.y * run;
        escalatorComplex(base, vx, vy);
        labelAt = [vx, vy];
      }
      const ll = toLngLat(labelAt[0], labelAt[1]);
      markers.push(label(s.name + (s.pilot ? ' <small>пилотный тоннель</small>' : ''), ll, 'new', { type: 'vest', s }));
      if (EDIT) markers.push(label('◆ зал «' + s.name + '»', toLngLat(mid.x, mid.y), 'hall', { type: 'hall', s }));
      ugLabels.push({ html: s.name, pos: new THREE.Vector3(labelAt[0], labelAt[1], 22), cls: 'new' });
    });

    // Вентиляционные шахты: ствол от тоннеля до поверхности и киоск наверху
    (shield.shafts || []).forEach((v, i) => {
      let p, top;
      if (v.lnglat) {
        // Шахта по адресу: ствол там, где площадка, и горизонтальная сбойка к ближайшей точке тоннеля
        const [sx, sy] = toLocal(v.lnglat);
        let best = 1e9, bt = 0;
        for (let k = 0; k <= 400; k++) { const q = curve.getPointAt(k / 400), dd = (q.x - sx) ** 2 + (q.y - sy) ** 2; if (dd < best) { best = dd; bt = k / 400; } }
        if (Math.sqrt(best) > 400) return; // площадка далеко от этого участка
        p = curve.getPointAt(bt); top = new THREE.Vector3(sx, sy, 0);
      } else {
        const t = Math.min(1, Math.max(0, tOfRing(v.ring)));
        p = curve.getPointAt(t); const tan = curve.getTangentAt(t).setZ(0).normalize();
        const o = new THREE.Vector3(-tan.y, tan.x, 0).multiplyScalar(R * 3.2);
        top = new THREE.Vector3(p.x + o.x, p.y + o.y, 0);
      }
      const off = new THREE.Vector3(top.x - p.x, top.y - p.y, 0);
      if (off.length() < 1) off.set(R * 3, 0, 0), top.set(p.x + off.x, p.y + off.y, 0);
      shaftComplex(p, top, off);
      const name = v.name || 'Вентшахта';
      markers.push(label(name + (v.note ? ' <small>' + v.note + '</small>' : ''), toLngLat(top.x, top.y), 'vs', { type: 'shaft', v }));
      ugLabels.push({ html: name, pos: new THREE.Vector3(top.x, top.y, 12), cls: 'vs' });
    });
    (shield.existing || DATA.existing || []).forEach(e => {
      markers.push(label(`${e.name} <small>${e.line}</small>`, e.lnglat, 'ex'));
      const [x, y] = toLocal(e.lnglat); ugLabels.push({ html: `${e.name} <small>${e.line}</small>`, pos: new THREE.Vector3(x, y, 8), cls: 'ex' });
    });

    // Остальные щиты — тоже на сцене, чтобы видеть, например, «Любовь» и «Веру» вместе
    const others = [];
    DATA.shields.filter(o => o !== shield).forEach(o => {
      const opts = o.path.map(ll => { const [x, y] = toLocal(ll); return new THREE.Vector3(x, y, -o.depth * VEX); });
      if (Math.hypot(opts[0].x, opts[0].y) > 30000) return; // далеко, не на этом экране
      const oc = new THREE.CatmullRomCurve3(opts, false, 'centripetal');
      const ocol = new THREE.Color(o.lineColor || '#8fa3b0'), oacc = new THREE.Color(o.color || '#e3a21a');
      scene.add(new THREE.Mesh(new THREE.TubeGeometry(oc, 300, R, 12, false), mat(ocol, 0.3)));
      const ot = Math.min(1, Math.max(0, tOfRing(o.ring, o)));
      if (ot > 0.002) {
        const dp = Array.from({ length: 60 }, (_, i) => oc.getPointAt(ot * i / 59));
        scene.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(dp), 120, R * 1.03, 12, false), mat(ocol.clone().multiplyScalar(0.55), 1)));
      }
      const op = oc.getPointAt(ot), og = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.3, R * 1.3, 26, 20), new THREE.MeshLambertMaterial({ color: oacc, emissive: oacc, emissiveIntensity: 0.4 }));
      og.position.copy(op); og.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), oc.getTangentAt(ot)); scene.add(og);
      const ob = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, o.depth * VEX, 6), new THREE.MeshBasicMaterial({ color: oacc, transparent: true, opacity: 0.6 }));
      ob.rotation.x = Math.PI / 2; ob.position.set(op.x, op.y, -o.depth * VEX / 2); scene.add(ob);
      const txt = '«' + o.name + '» · <span class="mono">' + (o.ring >= o.total ? 'финиш' : (o.unit === 'm' ? fmt(o.ring) + ' м' : 'кольцо ' + fmt(o.ring))) + '</span>';
      const mk = label(txt, toLngLat(op.x, op.y), 'sh other');
      mk.getElement().style.setProperty('--oc', o.color || '#e3a21a');
      mk.getElement().title = 'Переключиться на «' + o.name + '»';
      mk.getElement().onclick = () => pick(o.id);
      markers.push(mk);
      ugLabels.push({ html: txt, pos: new THREE.Vector3(op.x, op.y, 30), cls: 'sh other', color: o.color });
      const line = Array.from({ length: 150 }, (_, i) => { const q = oc.getPointAt(i / 149), ll = toLngLat(q.x, q.y); return [ll.lng, ll.lat]; });
      const n = Math.max(2, Math.round(ot * 149));
      others.push({ type: 'Feature', properties: { k: 'all', c: o.lineColor || '#39474f' }, geometry: { type: 'LineString', coordinates: line } },
        { type: 'Feature', properties: { k: 'done', c: o.lineColor || '#39474f' }, geometry: { type: 'LineString', coordinates: line.slice(0, n) } });
    });

    // Пройденная часть и щит
    const doneMat = mat(lineDark, 1);
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
    const shUg = { html: '', pos: new THREE.Vector3(), cls: 'sh' }; ugLabels.push(shUg);

    // Поверхность для режима «под землёй»: заполняется из тайлов карты при открытии
    ugGroup = new THREE.Group(); ugGroup.visible = false; scene.add(ugGroup);

    const Y = new THREE.Vector3(0, 1, 0);
    layer = {
      id: 'tunnel', type: 'custom', renderingMode: '3d',
      curve, D, shUg,
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
        shUg.pos.set(p.x, p.y, 30);
        this.shieldLL = ll; this.shieldP = p.clone();
        map.triggerRepaint();
      },
      onAdd(m, gl) {
        this.camera = new THREE.Camera();
        this.renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
        this.renderer.autoClear = false;
      },
      render(gl, matrix) {
        if (UG.open) return;
        const l = new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z).scale(new THREE.Vector3(S, S, S));
        this.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(l);
        ugGroup.visible = false;
        this.renderer.resetState();
        this.renderer.render(scene, this.camera);
      },
      shLabel
    };
    map.addLayer(layer, map.getLayer('building-3d') ? 'building-3d' : undefined);

    // Трасса на поверхности: пунктир будущего хода, сплошная линия пройденного, соседние участки линии
    const line = Array.from({ length: 200 }, (_, i) => { const p = curve.getPointAt(i / 199); const ll = toLngLat(p.x, p.y); return [ll.lng, ll.lat]; });
    layer.line = line;
    const ctx = { type: 'FeatureCollection', features: (shield.context || []).map(c => ({ type: 'Feature', properties: { k: c.kind }, geometry: { type: 'LineString', coordinates: c.pts } })) };
    const lc = shield.lineColor || '#39474f';
    const oth = { type: 'FeatureCollection', features: others };
    if (!map.getSource('others')) {
      map.addSource('others', { type: 'geojson', data: oth });
      map.addLayer({ id: 'oth-all', type: 'line', source: 'others', filter: ['==', 'k', 'all'], paint: { 'line-color': ['get', 'c'], 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.5 } }, 'tunnel');
      map.addLayer({ id: 'oth-done', type: 'line', source: 'others', filter: ['==', 'k', 'done'], paint: { 'line-color': ['get', 'c'], 'line-width': 4, 'line-opacity': 0.7 } }, 'tunnel');
    } else map.getSource('others').setData(oth);
    if (!map.getSource('route')) {
      map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('context', { type: 'geojson', data: ctx });
      map.addLayer({ id: 'ctx-con', type: 'line', source: 'context', filter: ['==', 'k', 'construction'], paint: { 'line-color': lc, 'line-width': 3, 'line-opacity': 0.55, 'line-dasharray': [3, 1.5] } }, 'tunnel');
      map.addLayer({ id: 'ctx-pro', type: 'line', source: 'context', filter: ['==', 'k', 'proposed'], paint: { 'line-color': lc, 'line-width': 2, 'line-opacity': 0.4, 'line-dasharray': [1, 2] } }, 'tunnel');
      map.addLayer({ id: 'route-all', type: 'line', source: 'route', filter: ['==', 'k', 'all'], paint: { 'line-color': lc, 'line-width': 3, 'line-dasharray': [2, 2], 'line-opacity': 0.75 } }, 'tunnel');
      map.addLayer({ id: 'route-done', type: 'line', source: 'route', filter: ['==', 'k', 'done'], paint: { 'line-color': lc, 'line-width': 5 } }, 'tunnel');
    } else {
      map.getSource('context').setData(ctx);
      ['ctx-con', 'ctx-pro', 'route-all', 'route-done'].forEach(id => map.setPaintProperty(id, 'line-color', lc));
    }
  }

  function label(html, ll, cls, ref) {
    const el = document.createElement('div'); el.className = 'lbl ' + cls; el.innerHTML = html;
    const mk = new maplibregl.Marker({ element: el, anchor: cls === 'hall' ? 'top' : 'bottom', offset: [0, cls === 'hall' ? 6 : -6], draggable: !!(EDIT && ref) }).setLngLat(ll).addTo(map);
    if (EDIT && ref) { el.classList.add('drag'); mk.on('dragend', () => { const ll = mk.getLngLat(); setTimeout(() => onDrag(ref, ll), 0); }); }
    return mk;
  }

  // --- Режим правки (?edit): перетаскивание станций, вестибюлей и шахт, ввод кольца ---
  function ringOfT(t) {
    const k = shield.ringKnots;
    for (let i = 0; i < k.length - 1; i++) if (t <= k[i + 1][1]) { const a = k[i], b = k[i + 1]; return a[0] + (b[0] - a[0]) * (t - a[1]) / (b[1] - a[1]); }
    return k[k.length - 1][0];
  }
  function onDrag(ref, ll) {
    const p = [+ll.lng.toFixed(6), +ll.lat.toFixed(6)];
    if (ref.type === 'shaft') { ref.v.lnglat = p; delete ref.v.ring; }
    else if (ref.type === 'vest') { ref.s.vestibule = Object.assign({}, ref.s.vestibule, { lnglat: p, moved: true }); }
    else if (ref.type === 'hall') {
      const [x, y] = toLocal(p); let best = 1e18, bt = 0;
      for (let k = 0; k <= 1000; k++) { const q = layer.curve.getPointAt(k / 1000), d = (q.x - x) ** 2 + (q.y - y) ** 2; if (d < best) { best = d; bt = k / 1000; } }
      const len = ref.s.to - ref.s.from, c = Math.round(ringOfT(bt));
      ref.s.from = Math.round(c - len / 2); ref.s.to = ref.s.from + len;
    }
    dirty();
    buildScene(); setRing($('ring').value);
  }
  function dirty() { const b = $('e-save'); if (b) { b.textContent = 'Скачать shields.json •'; } }
  function setupEdit() {
    if (!EDIT) return;
    const box = document.createElement('section'); box.className = 'card editbox';
    box.innerHTML = `<div class="row"><div class="eyebrow">Режим правки</div><button id="e-min" title="Свернуть">—</button></div><div class="ebody">
      <div class="small muted">Перетаскивайте подписи: вестибюли, шахты, ◆ залы станций (зал двигается вдоль трассы).</div>
      <label class="small">Кольцо (или метры) <input id="e-ring" type="number" min="0" step="1"></label>
      <label class="small">Дата <input id="e-date" type="date"></label>
      <button id="e-apply">Применить</button>
      <div class="btns"><button id="e-save" class="primary">Скачать shields.json</button><button id="e-copy">Копировать</button>
      <a id="e-gh" class="btnlink" href="https://github.com/rommmades/metro-shields/edit/main/data/shields.json" target="_blank" rel="noopener">Открыть файл на GitHub</a></div>
      <div class="small muted">Чтобы сохранить: «Копировать», затем на GitHub выделите весь текст файла, вставьте и нажмите Commit changes.</div></div>`;
    document.body.appendChild(box);
    $('e-min').onclick = () => { box.classList.toggle('min'); $('e-min').textContent = box.classList.contains('min') ? '+' : '—'; };
    const fill = () => { $('e-ring').value = shield.ring; $('e-date').value = DATA.updated; };
    fill(); $('p-pick').addEventListener('change', fill);
    $('e-apply').onclick = () => {
      const r = +$('e-ring').value, d = $('e-date').value || new Date().toISOString().slice(0, 10);
      shield.ring = r; DATA.updated = d; shield.history = shield.history || [];
      const last = shield.history[shield.history.length - 1];
      if (last && last.date === d) last.ring = r; else shield.history.push({ date: d, ring: r });
      $('ring').value = r; setRing(r); pickTexts(); dirty();
    };
    const json = () => JSON.stringify(DATA, null, 1);
    $('e-save').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json()], { type: 'application/json' })); a.download = 'shields.json'; a.click(); };
    $('e-copy').onclick = () => navigator.clipboard.writeText(json()).then(() => { $('e-copy').textContent = 'Скопировано'; setTimeout(() => $('e-copy').textContent = 'Копировать', 1500); });
  }
  function pickTexts() { $('p-note').textContent = [shield.note, 'Обновлено ' + new Date(DATA.updated).toLocaleDateString('ru-RU')].filter(Boolean).join('. ') + '.'; }

  function tOfRing(r, sh = shield) {
    const k = sh.ringKnots;
    for (let i = 0; i < k.length - 1; i++) if (r <= k[i + 1][0]) { const a = k[i], b = k[i + 1]; return a[1] + (b[1] - a[1]) * (r - a[0]) / (b[0] - a[0]); }
    return k[k.length - 1][1];
  }

  function setRing(r) {
    r = +r;
    const t = Math.min(1, Math.max(0, tOfRing(r)));
    layer.setT(t);
    const html = '«' + shield.name + '» · <span class="mono">' + (r >= shield.total ? 'финиш' : unitTxt(r)) + '</span>';
    layer.shLabel.getElement().innerHTML = html; layer.shUg.html = html;
    const n = Math.max(2, Math.round(t * 199));
    map.getSource('route').setData({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { k: 'all' }, geometry: { type: 'LineString', coordinates: layer.line } },
      { type: 'Feature', properties: { k: 'done' }, geometry: { type: 'LineString', coordinates: layer.line.slice(0, n) } }] });
    $('p-ring').textContent = fmt(r);
    $('p-bar').style.width = Math.min(100, r / shield.total * 100) + '%';
    $('ring-out').textContent = unitTxt(r);
    const st = shield.stations.filter(s => s.to > 0);
    const inside = st.find(s => r >= s.from && r <= s.to);
    const next = st.find(s => s.from > r);
    const u = shield.unit === 'm' ? ' м' : ' колец';
    let txt;
    if (r >= shield.total) txt = 'Проходка участка завершена';
    else if (inside) txt = 'Щит проходит «' + inside.name + '»';
    else if (next && next.from < shield.total) txt = 'До «' + next.name + '» ' + fmt(next.from - r) + u;
    else txt = 'До финиша ' + fmt(shield.total - r) + u;
    $('p-next').textContent = txt;
    UG.dirty = true;
  }

  function unitTxt(r) { return shield.unit === 'm' ? fmt(r) + ' м' : 'кольцо ' + fmt(r); }

  function overview(animate = true) {
    const b = new maplibregl.LngLatBounds();
    shield.path.forEach(p => b.extend(p));
    const small = innerWidth < 640;
    const cam = map.cameraForBounds(b, { padding: small ? { top: 170, bottom: 150, left: 20, right: 20 } : { top: 60, bottom: 140, left: 380, right: EDIT ? 330 : 60 }, bearing: -20 });
    const o = { center: cam.center, zoom: cam.zoom + (small ? 0.2 : EDIT ? 0 : 0.8), bearing: -20, pitch: 55 };
    animate ? map.easeTo({ ...o, duration: 1200 }) : map.jumpTo(o);
  }
  function follow() { map.easeTo({ center: layer.shieldLL, zoom: 15.8, pitch: 65, duration: 1200 }); }

  // --- Режим «под землёй»: своя камера, которую можно опустить ниже поверхности ---
  const UG = {
    open: false, dirty: true, renderer: null, camera: null, controls: null, raf: 0,
    init() {
      const box = $('under');
      this.renderer = new THREE.WebGLRenderer({ antialias: true });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      this.renderer.setClearColor(0x2a2723, 1);
      box.insertBefore(this.renderer.domElement, box.firstChild);
      this.camera = new THREE.PerspectiveCamera(45, 1, 2, 30000);
      this.camera.up.set(0, 0, 1);
      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true; this.controls.minPolarAngle = 0.05; this.controls.maxPolarAngle = Math.PI - 0.05; this.controls.minDistance = 30; this.controls.maxDistance = 8000;
      this.controls.addEventListener('change', () => this.dirty = true);
      addEventListener('resize', () => this.resize());
    },
    resize() {
      const w = innerWidth, h = innerHeight;
      this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.dirty = true;
    },
    // Поверхность: полупрозрачная «земля», дома и дороги из уже загруженных тайлов карты
    rebuildSurface() {
      while (ugGroup.children.length) { const c = ugGroup.children.pop(); c.geometry && c.geometry.dispose(); }
      const c = layer.curve, D = layer.D;
      const bb = new THREE.Box3().setFromPoints(c.getSpacedPoints(100)); bb.expandByScalar(700);
      const size = bb.getSize(new THREE.Vector3()), ctr = bb.getCenter(new THREE.Vector3());
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(size.x, size.y), new THREE.MeshBasicMaterial({ color: 0xf1ede4, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
      ground.position.set(ctr.x, ctr.y, 0); ugGroup.add(ground);
      // слой грунта снизу, чтобы было ощущение «под землёй»
      const grid = new THREE.GridHelper(Math.max(size.x, size.y), 40, 0x6b6153, 0x4a443b);
      grid.rotation.x = Math.PI / 2; grid.position.set(ctr.x, ctr.y, -D - 30); grid.material.transparent = true; grid.material.opacity = 0.35; ugGroup.add(grid);
      const near = (x, y) => x > bb.min.x && x < bb.max.x && y > bb.min.y && y < bb.max.y;
      let feats = [];
      try { feats = map.querySourceFeatures('openmaptiles', { sourceLayer: 'building' }); } catch (e) { feats = []; }
      const geos = [], seen = new Set();
      for (const f of feats) {
        const g = f.geometry, h = +(f.properties.render_height || f.properties.height || 12);
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
        for (const poly of polys) {
          const ring = poly[0]; if (!ring || ring.length < 4) continue;
          const key = ring[0].join() + ring.length; if (seen.has(key)) continue; seen.add(key);
          const loc = ring.map(toLocal); if (!near(loc[0][0], loc[0][1])) continue;
          const shp = new THREE.Shape(loc.map(p => new THREE.Vector2(p[0], p[1])));
          geos.push(new THREE.ExtrudeGeometry(shp, { depth: Math.max(3, h), bevelEnabled: false }));
          if (geos.length > 6000) break;
        }
      }
      if (geos.length) {
        const merged = mergeGeos(geos);
        ugGroup.add(new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color: 0xd9d3c7, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide })));
      }
      let roads = [];
      try { roads = map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation' }); } catch (e) { roads = []; }
      const seg = [];
      for (const f of roads) {
        const g = f.geometry; const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
        for (const ln of lines) {
          const loc = ln.map(toLocal);
          for (let i = 0; i < loc.length - 1; i++) if (near(loc[i][0], loc[i][1])) seg.push(loc[i][0], loc[i][1], 0.5, loc[i + 1][0], loc[i + 1][1], 0.5);
        }
      }
      if (seg.length) {
        const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
        ugGroup.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x9aa4a9, transparent: true, opacity: 0.6 })));
      }
      // трасса на поверхности
      const rl = new THREE.BufferGeometry().setFromPoints(c.getSpacedPoints(200).map(p => new THREE.Vector3(p.x, p.y, 0.8)));
      ugGroup.add(new THREE.Line(rl, new THREE.LineDashedMaterial({ color: new THREE.Color(shield.lineColor || '#39474f'), dashSize: 12, gapSize: 8 })));
      ugGroup.children[ugGroup.children.length - 1].computeLineDistances();
      // подписи
      const lb = $('under-labels'); lb.innerHTML = '';
      this.labels = ugLabels.map(L => { const d = document.createElement('div'); d.className = 'lbl ' + L.cls; lb.appendChild(d); return { L, d }; });
      this.dirty = true;
    },
    look() {
      // Камера ниже поверхности, сбоку от щита, смотрит на щит снизу вверх
      const p = layer.shieldP || layer.curve.getPointAt(0.5);
      const tan = layer.curve.getTangentAt(0.5).setZ(0).normalize();
      const side = new THREE.Vector3(-tan.y, tan.x, 0);
      // y в сцене смотрит на юг; для подземной камеры сцена отражается (y → −y), чтобы не было зеркала
      this.camera.position.set(p.x + side.x * 520 - tan.x * 260, -(p.y + side.y * 520 - tan.y * 260), p.z - 170);
      this.controls.target.set(p.x, -p.y, p.z * 0.6);
      this.controls.update(); this.dirty = true;
    },
    loop() {
      this.raf = requestAnimationFrame(() => this.loop());
      this.controls.update();
      if (!this.dirty) return;
      this.dirty = false;
      ugGroup.visible = true;
      scene.scale.set(1, -1, 1); scene.updateMatrixWorld(true);
      this.renderer.render(scene, this.camera);
      scene.scale.set(1, 1, 1); scene.updateMatrixWorld(true);
      const w = innerWidth, h = innerHeight, v = new THREE.Vector3();
      for (const { L, d } of this.labels) {
        v.copy(L.pos); v.y = -v.y; v.project(this.camera);
        const show = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
        d.style.display = show ? '' : 'none';
        if (show) { d.innerHTML = L.html; if (L.color) d.style.setProperty('--oc', L.color); d.style.transform = `translate(${(v.x + 1) / 2 * w}px, ${(1 - v.y) / 2 * h}px) translate(-50%, -100%)`; }
      }
    }
  };
  if (qs.has('debug')) window.__dbg = { UG, toLocal: ll => toLocal(ll) };
  function openUnder() {
    if (!UG.renderer) UG.init();
    UG.open = true; $('under').hidden = false; document.body.classList.add('ug');
    $('b-under').textContent = 'На карту';
    UG.resize(); UG.rebuildSurface(); UG.look(); UG.loop();
  }
  function closeUnder() {
    UG.open = false; $('under').hidden = true; document.body.classList.remove('ug');
    $('b-under').textContent = 'Под землю';
    cancelAnimationFrame(UG.raf); map.triggerRepaint();
  }

  // Минимальное слияние геометрий (без BufferGeometryUtils)
  function mergeGeos(geos) {
    let total = 0; const list = geos.map(g => (g.index ? g.toNonIndexed() : g)); list.forEach(g => total += g.attributes.position.count);
    const pos = new Float32Array(total * 3); let o = 0;
    list.forEach(g => { pos.set(g.attributes.position.array, o); o += g.attributes.position.array.length; g.dispose(); });
    const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.computeVertexNormals(); return out;
  }

  $('ring').addEventListener('input', e => setRing(e.target.value));
  $('b-now').onclick = () => { $('ring').value = shield.ring; setRing(shield.ring); UG.open ? UG.look() : follow(); };
  $('b-follow').onclick = () => UG.open ? UG.look() : follow();
  $('b-all').onclick = () => { if (UG.open) closeUnder(); overview(true); };
  $('b-under').onclick = () => UG.open ? closeUnder() : openUnder();
  $('b-back').onclick = closeUnder;

  // --- Ракурсы и чистый кадр для скриншотов ---
  // Ссылка вида #cam=lng,lat,zoom,bearing,pitch открывает карту ровно в этом ракурсе
  function applyCam() {
    const m = location.hash.match(/cam=([-\d.,]+)/); if (!m) return;
    const [lng, lat, zoom, bearing, pitch] = m[1].split(',').map(Number);
    if (isFinite(lng) && isFinite(lat)) map.jumpTo({ center: [lng, lat], zoom, bearing, pitch });
  }
  $('b-link').onclick = () => {
    const c = map.getCenter(), f = n => +n.toFixed(5);
    const u = new URL(location.href); u.searchParams.delete('edit'); u.searchParams.set('shield', shield.id);
    u.hash = 'cam=' + [f(c.lng), f(c.lat), f(map.getZoom()), +map.getBearing().toFixed(1), +map.getPitch().toFixed(1)].join(',');
    history.replaceState(null, '', u.pathname + u.search + u.hash);
    navigator.clipboard.writeText(u.href).then(() => { $('b-link').textContent = 'Скопировано'; setTimeout(() => $('b-link').textContent = 'Ссылка на ракурс', 1500); });
  };
  let tipT = 0;
  function setClean(on) {
    document.body.classList.toggle('clean', on);
    if (on) { $('clean-tip').classList.add('show'); clearTimeout(tipT); tipT = setTimeout(() => $('clean-tip').classList.remove('show'), 2500); }
    map.resize(); if (UG.open) UG.dirty = true;
  }
  $('b-shot').onclick = () => setClean(true);
  addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('clean')) setClean(false); });
})();
