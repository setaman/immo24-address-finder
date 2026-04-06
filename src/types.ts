// Shared types for the extension

import type { Address as DecoderAddress } from '@immo24/decoder';

export type AddressConfidence = 'exact' | 'high' | 'medium' | 'low';

export interface Address extends DecoderAddress {
  lat?: number;
  lng?: number;
  confidence?: AddressConfidence;
  source?: string;
}

export type MapProvider = 'google' | 'osm' | 'apple';
export type Position = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
export type Theme = 'dark' | 'light';
export type LocaleOverride = 'auto' | 'de' | 'en' | 'es' | 'it';

export interface Settings {
  mapProvider: MapProvider;
  autoCopy: boolean;
  showEarth: boolean;
  showDates: boolean;
  position: Position;
  theme: Theme;
  localeOverride: LocaleOverride;
}

export interface ToggleOverlayMessage { type: 'IS24_TOGGLE_OVERLAY'; }
