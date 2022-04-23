'use strict';

const Main = imports.ui.main;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

/**
 * @type {import('./utils')}
 */
const { wire } = Me.imports.utils;

const AnimationType = {
  NONE: 0,
  OFFCANVAS: 1
};

/**
 * @type {( msg: string )}
 */
var _log;

/**
 * Wrapper class for configuring animation.
 */
var Wrapper = class {

  /**
   * @param {Gio.Settings} gsettings - the settings
   * @param {TransformedAllocation} talloc - the transformed allocation
   */
  constructor(gsettings, talloc) {
    this._gsettings = gsettings;
    this._talloc = talloc;

    this._active = true;
    this._animation = null;
    this._animationType = 0;

    this._wire = wire(
      gsettings,
      'changed::animation-type',
      this._updateAnimation.bind(this)
    );
  }

  enable() {
    this._wire.connect();
    this._updateAnimation();
  }

  disable() {
    this._wire.disconnect();
    this._animation && this._animation.disable();
  }

  /**
   * @param {boolean} value - the active state
   */
  setActive(value) {
    this._active = value;
    this._animation && this._animation.setActive(value);
  }

  onCompleted() { }

  _updateAnimation() {
    const type = this._gsettings.get_enum('animation-type');
    if (this._animation && this._animationType === type) {
      return;
    }
    if (this._animation) {
      this._animation.disable();
    }
    this._animation = this._newAnimation(type);
    this._animationType = type;
    if (!this._animation) {
      return;
    }
    this._animation.onCompleted = () => this.onCompleted();
    this._animation.enable();
    this._animation.setActive(this._active);
  }

  _newAnimation(type) {
    switch (type) {
      case AnimationType.OFFCANVAS:
        return new Offcanvas(this._talloc);
    }
    return new ShowHide(this._talloc.actor);
  }
}

/**
 * This should be the most easy one.
 * Used as placeholder for no animation.
 */
class ShowHide {
  constructor(actor) {
    this._actor = actor;
    //    this._wasVisible = null;
  }

  enable() {
    //    if (this._wasVisible === null) {
    //      this._wasVisible = this._actor.visible;
    //    }
  }

  disable() {
    //    if (this._wasVisible !== null) {
    //      this._actor.visible = this._wasVisible;
    //      this._wasVisible = null;
    //    }
    this._actor.set_clip_to_allocation(false);
    this._actor.set_height(-1);
  }

  setActive(value) {
    //    if (this._actor.visible !== value) {
    //      this._actor.visible = value;
    //      this.onCompleted();
    //    }
    this._actor.set_clip_to_allocation(!value);
    this._actor.set_height(value ? -1 : 0);
    this.onCompleted();
  }

  onCompleted() { }
}

class Offcanvas {

  /**
   * @param {TransformedAllocation} talloc
   */
  constructor(talloc) {
    const actor = talloc.actor;

    this._actor = actor;
    this._talloc = talloc;

    this._active = true;
    //    this._animating = false;
    this._wasFixedPositionSet = null;

    this._activeY = 0;
    this._inactiveY = 0;
    this._transitionY = null;

    this._pendingWire = wire(null, 'stopped', () => {
      this._pendingWire.setTarget(null);
      this._toggle();
    });

    this._wires = [
      wire(talloc, 'allocation-changed', () => {
        this._update();
        this._toggle();
      })
    ];
  }

  enable() {
    if (this._wasFixedPositionSet === null) {
      this._wasFixedPositionSet = this._actor.get_fixed_position_set();
    }
    this._wires.forEach(e => e.connect());
    this._update();
  }

  disable() {
    this._wires.forEach(e => e.disconnect());
    this._pendingWire.setTarget(null);

    /* remove transition */
    if (this._transitionY) {
      this._actor.remove_transition('translation-y');
    }
    /* reset active status and actor position */
    if (!this._active) {
      this._active = true;
      this._onCompleted();
    }
    /* reset actor status */
    if (this._wasFixedPositionSet === false) {
      this._actor.set_fixed_position_set(false);
    }
    this._wasFixedPositionSet = null;
  }

  setActive(value) {
    if (this._active !== value) {
      this._active = value;
      this._toggle();
    }
  }

  onCompleted() { }

  _toggle() {
    _log && _log(`Toggle, active: ${this._active}`);

    /* check if we are waiting for other transitions to complete */
    if (this._waitingForTransition()) {
      _log && _log('Waiting for transition to complete');
      return;
    }

    const shouldChangeY = this._shouldChangeY();

    if (!this._transitionY && shouldChangeY) {
      /* check if other transitions are changing the properties we use,
       * if this is the case, we wait for the transitions to complete */
      if (this._waitForTransition('translation-y')) {
        _log && _log('Waiting for translation-y to complete');
        return;
      }

      /* check we are in clean status */
      if (this._actor.translation_y !== 0) {
        _log && _log(`Translation Y not 0: ${this._actor.translation_y}`);
        return;
      }
    }

    /* check if we are actually going to do something */
    if (!shouldChangeY) {
      return;
    }

    /* finally we are going to do something useful */
    this._doTransition();

    /* if we created a new transition, connect the signals */
    if (!this._transitionY) {
      const transitionY = this._actor.get_transition('translation-y');
      /* when actor is not mapped, transition is not created */
      if (transitionY) {
        this._transitionY = transitionY;
        transitionY.connect('stopped', this._onCompleted.bind(this));
        transitionY.connect_after('new-frame', this._onTransition.bind(this));
      }
    }

    /* if we did not create a transition, jump to onComplete */
    if (!this._transitionY) {
      this._onCompleted();
    }

    //    /* (maybe) this should go away */
    //    if (!actor.is_mapped()) {
    //      this._onCompleted();
    //    }
  }

  _shouldChangeY() {
    return this._activeY !== this._inactiveY;
  }

  _waitingForTransition() {
    return this._pendingWire.isConnected();
  }

  _waitForTransition(name) {
    const transition = this._actor.get_transition(name);
    if (!transition) {
      return false;
    }
    this._pendingWire.setTarget(transition).connect();
    return true;
  }

  _doTransition() {
    const actor = this._actor;
    const delay = this._active ? 0 : 200;

    //    if (!this._animating) {
    //      this._animating = true;
    //    }

    actor.save_easing_state();
    try {

      if (delay)
        actor.set_easing_delay(delay);
      //      actor.set_easing_duration(10000);

      if (this._shouldChangeY()) {
        const targetY = this._active ? this._activeY : this._inactiveY;
        const translationY = targetY - actor.y;

        _log && _log(`Transition for Y to value: ${translationY}, `
          + `current: ${actor.translation_y}, delay: ${delay}`);

        actor.translation_y = translationY;
      }

    } finally {
      actor.restore_easing_state();
    }
  }

  _onCompleted(transition = null) {
    //    if (!this._animating) {
    //      return;
    //    }
    //
    //    this._animating = false;

    const actor = this._actor;
    const allocation = this._talloc.allocation;
    const translation = {};

    if (this._transitionY === transition) {
      this._transitionY = null;

      _log && _log('Reset Y translation');

      /* reset translation */
      actor.translation_y = 0;
      translation.y1 = 0;
      translation.y2 = 0;

      if (this._shouldChangeY()) {
        const y1 = this._active ? this._activeY : this._inactiveY;
        const y2 = allocation.y2 - allocation.y1 + y1;

        _log && _log(`Moving actor, y1: ${y1}, y2: ${y2}`);

        /* instruct transformed allocation that this change is a transformation */
        allocation.y1 = y1;
        allocation.y2 = y2;

        /* change actor position */
        actor.y = y1;
      }
    }

    /* Note for my future self: despite we change the position before the translation,
     * this signal will be emitted before as the position signal (allocation-changed)
     * is emitted only when the actor relayout will be executed (so after this) while
     * this signal will be emitted just now */
    this._talloc.setTranslation(translation);

    this.onCompleted();
  }

  _onTransition() {
    const translationY = this._actor.translation_y;
    this._talloc.setTranslation({ y1: translationY, y2: translationY });
  }

  _update() {
    let activeY = 0;
    let inactiveY = 0;

    const actor = this._actor;
    const monitor = Main.layoutManager.findMonitorForActor(actor);

    if (monitor) {
      const y = actor.y;
      const h = actor.height;
      const isLocalY = this._activeY !== this._inactiveY
        && (y === this._activeY || y === this._inactiveY);
      if (isLocalY || y === monitor.y || y + h === monitor.y) {
        activeY = monitor.y;
        inactiveY = activeY - h;
      }
    }

    _log && _log(`Update, active Y: ${activeY}, inactive Y: ${inactiveY}`);

    this._activeY = activeY;
    this._inactiveY = inactiveY;
  }
}
