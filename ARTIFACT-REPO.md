# Synclistic Artifact Repo

This repository is a publishable release artifact exported from the private Synclistic monorepo.

Notes:
- `node_modules/@synclistic/*` is committed intentionally because the public npm package bundles those private runtime workspaces.
- This repo mirrors the publishable package contents, not a standalone development checkout.
- Validate the artifact by running `npm pack` here and installing the generated tarball into a clean temp directory.
- Do not run `npm install` here unless you intend to rebuild the artifact from source elsewhere.
- Publish from this repo with `npm publish`.
- Regenerate this repo by re-running the export script from the private monorepo.

Export source metadata was rewritten for: https://github.com/bradongamor/synclistic-cli
