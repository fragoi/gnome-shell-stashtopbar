// @ts-nocheck

/**
 * @type {import('../utils')}
 */
const { wire } = imports.utils;

function test() {
  const actor = null;
  const task = new TransitionTask();
  task.watch(actor, 'x');
  task.watch(actor, 'y');
  task.watch(actor, 'z');
  task.unwatch(actor, 'z');

  if (task.isRunning()) {
    doTransition();
  } else if (!task.isWaiting()) {
    task.waitForTransitions().then(() => {
      task.execute(doTransition)
        .after('new-frame', afterNewFrame)
        .then(onCompleted);
    });

    await task.waitForTransitions();
    task.execute(doTransition)
      .after('new-frame', afterNewFrame)
      .then(onCompleted);

    await task.waitForTransitions();
    await task.execute(doTransition)
      .after('new-frame', afterNewFrame)
      .promise();
    onCompleted();
  }

  task.execute(doTransition)
    .on('completed', onCompleted)
    .on('new-frame', onNewFrame)
    .after('new-frame', afterNewFrame)
    .then(() => log('stopped'));

  task.cancel();

  task.run({
    waitForExternals: true,
    waitForInternals: true,
    onCreate: doTransition,
    onModify: doTransition,
    connect: {
      'completed': onCompleted,
      'new-frame': onNewFrame
    },
    connectAfter: {
      'new-frame': afterNewFrame
    }
  });
}

function updateX() { }

function doTransition() { }

function onCompleted() { }

function onNewFrame() { }

function afterNewFrame() { }

class TransitionGroup {
  constructor() {
    this._group = [];
  }

  add(actor, name) {
    if (this._indexOf(actor, name) >= 0) {
      return;
    }
    this._group.push({ actor, name });
  }

  remove(actor, name) {
    const index = this._indexOf(actor, name);
    if (index < 0) {
      return;
    }
    this._group.splice(index, 1);
  }

  transitions() {
    const transitions = [];
    for (const e of this._group) {
      const transition = e.actor.get_transition(e.name);
      if (transition) {
        transitions.push(transition);
      }
    }
    return transitions;
  }

  _indexOf(actor, name) {
    return this._group.findIndex(e =>
      e.actor === actor && e.name === name
    );
  }
}

class TransitionTask {
  constructor() {
    this._group = new TransitionGroup();
    this._task = null;
  }

  watch(actor, name) {
    this._group.add(actor, name);
  }

  unwatch(actor, name) {
    this._group.remove(actor, name);
  }

  transitions() {
    return this._group.transitions();
  }

  cancel() {
    if (!this._task) {
      return;
    }
    this._task.cancel();
    this._task = null;
  }

  execute(callback) {
    this.cancel();

    callback();

    const transitions = this.transitions();
    const task = new ExecuteTask(transitions);
    this._task = task;
    return task.then(() => this._task = null);
  }

  waitForTransitions() {
    this.cancel();

    this._task = new WaitTask(this);
    return this._task;
  }
}

class ExecuteTask {

  /**
   * @param {Array} transitions
   */
  constructor(transitions) {
    this._symbol = Symbol('ExecuteTask');
    this._transitions = [];

    try {
      transitions.forEach(e => this._add(e));
    } catch (e) {
      transitions.forEach(e => this._remove(e));
      throw e;
    }
  }

  cancel() {
    // TODO: need to check if better to remove it
    this._transitions.slice().forEach(e => e.stop());
  }

  on(signal, callback) {
    new GroupHandler(signal, callback).addAll(this._transitions);
    return this;
  }

  after(signal, callback) {
    new GroupHandler(signal, callback, true).addAll(this._transitions);
    return this;
  }

  then(callback) {
    if (this._transitions.length) {
      return this.on('stopped', callback);
    }
    callback();
    return this;
  }

  _add(transition) {
    if (transition[this._symbol]) {
      return;
    }
    transition[this._symbol] = transition.connect(
      'stopped',
      this._remove.bind(this)
    );
    this._transitions.push(transition);
  }

  _remove(transition) {
    const handlerId = transition[this._symbol];
    if (!handlerId) {
      return;
    }
    transition.disconnect(handlerId);
    delete transition[this._symbol];
    const index = this._transitions.indexOf(transition);
    if (index >= 0) {
      this._transitions.splice(index, 1);
    }
  }
}

class WaitTask {
  constructor(executor) {
    /** @type {TransitionTask} */
    this._executor = executor;
    this._delayed = null;

    this._wire = wire(null, 'stopped', this._onStopped.bind(this));
  }

  cancel() {
    this._wire.setTarget(null);
    if (this._delayed) {
      this._delayed.cancel();
      this._delayed = null;
    }
  }

  execute(callback) {
    this.cancel();

    if (!this._wait()) {
      return this._executor.execute(callback);
    }

    this._delayed = new DelayedTask(this._executor, callback);
    return this._delayed;
  }

  _wait() {
    const transition = this._executor.transitions()
      .find(e => e.is_playing());
    this._wire.setTarget(transition).connect();
    return !!transition;
  }

  _onStopped() {
    if (this._wait()) {
      return;
    }
    this._delayed.run();
  }
}

class DelayedTask {
  /**
   * @param {TransitionTask} executor
   * @param {Function} callback
   */
  constructor(executor, callback) {
    this._executor = executor;
    this._callback = callback;

    this._task = null;
    this._taskCallbacks = [];
  }

  cancel() {
    if (!this._task) {
      return;
    }
    this._task.cancel();
    this._task = null;
  }

  on(signal, callback) {
    this._add(task => task.on(signal, callback));
  }

  after(signal, callback) {
    this._add(task => task.after(signal, callback));
  }

  then(callback) {
    this._add(task => task.then(callback));
  }

  run() {
    this.cancel();

    this._task = this._executor.execute(this._callback);

    const reducer = (t, f) => f.apply(t);
    this._taskCallbacks.reduce(reducer, this._task);
  }

  /**
   * @param {(task: ExecuteTask) => ExecuteTask} callback
   */
  _add(callback) {
    this._taskCallbacks.push(callback);
  }
}

class GroupHandler {
  constructor(signal, callback, after = false) {
    this._signal = signal;
    this._callback = callback;
    this._after = after;

    this._symbol = Symbol();
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

  /**
   * @param {Array} transitions
   */
  addAll(transitions) {
    try {
      transitions.forEach(e => e && this.add(e));
    } catch (error) {
      transitions.forEach(e => e && this.remove(e));
      throw error;
    }
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

    if (this._count && this._count === this._length) {
      this._trigger();
    }
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
        this._trigger();
      }
    }
  }

  _trigger() {
    this._figure++;
    this._count = 0;
    this._callback.apply(null);
  }
}
