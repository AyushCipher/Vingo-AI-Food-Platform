/**
 * Frontend Core Web Vitals & Performance Observer for Vingo
 * Monitors Largest Contentful Paint (LCP), Cumulative Layout Shift (CLS),
 * and First Input Delay (FID) / Interaction to Next Paint (INP).
 */
export function initWebVitals() {
  if (typeof window === "undefined" || !("PerformanceObserver" in window)) {
    return;
  }

  // 1. Largest Contentful Paint (LCP)
  try {
    const lcpObserver = new PerformanceObserver((entryList) => {
      const entries = entryList.getEntries();
      const lastEntry = entries[entries.length - 1];
      if (lastEntry) {
        const value = Math.round(lastEntry.startTime);
        const status = value <= 2500 ? "🟢 Optimal" : value <= 4000 ? "🟡 Needs Improvement" : "🔴 Poor";
        if (import.meta.env.DEV) {
          console.debug(`%c[Web Vitals] LCP: ${value}ms (${status})`, "color: #10b981; font-weight: bold;");
        }
      }
    });
    lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
  } catch (e) {
    // Unsupported in older browsers
  }

  // 2. Cumulative Layout Shift (CLS)
  try {
    let clsValue = 0;
    const clsObserver = new PerformanceObserver((entryList) => {
      for (const entry of entryList.getEntries()) {
        if (!entry.hadRecentInput) {
          clsValue += entry.value;
        }
      }
      const status = clsValue <= 0.1 ? "🟢 Optimal" : clsValue <= 0.25 ? "🟡 Needs Improvement" : "🔴 Poor";
      if (import.meta.env.DEV) {
        console.debug(`%c[Web Vitals] CLS: ${clsValue.toFixed(4)} (${status})`, "color: #3b82f6; font-weight: bold;");
      }
    });
    clsObserver.observe({ type: "layout-shift", buffered: true });
  } catch (e) {
    // Unsupported
  }

  // 3. First Input Delay / Interaction
  try {
    const fidObserver = new PerformanceObserver((entryList) => {
      const firstInput = entryList.getEntries()[0];
      if (firstInput) {
        const delay = Math.round(firstInput.processingStart - firstInput.startTime);
        const status = delay <= 100 ? "🟢 Optimal" : "🟡 Needs Improvement";
        if (import.meta.env.DEV) {
          console.debug(`%c[Web Vitals] FID: ${delay}ms (${status})`, "color: #8b5cf6; font-weight: bold;");
        }
      }
    });
    fidObserver.observe({ type: "first-input", buffered: true });
  } catch (e) {
    // Unsupported
  }
}
