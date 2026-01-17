'use strict';

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import * as Animations from './animations.js';
import { idleAdd, idleRemove, setProperties, wire } from './utils.js';
import { disable_unredirect, enable_unredirect } from './compat.js';

const Signals = imports.signals;

/**
 * @typedef {{ x1: number, y1: number, x2: number, y2: number }} Box
 */

/**
 * @enum {number}
 */
export const Edge = {
  AUTO: -1,
  NONE: 0,
  TOP: 1,
  RIGHT: 2,
  BOTTOM: 4,
  LEFT: 8
};

/**
 * @type {(msg: string) => void}
 */
var _log;

/**
 * @param {Box} box
 */
export function boxToString({ x1, y1, x2, y2 }) {
  return `[${x1},${y1},${x2},${y2}]`;
}

/**
 * @param {Box} boxA 
 * @param {Box} boxB 
 */
export function boxOverlaps(boxA, boxB) {
  return boxA.x1 < boxB.x2 && boxB.x1 < boxA.x2 &&
    boxA.y1 < boxB.y2 && boxB.y1 < boxA.y2;
}

/**
 * @param {Box} boxA - the respect to box
 * @param {Box} boxB - the relative to box
 * @param factor - the relative factor
 */
export function relativeEdge(boxA, boxB, factor = 0.3) {
  const ox = (boxA.x2 - boxA.x1) * factor;
  const oy = (boxA.y2 - boxA.y1) * factor;

  let edge = 0;

  if (boxB.y2 < boxA.y1 + oy)
    edge |= Edge.TOP;
  else if (boxB.y1 > boxA.y2 - oy)
    edge |= Edge.BOTTOM;

  if (boxB.x2 < boxA.x1 + ox)
    edge |= Edge.LEFT;
  else if (boxB.x1 > boxA.x2 - ox)
    edge |= Edge.RIGHT;

  return edge;
}

/**
 * Transforms `boxA` removing the space used by `boxB`.
 * If boxes do not overlap `boxA` is not modified.
 * 
 * @param {Box} boxA - the box to reduce
 * @param {Box} boxB - space to remove
 */
export function reduceBox(boxA, boxB) {
  const edge = relativeEdge(boxA, boxB);
  switch (edge) {
    case Edge.TOP:
      boxA.y1 = Math.max(boxA.y1, Math.ceil(boxB.y2));
      break;
    case Edge.BOTTOM:
      boxA.y2 = Math.min(boxA.y2, Math.floor(boxB.y1));
      break;
    case Edge.LEFT:
      boxA.x1 = Math.max(boxA.x1, Math.ceil(boxB.x2));
      break;
    case Edge.RIGHT:
      boxA.x2 = Math.min(boxA.x2, Math.floor(boxB.x1));
      break;
  }
}

export class Mole {

  /**
   * @param {Clutter.Actor} actor 
   * @param {Gio.Settings} gsettings 
   */
  constructor(actor, gsettings) {
    this._allocation = new TransformedAllocation(actor);

    this._animation = new Animations.Wrapper(gsettings, this._allocation);

    this._unredirect = new Unredirect();

    this._activation = new IdleActivation(true);

    this._acounter = new ActivationCounter();

    this._acounter.onActiveChanged = () =>
      this._activation.setActive(this._acounter.active);

    this._activation.onActiveChanged = () => {
      if (this._activation.active)
        this._unredirect.setDisabled(true);
      this._animation.setActive(this._activation.active);
    };

    this._animation.onCompleted = () => {
      if (!this._activation.active)
        this._unredirect.setDisabled(false);
    };
  }

  enable() {
    this._allocation.enable();
    this._animation.enable();
    this._activation.enable();
  }

  disable() {
    this._activation.disable();
    this._animation.disable();
    this._allocation.disable();
    this._unredirect.setDisabled(false);
  }

  sync() {
    this._activation.setActive(this._acounter.active);
  }

  get allocation() {
    return this._allocation;
  }

  get counter() {
    return this._acounter;
  }
}

export class TransformedAllocation {

  /**
   * @param {Clutter.Actor} actor 
   */
  constructor(actor) {
    this._actor = actor;
    this._allocated = { x1: 0, y1: 0, x2: 0, y2: 0 };
    this._allocation = { x1: 0, y1: 0, x2: 0, y2: 0 };
    this._translation = { x1: 0, y1: 0, x2: 0, y2: 0 };
    this._visible = true;

    const updateAllocation = this._updateAllocation.bind(this);
    this._wires = [
      wire(actor, 'notify::allocation', updateAllocation),
      wire(actor, 'notify::mapped', updateAllocation),
    ];

    if (actor.has_allocation()) {
      this._updateAllocation();
    }
  }

  enable() {
    this._wires.forEach(e => e.connect());

    /* This should be done only if the actor has an allocation,
     * however there are cases where the has_allocation method
     * returns false but then the signal is not emitted (ex.
     * lock/unlock screen) so only check if mapped */
    if (this._actor.is_mapped()) {
      this._updateAllocation();
    }
  }

  disable() {
    this._wires.forEach(e => e.disconnect());
  }

  get actor() {
    return this._actor;
  }

  get allocation() {
    return this._allocation;
  }

  get x1() {
    return this._allocated.x1 + this._translation.x1;
  }

  get y1() {
    return this._allocated.y1 + this._translation.y1;
  }

  get x2() {
    return this._allocated.x2 + this._translation.x2;
  }

  get y2() {
    return this._allocated.y2 + this._translation.y2;
  }

  get visible() {
    return this._visible;
  }

  set visible(value) {
    if (this._visible !== value) {
      this._visible = value;
      this._visibleChanged();
    }
  }

  /**
   * @param {Partial<Box>} translation - the translation of the original allocation
   */
  setTranslation(translation) {
    if (setProperties(this._translation, translation)) {
      this._transformedChanged();
    }
  }

  _updateAllocation() {
    const allocation = this._actor.get_allocation_box();
    if (setProperties(this._allocated, allocation)) {
      if (setProperties(this._allocation, allocation)) {
        this._allocationChanged();
      } else {
        this._transformedChanged();
      }
    }
  }

  _allocationChanged() {
    _log && _log(`Allocation changed: ${boxToString(this.allocation)}`);
    this.emit('allocation-changed');
  }

  _transformedChanged() {
    _log && _log(`Transformed changed: ${boxToString(this)}`);
    this.emit('transformed-changed');
  }

  _visibleChanged() {
    _log && _log(`Visible changed: ${this.visible}`);
    this.emit('visible-changed');
  }
}
Signals.addSignalMethods(TransformedAllocation.prototype);
/** @type {(s: string, ...args: any[]) => void} */
TransformedAllocation.prototype.emit;

export class ActivationCounter {
  constructor() {
    this._count = 0;
  }

  get active() {
    return !!this._count;
  }

  onActiveChanged() { }

  /**
   * @param {string} name 
   */
  newActivation(name) {
    return new Activation(this, name);
  }

  get count() {
    return this._count;
  }

  increase() {
    this._count++;
    if (this._count === 1) {
      this.onActiveChanged();
    }
  }

  decrease() {
    this._count--;
    if (this._count === 0) {
      this.onActiveChanged();
    }
  }
}

export class Activation {

  /**
   * @param {ActivationCounter} counter 
   * @param {string} name 
   */
  constructor(counter, name) {
    this.counter = counter;
    this.name = name;
    this._active = false;
  }

  get active() {
    return this._active;
  }

  set active(value) {
    value = !!value;
    if (this._active !== value) {
      this._active = value;
      if (value) {
        _log && _log(`Activate: ${this.name}`);
        this.counter.increase();
      } else {
        _log && _log(`Deactivate: ${this.name}`);
        this.counter.decrease();
      }
    }
  }
}

class IdleActivation {
  constructor(active = false) {
    this._active = active;
    this._wanted = active;
    this._idleId = 0;
  }

  enable() { }

  disable() {
    this._idleRemove();
  }

  get active() {
    return this._active;
  }

  onActiveChanged() { }

  setActive(value) {
    if (this._wanted !== value) {
      this._wanted = value;
      this._idleAdd();
    }
  }

  _setActive(value) {
    if (this._active !== value) {
      this._active = value;
      _log && _log(`Active changed: ${value}`);
      this.onActiveChanged();
    }
  }

  _idleAdd() {
    if (this._idleId)
      return;

    _log && _log('Idle add');
    this._idleId = idleAdd(this._onIdle.bind(this));
  }

  _idleRemove() {
    if (!this._idleId)
      return;

    idleRemove(this._idleId);
    this._idleId = 0;
  }

  _onIdle() {
    this._idleId = 0;
    this._setActive(this._wanted);
  }
}

/**
 * Disable/enable unredirect for display.
 *
 * On X sessions some applications (most notably media players, for ex VLC) after going
 * fullscreen for a while, when leaving fullscreen and their window geometry is the same
 * of the screen (so when they are maximized) they not allow elements to be painted on
 * top of the window, causing the panel to be invisible (still usable however if clicking
 * on reactive elements).
 * Disabling unredirect fix this.
 */
class Unredirect {
  constructor() {
    this._disabled = false;
  }

  /**
   * @param {boolean} value 
   */
  setDisabled(value) {
    if (this._disabled === value)
      return;

    if (value) {
      disable_unredirect();
    } else {
      enable_unredirect();
    }

    this._disabled = value;
  }
}

export const TransformedCanvasConstraint = GObject.registerClass(
  class TransformedCanvasConstraint extends (Clutter.Constraint) {

    /**
     * @param {TransformedAllocation} talloc 
     */
    _init(talloc) {
      super._init();
      this._talloc = talloc;
      this._wire = wire(
        talloc,
        'transformed-changed',
        this._queueRelayout.bind(this)
      );
    }

    vfunc_set_actor(actor) {
      if (actor) {
        this._wire.connect();
      } else {
        this._wire.disconnect();
      }
      super.vfunc_set_actor(actor);
    }

    vfunc_update_allocation(_actor, allocation) {
      /* maybe I should check the actors have the same parent,
       * as allocation is relative to the parent, however it may be
       * they have different parents but still valid relative allocations,
       * only time will tell */
      reduceBox(allocation, this._talloc);
      _log && _log(`TransformedCanvasConstraint updated allocation: ${boxToString(allocation)}`);
    }

    _queueRelayout() {
      const actor = this.get_actor();
      actor && actor.queue_relayout();
    }
  }
);

export const AllocationCanvasConstraint = GObject.registerClass(
  class AllocationCanvasConstraint extends (Clutter.Constraint) {

    /**
     * @param {TransformedAllocation} talloc 
     */
    _init(talloc) {
      super._init();
      this._talloc = talloc;
      this._box = { x1: 0, y1: 0, x2: 0, y2: 0 };
      this._wire = wire(
        talloc,
        'allocation-changed',
        this._allocationChanged.bind(this)
      );
    }

    vfunc_set_actor(actor) {
      if (actor) {
        this._wire.connect();
        this._updateBox();
      } else {
        this._wire.disconnect();
      }
      super.vfunc_set_actor(actor);
    }

    vfunc_update_allocation(_actor, allocation) {
      reduceBox(allocation, this._box);
      _log && _log(`AllocationCanvasConstraint updated allocation: ${boxToString(allocation)}`);
    }

    _allocationChanged() {
      this._updateBox();
      this._queueRelayout();
    }

    _updateBox() {
      this._box = { ...this._talloc.allocation };
      _log && _log(`AllocationCanvasConstraint box: ${boxToString(this._box)}`);
    }

    _queueRelayout() {
      const actor = this.get_actor();
      actor && actor.queue_relayout();
    }
  }
);
