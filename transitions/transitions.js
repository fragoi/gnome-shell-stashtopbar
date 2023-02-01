// @ts-nocheck

/**
 * @type {import('../utils')}
 */
const { wire } = imports.utils;

function test() {
  const actor = null;
  const tm = new TransitionTask(actor, 'x', 'y');
  if (tm.isRunning()) {
    doTransition();
  } else {
    tm.waitForExternals()
      .waitForInternals()
      .execute(doTransition)
      .on('completed', onCompleted)
      .on('new-frame', onNewFrame)
      .after('new-frame', afterNewFrame);
  }
}

function doTransition() { }

function onCompleted() { }

function onNewFrame() { }

function afterNewFrame() { }

const TransitionTaskState = {
  WAITING: 0,
  RUNNING: 1,
  SETTLED: 2
};

class TransitionTask {
  constructor(actor, ...names) {
    this._actor = actor;
    this._names = names;

    this._state = TransitionTaskState.WAITING;
    this._transitions = null;
    this._indexSymbol = Symbol('index');

    this._shouldWaitForExternals = false;
    this._shouldWaitForInternals = false;
    this._onCreateCallback = null;
    this._onModifyCallback = null;
    this._signals = [];

    this._pendingWire = wire(
      null,
      'stopped',
      this._onPendingStopped.bind(this)
    );
  }

  waitForExternals() {
    this._assertState(TransitionTaskState.WAITING);
    this._shouldWaitForExternals = true;
    this._checkPending();
    return this;
  }

  waitForInternals() {
    this._assertState(TransitionTaskState.WAITING);
    this._shouldWaitForInternals = true;
    this._checkPending();
    return this;
  }

  execute(callback) {
    this._assertState(TransitionTaskState.WAITING);

    callback();

    this._transitions = this._getRunningTransitions();

    if (this._transitions.length) {
      this._state = TransitionTaskState.RUNNING;
    } else {
      this._state = TransitionTaskState.SETTLED;
    }

    return this;
  }

  on(signal, callback) {
    // Can be RUNNING or SETTLED
    //    this._assertState(TransitionTaskState.RUNNING);

    //    const group = new GroupHandler(callback);
    //    const handler = group.handle.bind(group);
    //    for (const transition of this._transitions) {
    //      const handlerId = transition.connect(signal, handler);
    //      const stoppedId = transition.connect('stopped', () => {
    //        transition.disconnect(handlerId);
    //        transition.disconnect(stoppedId);
    //        group.remove(transition);
    //      });
    //    }

    const handler = new GroupHandler2(signal, callback);
    for (const transition of this._transitions) {
      handler.add(transition);
    }
  }

  after(signal, callback) {

    //    const group = new GroupHandler(callback);
    //    const handler = group.handle.bind(group);
    //    for (const transition of this._transitions) {
    //      const handlerId = transition.connect_after(signal, handler);
    //      const stoppedId = transition.connect_after('stopped', () => {
    //        transition.disconnect(handlerId);
    //        transition.disconnect(stoppedId);
    //        group.remove(transition);
    //      });
    //    }

    const handler = new GroupHandler2(signal, callback, true);
    for (const transition of this._transitions) {
      handler.add(transition);
    }
  }

  _assertState(state) {
    if (this._state !== state) {
      throw new Error(`Illegal state`);
    }
  }

  _getRunningTransitions() {
    const transitions = [];
    for (const name of this._names) {
      const transition = this._actor.get_transition(name);
      if (transition) {
        transitions.push(transition);
      }
    }
    return transitions;
  }

  _indexTransitions() {
    let index = 0;
    for (const name of this._names) {
      const transition = this._actor.get_transition(name);
      if (transition) {
        transition[this._indexSymbol] = index++;
      }
    }
    return !!index;
  }

  _getTransition(name) {
    const names = this._names;
    for (let i = 0; i < names.length; i++) {
      if (names[i] == name) {
        return this._transitions[i];
      }
    }
    return null;
  }

  _checkPending() {
    if (this._pendingWire.isConnected()) {
      return;
    }
    if (this._shouldWaitForExternals && this._waitForExternals()) {
      return;
    }
    if (this._shouldWaitForInternals && this._waitForInternals()) {
      return;
    }
    this._settle();
  }

  _waitForExternals() {
    const names = this._names;
    for (let i = 0; i < names.length; i++) {
      const transition = this._actor.get_transition(names[i]);
      if (transition && transition !== this._transitions[i]) {
        this._pendingWire.setTarget(transition).connect();
        return true;
      }
    }
    return false;
  }

  _waitForInternals() {
    for (const transition of this._transitions) {
      if (transition) {
        this._pendingWire.setTarget(transition).connect();
        return true;
      }
    }
    return false;
  }

  _onPendingStopped() {
    this._pendingWire.setTarget(null);
    this._checkPending();
  }

  _settle() {
    this._settled = true;
  }
}

function groupHandler(length, callback) {
  const symbol = Symbol();
  let figure = 0;
  let count = 0;
  return (target) => {
    if (target.canceled) {
      length--;
      if (target[symbol] === figure) {
        count--;
      }
    } else if (target[symbol] !== figure) {
      target[symbol] = figure;
      if (++count === length) {
        figure++;
        count = 0;
        callback();
      }
    }
  };
}

class GroupHandler {

  /**
   * @param {Function} callback
   */
  constructor(callback) {
    this._callback = callback;
    this._symbol = Symbol();
    this._length = 0;
    this._figure = 0;
    this._count = 0;
  }

  add(target) {
    if (this._symbol in target) {
      return;
    }
    target[this._symbol] = null;
    this._length++;
  }

  remove(target) {
    if (!(this._symbol in target)) {
      return;
    }
    if (target[this._symbol] === this._figure) {
      this._count--;
    }
    delete target[this._symbol];
    this._length--;
  }

  handle(target) {
    if (!(this._symbol in target)) {
      return;
    }
    if (target[this._symbol] !== this._figure) {
      target[this._symbol] = this._figure;
      if (++this._count === this._length) {
        this._figure++;
        this._count = 0;
        this._callback.apply(null, arguments);
      }
    }
  }
}

class GroupHandler2 {
  constructor(signal, callback, after = false) {
    this._signal = signal;
    this._callback = callback;
    this._after = after;

    this._symbol = Symbol('GroupHandler');
    this._length = 0;
    this._figure = 0;
    this._count = 0;
  }

  add(transition) {
    if (transition[this._symbol]) {
      return;
    }
    transition[this._symbol] = {
      handlerId: this._connect(transition, this._signal, this._handle.bind(this)),
      stoppedId: this._connect(transition, 'stopped', this.remove.bind(this)),
      figure: null
    };
    this._length++;
  }

  remove(transition) {
    const data = transition[this._symbol];
    if (!data) {
      return;
    }
    transition.disconnect(data.handlerId);
    transition.disconnect(data.stoppedId);
    if (data.figure === this._figure) {
      this._count--;
    }
    delete transition[this._symbol];
    this._length--;
    // TODO: should trigger also here
  }

  _connect(target, signal, handler) {
    return !this._after
      ? target.connect(signal, handler)
      : target.connect_after(signal, handler);
  }

  _handle(transition) {
    const data = transition[this._symbol];
    if (!data) {
      return;
    }
    if (data.figure !== this._figure) {
      data.figure = this._figure;
      if (++this._count === this._length) {
        this._figure++;
        this._count = 0;
        this._callback.apply(null, arguments);
      }
    }
  }
}
