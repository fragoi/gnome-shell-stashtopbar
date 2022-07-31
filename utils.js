'use strict';

const { GLib } = imports.gi;

/**
 * @param {function} callback - the callback to execute when idle
 * @returns {number} the ID of the idle source
 */
function idleAdd(callback) {
  return GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, callback);
}

/**
 * @param {number} id - the ID of the idle source
 */
function idleRemove(id) {
  GLib.Source.remove(id);
}

/**
 * @param object - the object to set properties to
 * @param values - the object with properties to set
 * @returns if any property is changed
 */
function setProperties(object, values) {
  let changed = false;
  for (const p in object) {
    if (p in values && object[p] !== values[p]) {
      object[p] = values[p];
      changed = true;
    }
  }
  return changed;
}

/**
 * @param target - the GObject-like object to connect to
 * @param {string} signal - the signal name to connect to
 * @param {function} handler - the handler to connect
 * @returns {Wire} a new wire
 */
function wire(target, signal, handler) {
  return new Wire(target, signal, handler);
}

class Wire {
  constructor(target, signal, handler) {
    this._target = target;
    this._signal = signal;
    this._handler = handler;
    this._handlerId = 0;
  }

  connect() {
    if (!this._handlerId && this._target) {
      this._handlerId = this._target.connect(this._signal, this._handler);
    }
    return this;
  }

  disconnect() {
    if (this._handlerId) {
      this._target.disconnect(this._handlerId);
      this._handlerId = 0;
    }
  }

  isConnected() {
    return !!this._handlerId;
  }

  setTarget(target) {
    this.disconnect();
    this._target = target;
    return this;
  }
}

if (typeof module === 'object') {
  module.exports = {
    idleAdd,
    idleRemove,
    setProperties,
    wire
  };
}
