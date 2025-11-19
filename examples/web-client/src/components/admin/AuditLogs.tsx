import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { formatAuditLogMessage, formatTimestamp } from '../../lib/audit-log-formatter';
import type { AuditLog } from '../../types/api';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

type ViewMode = 'table' | 'natural';

export const AuditLogs = () => {
  const [entityType, setEntityType] = useState<string | undefined>();
  const [aggregateType, setAggregateType] = useState<string | undefined>();
  const [action, setAction] = useState<string | undefined>();
  const [viewMode, setViewMode] = useState<ViewMode>('natural');

  const { data: logs, isLoading } = useQuery({
    queryKey: ['audit-logs', entityType, aggregateType, action],
    queryFn: () => apiClient.getAuditLogs({ entityType, aggregateType, action }),
    refetchInterval: 5000, // Auto-refresh every 5 seconds
  });

  /**
   * Redacted field info structure (from @kuruwic/prisma-audit)
   */
  interface RedactedFieldInfo {
    redacted: true;
    hadValue: boolean;
    isDifferent?: boolean;
  }

  /**
   * Type guard for change object with old/new values
   */
  interface ChangeObject {
    old: unknown;
    new: unknown;
  }

  /**
   * Check if a value is a structured redacted field
   */
  const isRedactedFieldInfo = (value: unknown): value is RedactedFieldInfo => {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
      'redacted' in candidate &&
      'hadValue' in candidate &&
      candidate.redacted === true &&
      typeof candidate.hadValue === 'boolean'
    );
  };

  /**
   * Check if a value is a change object with old/new properties
   */
  const isChangeObject = (value: unknown): value is ChangeObject => {
    return typeof value === 'object' && value !== null && 'old' in value && 'new' in value;
  };

  /**
   * Format a redacted value for display
   */
  const formatRedactedValue = (redacted: RedactedFieldInfo): string | null => {
    if (redacted.isDifferent !== undefined) {
      return redacted.isDifferent ? '[VALUE CHANGED]' : '[VALUE UNCHANGED]';
    }
    return redacted.hadValue ? '[REDACTED]' : null;
  };

  /**
   * Format JSON with special handling for redacted fields
   */
  const formatJson = (data: Record<string, unknown> | null) => {
    if (!data) return 'null';

    // Replace redacted field info with human-readable format
    const replacer = (_key: string, value: unknown): unknown => {
      if (isRedactedFieldInfo(value)) {
        return formatRedactedValue(value);
      }
      // Handle { old, new } change objects with redacted fields
      if (isChangeObject(value)) {
        const oldVal = isRedactedFieldInfo(value.old) ? formatRedactedValue(value.old) : value.old;
        const newVal = isRedactedFieldInfo(value.new) ? formatRedactedValue(value.new) : value.new;

        return { old: oldVal, new: newVal };
      }
      return value;
    };

    return JSON.stringify(data, replacer, 2);
  };

  const renderDataView = (log: AuditLog) => {
    const { action, before, after, changes } = log;

    return (
      <details className="cursor-pointer">
        <summary className="text-xs text-primary">View details</summary>
        <div className="mt-2 max-w-2xl space-y-3">
          {action === 'create' && after && (
            <div>
              <div className="mb-1 text-xs font-semibold text-green-600 dark:text-green-400">Created Data:</div>
              <pre className="overflow-auto rounded border border-green-200 bg-green-50/50 p-2 text-xs dark:border-green-800 dark:bg-green-950/50">
                {formatJson(after)}
              </pre>
            </div>
          )}
          {action === 'delete' && before && (
            <div>
              <div className="mb-1 text-xs font-semibold text-red-600 dark:text-red-400">Deleted Data:</div>
              <pre className="overflow-auto rounded border border-red-200 bg-red-50/50 p-2 text-xs dark:border-red-800 dark:bg-red-950/50">
                {formatJson(before)}
              </pre>
            </div>
          )}
          {action === 'update' && (
            <>
              {changes && (
                <div>
                  <div className="mb-1 text-xs font-semibold text-blue-600 dark:text-blue-400">Changes:</div>
                  <pre className="overflow-auto rounded border border-blue-200 bg-blue-50/50 p-2 text-xs dark:border-blue-800 dark:bg-blue-950/50">
                    {formatJson(changes)}
                  </pre>
                </div>
              )}
              {before && (
                <div>
                  <div className="mb-1 text-xs font-semibold text-muted-foreground">Before:</div>
                  <pre className="overflow-auto rounded border bg-muted/50 p-2 text-xs">{formatJson(before)}</pre>
                </div>
              )}
              {after && (
                <div>
                  <div className="mb-1 text-xs font-semibold text-muted-foreground">After:</div>
                  <pre className="overflow-auto rounded border bg-muted/50 p-2 text-xs">{formatJson(after)}</pre>
                </div>
              )}
            </>
          )}
        </div>
      </details>
    );
  };

  /**
   * Extract a string value from a context object property
   */
  const getStringProperty = (context: Record<string, unknown>, key: string): string | null => {
    if (key in context && context[key]) {
      return String(context[key]);
    }
    return null;
  };

  /**
   * Get actor display name from actorContext or fallback to actorId
   */
  const getActorDisplayName = (log: AuditLog): string => {
    if (log.actorContext && typeof log.actorContext === 'object') {
      const context = log.actorContext as Record<string, unknown>;
      return (
        getStringProperty(context, 'displayName') ||
        getStringProperty(context, 'name') ||
        getStringProperty(context, 'email') ||
        log.actorId
      );
    }
    return log.actorId;
  };

  /**
   * Get aggregate display name from aggregateContext or fallback to aggregateId
   */
  const getAggregateDisplayName = (log: AuditLog): string => {
    if (log.aggregateContext && typeof log.aggregateContext === 'object') {
      const context = log.aggregateContext as Record<string, unknown>;
      return (
        getStringProperty(context, 'displayName') ||
        getStringProperty(context, 'name') ||
        getStringProperty(context, 'postTitle') ||
        getStringProperty(context, 'authorDisplayName') ||
        log.aggregateId
      );
    }
    return log.aggregateId;
  };

  const renderNaturalView = () => {
    if (!logs || logs.length === 0) {
      return (
        <div className="rounded border p-8 text-center text-muted-foreground">
          <p>No audit logs found</p>
        </div>
      );
    }

    // Sort by createdAt descending
    const sortedLogs = [...logs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return (
      <div className="space-y-3">
        {sortedLogs.map((log) => {
          const message = formatAuditLogMessage(log);
          if (!message.trim()) return null;

          return (
            <div key={log.id} className="rounded border bg-card p-4 shadow-sm">
              <div className="mb-2 flex items-start justify-between gap-4">
                <div className="flex-1">
                  <p className="text-sm font-medium leading-relaxed">{message}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{formatTimestamp(log.createdAt)}</span>
                    <span>•</span>
                    <span>
                      by <span className="font-medium text-foreground">{getActorDisplayName(log)}</span>
                    </span>
                    <span>•</span>
                    <span>
                      on <span className="font-medium text-foreground">{getAggregateDisplayName(log)}</span>
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={`rounded px-2 py-1 text-xs font-medium ${
                      log.action === 'create'
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                        : log.action === 'update'
                          ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                          : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
                    }`}
                  >
                    {log.action}
                  </span>
                  <span className="rounded bg-secondary px-2 py-1 text-xs font-medium">{log.entityType}</span>
                </div>
              </div>
              {renderDataView(log)}
            </div>
          );
        })}
      </div>
    );
  };

  const renderTableView = () => {
    return (
      <div className="rounded border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Timestamp</TableHead>
              <TableHead>Entity Type</TableHead>
              <TableHead>Aggregate Type</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Aggregate</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs && logs.length > 0 ? (
              logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="font-mono text-xs">{formatTimestamp(log.createdAt)}</TableCell>
                  <TableCell>
                    <span className="rounded bg-secondary px-2 py-1 text-xs font-medium">{log.entityType}</span>
                  </TableCell>
                  <TableCell>
                    <span className="rounded bg-secondary px-2 py-1 text-xs font-medium">{log.aggregateType}</span>
                  </TableCell>
                  <TableCell>
                    <span
                      className={`rounded px-2 py-1 text-xs font-medium ${
                        log.action === 'create'
                          ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                          : log.action === 'update'
                            ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                            : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
                      }`}
                    >
                      {log.action}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-medium">{getActorDisplayName(log)}</span>
                      <span className="text-xs text-muted-foreground">{log.actorType}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-medium">{getAggregateDisplayName(log)}</span>
                      <span className="text-xs text-muted-foreground">{log.aggregateType}</span>
                    </div>
                  </TableCell>
                  <TableCell>{renderDataView(log)}</TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={7} className="text-center">
                  No audit logs found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Audit Logs</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setViewMode('natural')}
            className={`rounded px-3 py-1 text-sm font-medium transition-colors ${
              viewMode === 'natural'
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
            }`}
          >
            Natural Language
          </button>
          <button
            type="button"
            onClick={() => setViewMode('table')}
            className={`rounded px-3 py-1 text-sm font-medium transition-colors ${
              viewMode === 'table'
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
            }`}
          >
            Table View
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-2">
          <Label>Entity Type</Label>
          <Select
            value={entityType || 'all'}
            onValueChange={(value) => setEntityType(value === 'all' ? undefined : value)}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="All entities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All entities</SelectItem>
              <SelectItem value="User">User</SelectItem>
              <SelectItem value="Post">Post</SelectItem>
              <SelectItem value="Comment">Comment</SelectItem>
              <SelectItem value="Profile">Profile</SelectItem>
              <SelectItem value="Avatar">Avatar</SelectItem>
              <SelectItem value="Tag">Tag</SelectItem>
              <SelectItem value="PostTag">PostTag</SelectItem>
              <SelectItem value="Attachment">Attachment</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <Label>Aggregate Type</Label>
          <Select
            value={aggregateType || 'all'}
            onValueChange={(value) => setAggregateType(value === 'all' ? undefined : value)}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="All aggregates" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All aggregates</SelectItem>
              <SelectItem value="User">User</SelectItem>
              <SelectItem value="Post">Post</SelectItem>
              <SelectItem value="Tag">Tag</SelectItem>
              <SelectItem value="Comment">Comment</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <Label>Action</Label>
          <Select value={action || 'all'} onValueChange={(value) => setAction(value === 'all' ? undefined : value)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="All actions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              <SelectItem value="create">create</SelectItem>
              <SelectItem value="update">update</SelectItem>
              <SelectItem value="delete">delete</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading audit logs...</p>
      ) : viewMode === 'natural' ? (
        renderNaturalView()
      ) : (
        renderTableView()
      )}
    </div>
  );
};
