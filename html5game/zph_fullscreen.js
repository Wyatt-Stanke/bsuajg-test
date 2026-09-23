// Fullscreen for the HTML5 build, whose window_set_fullscreen does nothing. import.mjs adds this file to the project
// as an extension; patch 14 and modernized/05 call it for the Configuration menu's SCREEN setting.
// A page may enter fullscreen only shortly after a key press or click, so without one it waits for the next.
var fullscreen_wanted = false;

function fullscreen_get() {
  return document.fullscreenElement || document.webkitFullscreenElement ? 1 : 0;
}

function fullscreen_set(on) {
  var d = document, el = d.documentElement;
  fullscreen_wanted = on >= 0.5;
  if (fullscreen_wanted == fullscreen_get()) return 0;
  if (!fullscreen_wanted) {
    (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    return 0;
  }
  var request = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!request) return 0; // iPhone Safari has no element fullscreen
  if (navigator.userActivation && !navigator.userActivation.isActive) {
    fullscreen_later();
    return 0;
  }
  var p = request.call(el);
  if (p) p.catch(fullscreen_later);
  return 0;
}

function fullscreen_later() {
  ['keydown', 'mousedown', 'touchend'].forEach(function (type) {
    addEventListener(type, fullscreen_retry, true);
  });
}

function fullscreen_retry() {
  ['keydown', 'mousedown', 'touchend'].forEach(function (type) {
    removeEventListener(type, fullscreen_retry, true);
  });
  if (fullscreen_wanted) fullscreen_set(1);
}
