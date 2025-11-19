import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { AuditLogs } from './AuditLogs';
import { PostManagement } from './PostManagement';
import { UserManagement } from './UserManagement';

export const AdminPage = () => {
  return (
    <div>
      <h1 className="mb-6 text-3xl font-bold">Admin Dashboard</h1>

      <Tabs defaultValue="users" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="posts">Posts</TabsTrigger>
          <TabsTrigger value="audit-logs">Audit Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="pt-6">
          <UserManagement />
        </TabsContent>

        <TabsContent value="posts" className="pt-6">
          <PostManagement />
        </TabsContent>

        <TabsContent value="audit-logs" className="pt-6">
          <AuditLogs />
        </TabsContent>
      </Tabs>
    </div>
  );
};
