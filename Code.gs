/**
 * TaShe Cloud Apps Script REST API
 * Deploy as: Web app, execute as owner, accessible to anyone.
 * Storage root: Google Drive folder 1IRiIh1MOfjJkGAjlj-ig2YD0QBn0pe29
 *
 * Architecture notes:
 * - Google Drive has no folder passwords. This API enforces password gates in
 *   Apps Script using salted SHA-256 hashes stored in Script Properties.
 * - Browser uploads are sent as JSON base64 payloads because GitHub Pages cannot
 *   directly post multipart files into Drive without exposing credentials.
 * - Apps Script web apps cannot reliably stream arbitrary Drive binaries with
 *   headers. Download/preview/share create least-surprise Drive URLs and set
 *   link visibility only when needed, while metadata/password checks remain here.
 */

const CONFIG = Object.freeze({
  ROOT_FOLDER_ID: '1IRiIh1MOfjJkGAjlj-ig2YD0QBn0pe29',
  SECURE_FOLDER_NAME: 'Secure',
  SECURE_FOLDER_PASSWORD: '1663136',
  MAX_UPLOAD_BYTES_PER_FILE: 45 * 1024 * 1024,
  MAX_UPLOAD_FILES: 20,
  CACHE_SECONDS: 45,
  PASSWORD_PREFIX: 'folderPassword:',
  SHARE_PREFIX: 'share:',
  CORS_HEADERS: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  }
});

function doGet(e) {
  return route_(e, 'GET');
}

function doPost(e) {
  return route_(e, 'POST');
}

function doOptions() {
  return json_({ ok: true });
}

function route_(e, method) {
  try {
    ensureSecureFolderPassword_();
    const action = cleanAction_(param_(e, 'action'));
    if (!action) return fail_('Missing action', 400);

    if (method === 'GET') {
      if (action === 'list') return listRoot_(e);
      if (action === 'openFolder') return openFolder_(e);
      if (action === 'download') return fileUrl_(e, 'download');
      if (action === 'preview') return fileUrl_(e, 'preview');
      if (action === 'share') return share_(e);
    }

    if (method === 'POST') {
      if (action === 'upload') return upload_(e);
      if (action === 'createFolder') return createFolder_(e);
      if (action === 'setPassword') return setPassword_(e);
      if (action === 'verifyPassword') return verifyPassword_(e);
    }

    return fail_('Unsupported action or method', 405);
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return fail_('Internal server error', 500, { detail: String(err && err.message ? err.message : err) });
  }
}

function listRoot_(e) {
  return folderContents_(CONFIG.ROOT_FOLDER_ID, e);
}

function openFolder_(e) {
  const id = requiredId_(e, 'id');
  assertFolderInRoot_(id);
  if (isPasswordProtected_(id) && !validAccessToken_(e, id)) {
    return fail_('Password required', 423, { protected: true, id });
  }
  return folderContents_(id, e);
}

function folderContents_(folderId, e) {
  assertFolderInRoot_(folderId);
  const cacheKey = 'contents:' + folderId;
  const cached = CacheService.getScriptCache().get(cacheKey);
  if (cached) return json_(JSON.parse(cached));

  const folder = DriveApp.getFolderById(folderId);
  const folders = [];
  const files = [];
  const folderIterator = folder.getFolders();
  while (folderIterator.hasNext()) folders.push(folderMeta_(folderIterator.next()));
  const fileIterator = folder.getFiles();
  while (fileIterator.hasNext()) files.push(fileMeta_(fileIterator.next()));

  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  const result = {
    ok: true,
    folder: folderMeta_(folder),
    breadcrumb: breadcrumb_(folderId),
    folders,
    files,
    serverTime: new Date().toISOString()
  };
  CacheService.getScriptCache().put(cacheKey, JSON.stringify(result), CONFIG.CACHE_SECONDS);
  return json_(result);
}

function upload_(e) {
  const body = body_(e);
  const folderId = cleanId_(body.folderId || CONFIG.ROOT_FOLDER_ID);
  assertFolderInRoot_(folderId);
  if (isPasswordProtected_(folderId) && !validBodyAccessToken_(body, folderId)) return fail_('Password required', 423);
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) return fail_('No files provided', 400);
  if (files.length > CONFIG.MAX_UPLOAD_FILES) return fail_('Too many files in one request', 413);

  const folder = DriveApp.getFolderById(folderId);
  const uploaded = [];
  files.forEach(item => {
    const name = sanitizeName_(item.name);
    const mimeType = sanitizeMime_(item.mimeType || 'application/octet-stream');
    const data = String(item.data || '').replace(/^data:[^,]+,/, '');
    const bytes = Utilities.base64Decode(data);
    if (bytes.length > CONFIG.MAX_UPLOAD_BYTES_PER_FILE) throw new Error('File exceeds Apps Script upload limit: ' + name);
    const blob = Utilities.newBlob(bytes, mimeType, name);
    const file = folder.createFile(blob);
    uploaded.push(fileMeta_(file));
  });
  clearFolderAndParentCaches_(folderId);
  return json_({ ok: true, uploaded });
}

function createFolder_(e) {
  const body = body_(e);
  const parentId = cleanId_(body.parentId || body.folderId || CONFIG.ROOT_FOLDER_ID);
  assertFolderInRoot_(parentId);
  if (isPasswordProtected_(parentId) && !validBodyAccessToken_(body, parentId)) return fail_('Password required', 423);
  const name = sanitizeName_(body.name);
  const folder = DriveApp.getFolderById(parentId).createFolder(name);
  clearFolderAndParentCaches_(parentId);
  return json_({ ok: true, folder: folderMeta_(folder) });
}

function setPassword_(e) {
  const body = body_(e);
  const folderId = cleanId_(body.folderId || body.id);
  assertFolderInRoot_(folderId);
  if (folderId !== CONFIG.ROOT_FOLDER_ID) {
    const parent = DriveApp.getFolderById(folderId).getParents();
    if (parent.hasNext()) {
      const parentId = parent.next().getId();
      if (isPasswordProtected_(parentId) && !validBodyAccessToken_(body, parentId)) return fail_('Password required', 423);
    }
  }
  const password = String(body.password || '');
  if (password.length < 4 || password.length > 128) return fail_('Password must be 4-128 characters', 400);
  savePassword_(folderId, password);
  clearFolderAndParentCaches_(folderId);
  return json_({ ok: true, protected: true, id: folderId });
}

function verifyPassword_(e) {
  const body = body_(e);
  const folderId = cleanId_(body.folderId || body.id);
  assertFolderInRoot_(folderId);
  const password = String(body.password || '');
  const ok = verifyPasswordValue_(folderId, password);
  if (!ok) return fail_('Invalid password', 401, { verified: false });
  return json_({ ok: true, verified: true, id: folderId, accessToken: accessToken_(folderId) });
}

function fileUrl_(e, mode) {
  const id = requiredId_(e, 'id');
  const file = DriveApp.getFileById(id);
  assertFileInRoot_(file);
  ensureAnyoneReadable_(file);
  return json_({ ok: true, id, url: mode === 'download' ? file.getDownloadUrl() : previewUrl_(file), mode });
}

function share_(e) {
  const id = requiredId_(e, 'id');
  const kind = param_(e, 'type') === 'folder' ? 'folder' : detectItemType_(id);
  const token = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty(CONFIG.SHARE_PREFIX + token, JSON.stringify({ id, kind, createdAt: new Date().toISOString() }));
  if (kind === 'folder') ensureAnyoneReadable_(DriveApp.getFolderById(id));
  else ensureAnyoneReadable_(DriveApp.getFileById(id));
  return json_({ ok: true, id, type: kind, token, url: '?share=' + encodeURIComponent(token) + '&id=' + encodeURIComponent(id) + '&type=' + encodeURIComponent(kind) });
}

function folderMeta_(folder) {
  const id = folder.getId();
  return { id, name: folder.getName(), type: 'folder', mimeType: 'application/vnd.google-apps.folder', modifiedTime: folder.getLastUpdated().toISOString(), protected: isPasswordProtected_(id), size: 0 };
}

function fileMeta_(file) {
  return { id: file.getId(), name: file.getName(), type: 'file', mimeType: file.getMimeType(), modifiedTime: file.getLastUpdated().toISOString(), size: Number(file.getSize() || 0), extension: extension_(file.getName()) };
}

function breadcrumb_(folderId) {
  const crumbs = [];
  let current = DriveApp.getFolderById(folderId);
  for (let i = 0; i < 30; i++) {
    crumbs.unshift({ id: current.getId(), name: current.getId() === CONFIG.ROOT_FOLDER_ID ? 'Home' : current.getName() });
    if (current.getId() === CONFIG.ROOT_FOLDER_ID) break;
    const parents = current.getParents();
    if (!parents.hasNext()) break;
    current = parents.next();
  }
  return crumbs;
}

function assertFolderInRoot_(folderId) {
  const folder = DriveApp.getFolderById(folderId);
  if (folderId === CONFIG.ROOT_FOLDER_ID) return true;
  let parents = folder.getParents();
  let guard = 0;
  while (parents.hasNext() && guard++ < 50) {
    const parent = parents.next();
    if (parent.getId() === CONFIG.ROOT_FOLDER_ID) return true;
    parents = parent.getParents();
  }
  throw new Error('Folder is outside TaShe Cloud root');
}

function assertFileInRoot_(file) {
  const parents = file.getParents();
  while (parents.hasNext()) if (assertFolderInRoot_(parents.next().getId())) return true;
  throw new Error('File is outside TaShe Cloud root');
}

function ensureSecureFolderPassword_() {
  const root = DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID);
  const matches = root.getFoldersByName(CONFIG.SECURE_FOLDER_NAME);
  let created = false;
  const folder = matches.hasNext() ? matches.next() : (created = true, root.createFolder(CONFIG.SECURE_FOLDER_NAME));
  let updatedPassword = false;
  if (!isPasswordProtected_(folder.getId())) {
    savePassword_(folder.getId(), CONFIG.SECURE_FOLDER_PASSWORD);
    updatedPassword = true;
  }
  if (created || updatedPassword) {
    clearFolderAndParentCaches_(folder.getId());
  }
}

function savePassword_(folderId, password) {
  const salt = Utilities.getUuid() + Utilities.getUuid();
  const hash = hash_(salt + password);
  PropertiesService.getScriptProperties().setProperty(CONFIG.PASSWORD_PREFIX + folderId, JSON.stringify({ salt, hash, updatedAt: new Date().toISOString() }));
}

function verifyPasswordValue_(folderId, password) {
  const raw = PropertiesService.getScriptProperties().getProperty(CONFIG.PASSWORD_PREFIX + folderId);
  if (!raw) return true;
  const record = JSON.parse(raw);
  return hash_(record.salt + password) === record.hash;
}

function isPasswordProtected_(folderId) {
  return !!PropertiesService.getScriptProperties().getProperty(CONFIG.PASSWORD_PREFIX + folderId);
}

function accessToken_(folderId) {
  const raw = PropertiesService.getScriptProperties().getProperty(CONFIG.PASSWORD_PREFIX + folderId) || '';
  return hash_(folderId + ':' + raw).slice(0, 40);
}

function validAccessToken_(e, folderId) { return param_(e, 'accessToken') === accessToken_(folderId); }
function validBodyAccessToken_(body, folderId) { return body.accessToken === accessToken_(folderId); }
function hash_(value) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value).map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join(''); }
function ensureAnyoneReadable_(item) { item.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
function previewUrl_(file) { return 'https://drive.google.com/file/d/' + encodeURIComponent(file.getId()) + '/preview'; }
function detectItemType_(id) { try { DriveApp.getFolderById(id); return 'folder'; } catch (err) { return 'file'; } }
function extension_(name) { const p = String(name).split('.'); return p.length > 1 ? p.pop().toLowerCase() : ''; }
function clearFolderCache_(folderId) { CacheService.getScriptCache().remove('contents:' + folderId); }
function clearFolderAndParentCaches_(folderId) {
  const cache = CacheService.getScriptCache();
  cache.remove('contents:' + folderId);
  try {
    let current = DriveApp.getFolderById(folderId);
    let guard = 0;
    while (guard++ < 50) {
      const parents = current.getParents();
      if (!parents.hasNext()) break;
      current = parents.next();
      cache.remove('contents:' + current.getId());
      if (current.getId() === CONFIG.ROOT_FOLDER_ID) break;
    }
  } catch (err) {}
}
function cleanAction_(value) { return String(value || '').replace(/[^a-zA-Z]/g, ''); }
function requiredId_(e, key) { const id = cleanId_(param_(e, key)); if (!id) throw new Error('Missing id'); return id; }
function cleanId_(value) { return String(value || '').replace(/[^a-zA-Z0-9_-]/g, ''); }
function sanitizeMime_(value) { return String(value).replace(/[^-+./a-zA-Z0-9]/g, '').slice(0, 120) || 'application/octet-stream'; }
function sanitizeName_(value) { const name = String(value || '').replace(/[\\/:*?"<>|\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180); if (!name || name === '.' || name === '..') throw new Error('Invalid name'); return name; }
function param_(e, key) { return e && e.parameter ? e.parameter[key] : ''; }
function body_(e) { return e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {}; }
function json_(payload) { return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON); }
function fail_(message, status, extra) { return json_(Object.assign({ ok: false, error: message, status: status || 400 }, extra || {})); }
