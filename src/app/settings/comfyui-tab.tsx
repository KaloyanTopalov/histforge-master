"use client";

import type { AllSettings } from "@/lib/settings";
import { enumOptions } from "@/lib/settings-enums";
import { Panel, SelectField, TextField } from "./field-primitives";

interface ComfyuiTabProps {
  values: AllSettings;
  update: <K extends keyof AllSettings>(key: K, value: AllSettings[K]) => void;
}

export function ComfyuiTab({ values, update }: ComfyuiTabProps): JSX.Element {
  return (
    <Panel className="space-y-4">
      <SelectField
        id="image_provider"
        label="Image Provider"
        value={values.image_provider}
        options={enumOptions("image_provider")}
        onChange={(v) =>
          update("image_provider", v as AllSettings["image_provider"])
        }
      />
      <TextField
        id="comfyui_base_url"
        label="ComfyUI Base URL"
        value={values.comfyui_base_url}
        onChange={(v) => update("comfyui_base_url", v)}
      />
      <TextField
        id="comfyui_workflow_path"
        label="ComfyUI Workflow Path"
        value={values.comfyui_workflow_path}
        onChange={(v) => update("comfyui_workflow_path", v)}
      />
      <TextField
        id="comfyui_hook_video_workflow_path"
        label="ComfyUI Hook Video Workflow Path"
        value={values.comfyui_hook_video_workflow_path}
        onChange={(v) => update("comfyui_hook_video_workflow_path", v)}
      />
    </Panel>
  );
}
