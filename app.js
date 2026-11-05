/* FOMO Desk · STEP 8 · the iPhone web app.
   Plan B (static JSON on GitHub Pages): open once as {URL}#d={DATA_PATH}; the path is kept in
   localStorage and every 15s the app polls ./d/{DATA_PATH}/*.json (same origin, relative URLs).
   Plan A (local FastAPI): open as {URL}#t={APP_TOKEN}; calls ./api/* with X-App-Token.
   No SSE on Plan B, no web push POST on Plan B, no order placement anywhere: every FOMO
   button uses a URL that came in the payload (built by links.py on the desk). */
(function () {
  'use strict';

  var POLL_MS = 15000;
  var STALE_S = 180;               // published data older than this = desk offline
  var LS_DP = 'fomo.dataPath', LS_T = 'fomo.appToken', LS_CACHE = 'fomo.lastGood.v1', LS_SEEN = 'fomo.seenTs';
  var AGENTS = ['scanner', 'auditor', 'analyst', 'executor', 'risk'];
  var AG = {
    scanner: { title: 'Scanner', color: 'var(--cyan)' },
    auditor: { title: 'Auditor', color: 'var(--text)' },
    analyst: { title: 'Analyst', color: 'var(--yellow)' },
    executor: { title: 'Executor', color: 'var(--green)' },
    risk: { title: 'Risk', color: 'var(--pink)' }
  };
  var RANGES = ['LIVE', '1H', '4H', '1D', '1W', 'ALL'];
  var reduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  function reduced() { return !!reduceMQ.matches; }

  /* ------------------------------------------------------------ pure helpers (unit-testable) */
  function parseHash(hash) {
    var out = {};
    String(hash || '').replace(/^#/, '').split('&').forEach(function (kv) {
      var i = kv.indexOf('='); if (i < 1) return;
      var k = kv.slice(0, i), v = decodeURIComponent(kv.slice(i + 1));
      if ((k === 'd' || k === 't') && /^[A-Za-z0-9_-]{8,200}$/.test(v)) out[k] = v;
    });
    return out;
  }
  function safeMint(m) { return String(m || '').replace(/[^A-Za-z0-9]/g, ''); }
  function isMintLike(q) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(q || '').trim()); }
  function num(v) { return v == null || v === '' || !isFinite(+v) ? null : +v; }
  function money(v, dp) {
    v = num(v); if (v == null) return 'n/a';
    dp = dp == null ? 2 : dp;
    var s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    return (v < 0 ? '-$' : '$') + s;
  }
  function compact(v) {
    v = num(v); if (v == null) return 'n/a';
    var a = Math.abs(v);
    if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return money(v);
  }
  function pct(v, dp) {
    v = num(v); if (v == null) return 'n/a';
    return (v > 0 ? '+' : v < 0 ? '-' : '') + Math.abs(v).toFixed(dp == null ? 2 : dp) + '%';
  }
  function price(v) { v = num(v); return v == null ? 'n/a' : '$' + window.FDChart.fmtP(v); }
  function hhmm(ts) {
    if (!ts) return '\u2014';
    var d = new Date(ts * 1000);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function short(m) { m = String(m || ''); return m.length > 10 ? m.slice(0, 4) + '\u2026' + m.slice(-4) : m; }
  function dur(sec) {
    if (sec == null) return 'n/a';
    if (sec <= 0) return 'now';
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h ? h + 'h ' + m + 'm' : m + 'm';
  }
  function ageText(h) {
    h = num(h); if (h == null) return null;
    if (h < 1) return Math.max(1, Math.round(h * 60)) + 'm old';
    if (h < 48) return Math.round(h) + 'h old';
    return Math.round(h / 24) + 'd old';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeUrl(u) { return /^https:\/\//i.test(String(u || '')) ? String(u) : null; }
  function firstPart(v) { return String(v == null ? '' : v).split(' \u00b7 ')[0]; }
  function nameFromTitle(t) { return String(t || '').replace(/^(Bought|Sold|Stopped|Rejected)\s+/, ''); }
  /* Chart mark text per spec: "Bought X" blue, "+$N" green, "-{stop_pct}% · -$N" red. */
  function markText(m, stopPct) {
    if (m.kind === 'bought') return m.label || 'Bought';
    if (m.kind === 'sold') return firstPart(m.value) || m.label || 'Sold';
    var v = firstPart(m.value);
    if (stopPct != null && v) return '-' + (+stopPct) + '% \u00b7 ' + v;
    return v || m.label || 'Stopped';
  }
  function unreadCount(rows, seenTs, pushRejects) {
    return (rows || []).filter(function (r) {
      return r.ts > (seenTs || 0) && (r.kind !== 'rejected' || pushRejects);
    }).length;
  }

  /* ------------------------------------------------------------ data source */
  var src = null;
  function initSource() {
    var h = parseHash(location.hash);
    try {
      if (h.d) { localStorage.setItem(LS_DP, h.d); localStorage.removeItem(LS_T); }
      if (h.t) { localStorage.setItem(LS_T, h.t); }
    } catch (e) { /* private mode: keep in memory only */ }
    var dp = h.d || lsGet(LS_DP), tok = h.t || lsGet(LS_T);
    // Keep the #d= fragment only while in Safari so "Add to Home Screen" captures it; the
    // home-screen app has its own storage on iOS. Never shown or rendered in the page.
    if (h.t && history.replaceState) history.replaceState(null, '', location.pathname + location.search);
    if (dp) {
      var base = './d/' + encodeURIComponent(dp) + '/';
      src = {
        plan: 'B', writable: false,
        state: base + 'state.json',
        chart: function (r) { return r === 'LIVE' ? base + 'chart.json' : base + 'chart/' + r + '.json'; },
        activity: base + 'activity.json',
        account: base + 'account.json',
        settings: base + 'settings.json',
        decisions: function (n) { return base + 'agents/' + n + '.json'; },
        coin: function (m) { return base + 'coin/' + safeMint(m) + '.json'; },
        audit: function (m) { return base + 'audit/' + safeMint(m) + '.json'; }
      };
    } else if (tok) {
      src = {
        plan: 'A', writable: true, token: tok,
        state: './api/state',
        chart: function (r) { return './api/chart?range=' + encodeURIComponent(r); },
        activity: './api/activity',
        account: './api/account',
        settings: './api/settings',
        decisions: function (n) { return './api/agents/' + n + '/decisions'; },
        coin: function (m) { return './api/coin/' + encodeURIComponent(m); },
        audit: function (m) { return './api/audit/' + encodeURIComponent(m); }
      };
    }
    return src;
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* quota */ } }

  function getJSON(url) {
    var u = url;
    var opt = { cache: 'no-store', credentials: 'same-origin', headers: {} };
    if (src.plan === 'B') u += (u.indexOf('?') < 0 ? '?' : '&') + '_=' + Date.now();
    else opt.headers['X-App-Token'] = src.token;
    return fetch(u, opt).then(function (r) {
      if (r.status === 404) return { __missing: true };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function postJSON(url, body) {
    if (!src || !src.writable) return Promise.reject(new Error('read-only'));
    return fetch(url, {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-App-Token': src.token },
      body: JSON.stringify(body || {})
    }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  /* ------------------------------------------------------------ store */
  var S = {
    state: null, chart: {}, activity: null, account: null, settings: null,
    decisions: {}, coins: {}, audits: {},
    range: 'LIVE', tab: 'home',
    lastOkMs: null, dataTs: null, offline: false, nextPollAt: 0, everLoaded: false
  };
  function saveCache() {
    lsSet(LS_CACHE, JSON.stringify({
      state: S.state, chart: { LIVE: S.chart.LIVE || null }, activity: S.activity,
      account: S.account, settings: S.settings, decisions: S.decisions, lastOkMs: S.lastOkMs
    }));
  }
  function loadCache() {
    try {
      var c = JSON.parse(lsGet(LS_CACHE) || 'null'); if (!c || !c.state) return false;
      S.state = c.state; S.chart = c.chart || {}; S.activity = c.activity; S.account = c.account;
      S.settings = c.settings; S.decisions = c.decisions || {}; S.lastOkMs = c.lastOkMs || null;
      S.dataTs = c.state.ts || null; S.everLoaded = true; S.offline = true;   // stays "offline" until a fresh poll lands
      return true;
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------------ polling */
  var pollTimer = null, inFlight = false;
  function poll() {
    if (!src || inFlight) return;
    inFlight = true;
    clearTimeout(pollTimer);
    var jobs = [
      getJSON(src.state), getJSON(src.chart(S.range)), getJSON(src.activity),
      getJSON(src.account), getJSON(src.settings)
    ];
    AGENTS.forEach(function (n) { jobs.push(getJSON(src.decisions(n))); });
    var openMint = sheetState && sheetState.mint;
    if (openMint) { jobs.push(getJSON(src.coin(openMint))); jobs.push(getJSON(src.audit(openMint))); }
    Promise.allSettled(jobs).then(function (res) {
      var st = res[0];
      if (st.status === 'fulfilled' && st.value && !st.value.__missing && st.value.ok !== false) {
        S.state = st.value; S.dataTs = st.value.ts || null; S.lastOkMs = Date.now(); S.everLoaded = true;
        var ok = function (i) { return res[i].status === 'fulfilled' && res[i].value && !res[i].value.__missing ? res[i].value : null; };
        var ch = ok(1); if (ch) S.chart[S.range] = ch;
        else if (S.range !== 'LIVE' && res[1].status === 'fulfilled') S.chart[S.range] = { __missing: true };
        if (ok(2)) S.activity = ok(2);
        if (ok(3)) S.account = ok(3);
        if (ok(4)) S.settings = ok(4);
        AGENTS.forEach(function (n, i) { var d = ok(5 + i); if (d) S.decisions[n] = d; });
        if (openMint) {
          var ci = 5 + AGENTS.length;
          if (res[ci].status === 'fulfilled') S.coins[openMint] = res[ci].value;
          if (res[ci + 1].status === 'fulfilled') S.audits[openMint] = res[ci + 1].value;
        }
        S.offline = !!(S.dataTs && (Date.now() / 1000 - S.dataTs) > STALE_S);
        saveCache();
        fetchAuditorLatest();
      } else {
        S.offline = true;   // keep the last good numbers on screen
      }
      inFlight = false;
      S.nextPollAt = Date.now() + POLL_MS;
      pollTimer = setTimeout(poll, POLL_MS);
      renderAll();
    });
  }
  // the Auditor card shows the latest coin's 8 layers: fetch that audit once per new mint
  function fetchAuditorLatest() {
    var d = S.decisions.auditor, m = d && d.decisions && d.decisions[0] && d.decisions[0].mint;
    if (!m) return;
    getJSON(src.audit(m)).then(function (a) { if (a && !a.__missing) { S.audits[m] = a; renderHomeAgents(); } }).catch(function () {});
  }

  /* ------------------------------------------------------------ error row */
  var errbar = document.getElementById('errbar');
  function renderErr() {
    var show = S.offline && !!src;
    errbar.hidden = !show;
    document.body.classList.toggle('has-err', show);
    if (!show) return;
    var n = Math.max(0, Math.ceil((S.nextPollAt - Date.now()) / 1000));
    var last = S.dataTs ? hhmm(S.dataTs) : 'never';
    errbar.textContent = 'Desk offline \u00b7 retrying in ' + n + 's \u00b7 last update ' + last;
  }
  setInterval(function () { renderErr(); tickTimers(); }, 1000);

  /* ------------------------------------------------------------ odometer */
  function Odometer(el) { this.el = el; this.cells = []; this.text = ''; }
  Odometer.prototype.set = function (text) {
    if (text === this.text) return;
    var el = this.el, prev = this.text, anim = !!prev && prev.length === text.length && !reduced();
    if (!anim || this.cells.length !== text.length) {
      el.innerHTML = '';
      this.cells = [];
      for (var i = 0; i < text.length; i++) {
        var ch = text[i], cell;
        if (/\d/.test(ch)) {
          cell = document.createElement('span'); cell.className = 'odo-dg';
          var col = document.createElement('span'); col.className = 'odo-col';
          for (var d = 0; d <= 9; d++) { var s = document.createElement('span'); s.textContent = d; col.appendChild(s); }
          var start = anim ? +prev[i] : +ch;
          col.style.transform = 'translateY(' + (-start * 1.04) + 'em)';
          cell.appendChild(col); cell._col = col; cell._d = start;
        } else {
          cell = document.createElement('span'); cell.className = 'odo-ch'; cell.textContent = ch;
        }
        el.appendChild(cell); this.cells.push(cell);
      }
      el.setAttribute('aria-label', text);
      this.text = text;
      if (!anim) return;
      void el.offsetWidth;
    }
    // roll each changed digit 600ms ease-out, 30ms stagger right to left
    var k = 0;
    for (var j = text.length - 1; j >= 0; j--) {
      var c = this.cells[j], nd = text[j];
      if (c._col) {
        if (+nd !== c._d) {
          c._col.classList.add('roll');
          c._col.style.transitionDelay = (k * 30) + 'ms';
          c._col.style.transform = 'translateY(' + (-(+nd) * 1.04) + 'em)';
          c._d = +nd; k++;
        }
      } else if (c.textContent !== nd) c.textContent = nd;
    }
    el.setAttribute('aria-label', text);
    this.text = text;
  };

  /* ------------------------------------------------------------ icons */
  var IC = {
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
    bell: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
    back: '<svg viewBox="0 0 14 22"><path d="M11 2 2 11l9 9"/></svg>',
    check: '<svg viewBox="0 0 16 16"><path d="m3 8.5 3.2 3L13 4.5"/></svg>',
    x: '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
    shield: '<svg viewBox="0 0 16 16"><path d="M8 1 2.5 3v4.5c0 3.4 2.4 6.3 5.5 7.5 3.1-1.2 5.5-4.1 5.5-7.5V3z"/></svg>'
  };

  /* ------------------------------------------------------------ tabs */
  var views = {
    home: document.getElementById('view-home'), agents: document.getElementById('view-agents'),
    activity: document.getElementById('view-activity'), account: document.getElementById('view-account')
  };
  function setTab(t) {
    S.tab = t;
    Object.keys(views).forEach(function (k) { views[k].hidden = k !== t; });
    document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === t); b.setAttribute('aria-selected', b.dataset.tab === t); });
    if (t === 'activity') markSeen();
    renderAll();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tab').forEach(function (b) { b.addEventListener('click', function () { closeSheet(true); setTab(b.dataset.tab); }); });

  function markSeen() {
    var rows = (S.activity && S.activity.rows) || [];
    var mx = rows.reduce(function (a, r) { return Math.max(a, r.ts || 0); }, +(lsGet(LS_SEEN) || 0));
    lsSet(LS_SEEN, String(mx));
  }

  /* ------------------------------------------------------------ HOME */
  var home = null;
  function buildHome() {
    var v = views.home;
    v.innerHTML =
      '<header class="navbar">' +
      '<button class="iconbtn" id="h-avatar" aria-label="Account"><span class="avatar" id="h-av">\u00a0</span></button>' +
      '<button class="navtitle" id="h-title">Grok Bot<span class="chev">\u203a</span></button>' +
      '<span class="spacer"></span>' +
      '<button class="iconbtn" id="h-search" aria-label="Search">' + IC.search + '</button>' +
      '<button class="iconbtn" id="h-bell" aria-label="Notifications">' + IC.bell + '<i class="dot" id="h-dot" hidden></i></button>' +
      '</header>' +
      '<div class="balance-row"><span class="balance" id="h-bal"></span><span class="pill paper" id="h-paper" hidden>PAPER</span></div>' +
      '<div class="today" id="h-today"></div>' +
      '<div class="chart-wrap"><canvas id="h-chart" aria-label="Balance chart"></canvas><div class="chart-empty" id="h-chart-empty" hidden>Waiting for the first trade</div></div>' +
      '<div class="ranges" id="h-ranges">' + RANGES.map(function (r) { return '<button data-r="' + r + '">' + r + '</button>'; }).join('') + '</div>' +
      '<div class="sechead"><h2 id="h-agents-h">Agents</h2></div>' +
      '<div class="carousel" id="h-cards">' + AGENTS.map(function (n) { return '<article class="acard" data-agent="' + n + '"></article>'; }).join('') + '</div>' +
      '<div class="sechead"><h2>Activity</h2><button id="h-seeall">See all</button></div>' +
      '<div class="list" id="h-act"></div>';
    home = {
      odo: new Odometer(document.getElementById('h-bal')),
      canvas: document.getElementById('h-chart'), lastKey: null, marksSeen: {}, markAlpha: {}
    };
    v.querySelector('#h-avatar').onclick = function () { setTab('account'); };
    v.querySelector('#h-title').onclick = function () { setTab('agents'); };
    v.querySelector('#h-search').onclick = function () { openSheet({ kind: 'search' }); };
    v.querySelector('#h-bell').onclick = function () { markSeen(); setTab('activity'); };
    v.querySelector('#h-seeall').onclick = function () { setTab('activity'); };
    v.querySelectorAll('#h-ranges button').forEach(function (b) {
      b.onclick = function () { S.range = b.dataset.r; renderHome(); if (src) { inFlight = false; poll(); } };
    });
    v.querySelectorAll('.acard').forEach(function (card) {
      card.addEventListener('click', function (e) {
        if (e.target.closest('a')) return;
        var n = card.dataset.agent;
        if (n === 'auditor') { var m = latestMint('auditor'); if (m) return openSheet({ kind: 'audit', mint: m }); }
        setTab('agents');
        var el = document.getElementById('ag-' + n); if (el) el.scrollIntoView();
      });
    });
  }
  function agent(n) { return S.state && S.state.agents ? S.state.agents.filter(function (a) { return a.name === n; })[0] : null; }
  function latestMint(n) { var d = S.decisions[n]; return d && d.decisions && d.decisions[0] ? d.decisions[0].mint : null; }
  function isPaper() { var m = (S.state && S.state.mode) || (S.account && S.account.mode); return String(m || '').toUpperCase() !== 'LIVE'; }

  function renderHome() {
    if (!home) buildHome();
    var st = S.state, v = views.home;
    var h = S.account && S.account.fomo_handle;      // avatar initial from the FOMO handle in the payload
    document.getElementById('h-av').textContent = h ? h[0].toUpperCase() : '\u00a0';
    // bell dot = unread pushes (push-worthy activity since last look)
    var pr = S.settings && S.settings.settings && S.settings.settings['desk.push_rejects'];
    document.getElementById('h-dot').hidden = !S.activity || unreadCount(S.activity.rows, +(lsGet(LS_SEEN) || 0), !!pr) === 0;

    var bal = document.getElementById('h-bal');
    if (!st) {
      bal.innerHTML = '<span class="sk-block" style="display:inline-block;width:62vw;height:0.9em"></span>';
      home.odo.text = ''; home.odo.cells = [];
      document.getElementById('h-today').innerHTML = '<span class="sk-block" style="display:inline-block;width:150px;height:22px"></span>';
      document.getElementById('h-paper').hidden = true;
    } else {
      home.odo.set(money(st.balance));
      document.getElementById('h-paper').hidden = !isPaper();
      var tp = num(st.today_pct), mult = num(st.multiplier);
      document.getElementById('h-today').innerHTML =
        '<span class="' + (tp > 0 ? 'green' : tp < 0 ? 'red' : 't2') + '">' + esc(pct(tp)) + '</span><span class="t2">today</span>' +
        (mult != null ? '<span class="pill mult' + (mult < 1 ? ' neg' : '') + '">' + mult.toFixed(2) + '\u00d7</span>' : '');
    }
    v.querySelectorAll('#h-ranges button').forEach(function (b) { b.classList.toggle('on', b.dataset.r === S.range); });
    renderHomeChart();
    var nRun = st ? st.agents_running : null;
    document.getElementById('h-agents-h').innerHTML = 'Agents' + (nRun != null ? ' <span class="t2">\u00b7 ' + nRun + ' running</span>' : '');
    renderHomeAgents();
    var act = document.getElementById('h-act');
    act.innerHTML = S.activity ? activityRows((S.activity.rows || []).slice(0, 5)) : skeletonRows(3);
    act.classList.toggle('skeleton', !S.activity);
    bindActivityRows(act);
  }

  var chartAnim = null;
  function renderHomeChart(force) {
    var ch = S.chart[S.range], canvas = home.canvas, empty = document.getElementById('h-chart-empty');
    if (!ch) {
      if (!S.state) { canvas.parentNode.classList.add('sk-block'); return; }
      ch = S.range === 'LIVE' ? { points: [], marks: [], start_value: S.state.night_start_balance } : { __loading: true };
    }
    canvas.parentNode.classList.toggle('sk-block', !!ch.__loading);
    if (ch.__loading) { empty.hidden = true; window.FDChart.line(canvas, { points: [] }); return; }
    if (ch.__missing) { empty.hidden = false; empty.textContent = S.range + ' range not published yet'; window.FDChart.line(canvas, { points: [], startValue: null }); return; }
    var pts = ch.points || [];
    var risk = agent('risk'), stopPct = risk ? risk.stop_pct : null;
    var marks = (ch.marks || []).map(function (m) {
      return { ts: m.ts, kind: m.kind, text: markText(m, stopPct), key: m.ts + ':' + m.kind + ':' + m.mint };
    });
    empty.hidden = pts.length > 0; empty.textContent = 'Waiting for the first trade';
    var key = S.range + ':' + (pts.length ? pts[pts.length - 1].ts : 0);
    var isNew = !!home.lastKey && home.lastKey !== key && home.lastKey.split(':')[0] === S.range && pts.length > 1;
    var newMarks = marks.filter(function (m) { return !home.marksSeen[m.key]; });
    var firstPaint = !home.lastKey;
    home.lastKey = key;
    marks.forEach(function (m) { home.marksSeen[m.key] = 1; });
    var opts = { points: pts, startValue: ch.start_value, marks: marks, markAlpha: home.markAlpha };
    if (reduced() || firstPaint || (!isNew && !newMarks.length) || force) {
      newMarks.forEach(function (m) { home.markAlpha[m.key] = 1; });
      opts.slide = 1; window.FDChart.line(canvas, opts); return;
    }
    // a new point slides in over 250ms, marks fade in over 200ms
    if (chartAnim) cancelAnimationFrame(chartAnim);
    var t0 = performance.now();
    newMarks.forEach(function (m) { home.markAlpha[m.key] = 0; });
    (function frame(now) {
      var e = now - t0;
      opts.slide = isNew ? Math.min(1, e / 250) : 1;
      var ma = Math.min(1, e / 200);
      newMarks.forEach(function (m) { home.markAlpha[m.key] = ma; });
      window.FDChart.line(canvas, opts);
      if (e < 250) chartAnim = requestAnimationFrame(frame); else chartAnim = null;
    })(t0);
  }

  function cardHead(n, a) {
    var stt = a ? a.status : null;
    var label = { running: 'Running', paused: 'Paused', stale: 'Stalled', off: 'Off' }[stt] || '';
    return '<div class="ahead"><span class="aname" style="color:' + AG[n].color + '">' + AG[n].title + '</span>' +
      '<span class="astatus"><i class="sdot ' + esc(stt || '') + '"></i>' + label + '</span></div>';
  }
  function decs(n) { var d = S.decisions[n]; return (d && d.decisions) || []; }

  function renderHomeAgents() {
    if (!home) return;
    document.querySelectorAll('#h-cards .acard').forEach(function (card) {
      var n = card.dataset.agent, a = agent(n);
      card.classList.toggle('sk-block', !a);
      if (!a) { card.innerHTML = ''; return; }
      var html = cardHead(n, a);
      if (n === 'scanner') {
        var feed = a.feed || [];
        html += '<div class="abig">' + (a.pools || 0) + '<small>pools</small></div><div class="abody">';
        if (!feed.length) html += '<div class="aempty">Listening for graduations</div>';
        feed.slice(0, 5).forEach(function (f) {
          var passed = f.verdict === 'pass';
          html += '<div class="feedrow ' + (passed ? 'passed' : 'killed') + '"><span class="fc">' + esc(short(f.mint)) + '</span>' +
            '<span class="fr">' + (passed ? '\u2192 auditor' : esc(f.reason || 'killed')) + '</span></div>';
        });
        html += '</div>';
      } else if (n === 'auditor') {
        var lm = latestMint('auditor'), au = lm ? S.audits[lm] : null, ld = decs('auditor')[0];
        if (au && (au.__missing || au.__error)) au = null;
        html += '<div class="abig">' + (a.taken_apart || 0) + '<small>taken apart</small></div><div class="abody">';
        if (!lm) html += '<div class="aempty">No coin taken apart yet</div>';
        else {
          var layers = (au && au.layers) || [];
          html += '<div class="strips">';
          for (var i = 0; i < 8; i++) {
            var L = layers[i];
            html += '<i class="strip ' + (!L || L.pass == null ? (au && au.passed == null ? 'wait' : '') : L.pass ? 'ok' : 'bad') + '"></i>';
          }
          html += '</div>';
          var line;
          if (au && au.passed === true) line = '<span class="green">8/8 \u2192 Executor</span>';
          else if (au && au.passed === false) line = '<span class="red">' + esc(String(au.reason || (ld && ld.reason) || 'Rejected').replace(/^Auditor \u00b7 /, '')) + '</span>';
          else if (au && au.passed == null) line = '<span class="t2">taking apart...</span>';
          else line = ld ? (ld.verdict === 'pass' ? '<span class="green">8/8 \u2192 Executor</span>' : '<span class="red">' + esc(ld.reason || 'Rejected') + '</span>') : '';
          html += '<div style="font-size:15px;margin-top:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(au && au.name ? au.name : short(lm)) + ' \u00b7 ' + line + '</div>';
        }
        html += '</div><div class="afoot">' + (a.rejected || 0) + ' rejected</div>';
      } else if (n === 'analyst') {
        html += '<div class="t2" style="margin-top:6px;font-size:15px">Scoring</div><div class="ringbox"><canvas class="ring" aria-label="Score"></canvas></div>' +
          '<div class="afoot">' + (a.last_mint ? esc(short(a.last_mint)) + ' \u00b7 ' : 'No coin scored yet \u00b7 ') + 'green from ' + esc(a.min_score) + '</div>';
      } else if (n === 'executor') {
        var ed = decs('executor')[0];
        html += '<div class="abig">' + (a.trades || 0) + '<small>trades</small></div><div class="abody">';
        if (!ed) html += '<div class="t2" style="font-size:15px">' + esc(a.stack_pct) + '% of stack per trade</div><div class="aempty">No trades yet</div>';
        else {
          html += '<div style="font-size:17px">' + esc(firstPart(ed.reason)) + ' \u00b7 ' + esc(a.stack_pct) + '% of stack</div>';
          var vs = String(ed.verdict || '');
          if (vs === 'bought') html += '<div class="exbar"><i style="width:100%"></i></div><div class="green" style="font-size:15px">\u2713 Filled</div>';
          else if (vs === 'missed') html += '<div class="exbar"><i style="width:100%;background:#3a3a3c"></i></div><div class="t2" style="font-size:15px">Missed</div>';
          else {
            var win = (S.settings && S.settings.settings && num(S.settings.settings['executor.confirm_window_min'])) || 5;
            var p = execPct(ed.ts, win);
            html += '<div class="exbar"><i data-exec-ts="' + ed.ts + '" data-win="' + win + '" style="width:' + p + '%"></i></div><div style="font-size:15px">Executing... <span class="exec-p">' + p + '</span>%</div>';
          }
          html += '<div class="t2" style="font-size:14px">' + esc(short(ed.mint)) + ' \u00b7 ' + hhmm(ed.ts) + '</div>';
        }
        html += '</div>';
      } else if (n === 'risk') {
        var rd = decs('risk')[0];
        var word = rd ? ({ trail: 'Trailed out', stop: 'Stopped', timeout: 'Timed out', pulled: 'Liquidity pulled' }[rd.verdict] || rd.verdict) : null;
        html += '<div class="abig" style="font-size:clamp(30px,9vw,44px)">Guarding<small>' + (a.open_positions || 0) + ' open</small></div><div class="abody">';
        html += rd ? '<div style="font-size:17px">' + esc(word) + ' \u00b7 <span class="t2">' + esc(short(rd.mint)) + '</span></div><div class="t2" style="font-size:14px">' + esc(rd.reason || '') + '</div>'
          : '<div class="aempty">No exits yet tonight</div>';
        html += '</div><div class="pillrow"><span class="pill mono stop">stop -' + esc(a.stop_pct) + '%</span><span class="pill mono trail">trail ' + esc(a.trail_pct) + '%</span></div>';
      }
      card.innerHTML = html;
      if (n === 'analyst') { var cv = card.querySelector('canvas'); requestAnimationFrame(function () { window.FDChart.ring(cv, a.last_score, a.min_score); }); }
    });
  }
  function execPct(ts, win) { return Math.max(0, Math.min(99, Math.round(((Date.now() / 1000 - ts) / (win * 60)) * 100))); }
  function tickTimers() {
    document.querySelectorAll('[data-exec-ts]').forEach(function (b) {
      var p = execPct(+b.dataset.execTs, +b.dataset.win);
      b.style.width = p + '%'; var t = b.parentNode.parentNode.querySelector('.exec-p'); if (t) t.textContent = p;
    });
    var tl = document.getElementById('c-timeleft');
    if (tl && tl.dataset.until) tl.textContent = dur(+tl.dataset.until - Date.now() / 1000);
  }

  /* ------------------------------------------------------------ activity rows */
  function skeletonRows(n) {
    var s = ''; for (var i = 0; i < n; i++) s += '<div class="row"><div class="rmain"><div class="rtitle">\u00a0</div><div class="rsub">\u00a0</div></div></div>';
    return s;
  }
  var KIND = { bought: ['B', 'var(--blue)'], sold: ['S', 'var(--green)'], stopped: ['S', 'var(--red)'], rejected: ['R', 'var(--card2)'] };
  function activityRows(rows) {
    if (!rows.length) return '<div class="empty-row">Nothing yet tonight</div>';
    return rows.map(function (r) {
      var k = KIND[r.kind] || ['\u2022', 'var(--card2)'];
      var vc = r.kind === 'sold' ? 'green' : r.kind === 'stopped' ? 'red' : r.kind === 'rejected' ? 't2' : '';
      var sub = r.subtitle || '';
      if (r.kind === 'bought' && !/\d\d:\d\d/.test(sub)) sub += ' \u00b7 ' + hhmm(r.ts);
      return '<button class="row" data-kind="' + esc(r.kind) + '" data-mint="' + esc(r.mint || '') + '">' +
        '<span class="ricon" style="background:' + k[1] + ';color:' + (r.kind === 'rejected' ? 'var(--text2)' : '#000') + '">' + k[0] + '</span>' +
        '<span class="rmain"><span class="rtitle" style="display:block">' + esc(r.title) + '</span><span class="rsub" style="display:block">' + esc(sub) + '</span></span>' +
        '<span class="rval ' + vc + '">' + esc(r.value || '') + '</span></button>';
    }).join('');
  }
  function bindActivityRows(root) {
    root.querySelectorAll('button.row[data-kind]').forEach(function (b) {
      b.onclick = function () {
        var m = b.dataset.mint; if (!m) return;
        openSheet({ kind: b.dataset.kind === 'rejected' ? 'audit' : 'coin', mint: m });
      };
    });
  }

  /* ------------------------------------------------------------ AGENTS tab */
  function renderAgents() {
    var v = views.agents, html = '<h1 class="largetitle">Agents</h1>';
    if (!S.state) {
      for (var i = 0; i < 5; i++) html += '<div class="agentfull sk-block" style="height:220px"></div>';
      v.innerHTML = html; return;
    }
    AGENTS.forEach(function (n) {
      var a = agent(n) || { status: 'off' }, d = S.decisions[n];
      var locked = n === 'risk' && a.pause_locked;
      var disabled = !src.writable || locked;
      html += '<section class="agentfull" id="ag-' + n + '">' +
        '<div class="ah"><i class="sdot ' + esc(a.status) + '"></i><span class="nm" style="color:' + AG[n].color + '">' + AG[n].title + '</span>' +
        '<span class="cnt">' + (a.today_count || 0) + ' today \u00b7 ' + esc(a.status || 'off') + '</span>' +
        '<label class="sw" aria-label="' + (a.paused ? 'Resume ' : 'Pause ') + AG[n].title + '"><input type="checkbox" data-pause="' + n + '"' + (a.paused ? '' : ' checked') + (disabled ? ' disabled' : '') + '><i class="tr"></i><i class="th"></i></label></div>' +
        '<div class="note">' + (locked ? 'Locked while a position is open' : !src.writable ? 'Plan B is read-only here' : 'Switch off to pause') + '</div>';
      var items = d ? d.decisions || [] : null;
      if (!items) html += '<div class="dec sk-block" style="height:40px"></div>';
      else if (!items.length) html += '<div class="dec"><span></span><span class="t2">' + ({ scanner: 'Listening for graduations', auditor: 'No coin taken apart yet' }[n] || 'Nothing yet tonight') + '</span><span></span></div>';
      else items.slice(0, 20).forEach(function (x) {
        var u = safeUrl(x.coin_url), good = /^(pass|bought|trail)$/.test(x.verdict || '');
        var bad = /^(reject|killed|kill|stop|pulled|missed|fail)/.test(x.verdict || '');
        html += '<div class="dec"><span class="dt">' + hhmm(x.ts) + '</span>' +
          (u ? '<a class="dcoin" href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(short(x.mint)) + '</a>' : '<span class="dcoin">' + esc(short(x.mint)) + '</span>') +
          '<span class="dv ' + (good ? 'green' : bad ? 'red' : '') + '">' + esc(x.verdict || '') + '</span>' +
          '<span class="dr">' + esc(x.reason || '') + '</span></div>';
      });
      html += '<button class="linkbtn" data-settings="' + n + '">Settings</button></section>';
    });
    v.innerHTML = html;
    v.querySelectorAll('[data-settings]').forEach(function (b) {
      b.onclick = function () { setTab('account'); requestAnimationFrame(function () { requestAnimationFrame(function () { var g = document.getElementById('set-' + b.dataset.settings); if (g) g.scrollIntoView(); }); }); };
    });
    v.querySelectorAll('[data-pause]').forEach(function (inp) {
      inp.onchange = function () {
        var n = inp.dataset.pause, resume = inp.checked;
        postJSON('./api/agents/' + n + '/' + (resume ? 'resume' : 'pause'), {}).then(function () { toast(AG[n].title + (resume ? ' resumed' : ' paused')); inFlight = false; poll(); })
          .catch(function () { inp.checked = !resume; toast('Could not change ' + AG[n].title); });
      };
    });
  }

  /* ------------------------------------------------------------ ACTIVITY tab */
  function renderActivity() {
    var v = views.activity;
    var rows = S.activity ? S.activity.rows || [] : null;
    v.innerHTML = '<h1 class="largetitle">Activity</h1><div class="list' + (rows ? '' : ' skeleton') + '">' + (rows ? activityRows(rows) : skeletonRows(6)) + '</div>' +
      (rows && rows.length && S.activity.next_before && src.plan === 'B' ? '<div class="group-foot">Showing the latest ' + rows.length + '</div>' : '');
    bindActivityRows(v);
  }

  /* ------------------------------------------------------------ ACCOUNT tab */
  var GROUP_TITLES = { desk: 'Desk', scanner: 'Scanner', auditor: 'Auditor', analyst: 'Analyst', executor: 'Executor', risk: 'Risk' };
  function labelOf(k) { var s = k.split('.').slice(1).join(' ').replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); }
  function sliderMax(def, val) {
    var b = Math.max(Math.abs(def || 0), Math.abs(val || 0));
    if (b === 0) return 100;
    if (b <= 1) return 1;
    var m = b * 3, p = Math.pow(10, Math.floor(Math.log10(m)));
    return Math.ceil(m / p) * p;
  }
  function stepOf(def, max) { if (Number.isInteger(def) && max > 1) return 1; return max <= 1 ? 0.01 : max <= 10 ? 0.1 : max <= 100 ? 0.5 : 1; }
  function standalone() { return (window.navigator.standalone === true) || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches); }

  function renderAccount() {
    var v = views.account, ac = S.account, ss = S.settings;
    var ae = document.activeElement;
    if (ae && v.contains(ae) && ae.tagName === 'INPUT') return;   // never yank a field out from under a finger
    var html = '<h1 class="largetitle">Account</h1>';
    if (!ac) {
      html += '<div class="sk-block" style="height:44px"></div><div class="sk-block" style="height:120px;margin-top:20px"></div><div class="sk-block" style="height:300px;margin-top:20px"></div>';
      v.innerHTML = html; return;
    }
    var live = String(ac.mode).toUpperCase() === 'LIVE';
    html += '<div class="seg"><button data-mode="PAPER" class="' + (!live ? 'on paper' : '') + '">PAPER</button><button data-mode="LIVE" class="' + (live ? 'on' : '') + '">LIVE</button></div>';
    html += '<div class="list" style="margin-top:16px">' +
      '<div class="row compact"><span class="rmain">Stack</span><span class="rval">' + esc(money(ac.stack)) + '</span></div>' +
      '<div class="row compact"><span class="rmain">In open positions</span><span class="rval">' + esc(money(ac.open_money)) + '</span></div></div>';
    var pu = safeUrl(ac.profile_url), su = safeUrl(ac.signup_url);
    html += '<div class="list" style="margin-top:20px">' +
      (pu ? '<a class="row" href="' + esc(pu) + '" target="_blank" rel="noopener"><span class="rmain"><span class="rtitle" style="display:block">Your FOMO profile</span><span class="rsub" style="display:block">@' + esc(ac.fomo_handle) + '</span></span><span class="rchev">\u203a</span></a>'
        : '<div class="row"><span class="rmain"><span class="rtitle" style="display:block">Your FOMO profile</span><span class="rsub" style="display:block">No handle set</span></span></div>') +
      (su ? '<button class="row" id="acc-invite"><span class="rmain"><span class="rtitle" style="display:block">Invite a friend</span><span class="rsub" style="display:block">Share your FOMO link</span></span><span class="rchev">\u203a</span></button>' : '') +
      '</div>';
    var tg = ac.push && ac.push.telegram, wp = ac.push && ac.push.web_push && src.plan !== 'B';
    html += '<div class="group-title">Notifications</div><div class="list">' +
      '<div class="row compact"><span class="rmain">Telegram</span><span class="rval ' + (tg ? 'green' : 't2') + '">' + (tg ? 'Connected' : 'Not connected') + '</span></div>' +
      '<button class="row compact" id="acc-testpush"' + (src.writable ? '' : ' disabled') + '><span class="rmain ' + (src.writable ? 'blue' : 't3') + '">Send test push</span></button>';
    if (src.plan === 'B') html += '<div class="row compact"><span class="rmain">Web push</span><span class="rval t2">Plan B = Telegram only</span></div>';
    else if (wp && standalone() && 'serviceWorker' in navigator && 'PushManager' in window) html += '<button class="row compact" id="acc-push"><span class="rmain blue">Enable notifications</span></button>';
    else html += '<div class="row compact"><span class="rmain">Web push</span><span class="rval t2">Add to Home Screen first</span></div>';
    html += '</div>';
    if (!src.writable) html += '<div class="group-foot">Plan B serves a read-only copy of the desk. Mode, stack and settings change on the desk itself.</div>';
    if (!ss) html += '<div class="sk-block" style="height:300px;margin-top:20px"></div>';
    else {
      var vals = ss.settings || {}, defs = ss.defaults || {};
      Object.keys(GROUP_TITLES).forEach(function (g) {
        var keys = Object.keys(vals).filter(function (k) { return k.indexOf(g + '.') === 0; });
        if (!keys.length) return;
        html += '<div class="group-title" id="set-' + g + '">' + GROUP_TITLES[g] + '</div><div class="list">';
        keys.forEach(function (k) {
          var val = vals[k], def = defs[k], dis = src.writable ? '' : ' disabled';
          html += '<div class="setrow"><div class="sk"><span class="lbl">' + esc(labelOf(k)) + '</span>';
          if (typeof def === 'boolean' || typeof val === 'boolean') {
            html += '<label class="sw"><input type="checkbox" data-key="' + esc(k) + '"' + (val ? ' checked' : '') + dis + '><i class="tr"></i><i class="th"></i></label></div>';
          } else if (typeof def === 'number' || typeof val === 'number') {
            var max = sliderMax(def, val), step = stepOf(def, max);
            html += '<input type="number" inputmode="decimal" data-key="' + esc(k) + '" value="' + esc(val) + '" step="any"' + dis + '></div>' +
              '<input type="range" data-key="' + esc(k) + '" min="0" max="' + max + '" step="' + step + '" value="' + esc(val) + '"' + dis + ' aria-label="' + esc(labelOf(k)) + '">';
          } else {
            html += '<input type="text" data-key="' + esc(k) + '" value="' + esc(val) + '"' + dis + '></div>';
          }
          html += '</div>';
        });
        html += '</div>';
      });
    }
    html += '<div class="group-title">This device</div><div class="list"><button class="row compact" id="acc-forget"><span class="rmain red">Forget this desk on this device</span></button></div>';
    v.innerHTML = html;

    v.querySelectorAll('[data-mode]').forEach(function (b) {
      b.onclick = function () {
        var m = b.dataset.mode;
        if (m === String(ac.mode).toUpperCase()) return;
        if (!src.writable) return toast('Plan B is read-only \u00b7 switch mode on the desk');
        var body = { mode: m };
        if (m === 'LIVE') {
          var t = window.prompt('Type LIVE to confirm.');
          if (t !== 'LIVE') return toast('Still PAPER');
          body.confirm = 'LIVE';
        }
        postJSON('./api/mode', body).then(function () { toast('Mode: ' + m); inFlight = false; poll(); }).catch(function () { toast('Mode not changed'); });
      };
    });
    var inv = v.querySelector('#acc-invite');
    if (inv) inv.onclick = function () { shareLink(su); };
    var tp = v.querySelector('#acc-testpush');
    if (tp) tp.onclick = function () { toast('Test push is not wired on this desk yet'); };
    var pb = v.querySelector('#acc-push');
    if (pb) pb.onclick = enableWebPush;
    v.querySelector('#acc-forget').onclick = function () {
      if (!window.confirm('Forget this desk link on this device?')) return;
      [LS_DP, LS_T, LS_CACHE, LS_SEEN].forEach(function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } });
      location.replace(location.pathname);
    };
    v.querySelectorAll('input[data-key]').forEach(function (inp) {
      var k = inp.dataset.key;
      if (inp.type === 'range') inp.oninput = function () { var n = v.querySelector('input[type=number][data-key="' + k + '"]'); if (n) n.value = inp.value; };
      inp.onchange = function () {
        var val = inp.type === 'checkbox' ? inp.checked : inp.type === 'text' ? inp.value : +inp.value;
        if (inp.type === 'number') { var r = v.querySelector('input[type=range][data-key="' + k + '"]'); if (r) r.value = inp.value; }
        if (k === 'auditor.enabled' && val === false && !confirmAuditorOff()) { inp.checked = true; return; }
        inp.blur();
        saveSetting(k, val).catch(function () { renderAccount(); });
      };
    });
  }
  function confirmAuditorOff() {
    return window.confirm('Turn off "Take apart before buying"? Coins would go to the Executor without the 8 checks.') &&
      window.confirm('Are you sure? This removes the Auditor from the pipeline.');
  }
  function saveSetting(k, val) {
    return postJSON('./api/settings', { key: k, value: val }).then(function () {
      if (S.settings && S.settings.settings) S.settings.settings[k] = val;
      toast('Saved'); inFlight = false; poll();
    }).catch(function (e) { toast(src.writable ? 'Not saved' : 'Plan B is read-only'); throw e; });
  }
  function shareLink(url) {
    if (navigator.share) { navigator.share({ title: 'FOMO', url: url }).catch(function () {}); return; }
    var done = function () { toast('Link copied'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { legacyCopy(url); done(); });
    else { legacyCopy(url); done(); }
  }
  function legacyCopy(t) {
    var ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) { /* ignore */ } ta.remove();
  }
  function enableWebPush() {
    // Plan A only: register sw.js, subscribe with the VAPID public key, POST to /api/push.
    if (!src || src.plan === 'B') return toast('Plan B = Telegram only');
    fetch('./vapidPublicKey.txt', { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (key) {
      key = key.trim();
      var pad = '='.repeat((4 - key.length % 4) % 4), raw = atob((key + pad).replace(/-/g, '+').replace(/_/g, '/'));
      var arr = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      return Notification.requestPermission().then(function (p) {
        if (p !== 'granted') throw new Error('denied');
        return navigator.serviceWorker.register('./sw.js').then(function () { return navigator.serviceWorker.ready; });
      }).then(function (reg) { return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: arr }); });
    }).then(function (sub) { return postJSON('./api/push', sub.toJSON()); })
      .then(function () { toast('Notifications on'); }, function () { toast('Notifications not enabled'); });
  }

  /* ------------------------------------------------------------ sheets: Coin · Auditor · Search */
  var sheet = document.getElementById('sheet'), sheetState = null, beam = null;
  function openSheet(st) {
    sheetState = st; beam = null;
    if (history.pushState) history.pushState({ sheet: { kind: st.kind, mint: st.mint || null } }, '');
    sheet.hidden = false; sheet.scrollTop = 0; sheet.innerHTML = '';
    sheet.classList.remove('anim'); if (!reduced()) { void sheet.offsetWidth; sheet.classList.add('anim'); }
    renderSheet();
    if (st.mint && src) loadMint(st.mint, st);
    if (st.kind === 'search') setTimeout(function () { var i = document.getElementById('q'); if (i) i.focus(); }, 50);
  }
  function loadMint(m, st) {
    Promise.allSettled([getJSON(src.coin(m)), getJSON(src.audit(m))]).then(function (r) {
      if (r[0].status === 'fulfilled') S.coins[m] = r[0].value; else if (!S.coins[m]) S.coins[m] = { __error: true };
      if (r[1].status === 'fulfilled') S.audits[m] = r[1].value; else if (!S.audits[m]) S.audits[m] = { __error: true };
      if (sheetState === st) renderSheet();
    });
  }
  function hideSheet() { sheet.hidden = true; sheetState = null; beam = null; sheet.innerHTML = ''; }
  function closeSheet(viaTab) {
    if (sheet.hidden) return;
    hideSheet();
    if (viaTab && history.state && history.state.sheet) history.back();
  }
  window.addEventListener('popstate', function (e) {
    if (e.state && e.state.sheet) {
      sheetState = { kind: e.state.sheet.kind, mint: e.state.sheet.mint }; beam = null; sheet.hidden = false; sheet.innerHTML = '';
      renderSheet(); if (sheetState.mint && src) loadMint(sheetState.mint, sheetState);
    } else hideSheet();
  });
  function backBar(extra) {
    return '<header class="navbar"><button class="backbtn" id="sh-back">' + IC.back + '<span>Back</span></button><span class="spacer"></span>' + (extra || '') + '</header>';
  }
  function bindBack() { var b = document.getElementById('sh-back'); if (b) b.onclick = function () { if (history.state && history.state.sheet) history.back(); else hideSheet(); }; }
  function renderSheet() {
    if (!sheetState || sheet.hidden) return;
    if (sheetState.kind === 'coin') renderCoin(sheetState.mint);
    else if (sheetState.kind === 'audit') renderAudit(sheetState.mint);
    else if (sheetState.kind === 'search') renderSearch();
  }

  function renderCoin(m) {
    var c = S.coins[m];
    var html = '<div class="screen">' + backBar(isPaper() ? '<span class="pill paper">PAPER</span>' : '');
    if (!c) {
      html += '<div class="sk-block" style="height:34px;width:60%;margin-top:8px"></div><div class="sk-block" style="height:70px;width:70%;margin-top:18px"></div>' +
        '<div class="sk-block" style="height:260px;margin-top:14px"></div><div class="sk-block" style="height:130px;margin-top:16px"></div>';
    } else if (c.__missing || c.__error) {
      html += '<div class="coinname" style="margin-top:8px">' + esc(short(m)) + '</div>' +
        '<div class="card"><div class="' + (c.__error ? 'red' : 't2') + '">' + (c.__error ? 'Could not load this coin \u00b7 retrying with the next poll' : 'The desk has not published this coin.') + '</div></div>';
    } else {
      var nm = c.name || short(m), sym = c.symbol || short(m);
      var sub = [esc(sym), 'Solana', ageText(c.age_h)].filter(Boolean).join(' \u00b7 ');
      var sh = c.shield ? String(c.shield) : null, shOk = !!sh && /^(\d+)\/\1$/.test(sh);
      html += '<div class="coinhead"><span class="coinname">' + esc(nm) + '</span>' +
        (sh ? '<button class="chip ' + (shOk ? 'ok' : 'bad') + '" id="c-shield" aria-label="Open the Auditor">' + IC.shield + esc(sh) + '</button>' : '') + '</div>' +
        '<div class="coinsub">' + sub + '</div>' +
        '<div class="price">' + esc(price(c.price)) + '</div>';
      var se = num(c.since_entry_pct);
      if (se != null) html += '<div class="' + (se >= 0 ? 'green' : 'red') + '" style="font-size:17px">' + (se >= 0 ? '\u25b2 ' : '\u25bc ') + Math.abs(se).toFixed(2) + '% since entry</div>';
      else if (c.price_ts) html += '<div class="t2" style="font-size:15px">price at ' + hhmm(c.price_ts) + '</div>';
      html += '<div class="candles-wrap"><canvas id="c-candles" aria-label="1-minute candles"></canvas></div>';
      var st = c.stats || {};
      html += '<div class="stats">' +
        '<div><div class="sl">Market cap</div><div class="sv">' + esc(compact(st.market_cap)) + '</div></div>' +
        '<div><div class="sl">Liquidity</div><div class="sv">' + esc(compact(st.liquidity_usd)) + '</div></div>' +
        '<div><div class="sl">24h volume</div><div class="sv">' + esc(compact(st.volume_h24)) + '</div></div>' +
        '<div><div class="sl">Holders</div><div class="sv">' + (num(st.holders) != null ? (+st.holders).toLocaleString('en-US') : 'n/a') + '</div></div></div>';
      var pos = c.position, ex = c.exit_lines || {}, risk = agent('risk'), exitLine = null;
      if (pos) {
        var trailPct = risk ? num(risk.trail_pct) : null, trailStart = risk ? num(risk.trail_start_pct) : null;
        var trailLine = ex.trail_active && num(ex.peak_price) != null && trailPct != null ? ex.peak_price * (1 - trailPct / 100) : null;
        exitLine = trailLine != null ? Math.max(num(ex.stop_price) || 0, trailLine) : num(ex.stop_price);
        var until = num(ex.opened_at) != null && num(ex.timeout_h) != null ? ex.opened_at + ex.timeout_h * 3600 : null;
        html += '<div class="card"><div class="ch">Your position</div><div class="cv">' + esc(money(pos.size_usd)) + ' in \u00b7 <span class="t2" style="font-weight:500">Executor</span></div></div>' +
          '<div class="card">' +
          '<div class="kv"><span class="k">Stop line</span><span class="red">' + esc(price(ex.stop_price)) + '</span></div>' +
          '<div class="kv"><span class="k">Trail line</span><span class="' + (trailLine != null ? 'green' : 't2') + '">' +
          (trailLine != null ? esc(price(trailLine)) + ' \u00b7 ' + trailPct + '% under peak' : (trailStart != null ? 'arms at +' + trailStart + '%' : 'off')) + '</span></div>' +
          '<div class="kv"><span class="k">Time left to timeout</span><span id="c-timeleft" data-until="' + (until || '') + '">' + (until ? dur(until - Date.now() / 1000) : 'n/a') + '</span></div></div>';
      }
      var u = safeUrl(c.coin_url);
      html += '<div class="bottombar"><a class="bigbtn' + (pos ? ' red' : '') + '"' + (u ? ' href="' + esc(u) + '" target="_blank" rel="noopener"' : ' aria-disabled="true"') + '>' + (pos ? 'Sell on FOMO' : 'Buy on FOMO') + '</a></div>';
      sheetState._candles = { candles: c.candles || [], exitLine: exitLine, entry: pos ? num(pos.entry_price) : null, emptyText: 'No price ticks yet' };
    }
    html += '</div>';
    var y = sheet.scrollTop;
    sheet.innerHTML = html; bindBack(); sheet.scrollTop = y;
    var cv = document.getElementById('c-candles'), cs = sheetState._candles;
    if (cv) requestAnimationFrame(function () { window.FDChart.candles(cv, cs || {}); });
    var shc = document.getElementById('c-shield'); if (shc) shc.onclick = function () { openSheet({ kind: 'audit', mint: m }); };
  }

  /* Auditor: 8 discs, cyan beam 350ms per layer top to bottom, then 150ms to green or red.
     The beam waits on any layer the server has not decided; it never shows an unsent result. */
  function renderAudit(m) {
    var a = S.audits[m];
    var html = '<div class="screen">' + backBar(isPaper() ? '<span class="pill paper">PAPER</span>' : '');
    if (!a) {
      html += '<div class="sk-block" style="height:34px;width:60%;margin-top:8px"></div><div class="sk-block" style="height:300px;width:220px;margin:14px auto"></div><div class="sk-block" style="height:400px"></div>';
      sheet.innerHTML = html + '</div>'; bindBack(); return;
    }
    if (a.__missing || a.__error || a.empty) {
      html += '<div class="coinname" style="margin-top:8px">' + esc(a.name || short(m)) + '</div>' +
        '<div class="card"><div class="' + (a.__error ? 'red' : 't2') + '">' + (a.__error ? 'Could not load the audit \u00b7 retrying with the next poll' : 'No coin taken apart yet') + '</div></div>';
      html += auditToggle() + openOnFomo(a.coin_url) + '</div>';
      sheet.innerHTML = html; bindBack(); bindAuditToggle(); return;
    }
    var nm = a.name || short(m), layers = a.layers || [];
    if (!beam || beam.mint !== m) beam = { mint: m, idx: 0, shown: 0, running: false };
    var b = beam;
    if (reduced()) { b.idx = 8; b.shown = 8; }
    html += '<div class="coinhead"><span class="coinname">' + esc(nm) + '</span></div><div class="coinsub">' + esc(a.symbol || short(m)) + ' \u00b7 taken apart ' + hhmm(a.ts) + '</div>';
    html += '<div class="discs" id="a-discs">';
    for (var i = 0; i < 8; i++) {
      var L = layers[i] || {}, rev = i < b.shown && L.pass != null;
      html += '<div class="disc ' + (rev ? (L.pass ? 'ok' : 'bad') : '') + '" style="top:' + (i * 34) + 'px;z-index:' + (10 - i) + '">' + (rev ? (L.pass ? IC.check : IC.x) : (i + 1)) + '</div>';
    }
    html += '<div class="beam" id="a-beam"></div></div>';
    html += '<div id="a-verdict">' + (b.shown >= 8 ? verdictHtml(a, nm, m) : '<div class="verdict t2">Taking apart\u2026</div><div class="verdict-sub">\u00a0</div>') + '</div>';
    html += '<div class="list" style="margin-top:14px">';
    layers.forEach(function (L, i) {
      var rev = i < b.shown && L.pass != null;
      html += '<div class="row compact lrow"><span class="lmark ' + (rev ? (L.pass ? 'ok' : 'bad') : '') + '">' + (rev ? (L.pass ? IC.check : IC.x) : '') + '</span>' +
        '<span class="rmain">' + esc(L.name) + '</span><span class="rval ' + (rev ? '' : 'pending') + '">' + (rev ? esc(L.value == null ? 'n/a' : L.value) : (i === b.idx ? 'reading\u2026' : '\u2014')) + '</span></div>';
    });
    html += '</div>' + auditToggle() + openOnFomo(a.coin_url) + '</div>';
    var y = sheet.scrollTop;
    sheet.innerHTML = html; bindBack(); bindAuditToggle(); sheet.scrollTop = y;
    runBeam(m);
  }
  function verdictHtml(a, nm, m) {
    if (a.passed === false) {
      var fail = (a.layers || []).filter(function (L) { return L.pass === false; })[0];
      var why = a.reason || (fail ? fail.name.toLowerCase() + ' ' + (fail.value || '') : 'failed a layer');
      why = String(why).replace(/^Auditor \u00b7 /, '');
      return '<div class="verdict red">Rejected \u00b7 ' + esc(why) + '</div><div class="verdict-sub">Grok Bot won\u2019t buy ' + esc(nm) + '</div>';
    }
    if (a.passed === true) {
      var ex = decs('executor').filter(function (d) { return d.mint === m; })[0];
      var n = (a.layers || []).length;
      return '<div class="verdict green">Cleared \u00b7 ' + n + '/' + n + ' parts</div><div class="verdict-sub">Sent to Executor' + (ex ? ' \u00b7 ' + esc(firstPart(ex.reason)) : '') + '</div>';
    }
    return '<div class="verdict t2">Waiting on the desk</div><div class="verdict-sub">Some layers have no result yet</div>';
  }
  function runBeam(m) {
    var b = beam;
    positionBeam();
    if (!b || b.mint !== m || b.running || b.shown >= 8) return;
    var a = S.audits[m], L = ((a && a.layers) || [])[b.idx];
    if (!L || L.pass == null) return;            // server slower: the beam waits on this layer (next poll re-runs)
    b.running = true;
    setTimeout(function () {                     // 350ms reading this layer, then 150ms colour change
      if (beam !== b) return;
      b.shown = b.idx + 1; b.idx++; b.running = false;
      if (sheetState && sheetState.mint === m && sheetState.kind === 'audit') renderAudit(m);
    }, 350);
  }
  function positionBeam() {
    var el = document.getElementById('a-beam'); if (!el || !beam) return;
    if (beam.idx >= 8 || reduced()) { el.style.opacity = '0'; return; }
    var prevTop = beam.idx > 0 ? (beam.idx - 1) * 34 + 22 : 0;
    el.style.transition = 'none'; el.style.opacity = '1'; el.style.top = prevTop + 'px';
    void el.offsetWidth;
    el.style.transition = 'top 350ms linear'; el.style.top = (beam.idx * 34 + 22) + 'px';
  }
  function auditToggle() {
    var on = S.settings && S.settings.settings ? S.settings.settings['auditor.enabled'] !== false : true;
    return '<div class="list" style="margin-top:16px"><div class="row compact"><span class="rmain">Take apart before buying</span>' +
      '<label class="sw"><input type="checkbox" id="a-enabled"' + (on ? ' checked' : '') + (src && src.writable ? '' : ' disabled') + '><i class="tr"></i><i class="th"></i></label></div></div>' +
      (src && !src.writable ? '<div class="group-foot">Read-only on Plan B</div>' : '');
  }
  function bindAuditToggle() {
    var t = document.getElementById('a-enabled'); if (!t) return;
    t.onchange = function () {
      if (!t.checked && !confirmAuditorOff()) { t.checked = true; return; }
      saveSetting('auditor.enabled', t.checked).catch(function () { t.checked = !t.checked; });
    };
  }
  function openOnFomo(url) {
    var u = safeUrl(url);
    return '<div class="bottombar"><a class="bigbtn"' + (u ? ' href="' + esc(u) + '" target="_blank" rel="noopener"' : ' aria-disabled="true"') + '>Open on FOMO</a></div>';
  }

  function searchIndex() {
    var idx = {};
    function add(m, name, sym) { if (!m) return; var e = idx[m] || (idx[m] = { mint: m, name: null, symbol: null }); if (name && !e.name) e.name = name; if (sym && !e.symbol) e.symbol = sym; }
    ((S.activity && S.activity.rows) || []).forEach(function (r) { var n = nameFromTitle(r.title); add(r.mint, n && n !== short(r.mint) ? n : null); });
    ((S.state && S.state.open_positions) || []).forEach(function (p) { add(p.mint); });
    AGENTS.forEach(function (n) { decs(n).forEach(function (d) { add(d.mint); }); });
    [S.coins, S.audits].forEach(function (bag) {
      Object.keys(bag).forEach(function (m) { var c = bag[m]; if (c && !c.__missing && !c.__error) add(m, c.name, c.symbol); });
    });
    return Object.keys(idx).map(function (k) { return idx[k]; });
  }
  function renderSearch() {
    if (!document.getElementById('q')) {
      sheet.innerHTML = '<div class="screen"><div class="searchbar"><input id="q" type="search" placeholder="Name, symbol or mint" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Search">' +
        '<button class="backbtn" id="sh-back">Cancel</button></div><div class="list" id="q-res" style="margin-top:14px"></div></div>';
      bindBack();
      var inp = document.getElementById('q'); inp.value = sheetState.q || '';
      inp.oninput = function () { sheetState.q = inp.value; drawResults(); };
    }
    drawResults();
  }
  function drawResults() {
    var inp = document.getElementById('q'), out = document.getElementById('q-res'); if (!inp || !out) return;
    var raw = inp.value.trim(), q = raw.toLowerCase(), all = searchIndex();
    var hits = all.filter(function (e) {
      return !q || e.mint.toLowerCase().indexOf(q) >= 0 || (e.name && e.name.toLowerCase().indexOf(q) >= 0) || (e.symbol && e.symbol.toLowerCase().indexOf(q) >= 0);
    }).slice(0, 30);
    var html = hits.map(function (e) {
      return '<button class="row" data-m="' + esc(e.mint) + '"><span class="rmain"><span class="rtitle" style="display:block">' + esc(e.name || short(e.mint)) + '</span>' +
        '<span class="rsub" style="display:block">' + esc((e.symbol ? e.symbol + ' \u00b7 ' : '') + short(e.mint)) + '</span></span><span class="rchev">\u203a</span></button>';
    }).join('');
    if (!hits.length && isMintLike(raw)) html = '<button class="row" data-m="' + esc(raw) + '"><span class="rmain">Look up ' + esc(short(raw)) + '</span><span class="rchev">\u203a</span></button>';
    if (!html) html = '<div class="empty-row">' + (all.length ? 'No coin on the desk matches' : 'No coins on the desk yet tonight') + '</div>';
    out.innerHTML = html;
    out.querySelectorAll('[data-m]').forEach(function (b) { b.onclick = function () { openSheet({ kind: 'coin', mint: b.dataset.m }); }; });
  }

  /* ------------------------------------------------------------ toast */
  var toastEl = document.getElementById('toast'), toastT = null;
  function toast(t) { toastEl.textContent = t; toastEl.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { toastEl.hidden = true; }, 2200); }

  /* ------------------------------------------------------------ first run (no link on this device yet) */
  function renderFirstRun() {
    document.getElementById('tabbar').hidden = true;
    views.home.innerHTML = '<div class="firstrun"><div class="largetitle">FOMO Desk</div>' +
      '<p>Open your private desk link once on this device. It stays on this device only.</p>' +
      '<input id="fr-link" type="url" placeholder="Paste your desk link" autocomplete="off" autocapitalize="off" spellcheck="false">' +
      '<button class="bigbtn" id="fr-go">Open desk</button></div>';
    document.getElementById('fr-go').onclick = function () {
      var raw = document.getElementById('fr-link').value.trim();
      var h = parseHash(raw.indexOf('#') >= 0 ? raw.slice(raw.indexOf('#')) : 'd=' + raw);
      if (!h.d && !h.t) return toast('That is not a desk link');
      if (h.d) lsSet(LS_DP, h.d);
      if (h.t) lsSet(LS_T, h.t);
      location.replace(location.pathname);
    };
  }

  /* ------------------------------------------------------------ render */
  var rafPending = false;
  function renderAll() {
    if (rafPending) return; rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      renderErr();
      if (S.tab === 'home') renderHome();
      else if (S.tab === 'agents') renderAgents();
      else if (S.tab === 'activity') renderActivity();
      else if (S.tab === 'account') renderAccount();
      if (!sheet.hidden && sheetState && sheetState.kind !== 'search') renderSheet();
    });
  }
  var rT = null;
  window.addEventListener('resize', function () { clearTimeout(rT); rT = setTimeout(function () { if (home && S.state) renderHomeChart(true); if (sheetState && sheetState.kind === 'coin') renderSheet(); }, 120); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && src) { inFlight = false; poll(); } });

  /* ------------------------------------------------------------ boot */
  function boot() {
    initSource();
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(function () {});
    if (!src) return renderFirstRun();
    if (lsGet(LS_SEEN) == null) lsSet(LS_SEEN, String(Math.floor(Date.now() / 1000)));
    loadCache();
    S.nextPollAt = Date.now();
    setTab('home');
    poll();
  }

  window.FDApp = {
    parseHash: parseHash, markText: markText, unreadCount: unreadCount, money: money, pct: pct,
    safeMint: safeMint, isMintLike: isMintLike, ageText: ageText, dur: dur, firstPart: firstPart,
    plan: function () { return src ? src.plan : null; }
  };
  if (!window.__FD_NO_BOOT) boot();
})();
