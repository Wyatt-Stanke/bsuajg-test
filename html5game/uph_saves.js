// Save transfer for the modernized HTML5 build (patch modernized/09). import.mjs adds this file to the project as an
// extension. Configuration -> SETTINGS -> Saves calls saves_open, which shows a panel holding every save slot as one
// block of text: the player copies it out of one browser and pastes it into another, or keeps it as a file. Saves live
// in browser storage, which is per origin, so they are lost by clearing site data or switching browser; this is the way
// back. Only the three save slots travel, not the settings, so a device keeps its own keys, screen and volume.
//
// The runtime stores each game file in localStorage under a prefix built from the game's name and id. Rather than
// rebuild that prefix (obfuscation renames everything around it), sSaveData writes a probe file and passes its name:
// the key that ends with it gives the prefix.
var saves_prefix = null;
var saves_tag = 'BARKLEY-SAVES-1:';
var saves_tag_plain = 'BARKLEY-SAVES-1U:'; // the same JSON, not gzipped (no CompressionStream in this browser)
// The three slots sFiler reads. Not \d+: sFileData writes slot 1 through the temp file Save10.sav, which would match.
var saves_name = /^Save[1-3]\.sav$/;
var saves_limit = 1 << 20;

function saves_open(probe) {
  var ui = saves_panel();
  saves_prefix = saves_find(String(probe));
  if (saves_prefix === null) {
    ui.say('This browser has no storage for save files, so there is nothing to export and nowhere to import to.');
    return 0;
  }
  var files = saves_read(),
    names = Object.keys(files);
  if (!names.length) ui.say('No save slots in this browser yet. Save in the game first, then come back here.');
  else
    saves_encode(files).then(
      function (text) {
        ui.fill(text, names.length);
      },
      function (e) {
        ui.say('Could not read the saves: ' + e);
      },
    );
  return 0;
}

// The runtime's key prefix, from the key of the probe file the game just wrote
function saves_find(probe) {
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k.length > probe.length && k.slice(-probe.length) === probe) return k.slice(0, k.length - probe.length);
    }
  } catch (e) {}
  return null;
}

function saves_read() {
  var files = {};
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k.indexOf(saves_prefix) === 0 && saves_name.test(k.slice(saves_prefix.length)))
        files[k.slice(saves_prefix.length)] = localStorage.getItem(k);
    }
  } catch (e) {}
  return files;
}

function saves_encode(files) {
  var json = JSON.stringify({ version: 1, game: 'bsuajg', time: new Date().toISOString(), files: files });
  var bytes = new TextEncoder().encode(json);
  if (typeof CompressionStream === 'undefined') return Promise.resolve(saves_tag_plain + saves_wrap(bytes));
  var gz = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(gz).arrayBuffer().then(function (buf) {
    return saves_tag + saves_wrap(new Uint8Array(buf));
  });
}

function saves_wrap(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/.{100}/g, '$&\n');
}

function saves_decode(text) {
  text = text.replace(/\s+/g, '');
  var plain = text.indexOf(saves_tag_plain.replace(/\s/g, '')) === 0;
  var tag = plain ? saves_tag_plain : saves_tag;
  if (text.indexOf(tag) !== 0)
    return Promise.reject('this is not a Barkley save code (it should start with ' + tag + ')');
  var raw = atob(text.slice(tag.length));
  var bytes = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  if (plain) return Promise.resolve(new TextDecoder().decode(bytes));
  if (typeof DecompressionStream === 'undefined') return Promise.reject('this browser cannot unpack the save code');
  var un = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(un).text().catch(function () {
    throw 'the save code is damaged or incomplete (copy the whole thing, including the first line)';
  });
}

// Writes the slots the code holds, and returns how many. Only slot files are written, whatever the code contains.
function saves_write(json) {
  var report = JSON.parse(json);
  if (!report || report.game !== 'bsuajg' || !report.files) throw 'this save code is not from this game';
  var names = Object.keys(report.files).filter(function (n) {
    return saves_name.test(n) && typeof report.files[n] === 'string' && report.files[n].length < saves_limit;
  });
  if (!names.length) throw 'this save code holds no save slots';
  for (var i = 0; i < names.length; i++) localStorage.setItem(saves_prefix + names[i], report.files[names[i]]);
  return names.length;
}

function saves_panel() {
  var old = document.getElementById('saves-panel');
  if (old) old.remove();
  var box = document.createElement('div');
  box.id = 'saves-panel';
  box.style.cssText =
    'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.88);color:#fff;font:15px/1.4 sans-serif;' +
    'display:flex;flex-direction:column;gap:8px;padding:16px;box-sizing:border-box;overflow:auto';
  var text = function (tag, s) {
    var e = document.createElement(tag);
    e.style.margin = '0';
    e.textContent = s;
    return e;
  };
  var area = function (readOnly, placeholder) {
    var a = document.createElement('textarea');
    a.readOnly = readOnly;
    a.placeholder = placeholder || '';
    a.style.cssText = 'flex:1;min-height:70px;width:100%;box-sizing:border-box;font:12px monospace';
    return a;
  };
  var row = function () {
    var r = document.createElement('div');
    r.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center';
    return r;
  };
  var button = function (parent, label, fn) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'font:inherit;padding:6px 16px';
    b.onclick = fn;
    parent.appendChild(b);
    return b;
  };

  var status = text('p', '');
  status.style.color = '#ffd';
  var out = area(true, ''),
    outRow = row();
  var inp = area(false, 'Paste a save code here'),
    inRow = row();
  var copy = button(outRow, 'Copy', function () {
    out.select();
    var done = function () {
      copy.textContent = 'Copied';
    };
    if (navigator.clipboard) navigator.clipboard.writeText(out.value).then(done, done);
    else if (document.execCommand('copy')) done();
  });
  button(outRow, 'Download', function () {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out.value], { type: 'text/plain' }));
    a.download = 'barkley-saves-' + new Date().toISOString().slice(0, 10) + '.txt';
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
    }, 10000);
  });
  button(inRow, 'Import', function () {
    saves_decode(inp.value)
      .then(saves_write)
      .then(
        function (n) {
          status.textContent =
            'Imported ' + n + ' save slot(s). Close this, leave Configuration, and open Load Datafile to see them.';
        },
        function (e) {
          status.textContent = 'Could not import: ' + (e && e.message ? e.message : e);
        },
      );
  });
  var file = document.createElement('input');
  file.type = 'file';
  file.accept = 'text/plain,.txt';
  file.style.font = 'inherit';
  file.onchange = function () {
    if (file.files[0])
      file.files[0].text().then(function (t) {
        inp.value = t;
        status.textContent = 'Loaded ' + file.files[0].name + '. Press Import to write it into this browser.';
      });
  };
  inRow.appendChild(file);
  var closeRow = row();
  button(closeRow, 'Close', function () {
    box.remove();
  });

  // the game cancels every key it sees, so keep typing in here away from it
  box.addEventListener('keydown', function (e) {
    e.stopPropagation();
  });
  box.addEventListener('keyup', function (e) {
    e.stopPropagation();
  });
  box.append(
    text('h2', 'Save data'),
    text(
      'p',
      'Saves live in this browser only. Copy the code below to carry your game to another browser, another device, ' +
        'or back after clearing site data. Settings (keys, screen, volume) stay on each device.',
    ),
    text('p', 'This browser:'),
    out,
    outRow,
    text('p', 'Import a code:'),
    inp,
    inRow,
    status,
    closeRow,
  );
  document.body.appendChild(box);
  return {
    say: function (s) {
      status.textContent = s;
    },
    fill: function (t, n) {
      out.value = t;
      status.textContent = n + ' save slot(s) in this browser.';
    },
  };
}
