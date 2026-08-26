import { GitHubCredentials, GitHubUser } from '../types/github';

export class GitHubApiError extends Error {
  public readonly status: number;
  public readonly data?: unknown;
  public readonly category: 'auth' | 'permission' | 'conflict' | 'validation' | 'not_found' | 'api';

  constructor(status: number, message: string, data?: unknown, category: GitHubApiError['category'] = 'api') {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.data = data;
    this.category = category;
  }
}

/**
 * 可重试错误的分类
 * 用于结构化识别临时性失败（网络、限流、服务端错误），取代按错误消息字符串匹配的判定
 */
export enum RetryableErrorCategory {
  NETWORK = 'network',       // 网络层失败（断网、DNS解析失败等）
  RATE_LIMIT = 'rate_limit', // 限流（HTTP 429）
  SERVER = 'server',         // 服务端错误（HTTP 5xx）
}

export interface GitHubRateLimitMetadata {
  status?: number;
  retryAfterSeconds?: number;
  remaining?: number;
  resetAt?: number;
}

/**
 * 可重试错误
 * 明确标记为临时性失败：可在执行租约有效期内重试
 */
export class RetryableError extends Error {
  public readonly category: RetryableErrorCategory;
  public readonly metadata?: GitHubRateLimitMetadata;

  constructor(category: RetryableErrorCategory, message: string, metadata?: GitHubRateLimitMetadata) {
    super(message);
    this.name = 'RetryableError';
    this.category = category;
    this.metadata = metadata;
  }
}

export const getGitHubErrorMetadata = (error: unknown): GitHubRateLimitMetadata | undefined => {
  if (error instanceof RetryableError) return error.metadata;
  return error instanceof GitHubApiError ? { status: error.status } : undefined;
};

/**
 * 结构化判定错误是否为可重试的临时性失败（网络、限流、服务端错误）
 * 重试判定仅依赖错误类型与状态码，不匹配错误消息字符串
 * @param error 错误对象
 * @returns 是否可重试
 */
export function isRetryableGitHubError(error: unknown): boolean {
  if (error instanceof RetryableError) {
    return true;
  }
  if (error instanceof GitHubApiError) {
    // 429 限流、5xx 服务端错误为临时性失败；其余（如 401 凭据错误）不可重试
    return error.status === 429 || error.status >= 500;
  }
  return false;
}

export class GitHubService {
  private static instance: GitHubService;
  private readonly baseUrl = 'https://api.github.com';
  private readonly apiVersion = '2022-11-28';
  private readonly requestTimeoutMs = 30_000;
  private readonly maxFileBytes = 20 * 1024 * 1024;
  
  private constructor() {}
  
  static getInstance(): GitHubService {
    if (!GitHubService.instance) {
      GitHubService.instance = new GitHubService();
    }
    return GitHubService.instance;
  }
  
  /**
   * 验证GitHub认证凭据
   */
  async validateCredentials(credentials: GitHubCredentials): Promise<GitHubUser> {
    const headers = this.getAuthHeaders(credentials);
    
    try {
      const response = await this.fetchWithRetryClassification(`${this.baseUrl}/user`, {
        method: 'GET',
        headers
      }, 'GitHub凭据验证');
      
      if (!response.ok) {
        await this.throwForErrorResponse(response, 'GitHub凭据验证');
      }
      
      const userData = await response.json();
      return userData as GitHubUser;
    } catch (error) {
      console.error('GitHub authentication failed:', error);
      throw error;
    }
  }
  
  /**
   * 获取认证头信息
   */
  private getAuthHeaders(credentials: GitHubCredentials): Headers {
    const headers = new Headers();
    headers.append('Accept', 'application/vnd.github+json');
    headers.append('Authorization', `Bearer ${credentials.token}`);
    headers.append('X-GitHub-Api-Version', this.apiVersion);
    return headers;
  }

  /**
   * 对路径按段编码，避免 #/?/% 等字符被当作 URL 特殊字符解析
   * （例如用户输入的文件夹名包含 # 时，未编码会静默上传到错误路径）
   * @param path 文件或目录路径（可为空字符串）
   * @returns 逐段编码后的路径
   */
  private encodePathSegments(path: string): string {
    return path.split('/').map(seg => encodeURIComponent(seg)).join('/');
  }

  /**
   * 统一 fetch 包装：网络层失败（浏览器 fetch 抛 TypeError，如 "Failed to fetch"）
   * 包装为结构化 RetryableError，供调用方按类型判定可重试性
   * @param url 请求地址
   * @param init 请求参数
   * @param context 操作上下文（用于错误消息）
   * @returns 响应对象
   */
  private async fetchWithRetryClassification(url: string, init: RequestInit | undefined, context: string): Promise<Response> {
    const controller = new AbortController();
    const callerSignal = init?.signal;
    let callerAbort: (() => void) | undefined;
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason);
      else {
        callerAbort = () => controller.abort(callerSignal.reason);
        callerSignal.addEventListener('abort', callerAbort, { once: true });
      }
    }
    const timeoutHandle = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && !callerSignal?.aborted) {
        throw new RetryableError(RetryableErrorCategory.NETWORK, `${context}超时`);
      }
      if (error instanceof TypeError) {
        throw new RetryableError(RetryableErrorCategory.NETWORK, `${context}网络错误: ${error.message}`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
      if (callerSignal && callerAbort) callerSignal.removeEventListener('abort', callerAbort);
    }
  }

  private async getLatestFileSha(
    credentials: GitHubCredentials,
    owner: string,
    repo: string,
    path: string,
  ): Promise<string | undefined> {
    const response = await this.fetchWithRetryClassification(
      `${this.baseUrl}/repos/${this.encodePathSegments(owner)}/${this.encodePathSegments(repo)}/contents/${this.encodePathSegments(path)}`,
      { method: 'GET', headers: this.getAuthHeaders(credentials) },
      '重新读取文件版本',
    );
    if (!response.ok) {
      await this.throwForErrorResponse(response, '重新读取文件版本');
    }
    const data = await response.json() as { sha?: unknown };
    return typeof data.sha === 'string' ? data.sha : undefined;
  }

  /**
   * 统一 HTTP 错误分类：限流（429）与服务端错误（5xx）为可重试的临时性失败，
   * 其余状态码为不可重试的 API 错误（如 401 凭据错误、404 资源不存在）
   * @param response 非 ok 的响应对象
   * @param context 操作上下文（用于错误消息）
   * @param errorData 已解析的响应体（可选，避免重复解析）
   */
  private async throwForErrorResponse(response: Response, context: string, errorData?: unknown): Promise<never> {
    if (errorData === undefined) {
      try {
        errorData = await response.json();
      } catch {
        // 响应体可能不是 JSON，忽略
      }
    }
    const getHeader = (name: string): string | null => {
      const headers = response.headers as Headers | undefined;
      return headers && typeof headers.get === 'function' ? headers.get(name) : null;
    };
    const retryAfterHeader = getHeader('retry-after');
    let retryAfterSeconds: number | undefined;
    if (retryAfterHeader) {
      const numeric = Number(retryAfterHeader);
      retryAfterSeconds = Number.isFinite(numeric)
        ? Math.max(0, Math.min(60, numeric))
        : Math.max(0, Math.min(60, (Date.parse(retryAfterHeader) - Date.now()) / 1000));
    }
    const remainingHeader = getHeader('x-ratelimit-remaining');
    const resetHeader = getHeader('x-ratelimit-reset');
    const metadata: GitHubRateLimitMetadata = {
      status: response.status,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      ...(remainingHeader && Number.isFinite(Number(remainingHeader)) ? { remaining: Number(remainingHeader) } : {}),
      ...(resetHeader && Number.isFinite(Number(resetHeader)) ? { resetAt: Number(resetHeader) * 1000 } : {}),
    };
    const message = `${context}失败: ${response.status}${errorData !== undefined ? ` - ${JSON.stringify(errorData)}` : ''}`;
    if (response.status === 429 || response.status >= 500) {
      throw new RetryableError(
        response.status === 429 ? RetryableErrorCategory.RATE_LIMIT : RetryableErrorCategory.SERVER,
        message,
        metadata
      );
    }
    // GitHub primary rate limit 返回 403 且响应体 message 含 "API rate limit exceeded"，
    // 与凭据错误等不可重试的 403 无法仅凭状态码区分，因此这是唯一依据响应体消息字符串做判定的例外
    const errorMessage = (errorData as { message?: unknown } | undefined)?.message;
    if (response.status === 403 &&
        typeof errorMessage === 'string' &&
        errorMessage.toLowerCase().includes('rate limit')) {
      throw new RetryableError(RetryableErrorCategory.RATE_LIMIT, message, metadata);
    }
    const category = response.status === 401 ? 'auth'
      : response.status === 403 ? 'permission'
        : response.status === 404 ? 'not_found'
          : response.status === 409 ? 'conflict'
            : response.status === 422 ? 'validation' : 'api';
    throw new GitHubApiError(response.status, message, errorData, category);
  }

  /**
   * 创建或更新仓库文件
   * @param credentials GitHub凭据
   * @param owner 仓库所有者用户名
   * @param repo 仓库名称
   * @param path 文件路径
   * @param content 文件内容
   * @param message 提交消息
   * @param sha 如果更新现有文件则需要提供此参数
   * @returns 创建或更新的文件信息
   */
  async createOrUpdateFile(
    credentials: GitHubCredentials,
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
    sha?: string
  ): Promise<any> {
    const headers = this.getAuthHeaders(credentials);
    const url = `${this.baseUrl}/repos/${this.encodePathSegments(owner)}/${this.encodePathSegments(repo)}/contents/${this.encodePathSegments(path)}`;
    
    // Base64编码内容
    const contentEncoded = btoa(unescape(encodeURIComponent(content)));
    
    try {
      let currentSha = sha;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const body: Record<string, string> = {
          message,
          content: contentEncoded,
        };
        if (currentSha) body.sha = currentSha;

        const response = await this.fetchWithRetryClassification(url, {
          method: 'PUT',
          headers,
          body: JSON.stringify(body)
        }, '创建或更新文件');

        if (response.ok) return await response.json();

        // 仅对版本冲突/Contents API 的可恢复 422 重读 SHA 并重试一次，
        // 防止重复提交风暴；其他 422 仍按不可重试错误返回。
        if ((response.status === 409 || response.status === 422) && attempt === 0) {
          const latestSha = await this.getLatestFileSha(credentials, owner, repo, path);
          if (latestSha) {
            currentSha = latestSha;
            continue;
          }
        }
        await this.throwForErrorResponse(response, '创建或更新文件');
      }
      throw new GitHubApiError(409, '创建或更新文件失败：重试次数已用尽');
    } catch (error) {
      console.error('Creating/updating file failed:', error);
      throw error;
    }
  }
  
  /**
   * 获取仓库文件内容
   * @param credentials GitHub凭据
   * @param owner 仓库所有者用户名
   * @param repo 仓库名称
   * @param path 文件路径
   * @returns 文件内容和元数据
   */
  async getFileContent(
    credentials: GitHubCredentials,
    owner: string,
    repo: string,
    path: string
  ): Promise<{ content: string; sha: string; metadata: any }> {
    const headers = this.getAuthHeaders(credentials);
    const url = `${this.baseUrl}/repos/${this.encodePathSegments(owner)}/${this.encodePathSegments(repo)}/contents/${this.encodePathSegments(path)}`;
    
    try {
      const response = await this.fetchWithRetryClassification(url, {
        method: 'GET',
        headers
      }, '获取文件内容');
      
      if (!response.ok) {
        await this.throwForErrorResponse(response, '获取文件内容');
      }
      
      const data = await response.json() as {
        content?: unknown;
        sha?: unknown;
        name?: unknown;
        path?: unknown;
        size?: unknown;
        html_url?: unknown;
        download_url?: unknown;
      };
      const declaredSize = typeof data.size === 'number' ? data.size : 0;
      if (declaredSize > this.maxFileBytes) {
        throw new GitHubApiError(413, `备份文件超过安全上限 ${this.maxFileBytes} 字节`);
      }

      let content: string;
      if (declaredSize > 1_000_000 || typeof data.content !== 'string') {
        // Contents API 对大于 1 MB 的文件可能不返回 Base64 content；使用
        // raw 媒体类型读取，并在本地再次执行字节上限校验。
        const rawUrl = typeof data.download_url === 'string' && data.download_url.startsWith('https://raw.githubusercontent.com/')
          ? data.download_url
          : url;
        const rawHeaders = this.getAuthHeaders(credentials);
        rawHeaders.set('Accept', 'application/vnd.github.raw+json');
        const rawResponse = await this.fetchWithRetryClassification(rawUrl, {
          method: 'GET',
          headers: rawHeaders,
        }, '获取大文件内容');
        if (!rawResponse.ok) await this.throwForErrorResponse(rawResponse, '获取大文件内容');
        content = await rawResponse.text();
        if (new TextEncoder().encode(content).byteLength > this.maxFileBytes) {
          throw new GitHubApiError(413, `备份文件超过安全上限 ${this.maxFileBytes} 字节`);
        }
      } else {
        // GitHub 返回的内容是 Base64 编码的。
        content = decodeURIComponent(escape(atob(data.content)));
      }
      
      return {
        content,
        sha: typeof data.sha === 'string' ? data.sha : '',
        metadata: {
          name: data.name,
          path: data.path,
          size: declaredSize,
          url: data.html_url,
          downloadUrl: data.download_url
        }
      };
    } catch (error) {
      console.error('Getting file content failed:', error);
      throw error;
    }
  }

  /**
   * 判断仓库是否存在
   * @param credentials GitHub凭据
   * @param owner 仓库所有者用户名
   * @param repo 仓库名称
   * @returns 仓库是否存在
   */
  async repoExists(
    credentials: GitHubCredentials,
    owner: string,
    repo: string
  ): Promise<boolean> {
    const headers = this.getAuthHeaders(credentials);
    const url = `${this.baseUrl}/repos/${this.encodePathSegments(owner)}/${this.encodePathSegments(repo)}`;
    
    try {
      const response = await this.fetchWithRetryClassification(url, {
        method: 'GET',
        headers
      }, '检查仓库是否存在');
      
      if (response.ok) {
        return true;
      }
      
      // 404 表示仓库确实不存在
      if (response.status === 404) {
        return false;
      }
      
      // 其余非 ok（429/5xx 等）抛出结构化错误，交由调用方按类型判定可重试性
      await this.throwForErrorResponse(response, '检查仓库是否存在');
      return false;
    } catch (error) {
      // 网络错误已由 fetchWithRetryClassification 包装为 RetryableError(NETWORK)，
      // 此处不再吞掉错误返回 false（避免误判为仓库不存在而白调 createRepo），而是向上抛出
      console.error('Checking repo existence failed:', error);
      throw error;
    }
  }

  /**
   * 创建新仓库
   * @param credentials GitHub凭据
   * @param name 仓库名称
   * @param isPrivate 是否为私有仓库
   * @returns 创建的仓库信息
   */
  async createRepo(
    credentials: GitHubCredentials,
    name: string,
    isPrivate: boolean = true
  ): Promise<any> {
    const headers = this.getAuthHeaders(credentials);
    const url = `${this.baseUrl}/user/repos`;
    
    const body = {
      name,
      private: isPrivate,
      auto_init: true, // 自动初始化仓库
      description: 'MarksVault书签备份仓库'
    };
    
    try {
      const response = await this.fetchWithRetryClassification(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      }, '创建仓库');
      
      if (!response.ok) {
        const errorData = await response.json();
        
        // 特殊处理422错误 - 仓库名称已存在
        if (response.status === 422 && 
            errorData.errors && 
            errorData.errors.some((e: any) => e.code === 'custom' && e.field === 'name' && e.message.includes('already exists'))) {
          
          console.log('仓库名称已存在，尝试获取现有仓库');
          
          // 尝试获取现有仓库信息
          try {
            const ownerResponse = await this.validateCredentials(credentials);
            const ownerName = ownerResponse.login;
            
            const existingRepoResponse = await this.fetchWithRetryClassification(
              `${this.baseUrl}/repos/${this.encodePathSegments(ownerName)}/${this.encodePathSegments(name)}`,
              {
                method: 'GET',
                headers
              },
              '获取现有仓库信息'
            );
            
            if (existingRepoResponse.ok) {
              const repoData = await existingRepoResponse.json();
              console.log('已成功获取现有仓库信息');
              
              // 返回现有仓库的信息，添加一个标记表示这是现有仓库
              return {
                ...repoData,
                _repoExisted: true
              };
            }
          } catch (fetchError) {
            console.error('获取现有仓库失败:', fetchError);
            // 网络错误已包装为 RetryableError(NETWORK)，保留可重试性向上抛出；
            // 其余错误（如凭据无效的 GitHubApiError）维持原逻辑，继续抛原始 422
            if (fetchError instanceof RetryableError) {
              throw fetchError;
            }
          }
        }
        
        await this.throwForErrorResponse(response, '创建仓库', errorData);
      }
      
      return await response.json();
    } catch (error) {
      console.error('Creating repo failed:', error);
      throw error;
    }
  }

  /**
   * 获取仓库中的所有文件列表
   * @param credentials GitHub凭据
   * @param owner 仓库所有者用户名
   * @param repo 仓库名称
   * @param path 可选的目录路径
   * @returns 文件列表
   */
  async getRepositoryFiles(
    credentials: GitHubCredentials,
    owner: string,
    repo: string,
    path: string = ''
  ): Promise<Array<{name: string; path: string; sha: string; size: number; url: string; download_url: string; type: string}>> {
    const headers = this.getAuthHeaders(credentials);
    // 添加缓存控制头，确保每次都获取最新数据
    headers.append('Cache-Control', 'no-cache');
    headers.append('Pragma', 'no-cache');
    
    try {
      const files: Array<{name: string; path: string; sha: string; size: number; url: string; download_url: string; type: string}> = [];
      const timestamp = Date.now();
      for (let page = 1; page <= 100; page += 1) {
        const url = `${this.baseUrl}/repos/${this.encodePathSegments(owner)}/${this.encodePathSegments(repo)}/contents/${this.encodePathSegments(path)}?per_page=100&page=${page}&timestamp=${timestamp}`;
        const response = await this.fetchWithRetryClassification(url, {
          method: 'GET',
          headers
        }, '获取仓库文件列表');
        if (!response.ok) await this.throwForErrorResponse(response, '获取仓库文件列表');
        const data = await response.json();
        if (!Array.isArray(data) || data.length === 0) break;
        files.push(...data);
        if (data.length < 100) break;
      }
      return files.filter(item => item.type === 'file');
    } catch (error) {
      console.error('Getting repository files failed:', error);
      throw error;
    }
  }

  /**
   * 删除仓库中的文件
   * @param credentials GitHub凭据
   * @param owner 仓库所有者用户名
   * @param repo 仓库名称
   * @param path 文件路径
   * @param message 提交消息
   * @param sha 文件的SHA标识符，必需
   * @returns 删除操作的结果
   */
  async deleteFile(
    credentials: GitHubCredentials,
    owner: string,
    repo: string,
    path: string,
    message: string,
    sha: string
  ): Promise<any> {
    const headers = this.getAuthHeaders(credentials);
    const url = `${this.baseUrl}/repos/${this.encodePathSegments(owner)}/${this.encodePathSegments(repo)}/contents/${this.encodePathSegments(path)}`;
    
    const body = {
      message,
      sha
    };
    
    try {
      const response = await this.fetchWithRetryClassification(url, {
        method: 'DELETE',
        headers,
        body: JSON.stringify(body)
      }, '删除文件');
      
      if (!response.ok) {
        await this.throwForErrorResponse(response, '删除文件');
      }
      
      return await response.json();
    } catch (error) {
      console.error('Deleting file failed:', error);
      throw error;
    }
  }
}

export default GitHubService.getInstance();
