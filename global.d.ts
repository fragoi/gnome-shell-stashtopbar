declare const global: any;

declare const imports: any;

declare function log(msg: any): void;

declare function _(key: string): string;

declare namespace Gio {
  type Settings = any;
}

declare module 'gi://*';
declare module 'resource://*';

declare module 'gi://Clutter' {
  type Clutter = any;
  namespace Clutter {
    interface Actor {
      [any: string]: any;
    }
    type Constraint = any;
  }
  const Clutter: Clutter;
  export default Clutter;
}

declare module 'gi://GObject' {
  type Constructor<T> = T extends { _init: (...args: infer Args) => void } ?
    new (...args: Args) => T :
    new (...args: any[]) => T;

  interface GObject {
    [any: string]: any;
    registerClass<T>(c: new (...args: any[]) => T): Constructor<T>;
    registerClass<T>(o: any, c: new (...args: any[]) => T): Constructor<T>;
  }
  const GObject: GObject;
  export default GObject;
}
