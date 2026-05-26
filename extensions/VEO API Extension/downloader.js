// VEO Downloader - External JS file (MV3 CSP compliant)
var videos = [];
var isDownloading = false;

function toggleAdvanced() {
  document.getElementById('advancedFields').classList.toggle('visible');
}

function getBaserowUrl() {
  // Returns the full API base, e.g. https://baserow.example.com/api
  // Accepts user input with or without /api suffix and with or without trailing slash.
  var custom = document.getElementById('baserowUrl').value.trim();
  var raw = custom || 'https://api.baserow.io';
  raw = raw.replace(/\/+$/, '');
  if (!/\/api$/.test(raw)) raw += '/api';
  return raw;
}

async function fetchAllRows(token, tableId) {
  var apiBase = getBaserowUrl();
  var allRows = [];
  var page = 1;

  while (true) {
    var url = apiBase + '/database/rows/table/' + tableId + '/?user_field_names=true&size=200&page=' + page;
    var resp = await fetch(url, {
      headers: { 'Authorization': 'Token ' + token }
    });

    if (!resp.ok) {
      var errText = await resp.text();
      throw new Error('Baserow API error ' + resp.status + ': ' + errText);
    }

    var data = await resp.json();
    allRows = allRows.concat(data.results);

    setStatus('Loading page ' + page + '... (' + allRows.length + ' rows so far)');

    if (!data.next) break;
    page++;
  }

  return allRows;
}

async function loadVideos() {
  console.log('[Downloader] loadVideos called');
  var token = document.getElementById('apiToken').value.trim();
  var tableId = document.getElementById('tableId').value.trim();
  var fieldName = document.getElementById('fieldName').value.trim() || 'Video_URL';

  if (!token || !tableId) { setStatus('Please enter API Token and Table ID.', true); return; }

  var loadBtn = document.getElementById('loadBtn');
  loadBtn.disabled = true;
  setStatus('Loading videos from Baserow...');
  document.getElementById('videoListContainer').innerHTML = '';

  try {
    var allRows = await fetchAllRows(token, tableId);

    var filtered = allRows.filter(function(row) {
      var val = row[fieldName];
      return val && typeof val === 'string' && val.indexOf('http') === 0;
    });

    if (filtered.length === 0) {
      document.getElementById('videoListContainer').innerHTML = '<div class="msg">No videos found. Found ' + allRows.length + ' rows but none have a URL in "' + escapeHtml(fieldName) + '".</div>';
      setStatus('No videos found.');
      loadBtn.disabled = false;
      return;
    }

    videos = [];
    filtered.forEach(function(row) {
      var rawUrl = row[fieldName].trim();
      var imagePrompt = row['Image Prompt'] || '';
      var veoPrompt = row['VEO Prompt'] || '';
      var isImage = !!imagePrompt;
      var prompt = imagePrompt || veoPrompt || row['Prompt'] || row['prompt'] || row['Name'] || row['name'] || '';
      var promptStr = typeof prompt === 'string' ? prompt.substring(0, 200) : '';

      var urls = rawUrl.split(',').map(function(u) { return u.trim(); }).filter(function(u) { return u.indexOf('http') === 0; });

      urls.forEach(function(videoUrl, urlIdx) {
        var idx = videos.length + 1;
        var ext = isImage ? '.png' : '.mp4';
        var typeLabel = isImage ? 'image' : 'video';

        var suffix = urls.length > 1 ? '_' + (urlIdx + 1) : '';
        var filename = typeLabel + '_' + idx + suffix + ext;
        if (promptStr) {
          var sanitized = promptStr.substring(0, 60).replace(/[^a-zA-Z0-9_ -]/g, '').trim().replace(/\s+/g, '_');
          if (sanitized) filename = sanitized + suffix + ext;
        }

        videos.push({ url: videoUrl, filename: filename, rowId: row.id, prompt: promptStr + (urls.length > 1 ? ' (' + (urlIdx + 1) + '/' + urls.length + ')' : ''), status: 'waiting' });
      });
    });

    renderVideoList();
    document.getElementById('downloadBtn').disabled = false;
    var multiRows = filtered.filter(function(r) { return r[fieldName].indexOf(',') !== -1; }).length;
    setStatus(videos.length + ' file(s) loaded from ' + filtered.length + ' rows' + (multiRows > 0 ? ' (' + multiRows + ' multi-output)' : '') + '.');
  } catch (err) {
    document.getElementById('videoListContainer').innerHTML = '<div class="msg error-msg">Error: ' + escapeHtml(err.message) + '</div>';
    setStatus('Failed to load videos.', true);
  }

  loadBtn.disabled = false;
}

function renderVideoList() {
  var container = document.getElementById('videoListContainer');
  container.innerHTML = '<div class="video-list" id="videoList"></div>';
  var list = document.getElementById('videoList');
  videos.forEach(function(v, i) {
    var item = document.createElement('div');
    item.className = 'video-item';
    item.id = 'video-' + i;
    item.innerHTML = '<span class="video-num">#' + (i + 1) + '</span><div class="video-info"><div class="video-filename">' + escapeHtml(v.filename) + '</div>' + (v.prompt ? '<div class="video-prompt">' + escapeHtml(v.prompt) + '</div>' : '') + '</div><span class="badge badge-waiting" id="badge-' + i + '">waiting</span><a class="save-link" href="#" data-idx="' + i + '">Save</a>';
    item.querySelector('.save-link').addEventListener('click', function(e) { e.preventDefault(); downloadSingle(parseInt(this.getAttribute('data-idx'))); });
    list.appendChild(item);
  });
  updateProgress();
}

function updateBadge(index, status) {
  videos[index].status = status;
  var badge = document.getElementById('badge-' + index);
  var item = document.getElementById('video-' + index);
  if (badge) { badge.className = 'badge badge-' + status; badge.textContent = status; }
  if (item) { item.className = 'video-item ' + (status === 'waiting' ? '' : status); }
  updateProgress();
}

function updateProgress() {
  var total = videos.length;
  var done = videos.filter(function(v) { return v.status === 'done'; }).length;
  var errors = videos.filter(function(v) { return v.status === 'error'; }).length;
  var remaining = total - done - errors;
  var pct = total > 0 ? ((done + errors) / total * 100) : 0;
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statDone').textContent = done;
  document.getElementById('statErrors').textContent = errors;
  document.getElementById('statRemaining').textContent = remaining;
  document.getElementById('progressBar').style.width = pct + '%';
  if (total > 0) document.getElementById('progressSection').classList.add('visible');
}

async function downloadAll() {
  if (isDownloading) return;
  isDownloading = true;
  document.getElementById('downloadBtn').disabled = true;
  document.getElementById('loadBtn').disabled = true;

  for (var i = 0; i < videos.length; i++) {
    if (videos[i].status === 'done') continue;
    updateBadge(i, 'downloading');
    setStatus('Downloading ' + (i + 1) + '/' + videos.length + ': ' + videos[i].filename);
    try {
      var resp = await fetch(videos[i].url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);

      var blob = await resp.blob();
      var fname = fixFilenameExt(videos[i].filename, blob.type);
      var blobUrl = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = blobUrl;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
      updateBadge(i, 'done');
    } catch (err) {
      console.error('Download failed for ' + videos[i].filename + ':', err);
      updateBadge(i, 'error');
    }
    if (i < videos.length - 1) await new Promise(function(r) { setTimeout(r, 2000); });
  }

  isDownloading = false;
  document.getElementById('downloadBtn').disabled = false;
  document.getElementById('loadBtn').disabled = false;
  var errs = videos.filter(function(v) { return v.status === 'error'; }).length;
  if (errs > 0) setStatus('Done. ' + errs + ' error(s). Use Save links for failed videos.');
  else setStatus('All downloads complete!');
}

async function downloadSingle(index) {
  if (videos[index].status === 'done') return;
  updateBadge(index, 'downloading');
  setStatus('Downloading: ' + videos[index].filename);
  try {
    var resp = await fetch(videos[index].url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var blob = await resp.blob();
    var filename = fixFilenameExt(videos[index].filename, blob.type);
    var blobUrl = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
    updateBadge(index, 'done');
    setStatus('Downloaded: ' + filename);
  } catch (err) {
    console.error('Download failed:', err);
    updateBadge(index, 'error');
    setStatus('Download failed: ' + err.message, true);
  }
}

function fixFilenameExt(filename, contentType) {
  if (!contentType) return filename;
  var extMap = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
  var correctExt = extMap[contentType];
  if (correctExt && !filename.endsWith(correctExt)) {
    return filename.replace(/\.[^.]+$/, correctExt);
  }
  return filename;
}

function setStatus(text, isError) {
  var el = document.getElementById('statusText');
  el.textContent = text;
  el.style.color = isError ? '#dc3545' : '#888';
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Attach event listeners
document.getElementById('loadBtn').addEventListener('click', loadVideos);
document.getElementById('downloadBtn').addEventListener('click', downloadAll);
document.getElementById('advancedToggle').addEventListener('click', toggleAdvanced);
console.log('[Downloader] Ready - event listeners attached');
