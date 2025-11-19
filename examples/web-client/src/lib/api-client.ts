import type {
  AuditLog,
  Comment,
  CreateCommentRequest,
  CreatePostRequest,
  CreateUserRequest,
  LoginRequest,
  Post,
  SetAvatarRequest,
  UpdatePostRequest,
  UpdateProfileRequest,
  UpdateUserRequest,
  User,
} from '../types/api';

// API client with actor context support
class ApiClient {
  private baseUrl: string;
  private actorId: string | null = null;
  private actorType: string | null = null;
  private actorName: string | null = null;

  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
  }

  setActorContext(actorId: string, actorType: string, actorName?: string) {
    this.actorId = actorId;
    this.actorType = actorType;
    this.actorName = actorName || null;
  }

  clearActorContext() {
    this.actorId = null;
    this.actorType = null;
    this.actorName = null;
  }

  private getHeaders(): HeadersInit {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    if (this.actorId && this.actorType) {
      headers['X-Actor-Id'] = this.actorId;
      headers['X-Actor-Type'] = this.actorType;
      if (this.actorName) {
        headers['X-Actor-Name'] = this.actorName;
      }
    }

    return headers;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = this.getHeaders();

    const response = await fetch(url, {
      ...options,
      headers: {
        ...headers,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API Error (${response.status}): ${error}`);
    }

    return response.json();
  }

  // Auth
  async login(data: LoginRequest): Promise<User> {
    return this.request<User>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Feed
  async getFeed(): Promise<Post[]> {
    return this.request<Post[]>('/feed');
  }

  // Posts
  async getPosts(): Promise<Post[]> {
    return this.request<Post[]>('/posts');
  }

  async createPost(data: CreatePostRequest): Promise<Post> {
    return this.request<Post>('/posts', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updatePost(id: string, data: UpdatePostRequest): Promise<Post> {
    return this.request<Post>(`/posts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deletePost(id: string): Promise<void> {
    return this.request<void>(`/posts/${id}`, {
      method: 'DELETE',
    });
  }

  // Comments
  async getComments(postId: string): Promise<Comment[]> {
    return this.request<Comment[]>(`/posts/${postId}/comments`);
  }

  async createComment(postId: string, data: CreateCommentRequest): Promise<Comment> {
    return this.request<Comment>(`/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async deleteComment(id: string): Promise<void> {
    return this.request<void>(`/comments/${id}`, {
      method: 'DELETE',
    });
  }

  // Users
  async getUsers(): Promise<User[]> {
    return this.request<User[]>('/users');
  }

  async createUser(data: CreateUserRequest): Promise<User> {
    return this.request<User>('/users', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateUser(id: string, data: UpdateUserRequest): Promise<User> {
    return this.request<User>(`/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteUser(id: string): Promise<void> {
    return this.request<void>(`/users/${id}`, {
      method: 'DELETE',
    });
  }

  // Profiles
  async getProfile(userId: string): Promise<User> {
    return this.request<User>(`/profiles/${userId}`);
  }

  async updateProfile(userId: string, data: UpdateProfileRequest): Promise<User> {
    return this.request<User>(`/profiles/${userId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async setAvatar(userId: string, data: SetAvatarRequest): Promise<User> {
    return this.request<User>(`/profiles/${userId}/avatar`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Tags
  async getTags(): Promise<{ id: string; name: string; createdAt: string; updatedAt: string }[]> {
    return this.request('/tags');
  }

  async getTag(id: string): Promise<{ id: string; name: string; createdAt: string; updatedAt: string }> {
    return this.request(`/tags/${id}`);
  }

  async addTagsToPost(postId: string, tagNames: string[]): Promise<Post> {
    return this.request<Post>(`/posts/${postId}/tags`, {
      method: 'POST',
      body: JSON.stringify({ tagNames }),
    });
  }

  // Attachments
  async createAttachment(data: { fileUrl: string; fileName: string; ownerId: string }): Promise<{ id: string }> {
    return this.request<{ id: string }>('/attachments', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Audit Logs
  async getAuditLogs(params?: {
    entityType?: string;
    action?: string;
    aggregateType?: string;
    aggregateId?: string;
  }): Promise<AuditLog[]> {
    const queryParams = new URLSearchParams();
    if (params?.entityType) queryParams.append('entityType', params.entityType);
    if (params?.action) queryParams.append('action', params.action);
    if (params?.aggregateType) queryParams.append('aggregateType', params.aggregateType);
    if (params?.aggregateId) queryParams.append('aggregateId', params.aggregateId);

    const query = queryParams.toString();
    return this.request<AuditLog[]>(`/audit-logs${query ? `?${query}` : ''}`);
  }
}

export const apiClient = new ApiClient();
