import Meta from 'gi://Meta';

import { PACKAGE_VERSION } from 'resource:///org/gnome/shell/misc/config.js';

const [SHELL_VERSION] = PACKAGE_VERSION.split('.');

/* Clutter */

/** @type {string} */
let CHILD_ADDED;
/** @type {string} */
let CHILD_REMOVED;
if (SHELL_VERSION >= 46) {
  CHILD_ADDED = 'child-added';
  CHILD_REMOVED = 'child-removed';
} else {
  CHILD_ADDED = 'actor-added';
  CHILD_REMOVED = 'actor-removed';
}

/* Meta */

/** @import Clutter from 'gi://Clutter' */

/** @type {() => void} */
let disable_unredirect;
/** @type {() => void} */
let enable_unredirect;
/** @type {() => Clutter.Actor[]} */
let get_window_actors;
if (SHELL_VERSION >= 48) {
  disable_unredirect = () => global.compositor.disable_unredirect();
  enable_unredirect = () => global.compositor.enable_unredirect();
  get_window_actors = () => global.compositor.get_window_actors();
} else {
  disable_unredirect = () => Meta.disable_unredirect_for_display(global.display);
  enable_unredirect = () => Meta.enable_unredirect_for_display(global.display);
  get_window_actors = () => Meta.get_window_actors(global.display);
}

export {
  CHILD_ADDED,
  CHILD_REMOVED,
  disable_unredirect,
  enable_unredirect,
  get_window_actors
};
