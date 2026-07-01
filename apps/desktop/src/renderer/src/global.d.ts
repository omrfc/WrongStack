import type { WrongStackDesktopApi } from '../../shared/types.js';

declare global {
  interface Window {
    wrongstackDesktop: WrongStackDesktopApi;
  }
}
