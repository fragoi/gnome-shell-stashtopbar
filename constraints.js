'use strict';

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {
  Edge,
  relativeEdge,
  boxToString,
  boxOverlaps
} from './chromole.js';
import { wire } from './utils.js';

/**
 * @import { Box, TransformedAllocation } from './chromole'
 */

/**
 * @type {(msg: string) => void}
 */
var _log;

/**
 * @param {Clutter.Actor} actor 
 * @return {Box}
 */
function transformedBox(actor) {
  const [x, y] = actor.get_transformed_position();
  const [w, h] = actor.get_transformed_size();
  return { x1: x, y1: y, x2: x + w, y2: y + h };
}

export const PaddingConstraint = GObject.registerClass(
  class PaddingConstraint extends Clutter.Constraint {

    /**
     * @param {TransformedAllocation} talloc 
     */
    _init(talloc) {
      super._init();
      this._talloc = talloc;

      this._edge = Edge.NONE;
      this._padding = 0;

      this._wire = wire(
        talloc,
        'allocation-changed',
        this._updateBox.bind(this)
      );

      this._actorWire = wire(
        null,
        'notify::allocation',
        this._updateBox.bind(this)
      );
    }

    vfunc_set_actor(actor) {
      super.vfunc_set_actor(actor);
      if (actor) {
        this._wire.connect();
        this._actorWire.setTarget(actor).connect();
        this._updateBox();
      } else {
        this._wire.disconnect();
        this._actorWire.setTarget(null);
        this._reset();
      }
    }

    vfunc_update_allocation(_actor, allocation) {
      if (!this._edge || !this._padding) {
        return;
      }
      if (this._edge & Edge.LEFT) allocation.x1 += this._padding;
      if (this._edge & Edge.RIGHT) allocation.x2 -= this._padding;
      if (this._edge & Edge.TOP) allocation.y1 += this._padding;
      if (this._edge & Edge.BOTTOM) allocation.y2 -= this._padding;
      _log && _log(`[PaddingConstraint] updated allocation: ${boxToString(allocation)}`);
    }

    vfunc_update_preferred_size(_actor, direction, _forSize, minSize, natSize) {
      if (!this._edge || !this._padding) {
        return [minSize, natSize];
      }
      let padding = 0;
      if (direction === Clutter.Orientation.HORIZONTAL) {
        if (this._edge & Edge.LEFT) padding += this._padding;
        if (this._edge & Edge.RIGHT) padding += this._padding;
      } else if (direction === Clutter.Orientation.VERTICAL) {
        if (this._edge & Edge.TOP) padding += this._padding;
        if (this._edge & Edge.BOTTOM) padding += this._padding;
      }
      const size = [minSize + padding, natSize + padding];
      _log && _log(`[PaddingConstraint] direction: ${direction}, padding: ${padding}, `
        + `size: ${size}`
      );
      return size;
    }

    _revert_allocation(allocation) {
      if (!this._edge || !this._padding) {
        return;
      }
      if (this._edge & Edge.LEFT) allocation.x1 -= this._padding;
      if (this._edge & Edge.RIGHT) allocation.x2 += this._padding;
      if (this._edge & Edge.TOP) allocation.y1 -= this._padding;
      if (this._edge & Edge.BOTTOM) allocation.y2 += this._padding;
    }

    _updateBox() {
      const actor = this.get_actor();
      if (!actor)
        return;

      _log && _log(`[PaddingConstraint] update box, `
        + `actor has allocation: ${actor.has_allocation()}, `
        + `is mapped: ${actor.mapped}`
      );

      if (!actor.has_allocation())
        return;

      const actorBox = transformedBox(actor);

      _log && _log(`[PaddingConstraint] update box, `
        + `actor box before revert: ${boxToString(actorBox)}`
      );

      /* as we modify the allocation, revert the changes */
      this._revert_allocation(actorBox);

      /* we consider the talloc to be relative to the stage */
      const tallocBox = this._talloc.allocation;

      const edge = boxOverlaps(actorBox, tallocBox) ?
        relativeEdge(actorBox, tallocBox, 1) :
        Edge.NONE;

      /* NOTE: I could handle mixed edges by using different
       * variables for the 4 edges, maybe it would be better */

      let padding = 0;
      switch (edge) {
        case Edge.LEFT:
        case Edge.RIGHT:
          padding = tallocBox.x2 - tallocBox.x1;
          break;
        case Edge.TOP:
        case Edge.BOTTOM:
          padding = tallocBox.y2 - tallocBox.y1;
          break;
      }

      _log && _log(`[PaddingConstraint] update box, `
        + `actor box: ${boxToString(actorBox)}, `
        + `talloc box: ${boxToString(tallocBox)}, `
        + `edge: ${edge}, padding: ${padding}`
      );

      const shouldRelayout = this._edge != edge || this._padding != padding;

      this._edge = edge;
      this._padding = padding;

      if (shouldRelayout) {
        actor.queue_relayout();
      }
    }

    _reset() {
      this._edge = Edge.NONE;
      this._padding = 0;
    }
  }
);
