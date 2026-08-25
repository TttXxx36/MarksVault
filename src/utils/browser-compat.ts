/**
 * MarksVault 浏览器能力判断。
 *
 * 只判断运行时能力，不把 Chrome/Firefox 的节点 ID 写入业务逻辑。
 * 该模块不访问书签、网络或存储，便于在三端和单元测试中复用。
 */

export type BrowserFamily = 'firefox' | 'chromium';

export const isFirefox = (): boolean => {
  return typeof navigator !== 'undefined' && /Firefox/i.test(navigator.userAgent);
};

export const getBrowserFamily = (): BrowserFamily => {
  return isFirefox() ? 'firefox' : 'chromium';
};

export const supportsChromiumFaviconEndpoint = (): boolean => {
  return getBrowserFamily() === 'chromium';
};
