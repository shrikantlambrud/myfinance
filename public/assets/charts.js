// Tiny dependency-free chart helpers. Everything is inline SVG/HTML so it works under the
// app's strict CSP (no external scripts) and stays crisp on any screen. Colours come from the
// .ch-* classes in styles.css, so charts follow the design tokens.
import { h, raw, esc } from './ui.js';

const CLS = (i) => (i % 8) + 1;

export function compact(n) {
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  const t = (x) => String(Math.round(x * 10) / 10).replace(/\.0$/, '');
  if (a >= 1e7) return `${sign}₹${t(a / 1e7)}Cr`;
  if (a >= 1e5) return `${sign}₹${t(a / 1e5)}L`;
  if (a >= 1e3) return `${sign}₹${t(a / 1e3)}K`;
  return `${sign}₹${Math.round(a)}`;
}

function niceStep(range, ticks) {
  const r = range / ticks;
  const p = 10 ** Math.floor(Math.log10(r));
  const f = r / p;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * p;
}
function scaleFor(values, ticks = 4) {
  let hi = Math.max(0, ...values);
  const lo = Math.min(0, ...values);
  if (hi === 0 && lo === 0) hi = 1;
  const step = niceStep(hi - lo, ticks);
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, step };
}

// Grid lines, y-axis labels and x-axis labels shared by bar and line charts.
function axes({ w, H, m, sc, labels, fmt }) {
  const pw = w - m.l - m.r;
  const ph = H - m.t - m.b;
  const y = (v) => m.t + ph - ((v - sc.min) / (sc.max - sc.min)) * ph;
  const n = labels.length;
  const slot = pw / n;
  let g = '';
  const count = Math.round((sc.max - sc.min) / sc.step);
  for (let i = 0; i <= count; i++) {
    const v = sc.min + i * sc.step;
    const yy = y(v);
    g += `<line class="${Math.abs(v) < 1e-9 ? 'ch-zero' : 'ch-grid'}" x1="${m.l}" x2="${w - m.r}" y1="${yy}" y2="${yy}"/>`;
    g += `<text class="ch-t" x="${m.l - 6}" y="${yy + 3.5}" text-anchor="end">${esc(fmt(v))}</text>`;
  }
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 46))));
  labels.forEach((lb, i) => {
    if ((n - 1 - i) % every !== 0) return;
    g += `<text class="ch-t" x="${m.l + slot * (i + 0.5)}" y="${H - 8}" text-anchor="middle">${esc(lb)}</text>`;
  });
  return { y, slot, grid: g, pw, ph };
}

export function legend(series) {
  return h`<div class="legend">${series.map((s, i) => h`<span class="lg"><i class="dot ch-b${CLS(s.c ?? i)}"></i>${s.name}</span>`)}</div>`;
}

/** Grouped or stacked vertical bars. series: [{name, values[], c?}] */
export function barChart({ labels, series, stacked = false, w = 560, H = 240, fmt = compact, tip = fmt }) {
  const m = { l: 50, r: 8, t: 10, b: 26 };
  const n = labels.length;
  const vals = stacked
    ? labels.map((_, i) => series.reduce((t, s) => t + Math.max(0, s.values[i]), 0))
    : series.flatMap((s) => s.values);
  const sc = scaleFor(vals);
  const ax = axes({ w, H, m, sc, labels, fmt });
  let bars = '';
  labels.forEach((lb, i) => {
    if (stacked) {
      const bw = Math.min(34, ax.slot * 0.62);
      const x = m.l + ax.slot * i + (ax.slot - bw) / 2;
      let base = 0;
      series.forEach((s, si) => {
        const v = Math.max(0, s.values[i]);
        if (v <= 0) return;
        const y1 = ax.y(base + v);
        const y0 = ax.y(base);
        bars += `<rect class="ch-f${CLS(s.c ?? si)}" x="${x}" y="${y1}" width="${bw}" height="${Math.max(0, y0 - y1)}" rx="2"><title>${esc(lb)} · ${esc(s.name)}: ${esc(tip(s.values[i]))}</title></rect>`;
        base += v;
      });
    } else {
      const bw = Math.min(26, (ax.slot * 0.74) / series.length);
      const gw = bw * series.length;
      const x0 = m.l + ax.slot * i + (ax.slot - gw) / 2;
      series.forEach((s, si) => {
        const v = s.values[i];
        const yv = ax.y(v);
        const y0 = ax.y(0);
        bars += `<rect class="ch-f${CLS(s.c ?? si)}" x="${x0 + si * bw}" y="${Math.min(yv, y0)}" width="${Math.max(1, bw - 2)}" height="${Math.abs(yv - y0)}" rx="2"><title>${esc(lb)} · ${esc(s.name)}: ${esc(tip(v))}</title></rect>`;
      });
    }
  });
  return raw(`<svg class="chart" viewBox="0 0 ${w} ${H}" role="img" aria-label="Bar chart">${ax.grid}${bars}</svg>`);
}

/** Line (optionally with soft area under it). series: [{name, values[], c?}] */
export function lineChart({ labels, series, w = 560, H = 240, fmt = compact, tip = fmt, area = true }) {
  const m = { l: 50, r: 12, t: 10, b: 26 };
  const sc = scaleFor(series.flatMap((s) => s.values));
  const ax = axes({ w, H, m, sc, labels, fmt });
  let out = '';
  series.forEach((s, si) => {
    const c = CLS(s.c ?? si);
    const pts = s.values.map((v, i) => [m.l + ax.slot * (i + 0.5), ax.y(v)]);
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    if (area && pts.length > 1) {
      out += `<path class="ch-a${c}" d="${path} L${pts[pts.length - 1][0].toFixed(1)} ${ax.y(0).toFixed(1)} L${pts[0][0].toFixed(1)} ${ax.y(0).toFixed(1)} Z"/>`;
    }
    out += `<path class="ch-l ch-s${c}" d="${path}" fill="none"/>`;
    pts.forEach((p, i) => {
      out += `<circle class="ch-f${c}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.2"><title>${esc(labels[i])} · ${esc(s.name)}: ${esc(tip(s.values[i]))}</title></circle>`;
    });
  });
  return raw(`<svg class="chart" viewBox="0 0 ${w} ${H}" role="img" aria-label="Line chart">${ax.grid}${out}</svg>`);
}

/** Donut with a legend (value + share). items: [{label, value}] */
export function donutChart({ items, centerValue = '', centerLabel = '', fmt = compact, tip = fmt }) {
  const data = items.filter((i) => i.value > 0);
  const total = data.reduce((t, i) => t + i.value, 0);
  if (!total) return h`<div class="chart-empty">Nothing to show yet</div>`;
  let acc = 0;
  const arcs = data.map((it, idx) => {
    const p = (it.value / total) * 100;
    const el = `<circle class="ch-s${CLS(idx)}" r="15.9155" cx="21" cy="21" fill="none" stroke-width="6" stroke-dasharray="${p.toFixed(3)} ${(100 - p).toFixed(3)}" stroke-dashoffset="${(25 - acc).toFixed(3)}"><title>${esc(it.label)}: ${esc(tip(it.value))} (${p.toFixed(1)}%)</title></circle>`;
    acc += p;
    return el;
  }).join('');
  const svg = `<svg class="donut" viewBox="0 0 42 42" role="img" aria-label="Donut chart"><circle class="ch-ring" r="15.9155" cx="21" cy="21" fill="none" stroke-width="6"/>${arcs}` +
    (centerValue ? `<text class="ch-cv" x="21" y="21.6" text-anchor="middle">${esc(centerValue)}</text>` : '') +
    (centerLabel ? `<text class="ch-cl" x="21" y="26.4" text-anchor="middle">${esc(centerLabel)}</text>` : '') + '</svg>';
  return h`<div class="donut-wrap">${raw(svg)}<ul class="dlegend">${data.map((it, idx) => h`<li><i class="dot ch-b${CLS(idx)}"></i><span class="dl">${it.label}</span><span class="dv num">${fmt(it.value)}</span><span class="dp">${Math.round((it.value / total) * 100)}%</span></li>`)}</ul></div>`;
}

/** Horizontal bars as plain HTML (labels wrap nicely on phones). items: [{label, value, sub?}] */
export function hbars({ items, fmt = compact, cls = 'ch-b1' }) {
  const max = Math.max(0, ...items.map((i) => i.value));
  if (!max) return h`<div class="chart-empty">Nothing to show yet</div>`;
  return h`<div class="hb">${items.map((it) => h`<div class="hb-row"><div class="hb-l">${it.label}${it.sub ? h`<small>${it.sub}</small>` : ''}</div>
    <div class="hb-track"><i class="hb-fill ${cls}" data-w="${it.value > 0 ? Math.max(2, Math.round((it.value / max) * 100)) : 0}"></i></div><div class="hb-v num">${fmt(it.value)}</div></div>`)}</div>`;
}
