"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AccountListItem } from "@/lib/flow-account-status";

export interface FlowAccountDeleteConfirmProps {
  account: AccountListItem;
  onConfirm: () => void;
  onCancel: () => void;
}

export function FlowAccountDeleteConfirm({
  account,
  onConfirm,
  onCancel,
}: FlowAccountDeleteConfirmProps): JSX.Element {
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete account {account.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Any tasks dispatched to this account will be requeued for
            other accounts to pick up. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            className={cn(buttonVariants({ variant: "destructive" }))}
          >
            Confirm
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
