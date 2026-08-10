/// <reference types="vite/client" />

// `import.meta.env.DEV` decides whether this demo pairs two panes in one tab or
// joins a real room, and its type came from wherever `vite/client` happened to
// be resolvable — which is not a place a build should depend on. Vite's own
// convention, stated once, so `pnpm typecheck` does not depend on the shape of
// node_modules.
