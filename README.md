# Git Preview

Git Preview clones a public GitHub repository, starts a supported web project on
your computer, captures a screenshot, and returns a local preview link.

## Local setup

Requirements: Node.js 18 or newer, npm, and Git.

Start the API in one terminal:

    cd backend
    npm install
    npx playwright install chromium
    npm run dev

Start the frontend in a second terminal:

    cd frontend
    npm install
    npm run dev

Open the Vite URL shown in the frontend terminal, then enter a public
https://github.com/owner/repository URL. The API listens on
http://127.0.0.1:3001 by default. Set VITE_API_URL in the frontend
environment to use another local API address.

## Supported projects

- Vite, Next.js, Create React App, and Vue CLI projects with their usual
  development scripts
- Node projects with an npm start script
- Static projects with a root index.html

Each preview gets a free local port. Up to three previews can run at once.
Previews expire after 15 minutes by default (configurable with
PREVIEW_TTL_MS, from 60 seconds to one hour). Use the Stop Preview button to
stop one early. The backend also removes its own cloned project when a preview
is stopped, expires, or fails to start.

## Local execution and data

Use only repositories you own or trust. Installing dependencies and starting a
repository runs code from that repository on your computer. Git Preview is a
local development utility; it does not isolate or sandbox repository code and
is not configured for public deployment.

Existing files under backend/temp-projects are preserved when the API starts.
Only UUID-named clones created by the current preview request are eligible for
cleanup. The service does not require or store GitHub credentials and supports
public repositories only.

The API binds to 127.0.0.1 by default. Configure HOST only if you intentionally
need a different bind address. The frontend origin allowlist defaults to Vite
development and preview ports; configure FRONTEND_ORIGIN if you use a
different frontend origin.
