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

    this._offcanvas = new Offcanvas();

    Main.layoutManager.addChrome(this._offcanvas);

    panelBox.remove_child(panel);
    this._offcanvas.add_child(panel);

    this._activator = new Activator();
    this._activator.onActivate = () => this._offcanvas.setActive(true);
    this._activator.onDeactivate = () => this._offcanvas.setActive(false);

    this._hoverActivation = new HoverActivation(this._offcanvas, this._activator);
    this._overviewActivation = new OverviewActivation(Main.overview, this._activator);

    this._otherActivations = [];
    for (const p in panel.statusArea) {
      const actor = panel.statusArea[p];
      this._otherActivations.push(new KeyFocusActivation(actor, this._activator));
      if (actor.menu) {
        this._otherActivations.push(
          new MenuActivation(actor.menu, this._activator, this._offcanvas)
        );
      }
    }

    Main.messageTray.add_constraint(new Clutter.SnapConstraint({
      name: 'below-offcanvas',
      source: this._offcanvas,
      from_edge: Clutter.SnapEdge.TOP,
      to_edge: Clutter.SnapEdge.BOTTOM
    }));

    this._offcanvas.setActive(false);

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

    this._offcanvas.destroy();
    this._offcanvas = null;

    delete Main.stashTopBar;
    log(`${NAME} disabled`);
  }
}

const Offcanvas = GObject.registerClass(
  class Offcanvas extends Clutter.Actor {
    _init() {
      super._init({
        reactive: true
      });
      this._active = true;
      this._animating = false;
      this.connect('transitions-completed', () => {
        this._animating = false;

        this.y += this.translation_y - this._translation_y;
        this.translation_y = this._translation_y;
      });
      //      this.connect('allocation-changed', () => log('Allocation changed (offcanvas)'));
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
      this._slide(this.height);
    }

    _deactivate() {
      this._slide(-this.height, 200);
    }

    _slide(value, delay) {
      if (!this._animating) {
        this._animating = true;
        //        this._y = this.translation_y;
        this._y = this._translation_y = this.translation_y;
        //        this._y = this.y;
      }
      this._y += value;
      this.save_easing_state();
      if (delay)
        this.set_easing_delay(delay);
      //      this.set_easing_duration(5000);
      this.translation_y = this._y;
      //      this.y = this._y;
      this.restore_easing_state();
    }
  }
);

class Activator {
  constructor() {
    this._flags = 0;
  }

  activate(flags) {
    const pre = this._flags;
    this._flags |= flags;
    if (!pre && this._flags) {
      this.onActivate();
      return true;
    }
    return false;
  }

  onActivate() { }

  deactivate(flags) {
    const pre = this._flags;
    this._flags &= ~flags;
    if (pre && !this._flags) {
      this.onDeactivate();
      return true;
    }
    return false;
  }

  onDeactivate() { }
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
    this._hoverTracker.destroy();
    this._pressureBarrier.destroy();
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
    _log && _log('Hover enter');
    this._setHover(true);
  }

  _onLeave(actor, event) {
    const related = event.get_related();
    _log && _log(`Hover leave, related: ${related}`);
    if (related && actor.contains(related)) {
      return;
    }
    _log && _log('Hover left');
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
  constructor(menu, activator, offcanvas) {
    this._menu = menu;
    this._openChangedId = menu.connect('open-state-changed', () => {
      if (menu.isOpen) {
        activator.activate(ActivationFlags.MENUOPEN);
      } else {
        activator.deactivate(ActivationFlags.MENUOPEN);
      }
    });
    const menuRelayout = () => {
      if (offcanvas.active && menu.isOpen && menu.actor) {
        menu.actor.queue_relayout();
      }
    };
    this._offcanvas = offcanvas;
    this._allocationId = offcanvas.connect('notify::y', menuRelayout);
    this._transitionId = offcanvas.connect('notify::translation-y', menuRelayout);
  }

  destroy() {
    this._menu.disconnect(this._openChangedId);
    this._offcanvas.disconnect(this._allocationId);
    this._offcanvas.disconnect(this._transitionId);
  }
}
