export class BoundedBuffer<T> {
  private readonly items: T[] = [];
  readonly capacity: number;
  totalAdded = 0;
  dropped = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("BoundedBuffer capacity must be a positive integer");
    }
    this.capacity = capacity;
  }

  push(value: T) {
    this.totalAdded += 1;
    this.items.push(value);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
      this.dropped += 1;
    }
  }

  pushMany(values: Iterable<T>) {
    for (const value of values) {
      this.push(value);
    }
  }

  values() {
    return [...this.items];
  }

  get size() {
    return this.items.length;
  }
}
