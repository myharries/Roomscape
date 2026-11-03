/* ===================================================================
   conductor-lib/ha.js  v1.2
   v1.2: AFTER-DARK — light.turn_on for the room's lights is held back while
        the sun is up. See the block above haCall.
   v1.1 (RS-SEC v1.01, F13): haFetch caps the buffered response (4 MB) and
        adds an absolute 20 s deadline on top of the inactivity timeout.
   Extracted verbatim from conductor.js v2.62 (RoomScape Conductor v3.62 split).
   Home Assistant bridge HELPER layer only: haOn / haCfg / haFetch / haCall.
   The /api/ha/* route handlers stay woven into coreHandler in conductor.js;
   haApplyRoom stays in core (it is REASSIGNED by the rooms2.5 TV-wake patch).
   SAFETY RULES (absolute):
   1. NEVER require npm packages here — node builtins (http/https) ONLY. This
      file lives on the share; the share's Windows-only node_modules must not
      shadow the container's Linux ones.
   2. Functions that appended patch blocks REASSIGN stay in conductor.js.
   ctx surface: values HA_URL, HA_TOKEN, DEFAULT_SETTINGS; getter settings()
   (read at call time — core reassigns settings on /api/profiles saves).
   No ctx accessor is called at construction time.
   =================================================================== */
'use strict';
const http = require('http');

module.exports = function (ctx) {
  const HA_URL = ctx.HA_URL, HA_TOKEN = ctx.HA_TOKEN, DEFAULT_SETTINGS = ctx.DEFAULT_SETTINGS;

  function haOn() { return !!(HA_URL && HA_TOKEN); }
  /* v1.1 (RS-THEMES v1): theme packs may register in-memory light scenes
     ('theme:<pack>' payloads) — the RS-THEMES block injects the getter into ctx
     AFTER construction, so guard for it and read at call time. They merge on
     top of defaults + user scenes and are never persisted. */
  function haCfg() { const h = ctx.settings().ha || {}; return { tvs: h.tvs || {}, lights: h.lights || [], zones: h.lightZones || DEFAULT_SETTINGS.ha.lightZones, lightScenes: Object.assign({}, DEFAULT_SETTINGS.ha.lightScenes, h.lightScenes || {}, (typeof ctx.themeLightScenes === 'function' ? ctx.themeLightScenes() : {})) }; }

  /* RS-SEC v1.01 (F13): the response used to be accumulated into an unbounded
     string, and `timeout: 8000` is an INACTIVITY timeout — a peer that dribbles
     a byte every few seconds keeps the socket alive forever while the buffer
     grows. GET /api/states on a large HA install is already megabytes, so this
     matters even without malice. Two bounds now:
       MAX_BODY  — hard cap on buffered bytes; over it, abort and error.
       DEADLINE  — absolute wall-clock limit for the whole exchange. */
  const HA_MAX_BODY = 4 * 1024 * 1024;
  const HA_DEADLINE = 20000;
  function haFetch(method, apiPath, body, cb) {
    cb = cb || function () {};
    if (!haOn()) return cb(new Error('HA not configured (set HA_URL and HA_TOKEN)'));
    let req2, done = false, deadline = null;
    function finish(err, code, j) {
      if (done) return; done = true;
      if (deadline) { clearTimeout(deadline); deadline = null; }
      cb(err, code, j);
    }
    function abort(msg) { try { req2 && req2.destroy(new Error(msg)); } catch (e) {} finish(new Error(msg)); }
    try {
      const url = new URL(HA_URL + apiPath);
      const lib = url.protocol === 'https:' ? require('https') : http;
      req2 = lib.request(url, { method, headers: { Authorization: 'Bearer ' + HA_TOKEN, 'Content-Type': 'application/json' }, timeout: 8000 }, (r) => {
        let s = '', n = 0;
        r.on('data', (c) => {
          if (done) return;
          n += c.length;
          if (n > HA_MAX_BODY) { try { r.destroy(); } catch (e) {} return abort('HA response exceeded ' + (HA_MAX_BODY / 1024 / 1024) + ' MB'); }
          s += c;
        });
        r.on('end', () => { let j = null; try { j = JSON.parse(s || 'null'); } catch (e) {} finish(null, r.statusCode, j); });
        r.on('error', (e) => finish(e));
      });
    } catch (e) { return finish(e); }
    deadline = setTimeout(() => abort('HA request exceeded the ' + (HA_DEADLINE / 1000) + 's deadline'), HA_DEADLINE);
    if (deadline.unref) deadline.unref();
    req2.on('error', (e) => finish(e));
    req2.on('timeout', () => { req2.destroy(new Error('HA timeout')); });
    if (body) req2.write(JSON.stringify(body));
    req2.end();
  }
  /* AFTER-DARK: every light command in the Conductor goes through haCall, so this
     one gate covers modes, intros, moments, flicker and the Lights tab. While the
     sun is up, light.turn_on is dropped for the room's own lights (ha.lights and
     every zone). Turning lights OFF and other entities are never touched. If
     sun.sun cannot be read the lights are allowed, so a broken sensor cannot
     silently disable the room. The test bypass expires by itself. */
  const BYPASS_MS = 30 * 60 * 1000;
  let sunUp = null, bypassUntil = 0, bypassTimer = null, sunTimer = null, onChange = function () {};
  function adCfg() { return Object.assign({}, DEFAULT_SETTINGS.ha.afterDark, (ctx.settings().ha || {}).afterDark || {}); }
  function bypassed() { return Date.now() < bypassUntil; }
  function lightsAllowed() { return !adCfg().on || sunUp !== true || bypassed(); }
  function roomLights() {
    const h = haCfg(), a = (h.lights || []).slice();
    Object.keys(h.zones || {}).forEach(function (k) { (h.zones[k] || []).forEach(function (en) { if (a.indexOf(en) < 0) a.push(en); }); });
    return a;
  }
  function pollSun(cb) {
    if (!haOn() || !adCfg().on) return cb && cb();
    haFetch('GET', '/api/states/' + (adCfg().sunEntity || 'sun.sun'), null, function (e, code, d) {
      const next = (!e && code === 200 && d && d.state) ? d.state === 'above_horizon' : null;
      const was = sunUp; sunUp = next;
      if (was === true && next === false) onChange('sunset');
      if (cb) cb();
    });
  }
  function afterDarkStatus() {
    return { ok: true, on: !!adCfg().on, sunUp: sunUp, dark: sunUp === false, allowed: lightsAllowed(), bypass: bypassed(),
             bypassLeftS: bypassed() ? Math.ceil((bypassUntil - Date.now()) / 1000) : 0 };
  }
  /* Ending the test (switched off, or the 30 minutes run out) puts the lights back:
     off again if the sun is still up, otherwise left alone for the night's scene. */
  function endBypass() {
    if (bypassTimer) { clearTimeout(bypassTimer); bypassTimer = null; }
    if (!bypassUntil) return;
    bypassUntil = 0; onChange('bypass-off');
    if (sunUp === true && adCfg().on) { const room = roomLights(); if (room.length) haCall('light', 'turn_off', { entity_id: room, transition: 1 }); }
  }
  function setBypass(on) {
    if (!on) { endBypass(); return afterDarkStatus(); }
    if (bypassTimer) clearTimeout(bypassTimer);
    bypassUntil = Date.now() + BYPASS_MS;
    bypassTimer = setTimeout(endBypass, BYPASS_MS); if (bypassTimer.unref) bypassTimer.unref();
    onChange('bypass');
    return afterDarkStatus();
  }
  function startAfterDark(fn) {
    onChange = fn || onChange; pollSun();
    if (!sunTimer) { sunTimer = setInterval(pollSun, 60000); if (sunTimer.unref) sunTimer.unref(); }
  }
  function haCall(domain, service, data, cb) {
    if (domain === 'light' && service === 'turn_on' && data && data.entity_id && !lightsAllowed()) {
      const room = roomLights(), ents = [].concat(data.entity_id), keep = ents.filter(function (en) { return room.indexOf(en) < 0; });
      if (!keep.length) return cb && cb(null, 200, null);          // nothing to do: looks like success to the caller
      data = Object.assign({}, data, { entity_id: keep });
    }
    haFetch('POST', '/api/services/' + domain + '/' + service, data || {}, cb);
  }

  return { haOn, haCfg, haFetch, haCall, afterDarkStatus, setBypass, startAfterDark };
};
