# Cabadbaran City Health Queuing System

A web-based queuing system with weighted-priority scheduling and doctor acceptance voice announcements for the Cabadbaran City Health Office and Family Planning Center.

The project root is the official Git working copy. Use `backend/` and `frontend/` here for development. The earlier temporary checkout has been merged into these folders.

## Run the application

Configure `backend/.env` and `frontend/.env` using their `.env.example` files if needed. Existing local environment files and runtime queue settings are retained.

Install dependencies when setting up a new checkout:

```sh
npm --prefix backend ci
npm --prefix frontend ci
```

Run these commands in separate terminals from the project root:

```sh
npm --prefix backend run dev
npm --prefix frontend run dev
```

The default backend port is 4000 and the frontend port is 3000. Restart existing servers after integrating backend changes.

## Validate changes

```sh
npm --prefix backend test
npm --prefix frontend test
npm --prefix frontend run build -- --webpack
```

The workflow tests use isolated database/storage doubles and a mocked local pyttsx3 HTTP service. Live Supabase behavior and audible playback from the local Python service require separate manual verification.

For the collaborator's local voice service, follow [backend/voice/README.md](backend/voice/README.md) on the computer that opens the Queue Display.

## Workflow and documentation

Registration creates a waiting patient. Calling selects the next patient by the existing weighted score and registration time within the assigned doctor's queue. The backend assigns the doctor and marks the patient serving; doctor acceptance drives the existing voice announcement. Completion is allowed after acceptance.

- [Official palette reference](docs/design/cho-palette.html)
- [Design reference notes](docs/design/README.md)

Runtime acceptance state is stored in `backend/data/awaiting-accept.json` and is ignored by Git. `backend/data/queue-settings.json` retains the current project's settings.
