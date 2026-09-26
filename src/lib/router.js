'use strict';

function compile(pattern) {
  const keys = [];
  const src = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  return { re: new RegExp(`^${src}/?$`), keys };
}

class Router {
  constructor() { this.routes = []; }
  on(method, pattern, ...fns) {
    const { re, keys } = compile(pattern);
    this.routes.push({ method, re, keys, fns });
  }
  get(p, ...f) { this.on('GET', p, ...f); }
  post(p, ...f) { this.on('POST', p, ...f); }
  patch(p, ...f) { this.on('PATCH', p, ...f); }
  put(p, ...f) { this.on('PUT', p, ...f); }
  delete(p, ...f) { this.on('DELETE', p, ...f); }

  // -> { route, params } | { allowed: [methods] } | null
  match(method, path) {
    const allowed = [];
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.method !== method) { allowed.push(r.method); continue; }
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return allowed.length ? { allowed } : null;
  }
}

// Response helpers. A handler may return plain data (-> 200 JSON) or one of these.
const created = (body) => ({ __res: true, status: 201, body });
const csv = (filename, text) => ({
  __res: true, status: 200, raw: '\ufeff' + text,
  headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` },
});

module.exports = { Router, created, csv };
