# Ochi Live backend

## Deploy to Render

Create a Render Web Service from this repository and use the included `render.yaml` Blueprint. The service uses `npm ci`, starts with `npm start`, and exposes `/healthz` for Render health checks. Render supplies the listening `PORT`.

Set the prompted environment variables in Render:

- Required for persistent application data and authentication: `MONGO_URI`, `AUTH_SECRET`.
- Required for frontend/API access: `FRONTEND_URL`, `CORS_ORIGIN`, `BACKEND_PUBLIC_URL`.
- Required for account verification and password reset email: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`.
- Needed only when enabling their respective features: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CLOUDINARY_URL`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `PAYSTACK_SECRET_KEY`.

Set `FRONTEND_URL` and `CORS_ORIGIN` to the deployed Vercel origin (for example `https://your-app.vercel.app`, without a trailing slash). `CORS_ORIGIN` can contain a comma-separated list when multiple exact origins are needed. Set `BACKEND_PUBLIC_URL` to the Render service origin. If using Google sign-in, register `${BACKEND_PUBLIC_URL}/api/auth/google/callback` as the OAuth redirect URI.

Use the Render service origin plus `/api` as the frontend `VITE_API_URL`, and the service origin as `VITE_SOCKET_URL`.
