/**
 * ======== CONFIGURE THESE ========
 */
const SHEET_ID   = 'PUT_YOUR_SHEET_ID_HERE';   // from Sheet URL
const SHEET_NAME = 'Sheet1';                    // tab name
const PHOTOS_FOLDER_ID    = 'PUT_PHOTOS_FOLDER_ID';
const VIDEOS_FOLDER_ID    = 'PUT_VIDEOS_FOLDER_ID';
const DOCUMENTS_FOLDER_ID = 'PUT_DOCUMENTS_FOLDER_ID';

/**
 * ======== HELPERS ========
 */
function sheet_() {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
}

function headerMap_() {
  const sh = sheet_();
  const headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach((h,i)=> map[h]=i+1);
  return map;
}

function saveBlobToFolder_(blob, folderId) {
  if (!blob) return null;
  const folder = DriveApp.getFolderById(folderId);
  const name = blob.getName() || ('upload_' + Date.now());
  const file = folder.createFile(blob.setName(name));
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch(e) {}
  return file.getUrl();
}

function collectFiles_(filesObj, prefix) {
  const links = [];
  if (!filesObj) return links;
  Object.keys(filesObj).forEach(k => {
    if (k === prefix || k.indexOf(prefix + '[') === 0) {
      const url = saveBlobToFolder_(filesObj[k],
        prefix.startsWith('photo') ? PHOTOS_FOLDER_ID :
        prefix.startsWith('video') ? VIDEOS_FOLDER_ID :
        DOCUMENTS_FOLDER_ID
      );
      if (url) links.push(url);
    }
  });
  return links;
}

function webAppUrl_() {
  try { return ScriptApp.getService().getUrl(); } catch(e) { return ''; }
}

function findRowByToken_(token) {
  if (!token) return -1;
  const sh = sheet_();
  const hm = headerMap_();
  const col = hm['Token'];
  if (!col) return -1;
  const vals = sh.getRange(2, col, Math.max(0, sh.getLastRow()-1), 1).getValues().flat();
  const idx = vals.indexOf(token);
  return idx === -1 ? -1 : (idx+2); // +2 offset (header + zero-index)
}

/**
 * ======== ROUTES ========
 * GET  ?action=get&token=...
 * POST (create)        -> no action or action=create
 * POST (update by token) -> action=update&token=...
 */
function doGet(e) {
  const action = (e.parameter.action || 'ping').toLowerCase();
  if (action === 'get') {
    const token = (e.parameter.token || '').trim();
    const row = findRowByToken_(token);
    if (row < 0) return json_({ok:false, message:'Invalid token'});
    const hm = headerMap_();
    const range = sheet_().getRange(row, 1, 1, sheet_().getLastColumn()).getValues()[0];
    const obj = {
      timestamp: range[hm['Timestamp']-1],
      token:     range[hm['Token']-1],
      name:      range[hm['Patient Name']-1] || '',
      age:       range[hm['Age']-1] || '',
      gender:    range[hm['Gender']-1] || '',
      notes:     range[hm['Notes']-1] || '',
      photos:    (range[hm['Photo Links']-1]||'').split(' | ').filter(Boolean),
      videos:    (range[hm['Video Links']-1]||'').split(' | ').filter(Boolean),
      documents: (range[hm['Document Links']-1]||'').split(' | ').filter(Boolean),
    };
    return json_({ok:true, data: obj});
  }
  // simple health check
  return json_({ok:true, message:'Web app running'});
}

function doPost(e) {
  const params = e.parameter || {};
  const files  = e.files || {};
  const action = (params.action || 'create').toLowerCase();

  if (action === 'update') {
    return update_(params, files);
  }
  return create_(params, files);
}

/**
 * CREATE
 */
function create_(params, files) {
  try {
    const name   = (params.name   || '').trim();
    const age    = (params.age    || '').trim();
    const gender = (params.gender || '').trim();
    const notes  = (params.notes  || '').trim();

    const photoLinks = collectFiles_(files, 'photos');
    const videoLinks = collectFiles_(files, 'videos');
    const docLinks   = collectFiles_(files, 'documents');

    const token = Utilities.getUuid();
    const sh = sheet_();
    const hm = headerMap_();

    const row = new Array(sh.getLastColumn()).fill('');
    row[hm['Timestamp']-1]    = new Date();
    row[hm['Token']-1]        = token;
    row[hm['Patient Name']-1] = name;
    row[hm['Age']-1]          = age;
    row[hm['Gender']-1]       = gender;
    row[hm['Notes']-1]        = notes;
    row[hm['Photo Links']-1]  = photoLinks.join(' | ');
    row[hm['Video Links']-1]  = videoLinks.join(' | ');
    row[hm['Document Links']-1]= docLinks.join(' | ');
    sh.appendRow(row);

    const base = webAppUrl_();
    const editUrl = base ? `${base}?token=${encodeURIComponent(token)}` : '';

    return json_({
      ok:true,
      message:'Saved successfully',
      editUrl,
      token,
      data: { name, age, gender, notes, photos:photoLinks, videos:videoLinks, documents:docLinks }
    });
  } catch (err) {
    return json_({ok:false, message:String(err)});
  }
}

/**
 * UPDATE (by token)
 * If NO new files uploaded, keeps existing file links.
 * If new files uploaded, replaces those link sets.
 */
function update_(params, files) {
  try {
    const token = (params.token || '').trim();
    const rowIdx = findRowByToken_(token);
    if (rowIdx < 0) return json_({ok:false, message:'Invalid token'});

    const sh = sheet_();
    const hm = headerMap_();
    const rowRange = sh.getRange(rowIdx, 1, 1, sh.getLastColumn());
    const rowVals  = rowRange.getValues()[0];

    const name   = (params.name   ?? rowVals[hm['Patient Name']-1]).toString();
    const age    = (params.age    ?? rowVals[hm['Age']-1]).toString();
    const gender = (params.gender ?? rowVals[hm['Gender']-1]).toString();
    const notes  = (params.notes  ?? rowVals[hm['Notes']-1]).toString();

    // Existing links
    let photoLinks = (rowVals[hm['Photo Links']-1]  || '').split(' | ').filter(Boolean);
    let videoLinks = (rowVals[hm['Video Links']-1]  || '').split(' | ').filter(Boolean);
    let docLinks   = (rowVals[hm['Document Links']-1]|| '').split(' | ').filter(Boolean);

    // If user attached any new files, REPLACE that category
    const newPhotos = collectFiles_(files, 'photos');
    const newVideos = collectFiles_(files, 'videos');
    const newDocs   = collectFiles_(files, 'documents');
    if (newPhotos.length) photoLinks = newPhotos;
    if (newVideos.length) videoLinks = newVideos;
    if (newDocs.length)   docLinks   = newDocs;

    const updated = rowVals.slice(); // copy
    updated[hm['Patient Name']-1] = name;
    updated[hm['Age']-1]          = age;
    updated[hm['Gender']-1]       = gender;
    updated[hm['Notes']-1]        = notes;
    updated[hm['Photo Links']-1]  = photoLinks.join(' | ');
    updated[hm['Video Links']-1]  = videoLinks.join(' | ');
    updated[hm['Document Links']-1]= docLinks.join(' | ');

    rowRange.setValues([updated]);

    return json_({
      ok:true,
      message:'Updated successfully',
      data: { name, age, gender, notes, photos:photoLinks, videos:videoLinks, documents:docLinks }
    });
  } catch (err) {
    return json_({ok:false, message:String(err)});
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
