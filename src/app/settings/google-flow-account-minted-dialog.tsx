"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MintedAccount } from "./google-flow-accounts-hooks";

async function copyToken(m: MintedAccount): Promise<void> {
  await navigator.clipboard.writeText(m.token);
}

export interface FlowAccountMintedDialogProps {
  minted: MintedAccount;
  onClose: () => void;
}

export function FlowAccountMintedDialog({
  minted,
  onClose,
}: FlowAccountMintedDialogProps): JSX.Element {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Account {minted.id} created</DialogTitle>
          <DialogDescription>
            Save this token now — it will never be shown again. Paste it into
            the YouForge Flow extension&rsquo;s Account token field.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-xs">
          <div>
            <div className="font-medium">Token</div>
            <code className="block break-all rounded bg-muted p-2">
              {minted.token}
            </code>
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => void copyToken(minted)}
          >
            Copy token
          </Button>
          <Button type="button" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
