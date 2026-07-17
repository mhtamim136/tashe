class TasheApi {
  constructor(config) { this.config = config; }
  ensureConfigured() { if (!this.config.apiBaseUrl) throw new Error('Connect your deployed Apps Script Web App URL to continue.'); }
  setBaseUrl(url) { this.config.apiBaseUrl = String(url || '').trim(); localStorage.setItem('tashe.apiBaseUrl', this.config.apiBaseUrl); }
  async get(action, params = {}) { this.ensureConfigured(); const url = new URL(this.config.apiBaseUrl); url.searchParams.set('action', action); Object.entries(params).forEach(([k,v]) => v !== undefined && v !== null && url.searchParams.set(k, v)); const res = await fetch(url); return this.parse(res); }
  async post(action, body = {}) { this.ensureConfigured(); const url = new URL(this.config.apiBaseUrl); url.searchParams.set('action', action); const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) }); return this.parse(res); }
  async parse(res) { const data = await res.json().catch(() => ({ ok: false, error: 'Invalid API response' })); if (!data.ok) { const err = new Error(data.error || 'Request failed'); err.data = data; throw err; } return data; }
  list() { return this.get('list'); }
  openFolder(id, accessToken) { return this.get('openFolder', { id, accessToken }); }
  upload(folderId, files, accessToken) { return this.post('upload', { folderId, files, accessToken }); }
  createFolder(parentId, name, accessToken) { return this.post('createFolder', { parentId, name, accessToken }); }
  setPassword(folderId, password) { return this.post('setPassword', { folderId, password }); }
  verifyPassword(folderId, password) { return this.post('verifyPassword', { folderId, password }); }
  download(id) { return this.get('download', { id }); }
  preview(id) { return this.get('preview', { id }); }
  share(item) { return this.get('share', { id: item.id, type: item.type }); }
}
window.TasheApi = TasheApi;
