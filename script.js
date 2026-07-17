const api = new TasheApi(window.TASHE_CONFIG);
const ui = new TasheUi();
const state = { folderId: window.TASHE_CONFIG.rootFolderId, access: {}, items: [], folder: null, breadcrumb: [], view: localStorage.getItem('tashe.view') || 'grid', query: '', sort: 'name' };

const els = {
  area: document.getElementById('fileArea'), breadcrumb: document.getElementById('breadcrumb'), search: document.getElementById('searchInput'), sort: document.getElementById('sortSelect'), dropzone: document.getElementById('dropzone'), fileInput: document.getElementById('fileInput'), progress: document.getElementById('progressPanel'), sidebar: document.getElementById('sidebar')
};

document.addEventListener('DOMContentLoaded', init);
document.addEventListener('click', () => ui.hideMenu());

async function init() {
  document.body.dataset.theme = localStorage.getItem('tashe.theme') || 'dark';
  bindEvents();
  if (!window.TASHE_CONFIG.apiBaseUrl) await configureApi();
  await loadRoot();
}

function bindEvents() {
  document.getElementById('themeButton').onclick = () => { document.body.dataset.theme = document.body.dataset.theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('tashe.theme', document.body.dataset.theme); };
  document.getElementById('sidebarToggle').onclick = () => els.sidebar.classList.toggle('open');
  document.querySelector('[data-root]').onclick = loadRoot;
  document.getElementById('uploadButton').onclick = () => els.fileInput.click();
  document.getElementById('uploadShortcut').onclick = () => els.fileInput.click();
  document.getElementById('newFolderShortcut').onclick = createFolder;
  document.getElementById('secureButton').onclick = openSecure;
  document.getElementById('viewButton').onclick = () => { state.view = state.view === 'grid' ? 'list' : 'grid'; localStorage.setItem('tashe.view', state.view); render(); };
  els.search.oninput = Utils.debounce(e => { state.query = e.target.value.toLowerCase(); render(); });
  els.sort.onchange = e => { state.sort = e.target.value; render(); };
  els.fileInput.onchange = e => uploadFiles([...e.target.files]);
  ['dragenter','dragover'].forEach(name => els.dropzone.addEventListener(name, e => { e.preventDefault(); els.dropzone.classList.add('drag'); }));
  ['dragleave','drop'].forEach(name => els.dropzone.addEventListener(name, e => { e.preventDefault(); els.dropzone.classList.remove('drag'); }));
  els.dropzone.addEventListener('drop', e => uploadFiles([...e.dataTransfer.files]));
}

async function configureApi() {
  const url = await ui.prompt({ title: 'Connect Apps Script API', label: 'Paste deployed Web App URL' });
  if (!url) throw new Error('Apps Script API URL is required.');
  api.setBaseUrl(url);
}

async function loadRoot() { state.folderId = window.TASHE_CONFIG.rootFolderId; await loadFolder(state.folderId); }
async function loadFolder(id) {
  try {
    const data = id === window.TASHE_CONFIG.rootFolderId ? await api.list() : await api.openFolder(id, state.access[id]);
    state.folderId = id; state.folder = data.folder; state.breadcrumb = data.breadcrumb; state.items = [...data.folders, ...data.files]; render();
  } catch (err) {
    if (err.data?.status === 423 || err.data?.protected) return unlockFolder(id);
    ui.toast(err.message);
  }
}

async function unlockFolder(id) {
  const password = await ui.prompt({ title: 'Protected folder', label: 'Password', type: 'password' });
  if (!password) return;
  try { const data = await api.verifyPassword(id, password); state.access[id] = data.accessToken; await loadFolder(id); } catch (err) { ui.toast('Incorrect password'); }
}

async function openSecure() {
  const root = state.folderId === window.TASHE_CONFIG.rootFolderId && state.items.length ? state.items : (await api.list()).folders;
  const secure = root.find(x => x.type === 'folder' && x.name.toLowerCase() === 'secure');
  if (!secure) return ui.toast('Secure folder is being prepared. Refresh and try again.');
  await unlockFolder(secure.id);
}

function render() {
  els.area.className = `file-area ${state.view}`;
  renderBreadcrumb();
  const filtered = Utils.sort(state.items.filter(i => i.name.toLowerCase().includes(state.query)), state.sort);
  els.area.innerHTML = filtered.length ? filtered.map(card).join('') : '<div class="empty glass">No files found</div>';
  els.area.querySelectorAll('[data-id]').forEach(el => {
    const item = state.items.find(i => i.id === el.dataset.id);
    el.ondblclick = () => openItem(item);
    el.querySelector('[data-open]').onclick = () => openItem(item);
    el.querySelector('[data-menu]').onclick = e => { e.stopPropagation(); showMenu(e, item); };
    el.oncontextmenu = e => { e.preventDefault(); showMenu(e, item); };
  });
}

function renderBreadcrumb() {
  els.breadcrumb.innerHTML = state.breadcrumb.map((c, i) => `<button data-id="${c.id}">${i ? '› ' : ''}${c.name}</button>`).join('');
  els.breadcrumb.querySelectorAll('button').forEach(btn => btn.onclick = () => loadFolder(btn.dataset.id));
}

function card(item) {
  return `<article class="file-card glass" data-id="${item.id}"><button class="file-main" data-open><span class="file-icon">${Utils.icon(item)}</span><span class="file-name">${item.name}</span><small>${item.type === 'folder' ? (item.protected ? 'Protected folder' : 'Folder') : `${Utils.formatBytes(item.size)} • ${item.extension || 'file'}`}</small></button><button class="icon-button more" data-menu>⋯</button></article>`;
}

function showMenu(e, item) {
  const actions = [{ label: item.type === 'folder' ? 'Open' : 'Preview', icon: '↗️', run: () => openItem(item) }, { label: 'Download', icon: '⬇️', run: () => downloadItem(item) }, { label: 'Share', icon: '🔗', run: () => shareItem(item) }];
  if (item.type === 'folder') actions.push({ label: 'Set password', icon: '🔒', run: () => setFolderPassword(item) });
  ui.menu(e.clientX, e.clientY, actions);
}

async function openItem(item) { if (item.type === 'folder') return loadFolder(item.id); if (!Utils.canPreview(item)) return downloadItem(item); const data = await api.preview(item.id); ui.preview({ title: item.name, html: `<iframe class="preview-frame" src="${data.url}" allow="autoplay"></iframe>` }); }
async function downloadItem(item) { const data = await api.download(item.id); window.open(data.url, '_blank', 'noopener'); }
async function shareItem(item) { const data = await api.share(item); const url = new URL(window.TASHE_CONFIG.websiteBaseUrl); url.searchParams.set('id', item.id); url.searchParams.set('type', item.type); navigator.clipboard?.writeText(url.toString()); ui.toast('Share link copied'); }
async function setFolderPassword(item) { const p = await ui.prompt({ title: 'Set folder password', label: `Password for ${item.name}`, type: 'password' }); if (p) { await api.setPassword(item.id, p); ui.toast('Password saved'); await loadFolder(state.folderId); } }
async function createFolder() { const name = Utils.safeName(await ui.prompt({ title: 'Create folder', label: 'Folder name' })); if (name) { await api.createFolder(state.folderId, name, state.access[state.folderId]); await loadFolder(state.folderId); } }

async function uploadFiles(files) {
  if (!files.length) return;
  const tooLarge = files.find(f => f.size > window.TASHE_CONFIG.maxUploadBytes);
  if (tooLarge) return ui.toast(`${tooLarge.name} exceeds the Apps Script upload limit.`);
  els.progress.hidden = false; const start = performance.now(); let loaded = 0, total = files.reduce((s,f) => s + f.size, 0);
  const payload = [];
  for (const file of files) {
    payload.push(await Utils.readFile(file, p => { const current = loaded + p.loaded; drawProgress(current, total, start); }));
    loaded += file.size; drawProgress(loaded, total, start);
  }
  await api.upload(state.folderId, payload, state.access[state.folderId]);
  els.progress.hidden = true; ui.toast('Upload complete'); await loadFolder(state.folderId);
}
function drawProgress(loaded, total, start) { const seconds = Math.max((performance.now() - start) / 1000, .1); const speed = loaded / seconds; const remaining = Math.max((total - loaded) / speed, 0); els.progress.innerHTML = `<div class="bar"><span style="width:${Math.round(loaded / total * 100)}%"></span></div><strong>${Math.round(loaded / total * 100)}%</strong><small>${Utils.formatBytes(speed)}/s • ${Math.ceil(remaining)}s remaining</small>`; }
