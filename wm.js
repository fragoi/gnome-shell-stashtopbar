'use strict';

const { Meta } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const { setProperties, wire } = Me.imports.utils;

/**
 * @type {(msg: string) => void}
 */
var _log;

var WindowOverlaps = class {
  constructor() {
    this._symbol = Symbol('WindowOverlaps');
    this._box = { x1: 0, y1: 0, x2: 0, y2: 0 };
    this._overlaps = 0;

    this._wires = [
      wire(global.window_group, 'actor-added', (_s, a) => this._trackActor(a))
    ];
  }

  enable() {
    this._wires.forEach(e => e.connect());
    this._windowActors.forEach(e => this._trackActor(e));
  }

  disable() {
    this._wires.forEach(e => e.disconnect());
    this._windowActors.forEach(e => this._untrackActor(e));
  }

  setBox(box) {
    if (setProperties(this._box, box)) {
      this._windowActors.forEach(e => this._updateOverlap(e));
    }
  }

  get overlaps() {
    return this._overlaps;
  }

  onOverlapsChanged() { }

  get hasOverlaps() {
    return !!this._overlaps;
  }

  onHasOverlapsChanged() { }

  _addOverlaps(value) {
    this._setOverlaps(this._overlaps + value);
  }

  _setOverlaps(value) {
    const pre = this._overlaps;
    if (pre !== value) {
      this._overlaps = value;
      this.onOverlapsChanged();
      if (!!pre !== !!value) {
        this.onHasOverlapsChanged();
      }
    }
  }

  get _windowActors() {
    return Meta.get_window_actors(global.display);
  }

  _trackActor(actor) {
    if (!actor.meta_window) {
      return;
    }
    if (actor[this._symbol]) {
      return;
    }

    _log && _log(`Track actor: ${actor}`);

    const handler = this._updateOverlap.bind(this);
    const untrack = this._untrackActor.bind(this);

    actor[this._symbol] = {
      allocationChangedId: actor.connect('notify::allocation', handler),
      visibleChangedId: actor.connect('notify::visible', handler),
      destroyId: actor.connect('destroy', untrack),
      overlap: false
    };

    if (actor.has_allocation() && actor.visible) {
      this._updateOverlap(actor);
    }
  }

  _untrackActor(actor) {
    const data = actor[this._symbol];
    if (!data) {
      return;
    }

    _log && _log(`Untrack actor: ${actor}`);

    actor.disconnect(data.allocationChangedId);
    actor.disconnect(data.visibleChangedId);
    actor.disconnect(data.destroyId);

    if (data.overlap) {
      this._addOverlaps(-1);
    }

    delete actor[this._symbol];
  }

  _updateOverlap(actor) {
    const data = actor[this._symbol];
    if (!data) {
      return;
    }

    _log && _log(`Update overlap for actor: ${actor}`);

    const overlap = this._actorOverlaps(actor);
    if (data.overlap !== overlap) {
      data.overlap = overlap;
      this._addOverlaps(overlap ? 1 : -1);
    }
  }

  _actorOverlaps(actor) {
    if (!actor.visible) {
      return false;
    }
    if (!actor.meta_window) {
      return false;
    }
    const { x, y, width, height } = actor.meta_window.get_frame_rect();
    return this._box.x1 < x + width && x < this._box.x2
      && this._box.y1 < y + height && y < this._box.y2
  }
}

if (typeof module === 'object') {
  module.exports = {
    __esModule: true,
    WindowOverlaps
  };
}
