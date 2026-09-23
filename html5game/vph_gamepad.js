// Game controller support for the modernized HTML5 build. import.mjs adds this file to the project as an
// extension; patch modernized/11 calls pad_keys from key_doset and pad_context from oController's Begin Step.
//
// Keys reach the game the way touch.js sends them: by calling the runtime's own window.onkeydown /
// window.onkeyup with {which, keyCode}. So a pad press is indistinguishable from a key press, and rebinding
// (SET KEYS), the key latch, dialog and every menu treat it as one. The handler is looked up at event time,
// never cached: it is null until GameMaker_Init runs and is set back to null at game end.
//
// The game's own joystick code (key_joyemu, GM6's joystick_*) is left alone: its one call site was already
// commented out in the original, and it read a fixed joystick 1 rather than the bound keys.
//
// The Gamepad API reports buttons only by polling, so state is read once a frame in this file's own
// requestAnimationFrame loop. The fuzz harness drops every frame callback but the runtime's, which is
// harmless here: a fuzz run has no pads.

var pad_key = { up: 38, down: 40, left: 37, right: 39, action: 90, cancel: 88, start: 67 };
var pad_started = false, pad_ctx = 0, pad_mute = false;
var pad_held = {}, pad_downAt = {}, pad_pending = {}, pad_repeatAt = {};

// The stick must travel past PAD_DEAD to turn a direction on and fall back inside PAD_LIVE to turn it off, so
// a thumb resting near the edge doesn't chatter between two directions.
var PAD_DEAD = 0.45, PAD_LIVE = 0.3;
var PAD_MIN_HOLD = 100;                     // the game reads held keys once per 30 fps step
var PAD_REPEAT_DELAY = 400, PAD_REPEAT_RATE = 110;  // held directions repeat, as a held arrow key does
// Standard-mapping buttons. Both bottom/left faces confirm and both right/top faces cancel, so a pad laid out
// either way round works; the shoulders cancel as well, which is how the player runs.
var PAD_BUTTON = {
  0: 'action', 2: 'action', 1: 'cancel', 3: 'cancel', 4: 'cancel', 5: 'cancel',
  8: 'start', 9: 'start', 12: 'up', 13: 'down', 14: 'left', 15: 'right',
};
var PAD_DIR = { up: 1, down: 1, left: 1, right: 1 };

// ---- extension entry points ---------------------------------------------------------------------

// Called at the end of key_doset, so a pad always sends the currently bound keys.
function pad_keys(u, d, l, r, a, c, s) {
  pad_key = { up: u | 0, down: d | 0, left: l | 0, right: r | 0, action: a | 0, cancel: c | 0, start: s | 0 };
  pad_started = true;
  return 0;
}

// The same context sTouchContext gives the touch overlay. 4 is SET KEYS, where a synthetic press would bind a
// control to the key it already has.
function pad_context(n) {
  n = n | 0;
  if (n === pad_ctx) return 0;
  pad_ctx = n;
  if (n === 4) pad_release_all();
  return 0;
}

// ---- key injection ------------------------------------------------------------------------------

// The Controls panel (controls.js) tests a pad with the game still running behind it, so while it is open the pad
// keeps being read - the panel shows that state - but sends nothing. Anything held when it opens is released first.
function pad_quiet(on) {
  on = !!on;
  if (on === pad_mute) return;
  if (on) {
    pad_release_all();
    pad_mute = true;
  } else pad_mute = false;
}

function pad_send(code, down) {
  if (pad_mute) return;
  var h = down ? window.onkeydown : window.onkeyup;     // looked up now, never cached
  if (!h) return;
  try {
    h({ which: code, keyCode: code, key: '', repeat: false, preventDefault: function () {},
        stopPropagation: function () {} });
  } catch (e) {}
}

function pad_down(k) {
  if (pad_pending[k]) { clearTimeout(pad_pending[k]); pad_pending[k] = 0; }  // pressed again mid-release
  if (pad_held[k]) {
    if (!PAD_DIR[k]) return;
    var now = Date.now();                               // a held direction repeats, as the keyboard's does
    if (now >= pad_repeatAt[k]) { pad_repeatAt[k] = now + PAD_REPEAT_RATE; pad_send(pad_key[k], true); }
    return;
  }
  pad_held[k] = true;
  pad_downAt[k] = Date.now();
  pad_repeatAt[k] = pad_downAt[k] + PAD_REPEAT_DELAY;
  pad_send(pad_key[k], true);
}

function pad_up(k) {
  if (!pad_held[k]) return;
  // A press the game never saw is a press that never happened, so hold it out the rest of a step first.
  var owed = Math.max(0, PAD_MIN_HOLD - (Date.now() - (pad_downAt[k] || 0)));
  if (owed > 0) {
    if (!pad_pending[k])
      pad_pending[k] = setTimeout(function () { pad_pending[k] = 0; pad_up(k); }, owed);
    return;
  }
  pad_held[k] = false;
  pad_send(pad_key[k], false);
}

function pad_release_all() {
  for (var k in pad_held) {
    if (pad_pending[k]) { clearTimeout(pad_pending[k]); pad_pending[k] = 0; }
    if (pad_held[k]) { pad_held[k] = false; pad_send(pad_key[k], false); }
  }
}

// ---- polling ------------------------------------------------------------------------------------

function pad_value(b) { return typeof b === 'object' && b ? (b.pressed || b.value > 0.5) : b > 0.5; }

function pad_axis(v, want, neg, pos) {
  if (typeof v !== 'number') return;
  if (v <= -(pad_held[neg] ? PAD_LIVE : PAD_DEAD)) want[neg] = true;
  else if (v >= (pad_held[pos] ? PAD_LIVE : PAD_DEAD)) want[pos] = true;
}

function pad_read(g, want) {
  var b = g.buttons || [], i, n;
  for (i = 0; i < b.length; i++) {
    n = PAD_BUTTON[i];
    if (n && pad_value(b[i])) want[n] = true;
  }
  var ax = g.axes || [];
  pad_axis(ax[0], want, 'left', 'right');
  pad_axis(ax[1], want, 'up', 'down');
}

function pad_poll() {
  requestAnimationFrame(pad_poll);
  if (!pad_started || pad_ctx === 4 || document.hidden) return;
  var pads;
  try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) { return; }
  var want = {}, i, k;
  for (i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected !== false) pad_read(pads[i], want);
  for (k in pad_key) {
    if (want[k]) pad_down(k);
    else pad_up(k);
  }
}

try {
  addEventListener('blur', pad_release_all);
  addEventListener('gamepaddisconnected', pad_release_all);
  document.addEventListener('visibilitychange', function () { if (document.hidden) pad_release_all(); });
  requestAnimationFrame(pad_poll);
} catch (e) {}
