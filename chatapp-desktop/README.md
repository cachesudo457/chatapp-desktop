# The Room — Desktop App

A tiny desktop wrapper around your live chat at
https://chat-thing-ufly.onrender.com/ — opens it in its own native window
with a proper app icon and taskbar entry, instead of a browser tab.

## Just want to use it right now? (no building required)

```bash
npm install
npm start
```

That opens the app immediately on your computer. This is the fastest way
to use it — no installer needed.

## Want a real installer to share with others?

**Easiest option — no Windows or Mac needed at all:** this project
includes a GitHub Actions workflow that builds both installers for you on
real (temporary) Windows and Mac machines in the cloud, for free.

1. Push this project to a GitHub repository.
2. Go to the repo's **Actions** tab on github.com.
3. Click **Build Desktop App** in the sidebar, then **Run workflow**.
4. Wait a few minutes for both jobs to finish (green checkmarks).
5. Click into the finished run, scroll down to **Artifacts**, and
   download `windows-installer` and `mac-installer` (each is a zip
   containing the real `.exe` or `.dmg`).
6. Unzip them, rename the files to exactly `The-Room-Setup.exe` and
   `The-Room.dmg`, and drop them into the `downloads` folder of your main
   chat app project, then push that.

This re-runs automatically every time you push to the `main` branch too,
so future updates to `main.js` get rebuilt without you doing anything.

**If you do have access to a Windows or Mac machine directly**, you can
skip GitHub Actions and build locally instead:

**On Windows:**
```bash
npm install
npm run dist:win
```
This produces an installer in the `dist` folder — a `.exe` that installs
the app like any normal Windows program, with your own choice of install
location and a Start Menu entry.

**On Mac:**
```bash
npm install
npm run dist:mac
```
This produces a `.dmg` in the `dist` folder — drag-to-Applications like
any normal Mac app.

## Changing the chat URL

If you ever move the chat to a different address, open `main.js` and
update the `CHAT_URL` constant near the top, then rebuild.

## Notes

- The app icon (a sage-green speech bubble with the `(ー_ー)` kaomoji,
  matching the chat's own look) is already generated in the `build/`
  folder as `icon.png`, `icon.ico`, and `icon.icns`.
- This is an unsigned app. On first run, Windows SmartScreen or macOS
  Gatekeeper may show a warning since it isn't from a registered
  developer — that's normal for a small personal project like this, and
  there's an option to run it anyway ("More info > Run anyway" on
  Windows, or right-click > Open on Mac).
