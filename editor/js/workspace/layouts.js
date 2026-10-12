/**
 * AE1 - default workspace layouts, per project type.
 *
 * A user's arranged layout is saved to settings.json and wins over these. This is
 * only the first thing they ever see -- but a default that requires immediate
 * rearrangement teaches the user that the tool does not know what they are doing.
 */

import { leaf, split } from './area.js';

/**
 * Point & click adventure.
 *
 *   +-----------+---------------------------+------------+
 *   | Outliner  |         Viewport          | Properties |
 *   |           +---------------------------+------------+
 *   |           |     Media    |   Script                |
 *   +-----------+---------------------------+------------+
 *
 * The reasoning: the viewport is the subject, so it takes the centre and the
 * largest share. Media and Script sit under it because in this genre they are
 * *consulted*, not stared at -- you drag an asset in, wire a script to it, and go
 * back to looking at the room. Outliner narrow at left, properties at right, in
 * the arrangement every DCC tool has converged on.
 */
const POINT_CLICK = () =>
  split(
    'row',
    leaf('outliner'),
    split(
      'row',
      split('col', leaf('viewport'), split('row', leaf('script'), leaf('console'), 0.62), 0.6),
      leaf('properties'),
      0.78,
    ),
    0.16,
  );

const DEFAULTS = {
  'point-click-adventure': POINT_CLICK,
};

export function defaultLayout(projectType) {
  return (DEFAULTS[projectType] ?? POINT_CLICK)();
}
