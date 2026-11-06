// Сводка по кольцам: все щиты линии, прогресс, скорость по последним замерам и прогноз до следующей станции.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const fmt = n => Math.round(n).toLocaleString('ru-RU');
  const dfmt = d => d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const day = 864e5;
  const qs = new URLSearchParams(location.search);
  // Порядок станций линии с юга на север — по нему строится схема «Перегоны и щиты»
  const ORDER = {
    'Красносельско-Калининская': ['Путиловская', 'Броневая', 'Заставская', 'Боровая', 'Каретная'],
    'Невско-Василеостровская': ['Каменка', 'Беговая']
  };
  fetch('data/shields.json', { cache: 'no-cache' }).then(r => r.json()).then(render)
    .catch(e => { $('lead').textContent = 'Не удалось загрузить данные.'; console.error(e); });

  function render(D) {
    const lineKey = qs.get('line') || 'Красносельско-Калининская';
    const SH = D.shields.filter(s => (s.line || '').includes(lineKey));
    const order = ORDER[lineKey] || [];
    $('eb').textContent = (SH[0] && SH[0].line.split(',')[0]) || lineKey;
    $('lead').textContent = 'Где каждый щит, сколько осталось до станции и с какой скоростью идёт проходка. Обновлено ' + dfmt(new Date(D.updated)) + '.';
    const m = s => s.unit === 'm' ? 1 : (s.ringLen || 1.4);           // метров в единице
    const work = SH.filter(s => s.ring < s.total);
    const passed = SH.reduce((a, s) => a + Math.max(0, s.ring) * m(s), 0);
    const left = SH.reduce((a, s) => a + Math.max(0, s.total - s.ring) * m(s), 0);
    const speed = SH.map(spd).filter(Boolean);
    const wk = speed.reduce((a, v) => a + v.perDay * 7 * v.k, 0);
    $('kpis').innerHTML = [
      [work.length + ' из ' + SH.length, 'щитов сейчас в работе'],
      ['≈ ' + fmt(passed) + ' м', 'пройдено тоннелей на участке'],
      ['≈ ' + fmt(left) + ' м', 'осталось до конечных станций'],
      [wk ? '≈ ' + fmt(wk) + ' м' : '—', 'в неделю, все щиты вместе']
    ].map(([b, t]) => `<div class="kpi"><b>${b}</b><span>${t}</span></div>`).join('');
    strip(SH, order);
    $('grid').innerHTML = SH.map(card).join('');
  }

  // скорость по двум последним замерам истории
  function spd(s) {
    const h = (s.history || []).filter(x => x.date && x.ring != null).sort((a, b) => a.date < b.date ? -1 : 1);
    if (h.length < 2) return null;
    const a = h[h.length - 2], b = h[h.length - 1], dd = (new Date(b.date) - new Date(a.date)) / day;
    if (dd <= 0 || b.ring <= a.ring) return null;
    return { perDay: (b.ring - a.ring) / dd, from: a.date, to: b.date, k: s.unit === 'm' ? 1 : (s.ringLen || 1.4) };
  }

  function card(s) {
    const u = s.unit === 'm' ? 'м' : 'колец', U = s.unit === 'm' ? ' м' : '';
    const pct = Math.max(0, Math.min(100, s.ring / s.total * 100));
    const st = (s.stations || []).filter(x => x.to > 0);
    const inside = st.find(x => x.from <= s.ring && s.ring <= x.to), next = st.find(x => x.from > s.ring);
    const v = spd(s);
    let eta = '—', etaSub = 'нет двух замеров';
    if (s.ring >= s.total) { eta = 'финиш'; etaSub = 'проходка завершена'; }
    else if (v && next) { const d = new Date(Date.now() + (next.from - s.ring) / v.perDay * day); eta = d.toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' }); etaSub = 'у «' + next.name + '» при той же скорости'; }
    const marks = st.map(x => { const a = Math.max(0, x.from / s.total * 100), b = Math.min(100, x.to / s.total * 100); return b > a ? `<em style="left:${a}%;width:${b - a}%"></em>` : ''; }).join('');
    const names = st.map(x => { const c = Math.max(0, Math.min(100, (x.from + x.to) / 2 / s.total * 100)); return `<span style="left:${c}%;transform:translateX(${c > 82 ? -100 : c < 12 ? 0 : -50}%)">${x.name}</span>`; }).join('');
    const hist = (s.history || []).slice(-5).reverse().map(x => `<tr><td>${dfmt(new Date(x.date))}</td><td>${fmt(x.ring)}${U}</td></tr>`).join('');
    return `<article class="sh" style="--c:${s.color || '#e3a21a'}">
      <div class="top"><h3>«${s.name}»</h3><span class="mach">${s.machine || ''}</span></div>
      <div class="route">${(s.line || '').split(',').slice(1).join(',').trim() || ''}</div>
      <div class="big"><b>${fmt(s.ring)}</b><span>${u} из ~${fmt(s.total)} · ${pct.toFixed(0)}%</span></div>
      <div class="bar"><i style="width:${pct}%"></i>${marks}</div>
      <div class="marks">${names}</div>
      <div class="stats">
        <div><b>${s.ring >= s.total ? 'финиш' : inside ? 'на станции' : next ? fmt(next.from - s.ring) + ' ' + u : '—'}</b><span>${s.ring >= s.total ? 'проходка завершена' : inside ? 'проходит «' + inside.name + '»' : next ? 'до «' + next.name + '»' : ''}</span></div>
        <div><b>${v ? fmt(v.perDay * 7) + ' ' + u : '—'}</b><span>${v ? 'в неделю (' + new Date(v.from).toLocaleDateString('ru-RU') + '–' + new Date(v.to).toLocaleDateString('ru-RU') + ')' : 'скорость: нужен второй замер'}</span></div>
        <div><b>${eta}</b><span>${etaSub}</span></div>
      </div>
      ${hist ? `<div class="hist"><table>${hist}</table></div>` : ''}
      ${s.note ? `<div class="note">${s.note}</div>` : ''}
    </article>`;
  }

  // Схема линии: станции по порядку, под ними строка на каждый щит с пройденной частью
  function strip(SH, order) {
    if (!order.length) { $('strip').innerHTML = ''; return; }
    const W = 1000, L = 70, Rt = 40, top = 34, rowH = 30, H = top + SH.length * rowH + 14;
    const X = i => L + i * (W - L - Rt) / (order.length - 1);
    const pos = s => {   // единицы щита → место на схеме по центрам его станций
      const an = (s.stations || []).filter(x => order.includes(x.name)).map(x => [(x.from + x.to) / 2, order.indexOf(x.name)]).sort((a, b) => a[0] - b[0]);
      if (s.anchors) s.anchors.forEach(a => an.push([a[0], order.indexOf(a[1])]));
      an.sort((a, b) => a[0] - b[0]);
      if (an.length < 2) return null;
      return u => { let i = 0; while (i < an.length - 2 && u > an[i + 1][0]) i++; const [u0, x0] = an[i], [u1, x1] = an[i + 1]; return X(x0 + (x1 - x0) * (u - u0) / (u1 - u0)); };
    };
    let g = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Схема проходки">`;
    order.forEach((n, i) => { g += `<line x1="${X(i)}" x2="${X(i)}" y1="${top - 8}" y2="${H - 6}" stroke="#e3dfd6" stroke-dasharray="3 4"/><text x="${X(i)}" y="16" text-anchor="middle" font-size="13" font-weight="600" fill="#1d2529">${n}</text>`; });
    SH.forEach((s, k) => {
      const f = pos(s), y = top + k * rowH + 10; if (!f) return;
      const a = f(0), b = f(s.total), r = f(Math.max(0, Math.min(s.ring, s.total)));
      g += `<line x1="${a}" x2="${b}" y1="${y}" y2="${y}" stroke="#e6e1d8" stroke-width="8" stroke-linecap="round"/>`;
      g += `<line x1="${a}" x2="${r}" y1="${y}" y2="${y}" stroke="${s.lineColor || '#8a5a36'}" stroke-width="8" stroke-linecap="round"/>`;
      g += `<circle cx="${r}" cy="${y}" r="7.5" fill="${s.color || '#e3a21a'}" stroke="#fff" stroke-width="2"/>`;
      const lx = Math.min(a, b) - 8;
      g += `<text x="${lx}" y="${y + 4}" text-anchor="end" font-size="12" fill="#5d6a71">«${s.name}»</text>`;
    });
    $('strip').innerHTML = g + '</svg>';
  }
})();
