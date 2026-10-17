import fs from 'node:fs';
import os from 'node:os';

import upath from 'upath';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('viewerRoot', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is the viewer given by VS_CLI_VIEWER_ROOT when it is built', async () => {
    const dir = fs.mkdtempSync(upath.join(os.tmpdir(), 'vs-viewer-'));
    fs.mkdirSync(upath.join(dir, 'lib'));
    fs.writeFileSync(upath.join(dir, 'lib/index.html'), '<!doctype html>');
    vi.stubEnv('VS_CLI_VIEWER_ROOT', dir);
    vi.resetModules();
    const { viewerRoot, versionForDisplay } = await import('../src/util.js');
    expect(viewerRoot).toBe(upath.resolve(dir));
    expect(versionForDisplay).toContain(`(${upath.resolve(dir)})`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is the viewer of the CLI when the given one is not built', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.stubEnv('VS_CLI_VIEWER_ROOT', upath.join(os.tmpdir(), 'vs-no-viewer'));
    vi.resetModules();
    const { viewerRoot, versionForDisplay } = await import('../src/util.js');
    expect(viewerRoot).toMatch(/@vivliostyle\/viewer$/v);
    expect(versionForDisplay).not.toContain('(');
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('VS_CLI_VIEWER_ROOT is not built'),
    );
    write.mockRestore();
  });
});
