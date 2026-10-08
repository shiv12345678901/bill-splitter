# Checks

Run `npm test` for domain and isolated server checks. Fixtures write only to a new temporary directory.

Start `npm run preview:ui` in another terminal, then run `npm run test:ui`. Browser scripts refuse to run outside the isolated 127.0.0.1:4173 preview. They do not scan WhatsApp or write production history. Screenshots go to `output/playwright/`.

Coverage includes expense editing, exact-cent accounting, confirmation/reset, history safety, failed image recovery, drafts, filters, pagination, offline reload and 40 light/dark desktop layouts. Expected offline network errors are distinct from JavaScript page errors.
