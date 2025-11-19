import { useState } from 'react';
import type { AvatarOption } from '../../types/api';
import { Button } from '../ui/button';
import { Label } from '../ui/label';

type AvatarSelectorProps = {
  currentAvatarUrl?: string;
  onSelect: (url: string) => void;
};

// Generate avatar options from Pravatar.cc
const AVATAR_OPTIONS: AvatarOption[] = Array.from({ length: 70 }, (_, i) => ({
  id: i + 1,
  url: `https://i.pravatar.cc/150?img=${i + 1}`,
}));

export const AvatarSelector = ({ currentAvatarUrl, onSelect }: AvatarSelectorProps) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedUrl, setSelectedUrl] = useState(currentAvatarUrl || '');

  const handleSelect = (url: string) => {
    setSelectedUrl(url);
    onSelect(url);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Label>Avatar</Label>
        <Button type="button" variant="outline" size="sm" onClick={() => setIsExpanded(!isExpanded)}>
          {isExpanded ? 'Hide' : 'Show'} Options
        </Button>
      </div>

      {selectedUrl && (
        <div className="flex items-center gap-3">
          <img src={selectedUrl} alt="Selected avatar" className="aspect-square h-16 w-16 rounded-full object-cover" />
          <p className="text-sm text-muted-foreground">Current selection</p>
        </div>
      )}

      {isExpanded && (
        <div className="grid max-h-96 grid-cols-4 gap-3 overflow-y-auto rounded border p-3 sm:grid-cols-6 md:grid-cols-8">
          {AVATAR_OPTIONS.map((option) => (
            <div
              key={option.id}
              className={`aspect-square h-12 w-12 cursor-pointer overflow-hidden rounded-full border-2 transition-all hover:scale-110 ${
                selectedUrl === option.url ? 'border-primary' : 'border-transparent'
              }`}
              onClick={() => handleSelect(option.url)}
            >
              <img src={option.url} alt={`Avatar ${option.id}`} className="h-full w-full rounded-full object-cover" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
