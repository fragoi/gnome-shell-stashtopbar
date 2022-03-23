'use strict';

const { GObject, Clutter, Meta } = imports.gi;
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

    this._animation = new OffcanvasAnimation(this._offcanvas);

    this._activator = new Activator();
    this._activator.onActiveChanged = () => {
      this._animation.setActive(this._activator.active);
    };

    this._hoverActivation = new HoverActivation(this._offcanvas, this._activator);
    this._overviewActivation = new OverviewActivation(Main.overview, this._activator);

    this._otherActivations = [];
    for (const p in panel.statusArea) {
      const actor = panel.statusArea[p];
      this._otherActivations.push(new KeyFocusActivation(actor, this._activator));
      if (actor.menu) {
        this._otherActivations.push(new MenuActivation(actor.menu, this._activator));
        this._otherActivations.push(new MenuRelayout(actor.menu, this._offcanvas));
      }
    }

    Main.messageTray.add_constraint(new Clutter.SnapConstraint({
      name: 'below-offcanvas',
      source: this._offcanvas,
      from_edge: Clutter.SnapEdge.TOP,
      to_edge: Clutter.SnapEdge.BOTTOM
    }));

    this._animation.setActive(false);

    Main.stashTopBar = this;
    log(`${NAME} enabled`);
  }

  disable() {
    const panel = Main.panel;
    const panelBox = Main.layoutManager.panelBox;

    Main.messageTray.remove_constraint_by_name('below-offcanvas');

    for (const a of this._otherActivations) {
      a.destroy();
    }
    this._otherActivations = null;

    this._overviewActivation.destroy();
    this._overviewActivation = null;
    this._hoverActivation.destroy();
    this._hoverActivation = null;

    this._activator = null;

    this._offcanvas.remove_child(panel);
    panelBox.add_child(panel);

    Main.layoutManager.removeChrome(this._offcanvas);

    this._animation.destroy();
    this._animation = null;

    this._offcanvas.destroy();
    this._offcanvas = null;

    this._fullscreenTrap.destroy();
    this._fullscreenTrap = null;

    delete Main.stashTopBar;
    log(`${NAME} disabled`);
  }
}

class OffcanvasAnimation {
  constructor(actor) {
    this._actor = actor;
    this._active = true;
    this._animating = false;

    this._tcId = actor.connect('transitions-completed', () => {
      this._animating = false;

      actor.y += actor.translation_y - this._translation_y;
      actor.translation_y = this._translation_y;
    });
  }

  destroy() {
    this._actor.disconnect(this._tcId);
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
    this._actor = actor;
    this._barrier = new Meta.Barrier({
      directions: Meta.BarrierDirection.POSITIVE_Y,
      display: global.display,
      x1: actor.x,
      y1: actor.y,
      x2: actor.x + actor.width,
      y2: actor.y
    });

    this._hoverTracker = new HoverTracker(actor);
    this._hoverTracker.onHoverChanged = () => {
      if (this._hoverTracker.hover) {
        activator.activate(ActivationFlags.HOVER);
      } else {
        activator.deactivate(ActivationFlags.HOVER);
      }
    };

    this._pressureBarrier = new PressureBarrier(this._barrier);
    this._pressureBarrier.onHit = () => activator.activate(ActivationFlags.HOVER);
  }

  destroy() {
    this._pressureBarrier.destroy();
    this._hoverTracker.destroy();
    this._barrier.destroy();
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
  }

  _distanceAcross(event) {
    return Math.abs(this._horizontal ? event.dy : event.dx);
  }

  _distanceAlong(event) {
    return Math.abs(this._horizontal ? event.dx : event.dy);
  }

  _onBarrierLeft(_barrier, _event) {
    _log && _log('Barrier left');
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
  constructor(menu, actor) {
    const menuRelayout = () => {
      if (menu.isOpen && menu.actor) {
        menu.actor.queue_relayout();
      }
    };
    this._actor = actor;
    this._allocationId = actor.connect('notify::y', menuRelayout);
    this._transitionId = actor.connect('notify::translation-y', menuRelayout);
  }

  destroy() {
    this._actor.disconnect(this._allocationId);
    this._actor.disconnect(this._transitionId);
  }
}

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
