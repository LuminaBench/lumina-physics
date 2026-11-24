import type { N } from './tsl';

export interface GridFocus {
  width: number;
  segments: number;
}
/** More samples across a centred play area, with a continuous metre-to-grid map.
 * Both axes share the same piecewise spacing and the total vertex count stays fixed. */
export class FocusedGrid {
  readonly innerStep: number;
  readonly outerStep: number;
  readonly middle: number;
  readonly innerHalf: number;
  readonly halfWidth: number;
  constructor(
    readonly size: number,
    readonly segments: number,
    focus: GridFocus,
  ) {
    if (
      !Number.isFinite(size) ||
      !Number.isFinite(focus.width) ||
      size <= 0 ||
      focus.width <= 0 ||
      focus.width >= size ||
      !Number.isInteger(segments) ||
      !Number.isInteger(focus.segments) ||
      focus.segments < 2 ||
      focus.segments >= segments ||
      (segments - focus.segments) % 2 !== 0
    )
      throw new RangeError(
        'Focused terrain needs an interior width and a whole number of cells on either side',
      );
    this.middle = segments / 2;
    this.innerHalf = focus.segments / 2;
    this.halfWidth = focus.width / 2;
    this.innerStep = focus.width / focus.segments;
    this.outerStep = (size - focus.width) / (segments - focus.segments);
  }
  at(index: number) {
    const d = index - this.middle,
      a = Math.abs(d);
    return (
      Math.sign(d) *
      (Math.min(a, this.innerHalf) * this.innerStep + Math.max(0, a - this.innerHalf) * this.outerStep)
    );
  }
  index(metres: number) {
    const a = Math.abs(metres);
    return (
      this.middle +
      Math.sign(metres) *
        (Math.min(a, this.halfWidth) / this.innerStep + Math.max(0, a - this.halfWidth) / this.outerStep)
    );
  }
  spacingAt(cell: number) {
    return Math.abs(cell + 0.5 - this.middle) < this.innerHalf ? this.innerStep : this.outerStep;
  }
  indexNode(metres: N): N {
    const a = metres.abs();
    return a
      .min(this.halfWidth)
      .div(this.innerStep)
      .add(a.sub(this.halfWidth).max(0).div(this.outerStep))
      .mul(metres.sign())
      .add(this.middle);
  }
}
