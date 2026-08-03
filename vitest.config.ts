/*
 * vitest.config.ts（测试配置）
 * 文件作用：配置 vitest 的运行环境，让单元测试能跑起来。
 * 要点：
 *   - environment: 'jsdom'：用 jsdom 模拟浏览器 DOM（document/元素等），因为插件界面依赖网页环境。
 *   - resolve.alias：把代码中 `import ... from 'obsidian'` 这个导入"重定向"到 src/test/obsidian-shim.ts，
 *     也就是前面讲的"测试桩"，使测试不依赖真实 Obsidian 就能运行。
 */

import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    // Windows 下 threads pool 在测试文件较多时偶发
    // "options.minThreads and options.maxThreads must not conflict" 崩溃（无输出退出 1），
    // 改用 forks pool 规避（本仓库测试为纯内存 jsdom，无共享状态依赖）。
    pool: 'forks',
  },
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, 'src/test/obsidian-shim.ts'),
    },
  },
});
