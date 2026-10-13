# SGM Desktop & Mobile
Desktop and Mobile Application of the Inventory Management and Point of Sale System for Sibugay Gas Marketing. The application aims to streamline the LPG-business workflow both within the store and in the warehouse by digitizing the information flow.

## What's in this repository

| Folder | What it is |
| --- | --- |
| `apps/desk` | **SGM Desk**, the Windows app for the store counter and the office. React Native screens (Expo, web build) inside Electron, installed with a normal Windows installer. |
| `apps/pocket` | **SGM Pocket**, the Android and iOS app (Expo) for selling and checking stock away from the counter. |
| `packages/core` | The business rules both apps share: roles, the stock ledger, sales, receipts, offline sign-in and sync. Has its own tests. |
| `packages/ui` | The shared components and screens: sidebar layout, tables, forms, dialogs, toasts, charts, receipt preview, and the login, point of sale, borrowing, inventory, sales, reports, products, users and settings screens. |

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
| `npm run pocket` / `npm run pocket:android` | Starts SGM Pocket (Expo Go, or an Android emulator). |

### Demo mode

There is no API server yet, so both apps run against a built-in demo server with sample products, opening stock and a week of sales. Sign in with:

| Username | PIN | Role | Can |
| --- | --- | --- | --- |
| `owner` | `1111` | Owner | Everything, including reports, products and sets, users, voiding sales and device settings |
| `cashier` | `2222` | Employee | Dashboard, sell, borrowing, sales history, view stock |
| `warehouse` | `3333` | Warehouse staff | View stock and record movements (deliveries, transfers, damage) |

In SGM Desk, **Settings → Simulate no connection** shows offline mode: sales keep working and sync when the connection returns. **Reset demo data** puts the sample data back. The sample data has three sets and three borrowers; if a device ran the app before they were added, use **Reset demo data** once to see them.

To use the real server once it exists, create `apps/desk/.env.local` and `apps/pocket/.env.local` with:

```sh
EXPO_PUBLIC_API_URL=https://your-server.example.com
```

## How it works

- **Offline first.** Each device keeps its own SQLite database: SGM Desk uses the SQLite built into Electron (`node:sqlite`, no native modules to compile) and SGM Pocket uses `expo-sqlite`. Every change also goes into an outbox, and `SyncEngine` sends it to the server and brings back other devices' changes, every 30 seconds and right after each new sale or stock movement.
- **Stock is a ledger.** Stock on hand is never typed over; it is the sum of movements (delivery, sale, transfer, adjustment, damage). Two offline devices can sell at the same time and sync later without overwriting each other. Full and empty cylinders are counted separately: a refill sale takes an empty back, a new-cylinder sale also takes an empty off the shelf (see `NEW_SALE_TAKES_EMPTY` below), and a borrowed cylinder goes out full and comes back as an empty.
- **Borrowing is a ledger too.** Refills on credit, lent cylinders, returns and payments are entries in `loans`. What someone owes and how many cylinders they have out are sums of their entries; payments and returns settle the oldest first, so every open item keeps the date it was borrowed.
- **Money is in centavos** (whole numbers), so totals never pick up rounding errors.
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
| The Windows installer | `apps/desk/electron-builder.yml` |

## Next steps

1. Build the API server (Oracle Always Free): `POST /auth/login`, `POST /sync/push` and `GET /sync/pull`, as described in `packages/core/src/api.ts`, with device registration and role checks.
2. Replace the placeholder address and TIN in `packages/core/src/config.ts`. Receipts say "THIS IS NOT AN OFFICIAL RECEIPT" until the system is registered with the BIR.
3. Turn on automatic updates by setting `publish` in `apps/desk/electron-builder.yml`, and sign the installer so Windows SmartScreen doesn't warn.
4. If SGM Pocket needs to print to Bluetooth receipt printers, add an ESC/POS printing library (`receiptText()` in `packages/core/src/receipt.ts` is the starting point).

## Troubleshooting

- **A command fails with "is not recognized as an internal or external command" or "Cannot find module".** The folder's path probably contains `&`, which breaks the launchers npm uses on Windows. Rename the folder (for example to `SGM-Desktop-Mobile`) and run the command again. Android native builds can also fail on long paths, so clone the repository to a short path such as `C:\dev\sgm` before building one.
- **Windows warns about the installer.** Unsigned installers show a SmartScreen warning; choose **More info → Run anyway**. Code signing removes it.
- **`npm audit` shows warnings.** They come from Expo's and electron-builder's build tools, plus one in Expo Router's URL parsing, and clear as those packages update.
