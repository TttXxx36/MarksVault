/**
 * 网站图标服务 - 用于获取和处理网站图标(favicon)
 */

import { browser } from 'wxt/browser';
import { isFirefox } from './browser-compat';

/**
 * 从URL获取域名
 * @param url 完整URL
 * @returns 域名部分
 */
export const getDomainFromUrl = (url: string): string => {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch (error) {
    console.error('无效的URL:', url);
    return '';
  }
};

/**
 * 获取网站图标URL
 * @param url 网站URL
 * @returns 图标URL
 */
export const getFaviconUrl = (url: string): string => {
  try {
    // 检查URL是否有效
    if (!url) return '';

    // Chromium（Chrome/Edge）支持内置的 `_favicon` 端点：
    // - 该端点不是 public 资源文件，因此不能直接作为 getURL 的入参（WXT 会对路径做类型收窄）
    // - 这里使用扩展根路径作为 base，再拼接 `_favicon`，避免硬编码 chrome-extension://
    //
    // Firefox 不支持该端点；为避免把书签域名泄漏给第三方服务，不做远程回退
    const firefoxRuntime = isFirefox();
    if (!firefoxRuntime) {
      // 注意：`runtime.getURL` 的入参应为相对路径，避免传入 '/' 导致部分环境出现双斜杠（`//`）。
      const baseUrl = browser.runtime.getURL('');
      const baseWithSlash = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
      return `${baseWithSlash}_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
    }

    // Firefox 不调用第三方 favicon 服务，避免把书签域名泄漏给 Google。
    // UI 会在空 URL 时直接显示默认图标。
    if (firefoxRuntime) return '';
  } catch (error) {
    console.error('获取图标URL失败:', error);
    
    // Firefox/未知运行时不向第三方服务回退，直接让 UI 使用默认图标。
    return '';
  }
};

/**
 * 获取网站主题色(未来可以扩展)
 * @param url 网站URL
 * @returns Promise<string> 返回颜色代码
 */
export const getWebsiteThemeColor = async (_url: string): Promise<string> => {
  void _url;
  // 这里可以实现获取网站主题色的逻辑
  // 默认返回一个占位色
  return '#f0f0f0';
};

/**
 * 检查图标是否有效
 * @param iconUrl 图标URL
 * @returns Promise<boolean> 是否有效
 */
export const isValidFavicon = async (iconUrl: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = iconUrl;
  });
};

const faviconService = {
  getFaviconUrl,
  getDomainFromUrl,
  getWebsiteThemeColor,
  isValidFavicon
};

export default faviconService; 
