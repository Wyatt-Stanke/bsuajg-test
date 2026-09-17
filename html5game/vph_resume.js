// Resume for the modernized HTML5 build: after the tab reloads, or is closed and reopened, the game continues where it
// was. import.mjs adds this file to the project as an extension. Every few steps resume_tick (patch modernized/06) hands
// the game state to resume_put, which writes it to browser storage when the page is hidden or closed, and at most every
// 5 s in case that never comes. resume_take gives it back once per page load, at Game Start, and forgets it.
// After an uncaught error (the game has stopped) nothing is kept, so a state that crashes isn't restored again.
var resume_key = 'barkley.resume', resume_state = '', resume_written = 0, resume_taken = false, resume_failed = false;

function resume_put(state) {
  if (resume_failed) return 0;
  resume_state = state;
  if (Date.now() - resume_written > 5000) resume_write();
  return 0;
}

function resume_take() {
  var state = '';
  if (resume_taken) return state; // game_restart runs Game Start again
  resume_taken = true;
  try {
    state = localStorage.getItem(resume_key) || '';
    localStorage.removeItem(resume_key); // a state that fails to restore isn't tried again
  } catch (e) {}
  return state;
}

function resume_clear() {
  resume_state = '';
  try {
    localStorage.removeItem(resume_key);
  } catch (e) {}
  return 0;
}

function resume_write() {
  resume_written = Date.now();
  if (resume_state)
    try {
      localStorage.setItem(resume_key, resume_state);
    } catch (e) {}
}

addEventListener('error', function () {
  resume_failed = true;
  resume_clear();
});
addEventListener('pagehide', resume_write);
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') resume_write();
});
