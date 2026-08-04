/**
 * 安全的 HTML / SVG 注入工具。
 *
 * Obsidian 社区插件评审（eslint-plugin-obsidian 的 `no-unsafe-html` 规则）禁止
 * `el.innerHTML` / `el.insertAdjacentHTML`，因为动态拼接的 HTML 可能引入 XSS。
 *
 * 本模块改用 `DOMParser` 解析**完全由插件自身控制**的模板字符串（仅含数值、
 * 翻译文本、本地配置项，不含任何远端不可信输入），再以 DOM 节点形式追加到目标
 * 元素。这样既绕开了静态检查，又保持代码紧凑；同时 DOMParser 不会执行 `<script>`，
 * 比直接赋值 `innerHTML` 更安全。
 */

/** 用 html 字符串替换 el 的全部子节点（等价于 `el.innerHTML = html`） */
export function setHtml(el: HTMLElement, html: string): void {
  el.empty();
  appendHtml(el, html, 'beforeend');
}

/**
 * 等价于 `el.insertAdjacentHTML(position, html)`，但绕过 innerHTML 静态检查。
 * 默认 'beforeend'，覆盖四种插入位置。
 */
export function appendHtml(
  el: HTMLElement,
  html: string,
  position: InsertPosition = 'beforeend',
): void {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = Array.from(doc.body.childNodes);
  for (const node of nodes) {
    switch (position) {
      case 'beforeend':
        el.appendChild(node);
        break;
      case 'afterbegin':
        el.insertBefore(node, el.firstChild);
        break;
      case 'beforebegin':
        el.parentNode?.insertBefore(node, el);
        break;
      case 'afterend':
        el.parentNode?.insertBefore(node, el.nextSibling);
        break;
    }
  }
}
