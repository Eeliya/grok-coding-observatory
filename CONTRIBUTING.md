# Contributing

Thanks for helping improve grok-coding-observatory! Bug reports, ideas and pull requests are all
welcome.

## Issues

Found a bug or have an idea? [Open an issue](https://github.com/Eeliya/grok-coding-observatory/issues).
For bugs, include your OS (and whether you run it in WSL), your Node.js version (`node -v`), what you
did, what you expected and what happened instead.

## Pull requests

We use the usual **fork → branch → pull request** flow:

1. [Fork the repository](https://github.com/Eeliya/grok-coding-observatory/fork) on GitHub.
2. Clone your fork and create a branch:

   ```bash
   git clone https://github.com/<you>/grok-coding-observatory.git
   cd grok-coding-observatory
   git checkout -b my-change
   ```

3. Install and run it against any git repo (Node.js 22.6+; `nvm use` picks the version from
   `.nvmrc`):

   ```bash
   npm install
   npm start -- /path/to/a/repo   # then open http://localhost:4477
   ```

4. Make your change. Keep it focused: one fix or feature per pull request, with tests where it makes
   sense (`test/`, `node:test`).
5. Run the checks before pushing:

   ```bash
   npm run check   # typecheck + prettier check + tests
   npm test        # tests only
   npm run format  # prettier --write . (fixes formatting)
   ```

6. Push your branch and open a pull request against `main`. Describe what changed and why, and how
   you tested it (screenshots help for UI changes).

The README's [Development](README.md#development) section explains how the code is organized. The
project website lives in `site/` (plain HTML/CSS, built by `site/build.sh` and published by
`.github/workflows/pages.yml`).

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
