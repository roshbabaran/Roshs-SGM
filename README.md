# SGM Desktop & Mobile
Desktop and Mobile Application of the Inventory Management and Point of Sale System for Sibugay Gas Marketing. The application aims to streamline the LPG-business workflow both within the store and in the warehouse by digitizing the information flow.

## What's in this repository

| Folder | What it is |
| --- | --- |
| `apps/desk` | **SGM Desk**, the Windows app for the store counter and the office. React Native screens (Expo, web build) inside Electron, installed with a normal Windows installer. |
| `apps/pocket` | **SGM Pocket**, the Android and iOS app (Expo) for selling and checking stock away from the counter. |
| `packages/core` | The business rules both apps share: roles, the stock ledger, sales, receipts, offline sign-in and sync. Has its own tests. |
| `packages/ui` | The shared components and screens: sidebar layout, tables, forms, dialogs, toasts, charts, receipt preview, and the login, sell, borrowing, inventory, transactions, reports, products, users and settings screens. |

Both apps show the same screens; only the parts that touch the device differ (database, secure storage, printing).

## Getting started

You need [Node.js](https://nodejs.org) 22.13 or newer (22 or 24 LTS) and npm. Building the Windows installer needs a Windows PC. On Windows, keep the repository in a folder whose path has no `&` in it, because npm can't start the project's tools (Expo, TypeScript, Vitest, electron-builder) from there.

```sh
npm install
npm run desk        # SGM Desk in its window, reloads as you edit the screens
npm run pocket      # SGM Pocket: scan the QR code with the Expo Go app (SDK 57)
npm test            # business-rule tests
npm run typecheck   # TypeScript checks for every package
```

| Command | What it does |
| --- | --- |
| `npm run desk` | Starts the Expo dev server and opens SGM Desk in Electron. |
| `npm run desk:web` | SGM Desk's screens in a browser, for design work. Data stays in that browser. |
| `npm run desk:build` | Builds the screens and the Electron code into `apps/desk/build/app`. |
| `npm run desk:dist` | Builds the Windows installer into `apps/desk/release/`. |
| `npm run desk:release` | Uploads that installer to the private releases repo, so installed copies update. |
| `npm run pocket:release -- <apk>` | Uploads an APK from `eas build` to the private releases repo, so phones offer the update. |
| `npm run pocket` / `npm run pocket:android` | Starts SGM Pocket (Expo Go, or an Android emulator). |
| `npm run ocr:models` | Downloads the receipt reading models into `models/ocr/`. Receipt scanning needs them in both apps. |

### Demo mode

Until `EXPO_PUBLIC_API_URL` is set (below), both apps run against a built-in demo server with sample products, opening stock and a week of sales. Sign in with:

| Username | PIN | Role | Can |
| --- | --- | --- | --- |
| `owner` | `1111` | Owner | Everything, including reports, products and sets, users, voiding sales and device settings |
| `cashier` | `2222` | Employee | Dashboard, sell, borrowing, transactions, view stock |
| `warehouse` | `3333` | Warehouse staff | View stock and record movements (deliveries, transfers, damage) |

In SGM Desk, **Settings → Simulate no connection** shows offline mode: sales keep working and sync when the connection returns. **Reset demo data** puts the sample data back. The sample data has three sets and three borrowers; if a device ran the app before they were added, use **Reset demo data** once to see them.

To use the real server, create `apps/desk/.env.local` and `apps/pocket/.env.local` with:

```sh
EXPO_PUBLIC_API_URL=https://<Project ID>.supabase.co/functions/v1/api
```

Then restart `npm run desk` or `npx expo start -c`, or rebuild the installer and APK, since the address is built into the app.

### The server (Supabase)

The server is a Supabase project. Everything for it is in `supabase/`:

- `schema.sql` creates SGM's tables in their own `sgm` schema, which Supabase's public API keys can't reach. Run it once in the project's SQL Editor.
- `functions/api/index.ts` is the API the apps call (`packages/core/src/api.ts`). It checks every change against the roles in `packages/core/src/roles.ts`, so keep its copy of them in step.

Deploy the API after changing it. It needs one secret, `SGM_JWT_SECRET`, set under **Edge Functions → Secrets**.

```sh
npx supabase functions deploy api --no-verify-jwt --use-api --project-ref <Project ID>
```

Users, PINs and devices are managed in the SQL Editor. A new PC or phone can't sign in until it is approved; its sign-in message shows its Device ID.

```sql
select sgm.add_location('branch-3', 'Third branch', 'branch');
select sgm.add_user('maria', 'Maria Santos', 'employee', array['branch-main'], '4821');
select sgm.reset_pin('maria', '9035');
select sgm.set_user_active('maria', false);
select sgm.approve_device('<Device ID>', 'Main branch counter PC');
```

## Releases and updates

Both apps are released privately: each version is a release in the private GitHub repo `NathBajamunde/SGM-Releases`, and the SGM API hands the files only to signed-in people on approved devices (`/api/updates/...` in `supabase/functions/api/index.ts`, using the `GITHUB_RELEASES_REPO` and `GITHUB_RELEASES_TOKEN` secrets).

- **SGM Desk:** raise `version` in `apps/desk/package.json`, run `npm run desk:dist`, then `npm run desk:release`. Installed copies download the update in the background and install it when SGM Desk closes, or straight away from the "Update" bar. The installer is one-click and per Windows user, so updates never ask for an administrator password.
- **SGM Pocket, screens and logic:** from `apps/pocket`, `eas update --channel production --message "What changed"`. Phones pick it up on their next launches; no reinstall. These updates are tied to the app `version`, so they only reach phones whose APK has the same version; anything native must ship as a new APK instead (next point).
- **SGM Pocket, native changes** (a new or upgraded package with native code, an Expo SDK upgrade, or `app.json` plugins, permissions, icon or splash): raise `version` and `android.versionCode` in `apps/pocket/app.json`, run `eas build -p android --profile production`, then `npm run pocket:release -- <the .apk>`. Phones show an "Update" bar; Android asks the person to confirm the install, and the app keeps its data.
- **Signing key:** every APK must be signed with the same key (kept by EAS; download a copy with `eas credentials`). An APK signed with another key can't update the installed app.

### Turning SGM off, or forcing an update

`sgm.app_policy` holds a minimum version for each app and an on/off switch. When it says no, the API refuses sign-in and sync, and the apps show "Update required" or "SGM is turned off" until it says yes again. Sales recorded meanwhile stay on the device and sync afterwards.

```sql
update sgm.app_policy set min_version = '1.2.0', message = 'Please update SGM Desk.' where platform = 'desk';
update sgm.app_policy set enabled = false, message = 'SGM is down for maintenance until 3 PM.';
update sgm.app_policy set enabled = true, message = null;
```

Only raise `min_version` to a version that is already released, or every device is locked out with nothing to update to.

### Backups

SGM Desk copies its local database into a `Backups` folder in the Windows account's app data (`%APPDATA%\SGM Desk\Backups`) once a week, and keeps the newest 12. In **Settings → Backups**, the owner and anyone given `backups.manage` can back up now and open the folder; nobody else sees the card, and the main process refuses the request too. Give someone those rights (an admin) with:

```sql
select sgm.set_extra_permissions('maria', array['backups.manage']);
```

A backup holds everything that PC has synced plus changes not yet sent; it opens in any SQLite viewer. Other Windows accounts on the PC can't open the folder, but anyone using the same Windows account can, so give each cashier their own Windows account if that matters. The server's own copy is Supabase's backups (Pro plan).

## How it works

- **Offline first.** Each device keeps its own SQLite database: SGM Desk uses the SQLite built into Electron (`node:sqlite`, no native modules to compile) and SGM Pocket uses `expo-sqlite`. Every change also goes into an outbox, and `SyncEngine` sends it to the server and brings back other devices' changes, every minute and right after each new sale or stock movement.
- **Stock is a ledger.** Stock on hand is never typed over; it is the sum of movements (delivery, sale, transfer, adjustment, damage). Two offline devices can sell at the same time and sync later without overwriting each other. Full and empty cylinders are counted separately: a refill sale takes an empty back, a new-cylinder sale also takes an empty off the shelf (see `NEW_SALE_TAKES_EMPTY` below), and a borrowed cylinder goes out full and comes back as an empty.
- **Borrowing is a ledger too.** Refills on credit, lent cylinders, returns and payments are entries in `loans`. What someone owes and how many cylinders they have out are sums of their entries; payments and returns settle the oldest first, so every open item keeps the date it was borrowed.
- **Money is in centavos** (whole numbers), so totals never pick up rounding errors.
- **Handwritten receipts can be scanned into a sale.** On the Sell screen, **Scan receipt** reads a photo offline with PaddleOCR's models, and the cashier checks every line against the photo before it goes into the cart. The receipt number is saved with the sale so the same receipt can't be entered twice. SGM Pocket needs its development build for this (`npx expo run:android`), not Expo Go. See `packages/core/src/ocr/README.md`.
- **Signing in needs the server.** After that, a device works offline for up to 72 hours before it must reach the server again.
- **Roles live in `packages/core/src/roles.ts`.** The apps hide menus and buttons a person can't use, but the server must check the same permissions on every request.

### SGM Desk's security

- The screens run sandboxed with no access to Node.js or the disk. They can only call the functions in `apps/desk/electron/preload.ts`, and the main process checks every call.
- The screens load from `app://sgm/` with a Content-Security-Policy that only allows SGM's own files and the API server.
- The sign-in token is encrypted with Windows' own encryption (DPAPI, through Electron `safeStorage`).
- The window can't navigate to other sites; links open in the normal browser.
- Only one copy of SGM Desk runs at a time, so two windows never write to the same database.

The API server must allow requests from the origin `app://sgm` (CORS), and from `http://localhost:8081` while developing.

## Where to change things

| To change | Edit |
| --- | --- |
| Business name, address, TIN, receipt footer, offline limit, sync interval | `packages/core/src/config.ts` |
| Whether selling a new cylinder also takes an empty off the shelf | `NEW_SALE_TAKES_EMPTY` in `packages/core/src/config.ts` |
| Products, prices and sets | The **Products** page in either app (owner only); no code needed |
| The printed sales report | `salesReportHtml()` in `packages/core/src/reports.ts` |
| Roles and permissions | `packages/core/src/roles.ts` |
| Colours | `packages/ui/src/theme.tsx` |
| SGM Desk's menu and keyboard shortcuts | `apps/desk/src/navigation.ts` |
| SGM Pocket's tabs and its More page | `apps/pocket/src/app/(app)/_layout.tsx` and `apps/pocket/src/app/(app)/more/index.tsx` |
| What the server must provide | `packages/core/src/api.ts` |
| Sample products and demo accounts | `packages/core/src/demo.ts` |
| The Windows installer and where it looks for updates | `apps/desk/electron-builder.yml` |
| SGM Pocket's builds (server address, CPU type, update channel) | `apps/pocket/eas.json` |
| Who may make and open backups | `backups.manage` in `packages/core/src/roles.ts`, and `sgm.set_extra_permissions` |
| How receipts are read (photo checks, thresholds, matching) | `packages/core/src/ocr/` (see its `README.md`) |

## Next steps

1. Before the store relies on it, move the Supabase project to the Pro plan: the free plan has no backups and pauses after a week without use.
2. Replace the placeholder address and TIN in `packages/core/src/config.ts`. Receipts say "THIS IS NOT AN OFFICIAL RECEIPT" until the system is registered with the BIR.
3. Sign the Windows installer so SmartScreen doesn't warn on the first install of each PC (optional; updates work without it).
4. If SGM Pocket needs to print to Bluetooth receipt printers, add an ESC/POS printing library (`receiptText()` in `packages/core/src/receipt.ts` is the starting point).
5. Try receipt scanning on real receipts from the store and on the phones the staff will use, then tune it (`packages/core/src/ocr/README.md`). The sample receipts so far are written in a handwriting font.

## Troubleshooting

- **A command fails with "is not recognized as an internal or external command" or "Cannot find module".** The folder's path probably contains `&`, which breaks the launchers npm uses on Windows. Rename the folder (for example to `SGM-Desktop-Mobile`) and run the command again. Android native builds can also fail on long paths, so clone the repository to a short path such as `C:\dev\sgm` before building one.
- **Windows warns about the installer.** Unsigned installers show a SmartScreen warning; choose **More info → Run anyway**. Code signing removes it.
- **`npm audit` shows warnings.** They come from Expo's and electron-builder's build tools, plus one in Expo Router's URL parsing, and clear as those packages update.
