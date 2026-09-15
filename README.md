# Relay

Password-gated file sharing for client handoffs. Upload a file, get a short share link, and send clients to a clean download page — no account required on their side.

**Live demo:** [relay-fileshare.web.app](https://relay-fileshare.web.app)

## Features

- Shared upload password (verified server-side; never shipped in the frontend)
- Resumable uploads with live progress (up to 1 GB)
- Short share URLs (`/d/{id}`) with a branded download page
- Configurable expiry: 1 hour, 24 hours, 7 days, or 30 days
- Automatic cleanup of expired files (hourly Cloud Scheduler job)
- Upload history after login: copy link, open page, delete
- Download counts on each share
- Drag-and-drop file picker
- Firebase Hosting, Storage, Firestore, Auth, and Cloud Functions

## Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | Vite, vanilla JavaScript, CSS |
| Backend | Firebase Cloud Functions (Node.js 20) |
| Auth | Custom tokens + claim-based role (`uploader`) |
| Data | Cloud Firestore |
| Files | Firebase Storage (resumable uploads) |
| Hosting | Firebase Hosting |
| Secrets | Google Secret Manager (`UPLOAD_PASSWORD`) |

## Architecture

```
Uploader  →  Login (callable)  →  Custom token (role: uploader)
          →  uploadBytesResumable  →  Storage
          →  Firestore share metadata
Client    →  /d/{shareId} download page  →  Download button
Scheduler →  cleanupExpiredShares (hourly)
```

Security highlights:

- Upload password compared with a timing-safe check inside a callable function
- Storage writes limited to authenticated uploaders and a fixed path pattern
- Firestore list/delete only for uploaders; public `get` by document ID powers the download page
- Clients never need Firestore write access

## Project structure

```
├── index.html              # App shell (login, dashboard, download page)
├── src/
│   ├── main.js             # Auth, upload, history, routing
│   ├── firebase.js         # Firebase SDK init from env
│   └── style.css
├── functions/
│   └── index.js            # login, download tracking, expiry cleanup
├── storage.rules
├── firestore.rules
├── firebase.json
└── .env.example
```

## Prerequisites

- Node.js 20+
- [Firebase CLI](https://firebase.google.com/docs/cli) (`npm i -g firebase-tools`)
- A Google account
- A Firebase project on the **Blaze** plan (required for Cloud Functions and Scheduler)

## Deploy your own

### 1. Clone and install

```bash
git clone https://github.com/NadeeraSilvaa/relay-fileshare.git
cd relay-fileshare
npm install
cd functions && npm install && cd ..
```

### 2. Create a Firebase project

1. Create a project in the [Firebase Console](https://console.firebase.google.com)
2. Upgrade to **Blaze**
3. Enable **Authentication** (custom tokens are enough; open the Auth page once to initialize it)
4. Create a **Cloud Storage** bucket
5. Create a **Cloud Firestore** database
6. Register a **Web** app and copy the Firebase config

### 3. Configure the app

```bash
cp .env.example .env
```

Fill `.env` with your web app config:

```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

Point the Firebase CLI at your project:

```bash
firebase login
firebase use YOUR_PROJECT_ID
```

Or set `projects.default` in `.firebaserc`.

### 4. Set the upload password

```bash
firebase functions:secrets:set UPLOAD_PASSWORD
```

Enter the password you will use on the login screen. This value stays in Secret Manager and is never committed to git.

### 5. Build and deploy

```bash
npm run build
firebase deploy
```

Your site will be available at `https://YOUR_PROJECT_ID.web.app`.

Grant the Cloud Functions runtime service account permission to mint custom tokens if needed (Service Account Token Creator on the default compute service account). New projects sometimes require this after the first Auth setup.

## Local development

```bash
npm run dev
```

The UI runs locally, but login, uploads, and history still need your deployed (or emulated) Firebase backend.

## Changing the upload password

```bash
firebase functions:secrets:set UPLOAD_PASSWORD
firebase deploy --only functions:loginWithUploadPassword
```

## License

MIT
