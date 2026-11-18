/**
 * The references an export's XML names for a later archive pass (workout
 * routes, Health Records files), kept up to what that pass reads.
 *
 * The XML parser hands over one reference per element, and an export can
 * name far more than the pass will ever read, each one held until the parse
 * is done. Past the cap a reference is only counted, so the pass can report
 * it as refused without the job having held it.
 */
export interface BoundedReferences<T> {
  /** The references kept, in the order they arrived. */
  readonly items: T[];
  /** How many arrived after the cap. */
  readonly overflow: number;
  /** Every reference that arrived. */
  readonly total: number;
  push(item: T): void;
  /** What the pass takes: the references kept and how many were not. */
  handOver(): { references: T[]; overflow: number };
  /** Drop what is held once the pass has read it. */
  clear(): void;
}

export function boundedReferences<T>(cap: number): BoundedReferences<T> {
  const items: T[] = [];
  let overflow = 0;
  return {
    items,
    get overflow() {
      return overflow;
    },
    get total() {
      return items.length + overflow;
    },
    push(item) {
      if (items.length < cap) items.push(item);
      else overflow += 1;
    },
    handOver() {
      return { references: items, overflow };
    },
    clear() {
      items.length = 0;
      overflow = 0;
    },
  };
}
