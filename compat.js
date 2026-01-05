import { PACKAGE_VERSION } from 'resource:///org/gnome/shell/misc/config.js';

const [SHELL_VERSION] = PACKAGE_VERSION.split('.');

let CHILD_ADDED;
let CHILD_REMOVED;
if (SHELL_VERSION >= 46) {
  CHILD_ADDED = 'child-added';
  CHILD_REMOVED = 'child-removed';
} else {
  CHILD_ADDED = 'actor-added';
  CHILD_REMOVED = 'actor-removed';
}

export { CHILD_ADDED, CHILD_REMOVED };
