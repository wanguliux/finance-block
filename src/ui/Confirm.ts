import { App, Modal, ButtonComponent } from 'obsidian';
import { t } from '../i18n';

export interface ConfirmOptions {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  // 标记这是危险操作（默认 true，给确认按钮加警示样式）
  warning?: boolean;
}

/**
 * 应用内确认框（替代原生 confirm()）。
 *
 * 为什么必须用它、不能用原生 confirm()：
 * Obsidian 跑在 Electron 上，原生 alert/confirm/prompt 是 **OS 级对话框**，会临时把焦点
 * 从 Electron 的 webview 整个拽出去；弹窗关闭后 Electron **不会可靠地把焦点还给 webview**
 * （长期已知 bug）。本函数用 Obsidian 自己的 Modal 渲染确认框，焦点始终留在 webview 内。
 * 返回 Promise<boolean>，调用方 `await` 即可，与同步 `confirm()` 的语义一致但更安全。
 */
export function confirmWithModal(
  app: App,
  message: string,
  opts: ConfirmOptions = {},
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const modal = new Modal(app);
    if (opts.title) modal.titleEl.setText(opts.title);

    modal.contentEl.empty();
    modal.contentEl.createDiv({ text: message, cls: 'finance-confirm-msg' });

    const btnRow = modal.contentEl.createDiv({ cls: 'finance-confirm-row' });

    let settled = false;
    const finish = (val: boolean): void => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(val);
    };

    new ButtonComponent(btnRow)
      .setButtonText(opts.cancelText ?? t('common.cancel'))
      .onClick(() => finish(false));

    const confirmBtn = new ButtonComponent(btnRow)
      .setButtonText(opts.confirmText ?? t('common.confirm'))
      .setCta();
    if (opts.warning !== false) confirmBtn.setClass('mod-destructive');
    confirmBtn.onClick(() => finish(true));

    // 打开后把焦点放到「取消」按钮（应用内 DOM，不会触发原生焦点 bug）。
    modal.onOpen = () => {
      const first = btnRow.querySelector('button');
      if (first) first.focus();
    };

    // Escape / 点击遮罩关闭时，确保 Promise 不会永远 pending
    modal.onClose = () => {
      finish(false);
    };

    modal.open();
  });
}
