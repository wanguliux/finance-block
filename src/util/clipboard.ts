/**
 * clipboard.ts —— 跨环境复制文本工具
 *
 * Obsidian 内 navigator.clipboard 在部分环境（非安全上下文 / 移动端）不可用，
 * 用 execCommand('copy') 做兜底，确保「复制该记录」等操作始终可用。
 */

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到兜底逻辑
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
