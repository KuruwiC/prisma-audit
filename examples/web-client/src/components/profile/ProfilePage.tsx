import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { apiClient } from '../../lib/api-client';
import { ActivityLog } from '../activity/ActivityLog';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { AvatarSelector } from './AvatarSelector';

export const ProfilePage = () => {
  const { user, refreshUser } = useAuth();
  const queryClient = useQueryClient();

  const [bio, setBio] = useState('');
  const [selectedAvatarUrl, setSelectedAvatarUrl] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');

  const { data: profile, isLoading } = useQuery({
    queryKey: ['profile', user?.id],
    queryFn: () => (user ? apiClient.getProfile(user.id) : Promise.reject()),
    enabled: !!user,
    refetchInterval: 30000, // 30秒ごとに自動更新
  });

  // Update local state when profile data is loaded
  useEffect(() => {
    if (profile) {
      setBio(profile.profile?.bio || '');
      setSelectedAvatarUrl(profile.profile?.avatar?.avatarImage?.imageUrl || 'https://i.pravatar.cc/150?img=1');
    }
  }, [profile]);

  const updateProfileMutation = useMutation({
    mutationFn: async (params: { bio: string; avatarUrl?: string }) => {
      if (!user) throw new Error('No user');
      const updateData: { bio: string; avatar?: { imageUrl: string } } = {
        bio: params.bio,
      };

      // Include avatar update if URL changed
      if (params.avatarUrl) {
        updateData.avatar = {
          imageUrl: params.avatarUrl,
        };
      }

      return apiClient.updateProfile(user.id, updateData);
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ['profile', user?.id] });
      await refreshUser();
      setHasChanges(false);
    },
  });

  const updateAvatarMutation = useMutation({
    mutationFn: async (imageUrl: string) => {
      if (!user) throw new Error('No user');
      return apiClient.setAvatar(user.id, { imageUrl });
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ['profile', user?.id] });
      await refreshUser();
      setHasChanges(false);
    },
  });

  const updatePasswordMutation = useMutation({
    mutationFn: async (newPassword: string) => {
      if (!user) throw new Error('No user');
      return apiClient.updateUser(user.id, { password: newPassword });
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ['profile', user?.id] });
      await refreshUser();
      setPassword('');
      setConfirmPassword('');
      setPasswordError('Password updated successfully!');
      setTimeout(() => setPasswordError(''), 3000);
    },
    onError: () => {
      setPasswordError('Failed to update password. Please try again.');
    },
  });

  const handleBioChange = (value: string) => {
    setBio(value);
    setHasChanges(true);
  };

  const handleAvatarSelect = (url: string) => {
    setSelectedAvatarUrl(url);
    setHasChanges(true);
  };

  const handleSave = async () => {
    const bioChanged = bio !== (profile?.profile?.bio || '');
    const avatarChanged = selectedAvatarUrl !== (profile?.profile?.avatar?.avatarImage?.imageUrl || '');

    // Use unified update for bio and avatar changes
    if (bioChanged || avatarChanged) {
      await updateProfileMutation.mutateAsync({
        bio,
        avatarUrl: avatarChanged ? selectedAvatarUrl : undefined,
      });
    }
  };

  const handlePasswordChange = async () => {
    setPasswordError('');

    if (!password || !confirmPassword) {
      setPasswordError('Please fill in both password fields');
      return;
    }

    if (password !== confirmPassword) {
      setPasswordError('Passwords do not match');
      return;
    }

    if (password.length < 6) {
      setPasswordError('Password must be at least 6 characters');
      return;
    }

    await updatePasswordMutation.mutateAsync(password);
  };

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <p className="text-muted-foreground">Loading profile...</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-3xl font-bold">Profile</h1>

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>User Information</CardTitle>
            <CardDescription>Your basic account details</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label>Email</Label>
              <p className="text-sm">{user?.email}</p>
            </div>
            <div className="flex flex-col gap-2">
              <Label>Name</Label>
              <p className="text-sm">{user?.name || 'Not set'}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Profile Settings</CardTitle>
            <CardDescription>Customize your profile appearance</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <AvatarSelector currentAvatarUrl={selectedAvatarUrl} onSelect={handleAvatarSelect} />

            <div className="flex flex-col gap-2">
              <Label htmlFor="bio">Bio</Label>
              <Textarea
                id="bio"
                placeholder="Tell us about yourself..."
                value={bio}
                onChange={(e) => handleBioChange(e.target.value)}
                className="min-h-[120px]"
              />
            </div>

            {hasChanges && (
              <Button onClick={handleSave} disabled={updateProfileMutation.isPending || updateAvatarMutation.isPending}>
                {updateProfileMutation.isPending || updateAvatarMutation.isPending ? 'Saving...' : 'Save Changes'}
              </Button>
            )}

            {(updateProfileMutation.isError || updateAvatarMutation.isError) && (
              <p className="text-sm text-destructive">Failed to update profile. Please try again.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Change Password</CardTitle>
            <CardDescription>Update your account password</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">New Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="Enter new password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirmPassword">Confirm Password</Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder="Confirm new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>

            {passwordError && (
              <p className={`text-sm ${passwordError.includes('success') ? 'text-green-600' : 'text-destructive'}`}>
                {passwordError}
              </p>
            )}

            <Button onClick={handlePasswordChange} disabled={updatePasswordMutation.isPending}>
              {updatePasswordMutation.isPending ? 'Updating...' : 'Update Password'}
            </Button>
          </CardContent>
        </Card>

        {user && (
          <ActivityLog
            aggregateType="User"
            aggregateId={user.id}
            title="Activity Log"
            description="Your recent activity"
          />
        )}
      </div>
    </div>
  );
};
