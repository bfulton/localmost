/**
 * Low-level GitHub API client that handles HTTP requests with consistent
 * error handling, authentication, and response parsing.
 *
 * This class deduplicates the fetch patterns used throughout GitHubAuth.
 */

export interface GitHubApiError {
  message: string;
  status: number;
  documentation_url?: string;
}

export class GitHubClientError extends Error {
  public readonly status: number;
  public readonly documentationUrl?: string;

  constructor(message: string, status: number, documentationUrl?: string) {
    super(message);
    this.name = 'GitHubClientError';
    this.status = status;
    this.documentationUrl = documentationUrl;
  }
}

/**
 * GitHub API client with built-in authentication and error handling.
 *
 * Usage:
 * ```typescript
 * const client = new GitHubClient(accessToken);
 * const user = await client.get<GitHubUser>('/user');
 * await client.post('/repos/owner/repo/actions/runners/registration-token');
 * await client.delete('/repos/owner/repo/actions/runners/123');
 * ```
 */
export class GitHubClient {
  private static readonly BASE_URL = 'https://api.github.com';
  private static readonly ACCEPT_HEADER = 'application/vnd.github.v3+json';

  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  /**
   * Update the access token (e.g., after refresh).
   */
  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  /**
   * Make a GET request to the GitHub API.
   */
  async get<T>(endpoint: string, options?: { params?: Record<string, string> }): Promise<T> {
    let url = `${GitHubClient.BASE_URL}${endpoint}`;

    if (options?.params) {
      const searchParams = new URLSearchParams(options.params);
      url += `?${searchParams.toString()}`;
    }

    return this.request<T>('GET', url);
  }

  /**
   * GET one page of a list that GitHub paginates with a cursor in the Link
   * header, as the repository activity endpoint does.
   *
   * Returns the page, the query parameters of the `rel="next"` link (to be
   * sent to the same endpoint for the next page; null on the last page), and
   * the response's Date header, GitHub's clock at the time of the read.
   * Only the next link's parameters are used, never its URL, so the token is
   * only ever sent to this client's API host.
   */
  async getPage<T>(
    endpoint: string,
    params: Record<string, string>
  ): Promise<{ data: T; next: Record<string, string> | null; date: Date | null }> {
    const url = `${GitHubClient.BASE_URL}${endpoint}?${new URLSearchParams(params).toString()}`;
    const { data, headers } = await this.send<T>('GET', url);
    const dateHeader = headers.get('date');
    const date = dateHeader ? new Date(dateHeader) : null;
    return {
      data,
      next: nextLinkParams(headers.get('link')),
      date: date && !Number.isNaN(date.getTime()) ? date : null,
    };
  }

  /**
   * Make a POST request to the GitHub API.
   */
  async post<T>(endpoint: string, body?: unknown): Promise<T> {
    const url = `${GitHubClient.BASE_URL}${endpoint}`;
    return this.request<T>('POST', url, body);
  }

  /**
   * Make a PUT request to the GitHub API.
   */
  async put<T>(endpoint: string, body?: unknown): Promise<T> {
    const url = `${GitHubClient.BASE_URL}${endpoint}`;
    return this.request<T>('PUT', url, body);
  }

  /**
   * Make a PATCH request to the GitHub API.
   */
  async patch<T>(endpoint: string, body?: unknown): Promise<T> {
    const url = `${GitHubClient.BASE_URL}${endpoint}`;
    return this.request<T>('PATCH', url, body);
  }

  /**
   * Make a DELETE request to the GitHub API.
   */
  async delete(endpoint: string): Promise<void> {
    const url = `${GitHubClient.BASE_URL}${endpoint}`;
    await this.request<void>('DELETE', url);
  }

  /**
   * Internal request method with authentication and error handling.
   */
  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    return (await this.send<T>(method, url, body)).data;
  }

  /**
   * Send a request and return the parsed body with the response headers.
   */
  private async send<T>(method: string, url: string, body?: unknown): Promise<{ data: T; headers: Headers }> {
    const headers: Record<string, string> = {
      Accept: GitHubClient.ACCEPT_HEADER,
      Authorization: `Bearer ${this.accessToken}`,
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    // Handle successful responses with no content
    if (response.status === 204 || response.status === 201) {
      // For 204 No Content or 201 Created without body
      const text = await response.text();
      if (!text) {
        return { data: undefined as T, headers: response.headers };
      }
      return { data: JSON.parse(text) as T, headers: response.headers };
    }

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({})) as Partial<GitHubApiError>;
      throw new GitHubClientError(
        errorBody.message || `GitHub API error: ${response.status} ${response.statusText}`,
        response.status,
        errorBody.documentation_url
      );
    }

    return { data: (await response.json()) as T, headers: response.headers };
  }
}

/**
 * The query parameters of the `rel="next"` link in a Link header, or null
 * when there is none.
 */
export function nextLinkParams(link: string | null): Record<string, string> | null {
  if (!link) {
    return null;
  }
  for (const part of link.split(',')) {
    const match = /^\s*<([^>]*)>\s*;(.*)$/.exec(part);
    if (!match || !/(^|;)\s*rel="?next"?\s*(;|$)/.test(match[2])) {
      continue;
    }
    const params: Record<string, string> = {};
    for (const [key, value] of new URL(match[1]).searchParams) {
      params[key] = value;
    }
    return params;
  }
  return null;
}

/**
 * Make an unauthenticated request to GitHub (for OAuth flows).
 * Used for device flow and token exchange where we don't have an access token yet.
 */
export async function githubOAuthRequest<T>(
  endpoint: string,
  body: Record<string, string>
): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  return response.json() as Promise<T>;
}
