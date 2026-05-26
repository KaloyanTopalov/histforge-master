"use client";

import type { AllSettings } from "@/lib/settings";
import { enumOptions } from "@/lib/settings-enums";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { GoogleFlowAccounts } from "./google-flow-accounts";
import {
  BoolField,
  FieldGrid,
  FieldGroup,
  NumberField,
  Panel,
  ReadOnlyField,
  SelectField,
  TextField,
} from "./field-primitives";

interface GoogleFlowTabProps {
  values: AllSettings;
  update: <K extends keyof AllSettings>(key: K, value: AllSettings[K]) => void;
}

export function GoogleFlowTab({
  values,
  update,
}: GoogleFlowTabProps): JSX.Element {
  return (
    <div className="space-y-6">
      <Panel>
        <GoogleFlowAccounts />
      </Panel>
      <Panel className="space-y-4">
        <SelectField
          id="google_flow_image_model"
          label="Image Model"
          value={values.google_flow_image_model}
          options={enumOptions("google_flow_image_model")}
          onChange={(v) =>
            update(
              "google_flow_image_model",
              v as AllSettings["google_flow_image_model"]
            )
          }
        />
        <SelectField
          id="google_flow_video_model"
          label="Video Model"
          value={values.google_flow_video_model}
          options={enumOptions("google_flow_video_model")}
          onChange={(v) =>
            update(
              "google_flow_video_model",
              v as AllSettings["google_flow_video_model"]
            )
          }
        />
        <SelectField
          id="google_flow_aspect_ratio"
          label="Aspect Ratio"
          value={values.google_flow_aspect_ratio}
          options={enumOptions("google_flow_aspect_ratio")}
          onChange={(v) =>
            update(
              "google_flow_aspect_ratio",
              v as AllSettings["google_flow_aspect_ratio"]
            )
          }
        />
        <SelectField
          id="google_flow_image_aspect_ratio"
          label="Image Aspect Ratio"
          value={values.google_flow_image_aspect_ratio}
          options={enumOptions("google_flow_image_aspect_ratio")}
          onChange={(v) =>
            update(
              "google_flow_image_aspect_ratio",
              v as AllSettings["google_flow_image_aspect_ratio"]
            )
          }
        />
        <SelectField
          id="google_flow_hook_clip_seconds"
          label="Hook Clip Seconds"
          value={values.google_flow_hook_clip_seconds}
          options={enumOptions("google_flow_hook_clip_seconds")}
          onChange={(v) =>
            update(
              "google_flow_hook_clip_seconds",
              v as AllSettings["google_flow_hook_clip_seconds"]
            )
          }
        />
      </Panel>
      <Collapsible className="space-y-4">
        <CollapsibleTrigger className="group inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:border-[hsl(225_22%_24%)] dark:hover:bg-[hsl(228_22%_12%)]">
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90 group-data-[state=open]:text-emerald-700 group-data-[state=open]:dark:text-emerald-300" />
          <span className="font-mono text-[11px] uppercase tracking-[0.18em]">
            Advanced
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-6">
          <FieldGroup title="Account">
            <FieldGrid>
              <NumberField
                id="google_flow_account_cooldown_hours"
                label="Account Cooldown (hours)"
                value={values.google_flow_account_cooldown_hours}
                onChange={(v) =>
                  update("google_flow_account_cooldown_hours", v)
                }
              />
              <ReadOnlyField
                id="google_flow_relogin_needed"
                label="Relogin Needed"
                value={String(values.google_flow_relogin_needed)}
              />
            </FieldGrid>
          </FieldGroup>

          <FieldGroup title="Dispatch">
            <FieldGrid>
              <NumberField
                id="google_flow_max_retries"
                label="Max Retries"
                value={values.google_flow_max_retries}
                onChange={(v) => update("google_flow_max_retries", v)}
              />
              <NumberField
                id="google_flow_dispatch_timeout_minutes"
                label="Dispatch Timeout (minutes)"
                value={values.google_flow_dispatch_timeout_minutes}
                onChange={(v) =>
                  update("google_flow_dispatch_timeout_minutes", v)
                }
              />
            </FieldGrid>
          </FieldGroup>

          <FieldGroup title="Content moderation">
            <FieldGrid>
              {/*
                Bool round-trip: form holds boolean; PATCH stringifies via
                String(value) → "true"/"false"; the per-key Zod enum parses
                that and transforms back to boolean on read. Same shape as
                voice_use_speaker_boost.
              */}
              <BoolField
                id="google_flow_content_moderation_enabled"
                label="Enabled"
                value={values.google_flow_content_moderation_enabled}
                onChange={(v) =>
                  update("google_flow_content_moderation_enabled", v)
                }
              />
              <NumberField
                id="google_flow_content_moderation_max_rounds"
                label="Max Rounds"
                value={values.google_flow_content_moderation_max_rounds}
                onChange={(v) =>
                  update("google_flow_content_moderation_max_rounds", v)
                }
              />
            </FieldGrid>
            <TextField
              id="google_flow_content_moderation_model"
              label="Moderation Model"
              value={values.google_flow_content_moderation_model}
              onChange={(v) =>
                update("google_flow_content_moderation_model", v)
              }
              hint="leave blank to use the provider's visual model"
            />
          </FieldGroup>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
