function wire(target, signal, handler) {
  return new Wire(target, signal, handler);
}

class Wire {
  constructor(target, signal, handler) {
    this._target = target;
    this._signal = signal;
    this._handler = handler;
    this._handlerId = 0;
  }

  connect() {
    if (!this._handlerId && this._target) {
      this._handlerId = this._target.connect(this._signal, this._handler);
    }
    return this;
  }

  disconnect() {
    if (this._handlerId) {
      this._target.disconnect(this._handlerId);
      this._handlerId = 0;
    }
  }

  setTarget(target) {
    this.disconnect();
    this._target = target;
    return this;
  }
}
