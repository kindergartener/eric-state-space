// Fixed-size rolling average, used by the perf HUD (main.js) to smooth
// per-frame step()/render()/GPU/frame timings into a readable number
// instead of a jittery instantaneous value.
export class RollingAverage {
  constructor(size) {
    this.size = size;
    this.values = [];
    this.sum = 0;
  }

  push(value) {
    this.values.push(value);
    this.sum += value;
    if (this.values.length > this.size) {
      this.sum -= this.values.shift();
    }
  }

  mean() {
    return this.values.length === 0 ? 0 : this.sum / this.values.length;
  }
}
