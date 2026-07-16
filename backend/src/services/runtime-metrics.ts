export type RuntimeMetricsSnapshot = {
  counters: Record<string, number>;
  gauges: Record<string, number>;
};

const SAFE_METRIC_KEY = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;

export class RuntimeMetrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  increment(key: string, amount = 1) {
    assertMetricKey(key);
    assertFiniteMetricValue(amount);
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }

  setGauge(key: string, value: number) {
    assertMetricKey(key);
    assertFiniteMetricValue(value);
    this.gauges.set(key, value);
  }

  snapshot(): RuntimeMetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges)
    };
  }

  reset() {
    this.counters.clear();
    this.gauges.clear();
  }
}

function assertMetricKey(key: string) {
  if (!SAFE_METRIC_KEY.test(key)) {
    throw new Error("Invalid runtime metric key");
  }
}

function assertFiniteMetricValue(value: number) {
  if (!Number.isFinite(value)) {
    throw new Error("Runtime metric value must be finite");
  }
}

export const runtimeMetrics = new RuntimeMetrics();
