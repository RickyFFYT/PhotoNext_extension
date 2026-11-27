/*
 * A complete Minotauris bridge client, in about a hundred lines and with no
 * dependencies.
 *
 * This exists to prove a claim: an extension's view does not need React, a
 * bundler, or any Minotauris package to be hosted. It needs a sandboxed
 * document that speaks `postMessage`, and that is all this is. If you are
 * building with a bundler, `@minotauris/extension-sdk` exports the same client
 * with types; if you are building with a text editor, this is the whole protocol.
 *
 * Note that the host's CSP forbids inline scripts, so this file must be loaded
 * with a <script src> tag rather than pasted into the document.
 */
(function () {
  'use strict';

  var BRIDGE_VERSION = 1;
  var REQUEST_TIMEOUT_MS = 30000;

  var nonce = null;
  var context = null;
  var theme = null;
  var sequence = 0;
  var pending = {};
  var readyCallbacks = [];

  function post(message) {
    window.parent.postMessage(message, '*');
  }

  function request(type, payload) {
    var id = type + '#' + (sequence += 1);
    return new Promise(function (resolve) {
      // A picker is answered by a person, not by the host's scheduling: give it
      // no deadline, so a slow choice is not reported as a host failure and the
      // eventual selection is still delivered.
      var timer = type === 'document.pick' ? null : setTimeout(function () {
        delete pending[id];
        resolve({ ok: false, error: 'The host did not answer "' + type + '".' });
      }, REQUEST_TIMEOUT_MS);
      pending[id] = function (response) {
        if (timer) clearTimeout(timer);
        resolve(response);
      };
      post({
        bridge: BRIDGE_VERSION,
        id: id,
        type: type,
        nonce: nonce,
        payload: payload || {}
      });
    });
  }

  function applyTheme(next) {
    theme = next;
    if (!next || !next.tokens) return;
    var root = document.documentElement;
    Object.keys(next.tokens).forEach(function (name) {
      root.style.setProperty(name, next.tokens[name]);
    });
    root.setAttribute('data-theme', next.preset || 'light');
  }

  window.addEventListener('message', function (event) {
    // Both checks matter. `event.source` is what actually authenticates the
    // host — the frame's own origin is opaque, so it cannot be used here.
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || typeof message !== 'object' || message.bridge !== BRIDGE_VERSION) return;

    if (message.type === 'host.ready') {
      nonce = message.payload.nonce;
      context = message.payload.context;
      applyTheme(message.payload.theme);
      readyCallbacks.forEach(function (callback) {
        callback(context, theme);
      });
      return;
    }

    if (message.type === 'host.theme') {
      applyTheme(message.payload.theme);
      return;
    }

    if (message.id && pending[message.id]) {
      var settle = pending[message.id];
      delete pending[message.id];
      settle({
        ok: message.payload.ok === true,
        result: message.payload.result,
        error: message.payload.error
      });
    }
  });

  window.minotauris = {
    /** Runs once the host has completed the handshake. */
    onReady: function (callback) {
      if (context) callback(context, theme);
      else readyCallbacks.push(callback);
    },
    context: function () {
      return context;
    },
    request: request,
    tools: {
      list: function () {
        return request('tools.list');
      },
      call: function (tool, args) {
        return request('tools.call', { tool: tool, args: args || {} });
      }
    },
    state: {
      get: function (key) {
        return request('state.get', { key: key });
      },
      set: function (key, value) {
        return request('state.set', { key: key, value: value });
      },
      remove: function (key) {
        return request('state.delete', { key: key });
      }
    },
    /** Hand free text to Mono, who can act on it with this extension's tools. */
    prompt: function (text) {
      return request('mono.prompt', { text: text });
    },
    /** Open this extension in its own OS window. */
    openWindow: function () {
      return request('host.openWindow');
    },
    /** Put this in-app surface away; the extension's process keeps running. */
    close: function () {
      return request('host.close');
    },
    log: function (level, message) {
      post({ bridge: BRIDGE_VERSION, type: 'host.log', nonce: nonce, payload: { level: level, message: message } });
    }
  };

  // Announce ourselves. The host answers with the nonce everything else needs.
  post({ bridge: BRIDGE_VERSION, id: 'ready#1', type: 'ext.ready', payload: { bridgeVersion: BRIDGE_VERSION } });
})();
