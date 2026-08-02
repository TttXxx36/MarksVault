import { GitHubCredentials, GitHubUser } from '../types/github';

export class GitHubApiError extends Error {
  public readonly status: number;
  public readonly data?: unknown;

  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.data = data;
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

/**
 * 可重试错误
 * 明确标记为临时性失败：可在执行租约有效期内重试
 */
export class RetryableError extends Error {
  public readonly category: RetryableErrorCategory;

  constructor(category: RetryableErrorCategory, message: string) {
    super(message);
    this.name = 'RetryableError';
    this.category = category;
  }
}

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
  private baseUrl = 'https://api.github.com';
  
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
    headers.append('Accept', 'application/vnd.github.v3+json');
    headers.append('Authorization', `token ${credentials.token}`);
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
    try {
      return await fetch(url, init);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new RetryableError(RetryableErrorCategory.NETWORK, `${context}网络错误: ${error.message}`);
      }
      throw error;
    }
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
    const message = `${context}失败: ${response.status}${errorData !== undefined ? ` - ${JSON.stringify(errorData)}` : ''}`;
    if (response.status === 429 || response.status >= 500) {
      throw new RetryableError(
        response.status === 429 ? RetryableErrorCategory.RATE_LIMIT : RetryableErrorCategory.SERVER,
        message
      );
    }
    // GitHub primary rate limit 返回 403 且响应体 message 含 "API rate limit exceeded"，
    // 与凭据错误等不可重试的 403 无法仅凭状态码区分，因此这是唯一依据响应体消息字符串做判定的例外
    const errorMessage = (errorData as { message?: unknown } | undefined)?.message;
    if (response.status === 403 &&
        typeof errorMessage === 'string' &&
        errorMessage.toLowerCase().includes('rate limit')) {
      throw new RetryableError(RetryableErrorCategory.RATE_LIMIT, message);
    }
    throw new GitHubApiError(response.status, message, errorData);
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
    const url = `${this.baseUrl}/repos/${owner}/${repo}/contents/${this.encodePathSegments(path)}`;
    
    // Base64编码内容
    const contentEncoded = btoa(unescape(encodeURIComponent(content)));
    
    const body: any = {
      message,
      content: contentEncoded,
    };
    
    // 如果提供了SHA，添加到请求体中（表示更新现有文件）
    if (sha) {
      body.sha = sha;
    }
    
    try {
      const response = await this.fetchWithRetryClassification(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body)
      }, '创建或更新文件');
      
      if (!response.ok) {
        await this.throwForErrorResponse(response, '创建或更新文件');
      }
      
      return await response.json();
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
    const url = `${this.baseUrl}/repos/${owner}/${repo}/contents/${this.encodePathSegments(path)}`;
    
    try {
      const response = await this.fetchWithRetryClassification(url, {
        method: 'GET',
        headers
      }, '获取文件内容');
      
      if (!response.ok) {
        await this.throwForErrorResponse(response, '获取文件内容');
      }
      
      const data = await response.json();
      
      // GitHub返回的内容是Base64编码的
      const content = decodeURIComponent(escape(atob(data.content)));
      
      return {
        content,
        sha: data.sha,
        metadata: {
          name: data.name,
          path: data.path,
          size: data.size,
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
    const url = `${this.baseUrl}/repos/${owner}/${this.encodePathSegments(repo)}`;
    
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
              `${this.baseUrl}/repos/${ownerName}/${this.encodePathSegments(name)}`,
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
    
    // 添加时间戳参数到URL，避免缓存（仅编码路径段，query 部分保持原样）
    const timestamp = new Date().getTime();
    const url = `${this.baseUrl}/repos/${owner}/${this.encodePathSegments(repo)}/contents/${this.encodePathSegments(path)}?timestamp=${timestamp}`;
    
    try {
      const response = await this.fetchWithRetryClassification(url, {
        method: 'GET',
        headers
      }, '获取仓库文件列表');
      
      if (!response.ok) {
        await this.throwForErrorResponse(response, '获取仓库文件列表');
      }
      
      const data = await response.json();
      
      // 过滤只返回文件（不包括目录）
      return Array.isArray(data) 
        ? data.filter(item => item.type === 'file') 
        : [];
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
    const url = `${this.baseUrl}/repos/${owner}/${this.encodePathSegments(repo)}/contents/${this.encodePathSegments(path)}`;
    
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
