# Omega Track Desktop Tracker

This is the official desktop tracking client for Omega Track. It is built securely using Electron and completely isolates telemetry interactions to your individually configured backend Server.

## Prerequisites
- Node.js (v18+)
- Local Omega Track Installation (or cloud endpoint)

## Configuration
Before running or building the application, you **MUST** configure your API targets.

1. Copy the example configuration file:
   ```bash
   cp env.example.json env.json
   ```
2. Open `env.json` and set your `API_BASE` precisely to your organization's domain:
   ```json
   {
       "API_BASE": "https://hrm.your-organization.com/api"
   }
   ```
*(Note: If testing locally, `http://localhost:8000/api` suffices).*

## Development
To spawn the hot-reload Electron application locally:
```bash
npm install
npm start
```

## Production Build
To wrap the client into an executable installer for your employees:

```bash
npm install
npm run build
```
This will compile the Windows Node bundles and drop `Omega Tracker Setup 1.0.0.exe` natively into the `/dist` directory. Distribute this installer file to your team.

### Auto-Updater Configuration
If you desire Over-The-Air auto-updates running silently on your employee machines, adjust the `"publish"` block inside `package.json` to point to the remote domain hosting your artifacts before executing the build sequence.


