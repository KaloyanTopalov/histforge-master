import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { ffprobeAudio, validateAudio, audioFileValid } from '@/lib/suno/audio';
import { SunoError } from '@/lib/suno/client';

const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'suno');

describe('lib/suno/audio', () => {
  describe('validateAudio', () => {
    it('accepts a known-good Suno-shape fixture (48kHz, 16-bit, stereo, 35s)', () => {
      expect(() =>
        validateAudio({ sampleRate: 48000, bitDepth: 16, channels: 2, duration: 35 }),
      ).not.toThrow();
    });

    it('accepts 24-bit @ 44.1kHz @ exactly 30s', () => {
      expect(() =>
        validateAudio({ sampleRate: 44100, bitDepth: 24, channels: 2, duration: 30 }),
      ).not.toThrow();
    });

    it('rejects sample rate below 44.1kHz', () => {
      expect(() =>
        validateAudio({ sampleRate: 22050, bitDepth: 16, channels: 2, duration: 35 }),
      ).toThrowError(/sample rate/i);
    });

    it('rejects bit depth not in {16, 24}', () => {
      expect(() =>
        validateAudio({ sampleRate: 48000, bitDepth: 32, channels: 2, duration: 35 }),
      ).toThrowError(/bit depth/i);
      expect(() =>
        validateAudio({ sampleRate: 48000, bitDepth: 8, channels: 2, duration: 35 }),
      ).toThrowError(/bit depth/i);
    });

    it('rejects mono', () => {
      expect(() =>
        validateAudio({ sampleRate: 48000, bitDepth: 16, channels: 1, duration: 35 }),
      ).toThrowError(/channels/i);
    });

    it('rejects duration shorter than 30s', () => {
      expect(() =>
        validateAudio({ sampleRate: 48000, bitDepth: 16, channels: 2, duration: 25 }),
      ).toThrowError(/duration/i);
    });

    it('throws SunoError with code INVALID_AUDIO_FORMAT and retriable=true', () => {
      try {
        validateAudio({ sampleRate: 22050, bitDepth: 16, channels: 1, duration: 5 });
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(SunoError);
        const e = err as SunoError;
        expect(e.code).toBe('INVALID_AUDIO_FORMAT');
        expect(e.retriable).toBe(true);
      }
    });
  });

  describe('ffprobeAudio + audioFileValid (real ffprobe binary)', () => {
    it('accepts a generated 48kHz/16-bit/stereo/35s fixture', async () => {
      const meta = await ffprobeAudio(path.join(FIXTURE_DIR, 'fixture-01.wav'));
      expect(meta.sampleRate).toBe(48000);
      expect(meta.bitDepth).toBe(16);
      expect(meta.channels).toBe(2);
      expect(meta.duration).toBeGreaterThanOrEqual(34.9);
      expect(() => validateAudio(meta)).not.toThrow();
      expect(await audioFileValid(path.join(FIXTURE_DIR, 'fixture-01.wav'))).toBe(true);
    });

    it('rejects bad-fixture.wav (mono, 22kHz, 10s)', async () => {
      const meta = await ffprobeAudio(path.join(FIXTURE_DIR, 'bad-fixture.wav'));
      expect(meta.channels).toBe(1);
      expect(meta.sampleRate).toBe(22050);
      expect(() => validateAudio(meta)).toThrowError(SunoError);
      expect(await audioFileValid(path.join(FIXTURE_DIR, 'bad-fixture.wav'))).toBe(false);
    });

    it('audioFileValid returns false for non-existent file', async () => {
      expect(await audioFileValid(path.join(FIXTURE_DIR, 'does-not-exist.wav'))).toBe(false);
    });
  });
});
