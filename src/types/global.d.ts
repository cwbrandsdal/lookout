import type { LookoutApi } from './electron-api';

interface LocalFontData {
  family: string;
  fullName?: string;
  postscriptName?: string;
  style?: string;
}

declare global {
  interface Window {
    lookout: LookoutApi;
    queryLocalFonts?: () => Promise<LocalFontData[]>;
  }
}

export {};
