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
| `owner` | `1111` | Owner | Everything, including reports, products and sets, users and devices, discounts, approving returns and defectives, voiding sales and device settings |
| `admin` | `4444` | Admin | Everything the owner can, but can't change the owner's or other admins' accounts |
| `manager` | `5555` | Branch manager | Runs Main Branch only: sell, discounts, sales on credit, cheques, approving returns and defectives, voiding sales, stock (including accepting stock sent to it) and reports. Not products, users and devices, or backups |
| `cashier` | `2222` | Employee | Dashboard, sell, claims (pick ups, and returns and defectives that wait for approval), borrowing, transactions, view stock |
| `warehouse` | `3333` | Warehouse staff | View stock, record movements (deliveries, stock sent out, defectives), and accept stock sent to the Warehouse |

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

Users, PINs and devices are managed in the apps, in **Users & Devices** (the owner and admins; only the owner can change the owner's and admins' accounts). Every change there goes straight to the server and is never saved offline, so the page is locked while the server can't be reached. A new PC or phone can't sign in until it is approved there; its sign-in message shows its Device ID, or it can be added ahead of time with the ID from its Settings page. The first owner account, and new branches, are still made in the SQL Editor:

```sql
select sgm.add_location('branch-3', 'Third branch', 'branch');
select sgm.add_user('nathan', 'Nathan', 'owner', array['branch-main'], '4821');
```

The same functions (`sgm.reset_pin`, `sgm.set_user_active`, `sgm.approve_device`) still work there if nobody can sign in to Users & Devices.

**Device IDs.** Each PC and phone gets a Device ID the first time the app opens, and keeps it through updates. SGM Desk keeps it in `%APPDATA%\SGM Desk\device.json`, with a copy in `device.backup.json` next to it in case one is damaged (`apps/desk/electron/device.ts`). SGM Pocket keeps it in the phone's secure storage and in `device-id.txt` in the app's own folder (`apps/pocket/src/services/device-id.ts`). When both are gone (after Clear data or a reinstall), it works the same ID out again from Android's ID for the app, so only a factory reset gives a phone a new ID. A device that does get a new ID must be approved again; remove its old entry in Users & Devices.

#### Upgrading the server to 1.1.0

Run `supabase/upgrade-1.1.0.sql` once in the SQL Editor, then deploy the API as above. SGM 1.0 keeps working against the 1.1.0 API (it isn't sent Claims records, which it can't store), but it doesn't know the admin and branch manager roles (they can't sign in on it), doesn't count defective stock apart and sells a set that holds other sets with only its own items. So once the 1.1.0 installer and APK are released, raise the minimum version to 1.1.0 (the last lines of the upgrade file, and [Turning SGM off, or forcing an update](#turning-sgm-off-or-forcing-an-update)). SGM Pocket 1.1.0 is a new APK, not an `eas update`: its icon and version changed.

#### Upgrading the server to 1.1.1

Deploy the API as above; there is no SQL to run. 1.1.1 adds `POST /api/updates/login`, a sign-in that only lets a signed-out SGM Desk or SGM Pocket download an update (good for 30 minutes, even on a version too old to sign in). Versions before 1.1.1 can't use it, so release 1.1.1 and let devices update through the "Update" bar before raising the minimum version to 1.1.1.

## Releases and updates

Both apps are released privately: each version is a release in the private GitHub repo `NathBajamunde/SGM-Releases`, and the SGM API hands the files only to signed-in people on approved devices (`/api/updates/...` in `supabase/functions/api/index.ts`, using the `GITHUB_RELEASES_REPO` and `GITHUB_RELEASES_TOKEN` secrets).

- **SGM Desk:** raise `version` in `apps/desk/package.json`, run `npm run desk:dist`, then `npm run desk:release`. Installed copies download the update in the background and install it when SGM Desk closes, or straight away from the "Update" bar. The installer is one-click and per Windows user, so updates never ask for an administrator password.
- **SGM Pocket, screens and logic:** from `apps/pocket`, with the server address set the way `eas.json` sets it for builds (`eas update` doesn't read it from there; without it the update points Pocket at the demo server):

  ```powershell
  $env:EXPO_PUBLIC_API_URL = "https://<Project ID>.supabase.co/functions/v1/api"
  npx expo export -p android --output-dir "$env:TEMP\sgm-update"
  npx eas update --channel production --platform android --skip-bundler --input-dir "$env:TEMP\sgm-update" --message "What changed"
  ```

  Phones pick it up on their next launches; no reinstall. These updates are tied to the app `version`, so they only reach phones whose APK has the same version; anything native must ship as a new APK instead (next point). Never publish from a branch whose `version` or native packages differ from the installed APK's.
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

SGM Desk copies its local database into a `Backups` folder in the Windows account's app data (`%APPDATA%\SGM Desk\Backups`) once a week, and keeps the newest 12. In **Settings → Backups**, the owner and admins can back up now and open the folder; nobody else sees the card, and the main process refuses the request too. `backups.manage` can't be given to anyone else.

A backup holds everything that PC has synced plus changes not yet sent; it opens in any SQLite viewer. Other Windows accounts on the PC can't open the folder, but anyone using the same Windows account can, so give each cashier their own Windows account if that matters. The server's copy is the nightly backup below.

### Server backups

Every night at 11 PM (Philippine time) a GitHub Action, `.github/workflows/backup.yml`, backs up the server's data to a **SGM Backups** folder in Google Drive. It runs on GitHub, so no PC, phone or app needs to be on. It dumps the `sgm` schema with `pg_dump`, restores the file into an empty database to prove it works, uploads it as `SGM backup <date>.dump`, and deletes old ones: it keeps the newest 30, plus the first backup of each of the last 12 months (`scripts/backup/prune.mjs`). Deleted backups go to Drive's trash for 30 days. Each run uses about two of the 2,000 GitHub Actions minutes a private repository gets free each month, and a backup is small (about 20 KB today).

The **Actions** tab shows every run and, on each run's page, how many records the backup holds. **Run workflow** on "Back up the database" makes one now. If a nightly backup fails, GitHub emails whoever last changed its schedule in the workflow file (unless they've turned those emails off).

A backup holds everything on the server, including PIN hashes and customers' names, so keep the Drive folder private.

#### Setting it up

1. **A read-only login for the backup.** In the SQL Editor, create it with a long random password, then run `scripts/backup/backup-login.sql`:

   ```sql
   create role sgm_backup login bypassrls password '<password>';
   ```

   Its connection string is the **Session pooler** one from the dashboard's **Connect** button, with the user changed to `sgm_backup.<Project ID>` and that password: `postgresql://sgm_backup.<Project ID>:<password>@aws-<n>-<region>.pooler.supabase.com:5432/postgres`. (GitHub's runners have no IPv6, so the direct `db.<Project ID>.supabase.co` address doesn't work from there.)
2. **Permission to write to your Google Drive.** On a PC, install [rclone](https://rclone.org) (`winget install Rclone.Rclone`), open a new terminal and run the command below. A browser opens; sign in with the Google account whose Drive should hold the backups and allow access. `drive.file` lets the backup see only the files it makes, not the rest of your Drive.

   ```sh
   rclone config create gdrive drive scope=drive.file
   rclone config show gdrive
   ```

   Copy the part after `token = `, from `{` to `}`. Don't make the SGM Backups folder yourself: the first backup makes it, and a folder made any other way is invisible to it.
3. **The secrets.** In the repository on GitHub, **Settings → Secrets and variables → Actions → New repository secret**: `SGM_BACKUP_DATABASE_URL` (step 1) and `GDRIVE_TOKEN` (step 2).
4. **Try it.** **Actions → Back up the database → Run workflow**, then check the SGM Backups folder in Drive.

If the backups start failing with a Google sign-in error (for example after rclone's access is removed in the Google account's security settings), make a new token (step 2) and replace `GDRIVE_TOKEN`.

#### Restoring a backup

A restore replaces everything in the `sgm` schema with the backup, in one transaction: if anything goes wrong, nothing changes. Everything that reached the server after that backup is lost from the server. A PC or phone that made or downloaded those changes keeps them on the device, but they don't sync back. If `schema.sql` has gained tables since the backup was made, the restore stops and changes nothing.

1. In **Project Settings → Database**, note or reset the database password, and add the secret `SGM_RESTORE_DATABASE_URL`: the **Session pooler** connection string with the `postgres.<Project ID>` user and that password. It can change everything, so it's only kept while restoring.
2. **Actions → Restore the database from a backup → Run workflow**. Enter the backup's name as it appears in Drive, for example `SGM backup 2026-10-22.dump`, and type `RESTORE`.
3. Delete the `SGM_RESTORE_DATABASE_URL` secret.

The PCs and phones don't need anything done. The restore renumbers the sync order (`scripts/backup/after-restore.sql`), so each device downloads the restored data again by itself within about ten minutes.

To restore into a new Supabase project instead (if the old one is gone), skip running `schema.sql`, since the backup creates the tables, and restore with the new project's connection string. Then deploy the API, set its secret and point the apps at it, as in [The server (Supabase)](#the-server-supabase), and create the backup login again. Without GitHub, `scripts/backup/restore.sh` does the same on any computer with PostgreSQL 17's tools and bash.

## How it works

- **Offline first.** Each device keeps its own SQLite database: SGM Desk uses the SQLite built into Electron (`node:sqlite`, no native modules to compile) and SGM Pocket uses `expo-sqlite`. Every change also goes into an outbox, and `SyncEngine` sends it to the server and brings back other devices' changes, every minute and right after each new sale or stock movement.
- **Stock is a ledger.** Stock on hand is never typed over; it is the sum of movements (delivery, sale, transfer, adjustment, defective). Two offline devices can sell at the same time and sync later without overwriting each other. Full and empty cylinders are counted separately: a refill sale takes an empty back, a new-cylinder sale also takes an empty off the shelf (see `NEW_SALE_TAKES_EMPTY` below), and a borrowed cylinder goes out full and comes back as an empty. Defective cylinders and accessories have a count of their own, never sold: a defective exchange or a **Defective** movement puts them there, and **To Depot** (or an adjustment) takes them out.
- **Stock sent between branches is accepted where it arrives.** **Stocks Out** takes the stock off the sender's count as it leaves. It shows in the receiving branch's Inventory (and on its dashboard) until the owner, an admin, or that branch's manager or warehouse staff counts what arrived and accepts it, which puts it on their count; nobody records Stocks In by hand any more. If the count doesn't match, they say what was different, and the sending branch's manager or warehouse staff (or the owner or an admin) checks its stock and settles it: what didn't arrive never left (it goes back on the sender's count) or more was sent than recorded (it comes off), or the counts stay as they are (lost on the way, or the receiving branch keeps the extra). Accepting stock comes only with those roles and can't be given to anyone else (`ROLE_ONLY` in `roles.ts`). See `packages/core/src/transfers.ts`.
- **Borrowing is a ledger too.** Sales on credit (anything in the store, with an optional part paid now), lent cylinders, returns, payments and post-dated cheques are entries in `loans`. What someone owes and how many cylinders they have out are sums of their entries; payments and returns settle the oldest first, so every open item keeps the date it was borrowed.
- **Money is in centavos** (whole numbers), so totals never pick up rounding errors.
- **Handwritten receipts can be scanned into a sale.** On the Sell screen, **Scan receipt** reads a photo offline with PaddleOCR's models, and the cashier checks every line against the photo before it goes into the cart. The receipt number is saved with the sale so the same receipt can't be entered twice. SGM Pocket needs its development build for this (`npx expo run:android`), not Expo Go. See `packages/core/src/ocr/README.md`.
- **Signing in needs the server, with one exception.** After signing in, a device works offline for up to 72 hours before it must reach the server again. Closing SGM Desk signs the person out (also after End task or a crash, at the next start). While the server can't be reached, only the last employee or warehouse staff who signed in on that device can sign in again, with the PIN checked against a salted hash on the device and their last sign-in's token, until that token runs out; five wrong PINs, a sign-in by someone else, or the server turning the token down (a disabled account) ends it. The owner, admins and branch managers always need the server to sign in (`needsServerToSignIn` in `roles.ts`), though once signed in they keep working offline too. Sales waiting to sync are kept and sent once the connection is back.
- **Customers and claims.** A sale can name a customer, who may have their own prices or a percentage off (**Products → Customer prices**). Cashiers with `pos.discount` can also discount a line at the counter. Prepaid orders are paid at **Sell** and picked up in **Claims**, where returns and defective exchanges (cylinders and accessories) are recorded too; a cashier's return or exchange waits for the owner, an admin or the branch's manager to approve it.
- **Roles live in `packages/core/src/roles.ts`.** The apps hide menus and buttons a person can't use, but the server must check the same permissions on every request. The owner and admins work at every branch; everyone else, branch managers included, only where they are assigned, and the server refuses their changes anywhere else.

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
| Who may make and open backups, and accept stock from other branches | Only the roles that have them (`ROLE_ONLY` in `packages/core/src/roles.ts`) |
| When the server backup runs, and how many are kept | `.github/workflows/backup.yml` and `scripts/backup/prune.mjs` |
| How receipts are read (photo checks, thresholds, matching) | `packages/core/src/ocr/` (see its `README.md`) |

## Next steps

1. Before the store relies on it, move the Supabase project to the Pro plan: the free plan pauses after a week without use and keeps no backups of its own (the nightly Google Drive backup is the only copy until then).
2. Replace the placeholder address and TIN in `packages/core/src/config.ts`. Receipts say "THIS IS NOT AN OFFICIAL RECEIPT" until the system is registered with the BIR.
3. Sign the Windows installer so SmartScreen doesn't warn on the first install of each PC (optional; updates work without it).
4. If SGM Pocket needs to print to Bluetooth receipt printers, add an ESC/POS printing library (`receiptText()` in `packages/core/src/receipt.ts` is the starting point).
5. Try receipt scanning on real receipts from the store and on the phones the staff will use, then tune it (`packages/core/src/ocr/README.md`). The sample receipts so far are written in a handwriting font.

## Troubleshooting

- **A command fails with "is not recognized as an internal or external command" or "Cannot find module".** The folder's path probably contains `&`, which breaks the launchers npm uses on Windows. Rename the folder (for example to `SGM-Desktop-Mobile`) and run the command again. Android native builds can also fail on long paths, so clone the repository to a short path such as `C:\dev\sgm` before building one.
- **Windows warns about the installer.** Unsigned installers show a SmartScreen warning; choose **More info → Run anyway**. Code signing removes it.
- **`npm audit` shows warnings.** They come from Expo's and electron-builder's build tools, plus one in Expo Router's URL parsing, and clear as those packages update.
