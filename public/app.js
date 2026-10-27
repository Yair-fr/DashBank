/* DashBank dashboard. All data is written via textContent / DOM APIs — never innerHTML. */
(() => {
  'use strict';

  const PAGE_SIZE = 50;
  const POLL_MS = 2500;
  const $ = (id) => document.getElementById(id);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const KIND_LABELS = { standing_order: 'הוראת קבע', subscription: 'מנוי', income: 'הכנסה קבועה', recurring: 'חוזר' };
  const CADENCE_LABELS = { monthly: 'חודשי', weekly: 'שבועי', yearly: 'שנתי' };
  const CADENCE_PER_MONTH = { monthly: 1, weekly: 52 / 12, yearly: 1 / 12 };
  const KNOWN_SOURCES = new Set(['hapoalim', 'isracard', 'visaCal', 'max']);

  const state = {
    month: null, // set at startup (after helpers are defined)
    overview: null,
    sourceLabels: {},
    txn: { q: '', direction: '', source: '', category: '', offset: 0 },
    charts: {},
    seq: { overview: 0, txn: 0 },
    pollTimer: null,
    lastTxn: null,
    catColor: null,
  };

  // ---------- formatting ----------
  const stripBidi = (s) => s.replace(/[‎‏؜]/g, '').replace('-', '−');
  const nf0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ils = (n) => stripBidi(nf0.format(Math.round(n || 0)));
  const ils2 = (n) => stripBidi(nf2.format(n || 0));
  const fx = (n, cur) => {
    try { return stripBidi(new Intl.NumberFormat('he-IL', { style: 'currency', currency: cur }).format(n)); }
    catch { return `${n} ${cur}`; }
  };
  const compact = (n) => {
    const a = Math.abs(n);
    if (a >= 1e6) return `₪${+(n / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `₪${+(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
    return `₪${Math.round(n)}`;
  };
  const pct = (n) => `${Math.abs(n) >= 10 ? Math.round(Math.abs(n)) : Math.abs(n).toFixed(1)}%`;
  const dtMonthLong = new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric' });
  const dtMonthShort = new Intl.DateTimeFormat('he-IL', { month: 'short' });
  const dtDay = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'numeric' });
  const dtDayYear = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' });
  const dtWeekday = new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
  const dtLongDay = new Intl.DateTimeFormat('he-IL', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  const dtFull = new Intl.DateTimeFormat('he-IL', { dateStyle: 'medium', timeStyle: 'short' });
  const dtRunTime = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

  const monthDate = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1); };
  const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const shiftMonth = (m, by) => { const d = monthDate(m); d.setMonth(d.getMonth() + by); return monthKey(d); };
  const currentMonth = () => monthKey(new Date());
  const monthRange = (m) => ({ from: `${m}-01`, to: `${shiftMonth(m, 1)}-01` });
  const daysIn = (m) => { const d = monthDate(m); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); };
  const parseDay = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
  const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const fmtDay = (iso) => {
    if (!iso) return '—';
    const d = parseDay(iso);
    return (d.getFullYear() === new Date().getFullYear() ? dtDay : dtDayYear).format(d);
  };

  // Hand-rolled Hebrew relative time: Chromium's ICU renders duals oddly ("לפני שעתיים (2)").
  function relTime(iso) {
    const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 60) return 'הרגע';
    const mins = Math.round(secs / 60);
    if (mins < 60) return mins === 1 ? 'לפני דקה' : `לפני ${mins} דקות`;
    const hours = Math.round(secs / 3600);
    if (hours < 24) return hours === 1 ? 'לפני שעה' : hours === 2 ? 'לפני שעתיים' : `לפני ${hours} שעות`;
    const days = Math.round(secs / 86400);
    return days === 1 ? 'אתמול' : days === 2 ? 'שלשום' : `לפני ${days} ימים`;
  }
  function relDays(iso) {
    const days = Math.round((parseDay(iso) - todayStart()) / 86400000);
    if (days === 0) return 'היום';
    if (days === 1) return 'מחר';
    if (days === 2) return 'מחרתיים';
    if (days > 0) return `בעוד ${days} ימים`;
    if (days === -1) return 'אתמול';
    return `לפני ${-days} ימים`;
  }

  function initialMonth() {
    try {
      const m = new URLSearchParams(location.search).get('month');
      if (m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return m;
    } catch { /* ignore */ }
    return currentMonth();
  }

  const srcLabel = (s) => state.sourceLabels[s] || s || '—';
  const srcKey = (s) => (KNOWN_SOURCES.has(s) ? s : 'other');

  // ---------- DOM helpers ----------
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) if (c != null && c !== false) node.append(c);
    return node;
  }
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(paths) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of [].concat(paths)) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }
  const ICONS = {
    wallet: ['M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1', 'M3 7v10a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2', 'M16 13.5h.01'],
    in: ['M12 19V5', 'M6 11l6-6 6 6'],
    out: ['M12 5v14', 'M6 13l6 6 6-6'],
    flow: ['M4 17l5-5 4 4 7-7', 'M14 9h6v6'],
    clock: ['M12 7v5l3 2', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'],
    up: ['M12 19V5', 'M6 11l6-6 6 6'],
    down: ['M12 5v14', 'M6 13l6 6 6-6'],
    check: ['M5 12.5l4.5 4.5L19 7'],
    x: ['M6 6l12 12', 'M18 6L6 18'],
  };

  function toast(msg, isErr = false) {
    const t = $('toast');
    t.textContent = msg;
    t.className = isErr ? 'toast err' : 'toast';
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 3800);
  }

  async function api(path, opts) {
    const res = await fetch(path, { headers: { Accept: 'application/json' }, ...opts });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    // The service worker marks responses served from its cache while offline.
    if (res.ok && (!opts || !opts.method || opts.method === 'GET')) setOffline(res.headers.get('X-DashBank-Offline') === '1');
    if (!res.ok) {
      const err = new Error(body?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  // ---------- count-up animation ----------
  function animateValue(node, to, format) {
    const from = Number(node.dataset.value || 0);
    node.dataset.value = String(to);
    if (reducedMotion || from === to) { node.textContent = format(to); return; }
    const start = performance.now();
    const dur = 650;
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      node.textContent = format(from + (to - from) * e);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- skeletons ----------
  function renderSkeletons() {
    const kpis = $('kpis');
    kpis.replaceChildren(...Array.from({ length: 5 }, () => el('div', { class: 'kpi' }, [
      el('div', { class: 'skeleton skel-line w40' }),
      el('div', { class: 'skeleton skel-val' }),
      el('div', { class: 'skeleton skel-line w60' }),
    ])));
    $('accounts').replaceChildren(...Array.from({ length: 3 }, () => el('li', { class: 'skeleton skel-row' })));
    $('synclog').replaceChildren(...Array.from({ length: 4 }, () => el('li', { class: 'skeleton skel-row' })));
    $('recurring-body').replaceChildren(...skeletonRows(4, 4));
    $('txn-list').replaceChildren(...Array.from({ length: 6 }, () => el('div', { class: 'skeleton skel-row' })));
    $('cat-list').replaceChildren(...Array.from({ length: 5 }, () => el('li', { class: 'skeleton skel-line w80' })));
  }
  function skeletonRows(n, cols) {
    return Array.from({ length: n }, () => el('tr', {}, Array.from({ length: cols }, (_, i) => el('td', {}, el('div', { class: `skeleton skel-line ${i === 1 ? 'w80' : 'w60'}` })))));
  }

  // ---------- KPIs ----------
  function deltaChip(cur, prev, { higherIsGood = true } = {}) {
    if (!prev) return el('span', { class: 'delta', text: '—' });
    const change = ((cur - prev) / Math.abs(prev)) * 100;
    if (!Number.isFinite(change)) return el('span', { class: 'delta', text: '—' });
    const up = change > 0.05; const down = change < -0.05;
    const good = (up && higherIsGood) || (down && !higherIsGood);
    const bad = (up && !higherIsGood) || (down && higherIsGood);
    return el('span', { class: `delta${good ? ' good' : ''}${bad ? ' bad' : ''}` }, [
      up ? icon(ICONS.up) : down ? icon(ICONS.down) : null,
      document.createTextNode(up || down ? pct(change) : '0%'),
    ]);
  }

  const kpiPrev = new Map();
  function kpiTile({ label, value, iconName, tone, valueClass = '', foot }, i) {
    const valueNode = el('div', { class: `kpi-value ${valueClass}`.trim(), dataset: { value: String(kpiPrev.get(label) ?? 0) } });
    kpiPrev.set(label, value);
    const tile = el('div', { class: 'kpi', dataset: { tone }, style: `--i:${i}` }, [
      el('div', { class: 'kpi-top' }, [el('span', { class: 'kpi-label', text: label }), el('span', { class: 'kpi-icon' }, icon(ICONS[iconName]))]),
      valueNode,
      el('div', { class: 'kpi-foot' }, foot),
    ]);
    animateValue(valueNode, value, ils);
    return tile;
  }

  function renderKpis(o) {
    const s = o.summary; const p = o.prevSummary;
    const vs = () => el('span', { text: 'לעומת חודש קודם' });
    const balanceAccounts = o.accounts.filter((a) => a.balance != null);
    const latest = balanceAccounts.map((a) => a.balanceDate || a.updatedAt).filter(Boolean).sort().at(-1);
    // Balance and pending are point-in-time figures (not month-scoped), so they get context, not a Δ%.
    const tiles = [
      {
        label: 'יתרה בעו״ש', value: s.balance, iconName: 'wallet', tone: 'accent', valueClass: s.balance < 0 ? 'neg' : '',
        foot: [el('span', { text: latest ? `עודכן ${relTime(latest)}` : 'אין נתוני יתרה' })],
      },
      {
        label: 'הכנסות החודש', value: s.income, iconName: 'in', tone: 'pos',
        foot: [deltaChip(s.income, p.income, { higherIsGood: true }), vs()],
      },
      {
        label: 'הוצאות החודש', value: s.expense, iconName: 'out', tone: 'neg',
        foot: [deltaChip(s.expense, p.expense, { higherIsGood: false }), vs()],
      },
      {
        label: 'תזרים נטו', value: s.net, iconName: 'flow', tone: s.net >= 0 ? 'pos' : 'neg', valueClass: s.net >= 0 ? 'pos' : 'neg',
        foot: [deltaChip(s.net, p.net, { higherIsGood: true }), vs()],
      },
      {
        label: 'חיובים ממתינים', value: s.pending, iconName: 'clock', tone: 'warn',
        foot: [el('span', { text: s.pending > 0 ? 'בכרטיסים, טרם נקלטו' : 'אין חיובים ממתינים' })],
      },
    ];
    $('kpis').replaceChildren(...tiles.map((t, i) => kpiTile(t, i)));
  }

  // ---------- charts ----------
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // Chart.js parses colours itself, so derive translucent variants as rgba() from the hex tokens.
  function alpha(color, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(color);
    if (!m) return color;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const CAT_VARS = ['--cat-1', '--cat-2', '--cat-3', '--cat-4', '--cat-5', '--cat-6', '--cat-7', '--cat-8'];
  const MAX_CATS = 7;

  function chartBase() {
    const Chart = window.Chart;
    Chart.defaults.font.family = css('--font') || 'system-ui';
    Chart.defaults.font.size = 12;
    Chart.defaults.color = css('--tick');
    Chart.defaults.borderColor = css('--grid');
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: reducedMotion ? false : { duration: 600, easing: 'easeOutCubic' },
      locale: 'he-IL',
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false, rtl: true, textDirection: 'rtl' },
        tooltip: {
          rtl: true, textDirection: 'rtl',
          backgroundColor: css('--tooltip-bg'), titleColor: css('--tooltip-text'), bodyColor: css('--tooltip-text'),
          padding: 10, cornerRadius: 10, boxPadding: 4, usePointStyle: true,
          titleFont: { weight: '600' },
        },
      },
    };
  }

  function mountChart(key, canvasId, config) {
    const canvas = $(canvasId);
    state.charts[key]?.destroy();
    state.charts[key] = new window.Chart(canvas, config);
    canvas.parentElement.classList.add('ready');
    return state.charts[key];
  }

  function setEmpty(canvasId, empty, text = 'אין נתונים לחודש זה') {
    const box = $(canvasId).parentElement;
    let msg = box.querySelector('.chart-empty');
    if (empty && !msg) { msg = el('div', { class: 'chart-empty', text }); box.append(msg); }
    if (!empty && msg) msg.remove();
  }

  function renderMonthlyChart(o) {
    const pos = css('--pos'); const neg = css('--neg');
    // Phones get the last 6 months so the bars stay legible.
    const months = isMobile() ? o.monthly.slice(-6) : o.monthly;
    const labels = months.map((r) => dtMonthShort.format(monthDate(r.month)));
    const sel = months.map((r) => r.month === o.month);
    $('monthly-sub').textContent = `${months.length} חודשים · לחצו על חודש למעבר`;
    const base = chartBase();
    mountChart('monthly', 'chart-monthly', {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'הכנסות', data: months.map((r) => r.income), backgroundColor: sel.map((s) => (s ? pos : alpha(pos, 0.42))), hoverBackgroundColor: pos },
          { label: 'הוצאות', data: months.map((r) => r.expense), backgroundColor: sel.map((s) => (s ? neg : alpha(neg, 0.42))), hoverBackgroundColor: neg },
        ].map((d) => ({ ...d, borderRadius: 6, borderSkipped: false, maxBarThickness: 22, categoryPercentage: 0.66, barPercentage: 0.86 })),
      },
      options: {
        ...base,
        onClick: (_e, els) => { if (els.length) goToMonth(months[els[0].index].month); },
        onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        scales: {
          x: { reverse: true, grid: { display: false }, border: { display: false } },
          y: { position: 'right', beginAtZero: true, border: { display: false }, grid: { color: css('--grid') }, ticks: { callback: (v) => compact(v), maxTicksLimit: 5, padding: 8 } },
        },
        plugins: {
          ...base.plugins,
          tooltip: {
            ...base.plugins.tooltip,
            callbacks: {
              title: (items) => dtMonthLong.format(monthDate(months[items[0].dataIndex].month)),
              label: (ctx) => ` ${ctx.dataset.label}: ${ils(ctx.parsed.y)}`,
              footer: (items) => {
                const r = months[items[0].dataIndex];
                return `נטו: ${ils(r.income - r.expense)}`;
              },
            },
          },
        },
      },
    });
    setEmpty('chart-monthly', months.every((r) => !r.income && !r.expense), 'אין עדיין נתונים');
  }

  function categoryGroups(cats) {
    if (cats.length <= MAX_CATS + 1) return cats.map((c) => ({ ...c, filterable: true }));
    const top = cats.slice(0, MAX_CATS).map((c) => ({ ...c, filterable: true }));
    const rest = cats.slice(MAX_CATS);
    top.push({ category: 'שאר הקטגוריות', total: rest.reduce((a, c) => a + c.total, 0), count: rest.reduce((a, c) => a + c.count, 0), filterable: false });
    return top;
  }

  function renderCategoryChart(o) {
    const groups = categoryGroups(o.categories);
    const colors = groups.map((g, i) => (g.filterable ? css(CAT_VARS[i % CAT_VARS.length]) : css('--cat-9')));
    state.catColor = new Map(groups.map((g, i) => [g.category, colors[i]]));
    const total = groups.reduce((a, g) => a + g.total, 0);
    const base = chartBase();
    $('donut-total').textContent = ils(total);
    const active = state.txn.category;
    mountChart('categories', 'chart-categories', {
      type: 'doughnut',
      data: {
        labels: groups.map((g) => g.category),
        datasets: [{
          data: groups.length ? groups.map((g) => g.total) : [1],
          backgroundColor: groups.length ? colors.map((c, i) => (active && groups[i].category !== active ? alpha(c, 0.3) : c)) : [css('--surface-3')],
          borderColor: css('--surface'), borderWidth: 2, hoverOffset: 6, borderRadius: 4,
        }],
      },
      options: {
        ...base,
        cutout: '74%',
        interaction: { mode: 'nearest', intersect: true },
        onClick: (_e, els) => { if (els.length && groups[els[0].index]?.filterable) toggleCategory(groups[els[0].index].category); },
        onHover: (e, els) => { e.native.target.style.cursor = els.length && groups[els[0]?.index]?.filterable ? 'pointer' : 'default'; },
        plugins: {
          ...base.plugins,
          tooltip: {
            ...base.plugins.tooltip,
            enabled: groups.length > 0,
            callbacks: { label: (ctx) => ` ${ctx.label}: ${ils(ctx.parsed)} (${pct((ctx.parsed / total) * 100)})` },
          },
        },
      },
    });

    const list = $('cat-list');
    if (!groups.length) {
      list.replaceChildren(el('li', { class: 'empty empty-li', text: 'אין הוצאות בחודש זה' }));
      return;
    }
    list.replaceChildren(...groups.map((g, i) => el('li', {}, el('button', {
      type: 'button',
      class: `cat-item${active === g.category ? ' active' : ''}`,
      disabled: !g.filterable,
      'aria-pressed': g.filterable ? String(active === g.category) : null,
      title: g.filterable ? `סינון לפי ${g.category}` : null,
      onclick: () => g.filterable && toggleCategory(g.category),
    }, [
      el('i', { class: 'sw', style: `background:${colors[i]}` }),
      el('span', { class: 'cat-name', text: g.category }),
      el('span', { class: 'cat-amt', text: ils(g.total) }),
      el('span', { class: 'cat-pct', text: pct((g.total / total) * 100) }),
    ]))));
  }

  function cumulative(rows, month, cutoffDay) {
    const n = daysIn(month);
    const byDay = new Map(rows.map((r) => [Number(r.day.slice(8, 10)), r.expense]));
    const out = []; let acc = 0;
    for (let d = 1; d <= n; d++) {
      acc += byDay.get(d) || 0;
      out.push(cutoffDay && d > cutoffDay ? null : Math.round(acc * 100) / 100);
    }
    return out;
  }

  function renderDailyChart(o) {
    const prevM = shiftMonth(o.month, -1);
    const isCurrent = o.month === currentMonth();
    const cutoff = isCurrent ? new Date().getDate() : null;
    const cur = cumulative(o.daily, o.month, cutoff);
    const prev = cumulative(o.prevDaily, prevM, null);
    const len = Math.max(cur.length, prev.length);
    const labels = Array.from({ length: len }, (_, i) => String(i + 1));
    const accent = css('--accent'); const muted = css('--muted-line');
    const base = chartBase();
    $('cum-sub').textContent = `${dtMonthLong.format(monthDate(o.month))} מול ${dtMonthLong.format(monthDate(prevM))}`;
    mountChart('daily', 'chart-daily', {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'החודש', data: cur, borderColor: accent, borderWidth: 2.5, tension: 0.3, pointRadius: 0, pointHoverRadius: 4,
            pointBackgroundColor: accent, fill: 'origin',
            backgroundColor: (ctx) => {
              const { chart } = ctx; const area = chart.chartArea;
              if (!area) return alpha(accent, 0.1);
              const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
              g.addColorStop(0, alpha(accent, 0.22)); g.addColorStop(1, alpha(accent, 0));
              return g;
            },
          },
          { label: 'חודש קודם', data: prev, borderColor: muted, borderWidth: 2, borderDash: [5, 5], tension: 0.3, pointRadius: 0, pointHoverRadius: 3, pointBackgroundColor: muted, fill: false },
        ],
      },
      options: {
        ...base,
        scales: {
          x: { reverse: true, offset: false, grid: { display: false }, border: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 14, align: 'inner' } },
          y: { position: 'right', beginAtZero: true, border: { display: false }, grid: { color: css('--grid') }, ticks: { callback: (v) => compact(v), maxTicksLimit: 5, padding: 8 } },
        },
        plugins: {
          ...base.plugins,
          tooltip: {
            ...base.plugins.tooltip,
            filter: (item) => item.parsed.y != null,
            callbacks: {
              title: (items) => `יום ${items[0].label} בחודש`,
              label: (ctx) => ` ${ctx.dataset.label}: ${ils(ctx.parsed.y)}`,
            },
          },
        },
      },
    });
    setEmpty('chart-daily', !o.daily.length && !o.prevDaily.length);
  }

  // Re-read colours when the OS theme flips.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.overview) renderCharts(state.overview);
  });

  function renderCharts(o) {
    if (!window.Chart) return;
    renderMonthlyChart(o);
    renderCategoryChart(o);
    renderDailyChart(o);
  }

  // ---------- accounts ----------
  function renderAccounts(o) {
    const list = $('accounts');
    $('accounts-sub').textContent = o.accounts.length ? `${o.accounts.length} חשבונות מחוברים` : 'אין חשבונות';
    if (!o.accounts.length) {
      list.replaceChildren(el('li', { class: 'empty empty-li', text: 'עוד לא סונכרנו חשבונות' }));
      return;
    }
    list.replaceChildren(...o.accounts.map((a) => {
      const label = srcLabel(a.source);
      const last4 = String(a.accountNumber || '').slice(-4);
      const hasBal = a.balance != null;
      return el('li', { class: 'account' }, [
        el('span', { class: 'acc-logo', dataset: { src: srcKey(a.source) }, text: label.replace(/^בנק\s+/, '').slice(0, 1) }),
        el('div', { style: 'min-width:0' }, [
          el('div', { class: 'acc-name', text: a.label || label }),
          el('div', { class: 'acc-meta' }, [
            el('span', { text: label }),
            last4 ? el('span', { text: '·' }) : null,
            last4 ? el('span', { class: 'last4', text: `•••• ${last4}` }) : null,
          ]),
        ]),
        el('span', { class: `acc-bal${hasBal ? (a.balance < 0 ? ' neg' : '') : ' none'}`, text: hasBal ? ils(a.balance) : 'כרטיס' }),
      ]);
    }));
  }

  // ---------- recurring ----------
  function renderRecurring(o) {
    const cutoff = todayStart(); cutoff.setDate(cutoff.getDate() - 7);
    const items = o.recurring.map((r) => ({ ...r, inactive: Boolean(r.nextDate) && parseDay(r.nextDate) < cutoff }));
    items.sort((a, b) => (a.inactive - b.inactive) || ((a.kind === 'income') - (b.kind === 'income')) || (Math.abs(b.avgAmount) - Math.abs(a.avgAmount)));
    const fixed = items
      .filter((r) => !r.inactive && r.kind !== 'income' && r.avgAmount < 0)
      .reduce((sum, r) => sum + Math.abs(r.avgAmount) * (CADENCE_PER_MONTH[r.cadence] ?? 1), 0);
    animateValue($('fixed-total'), fixed, ils);

    const body = $('recurring-body');
    if (!items.length) {
      body.replaceChildren(el('tr', {}, el('td', { colspan: '4', class: 'empty', text: 'לא זוהו עדיין תשלומים קבועים' })));
      return;
    }
    body.replaceChildren(...items.map((r) => {
      const kind = el('span', { class: r.inactive ? 'badge inactive' : `badge k-${r.kind || 'recurring'}`, text: r.inactive ? 'לא פעיל' : (KIND_LABELS[r.kind] || 'חוזר') });
      return el('tr', { class: r.inactive ? 'inactive' : null }, [
        el('td', {}, [
          el('div', { class: 'desc', text: r.description }),
          el('div', { class: 'meta' }, [
            el('span', { class: 'kind-inline' }, kind.cloneNode(true)),
            el('span', { class: 'src-pill' }, [el('i', { class: 'src-dot', dataset: { src: srcKey(r.source) } }), document.createTextNode(srcLabel(r.source))]),
            el('span', { text: '·' }),
            el('span', { text: `${CADENCE_LABELS[r.cadence] || r.cadence} · ${r.count} חיובים` }),
            r.nextDate && !r.inactive ? el('span', { class: 'next-inline', text: `· הבא ${relDays(r.nextDate)}` }) : null,
          ]),
        ]),
        el('td', { class: 'kind' }, kind),
        el('td', { class: 'date col-next' }, [
          el('div', { text: fmtDay(r.nextDate) }),
          r.nextDate && !r.inactive ? el('div', { class: 'meta', text: relDays(r.nextDate) }) : null,
        ]),
        el('td', { class: `amount ${r.avgAmount > 0 ? 'pos' : 'neg'}`, text: `${r.avgAmount > 0 ? '+' : ''}${ils2(r.avgAmount)}` }),
      ]);
    }));
  }

  // ---------- sync log + status ----------
  function renderSyncLog(o) {
    const list = $('synclog');
    if (!o.syncRuns.length) {
      list.replaceChildren(el('li', { class: 'empty empty-li', text: 'עוד לא בוצע סנכרון' }));
      return;
    }
    list.replaceChildren(...o.syncRuns.map((r) => el('li', { class: 'run' }, [
      el('span', { class: `run-icon ${r.ok ? 'ok' : 'err'}`, 'aria-label': r.ok ? 'הצליח' : 'נכשל' }, icon(r.ok ? ICONS.check : ICONS.x)),
      el('div', { style: 'min-width:0' }, [
        el('div', { class: 'run-title', text: r.label ? `${srcLabel(r.source)} · ${r.label}` : srcLabel(r.source) }),
        r.ok
          ? el('div', { class: 'run-new', text: r.newCount ? `${r.newCount} תנועות חדשות` : 'אין תנועות חדשות' })
          : el('div', { class: 'run-err', text: r.error || 'שגיאה לא ידועה' }),
      ]),
      el('span', { class: 'run-time', title: dtFull.format(new Date(r.startedAt)), text: dtRunTime.format(new Date(r.startedAt)) }),
    ])));
  }

  function renderSyncStatus(o) {
    const dot = $('sync-dot'); const text = $('sync-text'); const btn = $('sync-btn');
    const last = o.syncRuns[0];
    if (o.syncing) {
      dot.className = 'dot busy';
      text.textContent = 'מסנכרן…';
    } else if (last) {
      const batch = o.syncRuns.filter((r) => Math.abs(new Date(r.startedAt) - new Date(last.startedAt)) < 10 * 60 * 1000);
      const failed = batch.some((r) => !r.ok);
      dot.className = `dot ${failed ? 'err' : 'ok'}`;
      text.textContent = `${failed ? 'סנכרון חלקי' : 'סונכרן'} ${relTime(last.finishedAt || last.startedAt)}`;
      $('sync-status').title = `סנכרון אחרון: ${dtFull.format(new Date(last.finishedAt || last.startedAt))}`;
    } else {
      dot.className = 'dot';
      text.textContent = 'טרם סונכרן';
    }
    btn.classList.toggle('loading', Boolean(o.syncing));
    btn.disabled = Boolean(o.syncing) || !o.canSync;
    btn.title = o.demo ? 'הסנכרון מושבת במצב הדגמה' : !o.canSync ? 'הסנכרון אינו זמין' : '';
    $('demo-banner').hidden = !o.demo;
  }

  async function startSync() {
    const btn = $('sync-btn');
    btn.disabled = true; btn.classList.add('loading');
    try {
      await api('api/sync', { method: 'POST' });
      toast('הסנכרון התחיל…');
    } catch (err) {
      if (err.status !== 409) {
        toast(err.message || 'הסנכרון נכשל', true);
        btn.classList.remove('loading');
        btn.disabled = !state.overview?.canSync;
        return;
      }
      toast('סנכרון כבר רץ ברקע');
    }
    pollSync(true);
  }

  function pollSync(announce) {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(async () => {
      try {
        const o = await api(`api/overview?month=${state.month}`);
        if (o.syncing) {
          renderSyncStatus(o);
          pollSync(announce);
          return;
        }
        state.pollTimer = null;
        applyOverview(o);
        loadTransactions();
        if (announce) {
          const failed = o.syncRuns[0] && !o.syncRuns[0].ok;
          toast(failed ? 'הסנכרון הסתיים עם שגיאות' : 'הסנכרון הושלם', failed);
        }
      } catch {
        pollSync(announce);
      }
    }, POLL_MS);
  }

  // ---------- overview ----------
  function applyOverview(o) {
    state.overview = o;
    state.sourceLabels = o.sourceLabels || {};
    renderKpis(o);
    renderCharts(o);
    renderAccounts(o);
    renderRecurring(o);
    renderSyncLog(o);
    renderSyncStatus(o);
    renderSourceOptions(o);
    if (state.lastTxn) renderTransactions(state.lastTxn); // pick up category colours
  }

  async function loadOverview() {
    const seq = ++state.seq.overview;
    try {
      const o = await api(`api/overview?month=${state.month}`);
      if (seq !== state.seq.overview) return;
      applyOverview(o);
      if (o.syncing) pollSync(false);
    } catch (err) {
      if (seq === state.seq.overview) toast(`שגיאה בטעינת הנתונים: ${err.message}`, true);
    }
  }

  function renderMonthNav() {
    $('month-label').textContent = dtMonthLong.format(monthDate(state.month));
    $('month-next').disabled = state.month >= currentMonth();
  }

  function goToMonth(m) {
    if (m > currentMonth() || m === state.month) return;
    state.month = m;
    state.txn.offset = 0;
    try {
      const url = new URL(location.href);
      if (m === currentMonth()) url.searchParams.delete('month'); else url.searchParams.set('month', m);
      history.replaceState(null, '', url);
    } catch { /* ignore */ }
    renderMonthNav();
    loadOverview();
    loadTransactions();
  }

  // ---------- transactions ----------
  function renderSourceOptions(o) {
    const sel = $('txn-source');
    const sources = [...new Set(o.accounts.map((a) => a.source))];
    const list = sources.length ? sources : Object.keys(state.sourceLabels);
    const current = sel.value;
    sel.replaceChildren(el('option', { value: '', text: 'כל המקורות' }), ...list.map((s) => el('option', { value: s, text: srcLabel(s) })));
    sel.value = list.includes(current) ? current : '';
  }

  function toggleCategory(cat) {
    state.txn.category = state.txn.category === cat ? '' : cat;
    state.txn.offset = 0;
    if (state.overview) renderCategoryChart(state.overview);
    loadTransactions();
    if (!state.txn.category) return;
    if (isMobile()) setTab('txns');
    else $('txn-card').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  }

  function renderChips() {
    const chips = $('txn-chips');
    const c = state.txn.category;
    chips.replaceChildren(...(c ? [el('button', { type: 'button', class: 'chip', title: 'הסרת סינון', onclick: () => toggleCategory(c) }, [
      el('span', { text: `קטגוריה: ${c}` }), icon(ICONS.x),
    ])] : []));
  }

  async function loadTransactions() {
    const seq = ++state.seq.txn;
    const { from, to } = monthRange(state.month);
    const params = new URLSearchParams({ from, to, limit: String(PAGE_SIZE), offset: String(state.txn.offset) });
    for (const k of ['q', 'direction', 'source', 'category']) if (state.txn[k]) params.set(k, state.txn[k]);
    renderChips();
    const body = $('txn-list');
    body.classList.add('loading-rows');
    try {
      const r = await api(`api/transactions?${params}`);
      if (seq !== state.seq.txn) return;
      state.lastTxn = r;
      renderTransactions(r);
    } catch (err) {
      if (seq === state.seq.txn) toast(`שגיאה בטעינת התנועות: ${err.message}`, true);
    } finally {
      if (seq === state.seq.txn) body.classList.remove('loading-rows');
    }
  }

  function dayHeading(iso) {
    const d = parseDay(iso);
    const diff = Math.round((todayStart() - d) / 86400000);
    if (diff === 0) return 'היום';
    if (diff === 1) return 'אתמול';
    return dtWeekday.format(d);
  }

  function renderTransactions({ rows, total }) {
    const body = $('txn-list');
    const filtered = Boolean(state.txn.q || state.txn.direction || state.txn.source || state.txn.category);
    $('txn-sub').textContent = `${total.toLocaleString('he-IL')} תנועות ב${dtMonthLong.format(monthDate(state.month))}${filtered ? ' (מסונן)' : ''}`;
    if (!rows.length) {
      body.replaceChildren(el('div', { class: 'empty', text: filtered ? 'אין תנועות שתואמות לסינון' : 'אין תנועות בחודש זה' }));
    } else {
      const groups = new Map();
      for (const t of rows) {
        const key = String(t.date).slice(0, 10);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
      }
      body.replaceChildren(...[...groups].map(([day, items]) => {
        const net = items.reduce((a, t) => a + (Number(t.amount) || 0), 0);
        return el('section', { class: 'day-group', role: 'listitem' }, [
          el('h3', { class: 'day-head' }, [
            el('span', { text: dayHeading(day) }),
            el('span', { class: `day-sum ${net > 0 ? 'pos' : ''}`, text: `${net > 0 ? '+' : ''}${ils(net)}` }),
          ]),
          el('div', { class: 'day-rows' }, items.map(txnRow)),
        ]);
      }));
    }
    const start = total ? state.txn.offset + 1 : 0;
    const end = Math.min(state.txn.offset + rows.length, total);
    $('pager-info').textContent = total ? `${start.toLocaleString('he-IL')}–${end.toLocaleString('he-IL')} מתוך ${total.toLocaleString('he-IL')}` : '';
    $('page-prev').disabled = state.txn.offset === 0;
    $('page-next').disabled = state.txn.offset + PAGE_SIZE >= total;
    $('pager').hidden = total <= PAGE_SIZE;
  }

  const isForeign = (t) => t.originalCurrency && t.originalCurrency !== 'ILS' && t.originalCurrency !== t.currency;
  const signedIls2 = (n) => `${n > 0 ? '+' : ''}${ils2(n)}`;

  function txnRow(t) {
    const meta = [];
    if (t.category) meta.push(el('span', { class: 'meta-cat', text: t.category }));
    meta.push(el('span', { class: 'src-pill src-inline' }, [el('i', { class: 'src-dot', dataset: { src: srcKey(t.source) } }), document.createTextNode(srcLabel(t.source))]));
    if (t.status === 'pending') meta.push(el('span', { class: 'badge pending', text: 'ממתין' }));
    if (t.installmentTotal > 1) meta.push(el('span', { class: 'badge inst', title: 'תשלומים', text: `${t.installmentNumber ?? '?'}/${t.installmentTotal}` }));
    const amount = Number(t.amount) || 0;
    const initial = (t.description || '?').trim().slice(0, 1);
    return el('button', { type: 'button', class: 'txn-row', onclick: (e) => openSheet(t, e.currentTarget) }, [
      el('span', { class: 'txn-avatar', dataset: { src: srcKey(t.source) }, text: initial, 'aria-hidden': 'true' }),
      el('span', { class: 'txn-main' }, [el('span', { class: 'desc', text: t.description }), el('span', { class: 'meta' }, meta)]),
      el('span', { class: 'txn-cat' }, [
        el('i', { class: 'cat-dot', style: `background:${state.catColor?.get(t.category) || 'var(--cat-9)'}` }),
        document.createTextNode(t.category || 'ללא קטגוריה'),
      ]),
      el('span', { class: 'txn-src' }, el('span', { class: 'src-pill' }, [el('i', { class: 'src-dot', dataset: { src: srcKey(t.source) } }), document.createTextNode(srcLabel(t.source))])),
      el('span', { class: `txn-amt ${amount > 0 ? 'pos' : ''}` }, [
        el('span', { text: signedIls2(amount) }),
        isForeign(t) ? el('span', { class: 'fx', text: fx(t.originalAmount, t.originalCurrency) }) : null,
      ]),
    ]);
  }

  // ---------- bottom sheet ----------
  const sheet = { open: false, returnFocus: null };

  function detailRow(label, value, cls = '') {
    if (value == null || value === '') return null;
    return el('div', { class: 'd-row' }, [el('dt', { text: label }), el('dd', { class: cls }, value)]);
  }

  function openSheet(t, from) {
    const amount = Number(t.amount) || 0;
    const acct = state.overview?.accounts.find((a) => a.source === t.source && a.accountNumber === t.accountNumber);
    const last4 = String(t.accountNumber || '').slice(-4);
    const body = $('sheet-body');
    body.replaceChildren(
      el('div', { class: 'sheet-hero' }, [
        el('span', { class: 'txn-avatar lg', dataset: { src: srcKey(t.source) }, text: (t.description || '?').trim().slice(0, 1), 'aria-hidden': 'true' }),
        el('h2', { id: 'sheet-title', class: 'sheet-title', text: t.description }),
        el('div', { class: `sheet-amount ${amount > 0 ? 'pos' : ''}`, text: signedIls2(amount) }),
        isForeign(t) ? el('div', { class: 'sheet-fx', text: `סכום מקורי ${fx(t.originalAmount, t.originalCurrency)}` }) : null,
        el('div', { class: 'sheet-badges' }, [
          el('span', { class: `badge ${t.status === 'pending' ? 'pending' : 'done'}`, text: t.status === 'pending' ? 'ממתין לחיוב' : 'נקלט' }),
          t.installmentTotal > 1 ? el('span', { class: 'badge inst', text: `תשלום ${t.installmentNumber ?? '?'} מתוך ${t.installmentTotal}` }) : null,
        ]),
      ]),
      el('dl', { class: 'details' }, [
        detailRow('תאריך עסקה', dtLongDay.format(parseDay(t.date))),
        detailRow('תאריך חיוב', t.processedDate ? dtLongDay.format(parseDay(t.processedDate)) : null),
        detailRow('מקור', `${srcLabel(t.source)}${acct?.label ? ` · ${acct.label}` : ''}`),
        detailRow('חשבון / כרטיס', last4 ? `•••• ${last4}` : null, 'ltr'),
        detailRow('קטגוריה', t.category || 'ללא קטגוריה'),
        detailRow('הערה', t.memo),
      ]),
      el('div', { class: 'sheet-actions' }, [
        t.category ? el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { closeSheet(); state.txn.category = ''; toggleCategory(t.category); } }, `כל ה${t.category}`) : null,
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { closeSheet(); searchFor(t.description); } }, 'עסקאות דומות'),
      ]),
    );
    sheet.returnFocus = from || document.activeElement;
    const s = $('sheet'); const bd = $('sheet-backdrop');
    s.hidden = false; bd.hidden = false;
    s.style.transform = '';
    s.getBoundingClientRect(); // commit initial state so the transition runs
    document.body.classList.add('sheet-open');
    s.classList.add('open'); bd.classList.add('open');
    sheet.open = true;
    $('sheet-close').focus({ preventScroll: true });
  }

  function closeSheet() {
    if (!sheet.open) return;
    sheet.open = false;
    const s = $('sheet'); const bd = $('sheet-backdrop');
    s.style.transform = '';
    s.classList.remove('open'); bd.classList.remove('open');
    document.body.classList.remove('sheet-open');
    const done = () => { if (!sheet.open) { s.hidden = true; bd.hidden = true; } };
    if (reducedMotion) done(); else setTimeout(done, 380);
    sheet.returnFocus?.focus?.({ preventScroll: true });
  }

  function wireSheet() {
    $('sheet-close').addEventListener('click', closeSheet);
    $('sheet-backdrop').addEventListener('click', closeSheet);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
    // Swipe down to dismiss (from the grabber, or anywhere while the body is scrolled to top).
    const s = $('sheet');
    let startY = 0; let lastY = 0; let lastT = 0; let velocity = 0; let dragging = false;
    s.addEventListener('pointerdown', (e) => {
      if (!isMobile() || e.button > 0) return;
      const onGrabber = e.target.closest('#sheet-grabber');
      if (!onGrabber && ($('sheet-body').scrollTop > 0 || e.target.closest('button'))) return;
      dragging = true; startY = lastY = e.clientY; lastT = performance.now(); velocity = 0;
      s.classList.add('dragging');
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const now = performance.now();
      velocity = (e.clientY - lastY) / Math.max(1, now - lastT);
      lastY = e.clientY; lastT = now;
      const dy = Math.max(0, e.clientY - startY);
      s.style.transform = `translate3d(0, ${dy}px, 0)`;
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      s.classList.remove('dragging');
      const dy = lastY - startY;
      if (dy > 110 || velocity > 0.6) closeSheet();
      else s.style.transform = '';
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  function searchFor(q) {
    $('txn-q').value = q;
    state.txn.q = q.slice(0, 100);
    state.txn.offset = 0;
    loadTransactions();
    if (isMobile()) setTab('txns');
    else $('txn-card').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  }

  // ---------- tabs (mobile) ----------
  const TAB_TITLES = { overview: 'סקירה', txns: 'עסקאות', recurring: 'קבועים', accounts: 'חשבונות' };
  const mobileMq = window.matchMedia('(max-width: 768px)');
  const isMobile = () => mobileMq.matches;

  function setTab(tab, { instant = false } = {}) {
    if (!TAB_TITLES[tab]) tab = 'overview';
    const changed = document.body.dataset.tab !== tab;
    document.body.dataset.tab = tab;
    $('large-title-text').textContent = TAB_TITLES[tab];
    $('nav-title').textContent = TAB_TITLES[tab];
    for (const b of document.querySelectorAll('.tab')) {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    try { history.replaceState(null, '', `${location.pathname}${location.search}#${tab}`); } catch { /* ignore */ }
    if (!changed || !isMobile()) return;
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (instant || reducedMotion) return;
    const page = $('page');
    page.classList.remove('tab-in');
    void page.offsetWidth;
    page.classList.add('tab-in');
  }

  function placeMonthNav() {
    const nav = $('month-nav');
    const target = isMobile() ? $('month-slot') : $('topbar').querySelector('.topbar-inner');
    if (nav.parentElement === target) return;
    if (isMobile()) target.append(nav);
    else target.insertBefore(nav, target.querySelector('.sync'));
  }

  function measureTopbar() {
    document.documentElement.style.setProperty('--topbar-h', `${$('topbar').offsetHeight}px`);
  }

  function wireChrome() {
    for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => setTab(b.dataset.tab));
    mobileMq.addEventListener('change', () => { placeMonthNav(); measureTopbar(); if (state.overview) renderCharts(state.overview); });
    window.addEventListener('resize', measureTopbar);
    placeMonthNav();
    measureTopbar();
    setTab((location.hash || '').slice(1) || 'overview', { instant: true });

    // iOS-style large title: collapse into the nav bar once it scrolls under it.
    const io = new IntersectionObserver(([entry]) => {
      document.body.classList.toggle('compact', !entry.isIntersecting);
    }, { rootMargin: `-${$('topbar').offsetHeight}px 0px 0px 0px`, threshold: 0 });
    io.observe($('large-title-text'));

    // Card fade+rise only on first paint.
    setTimeout(() => document.body.classList.remove('intro'), 1400);
  }

  // ---------- pull to refresh ----------
  function wirePullToRefresh() {
    const ptr = $('ptr');
    const THRESHOLD = 72;
    let startY = null; let dy = 0; let busy = false;
    window.addEventListener('touchstart', (e) => {
      if (busy || !isMobile() || sheet.open || window.scrollY > 0 || e.touches.length !== 1) { startY = null; return; }
      startY = e.touches[0].clientY; dy = 0;
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (startY == null) return;
      dy = e.touches[0].clientY - startY;
      if (dy <= 0 || window.scrollY > 0) { ptr.style.transform = ''; ptr.style.opacity = ''; return; }
      const pull = Math.min(110, dy * 0.5);
      ptr.classList.add('pulling');
      ptr.style.transform = `translate3d(-50%, ${pull}px, 0) rotate(${pull * 4}deg)`;
      ptr.style.opacity = String(Math.min(1, pull / THRESHOLD));
      ptr.classList.toggle('armed', pull >= THRESHOLD * 0.75);
    }, { passive: true });
    window.addEventListener('touchend', async () => {
      if (startY == null) return;
      startY = null;
      ptr.classList.remove('pulling');
      if (dy * 0.5 < THRESHOLD * 0.75) { ptr.style.transform = ''; ptr.style.opacity = ''; return; }
      busy = true;
      ptr.classList.add('refreshing');
      ptr.style.transform = ''; ptr.style.opacity = '';
      try { await refreshAll(); } finally {
        ptr.classList.remove('refreshing', 'armed');
        busy = false;
      }
    });
  }

  async function refreshAll() {
    const o = state.overview;
    if (o?.canSync && !o.syncing) {
      startSync();
      return;
    }
    await Promise.all([loadOverview(), loadTransactions()]);
  }

  // ---------- offline / service worker ----------
  function setOffline(off) {
    $('offline-pill').hidden = !off;
  }

  function registerSw() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* non-fatal */ });
    });
  }

  // ---------- wiring ----------
  function wire() {
    $('month-prev').addEventListener('click', () => goToMonth(shiftMonth(state.month, -1)));
    $('month-next').addEventListener('click', () => goToMonth(shiftMonth(state.month, 1)));
    $('sync-btn').addEventListener('click', startSync);

    let debounce;
    $('txn-q').addEventListener('input', (e) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        state.txn.q = e.target.value.trim().slice(0, 100);
        state.txn.offset = 0;
        loadTransactions();
      }, 300);
    });
    for (const b of document.querySelectorAll('.segmented button')) {
      b.addEventListener('click', () => {
        for (const o of document.querySelectorAll('.segmented button')) o.setAttribute('aria-checked', String(o === b));
        state.txn.direction = b.dataset.dir;
        state.txn.offset = 0;
        loadTransactions();
      });
    }
    $('txn-source').addEventListener('change', (e) => {
      state.txn.source = e.target.value;
      state.txn.offset = 0;
      loadTransactions();
    });
    $('page-prev').addEventListener('click', () => {
      state.txn.offset = Math.max(0, state.txn.offset - PAGE_SIZE);
      loadTransactions();
      $('txn-card').scrollIntoView({ block: 'start' });
    });
    $('page-next').addEventListener('click', () => {
      state.txn.offset += PAGE_SIZE;
      loadTransactions();
      $('txn-card').scrollIntoView({ block: 'start' });
    });
    // Refresh relative times / data when the tab comes back into view.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !state.pollTimer) loadOverview();
    });
  }

  state.month = initialMonth();
  renderSkeletons();
  renderMonthNav();
  wire();
  wireSheet();
  wireChrome();
  wirePullToRefresh();
  registerSw();
  window.addEventListener('offline', () => setOffline(true));
  window.addEventListener('online', () => { setOffline(false); loadOverview(); loadTransactions(); });
  loadOverview();
  loadTransactions();
})();
