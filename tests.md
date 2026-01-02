# Manual tests

#### Activations:

* barrier: (not on VM) panel shows when pointer hits with force the top of the monitor,
  should not show when weakly touching it or sliding over it
* hot corner: (not on VM) hot corner works and shows/hide overview
* hover: panel visible when pointer is over it
* overview: panel visible when in overview
* key focus: `ctrl + alt + tab` should focus the panel,
  keyboard navigation should not close the panel, also on menus
* status area:
  * key focus on panel menus: panel shoud show,
    `super + v` shows calendar,
    `super + f10` shows app menu,
    `esc` to leave
  * menu open: when menu is open panel should be visible
  * actor added: when an item is added to the panel should have same behavior above,
    try enable `apps-menu@gnome-shell-extensions.gcampax.github.com`,
    or use `testmenu@fragoi.github.com`
* windows: when a window overlaps the panel it should hide,
  try also to switch workspace

#### Relayouts

* message tray: when a notification is visible,
  it should relayouts according to the panel animation,
  try: `notify-send hello` and activate the panel
* active menu: when a menu opens,
  it should relayouts according to the panel animation,
  try `super + v` to show calendar menu
* overview (shell >= 40): there should be some space between the panel and the search input

#### Shell known issues

Issues that exist in the shell but are less evident without this extension.

* keyboard navigation: when opening a menu with shortcuts or mouse,
  then navigating with keyboard to "Activities", the focus get stuck,
  to unstuck the only way so far is to press `esc` followed by `ctrl + alt + tab`.
  When the menu was opened after focusing with `ctrl + alt + tab`,
  the navigation does not get stuck.
* Allocation related (only with "offcanvas" animation):
  * pressure barrier: when barrier is disconnected and it was hit,
    it does not fire the barrier left signal,
    result is that when opening the overview with the hot corner,
    hitting it again to close the overview does not work the first time,
    should work the second though
  * looking glass: when panel allocation changes and looking glass "resizes",
    it does not consider if it is open,
    result is that it flies out of the screen
    and has to be closed (`esc`),
    otherwise the feeling is that windows are feezed

#### GSettings

Use gsettings with extension:

    SCHEMA_DIR=~/.local/share/gnome-shell/extensions/stashtopbar@fragoi.github.com/schemas
    SCHEMA=org.gnome.shell.extensions.com-github-fragoi-stashtopbar

List keys:

    gsettings --schemadir $SCHEMA_DIR list-keys $SCHEMA

List animation types:

    gsettings --schemadir $SCHEMA_DIR range $SCHEMA animation-type

Set "offcanvas" animation:

    gsettings --schemadir $SCHEMA_DIR set $SCHEMA animation-type offcanvas

Reset default animation:

    gsettings --schemadir $SCHEMA_DIR reset $SCHEMA animation-type
