# Firebase setup — Lab Wiki annotation & review layer

The wiki's sign-in / annotation / review features run on **Firebase Auth + Firestore**
in project **`hamiltonfour`**. The static site is unchanged and unaffected until the
`PUBLIC_FIREBASE_*` env vars below are present at build time — with no config, the
sign-in control simply doesn't render.

## 1. Environment variables

Create a `.env` file at the repo root (already git-ignored). All values are **public**
by design — a Firebase web `apiKey` is a project identifier, not a secret; access is
governed entirely by the Firestore security rules.

```
PUBLIC_FIREBASE_API_KEY=...
PUBLIC_FIREBASE_AUTH_DOMAIN=hamiltonfour.firebaseapp.com
PUBLIC_FIREBASE_PROJECT_ID=hamiltonfour
PUBLIC_FIREBASE_STORAGE_BUCKET=hamiltonfour.appspot.com
PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
PUBLIC_FIREBASE_APP_ID=...
```

Get these from **Firebase console → Project settings → Your apps → SDK setup and
configuration** (register a Web App if none exists).

## 2. One-time console setup

1. **Authentication → Sign-in method** → enable **Google**; set a support email.
2. **Authentication → Settings → Authorized domains** → add:
   `hamiltonfour.web.app`, `hamiltonfour.firebaseapp.com`, any custom domain, and
   `localhost` (for `npm run dev`). Popups fail silently on unlisted domains.
3. **Firestore Database** → create in **production mode**, region near VT (e.g. `nam5`).
4. Register a **Web App** (step 1 above) to obtain the config for `.env`.

## 3. Deploy rules & indexes

```
firebase deploy --only firestore:rules,firestore:indexes
```

(`firestore.rules` and `firestore.indexes.json` live at the repo root and are wired into
`firebase.json`.) You can also paste the rules via the console for the first cut.

## 4. Bootstrap the first admin (chicken-and-egg)

The rules intentionally let **only admins** create admins, so the first one is made by
hand — this is safer than shipping a temporarily-open rule.

1. Sign in once on the site with your `@vt.edu` Google account (creates a `pending`
   member doc).
2. Firebase console → **Authentication → Users** → copy your **User UID**.
3. Firebase console → **Firestore** → `members` collection → open the doc with your UID
   → set `role: "admin"` and `status: "member"`.

Reload the site — you're now an admin, and all further approvals happen in `/admin` → Members.

## Security model (why it's safe)

- The client UI (sign-in gating, the `/admin` and `/wiki/admin` pages) is **cosmetic**. They
  ship as public static files; put no secrets in them.
- **Firestore security rules are the only real enforcement.** Every read/write checks
  `@vt.edu` + verified email + member/admin role. A non-VT Google account can obtain a
  token but can read/write nothing.
- Roles live in `members/{uid}`; rules read them with `get()`. Fine for a lab; if the
  read cost ever matters, migrate roles to Auth custom claims (noted in `firestore.rules`).
