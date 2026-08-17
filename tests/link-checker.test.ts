import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkHttpLink,
  checkLocalLink,
  extractLinksFromMarkdown,
  resolveLocalLinkPath,
} from '../src/link-checker';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'md-link-check-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('extractLinksFromMarkdown', () => {
  it('извлекает markdown ссылки и standalone file:/// ссылки', () => {
    const content = [
      '# Header',
      '[docs](./docs/readme.md)',
      '[api](https://example.com/api)',
      'Raw file uri: file:///tmp/missing.txt',
    ].join('\n');

    const links = extractLinksFromMarkdown(content, '/repo/a.md');
    expect(links).toHaveLength(3);
    expect(links[0].originalTarget).toBe('./docs/readme.md');
    expect(links[1].originalTarget).toBe('https://example.com/api');
    expect(links[2].originalTarget).toBe('file:///tmp/missing.txt');
  });
});

describe('resolveLocalLinkPath', () => {
  it('резолвит относительный путь относительно текущего файла в абсолютный', () => {
    const resolved = resolveLocalLinkPath('/repo/docs/a.md', '../assets/image.png');
    expect(resolved).toBe(path.resolve('/repo/assets/image.png'));
  });
});

describe('checkLocalLink', () => {
  it('возвращает ENOENT для отсутствующего локального файла с абсолютным путём', async () => {
    const root = await createTempDir();
    const markdown = path.join(root, 'docs', 'readme.md');
    await mkdir(path.dirname(markdown), { recursive: true });
    await writeFile(markdown, '# test', 'utf8');

    const broken = await checkLocalLink({
      sourceFile: markdown,
      linkText: 'lost',
      originalTarget: './missing.txt',
      line: 3,
    });

    expect(broken).not.toBeNull();
    expect(broken?.status).toBe('ENOENT');
    expect(path.isAbsolute(broken?.resolvedTarget ?? '')).toBe(true);
  });
});

describe('checkHttpLink', () => {
  it('возвращает null для HTTP 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })) as typeof fetch,
    );

    const broken = await checkHttpLink(
      {
        sourceFile: '/repo/a.md',
        linkText: 'ok',
        originalTarget: 'https://example.com',
        line: 1,
      },
      100,
    );

    expect(broken).toBeNull();
  });

  it('возвращает статус 404 для неуспешного HTTP ответа', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })) as typeof fetch,
    );

    const broken = await checkHttpLink(
      {
        sourceFile: '/repo/a.md',
        linkText: 'bad',
        originalTarget: 'https://example.com/404',
        line: 2,
      },
      100,
    );

    expect(broken?.status).toBe('404');
  });

  it('возвращает TIMEOUT при AbortError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      }) as typeof fetch,
    );

    const broken = await checkHttpLink(
      {
        sourceFile: '/repo/a.md',
        linkText: 'slow',
        originalTarget: 'https://example.com/slow',
        line: 3,
      },
      10,
    );

    expect(broken?.status).toBe('TIMEOUT');
  });

  it('возвращает NETWORK_ERROR при сетевой ошибке', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }) as typeof fetch,
    );

    const broken = await checkHttpLink(
      {
        sourceFile: '/repo/a.md',
        linkText: 'net',
        originalTarget: 'https://example.com/net',
        line: 4,
      },
      100,
    );

    expect(broken?.status).toBe('NETWORK_ERROR');
  });
});