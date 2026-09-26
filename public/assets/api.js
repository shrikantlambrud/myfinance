// Tiny fetch wrapper: JSON in/out, bearer token, uniform errors.
const KEY = 'mf_token';

export const session = {
  get token() { try { return localStorage.getItem(KEY); } catch { return null; } },
  set(t) { try { localStorage.setItem(KEY, t); } catch { /* private mode */ } },
  clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } },
};

export class ApiError extends Error {
  constructor(status, data) {
    super((data && data.error) || 'Something went wrong');
    this.status = status;
    this.data = data || {};
    this.fields = (data && data.fields) || null;
  }
}

async function request(method, url, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session.token) headers.Authorization = 'Bearer ' + session.token;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, { error: 'Cannot reach the server. Check your internet connection.' });
  }
  return res;
}

export async function api(method, url, body) {
  const res = await request(method, url, body);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && session.token && !url.startsWith('/api/auth/login')) {
      session.clear();
      window.dispatchEvent(new CustomEvent('mf:logout'));
    }
    throw new ApiError(res.status, data);
  }
  return data;
}
export const get = (url) => api('GET', url);
export const post = (url, body) => api('POST', url, body === undefined ? {} : body);
export const patch = (url, body) => api('PATCH', url, body);
export const put = (url, body) => api('PUT', url, body);
export const del = (url) => api('DELETE', url);

// CSV etc: the Authorization header cannot ride on a plain link, so fetch then save the blob.
export async function download(url, filename) {
  const res = await request('GET', url);
  if (!res.ok) throw new ApiError(res.status, { error: 'Could not download the file' });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
