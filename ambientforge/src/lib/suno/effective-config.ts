import type { Album } from '@/lib/repos/albums';
import type { Channel, SunoMode } from '@/lib/repos/channels';

export type EffectiveSunoConfig = {
  model: string;
  mode: SunoMode;
  instrumental: boolean;
  personaId: string | null;
};

export function resolveEffectiveSunoConfig(album: Album, channel: Channel): EffectiveSunoConfig {
  return {
    model: album.sunoModel ?? channel.sunoModel,
    mode: album.sunoMode ?? channel.sunoMode,
    instrumental: album.sunoInstrumental ?? channel.sunoInstrumental,
    personaId: album.sunoPersonaId ?? channel.sunoPersonaId,
  };
}
