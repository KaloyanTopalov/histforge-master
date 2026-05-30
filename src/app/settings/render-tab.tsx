"use client";

import type { AllSettings } from "@/lib/settings";
import { enumOptions } from "@/lib/settings-enums";
import { BoolField, NumberField, Panel, SelectField } from "./field-primitives";

interface RenderTabProps {
  values: AllSettings;
  update: <K extends keyof AllSettings>(key: K, value: AllSettings[K]) => void;
}

export function RenderTab({ values, update }: RenderTabProps): JSX.Element {
  return (
    <Panel className="space-y-4">
      <SelectField
        id="aspect_ratio"
        label="Aspect Ratio"
        value={values.aspect_ratio}
        options={enumOptions("aspect_ratio")}
        onChange={(v) =>
          update("aspect_ratio", v as AllSettings["aspect_ratio"])
        }
      />
      <NumberField
        id="long_edge_px"
        label="Long Edge (px)"
        value={values.long_edge_px}
        onChange={(v) => update("long_edge_px", v)}
      />
      <SelectField
        id="framerate"
        label="Frame Rate"
        value={String(values.framerate)}
        options={enumOptions("framerate")}
        onChange={(v) =>
          update("framerate", Number(v) as AllSettings["framerate"])
        }
      />
      <SelectField
        id="video_encoder"
        label="Encoder"
        value={values.video_encoder}
        options={enumOptions("video_encoder")}
        onChange={(v) =>
          update("video_encoder", v as AllSettings["video_encoder"])
        }
      />
      <BoolField
        id="auto_cleanup_after_render"
        label="Wipe intermediates automatically after render (images, audio, alignment, chunks) — off by default; recommended to leave off unless you don't need intermediates for retry/diagnosis."
        value={values.auto_cleanup_after_render}
        onChange={(v) => update("auto_cleanup_after_render", v)}
      />
    </Panel>
  );
}
