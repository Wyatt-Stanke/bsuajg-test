// Touch controls for the modernized HTML5 build: a joystick or D-pad and A/B/START, drawn as a DOM/SVG
// overlay above the canvas. import.mjs adds this file to the project as an extension; patch
// modernized/09 calls touch_keys, touch_context, touch_dpr and touch_view_* from GML.
// migrate/TOUCH-UI.md is the design.
//
// Keys reach the game the way the fuzzer drives it: by calling the runtime's own window.onkeydown /
// window.onkeyup with {which, keyCode}. Those are DOM properties, so the names survive obfuscation, and
// a touch is then indistinguishable from a physical key - rebinding, the key latch and menus all just work.
// The handler is looked up at event time, never cached: it is null until GameMaker_Init runs and is set
// back to null at game end.
//
// Two coordinate systems meet here. The overlay lives in CSS pixels; GML's window/canvas coordinates are
// device pixels once the DPR fix is on. touch_px() is the only place that converts.

var touch_cfg = { mode: 'stick', side: 'right', haptics: 1, enabled: 2 };
var touch_key = { up: 38, down: 40, left: 37, right: 39, action: 90, cancel: 88, start: 67 };
var touch_started = false, touch_live = false, touch_ctx = 0, touch_ready = false;
var touch_L = null, touch_held = {}, touch_downAt = {}, touch_ptr = {}, touch_pending = {};
var touch_dir = { active: false, bx: 0, by: 0, tx: 0, ty: 0, sector: null };
var touch_root = null, touch_hit = null, touch_svg = null, touch_sheet = null, touch_note = null;

var TOUCH_BASE_R = 56, TOUCH_KNOB_R = 24, TOUCH_THROW = 48, TOUCH_HYST = 7, TOUCH_MIN_HOLD = 100;
var TOUCH_GW = 320, TOUCH_GH = 240;
// Cardinal-biased sectors: walking straight is the common case, so cardinals get 50 deg, diagonals 40.
var TOUCH_S8 = [['right',0,25],['upright',45,20],['up',90,25],['upleft',135,20],
                ['left',180,25],['downleft',225,20],['down',270,25],['downright',315,20]];
var TOUCH_S4 = [['right',0,45],['up',90,45],['left',180,45],['down',270,45]];
var TOUCH_PAIR = { up:['up'], down:['down'], left:['left'], right:['right'],
  upright:['up','right'], upleft:['up','left'], downright:['down','right'], downleft:['down','left'] };
// context -> [direction opacity, button opacity, 8-way?]
var TOUCH_CTX = [[1,1,true],[.92,1,false],[.5,.92,true],[.28,.34,true],[0,0,true]];

// ---- extension entry points ---------------------------------------------------------------------

// Called at the end of key_doset, so the overlay always sends the currently bound keys.
function touch_keys(u, d, l, r, a, c, s) {
  touch_key = { up:u|0, down:d|0, left:l|0, right:r|0, action:a|0, cancel:c|0, start:s|0 };
  touch_started = true;             // the game is running; the overlay may come up now
  touch_apply();
  return 0;
}

function touch_context(n) {
  n = n | 0;
  if (n === touch_ctx) return 0;
  touch_ctx = n;
  if (n === 4) touch_release_all();  // SET KEYS: never let a synthetic press bind itself
  touch_paint();
  if (touch_note) touch_note.style.display = n === 4 && touch_live ? 'flex' : 'none';
  return 0;
}

function touch_active() { return touch_live ? 1 : 0; }
function touch_view_x() { return touch_live && touch_L ? Math.round(touch_L.game.x * touch_px()) : 0; }
function touch_view_y() { return touch_live && touch_L ? Math.round(touch_L.game.y * touch_px()) : 0; }
function touch_view_w() {
  return touch_live && touch_L ? Math.round(touch_L.game.w * touch_px()) : Math.round(innerWidth * touch_px());
}
function touch_view_h() {
  return touch_live && touch_L ? Math.round(touch_L.game.h * touch_px()) : Math.round(innerHeight * touch_px());
}

// The runtime ignores devicePixelRatio, so the canvas is backed by CSS pixels and the browser upscales it.
// oScreenFill sizes the canvas to browser_* times this, and touch_pin puts the CSS size back.
function touch_dpr() {
  var r = window.devicePixelRatio || 1;
  return Math.max(1, Math.min(3, r));    // past 3x the final blit costs more than it returns
}

// ---- key injection ------------------------------------------------------------------------------

function touch_send(code, down) {
  var h = down ? window.onkeydown : window.onkeyup;      // looked up now, never cached
  if (!h) return;
  try {
    h({ which: code, keyCode: code, key: '', repeat: false, preventDefault: function () {},
        stopPropagation: function () {} });
  } catch (e) {}
}
function touch_down(k) {
  if (touch_pending[k]) { clearTimeout(touch_pending[k]); touch_pending[k] = 0; } // sliding back cancels the release
  if (touch_held[k]) return;
  touch_held[k] = true; touch_downAt[k] = Date.now();
  touch_send(touch_key[k], true);
}
// How much of the minimum hold this key still owes.
function touch_owed(k) {
  return touch_held[k] ? Math.max(0, TOUCH_MIN_HOLD - (Date.now() - (touch_downAt[k] || 0))) : 0;
}
function touch_up(k) {
  if (!touch_held[k]) return;
  // The game reads held state once per 30 fps step, so a tap shorter than a frame is invisible.
  var owed = touch_owed(k);
  if (owed > 0) {
    if (!touch_pending[k])
      touch_pending[k] = setTimeout(function () { touch_pending[k] = 0; touch_up(k); }, owed);
    return;
  }
  touch_held[k] = false; touch_send(touch_key[k], false);
}
// Sliding between buttons must never hold both: the incoming key waits for the outgoing key to finish
// paying off its minimum hold, so a fast A->B roll still sends a real A press and then a real B press.
function touch_swap(r, k) {
  var wait = 0;
  if (r.k) { wait = touch_owed(r.k); touch_up(r.k); }
  r.k = k;
  if (!k) return;
  if (wait <= 0) { touch_down(k); touch_buzz(8); return; }
  setTimeout(function () {
    if (r.k !== k) return;                 // the finger moved on again while the press was waiting
    touch_down(k); touch_buzz(8);
    if (r.up) touch_up(k);                 // it already lifted: land it as a tap, never a stuck key
  }, wait + 1);
}
function touch_release_all() {
  for (var t in touch_pending) if (touch_pending[t]) { clearTimeout(touch_pending[t]); touch_pending[t] = 0; }
  for (var k in touch_held) if (touch_held[k]) { touch_held[k] = false; touch_send(touch_key[k], false); }
  touch_dir.active = false; touch_dir.sector = null;
  touch_ptr = {};
  touch_paint();
}
function touch_buzz(ms) {
  if (touch_cfg.haptics && navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) {} }
}
function touch_sector(next) {
  var d = touch_dir;
  if (d.sector === next) return;
  var was = d.sector ? TOUCH_PAIR[d.sector] : [], now = next ? TOUCH_PAIR[next] : [];
  for (var i = 0; i < was.length; i++)
    if (now.indexOf(was[i]) < 0) { touch_held[was[i]] = false; touch_send(touch_key[was[i]], false); }
  for (var j = 0; j < now.length; j++) touch_down(now[j]);
  d.sector = next;
}

// ---- settings -----------------------------------------------------------------------------------

function touch_load() {
  try {
    var s = JSON.parse(localStorage.getItem('barkley.touch') || '{}');
    for (var k in touch_cfg) if (s[k] !== undefined) touch_cfg[k] = s[k];
  } catch (e) {}
}
function touch_save() {
  try { localStorage.setItem('barkley.touch', JSON.stringify(touch_cfg)); } catch (e) {}
}
function touch_wanted() {
  if (touch_cfg.enabled === 0) return false;
  if (touch_cfg.enabled === 1) return true;
  if (touch_pads()) return false;                       // a real controller is plugged in
  return navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches;
}
function touch_pads() {
  try {
    var g = navigator.getGamepads ? navigator.getGamepads() : [];
    for (var i = 0; i < g.length; i++) if (g[i]) return true;
  } catch (e) {}
  return false;
}
function touch_apply() {
  var want = touch_ready && touch_started && touch_wanted();
  if (want === touch_live) { if (want) touch_layout(); return; }
  touch_live = want;
  if (!want) touch_release_all();
  if (touch_root) touch_root.style.display = want ? 'block' : 'none';
  touch_layout();
}

// ---- layout -------------------------------------------------------------------------------------

function touch_px() { return touch_dpr(); }
function touch_inset(name) {
  var v = getComputedStyle(document.documentElement).getPropertyValue('--touch-' + name);
  return parseFloat(v) || 0;
}
function touch_layout() {
  if (!touch_ready) return;
  var W = innerWidth, H = innerHeight;
  var it = touch_inset('top'), ib = touch_inset('bottom'),
      il = touch_inset('left'), ir = touch_inset('right');
  var wide = W / H > TOUCH_GW / TOUCH_GH, L = { W: W, H: H, buttons: [] };
  if (!touch_live) {                                   // no overlay: the picture uses the whole window
    L.game = { x: 0, y: 0, w: W, h: H };
    L.dirZone = { x: 0, y: 0, w: 0, h: 0 }; L.dirCenter = { x: 0, y: 0 }; L.dpadR = 0;
    L.gear = { x: -99, y: -99, r: 0 };
    touch_L = L; touch_paint(); return;
  }
  if (!wide) {
    var s = W / TOUCH_GW;
    L.game = { x: 0, y: it, w: W, h: Math.round(TOUCH_GH * s) };
    var py = L.game.y + L.game.h;
    L.panel = { x: 0, y: py, w: W, h: Math.max(0, H - py - ib) };
    L.dirZone = { x: il, y: py, w: (W - il - ir) * 0.52, h: L.panel.h };
    var bx = W - 74 - ir, by = py + L.panel.h - 180;
    L.buttons.push({ k: 'action', label: 'A', x: bx, y: by, r: 34 });
    L.buttons.push({ k: 'cancel', label: 'B', x: bx - 64, y: by - 45, r: 30 });
    L.buttons.push({ k: 'start', label: 'START', x: W / 2, y: py + 64, r: 22, pill: true });
    L.gear = { x: W - 30 - ir, y: py + 30, r: 15 };
    L.dirCenter = { x: L.dirZone.x + L.dirZone.w * 0.46, y: py + L.panel.h - 190 };
  } else {
    var sc = Math.min(W / TOUCH_GW, H / TOUCH_GH);
    var gw = Math.round(TOUCH_GW * sc), gh = Math.round(TOUCH_GH * sc);
    L.game = { x: Math.round((W - gw) / 2), y: Math.round((H - gh) / 2), w: gw, h: gh };
    var bar = L.game.x;
    L.panel = null;
    var lw = Math.max(bar - il, 92), rEdge = W - ir, rw = Math.max(bar - ir, 92);
    L.dirZone = { x: il, y: 0, w: lw, h: H };
    // The cluster reaches 84 px left of A's centre (B is up-left by 54 at r 30). Keep that clear of the
    // picture and keep A on screen; if the bar cannot hold both, staying on screen wins.
    var gameR = L.game.x + L.game.w;
    var minAx = gameR + 6 + 84, maxAx = rEdge - 8 - 34;
    var ax = Math.min(maxAx, Math.max(minAx, rEdge - rw * 0.42)), ay = H - 104 - ib;
    L.buttons.push({ k: 'action', label: 'A', x: ax, y: ay, r: 34 });
    L.buttons.push({ k: 'cancel', label: 'B', x: ax - 54, y: ay - 46, r: 30 });
    L.buttons.push({ k: 'start', label: 'START',
      x: Math.min(maxAx, Math.max(gameR + 6 + 34, rEdge - rw * 0.5)), y: 42 + it, r: 20, pill: true });
    L.gear = { x: Math.max(26 + il, il + lw / 2), y: 36 + it, r: 15 };
    L.dirCenter = { x: L.dirZone.x + lw / 2, y: H - 118 - ib };
  }
  L.dpadR = Math.max(52, Math.min(78, L.dirZone.w / 2 - 6));
  if (touch_cfg.side === 'left') {
    L.dirZone.x = W - (L.dirZone.x + L.dirZone.w);
    L.dirCenter.x = W - L.dirCenter.x;
    L.gear.x = W - L.gear.x;
    for (var b = 0; b < L.buttons.length; b++) L.buttons[b].x = W - L.buttons[b].x;
  }
  for (var i = 0; i < L.buttons.length; i++) {
    var bt = L.buttons[i];
    bt.x = Math.max(bt.r + 8, Math.min(W - bt.r - 8, bt.x));
    bt.y = Math.max(bt.r + 8, Math.min(H - bt.r - 8, bt.y));
  }
  L.dirCenter.x = Math.max(L.dirZone.x + L.dpadR + 6,
    Math.min(L.dirZone.x + L.dirZone.w - L.dpadR - 6, L.dirCenter.x));
  L.dirCenter.y = Math.max(L.dirZone.y + L.dpadR + 6,
    Math.min(L.dirZone.y + L.dirZone.h - L.dpadR - 6, L.dirCenter.y));
  touch_L = L;
  touch_svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  touch_paint();
}

// ---- input --------------------------------------------------------------------------------------

function touch_at(e) {
  return { x: e.clientX, y: e.clientY };
}
function touch_in(p, z) { return p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h; }
function touch_over(p, b, f) {
  var dx = p.x - b.x, dy = p.y - b.y;
  return b.pill ? (Math.abs(dx) <= b.r * 2.4 * f && Math.abs(dy) <= b.r * 1.2 * f)
                : (dx * dx + dy * dy <= (b.r * f) * (b.r * f));
}
function touch_btn_at(p, cur) {
  var i, bs = touch_L.buttons;
  // hysteresis: hold the current button until well outside it before acquiring another
  if (cur) for (i = 0; i < bs.length; i++) if (bs[i].k === cur && touch_over(p, bs[i], 1.32)) return cur;
  for (i = 0; i < bs.length; i++) if (touch_over(p, bs[i], 1.10)) return bs[i].k;
  return null;
}
function touch_angdist(a, c) { return Math.abs(((a - c + 540) % 360) - 180); }
function touch_sector_for(a, eight, cur) {
  var t = eight ? TOUCH_S8 : TOUCH_S4, i;
  if (cur) for (i = 0; i < t.length; i++)
    if (t[i][0] === cur && touch_angdist(a, t[i][1]) <= t[i][2] + TOUCH_HYST) return cur;
  for (i = 0; i < t.length; i++) if (touch_angdist(a, t[i][1]) <= t[i][2]) return t[i][0];
  return t[0][0];
}
function touch_update_dir() {
  var d = touch_dir, eight = TOUCH_CTX[touch_ctx][2];
  var dx = d.tx - d.bx, dy = d.ty - d.by, dist = Math.hypot(dx, dy);
  if (touch_cfg.mode === 'stick') {
    if (dist > TOUCH_THROW) {              // follow: the base slides under the thumb
      d.bx = d.tx - (dx / dist) * TOUCH_THROW; d.by = d.ty - (dy / dist) * TOUCH_THROW;
      dx = d.tx - d.bx; dy = d.ty - d.by; dist = TOUCH_THROW;
    }
  }
  var dead = touch_cfg.mode === 'stick' ? 12 : 14, out = touch_cfg.mode === 'stick' ? 8 : 10;
  if (dist < (d.sector ? out : dead)) { touch_sector(null); return; }
  var a = ((Math.atan2(-dy, dx) * 180 / Math.PI) + 360) % 360;
  var next = touch_sector_for(a, eight, d.sector);
  if (next !== d.sector) touch_buzz(4);
  touch_sector(next);
}

function touch_on_down(e) {
  if (!touch_live || touch_ctx === 4) return;
  e.preventDefault();
  var p = touch_at(e), L = touch_L;
  if (Math.hypot(p.x - L.gear.x, p.y - L.gear.y) <= L.gear.r * 1.6) { touch_open_sheet(); return; }
  var k = touch_btn_at(p, null);
  if (k) {                                  // a finger that lands on a button stays in button mode
    touch_ptr[e.pointerId] = { role: 'btn', k: k };
    touch_down(k); touch_buzz(8);
  } else if (touch_in(p, L.dirZone)) {
    var d = touch_dir;
    d.active = true; d.tx = p.x; d.ty = p.y;
    if (touch_cfg.mode === 'dpad') { d.bx = L.dirCenter.x; d.by = L.dirCenter.y; }
    else {
      var m = TOUCH_BASE_R + 4, z = L.dirZone;
      d.bx = Math.max(z.x + m, Math.min(z.x + z.w - m, p.x));
      d.by = Math.max(z.y + m, Math.min(z.y + z.h - m, p.y));
    }
    touch_ptr[e.pointerId] = { role: 'dir' };
    touch_update_dir();
  } else if (touch_in(p, L.game) && touch_ctx === 2) {
    touch_ptr[e.pointerId] = { role: 'screen' };        // dialog: the picture advances it
    touch_down('action');
  }
  try { touch_hit.setPointerCapture(e.pointerId); } catch (err) {}
  touch_paint();
}
function touch_on_move(e) {
  var r = touch_ptr[e.pointerId]; if (!r) return;
  e.preventDefault();
  var p = touch_at(e);
  if (r.role === 'dir') { touch_dir.tx = p.x; touch_dir.ty = p.y; touch_update_dir(); }
  else if (r.role === 'btn') {
    var k = touch_btn_at(p, r.k);
    if (k !== r.k) touch_swap(r, k);        // slide A -> B: release A, then press B, never both
  }
  touch_paint();
}
function touch_on_up(e) {
  var r = touch_ptr[e.pointerId]; if (!r) return;
  delete touch_ptr[e.pointerId];
  r.up = true;                             // a press still waiting on the minimum hold becomes a tap
  if (r.role === 'btn') { if (r.k) touch_up(r.k); }
  else if (r.role === 'screen') touch_up('action');
  else { touch_sector(null); touch_dir.active = false; }
  touch_paint();
}

// ---- drawing ------------------------------------------------------------------------------------

var TOUCH_NS = 'http://www.w3.org/2000/svg';
function touch_el(n, a) {
  var e = document.createElementNS(TOUCH_NS, n);
  for (var k in a) e.setAttribute(k, a[k]);
  return e;
}
function touch_paint() {
  if (!touch_ready || !touch_svg) return;
  while (touch_svg.firstChild) touch_svg.removeChild(touch_svg.firstChild);
  if (!touch_live || !touch_L || touch_ctx === 4) return;
  var L = touch_L, d = touch_dir, c = TOUCH_CTX[touch_ctx];
  var gd = touch_el('g', { opacity: c[0], class: 'gmt-fade' });
  var gb = touch_el('g', { opacity: c[1], class: 'gmt-fade' });
  gb.appendChild(touch_el('circle', { cx: L.gear.x, cy: L.gear.y, r: L.gear.r, class: 'gmt-gear' }));
  var gt = touch_el('text', { x: L.gear.x, y: L.gear.y, class: 'gmt-label', 'font-size': 12 });
  gt.textContent = '⚙'; gb.appendChild(gt);
  for (var i = 0; i < L.buttons.length; i++) {
    var b = L.buttons[i], on = !!touch_held[b.k];
    if (b.pill) {
      var w = b.r * 3.4, h = b.r * 1.5;
      gb.appendChild(touch_el('rect', { x: b.x - w / 2, y: b.y - h / 2, width: w, height: h, rx: h / 2,
        class: 'gmt-btn' + (on ? ' on' : '') }));
    } else gb.appendChild(touch_el('circle', { cx: b.x, cy: b.y, r: b.r, class: 'gmt-btn' + (on ? ' on' : '') }));
    var t = touch_el('text', { x: b.x, y: b.y, class: 'gmt-label' + (on ? ' on' : ''),
      'font-size': b.pill ? 10 : (b.r > 32 ? 16 : 14) });
    t.textContent = b.label; gb.appendChild(t);
  }
  if (touch_cfg.mode === 'dpad') touch_draw_dpad(gd, L, d);
  else touch_draw_stick(gd, L, d);
  touch_svg.appendChild(gd); touch_svg.appendChild(gb);
}
function touch_draw_stick(g, L, d) {
  if (!d.active) {
    g.appendChild(touch_el('circle', { cx: L.dirCenter.x, cy: L.dirCenter.y, r: TOUCH_BASE_R, class: 'gmt-ghost' }));
    return;
  }
  g.appendChild(touch_el('circle', { cx: d.bx, cy: d.by, r: TOUCH_BASE_R, class: 'gmt-ring' }));
  var dx = d.tx - d.bx, dy = d.ty - d.by, m = Math.hypot(dx, dy);
  if (m > TOUCH_THROW) { dx = dx / m * TOUCH_THROW; dy = dy / m * TOUCH_THROW; }
  g.appendChild(touch_el('circle', { cx: d.bx + dx, cy: d.by + dy, r: TOUCH_KNOB_R,
    class: 'gmt-knob' + (d.sector ? ' on' : '') }));
}
// One rounded 12-gon. Two overlapping translucent rects would composite where they cross and show a
// lighter square in the middle.
function touch_cross(cx, cy, L, w2, r) {
  var V = [[-w2,-L],[w2,-L],[w2,-w2],[L,-w2],[L,w2],[w2,w2],[w2,L],[-w2,L],[-w2,w2],[-L,w2],[-L,-w2],[-w2,-w2]];
  var d = '';
  for (var i = 0; i < 12; i++) {
    var p = V[(i + 11) % 12], v = V[i], n = V[(i + 1) % 12];
    var e1 = Math.hypot(p[0]-v[0], p[1]-v[1]), e2 = Math.hypot(n[0]-v[0], n[1]-v[1]);
    var d1 = [(p[0]-v[0])/e1, (p[1]-v[1])/e1], d2 = [(n[0]-v[0])/e2, (n[1]-v[1])/e2];
    var rr = Math.min(r, e1 / 2, e2 / 2);
    var a = [cx+v[0]+d1[0]*rr, cy+v[1]+d1[1]*rr], b = [cx+v[0]+d2[0]*rr, cy+v[1]+d2[1]*rr];
    var sweep = (d1[0]*d2[1] - d1[1]*d2[0]) < 0 ? 1 : 0;      // convex corners bulge outward
    d += (i === 0 ? 'M' : 'L') + a[0].toFixed(2) + ' ' + a[1].toFixed(2);
    d += 'A' + rr.toFixed(2) + ' ' + rr.toFixed(2) + ' 0 0 ' + sweep + ' ' + b[0].toFixed(2) + ' ' + b[1].toFixed(2);
  }
  return d + 'Z';
}
function touch_draw_dpad(g, L, d) {
  var cx = L.dirCenter.x, cy = L.dirCenter.y, R = L.dpadR;
  var arm = R * 0.92, w = R * 0.68, r = w * 0.28;
  g.appendChild(touch_el('path', { d: touch_cross(cx, cy, arm, w / 2, r), class: 'gmt-dpad' }));
  var s = d.sector, lit = [];
  if (s) {
    if (s.indexOf('up') >= 0) lit.push([cx-w/2+2, cy-arm+2, w-4, arm-w/2+r-2]);
    if (s.indexOf('down') >= 0) lit.push([cx-w/2+2, cy+w/2-r, w-4, arm-w/2+r-2]);
    if (s.indexOf('left') >= 0) lit.push([cx-arm+2, cy-w/2+2, arm-w/2+r-2, w-4]);
    if (s.indexOf('right') >= 0) lit.push([cx+w/2-r, cy-w/2+2, arm-w/2+r-2, w-4]);
    for (var i = 0; i < lit.length; i++)
      g.appendChild(touch_el('rect', { x: lit[i][0], y: lit[i][1], width: lit[i][2], height: lit[i][3],
        rx: r, class: 'gmt-arm' }));
  }
  var ax = [[0,-1],[0,1],[-1,0],[1,0]];
  for (var j = 0; j < 4; j++)
    g.appendChild(touch_el('circle', { cx: cx + ax[j][0] * (arm-13), cy: cy + ax[j][1] * (arm-13),
      r: 2, class: 'gmt-tick' }));
}

// ---- settings sheet -----------------------------------------------------------------------------

function touch_seg(label, hint, opts, get, set) {
  var row = document.createElement('div'); row.className = 'gmt-row';
  var l = document.createElement('div'); l.className = 'gmt-lab'; l.textContent = label;
  var seg = document.createElement('div'); seg.className = 'gmt-seg';
  for (var i = 0; i < opts.length; i++) (function (o) {
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = o[0];
    b.onclick = function () { set(o[1]); touch_save(); touch_sync(); touch_layout(); };
    b.setAttribute('data-v', String(o[1]));
    seg.appendChild(b);
  })(opts[i]);
  var box = document.createElement('div'); box.className = 'gmt-cell';
  box.appendChild(l);
  if (hint) { var h = document.createElement('div'); h.className = 'gmt-hint'; h.textContent = hint; box.appendChild(h); }
  row.appendChild(box); row.appendChild(seg);
  row._get = get; row._seg = seg;
  return row;
}
function touch_sync() {
  if (!touch_sheet) return;
  var rows = touch_sheet.querySelectorAll('.gmt-row');
  for (var i = 0; i < rows.length; i++) {
    var v = String(rows[i]._get()), bs = rows[i]._seg.children;
    for (var j = 0; j < bs.length; j++)
      bs[j].setAttribute('aria-pressed', bs[j].getAttribute('data-v') === v ? 'true' : 'false');
  }
}
function touch_open_sheet() { touch_release_all(); touch_sync(); touch_sheet.style.display = 'flex'; }
function touch_close_sheet() { touch_sheet.style.display = 'none'; }

// SET KEYS records the next seven keys pressed and has no cancel key, so on a device with no keyboard
// this is the only way out: replay the seven defaults, which restores the original bindings.
function touch_defaults() {
  var seq = [38, 40, 37, 39, 90, 88, 67], i = 0;
  function next() {
    if (i >= seq.length) return;
    var c = seq[i++];
    touch_send(c, true);
    setTimeout(function () { touch_send(c, false); setTimeout(next, 170); }, 170);
  }
  next();
}

// ---- boot ---------------------------------------------------------------------------------------

function touch_pin() {
  // window_set_size writes only the canvas backing store, so pin the CSS size to the window. The
  // runtime's fullscreen path rewrites canvas.style.cssText, hence re-checking every frame.
  var c = document.getElementById('canvas') || document.querySelector('canvas');
  if (c) {
    var w = innerWidth + 'px', h = innerHeight + 'px';
    if (c.style.width !== w) c.style.width = w;
    if (c.style.height !== h) c.style.height = h;
  }
  requestAnimationFrame(touch_pin);
}

function touch_init() {
  if (touch_ready) return;
  touch_load();
  var css = document.createElement('style');
  css.textContent =
    ':root{--touch-top:env(safe-area-inset-top,0px);--touch-bottom:env(safe-area-inset-bottom,0px);' +
    '--touch-left:env(safe-area-inset-left,0px);--touch-right:env(safe-area-inset-right,0px)}' +
    '#gmtouch{position:fixed;inset:0;z-index:2147483000;pointer-events:none;display:none;' +
    'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;-webkit-user-select:none;user-select:none}' +
    '#gmtouch-hit{position:absolute;inset:0;pointer-events:auto;touch-action:none}' +
    '#gmtouch svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}' +
    '.gmt-fade{transition:opacity .45s ease}' +
    '.gmt-btn{fill:rgba(255,255,255,.085);stroke:rgba(255,255,255,.30);stroke-width:1.15;' +
    'transition:fill .06s,stroke .06s}' +
    '.gmt-btn.on{fill:rgba(255,176,58,.26);stroke:rgba(255,176,58,.85)}' +
    '.gmt-label{fill:rgba(255,255,255,.62);text-anchor:middle;dominant-baseline:central;letter-spacing:.05em;' +
    'font-family:ui-monospace,SFMono-Regular,Menlo,monospace}' +
    '.gmt-label.on{fill:#ffb03a}' +
    '.gmt-ring{fill:rgba(255,255,255,.028);stroke:rgba(255,255,255,.22);stroke-width:1}' +
    '.gmt-knob{fill:rgba(255,255,255,.13);stroke:rgba(255,255,255,.34);stroke-width:1;transition:fill .07s,stroke .07s}' +
    '.gmt-knob.on{fill:rgba(255,176,58,.20);stroke:rgba(255,176,58,.52)}' +
    '.gmt-ghost{fill:none;stroke:rgba(255,255,255,.10);stroke-width:1;stroke-dasharray:2 6}' +
    '.gmt-dpad{fill:rgba(255,255,255,.06);stroke:rgba(255,255,255,.24);stroke-width:1.15}' +
    '.gmt-arm{fill:rgba(255,176,58,.30)}.gmt-tick{fill:rgba(255,255,255,.30)}' +
    '.gmt-gear{fill:rgba(255,255,255,.055);stroke:rgba(255,255,255,.16);stroke-width:1}' +
    '#gmtouch-sheet{position:absolute;left:0;right:0;bottom:0;background:rgba(10,11,14,.97);' +
    'border-top:1px solid #262c38;padding:16px;padding-bottom:calc(20px + var(--touch-bottom));' +
    'box-sizing:border-box;display:none;flex-direction:column;gap:13px;pointer-events:auto;color:#e8eaee}' +
    '#gmtouch-sheet h3{margin:0;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#79839a;font-weight:500}' +
    '.gmt-head{display:flex;justify-content:space-between;align-items:baseline}' +
    '.gmt-row{display:flex;justify-content:space-between;align-items:center;gap:12px}' +
    '.gmt-lab{font-size:12px}.gmt-hint{font-size:10px;color:#5a6274;margin-top:2px}' +
    '.gmt-seg{display:flex;border:1px solid #1e222b;border-radius:6px;overflow:hidden;flex:0 0 auto}' +
    '.gmt-seg button{appearance:none;border:0;background:transparent;color:#79839a;font:inherit;font-size:11px;' +
    'padding:8px 11px;cursor:pointer}' +
    '.gmt-seg button+button{border-left:1px solid #1e222b}' +
    '.gmt-seg button[aria-pressed="true"]{background:rgba(255,176,58,.14);color:#ffb03a}' +
    '#gmtouch-done{appearance:none;background:transparent;border:0;color:#e8eaee;font:inherit;font-size:12px;cursor:pointer}' +
    '#gmtouch-note{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:14px;background:rgba(8,9,11,.82);pointer-events:auto;color:#e8eaee;text-align:center;padding:24px}' +
    '#gmtouch-note p{margin:0;font-size:13px;line-height:1.5;max-width:30ch}' +
    '#gmtouch-note button{appearance:none;background:rgba(255,176,58,.16);border:1px solid rgba(255,176,58,.6);' +
    'color:#ffb03a;font:inherit;font-size:12px;padding:10px 16px;border-radius:7px;cursor:pointer}';
  document.head.appendChild(css);

  touch_root = document.createElement('div'); touch_root.id = 'gmtouch';
  touch_hit = document.createElement('div'); touch_hit.id = 'gmtouch-hit';
  touch_svg = document.createElementNS(TOUCH_NS, 'svg');
  touch_sheet = document.createElement('div'); touch_sheet.id = 'gmtouch-sheet';
  touch_note = document.createElement('div'); touch_note.id = 'gmtouch-note';

  var head = document.createElement('div'); head.className = 'gmt-head';
  var h3 = document.createElement('h3'); h3.textContent = 'Touch controls';
  var done = document.createElement('button');
  done.type = 'button'; done.id = 'gmtouch-done'; done.textContent = 'Done ✕';
  done.onclick = touch_close_sheet;
  head.appendChild(h3); head.appendChild(done);
  touch_sheet.appendChild(head);
  touch_sheet.appendChild(touch_seg('Control', 'Joystick follows your thumb. D-pad stays put.',
    [['Joystick', 'stick'], ['D-pad', 'dpad']],
    function () { return touch_cfg.mode; }, function (v) { touch_cfg.mode = v; }));
  touch_sheet.appendChild(touch_seg('Side', '', [['Right', 'right'], ['Left', 'left']],
    function () { return touch_cfg.side; }, function (v) { touch_cfg.side = v; }));
  touch_sheet.appendChild(touch_seg('Vibration', '', [['On', 1], ['Off', 0]],
    function () { return touch_cfg.haptics; }, function (v) { touch_cfg.haptics = v; }));
  touch_sheet.appendChild(touch_seg('Show controls', 'Auto hides them for a gamepad.',
    [['Auto', 2], ['On', 1], ['Off', 0]],
    function () { return touch_cfg.enabled; }, function (v) { touch_cfg.enabled = v; touch_apply(); }));

  var np = document.createElement('p');
  np.textContent = 'SET KEYS needs a keyboard. It records the next seven keys you press and has no cancel.';
  var nb = document.createElement('button');
  nb.type = 'button'; nb.textContent = 'Restore default keys';
  nb.onclick = touch_defaults;
  touch_note.appendChild(np); touch_note.appendChild(nb);

  touch_root.appendChild(touch_hit);
  touch_root.appendChild(touch_svg);
  touch_root.appendChild(touch_sheet);
  touch_root.appendChild(touch_note);
  document.body.appendChild(touch_root);

  touch_hit.addEventListener('pointerdown', touch_on_down);
  touch_hit.addEventListener('pointermove', touch_on_move);
  touch_hit.addEventListener('pointerup', touch_on_up);
  touch_hit.addEventListener('pointercancel', touch_on_up);
  addEventListener('resize', function () { touch_release_all(); touch_layout(); });
  addEventListener('orientationchange', function () { touch_release_all(); touch_layout(); });
  addEventListener('blur', touch_release_all);
  addEventListener('gamepadconnected', touch_apply);
  addEventListener('gamepaddisconnected', touch_apply);
  document.addEventListener('visibilitychange', function () { if (document.hidden) touch_release_all(); });

  touch_ready = true;
  touch_apply();
  requestAnimationFrame(touch_pin);
}

try {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', touch_init);
  else touch_init();
} catch (e) {}
