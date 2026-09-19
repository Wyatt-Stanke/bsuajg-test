// Crash reports for the modernized HTML5 build (patch modernized/07). import.mjs adds this file to the project as an
// extension. The game hands over a checkpoint (its resume state) every 30 steps and each step's frame time; this file
// records the key events between steps. After an uncaught error, or when the player types BUG (in capitals), the page
// shows a report: the checkpoint about 10 s back, the frame times and key events since, and the error or the state
// the game has now, gzipped and Base64-encoded. `node migrate/fuzz.mjs replay <build> <report file>` replays it.
var crash_steps = [],
  crash_events = [],
  crash_base = 0,
  crash_n = 0; // frame times of steps crash_base..crash_n-1
var crash_points = [],
  crash_pending = [],
  crash_held = {},
  crash_typed = '',
  crash_typed_at = 0;
var crash_want = 0,
  crash_done = false,
  crash_window = 300; // steps (10 s at 30 a second) a report reaches back

// A checkpoint in the step about to run (before its crash_step); state '' (a menu) forgets them all.
function crash_put(state, latch) {
  if (crash_done) return 0;
  if (state === '') crash_points = [];
  else {
    crash_points.push({ step: crash_n, state: state, latch: latch, held: Object.keys(crash_held).map(Number) });
    while (crash_points.length > 1 && crash_points[1].step <= crash_n - crash_window) crash_points.shift();
  }
  // without a checkpoint, the last 30 s of input are still worth showing
  crash_trim(crash_points.length ? crash_points[0].step : crash_n - 900);
  return 0;
}

// oController's Begin Step, every step: the step's frame time; the key events before it belong to it.
function crash_step(rendt) {
  if (crash_done) return rendt;
  for (var i = 0; i < crash_pending.length; i++) {
    var e = crash_pending[i];
    crash_events.push([crash_n].concat(e));
    if (e[0] === 1) crash_held[e[1]] = 1;
    else if (e[0] === 0) delete crash_held[e[1]];
    else if (e[0] === 2) crash_held = {};
  }
  crash_pending = [];
  crash_steps.push(rendt);
  crash_n++;
  if (crash_steps.length > 20000) crash_trim(crash_n - 900); // a long time in a menu
  return rendt;
}

function crash_trim(from) {
  if (from <= crash_base) return;
  crash_steps.splice(0, Math.min(from - crash_base, crash_steps.length));
  crash_base = from;
  var k = 0;
  while (k < crash_events.length && crash_events[k][0] < from) k++;
  crash_events.splice(0, k);
}

function crash_wanted() {
  var w = crash_want;
  crash_want = 0;
  return w;
}

// The game's state when a report was asked for (BUG)
function crash_end(state) {
  crash_report('report', null, state);
  return 0;
}

function crash_record(type, e) {
  if (crash_done || document.getElementById('crash-report')) return;
  var which = e ? e.which || e.keyCode || 0 : 0;
  crash_pending.push([type, which, (e && e.key) || '']);
  if (type !== 1) return;
  if (e.key && e.key.length === 1 && e.key >= 'A' && e.key <= 'Z') {
    if (Date.now() - crash_typed_at > 3000) crash_typed = '';
    crash_typed = (crash_typed + e.key).slice(-3);
    crash_typed_at = Date.now();
    if (crash_typed === 'BUG') ((crash_want = 1), (crash_typed = ''));
  } else if (e.key && e.key.length === 1) crash_typed = '';
}
addEventListener(
  'keydown',
  function (e) {
    crash_record(1, e);
  },
  true,
);
addEventListener(
  'keyup',
  function (e) {
    crash_record(0, e);
  },
  true,
);
// the window's own (the runtime clears its keys on blur), not an element's
addEventListener(
  'blur',
  function (e) {
    if (e.target === window) crash_record(2, null);
  },
  true,
);
addEventListener(
  'focus',
  function (e) {
    if (e.target === window) crash_record(3, null);
  },
  true,
);

addEventListener('error', function (e) {
  if (crash_done) return;
  var x = e.error,
    message,
    stack;
  if (x && typeof x === 'object') {
    message = x.gmllongMessage || x.gmlmessage || x.message;
    stack = x.gmlstacktrace || x.stack;
  }
  if (message === undefined) message = e.message;
  if (Array.isArray(stack)) stack = stack.join('\n');
  crash_report('crash', { message: String(message), stack: String(stack || ''), file: e.filename, line: e.lineno });
});

function crash_report(kind, error, end) {
  if (crash_done) return;
  if (kind === 'crash') crash_done = true; // the game has stopped
  var cp = crash_points[0] || null,
    from = cp ? cp.step : crash_base;
  var script = document.querySelector('script[src*="html5game/"]');
  var report = {
    version: 1,
    kind: kind,
    time: new Date().toISOString(),
    page: location.href,
    bundle: script ? script.getAttribute('src') : '',
    agent: navigator.userAgent,
    window: [innerWidth, innerHeight, devicePixelRatio],
    error: error,
    checkpoint: cp && { state: cp.state, latch: cp.latch, held: cp.held, files: crash_files() },
    // frame times from the checkpoint's step on, key events [step - from, type (0 up, 1 down, 2 blur, 3 focus),
    // key code, key]; events after the last step go with a step that has no frame time
    steps: crash_steps.slice(from - crash_base),
    events: crash_events
      .filter(function (e) {
        return e[0] >= from;
      })
      .map(function (e) {
        return [e[0] - from].concat(e.slice(1));
      })
      .concat(
        crash_pending.map(function (e) {
          return [crash_n - from].concat(e);
        }),
      ),
    end: end || null,
  };
  crash_encode(JSON.stringify(report)).then(function (text) {
    try {
      localStorage.setItem('barkley.crash', text);
    } catch (e) {}
    crash_show(kind, text);
  });
}

// The game's files (saves, settings): the runtime keeps them in browser storage
function crash_files() {
  var files = {};
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k.indexOf('barkley.') !== 0) files[k] = localStorage.getItem(k);
    }
  } catch (e) {}
  return files;
}

function crash_encode(json) {
  var gz = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(gz).arrayBuffer().then(function (buf) {
    var bytes = new Uint8Array(buf),
      s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return 'BARKLEY-CRASH-1:' + btoa(s).replace(/.{100}/g, '$&\n');
  });
}

function crash_show(kind, text) {
  var old = document.getElementById('crash-report');
  if (old) old.remove();
  // plain DOM; index.html's stylesheet lays it out (.ui-panel and friends)
  var el = function (parent, tag, cls, s) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (s) e.textContent = s;
    parent.appendChild(e);
    return e;
  };
  var box = document.createElement('div');
  box.id = 'crash-report';
  box.className = 'ui-panel';
  box.tabIndex = -1;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-labelledby', 'crash-title');
  var head = el(box, 'div', 'ui-head');
  el(head, 'h2', '', kind === 'crash' ? 'The game stopped' : 'Bug report').id = 'crash-title';
  var close = function () {
    box.remove();
  };
  var button = function (parent, label, cls, fn) {
    var b = el(parent, 'button', cls, label);
    b.type = 'button';
    b.onclick = fn;
    return b;
  };
  if (kind !== 'crash') button(head, 'Close', 'ui-link', close);
  el(
    box,
    'p',
    'ui-mute',
    'Copy this report and send it with a few words about what you were doing.' +
      (kind === 'crash' ? ' Then reload the page to play on.' : ''),
  );
  var area = el(box, 'textarea', 'ui-code');
  area.readOnly = true;
  area.value = text;
  area.setAttribute('aria-label', 'Report');
  var row = el(box, 'div', 'ui-row');
  var copy = button(row, 'Copy report', 'ui-btn primary', function () {
    area.select();
    var done = function () {
      copy.textContent = 'Copied';
    };
    if (navigator.clipboard)
      navigator.clipboard.writeText(text).then(done, function () {
        document.execCommand('copy') && done();
      });
    else if (document.execCommand('copy')) done();
  });
  if (kind === 'crash')
    button(row, 'Reload', 'ui-btn', function () {
      location.reload();
    });
  // keep keys pressed in here away from the game (it cancels them all); a release of a key pressed in the game
  // (the G of BUG) must still reach it
  var down = {};
  box.addEventListener('keydown', function (e) {
    e.stopPropagation();
    down[e.code] = 1;
    if (e.key === 'Escape' && kind !== 'crash') close();
  });
  box.addEventListener('keyup', function (e) {
    if (down[e.code]) (delete down[e.code], e.stopPropagation());
  });
  document.body.appendChild(box);
  box.focus();
}
