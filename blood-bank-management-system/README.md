# Blood Bank Donation and Management System

A responsive academic demonstration app for donor records, blood donations, inventory and blood requests. It uses HTML, CSS, browser JavaScript, Express, and persistent JSON files. All included people, hospitals, phone numbers and records are fictional demo data.

## Run locally in VS Code

1. Open this `blood-bank-management-system` folder in VS Code, or open the containing repository and use its integrated terminal.
2. In the terminal, change into this folder if needed:

   ```sh
   cd blood-bank-management-system
   ```

3. Install the Node.js dependency:

   ```sh
   npm install
   ```

4. Start the server:

   ```sh
   npm start
   ```

5. Open [http://localhost:3000](http://localhost:3000) in a browser. The app uses the existing project [Index.html](../Index.html) as its home page after sign-in; there is no second app-specific index page.
6. Sign in with the demo credentials shown on the login screen:

   - Username: `admin`
   - Password: `admin123`

The default account is for local academic demonstrations only. Do not expose this app or password on a public production server, and do not enter real donor or patient information.

## Features

- Admin sign-in, password visibility toggle, HTTP-only session cookie, CSRF checks and logout.
- Dashboard statistics, blood group chart, recent donor/request lists, low-stock and pending-request notices, and quick actions.
- Donor registration and management, with generated IDs, validation, search, filters, sorting, pagination, profile details, editing and deletion.
- Donation entry and history, editing and deletion. Donation changes reconcile available inventory and donor last-donation dates.
- Inventory for all eight blood groups, low/critical stock indicators, manual stock addition/issues, and movement history.
- Blood request entry, search and filters, approval/rejection, editing, and fulfillment. Fulfillment issues stock and fails if there are not enough units.
- CSV download for donor, donation and request records.
- Responsive layouts for desktop, tablet and mobile.
- After sign-in, continue to the existing public website home page; its navigation includes a link back to the management dashboard.

## JSON data files

The Express server reads and writes these files in `data/`:

- `donors.json`
- `donations.json`
- `inventory.json`
- `requests.json`
- `admin.json`

They are initialized with 15 donor profiles, 10 donation records, inventory for all eight groups, 8 requests and one demo administrator. Updates are saved to disk, so records remain after browser refreshes and server restarts. Back up `data/` before manually editing or resetting demo data.

Admin credentials are stored in `admin.json`, and persistent session records are stored separately in `sessions.json`. Logging out invalidates the current session. The seeded password is stored as a scrypt hash, not as plaintext. Runtime sessions are excluded from Git.

## Development and tests

Run the integration tests from this folder:

```sh
npm test
```

The API is served by `server.js`; static pages and browser scripts are in `public/`. Chart.js, Font Awesome and web fonts are loaded from public CDNs, so the charts/icons/fonts need internet access. Core pages and the JSON API run locally with Node.js.

This project uses JSON files rather than a production database. It is intended for a single local demo instance, not concurrent multi-server use or deployment with real health data.
