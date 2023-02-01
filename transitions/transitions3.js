// @ts-nocheck

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
    const getTransitions = () => [
      actor.get_transition('x'),
      actor.get_transition('y')
    ];
    await factory.stoppedPromise(
      actor.get_transition('x'),
      actor.get_transition('y')
    );
    await factory.waitForTransitions(actor.get_transition('x'));
    doTransition();
    // connect signals
    await task.waitForCompleted(actor.get_transition('x'));

    task.waitForTransitions(actor.get_transition('x'))
      .then(doTransition)
      .then(connectSignals)
      .then(task.waitForCompleted(actor.get_transition('x')));
  }

  task.execute(doTransition)
    .on('completed', onCompleted)
    .on('new-frame', onNewFrame)
    .after('new-frame', afterNewFrame)
    .then(() => log('stopped'));

  task.cancel();
}

function updateX() { }

function doTransition() { }

function onCompleted() { }

function onNewFrame() { }

function afterNewFrame() { }

function waitForTransitions(getTransitions) {
  let waiting;
  const executor = (resolve) => {
    const transition = getTransitions().find(e => e.is_playing());
    if (transition) {
      waiting = transitionPromise(transition);
      waiting.then(() => executor(resolve));
    } else {
      waiting = null;
      resolve();
    }
  };
  const promise = new CancellablePromise(executor);
  const cancel = () => waiting && waiting.cancel();
  promise.catch(cancel);
  return promise;
}

function transitionsPromise(getTransitions) {
  let waiting;
  const executor = async (resolve, reject) => {
    try {
      let transition;
      while (transition = getTransitions().find(e => e)) {
        waiting = transitionPromise(transition);
        await waiting;
        //        waiting = idlePromise();
        //        await waiting;
      }
      waiting = null;
      resolve();
    } catch (e) {
      waiting = null;
      reject(e);
    }
  };
  const promise = new CancellablePromise(executor);
  const cancel = (e) => waiting && waiting.cancel(e);
  promise.catch(cancel);
  return promise;
}

class TransitionsPromise {
  constructor() {
    /** @type {CancellablePromise} */
    this._tp = null;
  }

  getTransitions() { }

  promise() {
    const promise = new CancellablePromise(this._executor.bind(this));
    promise.catch(this._cancel.bind(this));
    return promise;
  }

  async _executor(resolve, reject) {
    try {
      let transition;
      while (transition = this._getTransition()) {
        this._tp = transitionPromise(transition);
        await this._tp;
        //        waiting = idlePromise();
        //        await waiting;
      }
      this._tp = null;
      resolve();
    } catch (e) {
      this._tp = null;
      reject(e);
    }
  }

  _getTransition() {
    const transitions = this.getTransitions();
    return transitions && transitions.find(e => e);
  }

  _cancel() {
    const tp = this._tp;
    tp && tp.cancel();
  }
}

function transitionPromise(transition) {
  if (!transition) {
    return new CancellablePromise(resolve => resolve());
  }
  let stoppedId;
  const promise = new CancellablePromise(resolve => {
    stoppedId = transition.connect('stopped', resolve);
  });
  const disconnect = () => transition.disconnect(stoppedId);
  promise.then(disconnect, disconnect);
  return promise;
}

class CancellablePromise extends Promise {
  constructor(executor) {
    let _reject;
    super((resolve, reject) => {
      _reject = reject;
      executor(resolve, reject);
    });
    this._reject = _reject;
  }

  cancel(reason = new Error('canceled')) {
    this._reject(reason);
  }
}
