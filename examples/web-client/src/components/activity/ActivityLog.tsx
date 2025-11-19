import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { formatAuditLogMessage, formatTimestamp } from '../../lib/audit-log-formatter';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

type ActivityLogProps = {
  aggregateType: string;
  aggregateId: string;
  title?: string;
  description?: string;
};

export const ActivityLog = ({ aggregateType, aggregateId, title, description }: ActivityLogProps) => {
  const [viewMode, setViewMode] = useState<'table' | 'natural'>('natural');

  const { data: logs, isLoading } = useQuery({
    queryKey: ['activity-log', aggregateType, aggregateId],
    queryFn: () => apiClient.getAuditLogs({ aggregateType, aggregateId }),
    refetchInterval: 10000, // Auto-refresh every 10 seconds
  });

  // Sort logs by createdAt descending (most recent first)
  const sortedLogs = logs
    ? [...logs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    : [];

  // Filter out empty messages for natural language view
  const naturalLogs = sortedLogs.filter((log) => formatAuditLogMessage(log).trim() !== '');

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>{title || 'Activity Log'}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={viewMode === 'natural' ? 'default' : 'outline'}
              onClick={() => setViewMode('natural')}
            >
              Natural
            </Button>
            <Button
              size="sm"
              variant={viewMode === 'table' ? 'default' : 'outline'}
              onClick={() => setViewMode('table')}
            >
              Table
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-muted-foreground">Loading activity log...</p>
        ) : viewMode === 'natural' ? (
          <div className="flex flex-col gap-3">
            {naturalLogs.length > 0 ? (
              naturalLogs.map((log) => (
                <div key={log.id} className="flex items-start gap-3 border-b pb-3 last:border-b-0">
                  <div className="flex-1">
                    <p className="text-sm">{formatAuditLogMessage(log)}</p>
                    <p className="text-xs text-muted-foreground">{formatTimestamp(log.createdAt)}</p>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No activity found</p>
            )}
          </div>
        ) : (
          <div className="rounded border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Actor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedLogs.length > 0 ? (
                  sortedLogs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="font-mono text-xs">{formatTimestamp(log.createdAt)}</TableCell>
                      <TableCell>
                        <span className="rounded bg-secondary px-2 py-1 text-xs font-medium">{log.entityType}</span>
                      </TableCell>
                      <TableCell>
                        <span
                          className={`rounded px-2 py-1 text-xs font-medium ${
                            log.action === 'create'
                              ? 'bg-green-100 text-green-800'
                              : log.action === 'update'
                                ? 'bg-blue-100 text-blue-800'
                                : 'bg-red-100 text-red-800'
                          }`}
                        >
                          {log.action}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs">{log.actorContext?.name || log.actorId}</span>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center">
                      No activity found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
