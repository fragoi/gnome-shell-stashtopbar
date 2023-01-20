'use strict';

const { Clutter, GObject, Meta, Shell } = imports.gi;
const Signals = imports.signals;
const Main = imports.ui.main;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const Animations = Me.imports.animations;
const { idleAdd, idleRemove, setProperties, wire } = Me.imports.utils;
const { WindowOverlaps } = Me.imports.wm;

const NAME = 'Stash Top Bar';
const GSETTINGS_ID = 'org.gnome.shell.extensions.com-github-fragoi-stashtopbar';

const Edge = {
  NONE: 0,
  AUTO: -1,
  TOP: 1,
  RIGHT: 2,
  BOTTOM: 4,
  LEFT: 8
};

/**
 * @typedef {{ x1: number, y1: number, x2: number, y2: number }} Box
 */

/**
 * @type {(msg: string) => void}
 */
var _log;

function init() {
  return new Extension();
}

/**
 * @param {Box} box
 */
function boxToString({ x1, y1, x2, y2 }) {
  return `[${x1},${y1},${x2},${y2}]`;
}

/**
 * @param {Box} boxA - the respect to box
 * @param {Box} boxB - the relative to box
 * @param factor - the relative factor
 */
function relativeEdge(boxA, boxB, factor = 0.3) {
  const { x1: x, y1: y } = boxA;
  const w = (boxA.x2 - x) || 1;
  const h = (boxA.y2 - y) || 1;

  /* relative points */
  const rx1 = (boxB.x1 - x) / w;
  const ry1 = (boxB.y1 - y) / h;
  const rx2 = (boxB.x2 - x) / w;
  const ry2 = (boxB.y2 - y) / h;

  let edge = Edge.NONE;

  if (ry2 < factor)
    edge |= Edge.TOP;
  else if (ry1 > 1 - factor)
    edge |= Edge.BOTTOM;

  if (rx2 < factor)
    edge |= Edge.LEFT;
  else if (rx1 > 1 - factor)
    edge |= Edge.RIGHT;

  return edge;
}

function isStartupCompleted() {
  return Main.actionMode !== Shell.ActionMode.NONE;
}

class Extension {
  enable() {
    this._gsettings = ExtensionUtils.getSettings(GSETTINGS_ID);

    //    this._actor = new Clutter.Actor({ reactive: true });
    this._actor = Main.layoutManager.panelBox;

    this._talloc = new TransformedAllocation(this._actor);

    this._animation = new Animations.Wrapper(this._gsettings, this._talloc);

    this._unredirect = new Unredirect();

    this._activation = new IdleActivation(true);

    this._activator = new Activator();

    const trigger = () => this._activation.setActive(this._activator.active);

    this._activator.onActiveChanged = trigger;

    this._activation.onActiveChanged = () => {
      if (this._activation.active)
        this._unredirect.setDisabled(true);
      this._animation.setActive(this._activation.active);
    };

    this._animation.onCompleted = () => {
      if (!this._activation.active)
        this._unredirect.setDisabled(false);
    };

    this._components = [];

    if (this._actor !== Main.layoutManager.panelBox) {
      this._components.push(new UIChangeForActor(this._actor));
    } else {
      this._components.push(new UIChangeForPanelBox());
    }

    this._components.push(new EnsureReactive(this._actor));
    this._components.push(new InputRegionTrigger(this._talloc));

    this._components.push(this._talloc);
    this._components.push(this._animation);
    this._components.push(this._activation);

    const hover = this._activator.newActivation('Hover');
    this._components.push(new HoverActivation(this._actor, hover));
    this._components.push(new BarrierActivation(this._talloc, this._gsettings, hover));
    this._components.push(new OverviewActivation(Main.overview, this._activator));
    this._components.push(new StatusAreaActivations(Main.panel, this._activator));
    // this._components.push(new KeyFocusTracker(this._actor, this._activator));
    this._components.push(new WindowOverlapsActivation(this._talloc, this._activator));

    this._components.push(new MessageTrayRelayout(this._talloc, Main.messageTray));
    this._components.push(new ActiveMenuRelayout(this._talloc));

    this._components.push(new TriggerOnMapped(this._actor, trigger));

    /* up to here no changes have been made to any actor and no signals
     * have been connected (otherwise, it is a bug).
     * Now start applying changes... */

    this._components.forEach(e => e.enable());

    Main.stashTopBar = this;
    log(`${NAME} enabled`);
  }

  disable() {
    this._components.reverse().forEach(e => e.disable());
    this._components = null;

    this._activator = null;

    this._unredirect.setDisabled(false);
    this._unredirect = null;

    this._animation = null;
    this._talloc = null;

    if (this._actor !== Main.layoutManager.panelBox) {
      this._actor.destroy();
    }
    this._actor = null;

    this._gsettings = null;

    delete Main.stashTopBar;
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

class TransformedAllocation {

  /**
   * @param {Clutter.Actor} actor 
   */
  constructor(actor) {
    this._actor = actor;
    this._translation = { x1: 0, y1: 0, x2: 0, y2: 0 };
    this._visible = true;
    /* lazily initialized */
    this.__allocated = null;
    this.__allocation = null;

    this._wire = wire(actor, 'notify::allocation', () => {
      this._updateAllocation();
    });

    /* updating the allocation when the actor has no allocation will cause
     * the allocation to be initialized, not doing it for now */
    if (actor.has_allocation()) {
      this._updateAllocation();
    }
  }

  enable() {
    this._wire.connect();

    if (this._actor.has_allocation()) {
      this._updateAllocation();
    }
  }

  disable() {
    this._wire.disconnect();
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

  /**
   * @param {Partial<Box>} translation - the translation of the original allocation
   */
  setTranslation(translation) {
    if (setProperties(this._translation, translation)) {
      this._transformedChanged();
    }
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

  get _allocated() {
    this._ensureAllocation();
    return this.__allocated;
  }

  get _allocation() {
    this._ensureAllocation();
    return this.__allocation;
  }

  _updateAllocation() {
    this._ensureAllocation();
    const allocation = this._actor.get_allocation_box();
    if (setProperties(this.__allocated, allocation)) {
      if (setProperties(this.__allocation, allocation)) {
        this._allocationChanged();
      } else {
        this._transformedChanged();
      }
    }
  }

  _ensureAllocation() {
    if (this.__allocated)
      return;

    const box = this._actor.get_allocation_box();
    /* we need a double check here because the above call may initialize
     * the allocation and trigger the connected signal, causing a double
     * initialization, not a big issue but better to avoid */
    if (this.__allocated)
      return;

    const allocated = { x1: 0, y1: 0, x2: 0, y2: 0 };
    setProperties(allocated, box);
    this.__allocated = allocated;
    this.__allocation = { ...allocated };
    _log && _log(`Allocation initialized: ${boxToString(allocated)}`);
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

class Activator {
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

class Activation {

  /**
   * @param {Activator} counter 
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
    if (!this._talloc.actor.visible)
      return;

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
      display: global.display,
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

    /* use same monitor of actor */
    const actor = this._talloc.actor;
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
   * @param {Activator} activator 
   */
  constructor(overview, activator) {
    this._activation = activator.newActivation('Overview');
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
   * @param {Activator} activator 
   */
  constructor(actor, activator) {
    this._actor = actor;
    this._activator = activator;

    /** @type {{ [key: string]: PanelMenuActivation }} */
    this._activations = {};

    this._wires = [];
    // I whish there was a better way
    const updateStatusArea = this._updateStatusArea.bind(this);
    for (const child of actor.get_children()) {
      this._wires.push(wire(child, 'actor-added', updateStatusArea));
      this._wires.push(wire(child, 'actor-removed', updateStatusArea));
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
      activation = new PanelMenuActivation(this._activator, key);
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
   * @param {Activator} activator 
   * @param {string} key 
   */
  constructor(activator, key) {
    this._activation = activator.newActivation(`Keyfocus: ${key}`);
    this._menuActivation = new PopupMenuActivation(activator, key);
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
   * @param {Activator} activator 
   * @param {string} key 
   */
  constructor(activator, key) {
    this._activation = activator.newActivation(`Menuopen: ${key}`);
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

class MessageTrayRelayout {

  /**
   * @param {TransformedAllocation} talloc 
   * @param {Clutter.Actor} messageTray 
   */
  constructor(talloc, messageTray) {
    this._messageTray = messageTray;
    this._constraint = new CanvasConstraint(talloc);
  }

  enable() {
    if (this._enabled())
      return;

    this._messageTray.add_constraint(this._constraint);
  }

  disable() {
    if (!this._enabled())
      return;

    this._messageTray.remove_constraint(this._constraint);
  }

  _enabled() {
    return this._messageTray.get_constraints().includes(this._constraint);
  }
}

const CanvasConstraint = GObject.registerClass(
  class CanvasConstraint extends (Clutter.Constraint) {

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

      const edge = relativeEdge(allocation, this._talloc);
      switch (edge) {
        case Edge.TOP:
          allocation.y1 = Math.max(allocation.y1, Math.ceil(this._talloc.y2));
          break;
        case Edge.BOTTOM:
          allocation.y2 = Math.min(allocation.y2, Math.floor(this._talloc.y1));
          break;
        case Edge.LEFT:
          allocation.x1 = Math.max(allocation.x1, Math.ceil(this._talloc.x2));
          break;
        case Edge.RIGHT:
          allocation.x2 = Math.min(allocation.x2, Math.floor(this._talloc.x1));
          break;
      }

      _log && _log(`Constraint updated allocation: ${boxToString(allocation)}`);
    }

    _queueRelayout() {
      const actor = this.get_actor();
      actor && actor.queue_relayout();
    }
  }
);

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
      Meta.disable_unredirect_for_display(global.display);
    } else {
      Meta.enable_unredirect_for_display(global.display);
    }

    this._disabled = value;
  }
}

class KeyFocusTracker {

  /**
   * @param {Clutter.Actor} actor 
   * @param {Activator} activator 
   */
  constructor(actor, activator) {
    this._actor = actor;
    this._activation = activator.newActivation('KeyFocusTracker');

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
   * @param {Activator} activator 
   */
  constructor(talloc, activator) {
    this._talloc = talloc;
    this._activation = activator.newActivation('WindowOverlaps');

    this._windowOverlaps = new WindowOverlaps();
    this._windowOverlaps.onHasOverlapsChanged = this._toggle.bind(this);

    this._wire = wire(
      talloc,
      'allocation-changed',
      this._updateAllocation.bind(this)
    );
  }

  enable() {
    this._wire.connect();
    this._windowOverlaps.enable();
    this._updateAllocation();
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

  _updateAllocation() {
    const actor = this._talloc.actor;
    const box = actor.get_allocation_box();
    _log && _log(`Set window overlaps box: ${boxToString(box)}`);
    this._windowOverlaps.setBox(box);
  }
}

var internal = {
  TransformedAllocation
};

if (typeof module === 'object') {
  module.exports = {
    __esModule: true,
    init,
    internal
  };
}
