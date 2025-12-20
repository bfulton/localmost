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
        return undefined as T;
      }
      return JSON.parse(text) as T;
    }

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({})) as Partial<GitHubApiError>;
      throw new GitHubClientError(
        errorBody.message || `GitHub API error: ${response.status} ${response.statusText}`,
        response.status,
        errorBody.documentation_url
      );
    }

    return response.json() as Promise<T>;
  }
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
