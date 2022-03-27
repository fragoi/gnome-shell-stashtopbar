'use strict';

const { GObject, Clutter, Meta } = imports.gi;
const Signals = imports.signals;
const Main = imports.ui.main;

const NAME = 'Stash Top Bar';

const ActivationFlags = {
  HOVER: 1,
  OVERVIEW: 2,
  KEYFOCUS: 4,
  MENUOPEN: 8
};

var _log = undefined;

function init() {
  return new Extension();
}

class Extension {
  enable() {
    const panel = Main.panel;
    const panelBox = Main.layoutManager.panelBox;

    this._fullscreenTrap = new FullscreenTrap(panelBox);

    this._offcanvas = new Clutter.Actor({ reactive: true });

    Main.layoutManager.addChrome(this._offcanvas);

    panelBox.remove_child(panel);
    this._offcanvas.add_child(panel);

    this._talloc = new TransformedAllocation(this._offcanvas);

    this._animation = new OffcanvasAnimation(this._offcanvas, this._talloc);

    this._activator = new Activator();
    this._activator.onActiveChanged = () => {
      this._animation.setActive(this._activator.active);
    };

    this._destroyables = [];

    this._destroyables.push(new HoverActivation(this._offcanvas, this._activator));
    this._destroyables.push(new BarrierActivation(this._offcanvas, this._activator));
    this._destroyables.push(new OverviewActivation(Main.overview, this._activator));

    for (const p in panel.statusArea) {
      const actor = panel.statusArea[p];
      this._destroyables.push(new KeyFocusActivation(actor, this._activator));
      if (actor.menu) {
        this._destroyables.push(new MenuActivation(actor.menu, this._activator));
        this._destroyables.push(new MenuRelayout(this._talloc, actor.menu));
      }
    }

    this._destroyables.push(new MessageTrayRelayout(this._talloc, Main.messageTray));

    this._animation.setActive(false);

    Main.stashTopBar = this;
    log(`${NAME} enabled`);
  }

  disable() {
    const panel = Main.panel;
    const panelBox = Main.layoutManager.panelBox;

    this._destroyables.reverse().forEach(e => e.destroy());
    this._destroyables = null;

    this._activator = null;

    this._animation.destroy();
    this._animation = null;

    this._talloc.destroy();
    this._talloc = null;

    this._offcanvas.remove_child(panel);
    panelBox.add_child(panel);

    Main.layoutManager.removeChrome(this._offcanvas);

    this._offcanvas.destroy();
    this._offcanvas = null;

    this._fullscreenTrap.destroy();
    this._fullscreenTrap = null;

    delete Main.stashTopBar;
    log(`${NAME} disabled`);
  }
}

class OffcanvasAnimation {
  constructor(actor, talloc) {
    this._actor = actor;
    this._active = true;
    this._animating = false;

    this._tcId = actor.connect('transitions-completed', () => {
      this._animating = false;

      actor.y += actor.translation_y - this._translation_y;
      actor.translation_y = this._translation_y;
    });

    this._transitionId = actor.connect('notify::translation-y', () => {
      const translation = actor.translation_y;
      talloc.setTranslation({ y1: translation, y2: translation });
    });
  }

  destroy() {
    this._actor.disconnect(this._tcId);
    this._actor.disconnect(this._transitionId);
  }

  get active() {
    return this._active;
  }

  setActive(value) {
    if (this._active !== value) {
      this._active = value;
      if (value) {
        this._activate();
      } else {
        this._deactivate();
      }
    }
  }

  _activate() {
    this._slide(this._actor.height);
  }

  _deactivate() {
    this._slide(-this._actor.height, 200);
  }

  _slide(value, delay) {
    if (!this._animating) {
      this._animating = true;
      //        this._y = this._actor.translation_y;
      this._y = this._translation_y = this._actor.translation_y;
      //        this._y = this._actor.y;
    }
    this._y += value;
    this._actor.save_easing_state();
    if (delay)
      this._actor.set_easing_delay(delay);
    //    this._actor.set_easing_duration(3000);
    this._actor.translation_y = this._y;
    //      this._actor.y = this._y;
    this._actor.restore_easing_state();
  }
}

class TransformedAllocation {
  constructor(actor) {
    this._actor = actor;
    this._allocation = { x1: 0, y1: 0, x2: 0, y2: 0 };
    this._translation = { x1: 0, y1: 0, x2: 0, y2: 0 };

    this._allocationChangedId = actor.connect('notify::allocation', () => {
      this._updateAllocation();
    });

    if (actor.has_allocation()) {
      this._updateAllocation();
    }
  }

  destroy() {
    this._actor.disconnect(this._allocationChangedId);
  }

  get x1() {
    return this._allocation.x1 + this._translation.x1;
  }

  get y1() {
    return this._allocation.y1 + this._translation.y1;
  }

  get x2() {
    return this._allocation.x2 + this._translation.x2;
  }

  get y2() {
    return this._allocation.y2 + this._translation.y2;
  }

  setTranslation(translation) {
    if (this._setValues(this._translation, translation)) {
      this._allocationChanged();
    }
  }

  _updateAllocation() {
    const allocation = this._actor.get_allocation_box();
    if (this._setValues(this._allocation, allocation)) {
      this._allocationChanged();
    }
  }

  _setValues(object, values) {
    let changed = false;
    for (const p in object) {
      if (p in values && object[p] !== values[p]) {
        object[p] = values[p];
        changed = true;
      }
    }
    return changed;
  }

  _allocationChanged() {
    this.emit('allocation-changed');
  }
}
Signals.addSignalMethods(TransformedAllocation.prototype);

class Activator {
  constructor() {
    this._flags = 0;
  }

  get active() {
    return !!this._flags;
  }

  onActiveChanged() { }

  activate(flags) {
    this._setFlags(this._flags | flags);
  }

  deactivate(flags) {
    this._setFlags(this._flags & ~flags);
  }

  _setFlags(flags) {
    const pre = this._flags;
    this._flags = flags;
    if (!!pre !== !!flags) {
      this.onActiveChanged();
    }
  }
}

class HoverActivation {
  constructor(actor, activator) {
    this._hoverTracker = new HoverTracker(actor);
    this._hoverTracker.onHoverChanged = () => {
      if (this._hoverTracker.hover) {
        activator.activate(ActivationFlags.HOVER);
      } else {
        activator.deactivate(ActivationFlags.HOVER);
      }
    };
  }

  destroy() {
    this._hoverTracker.destroy();
  }
}

class HoverTracker {
  constructor(actor) {
    this._actor = actor;
    this._hover = false;

    this._enterId = actor.connect('enter-event', this._onEnter.bind(this));
    this._leaveId = actor.connect('leave-event', this._onLeave.bind(this));
  }

  destroy() {
    this._actor.disconnect(this._enterId);
    this._actor.disconnect(this._leaveId);
  }

  onHoverChanged() { }

  get hover() {
    return this._hover;
  }

  _setHover(value) {
    if (this._hover !== value) {
      this._hover = value;
      this.onHoverChanged();
    }
  }

  _onEnter(_actor, _event) {
    this._setHover(true);
  }

  _onLeave(actor, event) {
    const related = event.get_related();
    if (related && actor.contains(related)) {
      return;
    }
    this._setHover(false);
  }
}

/**
 * NOTE: Barrier activation activate the HOVER flag, this is intended.
 */
class BarrierActivation {
  constructor(actor, activator) {
    this._barrier = new Meta.Barrier({
      directions: Meta.BarrierDirection.POSITIVE_Y,
      display: global.display,
      x1: actor.x,
      y1: actor.y,
      x2: actor.x + actor.width,
      y2: actor.y
    });

    this._pressureBarrier = new PressureBarrier(this._barrier);
    this._pressureBarrier.onHit = () => activator.activate(ActivationFlags.HOVER);
  }

  destroy() {
    this._pressureBarrier.destroy();
    this._barrier.destroy();
  }
}

class PressureBarrier {
  constructor(barrier, threshold = 100, timeout = 100) {
    this._barrier = barrier;
    this._horizontal = barrier.y1 === barrier.y2;
    this._threshold = threshold;
    this._timeout = timeout;

    this._expire = 0;
    this._pressure = 0;
    this._hit = false;

    this._hitId = barrier.connect('hit', this._onBarrierHit.bind(this));
    this._leftId = barrier.connect('left', this._onBarrierLeft.bind(this));
  }

  destroy() {
    this._barrier.disconnect(this._hitId);
    this._barrier.disconnect(this._leftId);
  }

  onHit() { }

  _onBarrierHit(_barrier, event) {
    if (this._hit) {
      return;
    }
    if (event.time >= this._expire) {
      this._expire = event.time + this._timeout;
      this._pressure = 0;
    }
    const across = this._distanceAcross(event);
    const along = this._distanceAlong(event);
    this._pressure += along > 1 ? across / along : across;
    if (this._pressure >= this._threshold) {
      _log && _log(`Barrier trigger, pressure: ${this._pressure}, time: ${(
        event.time + this._timeout - this._expire
      )}`);
      this._hit = true;
      this.onHit();
    }
    /* maybe I should release the pointer when there is no timeout
     * so I can support having a monitor after the barrier?
     * Need to check with more monitors */
    //    else if (this._timeout <= 0) {
    //      this._barrier.release(event);
    //    }
  }

  _distanceAcross(event) {
    return Math.abs(this._horizontal ? event.dy : event.dx);
  }

  _distanceAlong(event) {
    return Math.abs(this._horizontal ? event.dx : event.dy);
  }

  _onBarrierLeft(_barrier, _event) {
    this._expire = 0;
    this._pressure = 0;
    this._hit = false;
  }
}

class OverviewActivation {
  constructor(overview, activator) {
    this._overview = overview;
    this._showingId = overview.connect('showing', () => {
      activator.activate(ActivationFlags.OVERVIEW);
    });
    this._hidingId = overview.connect('hiding', () => {
      activator.deactivate(ActivationFlags.OVERVIEW);
    });
  }

  destroy() {
    this._overview.disconnect(this._showingId);
    this._overview.disconnect(this._hidingId);
  }
}

class KeyFocusActivation {
  constructor(actor, activator) {
    this._actor = actor;
    this._keyFocusInId = actor.connect('key-focus-in', () => {
      activator.activate(ActivationFlags.KEYFOCUS);
    });
    this._keyFocusOutId = actor.connect('key-focus-out', () => {
      activator.deactivate(ActivationFlags.KEYFOCUS);
    });
  }

  destroy() {
    this._actor.disconnect(this._keyFocusInId);
    this._actor.disconnect(this._keyFocusOutId);
  }
}

class MenuActivation {
  constructor(menu, activator) {
    this._menu = menu;
    this._openChangedId = menu.connect('open-state-changed', () => {
      if (menu.isOpen) {
        activator.activate(ActivationFlags.MENUOPEN);
      } else {
        activator.deactivate(ActivationFlags.MENUOPEN);
      }
    });
  }

  destroy() {
    this._menu.disconnect(this._openChangedId);
  }
}

class MenuRelayout {
  constructor(talloc, menu) {
    this._talloc = talloc;
    this._changedId = talloc.connect('allocation-changed', () => {
      if (menu.isOpen && menu.actor) {
        menu.actor.queue_relayout();
      }
    });
  }

  destroy() {
    this._talloc.disconnect(this._changedId);
  }
}

class MessageTrayRelayout {
  constructor(talloc, messageTray) {
    this._messageTray = messageTray;
    this._constraint = new CanvasConstraint(talloc);
    messageTray.add_constraint(this._constraint);
  }

  destroy() {
    this._messageTray.remove_constraint(this._constraint);
  }
}

const CanvasConstraint = GObject.registerClass(
  class CanvasConstraint extends Clutter.Constraint {
    _init(talloc) {
      super._init();
      this._talloc = talloc;
      this._changedId = 0;
    }

    _connect() {
      if (this._changedId) {
        return;
      }
      this._changedId = this._talloc.connect(
        'allocation-changed',
        this._queueRelayout.bind(this)
      );
    }

    _disconnect() {
      if (!this._changedId) {
        return;
      }
      this._talloc.disconnect(this._changedId);
      this._changedId = 0;
    }

    vfunc_set_actor(actor) {
      if (actor) {
        this._connect();
      } else {
        this._disconnect();
      }
      super.vfunc_set_actor(actor);
    }

    vfunc_update_allocation(_actor, allocation) {
      /* maybe I should check the actors have the same parent,
       * as allocation is relative to the parent, however it may be
       * they have different parents but still valid relative allocations,
       * only time will tell */

      const { x1: ax1, y1: ay1, x2: ax2, y2: ay2 } = allocation;
      const w = ax2 - ax1;
      const h = ay2 - ay1;
      if (!w || !h) {
        return;
      }

      const { x1: tx1, y1: ty1, x2: tx2, y2: ty2 } = this._talloc;
      /* relative points */
      const rx1 = (tx1 - ax1) / w;
      const ry1 = (ty1 - ay1) / h;
      const rx2 = (tx2 - ax1) / w;
      const ry2 = (ty2 - ay1) / h;
      /* relative size */
      const rw = rx2 - rx1;
      const rh = ry2 - ry1;

      /* horizontal */
      if (rw > rh) {
        /* top */
        if (ry2 < 0.3) {
          allocation.y1 = Math.max(ay1, Math.ceil(ty2));
        }
        /* bottom */
        else if (ry1 > 0.7) {
          allocation.y2 = Math.min(ay2, Math.floor(ty1));
        }
      }
      /* vertical */
      else if (rw < rh) {
        /* left */
        if (rx2 < 0.3) {
          allocation.x1 = Math.max(ax1, Math.ceil(tx2));
        }
        /* right */
        else if (rx1 > 0.7) {
          allocation.x2 = Math.min(ax2, Math.floor(tx1));
        }
      }
    }

    _queueRelayout() {
      const actor = this.get_actor();
      actor && actor.queue_relayout();
    }
  }
);

const FullscreenTrap_TRACKED = Symbol('tracked');

/**
 * On X sessions some applications (most notably media players, for ex VLC) after going
 * fullscreen for a while, when leaving fullscreen and their window geometry is the same
 * of the screen (so when they are maximized) they not allow elements to be painted on
 * top of the window, causing the panel to be invisible (still usable however if clicking
 * on reactive elements).
 * This seems to be related to the window geometry being the same size of the screen.
 * The only solution found so far is to modify the "struts" of the workspace so that
 * the working area of the workspace is smaller than the screen.
 * This is already managed by "addChrome" method of layout manager, passing the proper
 * parameter.
 * What this class do is adding an actor that affects the struts of the workspace by 1px,
 * only when a window has gone fullscreen and it is currently focused.
 */
class FullscreenTrap {
  constructor(actor) {
    /* Use same monitor of the actor */
    const monitor = Main.layoutManager.findMonitorForActor(actor) || {
      x: 0, y: 0, width: actor.width
    };

    this._actor = new Clutter.Actor({
      x: monitor.x,
      y: monitor.y,
      width: monitor.width,
      height: 0
    });
    this._active = false;

    Main.layoutManager.addChrome(this._actor, {
      affectsInputRegion: false,
      affectsStruts: true
    });

    this._ifcId = global.display.connect(
      'in-fullscreen-changed',
      this._onInFullscreenChanged.bind(this)
    );
    this._fwcId = global.display.connect(
      'notify::focus-window',
      this._onFocusWindowChanged.bind(this)
    );
  }

  destroy() {
    global.display.disconnect(this._ifcId);
    global.display.disconnect(this._fwcId);
    this._actor.destroy();
  }

  _onInFullscreenChanged() {
    if (this._active) {
      return;
    }
    /* maybe I should check that the monitor of the actor is fullscreen
     * to avoid tracking windows on other monitors, but what if the window
     * is then moved on this monitor? Need to check with more monitors */
    //    const monitor = Main.layoutManager.findMonitorForActor(this._actor);
    //    if (!monitor.inFullscreen) {
    //      return;
    //    }
    const win = global.display.focus_window;
    if (win && win.is_fullscreen()) {
      this._trackWindow(win);
      this._setActive(true);
    }
  }

  _onFocusWindowChanged() {
    const win = global.display.focus_window;
    const tracked = !!win && this._isWindowTracked(win);
    this._setActive(tracked);
  }

  _isWindowTracked(win) {
    return !!win[FullscreenTrap_TRACKED];
  }

  _trackWindow(win) {
    win[FullscreenTrap_TRACKED] = true;
  }

  _untrackWindow(win) {
    delete win[FullscreenTrap_TRACKED];
  }

  _setActive(value) {
    if (this._active !== value) {
      this._active = value;
      this._toggle();
    }
  }

  _toggle() {
    if (this._active) {
      this._actor.set_height(1);
    } else {
      this._actor.set_height(0);
    }
  }
}
