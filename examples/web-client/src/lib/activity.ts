/**
 * Activity feed projection: audit rows in, one sentence per operation (one request) out.
 *
 * A mutation recorded under another mutation's entity belongs to it, so a post carries the tags
 * linked while publishing it and a deleted post the comments removed with it. Sentences are built
 * from the contexts captured at write time, so a feed shows what was true then and needs no further query.
 */

import type { AuditAction, AuditLog } from './api';
import { actorName, groupByRequest, type Mutation, type RequestGroup } from './audit';
import { plural } from './plural';

export type Perspective = { kind: 'everything' } | { kind: 'aggregate'; type: string; id: string };

export type ActivityTag = { name: string; created: boolean };

export type Phrase = {
  actor: string;
  predicate: string;
  quote: string | null;
  tags: ActivityTag[];
  details: string[];
  /** Nothing changed: shown, but de-emphasized */
  quiet: boolean;
};

export type Activity = {
  id: string;
  at: string;
  action: AuditAction;
  request: { method: string; path: string } | null;
  phrase: Phrase;
  /** Every mutation of the operation, the primary one first */
  mutations: Mutation[];
  rowCount: number;
};

/**
 * Which root names an operation when several are left, first wins. In this demo a tag is only
 * created as a side effect of tagging a post, so it ranks last
 */
const ENTITY_RANK = ['Post', 'Comment', 'PostLike', 'User', 'Profile', 'PostTag', 'Tag'];

const LABEL_LENGTH = 56;

const primaryRow = (mutation: Mutation): AuditLog => {
  const first = mutation.projections[0];
  if (!first) throw new Error(`Mutation ${mutation.key} has no rows`);
  return first;
};

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const field = (mutation: Mutation, key: string) => {
  const row = primaryRow(mutation);
  return text(row.after?.[key]) ?? text(row.before?.[key]);
};

const entityField = (mutation: Mutation, key: string) => text(primaryRow(mutation).entityContext?.[key]);

const changedFields = (mutation: Mutation) => Object.keys(primaryRow(mutation).changes ?? {});

const refKey = (type: string, id: string) => `${type}:${id}`;

/** Whether `child` was also recorded under the entity `parent` wrote */
const belongsTo = (child: Mutation, parent: Mutation) =>
  child !== parent &&
  child.projections.some((row) => row.aggregateType === parent.entityType && row.aggregateId === parent.entityId);

const rankOf = (mutation: Mutation) => {
  const index = ENTITY_RANK.indexOf(mutation.entityType);
  return index === -1 ? ENTITY_RANK.length : index;
};

const labelsOf = (mutations: Mutation[]) => {
  const labels = new Map<string, string>();
  const offer = (type: string, id: string | null, label: string | null) => {
    if (id && label && !labels.has(refKey(type, id))) labels.set(refKey(type, id), label);
  };
  for (const mutation of mutations) {
    for (const row of mutation.projections)
      offer(row.aggregateType, row.aggregateId, text(row.aggregateContext?.label));
  }
  for (const mutation of mutations) {
    const label =
      field(mutation, 'title') ??
      field(mutation, 'name') ??
      entityField(mutation, 'excerpt') ??
      entityField(mutation, 'tag');
    offer(mutation.entityType, mutation.entityId, label);
    offer('Post', field(mutation, 'postId'), entityField(mutation, 'postTitle'));
    offer('Tag', field(mutation, 'tagId'), entityField(mutation, 'tag'));
  }
  return labels;
};

const clip = (label: string) => (label.length > LABEL_LENGTH ? `${label.slice(0, LABEL_LENGTH - 1)}…` : label);

const list = new Intl.ListFormat('en', { type: 'conjunction' });

const pastTense: Record<AuditAction, string> = { create: 'created', update: 'updated', delete: 'deleted' };

const DELETED_WITH: [type: string, noun: string][] = [
  ['Comment', 'comment'],
  ['PostLike', 'like'],
  ['PostTag', 'tag'],
];

type Predicate = Partial<Omit<Phrase, 'actor' | 'predicate'>> & { predicate: string };

type PhraseContext = {
  perspective: Perspective;
  labels: Map<string, string>;
  actorId: string;
  contained: Mutation[];
};

const isViewed = (context: PhraseContext, type: string, id: string | null) =>
  context.perspective.kind === 'aggregate' && context.perspective.type === type && context.perspective.id === id;

const postRef = (context: PhraseContext, postId: string | null) => {
  if (isViewed(context, 'Post', postId)) return 'this post';
  const label = postId ? context.labels.get(refKey('Post', postId)) : undefined;
  return label ? `“${clip(label)}”` : 'a post';
};

const userName = (context: PhraseContext, userId: string | null) =>
  (userId ? context.labels.get(refKey('User', userId)) : undefined) ?? 'someone';

const possessive = (context: PhraseContext, userId: string | null) =>
  userId === context.actorId ? 'their' : `${userName(context, userId)}’s`;

const tagOf = (context: PhraseContext, mutation: Mutation) =>
  entityField(mutation, 'tag') ?? context.labels.get(refKey('Tag', field(mutation, 'tagId') ?? '')) ?? 'a tag';

const containedOf = (context: PhraseContext, type: string, action: AuditAction) =>
  context.contained.filter((mutation) => mutation.entityType === type && mutation.action === action);

const phrasers: Record<string, (mutation: Mutation, context: PhraseContext) => Predicate> = {
  Post: (post, context) => {
    const ref = postRef(context, post.entityId);
    const excerpt = entityField(post, 'excerpt');
    switch (post.action) {
      case 'create':
        return {
          predicate: ref === 'this post' ? 'created this post' : 'posted',
          quote: ref === 'this post' ? null : excerpt,
          tags: containedOf(context, 'PostTag', 'create')
            .map((link) => ({ name: tagOf(context, link), created: false }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        };
      case 'update': {
        const unchanged = changedFields(post).length === 0;
        return {
          predicate: `edited ${ref}`,
          quote: excerpt,
          quiet: unchanged,
          details: unchanged ? ['No field changed'] : [],
        };
      }
      case 'delete': {
        const removed = DELETED_WITH.map(([type, noun]) => [containedOf(context, type, 'delete').length, noun] as const)
          .filter(([count]) => count > 0)
          .map(([count, noun]) => plural(count, noun));
        return {
          predicate: `deleted ${ref}`,
          details: removed.length > 0 ? [`Along with ${list.format(removed)}`] : [],
        };
      }
    }
  },
  Comment: (comment, context) => {
    const postId = field(comment, 'postId');
    const on = isViewed(context, 'Post', postId) ? '' : ` on ${postRef(context, postId)}`;
    const verbs: Record<AuditAction, string> = {
      create: 'commented',
      update: 'edited a comment',
      delete: 'deleted a comment',
    };
    return { predicate: `${verbs[comment.action]}${on}`, quote: entityField(comment, 'excerpt') };
  },
  PostLike: (like, context) => {
    const ref = postRef(context, field(like, 'postId'));
    return { predicate: like.action === 'delete' ? `unliked ${ref}` : `liked ${ref}` };
  },
  PostTag: (link, context) => {
    const ref = postRef(context, field(link, 'postId'));
    const tag = tagOf(context, link);
    return link.action === 'delete'
      ? { predicate: `removed #${tag} from ${ref}` }
      : { predicate: `tagged ${ref}`, tags: [{ name: tag, created: false }] };
  },
  Tag: (tag, context) => ({
    predicate: `${pastTense[tag.action]} the tag #${context.labels.get(refKey('Tag', tag.entityId)) ?? tag.entityId}`,
  }),
  User: (user, context) => {
    if (user.action === 'create') {
      return {
        predicate: isViewed(context, 'User', user.entityId)
          ? 'created this account'
          : `created the account of ${userName(context, user.entityId)}`,
        details: containedOf(context, 'Profile', 'create').length > 0 ? ['With a bio'] : [],
      };
    }
    if (user.action === 'delete') return { predicate: `deleted the account of ${userName(context, user.entityId)}` };
    const aspects = [
      ...changedFields(user),
      ...(context.contained.some((mutation) => mutation.entityType === 'Profile') ? ['bio'] : []),
    ];
    const whose = possessive(context, user.entityId);
    if (aspects.length === 0)
      return { predicate: `saved ${whose} account`, quiet: true, details: ['No field changed'] };
    if (aspects.length === 1 && aspects[0] === 'password') return { predicate: `changed ${whose} password` };
    return { predicate: `updated ${whose} ${list.format(aspects)}` };
  },
  Profile: (profile, context) => {
    const whose = possessive(context, field(profile, 'userId'));
    return profile.action === 'delete'
      ? { predicate: `removed ${whose} bio` }
      : { predicate: `updated ${whose} bio`, quote: field(profile, 'bio') };
  },
};

const phraseOf = (mutation: Mutation, context: PhraseContext): Predicate =>
  phrasers[mutation.entityType]?.(mutation, context) ?? {
    predicate: `${pastTense[mutation.action]} a ${mutation.entityType}`,
  };

/** Closure of the mutations recorded under `root`, directly or through another contained one */
const containedIn = (root: Mutation, mutations: Mutation[]) => {
  const contained: Mutation[] = [];
  const queue = [root];
  for (let parent = queue.shift(); parent; parent = queue.shift()) {
    for (const mutation of mutations) {
      if (mutation !== root && !contained.includes(mutation) && belongsTo(mutation, parent)) {
        contained.push(mutation);
        queue.push(mutation);
      }
    }
  }
  return contained;
};

export const activityOf = (group: RequestGroup, perspective: Perspective): Activity | null => {
  const { mutations } = group;
  const roots = mutations.filter((mutation) => !mutations.some((parent) => belongsTo(mutation, parent)));
  const candidates = roots.length > 0 ? roots : mutations;
  // An update that changed nothing and carries nothing names the operation only when nothing else can
  const hollow = (mutation: Mutation) =>
    mutation.action === 'update' &&
    changedFields(mutation).length === 0 &&
    !mutations.some((child) => belongsTo(child, mutation));
  const [primary, ...siblings] = [...candidates].sort(
    (a, b) => Number(hollow(a)) - Number(hollow(b)) || rankOf(a) - rankOf(b),
  );
  if (!primary) return null;

  const row = primaryRow(primary);
  const context: PhraseContext = {
    perspective,
    labels: labelsOf(mutations),
    actorId: row.actorId,
    contained: containedIn(primary, mutations),
  };
  const predicate = phraseOf(primary, context);
  const tags = [...(predicate.tags ?? [])];
  const details = [...(predicate.details ?? [])];

  for (const sibling of siblings) {
    const name = sibling.entityType === 'Tag' ? context.labels.get(refKey('Tag', sibling.entityId)) : undefined;
    const tag = tags.find((candidate) => candidate.name === name);
    if (tag && sibling.action === 'create') {
      tag.created = true;
      continue;
    }
    details.push(`Also ${phraseOf(sibling, { ...context, contained: containedIn(sibling, mutations) }).predicate}`);
  }

  return {
    id: group.requestId,
    at: row.createdAt,
    action: primary.action,
    request: group.method ? { method: group.method, path: group.path } : null,
    phrase: {
      actor: actorName(row),
      predicate: predicate.predicate,
      quote: predicate.quote ?? null,
      tags,
      details,
      quiet: predicate.quiet ?? false,
    },
    mutations: [primary, ...mutations.filter((mutation) => mutation !== primary)],
    rowCount: group.rowCount,
  };
};

/** Activities, newest first */
export const toActivities = (logs: AuditLog[], perspective: Perspective): Activity[] =>
  groupByRequest(logs)
    .map((group) => activityOf(group, perspective))
    .filter((activity): activity is Activity => activity !== null)
    .sort((a, b) => b.at.localeCompare(a.at));
