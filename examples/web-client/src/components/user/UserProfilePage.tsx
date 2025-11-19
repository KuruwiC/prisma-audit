import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../../lib/api-client';
import { ActivityLog } from '../activity/ActivityLog';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Label } from '../ui/label';

type UserProfilePageProps = {
  userId: string;
  onBack: () => void;
};

export const UserProfilePage = ({ userId, onBack }: UserProfilePageProps) => {
  const { data: profile, isLoading } = useQuery({
    queryKey: ['user-profile', userId],
    queryFn: () => apiClient.getProfile(userId),
    refetchInterval: 30000, // 30秒ごとに自動更新
  });

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <p className="text-muted-foreground">Loading profile...</p>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4">
        <p className="text-destructive">User not found</p>
        <Button onClick={onBack}>Back</Button>
      </div>
    );
  }

  const getAvatarUrl = () => {
    return profile.profile?.avatar?.avatarImage?.imageUrl || 'https://i.pravatar.cc/150?img=1';
  };

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6">
        <Button variant="ghost" onClick={onBack}>
          ← Back
        </Button>
      </div>

      <h1 className="mb-6 text-3xl font-bold">User Profile</h1>

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-4">
              <img
                src={getAvatarUrl()}
                alt={profile.name || profile.email}
                className="h-20 w-20 rounded-full object-cover"
              />
              <div>
                <CardTitle>{profile.name || 'Anonymous'}</CardTitle>
                <CardDescription>{profile.email}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {profile.profile?.bio && (
              <div className="flex flex-col gap-2">
                <Label>Bio</Label>
                <p className="text-sm">{profile.profile.bio}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <ActivityLog
          aggregateType="User"
          aggregateId={userId}
          title="Activity Log"
          description="User's recent activity"
        />
      </div>
    </div>
  );
};
