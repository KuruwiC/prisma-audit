import { useState } from 'react';
import type { AttachmentOption } from '../../types/api';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';

type AttachmentSelectorProps = {
  selectedUrls: string[];
  onSelectionChange: (urls: string[]) => void;
};

// Generate attachment options from Picsum Photos (high-quality placeholder images)
const ATTACHMENT_OPTIONS: AttachmentOption[] = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  url: `https://picsum.photos/seed/${100 + i}/400/300`,
  width: 400,
  height: 300,
}));

export const AttachmentSelector = ({ selectedUrls, onSelectionChange }: AttachmentSelectorProps) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const toggleAttachment = (url: string) => {
    if (selectedUrls.includes(url)) {
      onSelectionChange(selectedUrls.filter((u) => u !== url));
    } else {
      onSelectionChange([...selectedUrls, url]);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Label>Attachments ({selectedUrls.length} selected)</Label>
        <Button type="button" variant="outline" size="sm" onClick={() => setIsExpanded(!isExpanded)}>
          {isExpanded ? 'Hide' : 'Show'} Images
        </Button>
      </div>

      {isExpanded && (
        <div className="grid grid-cols-2 gap-3 rounded border p-3 sm:grid-cols-3 md:grid-cols-4">
          {ATTACHMENT_OPTIONS.map((option) => (
            <div key={option.id} className="flex flex-col gap-2">
              <div
                className={`cursor-pointer overflow-hidden rounded border-2 transition-all ${
                  selectedUrls.includes(option.url) ? 'border-primary' : 'border-transparent'
                }`}
                onClick={() => toggleAttachment(option.url)}
              >
                <img src={option.url} alt={`Attachment ${option.id}`} className="h-24 w-full object-cover" />
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`attachment-${option.id}`}
                  checked={selectedUrls.includes(option.url)}
                  onCheckedChange={() => toggleAttachment(option.url)}
                />
                <Label htmlFor={`attachment-${option.id}`} className="text-xs font-normal">
                  Image {option.id}
                </Label>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
