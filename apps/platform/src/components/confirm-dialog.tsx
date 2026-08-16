import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * A deliberate second step in front of an action that is hard to undo.
 *
 * Everything it shows is a prop, already translated. What it contributes is
 * the parts that are easy to get wrong and easy to forget: a real dialog with
 * a title and a description (Radix requires both, and a screen-reader user is
 * told what they are confirming rather than just "dialog"), a focus trap, a
 * disabled state while the action runs, and `aria-busy` for the half of the
 * audience that cannot see the spinner.
 *
 * The buttons are in a `DialogFooter`, which stacks them on a narrow screen
 * and lays them out along the reading direction on a wide one. Confirm sits at
 * the end edge in both directions.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  isPending = false,
  isDestructive = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  /** Extra explanation shown above the buttons. */
  children?: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel: ReactNode;
  onConfirm: () => void;
  isPending?: boolean;
  isDestructive?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {children}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {cancelLabel}
          </Button>

          <Button
            type="button"
            variant={isDestructive ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={isPending}
            aria-busy={isPending}
          >
            {isPending ? <Loader2 className="animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
