import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import Table from 'cli-table3';
import { scanMarkdownDirectory } from './link-checker';

function printUsage(): void {
  console.log('Использование: node dist/cli.js <путь-к-папке> [--timeout=5000]');
}

function parseArgs(argv: string[]): { folderPath: string; timeoutMs: number } | null {
  const args = argv.slice(2);
  const folderPath = args.find((arg) => !arg.startsWith('--'));
  const timeoutArg = args.find((arg) => arg.startsWith('--timeout='));

  if (!folderPath) {
    return null;
  }

  const timeoutValue = timeoutArg ? Number(timeoutArg.split('=')[1]) : 5000;
  const timeoutMs = Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : 5000;

  return { folderPath, timeoutMs };
}

function printBrokenLinksReport(
  brokenLinks: Awaited<ReturnType<typeof scanMarkdownDirectory>>['brokenLinks'],
): void {
  const table = new Table({
    head: [
      chalk.cyan('#'),
      chalk.cyan('Markdown файл'),
      chalk.cyan('Ссылка'),
      chalk.cyan('Абсолютный/URL путь'),
      chalk.cyan('Статус'),
      chalk.cyan('Детали'),
    ],
    wordWrap: true,
    colWidths: [4, 38, 30, 44, 14, 42],
  });

  brokenLinks.forEach((item, index) => {
    table.push([
      String(index + 1),
      item.sourceFile,
      item.originalTarget,
      item.resolvedTarget,
      item.status,
      item.details,
    ]);
  });

  console.log(table.toString());
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  if (!parsed) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const absoluteFolderPath = path.resolve(parsed.folderPath);
  if (!fs.existsSync(absoluteFolderPath) || !fs.statSync(absoluteFolderPath).isDirectory()) {
    console.error(chalk.red(`Ошибка: папка не найдена или это не директория: ${absoluteFolderPath}`));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.blue(`Сканирование: ${absoluteFolderPath}`));
  console.log(chalk.blue(`HTTP timeout: ${parsed.timeoutMs}ms`));

  const result = await scanMarkdownDirectory(absoluteFolderPath, { timeoutMs: parsed.timeoutMs });

  console.log(chalk.gray(`Найдено Markdown файлов: ${result.markdownFiles.length}`));
  console.log(chalk.gray(`Извлечено ссылок: ${result.totalLinks}`));

  if (result.brokenLinks.length === 0) {
    console.log(chalk.green('Сломанных ссылок не найдено ✅'));
    return;
  }

  console.log(chalk.red(`Найдено сломанных ссылок: ${result.brokenLinks.length}`));
  printBrokenLinksReport(result.brokenLinks);
  process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(`Критическая ошибка: ${message}`));
  process.exitCode = 1;
});