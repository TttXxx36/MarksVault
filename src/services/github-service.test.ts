import githubService, { GitHubApiError, RetryableError, RetryableErrorCategory, getGitHubErrorMetadata } from './github-service';

describe('github-service.validateCredentials', () => {
  beforeEach(() => {
    (global as any).fetch = jest.fn();
  });

  test('成功返回用户信息', async () => {
    (global as any).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ login: 'alice' }),
    });

    const user = await githubService.validateCredentials({ token: 'test-token' } as any);
    expect(user.login).toBe('alice');
    const request = (global as any).fetch.mock.calls[0][1];
    expect(request.headers.get('Accept')).toBe('application/vnd.github+json');
    expect(request.headers.get('Authorization')).toBe('Bearer test-token');
    expect(request.headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
  });

  test('失败时抛出 GitHubApiError 并携带 status/data', async () => {
    (global as any).fetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Bad credentials' }),
    });

    await expect(
      githubService.validateCredentials({ token: 'bad-token' } as any),
    ).rejects.toMatchObject<Partial<GitHubApiError>>({
      name: 'GitHubApiError',
      status: 401,
      data: { message: 'Bad credentials' },
    });
  });

  test('限流错误暴露结构化 Retry-After 与配额元数据，并限制等待上限', async () => {
    (global as any).fetch.mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '120', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' }),
      json: async () => ({ message: 'rate limited' }),
    });

    const error = await githubService.validateCredentials({ token: 'fake-token' } as any).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(RetryableError);
    expect(error).toMatchObject({ category: RetryableErrorCategory.RATE_LIMIT });
    expect(getGitHubErrorMetadata(error)).toEqual({
      status: 429,
      retryAfterSeconds: 60,
      remaining: 0,
      resetAt: 1700000000000,
    });
  });

  test('分页读取文件并过滤目录项', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ name: `b-${index}.json`, path: `b-${index}.json`, sha: `s-${index}`, size: 1, url: '', download_url: '', type: 'file' }));
    const secondPage = [{ name: 'last.json', path: 'last.json', sha: 'last', size: 1, url: '', download_url: '', type: 'file' }];
    (global as any).fetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => firstPage })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => secondPage });

    const files = await githubService.getRepositoryFiles({ token: 'fake' } as any, 'owner#name', 'repo 1', 'folder/a#b');
    expect(files).toHaveLength(101);
    expect((global as any).fetch.mock.calls[0][0]).toContain('owner%23name');
    expect((global as any).fetch.mock.calls[0][0]).toContain('repo%201');
    expect((global as any).fetch.mock.calls[0][0]).toContain('folder/a%23b');
    expect((global as any).fetch.mock.calls[1][0]).toContain('page=2');
  });

  test('大文件使用 raw 响应并限制读取大小', async () => {
    (global as any).fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ size: 1_000_001, sha: 'sha-large', download_url: 'https://raw.githubusercontent.com/owner/repo/main/file.json' }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{"ok":true}' });

    const result = await githubService.getFileContent({ token: 'fake' } as any, 'owner', 'repo', 'file.json');
    expect(result.content).toBe('{"ok":true}');
    expect((global as any).fetch.mock.calls[1][1].headers.get('Accept')).toBe('application/vnd.github.raw+json');
  });

  test('写入冲突时只重新读取 SHA 并有限重试', async () => {
    (global as any).fetch
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ message: 'conflict' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ sha: 'latest-sha' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ content: { sha: 'written' } }) });

    await githubService.createOrUpdateFile({ token: 'fake' } as any, 'owner', 'repo', 'file.json', '{}', 'update');
    expect((global as any).fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse((global as any).fetch.mock.calls[2][1].body).sha).toBe('latest-sha');
  });
});
