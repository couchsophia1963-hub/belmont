# belmont

[![Open in Bolt](https://bolt.new/static/open-in-bolt.svg)](https://bolt.new/~/sb1-dq6blzts)

The Belmont County News site. See [docs/hosting.md](docs/hosting.md) for where it
runs, what the host has to serve for deep links to work, and the check to run
before a deploy.

```
npm install
npm run dev          # local dev server
npm run build        # production build into dist/
npm run typecheck    # tsc, no emit
npm run lint         # eslint
npm run check        # routing and story-URL cases
npm run check:host -- https://the-host   # is a deep link safe on that host?
```