// The Controls panel for the modernized HTML5 build. import.mjs adds this file to the project as an extension, and
// the Start screen's Controls link opens it (controls_show): before the game runs, which is where a player who
// cannot work out how to drive it is actually standing. The game itself never opens it.
//
// It says what the game listens to - the keys as the player has them, the controller mapping, and where to change
// them - and then lets them prove it hears them: every control lights up as it is pressed, from the keyboard or
// from a pad, with the pad's name, raw buttons and sticks beside it for a pad that maps itself oddly.
//
// The bindings come from the game's own controls.txt in browser storage (key_save writes it: a warning line, then
// one key code a line), so they are the player's own. With no such file, or an unreadable one, they are the
// defaults, which is what the game would use anyway.
//
// Nothing pressed in the panel reaches the game or the Start screen: key events stop here (as saves.js does), the
// Start screen's own key handler stands down while the panel is up, and gamepad.js is asked to go quiet.
//
// It builds plain DOM; the style sheet is in index.html (.ui-panel and friends, .ctl-*).

var controls_key = { up: 38, down: 40, left: 37, right: 39, action: 90, cancel: 88, start: 67 };
var controls_saved = false;
var controls_default = { up: 38, down: 40, left: 37, right: 39, action: 90, cancel: 88, start: 67 };
// key_doset's aliases: these act as the control they name unless the player has bound them to something else.
var CONTROLS_ALIAS = { 87: 'up', 65: 'left', 83: 'down', 68: 'right', 74: 'action', 75: 'cancel' };
var CONTROLS_ROWS = [
  ['up', 'Up'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right'],
  ['action', 'Action'], ['cancel', 'Cancel'], ['start', 'Menu'],
];
var CONTROLS_NAMES = {
  8: 'Backspace', 9: 'Tab', 13: 'Enter', 16: 'Shift', 17: 'Ctrl', 18: 'Alt', 19: 'Pause', 20: 'Caps Lock',
  27: 'Esc', 32: 'Space', 33: 'Page Up', 34: 'Page Down', 35: 'End', 36: 'Home',
  37: '← Left', 38: '↑ Up', 39: '→ Right', 40: '↓ Down',
  45: 'Insert', 46: 'Delete', 91: 'Meta', 93: 'Menu', 144: 'Num Lock', 145: 'Scroll Lock',
  186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`',
  219: '[', 220: '\\', 221: ']', 222: "'",
};

function controls_name(code) {
  code = code | 0;
  if (CONTROLS_NAMES[code]) return CONTROLS_NAMES[code];
  if (code >= 48 && code <= 57) return String.fromCharCode(code);
  if (code >= 65 && code <= 90) return String.fromCharCode(code);
  if (code >= 96 && code <= 105) return 'Numpad ' + (code - 96);
  if (code >= 112 && code <= 123) return 'F' + (code - 111);
  return 'Key ' + code;
}

// The Start screen's Controls link. Takes the player's own keys when the game has ever saved them.
function controls_show() {
  var saved = controls_stored();
  controls_key = saved || controls_default;
  controls_saved = !!saved;
  controls_panel();
  return 0;
}

// key_save's controls.txt, under whatever prefix the runtime gives the game's files in browser storage.
function controls_stored() {
  var text = null, i, k;
  try {
    for (i = 0; i < localStorage.length; i++) {
      k = localStorage.key(i);
      if (k.length > 12 && k.slice(-12) === 'controls.txt') text = localStorage.getItem(k);
    }
  } catch (e) {
    return null;
  }
  if (!text) return null;
  var lines = text.split(/\r?\n/), keys = {}, n;
  for (i = 0; i < CONTROLS_ROWS.length; i++) {
    n = parseInt(lines[i + 1], 10); // line 0 is key_save's "Do not edit or delete this file."
    if (!(n > 0 && n < 256)) return null;
    keys[CONTROLS_ROWS[i][0]] = n;
  }
  return keys;
}

// gamepad.js decides what a pad's buttons and sticks mean, so its tables are read here and the test cannot drift
// from the game. Its own held state is no use on the Start screen: it starts tracking only once the game has run
// key_doset, which is after Start. These are the same values, for a page that somehow loaded without it.
var CONTROLS_PAD = {
  0: 'action', 2: 'action', 1: 'cancel', 3: 'cancel', 4: 'cancel', 5: 'cancel',
  8: 'start', 9: 'start', 12: 'up', 13: 'down', 14: 'left', 15: 'right',
};

function controls_pad_state(list, on) {
  var map = typeof PAD_BUTTON === 'object' && PAD_BUTTON ? PAD_BUTTON : CONTROLS_PAD;
  var dead = typeof PAD_DEAD === 'number' ? PAD_DEAD : 0.45;
  for (var i = 0; i < list.length; i++) {
    var g = list[i], b = g.buttons || [], ax = g.axes || [], j, n;
    for (j = 0; j < b.length; j++) {
      n = map[j];
      if (n && (typeof b[j] === 'object' && b[j] ? b[j].pressed || b[j].value > 0.5 : b[j] > 0.5)) on[n] = true;
    }
    if (typeof ax[0] === 'number') {
      if (ax[0] <= -dead) on.left = true;
      else if (ax[0] >= dead) on.right = true;
    }
    if (typeof ax[1] === 'number') {
      if (ax[1] <= -dead) on.up = true;
      else if (ax[1] >= dead) on.down = true;
    }
  }
}

// An alias only stands for its control while no control is bound to that key, exactly as key_alias decides it.
function controls_alias_of(code) {
  var name = CONTROLS_ALIAS[code], k;
  if (!name) return null;
  for (k in controls_key) if (controls_key[k] === code) return null;
  return name;
}

function controls_aliases(name) {
  var out = [], code;
  for (code in CONTROLS_ALIAS) if (controls_alias_of(code | 0) === name) out.push(controls_name(code | 0));
  return out;
}

function controls_defaults_line() {
  var same = true, k;
  for (k in controls_default) if (controls_key[k] !== controls_default[k]) same = false;
  if (same)
    return controls_saved
      ? 'These are the keys the game starts with, and yours are still those.'
      : 'These are the keys the game starts with.';
  return 'You have changed these; the keys the game starts with are ↑ ↓ ← →, Z, X and C.';
}

function controls_panel() {
  var old = document.getElementById('controls-panel');
  if (old) old.remove();

  var el = function (parent, tag, cls, s) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (s) e.textContent = s;
    if (parent) parent.appendChild(e);
    return e;
  };
  // A binding row: the control on the left, what presses it on the right.
  var bind = function (list, label, keys, extra) {
    el(list, 'dt', '', label);
    var dd = el(list, 'dd', '');
    for (var i = 0; i < keys.length; i++) {
      if (i) el(dd, 'span', 'ctl-or', 'or');
      el(dd, 'span', 'ctl-key', keys[i]);
    }
    if (extra) el(dd, 'span', 'ctl-note', extra);
    return dd;
  };

  var box = el(null, 'div', 'ui-panel');
  box.id = 'controls-panel';
  box.tabIndex = -1;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-labelledby', 'controls-title');

  var head = el(box, 'div', 'ui-head');
  el(head, 'h2', '', 'Controls').id = 'controls-title';
  var closeBtn = el(head, 'button', 'ui-link', 'Close');
  closeBtn.type = 'button';

  el(box, 'p', 'ui-mute',
    'What the game listens to, and a test below to see that it hears you. Close this and press Start to play.');

  var cols = el(box, 'div', 'ui-cols');

  var kb = el(cols, 'section', 'ui-col');
  el(kb, 'h3', '', 'Keyboard');
  var list = el(kb, 'dl', 'ctl-list');
  for (var i = 0; i < CONTROLS_ROWS.length; i++) {
    var name = CONTROLS_ROWS[i][0];
    bind(list, CONTROLS_ROWS[i][1], [controls_name(controls_key[name])].concat(controls_aliases(name)));
  }
  el(kb, 'p', 'ui-mute',
    controls_defaults_line() + ' Enter also confirms in menus, and Esc leaves full screen.');
  el(kb, 'h3', '', 'Changing them');
  el(kb, 'p', '',
    'Start the game, and on the title menu choose Configuration → SET KEYS: it then asks for the key you want ' +
      'for each control in turn. Configuration → SETTINGS → Default puts them all back.');
  el(kb, 'p', 'ui-mute', 'Full screen, picture size and volume are in Configuration too.');

  var pad = el(cols, 'section', 'ui-col');
  el(pad, 'h3', '', 'Controller');
  el(pad, 'p', '',
    'Connect a controller and press one of its buttons: a browser hides a pad until it has been used once.');
  var padList = el(pad, 'dl', 'ctl-list');
  bind(padList, 'Move', ['Left stick', 'D-pad']);
  bind(padList, 'Action', ['A'], 'the bottom or left face button');
  bind(padList, 'Cancel', ['B'], 'the right or top face, or either shoulder');
  bind(padList, 'Menu', ['Start'], 'or Back');
  el(pad, 'p', 'ui-mute',
    'A controller sends the same keys as the keyboard, so it follows whatever you set in SET KEYS. ' +
      'On a phone the touch controls step aside while a controller is connected.');

  el(box, 'h3', '', 'Test');
  // One block, so the lamps are in view under the two columns rather than a screen below them.
  var test = el(box, 'div', 'ui-col');
  var status = el(test, 'p', 'ui-status');
  status.id = 'ctl-status';
  var lamps = el(test, 'div', 'ctl-lamps');
  var lamp = {};
  for (i = 0; i < CONTROLS_ROWS.length; i++) {
    var cell = el(lamps, 'div', 'ctl-lamp');
    cell.setAttribute('data-control', CONTROLS_ROWS[i][0]);
    el(cell, 'span', 'ctl-lamp-name', CONTROLS_ROWS[i][1]);
    el(cell, 'span', 'ctl-lamp-key', controls_name(controls_key[CONTROLS_ROWS[i][0]]));
    lamp[CONTROLS_ROWS[i][0]] = cell;
  }
  var last = el(test, 'p', 'ctl-raw', 'Press something.');
  last.id = 'ctl-last';
  var raw = el(test, 'p', 'ctl-raw', '');
  raw.id = 'ctl-raw';
  el(test, 'p', 'ui-mute', 'Presses stay in this panel: none of them starts the game.');

  // ---- the test ---------------------------------------------------------------------------------
  var keyHeld = {}, alive = true, timer = 0;

  var quiet = function (on) {
    if (typeof pad_quiet === 'function') pad_quiet(on);
  };

  var close = function () {
    alive = false;
    clearInterval(timer);
    quiet(false);
    box.remove();
  };
  closeBtn.onclick = close;

  var describe = function (code) {
    var k;
    for (k in controls_key) if (controls_key[k] === code) return k;
    return controls_alias_of(code);
  };
  var label = function (name) {
    for (var i = 0; i < CONTROLS_ROWS.length; i++) if (CONTROLS_ROWS[i][0] === name) return CONTROLS_ROWS[i][1];
    return name;
  };

  box.addEventListener('keydown', function (e) {
    e.stopPropagation();
    var code = e.which || e.keyCode;
    keyHeld[code] = 1;
    if (e.key === 'Escape') {
      close();
      return;
    }
    var what = describe(code);
    last.textContent =
      controls_name(code) +
      (what ? ' → ' + label(what) : ' → not bound to anything; the game ignores it');
  });
  box.addEventListener('keyup', function (e) {
    var code = e.which || e.keyCode;
    if (keyHeld[code]) {
      delete keyHeld[code];
      e.stopPropagation();
    }
  });
  addEventListener('blur', function () {
    keyHeld = {};
  });

  var pads = function () {
    var list = [], g, i;
    try {
      g = navigator.getGamepads ? navigator.getGamepads() : [];
    } catch (e) {
      return list;
    }
    for (i = 0; i < g.length; i++) if (g[i] && g[i].connected !== false) list.push(g[i]);
    return list;
  };

  // A timer, not requestAnimationFrame: the Start screen holds every frame callback back until the game starts
  // (index.html's rAF wrapper), which would leave this test frozen exactly where it is most used. 20 a second is
  // plenty to see a button go down.
  var tick = function () {
    if (!alive) return;
    var live = pads(), g = live[0], on = {}, k, code, i;
    for (code in keyHeld) {
      k = describe(code | 0);
      if (k) on[k] = true;
    }
    controls_pad_state(live, on);

    for (k in lamp) {
      if (lamp[k].classList.contains('on') !== !!on[k]) lamp[k].classList.toggle('on', !!on[k]);
    }

    if (!live.length) {
      status.textContent = 'No controller yet. Connect one and press a button on it — the keyboard works here too.';
      raw.textContent = '';
      return;
    }
    status.textContent =
      live.length === 1 ? 'Controller: ' + (g.id || 'connected') : live.length + ' controllers connected';
    var pressed = [], axes = [];
    for (i = 0; i < (g.buttons || []).length; i++) {
      var b = g.buttons[i];
      if (typeof b === 'object' ? b.pressed || b.value > 0.5 : b > 0.5) pressed.push(i);
    }
    for (i = 0; i < Math.min((g.axes || []).length, 4); i++) axes.push(g.axes[i].toFixed(2));
    raw.textContent =
      'Buttons down: ' + (pressed.length ? pressed.join(' ') : 'none') + '  ·  Sticks: ' + axes.join(' ');
  };

  document.body.appendChild(box);
  box.focus();
  quiet(true);
  timer = setInterval(tick, 50);
  tick();
  return box;
}
