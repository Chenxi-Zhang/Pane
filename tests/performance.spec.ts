import { test, expect, Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

type PaneTestMock = {
  emitRemoteDaemonResyncRequested: () => void;
  setSessions: (sessions: Array<Record<string, unknown>>) => void;
  setPanels: (sessionId: string, panels: Array<Record<string, unknown>>) => void;
  emitPanelActivityStatus: (event: Record<string, unknown>) => void;
};

test.beforeEach(async ({ page }) => {
  await installElectronApiMock(page);
});

async function dismissStartupDialogs(page: Page) {
  const analyticsDecline = page.locator('button:has-text("No thanks")');
  if (await analyticsDecline.isVisible({ timeout: 3000 }).catch(() => false)) {
    await analyticsDecline.click();
  }

  const getStartedButton = page.locator('button:has-text("Get Started")');
  if (await getStartedButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await getStartedButton.click();
  }
}

function createPanel(sessionId: string, index: number): Record<string, unknown> {
  const id = `${sessionId}-terminal-${index}`;
  return {
    id,
    sessionId,
    type: 'terminal',
    title: `Terminal ${index + 1}`,
    state: {
      isActive: index === 0,
      hasBeenViewed: true,
      customState: {
        isInitialized: false,
        cwd: '/tmp',
      },
    },
    metadata: {
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      position: index,
    },
  };
}

test.describe('Performance smoke tests', () => {
  test('activity-status churn does not block Add Tool interaction or renderer frames', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissStartupDialogs(page);

    const fixture = Array.from({ length: 8 }, (_, sessionIndex) => {
      const sessionId = `perf-session-${sessionIndex}`;
      return {
        session: {
          id: sessionId,
          name: `Perf Pane ${sessionIndex + 1}`,
          worktreePath: `/tmp/${sessionId}`,
          prompt: 'performance smoke',
          status: 'running',
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
          output: [],
          jsonMessages: [],
        },
        panels: Array.from({ length: 4 }, (_unused, panelIndex) => createPanel(sessionId, panelIndex)),
      };
    });

    await page.evaluate((nextFixture) => {
      const mock = (window as typeof window & { __paneTestElectronMock?: PaneTestMock }).__paneTestElectronMock;
      mock?.setSessions(nextFixture.map((entry) => entry.session));
      for (const entry of nextFixture) {
        mock?.setPanels(String(entry.session.id), entry.panels);
      }
      mock?.emitRemoteDaemonResyncRequested();
    }, fixture);

    await page.getByText('Perf Pane 1').click();
    await expect(page.getByRole('button', { name: /Add Tool/i })).toBeVisible({ timeout: 5000 });

    const result = await page.evaluate(async () => {
      const mock = (window as typeof window & { __paneTestElectronMock?: PaneTestMock }).__paneTestElectronMock;
      const statuses = ['active', 'waiting_for_input', 'unviewed', 'idle'];
      const panelIds = Array.from({ length: 8 }, (_sessionUnused, sessionIndex) =>
        Array.from({ length: 4 }, (_panelUnused, panelIndex) => `perf-session-${sessionIndex}-terminal-${panelIndex}`)
      ).flat();
      const frameGaps: number[] = [];
      let lastFrame = performance.now();
      let running = true;

      const sampleFrames = () => {
        if (!running) return;
        const now = performance.now();
        frameGaps.push(now - lastFrame);
        lastFrame = now;
        requestAnimationFrame(sampleFrames);
      };
      requestAnimationFrame(sampleFrames);

      const start = performance.now();
      for (let index = 0; index < 320; index += 1) {
        const panelId = panelIds[index % panelIds.length];
        mock?.emitPanelActivityStatus({
          panelId,
          sessionId: panelId.split('-terminal-')[0],
          status: statuses[index % statuses.length],
          lastActivityAt: new Date().toISOString(),
        });
        if (index % 20 === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      running = false;

      return {
        churnMs: performance.now() - start,
        maxFrameGapMs: Math.max(...frameGaps),
      };
    });

    const addToolButton = page.getByRole('button', { name: /Add Tool/i });
    const interactionStart = Date.now();
    await addToolButton.hover();
    await addToolButton.click();
    await expect(page.getByRole('menu')).toBeVisible({ timeout: 1500 });
    const addToolOpenMs = Date.now() - interactionStart;

    expect(result.maxFrameGapMs).toBeLessThan(250);
    expect(result.churnMs).toBeLessThan(1500);
    expect(addToolOpenMs).toBeLessThan(1000);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });
});
