/**
 * Array-based binary min-heap, shared by every router in the app.
 *
 * Extracted verbatim from `routing.ts`, where it had served the walking
 * `dijkstra` and the `paretoRoutes` A* frontier since they were written. It
 * moved here unchanged so `trainDijkstra` could stop being the one router still
 * scanning an array for its minimum: the transit search state is
 * `(station, route boarded)` — 955 of them for the published NYC subway, and
 * 27,662 once bus shards load. `findBestTrainRoute` runs up to 25 of these
 * searches per route calculation, which is 14.2 s of argmin scanning against
 * 563 ms of heap.
 *
 * No decrease-key. Every caller uses lazy deletion instead — push the improved
 * cost and skip the stale entry on pop — which is why the comparator is
 * injected rather than the heap knowing anything about what it orders.
 */

/** Simple array-based binary min-heap. */
export class MinHeap<T> {
  private data: T[] = [];
  constructor(private cmp: (a: T, b: T) => number) {}

  push(item: T): void {
    this.data.push(item);
    this._bubbleUp(this.data.length - 1);
  }

  pop(): T | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  get size(): number {
    return this.data.length;
  }

  private _bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.cmp(this.data[i], this.data[parent]) < 0) {
        [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
        i = parent;
      } else {
        break;
      }
    }
  }

  private _sinkDown(i: number): void {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this.cmp(this.data[l], this.data[smallest]) < 0) smallest = l;
      if (r < n && this.cmp(this.data[r], this.data[smallest]) < 0) smallest = r;
      if (smallest === i) break;
      [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
      i = smallest;
    }
  }
}
