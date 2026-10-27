/* DashBank dashboard. All data is written via textContent / DOM APIs — never innerHTML.
 * All user-facing strings come from public/locales/*.json through window.I18N (public/i18n.js). */
(() => {
  'use strict';

  const PAGE_SIZE = 50;
  const POLL_MS = 2500;
  const $ = (id) => document.getElementById(id);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const I18N = window.I18N;
  const t = (key, vars) => I18N.t(key, vars);
  const isRtl = () => I18N.dir === 'rtl';

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

  // ---------- formatting (rebuilt on language change) ----------
  const stripBidi = (s) => s.replace(/[‎‏؜]/g, '').replace('-', '−');
  let F = {};
  function buildFormatters() {
    const loc = I18N.locale;
    const dt = (o) => new Intl.DateTimeFormat(loc, o);
    F = {
      nf0: new Intl.NumberFormat(loc, { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }),
      nf2: new Intl.NumberFormat(loc, { style: 'currency', currency: 'ILS', minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      int: new Intl.NumberFormat(loc),
      monthLong: dt({ month: 'long', year: 'numeric' }),
      monthShort: dt({ month: 'short' }),
      day: dt({ day: 'numeric', month: 'numeric' }),
      dayYear: dt({ day: 'numeric', month: 'numeric', year: '2-digit' }),
      weekday: dt({ weekday: 'long', day: 'numeric', month: 'long' }),
      longDay: dt({ weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }),
      full: dt({ dateStyle: 'medium', timeStyle: 'short' }),
      runTime: dt({ day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }),
    };
  }
  const ils = (n) => stripBidi(F.nf0.format(Math.round(n || 0)));
  const ils2 = (n) => stripBidi(F.nf2.format(n || 0));
  const fmtInt = (n) => F.int.format(n);
  const fx = (n, cur) => {
    try { return stripBidi(new Intl.NumberFormat(I18N.locale, { style: 'currency', currency: cur }).format(n)); }
    catch { return `${n} ${cur}`; }
  };
  const compact = (n) => {
    const a = Math.abs(n);
    if (a >= 1e6) return `₪${+(n / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `₪${+(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
    return `₪${Math.round(n)}`;
  };
  const pct = (n) => `${Math.abs(n) >= 10 ? Math.round(Math.abs(n)) : Math.abs(n).toFixed(1)}%`;

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
    return (d.getFullYear() === new Date().getFullYear() ? F.day : F.dayYear).format(d);
  };

  // Hand-rolled relative time from locale plurals: Chromium's ICU renders Hebrew duals oddly.
  function relTime(iso) {
    const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 60) return t('time.just_now');
    const mins = Math.round(secs / 60);
    if (mins < 60) return t('time.minutes_ago', { count: mins });
    const hours = Math.round(secs / 3600);
    if (hours < 24) return t('time.hours_ago', { count: hours });
    return t('time.days_ago', { count: Math.round(secs / 86400) });
  }
  function relDays(iso) {
    const days = Math.round((parseDay(iso) - todayStart()) / 86400000);
    if (days === 0) return t('time.today');
    if (days > 0) return t('time.in_days', { count: days });
    return t('time.days_ago', { count: -days });
  }

  function initialMonth() {
    try {
      const m = new URLSearchParams(location.search).get('month');
      if (m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return m;
    } catch { /* ignore */ }
    return currentMonth();
  }

  const srcLabel = (s) => {
    if (!s) return '—';
    const tr = I18N.term('sources', s);
    return tr !== s ? tr : (state.sourceLabels[s] || s);
  };
  const srcInitial = (s) => String(I18N.term('sources_short', s) || srcLabel(s)).trim().slice(0, 1);
  const srcKey = (s) => (KNOWN_SOURCES.has(s) ? s : 'other');
  // Category names are Hebrew data values; only their display is translated.
  const catName = (c) => I18N.term('categories', c);
  // Merchant names and other data snippets may be in a different language from the UI.
  const langOf = (s) => (/[\u0590-\u05FF]/.test(s || '') ? 'he' : /[A-Za-z]/.test(s || '') ? 'en' : null);
  const langAttr = (s) => { const l = langOf(s); return l && l !== I18N.lang ? l : null; };
  const dataText = (tag, cls, text) => el(tag, { class: cls, text, lang: langAttr(text) });

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
      el('span', { class: 'sr-only', text: `${t(up ? 'kpi.delta_up' : down ? 'kpi.delta_down' : 'kpi.delta_same')} ` }),
      document.createTextNode(up || down ? pct(change) : '0%'),
    ]);
  }

  const kpiPrev = new Map();
  function kpiTile({ id, label, value, iconName, tone, valueClass = '', foot }, i) {
    const valueNode = el('div', { class: `kpi-value ${valueClass}`.trim(), dataset: { value: String(kpiPrev.get(id) ?? 0) } });
    kpiPrev.set(id, value);
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
    const vs = () => el('span', { text: t('kpi.vs_prev') });
    const balanceAccounts = o.accounts.filter((a) => a.balance != null);
    const latest = balanceAccounts.map((a) => a.balanceDate || a.updatedAt).filter(Boolean).sort().at(-1);
    // Balance and pending are point-in-time figures (not month-scoped), so they get context, not a Δ%.
    const tiles = [
      {
        id: 'balance', label: t('kpi.balance'), value: s.balance, iconName: 'wallet', tone: 'accent', valueClass: s.balance < 0 ? 'neg' : '',
        foot: [el('span', { text: latest ? t('kpi.updated', { when: relTime(latest) }) : t('kpi.no_balance') })],
      },
      {
        id: 'income', label: t('kpi.income'), value: s.income, iconName: 'in', tone: 'pos',
        foot: [deltaChip(s.income, p.income, { higherIsGood: true }), vs()],
      },
      {
        id: 'expense', label: t('kpi.expense'), value: s.expense, iconName: 'out', tone: 'neg',
        foot: [deltaChip(s.expense, p.expense, { higherIsGood: false }), vs()],
      },
      {
        id: 'net', label: t('kpi.net'), value: s.net, iconName: 'flow', tone: s.net >= 0 ? 'pos' : 'neg', valueClass: s.net >= 0 ? 'pos' : 'neg',
        foot: [deltaChip(s.net, p.net, { higherIsGood: true }), vs()],
      },
      {
        id: 'pending', label: t('kpi.pending'), value: s.pending, iconName: 'clock', tone: 'warn',
        foot: [el('span', { text: s.pending > 0 ? t('kpi.pending_some') : t('kpi.pending_none') })],
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
      locale: I18N.locale,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false, rtl: isRtl(), textDirection: I18N.dir },
        tooltip: {
          rtl: isRtl(), textDirection: I18N.dir,
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

  function setEmpty(canvasId, empty, text = t('charts.no_data_month')) {
    const box = $(canvasId).parentElement;
    let msg = box.querySelector('.chart-empty');
    if (msg && msg.textContent !== text) { msg.remove(); msg = null; }
    if (empty && !msg) { msg = el('div', { class: 'chart-empty', text }); box.append(msg); }
    if (!empty && msg) msg.remove();
  }

  // Visually-hidden data table next to each chart, so the numbers are available without the canvas.
  function renderDataTable(id, caption, head, rows) {
    $(id).replaceChildren(
      el('caption', { text: caption }),
      el('thead', {}, el('tr', {}, head.map((h) => el('th', { scope: 'col', text: h })))),
      el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) => el(i === 0 ? 'th' : 'td', { scope: i === 0 ? 'row' : null, text: c }))))),
    );
  }
  // Charts read in the UI's direction: newest data at the inline end, value axis at the inline start.
  const xReverse = () => isRtl();
  const yPosition = () => (isRtl() ? 'right' : 'left');

  function renderMonthlyChart(o) {
    const pos = css('--pos'); const neg = css('--neg');
    // Phones get the last 6 months so the bars stay legible.
    const months = isMobile() ? o.monthly.slice(-6) : o.monthly;
    const labels = months.map((r) => F.monthShort.format(monthDate(r.month)));
    const sel = months.map((r) => r.month === o.month);
    $('monthly-sub').textContent = t('charts.monthly_sub', { count: months.length });
    const base = chartBase();
    mountChart('monthly', 'chart-monthly', {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: t('charts.income'), data: months.map((r) => r.income), backgroundColor: sel.map((s) => (s ? pos : alpha(pos, 0.42))), hoverBackgroundColor: pos },
          { label: t('charts.expense'), data: months.map((r) => r.expense), backgroundColor: sel.map((s) => (s ? neg : alpha(neg, 0.42))), hoverBackgroundColor: neg },
        ].map((d) => ({ ...d, borderRadius: 6, borderSkipped: false, maxBarThickness: 22, categoryPercentage: 0.66, barPercentage: 0.86 })),
      },
      options: {
        ...base,
        onClick: (_e, els) => { if (els.length) goToMonth(months[els[0].index].month); },
        onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        scales: {
          x: { reverse: xReverse(), grid: { display: false }, border: { display: false } },
          y: { display: !months.every((r) => !r.income && !r.expense), position: yPosition(), beginAtZero: true, border: { display: false }, grid: { color: css('--grid') }, ticks: { callback: (v) => compact(v), maxTicksLimit: 5, padding: 8 } },
        },
        plugins: {
          ...base.plugins,
          tooltip: {
            ...base.plugins.tooltip,
            callbacks: {
              title: (items) => F.monthLong.format(monthDate(months[items[0].dataIndex].month)),
              label: (ctx) => ` ${ctx.dataset.label}: ${ils(ctx.parsed.y)}`,
              footer: (items) => {
                const r = months[items[0].dataIndex];
                return t('charts.net', { amount: ils(r.income - r.expense) });
              },
            },
          },
        },
      },
    });
    setEmpty('chart-monthly', months.every((r) => !r.income && !r.expense), t('charts.no_data'));
    const cur = o.monthly.find((r) => r.month === o.month) || { income: 0, expense: 0 };
    $('chart-monthly').setAttribute('aria-label', t('charts.monthly_summary', {
      count: o.monthly.length, month: F.monthLong.format(monthDate(o.month)), income: ils(cur.income), expense: ils(cur.expense),
    }));
    renderDataTable('table-monthly', t('charts.table_monthly'),
      [t('charts.col_month'), t('charts.col_income'), t('charts.col_expense'), t('charts.col_net')],
      o.monthly.map((r) => [F.monthLong.format(monthDate(r.month)), ils(r.income), ils(r.expense), ils(r.income - r.expense)]));
  }

  function categoryGroups(cats) {
    if (cats.length <= MAX_CATS + 1) return cats.map((c) => ({ ...c, filterable: true }));
    const top = cats.slice(0, MAX_CATS).map((c) => ({ ...c, filterable: true }));
    const rest = cats.slice(MAX_CATS);
    top.push({ category: null, label: t('charts.other_categories'), total: rest.reduce((a, c) => a + c.total, 0), count: rest.reduce((a, c) => a + c.count, 0), filterable: false });
    return top;
  }
  const groupName = (g) => g.label || catName(g.category);

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
        labels: groups.map(groupName),
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

    const canvas = $('chart-categories');
    canvas.setAttribute('aria-label', groups.length
      ? t('charts.categories_summary', { total: ils(total), top: groups.slice(0, 3).map((g) => `${groupName(g)} ${ils(g.total)}`).join(', ') })
      : t('charts.categories_summary_empty'));
    renderDataTable('table-categories', t('charts.table_categories'),
      [t('charts.col_category'), t('charts.col_amount'), t('charts.col_share')],
      groups.map((g) => [groupName(g), ils(g.total), pct((g.total / total) * 100)]));

    const list = $('cat-list');
    if (!groups.length) {
      list.replaceChildren(el('li', { class: 'empty empty-li', text: t('charts.no_expenses') }));
      return;
    }
    list.replaceChildren(...groups.map((g, i) => el('li', {}, el('button', {
      type: 'button',
      class: `cat-item${active === g.category ? ' active' : ''}`,
      disabled: !g.filterable,
      'aria-pressed': g.filterable ? String(active === g.category) : null,
      title: g.filterable ? t('charts.filter_by', { category: groupName(g) }) : null,
      onclick: () => g.filterable && toggleCategory(g.category),
    }, [
      el('i', { class: 'sw', style: `background:${colors[i]}` }),
      el('span', { class: 'cat-name', text: groupName(g) }),
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
    const curName = F.monthLong.format(monthDate(o.month)); const prevName = F.monthLong.format(monthDate(prevM));
    $('cum-sub').textContent = t('charts.cumulative_vs', { cur: curName, prev: prevName });
    mountChart('daily', 'chart-daily', {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: t('charts.this_month'), data: cur, borderColor: accent, borderWidth: 2.5, tension: 0.3, pointRadius: 0, pointHoverRadius: 4,
            pointBackgroundColor: accent, fill: 'origin',
            backgroundColor: (ctx) => {
              const { chart } = ctx; const area = chart.chartArea;
              if (!area) return alpha(accent, 0.1);
              const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
              g.addColorStop(0, alpha(accent, 0.22)); g.addColorStop(1, alpha(accent, 0));
              return g;
            },
          },
          { label: t('charts.prev_month'), data: prev, borderColor: muted, borderWidth: 2, borderDash: [5, 5], tension: 0.3, pointRadius: 0, pointHoverRadius: 3, pointBackgroundColor: muted, fill: false },
        ],
      },
      options: {
        ...base,
        scales: {
          x: { reverse: xReverse(), offset: false, grid: { display: false }, border: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 14, align: 'inner' } },
          y: { display: Boolean(o.daily.length || o.prevDaily.length), position: yPosition(), beginAtZero: true, border: { display: false }, grid: { color: css('--grid') }, ticks: { callback: (v) => compact(v), maxTicksLimit: 5, padding: 8 } },
        },
        plugins: {
          ...base.plugins,
          tooltip: {
            ...base.plugins.tooltip,
            filter: (item) => item.parsed.y != null,
            callbacks: {
              title: (items) => t('charts.day_of_month', { day: items[0].label }),
              label: (ctx) => ` ${ctx.dataset.label}: ${ils(ctx.parsed.y)}`,
            },
          },
        },
      },
    });
    setEmpty('chart-daily', !o.daily.length && !o.prevDaily.length);
    const last = (arr) => arr.filter((v) => v != null).at(-1) ?? 0;
    $('chart-daily').setAttribute('aria-label', t('charts.daily_summary', { cur: curName, curTotal: ils(last(cur)), prev: prevName, prevTotal: ils(last(prev)) }));
    renderDataTable('table-daily', t('charts.table_daily'),
      [t('charts.col_day'), curName, prevName],
      labels.map((d, i) => [d, cur[i] == null ? '—' : ils(cur[i]), prev[i] == null ? '—' : ils(prev[i])]));
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
    $('accounts-sub').textContent = o.accounts.length ? t('accounts.count', { count: o.accounts.length }) : t('accounts.none');
    if (!o.accounts.length) {
      list.replaceChildren(el('li', { class: 'empty empty-li', text: t('accounts.empty') }));
      return;
    }
    list.replaceChildren(...o.accounts.map((a) => {
      const label = srcLabel(a.source);
      const last4 = String(a.accountNumber || '').slice(-4);
      const hasBal = a.balance != null;
      // Default account labels are the server's (Hebrew) source names: show those translated.
      const name = a.label && a.label !== state.sourceLabels[a.source] ? a.label : label;
      return el('li', { class: 'account' }, [
        el('span', { class: 'acc-logo', dataset: { src: srcKey(a.source) }, text: srcInitial(a.source), 'aria-hidden': 'true' }),
        el('div', { style: 'min-width:0' }, [
          el('div', { class: 'acc-name', text: name, lang: langAttr(name) }),
          el('div', { class: 'acc-meta' }, [
            el('span', { text: label }),
            last4 ? el('span', { text: '·', 'aria-hidden': 'true' }) : null,
            last4 ? el('span', { class: 'last4', text: `•••• ${last4}` }) : null,
          ]),
        ]),
        hasBal
          ? el('span', { class: `acc-bal${a.balance < 0 ? ' neg' : ''}`, text: ils(a.balance) })
          : el('span', { class: 'acc-bal acc-spend' }, [
            el('span', { text: ils(a.monthSpend || 0) }),
            el('small', { class: 'acc-spend-label', text: t('accounts.month_charges') }),
          ]),
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
      body.replaceChildren(el('tr', {}, el('td', { colspan: '4', class: 'empty', text: t('recurring.empty') })));
      return;
    }
    body.replaceChildren(...items.map((r) => {
      const kindKey = ['standing_order', 'subscription', 'income', 'recurring'].includes(r.kind) ? r.kind : 'recurring';
      const kind = el('span', { class: r.inactive ? 'badge inactive' : `badge k-${r.kind || 'recurring'}`, text: r.inactive ? t('recurring.inactive') : I18N.term('kinds', kindKey) });
      return el('tr', { class: r.inactive ? 'inactive' : null }, [
        el('td', {}, [
          dataText('div', 'desc', r.description),
          el('div', { class: 'meta' }, [
            el('span', { class: 'kind-inline' }, kind.cloneNode(true)),
            el('span', { class: 'src-pill' }, [el('i', { class: 'src-dot', dataset: { src: srcKey(r.source) } }), document.createTextNode(srcLabel(r.source))]),
            el('span', { text: '·', 'aria-hidden': 'true' }),
            el('span', { text: `${I18N.term('cadences', r.cadence) || ''} · ${t('recurring.charges', { count: r.count })}` }),
            r.nextDate && !r.inactive ? el('span', { class: 'next-inline', text: `· ${t('recurring.next', { when: relDays(r.nextDate) })}` }) : null,
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
      list.replaceChildren(el('li', { class: 'empty empty-li', text: t('synclog.empty') }));
      return;
    }
    list.replaceChildren(...o.syncRuns.map((r) => {
      const label = r.label && r.label !== state.sourceLabels[r.source] ? r.label : srcLabel(r.source);
      const err = r.error || t('synclog.unknown_error');
      return el('li', { class: 'run' }, [
        el('span', { class: `run-icon ${r.ok ? 'ok' : 'err'}`, role: 'img', 'aria-label': r.ok ? t('synclog.ok') : t('synclog.failed') }, icon(r.ok ? ICONS.check : ICONS.x)),
        el('div', { style: 'min-width:0' }, [
          el('div', { class: 'run-title', text: r.label ? `${srcLabel(r.source)} · ${label}` : srcLabel(r.source) }),
          r.ok
            ? el('div', { class: 'run-new', text: r.newCount ? t('synclog.new', { count: r.newCount }) : t('synclog.none') })
            : el('div', { class: 'run-err', text: err, lang: langAttr(err) }),
        ]),
        el('span', { class: 'run-time', title: F.full.format(new Date(r.startedAt)), text: F.runTime.format(new Date(r.startedAt)) }),
      ]);
    }));
  }

  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

  function renderSyncStatus(o) {
    const dot = $('sync-dot'); const text = $('sync-text'); const btn = $('sync-btn');
    const last = o.syncRuns[0];
    if (o.syncing) {
      dot.className = 'dot busy';
      setText(text, t('sync.syncing'));
    } else if (last) {
      const batch = o.syncRuns.filter((r) => Math.abs(new Date(r.startedAt) - new Date(last.startedAt)) < 10 * 60 * 1000);
      const failed = batch.some((r) => !r.ok);
      const when = relTime(last.finishedAt || last.startedAt);
      dot.className = `dot ${failed ? 'err' : 'ok'}`;
      setText(text, failed ? t('sync.partial', { when }) : t('sync.synced', { when }));
      $('sync-status').title = t('sync.last', { when: F.full.format(new Date(last.finishedAt || last.startedAt)) });
    } else {
      dot.className = 'dot';
      setText(text, t('sync.never'));
    }
    btn.classList.toggle('loading', Boolean(o.syncing));
    btn.disabled = Boolean(o.syncing) || !o.canSync;
    btn.title = o.demo ? t('sync.disabled_demo') : !o.canSync ? t('sync.unavailable') : '';
    $('demo-banner').hidden = !o.demo;
  }

  async function startSync() {
    const btn = $('sync-btn');
    btn.disabled = true; btn.classList.add('loading');
    try {
      await api('api/sync', { method: 'POST' });
      toast(t('sync.started'));
    } catch (err) {
      if (err.status !== 409) {
        toast(err.status === 400 ? t('sync.unavailable') : t('sync.failed'), true);
        btn.classList.remove('loading');
        btn.disabled = !state.overview?.canSync;
        return;
      }
      toast(t('sync.already'));
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
          toast(failed ? t('sync.done_errors') : t('sync.done'), failed);
        }
      } catch {
        pollSync(announce);
      }
    }, POLL_MS);
  }

  // ---------- insights (BI) ----------
  function renderInsights(o) {
    const ins = o.insights;
    if (!ins) return;
    const na = t('insights.none');
    const metric = (label, value, hint) => el('div', { class: 'insight-metric' }, [
      el('span', { class: 'insight-label', text: label }),
      el('strong', { class: 'insight-value num', text: value }),
      el('span', { class: 'insight-hint', text: hint }),
    ]);
    $('insight-metrics').replaceChildren(
      metric(t('insights.savings_rate'), ins.savingsRate == null ? na : `${ins.savingsRate}%`, t('insights.savings_rate_hint')),
      metric(t('insights.avg_daily'), ils(ins.avgDailySpend), t('insights.avg_daily_hint')),
      metric(t('insights.projected'), ins.projectedSpend == null ? '—' : ils(ins.projectedSpend), t('insights.projected_hint')),
      metric(t('insights.fixed_share'), ins.fixedShare == null ? na : `${ins.fixedShare}%`, `${ils(ins.fixedMonthly)} · ${t('insights.fixed_hint')}`),
      metric(t('insights.top_category'), ins.topCategory ? catName(ins.topCategory.category) : na, ins.topCategory ? `${ins.topCategory.share ?? 0}% ${t('insights.share_of_spend')}` : ''),
    );
    const merchants = ins.topMerchants || [];
    $('insight-merchants').replaceChildren(...(merchants.length
      ? merchants.map((m) => el('li', {}, [
        el('span', { class: 'insight-name', text: m.description }),
        el('span', { class: 'insight-amt num', text: ils(m.total) }),
        el('span', { class: 'insight-hint', text: m.count === 1 ? t('insights.merchant_one') : t('insights.merchant_count', { n: m.count }) }),
      ]))
      : [el('li', { class: 'empty', text: na })]));
    const incs = ins.increases || [];
    $('insight-increases').replaceChildren(...(incs.length
      ? incs.map((c) => el('li', {}, [
        el('span', { class: 'insight-name', text: catName(c.category) }),
        el('span', { class: 'insight-amt num', text: `+${pct(c.changePct)}` }),
        el('span', { class: 'insight-hint', text: t('insights.was_now', { from: ils(c.before), to: ils(c.total) }) }),
      ]))
      : [el('li', { class: 'empty', text: t('insights.increases_none') })]));
  }

  // ---------- overview ----------
  function applyOverview(o) {
    state.overview = o;
    state.sourceLabels = o.sourceLabels || {};
    renderKpis(o);
    renderInsights(o);
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
      if (seq === state.seq.overview) toast(t('errors.load_overview', { msg: err.message }), true);
    }
  }

  function renderMonthNav() {
    $('month-label').textContent = F.monthLong.format(monthDate(state.month));
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
    sel.replaceChildren(el('option', { value: '', text: t('txns.all_sources') }), ...list.map((s) => el('option', { value: s, text: srcLabel(s) })));
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
    chips.replaceChildren(...(c ? [el('button', { type: 'button', class: 'chip', title: t('txns.remove_filter'), onclick: () => toggleCategory(c) }, [
      el('span', { text: t('txns.chip_category', { category: catName(c) }) }),
      el('span', { class: 'sr-only', text: ` (${t('txns.remove_filter')})` }),
      icon(ICONS.x),
    ])] : []));
  }

  function txnParams() {
    const { from, to } = monthRange(state.month);
    const params = new URLSearchParams({ from, to });
    for (const k of ['q', 'direction', 'source', 'category']) if (state.txn[k]) params.set(k, state.txn[k]);
    return params;
  }

  function updateExportLink() {
    const params = txnParams();
    params.set('lang', I18N.lang);
    $('txn-export').href = `api/transactions.csv?${params}`;
    $('txn-export').setAttribute('download', `dashbank-${state.month}.csv`);
  }

  async function loadTransactions() {
    const seq = ++state.seq.txn;
    const params = txnParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(state.txn.offset));
    renderChips();
    updateExportLink();
    const body = $('txn-list');
    body.classList.add('loading-rows');
    try {
      const r = await api(`api/transactions?${params}`);
      if (seq !== state.seq.txn) return;
      state.lastTxn = r;
      renderTransactions(r);
    } catch (err) {
      if (seq === state.seq.txn) toast(t('errors.load_txns', { msg: err.message }), true);
    } finally {
      if (seq === state.seq.txn) body.classList.remove('loading-rows');
    }
  }

  function dayHeading(iso) {
    const d = parseDay(iso);
    const diff = Math.round((todayStart() - d) / 86400000);
    if (diff === 0) return t('txns.today');
    if (diff === 1) return t('txns.yesterday');
    return F.weekday.format(d);
  }

  function renderTransactions({ rows, total }) {
    const body = $('txn-list');
    const filtered = Boolean(state.txn.q || state.txn.direction || state.txn.source || state.txn.category);
    $('txn-sub').textContent = `${t('txns.count', { count: total, month: F.monthLong.format(monthDate(state.month)) })}${filtered ? t('txns.filtered') : ''}`;
    if (!rows.length) {
      body.replaceChildren(el('div', { class: 'empty', text: filtered ? t('txns.empty_filtered') : t('txns.empty') }));
    } else {
      const groups = new Map();
      for (const tx of rows) {
        const key = String(tx.date).slice(0, 10);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(tx);
      }
      body.replaceChildren(...[...groups].map(([day, items]) => {
        const net = items.reduce((a, tx) => a + (Number(tx.amount) || 0), 0);
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
    $('pager-info').textContent = total ? t('txns.pager', { start: fmtInt(start), end: fmtInt(end), total: fmtInt(total) }) : '';
    $('page-prev').disabled = state.txn.offset === 0;
    $('page-next').disabled = state.txn.offset + PAGE_SIZE >= total;
    $('pager').hidden = total <= PAGE_SIZE;
  }

  const isForeign = (tx) => tx.originalCurrency && tx.originalCurrency !== 'ILS' && tx.originalCurrency !== tx.currency;
  const signedIls2 = (n) => `${n > 0 ? '+' : ''}${ils2(n)}`;

  function txnRow(tx) {
    const meta = [];
    if (tx.category) meta.push(el('span', { class: 'meta-cat', text: catName(tx.category) }));
    meta.push(el('span', { class: 'src-pill src-inline' }, [el('i', { class: 'src-dot', dataset: { src: srcKey(tx.source) } }), document.createTextNode(srcLabel(tx.source))]));
    if (tx.status === 'pending') meta.push(el('span', { class: 'badge pending', text: t('txns.pending') }));
    if (tx.installmentTotal > 1) meta.push(el('span', { class: 'badge inst', title: t('txns.installments'), text: `${tx.installmentNumber ?? '?'}/${tx.installmentTotal}` }));
    const amount = Number(tx.amount) || 0;
    const initial = (tx.description || '?').trim().slice(0, 1);
    return el('button', { type: 'button', class: 'txn-row', 'aria-haspopup': 'dialog', onclick: (e) => openSheet(tx, e.currentTarget) }, [
      el('span', { class: 'txn-avatar', dataset: { src: srcKey(tx.source) }, text: initial, 'aria-hidden': 'true' }),
      el('span', { class: 'txn-main' }, [dataText('span', 'desc', tx.description), el('span', { class: 'meta' }, meta)]),
      el('span', { class: 'txn-cat' }, [
        el('i', { class: 'cat-dot', style: `background:${state.catColor?.get(tx.category) || 'var(--cat-9)'}` }),
        document.createTextNode(tx.category ? catName(tx.category) : t('txns.no_category')),
      ]),
      el('span', { class: 'txn-src' }, el('span', { class: 'src-pill' }, [el('i', { class: 'src-dot', dataset: { src: srcKey(tx.source) } }), document.createTextNode(srcLabel(tx.source))])),
      el('span', { class: `txn-amt ${amount > 0 ? 'pos' : ''}` }, [
        el('span', { text: signedIls2(amount) }),
        isForeign(tx) ? el('span', { class: 'fx', text: fx(tx.originalAmount, tx.originalCurrency) }) : null,
      ]),
    ]);
  }

  // ---------- bottom sheet ----------
  const sheet = { open: false, returnFocus: null, txn: null };

  function detailRow(label, value, cls = '') {
    if (value == null || value === '') return null;
    return el('div', { class: 'd-row' }, [el('dt', { text: label }), el('dd', { class: cls, lang: typeof value === 'string' ? langAttr(value) : null }, value)]);
  }

  function renderSheetBody(tx) {
    const amount = Number(tx.amount) || 0;
    const acct = state.overview?.accounts.find((a) => a.source === tx.source && a.accountNumber === tx.accountNumber);
    const acctLabel = acct?.label && acct.label !== state.sourceLabels[acct.source] ? acct.label : (acct ? srcLabel(acct.source) : '');
    const last4 = String(tx.accountNumber || '').slice(-4);
    $('sheet-body').replaceChildren(
      el('div', { class: 'sheet-hero' }, [
        el('span', { class: 'txn-avatar lg', dataset: { src: srcKey(tx.source) }, text: (tx.description || '?').trim().slice(0, 1), 'aria-hidden': 'true' }),
        el('h2', { id: 'sheet-title', class: 'sheet-title', text: tx.description, lang: langAttr(tx.description) }),
        el('div', { class: `sheet-amount ${amount > 0 ? 'pos' : ''}`, text: signedIls2(amount) }),
        isForeign(tx) ? el('div', { class: 'sheet-fx', text: t('sheet.original_amount', { amount: fx(tx.originalAmount, tx.originalCurrency) }) }) : null,
        el('div', { class: 'sheet-badges' }, [
          el('span', { class: `badge ${tx.status === 'pending' ? 'pending' : 'done'}`, text: tx.status === 'pending' ? t('sheet.pending') : t('sheet.completed') }),
          tx.installmentTotal > 1 ? el('span', { class: 'badge inst', text: t('sheet.installment', { n: tx.installmentNumber ?? '?', total: tx.installmentTotal }) }) : null,
        ]),
      ]),
      el('dl', { class: 'details' }, [
        detailRow(t('sheet.date'), F.longDay.format(parseDay(tx.date))),
        detailRow(t('sheet.processed'), tx.processedDate ? F.longDay.format(parseDay(tx.processedDate)) : null),
        detailRow(t('sheet.source'), `${srcLabel(tx.source)}${acct?.label ? ` · ${acctLabel}` : ''}`),
        detailRow(t('sheet.account'), last4 ? `•••• ${last4}` : null, 'ltr'),
        detailRow(t('sheet.category'), tx.category ? catName(tx.category) : t('txns.no_category')),
        detailRow(t('sheet.memo'), tx.memo),
      ]),
      el('div', { class: 'sheet-actions' }, [
        tx.category ? el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { closeSheet(); state.txn.category = ''; toggleCategory(tx.category); } }, t('sheet.all_in_category', { category: catName(tx.category) })) : null,
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { closeSheet(); searchFor(tx.description); } }, t('sheet.similar')),
      ]),
    );
  }

  // Everything outside the dialog is made inert while it is open (focus can't escape, AT ignores it).
  const backgroundNodes = () => [...document.body.children].filter((n) => n.id !== 'sheet' && n.id !== 'sheet-backdrop' && n.tagName !== 'SCRIPT');

  function openSheet(tx, from) {
    sheet.txn = tx;
    renderSheetBody(tx);
    sheet.returnFocus = from || document.activeElement;
    const s = $('sheet'); const bd = $('sheet-backdrop');
    s.hidden = false; bd.hidden = false;
    s.style.transform = '';
    s.getBoundingClientRect(); // commit initial state so the transition runs
    document.body.classList.add('sheet-open');
    s.classList.add('open'); bd.classList.add('open');
    sheet.open = true;
    for (const n of backgroundNodes()) n.inert = true;
    $('sheet-close').focus({ preventScroll: true });
  }

  function closeSheet() {
    if (!sheet.open) return;
    sheet.open = false;
    const s = $('sheet'); const bd = $('sheet-backdrop');
    s.style.transform = '';
    s.classList.remove('open'); bd.classList.remove('open');
    document.body.classList.remove('sheet-open');
    for (const n of backgroundNodes()) n.inert = false;
    const done = () => { if (!sheet.open) { s.hidden = true; bd.hidden = true; } };
    if (reducedMotion) done(); else setTimeout(done, 380);
    sheet.returnFocus?.focus?.({ preventScroll: true });
  }

  function wireSheet() {
    $('sheet-close').addEventListener('click', closeSheet);
    $('sheet-backdrop').addEventListener('click', closeSheet);
    document.addEventListener('keydown', (e) => {
      if (!sheet.open) return;
      if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
      if (e.key !== 'Tab') return;
      // Focus trap (backup for browsers without `inert`).
      const box = $('sheet');
      const items = [...box.querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])')].filter((n) => !n.disabled && n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      const inside = box.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
    });
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
  const TABS = ['overview', 'txns', 'recurring', 'accounts'];
  const mobileMq = window.matchMedia('(max-width: 768px)');
  const isMobile = () => mobileMq.matches;

  function setTab(tab, { instant = false } = {}) {
    if (!TABS.includes(tab)) tab = 'overview';
    const changed = document.body.dataset.tab !== tab;
    document.body.dataset.tab = tab;
    $('large-title-text').textContent = t(`tabs.${tab}`);
    $('nav-title').textContent = t(`tabs.${tab}`);
    for (const b of document.querySelectorAll('.tab')) {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
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
    // Tabs: arrow keys move + activate (direction-aware), Home/End jump.
    rovingKeys($('tabbar'), '.tab', (b) => setTab(b.dataset.tab));
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
      // Keep the spinner up briefly so the gesture always gets visible feedback.
      try { await Promise.all([refreshAll(), new Promise((r) => setTimeout(r, 700))]); } finally {
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
    document.body.classList.toggle('offline', off);
    const btn = $('sync-btn');
    if (off) btn.disabled = true;
    else if (state.overview) btn.disabled = Boolean(state.overview.syncing) || !state.overview.canSync;
  }

  function registerSw() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    const register = () => navigator.serviceWorker.register('sw.js').catch(() => { /* non-fatal */ });
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register);
  }

  // ---------- keyboard: roving focus for tablist / radiogroup ----------
  // Arrow keys follow the reading direction: in RTL, ArrowLeft moves to the next item.
  function rovingKeys(container, selector, activate) {
    container.addEventListener('keydown', (e) => {
      const items = [...container.querySelectorAll(selector)];
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      const next = isRtl() ? 'ArrowLeft' : 'ArrowRight';
      const prev = isRtl() ? 'ArrowRight' : 'ArrowLeft';
      let j = null;
      if (e.key === next || e.key === 'ArrowDown') j = (i + 1) % items.length;
      else if (e.key === prev || e.key === 'ArrowUp') j = (i - 1 + items.length) % items.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = items.length - 1;
      if (j == null) return;
      e.preventDefault();
      items[j].focus();
      activate(items[j]);
    });
  }

  function setDirection(b) {
    for (const o of document.querySelectorAll('.segmented button')) {
      o.setAttribute('aria-checked', String(o === b));
      o.tabIndex = o === b ? 0 : -1;
    }
    state.txn.direction = b.dataset.dir;
    state.txn.offset = 0;
    loadTransactions();
  }

  // ---------- language ----------
  function renderLangButton() {
    const target = t('lang.toggle_target');
    $('lang-short').lang = target;
    $('lang-name').lang = target;
  }

  function onLanguageChange() {
    buildFormatters();
    renderLangButton();
    setTab(document.body.dataset.tab, { instant: true });
    renderMonthNav();
    if (state.overview) applyOverview(state.overview);
    else renderSkeletons();
    if (state.lastTxn) renderTransactions(state.lastTxn);
    renderChips();
    updateExportLink();
    if (sheet.open && sheet.txn) renderSheetBody(sheet.txn);
    measureTopbar();
  }

  // ---------- wiring ----------
  function wire() {
    $('lang-btn').addEventListener('click', async () => {
      try { await I18N.toggle(); } catch { /* keep current language */ }
    });
    document.addEventListener('i18n:change', onLanguageChange);
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
    for (const b of document.querySelectorAll('.segmented button')) b.addEventListener('click', () => setDirection(b));
    rovingKeys(document.querySelector('.segmented'), 'button', setDirection);
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
  I18N.ready.then(() => {
    buildFormatters();
    renderLangButton();
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
  });
})();
