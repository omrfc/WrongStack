// Type declarations for CSS and font imports used by the webui client bundle.
// These are resolved by Vite at build time but TypeScript needs a stub for DTS generation.

declare module '*.css' {
  const css: string;
  export default css;
}

declare module '@fontsource-variable/ibm-plex-sans' {
  const _: string;
  export default _;
}

declare module '@fontsource/ibm-plex-mono/400.css' {
  const _: string;
  export default _;
}

declare module '@fontsource/ibm-plex-mono/500.css' {
  const _: string;
  export default _;
}

declare module '@fontsource/ibm-plex-mono/600.css' {
  const _: string;
  export default _;
}
