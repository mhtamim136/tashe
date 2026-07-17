const api = new TasheApi(window.TASHE_CONFIG);
const ui = new TasheUi();
const state = {
  folderId: window.TASHE_CONFIG.rootFolderId,
  access: {},
  items: [],
  itemMap: new Map(),
  folder: null,
  breadcrumb: [],
  view: localStorage.getItem('tashe.view') || 'grid',
  query: '',
  sort: 'name',
  folderCache: new Map(),
  requestSeq: 0
};

const els = {
  area: document.getElementById('fileArea'), breadcrumb: document.getElementById('breadcrumb'), search: document.getElementById('searchInput'), sort: document.getElementById('sortSelect'), dropzone: document.getElementById('dropzone'), fileInput: document.getElementById('fileInput'), progress: document.getElementById('progressPanel'), sidebar: document.getElementById('sidebar')
};

document.addEventListener('DOMContentLoaded', init);
document.addEventListener('click', () => ui.hideMenu());


async function init() {
  document.body.dataset.theme = localStorage.getItem('tashe.theme') || 'dark';

  // Use the preconfigured Apps Script endpoint.
  api.setBaseUrl(window.TASHE_CONFIG.apiBaseUrl);

  bindEvents();
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
  bindAreaEvents();
}


async function loadRoot() { state.folderId = window.TASHE_CONFIG.rootFolderId; await loadFolder(state.folderId); }
async function loadFolder(id, { force = false } = {}) {
  const cached = !force ? state.folderCache.get(id) : null;
  if (cached) {
    applyFolderData(id, cached.data);
    if (Date.now() - cached.time < 30000) return;
  }

  const requestId = ++state.requestSeq;
  try {
    const data = id === window.TASHE_CONFIG.rootFolderId ? await api.list() : await api.openFolder(id, state.access[id]);
    if (requestId !== state.requestSeq) return;
    state.folderCache.set(id, { data, time: Date.now() });
    applyFolderData(id, data);
  } catch (err) {
    if (err.data?.status === 423 || err.data?.protected) return unlockFolder(id);
    ui.toast(err.message);
  }
}

function applyFolderData(id, data) {
  state.folderId = id;
  state.folder = data?.folder || null;
  state.breadcrumb = Array.isArray(data?.breadcrumb) ? data.breadcrumb : [];
  const folders = Array.isArray(data?.folders) ? data.folders : [];
  const files = Array.isArray(data?.files) ? data.files : [];
  state.items = [...folders, ...files];
  state.itemMap = new Map(state.items.map(item => [item.id, item]));
  render();
}

async function unlockFolder(id) {
  const password = await ui.prompt({ title: 'Protected folder', label: 'Password', type: 'password' });
  if (!password) return;
  try { const data = await api.verifyPassword(id, password); state.access[id] = data.accessToken; await loadFolder(id, { force: true }); } catch (err) { ui.toast('Incorrect password'); }
}

async function openSecure() {
  try {
    const rootData = await getRootData();
    const rootFolders = Array.isArray(rootData?.folders) ? rootData.folders : [];
    const secure = rootFolders.find(x => x.type === 'folder' && String(x.name || '').toLowerCase() === 'secure');
    if (!secure) return ui.toast('Secure folder is being prepared. Refresh and try again.');
    await unlockFolder(secure.id);
  } catch (err) {
    ui.toast(err.message || 'Unable to open Secure folder');
  }
}

function render() {
  els.area.className = `file-area ${state.view}`;
  renderBreadcrumb();
  const filtered = Utils.sort(state.items.filter(i => String(i?.name || '').toLowerCase().includes(state.query)), state.sort);
  els.area.innerHTML = filtered.length ? filtered.map(card).join('') : '<div class="empty glass">No files found</div>';
}

function renderBreadcrumb() {
  els.breadcrumb.innerHTML = state.breadcrumb.map((c, i) => `<button data-id="${c.id}">${i ? '› ' : ''}${c.name}</button>`).join('');
  els.breadcrumb.querySelectorAll('button').forEach(btn => btn.onclick = () => loadFolder(btn.dataset.id));
}

function card(item) {
  const itemId = String(item?.id || '');
  const itemName = String(item?.name || 'Untitled');
  return `<article class="file-card glass" data-item-id="${itemId}"><button class="file-main" data-open-id="${itemId}"><span class="file-icon">${Utils.icon(item)}</span><span class="file-name">${itemName}</span><small>${item.type === 'folder' ? (item.protected ? 'Protected folder' : 'Folder') : `${Utils.formatBytes(item.size)} • ${item.extension || 'file'}`}</small></button><button class="icon-button more" data-menu-id="${itemId}">⋯</button></article>`;
}

function showMenu(e, item) {
  const actions = [{ label: item.type === 'folder' ? 'Open' : 'Preview', icon: '↗️', run: () => openItem(item) }, { label: 'Download', icon: '⬇️', run: () => downloadItem(item) }, { label: 'Share', icon: '🔗', run: () => shareItem(item) }];
  if (item.type === 'folder') actions.push({ label: 'Set password', icon: '🔒', run: () => setFolderPassword(item) });
  ui.menu(e.clientX, e.clientY, actions);
}

async function openItem(item) {
  if (!item) return ui.toast('Item not found');
  if (item.type === 'folder') return loadFolder(item.id);
  if (!Utils.canPreview(item)) return downloadItem(item);
  try {
    const data = await api.preview(item.id);
    if (!data?.url) throw new Error('Preview URL unavailable');
    ui.preview({ title: item.name, html: `<iframe class="preview-frame" src="${data.url}" allow="autoplay"></iframe>` });
  } catch (err) {
    ui.toast(err.message || 'Preview failed');
  }
}

async function downloadItem(item) {
  if (!item?.id) return ui.toast('Invalid file');
  try {
    const data = await api.download(item.id);
    if (!data?.url) throw new Error('Download URL unavailable');
    const link = document.createElement('a');
    link.href = data.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.click();
  } catch (err) {
    ui.toast(err.message || 'Download failed');
  }
}

async function shareItem(item) {
  if (!item?.id) return ui.toast('Invalid item');
  try {
    const data = await api.share(item);
    if (!data?.url) throw new Error('Share URL unavailable');
    const shareUrl = new URL(data.url, window.TASHE_CONFIG.websiteBaseUrl).toString();
    const copied = await copyText(shareUrl);
    if (copied) ui.toast('Share link copied');
    else {
      ui.toast('Could not copy link. Opened in new tab.');
      window.open(shareUrl, '_blank', 'noopener');
    }
  } catch (err) {
    ui.toast(err.message || 'Share failed');
  }
}

async function setFolderPassword(item) {
  if (!item?.id || item.type !== 'folder') return ui.toast('Folder required');
  const p = await ui.prompt({ title: 'Set folder password', label: `Password for ${item.name}`, type: 'password' });
  if (!p) return;
  try {
    await api.setPassword(item.id, p, state.access[state.folderId]);
    ui.toast('Password saved');
    state.folderCache.delete(state.folderId);
    await loadFolder(state.folderId, { force: true });
  } catch (err) {
    ui.toast(err.message || 'Failed to save password');
  }
}

async function createFolder() {
  const name = Utils.safeName(await ui.prompt({ title: 'Create folder', label: 'Folder name' }));
  if (!name) return;
  try {
    await api.createFolder(state.folderId, name, state.access[state.folderId]);
    state.folderCache.delete(state.folderId);
    await loadFolder(state.folderId, { force: true });
  } catch (err) {
    ui.toast(err.message || 'Folder creation failed');
  }
}

async function uploadFiles(files) {
  if (!files.length) return;
  const tooLarge = files.find(f => f.size > window.TASHE_CONFIG.maxUploadBytes);
  if (tooLarge) return ui.toast(`${tooLarge.name} exceeds the Apps Script upload limit.`);
  els.progress.hidden = false; const start = performance.now(); let loaded = 0, total = files.reduce((s,f) => s + f.size, 0);
  try {
    const payload = [];
    for (const file of files) {
      payload.push(await Utils.readFile(file, p => { const current = loaded + p.loaded; drawProgress(current, total, start); }));
      loaded += file.size; drawProgress(loaded, total, start);
    }
    await api.upload(state.folderId, payload, state.access[state.folderId]);
    state.folderCache.delete(state.folderId);
    ui.toast('Upload complete');
    await loadFolder(state.folderId, { force: true });
  } catch (err) {
    ui.toast(err.message || 'Upload failed');
  } finally {
    els.progress.hidden = true;
  }
}
function drawProgress(loaded, total, start) { const seconds = Math.max((performance.now() - start) / 1000, .1); const speed = loaded / seconds; const remaining = Math.max((total - loaded) / speed, 0); els.progress.innerHTML = `<div class="bar"><span style="width:${Math.round(loaded / total * 100)}%"></span></div><strong>${Math.round(loaded / total * 100)}%</strong><small>${Utils.formatBytes(speed)}/s • ${Math.ceil(remaining)}s remaining</small>`; }

async function getRootData() {
  const rootId = window.TASHE_CONFIG.rootFolderId;
  const cached = state.folderCache.get(rootId);
  if (cached && Date.now() - cached.time < 30000) return cached.data;
  const data = await api.list();
  state.folderCache.set(rootId, { data, time: Date.now() });
  if (state.folderId === rootId) applyFolderData(rootId, data);
  return data;
}

function bindAreaEvents() {
  els.area.addEventListener('dblclick', e => {
    const cardEl = e.target.closest('[data-item-id]');
    if (!cardEl) return;
    openItem(state.itemMap.get(cardEl.dataset.itemId));
  });

  els.area.addEventListener('click', e => {
    const openButton = e.target.closest('[data-open-id]');
    if (openButton) return openItem(state.itemMap.get(openButton.dataset.openId));
    const menuButton = e.target.closest('[data-menu-id]');
    if (!menuButton) return;
    e.stopPropagation();
    const item = state.itemMap.get(menuButton.dataset.menuId);
    if (!item) return;
    showMenu(e, item);
  });

  els.area.addEventListener('contextmenu', e => {
    const cardEl = e.target.closest('[data-item-id]');
    if (!cardEl) return;
    e.preventDefault();
    const item = state.itemMap.get(cardEl.dataset.itemId);
    if (!item) return;
    showMenu(e, item);
  });
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {}
  const input = document.createElement('textarea');
  input.value = text;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const ok = document.execCommand('copy');
  input.remove();
  return ok;
}
