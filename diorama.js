// Просмотр диорамы в браузере: модель renders/<имя>.glb из Blender, вращение мышью, сохранение кадра в PNG.
(function () {
  'use strict';
  const qs = new URLSearchParams(location.search), NAME = qs.get('name') || 'borovaya';
  const $ = id => document.getElementById(id);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputEncoding = THREE.sRGBEncoding; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0xc9cdcf);
  document.body.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 5, 20000);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.62; controls.minDistance = 60; controls.maxDistance = 4000;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f86, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-400, 700, 300); sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096); Object.assign(sun.shadow.camera, { left: -600, right: 600, top: 600, bottom: -600, near: 10, far: 2500 }); sun.shadow.bias = -0.0005;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xfff4e8, 0.55); fill.position.set(300, -150, 500); scene.add(fill);   // подсветка разреза снизу-спереди

  let info = { labels: [] }, home = null, cutN = null, cutP = null; const hallBox = new THREE.Box3();
  const toY = p => new THREE.Vector3(p[0], p[2], -p[1]);   // Blender (Z вверх) → glTF (Y вверх)
  fetch(`renders/${NAME}-scene.json`, { cache: 'no-cache' }).then(r => r.json()).then(j => { info = j; buildLabels(); }).catch(() => {});
  new THREE.GLTFLoader().load(`renders/${NAME}.glb?t=${Date.now()}`, g => {
    g.scene.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      const m = o.material;
      const n = (m && m.name) || '';
      if (/-cut$|^glass/.test(n) || (m && m.transparent && m.opacity < 0.02)) {   // открытая грань разреза
        o.visible = false;
        const nr = o.geometry.attributes.normal;
        if (nr && !cutN) for (let i = 0; i < nr.count; i++) if (Math.abs(nr.getY(i)) < 0.5) { cutN = new THREE.Vector3(nr.getX(i), 0, nr.getZ(i)).normalize(); cutP = new THREE.Vector3().fromBufferAttribute(o.geometry.attributes.position, i); break; }
        return;
      }
      if (/^hall/.test(o.name)) hallBox.expandByObject(o);
      const alpha = { future: 0.7, beam: 0.4, canopy: 0.5 }[n.replace(/\.\d+$/, '')];
      if (alpha) { m.transparent = true; m.opacity = alpha; m.depthWrite = false; }
      if (/^sh-/.test(n)) { m.emissive = m.color.clone(); m.emissiveIntensity = 0.8; }
      if (m) m.side = THREE.DoubleSide;
      if (m && /beam/.test(m.name)) { o.castShadow = false; }
    });
    scene.add(g.scene); 
    const box = new THREE.Box3().setFromObject(g.scene), c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    // исходный ракурс: со стороны открытого разреза, сверху под углом, чуть сбоку
    const cen = hallBox.isEmpty() ? c : hallBox.getCenter(new THREE.Vector3()).setY(c.y * 0.5 + hallBox.getCenter(new THREE.Vector3()).y * 0.5);
    const n = cutN || new THREE.Vector3(0, 0, 1);
    if (cutP && cutP.clone().sub(c).dot(n) < 0) n.negate();   // нормаль грани может смотреть внутрь блока
    const ax = new THREE.Vector3(n.z, 0, -n.x);
    const r = Math.max(size.x, size.z) * 1.1;
    const pos = cen.clone().add(n.clone().multiplyScalar(r * 0.85)).add(ax.multiplyScalar(r * 0.3)).add(new THREE.Vector3(0, r * 0.4, 0));
    home = { pos, target: cen };
    reset();
  });
  function reset() { if (!home) return; camera.position.copy(home.pos); controls.target.copy(home.target); controls.update(); }

  // --- подписи ---
  let showLbl = true; const LB = [];
  function buildLabels() {
    const box = $('labels'); box.innerHTML = '';
    for (const L of info.labels || []) {
      const t = L.kind === 'hall' ? 'Станция ' + L.text : L.text, sub = L.kind === 'hall' ? 'глубина ≈ ' + (L.sub || '').replace('−', '') : L.kind === 'station' ? 'вестибюль' : L.kind === 'shield' ? L.sub : '';
      const el = document.createElement('div'); el.className = 'lbl'; el.innerHTML = t + (sub ? `<small>${sub}</small>` : '');
      if (L.color) el.style.borderColor = L.color, el.style.borderWidth = '2px';
      box.appendChild(el); LB.push({ el, p: toY(L.top || L.pos), t, sub, color: L.color });
    }
  }
  function place() {
    const w = innerWidth, h = innerHeight, v = new THREE.Vector3();
    for (const L of LB) {
      v.copy(L.p).project(camera); const vis = showLbl && v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1;
      L.el.style.display = vis ? '' : 'none'; if (!vis) continue;
      L.x = (v.x + 1) / 2 * w; L.y = (1 - v.y) / 2 * h - 14;
      L.el.style.transform = `translate(${L.x}px, ${L.y}px) translate(-50%, -100%)`;
    }
  }
  function resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
  addEventListener('resize', resize); resize();
  (function loop() { requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); place(); })();

  // --- кадр в PNG: рендер + подписи + источник ---
  $('b-png').onclick = () => {
    renderer.render(scene, camera);
    const src = renderer.domElement, out = document.createElement('canvas'); out.width = src.width; out.height = src.height;
    const ctx = out.getContext('2d'), k = src.width / innerWidth; ctx.drawImage(src, 0, 0); ctx.scale(k, k);
    if (showLbl) for (const L of LB) {
      if (L.el.style.display === 'none') continue;
      ctx.font = '600 14px "Golos Text", sans-serif'; const w1 = ctx.measureText(L.t).width;
      ctx.font = '400 12px "Golos Text", sans-serif'; const w2 = L.sub ? ctx.measureText(L.sub).width : 0;
      const bw = Math.max(w1, w2) + 20, bh = L.sub ? 42 : 26, x = L.x - bw / 2, y = L.y - bh;
      ctx.strokeStyle = '#1f2a2e'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(L.x, L.y); ctx.lineTo(L.x, L.y + 12); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.strokeStyle = L.color || '#1f2a2e'; ctx.lineWidth = L.color ? 2 : 1;
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, bw, bh, 8) : ctx.rect(x, y, bw, bh); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#1f2a2e'; ctx.font = '600 14px "Golos Text", sans-serif'; ctx.fillText(L.t, x + 10, y + 18);
      if (L.sub) { ctx.fillStyle = '#5b6a70'; ctx.font = '400 12px "Golos Text", sans-serif'; ctx.fillText(L.sub, x + 10, y + 34); }
    }
    ctx.fillStyle = '#4b585c'; ctx.font = '400 12px "Golos Text", sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('t.me/podzemnik_spb · дома и улицы © OpenStreetMap · глубина и тоннели утрированы в 1,5 раза', innerWidth - 16, innerHeight - 12);
    const a = document.createElement('a'); a.download = `diorama-${NAME}.png`; a.href = out.toDataURL('image/png'); a.click();
  };
  $('b-lbl').onclick = () => { showLbl = !showLbl; $('b-lbl').textContent = 'Подписи: ' + (showLbl ? 'вкл' : 'выкл'); };
  $('b-clean').onclick = () => document.body.classList.add('clean');
  addEventListener('keydown', e => { if (e.key === 'Escape') document.body.classList.remove('clean'); });
  $('b-reset').onclick = reset;
})();
