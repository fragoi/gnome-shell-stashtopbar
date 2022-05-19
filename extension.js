'use strict';

const { Clutter, GObject, Meta, Shell } = imports.gi;
const Signals = imports.signals;
const Main = imports.ui.main;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

/**
 * @type {import('./animations')}
 */
const Animations = Me.imports.animations;

/**
 * @type {import('./utils')}
 */
const { idleAdd, idleRemove, wire } = Me.imports.utils;

/**
 * @type {import('./wm')}
 */
const { WindowOverlaps } = Me.imports.wm;

const NAME = 'Stash Top Bar';
const GSETTINGS_ID = 'org.gnome.shell.extensions.com-github-fragoi-stashtopbar';

const ActivationFlags = {
  HOVER: 1 << 0,
  OVERVIEW: 1 << 1,
  KEYFOCUS: 1 << 2,
  MENUOPEN: 1 << 3,
  KEYFOCUS_TRACKER: 1 << 4,
  WINDOW_OVERLAPS: 1 << 5
};

const Edge = {
  NONE: 0,
  AUTO: -1,
  TOP: 1,
  RIGHT: 2,
  BOTTOM: 4,
  LEFT: 8
};

/**
 * @typedef {{x1: number, y1: number, x2: number, y2: number}} box
 */

/**
 * @type {( msg: string )}
 */
var _log;

function init() {
  return new Extension();
}

/**
 * @param {number} flags
 */
function _activationFlagsToString(flags) {
  let string = '';
  for (const name in ActivationFlags) {
    if (flags & ActivationFlags[name]) {
      string && (string += ', ');
      string += name;
    }
  }
  return string;
}

/**
 * @param {box}
 */
function _boxToString({ x1, y1, x2, y2 }) {
  return `[${x1},${y1},${x2},${y2}]`;
}

/**
 * @param {box} boxA - the respect to box
 * @param {box} boxB - the relative to box
 * @param factor - the relative factor
 */
function _relativeEdge(boxA, boxB, factor = 0.3) {
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

function _isStartupCompleted() {
  return Main.actionMode !== Shell.ActionMode.NONE;
}

class Extension {
  enable() {
    this._gsettings = ExtensionUtils.getSettings(GSETTINGS_ID);

    //    this._actor = new Clutter.Actor({ reactive: true });
    this._actor = Main.layoutManager.panelBox;

    this._talloc = new TransformedAllocation(this._actor);

    //    this._animation = new OffcanvasAnimation(this._talloc);
    this._animation = new Animations.Wrapper(this._gsettings, this._talloc);

    this._unredirect = new Unredirect();

    this._activation = new IdleActivation(true);

    this._activator = new Activator();

    const trigger = () => this._activation.setActive(this._activator.active);

    this._activator.onActiveChanged = trigger;

    this._activator.onFlagsChanged = () => {
      _log && _log(`Activator flags changed: [${(
        _activationFlagsToString(this._activator.flags)
      )}]`);
    };

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
      this._components.push(new UIChangeForPanelBox(this._actor));
    }

    this._components.push(new EnsureReactive(this._actor));
    this._components.push(new InputRegionTrigger(this._talloc));

    this._components.push(this._talloc);
    this._components.push(this._animation);
    this._components.push(this._activation);

    this._components.push(new HoverActivation(this._actor, this._activator));
    this._components.push(new BarrierActivation(
      this._talloc,
      this._gsettings,
      this._activator
    ));
    this._components.push(new OverviewActivation(Main.overview, this._activator));
    this._components.push(new StatusAreaActivations(Main.panel, this._activator));
    //    this._components.push(new KeyFocusTracker(this._actor, this._activator));
    this._components.push(new WindowOverlapsActivation(this._talloc, this._activator));
    this._components.push(new MessageTrayRelayout(this._talloc, Main.messageTray));
    this._components.push(new ActiveMenuRelayout(this._talloc));

    //    const panel = Main.panel;
    //    for (const p in panel.statusArea) {
    //      const actor = panel.statusArea[p];
    //      this._components.push(new KeyFocusActivation(actor, this._activator));
    //      if (actor.menu) {
    //        this._components.push(new MenuActivation(actor.menu, this._activator));
    ////        this._components.push(new MenuRelayout(this._talloc, actor.menu));
    //      }
    //    }

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
  constructor(actor) {
    this._actor = actor;
  }

  enable() {
    const panel = Main.panel;
    const panelBox = Main.layoutManager.panelBox;

    if (this._actor.contains(panel)) {
      return;
    }

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

    if (panelBox.contains(panel)) {
      return;
    }

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
  constructor(actor) {
    this._actor = actor;
    this._wasReactive = null;
  }

  enable() {
    if (this._wasReactive !== null) {
      return;
    }

    this._wasReactive = this._actor.get_reactive();

    if (!this._wasReactive) {
      this._actor.set_reactive(true);
    }
  }

  disable() {
    if (this._wasReactive === null) {
      return;
    }

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
    if (this._actor) {
      return;
    }
    this._actor = new Clutter.Actor();

    Main.layoutManager.addChrome(this._actor);
    Main.layoutManager.uiGroup.set_child_below_sibling(
      this._actor,
      this._talloc.actor
    );

    this._wire.connect();
  }

  disable() {
    if (!this._actor) {
      return;
    }
    this._wire.disconnect();
    this._actor.destroy();
    this._actor = null;
  }

  _onVisibleChanged() {
    this._actor.visible = this._talloc.visible;
  }
}

class OffcanvasAnimation {
  constructor(talloc) {
    const actor = talloc.actor;

    this._actor = actor;
    this._talloc = talloc;

    this._active = true;
    this._animating = false;

    this._wires = [
      wire(actor, 'transitions-completed', this._onCompleted.bind(this)),
      wire(actor, 'notify::translation-y', this._onTransition.bind(this))
    ];
  }

  enable() {
    this._wires.forEach(e => e.connect());
  }

  disable() {
    this._wires.forEach(e => e.disconnect());
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
    const actor = this._actor;

    if (!this._animating) {
      this._animating = true;
      //        this._value = actor.translation_y;
      this._value = this._translation_y = actor.translation_y;
      //        this._value = actor.y;
    }

    this._value += value;
    actor.save_easing_state();
    if (delay)
      actor.set_easing_delay(delay);
    //    actor.set_easing_duration(3000);
    actor.translation_y = this._value;
    //      actor.y = this._value;
    actor.restore_easing_state();

    /* TODO: (maybe) this should go away when implementing proper transition */
    if (!actor.is_mapped()) {
      this._onCompleted();
    }
  }

  _onCompleted() {
    if (!this._animating) {
      return;
    }

    this._animating = false;

    const actor = this._actor;
    const allocation = this._talloc.allocation;
    const translated_y = actor.translation_y - this._translation_y;

    /* instruct transformed allocation that this change is a transformation */
    allocation.y1 += translated_y;
    allocation.y2 += translated_y;

    /* change actor position and reset translation */
    actor.y += translated_y;
    actor.translation_y = this._translation_y;
  }

  _onTransition() {
    const translation_y = this._actor.translation_y;
    this._talloc.setTranslation({ y1: translation_y, y2: translation_y });
  }
}

class TransformedAllocation {
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
   * @param {box} translation - the translation of the original allocation
   */
  setTranslation(translation) {
    if (this._setValues(this._translation, translation)) {
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
    if (this._setValues(this.__allocated, allocation)) {
      if (this._setValues(this.__allocation, allocation)) {
        this._allocationChanged();
      } else {
        this._transformedChanged();
      }
    }
  }

  _ensureAllocation() {
    if (this.__allocated) {
      return;
    }
    const box = this._actor.get_allocation_box();
    /* we need a double check here because the above call may initialize
     * the allocation and trigger the connected signal, causing a double
     * initialization, not a big issue but better to avoid */
    if (this.__allocated) {
      return;
    }
    const allocated = { x1: 0, y1: 0, x2: 0, y2: 0 };
    this._setValues(allocated, box);
    this.__allocated = allocated;
    this.__allocation = { ...allocated };
    _log && _log(`Allocation initialized: ${_boxToString(allocated)}`);
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
    _log && _log(`Allocation changed: ${_boxToString(this.allocation)}`);
    this.emit('allocation-changed');
  }

  _transformedChanged() {
    _log && _log(`Transformed changed: ${_boxToString(this)}`);
    this.emit('transformed-changed');
  }

  _visibleChanged() {
    _log && _log(`Visible changed: ${this.visible}`);
    this.emit('visible-changed');
  }
}
Signals.addSignalMethods(TransformedAllocation.prototype);

class TriggerOnMapped {
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

  get flags() {
    return this._flags;
  }

  onFlagsChanged() { }

  _setFlags(flags) {
    const pre = this._flags;
    if (pre !== flags) {
      this._flags = flags;
      this.onFlagsChanged();
      if (!!pre !== !!flags) {
        this.onActiveChanged();
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
    if (this._idleId) {
      return;
    }
    _log && _log('Idle add');
    this._idleId = idleAdd(this._onIdle.bind(this));
  }

  _idleRemove() {
    if (!this._idleId) {
      return;
    }
    idleRemove(this._idleId);
    this._idleId = 0;
  }

  _onIdle() {
    this._idleId = 0;
    this._setActive(this._wanted);
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
    this._hoverTracker.preventSafeLeave = () => {
      return activator.flags !== ActivationFlags.HOVER;
    };
  }

  enable() {
    this._hoverTracker.enable();
  }

  disable() {
    this._hoverTracker.disable();
  }
}

class HoverTracker {
  constructor(actor) {
    this._hover = false;
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

  get hover() {
    return this._hover;
  }

  onHoverChanged() { }

  preventSafeLeave() {
    return false;
  }

  _setHover(value) {
    if (this._hover !== value) {
      this._hover = value;
      this.onHoverChanged();
    }
  }

  _onEnter() {
    _log && _log('Enter');
    this._setHover(true);
  }

  _onHover() {
    this._setHover(true);
  }

  _onLeave(actor, event) {
    _log && _log('Leave');

    /* check related actor only when there is no event grab
     * as we may then not receive another leave event */
    //    if (!(Main.actionMode & Shell.ActionMode.POPUP)) {
    if (!this.preventSafeLeave()) {
      const related = event.get_related();
      if (related && actor.contains(related)) {
        return;
      }
    }

    this._setHover(false);
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
  constructor(talloc, gsettings, activator) {
    this._talloc = talloc;
    this._gsettings = gsettings;
    this._activator = activator;

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

    if (_isStartupCompleted()) {
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
    if (!this._talloc.actor.visible) {
      return;
    }
    this._activator.activate(ActivationFlags.HOVER);
  }

  _updateBarrier() {
    const props = this._barrierProps();

    if (this._checkBarrierProps(props)) {
      return;
    }

    this._destroyBarrier();

    if (!props) {
      return;
    }

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
    if (edge === Edge.NONE) {
      return;
    }

    /* use same monitor of actor */
    const actor = this._talloc.actor;
    const monitor = Main.layoutManager.findMonitorForActor(actor);
    if (!monitor) {
      return;
    }

    const x1 = monitor.x;
    const y1 = monitor.y;
    const x2 = x1 + monitor.width;
    const y2 = y1 + monitor.height;

    if (edge === Edge.AUTO) {
      /* calculate relative position of actor with respect to monitor */
      const [x, y] = actor.get_transformed_position();
      const [w, h] = actor.get_transformed_size();
      edge = _relativeEdge({ x1, y1, x2, y2 }, {
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
      return barrier.directions === props.directions
        && barrier.x1 === props.x1
        && barrier.y1 === props.y1
        && barrier.x2 === props.x2
        && barrier.y2 === props.y2;
    }
    return !barrier && !props;
  }

  _hotCorners() {
    /** @type {Array} */
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
    if (this._hit) {
      return;
    }
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
    //    else if (this.timeout <= 0) {
    //      this._barrier.release(event);
    //    }
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
    _log && _log(`Pressure: ${this._pressure}, `
      + `across: ${across}, along: ${along}, delta: ${pressure}`);
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
  constructor(overview, activator) {
    this._activator = activator;
    this._wires = [
      wire(overview, 'showing', this._activate.bind(this)),
      wire(overview, 'hiding', this._deactivate.bind(this))
    ];
  }

  enable() {
    this._wires.forEach(e => e.connect());
  }

  disable() {
    this._wires.forEach(e => e.disconnect());
  }

  _activate() {
    this._activator.activate(ActivationFlags.OVERVIEW);
  }

  _deactivate() {
    this._activator.deactivate(ActivationFlags.OVERVIEW);
  }
}

class StatusAreaActivations {

  /**
   * @param {Clutter.Actor} actor - the panel
   * @param {Activator} activator
   */
  constructor(actor, activator) {
    this._actor = actor;
    this._activator = activator;

    /** @type {Object<string, PanelMenuActivation>} */
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
    for (const key in this._activations) {
      this._removeActivation(key);
    }
  }

  _updateStatusArea() {
    const statusArea = this._actor.statusArea;
    _log && _log(`Update status area: ${Object.keys(statusArea)}`);
    for (const key in statusArea) {
      const actor = statusArea[key];
      this._setActivation(key, actor);
    }
    for (const key in this._activations) {
      if (!(key in statusArea)) {
        this._removeActivation(key);
      }
    }
  }

  _setActivation(key, actor) {
    let activation = this._activations[key];
    if (activation && activation.actor !== actor) {
      _log && _log(`Disable activation for key: ${key}`);
      activation.disable();
      activation = null;
    }
    if (!activation && actor) {
      _log && _log(`Create new activation for key: ${key}`);
      activation = new PanelMenuActivation(actor, this._activator);
      activation.onDestroy = () => {
        _log && _log(`Delete activation for key: ${key}`);
        delete this._activations[key];
      };
      this._activations[key] = activation;
      activation.enable();
    }
    if (!actor) {
      _log && _log(`Delete activation for key: ${key}`);
      delete this._activations[key];
    }
  }

  _removeActivation(key) {
    _log && _log(`Remove activation for key: ${key}`);
    const activation = this._activations[key];
    if (activation) {
      activation.disable();
    }
    delete this._activations[key];
  }
}

class PanelMenuActivation {
  constructor(actor, activator) {
    this._actor = actor;
    this._activator = activator;

    this._menuActivator = new PopupMenuActivation(activator);

    this._wires = [
      wire(actor, 'key-focus-in', this._onKeyFocusIn.bind(this)),
      wire(actor, 'key-focus-out', this._onKeyFocusOut.bind(this)),
      wire(actor, 'menu-set', this._onMenuSet.bind(this)),
      wire(actor, 'destroy', this._onDestroy.bind(this))
    ];
  }

  get actor() {
    return this._actor;
  }

  enable() {
    this._wires.forEach(e => e.connect());
    this._menuActivator.setMenu(this._actor.menu);
  }

  disable() {
    this._wires.forEach(e => e.disconnect());
    this._menuActivator.setMenu(null);
  }

  onDestroy() { }

  _onKeyFocusIn() {
    this._activator.activate(ActivationFlags.KEYFOCUS);
  }

  _onKeyFocusOut() {
    this._activator.deactivate(ActivationFlags.KEYFOCUS);
  }

  _onMenuSet() {
    this._menuActivator.setMenu(this._actor.menu);
  }

  _onDestroy() {
    this._wires.forEach(e => e.setTarget(null));
    this._menuActivator.setMenu(null);
    this.onDestroy();
  }
}

class PopupMenuActivation {
  constructor(activator) {
    this._activator = activator;
    this._wires = [
      wire(null, 'open-state-changed', this._onOpenChanged.bind(this)),
      wire(null, 'destroy', this._onDestroy.bind(this))
    ];
  }

  setMenu(menu) {
    this._wires.forEach(e => e.setTarget(menu).connect());
  }

  _onOpenChanged(menu) {
    if (menu.isOpen) {
      this._activator.activate(ActivationFlags.MENUOPEN);
    } else {
      this._activator.deactivate(ActivationFlags.MENUOPEN);
    }
  }

  _onDestroy() {
    this.setMenu(null);
  }
}

class KeyFocusActivation {
  constructor(actor, activator) {
    this._activator = activator;
    this._wires = [
      wire(actor, 'key-focus-in', this._activate.bind(this)),
      wire(actor, 'key-focus-out', this._deactivate.bind(this))
    ];
  }

  enable() {
    this._wires.forEach(e => e.connect());
  }

  disable() {
    this._wires.forEach(e => e.disconnect());
  }

  _activate() {
    this._activator.activate(ActivationFlags.KEYFOCUS);
  }

  _deactivate() {
    this._activator.deactivate(ActivationFlags.KEYFOCUS);
  }
}

class MenuActivation {
  constructor(menu, activator) {
    this._activator = activator;
    this._wire = wire(
      menu,
      'open-state-changed',
      this._onOpenChanged.bind(this)
    );
  }

  enable() {
    this._wire.connect();
  }

  disable() {
    this._wire.disconnect();
  }

  _onOpenChanged(menu) {
    if (menu.isOpen) {
      this._activator.activate(ActivationFlags.MENUOPEN);
    } else {
      this._activator.deactivate(ActivationFlags.MENUOPEN);
    }
  }
}

class MenuRelayout {
  constructor(talloc, menu) {
    this._menu = menu;
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
    const menu = this._menu;
    if (menu.isOpen && menu.actor) {
      menu.actor.queue_relayout();
    }
  }
}

class ActiveMenuRelayout {
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
  constructor(talloc, messageTray) {
    this._messageTray = messageTray;
    this._constraint = new CanvasConstraint(talloc);
  }

  enable() {
    if (this._enabled()) {
      return;
    }
    this._messageTray.add_constraint(this._constraint);
  }

  disable() {
    if (!this._enabled()) {
      return;
    }
    this._messageTray.remove_constraint(this._constraint);
  }

  _enabled() {
    return this._messageTray.get_constraints().includes(this._constraint);
  }
}

const CanvasConstraint = GObject.registerClass(
  class CanvasConstraint extends Clutter.Constraint {
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

      const edge = _relativeEdge(allocation, this._talloc);
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

      _log && _log(`Constraint updated allocation: ${_boxToString(allocation)}`);
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

  setDisabled(value) {
    if (this._disabled === value) {
      return;
    }
    if (value) {
      Meta.disable_unredirect_for_display(global.display);
    } else {
      Meta.enable_unredirect_for_display(global.display);
    }
    this._disabled = value;
  }
}

class KeyFocusTracker {
  constructor(actor, activator) {
    this._actor = actor;
    this._activator = activator;

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
    this._keyFocus = null;
    this._modal = false;
  }

  _activate() {
    this._activator.activate(ActivationFlags.KEYFOCUS_TRACKER);
  }

  _deactivate() {
    this._activator.deactivate(ActivationFlags.KEYFOCUS_TRACKER);
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
    if (this._withinModal()) {
      return;
    }
    const keyFocus = this._keyFocus;
    _log && _log(`Key focus changed: ${keyFocus}`);
    if (keyFocus && this._actor.contains(keyFocus)) {
      this._activate();
    } else {
      this._deactivate();
    }
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
    this._activator = activator;

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
  }

  _toggle() {
    if (!this._windowOverlaps.hasOverlaps) {
      this._activator.activate(ActivationFlags.WINDOW_OVERLAPS);
    } else {
      this._activator.deactivate(ActivationFlags.WINDOW_OVERLAPS);
    }
  }

  _updateAllocation() {
    const actor = this._talloc.actor;
    const box = actor.get_allocation_box();
    _log && _log(`Set window overlaps box: ${_boxToString(box)}`);
    this._windowOverlaps.setBox(box);
  }
}
