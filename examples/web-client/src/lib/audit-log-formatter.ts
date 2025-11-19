import type { AuditLog } from '../types/api';

/**
 * Type guard to check if value is a valid object
 */
const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

/**
 * Extract a string value from a property if it exists and has a value
 */
const getStringValue = (context: Record<string, unknown>, key: string): string | null => {
  if (key in context && context[key]) {
    return String(context[key]);
  }
  return null;
};

/**
 * Extract display name from a context object or data
 */
const getDisplayName = (context: Record<string, unknown> | null | undefined, fallback: string): string => {
  if (!isRecord(context)) return fallback;

  // Try common name fields in priority order
  const displayName = getStringValue(context, 'displayName');
  if (displayName) return displayName;

  const name = getStringValue(context, 'name');
  if (name) return name;

  const title = getStringValue(context, 'title');
  if (title) return title;

  const email = getStringValue(context, 'email');
  if (email) return email;

  const fileName = getStringValue(context, 'fileName');
  if (fileName) return fileName;

  const content = getStringValue(context, 'content');
  if (content) {
    // For comments, show first 50 chars as preview
    return content.length > 50 ? `${content.substring(0, 50)}...` : content;
  }

  if ('bio' in context && context.bio) return 'Profile';

  return fallback;
};

/**
 * Extract actor display name from actorContext or fallback to actorId
 */
const getActorName = (log: AuditLog): string => {
  if (isRecord(log.actorContext)) {
    const name = getDisplayName(log.actorContext, '');
    if (name) return name;
  }
  return log.actorId;
};

/**
 * Try to extract name from nested relation in data
 */
const tryGetNestedRelationName = (
  data: Record<string, unknown>,
  relationKey: string,
  expectedId: string,
): string | null => {
  if (!(relationKey in data) || !isRecord(data[relationKey])) {
    return null;
  }

  const relationData = data[relationKey];
  // Verify this is the same aggregate by checking ID
  if (!('id' in relationData) || relationData.id !== expectedId) {
    return null;
  }

  return getDisplayName(relationData, '');
};

/**
 * Type-specific field lookup for aggregateContext
 */
const AGGREGATE_CONTEXT_FIELD_MAP: Record<string, string[]> = {
  Tag: ['name'],
  Post: ['name'],
  User: ['name'],
};

/**
 * Type-specific relation field lookup for data extraction
 */
const AGGREGATE_RELATION_FIELD_MAP: Record<string, string[]> = {
  User: ['author', 'user'],
  Post: ['post'],
  Tag: ['tag'],
};

/**
 * Try to extract name from aggregateContext
 */
const tryGetAggregateContextName = (
  aggregateContext: Record<string, unknown>,
  aggregateType: string,
): string | null => {
  const typeSpecificFields = AGGREGATE_CONTEXT_FIELD_MAP[aggregateType];
  if (typeSpecificFields) {
    for (const field of typeSpecificFields) {
      const value = getStringValue(aggregateContext, field);
      if (value) return value;
    }
  }

  return getDisplayName(aggregateContext, '');
};

/**
 * Try to extract name from nested relations in data
 */
const tryGetNestedAggregateData = (
  data: Record<string, unknown>,
  aggregateType: string,
  aggregateId: string,
): string | null => {
  const relationFields = AGGREGATE_RELATION_FIELD_MAP[aggregateType];
  if (!relationFields) return null;

  for (const field of relationFields) {
    const name = tryGetNestedRelationName(data, field, aggregateId);
    if (name) return name;
  }
  return null;
};

/**
 * Extract aggregate name from aggregate context or fallback to after/before data
 */
const getAggregateName = (log: AuditLog): string => {
  // Early return: If aggregate is the entity itself, use entity name directly
  if (log.aggregateId === log.entityId && log.aggregateType === log.entityType) {
    return getEntityName(log);
  }

  // Try aggregateContext first with type-specific fields
  if (isRecord(log.aggregateContext)) {
    const name = tryGetAggregateContextName(log.aggregateContext, log.aggregateType);
    if (name) return name;
  }

  // Try to extract from nested relations in before/after data
  const data = log.action === 'delete' ? log.before : log.after;
  if (isRecord(data)) {
    const name = tryGetNestedAggregateData(data, log.aggregateType, log.aggregateId);
    if (name) return name;
  }

  // Final fallback: just use aggregateId without type prefix
  return log.aggregateId;
};

/**
 * Extract tag name from entity context or aggregate context
 */
const getTagName = (log: AuditLog): string | null => {
  // Try entityContext first
  const entityContext = isRecord(log.entityContext) ? log.entityContext : {};
  const entityTagName = getStringValue(entityContext, 'tagName');
  if (entityTagName) return entityTagName;

  // Try aggregateContext.name (for Tag aggregate)
  const aggregateContext = isRecord(log.aggregateContext) ? log.aggregateContext : {};
  const aggregateName = getStringValue(aggregateContext, 'name');
  if (aggregateName && log.entityType === 'Tag') return aggregateName;

  // Try before/after data
  const data = log.action === 'delete' ? log.before : log.after;
  if (!isRecord(data)) return null;

  // Check for nested tag object (common in PostTag)
  if ('tag' in data && isRecord(data.tag)) {
    const tagName = getStringValue(data.tag, 'name');
    if (tagName) return tagName;
  }

  // Check for direct name field
  return getStringValue(data, 'name');
};

/**
 * Type guard for change value object
 */
interface ChangeValue {
  old: unknown;
  new: unknown;
}

/**
 * Check if a value is a change object with old/new properties
 */
const isChangeValue = (value: unknown): value is ChangeValue => {
  return isRecord(value) && 'old' in value && 'new' in value;
};

/**
 * Sensitive field names that should be redacted
 */
const SENSITIVE_FIELDS = ['password', 'token', 'secret', 'apiKey', 'ssn', 'creditCard'];

/**
 * Check if a field name is sensitive
 */
const isSensitiveField = (fieldName: string): boolean => {
  const lowerField = fieldName.toLowerCase();
  return SENSITIVE_FIELDS.some((sensitive) => lowerField.includes(sensitive.toLowerCase()));
};

/**
 * Format a single value for display
 */
const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '(none)';
  }
  if (typeof value === 'object') {
    // Don't show [object Object], show placeholder instead
    return '[REDACTED]';
  }
  if (typeof value === 'string' && value.length > 50) {
    return `"${value.substring(0, 47)}..."`;
  }
  if (typeof value === 'string') {
    return `"${value}"`;
  }
  return String(value);
};

/**
 * Format field changes for display
 */
const formatChanges = (changes: Record<string, unknown> | null): string => {
  if (!isRecord(changes)) return '';

  const changeEntries = Object.entries(changes);
  if (changeEntries.length === 0) return '';

  // Format each change
  const formattedChanges = changeEntries
    .map(([field, change]) => {
      if (isChangeValue(change)) {
        // Skip nested object changes (only show scalar changes)
        if (
          typeof change.old === 'object' &&
          change.old !== null &&
          typeof change.new === 'object' &&
          change.new !== null
        ) {
          return null;
        }

        // Handle sensitive fields
        if (isSensitiveField(field)) {
          return `${field}: [REDACTED]`;
        }

        // Handle regular fields
        const oldVal = formatValue(change.old);
        const newVal = formatValue(change.new);
        return `${field}: ${oldVal} → ${newVal}`;
      }
      return null;
    })
    .filter((value): value is string => value !== null);

  return formattedChanges.length > 0 ? ` (${formattedChanges.join(', ')})` : '';
};

/**
 * Get entity display name with fallback
 */
const getEntityName = (log: AuditLog): string => {
  // Try entityContext first
  if (isRecord(log.entityContext)) {
    const name = getDisplayName(log.entityContext, '');
    if (name) return name;
  }

  // Try to get entity info from after/before data
  const data = log.action === 'delete' ? log.before : log.after;
  if (isRecord(data)) {
    const name = getDisplayName(data, '');
    if (name) return name;
  }

  // Fallback to entityType#entityId
  return `${log.entityType}#${log.entityId}`;
};

/**
 * Check if the actor is the same as the aggregate (self-operation)
 */
const isActorSameAsAggregate = (log: AuditLog): boolean => {
  return (
    log.actorCategory === log.aggregateCategory &&
    log.actorType === log.aggregateType &&
    log.actorId === log.aggregateId
  );
};

/**
 * Common formatting context shared across entity-specific formatters
 */
type FormatContext = {
  actorName: string;
  aggregateName: string;
  action: string;
  entityName: string;
  changeDetails: string;
  showActor: boolean;
  data: Record<string, unknown> | null;
  log: AuditLog;
};

/**
 * Entity-specific formatter functions
 */
type EntityFormatter = (ctx: FormatContext) => string | null;

const formatUserMessage: EntityFormatter = ({
  action,
  showActor,
  actorName,
  entityName,
  aggregateName,
  changeDetails,
}) => {
  if (action === 'create') {
    return showActor ? `${actorName} registered ${entityName}` : `${entityName} registered`;
  }
  if (action === 'update') {
    return showActor
      ? `${actorName} updated ${aggregateName}${changeDetails}`
      : `${aggregateName} updated${changeDetails}`;
  }
  if (action === 'delete') {
    return showActor ? `${actorName} deleted ${entityName}` : `${entityName} was deleted`;
  }
  return null;
};

const formatProfileMessage: EntityFormatter = ({ action, showActor, actorName, aggregateName, changeDetails }) => {
  if (action === 'create') {
    return showActor ? `${actorName} created Profile for ${aggregateName}` : `${aggregateName} created Profile`;
  }
  if (action === 'update') {
    return showActor
      ? `${actorName} updated Profile of ${aggregateName}${changeDetails}`
      : `${aggregateName} updated Profile${changeDetails}`;
  }
  if (action === 'delete') {
    return showActor ? `${actorName} deleted Profile of ${aggregateName}` : `${aggregateName} deleted Profile`;
  }
  return null;
};

const formatAvatarMessage: EntityFormatter = ({ action, showActor, actorName, aggregateName, changeDetails }) => {
  if (action === 'create') {
    return showActor ? `${actorName} set Avatar for ${aggregateName}` : `${aggregateName} set Avatar`;
  }
  if (action === 'update') {
    return showActor
      ? `${actorName} updated Avatar of ${aggregateName}${changeDetails}`
      : `${aggregateName} updated Avatar${changeDetails}`;
  }
  if (action === 'delete') {
    return showActor ? `${actorName} removed Avatar of ${aggregateName}` : `${aggregateName} removed Avatar`;
  }
  return null;
};

const formatAvatarImageMessage: EntityFormatter = ({ action, showActor, actorName, aggregateName, changeDetails }) => {
  if (action === 'create') {
    return showActor ? `${actorName} set profile picture for ${aggregateName}` : `${aggregateName} set profile picture`;
  }
  if (action === 'update') {
    return showActor
      ? `${actorName} updated profile picture of ${aggregateName}${changeDetails}`
      : `${aggregateName} updated profile picture${changeDetails}`;
  }
  if (action === 'delete') {
    return showActor
      ? `${actorName} removed profile picture of ${aggregateName}`
      : `${aggregateName} removed profile picture`;
  }
  return null;
};

const formatPostMessage: EntityFormatter = ({
  action,
  showActor,
  actorName,
  entityName,
  aggregateName,
  changeDetails,
}) => {
  if (action === 'create') {
    return showActor
      ? `${actorName} created Post "${entityName}" for ${aggregateName}`
      : `${aggregateName} created Post "${entityName}"`;
  }
  if (action === 'update') {
    return showActor
      ? `${actorName} updated Post "${aggregateName}"${changeDetails}`
      : `Post "${aggregateName}" updated${changeDetails}`;
  }
  if (action === 'delete') {
    return showActor
      ? `${actorName} deleted Post "${entityName}" of ${aggregateName}`
      : `${aggregateName} deleted Post "${entityName}"`;
  }
  return null;
};

/**
 * Format comment for Post aggregate
 */
const formatCommentForPostAggregate = (
  action: string,
  showActor: boolean,
  actorName: string,
  postName: string,
  changeDetails: string,
): string => {
  if (action === 'create') {
    return showActor ? `${actorName} posted Comment on Post "${postName}"` : `Post "${postName}" received Comment`;
  }
  if (action === 'update') {
    return showActor
      ? `${actorName} edited Comment on Post "${postName}"${changeDetails}`
      : `Post "${postName}"'s Comment was edited${changeDetails}`;
  }
  return showActor
    ? `${actorName} deleted Comment from Post "${postName}"`
    : `Post "${postName}"'s Comment was deleted`;
};

/**
 * Format comment for User aggregate or self-operation
 */
const formatCommentForOtherAggregate = (
  action: string,
  showActor: boolean,
  actorName: string,
  aggregateName: string,
  changeDetails: string,
): string => {
  if (action === 'create') {
    return showActor ? `${actorName} posted Comment` : `${aggregateName} posted Comment`;
  }
  if (action === 'update') {
    return showActor
      ? `${actorName} edited Comment${changeDetails}`
      : `${aggregateName} edited Comment${changeDetails}`;
  }
  return showActor ? `${actorName} deleted Comment` : `${aggregateName} deleted Comment`;
};

const formatCommentMessage: EntityFormatter = ({ action, showActor, actorName, aggregateName, changeDetails, log }) => {
  // Try to get parent entity name from entityContext or aggregateContext
  const entityContext = isRecord(log.entityContext) ? log.entityContext : {};
  const aggregateContext = isRecord(log.aggregateContext) ? log.aggregateContext : {};

  // Priority: entityContext.title > aggregateContext.title > aggregateContext.name > aggregateName (if Post type)
  const parentName =
    getStringValue(entityContext, 'title') ||
    getStringValue(aggregateContext, 'title') ||
    getStringValue(aggregateContext, 'name') ||
    (log.aggregateType === 'Post' ? aggregateName : null);

  // If parent entity name is available, use it for detailed message
  if (parentName) {
    return formatCommentForPostAggregate(action, showActor, actorName, parentName, changeDetails);
  }

  // Otherwise, use simple format without parent context
  return formatCommentForOtherAggregate(action, showActor, actorName, aggregateName, changeDetails);
};

const formatTagMessage: EntityFormatter = ({ action, showActor, actorName, entityName }) => {
  if (action === 'create') {
    return showActor ? `${actorName} created Tag "${entityName}"` : `Tag "${entityName}" created`;
  }
  if (action === 'delete') {
    return showActor ? `${actorName} deleted Tag "${entityName}"` : `Tag "${entityName}" deleted`;
  }
  return null;
};

/**
 * Format PostTag create message
 */
const formatPostTagCreate = (
  showActor: boolean,
  actorName: string,
  aggregateType: string,
  aggregateName: string,
  tagName: string,
  postTitle: string,
): string => {
  if (aggregateType === 'Post') {
    return showActor
      ? `${actorName} tagged Post "${aggregateName}" with "${tagName}"`
      : `Post "${aggregateName}" was tagged with "${tagName}"`;
  }
  if (aggregateType === 'Tag') {
    return showActor
      ? `${actorName} added Tag "${aggregateName}" to Post "${postTitle}"`
      : `Tag "${aggregateName}" was added to Post "${postTitle}"`;
  }
  return showActor ? `${actorName} added Tag "${tagName}"` : `Tag "${tagName}" was added`;
};

/**
 * Format PostTag delete message
 */
const formatPostTagDelete = (
  showActor: boolean,
  actorName: string,
  aggregateType: string,
  aggregateName: string,
  tagName: string,
  postTitle: string,
): string => {
  if (aggregateType === 'Post') {
    return showActor
      ? `${actorName} removed tag "${tagName}" from Post "${aggregateName}"`
      : `Tag "${tagName}" was removed from Post "${aggregateName}"`;
  }
  if (aggregateType === 'Tag') {
    return showActor
      ? `${actorName} removed Tag "${aggregateName}" from Post "${postTitle}"`
      : `Tag "${aggregateName}" was removed from Post "${postTitle}"`;
  }
  return showActor ? `${actorName} removed Tag "${tagName}"` : `Tag "${tagName}" was removed`;
};

const formatPostTagMessage: EntityFormatter = ({ action, showActor, actorName, aggregateName, log }) => {
  // Get entity comprehension from entityContext
  const entityContext = isRecord(log.entityContext) ? log.entityContext : {};
  const tagName = getStringValue(entityContext, 'name') || getTagName(log) || 'unknown tag';
  const postTitle = getStringValue(entityContext, 'title') || 'unknown post';

  if (action === 'create') {
    return formatPostTagCreate(showActor, actorName, log.aggregateType, aggregateName, tagName, postTitle);
  }

  if (action === 'delete') {
    return formatPostTagDelete(showActor, actorName, log.aggregateType, aggregateName, tagName, postTitle);
  }

  return null;
};

const formatAttachmentMessage: EntityFormatter = ({
  action,
  showActor,
  actorName,
  entityName,
  aggregateName,
  changeDetails,
}) => {
  if (action === 'create') {
    return showActor
      ? `${actorName} uploaded "${entityName}" for ${aggregateName}`
      : `${aggregateName} uploaded "${entityName}"`;
  }
  if (action === 'update') {
    return showActor
      ? `${actorName} updated "${entityName}" of ${aggregateName}${changeDetails}`
      : `${aggregateName} updated "${entityName}"${changeDetails}`;
  }
  if (action === 'delete') {
    return showActor
      ? `${actorName} deleted "${entityName}" of ${aggregateName}`
      : `${aggregateName} deleted "${entityName}"`;
  }
  return null;
};

/**
 * Extract file name from data or use entity name
 */
const extractFileName = (data: Record<string, unknown> | null, entityName: string): string => {
  if (isRecord(data) && 'attachment' in data && isRecord(data.attachment)) {
    return getDisplayName(data.attachment, entityName);
  }
  return entityName;
};

/**
 * Format attachment create message
 */
const formatAttachmentCreate = (
  showActor: boolean,
  actorName: string,
  fileName: string,
  targetName: string,
  hasAggregate: boolean,
): string => {
  if (hasAggregate) {
    return showActor
      ? `${actorName} attached "${fileName}" to Post "${targetName}"`
      : `Post "${targetName}" attached "${fileName}"`;
  }
  return showActor ? `${actorName} attached "${fileName}" to Post` : `"${fileName}" attached to Post`;
};

/**
 * Format attachment delete message
 */
const formatAttachmentDelete = (
  showActor: boolean,
  actorName: string,
  fileName: string,
  targetName: string,
  hasAggregate: boolean,
): string => {
  if (hasAggregate) {
    return showActor
      ? `${actorName} removed "${fileName}" from Post "${targetName}"`
      : `Post "${targetName}" removed "${fileName}"`;
  }
  return showActor ? `${actorName} removed "${fileName}" from Post` : `"${fileName}" removed from Post`;
};

const formatPostAttachmentMessage: EntityFormatter = ({
  action,
  showActor,
  actorName,
  entityName,
  aggregateName,
  data,
  log,
}) => {
  const fileName = extractFileName(data, entityName);
  const isPostAggregate = log.aggregateType === 'Post';

  if (action === 'create') {
    return formatAttachmentCreate(showActor, actorName, fileName, aggregateName, isPostAggregate);
  }

  if (action === 'delete') {
    return formatAttachmentDelete(showActor, actorName, fileName, aggregateName, isPostAggregate);
  }

  return null;
};

/**
 * Format comment attachment create message
 */
const formatCommentAttachmentCreate = (
  showActor: boolean,
  actorName: string,
  fileName: string,
  targetName: string,
  hasPostAggregate: boolean,
): string => {
  if (hasPostAggregate) {
    return showActor
      ? `${actorName} attached "${fileName}" to Comment on Post "${targetName}"`
      : `Post "${targetName}"'s Comment attached "${fileName}"`;
  }
  return showActor ? `${actorName} attached "${fileName}" to Comment` : `Comment attached "${fileName}"`;
};

/**
 * Format comment attachment delete message
 */
const formatCommentAttachmentDelete = (
  showActor: boolean,
  actorName: string,
  fileName: string,
  targetName: string,
  hasPostAggregate: boolean,
): string => {
  if (hasPostAggregate) {
    return showActor
      ? `${actorName} removed "${fileName}" from Comment on Post "${targetName}"`
      : `Post "${targetName}"'s Comment removed "${fileName}"`;
  }
  return showActor ? `${actorName} removed "${fileName}" from Comment` : `Comment removed "${fileName}"`;
};

const formatCommentAttachmentMessage: EntityFormatter = ({
  action,
  showActor,
  actorName,
  entityName,
  aggregateName,
  data,
  log,
}) => {
  const fileName = extractFileName(data, entityName);
  const isPostAggregate = log.aggregateType === 'Post';

  if (action === 'create') {
    return formatCommentAttachmentCreate(showActor, actorName, fileName, aggregateName, isPostAggregate);
  }

  if (action === 'delete') {
    return formatCommentAttachmentDelete(showActor, actorName, fileName, aggregateName, isPostAggregate);
  }

  return null;
};

/**
 * Format generic self-operation message
 */
const formatGenericSelfOperation = (
  action: string,
  showActor: boolean,
  actorName: string,
  entityType: string,
  entityName: string,
  changeDetails: string,
): string => {
  if (action === 'create') {
    return showActor ? `${actorName} created ${entityType} ${entityName}` : `${entityType} ${entityName} created`;
  }
  if (action === 'update') {
    return showActor
      ? `${actorName} updated ${entityType} ${entityName}${changeDetails}`
      : `${entityType} ${entityName} updated${changeDetails}`;
  }
  if (action === 'delete') {
    return showActor ? `${actorName} deleted ${entityType} ${entityName}` : `${entityType} ${entityName} deleted`;
  }
  return showActor
    ? `${actorName} performed ${action} on ${entityType}`
    : `${entityType} ${entityName} performed ${action}`;
};

/**
 * Format generic aggregate-entity message
 */
const formatGenericAggregateOperation = (
  action: string,
  showActor: boolean,
  actorName: string,
  entityType: string,
  entityName: string,
  aggregateType: string,
  aggregateName: string,
  changeDetails: string,
): string => {
  if (action === 'create') {
    return showActor
      ? `${actorName} created ${entityType} ${entityName} for ${aggregateType} ${aggregateName}`
      : `${aggregateType} ${aggregateName} created ${entityType} ${entityName}`;
  }
  if (action === 'update') {
    return showActor
      ? `${actorName} updated ${entityType} ${entityName} of ${aggregateType} ${aggregateName}${changeDetails}`
      : `${aggregateType} ${aggregateName} updated ${entityType} ${entityName}${changeDetails}`;
  }
  if (action === 'delete') {
    return showActor
      ? `${actorName} deleted ${entityType} ${entityName} of ${aggregateType} ${aggregateName}`
      : `${aggregateType} ${aggregateName} deleted ${entityType} ${entityName}`;
  }
  return showActor
    ? `${actorName} performed ${action} on ${entityType} of ${aggregateType} ${aggregateName}`
    : `${aggregateType} "${aggregateName}" performed ${action} on ${entityType}`;
};

const formatGenericMessage: EntityFormatter = ({
  action,
  showActor,
  actorName,
  entityName,
  aggregateName,
  changeDetails,
  log,
}) => {
  const isSelfOperation = log.aggregateId === log.entityId && log.aggregateType === log.entityType;

  if (isSelfOperation) {
    return formatGenericSelfOperation(action, showActor, actorName, log.entityType, entityName, changeDetails);
  }

  return formatGenericAggregateOperation(
    action,
    showActor,
    actorName,
    log.entityType,
    entityName,
    log.aggregateType,
    aggregateName,
    changeDetails,
  );
};

/**
 * Entity type to formatter mapping
 */
const ENTITY_FORMATTER_MAP: Record<string, EntityFormatter> = {
  User: formatUserMessage,
  Profile: formatProfileMessage,
  Avatar: formatAvatarMessage,
  AvatarImage: formatAvatarImageMessage,
  Post: formatPostMessage,
  Comment: formatCommentMessage,
  Tag: formatTagMessage,
  PostTag: formatPostTagMessage,
  Attachment: formatAttachmentMessage,
  PostAttachment: formatPostAttachmentMessage,
  CommentAttachment: formatCommentAttachmentMessage,
};

/**
 * Convert AuditLog to natural language description (English)
 * Format: "Actor performed action on Entity (on Aggregate)" or "Aggregate performed action on Entity"
 * Enhanced with Actor Context for richer descriptions
 */
export const formatAuditLogMessage = (log: AuditLog): string => {
  const actorName = getActorName(log);
  const aggregateName = getAggregateName(log);
  const entityName = getEntityName(log);
  const changeDetails = formatChanges(log.changes);
  const data = log.action === 'delete' ? log.before : log.after;

  // Check if actor is the same as aggregate
  const actorIsAggregate = isActorSameAsAggregate(log);
  const showActor = !actorIsAggregate && actorName !== aggregateName;

  // Build format context
  const context: FormatContext = {
    actorName,
    aggregateName,
    action: log.action,
    entityName,
    changeDetails,
    showActor,
    data: isRecord(data) ? data : null,
    log,
  };

  // Use entity-specific formatter or fall back to generic
  const formatter = ENTITY_FORMATTER_MAP[log.entityType] || formatGenericMessage;
  const result = formatter(context);

  // Final fallback if formatter returns null
  if (result) return result;

  return showActor
    ? `${actorName} performed ${log.action} on ${log.entityType} "${entityName}"`
    : `${log.aggregateType} "${aggregateName}" performed ${log.action} on ${log.entityType}`;
};

/**
 * Format timestamp for display
 */
export const formatTimestamp = (timestamp: string): string => {
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};
