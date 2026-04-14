import { describe, expect, it } from 'vitest';
import { removeRelations } from './remove-relations';

describe('removeRelations', () => {
  describe('with relationFieldNames (precise removal)', () => {
    it('should remove specified relation fields while keeping scalar fields', () => {
      const input = {
        id: 'comment-1',
        postId: 'post-1',
        authorId: 'user-1',
        content: 'Hello World',
        createdAt: new Date('2024-01-01'),
        post: {
          id: 'post-1',
          title: 'Post Title',
          content: 'Post Content',
        },
        author: {
          id: 'user-1',
          name: 'John Doe',
          email: 'john@example.com',
        },
      };

      const result = removeRelations(input, new Set(['post', 'author']));

      expect(result).toEqual({
        id: 'comment-1',
        postId: 'post-1',
        authorId: 'user-1',
        content: 'Hello World',
        createdAt: new Date('2024-01-01'),
      });
    });

    it('should remove relation arrays', () => {
      const input = {
        id: 'post-1',
        title: 'Post Title',
        comments: [
          { id: 'comment-1', content: 'Comment 1' },
          { id: 'comment-2', content: 'Comment 2' },
        ],
      };

      const result = removeRelations(input, new Set(['comments']));

      expect(result).toEqual({
        id: 'post-1',
        title: 'Post Title',
      });
    });

    it('should handle complex nested structures', () => {
      const input = {
        id: 'post-1',
        title: 'Post',
        authorId: 'user-1',
        author: {
          id: 'user-1',
          name: 'John',
        },
        postTags: [
          {
            id: 'pt-1',
            postId: 'post-1',
            tagId: 'tag-1',
            tag: {
              id: 'tag-1',
              name: 'TypeScript',
            },
          },
        ],
        metadata: {
          views: 100,
          likes: 10,
          stats: {
            averageReadTime: 5,
            comments: 3,
          },
        },
      };

      const result = removeRelations(input, new Set(['author', 'postTags']));

      expect(result).toEqual({
        id: 'post-1',
        title: 'Post',
        authorId: 'user-1',
        metadata: {
          views: 100,
          likes: 10,
          stats: {
            averageReadTime: 5,
            comments: 3,
          },
        },
      });
    });

    it('should not mutate the original object', () => {
      const input = {
        id: 'comment-1',
        content: 'Hello',
        author: {
          id: 'user-1',
          name: 'John',
        },
      };

      const original = JSON.parse(JSON.stringify(input));
      removeRelations(input, new Set(['author']));

      expect(input).toEqual(original);
    });
  });

  describe('without relationFieldNames (no removal)', () => {
    it('should preserve all fields including nested objects', () => {
      const input = {
        id: 'comment-1',
        postId: 'post-1',
        content: 'Hello World',
        post: {
          id: 'post-1',
          title: 'Post Title',
        },
      };

      const result = removeRelations(input);

      expect(result).toEqual(input);
    });

    it('should preserve nested objects with id field', () => {
      const input = {
        id: 'user-1',
        settings: {
          id: 'settings-uuid',
          theme: 'dark',
          notifications: true,
        },
      };

      const result = removeRelations(input);

      expect(result).toEqual(input);
    });
  });

  describe('edge cases', () => {
    it('should preserve nested scalar objects without id field', () => {
      const input = {
        id: 'user-1',
        name: 'John',
        metadata: {
          lastLogin: new Date('2024-01-01'),
          loginCount: 5,
        },
      };

      const result = removeRelations(input, new Set([]));

      expect(result).toEqual(input);
    });

    it('should handle null and undefined values', () => {
      const input = {
        id: 'user-1',
        name: 'John',
        email: null,
        bio: undefined,
      };

      const result = removeRelations(input);

      expect(result).toEqual(input);
    });

    it('should handle empty objects and arrays', () => {
      const input = {
        id: 'user-1',
        metadata: {},
        tags: [],
      };

      const result = removeRelations(input);

      expect(result).toEqual(input);
    });

    it('should handle primitive values', () => {
      expect(removeRelations('string')).toBe('string');
      expect(removeRelations(123)).toBe(123);
      expect(removeRelations(true)).toBe(true);
      expect(removeRelations(null)).toBe(null);
      expect(removeRelations(undefined)).toBe(undefined);
    });

    it('should handle arrays of primitive values', () => {
      const input = {
        id: 'post-1',
        tags: ['javascript', 'typescript', 'node'],
      };

      const result = removeRelations(input);

      expect(result).toEqual(input);
    });
  });
});
