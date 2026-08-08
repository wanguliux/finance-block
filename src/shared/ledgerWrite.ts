/**
 * ledgerWrite.ts —— 账本落盘的纯核心（无 App 依赖）
 *
 * 把一笔 fin-beancount 分录插入账本文件「唯一的 fin-beancount 块」底部，
 * 或创建新文件 + 块。仅做纯字符串变换，文件 IO 留给调用方
 * （插件走 Obsidian adapter；CLI 走 fs / obsidian-cli）。
 *
 * 插件侧：src/ledger/ledgerFile.ts 的 appendEntryToLedgerBlock 改用本模块；
 * CLI 侧：src/cli/index.ts 直接用本模块 + fs 完成落盘。
 */

/**
 * 归一化块引用 ID：保留 t / v 前缀语义（t=交易，v=估值）。
 * 无论入参是 ^t-xxx / t-xxx / ^v-xxx / v-xxx / xxx，统一规整为 ^<t|v>-xxx。
 */
export function normalizeBlockRefId(blockRefId: string): string {
  const kindMatch = /^\^?([tv])-/.exec(blockRefId);
  const kind = kindMatch ? kindMatch[1] : 't';
  return `^${kind}-${blockRefId.replace(/^\^?[tv]-/, '')}`;
}

/**
 * 在账本文件内容中插入一笔分录。
 *
 * @param existing     账本文件现有内容；null 表示文件尚不存在（将创建）。
 * @param entryBody    分录内文（**不含** ``` 围栏），如：
 *                     2026-01-01 * 示例\n  资产:现金 -3500\n  费用:示例 3500
 * @param blockRefId   块引用 ID（可带或不带前导 ^t-），如 ^t-20260729120000
 * @param ledgerPath   账本文件路径（仅用于「文件不存在时」推断标题）
 * @returns            新的账本文件完整内容（含围栏）。
 */
export function appendEntryToContent(
  existing: string | null,
  entryBody: string,
  blockRefId: string,
  ledgerPath: string,
): string {
  const refId = normalizeBlockRefId(blockRefId);
  const entryText = `${entryBody}\n${refId}`; // 块内新分录（不含围栏）

  if (existing === null) {
    // 文件不存在 → 创建，含标题 + 单个 fin-beancount 块
    const title = ledgerPath.split('/').pop()?.replace('.md', '') || '账本';
    return `# ${title}\n\n\`\`\`fin-beancount\n${entryText}\n\`\`\`\n`;
  }

  const blockMatch = /```fin-beancount\r?\n([\s\S]*?)```/.exec(existing);

  if (blockMatch) {
    // 找到唯一的 fin-beancount 块：在其闭合 ``` 之前插入新分录
    const blockEnd = blockMatch.index + blockMatch[0].length; // 闭合 fence 之后的位置
    const closeFenceStart = blockEnd - 3; // 闭合 ``` 起始下标
    const before = existing.slice(0, closeFenceStart);
    const after = existing.slice(closeFenceStart);
    // entryText 以 ^t-xxx 结尾（无换行），after 是闭合 ```（无前导换行），
    // 必须在 after 前补一个 \n，否则最后一条分录会黏在 ``` 上导致渲染异常。
    return `${before}\n\n${entryText}\n${after}`;
  }

  // 文件存在但无 fin-beancount 块 → 末尾追加一个
  return `${existing}\n\n\`\`\`fin-beancount\n${entryText}\n\`\`\`\n`;
}

// ─── 按块引用定位 / 编辑 / 软删（纯字符串变换） ──────────────────

export interface LedgerEntrySpan {
  /** 该条目的块引用（^t- / ^v-），草稿无引用则为 null */
  ref: string | null;
  /** 在 body 行数组中的起止下标（含两端） */
  start: number;
  end: number;
}

/**
 * 把账本块内文切成一条条分录，标记各自的块引用行与行范围。
 * 规则（与插件 poster.splitEntries 一致）：
 *   - 日期行（非缩进）开启新条目；缩进行归入当前条目。
 *   - ^t-/^v- 行归属当前条目并闭合该条目。
 *   - 空行 / ; 注释行作为分隔，闭合当前条目（墓碑态的条目整体以 ; 前缀存在，仍被整体切出）。
 */
export function splitLedgerEntries(body: string): LedgerEntrySpan[] {
  const lines = body.split(/\r?\n/);
  const spans: LedgerEntrySpan[] = [];
  let curStart = -1;

  const findRefIdx = (s: number, e: number): number => {
    for (let i = s; i <= e; i++) {
      if (/^\^[tv]-/.test(lines[i].trim())) return i;
    }
    return -1;
  };
  const closeAt = (boundaryExclusive: number): void => {
    if (curStart < 0) return;
    let end = boundaryExclusive - 1;
    while (end >= curStart && lines[end].trim() === '') end--;
    if (end < curStart) {
      curStart = -1;
      return;
    }
    const refIdx = findRefIdx(curStart, end);
    spans.push({
      ref: refIdx >= 0 ? lines[refIdx].trim() : null,
      start: curStart,
      end: refIdx >= 0 ? refIdx : end,
    });
    curStart = -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith(';')) {
      closeAt(i);
      continue;
    }
    if (/^\^[tv]-/.test(trimmed)) {
      closeAt(i + 1);
      continue;
    }
    const isDate = /^\d{4}-\d{2}-\d{2}\s/.test(line) && !line.startsWith(' ');
    if (isDate) {
      closeAt(i);
      curStart = i;
    } else if (curStart < 0) {
      curStart = i;
    }
  }
  closeAt(lines.length);
  return spans;
}

/** 把账本内文替换为「按 ref 定位的条目」新文本（ref 不变，finance-log 链接不失效）。 */
export function replaceEntryByRef(content: string, refId: string, newBody: string): string {
  const m = /```fin-beancount\r?\n([\s\S]*?)```/.exec(content);
  if (!m) throw new Error('账本中找不到 fin-beancount 块');
  const body = m[1];
  const target = splitLedgerEntries(body).find((e) => e.ref === refId);
  if (!target) throw new Error(`未找到块引用 ${refId} 对应的分录`);

  const lines = body.split(/\r?\n/);
  const newLines = [
    ...lines.slice(0, target.start),
    ...newBody.split(/\r?\n/),
    ...lines.slice(target.end + 1),
  ];
  const newBodyText = newLines.join('\n');
  const bodyStart = m.index + m[0].indexOf(body);
  const bodyEnd = bodyStart + body.length;
  return content.slice(0, bodyStart) + newBodyText + content.slice(bodyEnd);
}

/**
 * 软删除墓碑：把该条目每一行前缀 `; `（beancount 注释 = 排除出解析与索引），
 * 数据保留、可反注释恢复。与插件 parser 约定一致（; 行被当分隔符，finance-log 不再索引）。
 */
export function tombstoneEntryByRef(content: string, refId: string): string {
  const m = /```fin-beancount\r?\n([\s\S]*?)```/.exec(content);
  if (!m) throw new Error('账本中找不到 fin-beancount 块');
  const body = m[1];
  const target = splitLedgerEntries(body).find((e) => e.ref === refId);
  if (!target) throw new Error(`未找到块引用 ${refId} 对应的分录`);

  const lines = body.split(/\r?\n/);
  const tombstoned = lines
    .slice(target.start, target.end + 1)
    .map((l) => (l.trim() === '' ? l : '; ' + l));
  const newLines = [...lines.slice(0, target.start), ...tombstoned, ...lines.slice(target.end + 1)];
  const newBodyText = newLines.join('\n');
  const bodyStart = m.index + m[0].indexOf(body);
  const bodyEnd = bodyStart + body.length;
  return content.slice(0, bodyStart) + newBodyText + content.slice(bodyEnd);
}
