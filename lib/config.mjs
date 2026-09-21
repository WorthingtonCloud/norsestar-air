// Runtime settings, filled in by whoever starts the app: lib/env.mjs on the server (from .env),
// public/app.js in the bring-your-own-key build (from the key the visitor pastes).
// Nothing in here touches Node, so the modules that read it run in a browser unchanged.
export const config = {};
export const configure = (values) => Object.assign(config, values);
