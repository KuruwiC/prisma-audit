// API response types for Prisma Audit Demo

export type User = {
  id: string;
  email: string;
  name: string | null;
  profile?: Profile | null;
  createdAt: string;
  updatedAt: string;
};

export type Profile = {
  id: string;
  userId: string;
  bio: string | null;
  avatar?: Avatar | null;
  createdAt: string;
  updatedAt: string;
};

export type Avatar = {
  id: string;
  profileId: string;
  name: string | null;
  avatarImage?: AvatarImage | null;
  createdAt: string;
  updatedAt: string;
};

export type AvatarImage = {
  id: string;
  avatarId: string;
  imageUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type Tag = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type PostTag = {
  id: string;
  postId: string;
  tagId: string;
  tag: Tag;
  createdAt: string;
  updatedAt: string;
};

export type Attachment = {
  id: string;
  fileUrl: string;
  fileName: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

export type PostAttachment = {
  id: string;
  postId: string;
  attachmentId: string;
  attachment: Attachment;
  createdAt: string;
  updatedAt: string;
};

export type CommentAttachment = {
  id: string;
  commentId: string;
  attachmentId: string;
  attachment: Attachment;
  createdAt: string;
  updatedAt: string;
};

export type Comment = {
  id: string;
  content: string;
  postId: string;
  authorId: string;
  author: User;
  commentAttachments?: CommentAttachment[];
  createdAt: string;
  updatedAt: string;
};

export type Post = {
  id: string;
  title: string;
  content: string | null;
  published: boolean;
  authorId: string;
  author: User;
  postTags?: PostTag[];
  postAttachments?: PostAttachment[];
  comments?: Comment[];
  createdAt: string;
  updatedAt: string;
};

export type AuditLog = {
  id: string;
  // Entity
  entityCategory: string;
  entityType: string;
  entityId: string;
  // biome-ignore lint/suspicious/noExplicitAny: JSON data from API
  entityContext: Record<string, any> | null;
  // Aggregate
  aggregateCategory: string;
  aggregateType: string;
  aggregateId: string;
  // biome-ignore lint/suspicious/noExplicitAny: JSON data from API
  aggregateContext: Record<string, any> | null;
  // Actor
  actorCategory: string;
  actorType: string;
  actorId: string;
  // biome-ignore lint/suspicious/noExplicitAny: JSON data from API
  actorContext: Record<string, any> | null;
  // Action
  action: string;
  // biome-ignore lint/suspicious/noExplicitAny: JSON data from API
  before: Record<string, any> | null;
  // biome-ignore lint/suspicious/noExplicitAny: JSON data from API
  after: Record<string, any> | null;
  // biome-ignore lint/suspicious/noExplicitAny: JSON data from API
  changes: Record<string, any> | null;
  // Request Context
  // biome-ignore lint/suspicious/noExplicitAny: JSON data from API
  requestContext: Record<string, any> | null;
  createdAt: string;
};

// Request types
export type LoginRequest = {
  email: string;
};

export type CreatePostRequest = {
  title: string;
  content: string;
  published: boolean;
  authorId: string;
  tags?: string[];
  attachments?: Array<{ fileUrl: string; fileName: string }>;
};

export type UpdatePostRequest = {
  title?: string;
  content?: string;
  published?: boolean;
  tags?: string[];
  attachments?: Array<{ fileUrl: string; fileName: string }>;
};

export type CreateCommentRequest = {
  content: string;
  authorId: string;
  attachmentIds?: string[];
};

export type CreateUserRequest = {
  email: string;
  name?: string;
};

export type UpdateUserRequest = {
  email?: string;
  name?: string;
  password?: string;
};

export type UpdateProfileRequest = {
  bio: string;
  avatar?: {
    name?: string;
    imageUrl?: string;
  };
};

export type SetAvatarRequest = {
  imageUrl: string;
  name?: string;
};

// Avatar and attachment image options
export type AvatarOption = {
  id: number;
  url: string;
};

export type AttachmentOption = {
  id: number;
  url: string;
  width: number;
  height: number;
};
