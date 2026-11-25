const VIRTUAL_CLOCK_SCRIPT = `<script>
(function() {
  var virtualNow = 0;
  var rafIdCounter = 1;
  var timerIdCounter = 1;
  var rafCallbacks = new Map();
  var timers = new Map();
  var animStartTimes = new WeakMap();

  var startEpoch = Date.now();

  try {
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: function() { return virtualNow; }
    });
  } catch (e) {
    try {
      performance.now = function() { return virtualNow; };
    } catch (err) {}
  }

  Date.now = function() {
    return startEpoch + virtualNow;
  };

  window.requestAnimationFrame = function(cb) {
    var id = rafIdCounter++;
    rafCallbacks.set(id, cb);
    return id;
  };

  window.cancelAnimationFrame = function(id) {
    rafCallbacks.delete(id);
  };

  window.setTimeout = function(fn, delay) {
    var args = Array.prototype.slice.call(arguments, 2);
    var id = timerIdCounter++;
    var ms = Math.max(0, Number(delay) || 0);
    timers.set(id, { fn: fn, time: virtualNow + ms, interval: null, args: args });
    return id;
  };

  window.clearTimeout = function(id) {
    timers.delete(id);
  };

  window.setInterval = function(fn, delay) {
    var args = Array.prototype.slice.call(arguments, 2);
    var id = timerIdCounter++;
    var step = Math.max(8, Number(delay) || 16);
    timers.set(id, { fn: fn, time: virtualNow + step, interval: step, args: args });
    return id;
  };

  window.clearInterval = function(id) {
    timers.delete(id);
  };

  var origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, attrs) {
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
      var nextAttrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
      return origGetContext.call(this, type, nextAttrs);
    }
    return origGetContext.call(this, type, attrs);
  };

  window.__FRAMEHTML_CLOCK__ = {
    advanceTo: function(targetMs) {
      virtualNow = targetMs;

      var safety = 0;
      while (safety++ < 500) {
        var nextId = null;
        var nextTimer = null;
        timers.forEach(function(t, id) {
          if (t.time <= virtualNow && (!nextTimer || t.time < nextTimer.time)) {
            nextId = id;
            nextTimer = t;
          }
        });
        if (!nextTimer) break;
        if (nextTimer.interval !== null) {
          nextTimer.time += nextTimer.interval;
        } else {
          timers.delete(nextId);
        }
        try {
          if (typeof nextTimer.fn === 'function') {
            nextTimer.fn.apply(window, nextTimer.args);
          } else if (typeof nextTimer.fn === 'string') {
            (0, eval)(nextTimer.fn);
          }
        } catch (err) {}
      }

      var currentRafs = Array.from(rafCallbacks.values());
      rafCallbacks.clear();
      for (var i = 0; i < currentRafs.length; i++) {
        try {
          currentRafs[i](virtualNow);
        } catch (err) {}
      }

      if (typeof document.getAnimations === 'function') {
        var anims = document.getAnimations({ subtree: true });
        for (var j = 0; j < anims.length; j++) {
          var anim = anims[j];
          try {
            if (!animStartTimes.has(anim)) {
              animStartTimes.set(anim, virtualNow);
            }
            if (anim.playState !== 'paused') {
              anim.pause();
            }
            var offset = animStartTimes.get(anim) || 0;
            anim.currentTime = Math.max(0, virtualNow - offset);
          } catch (e) {}
        }
      }

      var svgs = document.querySelectorAll('svg');
      for (var k = 0; k < svgs.length; k++) {
        var svg = svgs[k];
        try {
          if (typeof svg.pauseAnimations === 'function') {
            svg.pauseAnimations();
            svg.setCurrentTime(virtualNow / 1000);
          }
        } catch (e) {}
      }
    }
  };
})();
</script>`;

const BASE_RESET_STYLE = `<style>html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }</style>`;

export function normalizeHtmlDocument(rawHtml: string, injectVirtualClock = false): string {
  const trimmed = rawHtml.trim();
  if (!trimmed) {
    return '<!DOCTYPE html><html><head></head><body></body></html>';
  }

  const headInjections = `${injectVirtualClock ? VIRTUAL_CLOCK_SCRIPT : ''}${BASE_RESET_STYLE}`;
  const hasHtmlTag = /<html[\s>]/i.test(trimmed);
  const hasHeadTag = /<head[\s>]/i.test(trimmed);
  const hasBodyTag = /<body[\s>]/i.test(trimmed);

  if (hasHeadTag) {
    return trimmed.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n${headInjections}`);
  }

  if (hasHtmlTag) {
    if (hasBodyTag) {
      return trimmed.replace(/<body(\s[^>]*)?>/i, (match) => `<head>${headInjections}</head>\n${match}`);
    }
    return trimmed.replace(/<html(\s[^>]*)?>/i, (match) => `${match}\n<head>${headInjections}</head>`);
  }

  if (hasBodyTag) {
    return `<!DOCTYPE html><html><head>${headInjections}</head>${trimmed}</html>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${headInjections}
</head>
<body>
${trimmed}
</body>
</html>`;
}
