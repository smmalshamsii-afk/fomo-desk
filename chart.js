/* FOMO Desk · hand-drawn <canvas> charts (STEP 8). No chart library.
   Every chart is devicePixelRatio aware. Exposes window.FDChart. */
(function () {
  'use strict';
  var C = {
    green: '#00d35a', red: '#ff453a', orange: '#ff9f0a', blue: '#0a84ff', yellow: '#ffd60a',
    text: '#fff', text2: 'rgba(235,235,245,0.6)', text3: 'rgba(235,235,245,0.3)',
    sep: 'rgba(84,84,88,0.55)', card: '#1c1c1e', card2: '#2c2c2e'
  };
  var FONT = '-apple-system, "SF Pro Text", system-ui, sans-serif';
  var MONO = '"SF Mono", ui-monospace, Menlo, monospace';

  function setup(canvas) {
    var dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 4));
    var r = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h, dpr: dpr };
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* Place mark labels so they never overlap: a later mark moves up a row. Pure, unit-testable. */
  function layoutMarks(items, rowH, minTop) {
    var placed = [];
    items.forEach(function (m) {
      var row = 0, rect;
      for (;;) {
        var y = m.py - 14 - rowH - row * (rowH + 4);
        rect = { x: m.px - m.tw / 2 - 6, y: y, w: m.tw + 12, h: rowH, row: row };
        var hit = placed.some(function (p) {
          return rect.x < p.x + p.w + 2 && p.x < rect.x + rect.w + 2 && rect.y < p.y + p.h + 2 && p.y < rect.y + rect.h + 2;
        });
        if (!hit || row > 12) break;
        row++;
      }
      if (rect.y < minTop) rect.y = minTop + 0; // clamp (still in its own column order)
      m.rect = rect;
      placed.push(rect);
    });
    return items;
  }

  /* Home LIVE line.
     opts: { points:[{ts,value}], startValue, marks:[{ts,kind,text}], slide:0..1 (new last point),
             markAlpha:{key:0..1}, emptyText } */
  function line(canvas, opts) {
    var s = setup(canvas), ctx = s.ctx, w = s.w, h = s.h;
    var pts = (opts.points || []).slice();
    var start = opts.startValue;
    var padL = 16, padR = 16, padB = 18;
    var marksTop = 6, rowH = 22;
    var nMarks = (opts.marks || []).length;
    var plotTop = nMarks ? 64 : 18;
    var plotBot = h - padB;

    if (!pts.length) {
      if (start != null && isFinite(start)) {
        var yy = Math.round((plotTop + plotBot) / 2) + 0.5;
        ctx.setLineDash([4, 4]); ctx.strokeStyle = C.text3; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke(); ctx.setLineDash([]);
      }
      return { empty: true };
    }

    // slide-in: last point eases from previous value/position
    var slide = opts.slide == null ? 1 : opts.slide;
    var t0 = pts[0].ts, t1 = pts[pts.length - 1].ts;
    if (pts.length > 1 && slide < 1) {
      var a = pts[pts.length - 2], b = pts[pts.length - 1];
      pts[pts.length - 1] = { ts: lerp(a.ts, b.ts, slide), value: lerp(a.value, b.value, slide) };
      t1 = lerp(a.ts, b.ts, 1); // keep the x domain fixed so the point slides in
    }
    var vals = pts.map(function (p) { return p.value; });
    if (start != null && isFinite(start)) vals.push(start);
    var vmin = Math.min.apply(null, vals), vmax = Math.max.apply(null, vals);
    if (vmax - vmin < 1e-9) { vmax += Math.abs(vmax) * 0.01 + 0.01; vmin -= Math.abs(vmin) * 0.01 + 0.01; }
    var pad = (vmax - vmin) * 0.12; vmin -= pad; vmax += pad;
    function X(ts) { return t1 === t0 ? (padL + (w - padR - padL) / 2) : padL + (ts - t0) / (t1 - t0) * (w - padL - padR); }
    function Y(v) { return plotBot - (v - vmin) / (vmax - vmin) * (plotBot - plotTop); }

    // dashed start line
    if (start != null && isFinite(start)) {
      var sy = Math.round(Y(start)) + 0.5;
      ctx.setLineDash([4, 4]); ctx.strokeStyle = C.text3; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, sy); ctx.lineTo(w - padR, sy); ctx.stroke(); ctx.setLineDash([]);
    }
    // gradient fill under the line
    var g = ctx.createLinearGradient(0, plotTop, 0, plotBot);
    g.addColorStop(0, 'rgba(0,211,90,0.28)'); g.addColorStop(1, 'rgba(0,211,90,0)');
    ctx.beginPath();
    pts.forEach(function (p, i) { var x = X(p.ts), y = Y(p.value); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.lineTo(X(pts[pts.length - 1].ts), plotBot); ctx.lineTo(X(pts[0].ts), plotBot); ctx.closePath();
    ctx.fillStyle = g; ctx.fill();
    // line
    ctx.beginPath();
    pts.forEach(function (p, i) { var x = X(p.ts), y = Y(p.value); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.strokeStyle = C.green; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
    // last dot
    var lp = pts[pts.length - 1];
    ctx.beginPath(); ctx.arc(X(lp.ts), Y(lp.value), 4, 0, Math.PI * 2); ctx.fillStyle = C.green; ctx.fill();

    // marks
    function valueAt(ts) {
      if (ts <= pts[0].ts) return pts[0].value;
      for (var i = 1; i < pts.length; i++) {
        if (pts[i].ts >= ts) {
          var p0 = pts[i - 1], p1 = pts[i], f = (ts - p0.ts) / ((p1.ts - p0.ts) || 1);
          return lerp(p0.value, p1.value, f);
        }
      }
      return pts[pts.length - 1].value;
    }
    ctx.font = '600 12px ' + FONT;
    var items = (opts.marks || []).filter(function (m) { return m.ts >= t0 - 60 && m.ts <= t1 + 60; }).map(function (m) {
      var px = Math.max(padL, Math.min(w - padR, X(Math.max(t0, Math.min(t1, m.ts)))));
      return { m: m, px: px, py: Y(valueAt(m.ts)), tw: ctx.measureText(m.text).width };
    });
    layoutMarks(items, rowH, marksTop);
    items.forEach(function (it) {
      var col = it.m.kind === 'bought' ? C.blue : it.m.kind === 'sold' ? C.green : C.red;
      var alpha = opts.markAlpha && opts.markAlpha[it.m.key] != null ? opts.markAlpha[it.m.key] : 1;
      ctx.globalAlpha = alpha;
      var r = it.rect;
      // clamp horizontally
      if (r.x < 4) r.x = 4; if (r.x + r.w > w - 4) r.x = w - 4 - r.w;
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.globalAlpha = alpha * 0.5;
      ctx.beginPath(); ctx.moveTo(it.px + 0.5, r.y + r.h); ctx.lineTo(it.px + 0.5, it.py - 5); ctx.stroke();
      ctx.globalAlpha = alpha;
      roundRect(ctx, r.x, r.y, r.w, r.h, r.h / 2); ctx.fillStyle = C.card2; ctx.fill();
      ctx.fillStyle = col; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      ctx.fillText(it.m.text, r.x + r.w / 2, r.y + r.h / 2 + 0.5);
      ctx.beginPath(); ctx.arc(it.px, it.py, 3.5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      ctx.globalAlpha = 1;
    });
    return { empty: false };
  }

  function fmtP(v) {
    if (v == null || !isFinite(v)) return '';
    var a = Math.abs(v);
    if (a >= 1000) return v.toFixed(0);
    if (a >= 1) return v.toFixed(4);
    if (a === 0) return '0';
    var d = Math.min(12, Math.max(2, 3 - Math.floor(Math.log10(a))));
    return v.toFixed(d);
  }

  /* Coin 1-minute candles + volume. opts: { candles:[{ts,open,high,low,close,volume}], exitLine, entry } */
  function candles(canvas, opts) {
    var s = setup(canvas), ctx = s.ctx, w = s.w, h = s.h;
    var cs = (opts.candles || []).slice(-90);
    var padL = 16, padR = 78, top = 12, volH = Math.round(h * 0.18), gap = 8;
    var priceBot = h - volH - gap - 4;
    if (!cs.length) {
      ctx.fillStyle = C.text2; ctx.font = '15px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(opts.emptyText || 'No price ticks yet', w / 2, h / 2);
      return;
    }
    var lows = cs.map(function (c) { return c.low; }), highs = cs.map(function (c) { return c.high; });
    var extra = [opts.exitLine, opts.entry].filter(function (v) { return v != null && isFinite(v) && v > 0; });
    var vmin = Math.min.apply(null, lows.concat(extra)), vmax = Math.max.apply(null, highs.concat(extra));
    if (vmax - vmin <= 0) { vmax = vmax * 1.01 || 1; vmin = vmin * 0.99; }
    var p = (vmax - vmin) * 0.08; vmin -= p; vmax += p;
    function Y(v) { return priceBot - (v - vmin) / (vmax - vmin) * (priceBot - top); }
    var n = Math.max(cs.length, 20), slot = (w - padL - padR) / n, bw = Math.max(1.5, Math.min(10, slot * 0.66));
    var x0 = w - padR - cs.length * slot;

    // grid labels
    ctx.font = '11px ' + MONO; ctx.fillStyle = C.text3; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    [vmax - p, (vmax + vmin) / 2, vmin + p].forEach(function (v) {
      var y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = 'rgba(84,84,88,0.3)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR + 4, y); ctx.stroke();
      ctx.fillText(fmtP(v), w - padR + 8, y);
    });

    var vmaxVol = Math.max.apply(null, cs.map(function (c) { return c.volume || 0; })) || 0;
    cs.forEach(function (c, i) {
      var cx = x0 + i * slot + slot / 2;
      var up = c.close >= c.open, col = up ? C.green : C.red;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(cx) + 0.5, Y(c.high)); ctx.lineTo(Math.round(cx) + 0.5, Y(c.low)); ctx.stroke();
      var yo = Y(c.open), yc = Y(c.close), bh = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(cx - bw / 2, Math.min(yo, yc), bw, bh);
      if (vmaxVol > 0 && c.volume > 0) {
        var vh = (c.volume / vmaxVol) * volH;
        ctx.globalAlpha = 0.45; ctx.fillRect(cx - bw / 2, h - 4 - vh, bw, vh); ctx.globalAlpha = 1;
      }
    });

    if (opts.entry != null && isFinite(opts.entry) && opts.entry > 0) {
      var ey = Math.round(Y(opts.entry)) + 0.5;
      ctx.setLineDash([2, 4]); ctx.strokeStyle = C.text3; ctx.beginPath(); ctx.moveTo(padL, ey); ctx.lineTo(w - padR + 4, ey); ctx.stroke(); ctx.setLineDash([]);
    }
    if (opts.exitLine != null && isFinite(opts.exitLine) && opts.exitLine > 0) {
      var xy = Math.round(Y(opts.exitLine)) + 0.5;
      ctx.setLineDash([6, 4]); ctx.strokeStyle = C.orange; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(padL, xy); ctx.lineTo(w - padR + 4, xy); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = '600 11px ' + FONT; ctx.fillStyle = C.orange; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText('Risk trailing stop', padL, xy - 3);
      ctx.font = '11px ' + MONO; ctx.textBaseline = 'middle'; ctx.fillText(fmtP(opts.exitLine), w - padR + 8, xy);
    }
  }

  /* Analyst score ring 0-100, green from `min`. */
  function ring(canvas, score, min) {
    var s = setup(canvas), ctx = s.ctx, w = s.w, h = s.h;
    var r = Math.min(w, h) / 2 - 8, cx = w / 2, cy = h / 2, lw = Math.max(6, r * 0.16);
    if (r < 8) return;   // not laid out yet (hidden view)
    ctx.lineCap = 'round'; ctx.lineWidth = lw;
    ctx.strokeStyle = '#2c2c2e'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    var has = score != null && isFinite(score);
    if (has) {
      var f = Math.max(0, Math.min(100, score)) / 100;
      ctx.strokeStyle = score >= (min == null ? 70 : min) ? C.green : C.yellow;
      ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = has ? C.text : C.text3; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 ' + Math.round(r * 0.62) + 'px -apple-system, "SF Pro Display", system-ui, sans-serif';
    ctx.fillText(has ? String(Math.round(score)) : '\u2014', cx, cy + 1);
  }

  window.FDChart = { line: line, candles: candles, ring: ring, layoutMarks: layoutMarks, setup: setup, fmtP: fmtP };
})();
