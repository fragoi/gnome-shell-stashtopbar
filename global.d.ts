interface CurrentExtension {
  imports: {
    animations: typeof import('./animations');
    chromole: typeof import('./chromole');
    utils: typeof import('./utils');
    wm: typeof import('./wm');
  };
}

declare const global: any;

declare const imports: imports;

declare function log(msg: any): void;

declare function _(key: string): string;

interface imports {
  [any: string]: any;
  gi: imports.gi;
  misc: imports.misc;
}

declare namespace imports {
  interface gi {
    [any: string]: any;
    GObject: gi.GObject;
  }
}
declare namespace imports.gi {
  interface GObject {
    [any: string]: any;
    registerClass<T>(c: new () => T): GObject.Constructor<T>;
    registerClass<T>(o: any, c: new () => T): GObject.Constructor<T>;
  }
}

declare namespace imports {
  interface misc {
    [any: string]: any;
    extensionUtils: misc.extensionUtils;
  }
}
declare namespace imports.misc {
  interface extensionUtils {
    [any: string]: any;
    getCurrentExtension(): CurrentExtension;
  }
}

declare namespace Clutter {
  interface Actor {
    [any: string]: any;
  }
}

declare namespace Gio {
  type Settings = any;
}

declare namespace GObject {
  type Constructor<T> = T extends { _init: (...args: infer Args) => void } ?
    new (...args: Args) => T :
    new (...args: any[]) => T;

  type Object = any;
}
