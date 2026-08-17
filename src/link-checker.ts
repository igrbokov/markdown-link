import { Dirent } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type LinkKind = 'local' | 'http';

export interface ExtractedLink {
  sourceFile: string;
  linkText: string;
  originalTarget: string;
  line: number;
}

export interface BrokenLink {
  sourceFile: string;
  linkText: string;
  originalTarget: string;
  kind: LinkKind;
  resolvedTarget: string;
  status: string;
  details: string;
}

export interface ScanOptions {
  timeoutMs?: number;
}

export interface ScanResult {
  markdownFiles: string[];
  totalLinks: number;
  brokenLinks: BrokenLink[];
}

const MARKDOWN_LINK_REGEX = /\[([^\]]*)\]\(([^)]+)\)/g;
const FILE_URI_REGEX = /file:\/\/\/[^)\s]+/g;

function toLineNumber(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function cleanupMarkdownTarget(target: string): string {
  const trimmed = target.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1).trim();
  }

  const quotedMatch = trimmed.match(/^([^\s]+)\s+".*"$/);
  if (quotedMatch) {
    return quotedMatch[1];
  }

  return trimmed;
}

function stripFragmentAndQuery(target: string): string {
  return target.split('#')[0].split('?')[0];
}

export function extractLinksFromMarkdown(content: string, sourceFile: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const occupiedRanges: Array<{ start: number; end: number }> = [];

  for (const match of content.matchAll(MARKDOWN_LINK_REGEX)) {
    const linkText = match[1] ?? '';
    const originalTarget = cleanupMarkdownTarget(match[2] ?? '');
    const start = match.index ?? 0;
    const end = start + match[0].length;
    occupiedRanges.push({ start, end });

    links.push({
      sourceFile,
      linkText,
      originalTarget,
      line: toLineNumber(content, start),
    });
  }

  for (const match of content.matchAll(FILE_URI_REGEX)) {
    const index = match.index ?? 0;
    const insideMarkdownLink = occupiedRanges.some((range) => index >= range.start && index <= range.end);
    if (insideMarkdownLink) {
      continue;
    }

    links.push({
      sourceFile,
      linkText: '(file-uri)',
      originalTarget: match[0],
      line: toLineNumber(content, index),
    });
  }

  return links;
}

export async function collectMarkdownFiles(rootDir: string): Promise<string[]> {
  const result: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries: Dirent[] = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && fullPath.toLowerCase().endsWith('.md')) {
        result.push(path.resolve(fullPath));
      }
    }
  }

  await walk(path.resolve(rootDir));
  return result;
}

function isHttpTarget(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

function isSkippableTarget(target: string): boolean {
  const value = target.trim().toLowerCase();
  return value.length === 0 || value.startsWith('#') || value.startsWith('mailto:') || value.startsWith('tel:');
}

export function resolveLocalLinkPath(sourceFile: string, target: string): string {
  const withoutSuffix = stripFragmentAndQuery(target);

  if (withoutSuffix.startsWith('file:///')) {
    const fileUrl = new URL(withoutSuffix);
    return path.resolve(decodeURIComponent(fileUrl.pathname));
  }

  if (path.isAbsolute(withoutSuffix)) {
    return path.resolve(withoutSuffix);
  }

  return path.resolve(path.dirname(sourceFile), withoutSuffix);
}

export async function checkLocalLink(link: ExtractedLink): Promise<BrokenLink | null> {
  const resolvedTarget = resolveLocalLinkPath(link.sourceFile, link.originalTarget);

  try {
    await access(resolvedTarget);
    return null;
  } catch {
    return {
      sourceFile: link.sourceFile,
      linkText: link.linkText,
      originalTarget: link.originalTarget,
      kind: 'local',
      resolvedTarget,
      status: 'ENOENT',
      details: `Файл не найден (строка ${link.line})`,
    };
  }
}

export async function checkHttpLink(link: ExtractedLink, timeoutMs: number): Promise<BrokenLink | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(link.originalTarget, {
      method: 'GET',
      signal: controller.signal,
    });

    if (response.ok) {
      return null;
    }

    return {
      sourceFile: link.sourceFile,
      linkText: link.linkText,
      originalTarget: link.originalTarget,
      kind: 'http',
      resolvedTarget: link.originalTarget,
      status: String(response.status),
      details: `HTTP ${response.status} (строка ${link.line})`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timeoutError = error instanceof DOMException && error.name === 'AbortError';

    return {
      sourceFile: link.sourceFile,
      linkText: link.linkText,
      originalTarget: link.originalTarget,
      kind: 'http',
      resolvedTarget: link.originalTarget,
      status: timeoutError ? 'TIMEOUT' : 'NETWORK_ERROR',
      details: timeoutError ? `Превышен таймаут ${timeoutMs}ms (строка ${link.line})` : `${message} (строка ${link.line})`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function scanMarkdownDirectory(rootDir: string, options: ScanOptions = {}): Promise<ScanResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const markdownFiles = await collectMarkdownFiles(rootDir);
  const allLinks: ExtractedLink[] = [];

  for (const markdownFile of markdownFiles) {
    const content = await readFile(markdownFile, 'utf8');
    const links = extractLinksFromMarkdown(content, markdownFile);
    allLinks.push(...links);
  }

  const brokenLinks: BrokenLink[] = [];

  for (const link of allLinks) {
    if (isSkippableTarget(link.originalTarget)) {
      continue;
    }

    if (isHttpTarget(link.originalTarget)) {
      const broken = await checkHttpLink(link, timeoutMs);
      if (broken) {
        brokenLinks.push(broken);
      }
      continue;
    }

    const broken = await checkLocalLink(link);
    if (broken) {
      brokenLinks.push(broken);
    }
  }

  return {
    markdownFiles,
    totalLinks: allLinks.length,
    brokenLinks,
  };
}