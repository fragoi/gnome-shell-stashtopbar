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
    await transitionsPromise(getTransitions);
    
    await task.waitForTransitions();
    task.execute(doTransition);
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
  const cancel = (e) => waiting && waiting.cancel(e);
  const promise = new CancellablePromise(executor);
  promise.catch(cancel);
  return promise;
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
