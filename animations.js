/**
 * @type {( msg: string )}
 */
var _log;

var Offcanvas = class {

  /**
   * @todo define talloc type
   * @param {{ talloc: any }}
   */
  constructor({ talloc }) {
    const actor = talloc.actor;

    this._actor = actor;
    this._talloc = talloc;

    this._active = true;
    this._animating = false;
  }

  enable() { }

  disable() { }

  /**
   * @param {boolean} value - the active state
   */
  setActive(value) {
    if (this._active === value) {
      return;
    }
    this._active = value;
    if (value) {
      this._activate();
    } else {
      this._deactivate();
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
    const isNew = !this._animating;

    if (!this._animating) {
      this._animating = true;
      this._value = this._translation_y = actor.translation_y;
    }

    this._value += value;
    actor.save_easing_state();
    if (delay)
      actor.set_easing_delay(delay);
    //    actor.set_easing_duration(3000);
    actor.translation_y = this._value;
    actor.restore_easing_state();

    if (!isNew) {
      return;
    }

    const transition = actor.get_transition('translation-y');

    if (transition) {
      transition.connect('stopped', this._onCompleted.bind(this));
      transition.connect_after('new-frame', this._onTransition.bind(this));
    } else {
      this._onCompleted();
    }

    //    /* TODO: (maybe) this should go away when implementing proper transition */
    //    if (!actor.is_mapped()) {
    //      this._onCompleted();
    //    }
  }

  _onCompleted() {
    if (!this._animating) {
      return;
    }

    this._animating = false;

    const actor = this._actor;
    const allocation = this._talloc.allocation;
    const translation_y = this._translation_y;
    const translated_y = actor.translation_y - translation_y;

    /* instruct transformed allocation that this change is a transformation */
    allocation.y1 += translated_y;
    allocation.y2 += translated_y;

    /* change actor position and reset translation */
    actor.y += translated_y;
    actor.translation_y = translation_y;
    this._talloc.setTranslation({ y1: translation_y, y2: translation_y });
  }

  _onTransition() {
    const translation_y = this._actor.translation_y;
    this._talloc.setTranslation({ y1: translation_y, y2: translation_y });
  }
}
