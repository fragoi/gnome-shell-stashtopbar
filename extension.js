'use strict';

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import {
  Mole,
  TransformedCanvasConstraint,
  AllocationCanvasConstraint,
  Edge,
  relativeEdge,
  boxToString
} from './chromole.js';
import { wire } from './utils.js';
import { WindowOverlaps } from './wm.js';
import { CHILD_ADDED, CHILD_REMOVED } from './compat.js';

const NAME = 'Stash Top Bar';
const GSETTINGS_ID = 'org.gnome.shell.extensions.com-github-fragoi-stashtopbar';

/**
 * @import { TransformedAllocation, ActivationCounter, Activation } from './chromole'
 */

/**
 * @type {(msg: string) => void}
 */
var _log;

function isStartupCompleted() {
  return Main.actionMode !== Shell.ActionMode.NONE;
}

export default class MyExtension extends Extension {
  enable() {
    const actor = Main.layoutManager.panelBox;
    const gsettings = this.getSettings(GSETTINGS_ID);

    const mole = new Mole(actor, gsettings);
    const hover = mole.counter.newActivation('Hover');

    this._components = [
      new UIChangeForPanelBox(),
      new EnsureReactive(actor),
      new InputRegionTrigger(mole.allocation),

      mole,

      new HoverActivation(actor, hover),
      new BarrierActivation(mole.allocation, gsettings, hover),
      new OverviewActivation(Main.overview, mole.counter),
      new StatusAreaActivations(Main.panel, mole.counter),
      /* KeyFocusTracker can replace completely StatusAreaActivations */
      // new KeyFocusTracker(actor, mole.counter),
      new WindowOverlapsActivation(mole.allocation, mole.counter),

      new ActorConstraint(
        Main.messageTray,
        new TransformedCanvasConstraint(mole.allocation)
      ),
      new ActorConstraint(
        Main.overview._overview,
        new AllocationCanvasConstraint(mole.allocation)
      ),
      new ActiveMenuRelayout(mole.allocation),

      new TriggerOnMapped(actor, () => mole.sync()),
    ];

    /* up to here no changes have been made to any actor and no signals
     * have been connected (otherwise, it is a bug).
     * Now start applying changes... */

    _log && _log(`${NAME} enabling...`);

    this._components.forEach(e => e.enable());

    log(`${NAME} enabled`);
  }

  disable() {
    _log && _log(`${NAME} disabling...`);

    this._components.reverse().forEach(e => e.disable());
    this._components = null;

    log(`${NAME} disabled`);
  }
}

class UIChangeForActor {

  /**
   * @param {Clutter.Actor} actor 
   */
  constructor(actor) {
    this._actor = actor;
  }

  enable() {
    const panel = Main.panel;
    const panelBox = Main.layoutManager.panelBox;

    if (this._actor.contains(panel))
      return;

    Main.layoutManager.addChrome(this._actor);

    panelBox.remove_child(panel);
    this._actor.add_child(panel);

    /* when actor is not visible need to ask a relayout */
    if (!panelBox.visible) {
      panelBox.queue_relayout();
    }
  }

  disable() {
    const panel = Main.panel;
    const panelBox = Main.layoutManager.panelBox;

    if (panelBox.contains(panel))
      return;

    this._actor.remove_child(panel);
    panelBox.add_child(panel);

    Main.layoutManager.removeChrome(this._actor);
  }
}

class UIChangeForPanelBox {
  enable() {
    const panelBox = Main.layoutManager.panelBox;

    // TODO: make this configurable
    const trackFullscreen = false;

    /* untrack and retrack only input region (by default) */
    Main.layoutManager.untrackChrome(panelBox);
    Main.layoutManager.trackChrome(panelBox, {
      trackFullscreen
    });

    if (!trackFullscreen && !panelBox.visible) {
      panelBox.visible = true;
    }
  }

  disable() {
    const panelBox = Main.layoutManager.panelBox;

    /* untrack and retrack with all flags (like when created) */
    Main.layoutManager.untrackChrome(panelBox);
    Main.layoutManager.trackChrome(panelBox, {
      affectsStruts: true,
      trackFullscreen: true
    });
  }
}

class EnsureReactive {

  /**
   * @param {Clutter.Actor} actor 
   */
  constructor(actor) {
    this._actor = actor;
    this._wasReactive = null;
  }

  enable() {
    if (this._wasReactive !== null)
      return;

    this._wasReactive = this._actor.get_reactive();

    if (!this._wasReactive) {
      this._actor.set_reactive(true);
    }
  }

  disable() {
    if (this._wasReactive === null)
      return;

    if (!this._wasReactive) {
      this._actor.set_reactive(false);
    }

    this._wasReactive = null;
  }
}

class InputRegionTrigger {

  /**
   * @param {TransformedAllocation} talloc
   */
  constructor(talloc) {
    this._talloc = talloc;
    this._actor = null;
    this._wire = wire(
      talloc,
      'visible-changed',
      this._onVisibleChanged.bind(this)
    );
  }

  enable() {
    if (this._actor)
      return;

    this._actor = new Clutter.Actor();

    Main.layoutManager.addChrome(this._actor);
    Main.layoutManager.uiGroup.set_child_below_sibling(
      this._actor,
      this._talloc.actor
    );

    this._wire.connect();
  }

  disable() {
    if (!this._actor)
      return;

    this._wire.disconnect();
    this._actor.destroy();
    this._actor = null;
  }

  _onVisibleChanged() {
    this._actor.visible = this._talloc.visible;
  }
}

class TriggerOnMapped {

  /**
   * @param {Clutter.Actor} actor 
   * @param {() => void} trigger 
   */
  constructor(actor, trigger) {
    this._actor = actor;
    this._trigger = trigger;

    this._wire = wire(
      actor,
      'notify::mapped',
      this._onMappedChanged.bind(this)
    );
  }

  enable() {
    if (this._actor.is_mapped()) {
      this._trigger();
    } else {
      _log && _log('Actor is not mapped, wait for it');
      this._wire.connect();
    }
  }

  disable() {
    this._wire.disconnect();
  }

  _onMappedChanged() {
    if (this._actor.is_mapped()) {
      this._wire.disconnect();
      this._trigger();
    }
  }
}

class HoverActivation {

  /**
   * @param {Clutter.Actor} actor 
   * @param {Activation} activation 
   */
  constructor(actor, activation) {
    this._activation = activation;
    this._wires = [
      wire(actor, 'enter-event', this._onEnter.bind(this)),
      /* need to track also motion event because of grabs */
      wire(actor, 'motion-event', this._onHover.bind(this)),
      wire(actor, 'leave-event', this._onLeave.bind(this))
    ];
  }

  enable() {
    this._wires.forEach(e => e.connect());
  }

  disable() {
    this._wires.forEach(e => e.disconnect());
  }

  _onEnter() {
    _log && _log('Enter');
    this._activation.active = true;
  }

  _onHover() {
    this._activation.active = true;
  }

  _onLeave(actor, event) {
    _log && _log('Leave');

    /* check related actor only when there is no other activation
     * as we may not receive another leave event in case of grabs */
    if (this._activation.counter.count === 1) {
      const related = event.get_related();
      if (related && actor.contains(related)) {
        return;
      }
    }

    this._activation.active = false;
  }
}

/**
 * NOTE: Barrier activation activate the HOVER flag.
 * 
 * NOTE: During startup animation methods get_transformed_xxx would return
 * wrong results, so the update barrier method needs to wait the startup to
 * complete. This is actually required only when the edge setting is 'auto',
 * but there should not be any issue doing this in any case.
 * An alternative solution would be to use the allocation box, as the panel
 * is in relative coordinates in respect to the stage in any case.
 */
class BarrierActivation {

  /**
   * @param {TransformedAllocation} talloc 
   * @param {Gio.Settings} gsettings 
   * @param {Activation} activation 
   */
  constructor(talloc, gsettings, activation) {
    this._talloc = talloc;
    this._gsettings = gsettings;
    this._activation = activation;

    this._barrier = null;
    this._pressureBarrier = new PressureBarrier();
    this._pressureBarrier.onHit = this._activate.bind(this);

    const updateBarrier = this._updateBarrier.bind(this);

    this._wires = [
      wire(Main.layoutManager, 'startup-complete', updateBarrier),
      wire(Main.layoutManager, 'hot-corners-changed', updateBarrier),

      wire(talloc, 'allocation-changed', updateBarrier),
      wire(talloc.actor, 'notify::visible', updateBarrier),
      wire(gsettings, 'changed::barrier-edge', updateBarrier),

      wire(
        gsettings,
        'changed::barrier-slide-prevention',
        this._updateSlidePrevention.bind(this)
      ),
      wire(
        gsettings,
        'changed::barrier-pressure-threshold',
        this._updateThreshold.bind(this)
      ),
      wire(
        gsettings,
        'changed::barrier-pressure-timeout',
        this._updateTimeout.bind(this)
      )
    ];
  }

  enable() {
    this._wires.forEach(e => e.connect());

    if (isStartupCompleted()) {
      this._updateBarrier();
    }

    this._updateSlidePrevention();
    this._updateThreshold();
    this._updateTimeout();
  }

  disable() {
    this._wires.forEach(e => e.disconnect());

    this._destroyBarrier();
  }

  _activate() {
    this._activation.active = true;
  }

  _updateBarrier() {
    const props = this._barrierProps();

    if (this._checkBarrierProps(props))
      return;

    this._destroyBarrier();

    if (!props)
      return;

    _log && _log(`Creating new barrier with props: ${JSON.stringify(props)}`);

    this._barrier = new Meta.Barrier({
      backend: global.backend,
      ...props
    });
    this._pressureBarrier.setBarrier(this._barrier);
  }

  _updateSlidePrevention() {
    this._pressureBarrier.slidePrevention = this._gsettings.get_enum(
      'barrier-slide-prevention'
    );
  }

  _updateThreshold() {
    this._pressureBarrier.threshold = this._gsettings.get_int(
      'barrier-pressure-threshold'
    );
  }

  _updateTimeout() {
    this._pressureBarrier.timeout = this._gsettings.get_int(
      'barrier-pressure-timeout'
    );
  }

  _destroyBarrier() {
    if (this._barrier) {
      this._pressureBarrier.setBarrier(null);
      this._barrier.destroy();
      this._barrier = null;
    }
  }

  _barrierProps() {
    let edge = this._gsettings.get_enum('barrier-edge');
    if (edge === Edge.NONE)
      return;

    const actor = this._talloc.actor;
    if (!actor.visible)
      return;

    /* use same monitor of actor */
    const monitor = Main.layoutManager.findMonitorForActor(actor);
    if (!monitor)
      return;

    const x1 = monitor.x;
    const y1 = monitor.y;
    const x2 = x1 + monitor.width;
    const y2 = y1 + monitor.height;

    if (edge === Edge.AUTO) {
      /* calculate relative position of actor with respect to monitor */
      const [x, y] = actor.get_transformed_position();
      const [w, h] = actor.get_transformed_size();
      edge = relativeEdge({ x1, y1, x2, y2 }, {
        x1: x,
        y1: y,
        x2: x + w,
        y2: y + h
      });
    }

    /* leave space for the hot corners as when barriers overlap only the
     * topmost will receive events (at least with X) */
    const [leftHotCorner, rightHotCorner] = this._hotCorners();

    switch (edge) {
      case Edge.TOP:
        return {
          directions: Meta.BarrierDirection.POSITIVE_Y,
          x1: x1 + leftHotCorner,
          y1,
          x2: x2 - rightHotCorner,
          y2: y1
        };
      case Edge.RIGHT:
        return {
          directions: Meta.BarrierDirection.NEGATIVE_X,
          x1: x2,
          y1: y1 + rightHotCorner,
          x2,
          y2
        };
      case Edge.BOTTOM:
        return {
          directions: Meta.BarrierDirection.NEGATIVE_Y,
          x1,
          y1: y2,
          x2,
          y2
        };
      case Edge.LEFT:
        return {
          directions: Meta.BarrierDirection.POSITIVE_X,
          x1,
          y1: y1 + leftHotCorner,
          x2: x1,
          y2
        };
    }
  }

  _checkBarrierProps(props) {
    const barrier = this._barrier;
    if (barrier && props) {
      return barrier.directions === props.directions &&
        barrier.x1 === props.x1 &&
        barrier.y1 === props.y1 &&
        barrier.x2 === props.x2 &&
        barrier.y2 === props.y2;
    }
    return !barrier && !props;
  }

  _hotCorners() {
    /** @type {any[]} */
    const hotCorners = Main.layoutManager.hotCorners;
    if (!hotCorners || !hotCorners.find(e => e)) {
      return [0, 0];
    }
    /* use same logic of hot corner class to determine size and placement,
     * not querying directly the hot corner as the API is not public */
    const hotCornerSize = this._talloc.actor.height;
    if (Clutter.get_default_text_direction() === Clutter.TextDirection.RTL) {
      return [0, hotCornerSize];
    }
    return [hotCornerSize, 0];
  }
}

const SlidePrevention = {
  NONE: 0,
  SOFT: 1,
  MEDIUM: 2,
  HARD: 3
};

class PressureBarrier {
  constructor(threshold = 100, timeout = 100) {
    this.slidePrevention = SlidePrevention.MEDIUM;
    this.threshold = threshold;
    this.timeout = timeout;

    this._horizontal = false;

    this._expire = 0;
    this._pressure = 0;
    this._hit = false;

    this._wires = [
      wire(null, 'hit', this._onBarrierHit.bind(this)),
      wire(null, 'left', this._onBarrierLeft.bind(this))
    ];
  }

  setBarrier(barrier) {
    this._wires.forEach(e => e.disconnect());

    this._wires.forEach(e => e.setTarget(barrier));
    this._horizontal = barrier && barrier.y1 === barrier.y2;
    this._reset();

    this._wires.forEach(e => e.connect());
  }

  onHit() { }

  _onBarrierHit(_barrier, event) {
    if (this._hit)
      return;

    if (event.time >= this._expire) {
      this._expire = event.time + this.timeout;
      this._pressure = 0;
    }
    this._pressure += this._eventPressure(event);
    if (this._pressure >= this.threshold) {
      _log && _log(`Barrier trigger, pressure: ${this._pressure}, time: ${(
        event.time + this.timeout - this._expire
      )}`);
      this._hit = true;
      this.onHit();
    }
    /* maybe I should release the pointer when there is no timeout
     * so I can support having a monitor after the barrier?
     * Need to check with more monitors */
    // else if (this.timeout <= 0) {
    //   this._barrier.release(event);
    // }
  }

  _onBarrierLeft(_barrier, _event) {
    this._reset();
  }

  _eventPressure(event) {
    const across = this._distanceAcross(event);
    const along = this._distanceAlong(event);
    let pressure = across;
    switch (this.slidePrevention) {
      case SlidePrevention.SOFT:
        pressure = across - along;
        break;
      case SlidePrevention.MEDIUM:
        pressure = across - along * Math.PI / 2;
        break;
      case SlidePrevention.HARD:
        pressure = along > 1 ? across / along : across;
        break;
    }
    _log && _log(`Pressure: ${this._pressure}, ` +
      `across: ${across}, along: ${along}, delta: ${pressure}`);
    return pressure;
  }

  _distanceAcross(event) {
    return Math.abs(this._horizontal ? event.dy : event.dx);
  }

  _distanceAlong(event) {
    return Math.abs(this._horizontal ? event.dx : event.dy);
  }

  _reset() {
    this._expire = 0;
    this._pressure = 0;
    this._hit = false;
  }
}

class OverviewActivation {

  /**
   * @param {any} overview - the overview (Main.overview)
   * @param {ActivationCounter} acounter 
   */
  constructor(overview, acounter) {
    this._activation = acounter.newActivation('Overview');
    this._wires = [
      wire(overview, 'showing', this._onShowing.bind(this)),
      wire(overview, 'hiding', this._onHiding.bind(this))
    ];
  }

  enable() {
    this._wires.forEach(e => e.connect());
  }

  disable() {
    this._wires.forEach(e => e.disconnect());
  }

  _onShowing() {
    this._activation.active = true;
  }

  _onHiding() {
    this._activation.active = false;
  }
}

class StatusAreaActivations {

  /**
   * @param {Clutter.Actor} actor - the panel (Main.panel)
   * @param {ActivationCounter} acounter 
   */
  constructor(actor, acounter) {
    this._actor = actor;
    this._acounter = acounter;

    /** @type {{ [key: string]: PanelMenuActivation }} */
    this._activations = {};

    this._wires = [];
    // I whish there was a better way
    const updateStatusArea = this._updateStatusArea.bind(this);
    for (const child of actor.get_children()) {
      this._wires.push(wire(child, CHILD_ADDED, updateStatusArea));
      this._wires.push(wire(child, CHILD_REMOVED, updateStatusArea));
    }
  }

  enable() {
    this._wires.forEach(e => e.connect());
    this._updateStatusArea();
  }

  disable() {
    this._wires.forEach(e => e.disconnect());
    Object.keys(this._activations).forEach(key =>
      this._deleteActivation(key)
    );
  }

  _updateStatusArea() {
    const statusArea = this._actor.statusArea;
    _log && _log(`Update status area: ${Object.keys(statusArea)}`);
    for (const key in statusArea) {
      const actor = statusArea[key];
      this._setActivation(key, actor);
    }
    Object.keys(this._activations).forEach(key =>
      key in statusArea || this._deleteActivation(key)
    );
  }

  /**
   * @param {string} key 
   * @param {any} actor 
   */
  _setActivation(key, actor) {
    let activation = this._activations[key];
    if (!activation) {
      _log && _log(`Create new activation for key: ${key}`);
      activation = new PanelMenuActivation(this._acounter, key);
      activation.onDestroy = () => {
        _log && _log(`Destroyed activation for key: ${key}`);
        delete this._activations[key];
      };
      this._activations[key] = activation;
    }
    activation.setActor(actor);
  }

  /**
   * @param {string} key 
   */
  _deleteActivation(key) {
    _log && _log(`Delete activation for key: ${key}`);
    const activation = this._activations[key];
    if (activation) {
      activation.setActor(null);
    }
    delete this._activations[key];
  }
}

class PanelMenuActivation {

  /**
   * @param {ActivationCounter} acounter 
   * @param {string} key 
   */
  constructor(acounter, key) {
    this._activation = acounter.newActivation(`Keyfocus: ${key}`);
    this._menuActivation = new PopupMenuActivation(acounter, key);
    this._actor = null;
    this._wires = [
      wire(null, 'key-focus-in', this._onKeyFocusIn.bind(this)),
      wire(null, 'key-focus-out', this._onKeyFocusOut.bind(this)),
      wire(null, 'menu-set', this._onMenuSet.bind(this)),
      wire(null, 'destroy', this._onDestroy.bind(this))
    ];
  }

  setActor(actor) {
    if (this._actor === actor)
      return;

    this._actor = actor;
    this._wires.forEach(e => e.setTarget(actor).connect());
    this._menuActivation.setMenu(actor ? actor.menu : null);
    this._activation.active = actor && actor.has_key_focus();
  }

  onDestroy() { }

  _onKeyFocusIn() {
    this._activation.active = true;
  }

  _onKeyFocusOut() {
    this._activation.active = false;
  }

  _onMenuSet(actor) {
    this._menuActivation.setMenu(actor.menu);
  }

  _onDestroy() {
    this.setActor(null);
    this.onDestroy();
  }
}

class PopupMenuActivation {

  /**
   * @param {ActivationCounter} acounter 
   * @param {string} key 
   */
  constructor(acounter, key) {
    this._activation = acounter.newActivation(`Menuopen: ${key}`);
    this._wires = [
      wire(null, 'open-state-changed', this._onOpenChanged.bind(this)),
      wire(null, 'destroy', this._onDestroy.bind(this))
    ];
  }

  setMenu(menu) {
    this._wires.forEach(e => e.setTarget(menu).connect());
    this._activation.active = menu && menu.isOpen;
  }

  _onOpenChanged(menu) {
    this._activation.active = menu.isOpen;
  }

  _onDestroy() {
    this.setMenu(null);
  }
}

class ActiveMenuRelayout {

  /**
   * @param {TransformedAllocation} talloc 
   */
  constructor(talloc) {
    this._wire = wire(
      talloc,
      'transformed-changed',
      this._relayout.bind(this)
    );
  }

  enable() {
    this._wire.connect();
  }

  disable() {
    this._wire.disconnect();
  }

  _relayout() {
    const menu = Main.panel.menuManager.activeMenu;
    if (menu && menu.isOpen && menu.actor) {
      menu.actor.queue_relayout();
    }
  }
}

class ActorConstraint {

  /**
   * @param {Clutter.Actor} actor 
   * @param {Clutter.Constraint} constraint
   */
  constructor(actor, constraint) {
    this._actor = actor;
    this._constraint = constraint;
  }

  enable() {
    if (this._enabled())
      return;

    this._actor.add_constraint(this._constraint);
  }

  disable() {
    if (!this._enabled())
      return;

    this._actor.remove_constraint(this._constraint);
  }

  _enabled() {
    return this._actor.get_constraints().includes(this._constraint);
  }
}

class KeyFocusTracker {

  /**
   * @param {Clutter.Actor} actor 
   * @param {ActivationCounter} acounter 
   */
  constructor(actor, acounter) {
    this._actor = actor;
    this._activation = acounter.newActivation('KeyFocusTracker');

    this._keyFocus = null;
    this._modal = false;

    this._wire = wire(
      global.stage,
      'notify::key-focus',
      this._onKeyFocusNotify.bind(this)
    );
  }

  enable() {
    this._wire.connect();
  }

  disable() {
    this._wire.disconnect();
    this._activation.active = false;
    this._keyFocus = null;
    this._modal = false;
  }

  /**
   * Need this as notify is emitted also when element is the same.
   */
  _onKeyFocusNotify() {
    const keyFocus = global.stage.key_focus;
    if (this._keyFocus !== keyFocus) {
      this._keyFocus = keyFocus;
      this._onKeyFocusChanged();
    }
  }

  _onKeyFocusChanged() {
    if (this._withinModal())
      return;

    const keyFocus = this._keyFocus;
    _log && _log(`Key focus changed: ${keyFocus}`);
    this._activation.active = keyFocus && this._actor.contains(keyFocus);
  }

  _withinModal() {
    const modal = !!(this._keyFocus && Main.modalCount);
    if (this._modal !== modal) {
      this._modal = modal;
      return false;
    }
    return modal;
  }
}

class WindowOverlapsActivation {

  /**
   * @param {TransformedAllocation} talloc 
   * @param {ActivationCounter} acounter 
   */
  constructor(talloc, acounter) {
    this._talloc = talloc;
    this._activation = acounter.newActivation('WindowOverlaps');

    this._windowOverlaps = new WindowOverlaps();
    this._windowOverlaps.onHasOverlapsChanged = this._toggle.bind(this);

    this._wire = wire(
      talloc,
      'allocation-changed',
      this._updateBox.bind(this)
    );
  }

  enable() {
    this._wire.connect();
    this._windowOverlaps.enable();
    if (this._talloc.actor.has_allocation()) {
      this._updateBox();
    }
    this._toggle();
  }

  disable() {
    this._wire.disconnect();
    this._windowOverlaps.disable();
    this._activation.active = false;
  }

  _toggle() {
    this._activation.active = !this._windowOverlaps.hasOverlaps;
  }

  _updateBox() {
    const box = this._talloc.actor.get_allocation_box();
    _log && _log(`Set window overlaps box: ${boxToString(box)}`);
    this._windowOverlaps.setBox(box);
  }
}
