import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@repo/ui';
import { Loader2, ShieldAlert } from 'lucide-react';
import { useTranslations } from 'use-intl';

import type { AdminUserInfo } from './admin-users-table';

type BanUserDialogProps = {
  user: AdminUserInfo | null;
  banReason: string;
  isBanning: boolean;
  onReasonChange: (reason: string) => void;
  onClose: () => void;
  onConfirm: () => void;
};

export function BanUserDialog({
  user,
  banReason,
  isBanning,
  onReasonChange,
  onClose,
  onConfirm,
}: BanUserDialogProps) {
  const t = useTranslations('AdminUsers');

  if (!user) return null;

  return (
    <Dialog open={Boolean(user)} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">
            {t('dialogs.banTitle')}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {t('dialogs.banDescription', { name: user.name || user.email })}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2 space-y-2">
          <Input
            type="text"
            placeholder={t('dialogs.banReason')}
            value={banReason}
            onChange={(e) => onReasonChange(e.target.value)}
            className="text-xs h-8"
          />
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} className="h-8 text-xs">
            {t('dialogs.cancel')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            disabled={isBanning}
            className="h-8 text-xs font-semibold gap-1.5"
          >
            {isBanning ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldAlert className="size-3.5" />}
            {t('dialogs.banSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
