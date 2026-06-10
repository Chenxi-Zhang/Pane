const REPORT_INTERVAL_MS = 5_000;
const FRAME_GAP_THRESHOLD_MS = 100;

function isEnabled(): boolean {
  try {
    return window.localStorage.getItem('pane.perfDiagnostics') === 'true';
  } catch {
    return false;
  }
}

export function startPerformanceDiagnostics() {
  if (!isEnabled()) return;

  let maxFrameGapMs = 0;
  let lastFrameAt = performance.now();
  let longTaskCount = 0;
  let maxLongTaskMs = 0;

  const observer = typeof PerformanceObserver !== 'undefined'
    ? new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount += 1;
        maxLongTaskMs = Math.max(maxLongTaskMs, entry.duration);
      }
    })
    : null;

  try {
    observer?.observe({ entryTypes: ['longtask'] });
  } catch {
    // Chromium exposes longtask in renderer contexts; keep RAF sampling if not.
  }

  const sampleFrame = (now: number) => {
    const gap = now - lastFrameAt;
    if (gap > FRAME_GAP_THRESHOLD_MS) {
      maxFrameGapMs = Math.max(maxFrameGapMs, gap);
    }
    lastFrameAt = now;
    window.requestAnimationFrame(sampleFrame);
  };

  window.requestAnimationFrame(sampleFrame);

  window.setInterval(() => {
    if (maxFrameGapMs > 0 || longTaskCount > 0) {
      console.warn('[PerfDiagnostics] renderer jank', {
        maxFrameGapMs: Math.round(maxFrameGapMs),
        longTaskCount,
        maxLongTaskMs: Math.round(maxLongTaskMs),
      });
    }

    maxFrameGapMs = 0;
    longTaskCount = 0;
    maxLongTaskMs = 0;
  }, REPORT_INTERVAL_MS);
}
